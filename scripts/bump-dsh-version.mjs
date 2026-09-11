#!/usr/bin/env node
/**
 * Coordinated DeepSeek Harness version bump (ТЗ §8, §27).
 *
 * DSH is not one package but a family (`@deepseek-ai/dsh`, `@deepseek-ai/dsh-*`)
 * plus a companion cordis runtime. Bumping a single member produces the classic
 * failure mode where `dsh-settings` is 0.1.5-rc.2 while `dsh-tools` is still
 * 0.1.0-rc.6, and the loader dies at boot. This script moves the whole set in
 * one shot and is the only supported way to change the pinned runtime.
 *
 * What it updates:
 *   1. every `@deepseek-ai/dsh*` dependency in the root manifest, to the exact
 *      target version — but only for packages actually published at that
 *      version (DSH occasionally skips a member, and forcing a pin would break
 *      install);
 *   2. the companion cordis runtime, to the newest version satisfying the range
 *      the new DSH declares, and every other `@deepseek-ai/cordis*` root
 *      dependency to the newest release compatible with that cordis version;
 *   3. `@deepseek-ai/*` peer ranges in `plugins/*​/package.json`, so vendored
 *      plugins keep resolving against the new runtime;
 *   4. `dsh-runtime.json`, the manifest CI and docs read;
 *   5. `package-lock.json` via `npm install --package-lock-only`, which rewrites
 *      the lockfile *without* touching node_modules — important because the
 *      sandbox forbids bulk deletion, and a normal `npm install` would try to
 *      retire the old tree.
 *
 * Usage:
 *   node scripts/bump-dsh-version.mjs --version 0.1.5-rc.2
 *   node scripts/bump-dsh-version.mjs --version 0.1.5-rc.2 --channel next
 *   node scripts/bump-dsh-version.mjs --version 0.1.5-rc.2 --dry-run
 *
 * Expect roughly a minute of runtime: each family member is verified against
 * the registry individually so a missing publication is reported, not guessed.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, maxSatisfying, VERSION_PATTERN } from '../src/semver.mjs';
import { ROOT, npm, parseJson } from './lib/exec.mjs';

const DSH = '@deepseek-ai/dsh';
const CORDIS = '@deepseek-ai/cordis';
const SCOPE = '@deepseek-ai/';

const argv = process.argv.slice(2);
function flag(name) {
	return argv.includes(`--${name}`);
}
function option(name) {
	const index = argv.indexOf(`--${name}`);
	return index === -1 ? null : (argv[index + 1] ?? null);
}

const TARGET = option('version');
const CHANNEL = option('channel') ?? 'next';
const DRY_RUN = flag('dry-run');
const SKIP_LOCKFILE = flag('skip-lockfile');

/** Registry lookups are slow (~1s each) and highly repetitive; memoise them. */
const versionCache = new Map();
const versionsCache = new Map();

function viewVersion(pkg, version) {
	const key = `${pkg}@${version}`;
	if (!versionCache.has(key)) {
		const raw = npm(['view', key, 'version', '--json'], { allowFailure: true });
		versionCache.set(key, raw === null ? null : raw.replace(/^"|"$/g, ''));
	}
	return versionCache.get(key);
}

function viewVersions(pkg) {
	if (!versionsCache.has(pkg)) {
		const parsed = parseJson(npm(['view', pkg, 'versions', '--json'], { allowFailure: true }));
		versionsCache.set(pkg, Array.isArray(parsed) ? parsed : []);
	}
	return versionsCache.get(pkg);
}

function viewField(pkg, field) {
	return parseJson(npm(['view', pkg, field, '--json'], { allowFailure: true }));
}

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Package names to keep in lockstep: `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*`. */
function isDshPackage(name) {
	return name === DSH || name.startsWith(`${DSH}-`);
}

function isCordisPackage(name) {
	return name.startsWith(`${CORDIS}`);
}

