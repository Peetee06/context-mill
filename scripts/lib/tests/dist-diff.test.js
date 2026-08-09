import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import archiver from 'archiver';

import { diffDistTrees, renderComment, renderFull } from '../dist-diff.js';

/** Write a file tree: { 'a/b.txt': 'content' } */
function writeTree(baseDir, files) {
    for (const [rel, content] of Object.entries(files)) {
        const full = join(baseDir, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
    }
}

/** Zip entries { name: content } into a buffer via archiver (the build's writer). */
function zipBuffer(entries, { date } = {}) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('data', c => chunks.push(c));
        archive.on('end', () => resolve(Buffer.concat(chunks)));
        archive.on('error', reject);
        for (const [name, content] of Object.entries(entries)) {
            archive.append(content, { name, date: date ?? new Date('2020-01-01T00:00:00Z') });
        }
        archive.finalize();
    });
}

let before, after;

beforeEach(() => {
    before = mkdtempSync(join(tmpdir(), 'distdiff-before-'));
    after = mkdtempSync(join(tmpdir(), 'distdiff-after-'));
});

afterEach(() => {
    rmSync(before, { recursive: true, force: true });
    rmSync(after, { recursive: true, force: true });
});

describe('diffDistTrees', () => {
    it('reports no changes for identical trees', async () => {
        const files = {
            'skills/skill-menu.json': '{"cliEntries":[]}',
            'skills/web-analytics.zip': 'placeholder',
        };
        writeTree(before, files);
        writeTree(after, files);

        const model = await diffDistTrees(before, after);
        expect(model.changes).toEqual([]);
    });

    it('filters zip archives whose bytes differ only by entry mtimes', async () => {
        const entries = { 'SKILL.md': '# Web analytics', 'references/setup.md': 'steps' };
        writeTree(before, {
            'skills/web-analytics.zip': await zipBuffer(entries, { date: new Date('2020-01-01T00:00:00Z') }),
        });
        writeTree(after, {
            'skills/web-analytics.zip': await zipBuffer(entries, { date: new Date('2026-08-09T12:00:00Z') }),
        });

        const model = await diffDistTrees(before, after);
        expect(model.changes).toEqual([]);
    });

    it('reports a zip whose entry content changed, naming the inner files', async () => {
        writeTree(before, {
            'skills/web-analytics.zip': await zipBuffer({ 'SKILL.md': 'v1', 'references/setup.md': 'same' }),
        });
        writeTree(after, {
            'skills/web-analytics.zip': await zipBuffer({ 'SKILL.md': 'v2', 'references/setup.md': 'same' }),
        });

        const model = await diffDistTrees(before, after);
        expect(model.changes).toEqual([
            { path: 'skills/web-analytics.zip', kind: 'changed', innerChanges: ['SKILL.md'], deltaHash: expect.any(String) },
        ]);
    });

    it('filters a manifest whose only difference is buildTimestamp, but reports real manifest changes', async () => {
        const resource = { id: 'web-analytics', uri: 'posthog://skills/web/web-analytics' };
        writeTree(before, {
            'skills/manifest.json': JSON.stringify({ buildTimestamp: '2026-08-01T00:00:00Z', resources: [resource] }),
        });
        writeTree(after, {
            'skills/manifest.json': JSON.stringify({ buildTimestamp: '2026-08-09T00:00:00Z', resources: [resource] }),
        });
        expect((await diffDistTrees(before, after)).changes).toEqual([]);

        writeTree(after, {
            'skills/manifest.json': JSON.stringify({
                buildTimestamp: '2026-08-09T00:00:00Z',
                resources: [resource, { id: 'new-skill', uri: 'posthog://skills/new/new-skill' }],
            }),
        });
        expect((await diffDistTrees(before, after)).changes).toEqual([
            { path: 'skills/manifest.json', kind: 'changed', deltaHash: expect.any(String) },
        ]);
    });

    it('reports unknown future artifact types instead of skipping them (totality)', async () => {
        writeTree(before, { 'desktop/blob.bin': 'v1' });
        writeTree(after, { 'desktop/blob.bin': 'v2', 'desktop/extra.dat': 'new' });

        expect((await diffDistTrees(before, after)).changes).toEqual([
            { path: 'desktop/blob.bin', kind: 'changed', deltaHash: expect.any(String) },
            { path: 'desktop/extra.dat', kind: 'added' },
        ]);
    });

    it('normalizes recursively inside aggregate zips (inner manifest stamps, inner zip mtimes)', async () => {
        const innerSkill = { 'SKILL.md': 'stable' };
        writeTree(before, {
            'skills-mcp-resources.zip': await zipBuffer({
                'manifest.json': JSON.stringify({ buildTimestamp: '2026-08-01T00:00:00Z', resources: [] }),
                'web-analytics.zip': await zipBuffer(innerSkill, { date: new Date('2020-01-01T00:00:00Z') }),
            }),
        });
        writeTree(after, {
            'skills-mcp-resources.zip': await zipBuffer({
                'manifest.json': JSON.stringify({ buildTimestamp: '2026-08-09T00:00:00Z', resources: [] }),
                'web-analytics.zip': await zipBuffer(innerSkill, { date: new Date('2026-08-09T12:00:00Z') }),
            }),
        });

        expect((await diffDistTrees(before, after)).changes).toEqual([]);
    });
});

