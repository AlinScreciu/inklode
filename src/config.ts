// What a vault configures for the app, kept in its `.inklode` folder:
// `settings.json` (theme, snippets and which modules are on), `keys.json` (shortcut overrides),
// and the CSS files in `themes/` and `snippets/`.

import { applyOptions, checkOption, DEFAULT_OPTIONS, readOptions, type Options } from "./appearance";
import { bindable, commands } from "./commands";
import { appSettingsGet, call, captureSet } from "./core/client";
import { moduleFlags, MODULES } from "./modules";

export const SETTINGS_FILE = ".inklode/settings.json";
export const KEYS_FILE = ".inklode/keys.json";

// The themes that ship with the app: `src/themes/<name>.css`, name to a loader of its CSS text.
// Each is its own chunk, fetched when the theme is first used.
const BUILTIN_THEMES = new Map<string, () => Promise<string>>(
  Object.entries(import.meta.glob<string>("./themes/*.css", { query: "?raw", import: "default" })).map(
    // NFC, because a file name on macOS can come back decomposed and would then not equal a typed "é".
    ([path, load]) => [path.slice("./themes/".length, -".css".length).normalize("NFC"), load],
  ),
);

export interface VaultConfig {
  /** The theme named in settings.json. Its file may be missing, see `available`. */
  theme: string | null;
  /** The snippets switched on in settings.json, in file order. */
  snippets: string[];
  /**
   * Every module's id to whether it is on: `modules` in settings.json, or the module's default where that has no
   * entry. Not `capture`: that one is on when the app's own settings say so for this vault (`APP_MODULES`).
   */
  modules: Record<string, boolean>;
  /** keys.json: command id to its key, or null for no key. */
  keys: Record<string, string | null>;
  /** The look and editor options in settings.json (src/appearance.ts), defaults where it has none. */
  options: Options;
  /** The CSS files that exist, as names without `.css`. `themes` is the vault's own plus the built-in ones. */
  available: { themes: string[]; snippets: string[] };
  /** Config files that are not valid JSON: path to the parse error. Their last good content stays in force. */
  broken: Record<string, string>;
}

/**
 * The modules a vault's settings.json cannot switch: they are on or off per vault in the app's settings, outside
 * the vault. Quick capture takes a system-wide key, which a vault folder from someone else must not be able to do.
 */
const APP_MODULES = { capture: async () => (await appSettingsGet()).capture.on };

/** `flags` with the modules of `APP_MODULES` as the app's settings have them. */
async function withAppModules(flags: Record<string, boolean>): Promise<Record<string, boolean>> {
  const app = await Promise.all(Object.entries(APP_MODULES).map(async ([id, on]) => [id, await on().catch(() => false)] as const));
  return { ...flags, ...Object.fromEntries(app) };
}

export const NO_CONFIG: VaultConfig = {
  theme: null,
  snippets: [],
  modules: moduleFlags(undefined),
  keys: {},
  options: DEFAULT_OPTIONS,
  available: { themes: [], snippets: [] },
  broken: {},
};

let current = NO_CONFIG;

/** The options in force, for code that App.tsx does not hand them to (a module's panel). */
export const currentOptions = () => current.options;
/** Counts loads, so a slow one that finishes after a newer one is dropped. */
let loads = 0;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A config file as an object. A missing file is `{}`. Throws the parse error if it is not a JSON object. */
async function readJson(path: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    ({ content } = await call<{ content: string }>("config.read", { path }));
  } catch {
    return {}; // the file does not exist yet
  }
  const data: unknown = JSON.parse(content);
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("not a JSON object");
  return data as Record<string, unknown>;
}

/**
 * Changes a config file: reads it, lets `change` edit the object, writes it back.
 * Keys the app does not know survive. A file that does not parse is never written over.
 */
