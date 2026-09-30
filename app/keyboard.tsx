// app/keyboard.tsx — the bottom-screen touch keyboard. The framework
// Osk renders through Portal, which sizes itself from the PRIMARY viewport,
// so a touch keyboard on the 3DS bottom screen is laid out by hand instead:
// a fixed grid of 26 px rows on a 32 px column unit (10 units = the 320 px
// panel), hit by one auxiliary-surface gesture on the keyboard root.
//
// Row 0 is the terminal action strip (Esc/Tab/Ctrl/Alt/dictation/settings/commands); the
// rows below it are the character layers. The keys themselves are data in
// ./keyboard-layout.ts, edited with `bun run keyboard`. Shift and Ctrl are
// one-shot: they arm, the next key consumes them — the classic touch-phone
// convention, and the only one that works with a single resistive contact.
// Ctrl arms on release rather than on touch, because holding it instead
// opens the ctrl menu.

import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { KEY_H, UNIT, type KeyboardLayout, type KeyDef, type LayerName } from "../shared/keyboard.ts";
import type { DictationState } from "./dictation.ts";

export { KEY_H };
export type { KeyAction, LayerName } from "../shared/keyboard.ts";

interface KeyHit {
  row: number;
  index: number;
  def: KeyDef;
}

/** The action strip, then the layer's rows. Shorter layers leave a gap. */
function rowsFor(layout: KeyboardLayout, name: LayerName): KeyDef[][] {
  return [layout.actionRow, ...(layout.layers[name] ?? [])];
}

/** Key under a point in keyboard-local coordinates, or null in a gap. */
export function keyAt(layout: KeyboardLayout, layerName: LayerName, x: number, y: number, keyH = KEY_H): KeyHit | null {
  const row = Math.floor(y / keyH);
  const rows = rowsFor(layout, layerName);
  if (row < 0 || row >= rows.length) return null;
  let at = 0;
  for (let index = 0; index < rows[row].length; index += 1) {
    const def = rows[row][index];
    const width = def.w * UNIT;
    if (x >= at && x < at + width) return "gap" in def.act ? null : { row, index, def };
    at += width;
  }
  return null;
}

/** Graphite draws lit caps set into sockets; Hairline draws no caps, only a
 *  1 px grid between the legends. */
export type KeyboardTheme = "hairline" | "graphite";
export const KEYBOARD_THEMES: readonly KeyboardTheme[] = ["hairline", "graphite"];

export interface KeyboardProps {
  layout: KeyboardLayout;
  theme: KeyboardTheme;
  top: number;
  rows: number;
  keyH: number;
  onSettings: () => void;
  onCommands: () => void;
  /** Ctrl was held rather than tapped. */
  onCtrlMenu: () => void;
  onVoice: () => void;
  voiceState: DictationState;
  onChar: (ch: string) => void;
  /** `name` is a KeyName, or a single character when ctrl is held. */
  onKey: (name: string, ctrl: boolean, alt: boolean, shift: boolean) => void;
  /** One-shot Ctrl arms here; the next character key consumes it. */
  ctrlArmed: () => boolean;
  setCtrlArmed: (on: boolean) => void;
  /** Alt and Shift held on hardware buttons (A holds Alt by default). */
  altHeld: () => boolean;
  shiftHeld: () => boolean;
  /** Called before a key is sent, so a hardware button still inside its
   *  hold time can send its own tap first and stop counting as held. */
  beforeKey: () => void;
  /** How long ctrl is held to open the ctrl menu (config timing). */
  ctrlMenuSeconds: number;
}

