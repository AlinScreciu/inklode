# Modules

The reference for each module: what it does, its commands, its entry in `ui_state` (what the in-app MCP server reports, see [mcp.md](mcp.md)) and its known limits. The claims module has its own page, [claims.md](claims.md).

Sections: [Excalidraw](#excalidraw), [Graph view](#graph-view), [Tables](#tables), [Git history](#git-history), [Merging changes made outside](#merging-changes-made-outside), [Review](#review), [Vault health](#vault-health), [Tasks](#tasks), [Quick capture](#quick-capture).

## How modules work

A feature beyond the base app (editor, file tree, links, search, palette, settings) is a module, and each one can be switched off per vault.

- The flag is `"modules": {"<id>": true}` in `.inklode/settings.json`. A module with no entry is on or off by its default (`excalidraw`: on, `graph`: on, `tables`: on, `history`: off, `merge`: off, `review`: off, `health`: off, `tasks`: off, `capture`: off, `claims`: off). `capture` is the exception: whether it is on is kept per vault in the app's own settings, and its entry here is not read (see [Quick capture](#quick-capture)).
- Settings (`Mod+,`) has a checkbox per module under "Modules". It runs the command `module.toggle {id, on?}`. The change is in force at once, without a restart.
- A module that is off is not loaded: its code is imported when it is switched on, and the library it needs when it is first used.

To add a module: write `src/modules/<id>/index.ts` with an `activate(app)` that registers what it adds through `AppApi` (`src/modules.ts`: commands, a view for a file type or one shown with no file, a renderer for embeds, a CodeMirror extension for the editor, a panel for the right sidebar, a ribbon button with an optional badge, entries for `ui_state`, listeners for a saved note and for changes in the vault, opening a note at a line, calls into the core), and add a row to `MODULES` in `src/modules.ts` that imports it. What a module registers is taken out again when it is switched off.

## Excalidraw

The `excalidraw` module. A file named `<name>.excalidraw.md` opens in an Excalidraw canvas in place of the text editor. With the module off it opens as Markdown text.

- No web page is shown inside a drawing: an embeddable element (a video, a post) is drawn as a box with its address, in the canvas and in an embed. In a drawing embedded in a note, an element's link is not a link: a click on the embed opens the drawing.
- Excalidraw's fonts come with the app (about 13 MB, most of it the CJK hand-drawn font), so drawings look the same offline.
- The format is the Obsidian Excalidraw plugin's, uncompressed, so the same files work in Obsidian. A compressed or broken drawing opens as text, with the reason in the error banner, and is never written by the canvas.
- Opening, selecting, scrolling and zooming write nothing. An edit is saved like a note's. Saving keeps the frontmatter and all text outside the scene block byte for byte, writes the scene as plain JSON, and writes the `## Text Elements` and `## Element Links` sections again from the elements.
- `![[name.excalidraw]]` (or `![[name.excalidraw.md]]`) in a note shows the drawing in Live Preview and follows changes to it. A click opens the drawing.
- "Present drawing as slides" (`excalidraw.present`) shows the drawing's frames one at a time, the canvas travelling from one to the next. The frames are ordered by frame name (`01 …`, `02 …`), or by the order stored in them when they carry slideshow data of the Obsidian Excalidraw plugin's slideshow script, whose build steps, excluded frames and presenter notes are followed too ([slideshow-spec.md](slideshow-spec.md)). A drawing without frames, or with every frame excluded, is not presented, and a message says which it is. Right, Down, Space and Page Down go forward (the slide's next build, then the next slide), Left, Up and Page Up back, Home starts the slide on screen over, End goes to the last slide, F turns fullscreen on or off, Escape and Backspace leave. The toolbar at the bottom is shown for the first two seconds, and then while the pointer is near it.

## Graph view

The `graph` module. It has two graphs, each with its own options.

- "Open graph view" (`graph.open`, `Mod+G`) shows every note of the vault as a dot and every link between two notes as a line, in place of the editor. Opening a note leaves it. The note that was open is marked in the accent colour.
- "Open local graph" (`graph.local`, the second graph button in the ribbon) opens a panel in the right sidebar, in place of the outline, with the active note and what is within a few links of it, whichever way a link points. "Depth" says how many links, 1 to 3. It follows the active note: when another note is shown, the graph is that note's. The note is marked, and a dot's size counts the links drawn, so a hub of the vault with one link here is small.

In both:

- A dot grows with the number of links it has among what shows. Zoomed out, only the most linked notes keep their label, and a label fades in as its dot nears the size that gives it one ("Text fade threshold" moves that size). A label that would cover another is left out; the pointed-at note, the marked note, the pointed-at note's neighbours and then the notes with the most links get their place first.
- Drag the background to pan, turn the wheel or pinch to zoom, drag a dot to move it. Pointing at a dot dims all but that dot and what is linked with it. A click on a note or a file opens it; a tag and a link target without a note open nothing.
- It follows changes in the vault, and keeps the view and the dots' places when it does.
- The button at the top right opens the options, and Escape or the button closes them:

| Section | Option (`graph.set` name) | What |
|---|---|---|
| Filters | name filter (`filter`) | Only what has the text in its name shows, without case. |
| | Depth (`depth`, 1 to 3, default 1) | The local graph only. |
| | Tags (`tags`, default off) | Each tag is a dot (in `--graph-tag`), linked with the notes that carry it: the frontmatter's `tags` and every `#tag` in the text. Tags that differ only in case are one. |
| | Attachments (`attachments`, off) | The files that are not notes and that a note links to or embeds (images), and drawings (`.excalidraw.md`), are dots (in `--graph-attachment`). |
| | Existing files only (`existingOnly`, on) | Off: a link target that reaches no note and no file is a dot too, drawn as a ring. |
| | Orphans (`orphans`, on) | Off: notes without any link that shows are hidden. |
| Groups | `groups`, a list of `{query, colour}` | A note or file that matches a group's query is drawn in the group's colour, one of eight (`colour` 1 to 8: red, orange, olive, green, cyan, blue, purple, pink; `--graph-group-1` to `--graph-group-8`). The first group that matches wins. |
| Display | Arrows (`arrows`, off) | An arrowhead where a link points to. Zoomed far out they are not drawn. |
| | Text fade threshold (`textFade`, -3 to 3, default 0) | Each step up doubles the zoom a label needs; down, halves it. |
| | Node size (`nodeSize`, 0.25 to 4, default 1), Link thickness (`linkThickness`, 0.25 to 5, default 1) | Multiply the dots' size and the lines' width. |
| Forces | Centre force (`centerForce`, 0 to 0.5, default 0.06) | The pull to the middle. |
| | Repel force (`repelForce`, 0 to 1000, default 220) | How hard dots push each other away. |
| | Link force (`linkForce`, 0 to 2, default 1) | How hard a link pulls its ends together. |
| | Link distance (`linkDistance`, 10 to 300, default 70) | The length a link wants to have. |

- A group's query is words separated by spaces, all of which have to match, without case: a plain word matches when the note's name contains it, `path:Folder/Sub` when its path starts with that, `tag:name` (or `tag:#name`) when it has that tag or one under it (`name/sub`). A word with a space goes in quotes: `path:"My Folder"`. An empty query matches nothing.
- The defaults are the graph as it was before it had options, except that a drawing now counts as an attachment and so is hidden until "Attachments" is on. The button in the options' header puts every option back to its default.
- The options are the vault's, in `.inklode/graph.json` as `{"full": {…}, "local": {…}}` with the names above, written half a second after the last change and read when a graph opens and when files change. A missing file, a file that is not JSON and a value an option does not take mean the default.
- A display option, a group and the name filter only paint again. A force changes the running layout and warms it up. A filter that adds or removes dots hands the layout the new set, and every dot that was there keeps its place.

| Command | What |
|---|---|
| `graph.open` | Shows the full graph in the active tab. Key: `Mod+G`. |
| `graph.local {open?}` | Opens the local graph in the right sidebar, or closes it when it is open. |
| `graph.set {option, value, graph?}` | Sets one option by its name in the table above. A number outside its range is brought to the nearest end; another kind of value is an error that says what the option takes. `graph` is `"full"` or `"local"`; without it, the full graph if it shows, else the local one if that shows, else the full one. The graph need not be open. Without params it opens the options panel. |
| `graph.filter {text, graph?}` | Sets the name filter (the same as `graph.set {option: "filter"}`). Without `text` it opens the options, where the filter field takes the keyboard. |
| `graph.addGroup {query?, colour?, graph?}` | Adds a group at the end. Without `colour`, the one after the last group's. |
| `graph.removeGroup {index?, graph?}` | Removes the group at that position, from 0. Without `index`, the last one. |
| `graph.reset {graph?}` | Puts every option of that graph back to its default. |
| `graph.options {open?, graph?}` | Opens the options panel of a graph that is on screen, or closes it with `{open: false}`. |
| `graph.zoom {zoom?, graph?}` | Zooms a graph that is on screen to that level around the middle of its pane (1 is the size the layout is made at). Without `zoom`, the whole graph is brought into the pane. |

`graph` in `ui_state`, while the full graph shows: `nodes` and `edges` (how many dots and lines show), `kinds` (`{note, tag, attachment, unresolved}`, the dots of each kind), `filter`, `hovered` (the path of the note or file under the pointer, or the name of a tag or missing target; null with none), `zoom`, `labels` (how many labels the last paint drew), `settled` (whether the layout has come to rest), `options` (every option by its name) and `optionsOpen`. `localGraph`: `open` (whether the panel shows), `path` (the note it is about, or null), `depth`, and while it is open the same fields as `graph`; closed, `options` as saved. Null with the module off.

The data is the core operation `vault.graph`: `{nodes: [{path, links, tags?}], edges: [{from, to}], unresolved: [{name, from}], attachments: [{path, from}]}`, with one edge per pair of notes and direction, `tags` left out for a note without any, and `from` as positions in `nodes`. The local graph is cut from the same answer in the window (`src/modules/graph/model.ts`). The options and the query are `options.ts`; `pnpm test:graph` checks both and the label placement. The colours and sizes are the `--graph-*` variables at the top of `src/app.css`.

Measured on a vault of 3000 notes with 6400 links (a debug build, a 1200 by 800 window): the graph shows 0.1 s after `graph.open` and its first layout comes to rest after 5 s, at 55 to 60 frames a second, with `ui_state` and opening a note answering in under 50 ms meanwhile. A paint takes 1.5 ms zoomed out, 5 ms at zoom 0.5 with 260 labels, and 10 ms there with tags, attachments, unresolved targets and arrows on (10700 lines). Switching a filter costs 7 ms and then the layout moves for 4 s; a step of a force slider costs 2 ms. The local graph of a hub with 150 links shows at depth 1 at once, and at depth 3 it is most of the vault and behaves like the full graph.

Known limits: every tick of the layout pushes every dot against every other (d3's approximation), 6 to 8 ms at 3000 notes, so around 6000 notes the layout drops under 30 frames a second while it moves; in a window that is covered or minimised the layout is worked out on a timer in slices of 100 ms, which the system slows down, so it can take half a minute to come to rest there (`settled` says when); a change of an option in the half second before another vault is opened is written to that vault; the name filter hides dots without moving the others together; two graphs of the same kind on screen (the full graph in two panes) share their options, and the commands act on the one opened last; the local graph's depth counts links through tags, attachments and unresolved targets when those show.

## Tables

The `tables` module. In Live Preview a pipe table (header row, delimiter row, rows) shows as a table, with the columns aligned as the delimiter row says and the inline Markdown of its cells rendered. Source mode shows the text, and so does Live Preview with the module off.

- Click a cell to edit it; it then shows its raw Markdown. A click on a link in a cell that is not being edited follows the link. A typed `|` is written as `\|`, and a cell is always one line.
- Keys in a cell: Tab and Shift+Tab go to the next and the previous cell, and Tab in the last cell adds a row. Enter goes down a row, and adds one at the end. The arrows left and right change cell when the caret is at that edge of the text, up and down change row, and leave the table from its first and last row. Escape leaves the cell for the line under the table. Undo and redo are the editor's.
- Writing rule: a table that is not edited is never rewritten, so opening a note leaves the file byte for byte as it was. An edit rewrites that one table only, the way Obsidian's table editor formats: one space around each cell, every column padded to its longest cell.
- A row with fewer or more cells than the header is shown padded to the longest row, and written that way once the table is edited.
- The commands act on the table and cell the cursor is in, in both modes, and each is one undo step. While a cell is edited, the same actions are buttons over the table. From the palette a command runs without params.

| Command | What |
|---|---|
| `table.addRow {above?}` | Adds a row below the cursor's row, or above it with `{above: true}`. |
| `table.addColumn {left?}` | Adds a column to the right, or to the left with `{left: true}`. |
| `table.deleteRow`, `table.deleteColumn` | Deletes the cursor's row (not the header) or column (not the only one). |
| `table.moveRow {direction?}` | Moves the row `"down"` (default) or `"up"`. The header stays. |
| `table.moveColumn {direction?}` | Moves the column `"right"` (default) or `"left"`. |
| `table.align {align?}` | Aligns the column `"left"`, `"center"`, `"right"` or `"none"`. Without `align`, the next of none, left, center, right. |
| `table.new {rows?, columns?}` | Inserts an empty table at the cursor, with 2 rows under the header and 3 columns unless given. |

The borders, the header background and the cell padding are the `--table-*` variables at the top of `src/app.css`. The text is read and written by `src/modules/tables/table.ts`, which `pnpm test:tables` checks.

## Git history

The `history` module, off by default: `"modules": {"history": true}` in `.inklode/settings.json`. It shows a note's past from the git repository the vault is in. Git is only read (`git log`, `git cat-file`, `git show -s`, `git blame`); the app never commits, checks out or stashes. In a vault that is not in a repository, or without `git` installed, the list is empty and the margin stays blank.

- "Show note history" (`history.open`, `Mod+Shift+H`) opens the History panel in the right sidebar, in place of the outline: the commits that changed the active note, newest first, through renames, each with its date, author and subject.
- A click on a version shows what differs between that version and the note's text now, as typed: lines only in the old version are marked removed, lines only in the text now added, and unchanged runs are folded to one row that a click opens.
- "Show changes in" at the top of the panel says where that comparison shows: "Sidebar", under the list (the default), or "Pane", in a pane of its own beside the note, which opens when a version is picked and closes when none is. The choice is the vault's setting `"historyDiff": "sidebar"` or `"pane"` in `.inklode/settings.json` (`settings.set {key: "historyDiff", value}`).
- "Restore this version" puts that version's text into the editor as one edit. Undo takes it back, and it is saved the way typing is, with the same check for a file that changed on disk. Nothing is written past the editor.
- "Toggle history margin" (`history.blame`) shows a column left of the text that names, for each stretch of lines and at the start of each paragraph, the author and date of the last commit that changed it; the commit's subject is the tooltip. Lines that are not in the last commit, typed or saved since, are marked "Not committed yet". Git is asked when the margin is switched on and after each save.

| Command | What |
|---|---|
| `history.open {open?}` | Opens the History panel, or closes it when it is open. |
| `history.select {rev?}` | Picks the version with that hash (null: none). Without `rev`, the next older one. The panel must be open. |
| `history.restore {rev?}` | Puts the version with that hash into the active note's editor. Without `rev`, the one picked in the panel. |
| `history.blame {on?}` | Shows or hides the history margin. |

`gitHistory` in `ui_state`: `open`, `path` (the note the panel is about), `revisions` (`[{rev, author, date, subject}]`), `selected` (a hash or null), `diff` (`{added, removed}` line counts against the picked version, or null), `diffIn` (`sidebar` or `pane`, where the comparison shows), `blame` (whether the margin is on) and `blameRanges` (`[{from, to, rev, author, date}]` for the active editor, lines from 1, `rev` null for lines not committed yet; null while the margin is off).

The core operations are `git.log {path}`, `git.show {path, rev?}` and `git.blame {path}` (the table on `Core::call`). They do not hold up the rest of the app: the app and the MCP servers run them without holding the core (`Core::outside`), so notes open and save while git runs. `src/components/DiffView.tsx` is the comparison view, built on `lineDiff` in `src/textDiff.ts`, and is not part of the module, so other features can show a comparison with it; `src/components/DiffPane.tsx` is the same comparison with a pane to itself, under a header with the line counts and buttons. Its colours are the `--diff-*` variables and the margin's the `--blame-*` variables at the top of `src/app.css`.

## Merging changes made outside

A note's file is never written over a text the app has not seen: every write names the text it replaces, and the core refuses it when the file has another text by then. When that happens under an unsaved edit, the pane shows a banner and nothing is saved until the user chooses: "Keep mine" (`conflict.keepMine`), "Take theirs" (`conflict.takeTheirs`) or "Show both". In `ui_state` the tab has `conflict: "changed"`.

The `merge` module, off by default: `"modules": {"merge": true}` in `.inklode/settings.json`. With it on, such a conflict is merged without asking when the edit and the outside change are in different parts of the note.

- The merge is by lines and three-way: the text the edit was made on, the editor's text and the file's text (`src/modules/merge/merge3.ts`, checked by `pnpm test:merge`). Changes to the same line, to lines next to each other, or two insertions at one spot do not merge; the same change on both sides is taken once. Line endings are left as they are.
- A merged text goes into the editor as one edit, in every pane that shows the note, and is saved from there over the file's text as it was just read. Undo takes the outside change out of the editor again, and that is then saved like typing. A line at the bottom of the window says that a change was merged, for a few seconds.
- When the changes do not merge, the banner shows as with the module off. So it does when the note is gone from disk, when it is a drawing or another module's view, and when no editor shows the note.
- `merge` in `ui_state`: `count`, the conflicts merged since the module was switched on, and `last`, the path of the note of the last one (null before the first).

## Review

The `review` module, off by default: `"modules": {"review": true}` in `.inklode/settings.json`. It is an inbox of the notes that changed since you last looked, for a vault whose notes are also edited by agents: by writing files, by committing to the vault's git repository, also while Inklode is closed.

- Git is run without your global and system git config, so a global ignore file set there (`core.excludesFile`) does not hide untracked notes from the inbox; the vault's own `.gitignore` does.
- What changed is asked of git, which is only read (`rev-parse`, `cat-file`, `ls-tree`, `ls-files`, `log`): the app never commits, stages or checks out. Git is not asked to read the notes on disk: the app reads them itself and compares them with the committed text, so no filter of the repository's `.gitattributes` and config runs. A note waits when its text on disk differs from the text you last saw: the one you last accepted, or its text at a remembered commit when you never accepted another. Committed and uncommitted changes, new notes and deleted notes all count; only notes (`.md`) outside dot folders do. A vault that is not in a git repository with a commit gets a message in the inbox and nothing else.
- What you have seen is not kept in the vault, where it would itself be a change: it is a file per vault under `review/` in the app's config folder (next to its `settings.json`; on macOS `~/Library/Application Support/app.inklode.desktop/`), as `{vault, base, accepted}`: `base` is the remembered commit and `accepted` maps a note's path to `{text}`, the text you accepted where it is not the one at `base` (null for a note you accepted as deleted). A file written before the texts were kept has a digest there instead; such a note still counts as accepted, and is compared with `base` when it changes again. `inklode-mcp` uses the same folder. The first time review is used in a vault, `base` is the last commit and what is uncommitted then is accepted, so the inbox starts empty.
- "Review changes" (`review.open`, `Mod+Shift+R`, the inbox button in the ribbon, which carries the number of notes that wait) shows the inbox in the active tab: the notes that wait, each with its status (changed, added, deleted), the lines added and removed against the text you last saw, and the author and subject of the newest commit that changed it, or "not committed yet". The picked note's changes show beside the list, against the text you last saw, and with the text as typed if the note is open.
- "Accept" marks the note's text as seen and keeps it: when the note changes again, the comparison shows only what changed since, and a reject goes back to the accepted text. "Accept all" does that for everything: the last commit becomes `base`, and only the texts that are not committed are kept. Accepting changes no file.
- "Reject" takes the note back to the text you last saw: the one you last accepted, else the one at `base`. For a note that is open in an editor it is an edit there: Undo takes it back, and it is saved the way typing is. For a note that is not open, the file is written, and the write is refused if the file changed since the comparison was shown. A new note is deleted the way the app deletes (it moves to `.trash/`), and a deleted note is made again. Nothing is committed: git then shows the note as changed against the last commit.
- Your own edits do not wait for review: when the app saves what you typed in a note that was not waiting, the new text is accepted. A note that was waiting stays, with your edit in it. Undoing a reject is such an edit, so it accepts the change.
- Neither does what you rename, move, delete or make in the app: the notes that moved or went, and the notes whose links a rename rewrote, are accepted as they are after it. A note that was waiting before stays waiting; one that moves while it waits shows as deleted at the old path and added at the new one. The app says so to the core with `own: true` on `note.create`, `note.rename`, `folder.rename`, `note.delete` and `folder.delete`. The MCP tools (`create`, `rename`, `delete`, `folder_rename`, `folder_delete`) do not have that parameter and drop it when given, so what an agent does through them waits for review.
- The inbox is read again when files of the vault change and when the window comes to the front.

| Command | What |
|---|---|
| `review.open` | Shows the inbox in the active tab. Key: `Mod+Shift+R`. |
| `review.select {path?}` | Shows the changes of that note. Without `path`, of the note after the picked one. |
| `review.accept {path?}` | Accepts that note. Without `path`, everything that waits. |
| `review.reject {path?}` | Rejects that note's changes. Without `path`, those of the picked note. |

`review` in `ui_state`: `open` (whether the inbox shows), `repository` (false in a vault that is not in a git repository), `entries` (`[{path, status, added, removed, commits, uncommitted}]`, `commits` as `[{rev, author, date, subject}]` newest first), `selected` (a path or null) and `diff` (`{added, removed}` for the picked note, as the comparison marks the lines, or null).

The core operations are `review.list`, `review.base {path}`, `review.accept {path?}` and `review.saved {path, before, after}` (the table on `Core::call`; `crates/core/src/review.rs`). Like the history's they run without holding the core, so reading the inbox, which compares every note with a commit, does not make a note wait to open or save. Two of them at once in one program change the state file one after the other; the app and `inklode-mcp` changing the state of one vault in the same moment can still lose one of the two changes. The MCP tool `review_list` is the first of them. The list's width and the badge's colours are `--review-list-width`, `--badge-bg` and `--badge-text` at the top of `src/app.css`.

Known limits: a note that waits and is renamed or moved in Inklode shows as two entries, a deleted and an added one; the accepted texts are all in the one state file, which is read and written whole; a commit made outside shows its author only at the next change in the vault or when the window comes to the front; merge commits are not named as the origin of a change.

## Vault health

The `health` module, off by default: `"modules": {"health": true}` in `.inklode/settings.json`. "Show vault health" (`health.open`, the heart button in the ribbon) opens a panel in the right sidebar that lists what in the vault needs looking after. A click on a row opens the note, and the panel stays.

- Broken links: `[[links]]` and `![[embeds]]` that reach no note and no file, under the note they are in. A click opens the note at the link. Links are resolved as everywhere else in the app (`Index::resolve`), and links in code are left out. A link to a heading counts as reaching its note, whether the note has that heading or not.
- Stale notes: a note whose frontmatter has `repos: [name, ...]` and `updated: YYYY-MM-DD` is stale when the default branch of a repository it names has a commit dated after the `updated:` day. Commits on the day itself do not count. The row shows how many commits there are and the newest one (day, short hash, subject).
  - A `repos:` entry is a path (`~/projects/foo`) or a folder name, and a folder name is looked up, up to three levels deep, under the folders in `$VAULT_REPO_ROOTS` (colon-separated; default `~/projects:~/work:~/misc`). The folder must be the root of a repository: a folder inside one (a chart in a repository of charts) is not taken for it.
  - The default branch is `origin/HEAD` as last fetched, or what is checked out in a repository that has no `origin/HEAD`. Commits on other branches do not count.
  - An entry can end in a scope. `name:dir` counts only the commits that change something under `dir`, a path from the repository's root; `name:!dir` only those that change something outside it.
  - A commit that changes only housekeeping files at the repository's root does not count: `.gitignore`, `.gitattributes`, `.editorconfig`, `.github/CODEOWNERS`, `.pre-commit-config.yaml`.
  - A row that starts with "?" is a note that could not be checked: its repository was not found or the folder is not the root of a git repository, or the note has `repos:` and no valid `updated:`.
  - Git is only read (`rev-parse`, `show-ref`, `log`), never written, and nothing is fetched.
- Notes without links: no link to another note and none from one.

Notes in a folder named `_templates`, at any depth, are in none of the three lists: a template's placeholder links and empty `updated:` are not faults.

The ribbon button carries the number of broken links plus stale notes. The list is read again:

- three seconds after the files of the vault last changed, so a row of saves is one reading, and the panel and the count are that much behind a change;
- when the panel is opened;
- when the window comes to the front while the panel shows. A commit in a repository changes no file of the vault, so with the panel closed the count learns of it at the next change in the vault.

For the three seconds after another vault is opened, the panel and the count are still those of the vault before. One reading runs at a time and at most one more waits, and the git part of a reading does not hold up the rest of the app: notes open and save while it runs. The commits read from a repository are kept until its default branch is at another commit, so a reading costs two short git runs per repository (its root, and where that branch is) plus a `git log` for each one that changed; the kept commits are gone when the app is closed.

`health` in `ui_state`: `open` (whether the panel shows), `broken` (`[{path, links: [{line, link, text}]}]`), `orphans` (paths), `stale` (`[{path, updated, repo, dir, commits, newest: {date, rev, subject}}]`) and `unchecked` (`[{path, repo, reason}]`, `repo` null when `updated:` is the problem). That is what the core operation `vault.health` returns (the table on `Core::call`; `crates/core/src/health.rs`), which is also the MCP tool `health`.

Known limits: a bare repository named in `repos:` is not read and is listed as unchecked, like a folder that is no repository (git is run so that a folder is never taken for a bare repository, see README, Security); a link to a heading or block that does not exist is not reported; a note whose only link is broken is also listed as without links; every reading runs git again, two or three times per repository that notes name, and keeps nothing between readings; a merge commit that changes nothing itself is not counted; a scope that names no folder of the repository finds no commits and is not reported; where `origin/HEAD` is missing in a clone, the commits of whatever branch is checked out are counted; an unfetched commit is not seen; a `repos:` entry with a comma in it is not read; the home folder for `~` is `$HOME`.

## Tasks

The `tasks` module, off by default: `"modules": {"tasks": true}` in `.inklode/settings.json`. "Show open tasks" (`tasks.open`, the list button in the ribbon, which carries the number of open tasks) opens a panel in the right sidebar with every open checkbox of the vault, under the name of its note: `- [ ] text`, also after `*`, `+`, `1.` and `1)`, indented or not, and not inside a fenced code block.

- A click on a task's text opens its note at that line.
- A click on its checkbox ticks it in the note (`[ ]` becomes `[x]`, nothing else changes). When the note is open as text this is an edit in its editor, which Undo takes back and which is saved like typing; else the file is written with the text just read as `base`, so the core refuses the write if the file changed in between.
- The list is read again when files of the vault change.
- Notes in a folder named `_templates`, at any depth, are left out: a template's checkboxes are not tasks.

| Command | What |
|---|---|
| `tasks.open {open?}` | Opens the panel, or closes it when it is open. |
| `tasks.tick {path, line}` | Ticks the open checkbox on that line of that note. Fails when there is none. |

`tasks` in `ui_state`: `open` (whether the panel shows), `count` (open checkboxes in all notes) and `notes` (`[{path, tasks: [{line, text}]}]`, `line` from 1). `notes` is what the core operation `vault.tasks` returns, which is also the MCP tool `tasks`. Ticking is `src/modules/tasks/tasks.ts`, checked by `pnpm test:tasks`.

Known limits: a checkbox in a quote (`> - [ ]`) is not listed; a task's text is cut at 200 characters in the list; ticked tasks are not shown and cannot be unticked from the panel.

## Quick capture

The `capture` module, off by default. Its switch in Settings (and `module.toggle {id: "capture"}`) is kept in the app's own settings, as the vault's folder in `"capture": {"vaults": [...]}`, not in the vault: the module takes a system-wide key, which a vault from someone else must not be able to do. `"modules": {"capture": true}` in a vault's `.inklode/settings.json` does nothing. With it on and Inklode running, also in the background, a system-wide hotkey brings up a small box. Enter appends its text to the vault's capture note and the box goes away; Shift+Enter makes a new line; Escape gives up. Either way the keyboard is back in the app you were in. "Quick capture" (`capture.open`, the pen button in the ribbon) opens the same box.

- The capture note is `Inbox.md` at the vault root, or the note named by `"capture": {"note": "Notes/Capture.md"}` in `.inklode/settings.json`. It is made, with the folders above it, by the first capture.
- A capture is one list item at the end of the note: `- text`, on a line of its own. The other lines of a capture with more than one are indented under the bullet, so it stays one item. The text already in the note is not changed: a note that does not end with a line end gets one first, and its line ends (`\n` or `\r\n`) are used (`src/modules/capture/append.ts`, checked by `pnpm test:capture`).
- If the capture note is open in an editor, the item is an edit at the end of the editor's text, saved like typing, so what was typed there and not saved yet stays, and Undo takes the capture back. If it is not open, the note is read and written with `note.write` and the text that was read as `base`; when another program changed the file in between, the core refuses the write and the note is read again (up to five times).
- A capture that cannot be written (a capture note outside the vault, a disk that is full) shows in the main window's error banner with its text, since the box is gone by then.
- The hotkey is `Ctrl+Alt+Space` unless the app's settings say otherwise: `"capture": {"hotkey": "Cmd+Shift+K"}` in the app's `settings.json` (next to the MCP setting; on macOS `~/Library/Application Support/app.inklode.desktop/`), written as modifiers (`Ctrl`, `Alt`, `Shift`, `Cmd`) and one key. It is the app's setting and never the vault's, so a vault from someone else cannot take a system-wide key. It is registered only while the open vault has the module on in the app's settings. Settings shows it under Modules, below the module's switch, where it can be changed, with a line that says whether it is registered or why not.
- The box is a window of its own with no Tauri permission (`src-tauri/src/capture.rs`). On macOS it is a panel that takes the keyboard without making Inklode the active app, so it shows over the app in front, also over a fullscreen one, and the main window stays where it is.

| Command | What |
|---|---|
| `capture.open {text?}` | Shows the capture box. With `text`, appends that text to the capture note without the box. |
| `capture.hotkey {key}` | Sets the global hotkey, e.g. `{key: "Cmd+Shift+K"}`. Fails, with the hotkey saved and none registered, when it is not a key combination or the system does not register it. |

`capture` in `ui_state`: `hotkey` (as in the app's settings), `registered` (whether the system has it registered for Inklode now), `error` (why not, or null), `count` (captures appended since the module was switched on) and `last` (the path of the note the last one went to, or null).

Known limits: macOS lets two apps register the same hotkey and gives the key to one of them, so a hotkey another app already has is not reported as an error; the hotkey is typed in Settings, not recorded from a key press; with Inklode hidden (Cmd+H) the box unhides the app, so the main window shows again behind the app in front; the box comes up on the display it was first shown on; a capture made while the main window's page is reloading is lost; outside macOS the box is an ordinary always-on-top window and was not tried.