async function updateJson(path: string, change: (data: Record<string, unknown>) => void): Promise<void> {
  let data: Record<string, unknown>;
  try {
    data = await readJson(path);
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${message(e)}), so Inklode will not write over it. Fix the file first.`);
  }
  change(data);
  await call("config.write", { path, content: JSON.stringify(data, null, 2) + "\n" });
}

/**
 * Reads the open vault's config from disk and applies its theme and snippets to the page.
 * `reset` starts from no config, for a vault that was just opened.
 * Returns null when a newer load has taken over.
 */
export async function loadConfig(reset = false): Promise<VaultConfig | null> {
  const turn = ++loads;
  const last = reset ? NO_CONFIG : current;
  const broken: Record<string, string> = {};
  const read = (path: string) =>
    readJson(path).catch((e) => {
      broken[path] = message(e);
      return null;
    });
  const [settings, keys, inVault] = await Promise.all([
    read(SETTINGS_FILE),
    read(KEYS_FILE),
    call<VaultConfig["available"]>("config.list"),
  ]);
  const available = {
    themes: [...new Set([...inVault.themes, ...BUILTIN_THEMES.keys()])].sort((a, b) => a.localeCompare(b)),
    snippets: inVault.snippets,
  };

  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
  const next: VaultConfig = {
    theme: settings ? (typeof settings.theme === "string" ? settings.theme : null) : last.theme,
    snippets: settings ? strings(settings.snippets) : last.snippets,
    modules: await withAppModules(settings ? moduleFlags(settings.modules) : last.modules),
    keys: keys
      ? (Object.fromEntries(
          Object.entries(keys).filter(([, key]) => typeof key === "string" || key === null),
        ) as VaultConfig["keys"])
      : last.keys,
    options: settings ? readOptions(settings) : last.options,
    available,
    broken,
  };

  // Only files that `config.list` reports are read, so a name whose file is missing is skipped.
  // A theme in the vault wins over a built-in one with the same name.
  const css = (folder: "themes" | "snippets", name: string) =>
    inVault[folder].includes(name)
      ? call<{ content: string }>("config.read", { path: `.inklode/${folder}/${name}.css` }).then(
          (file) => file.content,
          () => null,
        )
      : folder === "themes" && BUILTIN_THEMES.has(name)
        ? BUILTIN_THEMES.get(name)!().catch(() => null)
        : null;
  const [themeCss, ...snippetCss] = await Promise.all([
    next.theme ? css("themes", next.theme) : null,
    ...next.snippets.map((name) => css("snippets", name)),
  ]);
  if (turn !== loads) return null;

  // At the end of <head>, so they come after the app's own CSS: the theme, then the snippets in order.
  document.querySelectorAll("style[data-inklode-theme], style[data-inklode-snippet]").forEach((el) => el.remove());
  const add = (attribute: string, name: string, text: string | null) => {
    if (text === null) return;
    const style = document.createElement("style");
    style.setAttribute(attribute, name);
    style.textContent = text;
    document.head.append(style);
  };
  if (next.theme) add("data-inklode-theme", next.theme, themeCss);
  next.snippets.forEach((name, i) => add("data-inklode-snippet", name, snippetCss[i]));

  // After the theme: the options are inline on <html> and win over it.
  applyOptions(next.options);

  current = next;
  return next;
}

/** Sets the vault's theme in settings.json. Null is the default theme. */
export async function setTheme(name: string | null): Promise<void> {
  if (name !== null) {
    const { themes } = await call<VaultConfig["available"]>("config.list");
    if (!themes.includes(name) && !BUILTIN_THEMES.has(name))
      throw new Error(`No theme named ${name}: not in .inklode/themes and not built in`);
  }
  await updateJson(SETTINGS_FILE, (settings) => {
    settings.theme = name;
  });
}

/** Sets one of the options of src/appearance.ts in settings.json. Null removes the key, which is the default. */
export async function setOption(key: string, value: unknown): Promise<void> {
  checkOption(key, value);
  await updateJson(SETTINGS_FILE, (settings) => {
    if (value === null) delete settings[key];
    else settings[key] = value;
  });
}

/** Switches a snippet on or off in settings.json. Without `on`, flips it. */
export async function toggleSnippet(name: string, on?: boolean): Promise<void> {
  const { snippets } = await call<VaultConfig["available"]>("config.list");
  await updateJson(SETTINGS_FILE, (settings) => {
    const enabled: unknown[] = Array.isArray(settings.snippets) ? settings.snippets : [];
    const isOn = enabled.includes(name);
    // A snippet whose file is gone can still be switched off.
    if (!isOn && !snippets.includes(name)) throw new Error(`No snippet named ${name} in .inklode/snippets`);
    if ((on ?? !isOn) === isOn) return;
    settings.snippets = isOn ? enabled.filter((n) => n !== name) : [...enabled, name];
  });
}

/** Switches a module on or off in settings.json, or for a module of `APP_MODULES` in the app's settings. Without `on`, flips it. */
export async function toggleModule(id: string, on?: boolean): Promise<void> {
  if (!MODULES.some((m) => m.id === id)) throw new Error(`Unknown module: ${id}`);
  if (id === "capture") return void (await captureSet(on ?? !current.modules.capture));
  await updateJson(SETTINGS_FILE, (settings) => {
    const { modules } = settings;
    // Entries for modules this build does not have are kept.
    const flags = (typeof modules === "object" && modules !== null && !Array.isArray(modules) ? modules : {}) as Record<string, unknown>;
    flags[id] = on ?? !moduleFlags(flags)[id];
    settings.modules = flags;
  });
}

/** Sets a command's key in keys.json. Null unbinds it; leaving `key` out removes the entry, which restores the default. */
export async function setKey(id: string, key?: string | null): Promise<void> {
  if (!commands.list().some((c) => c.id === id)) throw new Error(`Unknown command: ${id}`);
  if (typeof key === "string" && !bindable(key)) {
    throw new Error(`${key} cannot be set as a key: it needs Cmd, Ctrl or Alt, or to be a function key (F1 to F24)`);
  }
  await updateJson(KEYS_FILE, (keys) => {
    if (key === undefined) delete keys[id];
    else keys[id] = key;
  });
}
