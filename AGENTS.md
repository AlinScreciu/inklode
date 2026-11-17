# AGENTS.md

Inklode is a local-first desktop Markdown notes app: Tauri 2 shell, Rust core, React + CodeMirror 6 UI, on a plain Obsidian-compatible folder of notes.
It is built for notes that agents edit and that can be verified: MCP servers, git history, a review inbox, claims with evidence.

## Layout

| Path | What |
|---|---|
| `crates/core` | Vault logic. No UI, no Tauri. One entry point: `Core::call(name, params)` in `src/call.rs`; the doc comment on it is the table of all operations. |
| `crates/mcp` | MCP tools: each row of `TOOLS` in `src/lib.rs` maps to one `Core::call`. `src/main.rs` is the headless stdio server `inklode-mcp`. |
| `src-tauri` | Desktop shell. `core_call` in `src/lib.rs` is the only bridge from the UI to the core. `src/mcp.rs` is the in-app MCP server, `src/settings.rs` the app's own settings. |
| `src` | React UI. `core/client.ts` is the only file that touches Tauri. `commands.ts` is the command registry, `modules.ts` the module registry, `modules/<id>/` one folder per module. |
| `docs` | Reference. Read the page for the area you change: `modules.md`, `claims.md`, `mcp.md`, `settings.md`, `themes.md`, `slideshow-spec.md`. `releasing.md` is how a release and the app's updater work. |

Where a change goes:

- A core operation: a match arm and a table row on `Core::call`, a Rust test, and the same case in `src/core/mock.ts` (the in-memory vault behind `pnpm dev`). For MCP, also a row in `TOOLS`.
- A UI action: a registered command (see `App.tsx`), so the palette, shortcuts and MCP `command_run` all reach it.
- A feature: a module (below).

## Build, run, test

```sh
pnpm install
pnpm tauri dev               # the desktop app with hot reload
pnpm dev                     # UI only at http://localhost:1420, on the mock vault
cargo test --workspace       # all Rust tests
cargo test -p inklode-core   # core only
pnpm build                   # tsc, then vite build
pnpm tauri build --bundles app   # needs TAURI_SIGNING_PRIVATE_KEY (docs/releasing.md); without the key add --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

UI self-checks are plain Node scripts, one `test:*` script per area in `package.json` (`pnpm test:claims`, `pnpm test:shell`, ...). There is no single `pnpm test`; run the script for the area you touched, and all of them before you say the work is done:

```sh
for s in $(node -e 'console.log(Object.keys(require("./package.json").scripts).filter(s=>s.startsWith("test:")).join(" "))'); do pnpm run "$s" || break; done
```

The dev server uses port 1420 and fails if it is taken, so only one `pnpm tauri dev` or `pnpm dev` runs at a time.

## Verify UI work in the real window

Type checks and self-checks do not show whether the window is right. Check it through the in-app MCP server:

1. Make a throwaway vault: an empty folder outside the repository, with the notes the check needs. Never open or write the user's own vault.
2. Start the app with the server on: `INKLODE_MCP_PORT=<port> pnpm tauri dev`. The variable switches the server on at that port whatever the settings say. The endpoint is `http://127.0.0.1:<port>/mcp` (streamable HTTP). Every request needs `Authorization: Bearer <token>`; the token is the content of `mcp-token` in the app's config folder (`~/Library/Application Support/app.inklode.desktop/` on macOS), made when the server first starts. Do not print it.
3. The app reopens the vault it had open last, which may be the user's. Open yours first: `command_run {id: "vault.open", params: {path: "/absolute/throwaway"}}`.
4. Drive and inspect: `command_list`, `command_run {id, params?}`, `ui_state` (what the window shows, as data), `ui_open {path, line?}`, `ui_click`, `ui_drag`, `ui_key`, `ui_screenshot`.

- Prefer `ui_state` and `command_run` to clicking; take a screenshot for what only pixels show.
- `ui_click` and `ui_drag` take CSS pixels. `ui_screenshot` returns device pixels (2x on a Retina display): divide a screenshot position by `viewport.devicePixelRatio` from `ui_state`.
- The `ui_*` input tools dispatch synthetic DOM events. The clipboard, file pickers and native popups do not respond to them, and neither do claim checks (by design, below).
- A module is switched on with `command_run {id: "module.toggle", params: {id: "<module>", on: true}}`.
- A request to the window times out after 5 s.

## Conventions the code follows