export function Keyboard(props: KeyboardProps) {
  const [layerName, setLayerName] = createSignal<LayerName>("lower");
  const [altArmed, setAltArmed] = createSignal(false);
  const [pressed, setPressed] = createSignal<string | null>(null);
  let rootNode: NodeMirror | undefined;
  let releaseTimer = 0;
  /** Ctrl is down and has not yet been a tap or a hold. */
  let ctrlDown = false;
  // Another layout may not have the layer this one was on.
  createEffect(on(() => props.layout, () => setLayerName("lower"), { defer: true }));
  const rowIndices = createMemo(() => Array.from({ length: props.rows }, (_, row) => row));

  const press = (hit: KeyHit) => {
    setPressed(`${hit.row}:${hit.index}`);
    releaseTimer = 4;
    const act = hit.def.act;
    if ("settings" in act) { props.onSettings();
    } else if ("commands" in act) {
      props.onCommands();
    } else if ("voice" in act) {
      props.onVoice();
    } else if ("ch" in act) {
      props.beforeKey();
      const alt = altArmed() || props.altHeld();
      if (act.ctrl || props.ctrlArmed() || alt) {
        props.onKey(act.ch, !!act.ctrl || props.ctrlArmed(), alt, false);
        setAltArmed(false);
        props.setCtrlArmed(false);
      } else {
        props.onChar(props.shiftHeld() ? act.ch.toUpperCase() : act.ch);
      }
      if (layerName() === "upper") setLayerName("lower"); // one-shot shift
    } else if ("key" in act) {
      props.beforeKey();
      props.onKey(act.key, props.ctrlArmed(), altArmed() || props.altHeld(), layerName() === "upper" || props.shiftHeld());
      setAltArmed(false);
      if (layerName() === "upper") setLayerName("lower");
      props.setCtrlArmed(false);
    } else if ("layer" in act) {
      setLayerName(act.layer);
    } else if ("mod" in act) {
      if (act.mod === "shift") setLayerName(layerName() === "upper" ? "lower" : "upper");
      else if (act.mod === "alt") setAltArmed(!altArmed());
      else ctrlDown = true;
    }
  };

  createGesture({
    surface: "auxiliary",
    region: { node: () => rootNode },
    // A getter: the gesture reads it each frame, so a saved config applies
    // without remounting the keyboard.
    get longPressSeconds() { return props.ctrlMenuSeconds; },
    onDown: (contact) => {
      ctrlDown = false;
      const hit = keyAt(props.layout, layerName(), contact.x, contact.y - props.top, props.keyH);
      if (hit) press(hit);
    },
    onLongPress: () => {
      if (!ctrlDown) return;
      ctrlDown = false;
      props.setCtrlArmed(false);
      props.onCtrlMenu();
    },
    onUp: () => {
      if (ctrlDown) props.setCtrlArmed(!props.ctrlArmed());
      ctrlDown = false;
    },
    onCancel: () => { ctrlDown = false; },
  });

  // The pressed flash decays on a frame budget.
  onFrame(() => {
    if (releaseTimer > 0 && --releaseTimer === 0) setPressed(null);
  });

  return (
    <View
      ref={(node) => (rootNode = node)}
      // Graphite: the plate the keys are set into, lit from the same
      // direction they are — a hairline along the top edge and a shallow fall
      // to the bottom. Hairline: the panel's own black.
      class={props.theme === "hairline" ? "absolute left-0 right-0 bg-[#0b0c0e]" : "absolute left-0 right-0 bg-gradient-to-b from-[#2a323e] via-[#161c26] to-[#10151d]"}
      style={{ insetT: props.top, height: props.rows * props.keyH, gradViaPos: 0.06 }}
      debugName="TermKeyboard"
    >
      {/* The rows have no container of their own: every key is placed
          absolutely in the plate, so a row is an offset rather than a node.
          Mount depth is what the JS stack is spent on (hosts/3ds/src/qjs.c
          POCKETJS_JS_STACK_SIZE), and a wrapper that only holds a y offset is
          the kind of level worth not spending it on. The theme switch sits
          above the rows, once, and a Hairline key is one view shallower than
          a Graphite cap in its socket. */}
      <Show
        when={props.theme === "hairline"}
        fallback={
          <For each={rowIndices()}>
            {(row) => (
              <KeyboardRow
                row={row}
                keys={rowsFor(props.layout, layerName())[row] ?? []}
                keyH={props.keyH}
                pressed={pressed()}
                ctrlArmed={props.ctrlArmed()}
                altArmed={altArmed() || props.altHeld()}
                voiceState={props.voiceState}
              />
            )}
          </For>
        }
      >
        <For each={rowIndices()}>
          {(row) => (
            <HairlineRow
              row={row}
              keys={rowsFor(props.layout, layerName())[row] ?? []}
              keyH={props.keyH}
              pressed={pressed()}
              ctrlArmed={props.ctrlArmed()}
              altArmed={altArmed() || props.altHeld()}
              voiceState={props.voiceState}
            />
          )}
        </For>
      </Show>
    </View>
  );
}

