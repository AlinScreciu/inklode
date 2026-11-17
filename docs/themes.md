# Themes

A theme is one CSS file that sets Inklode's CSS variables. It is added to the page after the app's own stylesheet (`src/app.css`), and before the snippets that are switched on.

## Where a theme comes from

| Kind | File | Notes |
|---|---|---|
| Vault theme | `<vault>/.inklode/themes/<name>.css` | Reloaded when the file changes. |
| Built-in theme | `src/themes/<name>.css` in this repository | Bundled with the app, each as its own chunk, fetched when first used. |

- The theme's name is the file name without `.css`.
- Both kinds are in one list: the Settings screen, `available.themes` in the config state, and what `theme.set {name}` and `"theme": "<name>"` in `.inklode/settings.json` accept.
- A vault theme with the name of a built-in one wins. So to change a built-in theme, copy it to the vault under the same name and edit the copy.
- `theme.set {name: null}` goes back to the app's default look.
- The code is in `src/config.ts` (`BUILTIN_THEMES`, `loadConfig`, `setTheme`).

Built-in now: `Catppuccin` (Latte in light, Mocha in dark), `Catppuccin Frappé`, `Catppuccin Macchiato` (both dark only), `Minimal`.

## Light and dark

`<html>` always has `data-appearance="light"` or `data-appearance="dark"` (set by `src/appearance.ts` from the appearance setting). One theme file covers both:

```css
:root {
  /* light values, and everything that is the same in both */
  --bg: #ffffff;
  --text: #222222;
}

:root[data-appearance="dark"] {
  /* what differs in dark */
  --bg: #1e1e1e;
  --text: #dddddd;
}
```

Rules:

- Do not use `@media (prefers-color-scheme)`. The user can pick an appearance that is not the system's.
- The app's own dark values are in `:root[data-appearance="dark"]`, and that selector outranks plain `:root`. So a variable set only in `:root` keeps the app's dark value in dark, if the app has one. Either set it again in your dark rule, or put what is the same in both appearances in `:root[data-appearance]`, which ties with the app's rule and wins by coming later. The built-in themes do the second: a palette per appearance, then one mapping in `:root[data-appearance]`.
- A theme that is dark in both appearances sets everything in `:root[data-appearance]` and adds `color-scheme: dark` (see `Catppuccin Frappé.css`).
- The user's own options (accent colour, font sizes, text font, line width) are inline styles on `<html>`, so they win over the theme.

## What a theme has to set

`pnpm test:themes` checks every built-in theme: each colour the app writes out as a literal value must be set by the theme, in both appearances. Today those are:

`--bg`, `--bg-sidebar`, `--bg-hover`, `--bg-active`, `--border`, `--text`, `--text-muted`, `--accent`, `--accent-text`, `--error`, `--tooltip-bg`, `--syntax-code`, `--syntax-keyword`, `--syntax-string`, `--syntax-number`, `--syntax-type`, `--syntax-function`.

Everything else is derived from those (`var(--other)` or a `color-mix` of variables), so it follows the theme without being set. Set a derived variable only where the theme wants something different. The check also wants `--text` at a contrast of 6 and `--text-muted` of 4 on `--bg` and `--bg-sidebar`, both written as `#rrggbb`, and a licence notice in the comment at the top of the file.

## Variables

The full list, from the `:root` rule of `src/app.css`. "Default" is the light value; `→ x` means it defaults to `var(--x)`.

### Fonts and sizes

