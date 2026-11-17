// The merge module: a note that changed on disk while the editor holds unsaved edits is merged without asking
// when the two changes are in different parts of the note (merge3.ts). When they touch, the conflict banner
// shows as it does with the module off.
//
// The app asks for the merge through `Saves.merge` (src/saves.ts) and puts the result into the editors
// (`seen` in App.tsx). This module gives the merge function, says on screen that a merge happened, and counts.

import type { AppApi } from "../../modules";
import { Saves } from "../../saves";
import { merge3 } from "./merge3";

/** How long the notice stays on screen. */
const NOTICE_MS = 6000;

let count = 0;
let last: string | null = null;
let notice: HTMLElement | null = null;
let hiding = 0;

/** A line at the bottom of the window that goes away by itself. A new one takes the place of the one that shows. */
function say(text: string) {
  hide();
  notice = document.createElement("div");
  notice.className = "notice";
  notice.setAttribute("role", "status");
  notice.textContent = text;
  document.body.append(notice);
  hiding = window.setTimeout(hide, NOTICE_MS);
}

function hide() {
  window.clearTimeout(hiding);
  notice?.remove();
  notice = null;
}

export function activate(app: AppApi) {
  count = 0;
  last = null;
  Saves.merge = (base, mine, theirs, path) => {
    const merged = merge3(base, mine, theirs);
    if (merged === null) return null;
    count++;
    last = path;
    // Nothing to say when the editor's text stays as it is (the outside change was one the user made too).
    if (merged !== mine) say(`Merged a change made outside Inklode into “${path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "")}”. Undo takes it out again.`);
    return merged;
  };
  // `merge` in `ui_state`: `count`, the conflicts merged since the module was switched on, and `last`, the
  // path of the note of the last one (null before the first).
  app.ui.registerState(() => ({ merge: { count, last } }));
}

export function deactivate() {
  Saves.merge = null;
  hide();
}
