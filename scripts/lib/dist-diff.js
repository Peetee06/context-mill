/**
 * dist-diff — normalized differ over two built dist/ trees.
 *
 * Design invariants (see the dist-diff PR/issue for the full rationale):
 *  - Totality: every file under both trees is compared. Unknown file types
 *    degrade to byte comparison — a future artifact type can at worst add a
 *    noisy line to the report, never be silently skipped.
 *  - Normalization is a small set of NAMED rules, nothing broader:
 *    ZIPs are compared by entry contents (the archive format embeds mtimes,
 *    which differ on every build), and JSON files are compared by parsed
 *    value with known build-stamp fields removed.
 *  - Determinism guard: `npm run diff` with `--exit-code` (git-diff
 *    convention) lets CI assert two builds of the same ref produce an empty
 *    normalized diff, so any new nondeterminism in the build fails loudly
 *    instead of eroding the report.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { unzipSync } from 'fflate';
import { structuredPatch } from 'diff';

/**
 * Read a ZIP buffer into { entryName: contentBuffer }. fflate is the same
 * library the PostHog MCP server uses to unzip these archives. Entry mtimes
 * and attributes are dropped here on purpose: they are exactly the noise this
 * tool normalizes away.
 */
export function readZipEntries(buf) {
    const entries = {};
    for (const [name, data] of Object.entries(unzipSync(buf))) {
        if (!name.endsWith('/')) entries[name] = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    return entries;
}

/**
 * True when two JSON buffers are equal after removing build-stamp fields.
 * buildTimestamp (build-phases.js writeManifestAndMenu) is the build's only
 * per-run stamp today; add fields here if another one appears.
 */
function jsonEqualIgnoringStamps(a, b) {
    let pa, pb;
    try {
        pa = JSON.parse(a.toString('utf8'));
        pb = JSON.parse(b.toString('utf8'));
    } catch {
        return false; // unparseable JSON falls back to the byte comparison verdict
    }
    if (pa && typeof pa === 'object') delete pa.buildTimestamp;
    if (pb && typeof pb === 'object') delete pb.buildTimestamp;
    return JSON.stringify(pa) === JSON.stringify(pb);
}

/**
 * True when two buffers are equal after normalization for their file type.
 * Applies recursively inside zips, so aggregate archives (zips of zips plus a
 * stamped manifest) normalize the same way the tree does.
 */
function normalizedEqual(name, a, b) {
    if (a.equals(b)) return true;
    if (name.endsWith('.json')) return jsonEqualIgnoringStamps(a, b);
    if (name.endsWith('.zip')) return zipInnerChanges(a, b).length === 0;
    return false;
}

/**
 * Fingerprint of a zip's inner delta: same changed entry names with the same
 * before/after bytes → same hash. Lets the report group fan-out (one shared
 * doc rebuilt into dozens of variant zips) into a single line.
 */
// Length-framed so contents can't collide with each other or with absence.
function hashFrame(hash, buf) {
    hash.update(String(buf ? buf.length : -1)).update('\0').update(buf ?? '').update('\0');
}

function zipDeltaHash(a, b, innerChanges) {
    const ea = readZipEntries(a);
    const eb = readZipEntries(b);
    const hash = createHash('sha256');
    for (const name of innerChanges) {
        hash.update(name).update('\0');
        hashFrame(hash, ea[name]);
        hashFrame(hash, eb[name]);
    }
    return hash.digest('hex');
}

/** Fingerprint of a plain file's before→after delta, for fan-out grouping. */
function fileDeltaHash(a, b) {
    const hash = createHash('sha256');
    hashFrame(hash, a);
    hashFrame(hash, b);
    return hash.digest('hex');
}

/** Inner entry names that differ (normalized) between two zip buffers. */
function zipInnerChanges(a, b) {
    const ea = readZipEntries(a);
    const eb = readZipEntries(b);
    const names = [...new Set([...Object.keys(ea), ...Object.keys(eb)])].sort();
    return names.filter(n => !ea[n] || !eb[n] || !normalizedEqual(n, ea[n], eb[n]));
}

/** Recursively list files under dir as tree-relative paths. */
function listFiles(dir, prefix = '') {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
        else out.push(rel);
    }
    return out;
}

