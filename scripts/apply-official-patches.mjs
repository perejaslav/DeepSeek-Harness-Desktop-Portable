/**
 * Apply official upstream fixes to the bundled dsh packages.
 *
 * ---------------------------------------------------------------------------
 * RETIRED PATCH (classification: UPSTREAM FIXED -> REMOVE)
 * ---------------------------------------------------------------------------
 * 0.6.2 shipped one patch against `dsh-tool-bash-persistent`, mirroring the
 * official deepseek-harness master fix for the persistent-bash 3.5s prompt
 * mismatch:
 *
 *   The package overrode PS1 to a private prompt
 *   (`__DSH_PERSISTENT_BASH_PROMPT__`) while `dsh-terminal-bash` waits for its
 *   own CONTROLLED_PROMPT ("dsh> "). The mismatch meant prompt-based readiness
 *   never fired and every command fell back to the 3.5s idle-silence settle.
 *
 * @deepseek-ai/dsh-tool-bash-persistent@0.1.5-rc.2 already ships that fix
 * upstream (verified against the published tarball: no `SHELL_PROMPT` /
 * `slice(0, -31)` / `PS1=` override remains; the backend keeps its own prompt
 * and only runs `stty -echo`). The patch is therefore removed — applying it
 * would only emit "pattern not found" warnings.
 *
 * The mechanism is kept so future patches have a home, and UPSTREAM_ASSERTIONS
 * below fails loudly if a later DSH release regresses on a fix we rely on.
 *
 * Runs idempotently from postinstall/predist; safe to run repeatedly.
 *
 * @module dsh-desktop/apply-official-patches
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Active patches. Empty: every 0.6.2 patch has been fixed upstream. */
const PATCHES = [];

/**
 * Fixes we depend on but no longer patch. Each entry asserts the upstream code
 * still looks the way the fix left it; a miss means upstream regressed and the
 * patch must be reinstated (see git history for the 0.6.2 replacements).
 */
const UPSTREAM_ASSERTIONS = [
	{
		target: join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-tool-bash-persistent', 'lib', 'index.js'),
		description: 'persistent-bash: no private PS1 override (fixed upstream in 0.1.5-rc.2)',
		mustBeAbsent: ['__DSH_PERSISTENT_BASH_PROMPT__', 'result = result.slice(0, -31)'],
		mustBePresent: ['stty -echo'],
	},
];

let changed = false;
for (const patch of PATCHES) {
	let source;
	try {
		source = readFileSync(patch.target, 'utf8');
	} catch {
		console.log(`[patch] skip (not installed yet): ${patch.target}`);
		continue;
	}
	let applied = 0;
	for (const [from, to] of patch.replacements) {
		if (source.includes(from)) {
			if (!source.includes(to)) {
				source = source.replaceAll(from, to);
				applied += 1;
			} else {
				// Both present: already patched, keep as-is.
			}
		} else if (!source.includes(to)) {
			console.warn(`[patch] pattern not found in ${patch.target}: ${from.slice(0, 60)}…`);
		}
	}
	if (applied > 0) {
		writeFileSync(patch.target, source, 'utf8');
		changed = true;
		console.log(`[patch] applied ${applied} replacement(s): ${patch.description}`);
	} else {
		console.log(`[patch] already up to date: ${patch.description}`);
	}
}

let regressed = 0;
for (const check of UPSTREAM_ASSERTIONS) {
	let source;
	try {
		source = readFileSync(check.target, 'utf8');
	} catch {
		console.log(`[patch] assertion skipped (not installed yet): ${check.description}`);
		continue;
	}
	const stale = (check.mustBeAbsent ?? []).filter((needle) => source.includes(needle));
	const missing = (check.mustBePresent ?? []).filter((needle) => !source.includes(needle));
	if (stale.length === 0 && missing.length === 0) {
		console.log(`[patch] upstream fix verified: ${check.description}`);
		continue;
	}
	regressed += 1;
	if (stale.length > 0) {
		console.warn(`[patch] UPSTREAM REGRESSION in ${check.target}: found ${stale.map((s) => `"${s}"`).join(', ')}`);
	}
	if (missing.length > 0) {
		console.warn(`[patch] UPSTREAM REGRESSION in ${check.target}: missing ${missing.map((s) => `"${s}"`).join(', ')}`);
	}
	console.warn('[patch] → reinstate the matching entry in PATCHES (see git history for 0.6.2 replacements).');
}

if (changed) console.log('[patch] done — node_modules patched (fresh npm ci re-applies via postinstall).');
if (regressed > 0) console.warn(`[patch] ${regressed} upstream fix(es) regressed — review before shipping.`);