| Variable | Default | What it is |
|---|---|---|
| `--font-ui` | system sans | Font of the app's chrome. |
| `--font-text` | system sans | Font of note text. |
| `--font-mono` | system mono | Font of code and frontmatter. |
| `--font-size-ui` | `13px` | Size of chrome text. |
| `--font-size-text` | `16px` | Size of note text. |
| `--line-height-text` | `1.6` | Line height of note text. |
| `--line-width` | `46rem` | Widest the text column gets. |
| `--radius` | `6px` | Corner radius of buttons, rows and inputs. |
| `--radius-s` | `4px` | Radius of what sits inside a rounded box: menu items, keycaps. |
| `--radius-l` | `10px` | Radius of dialogs and menus. |
| `--ribbon-width` | `44px` | Width of the icon strip at the left edge. |
| `--sidebar-width` | `260px` | Width of the sidebar. The app sets it on `.app` when the edge is dragged. |
| `--header-height` | `40px` | Height of the sidebar's header and a pane's header. |
| `--status-height` | `24px` | Height of the status bar. |
| `--row-height` | `28px` | Height of a row of the file tree. |
| `--tab-height` | `36px` | Height of the strip of tabs over a pane. |
| `--tab-width` | `180px` | Width of a tab while there is room. Tabs shrink when there are many. |
| `--right-sidebar-width` | `260px` | Width of the right sidebar (the outline). The app sets it on `.app` when the edge is dragged. |
| `--transition` | `120ms ease-out` | Timing of hover and state changes. |

### Surfaces, text and accent

| Variable | Default | What it is |
|---|---|---|
| `--bg` | `#fcfbf9` | The surface notes are on. |
| `--bg-sidebar` | `#f4f2ee` | The sidebar, one layer under `--bg`. |
| `--bg-ribbon` | sidebar, darkened | The ribbon, the lowest layer. |
| `--bg-elevated` | `--bg`, lightened | Dialogs, menus, the palette. They also get a shadow. |
| `--bg-hover` | 6% dark veil | Laid over a surface under the pointer. See-through, so it works on every layer. |
| `--bg-active` | 10% dark veil | Laid over what is selected. |
| `--border` | `#e3e0da` | Lines between and around surfaces. |
| `--text` | `#26241f` | Main text. |
| `--text-muted` | `#6b6860` | Secondary text. Keep it at 4.5:1 on every surface. |
| `--text-faint` | muted mixed with `--bg` | Placeholders, disabled buttons, small marks. |
| `--accent` | `#b84a14` | The one accent: links, the caret, the main button, what is switched on. |
| `--accent-text` | `#ffffff` | Text on an accent background. |
| `--accent-soft` | 14% accent | A tint behind something that is on or being changed. |
| `--error` | `#c0262d` | Error text and destructive actions. |
| `--focus-ring` | 70% accent | Outline of what the keyboard has focused. |
| `--backdrop` | 30% dark veil | Dims the window behind a dialog. |
| `--shadow-popover` | soft shadow | Shadow under menus and tooltips. |
| `--shadow-dialog` | deep shadow | Shadow under dialogs. |
| `--tooltip-bg` | `→ text` | Tooltip surface. |
| `--tooltip-text` | `→ bg` | Tooltip text. |

### Tabs and panes

The strip of tabs is on the sidebar's layer and the tab that shows is on the note's, so the tab reads as part of its pane. A theme whose `--bg` and `--bg-sidebar` are the same colour should set `--tab-strip-bg` or `--tab-active-bg`, or the shown tab cannot be told from the others.

| Variable | Default | What it is |
|---|---|---|
| `--tab-strip-bg` | `→ bg-sidebar` | The strip behind the tabs. |
| `--tab-text` | `→ text-muted` | Name of a tab that does not show. |
| `--tab-active-bg` | `→ bg` | The tab that shows. |
| `--tab-active-text` | `→ text` | Its name. |
| `--tab-active-mark` | `→ accent` | The line over the shown tab of the active pane, when there is more than one pane. |
| `--pane-divider` | `→ border` | The line between two panes. |

### Markdown syntax (both editor modes)