/** Longer labels ("settings") take the small size: the action row splits the
 *  panel seven ways, 45 or 46 px a key. */
const LONG_LABEL = 5;

/** How far the cap travels into its socket, and the lip it leaves showing. */
const KEY_LIP = 2;

/**
 * The cap's face: a vertical three-stop gradient standing in for a lit,
 * slightly domed surface. Resting, the top stop is the specular edge, the
 * middle is the body and the bottom is where the cap turns away from the
 * light. Pressed, the whole face darkens — a cap sunk into its socket is in
 * shadow — and the stops run the other way, leaving the only light along the
 * bottom edge. Darkening alone reads as "disabled" and flipping alone reads as
 * "highlighted"; together they read as pushed in.
 */
function capClass(down: boolean, dark: boolean, armed: boolean): string {
  // Every branch is a whole literal. The compiler collects class strings from
  // the source at build time and the device looks them up in a baked table, so
  // a string assembled at runtime — a template, a join — is one the table has
  // never seen, and the node ends up with no style at all.
  if (armed) {
    return "absolute left-0 right-0 rounded-[4] items-center justify-center bg-gradient-to-b from-[#8cc2ff] via-[#4c9bf5] to-[#2f6fbe]";
  }
  if (down) {
    return dark
      ? "absolute left-0 right-0 rounded-[4] items-center justify-center bg-gradient-to-b from-[#0d1118] via-[#141922] to-[#28303b]"
      : "absolute left-0 right-0 rounded-[4] items-center justify-center bg-gradient-to-b from-[#151a22] via-[#1d242e] to-[#343d4a]";
  }
  return dark
    ? "absolute left-0 right-0 rounded-[4] items-center justify-center bg-gradient-to-b from-[#4b5768] via-[#2a323d] to-[#1c222b]"
    : "absolute left-0 right-0 rounded-[4] items-center justify-center bg-gradient-to-b from-[#5f6c7f] via-[#3a4351] to-[#2a323e]";
}

/** A row's drawn keys and their x offsets. Gaps take width but no node. */
function placeKeys(keys: readonly KeyDef[]): Array<{ def: KeyDef; index: number; left: number }> {
  const placed: Array<{ def: KeyDef; index: number; left: number }> = [];
  let left = 0;
  keys.forEach((def, index) => {
    if (!("gap" in def.act)) placed.push({ def, index, left });
    left += def.w * UNIT;
  });
  return placed;
}

function KeyboardRow(props: {
  row: number;
  keys: KeyDef[];
  keyH: number;
  pressed: string | null;
  ctrlArmed: boolean;
  altArmed: boolean;
  voiceState: KeyboardProps["voiceState"];
}) {
  const placed = createMemo(() => placeKeys(props.keys));
  // Rows taller than the touchpad-on 26 px have room for the larger label,
  // unless the label is too long for a seventh of the panel.
  const big = () => props.keyH >= 34;
  return (
    <For each={placed()}>
      {({ def, index, left }) => {
        const isPressed = createMemo(() => props.pressed === `${props.row}:${index}`);
        const isArmedCtrl = () => "mod" in def.act && (def.act.mod === "ctrl" && props.ctrlArmed || def.act.mod === "alt" && props.altArmed);
        const isVoice = "voice" in def.act;
        const voiceActive = () => isVoice && (props.voiceState === "starting" || props.voiceState === "recording");
        const label = () => isVoice ? voiceKeyLabel(props.voiceState) : def.label;
        const down = createMemo(() => isPressed() || isArmedCtrl() || voiceActive());
        return (
          // The socket: a dark recess the cap sits in. Unpressed, the cap
          // covers all but the bottom lip, and that sliver of shadow is what
          // makes the key look like it stands above the plate.
          <View
            class="absolute rounded-[4] bg-[#080b11]"
            style={{
              insetL: left + 2,
              width: def.w * UNIT - 4,
              height: props.keyH - 4,
              insetT: props.row * props.keyH + 2,
            }}
          >
            <View
              class={capClass(down(), def.dark === true, isArmedCtrl())}
              // Pressing moves the cap down into the socket, so the lip of
              // shadow appears above it instead of below. The middle stop sits
              // near whichever edge the light is on, which keeps the specular
              // band thin instead of letting it wash over half the face.
              style={{
                insetT: down() ? KEY_LIP : 0,
                height: props.keyH - 4 - KEY_LIP,
                gradViaPos: down() ? 0.82 : 0.18,
              }}
            >
              <Text class={labelClass(down(), big() && label().length <= LONG_LABEL)}>{label()}</Text>
            </View>
          </View>
        );
      }}
    </For>
  );
}

