# DSH runtime integration

How DeepSeek Harness (DSH) is embedded in this Electron app, which parts are
upstream, where the compatibility layer lives, and what to do when DSH ships a
new version. Written for the next person — or agent — who has to touch this.

---

## 1. What this app is

An Electron shell that runs the **shipped DSH `web` profile composition
in-process** and serves its built frontend to a Chromium window.

Two hard constraints shape everything below:

1. **No HTTP server.** The `webserver` row is disabled and replaced by an
   in-process stub. Nothing binds a port; no `dsh web` child process is spawned.
2. **No fork of DSH.** The shipped client stack runs unmodified. Where the
   desktop carrier has to differ, it does so through a small, explicit
   compatibility layer rather than by patching upstream code.

This repository is a fork of `Easyhoov/deepseek-harness-desktop-windows` whose
only purpose is to keep the bundled DSH runtime current. The Electron shell is
kept 1:1 with upstream; the DSH runtime is the thing that moves.

---

## 2. Layer map: what belongs to whom

| Layer | Owner | Where |
| --- | --- | --- |
| DSH runtime (`@deepseek-ai/dsh*`, `@deepseek-ai/cordis*`) | upstream | `node_modules`, pinned in `package.json` |
| DSH boot / compose API (`@deepseek-ai/dsh-app-boot`) | upstream | consumed by `src/boot.mjs` |
| Web profile composition (rows, bundles, patches) | upstream | `src/desktop.patch.yml` disables/overrides rows only |
| Electron shell, window, tray, notifications, updater | Easyhoov | `src/main.mjs`, `src/tray.mjs`, `src/notifications.mjs`, `src/updates.mjs` |
| In-process transport (webServer stub + IPC bridge) | Easyhoov | `src/ipc-web-server.mjs`, `src/ipc-bridge.mjs`, `src/preload.cjs`, `src/ws-ipc.mjs` |
| Site materialization + index rendering | Easyhoov | `src/site.mjs` |
| Bundled DSH overlay (user-level runtime update) | Easyhoov | `src/dsh-overlay.mjs` |
| Home resolution + shared-home guard | Easyhoov | `src/home.mjs` |
| Bundled npm/pnpm runners | Easyhoov | `src/npm-runner.mjs`, `src/dsh-runner.mjs` |
| Vendored plugins | Easyhoov + plugin authors | `plugins/` |
| Compatibility layer | this fork | see §4 |

The **compatibility layer** is not a directory — it is the set of small,
commented adaptations marked with a `dsh >= 0.1.5-rc.2` note in the files listed
in §4.

---

## 3. The in-process architecture

```
Electron main process
├─ src/main.mjs            window, tray, protocol handler, lifecycle
├─ src/home.mjs            resolve DSH_HOME (+ shared-home conflict guard)
├─ src/boot.mjs            bootDesktop(): the in-process composition
│    ├─ loads the `web` profile: bundle layers → profile → home → overlays
│    ├─ disables the `webserver` row, provides the stub instead
│    └─ provides directoryPicker / desktopUi / launch environment
├─ src/ipc-web-server.mjs  the webServer service: routes + index rendering,
│                          zero sockets
├─ src/site.mjs            materializes the frontend dist into <userData>/www
│                          and renders index.html for the scheme in use
└─ src/ipc-bridge.mjs      renderer fetch / WebSocket ⇄ in-process dispatch

Renderer (contextIsolation OFF by design)
└─ src/preload.cjs         replaces globalThis.fetch and WebSocket with
                           IPC-backed implementations, so the shipped client
                           runs unmodified
```

Request flow for anything the client fetches:

```
client fetch → preload shim → ipcRenderer.invoke('dsh:fetch')
             → mock node:http req/res → webServer route handler
             → buffered response back over IPC
```

`app://` (the default scheme) is a standard, secure origin so the shipped
client's `connection.isLoopback` stays true. `file://` remains available via
`DSH_DESKTOP_SCHEME=file` for debugging, but it cannot dispatch routes — it is
strictly a fallback.

---

## 4. The compatibility layer

Each item below is a place where the desktop carrier has to know something about
a specific DSH version. They are the only files that should need attention when
DSH changes.

### 4.1 `src/boot.mjs` — `healProfilesModuleFallback` signature

0.1.0-rc.6 exposed a synchronous `healProfilesModuleFallback(installAnchor, home)`.
0.1.5-rc.2 made it `async ({ installAnchor, profile?, home? })`. Calling the old
form resolves to `undefined` and throws when awaited.

```js
await healProfilesModuleFallback({ installAnchor: anchor });
```

### 4.2 `src/ipc-web-server.mjs` — index injection table

0.1.5-rc.2 split index rendering in two: a **structured injection table**
(`webserver/index-inject` event → rows → `renderIndexInjections`) and the legacy
raw `tapIndex` transforms. `applyIndexTaps()` runs only the raw transforms, and
nothing registers those any more — so the stub must implement
`collectIndexInjections()` and `renderIndex()` and emit on the host context.

