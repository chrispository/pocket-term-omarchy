// app/buttons.ts — the configurable hardware buttons (shared/config.ts).
//
// A button taps a key sequence, holds a modifier, or both. A tap-only button
// fires on its press, as a key should. A button with both is dual-role, like
// A: holding it is Alt for everything sent meanwhile — touch keys, the
// d-pad, the other buttons — and only a press that nothing was sent under
// counts as the tap, which therefore fires on release.

import { BTN } from "@pocketjs/framework/input";
import { BUTTON_NAMES, type ButtonBinding, type ButtonName } from "../shared/config.ts";
import { parseKeys, type KeyStep } from "../shared/keyseq.ts";

export interface Mods { ctrl: boolean; alt: boolean; shift: boolean }
export const NO_MODS: Mods = { ctrl: false, alt: false, shift: false };

/** The 3DS host maps A/B/X/Y positionally onto the PSP-style names
 *  (vendor/pocketjs/hosts/3ds/src/input.c). */
export const BUTTON_MASKS: Record<ButtonName, number> = {
  A: BTN.CIRCLE, B: BTN.CROSS, X: BTN.TRIANGLE, Y: BTN.SQUARE,
  START: BTN.START, ZL: BTN.ZL, ZR: BTN.ZR,
};

export const sameMods = (a: Mods, b: Mods) => a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift;

export function createButtons(masks: Record<ButtonName, number> = BUTTON_MASKS) {
  /** Buttons holding a modifier, and whether anything was sent under them. */
  const down = new Map<ButtonName, { used: boolean }>();
  let bindings: Record<ButtonName, ButtonBinding> | undefined;

  const held = (): Mods => {
    const mods = { ...NO_MODS };
    for (const name of down.keys()) {
      const hold = bindings?.[name]?.hold;
      if (hold) mods[hold] = true;
    }
    return mods;
  };

  /** Something was sent: every button held now was a modifier, not a tap. */
  const use = () => { for (const state of down.values()) state.used = true; };

  return {
    held,
    use,
    /** Forget held buttons, as when a menu takes the buttons over; their
     *  releases then send nothing. */
    reset() { down.clear(); },
    /** One frame of button edges. Returns the taps to send, with the
     *  modifiers held by the other buttons at that moment. */
    frame(buttons: number, prev: number, current: Record<ButtonName, ButtonBinding>): { tap: string; mods: Mods }[] {
      bindings = current;
      const pressed = buttons & ~prev, released = prev & ~buttons;
      const taps: string[] = [];
      for (const name of BUTTON_NAMES) {
        const binding = current[name], mask = masks[name];
        if (binding.hold) {
          if (pressed & mask) down.set(name, { used: false });
          if (released & mask) {
            const state = down.get(name);
            down.delete(name);
            if (binding.tap && state && !state.used) taps.push(binding.tap);
          }
        } else if (binding.tap && pressed & mask) taps.push(binding.tap);
      }
      const mods = held();
      if (taps.length) use();
      return taps.map(tap => ({ tap, mods }));
    },
  };
}

const parsed = new Map<string, KeyStep[]>();

/** How to send a tap: one key or character goes as a key with the held
 *  modifiers added, so ZL+B is still Ctrl+Backspace; plain text goes as
 *  typing; anything longer is played by the companion as written. */
export function tapAction(sequence: string, mods: Mods):
  | { kind: "key"; key: string; ctrl: boolean; alt: boolean; shift: boolean }
  | { kind: "text"; text: string }
  | { kind: "keys"; sequence: string } {
  let steps = parsed.get(sequence);
  if (!steps) {
    try { steps = parseKeys(sequence); } catch { steps = []; }
    parsed.set(sequence, steps);
  }
  const moded = mods.ctrl || mods.alt || mods.shift;
  if (steps.length === 1) {
    const step = steps[0];
    if ("key" in step) return { kind: "key", key: step.key, ctrl: step.ctrl || mods.ctrl, alt: step.alt || mods.alt, shift: step.shift || mods.shift };
    if ("text" in step && step.text.length === 1 && moded) return { kind: "key", key: step.text, ctrl: mods.ctrl, alt: mods.alt, shift: mods.shift };
    if ("text" in step && !moded) return { kind: "text", text: step.text };
  }
  return { kind: "keys", sequence };
}