| Variable | Default | What it is |
|---|---|---|
| `--syntax-heading` | `→ text` | Heading text. |
| `--syntax-link` | `→ accent` | Links and URLs. |
| `--syntax-code` | `#0f766e` | Inline code. |
| `--syntax-quote` | `→ text-muted` | Quoted text. |
| `--syntax-meta` | `→ text-muted` | Markdown marks: `#`, `**`, list marks. |
| `--syntax-keyword` | red, mixed with text | Keywords in fenced code. |
| `--syntax-string` | green, mixed with text | Strings in fenced code. |
| `--syntax-number` | orange, mixed with text | Numbers and constants in fenced code. |
| `--syntax-type` | cyan, mixed with text | Types and class names in fenced code. |
| `--syntax-function` | blue, mixed with text | Function names in fenced code. |
| `--syntax-property` | `→ text` | Property names in fenced code. |
| `--syntax-comment` | `→ text-muted` | Comments in fenced code. |
| `--syntax-punctuation` | `→ text-muted` | Brackets and operators in fenced code. |

### Editor

| Variable | Default | What it is |
|---|---|---|
| `--editor-padding` | `clamp(20px, 5vw, 48px)` | Space left and right of the text column. |
| `--selection-bg` | 28% accent | Selected text. Keep it translucent: the selection is drawn over the text. |
| `--caret-color` | `→ accent` | The text cursor. |
| `--scrollbar-thumb` | 35% muted | Scrollbar thumb. |
| `--scrollbar-thumb-hover` | 60% muted | Scrollbar thumb under the pointer. |

### Live Preview

| Variable | Default | What it is |
|---|---|---|
| `--heading-1-size`, `--heading-2-size`, `--heading-3-size`, `--heading-4-size`, `--heading-5-size`, `--heading-6-size` | `1.9em`, `1.5em`, `1.25em`, `1.1em`, `1em`, `0.9em` | Size of each heading level. |
| `--heading-line-height` | `1.25` | Line height of headings. |
| `--heading-weight` | `650` | Weight of headings 2 to 6. |
| `--heading-1-weight` | `750` | Weight of heading 1 and of the inline title. |
| `--heading-space` | `0.5em` | Space over a heading, in the heading's own em. |
| `--heading-6-text` | `→ text-muted` | Colour of heading 6. |
| `--inline-title-text` | `→ syntax-heading` | The note's name shown as a title over the note. |
| `--frontmatter-text` | `→ text-muted` | Frontmatter shown as YAML. |
| `--frontmatter-bg` | `→ bg-sidebar` | Background of frontmatter shown as YAML. |
| `--frontmatter-size` | `0.8em` | Size of frontmatter shown as YAML. |
| `--props-size` | `→ font-size-ui` | Size of the properties block. |
| `--props-key-text` | `→ text-muted` | Property keys. |
| `--props-pill-bg` | `→ bg-hover` | Background of a list value shown as a pill. |
| `--props-tag-bg` | 16% accent | Background of a tag pill. |
| `--props-tag-text` | `→ accent` | Text of a tag pill. |
| `--link-text` | `→ syntax-link` | Links to notes. |
| `--link-external-text` | `→ link-text` | Web links. |
| `--link-unresolved-text` | 55% link | Links to notes that do not exist. |
| `--code-bg` | `→ bg-sidebar` | Background of inline code and code blocks. |
| `--code-size` | `0.875em` | Size of code. |
| `--code-fence-text` | `→ text-muted` | The fence lines and the language label. |
| `--code-block-padding` | `16px` | Padding left and right inside a code block. |
| `--blockquote-bar` | `→ border` | The bar left of a quote. |
| `--blockquote-bar-width` | `3px` | Its width. |
| `--blockquote-indent` | `16px` | Space between bar and text. |
| `--blockquote-text` | `→ syntax-quote` | Quoted text. |
| `--rule-color` | `→ border` | Horizontal rules. |
| `--bullet-color` | `→ text-muted` | List bullets. |
| `--bullet-size` | `0.36em` | Diameter of a bullet. |
| `--list-indent` | `1.5em` | Indent of each list level. |
| `--list-marker-width` | `1.6em` | Width of the box that holds a bullet, number or checkbox. |
| `--list-number-text` | `→ text-muted` | Numbers of ordered lists. |
| `--checkbox-color` | `→ accent` | Fill of a ticked checkbox. |
| `--checkbox-size` | `1em` | Size of a checkbox. |
| `--checkbox-border` | `→ text-muted` | Outline of an empty checkbox. |
| `--checkbox-check` | `→ bg` | The tick. |
| `--task-done-text` | `→ text-muted` | Text of a done task. |
| `--image-max-height` | `60vh` | Tallest an image gets. |
| `--embed-border` | `→ border` | Outline of an embedded drawing. |
| `--embed-bg` | `→ bg` | Background of an embedded drawing. |