/**
 * Diff two dist trees. Returns { changes: [{ path, kind }] } where kind is
 * 'added' | 'removed' | 'changed'.
 */
export async function diffDistTrees(beforeDir, afterDir) {
    const beforeFiles = new Set(listFiles(beforeDir));
    const afterFiles = new Set(listFiles(afterDir));
    const changes = [];

    for (const path of [...new Set([...beforeFiles, ...afterFiles])].sort()) {
        if (!beforeFiles.has(path)) {
            changes.push({ path, kind: 'added' });
        } else if (!afterFiles.has(path)) {
            changes.push({ path, kind: 'removed' });
        } else {
            const a = readFileSync(join(beforeDir, path));
            const b = readFileSync(join(afterDir, path));
            try {
                if (normalizedEqual(path, a, b)) continue;
            } catch (err) {
                // A file our own build just wrote but can't be read back (e.g.
                // a truncated zip) is a broken build — fail loudly, naming it.
                throw new Error(`dist-diff failed reading ${path}: ${err.message}`, { cause: err });
            }
            if (path.endsWith('.zip')) {
                const innerChanges = zipInnerChanges(a, b);
                changes.push({ path, kind: 'changed', innerChanges, deltaHash: zipDeltaHash(a, b, innerChanges) });
            } else {
                changes.push({ path, kind: 'changed', deltaHash: fileDeltaHash(a, b) });
            }
        }
    }
    return { beforeDir, afterDir, changes };
}

/** Review surfaces, ordered by user impact. classify() returns the first match. */
const SURFACES = [
    { key: 'wizard', title: 'Wizard surface', match: p => p === 'skills/skill-menu.json' },
    {
        key: 'skill-content',
        title: 'Skill content',
        match: p => p.startsWith('skills/') && p !== 'skills/manifest.json',
    },
    { key: 'marketplace', title: 'Marketplace', match: p => p.startsWith('marketplace/') },
    { key: 'agents', title: 'Agents', match: p => p.startsWith('agents/') },
    {
        key: 'mcp',
        title: 'MCP manifest',
        match: p => p === 'skills/manifest.json' || p === 'skills-mcp-resources.zip',
    },
    { key: 'mirror', title: 'Skills-repo mirror', match: p => p === 'push-manifest.json' },
    { key: 'other', title: 'Other artifacts', match: () => true },
];

function classify(path) {
    return SURFACES.find(s => s.match(path)).key;
}

function bucketBySurface(model) {
    const bySurface = new Map(SURFACES.map(s => [s.key, []]));
    for (const change of model.changes) bySurface.get(classify(change.path)).push(change);
    return bySurface;
}

// Report bodies are ```diff fenced blocks: a leading '+' renders green,
// '-' renders red, and any other first character (we use '~' and ' ') gray.
const STATUS = { added: '+', removed: '-', changed: '~' };
const MAX_INLINE_INNER = 5;

/** Path prefix implied by a surface's title, stripped inside its block. */
const SURFACE_STRIP = { 'skill-content': 'skills/', marketplace: 'marketplace/', agents: 'agents/' };

