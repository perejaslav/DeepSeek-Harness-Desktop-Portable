#!/usr/bin/env node
/**
 * Boot smoke test (ТЗ §17, §21, §22).
 *
 * The fast test suite in `tests/` verifies that the right packages and symbols
 * are on disk. This one verifies the thing that actually matters: that the
 * Electron main process boots DSH in-process, materializes the frontend, and
 * reaches `ready` — with the expected runtime version and without a single
 * plugin failing to load.
 *
 * It is deliberately hermetic. DSH state and Electron's userData both point at
 * a throwaway directory under the OS temp dir, so the test never reads or
 * writes `~/.dsh` (ТЗ §15–§16) and can run on a fresh CI runner without
 * credentials.
 *
 * Usage:
 *   node scripts/smoke-boot.mjs
 *   node scripts/smoke-boot.mjs --timeout 300
 *   node scripts/smoke-boot.mjs --keep        # keep the temp dirs for debugging
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const optionIndex = argv.indexOf('--timeout');
const TIMEOUT_MS = (optionIndex === -1 ? 180 : Number(argv[optionIndex + 1])) * 1000;
const KEEP = argv.includes('--keep');
/** Grace period after `ready` for renderer-side failures to surface. */
const SETTLE_MS = 8000;

const manifest = JSON.parse(readFileSync(join(ROOT, 'dsh-runtime.json'), 'utf8'));

/** Log lines that mean boot did not really succeed, even if `ready` appeared. */
const FATAL_PATTERNS = [
	'Failed to load plugins',
	'bootstrap facade is missing',
	'boot failed',
	'Cannot find module',
	'does not provide an export named',
	'Mismatched native',
	'Could not load the "sharp" module',
];

/**
 * Any `[renderer:error]` line fails the run. This is the check that actually
 * catches index/bundle regressions: when the boot manifest or a client bundle
 * URL is wrong, the main process still reaches `ready` happily and only the
 * renderer reports the problem.
 *
 * Entries here are environmental noise, not app failures. Keep the list tight
 * — a pattern that is too broad silently disables the check.
 */
const BENIGN_RENDERER_ERRORS = [
	// The smoke run uses a throwaway DSH home with no credentials, so the Cordis
	// inspector endpoints answer 401. Scoped to those routes on purpose: a 401
	// anywhere else is a real regression and must still fail the run.
	/dynamicCordisRunner\S*.*HTTP 401/,
];

const REQUIRED_MARKERS = ['boot ok', 'site ok', 'window created', 'ready'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Renderer errors are forwarded to stdout by the main process as
 * `[renderer:error] …`. Extract their messages so they can be asserted on.
 */
function rendererErrors(consoleText) {
	const prefix = '[renderer:error]';
	return consoleText
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith(prefix))
		.map((line) => line.slice(prefix.length).trim());
}

function electronBinary() {
	// `electron` resolves to the platform binary path when required from Node.
	const path = require('electron');
	if (typeof path !== 'string' || !existsSync(path)) {
		throw new Error('electron binary not found — run `npm ci` first');
	}
	return path;
}

