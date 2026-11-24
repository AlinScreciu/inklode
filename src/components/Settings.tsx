import { Blocks, Info, Keyboard, Moon, Monitor, Palette, Plug, RotateCcw, Search, SquarePen, Sun, Unlink, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { version } from "../../package.json";
import type { Options } from "../appearance";
import { bindable, commands } from "../commands";
import { KEYS_FILE, SETTINGS_FILE, type VaultConfig } from "../config";
import { appSettingsGet, type AppSettings } from "../core/client";
import { MODULES } from "../modules";
import { Keys, Select, useReturnFocus, type Icon } from "./Menu";

export const SETTINGS_SECTIONS = [
  { id: "appearance", title: "Appearance", icon: Palette },
  { id: "editor", title: "Editor", icon: SquarePen },
  { id: "hotkeys", title: "Hotkeys", icon: Keyboard },
  { id: "modules", title: "Modules", icon: Blocks },
  { id: "mcp", title: "MCP server", icon: Plug },
  { id: "about", title: "About", icon: Info },
] as const satisfies readonly { id: string; title: string; icon: Icon }[];

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

/** The accents offered as swatches. Any other colour can be typed. The first is the theme's own. */
const ACCENTS = [
  { name: "Blue", color: "#2f6fde" },
  { name: "Teal", color: "#0f8f85" },
  { name: "Green", color: "#2f9e44" },
  { name: "Rose", color: "#d6336c" },
  { name: "Violet", color: "#7c5cdb" },
];

interface Props {
  /** Null when no vault is open: only the MCP and About sections work then. */
  config: VaultConfig | null;
  /** Null until the app settings have loaded. */
  app: AppSettings | null;
  /** The open vault's folder, for About. */
  vaultRoot: string | null;
  section: SettingsSection;
  onSection(section: SettingsSection): void;
  onClose(): void;
}

const set = (key: keyof Options, value: unknown) => void commands.run("settings.set", { key, value });

/** One setting: its name and what it does on the left, its control on the right. */
function Row({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-label">
        <div>{title}</div>
        {hint && <div className="settings-hint">{hint}</div>}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

/** A row whose control is a switch. The whole row is the label. */
function Toggle(props: { title: string; hint?: ReactNode; checked: boolean; disabled?: boolean; onChange(on: boolean): void }) {
  return (
    <label className="settings-row settings-check">
      <div className="settings-label">
        <div>{props.title}</div>
        {props.hint && <div className="settings-hint">{props.hint}</div>}
      </div>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
    </label>
  );
}

/**
 * The switch that lets the open vault run the commands its claims name (src/modules/claims). It is the app's
 * setting, kept per vault outside the vault, so a vault cannot allow itself. The command refuses a click that
 * a script made, so the switch shows what the app's settings say after it, not what was clicked.
 */
function ClaimsTrust({ app }: { app: AppSettings }) {
  const [trusted, setTrusted] = useState(app.claims.trusted);
  useEffect(() => setTrusted(app.claims.trusted), [app]);
  return (
    <Toggle
      title="Allow this vault to run commands"
      hint="Commands written in this vault's notes run on your Mac when you press Check. While it is off, only claims about files and web addresses are checked."
      checked={trusted}
      onChange={(on) =>
        void commands
          .run("claims.trust", { trusted: on })
          .then(appSettingsGet)
          .then((now) => setTrusted(now.claims.trusted))
      }
    />
  );
}

/**
 * A field that is applied on Enter or when focus leaves, not per character: each change writes a file.
 * Empty means the default, which shows as the placeholder. `number` makes the value a number.
 */
function Field(props: {
  label: string;
  value: string | number | null;
  placeholder: string;
  number?: { min: number; max: number };
  unit?: string;
  disabled?: boolean;
  onChange(value: string | number | null): void;
}) {
  const { label, value, placeholder, number, unit, disabled, onChange } = props;
  const input = useRef<HTMLInputElement>(null);
  // What the file says shows in the field, also when it changed by another way than this field.
  useEffect(() => {
    if (input.current) input.current.value = String(value ?? "");
  }, [value]);
  const commit = (field: HTMLInputElement) => {
    const text = field.value.trim();
    // A number outside the range becomes the nearest one inside it.
    const next = text === "" ? null : number ? Math.min(Math.max(Number(text), number.min), number.max) : text;
    field.value = String(next ?? "");
    if (next !== value) onChange(next);
  };
  return (
    <span className={"settings-field" + (number ? " is-number" : "")}>
      <input
        ref={input}
        type={number ? "number" : "text"}
        aria-label={label}
        min={number?.min}
        max={number?.max}
        defaultValue={value ?? ""}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        onKeyDown={(e) => e.key === "Enter" && commit(e.currentTarget)}
        onBlur={(e) => commit(e.target)}
      />
      {unit && <span className="settings-unit">{unit}</span>}
    </span>
  );
}

/**
 * The settings screen: sections on the left, the chosen one on the right, scrolling on its own.
 * It is a view over the vault's `.inklode/settings.json` and `keys.json` and the app's own settings: every control
 * runs a command (`settings.set`, `appearance.set`, `theme.set`, `snippet.toggle`, `module.toggle`, `key.set`,
 * `mcp.set`), the same ones an agent runs over MCP, and shows what the files say. Escape closes.
 */
export function Settings({ config, app, vaultRoot, section, onSection, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null);
  // The id of the command whose new key is being recorded.
  const [recording, setRecording] = useState<string | null>(null);
  const [keyFilter, setKeyFilter] = useState("");
  /** What the last button of the MCP section did, said under it. */
  const [mcpNote, setMcpNote] = useState<string | null>(null);
  const copied = (what: "token" | "command" | "new", done: Promise<void>) =>
    done.then(
      () => setMcpNote(what === "new" ? "A new token is in force. Clients that have the old one are refused until they get this one." : `The ${what === "token" ? "token" : "command"} is on the clipboard.`),
      (e) => {
        setMcpNote(null);
        commands.onError(e);
      },
    );
  useReturnFocus();

  // Focus starts in the dialog, so Tab works at once.
  useEffect(() => box.current?.focus(), []);

  // Escape closes wherever the focus is, also when it is nowhere. Not while a key is recorded (Escape cancels
  // that) and not from an open menu, which closes itself and keeps the key press to itself.
  useEffect(() => {
    if (recording) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, onClose]);

  useEffect(() => {
    if (!recording) return;
    commands.capture = (key) => {
      setRecording(null);
      if (key !== "Escape") void commands.run("key.set", { id: recording, key });
    };
    return () => {
      commands.capture = null;
    };
  }, [recording]);

  const list = commands.list().sort((a, b) => a.title.localeCompare(b.title));
  const uses = (key: string) => list.filter((c) => c.key === key).length;
  /** Why a config file cannot be changed from here, if it cannot. */
  const broken = (path: string) =>
    config?.broken[path] && (
      <p className="settings-bad">
        {path} is not valid JSON ({config.broken[path]}). Its last good content is in use, and it cannot be changed here
        until it is fixed.
      </p>
    );
  const needsVault = (what: string) => <p className="settings-hint">Open a vault to {what}.</p>;
  const options = config?.options;

  const sections: Record<SettingsSection, ReactNode> = {
    appearance:
      config && options ? (
        <>
          {broken(SETTINGS_FILE)}
          <Row title="Appearance" hint="System follows macOS as it changes between light and dark.">
            <div className="segmented" role="group" aria-label="Appearance">
              {(
                [
                  ["system", "System", Monitor],
                  ["light", "Light", Sun],
                  ["dark", "Dark", Moon],
                ] as const
              ).map(([mode, label, IconOf]) => (
                <button
                  key={mode}
                  aria-pressed={options.appearance === mode}
                  onClick={() => void commands.run("appearance.set", { mode })}
                >
                  <IconOf size={14} />
                  {label}
                </button>
              ))}
            </div>
          </Row>
          <Row title="Theme" hint="Built in, or a CSS file in .inklode/themes.">
            <Select
              label="Theme"
              value={config.theme ?? ""}
              options={[
                { value: "", label: "Inklode (default)" },
                ...(config.theme && !config.available.themes.includes(config.theme)
                  ? [{ value: config.theme, label: `${config.theme} (missing)` }]
                  : []),
                ...config.available.themes.map((name) => ({ value: name, label: name })),
              ]}
              onChange={(name) => void commands.run("theme.set", { name: name || null })}
            />
          </Row>
          <Row title="Accent colour" hint="Used in place of the theme's accent.">
            <div className="swatches">
              <button
                className="swatch is-default"
                aria-label="The theme's accent"
                title="The theme's accent"
                aria-pressed={options.accent === null}
                onClick={() => set("accent", null)}
              />
              {ACCENTS.map(({ name, color }) => (
                <button
                  key={color}
                  className="swatch"
                  style={{ background: color }}
                  aria-label={name}
                  title={name}
                  aria-pressed={options.accent === color}
                  onClick={() => set("accent", color)}
                />
              ))}
              <Field label="Custom accent colour" value={options.accent} placeholder="#rrggbb" onChange={(v) => set("accent", v)} />
            </div>
          </Row>
          <Row title="Interface font size">
            <Field
              label="Interface font size"
              value={options.uiFontSize}
              placeholder="default"
              number={{ min: 10, max: 20 }}
              unit="px"
              onChange={(v) => set("uiFontSize", v)}
            />
          </Row>
          <Row title="Text font" hint="The font of notes: a family name, or a list such as Georgia, serif.">
            <Field label="Text font" value={options.textFont} placeholder="System font" onChange={(v) => set("textFont", v)} />
          </Row>
          <Row title="Text size">
            <Field
              label="Text size"
              value={options.textFontSize}
              placeholder="default"
              number={{ min: 10, max: 32 }}
              unit="px"
              onChange={(v) => set("textFontSize", v)}
            />
          </Row>
          <Row title="Line width" hint="How wide a note's text column may get.">
            <Field
              label="Line width"
              value={options.lineWidth}
              placeholder="default"
              number={{ min: 20, max: 120 }}
              unit="rem"
              onChange={(v) => set("lineWidth", v)}
            />
          </Row>
          <h3>CSS snippets</h3>
          {/* Snippets that are on but whose file is gone stay listed, so they can be switched off. */}
          {[...new Set([...config.available.snippets, ...config.snippets])].map((name) => (
            <Toggle
              key={name}
              title={name + (config.available.snippets.includes(name) ? "" : " (missing)")}
              checked={config.snippets.includes(name)}
              onChange={(on) => void commands.run("snippet.toggle", { name, on })}
            />
          ))}
          <p className="settings-hint">Snippets are the CSS files in .inklode/snippets. They load after the theme.</p>
        </>
      ) : (
        needsVault("choose its look")
      ),

    editor:
      config && options ? (
        <>
          {broken(SETTINGS_FILE)}
          <Row title="Default mode" hint="What a note opens in. Live Preview renders Markdown as you write; source shows it as typed; reading shows it rendered, not editable.">
            <div className="segmented" role="group" aria-label="Default mode">
              {(
                [
                  ["live-preview", "Live Preview"],
                  ["source", "Source"],
                  ["reading", "Reading"],
                ] as const
              ).map(([mode, label]) => (
                <button key={mode} aria-pressed={options.defaultMode === mode} onClick={() => set("defaultMode", mode)}>
                  {label}
                </button>
              ))}
            </div>
          </Row>
        </>
      ) : (
        needsVault("set up its editor")
      ),

    hotkeys: config ? (
      <>
        {broken(KEYS_FILE)}
        <label className="settings-search">
          <Search size={14} />
          <input
            type="search"
            aria-label="Filter hotkeys"
            placeholder="Filter by command or key"
            value={keyFilter}
            onChange={(e) => setKeyFilter(e.target.value)}
          />
        </label>
        <ul className="settings-keys">
          {list
            // A command that no key runs has no row.
            .filter((c) => !c.noKey)
            .filter((c) => `${c.title} ${c.key ?? ""}`.toLowerCase().includes(keyFilter.trim().toLowerCase()))
            .map((c) => {
              const changed = c.id in config.keys;
              // A key from keys.json without Cmd, Ctrl or Alt that is no function key is not in force (`bindable`).
              const ignored = typeof config.keys[c.id] === "string" && !bindable(config.keys[c.id]!);
              const conflict = c.key !== undefined && uses(c.key) > 1;
              return (
                <li key={c.id} data-command={c.id}>
                  <span className="settings-key-title">{c.title}</span>
                  {conflict && <span className="settings-bad">conflict</span>}
                  {ignored ? (
                    <span className="settings-bad" title="keys.json may only set a key with Cmd, Ctrl or Alt, or a function key">
                      {config.keys[c.id]} in keys.json is ignored
                    </span>
                  ) : (
                    changed && <span className="settings-hint">changed</span>
                  )}
                  <button
                    className={"settings-key" + (recording === c.id ? " is-recording" : "")}
                    aria-label={`Change key for ${c.title}`}
                    title="Click, then press the new key. Escape cancels."
                    onClick={() => setRecording(recording === c.id ? null : c.id)}
                  >
                    {recording === c.id ? "Press a key…" : c.key ? <Keys k={c.key} /> : <span className="settings-hint">no key</span>}
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Unbind ${c.title}`}
                    title="Unbind"
                    disabled={!c.key}
                    onClick={() => void commands.run("key.set", { id: c.id, key: null })}
                  >
                    <Unlink size={14} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Reset key for ${c.title} to default`}
                    title="Reset to default"
                    disabled={!changed}
                    onClick={() => void commands.run("key.set", { id: c.id })}
                  >
                    <RotateCcw size={14} />
                  </button>
                </li>
              );
            })}
        </ul>
      </>
    ) : (
      needsVault("change its keys")
    ),

    modules: config ? (
      <>
        {broken(SETTINGS_FILE)}
        {MODULES.map((m) => (
          <Fragment key={m.id}>
            <Toggle
              title={m.title}
              // Whether quick capture is on is the app's setting for this vault, not the vault's own: the same switch, kept elsewhere.
              hint={m.id === "capture" ? "Kept in the app's settings for this vault, not in the vault." : undefined}
              checked={config.modules[m.id]}
              onChange={(on) => void commands.run("module.toggle", { id: m.id, on })}
            />
            {/* The global hotkey is the app's setting, not the vault's, so a vault cannot take a system-wide key. */}
            {m.id === "capture" && config.modules.capture && app && (
              <>
                {/* shortcut: the hotkey is typed as text, because the key recorder of the Hotkeys section
                    reads Cmd and Ctrl as one "Mod"; record it there once that tells the two apart */}
                <Row title="Capture hotkey" hint="Works in every app while Inklode runs. Modifiers and one key. Kept in the app's settings, not the vault's.">
                  <Field
                    label="Capture hotkey"
                    value={app.capture.hotkey}
                    placeholder="Ctrl+Alt+Space"
                    onChange={(key) => void commands.run("capture.hotkey", { key: key ?? "Ctrl+Alt+Space" })}
                  />
                </Row>
                <p className={app.captureStatus.error ? "settings-bad" : "settings-hint"} role="status">
                  {app.captureStatus.error ?? (app.captureStatus.registered ? `${app.capture.hotkey} is registered` : "The hotkey is not registered")}
                </p>
              </>
            )}
            {m.id === "claims" && config.modules.claims && app && <ClaimsTrust app={app} />}
          </Fragment>
        ))}
        <p className="settings-hint">A module that is off is not loaded.</p>
      </>
    ) : (
      needsVault("choose its modules")
    ),

    mcp: (
      <>
        {app && (
          <>
            <Toggle
              title="Serve MCP while the app runs"
              hint="While it is on, a program that has the token below can read and change notes through it, and open any folder as a vault."
              checked={app.mcp.enabled}
              disabled={app.mcpStatus.envOverride !== null}
              onChange={(enabled) => void commands.run("mcp.set", { enabled })}
            />
            <Row title="Port">
              <Field
                label="Port"
                value={app.mcp.port}
                placeholder=""
                number={{ min: 1, max: 65535 }}
                disabled={app.mcpStatus.envOverride !== null}
                onChange={(port) => port !== null && void commands.run("mcp.set", { port })}
              />
            </Row>
            <p className={app.mcpStatus.error ? "settings-bad" : "settings-hint"} role="status">
              {app.mcpStatus.error ?? (app.mcpStatus.running ? `Running on 127.0.0.1:${app.mcpStatus.port}` : "Off")}
            </p>
            {app.mcpStatus.envOverride !== null && (
              <p className="settings-hint">INKLODE_MCP_PORT={app.mcpStatus.envOverride} overrides this setting.</p>
            )}
            {/* The token itself is never in the window: the shell puts it on the clipboard (`mcpCopy` in core/client.ts). */}
            <Row title="Token" hint="Every request must carry it. It is kept in the app's settings folder, in a file only you can read.">
              <button className="button is-quiet" onClick={() => void copied("token", commands.execute("mcp.copyToken"))}>
                Copy
              </button>
              <button className="button is-quiet" onClick={() => void copied("new", commands.execute("mcp.newToken"))}>
                New token
              </button>
            </Row>
            <Row title="Add to Claude Code" hint="The `claude mcp add` line for this server, with the token in it.">
              <button className="button is-quiet" onClick={() => void copied("command", commands.execute("mcp.copyCommand"))}>
                Copy
              </button>
            </Row>
            {mcpNote && (
              <p className="settings-hint" role="status">
                {mcpNote}
              </p>
            )}
          </>
        )}
      </>
    ),

    about: (
      <>
        <Row title="Inklode" hint="Markdown notes in a folder you own.">
          <span className="settings-value">Version {version}</span>
        </Row>
        <Row title="Vault" hint="Its settings, keys, themes and snippets are in the .inklode folder inside it.">
          <span className="settings-value">{vaultRoot ?? "None open"}</span>
        </Row>
        {app && (
          <>
            <h3>Updates</h3>
            {/* The answer of "Check now" shows in the notice at the bottom of the window (components/Updates.tsx). */}
            <Row title="Current version" hint="An update is downloaded and installed only when you ask for it.">
              <span className="settings-value">{app.updates.version}</span>
              <button className="button is-quiet" onClick={() => void commands.run("app.checkForUpdates")}>
                Check now
              </button>
            </Row>
            <Toggle
              title="Check for updates when Inklode starts"
              hint="Reads the latest version from github.com once per start. Nothing about you or your notes is sent."
              checked={app.updates.auto}
              onChange={(auto) => void commands.run("updates.set", { auto })}
            />
          </>
        )}
      </>
    ),
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        ref={box}
        className="palette settings"
        role="dialog"
        aria-label="Settings"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav-title">Settings</div>
          {SETTINGS_SECTIONS.map(({ id, title, icon: IconOf }) => (
            <button key={id} className={id === section ? "is-active" : ""} aria-current={id === section ? "page" : undefined} onClick={() => onSection(id)}>
              <IconOf size={15} />
              {title}
            </button>
          ))}
        </nav>
        <section className="settings-section" data-section={section} aria-label={SETTINGS_SECTIONS.find((s) => s.id === section)?.title}>
          <header className="settings-header">
            <h2>{SETTINGS_SECTIONS.find((s) => s.id === section)?.title}</h2>
            <button className="icon-button" aria-label="Close settings" title="Close" onClick={onClose}>
              <X size={16} />
            </button>
          </header>
          {/* Keyed, so each section starts at its top. */}
          <div key={section} className="settings-body">
            {sections[section]}
          </div>
        </section>
      </div>
    </div>
  );
}
