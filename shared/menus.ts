// shared/menus.ts — the ctrl and >_ menus, from the companion's config file
// to the lists the console draws.
//
// The file lives on the computer (host/menus.ts finds it), so editing a menu
// needs no rebuild and no ftpd copy. The companion checks it here, reduces
// every entry to a label, a right-hand detail and one key sequence
// (shared/keyseq.ts), and sends the result to the console on connect and on
// every save. A mistake in the file is reported rather than fatal: the entry
// is dropped and the menu says so.

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

export interface MenuConfigSource {
  ctrl?: MenuSource[];
  commands?: MenuSource[];
}

/** One entry as the console draws it: a leaf sends `keys`, a branch opens
 *  `items`. */
export interface MenuItem {
  label: string;
  detail: string;
  keys?: string;
  items?: MenuItem[];
}

export interface Menus {
  ctrl: MenuItem[];
  commands: MenuItem[];
  /** Problems found in the file, for the menu's footer and the daemon log. */
  errors: string[];
}

export const MENU_LIMITS = { label: 32, detail: 40, items: 48, total: 400, depth: 4, chars: 32768 } as const;

/** The console draws config text from its baked atlas, which is guaranteed
 *  to hold printable ASCII (app/menus.tsx carries the literal that bakes
 *  it). Anything else would draw as a blank box, so it is replaced up front
 *  and reported. */
const PRINTABLE = /^[\x20-\x7e]*$/;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function buildMenus(source: unknown): Menus {
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
    if (value.length > MENU_LIMITS.items) errors.push(`${where} has ${value.length} entries; the first ${MENU_LIMITS.items} are used`);
    const out: MenuItem[] = [];
    value.slice(0, MENU_LIMITS.items).forEach((raw: unknown, n) => {
      const at = `${where}[${n}]`;
      if (!raw || typeof raw !== "object") { errors.push(`${at} must be an object`); return; }
      const item = raw as Record<string, unknown>;
      if (typeof item.label !== "string" || item.label.trim() === "") { errors.push(`${at} needs a label`); return; }
      const name = `${where} > ${item.label}`;
      const kinds = (["run", "type", "keys", "items"] as const).filter(k => item[k] !== undefined);
      if (kinds.length !== 1) { errors.push(`${name}: needs exactly one of run, type, keys or items`); return; }
      if (++total > MENU_LIMITS.total) { if (total === MENU_LIMITS.total + 1) errors.push(`more than ${MENU_LIMITS.total} entries; the rest are dropped`); return; }
      const label = text(item.label, name, MENU_LIMITS.label);
      if (item.hint !== undefined && typeof item.hint !== "string") { errors.push(`${name}: hint must be text`); return; }
      if (kinds[0] === "items") {
        if (depth >= MENU_LIMITS.depth) { errors.push(`${name}: menus nest at most ${MENU_LIMITS.depth} deep`); return; }
        const items = list(item.items, name, depth + 1);
        out.push({ label, detail: text(item.hint ?? `${items.length}`, name, MENU_LIMITS.detail), items });
        return;
      }
      const value = item[kinds[0]];
      if (typeof value !== "string" || value === "") { errors.push(`${name}: ${kinds[0]} must be text`); return; }
      const keys = kinds[0] === "keys" ? value : kinds[0] === "run" ? `${literalKeys(value)}<CR>` : literalKeys(value);
      try { parseKeys(keys); } catch (error) { errors.push(`${name}: ${(error as Error).message}`); return; }
      const detail = item.hint ?? (kinds[0] === "keys" ? describeKeys(value) : value);
      out.push({ label, detail: text(detail, name, MENU_LIMITS.detail), keys });
    });
    return out;
  };
  if (!source || typeof source !== "object" || Array.isArray(source)) return { ctrl: [], commands: [], errors: ["the file must hold one object with ctrl and commands lists"] };
  const config = source as Record<string, unknown>;
  for (const key of Object.keys(config)) if (key !== "ctrl" && key !== "commands") errors.push(`unknown section "${key}"`);
  return { ctrl: list(config.ctrl, "ctrl", 1), commands: list(config.commands, "commands", 1), errors };
}