The stub is constructed *before* the composition exists, so `src/boot.mjs` hands
it the host context via `webServer.attachContext(hostCtx)` right after
`hostCtx.provide('webServer', webServer)`.

Symptom when this is wrong: the main process still reaches `ready`, and the
renderer dies with

```
Error: web boot: window.__ModuleLoader__ bootstrap facade is missing
```

### 4.3 `src/site.mjs` — bundle URLs under `app://`

0.1.5-rc.2 advertises client bundles as a **combined request**:

```
/plugins/??a/client.js,b/client.js&rev=<hash>
```

`dsh-client-modules` registers a `prefix` route at `/plugins`, and the `app://`
protocol handler dispatches it. The URL must therefore stay absolute under
`app://`. Rewriting the prefix to the materialized `__plugins` tree — which was
correct for the older one-file-per-module URLs — produces `/__plugins/??…`,
whose *pathname* (`/__plugins/`) no longer matches the `/plugins` route, so the
module loader script 404s and the renderer never boots.

Under `file://` the rewrite is still applied, because there is no protocol
handler to dispatch routes; that scheme is debug-only.

### 4.4 `plugins/dsh-better-sidebar/lib/index.js` — `settingsNamespace`

`@deepseek-ai/dsh-settings` exported a `settingsNamespace` validator in
0.1.0-rc.6; 0.1.5-rc.2 removed it (it is internal now). The vendored plugin
passes its already-valid namespace constant through directly instead.

### 4.5 `scripts/apply-official-patches.mjs` — retired patch

The `dsh-tool-bash-persistent` private-`PS1` patch is **fixed upstream** as of
0.1.5-rc.2, so it was removed. The script keeps `UPSTREAM_ASSERTIONS`, which
verifies the upstream fix is still present and warns loudly if it regresses —
turning a silent behavioural change into a visible one.

---

## 5. Version management

`dsh-runtime.json` records which upstream runtime the build is tested against:

```json
{ "package": "@deepseek-ai/dsh", "version": "0.1.5-rc.2", "channel": "next", "source": "npm" }
```

`package.json` holds the authoritative per-package pins. The two must agree —
`tests/compat.test.mjs` asserts it, and `scripts/check-dsh-update.mjs` warns if
they drift.

### Rules that are not obvious

- **The whole family moves together.** `@deepseek-ai/dsh` and every
  `@deepseek-ai/dsh-*` package are pinned to one exact version. Mixing versions
  (say `dsh-settings` new, `dsh-tools` old) produces loader failures at boot.
- **The dist-tag trap.** DSH publishes prereleases, and `latest` can trail
  `next`: at the time of writing `latest` = `0.1.5-rc.1` while `next` =
  `0.1.5-rc.2`. `npm view @deepseek-ai/dsh version` therefore reports an *older*
  build. Both the app (`src/dsh-overlay.mjs`) and CI
  (`scripts/check-dsh-update.mjs`) compare versions across channels with real
  semver (`src/semver.mjs`) instead of trusting one tag.
- **The caret trap.** `^0.1.0-rc.6` does **not** resolve to `0.1.5-rc.2` — a
  prerelease range only matches the same `major.minor.patch` tuple. Every peer
  range has to be repinned explicitly.
- **cordis companions follow DSH.** `@deepseek-ai/cordis*` packages are moved to
  the newest release compatible with the cordis version the new DSH declares.

---

## 6. Updating DSH

```bash
# 1. See whether anything is available (semver-aware, all channels).
npm run check:dsh-update                 # latest + next
npm run check:dsh-update -- --include-prerelease   # also alpha

# 2. Move the whole family in one shot. Writes package.json,
#    plugins/*/package.json peer ranges, dsh-runtime.json, and refreshes
#    package-lock.json via `npm install --package-lock-only`.
npm run bump:dsh -- --version 0.1.5-rc.2 --channel next
#    add --dry-run to preview, --skip-lockfile to skip the lockfile step

# 3. Reconcile node_modules with the new lockfile, then verify.
npm run tests
npm run smoke

# 4. Build.
npm run dist
```

`--package-lock-only` is deliberate: a plain `npm install` runs npm's reify
phase, which retires the old tree by deleting it. In restricted environments
that bulk deletion can be blocked and the install hangs indefinitely. The
lockfile is what matters for reproducibility; `node_modules` is reconciled
separately (see §9).

After a bump, expect to fix the compatibility-layer items in §4 if the release
changed any of those surfaces. `npm run smoke` is what tells you.

### How CI does it

`.github/workflows/check-dsh-update.yml` runs daily: it checks, bumps, runs
tests and the boot smoke test, then opens a PR titled
`chore: update DeepSeek Harness to <version>`. **Auto-merge is off** — DSH only
ships prereleases and a coordinated bump can carry breaking changes no automated
check can fully vet.

