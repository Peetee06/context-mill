import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateMarketplace } from '../marketplace-generator.js';

// Two skills from different groups sharing one category — the real shape of the
// collision: `omnibus/instrument-integration` and `omnibus/instrument-product-analytics`
// both declare `category: integration` with a single variant `id: all`.
const skill = (id, extra = {}) => ({
    id,
    shortId: 'all',
    category: 'integration',
    displayName: id,
    description: `${id} description`,
    ...extra,
});

let dir;
const tempDir = () => path.join(dir, 'built');
const configDir = () => path.join(dir, 'context');
const outputDir = () => path.join(dir, 'dist');
const pluginSkills = plugin =>
    fs.readdirSync(path.join(outputDir(), 'marketplace', 'plugins', plugin, 'skills'));

function writeSkillSource(id) {
    const skillDir = path.join(tempDir(), id);
    fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `name: ${id}`);
    fs.writeFileSync(path.join(skillDir, 'references', `${id}.md`), `${id} docs`);
}

const run = skills =>
    generateMarketplace({
        skills,
        tempDir: tempDir(),
        version: 'test',
        outputDir: outputDir(),
        configDir: configDir(),
    });

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-generator-'));
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(
        path.join(configDir(), 'marketplace.yaml'),
        [
            'target_repo: PostHog/skills',
            'mega_plugin:',
            '  name: posthog-all',
            '  destination: skills/posthog/all',
            'plugins:',
            '  integration:',
            '    name: posthog-integration',
            '    destination: skills/posthog/integration',
        ].join('\n'),
    );
    writeSkillSource('omnibus-instrument-integration');
    writeSkillSource('omnibus-instrument-product-analytics');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('generateMarketplace', () => {
    it('gives every skill in a plugin its own directory, keyed by full id', () => {
        const skills = [
            skill('omnibus-instrument-integration'),
            skill('omnibus-instrument-product-analytics'),
        ];

        const result = run(skills);

        // Keying by `shortId` collapsed both skills into `skills/all`, so one was
        // silently dropped and the survivor inherited the loser's leftover files.
        expect(pluginSkills('posthog-integration').sort()).toEqual([
            'omnibus-instrument-integration',
            'omnibus-instrument-product-analytics',
        ]);
        expect(result.skillCount).toBe(skills.length);
    });

    it('copies each skill intact, with no files bleeding across siblings', () => {
        run([
            skill('omnibus-instrument-integration'),
            skill('omnibus-instrument-product-analytics'),
        ]);

        const dirOf = id =>
            path.join(outputDir(), 'marketplace', 'plugins', 'posthog-integration', 'skills', id);

        for (const id of ['omnibus-instrument-integration', 'omnibus-instrument-product-analytics']) {
            expect(fs.readFileSync(path.join(dirOf(id), 'SKILL.md'), 'utf8')).toBe(`name: ${id}`);
            expect(fs.readdirSync(path.join(dirOf(id), 'references'))).toEqual([`${id}.md`]);
        }
    });

    it('throws rather than overwriting when two skills share an id', () => {
        expect(() =>
            run([skill('omnibus-instrument-integration'), skill('omnibus-instrument-integration')]),
        ).toThrow(/duplicate skill id "omnibus-instrument-integration"/);
    });
});
