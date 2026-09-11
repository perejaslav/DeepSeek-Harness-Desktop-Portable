/**
 * Minimal semver precedence helpers, shared by the in-app updater
 * (`src/dsh-overlay.mjs`) and the CI scripts (`scripts/check-dsh-update.mjs`).
 *
 * Keeping one implementation matters: the desktop app and the automated
 * upstream-tracking workflow must agree on what "newer" means, otherwise CI can
 * open a PR for a version the app would refuse to install (or vice versa).
 *
 * This is deliberately not a full semver library — we only need `X.Y.Z[-pre]`
 * parsing plus the precedence rules from https://semver.org/#spec-item-11.
 * Build metadata (`+build`) is ignored, as the spec requires.
 *
 * @module dsh-desktop/semver
 */

/** Matches the versions DSH actually publishes: `1.2.3`, `0.1.5-rc.2`. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+([.-].+)?$/;

/** Parse `X.Y.Z[-pre]` into comparable parts; returns null when malformed. */
export function parseVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.+)?$/.exec(version ?? '');
	if (match === null) return null;
	return {
		release: [Number(match[1]), Number(match[2]), Number(match[3])],
		prerelease: match[4] === undefined ? null : match[4].split('.'),
	};
}

/** Semver precedence (https://semver.org/#spec-item-11); 0 when equal. */
export function compareVersions(left, right) {
	const a = parseVersion(left);
	const b = parseVersion(right);
	if (a === null || b === null) return 0;
	for (let i = 0; i < 3; i += 1) {
		if (a.release[i] !== b.release[i]) return a.release[i] < b.release[i] ? -1 : 1;
	}
	if (a.prerelease === null || b.prerelease === null) {
		if (a.prerelease === b.prerelease) return 0;
		return a.prerelease === null ? 1 : -1;
	}
	const len = Math.max(a.prerelease.length, b.prerelease.length);
	for (let i = 0; i < len; i += 1) {
		const l = a.prerelease[i];
		const r = b.prerelease[i];
		if (l === undefined) return -1;
		if (r === undefined) return 1;
		if (l === r) continue;
		const lNum = /^\d+$/.test(l);
		const rNum = /^\d+$/.test(r);
		if (lNum && rNum) return Number(l) < Number(r) ? -1 : 1;
		if (lNum !== rNum) return lNum ? -1 : 1;
		return l < r ? -1 : 1;
	}
	return 0;
}

/**
 * Highest version across the requested dist-tags.
 *
 * `channels` is ordered by preference but that order only breaks ties — the
 * comparison is numeric. This matters because DSH publishes prereleases whose
 * `latest` tag can trail `next` (e.g. `latest` = 0.1.5-rc.1, `next` =
 * 0.1.5-rc.2), so trusting a single tag silently offers the older build.
 */
export function pickHighest(distTags, channels) {
	let best = null;
	let bestChannel = null;
	for (const channel of channels) {
		const candidate = distTags?.[channel];
		if (typeof candidate !== 'string' || !VERSION_PATTERN.test(candidate)) continue;
		if (best === null || compareVersions(candidate, best) > 0) {
			best = candidate;
			bestChannel = channel;
		}
	}
	return best === null ? null : { version: best, channel: bestChannel };
}

/** Highest version in `versions` that satisfies `range`; null when none does. */
export function maxSatisfying(versions, range) {
	let best = null;
	for (const version of versions ?? []) {
		if (typeof version !== 'string') continue;
		if (!satisfiesRange(version, range)) continue;
		if (best === null || compareVersions(version, best) > 0) best = version;
	}
	return best;
}

/**
 * Minimal range check covering the shapes DSH actually declares: `^X.Y.Z`,
 * `^X.Y.Z-pre`, `X.Y.Z` and `X.Y.Z-pre`.
 *
 * Prerelease handling follows npm's rule: a range without a prerelease never
 * matches a prerelease version, even if the numbers line up — so `^4.0.1` does
 * not accept `4.0.2-rc.1`. A range *with* a prerelease only matches versions
 * sharing the same `major.minor.patch` tuple.
 */
export function satisfiesRange(version, range) {
	const parsed = parseVersion(version);
	if (parsed === null || typeof range !== 'string') return false;
	const trimmed = range.trim();

	const caret = /^\^(.+)$/.exec(trimmed);
	const plain = caret === null ? trimmed : caret[1];
	const bound = parseVersion(plain);
	if (bound === null) return false;

	if (parsed.prerelease !== null) {
		if (bound.prerelease === null) return false;
		if (parsed.release.some((part, index) => part !== bound.release[index])) return false;
	}

	if (compareVersions(version, plain) < 0) return false;
	if (caret === null) return compareVersions(version, plain) === 0;

	// Caret: compatible within the leftmost non-zero release component.
	if (bound.release[0] > 0) return parsed.release[0] === bound.release[0];
	if (bound.release[1] > 0) {
		return parsed.release[0] === 0 && parsed.release[1] === bound.release[1];
	}
	return parsed.release[0] === 0 && parsed.release[1] === 0 && parsed.release[2] === bound.release[2];
}
