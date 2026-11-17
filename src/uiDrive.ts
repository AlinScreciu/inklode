// Mouse and keyboard input for the app's MCP tools `ui_click`, `ui_drag` and `ui_key`:
// DOM events dispatched in the webview, so an agent can use the real window.
// Coordinates are CSS pixels in the viewport (a screenshot pixel divided by devicePixelRatio).
//
// shortcut: synthetic events are not trusted events, so things that require a real user gesture
// (clipboard, file pickers, fullscreen requests) will not respond, and neither do native controls
// drawn outside the page (the popup of a <select>, context menus); send real input from the Rust
// side (CGEvent on macOS) if a test needs those.

type Args = Record<string, unknown>;

interface Point {
  x: number;
  y: number;
}

const BUTTONS = { left: 0, middle: 1, right: 2 } as const;
/** The `buttons` bit mask of a mouse event for each `button` number. */
const BUTTON_MASK = [1, 4, 2];
/** `ui_drag` makes at most this many moves, to stay well inside the MCP server's 5 s limit for an answer. */
const MAX_STEPS = 100;

function point(value: unknown, name: string): Point {
  const { x, y } = (value ?? {}) as Partial<Point>;
  if (typeof x !== "number" || typeof y !== "number") throw new Error(`${name} needs numbers x and y`);
  return { x, y };
}

function elementAt({ x, y }: Point): Element {
  const el = document.elementFromPoint(x, y);
  if (!el) throw new Error(`Nothing at ${x}, ${y}: the point is outside the window's viewport`);
  return el;
}

/** What an event went to, for the tool's answer. */
function describe(el: Element) {
  const text = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent) ?? "";
  return {
    tag: el.tagName.toLowerCase(),
    ...(el.id && { id: el.id }),
    ...(el.classList.length > 0 && { classes: [...el.classList] }),
    text: text.trim().slice(0, 80),
  };
}

/** Whether the events of the click being made have Cmd held (Ctrl off macOS): `ui_click {mod: true}`. */
let mod = false;

/** Dispatches one pointer or mouse event and returns false if a listener called `preventDefault`. */
function fire(el: Element, type: string, at: Point, button: number, pressed: boolean, detail: number): boolean {
  const mac = navigator.platform.startsWith("Mac");
  const init: PointerEventInit = {
    metaKey: mod && mac,
    ctrlKey: mod && !mac,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: at.x,
    clientY: at.y,
    screenX: window.screenX + at.x,
    screenY: window.screenY + at.y,
    // A move has no button of its own.
    button: type.endsWith("move") ? (type === "pointermove" ? -1 : 0) : button,
    buttons: pressed ? BUTTON_MASK[button] : 0,
    detail,
  };
  const event = type.startsWith("pointer")
    ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true })
    : new MouseEvent(type, init);
  return el.dispatchEvent(event);
}

/** Button down at a point. Unless a listener prevented it, focus moves as on a real mouse down. */
function press(el: Element, at: Point, button: number, detail: number) {
  fire(el, "pointerdown", at, button, true, detail);
  if (!fire(el, "mousedown", at, button, true, detail)) return;
  let focusable: Element | null = el;
  while (focusable && !(focusable instanceof HTMLElement && (focusable.tabIndex >= 0 || focusable.isContentEditable))) {
    focusable = focusable.parentElement;
  }
  // The editor focuses itself in its mousedown listener; focusing it a second time would move its cursor.
  if (focusable?.contains(document.activeElement)) return;
  if (focusable instanceof HTMLElement) focusable.focus({ preventScroll: true });
  else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

function release(el: Element, at: Point, button: number, detail: number) {
  fire(el, "pointerup", at, button, false, detail);
  fire(el, "mouseup", at, button, false, detail);
}

/** Lets the app handle what was dispatched (state updates, a repaint) before the next event. */
// A timer next to the frame because a hidden or covered window gets no frames.
const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
    setTimeout(resolve, 50);
  });

