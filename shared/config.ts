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

/** The buttons the file can set. L, R, SELECT, the d-pad and the sticks
 *  keep their fixed jobs (sessions, the file browser, arrows, scrolling). */
export const BUTTON_NAMES = ["A", "B", "X", "Y", "START", "ZL", "ZR"] as const;
export type ButtonName = (typeof BUTTON_NAMES)[number];
export type Modifier = "ctrl" | "alt" | "shift";

/** A button taps a key sequence, holds a modifier, or both. With both, a
 *  press that nothing else happens during sends the tap on release; a
 *  press that other keys were sent under was only the modifier. */
export interface ButtonBinding {
  tap?: string;
  hold?: Modifier;
}

export const DEFAULT_BUTTONS: Record<ButtonName, ButtonBinding> = {
  A: { tap: "<CR>", hold: "alt" },
  B: { tap: "<BS>" },
  X: { tap: "<Tab>" },
  Y: { tap: "<Space>" },
  START: { tap: "<C-c>" },
  ZL: { hold: "ctrl" },
  ZR: {},
};

export interface ConfigSource {
  ctrl?: MenuSource[];
  commands?: MenuSource[];
  /** Buttons the file names replace their default outright; `{}` makes a
   *  button do nothing. */
  buttons?: Partial<Record<ButtonName, ButtonBinding>>;
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
  /** Problems found in the file, for the menu's footer and the daemon log. */
  errors: string[];
}

export const EMPTY_CONFIG: TermConfig = { ctrl: [], commands: [], buttons: DEFAULT_BUTTONS, errors: [] };

export const CONFIG_LIMITS = { label: 32, detail: 40, items: 48, total: 400, depth: 4, chars: 32768 } as const;

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
  const buttons = (value: unknown): Record<ButtonName, ButtonBinding> => {
    const out = { ...DEFAULT_BUTTONS };
    if (value === undefined) return out;
    if (!value || typeof value !== "object" || Array.isArray(value)) { errors.push("buttons must be an object keyed by button"); return out; }
    for (const [name, raw] of Object.entries(value)) {
      const where = `buttons > ${name}`;
      if (!(BUTTON_NAMES as readonly string[]).includes(name)) { errors.push(`${where}: only ${BUTTON_NAMES.join(", ")} can be set`); continue; }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors.push(`${where}: must be an object with tap and/or hold`); continue; }
      const { tap, hold, ...rest } = raw as Record<string, unknown>;
      if (Object.keys(rest).length) { errors.push(`${where}: unknown field ${Object.keys(rest)[0]}`); continue; }
      if (hold !== undefined && hold !== "ctrl" && hold !== "alt" && hold !== "shift") { errors.push(`${where}: hold must be ctrl, alt or shift`); continue; }
      if (tap !== undefined) {
        if (typeof tap !== "string" || tap === "") { errors.push(`${where}: tap must be a key sequence`); continue; }
        try { parseKeys(tap); } catch (error) { errors.push(`${where}: ${(error as Error).message}`); continue; }
      }
      out[name as ButtonName] = { ...(tap !== undefined ? { tap: tap as string } : {}), ...(hold !== undefined ? { hold: hold as Modifier } : {}) };
    }
    return out;
  };
  if (!source || typeof source !== "object" || Array.isArray(source)) return { ...EMPTY_CONFIG, errors: ["the file must hold one object with ctrl, commands and buttons"] };
  const config = source as Record<string, unknown>;
  for (const key of Object.keys(config)) if (key !== "ctrl" && key !== "commands" && key !== "buttons") errors.push(`unknown section "${key}"`);
  return { ctrl: list(config.ctrl, "ctrl", 1), commands: list(config.commands, "commands", 1), buttons: buttons(config.buttons), errors };
}
