// app/buttons.ts — the configurable hardware buttons (shared/config.ts).
//
// A button taps (a key sequence or an app action), holds a modifier, or
// both. A tap-only button fires on its press. A button with both is
// dual-role, like A: for its first holdMs it is still a tap, so a key that
// arrives in that window sends the tap first and then itself, unmodified;
// after holdMs it is the modifier for everything sent until release. A
// press with nothing sent under it is the tap, sent on release.
//
// A button that belongs to a combo waits comboMs after its press before it
// does anything. If the rest of a combo goes down inside that window the
// combo fires and none of its buttons do their own job for that press.

import { BTN } from "@pocketjs/framework/input";
import { BUTTON_NAMES, type ButtonAction, type ButtonBinding, type ButtonName, type TermConfig } from "../shared/config.ts";
import { parseKeys, type KeyStep } from "../shared/keyseq.ts";

export interface Mods { ctrl: boolean; alt: boolean; shift: boolean }
export const NO_MODS: Mods = { ctrl: false, alt: false, shift: false };

/** The 3DS host maps A/B/X/Y positionally onto the PSP-style names
 *  (vendor/pocketjs/hosts/3ds/src/input.c). */
export const BUTTON_MASKS: Record<ButtonName, number> = {
  A: BTN.CIRCLE, B: BTN.CROSS, X: BTN.TRIANGLE, Y: BTN.SQUARE,
  L: BTN.LTRIGGER, R: BTN.RTRIGGER, ZL: BTN.ZL, ZR: BTN.ZR,
  START: BTN.START, SELECT: BTN.SELECT,
};

export const sameMods = (a: Mods, b: Mods) => a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift;

/** What a button, combo or resolved hold asks the app to do. */
export type ButtonEvent =
  | { kind: "tap"; tap: string; mods: Mods }
  | { kind: "action"; action: ButtonAction };

type Settings = Pick<TermConfig, "buttons" | "combos" | "timing">;

interface Press {
  at: number;
  /** pending: waiting out comboMs · down: doing its job · combo: spent on a
   *  combo, silent until released. */
  phase: "pending" | "down" | "combo";
  /** Something was sent while this dual-role button was the modifier. */
  used: boolean;
  /** This dual-role button already sent its tap. */
  tapped: boolean;
}

const dual = (b: ButtonBinding) => !!b.hold && (b.tap !== undefined || b.action !== undefined);

export function createButtons(masks: Record<ButtonName, number> = BUTTON_MASKS) {
  const presses = new Map<ButtonName, Press>();
  let settings: Settings | undefined;
  let events: ButtonEvent[] = [];

  const holdMs = (name: ButtonName) => settings!.buttons[name].holdMs ?? settings!.timing.holdMs;
  const inCombo = (name: ButtonName) => settings!.combos.some(c => c.buttons.includes(name));

  const held = (now: number): Mods => {
    const mods = { ...NO_MODS };
    if (!settings) return mods;
    for (const [name, press] of presses) {
      const binding = settings.buttons[name];
      if (press.phase !== "down" || !binding.hold) continue;
      if (!dual(binding) || (!press.tapped && (press.used || now - press.at >= holdMs(name)))) mods[binding.hold] = true;
    }
    return mods;
  };

  const fire = (binding: { tap?: string; action?: ButtonAction }, now: number) => {
    if (binding.action) events.push({ kind: "action", action: binding.action });
    else if (binding.tap) events.push({ kind: "tap", tap: binding.tap, mods: held(now) });
  };

  /** Something is about to be sent at `now`: each dual-role button still
   *  inside its holdMs becomes its tap (sent first); each past it becomes
   *  the modifier. */
  const commit = (now: number) => {
    if (!settings) return;
    for (const [name, press] of presses) {
      const binding = settings.buttons[name];
      if (press.phase !== "down" || !dual(binding) || press.used || press.tapped) continue;
      if (now - press.at < holdMs(name)) { press.tapped = true; fire(binding, now); }
      else press.used = true;
    }
  };

  const start = (name: ButtonName, press: Press, now: number) => {
    press.phase = "down";
    const binding = settings!.buttons[name];
    if (binding.hold) return;
    commit(now);
    fire(binding, now);
  };

  const finish = (name: ButtonName, press: Press, now: number) => {
    const binding = settings!.buttons[name];
    if (dual(binding) && !press.used && !press.tapped) fire(binding, now);
  };

  const drain = () => { const out = events; events = []; return out; };

  return {
    held,
    /** Call before sending anything that is not a button: returns the taps
     *  of dual-role buttons it resolves, to send first. */
    beforeSend(now: number): ButtonEvent[] { commit(now); return drain(); },
    /** Forget held buttons, as when a menu takes the buttons over; their
     *  releases then send nothing. */
    reset() { presses.clear(); events = []; },
    /** One frame of button edges, in milliseconds of virtual time. */
    frame(buttons: number, prev: number, current: Settings, now: number): ButtonEvent[] {
      settings = current;
      const pressed = buttons & ~prev, released = prev & ~buttons;
      for (const name of BUTTON_NAMES) {
        if (!(pressed & masks[name])) continue;
        const press: Press = { at: now, phase: "pending", used: false, tapped: false };
        presses.set(name, press);
        if (!inCombo(name)) start(name, press, now);
      }
      // Larger combos first, so L+R+Y is not read as L+R.
      for (const combo of [...current.combos].sort((a, b) => b.buttons.length - a.buttons.length)) {
        const members = combo.buttons.map(name => presses.get(name));
        if (members.some(p => !p || p.phase !== "pending")) continue;
        const times = members.map(p => p!.at);
        if (Math.max(...times) - Math.min(...times) > current.timing.comboMs) continue;
        for (const p of members) p!.phase = "combo";
        commit(now);
        fire(combo, now);
      }
      for (const [name, press] of presses) {
        if (press.phase === "pending" && now - press.at >= current.timing.comboMs) start(name, press, now);
      }
      for (const name of BUTTON_NAMES) {
        if (!(released & masks[name])) continue;
        const press = presses.get(name);
        presses.delete(name);
        if (!press || press.phase === "combo") continue;
        // Released inside the combo window: it was a quick press after all.
        if (press.phase === "pending") start(name, press, now);
        finish(name, press, now);
      }
      return drain();
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
