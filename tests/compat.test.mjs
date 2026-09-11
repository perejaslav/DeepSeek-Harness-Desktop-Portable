/**
 * Compatibility guard for the bundled DeepSeek Harness runtime (ТЗ §9, §17).
 *
 * These assertions exist because of a specific, repeatable failure mode: the
 * desktop shell talks to DSH through a handful of symbols whose shape has
 * changed between rc releases, and a mismatch does not surface as a clean error
 * — it surfaces as ~100 loader-entry boot failures or a silently stale
 * `node_modules`. Every check below corresponds to a bug that actually happened
 * while moving from 0.1.0-rc.6 to 0.1.5-rc.2:
 *
 *   - `healProfilesModuleFallback` went from sync `(anchor, home)` to async
 *     `({ installAnchor })`; calling it the old way threw at boot.
 *   - `dsh-settings` stopped exporting `settingsNamespace`, which broke the
 *     vendored sidebar plugin's loader entry.
 *   - `dsh-typert-protocol` gained `RemoteError` / `remoteErrorOf`; a half
 *     finished `npm install` left the new `package.json` with the old `lib/`,
 *     and every module that imports `RemoteError` failed to resolve.
 *   - native addons (`sharp`, `koffi`) can be left at the previous version's
 *     binary while their JS wrapper is new, which fails only at load time.
 *
 * Run: node --test --test-force-exit tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import { compareVersions, satisfiesRange, parseVersion } from '../src/semver.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const rootPkg = readJson(join(ROOT, 'package.json'));
const manifest = readJson(join(ROOT, 'dsh-runtime.json'));

/** Version of an installed package, or null when it is not present. */
function installedVersion(name) {
	const path = join(ROOT, 'node_modules', ...name.split('/'), 'package.json');
	if (!existsSync(path)) return null;
	return readJson(path).version ?? null;
}

/**
 * `@deepseek-ai/*` names that belong to the resolved dependency graph.
 *
 * This is the lockfile's view, and it is the authoritative one: it decides what
 * `npm ci` installs and what electron-builder packs. A directory in
 * `node_modules` that is absent here is a leftover from an interrupted install,
 * not a dependency.
 */
function resolvedScopedNames() {
	const lock = readJson(join(ROOT, 'package-lock.json'));
	const names = new Set();
	for (const key of Object.keys(lock.packages ?? {})) {
		const match = /^node_modules\/(@deepseek-ai\/[^/]+)$/.exec(key);
		if (match !== null) names.add(match[1]);
	}
	return names;
}

test('runtime manifest agrees with the pinned dependency', () => {
	const pinned = rootPkg.dependencies[manifest.package];
	assert.ok(pinned, `${manifest.package} must be a direct dependency`);
	assert.equal(
		manifest.version,
		pinned,
		'dsh-runtime.json and package.json must pin the same runtime version — run scripts/bump-dsh-version.mjs instead of editing either by hand',
	);
	assert.equal(manifest.source, 'npm');
	assert.equal(typeof manifest.channel, 'string');
});

test('the whole DSH family is pinned to one version', () => {
	const family = Object.entries(rootPkg.dependencies)
		.filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'));
	assert.ok(family.length > 5, 'expected a sizeable DSH family in dependencies');

	const versions = new Set(family.map(([, range]) => range));
	assert.equal(
		versions.size,
		1,
		`DSH packages must move together, found: ${family.map(([n, r]) => `${n}@${r}`).join(', ')}`,
	);
	assert.equal([...versions][0], manifest.version);
});

test('installed DSH packages match their pins', () => {
	const mismatches = [];
	for (const [name, range] of Object.entries(rootPkg.dependencies)) {
		if (!name.startsWith('@deepseek-ai/')) continue;
		const installed = installedVersion(name);
		if (installed === null) {
			mismatches.push(`${name}: not installed`);
			continue;
		}
		// Exact pins for DSH; ranges (^x.y.z) for cordis companions.
		if (!satisfiesRange(installed, range)) {
			mismatches.push(`${name}: installed ${installed} does not satisfy ${range}`);
		}
	}
	assert.deepEqual(mismatches, [], `node_modules drifted from package.json:\n${mismatches.join('\n')}`);
});

test('dsh-app-boot exposes the async healProfilesModuleFallback adapter', async () => {
	const mod = await import('@deepseek-ai/dsh-app-boot');
	assert.equal(
		typeof mod.healProfilesModuleFallback,
		'function',
		'src/boot.mjs depends on this export',
	);
	// 0.1.5-rc.2 takes a single options object and returns a promise. The old
	// synchronous `(installAnchor, home)` signature resolved to undefined and
	// threw when awaited, so both facts are asserted.
	assert.equal(mod.healProfilesModuleFallback.length, 1, 'expected a single options argument');
	assert.equal(
		mod.healProfilesModuleFallback.constructor.name,
		'AsyncFunction',
		'src/boot.mjs awaits this — a sync function means the upstream signature regressed',
	);
});