/** `ui_click {x, y, button?, count?, mod?}`: a click at a point, with Cmd held if `mod`. Returns what was hit. */
export function click(args: Args) {
  const at = point(args, "ui_click");
  const button = BUTTONS[(args.button ?? "left") as keyof typeof BUTTONS];
  if (button === undefined) throw new Error("button is left, middle or right");
  const count = args.count === 2 ? 2 : 1;
  const el = elementAt(at);
  mod = args.mod === true;
  try {
    for (let n = 1; n <= count; n++) {
      press(el, at, button, n);
      release(el, at, button, n);
      // The browser runs the default action of a dispatched `click` (toggle a checkbox, follow a link).
      // The other buttons make these events instead of `click`.
      fire(el, button === 0 ? "click" : button === 2 ? "contextmenu" : "auxclick", at, button, false, n);
    }
    if (count === 2 && button === 0) fire(el, "dblclick", at, button, false, 2);
  } finally {
    mod = false;
  }
  // A click on an option of a list box selects it. No default action does that for a dispatched event.
  if (button === 0 && el instanceof HTMLOptionElement && !el.selected) {
    el.selected = true;
    const select = el.closest("select");
    select?.dispatchEvent(new Event("input", { bubbles: true }));
    select?.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return describe(el);
}

/** `ui_drag {from, to, steps?}`: left button down at `from`, moves along the line, up at `to`. Returns what was hit at `from`. */
// shortcut: no `click` after the button is released and no HTML drag-and-drop events (dragstart, drop);
// add them when something that is driven listens for them.
export async function drag(args: Args) {
  const from = point(args.from, "from");
  const to = point(args.to, "to");
  const steps = Math.min(Math.max(Math.round(typeof args.steps === "number" ? args.steps : 10), 1), MAX_STEPS);
  const start = elementAt(from);
  press(start, from, 0, 1);
  await nextFrame();
  // Moves and the release go to whatever is under the pointer (the page itself outside the viewport)
  // and bubble, so listeners on `document` and `window` see them.
  const under = (at: Point) => document.elementFromPoint(at.x, at.y) ?? document.documentElement;
  for (let step = 1; step <= steps; step++) {
    const at = { x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps };
    fire(under(at), "pointermove", at, 0, true, 0);
    fire(under(at), "mousemove", at, 0, true, 0);
    await nextFrame();
  }
  release(under(to), to, 0, 1);
  return describe(start);
}

/** `ui_key {key, mod?, shift?, alt?}` or `ui_key {text}`: one key press on the focused element, or text typed into it. Returns that element. */
export function key(args: Args) {
  const target = document.activeElement ?? document.body;
  if (typeof args.key === "string") {
    // `mod` is Cmd on macOS and Ctrl elsewhere, the same pair `keyOf` in commands.ts reads as "Mod".
    const mac = navigator.platform.startsWith("Mac");
    const init: KeyboardEventInit = {
      key: args.key,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      metaKey: args.mod === true && mac,
      ctrlKey: args.mod === true && !mac,
      shiftKey: args.shift === true,
      altKey: args.alt === true,
    };
    // A dispatched key event runs the listeners (shortcuts) but types nothing.
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  } else if (typeof args.text === "string") {
    insertText(target, args.text);
  } else {
    throw new Error("ui_key needs key or text");
  }
  return describe(target);
}

/** Types text at the cursor of the focused element, replacing its selection, so that its framework notices. */
function insertText(target: Element, text: string) {
  // Works for inputs, textareas and contenteditable (the editor) and fires the `input` events of real typing.
  if (document.execCommand("insertText", false, text)) return;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    throw new Error("The focused element does not take text. Click a text field or the editor first.");
  }
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? start;
  // The setter of the prototype, because React replaces the element's own and would miss the change.
  const proto = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(target, target.value.slice(0, start) + text + target.value.slice(end));
  target.setSelectionRange(start + text.length, start + text.length);
  target.dispatchEvent(new Event("input", { bubbles: true }));
}
