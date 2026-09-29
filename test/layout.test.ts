import { expect, test } from "bun:test";
import { TERM_FONT, TERM_FONTS } from "../app/font.generated.ts";
import { TERM_LAYOUT } from "../shared/layout.ts";
import { readFileSync } from "node:fs";
import { keyAt, type LayerName } from "../app/keyboard.tsx";
import { KEYBOARD } from "../app/keyboard-layout.ts";
import { checkConfig, configSource, keyboardGeometry, type KeyDef } from "../shared/keyboard.ts";
import type { KeyName } from "../shared/protocol.ts";
import { terminalFont } from "../scripts/font.ts";
import { loadBitmapFont, type TerminalFontName } from "../shared/font-sources.ts";
import { bitmapCell } from "../shared/bitmap-font.ts";
import { bakeBitmapAtlas } from "../host/glyphs.ts";

test("the shipped atlas and 80 x 24 grid reach all four screen edges", () => {
  const bytes = Buffer.from(TERM_FONT, "base64"), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(bytes).toEqual(Buffer.from(terminalFont()));
  expect([bytes[8], bytes[9], bytes[11], bytes[12]]).toEqual([5, 10, 10, 16]);
  expect(TERM_LAYOUT.cols * bytes[8]).toBe(400); expect(TERM_LAYOUT.rows * bytes[9]).toBe(240);
  for (let i = 0; i < view.getUint16(6, true); i++) expect(bytes[16 + i * 8 + 6]).toBe(5);
});

test("every keyboard layout covers the touch panel, with reachable function and modifier keys", () => {
  // Structural rather than positional, so a layout edited with `bun run keyboard`
  // keeps passing as long as it stays usable. Gap keys are the one deliberate
  // dead zone.
  for (const [name, layout] of Object.entries(KEYBOARD.layouts)) {
    for (const [layer, rows] of Object.entries(layout.layers) as [LayerName, KeyDef[][]][]) {
      for (const [row, keys] of [layout.actionRow, ...rows].entries()) {
        let x = 0;
        for (const def of keys) {
          const hit = keyAt(layout, layer, x * 32 + 1, row * 26 + 13);
          if ("gap" in def.act) expect(hit).toBeNull();
          else expect(hit?.def).toBe(def);
          x += def.w;
        }
        expect(x, `${name}/${layer} row ${row}`).toBe(10);
      }
    }
    const acts = [layout.actionRow, ...Object.values(layout.layers).flat()].flat().map((def) => def.act);
    for (let n = 1; n <= 12; n++) expect(acts).toContainEqual({ key: `F${n}` as KeyName });
    const strip = layout.actionRow.map((def) => def.act);
    expect(strip).toContainEqual({ settings: true });
    expect(strip).toContainEqual({ mod: "alt" });
    expect(strip).toContainEqual({ mod: "ctrl" });
    expect(strip.some(act => "key" in act && ["Up", "Down", "Left", "Right"].includes(act.key))).toBe(false);
  }
});

test("without the touchpad the keyboard grows into its band and keeps clear of the tabs", () => {
  for (const layout of Object.values(KEYBOARD.layouts)) {
    const on = keyboardGeometry(layout, true), off = keyboardGeometry(layout, false);
    expect(on.keyH).toBe(26);
    expect(off.keyH).toBeGreaterThan(on.keyH);
    expect(off.top).toBeGreaterThanOrEqual(26);
    expect(off.top + off.rows * off.keyH).toBe(240);
    expect(keyAt(layout, "lower", 1, off.keyH / 2, off.keyH)?.row).toBe(0);
  }
});

test("the keyboard layouts pass the editor's checks and are written back unchanged", () => {
  expect(checkConfig(KEYBOARD).errors).toEqual([]);
  expect(configSource(KEYBOARD)).toBe(readFileSync(new URL("../app/keyboard-layout.ts", import.meta.url), "utf8"));
});

test("box and block ink reaches adjacent cells without font-metric gaps", () => {
  const bytes = terminalFont(), view = new DataView(bytes.buffer), n = view.getUint16(6, true);
  const glyph = (ch: string) => {
    for (let i = 0; i < n; i++) if (view.getUint32(16 + i * 8, true) === ch.codePointAt(0)) {
      const offset = 16 + n * 8 + view.getUint16(20 + i * 8, true) * 50; return bytes.slice(offset, offset + 50);
    }
    throw new Error(`Missing ${ch}`);
  };
  expect([...glyph("█")].every(a => a === 255)).toBe(true);
  expect([...glyph("─").slice(20, 25)]).toEqual([255, 255, 255, 255, 255]);
  expect(Array.from({ length: 10 }, (_, y) => glyph("│")[y * 5 + 2])).toEqual(Array(10).fill(255));
});

test("all three terminal faces preserve the source's ASCII bitmap and have no antialiasing samples", () => {
  for (const name of Object.keys(TERM_FONTS) as TerminalFontName[]) {
    const b = Buffer.from(TERM_FONTS[name], "base64"), v = new DataView(b.buffer, b.byteOffset, b.byteLength), n = v.getUint16(6, true);
    const source = loadBitmapFont(name);
    expect(b).toEqual(Buffer.from(terminalFont(name)));
    expect([...b.subarray(16 + n * 8)].every(a => a === 0 || a === 255)).toBe(true);
    for (let i = 0; i < n; i++) {
      const cp = v.getUint32(16 + i * 8, true), gid = v.getUint16(20 + i * 8, true);
      if (cp >= 32 && cp <= 126) expect(b.subarray(16 + n * 8 + gid * 50, 16 + n * 8 + (gid + 1) * 50)).toEqual(Buffer.from(bitmapCell(source, cp)!));
    }
  }
});

test("Fusion Pixel CJK keeps its complete 10x10 cell next to a narrow dynamic glyph", () => {
  const source = loadBitmapFont("fusion");
  const b = bakeBitmapAtlas(source, 19, new Map([["你".codePointAt(0)!, 2], ["é".codePointAt(0)!, 1]]), 5, 10);
  const v = new DataView(b.buffer), n = v.getUint16(6, true);
  expect([b[8], b[9]]).toEqual([10, 10]);
  for (let i = 0; i < n; i++) {
    const cp = v.getUint32(16 + i * 8, true), gid = v.getUint16(20 + i * 8, true);
    if (cp === "你".codePointAt(0)) { expect(b[22 + i * 8]).toBe(10); expect([...b.slice(16 + n * 8 + gid * 100, 16 + n * 8 + (gid + 1) * 100)]).toEqual([...bitmapCell(source, cp, 10, 10)!]); }
  }
});