function stripSurfacePrefix(surfaceKey, path) {
    const prefix = SURFACE_STRIP[surfaceKey];
    return prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Grouping key for a changed artifact: same key ⇔ identical delta. */
function deltaKey(change) {
    return change.innerChanges
        ? `zip:${change.innerChanges.join('|')}#${change.deltaHash}`
        : `file:#${change.deltaHash}`;
}

/** " — inner1, inner2" suffix for a zip change, optionally capped. */
function innerSuffix(change, capInner) {
    if (!change.innerChanges?.length) return '';
    return ` — ${capInner ? capList(change.innerChanges) : change.innerChanges.join(', ')}`;
}

/**
 * Render changes as an indented directory tree (single-child directory chains
 * collapsed, `tree`-style). A directory whose descendants all share one status
 * carries that status char itself, so a freshly added subtree is solid green.
 */
function treeLines(items, { capInner = true } = {}) {
    const root = { dirs: new Map(), files: [] };
    for (const { rel, change } of items) {
        const segs = rel.split('/');
        let node = root;
        for (const seg of segs.slice(0, -1)) {
            if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: [] });
            node = node.dirs.get(seg);
        }
        node.files.push({ name: segs.at(-1), change });
    }
    const kindsOf = node => [
        ...node.files.map(f => f.change.kind),
        ...[...node.dirs.values()].flatMap(kindsOf),
    ];
    const lines = [];
    const emit = (node, depth) => {
        for (const [name, start] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
            let label = name;
            let child = start;
            while (child.files.length === 0 && child.dirs.size === 1) {
                const [[next, sub]] = child.dirs;
                label = `${label}/${next}`;
                child = sub;
            }
            const kinds = new Set(kindsOf(child));
            const status = kinds.size === 1 ? STATUS[[...kinds][0]] : ' ';
            // A directory holding exactly one file collapses onto one line.
            if (child.dirs.size === 0 && child.files.length === 1) {
                const f = child.files[0];
                lines.push(`${STATUS[f.change.kind]} ${'  '.repeat(depth)}${label}/${f.name}${innerSuffix(f.change, capInner)}`);
                continue;
            }
            lines.push(`${status} ${'  '.repeat(depth)}${label}/`);
            emit(child, depth + 1);
        }
        for (const f of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) {
            lines.push(`${STATUS[f.change.kind]} ${'  '.repeat(depth)}${f.name}${innerSuffix(f.change, capInner)}`);
        }
    };
    emit(root, 0);
    return lines;
}

/** Added/removed cliEntries between the two skill menus. */
function cliEntryDelta(model) {
    const read = dir => {
        try {
            return JSON.parse(readFileSync(join(dir, 'skills/skill-menu.json'), 'utf8')).cliEntries ?? [];
        } catch {
            return [];
        }
    };
    const key = e => [e.skillId, e.parentCommand, e.command].join('|');
    const beforeEntries = new Map(read(model.beforeDir).map(e => [key(e), e]));
    const afterEntries = new Map(read(model.afterDir).map(e => [key(e), e]));
    return {
        added: [...afterEntries.values()].filter(e => !beforeEntries.has(key(e))),
        removed: [...beforeEntries.values()].filter(e => !afterEntries.has(key(e))),
        modified: [...afterEntries.values()].filter(e => {
            const prev = beforeEntries.get(key(e));
            return prev && JSON.stringify(prev) !== JSON.stringify(e);
        }),
    };
}

function describeEntry(e) {
    const cmd = e.command ? `, command: ${e.parentCommand ? `${e.parentCommand} ` : ''}${e.command}` : '';
    return `${e.skillId} (role: ${e.role}${cmd})`;
}

/** Diff-block lines for the wizard surface: semantic cliEntry delta. */
function wizardBlock(model) {
    const { added, removed, modified } = cliEntryDelta(model);
    const block = [
        ...added.map(e => `+ cliEntry ${describeEntry(e)}`),
        ...removed.map(e => `- cliEntry ${describeEntry(e)}`),
        ...modified.map(e => `~ cliEntry ${e.skillId} updated`),
    ];
    return block.length ? block : ['~ skill-menu.json changed (no cliEntry changes)'];
}

/**
 * Render the sticky-comment report: surfaces ordered by user impact, explicit
 * "unchanged" assertions, hard line budget.
 */
