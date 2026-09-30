// shared/config.ts — the companion's config file: the ctrl and >_ menus and
// what the hardware buttons do, from the file to what the console uses.
//
// The file lives on the computer (host/config.ts finds it), so editing it
// needs no rebuild and no ftpd copy. The companion checks it here, reduces
// every menu entry to a label, a right-hand detail and one key sequence
// (shared/keyseq.ts), fills in the buttons the file leaves out, and sends the
// result to the console on connect and on every save. A mistake in the file
// is reported rather than fatal: the entry is dropped and the menu says so.

import { describeKeys, literalKeys, parseKeys } from "./keyseq.ts";

/** One entry as written in the config file. Exactly one of run, type, keys
 *  or items. */
export interface MenuSource {
  label: string;
  /** Types the text, then Enter. */
  run?: string;
  /** Types the text and stops, for a command to be finished by hand. */
  type?: string;
  /** A key sequence: text with <C-c>, <Esc>, <wait:75> and so on. */
  keys?: string;
  /** A submenu. */
  items?: MenuSource[];
  /** Replaces the right-hand column. */
  hint?: string;
}

/** The buttons the file can set. The d-pad and the sticks keep their jobs
 *  (arrows, scrolling, moving through menus). */
export const BUTTON_NAMES = ["A", "B", "X", "Y", "L", "R", "ZL", "ZR", "START", "SELECT"] as const;
export type ButtonName = (typeof BUTTON_NAMES)[number];
export type Modifier = "ctrl" | "alt" | "shift";

/** What a button can do besides send keys. */
export const BUTTON_ACTIONS = ["prev-session", "next-session", "new-session", "files", "commands", "ctrl-menu", "settings"] as const;
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];

/** A button taps (a key sequence, or an action), holds a modifier, or both.
 *  With both, it is the tap for its first holdMs and the modifier after
 *  (app/buttons.ts). */
export interface ButtonBinding {
  tap?: string;
  action?: ButtonAction;
  hold?: Modifier;
  /** Overrides timing.holdMs for this button. */
  holdMs?: number;
}

/** Buttons pressed together within timing.comboMs. */
export interface ComboBinding {
  buttons: ButtonName[];
  tap?: string;
  action?: ButtonAction;
}

export interface Timing {
  /** How long a tap-and-hold button must be down before it is the modifier
   *  rather than the tap. */
  holdMs: number;
  /** How close together a combo's presses must be. Buttons in a combo wait
   *  this long before doing their own job. */
  comboMs: number;
  /** How long the keyboard's ctrl key is held to open the ctrl menu. */
  ctrlMenuMs: number;
}

export const DEFAULT_TIMING: Timing = { holdMs: 200, comboMs: 60, ctrlMenuMs: 350 };

export const DEFAULT_BUTTONS: Record<ButtonName, ButtonBinding> = {
  A: { tap: "<CR>", hold: "alt" },
  B: { tap: "<BS>" },
  X: { tap: "<Tab>" },
  Y: { tap: "<Space>" },
  L: { action: "prev-session" },
  R: { action: "next-session" },
  ZL: { hold: "ctrl" },
  ZR: {},
  START: { tap: "<C-c>" },
  SELECT: { action: "files" },
};

export interface ConfigSource {
  ctrl?: MenuSource[];
  commands?: MenuSource[];
  /** Buttons the file names replace their default outright; `{}` makes a
   *  button do nothing. */
  buttons?: Partial<Record<ButtonName, ButtonBinding>>;
  combos?: ComboBinding[];
  timing?: Partial<Timing>;
}

/** One entry as the console draws it: a leaf sends `keys`, a branch opens
 *  `items`. */
export interface MenuItem {
  label: string;
  detail: string;
  keys?: string;
  items?: MenuItem[];
}

export interface TermConfig {
  ctrl: MenuItem[];
  commands: MenuItem[];
  buttons: Record<ButtonName, ButtonBinding>;
  combos: ComboBinding[];
  timing: Timing;
  /** Problems found in the file, for the menu's footer and the daemon log. */
  errors: string[];
}

export const EMPTY_CONFIG: TermConfig = { ctrl: [], commands: [], buttons: DEFAULT_BUTTONS, combos: [], timing: DEFAULT_TIMING, errors: [] };

/** The config file is JSON with comments (JSONC): // and /* *\/ comments and
 *  trailing commas are removed, outside strings, before parsing. */