### Tables

| Variable | Default | What it is |
|---|---|---|
| `--table-border` | `→ border` | Cell borders. |
| `--table-header-bg` | `→ bg-sidebar` | Background of the header row. |
| `--table-row-hover` | half of `--bg-hover` | Row under the pointer. |
| `--table-cell-padding` | `6px 12px` | Padding of a cell. |
| `--table-size` | `0.9375em` | Text size in tables. |

### Graph view

The canvas reads these, and again when the theme changes.

| Variable | Default | What it is |
|---|---|---|
| `--graph-node` | `→ text-muted` | A note's dot. |
| `--graph-edge` | `→ border` | A link's line. |
| `--graph-open` | `→ accent` | The note that was open when the graph was opened. |
| `--graph-hover` | `→ accent` | The note under the pointer, and its lines. |
| `--graph-label` | `→ text` | Note names. |
| `--graph-label-size` | `11px` | Size of note names. |
| `--graph-label-halo` | `→ bg` | Outline around each name, so it reads over lines and dots. |
| `--graph-bg` | `→ bg` | The canvas. |
| `--graph-node-size` | `4px` | Radius of the dot of a note without links. Dots grow with the number of links. |

### Comparisons and the history margin

The comparison of two texts (`src/components/DiffView.tsx`, used by the History panel) and the margin of the `history` module.

| Variable | Default | What it is |
|---|---|---|
| `--diff-added-bg` | 16% `--syntax-string` | Background of a line that is only in the newer text. |
| `--diff-added-mark` | `→ syntax-string` | The `+` of such a line. |
| `--diff-removed-bg` | 13% `--error` | Background of a line that is only in the older text. |
| `--diff-removed-mark` | `→ error` | The `−` of such a line. |
| `--diff-fold-text` | `→ text-muted` | The row that stands for a run of unchanged lines. |
| `--diff-size` | `12px` | Text size in a comparison. |
| `--blame-width` | `11rem` | Width of the history margin. |
| `--blame-size` | `11px` | Text size in the margin. |
| `--blame-text` | `→ text-muted` | Author and date in the margin. |
| `--blame-uncommitted` | `→ accent` | The bar and the text beside lines that are not committed yet. |
| `--claim-passing` | `→ syntax-string` | The mark of a claim whose last check passed. |
| `--claim-failing` | `→ error` | The mark of a claim whose last check failed, and the reason a check did not run. |
| `--claim-stale` | `→ syntax-number` | The mark of a claim that passed too long ago or whose evidence file changed. |
| `--claim-unchecked` | `→ text-muted` | The mark of a claim that was never checked. |
| `--claim-dim` | `0.55` | Opacity of the text of a claim that is stale or was never checked. |
| `--review-list-width` | `300px` | Width of the list of notes in the review inbox. |
| `--badge-bg` | `→ accent` | The count on a ribbon button (the notes that wait for review). |
| `--badge-text` | `→ accent-text` | The number in it. |

### Search results and backlinks

| Variable | Default | What it is |
|---|---|---|
| `--hit-mark-bg` | 22% accent | Background of the matched text in a result. |
| `--hit-mark-text` | `→ text` | The matched text. |
| `--backlinks-max-height` | `min(150px, 20vh)` | How high the list of backlinks gets before it scrolls. |

## Class names