export function renderComment(model, { fullReportUrl } = {}) {
    const bySurface = bucketBySurface(model);

    // Build per-surface segments first, so the budget can trim inside diff
    // blocks while the surface headers and "✓ unchanged" assertions — the
    // report's core guarantee — always survive truncation.
    const segments = [];
    for (const surface of SURFACES) {
        const changes = bySurface.get(surface.key);
        if (surface.key === 'other' && changes.length === 0) continue;
        if (changes.length === 0) {
            segments.push({ head: [`**${surface.title}** ✓ unchanged`], block: null, after: [] });
            continue;
        }
        const { block, after } = surface.key === 'wizard'
            ? { block: wizardBlock(model), after: [] }
            : surfaceBlock(changes, surface.key);
        segments.push({ head: [`**${surface.title}**`], block, after });
    }

    const BUDGET = 40;
    const fixedCost = 1 + (fullReportUrl ? 2 : 0)
        + segments.reduce((n, s) => n + 1 + s.head.length + (s.block ? 2 : 0) + s.after.length, 0);
    let overflow = segments.reduce((n, s) => n + (s.block?.length ?? 0), 0) - (BUDGET - fixedCost);
    if (overflow > 0) {
        // Trim the largest blocks first; each trimmed block keeps its first
        // lines plus a gray pointer at the full report.
        for (const s of [...segments].sort((a, b) => (b.block?.length ?? 0) - (a.block?.length ?? 0))) {
            if (overflow <= 0) break;
            const len = s.block?.length ?? 0;
            if (len < 4) continue;
            const cut = Math.min(overflow + 1, len - 2);
            s.block.length = len - cut;
            s.block.push(`~ …${cut} more line(s) — see the full report in the workflow summary`);
            overflow -= cut - 1;
        }
    }

    const lines = [`## dist-diff — ${model.changes.length} artifact change(s)`];
    for (const s of segments) {
        // Blank line between blocks — without it, GFM folds a line that
        // follows a fenced block or list into the preceding element.
        lines.push('', ...s.head);
        if (s.block) lines.push('```diff', ...s.block, '```', ...s.after);
    }
    if (fullReportUrl) lines.push('', `[Full report](${fullReportUrl})`);
    return lines.join('\n');
}

// Content-hunk limits for the full report: the step summary allows ~1MB, but
// a diff nobody can scan is worse than a truncated one.
const MAX_HUNK_LINES = 120;
const MAX_LINE_CHARS = 300;
const MAX_DIFF_BYTES = 300 * 1024;

function isText(buf) {
    return !buf.subarray(0, 8192).includes(0);
}

function hunkLines(oldStr, newStr) {
    const patch = structuredPatch('a', 'b', oldStr, newStr, '', '', { context: 3 });
    const lines = [];
    for (const h of patch.hunks) {
        lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
        lines.push(...h.lines);
    }
    return lines.map(l => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l));
}

function capHunks(lines) {
    if (lines.length <= MAX_HUNK_LINES) return lines;
    return [...lines.slice(0, MAX_HUNK_LINES), `… ${lines.length - MAX_HUNK_LINES} more diff line(s) omitted`];
}

/** Unified-diff lines for one artifact (added/removed diff against empty). */
function changeHunks(model, change) {
    const tooLarge = size => `(too large to diff: ${Math.round(size / 1024)} KB)`;
    const a = change.kind === 'added' ? Buffer.alloc(0) : readFileSync(join(model.beforeDir, change.path));
    const b = change.kind === 'removed' ? Buffer.alloc(0) : readFileSync(join(model.afterDir, change.path));
    if (change.path.endsWith('.zip')) {
        const ea = a.length ? readZipEntries(a) : {};
        const eb = b.length ? readZipEntries(b) : {};
        const names = change.innerChanges
            ?? [...new Set([...Object.keys(ea), ...Object.keys(eb)])].sort();
        const lines = [];
        for (const name of names) {
            lines.push(`# ${name}`);
            if (name.endsWith('.zip')) {
                lines.push('(nested archive — its contents are diffed as individual skill zips)');
                continue;
            }
            const ia = ea[name] ?? Buffer.alloc(0);
            const ib = eb[name] ?? Buffer.alloc(0);
            // Gate on DECOMPRESSED size — a tiny archive can hold a huge entry.
            if (ia.length > MAX_DIFF_BYTES || ib.length > MAX_DIFF_BYTES) {
                lines.push(tooLarge(Math.max(ia.length, ib.length)));
                continue;
            }
            if (!isText(ia) || !isText(ib)) {
                lines.push('(binary entry)');
                continue;
            }
            lines.push(...hunkLines(ia.toString('utf8'), ib.toString('utf8')));
        }
        return capHunks(lines);
    }
    if (a.length > MAX_DIFF_BYTES || b.length > MAX_DIFF_BYTES) {
        return [tooLarge(Math.max(a.length, b.length))];
    }
    if (!isText(a) || !isText(b)) return ['(binary file)'];
    return capHunks(hunkLines(a.toString('utf8'), b.toString('utf8')));
}

