# Claims

A claim is a line of a note that names the evidence for what it says, in an HTML comment at its end, which the rendered note does not show:

```markdown
45 core tests pass. <!-- check: cargo test -p core @ ~/code/myproject -->
The spec is in the vault. <!-- check: file Notes/Spec.md -->
Docs are online. <!-- check: https://tauri.app -->
```

The text after `check:` decides what a check does. A marker in a fenced code block or in inline code is not a claim.

- `file <path>`: passes when the file can be read. The path is relative to the vault's folder, or `~/…`, or absolute. Only a regular file of at most 64 MB is read: a folder, a device or a FIFO fails with `not a regular file`, a larger file with `larger than 64 MB, the most a file claim reads`. The check remembers a digest of the file's content.
- A text that starts with `http://` or `https://`: passes when a GET, redirects followed, ends in a 2xx within 10 s. `/usr/bin/curl` does the request.
- Anything else is a shell command: run with `/bin/sh -c`, with nothing to read on stdin, in the vault's folder or in the one named after ` @ ` at its end (`~` is the home folder). It passes when it exits with status 0 within 120 s; after that it is ended, with everything it started.

A claim is in one of four states:

- `unchecked`: it was never checked.
- `failing`: the last check failed.
- `stale`: the last check passed, but it is more than 30 days old, or the file of a `file` claim has another content now or is gone.
- `passing`: otherwise.

Listing the claims only reads: no command runs and no URL is fetched until a claim is checked, one at a time. The results are kept outside the vault, in `claims/` next to the app's `settings.json` (on macOS `~/Library/Application Support/app.inklode.desktop/`), one file per vault. A check writes nothing into the vault, so it never shows up in git or in the review inbox. A claim is known by its note's path and its whole line: after an edit of the line, or a rename of the note, it is `unchecked` again, and what was kept for claims that are gone is dropped at the next check.

Who may run a command: a note can come from someone else, and the command in its marker would run as you. So:

- A command runs only in a vault you marked as trusted. That mark is the vault's folder in `"claims": {"trusted": ["/path/to/vault"]}` of the app's own `settings.json`, never a file in the vault: a vault cannot trust itself. In a vault that is not trusted, checking a command claim fails with `commands are not allowed for this vault` and nothing runs. `file` and URL claims can be checked in any vault.
- The window does not decide this. Whatever it sends, the shell looks the open vault up in the list for every check (`core_call` in `src-tauri/src/lib.rs`). The list changes only through the shell's `claims_trust`, which the trust switch of the claims module calls.
- A check runs when you ask for it in the app. Nothing checks on a timer.
- No MCP tool checks a claim or trusts a vault. `claims_list` only reads, and `command_run` refuses `claims.check`, `claims.checkAll` and `claims.trust`.

The core operations are `claims.list` and `claims.check {path, line, commands?}` (the table on `Core::call`; `crates/core/src/claims.rs`). `claims.list` returns `[{path, line, text, evidence, kind, status, checked, output}]` by path then line: `line` from 1, `text` the line without its marker, `evidence` the marker's text after `check:`, `kind` `command`, `file` or `url`, `checked` the day of the last check and `output` how it ended with the end of what it printed (`exit status 101` and the last lines, `HTTP 404`, `no such file`), at most 2000 characters. `claims.check` checks the claim on one line and returns it in that shape. The MCP tool `claims_list` is the first of the two.

In the app this is the `claims` module, off by default: `"modules": {"claims": true}` in `.inklode/settings.json`.

- In Live Preview the marker is drawn as one mark of the claim's status, each with a shape of its own: a circle with a tick (passing), a square with a cross (failing), a clock (stale), a dashed circle (unchecked). The text of a stale or unchecked claim is dimmed. With the cursor on the line the comment shows as written; source mode always shows it. A click on the mark opens a popover with the evidence, its kind, the day of the last check, the end of what that check printed and a Check button, which says "Checking…" while the check runs.
- "Show claims" (`claims.open`, the shield button in the ribbon, which carries the number of claims that are failing, stale or unchecked) opens the review queue in the right sidebar: Failing, Stale (the oldest check first), Unchecked, then Passing folded to its count. A click on a claim's text opens its note at that line. Each row has a Check button; "Check all" checks everything that is not passing, one claim after another, and Stop ends it after the check that is running.
- The trust switch is "Allow this vault to run commands" in Settings, under the module's switch. A command claim that was refused says so in its row and popover, with a link to that screen.
- Check, "Check all" and the trust switch act on your own click or key press only. A click or key that a script dispatched (the MCP tools `ui_click` and `ui_key`) gets the notice "Checks are run by the user in the app", and these three commands cannot be bound to a key.

| Command | What it does |
| --- | --- |
| `claims.open {open?}` | Opens the panel, or closes it when it is open. |
| `claims.check {path, line}` | Checks the claim on that line of that note. Without params, the claim on the cursor's line; fails when there is none. By the user only. |
| `claims.checkAll` | Checks every claim that is not passing, in the queue's order. By the user only. |
| `claims.trust {trusted}` | Sets whether the open vault may run commands. Without params, opens Settings at the switch. By the user only. |

`claims` in `ui_state`: `open` (whether the panel shows), `trusted` (whether the vault may run commands), `counts` (`{failing, stale, unchecked, passing}`) and `checking` (the claim being checked as `path:line`, or null). Finding the marker on a line and the order of the queue are `src/modules/claims/claims.ts`, checked by `pnpm test:claims`.

Limits of the module: one check runs at a time, and a running check cannot be ended from the app before its 120 s are over; a claim typed a moment ago gets its mark when the note is saved; "by the user" means that the window's last key or mouse event was a real one and under a second old.

Known limits: trust goes by the folder's path, so another vault put at a trusted path is trusted; an agent that can write notes (the MCP `write` tool, any program) can change the command of a claim in a trusted vault, which then runs when you check that claim, so read the command before you check; with the MCP server on, `ui_click` and `ui_key` send clicks and keys to the window, and it is the window's code that tells them from yours; a URL claim can be checked in a vault that is not trusted, and the request goes out from your machine, also to addresses only it can reach; a command gets the app's environment, with `PATH` taken once at start from your login shell (so a change to your shell files needs a restart of the app); the last ` @ ` of a command always starts its folder; the day of a check is in UTC; a passing `file` claim's file is read whole at every listing; two equal lines of one note share a result.
