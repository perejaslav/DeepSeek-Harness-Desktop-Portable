#!/usr/bin/env node
/**
 * Upstream DeepSeek Harness version check (ТЗ §24–§29).
 *
 * Compares the runtime pinned in `dsh-runtime.json` against what the npm
 * registry currently publishes and reports whether a newer build exists.
 *
 * Why this is a script and not inline workflow YAML: the comparison rules are
 * not trivial. DSH ships prereleases whose `latest` dist-tag can trail `next`
 * (`latest` = 0.1.5-rc.1 while `next` = 0.1.5-rc.2), so a naive string compare
 * — or trusting a single tag — silently reports "up to date" or offers an
 * older build. The same semver implementation the desktop app uses
 * (`src/semver.mjs`) is reused here so CI and the app can never disagree about
 * what "newer" means.
 *
 * Channels (§25): `latest`, `next` (the RC line), `alpha`.
 * Policy (§26): by default only `latest` + `next` are eligible. `alpha` is
 * considered only with `--include-prerelease`, and never auto-merged (§28).
 *
 * Usage:
 *   node scripts/check-dsh-update.mjs                     # report, human output
 *   node scripts/check-dsh-update.mjs --include-prerelease
 *   node scripts/check-dsh-update.mjs --json              # machine output
 *
 * When running under GitHub Actions it also writes step outputs to
 * `$GITHUB_OUTPUT` and, if an update exists, a PR body to
 * `dsh-update-pr-body.md`.
 */

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, VERSION_PATTERN } from '../src/semver.mjs';
import { ROOT, exec, npm } from './lib/exec.mjs';

/** Channels that may open an automatic PR without extra flags (§26). */
const DEFAULT_CHANNELS = ['latest', 'next'];
/** Extra channel unlocked by `--include-prerelease`; never auto-merged (§28). */
const PRERELEASE_CHANNELS = ['alpha'];

const argv = new Set(process.argv.slice(2));
const INCLUDE_PRERELEASE = argv.has('--include-prerelease');
const AS_JSON = argv.has('--json');

function readManifest() {
	try {
		return JSON.parse(readFileSync(join(ROOT, 'dsh-runtime.json'), 'utf8'));
	} catch (error) {
		throw new Error(`cannot read dsh-runtime.json: ${error.message}`);
	}
}

/**
 * Current pinned runtime version. `dsh-runtime.json` is authoritative, but we
 * cross-check package.json so a hand-edit that forgot to run the bump script is
 * reported instead of silently tracking the wrong baseline.
 */
function readCurrent(manifest) {
	let dependency = null;
	try {
		const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
		dependency = pkg.dependencies?.[manifest.package] ?? null;
	} catch {
		dependency = null;
	}
	return { manifest: manifest.version, dependency };
}

function fetchDistTags(pkg) {
	const raw = npm(['view', pkg, 'dist-tags', '--json']);
	const parsed = JSON.parse(raw);
	if (parsed === null || typeof parsed !== 'object') {
		throw new Error(`unexpected dist-tags payload for ${pkg}`);
	}
	return parsed;
}

/** Upstream repository URL, used to link release notes in the PR (§29). */
function fetchRepository(pkg) {
	const raw = npm(['view', pkg, 'repository.url', '--json'], { allowFailure: true });
	if (raw === null) return null;
	return raw.replace(/^"|"$/g, '').replace(/^git\+/, '').replace(/\.git$/, '');
}

/**
 * Look for the GitHub release/tag matching the version. npm can publish before
 * the matching GitHub release exists; per §29 that is not an error, we just say
 * so explicitly in the PR body.
 */
function findUpstreamRelease(repoUrl, version) {
	if (repoUrl === null) return null;
	const match = /github\.com[/:]([^/]+)\/([^/]+)$/.exec(repoUrl);
	if (match === null) return null;
	const slug = `${match[1]}/${match[2]}`;
	for (const tag of [`v${version}`, version, `@deepseek-ai/dsh@${version}`]) {
		// `gh` may be unavailable (or unauthenticated) outside CI; a missing tag
		// is explicitly not an error (§29), so failures just fall through.
		const raw = exec('gh', ['api', `repos/${slug}/releases/tags/${tag}`, '--jq', '.html_url'], {
			allowFailure: true,
		});
		if (raw !== null && raw !== '' && raw !== 'null') return raw;
	}
	return null;
}

