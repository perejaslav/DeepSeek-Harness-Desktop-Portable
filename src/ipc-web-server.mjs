/**
 * In-process webServer replacement for the Electron desktop carrier.
 *
 * The shipped Web composition registers its routes on the `webServer`
 * service (the node:http server from @deepseek-ai/dsh-host-webserver). The
 * desktop app disables that row and provides THIS object under the same
 * service name instead: identical route/fallback/index-tap semantics, zero
 * sockets. The IPC bridge later dispatches renderer requests through
 * `match()` + the registered handlers, so every shipped host row (the /api
 * gateway carrier, plugin bundle serving, RPC channels, the SPA fallback)
 * keeps working unchanged.
 *
 * `port` reports 0 and `host` reports '127.0.0.1' because the web-runtime
 * glue and the directory-picker chooser read those as composition facts.
 */

import { renderIndexInjections } from '@deepseek-ai/dsh-host-webserver';

export function createIpcWebServer() {
	const exact = new Map();
	const prefixes = new Map();
	const upgrades = new Map();
	const indexTaps = [];
	let fallback;
	// The host context is attached after boot (see `attachContext`), because the
	// stub is constructed before the composition exists. `renderIndex` needs it
	// to emit `webserver/index-inject` and collect the plugin rows.
	let hostCtx = null;

	return {
		/** No socket ever binds: port 0 is the honest composition fact. */
		get port() {
			return 0;
		},
		/** Loopback literal keeps the directory picker on the native backend. */
		get host() {
			return '127.0.0.1';
		},

		/**
		 * Bind the host context that owns the `webserver/index-inject` event.
		 *
		 * dsh >= 0.1.5-rc.2 builds the index in two layers: a structured
		 * injection table contributed by plugins (client modules, theme,
		 * connection bootstrap) and the legacy raw `tapIndex` transforms. The
		 * table is gathered by emitting an event on the host context, so the
		 * stub cannot render a working index without it.
		 *
		 * @param {object} ctx the booted host context.
		 */
		attachContext(ctx) {
			hostCtx = ctx;
		},

		register(route) {
			const table = route.kind === 'exact' ? exact : prefixes;
			if (table.has(route.path)) {
				throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
			}
			table.set(route.path, route);
			return () => {
				table.delete(route.path);
			};
		},

		registerUpgrade(route) {
			if (upgrades.has(route.path)) {
				throw new Error(`webserver: duplicate upgrade route "${route.path}"`);
			}
			upgrades.set(route.path, route);
			return () => {
				upgrades.delete(route.path);
			};
		},

		registerFallback(handler) {
			if (fallback !== undefined) {
				throw new Error('webserver: fallback already registered');
			}
			fallback = handler;
			return () => {
				fallback = undefined;
			};
		},

		tapIndex(transform) {
			indexTaps.push(transform);
			return () => {
				const at = indexTaps.indexOf(transform);
				if (at !== -1) indexTaps.splice(at, 1);
			};
		},

		applyIndexTaps(html) {
			let out = html;
			for (const transform of indexTaps) out = transform(out);
			return out;
		},

		/**
		 * Gather the structured injection table: one `webserver/index-inject`
		 * emit, every subscriber pushing its current rows. Mirrors the shipped
		 * WebServer so plugins that contribute rows (dsh-client-modules,
		 * dsh-client-connection, dsh-client-ui-theme) behave identically.
		 *
		 * @returns {object[]} rows in subscriber activation order.
		 */
		collectIndexInjections() {
			if (hostCtx === null) return [];
			const table = [];
			hostCtx.emit('webserver/index-inject', table);
			return table;
		},

		/**
		 * Render one index.html body: the structured injection table first, then
		 * the raw `tapIndex` transforms over the result — the same order the
		 * shipped WebServer uses.
		 *
		 * @param {string} html the raw index.html body.
		 * @returns {string} the transformed body.
		 */
		renderIndex(html) {
			return this.applyIndexTaps(renderIndexInjections(html, this.collectIndexInjections()));
		},

		/** Exact lookup in the upgrade table (WebSocket upgrade paths). */
		matchUpgrade(pathname) {
			return upgrades.get(pathname);
		},

		/** Longest-prefix-wins over the prefix table after an exact-table miss. */
		match(pathname) {
			const hit = exact.get(pathname);
			if (hit !== undefined) return hit;
			let best;
			for (const [prefix, route] of prefixes) {
				if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
				if (best === undefined || prefix.length > best.path.length) best = route;
			}
			return best;
		},

		fallbackHandler() {
			return fallback;
		},
	};
}