Where a variable cannot say it, a theme or snippet may add a rule against a class name. The class names in `src/app.css` are the interface; the comments there say what each is. The ones a theme most often needs:

| Class | On |
|---|---|
| `tok-heading`, `tok-strong`, `tok-emphasis`, `tok-strikethrough`, `tok-link`, `tok-url`, `tok-monospace`, `tok-quote`, `tok-meta`, `tok-punctuation` | Spans of Markdown syntax, in both editor modes (CodeMirror's class highlighter). |
| `is-live-preview`, `is-source` | The editor's root, by mode. |
| `md-heading`, `md-heading-1` … `md-heading-6` | A heading line in Live Preview. Source mode has no `md-*` classes. |
| `md-link`, `md-wikilink`, `md-external-link`, `is-unresolved` | A rendered link. `data-link` holds its target. |
| `md-inline-code`, `md-codeblock`, `md-codeblock-fence`, `md-codeblock-tools`, `md-codeblock-lang`, `md-codeblock-copy` | Code; the last three are the block's corner with the language and the Copy button. |
| `md-blockquote`, `md-hr` | Quote lines and rules. |
| `md-list-line`, `md-list-bullet`, `md-list-number`, `md-task`, `md-task-checkbox`, `md-task-done` | Lists and tasks. `--list-depth` is set on a list line. |
| `md-frontmatter`, `md-frontmatter-source`, `md-props`, `md-props-row`, `md-props-key`, `md-props-values`, `md-props-value`, `md-props-pill`, `md-props-tags` | Frontmatter as YAML (`md-frontmatter-source` while the cursor is in it) and as the properties block: the block, a key's row, the key, its values (`is-empty` when there are none), one value, one item of a list as a pill, the tags row. |
| `md-table-block`, `md-image`, `md-embed` | Tables, images and embedded drawings. |
| `app`, `ribbon`, `sidebar` (`is-right` for the right one), `status-bar`, `welcome`, `empty` | The shell, the screen with no vault open, and a pane with no note. |
| `workspace` (`is-split` with more than one pane), `pane-column`, `pane` (`is-active`), `pane-divider`, `pane-header` | The panes: columns side by side, each a stack of panes, with a line to drag between neighbours. |
| `tab-strip`, `tabs`, `tab` (`is-active`), `tab-title`, `tab-close` | A pane's tabs. `is-drop-before` and `is-drop-after` mark where a dragged tab would land. |
| `outline`, `outline-list`, `outline-item` (`is-current`), `outline-empty` | The outline in the right sidebar. `--outline-level` is set on an item. |
| `side-panel`, `history`, `history-list`, `history-item` (`is-selected`), `history-compare`, `history-empty` | A module's panel in the right sidebar, and the History panel in it: the versions, and the comparison with the picked one. |
| `diff`, `diff-line` (`is-same`, `is-add`, `is-remove`), `diff-sign`, `diff-text`, `diff-fold`, `diff-empty` | A comparison of two texts: one row per line, and the row for a folded run of unchanged lines. |
| `blame-gutter`, `blame-mark` (`is-uncommitted`) | The history margin beside a note's text, and its entry for one line. |
| `diff-pane`, `diff-pane-head`, `diff-pane-title`, `diff-pane-detail`, `diff-pane-counts`, `diff-count` (`is-add`, `is-remove`), `diff-pane-actions`, `diff-pane-body` | A comparison with a pane to itself: its header with what is compared, the counts of added and removed lines and the buttons, and the lines under it. |
| `history-where` | The switch at the top of the History panel: the comparison in the sidebar or in a pane. |
| `review`, `review-columns`, `review-list`, `review-list-head`, `review-count`, `review-item` (`is-selected`), `review-name`, `review-status` (`is-changed`, `is-added`, `is-deleted`), `review-folder`, `review-origin`, `review-empty` | The review inbox: the list of notes that wait, one item per note, and the message when there is nothing to show. |
| `ribbon-badge` | The count on a ribbon button. |
| `upkeep`, `upkeep-head`, `upkeep-count`, `upkeep-note`, `upkeep-folder`, `upkeep-row`, `upkeep-detail`, `upkeep-commit`, `upkeep-empty`, `task` | The health and tasks panels in the right sidebar: a heading with a count per kind of row (health only), a note's name with its folder, the rows under it (a broken link, a task's text), the lines under a stale note with its newest commit, and the message when there is nothing to list. `task` is a task's row; its checkbox is a `md-task-checkbox`. |
| `claim-mark` (`is-passing`, `is-failing`, `is-stale`, `is-unchecked`, `is-checking`), `claim-dim` | In a note: the mark in place of a claim's `<!-- check: … -->` marker, which has a shape per status and blinks while its check runs, and the text of a claim that is stale or was never checked. |
| `claim-popover`, `claim-popover-head`, `claim-popover-status`, `claim-status` (`is-passing`, `is-failing`, `is-stale`, `is-unchecked`), `claim-meta`, `claim-evidence`, `claim-output`, `claim-notice`, `claim-check` | The popover of a claim, opened from its mark: the status as a mark and a word, the kind and the day of the last check, the evidence, the end of what the last check printed, why a check did not run, and the Check button. |
| `claims`, `claims-bar`, `claims-fold`, `claim`, `claim-body`, `claim-link` | The claims panel in the right sidebar, which also uses the `upkeep` classes: the bar with "Check all", the heading that opens the passing claims, a claim's row, its text with note and evidence, and the link to Settings in a notice. |
| `tree`, `tree-item`, `tree-folder`, `tree-file`, `tree-drawing` (`is-drop-target`), `tree-ghost` | The file tree, and the name that follows the pointer while a row is dragged. |
| `palette`, `menu`, `menu-item`, `settings`, `button` (`is-quiet`, `is-danger`), `icon-button` | Dialogs, menus and buttons. |
| `graph`, `backlinks`, `hits`, `hit` | Graph view, backlinks, search results. |
| `drawing`, `slideshow-start`, `slideshow-canvas`, `slideshow-bar`, `slideshow-notes`, `slideshow-build` | A drawing, its Present buttons, and while presenting: the canvas over the window, the toolbar, the notes panel, the picture a build moves. |
| `presenter`, `presenter-head`, `presenter-slides`, `presenter-now`, `presenter-next`, `presenter-picture`, `presenter-notes`, `presenter-foot`, `presenter-idle` | The presenter window of a slideshow. It gets the theme's and the snippets' CSS, so rules against these work there. |

