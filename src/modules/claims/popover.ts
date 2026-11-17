// The popover of a claim, opened by a click on its mark in the editor: the evidence, its kind, the day of
// the last check, the end of what that check printed, and a Check button. It is drawn outside the editor and
// follows the list and the running check, so it shows "Checking…" and then the result while the editor stays
// usable. It closes on Escape, on a click outside it, and when the editor scrolls or the window is resized.

import { commands } from "../../commands";
import { type Claim, keyOf, refused } from "./claims";
import { checkedLine, COMMANDS_OFF, LABEL, markSvg } from "./marks";
import { claims, live, runByUser, state } from "./state";

/** Ends the popover that is open, if one is. */
let close: (() => void) | null = null;

export function closePopover() {
  close?.();
}

function el<K extends keyof HTMLElementTagNameMap>(parent: Element, tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const child = parent.appendChild(document.createElement(tag));
  child.className = className;
  child.textContent = text;
  return child;
}

/** Opens the popover of `claim` under `anchor`, its mark. A click on the mark of the open one closes it. */
export function openPopover(anchor: HTMLElement, claim: Claim) {
  const again = close !== null && document.querySelector(".claim-popover")?.getAttribute("data-claim") === keyOf(claim);
  closePopover();
  if (again) return;

  const box = document.createElement("div");
  box.className = "claim-popover";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Claim");
  box.tabIndex = -1;

  /** The claim as listed now: on its line, or where typing above it moved it. Null when it is gone. */
  let shown: Claim | null = claim;
  const find = () => {
    const same = claims.get().filter((c) => c.path === claim.path && c.evidence === claim.evidence && c.text === claim.text);
    return same.find((c) => c.line === shown?.line) ?? same[0] ?? null;
  };

  const draw = () => {
    shown = find();
    if (!shown) return closePopover();
    const now = shown;
    const key = keyOf(now);
    const checking = state.checking === key;
    const error = state.errors.get(key);
    box.dataset.claim = key;
    box.replaceChildren();

    const head = el(box, "div", "claim-popover-head");
    const status = el(head, "span", `claim-status is-${now.status}`);
    status.innerHTML = markSvg(now.status);
    el(head, "span", "claim-popover-status", LABEL[now.status]);
    el(head, "span", "claim-meta", checkedLine(now));
    el(box, "code", "claim-evidence", now.evidence);
    if (now.output) el(box, "pre", "claim-output", now.output).tabIndex = 0;
    if (error) {
      const notice = el(box, "p", "claim-notice", refused(error) ? COMMANDS_OFF : error);
      notice.setAttribute("role", "status");
      if (refused(error)) {
        const open = el(box, "button", "button is-quiet", "Open Settings");
        open.type = "button";
        open.addEventListener("click", () => {
          closePopover();
          void commands.run("settings.open", { section: "modules" });
        });
      }
    }
    const button = el(box, "button", "button claim-check", checking ? "Checking…" : "Check");
    button.type = "button";
    // One check runs at a time.
    button.disabled = state.checking !== null;
    button.addEventListener("click", (event) => runByUser(event, "claims.check", { path: now.path, line: now.line }));
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    closePopover();
  };
  const onPress = (event: MouseEvent) => {
    const target = event.target as Node;
    // A press on the mark is left to the mark's own click, which closes.
    if (!box.contains(target) && !anchor.contains(target)) closePopover();
  };
  // Scrolling inside the popover (the output) does not close it.
  const onScroll = (event: Event) => {
    if (!box.contains(event.target as Node)) closePopover();
  };
  const stop = [claims.subscribe(draw), live.subscribe(draw)];
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("mousedown", onPress, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", closePopover);
  close = () => {
    close = null;
    stop.forEach((end) => end());
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("mousedown", onPress, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", closePopover);
    box.remove();
  };

  document.body.appendChild(box);
  draw();
  if (!box.isConnected) return;
  // Under the mark, its left edge at the mark's, moved in from the window's right and bottom edges.
  const at = anchor.getBoundingClientRect();
  const size = box.getBoundingClientRect();
  const left = Math.max(8, Math.min(at.left, window.innerWidth - size.width - 8));
  const below = at.bottom + 6;
  const top = below + size.height > window.innerHeight - 8 ? Math.max(8, at.top - size.height - 6) : below;
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
}
