#!/usr/bin/env node
/**
 * dist-diff CLI — show what a change does to the built artifacts in dist/.
 *
 * Usage:
 *   node scripts/diff-dist.js <beforeDist> <afterDist> [options]
 *   node scripts/diff-dist.js --against <git-ref> [options]
 *
 * Options:
 *   --format comment|full   comment: sticky-comment report (default); full: complete listing
 *   --summary-url URL       append a "Full report" link to the comment format
 *   --exit-code             exit 1 when the normalized diff is non-empty (like `git diff --exit-code`);
 *                           CI uses this to assert two builds of the same ref are identical
 *
 * --against builds the given ref in a temporary worktree and rebuilds the
 * local dist/, both sharing the current .docs-cache — so upstream doc drift
 * cannot appear in the diff (same guarantee the CI job gets by running both
 * builds in one job).
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { diffDistTrees, renderComment, renderFull } from './lib/dist-diff.js';

const options = { positional: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
        case '--against': options.against = argv[++i]; break;
        case '--format': options.format = argv[++i]; break;
        case '--summary-url': options.summaryUrl = argv[++i]; break;
        case '--exit-code': options.exitCode = true; break;
        default: options.positional.push(argv[i]);
    }
}

const repoRoot = resolve(import.meta.dirname, '..');

function buildRefDist(ref) {
    const worktree = mkdtempSync(join(tmpdir(), 'dist-diff-base-'));
    execFileSync('git', ['worktree', 'add', '--detach', worktree, ref], { cwd: repoRoot, stdio: 'inherit' });
    try {
        symlinkSync(join(repoRoot, 'node_modules'), join(worktree, 'node_modules'));
        // Share the docs cache so both sides see identical upstream doc bytes.
        if (existsSync(join(repoRoot, '.docs-cache'))) {
            symlinkSync(join(repoRoot, '.docs-cache'), join(worktree, '.docs-cache'));
        }
        execFileSync('node', ['scripts/build.js'], { cwd: worktree, stdio: 'inherit' });
        return { worktree, dist: join(worktree, 'dist') };
    } catch (err) {
        rmSync(worktree, { recursive: true, force: true });
        execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot });
        throw err;
    }
}

let beforeDir, afterDir, cleanup;
if (options.against) {
    console.error(`Building ${options.against} in a temporary worktree...`);
    const base = buildRefDist(options.against);
    beforeDir = base.dist;
    afterDir = join(repoRoot, 'dist');
    cleanup = () => {
        rmSync(base.worktree, { recursive: true, force: true });
        execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot });
    };
    // Always rebuild — a dist/ left over from another ref would silently
    // poison the comparison. The base build above primed .docs-cache.
    console.error('Rebuilding local dist/...');
    execFileSync('node', ['scripts/build.js'], { cwd: repoRoot, stdio: 'inherit' });
} else {
    [beforeDir, afterDir] = options.positional;
    if (!beforeDir || !afterDir) {
        console.error('Usage: diff-dist.js <beforeDist> <afterDist> | --against <ref>  [--format comment|full] [--summary-url URL] [--exit-code]');
        process.exit(2);
    }
}

try {
    const model = await diffDistTrees(beforeDir, afterDir);
    if (options.format === 'full') {
        console.log(renderFull(model));
    } else {
        console.log(renderComment(model, { fullReportUrl: options.summaryUrl }));
    }
    if (options.exitCode && model.changes.length) process.exitCode = 1;
} finally {
    cleanup?.();
}
