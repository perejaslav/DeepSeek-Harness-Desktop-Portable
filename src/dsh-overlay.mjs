/**
 * Second update channel: the bundled @deepseek-ai/dsh agent itself.
 *
 * `checkLatest` asks the npm registry; `install` runs the bundled npm into a
 * staging directory and atomically swaps it in as `<userData>/agent`. The
 * boot layer prefers the overlay's package.json as the install anchor, so
 * the composition (healed fallback junctions + bundle resolution) follows
 * the overlay on the next boot — same process, no child. `rollback` removes
 * the overlay and falls back to the bundled copy.
 *
 * @module dsh-desktop/dsh-overlay
 */
import { existsSync, rmSync, renameSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runNpm } from './npm-runner.mjs';
import { INSTALL_ANCHOR } from './boot.mjs';
import { compareVersions, pickHighest } from './semver.mjs';

const PKG = '@deepseek-ai/dsh';

// Re-exported for callers that historically imported it from here
// (`src/main.mjs`); the implementation lives in `src/semver.mjs` so the app and
// the CI update workflow cannot drift apart.
export { compareVersions };

/**
 * Update channels we are willing to install from, in descending preference.
 * `alpha` is deliberately excluded: it is the least settled channel and the
 * desktop app should never jump a user onto it implicitly.
 *
 * We compare the versions across channels instead of trusting a single
 * dist-tag, because DSH publishes prereleases whose `latest` can trail `next`
 * (e.g. `latest` = 0.1.5-rc.1 while `next` = 0.1.5-rc.2). A naive
 * `npm view @deepseek-ai/dsh version` would silently offer the older build.
 */
const UPDATE_CHANNELS = ['latest', 'next'];

/** Newest version among the configured channels, or null when unusable. */
export function pickUpdateTarget(distTags) {
	return pickHighest(distTags, UPDATE_CHANNELS)?.version ?? null;
}

export function overlayDirs(userData) {
	return {
		overlay: join(userData, 'agent'),
		staging: join(userData, 'agent-staging'),
	};
}

export function overlayAnchor(userData) {
	return join(userData, 'agent', 'node_modules', PKG, 'package.json');
}

export function overlayVersion(userData) {
	try {
		const parsed = JSON.parse(readFileSync(overlayAnchor(userData), 'utf8'));
		return typeof parsed.version === 'string' ? parsed.version : null;
	} catch {
		return null;
	}
}

export function bundledDshVersion() {
	try {
		const parsed = JSON.parse(readFileSync(INSTALL_ANCHOR, 'utf8'));
		return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
	} catch {
		return '0.0.0';
	}
}

export function activeDshVersion(userData) {
	return overlayVersion(userData) ?? bundledDshVersion();
}

export async function checkLatestDsh({ logLine } = {}) {
	const result = await runNpm(['view', PKG, 'dist-tags', '--json'], { logLine });
	if (result.code !== 0) return null;
	// npm may prepend warnings; take the JSON object out of the stream.
	const stdout = result.stdout ?? '';
	const start = stdout.indexOf('{');
	const end = stdout.lastIndexOf('}');
	if (start === -1 || end <= start) return null;
	let distTags;
	try {
		distTags = JSON.parse(stdout.slice(start, end + 1));
	} catch {
		return null;
	}
	return pickUpdateTarget(distTags);
}

export async function installDshOverlay(userData, version, { logLine } = {}) {
	const { overlay, staging } = overlayDirs(userData);
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	const result = await runNpm(['install', '--prefix', staging, '--no-save', `${PKG}@${version}`], { logLine });
	if (result.code !== 0) {
		const tail = (result.stderr || result.stdout || 'npm failed').trim().split('\n').slice(-5).join(' ');
		return { ok: false, reason: tail.slice(-400) };
	}
	const stagingAnchor = join(staging, 'node_modules', PKG, 'package.json');
	if (!existsSync(stagingAnchor)) {
		// Installed tree must contain the CLI package.
		rmSync(staging, { recursive: true, force: true });
		return { ok: false, reason: 'installed tree missing @deepseek-ai/dsh' };
	}
	const backup = `${overlay}.old`;
	rmSync(backup, { recursive: true, force: true });
	if (existsSync(overlay)) renameSync(overlay, backup);
	renameSync(staging, overlay);
	return { ok: true, restartRequired: true };
}

export function rollbackDshOverlay(userData) {
	const { overlay } = overlayDirs(userData);
	rmSync(overlay, { recursive: true, force: true });
}
