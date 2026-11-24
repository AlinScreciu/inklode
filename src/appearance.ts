// The look options of a vault: keys in `.inklode/settings.json` next to `theme`, set with the command
// `settings.set {key, value}`. A key that is absent (or set to null) means the default: what the theme says.
// The ones that are set go on <html> as inline CSS variables, so they win over the theme and the snippets.
// `defaultMode`, `historyDiff` and `templateFolder` are kept here too: not looks, but options of the same kind.

export type AppearanceMode = "system" | "light" | "dark";

export interface Options {
  /** Light or dark, or whatever the system is in. Decides `data-appearance` on <html>. */
  appearance: AppearanceMode;
  /** A CSS colour for `--accent`. */
  accent: string | null;
  /** `--font-size-ui`, in px. */
  uiFontSize: number | null;
  /** `--font-text`: a CSS font-family list. */
  textFont: string | null;
  /** `--font-size-text`, in px. */
  textFontSize: number | null;
  /** `--line-width`, in rem. */
  lineWidth: number | null;
  /** The editor mode a vault opens in. */
  defaultMode: "live-preview" | "source";
  /** Where the history panel shows what changed since the picked version: under its list, or in a pane beside the note. */
  historyDiff: "sidebar" | "pane";
  /** The folder the templates module lists its templates from, as a vault path. Null is `_templates`. */
  templateFolder: string | null;
}

export const DEFAULT_OPTIONS: Options = {
  appearance: "system",
  accent: null,
  uiFontSize: null,
  textFont: null,
  textFontSize: null,
  lineWidth: null,
  defaultMode: "live-preview",
  historyDiff: "sidebar",
  templateFolder: null,
};

const oneOf =
  (...allowed: string[]) =>
  (value: unknown) =>
    allowed.includes(value as string);
const between = (min: number, max: number) => (value: unknown) =>
  typeof value === "number" && value >= min && value <= max;
/** A folder of the vault, written as a path from its root: no empty part, none that starts with a dot, no `\\`. */
const vaultFolder = (value: unknown) =>
  typeof value === "string" && value.split("/").every((part) => part.trim() !== "" && !part.startsWith(".") && !part.includes("\\"));
// No `;` or braces: the text goes into a style declaration.
const cssText = (value: unknown) => typeof value === "string" && value.trim() !== "" && !/[;{}]/.test(value);

/** What each key accepts, and how to say it in an error. */
const VALID: Record<keyof Options, { ok(value: unknown): boolean; expects: string }> = {
  appearance: { ok: oneOf("system", "light", "dark"), expects: '"system", "light" or "dark"' },
  accent: { ok: cssText, expects: "a CSS colour, e.g. #2f6fde" },
  uiFontSize: { ok: between(10, 20), expects: "a number from 10 to 20 (px)" },
  textFont: { ok: cssText, expects: "a font family, e.g. Georgia, serif" },
  textFontSize: { ok: between(10, 32), expects: "a number from 10 to 32 (px)" },
  lineWidth: { ok: between(20, 120), expects: "a number from 20 to 120 (rem)" },
  defaultMode: { ok: oneOf("live-preview", "source"), expects: '"live-preview" or "source"' },
  historyDiff: { ok: oneOf("sidebar", "pane"), expects: '"sidebar" or "pane"' },
  templateFolder: { ok: vaultFolder, expects: "a folder of the vault, written from its root without a slash at either end, e.g. _templates" },
};

export const OPTION_KEYS = Object.keys(VALID) as (keyof Options)[];

/** Throws, saying what is expected, unless `value` can be stored under `key`. Null always can: it means the default. */
export function checkOption(key: string, value: unknown): asserts key is keyof Options {
  if (!(key in VALID)) throw new Error(`Unknown setting: ${key}. The settings are ${OPTION_KEYS.join(", ")}`);
  if (value !== null && !VALID[key as keyof Options].ok(value)) {
    throw new Error(`${key} must be ${VALID[key as keyof Options].expects}, or null for the default`);
  }
}