/** Highest version across the eligible channels, with its channel name. */
function pickTarget(distTags, channels) {
	let best = null;
	for (const channel of channels) {
		const candidate = distTags[channel];
		if (typeof candidate !== 'string' || !VERSION_PATTERN.test(candidate)) continue;
		if (best === null || compareVersions(candidate, best.version) > 0) {
			best = { version: candidate, channel };
		}
	}
	return best;
}

function buildPrBody({ current, target, repoUrl, releaseUrl, dependencyMismatch }) {
	const release = releaseUrl ?? 'GitHub release/tag not available at PR creation time';
	const lines = [
		`Automated DeepSeek Harness runtime update.`,
		``,
		`Old DSH: ${current}`,
		`New DSH: ${target.version}`,
		`npm channel: ${target.channel}`,
		`GitHub release: ${release}`,
		`Tests: see the checks on this PR`,
		`Windows build: see the windows-build job on this PR`,
		`Known incompatibilities: not determined automatically — review the upstream release notes and the compatibility layer in src/ before merging.`,
		``,
		`AUTO MERGE = OFF. This PR is intentionally left for manual review: DSH releases are prereleases and may carry breaking changes (ТЗ §28).`,
	];
	if (repoUrl !== null) lines.push(``, `Upstream: ${repoUrl}`);
	if (dependencyMismatch) {
		lines.push(
			``,
			`> Warning: package.json pins \`${dependencyMismatch}\` while dsh-runtime.json says \`${current}\`. The bump script should have kept them in sync — check the previous update commit.`,
		);
	}
	return `${lines.join('\n')}\n`;
}

function setOutput(name, value) {
	const file = process.env.GITHUB_OUTPUT;
	if (file === undefined || file === '') return;
	appendFileSync(file, `${name}=${value}\n`);
}

function main() {
	const manifest = readManifest();
	const { manifest: current, dependency } = readCurrent(manifest);
	const dependencyMismatch = dependency !== null && dependency !== current ? dependency : null;

	const channels = INCLUDE_PRERELEASE
		? [...DEFAULT_CHANNELS, ...PRERELEASE_CHANNELS]
		: DEFAULT_CHANNELS;

	const distTags = fetchDistTags(manifest.package);
	const target = pickTarget(distTags, channels);
	const updateAvailable = target !== null && compareVersions(target.version, current) > 0;

	const result = {
		current,
		channel: manifest.channel,
		distTags,
		channels,
		includePrerelease: INCLUDE_PRERELEASE,
		target: target?.version ?? null,
		targetChannel: target?.channel ?? null,
		updateAvailable,
		dependencyMismatch,
		prerelease: target?.channel === 'alpha',
	};

	if (updateAvailable) {
		const repoUrl = fetchRepository(manifest.package);
		const releaseUrl = findUpstreamRelease(repoUrl, target.version);
		result.upstreamRepo = repoUrl;
		result.upstreamRelease = releaseUrl;
		const body = buildPrBody({
			current,
			target,
			repoUrl,
			releaseUrl,
			dependencyMismatch,
		});
		writeFileSync(join(ROOT, 'dsh-update-pr-body.md'), body);
	}

	setOutput('update_available', String(updateAvailable));
	setOutput('current', current);
	setOutput('target', result.target ?? '');
	setOutput('target_channel', result.targetChannel ?? '');
	setOutput('prerelease', String(result.prerelease));

	if (AS_JSON) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}

	process.stdout.write(`pinned runtime : ${manifest.package}@${current} (channel ${manifest.channel})\n`);
	process.stdout.write(`dist-tags      : ${JSON.stringify(distTags)}\n`);
	process.stdout.write(`channels used  : ${channels.join(', ')}\n`);
	if (dependencyMismatch !== null) {
		process.stdout.write(`WARNING        : package.json pins ${dependencyMismatch}, manifest says ${current}\n`);
	}
	if (target === null) {
		process.stdout.write('result         : no eligible version found — nothing to do\n');
		return;
	}
	if (!updateAvailable) {
		process.stdout.write(`result         : up to date (${target.version} on ${target.channel} is not newer)\n`);
		return;
	}
	process.stdout.write(`result         : update available → ${target.version} (${target.channel})\n`);
	if (result.upstreamRelease !== undefined) {
		process.stdout.write(`release notes  : ${result.upstreamRelease ?? 'GitHub release/tag not available at PR creation time'}\n`);
	}
}

main();