export function parseJsonc(text: string): unknown {
  // Two passes, each stepping over strings whole: the first drops comments,
  // the second drops any comma that only whitespace separates from } or ].
  const strip = (source: string, other: (at: number) => [string, number]) => {
    let out = "";
    for (let i = 0; i < source.length; i++) {
      if (source[i] === '"') {
        let j = i + 1;
        while (j < source.length && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
        out += source.slice(i, j + 1); i = j;
      } else { const [kept, last] = other(i); out += kept; i = last; }
    }
    return out;
  };
  const bare = strip(text, i => {
    if (text.startsWith("//", i)) { const end = text.indexOf("\n", i); return ["\n", end < 0 ? text.length : end]; }
    if (text.startsWith("/*", i)) { const end = text.indexOf("*/", i + 2); return [" ", end < 0 ? text.length : end + 1]; }
    return [text[i], i];
  });
  return JSON.parse(strip(bare, i => [bare[i] === "," && /^\s*[}\]]/.test(bare.slice(i + 1)) ? "" : bare[i], i]));
}

/** chars bounds the file as written, comments included. */
export const CONFIG_LIMITS = { label: 32, detail: 40, items: 48, total: 400, depth: 4, chars: 131072 } as const;

/** The console draws config text from its baked atlases, and the build
 *  always bakes printable ASCII into them (vendor/pocketjs
 *  framework/compiler/bake-font.ts); other characters exist only if some
 *  source literal happened to carry them. Anything outside ASCII would draw
 *  as a box, so it is replaced up front and reported. */
