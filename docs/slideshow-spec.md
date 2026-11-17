# Slideshow: data format and behaviour

This document says what Inklode reads from a drawing to present it as slides, and what a viewer sees while it is
presented. It is the only source for the implementation of the parts listed under [Public surface](#public-surface).

Terms used below:

- **Drawing**: the scene of one `.excalidraw.md` file, a list of elements. An element with `isDeleted: true` does not exist for anything in this document.
- **Frame**: an element with `type: "frame"`.
- **Slide**: a frame that is presented.
- **Record**: the value of `customData.slideshow` on a frame.
- **Step** (also "build step" or "build"): one entry of a record's `animation.steps`. It shows or hides some elements of the slide.
- **Entrance**: a step whose effect is `appear`, `fade`, `slide` or `zoom`. **Exit**: a step whose effect is `disappear`, `fade-out`, `slide-out` or `zoom-out`.

## The slideshow record

A frame may carry a record at `customData.slideshow`. A frame without `customData`, or without that key, has no record.

| Field | Type | Required | Meaning | Missing | Malformed |
| --- | --- | --- | --- | --- | --- |
| `schemaVersion` | number | yes | Must be exactly `2`. | record invalid | any other value: record invalid |
| `kind` | string | yes | Must be exactly `"frame"`. | record invalid | any other value: record invalid |
| `order` | number | yes | The slide's place in the deck. An integer, 0 or more. | record invalid | negative, not an integer, or not a number (a numeric string too): record invalid |
| `excluded` | boolean | no | `true`: the frame is left out of the slideshow. | `false` | not a boolean (`null` too): record invalid |
| `notes` | string | no | Presenter notes, Markdown. | no notes | not a string: record invalid. Only white space: same as missing |
| `deckName` | string | no | The name of the deck. | no name | not a string: record invalid. Only white space: same as missing |
| `animation` | object | no | Holds `steps`, an array of steps (may be empty). | no steps | not an object, `steps` not an array, or any step invalid: record invalid |

Rules:

- A record must be a JSON object. A string, number, array or `null` there counts as no record.
- Validity is all or nothing. One invalid field, or one invalid step, makes the whole record invalid.
- **An invalid record counts as no record.** The frame then has no order, is not excluded (even if the record says `excluded: true`), has no notes, no deck name and no steps. The app shows no error for it: the frame is presented as a plain slide, sorted with the frames that have no record. The record is left in the file as it is.
- Fields that are not in the table are ignored when reading and kept when writing.

### A step

| Field | Type | Required | Meaning | Missing | Malformed |
| --- | --- | --- | --- | --- | --- |
| `id` | string | yes | The step's name. Not empty. Inklode does not require it to be unique. | step invalid | empty or not a string: step invalid |
| `targets` | array | yes | What the step acts on. At least one target. | step invalid | not an array, empty, or any target invalid: step invalid |
| `effect` | string | yes | One of `appear`, `fade`, `slide`, `zoom`, `disappear`, `fade-out`, `slide-out`, `zoom-out`. | step invalid | any other value: step invalid |
| `trigger` | string | yes | `advance`: the step runs when the presenter moves forward. `after-delay`: it runs by itself. | step invalid | any other value: step invalid |
| `delayMs` | number | no | For `after-delay`: how long the step waits, in milliseconds. Finite, 0 or more. | 1000 | negative, not finite or not a number: step invalid |
| `durationMs` | number | no | How long the effect plays, in milliseconds. Finite, 0 or more. Not used by `appear` and `disappear`. | 350 | negative, not finite or not a number: step invalid |
| `direction` | string | no | For `slide` and `slide-out`: one of `left`, `right`, `up`, `down`. Allowed, and without effect, on other effects. | `left` | any other value (`null` too): step invalid, whatever the effect |

A step that is not a JSON object is invalid. Fields not in the table are ignored.

The two defaults are part of the format: files written by the Obsidian plugin leave `delayMs` and `durationMs` out
when the author kept the defaults, and the deck must play the same here.

### A target

| Field | Type | Required | Meaning | Missing | Malformed |
| --- | --- | --- | --- | --- | --- |
| `type` | string | yes | `element`: `id` is an element's id. `group`: `id` is a group id, as found in elements' `groupIds`. | target invalid | any other value: target invalid |
| `id` | string | yes | Not empty. | target invalid | empty or not a string: target invalid |
| `scope` | string | no | `viewport`: see [Viewport scope](#viewport-scope). | frame scope | any other value is ignored, the target is still valid and has frame scope |

A target that is not a JSON object is invalid. Fields not in the table are ignored.

### The normal form

Reading a valid record gives it back in a normal form: only the fields in the tables above; `notes` and `deckName`
left out when they are blank; `excluded` kept as written when present (also `false`); `delayMs`, `durationMs` and
`direction` present only when the file has them (defaults are applied when the step plays, not when it is read);
`scope` present on a target only when it is `"viewport"`.

## The deck

### Titles

A slide's title is the frame's `name` when that is a string, also an empty one. Otherwise it is `Frame NN`, where
`NN` is the frame's position, counted from 1, among the drawing's frames in the order of the element list, written
with at least two digits (`Frame 03`, `Frame 12`, `Frame 104`).

### Order

- Frames with a valid record come first, by `order`, lowest first. Two frames with the same `order` keep the order they have in the element list.
- Frames without a valid record come after them, by title. Titles are compared as plain strings, code unit by code unit, not by language rules: `"10 Late"` comes before `"2 Middle"`, and `"Zebra"` before `"appendix"`. Two frames with the same title keep the order they have in the element list.
- When no frame has a valid record, the second rule alone orders the deck. This is why a deck can be ordered by naming its frames `01 ...`, `02 ...`.

The deck is every frame in that order, excluded ones too. The slides of a slideshow are the deck without the frames
whose valid record has `excluded: true`.

### Deck name

The deck's name is the `deckName` of the first frame, in the order of the element list (not of the deck), that has a
valid record with a non-blank `deckName`. A deck where no frame has one has no name.

Inklode uses the name in one place: when presenter notes are saved, every frame record that the save writes with an
`order` (a new record, or a valid one that is renumbered) and that has no non-blank `deckName` of its own gets the
deck's name. A deck without a name leaves the records as they are.

### Nothing to present

A slideshow does not start when the deck has no slides. The app tells the user which case it is: the drawing has no
frame at all (each slide needs a frame), or every frame is excluded. The wording is the implementer's.

## Writing records

Inklode writes records in one case: when the presenter notes of a frame are saved. The Obsidian plugin reads what is
written, so the rules below are facts of the file format.

Saving the notes of one frame (the target) writes these records and no others:

| Frame | What is written |
| --- | --- |
| Has no record (`customData.slideshow` is missing or `null`) | A new record with exactly `schemaVersion: 2`, `kind: "frame"` and `order`. |
| Has a valid record | The stored record with `order` set. Every other field stays as stored. |
| Has an invalid record, and is not the target | Nothing. The frame is left exactly as it is. |
| Is the target, and its stored value is a JSON object that is an invalid record | The stored object with only `notes` set or removed. No `order` is written and nothing else changes. |
| Is the target, and its stored value is not a JSON object (a string, a number, an array) | A new record, as in the first row, replaces it. |

- `order` is the frame's position in [the deck](#the-deck) as it is before the save, counted from 0, over all frames, excluded ones too. The slides therefore keep the order they had, and from then on that order is stored: renaming a frame no longer moves its slide.
- The target's record gets `notes` with the text as given. Notes that are blank (only white space) remove `notes` instead; the record stays.
- [The deck's name](#deck-name) is added to the records in the first two rows that have none.
- A stored record is changed in place, not written again from its normal form: fields Inklode does not know stay, in the record, in a step and in a target, and so do fields the normal form leaves out (blank `notes` on another frame, for one). Fields keep the position they have in the stored object; a field that is added goes after them. A new record has its fields in the order `schemaVersion`, `kind`, `order`, then `deckName` and `notes` when it has them.
- The other keys of the frame's `customData` stay.
- Nothing at all is written when the notes do not change: the new text equals the stored `notes`, or both are blank or missing. The stored `notes` are compared also when the record is invalid.
- Saving notes for a frame that is not in the drawing is an error.

## Build steps of a slide

When a slide is entered, its steps are matched against the drawing as it is at that moment. Nothing about the
matching is stored.

### Which elements are on a slide

A frame does not own what is drawn on it. An element is on a slide when its bounding box touches the frame's
rectangle. `frameId` plays no part.

- The frame's rectangle is its `x`, `y`, `width`, `height`.
- An element's bounding box is the rectangle given by its `x`, `y`, `width`, `height` (a negative `width` or `height` spans the same area from the other side), turned by its `angle` (radians) about the rectangle's centre, and then the smallest upright rectangle around the turned one. An element without `angle` is not turned.
- "Touches" includes sharing only an edge or a corner. A gap of any size does not touch.
- The slide's own frame is never on the slide: a step cannot target it.

### Visual units

A text bound to a shape and the shape are one unit: a step that acts on either acts on both.

- A text element with a `containerId` belongs with the element of that id, when that element exists.
- An element belongs with every element listed in its `boundElements` that exists and is a text element. Arrows and other non-text entries of `boundElements` do not join the unit.
- Units are closed under both rules: an arrow and its label are a unit, a box and its text are a unit.

### What a target selects

- An `element` target selects the element with that id together with its unit, when at least one member of the unit is on the slide. It selects nothing when the element does not exist, or when no member of the unit is on the slide.
- A `group` target selects every element that has the id in its `groupIds` now and is itself on the slide, each together with its unit. Members that are not on the slide are left out; the others still count.

A step acts on everything its targets select. An element selected twice by one step counts once. The order of the
elements within a step has no meaning.

### Viewport scope

A target with `scope: "viewport"` uses a wider area in place of the frame's rectangle in the rules above, so it can
select elements that sit beside the frame but are on screen with it. The area is built from:

1. What a screen of 1920 by 1080 pixels shows of the drawing when the slide is centred on it and as large as fits. This is the reference screen of the format: a deck's author sees which off-frame elements count on such a screen.
2. What the window presenting the slide shows of the drawing, fitted the same way, when its size is known.
3. The smallest rectangle around both, grown on the left and on the right by a tenth of its width, and at the top and the bottom by a tenth of its height.

The numbers decide whether an element belongs to a step, so they are part of the format: a different reference
screen or margin would make a deck's off-frame targets appear in one app and not in the other.

When the window's size is not known (a picture of a slide that is not on screen), rule 1 alone gives the rectangle
that rule 3 grows.

Optional, and it only matters for very small frames: "as large as fits" may be limited to a zoom of 30, the limit
`fitSlide` has, so that a screen shows more around a frame that would need a larger zoom to fill it. On the reference
screen that is a frame under 64 wide and under 36 high. An implementation without the limit is acceptable.

### Steps without elements

A step that selects no element is dropped when the slide is entered: it is not a step of that slide. Forward does not
stop on it, and the count of builds shown to the presenter does not include it. The other steps keep their order.

## Hidden elements

At every moment a slide has a number of steps that have run, from 0 to all of them. Which elements are hidden follows
from that number alone:

- An element that no step acts on is always shown.
- With no step run, an element is hidden when the first step that acts on it is an entrance, and shown when that step is an exit.
- With some steps run, look at the last of them that acts on the element: after an entrance it is shown, after an exit it is hidden. When none of the steps that have run acts on it, the previous rule holds.

A hidden element is not visible at all. It is still part of the drawing, and it keeps its own opacity for when it is
shown again.

## Moving through a slideshow

- **Forward** runs the slide's next step. When all steps have run it goes to the next slide, entered with no step run. After the last slide's last step it ends the slideshow.
- **Backward** undoes the step that ran last. With no step run it goes to the previous slide, entered with all its steps run. On the first slide with no step run it ends the slideshow.
- **Go to a slide** (the picker, Home, End, `slideshow.goto`) enters that slide with no step run, also when it is the slide already on screen.

If Forward or Backward runs or undoes a step while the canvas is still travelling to the slide, the canvas is put on
the slide first, at once.

### Travelling to a slide

A slide on screen is centred in the window and as large as fits, with no margin (`fitSlide` gives the zoom and the
scroll). Going to a slide, the view travels there smoothly from where it is, position and zoom changing together, so
the viewer sees where the next slide lies in the drawing. How long it takes and how it eases are the implementer's:
no number here is needed for compatibility.

- The slide counts as the current one from the moment the travel starts: the picker, the presenter window and `ui_state` name it at once.
- If the window changes size on the way (it goes fullscreen as the slideshow starts), the travel still ends with the slide fitted to the window as it is then. A window that changes size while a slide is at rest gets the slide fitted again at once.
- A new travel replaces one that is under way. The one replaced never counts as arrived.
- The travel must arrive also in a window that is covered or not being drawn.
- Where this document says "at once", there is no travel: the canvas is on the slide.

### The toolbar

The slideshow's toolbar (previous, slide picker, next, fullscreen, end) gets out of the way while presenting, so it
does not sit over the slides, and is there when the presenter reaches for it: under the pointer, with keyboard focus
inside it, or with its picker open. How it does that, and when, is the implementer's.

## Effects

Each effect has a forward form and an undone form. Undoing an entrance hides its elements, undoing an exit shows them.
All elements of a step move together, as one picture, not one by one.

| Effect | Forward | Undone |
| --- | --- | --- |
| `appear` | The elements are shown at once. | They are hidden at once. |
| `disappear` | The elements are hidden at once. | They are shown at once. |
| `fade` | The elements go from invisible to their own opacity, evenly over the duration. | They go from their own opacity to invisible, evenly over the duration. |
| `fade-out` | From their own opacity to invisible, evenly over the duration. | From invisible to their own opacity, evenly over the duration. |
| `slide` | The elements travel in a straight line from a place off to the `direction` side into their place, fully visible all the way. | They travel from their place out to that side, and are hidden. |
| `slide-out` | The elements travel from their place out to the `direction` side, fully visible, and are hidden. | They travel back in from that side. |
| `zoom` | The elements grow from very small to full size about the centre of the box around all of them, fully visible. | They shrink to very small about that centre while fading out, and are hidden. |
| `zoom-out` | They shrink to very small about that centre while fading out, and are hidden. | They grow from very small to full size, fully visible. |

- `direction` names the side the off-place is on: `left` is to the left of the elements' place, `right` to the right, `up` above, `down` below. A `slide` from `left` therefore moves rightward; a `slide-out` to `left` moves leftward.
- The off-place is far enough that the elements start clear of where they rest: at least their own size on screen along the direction of travel. The exact distance is the implementer's.
- "Very small" is a few hundredths of full size. The exact value is the implementer's.
- Slide and zoom ease in and out; fades are even. The curve is the implementer's.
- A duration of 0 makes any effect instant.
- When a slide or zoom entrance ends, the elements are in place with no visible gap or flicker between the moving picture and the elements themselves. How long the picture is kept for that is a short moment of the implementer's choosing.
- When any effect has ended, the slide looks exactly as [Hidden elements](#hidden-elements) says for the new number of steps run.
- An effect must reach its end state on time also in a window that is covered or not being drawn.
- Whatever is put over the canvas to show moving elements has the CSS class `slideshow-build` (documented for themes in `docs/themes.md`, styled in `src/app.css`).

## Timed steps

A step with `trigger: "after-delay"` runs by itself, as if Forward were pressed, after waiting `delayMs` (1000 when
missing). The wait starts:

- when the canvas has arrived at a slide, if the slide's next step is a timed one;
- when a step that ran forward (by the presenter or by itself) has finished its effect, if the next step is a timed one.

It does not start after a step is undone: the presenter then has to move forward.

- Forward during the wait runs the step at once.
- Backward, going to a slide, or ending the slideshow during the wait cancels it.
- A slide entered backward has all its steps run, so nothing waits.

## Interrupting and leaving

- A command that arrives while an effect is playing (Forward, Backward, go to a slide, end) first finishes that effect at once: its elements are shown or hidden as the effect would have left them, and nothing is left moving. Then the command acts.
- Leaving a slide, and ending the slideshow, shows every element of the slide again with its own opacity, removes anything that was moving, and cancels a wait.

## Presenting never changes the file

A slideshow is read-only. Hiding, fading and moving elements must not count as an edit: the drawing is not reported
as changed (`ui_state.drawing.dirty` stays as it was), no element gets a new `version`, and no file is ever written
with an opacity that a step set. This holds also when the tab is closed or the app reloads in the middle of an effect.

## Keys

While a slideshow runs, in the drawing's window:

| Key | Does |
| --- | --- |
| Right arrow, Down arrow, Space, Page Down | Forward |
| Left arrow, Up arrow, Page Up | Backward |
| Home | Goes to the slide on screen: the canvas is centred on it again and its steps start over |
| End | Goes to the last slide |
| Escape, Backspace | Ends the slideshow |
| F (either case) | Fullscreen on or off |

- A key held down acts once, not once per repeat.
- With Cmd, Ctrl or Alt held, none of these keys does anything in the slideshow.
- No key press reaches the canvas while presenting, whether it is in the table or not, so Delete cannot remove anything.
- A key in the table does not also do what the browser would do with it (scroll, go back).
- Keys typed into the command palette, a prompt or a menu opened over the slides (inside `.palette-backdrop` or `.menu`) are theirs: the slideshow leaves them alone.

Page Down and Page Up are there because presentation remotes send them.

The presenter window has the same keys, except F, with the same rules for a held key and for Cmd, Ctrl and Alt. It
does not act itself: it asks the drawing's window over the channel, with the messages `FromPresenter` already has
(`step` with `by` 1 or -1, `goto` with `index` `"current"` for Home and `"last"` for End, `exit`).

## Presenter pictures

The presenter window shows a picture of the slide on screen and a picture of what Forward leads to. A picture of a
slide with some number of its steps run shows the frame's rectangle with the elements that are on the slide (frame
scope), without the elements that are hidden at that number of steps. For a slide that is not on screen its steps are
matched as in [Viewport scope](#viewport-scope) without a window size.

## Examples

Examples 5 to 11 use this frame, and give elements as `x`, `y`, `width`, `height`:

```json
{ "id": "F", "type": "frame", "name": "Slide", "x": 0, "y": 0, "width": 1280, "height": 720 }
```

Steps are written short: every step also has `"trigger": "advance"` unless shown. Element ids in results are sorted
for reading; their order has no meaning.

### 1. Order and titles without records

```json
[
  { "id": "f1", "type": "frame", "name": "2 Middle" },
  { "id": "f2", "type": "frame", "name": "10 Late" },
  { "id": "t1", "type": "text" },
  { "id": "f3", "type": "frame", "name": null },
  { "id": "f4", "type": "frame", "name": "1 Start" },
  { "id": "f5", "type": "frame", "name": "appendix" },
  { "id": "f6", "type": "frame", "name": "Zebra", "isDeleted": true },
  { "id": "f7", "type": "frame", "name": "Zebra" },
  { "id": "f8", "type": "frame" },
  { "id": "f9", "type": "frame", "name": "" }
]
```

Deck, as frame id and title:

| # | Frame | Title |
| --- | --- | --- |
| 1 | `f9` | (empty) |
| 2 | `f4` | `1 Start` |
| 3 | `f2` | `10 Late` |
| 4 | `f1` | `2 Middle` |
| 5 | `f3` | `Frame 03` |
| 6 | `f8` | `Frame 07` |
| 7 | `f7` | `Zebra` |
| 8 | `f5` | `appendix` |

`f6` is deleted and is not counted: `f8` is the seventh frame.

### 2. Order with records

```json
[
  { "id": "a", "type": "frame", "name": "Alpha", "customData": { "slideshow": { "schemaVersion": 2, "kind": "frame", "order": 2 } } },
  { "id": "b", "type": "frame", "name": "Beta" },
  { "id": "c", "type": "frame", "name": "Gamma", "customData": { "slideshow": { "schemaVersion": 2, "kind": "frame", "order": 0, "excluded": true } } },
  { "id": "d", "type": "frame", "name": "Delta", "customData": { "slideshow": { "schemaVersion": 2, "kind": "frame", "order": 2 } } },
  { "id": "e", "type": "frame", "name": "Aardvark" },
  { "id": "f", "type": "frame", "name": "Omega", "customData": { "slideshow": { "schemaVersion": 2, "kind": "frame", "order": 1 } } }
]
```

- Deck: Gamma, Omega, Alpha, Delta, Aardvark, Beta.
- Slides: Omega, Alpha, Delta, Aardvark, Beta.

### 3. Invalid records count as none

```json
[
  { "id": "a", "type": "frame", "name": "B ordered",
    "customData": { "slideshow": { "schemaVersion": 2, "kind": "frame", "order": 5, "notes": "Hello" } } },
  { "id": "b", "type": "frame", "name": "C no order",
    "customData": { "slideshow": { "schemaVersion": 2, "kind": "frame", "excluded": true, "notes": "n" } } },
  { "id": "c", "type": "frame", "name": "A bad step",
    "customData": { "slideshow": { "schemaVersion": 2, "kind": "frame", "order": 0, "excluded": true, "notes": "n",
      "animation": { "steps": [
        { "id": "s1", "targets": [{ "type": "element", "id": "x" }], "effect": "fade", "trigger": "advance" },
        { "id": "s2", "targets": [{ "type": "element", "id": "x" }], "effect": "spin", "trigger": "advance" }
      ] } } } },
  { "id": "d", "type": "frame", "name": "D version",
    "customData": { "slideshow": { "schemaVersion": 3, "kind": "frame", "order": 1 } } },
  { "id": "e", "type": "frame", "name": "E float",
    "customData": { "slideshow": { "schemaVersion": 2, "kind": "frame", "order": 1.5 } } },
  { "id": "g", "type": "frame", "name": "F string", "customData": { "slideshow": "yes" } }
]
```

Slides, in order: `B ordered`, `A bad step`, `C no order`, `D version`, `E float`, `F string`. Only `B ordered` has
a record (`order` 5, notes `Hello`). The other five have none: `A bad step` and `C no order` are presented although
they say `excluded: true`, they have no notes, and `A bad step` has no steps, not even its valid one.

### 4. Reading a record

```json
{
  "schemaVersion": 2, "kind": "frame", "order": 3, "excluded": false, "notes": "  \n", "deckName": "Talk", "theme": "dark",
  "animation": {
    "loop": true,
    "steps": [
      { "id": "s1", "effect": "slide", "trigger": "after-delay", "delayMs": 0, "durationMs": 500, "direction": "up", "easing": "bounce",
        "targets": [{ "type": "element", "id": "a", "scope": "frame", "pinned": true }, { "type": "group", "id": "g", "scope": "viewport" }] },
      { "id": "s2", "effect": "zoom-out", "trigger": "advance", "targets": [{ "type": "element", "id": "a" }] }
    ]
  }
}
```

It is valid. Its normal form:

```json
{
  "schemaVersion": 2, "kind": "frame", "order": 3, "excluded": false, "deckName": "Talk",
  "animation": {
    "steps": [
      { "id": "s1", "targets": [{ "type": "element", "id": "a" }, { "type": "group", "id": "g", "scope": "viewport" }],
        "effect": "slide", "trigger": "after-delay", "delayMs": 0, "durationMs": 500, "direction": "up" },
      { "id": "s2", "targets": [{ "type": "element", "id": "a" }], "effect": "zoom-out", "trigger": "advance" }
    ]
  }
}
```

This record is valid too, and keeps its empty `steps`:

```json
{ "schemaVersion": 2, "kind": "frame", "order": 0, "animation": { "steps": [] } }
```

Each element of this array is an invalid record (a frame that carries it has no record):

```json
[
  { "schemaVersion": 2, "kind": "frame", "order": -1 },
  { "schemaVersion": 2, "kind": "frame", "order": "0" },
  { "schemaVersion": 2, "kind": "path", "order": 0 },
  { "schemaVersion": 2, "kind": "frame", "order": 0, "excluded": null },
  { "schemaVersion": 2, "kind": "frame", "order": 0, "notes": 5 },
  { "schemaVersion": 2, "kind": "frame", "order": 0, "animation": null },
  { "schemaVersion": 2, "kind": "frame", "order": 0, "animation": {} },
  { "schemaVersion": 2, "kind": "frame", "order": 0, "animation": [] },
  []
]
```

Each element of this array is an invalid step. A record whose `animation.steps` holds it, alone or next to valid
steps, is invalid as a whole:

```json
[
  { "id": "",   "targets": [{ "type": "element", "id": "x" }], "effect": "fade", "trigger": "advance" },
  { "id": "s1", "targets": [], "effect": "fade", "trigger": "advance" },
  { "id": "s1", "targets": [{ "type": "frame", "id": "x" }], "effect": "fade", "trigger": "advance" },
  { "id": "s1", "targets": [{ "type": "element" }], "effect": "fade", "trigger": "advance" },
  { "id": "s1", "targets": [{ "type": "element", "id": "x" }], "effect": "spin", "trigger": "advance" },
  { "id": "s1", "targets": [{ "type": "element", "id": "x" }], "effect": "fade", "trigger": "click" },
  { "id": "s1", "targets": [{ "type": "element", "id": "x" }], "effect": "fade", "trigger": "advance", "delayMs": -1 },
  { "id": "s1", "targets": [{ "type": "element", "id": "x" }], "effect": "fade", "trigger": "advance", "durationMs": "350" },
  { "id": "s1", "targets": [{ "type": "element", "id": "x" }], "effect": "fade", "trigger": "advance", "direction": "north" },
  { "id": "s1", "targets": [{ "type": "element", "id": "x" }], "effect": "fade", "trigger": "advance", "direction": null },
  "step",
  null
]
```

### 5. A text and its shape are one

```json
[
  { "id": "box",    "type": "rectangle", "x": 100, "y": 100, "width": 200, "height": 100,
    "boundElements": [{ "type": "text", "id": "label" }, { "type": "arrow", "id": "arrow" }] },
  { "id": "label",  "type": "text",  "x": 150, "y": 130, "width": 100, "height": 25, "containerId": "box" },
  { "id": "arrow",  "type": "arrow", "x": 300, "y": 150, "width": 200, "height": 0,
    "boundElements": [{ "type": "text", "id": "alabel" }] },
  { "id": "alabel", "type": "text",  "x": 380, "y": 140, "width": 40, "height": 20, "containerId": "arrow" },
  { "id": "free",   "type": "text",  "x": 600, "y": 100, "width": 100, "height": 25 }
]
```

Steps:

```json
[
  { "id": "s1", "effect": "appear", "targets": [{ "type": "element", "id": "label" }] },
  { "id": "s2", "effect": "fade",   "targets": [{ "type": "element", "id": "arrow" }] }
]
```

| | Acts on | Hidden afterwards |
| --- | --- | --- |
| On entering | | `alabel`, `arrow`, `box`, `label` |
| `s1` | `box`, `label` | `alabel`, `arrow` |
| `s2` | `alabel`, `arrow` | nothing |

The text brings its box; the box does not bring the arrow bound to it; the arrow brings its label. `free` is always
shown. A single step that targets `box` acts on `box` and `label` in the same way.

### 6. Exits

Elements of example 5.

```json
[
  { "id": "s1", "effect": "fade-out",  "targets": [{ "type": "element", "id": "free" }] },
  { "id": "s2", "effect": "slide-out", "direction": "right", "targets": [{ "type": "element", "id": "box" }] }
]
```

| | Hidden afterwards | What is seen |
| --- | --- | --- |
| On entering | nothing | |
| `s1` | `free` | `free` fades away over 350 ms |
| `s2` | `box`, `free`, `label` | `box` and `label` travel together to the right over 350 ms and are gone |
| Backward | `free` | `box` and `label` travel back in from the right |
| Backward | nothing | `free` fades in |

### 7. An element in several steps

Elements of example 5.

```json
[
  { "id": "s1", "effect": "appear",    "targets": [{ "type": "element", "id": "box" }] },
  { "id": "s2", "effect": "fade",      "targets": [{ "type": "element", "id": "free" }] },
  { "id": "s3", "effect": "disappear", "targets": [{ "type": "element", "id": "box" }] },
  { "id": "s4", "effect": "zoom",      "targets": [{ "type": "element", "id": "box" }, { "type": "element", "id": "free" }] },
  { "id": "s5", "effect": "fade-out",  "targets": [{ "type": "element", "id": "free" }] }
]
```

| Steps run | Hidden |
| --- | --- |
| 0 | `box`, `free`, `label` |
| 1 | `free` |
| 2 | nothing |
| 3 | `box`, `label` |
| 4 | nothing |
| 5 | `free` |

At step `s4`, `free` is already shown and takes part in the zoom anyway: all three elements grow in together.

The first step decides the start: with the steps `disappear` on `free`, then `appear` on `free`, the element is
shown on entering, hidden after the first and shown after the second.

### 8. Groups, and targets that are gone

```json
[
  { "id": "box",   "type": "rectangle", "x": 100, "y": 100, "width": 200, "height": 100, "boundElements": [{ "type": "text", "id": "label" }] },
  { "id": "label", "type": "text",      "x": 150, "y": 130, "width": 100, "height": 25, "containerId": "box" },
  { "id": "g1",    "type": "ellipse",   "x": 200, "y": 400, "width": 50, "height": 50, "groupIds": ["grp", "outer"] },
  { "id": "g2",    "type": "ellipse",   "x": 300, "y": 400, "width": 50, "height": 50, "groupIds": ["grp"], "boundElements": [{ "type": "text", "id": "g2t" }] },
  { "id": "g2t",   "type": "text",      "x": 310, "y": 415, "width": 30, "height": 20, "containerId": "g2", "groupIds": ["grp"] },
  { "id": "g3",    "type": "ellipse",   "x": 2000, "y": 400, "width": 50, "height": 50, "groupIds": ["grp"] },
  { "id": "g4",    "type": "ellipse",   "x": 400, "y": 400, "width": 50, "height": 50, "groupIds": ["grp"], "isDeleted": true },
  { "id": "away",  "type": "rectangle", "x": 3000, "y": 0, "width": 50, "height": 50 }
]
```

Steps:

```json
[
  { "id": "s1", "effect": "fade",   "targets": [{ "type": "group", "id": "grp" }] },
  { "id": "s2", "effect": "appear", "targets": [{ "type": "element", "id": "away" }] },
  { "id": "s3", "effect": "zoom",   "targets": [{ "type": "group", "id": "nobody" }] },
  { "id": "s4", "effect": "appear", "targets": [{ "type": "element", "id": "gone" }, { "type": "element", "id": "box" }] },
  { "id": "s5", "effect": "appear", "targets": [{ "type": "element", "id": "F" }] },
  { "id": "s6", "effect": "appear", "targets": [{ "type": "element", "id": "g4" }] }
]
```

The slide has two steps, `s1` and `s4`:

| | Acts on | Hidden afterwards |
| --- | --- | --- |
| On entering | | `box`, `g1`, `g2`, `g2t`, `label` |
| `s1` | `g1`, `g2`, `g2t` | `box`, `label` |
| `s4` | `box`, `label` | nothing |

`g3` is in the group but not on the slide, `g4` is deleted. `s2` (off the slide), `s3` (no such group), `s5` (the
slide's own frame) and `s6` (deleted) select nothing and are dropped. Forward pressed twice builds the slide; the
third Forward leaves it.

### 9. Viewport scope

```json
[
  { "id": "near",   "type": "rectangle", "x": 1340, "y": 100,  "width": 50, "height": 50 },
  { "id": "far",    "type": "rectangle", "x": 1500, "y": 100,  "width": 50, "height": 50 },
  { "id": "above",  "type": "rectangle", "x": 100,  "y": -400, "width": 50, "height": 50 },
  { "id": "grazes", "type": "rectangle", "x": 1408, "y": 300,  "width": 50, "height": 50 }
]
```

Steps, all `appear`:

```json
[
  { "id": "s1", "effect": "appear", "targets": [{ "type": "element", "id": "near" }] },
  { "id": "s2", "effect": "appear", "targets": [{ "type": "element", "id": "near",   "scope": "viewport" }] },
  { "id": "s3", "effect": "appear", "targets": [{ "type": "element", "id": "far",    "scope": "viewport" }] },
  { "id": "s4", "effect": "appear", "targets": [{ "type": "element", "id": "above",  "scope": "viewport" }] },
  { "id": "s5", "effect": "appear", "targets": [{ "type": "element", "id": "grazes", "scope": "viewport" }] }
]
```

The frame has the shape of the reference screen, so that screen shows exactly the frame, and the grown rectangle
runs from x -128 to 1408 and from y -72 to 792.

| Window | Steps of the slide | Why |
| --- | --- | --- |
| not known | `s2`, `s5` | `near` is inside the grown rectangle; `grazes` touches its right edge at 1408 |
| 1920 by 1080 | `s2`, `s5` | the window shows what the reference screen shows |
| 1000 by 1000 | `s2`, `s4`, `s5` | the window shows y from -280 to 1000; grown, the rectangle runs from y -408 to 1128, which reaches `above` |
| 2560 by 1080 | `s2`, `s3`, `s5` | the window shows x from about -213 to 1493; grown, the rectangle runs to about x 1664, which reaches `far` |

`s1` is dropped in every case: without `scope`, `near` is 60 away from the frame.

### 10. Edges, turned elements, and a unit half on the slide

```json
[
  { "id": "edge",    "type": "rectangle", "x": 1280, "y": 720, "width": 40,  "height": 40 },
  { "id": "off",     "type": "rectangle", "x": 1281, "y": 100, "width": 40,  "height": 40 },
  { "id": "tall",    "type": "rectangle", "x": -30,  "y": 300, "width": 10,  "height": 100 },
  { "id": "turned",  "type": "rectangle", "x": -30,  "y": 300, "width": 10,  "height": 100, "angle": 1.5707963267948966 },
  { "id": "flipped", "type": "line",      "x": 1300, "y": 200, "width": -40, "height": 10 },
  { "id": "oc",      "type": "rectangle", "x": 1270, "y": 480, "width": 300, "height": 60, "boundElements": [{ "type": "text", "id": "ot" }] },
  { "id": "ot",      "type": "text",      "x": 1400, "y": 500, "width": 50,  "height": 20, "containerId": "oc" }
]
```

One `appear` step per element, each with one `element` target: `s1` `edge`, `s2` `off`, `s3` `tall`, `s4` `turned`,
`s5` `flipped`, `s6` `ot`.

The slide has four steps:

| Step | Acts on | Why |
| --- | --- | --- |
| `s1` | `edge` | it shares the frame's bottom right corner |
| `s4` | `turned` | turned a quarter, its box runs from x -75 to 25 and reaches the frame |
| `s5` | `flipped` | with its negative width it spans x 1260 to 1300 |
| `s6` | `oc`, `ot` | the text is off the slide, but its box is on it, and they are one unit |

`s2` is dropped (`off` is 1 away from the frame) and so is `s3` (`tall` ends at x -20).

### 11. Timed steps

This example was derived by reading, not by running anything. The order of events and what starts or cancels a wait
are the rule. The times follow from the defaults and from this document's choice that an effect lasts exactly its
duration; where the implementer's own choices add a short moment (the hand-off after an entrance, a timer's
grain), the times shift by that much, and the implementer confirms them against their implementation.

Elements of example 5.

```json
[
  { "id": "s1", "effect": "fade",      "trigger": "advance",     "targets": [{ "type": "element", "id": "box" }] },
  { "id": "s2", "effect": "appear",    "trigger": "after-delay", "delayMs": 500, "targets": [{ "type": "element", "id": "free" }] },
  { "id": "s3", "effect": "fade",      "trigger": "after-delay", "durationMs": 200, "targets": [{ "type": "element", "id": "arrow" }] },
  { "id": "s4", "effect": "disappear", "trigger": "advance",     "targets": [{ "type": "element", "id": "box" }] }
]
```

The slide is entered forward. Nothing happens by itself: the first step waits for the presenter. Forward is pressed
at time 0 (times in ms, approximate):

| Time | What happens | Steps run |
| --- | --- | --- |
| 0 to 350 | `box` and `label` fade in | 1 at the end |
| 850 | `free` appears (500 after `s1` finished) | 2 |
| 1850 to 2050 | `arrow` and `alabel` fade in (1000, the default, after `s2`) | 3 at the end |
| after 2050 | nothing: `s4` waits for Forward | 3 |

Variations from the same start:

- Forward again at 100, while `box` fades: `box` and `label` are fully shown at once and `free` appears at once (2 steps run). `arrow` starts fading in 1000 later.
- Backward at 1200, while `s3` waits: the wait is cancelled and `free` is hidden at once (1 step run). Nothing more happens by itself. Forward then shows `free` at once, and `arrow` starts fading in 1000 later.
- If `s1` had `trigger: "after-delay"` with no `delayMs`, `box` would start fading in 1000 after the canvas arrived on the slide.
- If the slide is entered backward, all four steps have run: `box` and `label` are hidden, the rest is shown, and nothing happens by itself.

### 12. Moving through a deck

Two slides. The first has two steps that both select elements; the second has none. Starting on the first slide with
no step run:

| Input | Slide | Steps run |
| --- | --- | --- |
| (start) | 1 | 0 of 2 |
| Right arrow | 1 | 1 of 2 |
| Space | 1 | 2 of 2 |
| Page Down | 2 | 0 of 0 |
| Left arrow | 1 | 2 of 2 |
| Up arrow | 1 | 1 of 2 |
| Home | 1 | 0 of 2 |
| End | 2 | 0 of 0 |
| Home | 2 | 0 of 0 |
| Right arrow | slideshow ends | |

From the start, Left arrow ends the slideshow. Escape or Backspace ends it from anywhere. Cmd+Right arrow does
nothing. Holding Right arrow on the first slide runs one step, not two.

The same rule as values of `stepFrom(now, count, by)` (see [Public surface](#public-surface)), with slides counted
from 0 and a deck of 3 slides:

| `now` | `by` | Result |
| --- | --- | --- |
| `{ "slide": 0, "done": 0, "total": 2 }` | 1 | `{ "slide": 0, "done": 1 }` |
| `{ "slide": 0, "done": 1, "total": 2 }` | 1 | `{ "slide": 0, "done": 2 }` |
| `{ "slide": 0, "done": 2, "total": 2 }` | 1 | `{ "slide": 1, "done": 0 }` |
| `{ "slide": 1, "done": 0, "total": 0 }` | 1 | `{ "slide": 2, "done": 0 }` |
| `{ "slide": 2, "done": 0, "total": 1 }` | 1 | `{ "slide": 2, "done": 1 }` |
| `{ "slide": 2, "done": 0, "total": 0 }` | 1 | `null` |
| `{ "slide": 1, "done": 2, "total": 2 }` | -1 | `{ "slide": 1, "done": 1 }` |
| `{ "slide": 0, "done": 1, "total": 2 }` | -1 | `{ "slide": 0, "done": 0 }` |
| `{ "slide": 1, "done": 0, "total": 2 }` | -1 | `{ "slide": 0, "done": "all" }` |
| `{ "slide": 0, "done": 0, "total": 2 }` | -1 | `null` |

### 13. Saving notes

A deck without records. The frames, in the order of the element list:

```json
[
  { "id": "f3", "type": "frame", "name": "03 How", "customData": { "drawKey": "how" } },
  { "id": "f1", "type": "frame", "name": "01 Title" },
  { "id": "f2", "type": "frame", "name": "02 Why", "customData": { "drawKey": "why" } }
]
```

Saving the notes `"Say **why**.\n\n- one\n- two"` for `f2` writes all three frames. Their `customData` afterwards:

```json
{
  "f1": { "slideshow": { "schemaVersion": 2, "kind": "frame", "order": 0 } },
  "f2": { "drawKey": "why", "slideshow": { "schemaVersion": 2, "kind": "frame", "order": 1, "notes": "Say **why**.\n\n- one\n- two" } },
  "f3": { "drawKey": "how", "slideshow": { "schemaVersion": 2, "kind": "frame", "order": 2 } }
}
```

From that state: saving the same notes for `f2` again writes nothing; saving `""` for `f1` writes nothing; saving
`" "` for `f2` leaves its record as `{ "schemaVersion": 2, "kind": "frame", "order": 1 }`.

A deck with records of every kind:

```json
[
  { "id": "n", "type": "frame", "name": "A newer", "customData": { "slideshow": {
      "schemaVersion": 2, "kind": "frame", "order": 0, "notes": "Keep me", "extra": 1,
      "animation": { "steps": [{ "id": "s1", "targets": [{ "type": "element", "id": "a" }], "effect": "spin", "trigger": "advance" }] } } } },
  { "id": "k", "type": "frame", "name": "B known", "customData": { "slideshow": {
      "schemaVersion": 2, "kind": "frame", "order": 1, "extra": { "a": 1 }, "notes": "Old", "deckName": "Talk",
      "animation": { "loop": true, "steps": [{ "id": "s1", "targets": [{ "type": "element", "id": "a", "pin": true }], "effect": "fade", "trigger": "advance", "easing": "bounce" }] } } } },
  { "id": "b", "type": "frame", "name": "C blank", "customData": { "slideshow": {
      "schemaVersion": 2, "kind": "frame", "order": 2, "notes": " ", "later": [1] } } },
  { "id": "p", "type": "frame", "name": "D plain" }
]
```

`n` has an invalid record (an effect Inklode does not know). The deck is `k`, `b`, `n`, `p`, and its name is `Talk`.

| Save | Result |
| --- | --- |
| `"New"` for `p` | `n` is not written. `k`: its stored record with `order` 0. `b`: its stored record with `order` 1 and `"deckName": "Talk"` added last; its blank `notes` and `later` stay. `p`: `{ "schemaVersion": 2, "kind": "frame", "order": 3, "deckName": "Talk", "notes": "New" }`. |
| `"New"` for `k` | `k`: its stored record with `order` 0 and `notes` `"New"`; `extra`, `deckName`, `loop`, `pin` and `easing` stay where they are. `b` and `p` as in the row above, `p` without `notes`. |
| `""` for `k` | As the row above, with `notes` removed from `k`. |
| `"New"` for `n` | `n`: its stored record with `notes` `"New"` and nothing else changed, `order` still 0. `k`, `b` and `p` as in the second row, `k` keeping `"Old"`. |
| `"Keep me"` for `n` | Nothing is written. |
| `"  "` for `b` | Nothing is written. |

## Public surface

The rest of the app calls these. Names, parameters and return types are fixed; the bodies are to be written from this
document. The types `SceneElement`, `SlideshowData`, `BuildStep`, `Slide<T>` (in `format.ts`), `Build` and `Place` (in
`slideshow.ts`) are in the source and stay as they are.

In `src/modules/excalidraw/format.ts`:

| Function | Contract |
| --- | --- |
| `slideshowData(frame: SceneElement): SlideshowData \| null` | The frame's record in its [normal form](#the-normal-form), or null when it has none or an invalid one. |
| `deck<T extends SceneElement>(elements: readonly T[]): Slide<T>[]` | [The deck](#the-deck) of a drawing: every frame, excluded ones too, in presenting order, each with its title and `slideshowData`. |

In `src/modules/excalidraw/slideshow.ts`:

| Function | Contract |
| --- | --- |
| `exits(effect: BuildStep["effect"]): boolean` | Whether the effect is an exit. |
| `overlaps(e: SceneElement, rect: { x: number; y: number; width: number; height: number }): boolean` | Whether the element's bounding box touches the rectangle, as defined under [Which elements are on a slide](#which-elements-are-on-a-slide). It does not look at the element's id. |
| `builds(frame: SceneElement, steps: readonly BuildStep[], elements: readonly SceneElement[], viewport?: { width: number; height: number }): Build[]` | The [steps of a slide](#build-steps-of-a-slide): each step that selects at least one element, in order, with the ids of the elements it acts on (`ids`, no duplicates, any order). `viewport` is the presenting window's size in CSS pixels, when known. |
| `hidden(steps: readonly Build[], done: number): Set<string>` | The ids of the [hidden elements](#hidden-elements) when the first `done` of `steps` have run. |
| `stepFrom(now: Place, count: number, by: 1 \| -1): { slide: number; done: number \| "all" } \| null` | Where Forward (`by` 1) or Backward (-1) leads from `now` (`slide` from 0, `done` steps run of `total`) in a deck of `count` slides, by [Moving through a slideshow](#moving-through-a-slideshow): the same slide with one step more or fewer, the next slide with `done: 0`, the previous slide with `done: "all"` (all its steps, which are only known once it is entered), or null when the slideshow ends. Example 12 lists values. |
| `withNotes(elements: readonly SceneElement[], frameId: string, notes: string): Map<string, Record<string, unknown>> \| null` | The whole new `customData` of every frame that [saving notes](#writing-records) writes, by frame id, or null when nothing is written. It may include a frame whose `customData` comes out equal to what it had. Its first lines (finding the frame, the error for a missing one, the comparison with the stored notes) are in the source and stay. |

In `src/modules/excalidraw/View.tsx` the slideshow runs without builds, travel and keys. The gaps are marked
`// TODO slideshow-spec: <section>` with the section of this document that fills each one. What the implementation
must keep true for the code around them:

- `Show.steps` holds the slide's steps as `builds` returns them and `Show.done` how many have run; `Show.animating` is true while an effect is playing. `stepFrom`, `publish` and `uiState` read them.
- `publish()` is called whenever the slide or the number of steps run changes, so the presenter window follows.
- `ui_state.slideshow.build` reports `{ done, total, animating }`.
- `ui_state.drawing.faded` lists the elements the canvas does not draw at full opacity, by id with the opacity it draws them at (0 to 100): a hidden element is there with 0, an element in the middle of a fade with its opacity at that moment.
- `move(to, animate, arrived)` is [travelling to a slide](#travelling-to-a-slide): with `animate` false the canvas is there at once; `arrived` is called on arrival; while travelling `Show.stop` is a function that stops the travel, and it is null at rest (`ui_state.slideshow.transitioning` reports it). The lines that make the slide the current one are in the source and stay.
- `enter(to, built)` enters a slide with none of its steps run, or all of them when `built`; `build(by)` runs the next step (1) or undoes the last (-1); `settle()` is [interrupting](#interrupting-and-leaving); `restore()` is leaving a slide. They are called from the code that stays.
- `picture(now, at, done)` gives a [presenter picture](#presenter-pictures).

In `src/modules/excalidraw/Presenter.tsx` the presenter window's keys are a marked gap ([Keys](#keys)), and in
`src/app.css` the toolbar's way of getting out of the way ([The toolbar](#the-toolbar)).

`src/modules/excalidraw/format.test.mjs` has no tests for any of this. The examples above are the cases to test.

## Provenance

This document describes the data format written by the slideshow script of the Obsidian Excalidraw plugin
(`frame.customData.slideshow`), and the behaviour needed to present files that carry it. The implementation is
written from this document alone.
