# Vault settings, keys, themes and snippets

A vault keeps its own look and keys in its `.inklode` folder. The app reads these files when the vault opens and again whenever one changes on disk, so an edit to a CSS file shows at once. Settings (`Mod+,`) edits the two JSON files; they can also be edited by hand.

| File | What |
|---|---|
| `.inklode/settings.json` | `{"theme": "Sepia", "snippets": ["Wide lines"], "modules": {"excalidraw": true}}`. `theme` is a name from `themes/` or `null`; `snippets` are the names switched on, applied in this order; `modules` is described in [modules.md](modules.md). The look and editor options sit next to them (`src/appearance.ts` has the list): `appearance`, `accent`, `uiFontSize`, `textFont`, `textFontSize`, `lineWidth`, `defaultMode`, `historyDiff`, and `templateFolder`, the folder the Templates module takes its templates from (`_templates` when left out). |
| `.inklode/keys.json` | `{"note.switch": "Mod+K", "note.save": null}`. Command id to key; `null` means no key. Commands not listed keep their default. `command_list` gives the ids. A key set here must have `Mod` (Cmd on macOS, Ctrl elsewhere) or `Alt` in it, or be a function key (`F1` to `F24`, also with Shift): `X`, `Shift+X`, `Enter` or `Escape` is ignored, the command keeps its default, and Settings says so on the command's row. `key.set` refuses such a key. |
| `.inklode/themes/<name>.css` | A theme. One is in use at a time. |
| `.inklode/snippets/<name>.css` | A snippet: a small CSS change, each switched on separately, applied after the theme. |

The app's own settings are not in a vault: the MCP server's switch and port, the capture hotkey and the vaults that have quick capture on, the vaults trusted to run claim commands, and `updates.auto` (whether the app looks for a newer version when it starts, on by default) are in `settings.json` in the app's config folder, `~/Library/Application Support/app.inklode.desktop/` on macOS. The MCP server's token is next to it, in `mcp-token`.

A missing file or key means the default. Keys the app does not know are kept when it writes a file. If a JSON file does not parse, the app says so, keeps using the last good content and does not write to the file until it is fixed.

Themes and snippets are plain CSS, loaded after the app's own. The variables at the top of `src/app.css` and the class names in that file are the interface they can rely on; [themes.md](themes.md) lists them. The app also ships themes of its own (`src/themes/`: Catppuccin, Catppuccin Frappé, Catppuccin Macchiato, Minimal, Things), which show in the same list as the vault's.

Light or dark is `data-appearance="light"` or `"dark"` on `<html>`, from the appearance setting ("system", "light" or "dark"), never `@media (prefers-color-scheme)`. One theme file covers both:

```css
:root {
  --bg: #f4ecd8;
  --text: #433422;
}

:root[data-appearance="dark"] {
  --bg: #2a241b;
  --text: #e6dcc8;
}
```