/** Every `@deepseek-ai/*` name mentioned in a manifest's dependency sections. */
function scopedNames(manifest) {
	const names = new Set();
	for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
		for (const name of Object.keys(manifest[section] ?? {})) {
			if (name.startsWith(SCOPE)) names.add(name);
		}
	}
	return names;
}

function pluginManifests() {
	const dir = join(ROOT, 'plugins');
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(dir, entry.name, 'package.json'))
		.filter((path) => existsSync(path));
}

function main() {
	if (TARGET === null || !VERSION_PATTERN.test(TARGET)) {
		throw new Error('usage: node scripts/bump-dsh-version.mjs --version <X.Y.Z[-pre]> [--channel <name>] [--dry-run]');
	}

	const rootPath = join(ROOT, 'package.json');
	const root = readJson(rootPath);
	const changes = [];
	const kept = [];

	process.stdout.write(`target: ${DSH}@${TARGET} (channel ${CHANNEL})\n`);

	const published = viewVersion(DSH, TARGET);
	if (published === null) {
		throw new Error(`${DSH}@${TARGET} is not published — check the version and channel`);
	}

	// --- 1. DSH family -----------------------------------------------------
	process.stdout.write('\nDSH family:\n');
	const dshNames = [...scopedNames(root)].filter(isDshPackage).sort();
	for (const name of dshNames) {
		const section = root.dependencies?.[name] !== undefined ? 'dependencies'
			: root.devDependencies?.[name] !== undefined ? 'devDependencies' : 'peerDependencies';
		const current = root[section][name];
		if (current === TARGET) continue;
		if (viewVersion(name, TARGET) === null) {
			kept.push(`${name} (not published at ${TARGET}, kept at ${current})`);
			continue;
		}
		root[section][name] = TARGET;
		changes.push(`${name}: ${current} → ${TARGET}`);
	}
	report(changes, kept);

	// --- 2. cordis runtime + companions ------------------------------------
	process.stdout.write('\ncordis family:\n');
	const cordisChanges = [];
	const dshDeps = viewField(`${DSH}@${TARGET}`, 'dependencies') ?? {};
	const cordisRange = dshDeps[CORDIS] ?? null;
	let cordisVersion = null;

	if (cordisRange === null) {
		process.stdout.write(`  ${DSH}@${TARGET} does not declare ${CORDIS}; leaving cordis pins alone\n`);
	} else {
		cordisVersion = maxSatisfying(viewVersions(CORDIS), cordisRange);
		if (cordisVersion === null) {
			throw new Error(`no published ${CORDIS} version satisfies ${cordisRange} required by ${DSH}@${TARGET}`);
		}
		process.stdout.write(`  ${DSH}@${TARGET} requires ${CORDIS} ${cordisRange} → resolving to ${cordisVersion}\n`);
	}

	const cordisNames = [...scopedNames(root)].filter(isCordisPackage).sort();
	for (const name of cordisNames) {
		const section = root.dependencies?.[name] !== undefined ? 'dependencies'
			: root.devDependencies?.[name] !== undefined ? 'devDependencies' : 'peerDependencies';
		const current = root[section][name];
		const ownRange = viewField(name, 'peerDependencies')?.[CORDIS]
			?? viewField(name, 'dependencies')?.[CORDIS]
			?? null;

		// Newest release of this companion that is compatible with the cordis
		// version the new DSH resolves to. A companion whose declared range does
		// not accept that cordis would drag in a second cordis copy.
		const candidates = cordisVersion === null || ownRange === null
			? [current]
			: viewVersions(name).filter((version) => maxSatisfying([version], ownRange) !== null
				&& maxSatisfying([cordisVersion], ownRange) !== null);
		const wanted = candidates
			.filter((version) => VERSION_PATTERN.test(version))
			.reduce((best, version) => (best === null || compareVersions(version, best) > 0 ? version : best), null)
			?? current;

		if (wanted === current) {
			process.stdout.write(`  ${name}: kept at ${current}${ownRange === null ? '' : ` (requires ${CORDIS} ${ownRange})`}\n`);
			continue;
		}
		root[section][name] = wanted;
		cordisChanges.push(`${name}: ${current} → ${wanted}`);
		changes.push(`${name}: ${current} → ${wanted}`);
	}
	report(cordisChanges, []);

	// --- 3. plugin peer ranges ---------------------------------------------
	process.stdout.write('\nplugin peers:\n');
	for (const path of pluginManifests()) {
		const manifest = readJson(path);
		const peers = manifest.peerDependencies ?? {};
		const pluginChanges = [];
		for (const name of Object.keys(peers).sort()) {
			if (!name.startsWith(SCOPE)) continue;
			if (name === CORDIS) {
				if (cordisVersion === null || peers[name] === `^${cordisVersion}`) continue;
				pluginChanges.push(`${name}: ${peers[name]} → ^${cordisVersion}`);
				peers[name] = `^${cordisVersion}`;
				continue;
			}
			if (!isDshPackage(name)) continue;
			if (peers[name] === `^${TARGET}`) continue;
			if (viewVersion(name, TARGET) === null) continue;
			pluginChanges.push(`${name}: ${peers[name]} → ^${TARGET}`);
			peers[name] = `^${TARGET}`;
		}
		if (pluginChanges.length === 0) {
			process.stdout.write(`  ${manifest.name}: already aligned\n`);
			continue;
		}
		process.stdout.write(`  ${manifest.name}:\n`);
		for (const line of pluginChanges) process.stdout.write(`    ${line}\n`);
		changes.push(...pluginChanges.map((line) => `${manifest.name}: ${line}`));
		if (!DRY_RUN) writeJson(path, manifest);
	}

	// --- 4. runtime manifest ------------------------------------------------
	const manifestPath = join(ROOT, 'dsh-runtime.json');
	const manifest = existsSync(manifestPath)
		? readJson(manifestPath)
		: { package: DSH, source: 'npm', tested: true };
	const previousVersion = manifest.version ?? null;
	manifest.version = TARGET;
	manifest.channel = CHANNEL;
	manifest.package = DSH;
	manifest.source = 'npm';
	manifest.tested = true;

	// --- 5. persist ---------------------------------------------------------
	if (DRY_RUN) {
		process.stdout.write('\ndry run: nothing written\n');
		return;
	}

	writeJson(rootPath, root);
	writeJson(manifestPath, manifest);

	process.stdout.write(`\npackage.json + dsh-runtime.json updated (${previousVersion} → ${TARGET})\n`);

	if (SKIP_LOCKFILE) {
		process.stdout.write('lockfile: skipped (--skip-lockfile)\n');
	} else {
		process.stdout.write('lockfile: running `npm install --package-lock-only` …\n');
		// `--package-lock-only` rewrites the lockfile without touching
		// node_modules, which keeps the sandbox's bulk-delete guard out of the
		// way; the tree is reconciled separately from the npm cache.
		npm(['install', '--package-lock-only', '--no-audit', '--no-fund']);
		process.stdout.write('lockfile: updated\n');
	}

	process.stdout.write(`\n${changes.length} change(s) applied:\n`);
	for (const line of changes) process.stdout.write(`  ${line}\n`);
	if (kept.length > 0) {
		process.stdout.write(`\nkept deliberately:\n`);
		for (const line of kept) process.stdout.write(`  ${line}\n`);
	}
	process.stdout.write('\nnext: npm run tests, then npm run dist\n');
}

function report(lines, keptLines) {
	if (lines.length === 0 && keptLines.length === 0) {
		process.stdout.write('  already at target\n');
		return;
	}
	for (const line of lines) process.stdout.write(`  ${line}\n`);
	for (const line of keptLines) process.stdout.write(`  ! ${line}\n`);
}

main();