describe('renderComment', () => {
    it('renders a cliEntry addition under the wizard surface, with unchanged assertions for the rest', async () => {
        const menu = entries => JSON.stringify({ cliEntries: entries });
        const base = [{ skillId: 'audit-events', role: 'command', parentCommand: 'audit', command: 'events' }];
        writeTree(before, { 'skills/skill-menu.json': menu(base) });
        writeTree(after, {
            'skills/skill-menu.json': menu([
                ...base,
                { skillId: 'creating-product-tours', role: 'skill' },
            ]),
        });

        const model = await diffDistTrees(before, after);
        const comment = renderComment(model);

        expect(comment).toContain('creating-product-tours');
        expect(comment).toMatch(/\+.*creating-product-tours.*skill/);
        expect(comment).toMatch(/Skill content.*✓/i);
        expect(comment).toMatch(/Marketplace.*✓/i);
        expect(comment.split('\n').length).toBeLessThanOrEqual(40);
    });

    it('groups zips sharing an identical inner delta and keeps the comment within budget', async () => {
        const beforeFiles = {};
        const afterFiles = {};
        // 45 variants all pick up the same shared-doc change...
        for (let i = 0; i < 45; i++) {
            const id = `ai-observability-variant-${i}`;
            beforeFiles[`skills/${id}.zip`] = await zipBuffer({ 'SKILL.md': `# ${id}`, 'references/auth.md': 'old auth' });
            afterFiles[`skills/${id}.zip`] = await zipBuffer({ 'SKILL.md': `# ${id}`, 'references/auth.md': 'new auth' });
        }
        // ...and one unrelated zip changes differently.
        beforeFiles['skills/web-analytics.zip'] = await zipBuffer({ 'SKILL.md': 'wa v1' });
        afterFiles['skills/web-analytics.zip'] = await zipBuffer({ 'SKILL.md': 'wa v2' });
        writeTree(before, beforeFiles);
        writeTree(after, afterFiles);

        const comment = renderComment(await diffDistTrees(before, after));

        expect(comment).toMatch(/45 zips.*identical.*references\/auth\.md/i);
        expect(comment).toContain('web-analytics.zip');
        expect(comment.split('\n').length).toBeLessThanOrEqual(40);

        const full = renderFull(await diffDistTrees(before, after));
        for (let i = 0; i < 45; i++) expect(full).toContain(`ai-observability-variant-${i}.zip`);
    });

    it('does not group a zip entry changed to the literal "absent" with a removed entry', async () => {
        writeTree(before, {
            'skills/a.zip': await zipBuffer({ 'SKILL.md': 'keep', 'doc.md': 'old' }),
            'skills/b.zip': await zipBuffer({ 'SKILL.md': 'keep', 'doc.md': 'old' }),
        });
        writeTree(after, {
            'skills/a.zip': await zipBuffer({ 'SKILL.md': 'keep', 'doc.md': 'absent' }), // content change
            'skills/b.zip': await zipBuffer({ 'SKILL.md': 'keep' }),                     // entry removed
        });

        const model = await diffDistTrees(before, after);
        const [a, b] = model.changes;
        expect(a.deltaHash).not.toEqual(b.deltaHash);
        expect(renderComment(model)).not.toMatch(/2 zips.*identical/i);
    });

    it('groups many zips touching the same inner files with differing contents (skill rebuild)', async () => {
        const beforeFiles = {}, afterFiles = {};
        for (const id of ['anthropic', 'openai', 'mistral', 'groq', 'cohere']) {
            beforeFiles[`skills/ai-observability-${id}.zip`] = await zipBuffer({ 'SKILL.md': `old ${id}`, 'references/setup.md': `old setup ${id}` });
            afterFiles[`skills/ai-observability-${id}.zip`] = await zipBuffer({ 'SKILL.md': `new ${id}`, 'references/setup.md': `new setup ${id}` });
        }
        // Two unrelated zips with the same inner-file signature must stay itemized (below threshold).
        for (const id of ['quack', 'omnibus']) {
            beforeFiles[`skills/${id}.zip`] = await zipBuffer({ 'SKILL.md': `old ${id}` });
            afterFiles[`skills/${id}.zip`] = await zipBuffer({ 'SKILL.md': `new ${id}` });
        }
        writeTree(before, beforeFiles);
        writeTree(after, afterFiles);

        const comment = renderComment(await diffDistTrees(before, after));

        expect(comment).toMatch(/5 zips changed — same files touched.*SKILL\.md, references\/setup\.md/i);
        expect(comment).toMatch(/^~ quack\.zip/m);
        expect(comment).toMatch(/^~ omnibus\.zip/m);
    });

    it('collapses the new-variant shape: added files group by directory, small identical-delta pairs merge by file name', async () => {
        const beforeFiles = {}, afterFiles = {};
        // 5 files added in one new plugin directory...
        for (const f of ['SKILL.md', 'references/cli.md', 'references/go.md', 'references/upload.md', 'references/COMMANDMENTS.md']) {
            afterFiles[`marketplace/plugins/posthog-uploads/skills/go/${f}`] = `new ${f}`;
        }
        // ...and 5 variants whose SKILL.md changed identically in their two plugin copies (5 pairs, distinct per variant).
        for (const id of ['android', 'ios', 'react', 'node', 'python']) {
            for (const loc of ['posthog-all/skills', 'posthog-uploads/skills']) {
                beforeFiles[`marketplace/plugins/${loc}/${id}/SKILL.md`] = `old ${id}`;
                afterFiles[`marketplace/plugins/${loc}/${id}/SKILL.md`] = `new ${id}`;
            }
        }
        writeTree(before, beforeFiles);
        writeTree(after, { ...afterFiles });

        const comment = renderComment(await diffDistTrees(before, after));

        expect(comment).toMatch(/^\+ plugins\/posthog-uploads\/skills\/go\/ — 5 files added/im);
        expect(comment).toMatch(/10 files changed — same file name \(SKILL\.md\)/i);
        expect(comment.split('\n').length).toBeLessThanOrEqual(22);
    });

    it('groups plain files sharing an identical content delta (marketplace fan-out)', async () => {
        const beforeFiles = {}, afterFiles = {};
        for (const id of ['android', 'angular', 'django']) {
            beforeFiles[`marketplace/plugins/posthog-all/skills/integration-${id}/references/4-conclude.md`] = 'old conclusion';
            afterFiles[`marketplace/plugins/posthog-all/skills/integration-${id}/references/4-conclude.md`] = 'new conclusion';
        }
        beforeFiles['marketplace/plugins/posthog-all/skills/quack/SKILL.md'] = 'unrelated old';
        afterFiles['marketplace/plugins/posthog-all/skills/quack/SKILL.md'] = 'unrelated new';
        writeTree(before, beforeFiles);
        writeTree(after, afterFiles);

        const comment = renderComment(await diffDistTrees(before, after));

        expect(comment).toMatch(/3 files changed — identical delta.*4-conclude\.md/i);
        expect(comment).toMatch(/^~ plugins\/posthog-all\/skills\/quack\/SKILL\.md/m); // single-file dir collapses
        // Members live only inside the collapsed <details>, never as diff-block lines.
        expect(comment).not.toMatch(/^[-+~ ] .*integration-angular/m);
    });

    it('reports a modified cliEntry (same identity, changed fields)', async () => {
        const menu = entries => JSON.stringify({ cliEntries: entries });
        writeTree(before, {
            'skills/skill-menu.json': menu([{ skillId: 'audit-events', role: 'command', parentCommand: 'audit', command: 'events', default: false }]),
        });
        writeTree(after, {
            'skills/skill-menu.json': menu([{ skillId: 'audit-events', role: 'command', parentCommand: 'audit', command: 'events', default: true }]),
        });

        const comment = renderComment(await diffDistTrees(before, after));
        expect(comment).toMatch(/^~ cliEntry audit-events updated/m);
    });

    it('full report names identical-delta groups by the changed file, hunk inline, members collapsed', async () => {
        const beforeFiles = {}, afterFiles = {};
        for (const id of ['anthropic', 'openai', 'mistral', 'groq', 'cohere']) {
            beforeFiles[`skills/ai-observability-${id}.zip`] = await zipBuffer({ 'SKILL.md': `keep ${id}`, 'references/setup.md': 'old setup' });
            afterFiles[`skills/ai-observability-${id}.zip`] = await zipBuffer({ 'SKILL.md': `keep ${id}`, 'references/setup.md': 'new setup' });
        }
        writeTree(before, beforeFiles);
        writeTree(after, afterFiles);

        const full = renderFull(await diffDistTrees(before, after));

        // The group is titled by WHAT changed, not by 68 repeating zip names...
        expect(full).toMatch(/`references\/setup\.md` — changed identically in 5 zips/);
        // ...the hunk appears once, inline (not inside <details>)...
        expect(full.match(/-old setup/g)).toHaveLength(1);
        expect(full.indexOf('-old setup')).toBeLessThan(full.indexOf('<details>'));
        // ...and the member list is what's collapsed.
        expect(full).toMatch(/<details><summary>5 archives<\/summary>skills\/ai-observability-anthropic\.zip/);
    });

    it('full report shows content-level hunks for changed files, once per identical-delta group', async () => {
        const beforeFiles = {}, afterFiles = {};
        for (const id of ['android', 'angular', 'django']) {
            beforeFiles[`marketplace/plugins/posthog-all/skills/integration-${id}/references/4-conclude.md`] = 'old conclusion\nshared line';
            afterFiles[`marketplace/plugins/posthog-all/skills/integration-${id}/references/4-conclude.md`] = 'new conclusion\nshared line';
        }
        beforeFiles['skills/web-analytics.zip'] = await zipBuffer({ 'SKILL.md': 'zip v1' });
        afterFiles['skills/web-analytics.zip'] = await zipBuffer({ 'SKILL.md': 'zip v2' });
        writeTree(before, beforeFiles);
        writeTree(after, afterFiles);

        const full = renderFull(await diffDistTrees(before, after));

        expect(full).toContain('-old conclusion');
        expect(full).toContain('+new conclusion');
        // Identical delta across 3 files → the hunk is shown exactly once.
        expect(full.match(/-old conclusion/g)).toHaveLength(1);
        // Zip inner content is diffed too.
        expect(full).toContain('-zip v1');
        expect(full).toContain('+zip v2');
    });

    it('does not fold root-level files into directory buckets (empty-dir key is a prefix of every key)', async () => {
        const afterFiles = {};
        for (let i = 0; i < 3; i++) afterFiles[`root-${i}.bin`] = `r${i}`;
        for (let i = 0; i < 4; i++) afterFiles[`deep/nested/f${i}.bin`] = `n${i}`;
        writeTree(before, { 'keep.txt': 'x' });
        writeTree(after, { 'keep.txt': 'x', ...afterFiles });

        const comment = renderComment(await diffDistTrees(before, after));

        expect(comment).toMatch(/deep\/nested\/ — 4 files added/);
        expect(comment).not.toMatch(/^\+ {2}— \d+ files/m);       // no nameless bucket
        expect(comment).toMatch(/^\+ root-0\.bin/m);              // root files itemized
    });

    it('keeps every surface assertion visible when the budget forces truncation', async () => {
        const beforeFiles = {}, afterFiles = {};
        // Distinct inner-file names per zip, so no grouping tier can collapse them.
        for (let i = 0; i < 60; i++) {
            beforeFiles[`skills/skill-${i}.zip`] = await zipBuffer({ [`ref-${i}.md`]: `old ${i}` });
            afterFiles[`skills/skill-${i}.zip`] = await zipBuffer({ [`ref-${i}.md`]: `new ${i}` });
        }
        writeTree(before, beforeFiles);
        writeTree(after, afterFiles);

        const comment = renderComment(await diffDistTrees(before, after), { fullReportUrl: 'https://x' });
        const lines = comment.split('\n');

        expect(lines.length).toBeLessThanOrEqual(40);
        // Truncation must spend block content, never the surface assertions.
        for (const title of ['Wizard surface', 'Marketplace', 'Agents', 'MCP manifest', 'Skills-repo mirror']) {
            expect(comment).toContain(`**${title}** ✓ unchanged`);
        }
        expect(comment).toMatch(/more .*full report/i);
        expect(lines.filter(l => l.startsWith('```')).length % 2).toBe(0);  // fences balanced
    });

    it('caps content hunks by decompressed inner-entry size, not archive size', async () => {
        const big = 'line\n'.repeat(80_000);   // ~400KB decompressed, tiny compressed
        writeTree(before, { 'skills/a.zip': await zipBuffer({ 'huge.md': big }) });
        writeTree(after, { 'skills/a.zip': await zipBuffer({ 'huge.md': `${big}tail\n` }) });

        const full = renderFull(await diffDistTrees(before, after));
        expect(full).toMatch(/too large to diff/i);
    });

    it('full report shows content for added and removed files', async () => {
        writeTree(before, { 'skills/old-note.md': 'goodbye content' });
        writeTree(after, { 'skills/new-note.md': 'hello content' });

        const full = renderFull(await diffDistTrees(before, after));
        expect(full).toContain('+hello content');
        expect(full).toContain('-goodbye content');
    });

    it('summarizes the aggregate bundle as one verified line when its changes match its constituents', async () => {
        const oldSkill = { 'SKILL.md': 'v1' };
        const newSkill = { 'SKILL.md': 'v2' };
        writeTree(before, {
            'skills/web-analytics.zip': await zipBuffer(oldSkill),
            'skills-mcp-resources.zip': await zipBuffer({
                'manifest.json': JSON.stringify({ resources: [] }),
                'web-analytics.zip': await zipBuffer(oldSkill),
            }),
        });
        writeTree(after, {
            'skills/web-analytics.zip': await zipBuffer(newSkill),
            'skills-mcp-resources.zip': await zipBuffer({
                'manifest.json': JSON.stringify({ resources: [] }),
                'web-analytics.zip': await zipBuffer(newSkill),
            }),
        });

        const model = await diffDistTrees(before, after);
        const comment = renderComment(model);
        const full = renderFull(model);

        expect(comment).toMatch(/skills-mcp-resources\.zip — aggregate, consistent with/i);
        expect(full).toMatch(/^✓ consistent with its constituents/m);   // plaintext line, not a code block
        expect(full).not.toMatch(/```diff\n\(consistent/);
        // The constituent's hunk appears once (its own section), not again for the aggregate.
        expect(full.match(/-v1/g)).toHaveLength(1);
    });

    it('goes loud when the aggregate contains a change no constituent explains', async () => {
        writeTree(before, {
            'skills-mcp-resources.zip': await zipBuffer({ 'phantom.zip': await zipBuffer({ 'SKILL.md': 'v1' }) }),
        });
        writeTree(after, {
            'skills-mcp-resources.zip': await zipBuffer({ 'phantom.zip': await zipBuffer({ 'SKILL.md': 'v2' }) }),
        });

        const model = await diffDistTrees(before, after);
        expect(renderComment(model)).toMatch(/⚠️.*phantom\.zip/);
        expect(renderFull(model)).toMatch(/⚠️.*diverges/i);
    });

    it('golden: the PR #330 shape — menu/marketplace/mirror changes surface, stamp and mtime noise does not', async () => {
        const menu = entries => JSON.stringify({ cliEntries: entries });
        const baseEntries = [{ skillId: 'audit-events', role: 'command', parentCommand: 'audit', command: 'events' }];
        const zipContent = { 'SKILL.md': '# stable skill' };

        writeTree(before, {
            'skills/skill-menu.json': menu(baseEntries),
            'skills/manifest.json': JSON.stringify({ buildTimestamp: '2026-08-01T00:00:00Z', resources: [] }),
            'push-manifest.json': JSON.stringify({ plugins: [] }),
            'marketplace/.claude-plugin/marketplace.json': JSON.stringify({ plugins: [] }),
            'skills/web-analytics.zip': await zipBuffer(zipContent, { date: new Date('2020-01-01T00:00:00Z') }),
        });
        writeTree(after, {
            'skills/skill-menu.json': menu([...baseEntries, { skillId: 'creating-product-tours', role: 'skill' }]),
            'skills/manifest.json': JSON.stringify({ buildTimestamp: '2026-08-09T00:00:00Z', resources: [] }),
            'push-manifest.json': JSON.stringify({ plugins: [{ name: 'posthog-product-tours' }] }),
            'marketplace/.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'posthog-product-tours' }] }),
            'marketplace/plugins/posthog-product-tours/SKILL.md': '# product tours',
            'skills/web-analytics.zip': await zipBuffer(zipContent, { date: new Date('2026-08-09T12:00:00Z') }),
        });

        const comment = renderComment(await diffDistTrees(before, after));

        expect(comment).toMatch(/^\+ cliEntry creating-product-tours \(role: skill\)/m);
        expect(comment).toMatch(/^~ \.claude-plugin\/marketplace\.json/m);         // marketplace index, gray
        expect(comment).toMatch(/^\+ plugins\/posthog-product-tours\/SKILL\.md/m); // new plugin file, green, chain-collapsed
        expect(comment).toContain('push-manifest.json');
        expect(comment).toMatch(/Skill content.*✓ unchanged/i);   // mtime-only zip filtered
        expect(comment).toMatch(/MCP manifest.*✓ unchanged/i);    // buildTimestamp-only filtered

        const linked = renderComment(await diffDistTrees(before, after), {
            fullReportUrl: 'https://github.com/PostHog/context-mill/actions/runs/123',
        });
        expect(linked).toContain('[Full report](https://github.com/PostHog/context-mill/actions/runs/123)');
    });
});