---

## 7. Rolling back

Two independent mechanisms, for two different situations.

**A. Roll back a user-level runtime overlay.** If a runtime update was installed
into `<userData>/agent`, the tray/About menu's rollback removes the overlay and
the app falls back to the bundled copy. `src/dsh-overlay.mjs`:

```js
rollbackDshOverlay(userData);   // deletes the overlay directory
```

The bundled DSH is a permanent fallback by design: it is always present, and
`~/.dsh` user data is never touched by an update or a rollback.

**B. Roll back the repository pins.**

```bash
git revert <the bump commit>     # package.json + lockfile + manifest
npm ci                           # or the reconciliation path in §9
npm run tests && npm run smoke
```

---

## 8. Testing an alpha

Alpha is the least settled channel and is never selected implicitly.

```bash
npm run check:dsh-update -- --include-prerelease
npm run bump:dsh -- --version <alpha version> --channel alpha
npm run tests
npm run smoke
```

Keep this on a branch, never on `main`. The generated PR body says so, and CI
deliberately does not enable auto-merge for it.

To try an alpha **without** touching the repository, install it as a user-level
overlay instead: the app's update check can point at the overlay path, and
rollback (see §7) returns to the bundled runtime. Always exercise an alpha
against a throwaway `DSH_DESKTOP_HOME` so real sessions are never at risk.

---

## 9. Building the Windows executable

```bash
npm ci            # or: npm install --package-lock-only + reconciliation
npm run tests
npm run smoke
npm run dist      # electron-builder --win → release/
npm run dist:dir  # unpacked only, much faster, for packaging sanity
```

Artifacts land in `directories.output` (`release/` by default):

```
DeepSeek-Harness-Desktop-Setup-<version>.exe      NSIS installer
DeepSeek-Harness-Desktop-Setup-<version>.exe.blockmap
DeepSeek-Harness-Desktop-Portable-<version>.exe   portable
latest.yml                                        update manifest
```

The packaged runtime can be verified without launching the app:

```bash
node -p "require('./release/win-unpacked/resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh/package.json').version"
```

It must equal `dsh-runtime.json`'s `version`. Both the release and the
windows-build workflows assert exactly this.

### Packaging notes

- `asarUnpack` covers `node_modules/**` and `plugins/**`, so the app reads real
  files rather than archive paths. `src/boot.mjs` rewrites `app.asar` paths to
  their `app.asar.unpacked` siblings for the same reason: the Loader's ESM
  resolution cannot cross a junction into an asar archive.
- `plugins/*/node_modules` is excluded. `@electron/asar` cannot pack the
  relative symlinks a pnpm-style layout creates inside a vendored plugin, and
  the vendored sidebar's `lib/client.js` is prebuilt, so its dependencies are
  not needed at pack time.
- The build copies the whole production dependency tree (~40k files) into
  `app.asar.unpacked`, so `npm run dist` takes on the order of an hour on a
  busy machine. `npm run dist:dir` is the fast check.

---

## 10. Verification checklist

| Command | What it proves |
| --- | --- |
| `npm run tests` | manifest/pin agreement, family consistency, required upstream exports, native addons load, vendored plugin peers satisfiable, semver contract |
| `npm run smoke` | the real app boots on the pinned runtime, materializes the frontend, reaches `ready`, and the renderer reports **no errors** |
| `npm run check:dsh-update` | whether a newer runtime exists, using semver across channels |

`npm run smoke` is hermetic: it points `DSH_DESKTOP_HOME` and Electron's
`userData` at a throwaway temp directory, so it never reads or writes `~/.dsh`.
It fails on any `[renderer:error]` line — that is what catches index/bundle
regressions, because the main process reaches `ready` even when the renderer
cannot boot at all.

---

## 11. Environment traps

- **Bulk deletion can be blocked.** Some sandboxes refuse to delete more than a
  fixed number of files per turn, at the OS level. npm's reify phase trips this
  and then hangs with no output. Workaround: `npm install --package-lock-only`,
  then reconcile `node_modules` without deleting anything (rename/move instead).
- **"Version correct, content stale."** An interrupted install can leave a
  package's `package.json` at the new version while `lib/` or a native `.node`
  binary is still the old one. `npm run tests` checks the exports and native
  addons that actually break this way (`RemoteError`, `sharp`, `koffi`).
- **Stale build directories.** An output directory locked by antivirus or an
  interrupted build may be impossible to move or delete. Build into a fresh
  directory via `--config.directories.output=<dir>` rather than fighting it.
- **Renderer errors are not in the log file.** The main process forwards
  `console-message` to stdout; only level ≥ 2 reaches the log file, and newer
  Electron reports the level as a string, so the numeric comparison misses it.
  `npm run smoke` reads stdout for this reason.