/**
 * A Hairline key: no cap, only its legend and the 1 px rule it shares with
 * its neighbours. Each cell draws a full inset border one pixel larger than
 * its slot and one pixel up and left, so adjacent borders land on the same
 * pixel and every rule is single; the leftmost and bottom rules fall off the
 * panel, and the top row's rule is the line under the session tabs. A press
 * lifts the cell's background; an armed modifier inverts it.
 */
function HairlineRow(props: {
  row: number;
  keys: KeyDef[];
  keyH: number;
  pressed: string | null;
  ctrlArmed: boolean;
  altArmed: boolean;
  voiceState: KeyboardProps["voiceState"];
}) {
  const placed = createMemo(() => placeKeys(props.keys));
  const big = () => props.keyH >= 34;
  return (
    <For each={placed()}>
      {({ def, index, left }) => {
        const isPressed = createMemo(() => props.pressed === `${props.row}:${index}`);
        const isVoice = "voice" in def.act;
        const armed = () => "mod" in def.act && (def.act.mod === "ctrl" && props.ctrlArmed || def.act.mod === "alt" && props.altArmed) ||
          isVoice && (props.voiceState === "starting" || props.voiceState === "recording");
        const label = () => isVoice ? voiceKeyLabel(props.voiceState) : def.label;
        return (
          <View
            class={hairCellClass(isPressed(), armed())}
            style={{ insetL: left - 1, width: def.w * UNIT + 1, insetT: props.row * props.keyH - 1, height: props.keyH + 1 }}
          >
            <Text class={hairLabelClass(def.dark === true, "commands" in def.act, armed(), big() && label().length <= LONG_LABEL)}>{label()}</Text>
          </View>
        );
      }}
    </For>
  );
}

function hairCellClass(down: boolean, armed: boolean): string {
  if (armed) return "absolute items-center justify-center border border-[#23262b] bg-[#e8e8e8]";
  if (down) return "absolute items-center justify-center border border-[#23262b] bg-[#1c1f24]";
  return "absolute items-center justify-center border border-[#23262b]";
}

/** Letters are light and large; function keys are grey; the command key's
 *  prompt glyph is monospace. */
function hairLabelClass(dark: boolean, mono: boolean, armed: boolean, big: boolean): string {
  if (armed) return big ? "text-sm text-[#0b0c0e]" : "text-xs text-[#0b0c0e]";
  if (mono) return big ? "text-sm font-mono text-[#7d848f]" : "text-xs font-mono text-[#7d848f]";
  if (dark) return big ? "text-sm text-[#7d848f]" : "text-xs text-[#7d848f]";
  return big ? "text-base text-[#e8e8e8]" : "text-sm text-[#e8e8e8]";
}

function voiceKeyLabel(state: KeyboardProps["voiceState"]): string {
  if (state === "ready" || state === "starting" || state === "recording") return "voice";
  if (state === "finishing" || state === "transcribing") return "wait";
  if (state === "done") return "done";
  if (state === "empty") return "empty";
  if (state === "link-error") return "link?";
  if (state === "session-error") return "term?";
  if (state === "microphone-error") return "mic?";
  if (state === "host-error" || state === "error") return "host?";
  if (state === "transcription-error") return "voice?";
  if (state === "unavailable") return "n/a";
  return "voice";
}

function labelClass(down: boolean, big: boolean): string {
  if (big) return down ? "text-sm text-[#c3d0e2]" : "text-sm text-[#dfe6f2]";
  return down ? "text-xs text-[#c3d0e2]" : "text-xs text-[#dfe6f2]";
}