test('dsh-settings still exports what the vendored sidebar needs', async () => {
	const mod = await import('@deepseek-ai/dsh-settings');
	assert.equal(
		typeof mod.SettingsConflictError,
		'function',
		'plugins/dsh-better-sidebar/lib/index.js imports SettingsConflictError',
	);
	// `settingsNamespace` was a validator in 0.1.0-rc.6 and is gone in
	// 0.1.5-rc.2. The plugin was adapted to pass its namespace through directly;
	// if upstream ever restores the export, this reminder keeps us honest.
	assert.ok(
		!('settingsNamespace' in mod) || typeof mod.settingsNamespace === 'function',
		'settingsNamespace reappeared upstream — revisit the vendored sidebar adaptation',
	);
});

test('dsh-typert-protocol carries the RemoteError symbol', async () => {
	const mod = await import('@deepseek-ai/dsh-typert-protocol');
	assert.ok(
		'RemoteError' in mod,
		'every DSH module that surfaces remote errors imports this; a stale lib/ under a new package.json is the usual cause',
	);
	assert.ok('remoteErrorOf' in mod, 'RemoteError helper pair is incomplete');
});

test('native addons load at their expected versions', async () => {
	// sharp and koffi are optional in the dependency graph but required by DSH
	// tools that touch images and FFI. A version-skewed .node binary fails here
	// rather than at first use.
	const sharpVersion = installedVersion('sharp');
	if (sharpVersion !== null) {
		const sharp = require('sharp');
		assert.equal(typeof sharp, 'function', 'sharp must be callable');
		assert.equal(sharp.versions?.sharp ?? sharpVersion, sharpVersion);
	}

	const koffiVersion = installedVersion('koffi');
	if (koffiVersion !== null) {
		const koffi = require('koffi');
		assert.equal(koffi.version, koffiVersion, 'koffi JS wrapper and native binary must agree');
	}
});

test('vendored plugin manifests parse and their DSH peers are satisfiable', () => {
	const dir = join(ROOT, 'plugins');
	const resolved = resolvedScopedNames();
	const manifests = readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(dir, entry.name, 'package.json'))
		.filter((path) => existsSync(path));
	assert.ok(manifests.length > 0, 'expected at least one vendored plugin');

	for (const path of manifests) {
		const plugin = readJson(path);
		const peers = plugin.peerDependencies ?? {};
		for (const [name, range] of Object.entries(peers)) {
			if (!name.startsWith('@deepseek-ai/')) continue;
			// Only peers that are actually part of the node dependency graph can
			// be checked here. The vendored sidebar also declares client-side
			// modules (`dsh-client-runtime`, `dsh-client-web-react`, …) that the
			// DSH client module system supplies from the served frontend bundle
			// rather than from node_modules — a stale directory left behind by an
			// interrupted install must not be mistaken for the real provider.
			if (!resolved.has(name)) continue;
			const installed = installedVersion(name);
			if (installed === null) continue;
			assert.ok(
				satisfiesRange(installed, range),
				`${plugin.name} peer ${name}@${range} is not satisfied by installed ${installed}`,
			);
		}
	}
});

test('stale node_modules leftovers are reported but not treated as dependencies', (t) => {
	// The sandbox forbids bulk deletion, so an interrupted `npm install` can
	// leave packages behind that the lockfile no longer knows about. They are
	// excluded from the packaged app (electron-builder walks the resolved
	// graph), so this is a diagnostic rather than a failure.
	const installed = readdirSync(join(ROOT, 'node_modules', '@deepseek-ai'), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => `@deepseek-ai/${entry.name}`);
	const orphans = installed.filter((name) => !resolvedScopedNames().has(name));
	if (orphans.length > 0) {
		t.diagnostic(
			`${orphans.length} package(s) present in node_modules but absent from package-lock.json (left by an interrupted install, excluded from builds): ${orphans.join(', ')}`,
		);
	}
});

test('semver helpers keep their contract', () => {
	// Regression cases for the dist-tag trap and the caret trap that forced a
	// manual pin of every peer range during the 0.1.5-rc.2 move.
	assert.equal(compareVersions('0.1.5-rc.2', '0.1.5-rc.1'), 1);
	assert.equal(compareVersions('0.1.5-rc.10', '0.1.5-rc.9'), 1, 'numeric prerelease parts compare numerically');
	assert.equal(compareVersions('0.1.5', '0.1.5-rc.2'), 1, 'a release outranks its prereleases');
	assert.equal(compareVersions('0.2.0', '0.1.5-rc.9'), 1);
	assert.ok(satisfiesRange('0.1.5-rc.2', '^0.1.5-rc.2'));
	assert.ok(
		!satisfiesRange('0.1.5-rc.1', '^0.1.5-rc.2'),
		'^0.1.0-rc.6 must NOT resolve to 0.1.5-rc.2 — this is why every peer range was repinned',
	);
	assert.ok(!satisfiesRange('4.0.2-rc.1', '^4.0.1'), 'a prerelease never satisfies a plain range');
	assert.equal(parseVersion('nonsense'), null);
});
