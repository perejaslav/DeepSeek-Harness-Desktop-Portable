/**
 * Process helpers for the maintenance scripts.
 *
 * Everything runs through `execFile` with `shell: false`. That is deliberate:
 * the scripts pass npm semver ranges around, and on Windows a shell would
 * interpret `^` as cmd.exe's escape character and silently corrupt the argument.
 * We therefore invoke the project's own pinned npm (`node_modules/npm`) through
 * the current Node binary, which also guarantees CI and local runs use the same
 * npm version as the app.
 *
 * @module dsh-desktop/scripts/lib/exec
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Repository root (two levels up from `scripts/lib/`). */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const BUNDLED_NPM = join(ROOT, 'node_modules', 'npm', 'bin', 'npm-cli.js');

/**
 * Run a command and return trimmed stdout.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{allowFailure?: boolean, timeout?: number}} [options]
 * @returns {string|null} stdout, or null when `allowFailure` and it failed.
 */
export function exec(command, args, { allowFailure = false, timeout = 300_000 } = {}) {
	try {
		return execFileSync(command, args, {
			cwd: ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout,
			shell: false,
		}).trim();
	} catch (error) {
		if (allowFailure) return null;
		const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
		const detail = stderr === '' ? error.message : stderr;
		throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
	}
}

/**
 * Run npm via the project's pinned copy when available.
 *
 * @param {string[]} args
 * @param {{allowFailure?: boolean, timeout?: number}} [options]
 * @returns {string|null}
 */
export function npm(args, options = {}) {
	if (existsSync(BUNDLED_NPM)) {
		return exec(process.execPath, [BUNDLED_NPM, ...args], options);
	}
	// Fallback: system npm. Only reachable before the first `npm ci`.
	const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
	return execFileSyncWithShell(command, args, options);
}

function execFileSyncWithShell(command, args, { allowFailure = false, timeout = 300_000 } = {}) {
	try {
		return execFileSync(command, args, {
			cwd: ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout,
			shell: true,
		}).trim();
	} catch (error) {
		if (allowFailure) return null;
		throw error;
	}
}

/** Parse a `--json` payload, returning null instead of throwing on garbage. */
export function parseJson(raw) {
	if (typeof raw !== 'string' || raw === '') return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