/**
 * Content sections for a surface's changed artifacts, one per unique delta:
 * an identical-delta fan-out shows its hunk once, titled with the member count.
 */
function contentSections(model, changes) {
    const groups = new Map();
    for (const change of changes) {
        const key = change.kind === 'changed' && change.deltaHash ? deltaKey(change) : `single:${change.path}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(change);
    }
    return [...groups.values()].map(members => ({
        title: members.length > 1
            ? `${members.length} files — identical delta (${commonPathSuffix(members.map(m => m.path)) || members[0].path})`
            : members[0].path,
        hunks: changeHunks(model, members[0]),
    }));
}

/** Render the full report: every change listed; content hunks size-budgeted. */
export function renderFull(model) {
    const bySurface = bucketBySurface(model);
    const lines = [`# dist-diff full report — ${model.changes.length} artifact change(s)`, ''];
    let hunkBudget = 4000;
    for (const surface of SURFACES) {
        const changes = bySurface.get(surface.key);
        if (surface.key === 'other' && changes.length === 0) continue;
        lines.push(`## ${surface.title}`, '');
        if (changes.length === 0) {
            lines.push('✓ unchanged', '');
            continue;
        }
        if (surface.key === 'wizard') {
            lines.push('```diff', ...wizardBlock(model), '```', '');
        }
        // Complete tree of every change — nothing grouped, nothing capped.
        lines.push('```diff');
        lines.push(...treeLines(
            changes.map(c => ({ rel: stripSurfacePrefix(surface.key, c.path), change: c })),
            { capInner: false },
        ));
        lines.push('```', '');
        // Content-level hunks, one per unique delta, under a report-wide
        // budget — the step summary rejects anything over 1MB.
        const sections = contentSections(model, changes);
        let omitted = 0;
        for (const { title, hunks } of sections) {
            if (hunkBudget <= 0) { omitted++; continue; }
            hunkBudget -= hunks.length;
            lines.push(`<details><summary>${title}</summary>`, '', '```diff', ...hunks, '```', '', '</details>', '');
        }
        if (omitted) {
            lines.push(`_${omitted} more content diff(s) omitted for size — run \`npm run diff\` locally for the complete set._`, '');
        }
    }
    return lines.join('\n');
}

/**
 * One surface's diff-block content plus its <details> member lists (which
 * are HTML and must live outside the code fence). Fan-out collapses in three
 * ways:
 *  - changed files/zips with an IDENTICAL delta → one "identical delta" line
 *  - ≥4 changed items touching the same file name / inner-file set with
 *    differing contents (a skill rebuilt across variants) → one line
 *  - ≥4 files added/removed in the same directory (a new variant) → one line
 * Everything below the thresholds is rendered as a directory tree.
 */
const GROUP_MIN = 4;

function surfaceBlock(changes, surfaceKey) {
    const block = [];
    const after = [];
    const singles = [];
    const exactGroups = new Map();
    const dirBuckets = new Map();
    for (const change of changes) {
        if (change.kind === 'changed' && change.deltaHash) {
            const key = deltaKey(change);
            if (!exactGroups.has(key)) exactGroups.set(key, []);
            exactGroups.get(key).push(change);
        } else {
            const dir = change.path.slice(0, change.path.lastIndexOf('/') + 1);
            const key = `${change.kind}:${dir}`;
            if (!dirBuckets.has(key)) dirBuckets.set(key, []);
            dirBuckets.get(key).push(change);
        }
    }

    // A new variant lands as one directory tree; fold each bucket into the
    // shallowest same-kind bucket whose directory contains it. The root
    // bucket (empty dir, key "kind:") is a string-prefix of every same-kind
    // key and has no meaningful label — it never folds or groups.
    const isRootKey = k => k.endsWith(':');
    const dirKeys = [...dirBuckets.keys()].sort((a, b) => a.length - b.length);
    for (const key of dirKeys) {
        if (!dirBuckets.has(key)) continue;
        const ancestor = dirKeys.find(k => k !== key && !isRootKey(k) && dirBuckets.has(k) && key.startsWith(k));
        if (ancestor) {
            dirBuckets.get(ancestor).push(...dirBuckets.get(key));
            dirBuckets.delete(key);
        }
    }
    for (const [key, members] of dirBuckets) {
        if (members.length >= GROUP_MIN && !isRootKey(key)) {
            const dir = stripSurfacePrefix(surfaceKey, key.slice(key.indexOf(':') + 1));
            block.push(`${STATUS[members[0].kind]} ${dir} — ${members.length} files ${members[0].kind}`);
            after.push(`<details><summary>${dir} (${members.length} files)</summary>${members.map(m => m.path).join(', ')}</details>`);
        } else {
            singles.push(...members);
        }
    }

    // Merge exact-delta groups that share a signature (same inner-file set for
    // zips, same file name for plain files) — a rebuild fans out over dozens
    // of variants whose contents differ per variant.
    const signatureBuckets = new Map();
    for (const members of exactGroups.values()) {
        const first = members[0];
        const sig = first.innerChanges ? `zip:${first.innerChanges.join('|')}` : `file:${first.path.split('/').pop()}`;
        if (!signatureBuckets.has(sig)) signatureBuckets.set(sig, []);
        signatureBuckets.get(sig).push(members);
    }
    for (const groups of signatureBuckets.values()) {
        const total = groups.reduce((n, g) => n + g.length, 0);
        const first = groups[0][0];
        let label = null;
        if (groups.length === 1 && total > 1) {
            label = first.innerChanges
                ? `${total} zips changed — identical delta in ${capList(first.innerChanges)}`
                : `${total} files changed — identical delta (${commonPathSuffix(groups[0].map(m => m.path)) || 'no common name'})`;
        } else if (groups.length > 1 && total >= GROUP_MIN) {
            label = first.innerChanges
                ? `${total} zips changed — same files touched (${capList(first.innerChanges)}), contents differ per archive`
                : `${total} files changed — same file name (${first.path.split('/').pop()}), contents differ`;
        }
        if (label) {
            block.push(`~ ${label}`);
            after.push(`<details><summary>${first.innerChanges ? 'archives' : 'files'} (${total})</summary>${groups.flat().map(m => m.path).join(', ')}</details>`);
        } else {
            singles.push(...groups.flat());
        }
    }

    block.push(...treeLines(singles.map(c => ({ rel: stripSurfacePrefix(surfaceKey, c.path), change: c }))));
    return { block, after };
}

/** Comma-joined list, capped at MAX_INLINE_INNER with a "+N more" tail. */
function capList(names) {
    if (names.length <= MAX_INLINE_INNER) return names.join(', ');
    return [...names.slice(0, MAX_INLINE_INNER), `…+${names.length - MAX_INLINE_INNER} more`].join(', ');
}

/** Longest common trailing path segments, e.g. shared "references/4-conclude.md". */
function commonPathSuffix(paths) {
    const parts = paths.map(p => p.split('/'));
    const suffix = [];
    for (let i = 1; ; i++) {
        const seg = parts[0][parts[0].length - i];
        if (seg === undefined || !parts.every(p => p[p.length - i] === seg)) break;
        suffix.unshift(seg);
    }
    return suffix.join('/');
}