Rules in a theme need at least the weight of the app's rule they replace: `.editor .md-heading-3 { … }` replaces `.editor .md-heading { … }`, where `.md-heading-3 { … }` alone would lose to it.

## Porting an Obsidian theme

Porting is mapping the theme's palette and type choices onto the variables above. Inklode's DOM is not Obsidian's, so none of the theme's selectors do anything here: take values, not rules.

1. Read the theme's licence. If it allows reuse (MIT does, with the notice kept), start the file with a comment that has the copyright line, the licence name, the source URL and the words "port to Inklode", and add the full licence text to `THIRD-PARTY-NOTICES.md`. `pnpm test:themes` checks the comment.
2. Find the theme's palette for `.theme-light` and `.theme-dark`. Write it as private variables with a prefix of your own (`--ctp-*`, `--min-*`), light in `:root`, dark in `:root[data-appearance="dark"]`. Work out formulas (`hsl(calc(...))`) to plain values for the base colours, so the contrast check can read them.
3. Find what the theme sets each Obsidian variable to, and write the mapping once, in `:root[data-appearance]`, using the table below. Where the theme leaves an Obsidian variable alone, Obsidian's default applies; most of those match Inklode's derived defaults, so leave them out.
4. Add rules against class names only for a trait the theme is known for and no variable covers (Catppuccin's coloured bold and italic, Minimal's heading weights and small caps).
5. Run `pnpm test:themes`, then look at it in the app in both appearances: a note with every kind of block, the sidebar, the palette, Settings, the graph. The usual failures are surfaces layered the wrong way round and faint text that cannot be read. Where the original is too faint to read, prefer `--text-faint` or `--text-muted` and say so in a comment.