async function main() {
	const base = mkdtempSync(join(tmpdir(), 'dsh-smoke-'));
	const home = join(base, 'home');
	const userData = join(base, 'userdata');
	mkdirSync(home, { recursive: true });
	mkdirSync(userData, { recursive: true });
	const logPath = join(userData, 'dsh-desktop.log');

	process.stdout.write(`smoke: temp dir ${base}\n`);
	process.stdout.write(`smoke: expecting bundled dsh ${manifest.version}\n`);

	const child = spawn(
		electronBinary(),
		[
			'.',
			`--user-data-dir=${userData}`,
			// The sandbox and this environment have no usable GPU; without these
			// the GPU process dies and Electron aborts before the window exists.
			'--no-sandbox',
			'--disable-gpu',
			'--in-process-gpu',
			'--disable-software-rasterizer',
		],
		{
			cwd: ROOT,
			env: { ...process.env, DSH_DESKTOP_HOME: home, NODE_OPTIONS: '' },
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);

	let console_ = '';
	child.stdout.on('data', (chunk) => {
		console_ += chunk.toString();
	});
	child.stderr.on('data', (chunk) => {
		console_ += chunk.toString();
	});

	const deadline = Date.now() + TIMEOUT_MS;
	let log = '';
	let failure = null;

	while (Date.now() < deadline) {
		if (existsSync(logPath)) {
			log = readFileSync(logPath, 'utf8');
			const haystack = `${log}\n${console_}`;
			const fatal = FATAL_PATTERNS.find((pattern) => haystack.includes(pattern));
			if (fatal !== undefined) {
				failure = `fatal line present: "${fatal}"`;
				break;
			}
			const rendererError = rendererErrors(console_).find(
				(line) => !BENIGN_RENDERER_ERRORS.some((pattern) => pattern.test(line)),
			);
			if (rendererError !== undefined) {
				failure = `renderer error: ${rendererError}`;
				break;
			}
			if (REQUIRED_MARKERS.every((marker) => log.includes(marker))) break;
		}
		if (child.exitCode !== null) {
			failure = `electron exited early with code ${child.exitCode}`;
			break;
		}
		await sleep(500);
	}

	// Renderer errors surface a moment after the window is created — the boot
	// manifest is parsed and the client bundles are fetched asynchronously. Give
	// the renderer time to fail before calling the run a success, otherwise the
	// loop would exit on the `ready` marker alone and miss exactly the
	// regression this test exists to catch.
	if (failure === null) {
		await sleep(SETTLE_MS);
		if (existsSync(logPath)) log = readFileSync(logPath, 'utf8');
		const haystack = `${log}\n${console_}`;
		const fatal = FATAL_PATTERNS.find((pattern) => haystack.includes(pattern));
		if (fatal !== undefined) failure = `fatal line present: "${fatal}"`;
		const rendererError = rendererErrors(console_).find(
			(line) => !BENIGN_RENDERER_ERRORS.some((pattern) => pattern.test(line)),
		);
		if (failure === null && rendererError !== undefined) failure = `renderer error: ${rendererError}`;
	}

	const markers = Object.fromEntries(REQUIRED_MARKERS.map((marker) => [marker, log.includes(marker)]));
	const missing = REQUIRED_MARKERS.filter((marker) => !markers[marker]);
	const versionLine = /^.*\bdsh (\S+) \((bundled|overlay)\)$/m.exec(log);
	const runtimeVersion = versionLine?.[1] ?? null;

	if (failure === null && missing.length > 0) {
		failure = `timed out after ${TIMEOUT_MS / 1000}s; missing markers: ${missing.join(', ')}`;
	}
	if (failure === null && runtimeVersion !== manifest.version) {
		failure = `runtime version mismatch: log reports ${runtimeVersion ?? 'nothing'}, dsh-runtime.json pins ${manifest.version}`;
	}

	child.kill();
	await sleep(1000);
	if (child.exitCode === null) child.kill('SIGKILL');

	if (failure === null) {
		process.stdout.write(`smoke: OK — dsh ${runtimeVersion} (bundled) reached ready with no plugin failures\n`);
	} else {
		process.stdout.write(`smoke: FAILED — ${failure}\n`);
		process.stdout.write(`\n--- last 40 log lines ---\n${log.split('\n').slice(-40).join('\n')}\n`);
		if (console_ !== '') process.stdout.write(`\n--- last 40 console lines ---\n${console_.split('\n').slice(-40).join('\n')}\n`);
	}

	if (KEEP) {
		process.stdout.write(`smoke: kept ${base}\n`);
	} else {
		try {
			rmSync(base, { recursive: true, force: true });
		} catch {
			process.stdout.write(`smoke: could not remove ${base} (locked); safe to delete manually\n`);
		}
	}

	process.exit(failure === null ? 0 : 1);
}

main().catch((error) => {
	process.stdout.write(`smoke: FAILED — ${error.message}\n`);
	process.exit(1);
});
