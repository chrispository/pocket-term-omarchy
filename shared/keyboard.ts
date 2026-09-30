// shared/keyboard.ts — the touch keyboard's layout format. The layout itself
// is data in app/keyboard-layout.ts, written by `bun run keyboard`; this module
// holds its types, the geometry both the device and the editor measure with,
// the checks the editor runs before saving, and the serializer that writes
// the file back out.
//
// The layout stays a TypeScript module rather than JSON because the build's
// first pass only walks imported .ts/.tsx modules. The string literals in it
// are what put each label's glyphs into the baked atlas; a label read from a
// JSON file at runtime would render as tofu.

import type { KeyName } from "./protocol.ts";

/** Row height with the touchpad shown. Without it the keyboard takes the
 *  space the touchpad had, and rows grow to match (keyboardGeometry). */
export const KEY_H = 26;
/** 10 column units of 32 px = the 320 px auxiliary panel. */
export const UNIT = 32;
export const PANEL_UNITS = 10;

export type LayerName = string;

export type KeyAction =
  | { ch: string; ctrl?: boolean }
  | { key: KeyName }
  | { layer: LayerName }
  | { mod: "shift" | "ctrl" | "alt" }
  | { voice: true }
  | { settings: true }
  /** Opens the command menu the companion reads from its config. */
  | { commands: true }
  /** Empty space: drawn as nothing and dead to touch. Splits a row. */
  | { gap: true };

export interface KeyDef {
  label: string;
  /** Width in column units; 10 units fill a row. */
  w: number;
  act: KeyAction;
  /** Painted darker, like the classic keyboard's function keys. */
  dark?: boolean;
}

export interface KeyboardLayout {
  /** The terminal action strip, shown above every layer. */
  actionRow: KeyDef[];
  /** Character layers. `lower` is shown first; `upper` is the one-shot Shift
   *  layer, which falls back to `lower` after the next key. */
  layers: Record<LayerName, KeyDef[][]>;
}

/** Every layout the device can switch between, and the ones it starts with. */
export interface KeyboardConfig {
  defaults: { layout: string; touchpad: boolean };
  layouts: Record<string, KeyboardLayout>;
}

export const KEY_NAMES: readonly KeyName[] = [
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "Insert", "Enter", "Backspace", "Tab", "Escape", "Up", "Down", "Left", "Right",
  "Home", "End", "PageUp", "PageDown", "Delete", "Space",
];

/** Rows below the action strip in the tallest layer. */
export function layerRows(layout: KeyboardLayout): number {
  return Math.max(0, ...Object.values(layout.layers).map((rows) => rows.length));
}

/** Where the keyboard sits and how tall its rows are. The session tabs keep
 *  the top 26 px; the touchpad, when shown, keeps the band below them. */
export function keyboardGeometry(layout: KeyboardLayout, touchpad: boolean): { rows: number; keyH: number; top: number } {
  const rows = 1 + layerRows(layout);
  const keyH = touchpad ? KEY_H : Math.floor((240 - 26 - 4) / rows);
  return { rows, keyH, top: 240 - rows * keyH };
}

/** Width of a row in column units. */
export function rowUnits(row: readonly KeyDef[]): number {
  return row.reduce((sum, def) => sum + def.w, 0);
}

/** Problems that would make the layout misbehave on the device. Errors block
 *  saving; warnings are shown but allowed. */