The mapping used for Catppuccin and Minimal:

| Obsidian | Inklode |
|---|---|
| `--background-primary` | `--bg` |
| `--background-secondary` | `--bg-sidebar` |
| `--ribbon-background`, `--titlebar-background`, `--background-secondary-alt` | `--bg-ribbon` |
| `--modal-background` | `--bg-elevated` |
| `--background-modifier-hover`, `--nav-item-background-hover` | `--bg-hover` |
| `--nav-item-background-active`, `--background-modifier-active-hover` | `--bg-active` |
| `--background-modifier-border`, `--divider-color` | `--border` |
| `--text-normal` | `--text` |
| `--text-muted` | `--text-muted` |
| `--text-faint` | `--text-faint` (derived; often too faint to copy) |
| `--interactive-accent`, `--text-accent`, `--color-accent` | `--accent` |
| `--text-on-accent` | `--accent-text` |
| `--text-error` | `--error` |
| `--text-selection` | `--selection-bg` |
| `--text-highlight-bg` | `--hit-mark-bg` |
| `--h1-color` … `--h6-color` | `--syntax-heading` (one colour for all levels), `--heading-6-text` |
| `--inline-title-color` | `--inline-title-text` |
| `--h1-size` … `--h6-size` | `--heading-1-size` … `--heading-6-size` |
| `--h1-weight`, `--h2-weight` … | `--heading-1-weight`, `--heading-weight`; a rule on `.editor .md-heading-N` and `.md-heading-N .tok-heading` for levels that differ |
| `--link-color`, `--link-external-color` | `--syntax-link` (then `--link-text`, `--link-external-text` follow) |
| `--code-normal` | `--syntax-code` |
| `--code-background` | `--code-bg` |
| `--code-keyword`, `--code-string`, `--code-value`, `--code-function`, `--code-property`, `--code-comment`, `--code-punctuation` | `--syntax-keyword`, `--syntax-string`, `--syntax-number`, `--syntax-function` and `--syntax-type`, `--syntax-property`, `--syntax-comment`, `--syntax-punctuation` |
| `--blockquote-color` | `--syntax-quote` (then `--blockquote-text` follows) |
| `--blockquote-border-color`, `--blockquote-border-thickness` | `--blockquote-bar`, `--blockquote-bar-width` |
| `--hr-color` | `--rule-color` |
| `--list-marker-color` | `--bullet-color`, `--list-number-text` |
| `--checkbox-color` | `--checkbox-color` |
| `--checklist-done-color` | `--task-done-text` |
| `--tag-color`, `--tag-background` | `--props-tag-text`, `--props-tag-bg` |
| `--table-border-color`, `--table-header-background` | `--table-border`, `--table-header-bg` |
| `--graph-node`, `--graph-line`, `--graph-node-focused`, `--graph-text` | `--graph-node`, `--graph-edge`, `--graph-open`, `--graph-label` |
| `--file-line-width` (Minimal: `--line-width`) | `--line-width` |
| `--line-height-normal` | `--line-height-text` |
| `--font-text-theme`, `--font-interface-theme`, `--font-monospace-theme` | `--font-text`, `--font-ui`, `--font-mono` |
| `--font-text-size`, `--font-ui-small` | `--font-size-text`, `--font-size-ui` |
| `--radius-s`, `--radius-m`, `--radius-l` | `--radius-s`, `--radius`, `--radius-l` |
| `--bold-color`, `--italic-color` | none: a rule on `.tok-strong`, `.tok-emphasis` |
| Formatting marks (`--text-faint` on `.cm-formatting`) | `--syntax-meta` |

No Inklode counterpart, so skipped: per-level heading colours, callouts, translucency, the theme's own fonts shipped as files, Style Settings options.