- **Features are modules.** Anything beyond the base app lives in `src/modules/<id>/index.ts` with an `activate(app)` that registers through `AppApi`, plus a row in `MODULES` in `src/modules.ts`. A new module has `defaultEnabled: false`, is imported only when switched on, and everything it registered goes away when it is switched off. "How modules work" in `docs/modules.md` has the details.
- **Marked shortcuts.** A deliberate simplification carries a comment `// shortcut: <the limit>, <when or how to upgrade>`, for example `// shortcut: scans every line of every note per query ..., fine for a few thousand notes; use a real search index beyond that.` Write one whenever you take a shortcut; `rg "shortcut:"` is the list of known debt.
- **Comments say why**, or state a rule the code cannot show. Doc comments describe behaviour in plain sentences.
- **Only what was asked.** Write the current behaviour only: migration code, fallbacks for old formats and compatibility layers are added when someone asks for them.
- **Tests.** A core operation gets Rust tests next to it (`#[cfg(test)]` in the same file). Pure UI logic lives in a file without React or DOM imports and gets a `<name>.test.mjs` self-check beside it, wired into a `test:*` script in `package.json`.
- **Docs move with the code.** A new command, `ui_state` entry or known limit goes into the module's section in `docs/`. A new operation goes into the table on `Core::call`.
- Colours, fonts and sizes are CSS variables at the top of `src/app.css`; `docs/themes.md` lists them as the interface themes rely on.

## Safety rules

These hold the security model together. Keep each one intact; if a task seems to need one changed, stop and ask the user.

- **The claims trust gate is in Rust.** Whether `claims.check` may run a command is decided in `core_call` (`src-tauri/src/lib.rs`) from the app's own settings, for every check, whatever `commands` value the window sends. Trust is stored in the app's config folder, never in a vault.
- **Checking and trusting need a real user event.** `claims.check`, `claims.checkAll` and `claims.trust` run only on a trusted (`isTrusted`) key or mouse event under a second old (`src/modules/claims/state.ts`), carry `noKey: true` so they cannot be bound to a key, and are refused by MCP `command_run` (`users_alone` in `src-tauri/src/mcp.rs`). No MCP tool maps to `claims.check` (a test in `crates/mcp/src/lib.rs` asserts it).
- **`own` is not for clients.** The MCP layer strips the `own` argument, so what an agent does waits in the review inbox.
- **`note.*` and `folder.*` refuse dot paths.** Any path with a part that starts with a dot (`.git`, `.obsidian`, `.trash`, `.inklode`) is rejected, and the tree, index and search leave such files out.
- **`.inklode/` goes through `config.*`.** `config.read`, `config.write` and `config.list` reach `.inklode/` and nothing else.
- **App settings stay out of the vault.** The MCP switch, the capture hotkey, whether quick capture is on for a vault (`capture.vaults`) and claims trust are in the app's config folder, so a vault from someone else cannot set them. `modules.capture` in a vault's `settings.json` is not read.
- **The MCP token never reaches the window or a tool.** `src-tauri/src/mcp.rs` checks it on every request and puts it on the clipboard itself (`mcp_copy`); no command returns it, and `ui_state` must not carry it.
- **Every git process is made by `command` in `crates/core/src/git.rs`,** which switches off what a repository's config can make git run or fetch. Git is never asked to read a file of the work tree (`diff`, `status`, `blame` without a commit): committed text comes from `cat-file`, the file from our own read. The tests in that file are the attacks.
- **Paths go through `Vault::resolve`** (`real` in `crates/core/src/vault.rs`), which refuses a symlink that leads out of the vault or to a dot name. Do not join a vault-relative path to the root by hand.
- **The window loads nothing from outside the app.** The content security policy in `src-tauri/tauri.conf.json` allows scripts, fonts and connections from the app only and no frames; a navigation of a window to another page is refused in `run` (`src-tauri/src/lib.rs`). Excalidraw's fonts are copied into the build by `vite.config.ts`. A drawing's SVG goes into the page through `toSvg`, which takes the links off it.
- **keys.json cannot bind a bare key.** `bindable` in `src/commands.ts`: a key from a vault needs `Mod` or `Alt`, or is a function key.
- **Only the main window calls Tauri commands** (`main_only`). The presenter and capture windows have no capability.
- **Git is read, never written.** The app does not commit, stage, check out or fetch.
- **The slideshow is written from `docs/slideshow-spec.md` alone.** The Obsidian Excalidraw plugin and its scripts are AGPL-3.0. Do not read, copy or port code from them; if the spec is missing something, extend the spec from observed behaviour and file contents, then implement from the spec.

## Commits

- A short subject that says what changed, for example `Review: reject returns to the last accepted text`. A prefix with the area and a colon is common.
- No AI attribution: no `Co-Authored-By` lines for an assistant, no "Generated with" lines.
- Commit or push only when the user asks.
