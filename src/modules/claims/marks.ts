// The mark of a claim's status, the same drawing in the editor (a DOM element) and in the panel. Each status
// has a shape of its own, so the marks can be told apart without their colour: a circle with a tick, a square
// with a cross, a clock, an empty dashed circle.

import type { Status } from "./claims";

export const LABEL: Record<Status, string> = {
  passing: "Passing",
  failing: "Failing",
  stale: "Stale",
  unchecked: "Not checked",
};

// On a grid of 16 by 16, drawn as lines in the text colour of the element.
const SHAPE: Record<Status, string> = {
  passing: '<circle cx="8" cy="8" r="6.25"/><path d="M5.2 8.3l1.9 1.9 3.7-4.1"/>',
  failing: '<rect x="1.75" y="1.75" width="12.5" height="12.5" rx="2.5"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8"/>',
  stale: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.4V8l2.4 1.6"/>',
  unchecked: '<circle cx="8" cy="8" r="6.25" stroke-dasharray="2.1 2.3"/>',
};

/** The drawing as SVG markup. The element around it says the status in words (`aria-label`). */
export const markSvg = (status: Status) =>
  `<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SHAPE[status]}</svg>`;

/** Said in a claim's row and popover when the core refused to run its command. The setting is in components/Settings.tsx. */
export const COMMANDS_OFF = "Commands are off for this vault. “Allow this vault to run commands” is in Settings, under Modules.";

/** Under a claim: its kind and the day of its last check. */
export const checkedLine = (claim: { kind: string; checked: string | null }) => `${claim.kind} · ${claim.checked ? `last checked ${claim.checked}` : "never checked"}`;
