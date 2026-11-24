# MCP servers

Inklode has two MCP servers. Both offer the same vault tools, each a thin wrapper over one core operation (the `TOOLS` table in `crates/mcp/src/lib.rs`).

- `inklode-mcp`: a headless binary that serves one vault over stdio. The app does not need to run.
- The server inside the running app, over HTTP on localhost: the same vault tools on the vault open in the window, plus tools that drive and inspect the window.

Neither server can check a claim or trust a vault for commands (see [claims.md](claims.md)). What an agent creates, renames or deletes through the tools waits in the review inbox when the `review` module is used (see [modules.md](modules.md#review)).

## The headless server: `inklode-mcp`

```sh
cargo run -p inklode-mcp -- --vault /absolute/path/to/vault   # MCP server over stdio for that vault, no UI
```

The released app carries the binary, signed with it, at `Inklode.app/Contents/MacOS/inklode-mcp`. To register that one with Claude Code:

```sh
claude mcp add inklode -- /Applications/Inklode.app/Contents/MacOS/inklode-mcp --vault /absolute/path/to/vault
```

An app update replaces it along with the app. From a clone, build it (`cargo build --release -p inklode-mcp`) and name `target/release/inklode-mcp` instead.

Any other MCP client that starts a server over stdio takes the same command line: the binary, `--vault` and the absolute path of the vault's folder. stdout carries only protocol messages; errors go to stderr.

Paths are relative to the vault root and use forward slashes. A path with a part that starts with a dot (`.git`, `.obsidian`, `.trash`, `.inklode`) is refused.

| Tool | What |
|---|---|
| `search {query}` | Notes whose file name or text contains the query, ignoring case. At most 200 hits as `{path, line, text}`; line 0 is a file-name match. |
| `search_ranked {query, limit?}` | The notes most about the query's words, best first, as `{path, score, lines}`: at most `limit` (10 if left out, 50 at most). A note matches when it has one of the words, whole and in any case (no stemming); it is ranked with BM25 over its words, with more weight for a word in its file name, its frontmatter `aliases` or `tags`, or a heading, and notes with every word come first. `lines` are up to 3 of its best matching lines as `{line, text}`. `search` is for an exact text and every hit, this for which notes are about something. |
| `read {path}` | The full Markdown text of one note as `{content}`. |
| `write {path, content, base?}` | Creates a note or replaces its whole content, creating missing folders. With `base`, the note's text as last read, nothing is written if the file no longer holds exactly that, and the error starts with `changed on disk since it was read`. |
| `create {path, content?}` | Makes a new note. Fails with `already exists` if anything has that path. |
| `rename {from, to}` | Moves or renames a note and rewrites the links that point to it. Returns `{updated}`, the notes whose links were rewritten. A new name with one of `[ ] # \| ^`, or with a space at its start or end, is refused before anything moves, because no link could say it. |
| `delete {path}` | Moves a note to `.trash/` in the vault. Returns `{trashed}`. Links to it stay as they are. |
| `folder_new {path}`, `folder_rename {from, to}`, `folder_delete {path}` | The same for folders: a rename moves the folder with everything in it and rewrites the links that would break, a delete moves it to `.trash/`. |
| `list` | The vault's folders and files as a tree of `{name, path, children}`. |
| `backlinks {path}` | The lines in other notes that link to this note, as `{path, line, text}`. |
| `resolve {link, from}` | The note a wiki link points to, as `{path}`, null when no note matches. |
| `graph_note {path, depth?}` | A note's place among the links, as `{path, links, backlinks, unresolved}`: the paths of the notes it links to or embeds, of the notes that link to it, and the targets of its links that reach no note and no file. With `depth` 2 or 3 (1 if left out) also `near`, the notes 2 to `depth` links away in either direction as `{path, distance}`, nearest first and at most 200, and `nearTotal`, how many there are. |
| `graph_path {from, to}` | A shortest chain of notes that joins two notes by links in either direction, as `{found, path, steps}`: `path` is the notes from `from` to `to`, `steps` one `{from, to, linkIn}` per pair, `linkIn` being the note the link is written in. With no chain, `found` is false and both lists are empty. |
| `git_log`, `git_show`, `git_blame` | Read the history of the git repository the vault is in (see [Git history](modules.md#git-history)). Git is never written. |
| `review_list` | The notes that wait for the user's review (see [Review](modules.md#review)). |
| `health` | Broken links, notes without links and stale notes (see [Vault health](modules.md#vault-health)). Only reads. |
| `tasks` | The open checkboxes of the vault (see [Tasks](modules.md#tasks)). Only reads. |
| `claims_list` | The claims of the notes with the result of their last check. Runs nothing (see [claims.md](claims.md)). |

The review and claims state is shared with the app: `inklode-mcp` reads the same folder (on macOS `~/Library/Application Support/app.inklode.desktop/`).

## MCP server in the app

In the table below, "see Claims" refers to [claims.md](claims.md) and the other "see" references to the sections of [modules.md](modules.md).

The running desktop app can also serve MCP itself, over streamable HTTP at `http://127.0.0.1:7811/mcp`, so an agent can drive and inspect the real window. The core tools act on the vault that is open in the window.

It is off by default. Switch it on in Settings (`Mod+,`) under "MCP server", where the port is set too. The setting is stored in the app's config folder, not in a vault, so a vault from someone else cannot switch the server on.

```sh
claude mcp add --transport http inklode-app http://127.0.0.1:7811/mcp --header "Authorization: Bearer <token>"
```

- Every request must carry the token as `Authorization: Bearer <token>`. A request without it, or with another one, gets `401`. The token is 64 hex digits, made when the server first starts and kept in `mcp-token` in the app's config folder (`~/Library/Application Support/app.inklode.desktop/` on macOS), a file with mode 0600. The server reads the file for every request.
- In Settings, "Copy" next to "Token" puts the token on the clipboard, "Copy" next to "Add to Claude Code" the line above with the port and the token filled in, and "New token" replaces the token, after which clients need the new one. The commands behind them are `mcp.copyToken`, `mcp.copyCommand` and `mcp.newToken`. The token is not shown in the window, and no tool returns it, `ui_state` included.
- A client with the token can open any folder as a vault (`command_run {id: "vault.open", params: {path}}`) and then read and write in it, so it reaches every file the user can. Any program run by the same user can read the token file. The token keeps out other users of the machine and programs that cannot read the user's files.

- The environment variable `INKLODE_MCP_PORT` overrides the setting: a port number switches the server on at that port even if the setting is off, and `off` switches it off. Settings then shows the override and its controls are disabled. If the port is taken, Settings shows the error and the app runs without MCP.
- It listens on `127.0.0.1` only, and refuses every request that has an `Origin` header (a web page) or a `Host` other than `127.0.0.1:<port>` or `localhost:<port>`. 

| Tool | What |
|---|---|
| `search`, `search_ranked`, `read`, `write`, `create`, `rename`, `delete`, `folder_new`, `folder_rename`, `folder_delete`, `list`, `backlinks`, `resolve`, `graph_note`, `graph_path`, `git_log`, `git_show`, `git_blame`, `review_list`, `health`, `tasks`, `claims_list` | The same tools as `inklode-mcp`, on the vault open in the window. `claims_list` lists the claims of the notes with the result of their last check and runs nothing (see Claims). The `git_*` tools read the vault's git history (see Git history). `review_list` lists the notes that wait for the user's review (see Review). `health` lists broken links, notes without links and stale notes (see Vault health), `tasks` the open checkboxes (see Tasks); both only read. |
| `command_list` | The window's commands as `[{id, title, key?}]`. |
| `command_run {id, params?}` | Runs a command. `vault.open {path}`, `note.new {path}` and `note.rename {path}` run without their dialog. `theme.set {name}`, `snippet.toggle {name, on?}`, `module.toggle {id, on?}`, `key.set {id, key}`, `mcp.set {enabled?, port?}` and `updates.set {auto}` do what the settings screen does. `app.checkForUpdates` asks the release server whether a newer version of the app exists and shows the answer in a notice in the window (`update` in `ui_state`); installing an update is not a command, only the notice's button does it. With a drawing open, `excalidraw.present` starts its slideshow, and `slideshow.next`, `slideshow.prev` and `slideshow.exit` drive it. `graph.open` shows the graph view, `graph.local` the local graph, and `graph.set {option, value, graph?}` sets one of a graph's options (the `graph.*` commands are listed under Graph view). The `table.*` commands are listed under Tables, the `history.*` commands under Git history, the `review.*` commands under Review, `health.open` under Vault health, the `tasks.*` commands under Tasks, the `capture.*` commands under Quick capture, the `template.*` commands under Templates and the `claims.*` commands under Claims. `note.exportPdf {path?}` opens the system's print dialog on the note, which does not answer to MCP: close it in the window. `claims.check`, `claims.checkAll` and `claims.trust` are refused here: they are the user's to run, in the app. |
| `ui_state` | What the window shows: vault, open note, `view` (`markdown`, `excalidraw` for a drawing, `image` for a picture, `pdf` for a PDF, `file` for a file that is not text and cannot be shown, or `graph` while the graph view covers the note), `pdf {pages, zoom, fit, drawn}` (while the active tab shows a PDF: its page count, the zoom with 1 as 100%, whether it fits the pane's width, and the pages drawn now; null otherwise), `graph {nodes, edges, kinds, filter, hovered, zoom, labels, settled, options, optionsOpen}` (the full graph while it shows) and `localGraph {open, path, depth, options, …}` (the local graph in the right sidebar; see Graph view for both), `drawing {elements, frames, dirty}` (element count, frame names in slide order, unsaved edit) and `slideshow {index, count, frame}` (`index` from 0; null when not presenting), `table {row, column, rows, columns}` (the cell the editor's cursor or the edited cell is in, row 0 being the header, and the table's size; null outside a table), `gitHistory {open, path, revisions, selected, diff, diffIn, blame, blameRanges}` (the history panel and margin, see Git history; null with the module off), `review {open, repository, entries, selected, diff}` (the review inbox, see Review; null with the module off), `merge {count, last}` (see Merging changes made outside; null with the module off), `capture {hotkey, registered, error, count, last}` (see Quick capture; null with the module off), `health {open, broken, orphans, stale, unchecked}` (see Vault health; null with the module off), `tasks {open, count, notes}` (see Tasks; null with the module off), `claims {open, trusted, counts, checking}` (see Claims; null with the module off), `rightSidebar` (`outline`, the id of a module's panel: `history`, `health`, `tasks`, `claims` or `graph-local`, or null), `modules` (id to on or off), `update {kind, version?, message?}` (the notice about an update of the app: `kind` is `checking`, `latest`, `error`, `available`, `downloading`, `failed` or `ready`; null with no notice), editor text, cursor line and mode (`live-preview`, `source` or `reading`), sidebar/search/dialog, theme, snippets and key overrides, visible tree entries, backlinks, search results, error banner. |
| `ui_open {path, line?}` | Opens a note in the window. |
| `ui_click {x, y, button?, count?, mod?}` | Clicks at a point of the window, with Cmd held if `mod`, and returns what was hit. Coordinates are CSS pixels: a `ui_screenshot` pixel divided by `viewport.devicePixelRatio` from `ui_state`. |
| `ui_drag {from, to, steps?}` | Presses the left button at `from {x, y}`, moves to `to {x, y}` in `steps` moves (default 10) and releases. |
| `ui_key {key, mod?, shift?, alt?}` or `ui_key {text}` | Presses one key (`Enter`, `Escape`, `p` with `mod`) on the focused element, or types `text` into it. A key press runs shortcuts but types nothing. |
| `ui_screenshot` | PNG of the window's content (macOS only). |
