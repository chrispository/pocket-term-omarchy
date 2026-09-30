// shared/keyseq.ts — the key notation the command menus are written in.
//
// A sequence is text with vim-style <...> keys in it:
//
//   git status<CR>          types the text, then Enter
//   <C-c><C-c>              Ctrl+C twice, back to back
//   <Esc><wait:75>:wq<CR>   Escape, a 75 ms pause, then :wq and Enter
//   <C-M-a> <S-Tab> <lt>    modifiers combine; <lt> is a literal "<"
//
// Keys that are "pressed together" are modifiers on one key: a terminal
// receives a byte stream, so Ctrl+C is the single byte ^C rather than two
// events. A wait is a pause between steps. The companion parses and plays the
// sequence beside the PTY, so waits are timed there and not stretched by the
// console's round trips; the device parses only to reject a bad config early.

import type { KeyName } from "./protocol.ts";

export type KeyStep =
  | { text: string }
  | { key: string; ctrl: boolean; alt: boolean; shift: boolean }
  | { wait: number };

export const KEYSEQ_LIMITS = { chars: 1024, steps: 256, waitMs: 5000, totalWaitMs: 10000 } as const;

const NAMES: Record<string, KeyName> = {
  cr: "Enter", enter: "Enter", return: "Enter",
  esc: "Escape", escape: "Escape",
  tab: "Tab", bs: "Backspace", backspace: "Backspace", space: "Space",
  up: "Up", down: "Down", left: "Left", right: "Right",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  del: "Delete", delete: "Delete", insert: "Insert",
};
for (let n = 1; n <= 12; n++) NAMES[`f${n}`] = `F${n}` as KeyName;

/** Parse a sequence into steps, or throw with the offending token. */
export function parseKeys(source: string): KeyStep[] {
  if (source.length > KEYSEQ_LIMITS.chars) throw new Error(`key sequence is longer than ${KEYSEQ_LIMITS.chars} characters`);
  const steps: KeyStep[] = [];
  let text = "", waited = 0;
  const flush = () => { if (text) { steps.push({ text }); text = ""; } };
  for (let at = 0; at < source.length;) {
    const ch = source[at];
    const close = ch === "<" ? source.indexOf(">", at + 1) : -1;
    if (close < 0) { text += ch; at++; continue; }
    const token = source.slice(at + 1, close);
    at = close + 1;
    const lower = token.toLowerCase();
    if (lower === "lt") { text += "<"; continue; }
    flush();
    const wait = /^wait:(\d+)$/.exec(lower);
    if (wait) {
      const ms = Number(wait[1]);
      if (ms > KEYSEQ_LIMITS.waitMs) throw new Error(`<${token}> waits longer than ${KEYSEQ_LIMITS.waitMs} ms`);
      waited += ms;
      if (waited > KEYSEQ_LIMITS.totalWaitMs) throw new Error(`waits add up to more than ${KEYSEQ_LIMITS.totalWaitMs} ms`);
      steps.push({ wait: ms });
      continue;
    }
    let ctrl = false, alt = false, shift = false, rest = token;
    for (let mod = /^([CMAS])-(.+)$/i.exec(rest); mod; mod = /^([CMAS])-(.+)$/i.exec(rest)) {
      const m = mod[1].toUpperCase();
      if (m === "C") ctrl = true; else if (m === "S") shift = true; else alt = true;
      rest = mod[2];
    }
    const named = NAMES[rest.toLowerCase()];
    if (named) steps.push({ key: named, ctrl, alt, shift });
    else if ([...rest].length === 1 && (ctrl || alt || shift)) steps.push({ key: shift && !ctrl ? rest.toUpperCase() : rest.toLowerCase(), ctrl, alt, shift: false });
    else throw new Error(`unknown key <${token}>`);
  }
  flush();
  if (steps.length > KEYSEQ_LIMITS.steps) throw new Error(`key sequence has more than ${KEYSEQ_LIMITS.steps} steps`);
  return steps;
}

/** Text as a sequence that types it literally. */
export function literalKeys(text: string): string {
  return text.replace(/</g, "<lt>");
}

/** A short caret form for a menu's right-hand column: ^C ^C, Esc :wq ⏎. */
export function describeKeys(source: string): string {
  let steps: KeyStep[];
  try { steps = parseKeys(source); } catch { return source; }
  const parts: string[] = [];
  for (const step of steps) {
    if ("text" in step) parts.push(step.text);
    else if ("key" in step) {
      const single = step.key.length === 1;
      const name = step.key === "Enter" ? "Enter" : step.key === "Escape" ? "Esc" : step.key;
      if (single && step.ctrl && !step.alt) parts.push(`^${step.key.toUpperCase()}`);
      else parts.push(`${step.ctrl ? "C-" : ""}${step.alt ? "M-" : ""}${step.shift ? "S-" : ""}${name}`);
    }
  }
  return parts.join(" ");
}