export function checkLayout(layout: KeyboardLayout, name = ""): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const at = name ? `${name}: ` : "";
  const layerNames = Object.keys(layout.layers);
  if (!layout.layers.lower) errors.push(`a "lower" layer is required; the keyboard starts on it`);
  if (!layout.layers.upper) warnings.push(`no "upper" layer: Shift will have nowhere to go`);
  // The session tabs (26 px) share the 240 px panel with the keyboard, and
  // with the touchpad when it is shown.
  const { rows: rowCount, keyH } = keyboardGeometry(layout, false);
  if (keyH < 20) errors.push(`${rowCount} rows are only ${keyH} px tall even without the touchpad`);
  const height = rowCount * KEY_H;
  if (height > 240 - 26 - 24) warnings.push(`${rowCount} rows (${height} px) leave no room for the touchpad; use it with the touchpad off`);

  const rows: Array<[string, KeyDef[]]> = [["action strip", layout.actionRow]];
  for (const name of layerNames) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) errors.push(`layer name "${name}" must be a plain identifier`);
    layout.layers[name].forEach((row, i) => rows.push([`${name} row ${i + 1}`, row]));
  }
  for (const [where, row] of rows) {
    const units = rowUnits(row);
    if (units > PANEL_UNITS + 1e-9) errors.push(`${where} is ${units} units wide; the panel holds ${PANEL_UNITS}`);
    else if (units < PANEL_UNITS - 1e-9) warnings.push(`${where} is ${units} of ${PANEL_UNITS} units; touches past its end do nothing`);
    for (const def of row) {
      const act = def.act;
      if (!(def.w > 0)) errors.push(`${where}: "${def.label}" needs a positive width`);
      if (def.label === "" && !("gap" in act)) warnings.push(`${where}: a key has no label`);
      if ("ch" in act && act.ch.length === 0) errors.push(`${where}: "${def.label}" types nothing`);
      if ("key" in act && !KEY_NAMES.includes(act.key)) errors.push(`${where}: "${def.label}" sends unknown key ${act.key}`);
      if ("layer" in act && !layerNames.includes(act.layer)) errors.push(`${where}: "${def.label}" switches to missing layer "${act.layer}"`);
    }
  }
  const reachable = new Set(["lower", "upper"]);
  for (const row of [layout.actionRow, ...Object.values(layout.layers).flat()]) {
    for (const def of row) if ("layer" in def.act) reachable.add(def.act.layer);
  }
  for (const name of layerNames) if (!reachable.has(name)) warnings.push(`layer "${name}" has no key that switches to it`);
  return { errors: errors.map((e) => at + e), warnings: warnings.map((w) => at + w) };
}

export function checkConfig(config: KeyboardConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const names = Object.keys(config.layouts);
  if (names.length === 0) errors.push("there are no layouts");
  if (!config.layouts[config.defaults.layout]) errors.push(`the default layout "${config.defaults.layout}" does not exist`);
  for (const name of names) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) errors.push(`layout name "${name}" must be a plain identifier`);
    const result = checkLayout(config.layouts[name], name);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }
  return { errors, warnings };
}

const str = (s: string) => JSON.stringify(s);

function actSource(act: KeyAction): string {
  if ("ch" in act) return act.ctrl ? `{ ch: ${str(act.ch)}, ctrl: true }` : `{ ch: ${str(act.ch)} }`;
  if ("key" in act) return `{ key: ${str(act.key)} }`;
  if ("layer" in act) return `{ layer: ${str(act.layer)} }`;
  if ("mod" in act) return `{ mod: ${str(act.mod)} }`;
  if ("gap" in act) return `{ gap: true }`;
  if ("voice" in act) return `{ voice: true }`;
  if ("commands" in act) return `{ commands: true }`;
  return `{ settings: true }`;
}

function keySource(def: KeyDef): string {
  return `{ label: ${str(def.label)}, w: ${def.w}, act: ${actSource(def.act)}${def.dark ? ", dark: true" : ""} }`;
}

function rowSource(row: readonly KeyDef[], indent: string): string {
  if (row.length === 0) return "[]";
  return `[\n${row.map((def) => `${indent}  ${keySource(def)},\n`).join("")}${indent}]`;
}

const ident = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : str(name);

/** A layout as an object literal whose closing brace sits at `indent`. */
function layoutBody(layout: KeyboardLayout, indent: string): string {
  const i1 = indent + "  ", i2 = i1 + "  ", i3 = i2 + "  ";
  const layers = Object.entries(layout.layers)
    .map(([name, rows]) => `${i2}${ident(name)}: [\n${rows.map((row) => `${i3}${rowSource(row, i3)},\n`).join("")}${i2}],\n`)
    .join("");
  return `{\n${i1}actionRow: ${rowSource(layout.actionRow, i1)},\n${i1}layers: {\n${layers}${i1}},\n${indent}}`;
}

/** The complete source of app/keyboard-layout.ts. */
export function configSource(config: KeyboardConfig): string {
  const layouts = Object.entries(config.layouts).map(([name, layout]) => `    ${ident(name)}: ${layoutBody(layout, "    ")},\n`).join("");
  return `// app/keyboard-layout.ts — the touch keyboard's keys. Written by
// \`bun run keyboard\` (scripts/keyboard-editor.ts); hand edits are fine and
// survive a round trip, but comments and formatting do not. The format and its
// checks are in shared/keyboard.ts.

import type { KeyboardConfig } from "../shared/keyboard.ts";

export const KEYBOARD: KeyboardConfig = {
  defaults: { layout: ${str(config.defaults.layout)}, touchpad: ${config.defaults.touchpad} },
  layouts: {
${layouts}  },
};
`;
}