const PRINTABLE = /^[\x20-\x7e]*$/;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function buildConfig(source: unknown): TermConfig {
  const errors: string[] = [];
  let total = 0;
  const text = (value: string, where: string, max: number) => {
    if (!PRINTABLE.test(value)) {
      errors.push(`${where}: only plain ASCII can be drawn; other characters show as ?`);
      value = value.replace(/[^\x20-\x7e]/g, "?");
    }
    return clip(value, max);
  };
  const list = (value: unknown, where: string, depth: number): MenuItem[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) { errors.push(`${where} must be a list`); return []; }
    if (value.length > CONFIG_LIMITS.items) errors.push(`${where} has ${value.length} entries; the first ${CONFIG_LIMITS.items} are used`);
    const out: MenuItem[] = [];
    value.slice(0, CONFIG_LIMITS.items).forEach((raw: unknown, n) => {
      const at = `${where}[${n}]`;
      if (!raw || typeof raw !== "object") { errors.push(`${at} must be an object`); return; }
      const item = raw as Record<string, unknown>;
      if (typeof item.label !== "string" || item.label.trim() === "") { errors.push(`${at} needs a label`); return; }
      const name = `${where} > ${item.label}`;
      const kinds = (["run", "type", "keys", "items"] as const).filter(k => item[k] !== undefined);
      if (kinds.length !== 1) { errors.push(`${name}: needs exactly one of run, type, keys or items`); return; }
      if (++total > CONFIG_LIMITS.total) { if (total === CONFIG_LIMITS.total + 1) errors.push(`more than ${CONFIG_LIMITS.total} entries; the rest are dropped`); return; }
      const label = text(item.label, name, CONFIG_LIMITS.label);
      if (item.hint !== undefined && typeof item.hint !== "string") { errors.push(`${name}: hint must be text`); return; }
      if (kinds[0] === "items") {
        if (depth >= CONFIG_LIMITS.depth) { errors.push(`${name}: menus nest at most ${CONFIG_LIMITS.depth} deep`); return; }
        const items = list(item.items, name, depth + 1);
        out.push({ label, detail: text(item.hint ?? `${items.length}`, name, CONFIG_LIMITS.detail), items });
        return;
      }
      const value = item[kinds[0]];
      if (typeof value !== "string" || value === "") { errors.push(`${name}: ${kinds[0]} must be text`); return; }
      const keys = kinds[0] === "keys" ? value : kinds[0] === "run" ? `${literalKeys(value)}<CR>` : literalKeys(value);
      try { parseKeys(keys); } catch (error) { errors.push(`${name}: ${(error as Error).message}`); return; }
      const detail = item.hint ?? (kinds[0] === "keys" ? describeKeys(value) : value);
      out.push({ label, detail: text(detail, name, CONFIG_LIMITS.detail), keys });
    });
    return out;
  };
  /** tap / action, checked; undefined after reporting a problem. */
  const press = (raw: Record<string, unknown>, where: string): { tap?: string; action?: ButtonAction } | undefined => {
    const { tap, action } = raw;
    if (tap !== undefined && action !== undefined) { errors.push(`${where}: use tap or action, not both`); return; }
    if (action !== undefined) {
      if (!(BUTTON_ACTIONS as readonly unknown[]).includes(action)) { errors.push(`${where}: action must be one of ${BUTTON_ACTIONS.join(", ")}`); return; }
      return { action: action as ButtonAction };
    }
    if (tap !== undefined) {
      if (typeof tap !== "string" || tap === "") { errors.push(`${where}: tap must be a key sequence`); return; }
      try { parseKeys(tap); } catch (error) { errors.push(`${where}: ${(error as Error).message}`); return; }
      return { tap };
    }
    return {};
  };
  const isButton = (name: unknown): name is ButtonName => (BUTTON_NAMES as readonly unknown[]).includes(name);
  const ms = (value: unknown, where: string, fallback: number) => {
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2000) return value;
    errors.push(`${where}: must be a whole number of milliseconds from 0 to 2000`);
    return fallback;
  };
  const buttons = (value: unknown): Record<ButtonName, ButtonBinding> => {
    const out = { ...DEFAULT_BUTTONS };
    if (value === undefined) return out;
    if (!value || typeof value !== "object" || Array.isArray(value)) { errors.push("buttons must be an object keyed by button"); return out; }
    for (const [name, raw] of Object.entries(value)) {
      const where = `buttons > ${name}`;
      if (!isButton(name)) { errors.push(`${where}: only ${BUTTON_NAMES.join(", ")} can be set`); continue; }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors.push(`${where}: must be an object with tap, action and/or hold`); continue; }
      const { tap, action, hold, holdMs, ...rest } = raw as Record<string, unknown>;
      if (Object.keys(rest).length) { errors.push(`${where}: unknown field ${Object.keys(rest)[0]}`); continue; }
      if (hold !== undefined && hold !== "ctrl" && hold !== "alt" && hold !== "shift") { errors.push(`${where}: hold must be ctrl, alt or shift`); continue; }
      const job = press({ tap, action }, where);
      if (!job) continue;
      out[name] = { ...job, ...(hold !== undefined ? { hold: hold as Modifier } : {}), ...(holdMs !== undefined ? { holdMs: ms(holdMs, `${where} > holdMs`, DEFAULT_TIMING.holdMs) } : {}) };
    }
    return out;
  };
  const combos = (value: unknown): ComboBinding[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) { errors.push("combos must be a list"); return []; }
    const out: ComboBinding[] = [];
    value.forEach((raw: unknown, n) => {
      const where = `combos[${n}]`;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors.push(`${where}: must be an object`); return; }
      const { buttons: names, tap, action, ...rest } = raw as Record<string, unknown>;
      if (Object.keys(rest).length) { errors.push(`${where}: unknown field ${Object.keys(rest)[0]}`); return; }
      if (!Array.isArray(names) || names.length < 2 || !names.every(isButton) || new Set(names).size !== names.length) {
        errors.push(`${where}: buttons must list two or more different buttons from ${BUTTON_NAMES.join(", ")}`); return;
      }
      const job = press({ tap, action }, where);
      if (!job) return;
      if (job.tap === undefined && job.action === undefined) { errors.push(`${where}: needs a tap or an action`); return; }
      out.push({ buttons: names, ...job });
    });
    return out;
  };
  const timing = (value: unknown): Timing => {
    if (value === undefined) return DEFAULT_TIMING;
    if (!value || typeof value !== "object" || Array.isArray(value)) { errors.push("timing must be an object"); return DEFAULT_TIMING; }
    const raw = value as Record<string, unknown>;
    for (const key of Object.keys(raw)) if (!(key in DEFAULT_TIMING)) errors.push(`timing: unknown field ${key}`);
    return {
      holdMs: ms(raw.holdMs, "timing > holdMs", DEFAULT_TIMING.holdMs),
      comboMs: ms(raw.comboMs, "timing > comboMs", DEFAULT_TIMING.comboMs),
      ctrlMenuMs: ms(raw.ctrlMenuMs, "timing > ctrlMenuMs", DEFAULT_TIMING.ctrlMenuMs),
    };
  };
  if (!source || typeof source !== "object" || Array.isArray(source)) return { ...EMPTY_CONFIG, errors: ["the file must hold one object"] };
  const config = source as Record<string, unknown>;
  const sections = ["timing", "buttons", "combos", "ctrl", "commands"];
  for (const key of Object.keys(config)) if (!sections.includes(key)) errors.push(`unknown section "${key}"`);
  return {
    ctrl: list(config.ctrl, "ctrl", 1), commands: list(config.commands, "commands", 1),
    buttons: buttons(config.buttons), combos: combos(config.combos), timing: timing(config.timing), errors,
  };
}