/** The options in a parsed settings.json. A value that is missing or not valid is the default. */
export function readOptions(settings: Record<string, unknown>): Options {
  const options: Record<string, unknown> = { ...DEFAULT_OPTIONS };
  for (const key of OPTION_KEYS) if (VALID[key].ok(settings[key])) options[key] = settings[key];
  return options as unknown as Options;
}

type Rgb = [number, number, number];

/** `#rgb` or `#rrggbb` as numbers from 0 to 255. Null for any other way of writing a colour. */
export function hexRgb(color: string): Rgb | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

/** Relative luminance as WCAG defines it, 0 (black) to 1 (white). */
export function luminance([r, g, b]: Rgb): number {
  const linear = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio of two colours, 1 to 21. */
export const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const DARK_TEXT: Rgb = [22, 19, 15];
const WHITE: Rgb = [255, 255, 255];
const toHex = (rgb: Rgb) => "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");

/**
 * `--accent` and `--accent-text` for an accent the user chose. One colour has to serve light and dark,
 * so on dark it is mixed 30% towards white. The text on it is whichever of dark and white reads better.
 * A colour that is not written as hex is used as it is, with white text.
 */
export function accentColors(color: string, dark: boolean): { accent: string; text: string } {
  const rgb = hexRgb(color);
  if (!rgb) return { accent: color, text: "#ffffff" };
  const accent = dark ? (rgb.map((c) => c + (255 - c) * 0.3) as Rgb) : rgb;
  return { accent: toHex(accent), text: toHex(contrast(accent, DARK_TEXT) > contrast(accent, WHITE) ? DARK_TEXT : WHITE) };
}

/** index.html reads this before the first paint, so the window does not flash the wrong appearance. */
const APPEARANCE_KEY = "inklode.appearance";

/** The options in force. Before a vault's are loaded: the defaults, in the appearance mode of last time. */
let applied: Options | null = null;
let watching = false;

/** "light" or "dark": what <html data-appearance> says now. */
export const appearanceNow = () => (document.documentElement.dataset.appearance === "dark" ? "dark" : "light");

/**
 * Puts the options in force: `data-appearance` on <html> ("light" or "dark", never anything else) and the
 * inline variables. Then replaces `<meta name="inklode-appearance">` in <head>: views that draw with the theme's
 * colours on a canvas (graph, Excalidraw) watch <head> for added and removed nodes, and so repaint.
 */
export function applyOptions(options?: Options) {
  if (!options) {
    let mode: string | null = null;
    try {
      mode = localStorage.getItem(APPEARANCE_KEY);
    } catch {
      // ignore
    }
    options = applied ?? { ...DEFAULT_OPTIONS, appearance: VALID.appearance.ok(mode) ? (mode as AppearanceMode) : "system" };
  }
  applied = options;
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  if (!watching) {
    watching = true;
    // Only "system" follows the system, but re-applying in the other modes changes nothing.
    system.addEventListener("change", () => applyOptions());
  }
  const root = document.documentElement;
  const dark = options.appearance === "system" ? system.matches : options.appearance === "dark";
  root.dataset.appearance = dark ? "dark" : "light";
  try {
    localStorage.setItem(APPEARANCE_KEY, options.appearance);
  } catch {
    // ignore: the next launch then starts in the system's appearance
  }

  const accent = options.accent && CSS.supports("color", options.accent) ? accentColors(options.accent, dark) : null;
  const size = (n: number | null, unit: string) => (n === null ? null : `${n}${unit}`);
  const variables: Record<string, string | null> = {
    "--accent": accent?.accent ?? null,
    "--accent-text": accent?.text ?? null,
    "--font-size-ui": size(options.uiFontSize, "px"),
    "--font-text": options.textFont,
    "--font-size-text": size(options.textFontSize, "px"),
    "--line-width": size(options.lineWidth, "rem"),
  };
  for (const [name, value] of Object.entries(variables)) {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }

  document.head.querySelector('meta[name="inklode-appearance"]')?.remove();
  const signal = document.createElement("meta");
  signal.name = "inklode-appearance";
  signal.content = root.dataset.appearance;
  document.head.append(signal);
}
