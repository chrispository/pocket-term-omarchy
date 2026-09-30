// app/menus.tsx — the ctrl menu (hold ctrl) and the command menu (>_).
//
// Both are lists from the companion's config file (shared/config.ts). A leaf
// sends its key sequence and closes the menu; a branch opens its submenu.
// The command menu's top level lays out as tiles when it has four or fewer
// groups. Touch, the d-pad and A/B all work: tap or A runs the selection, B
// goes back a level and closes at the top.

import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import type { MenuItem } from "../shared/config.ts";
import { FOOT_H, HEAD_H, LIST_TOP, PANEL_TOP, ROW_H, SLOT_MONO_XS, SLOT_SM, SLOT_XS, VISIBLE_ROWS, fitCrumbs, fitEnd, textWidth } from "./panel.ts";

const TILE_MAX = 4;
const LABEL_LEFT = 12;
const DPAD_DELAY = 18;
const DPAD_REPEAT = 4;

interface Level { label: string; items: MenuItem[]; sel: number; top: number }

export interface MenuPanelProps {
  /** The first breadcrumb: "ctrl" or ">_". */
  root: string;
  items: MenuItem[];
  /** Lay a short top level out as tiles. */
  tiles: boolean;
  /** Problems the companion found in the config file. */
  errors: number;
  onSend(keys: string): void;
  onClose(): void;
}

export function MenuPanel(props: MenuPanelProps) {
  // The levels above the one showing, each with the selection to return to.
  const [parents, setParents] = createSignal<Level[]>([]);
  const [sub, setSub] = createSignal<{ label: string; items: MenuItem[] } | null>(null);
  const [sel, setSel] = createSignal(0);
  const [top, setTop] = createSignal(0);
  // A saved config replaces every item; the path into the old one is gone.
  createEffect(on(() => props.items, () => { setParents([]); setSub(null); setSel(0); setTop(0); }, { defer: true }));

  const items = () => sub()?.items ?? props.items;
  const tiled = () => props.tiles && sub() === null && items().length > 0 && items().length <= TILE_MAX;
  const crumbs = createMemo(() => [props.root, ...parents().slice(1).map(p => p.label), ...(sub() ? [sub()!.label] : [])]);

  const select = (n: number) => {
    const count = items().length;
    if (count === 0) return;
    const next = Math.max(0, Math.min(count - 1, n));
    setSel(next);
    if (next < top()) setTop(next);
    else if (next >= top() + VISIBLE_ROWS) setTop(next - VISIBLE_ROWS + 1);
  };
  const scrollBy = (rows: number) => {
    const max = Math.max(0, items().length - VISIBLE_ROWS);
    setTop(Math.max(0, Math.min(max, top() + rows)));
  };
  const activate = (n: number) => {
    const item = items()[n];
    if (!item) return;
    if (item.items) {
      setParents([...parents(), { label: sub()?.label ?? props.root, items: items(), sel: n, top: top() }]);
      setSub({ label: item.label, items: item.items });
      setSel(0); setTop(0);
    } else if (item.keys) props.onSend(item.keys);
  };
  const back = () => {
    const stack = parents();
    if (stack.length === 0) { props.onClose(); return; }
    const parent = stack[stack.length - 1];
    setParents(stack.slice(0, -1));
    setSub(stack.length === 1 ? null : { label: parent.label, items: parent.items });
    setSel(parent.sel); setTop(parent.top);
  };

  let prev = -1;
  const held = new Map<number, number>();
  onFrame((buttons) => {
    // The first frame only learns what is already held, so the press that
    // opened the menu is not read as a press inside it.
    if (prev < 0) { prev = buttons; return; }
    const pressed = buttons & ~prev;
    prev = buttons;
    if (pressed & BTN.CIRCLE) activate(sel());
    if (pressed & BTN.CROSS) back();
    const steps: [number, number][] = tiled()
      ? [[BTN.UP, -2], [BTN.DOWN, 2], [BTN.LEFT, -1], [BTN.RIGHT, 1]]
      : [[BTN.UP, -1], [BTN.DOWN, 1]];
    for (const [mask, step] of steps) {
      if (buttons & mask) {
        const count = (held.get(mask) ?? 0) + 1;
        held.set(mask, count);
        if (count === 1 || (count > DPAD_DELAY && (count - DPAD_DELAY) % DPAD_REPEAT === 0)) select(sel() + step);
      } else held.set(mask, 0);
    }
  });

  let panel: NodeMirror | undefined;
  let drag = 0;
  const tileRows = () => Math.ceil(items().length / 2);
  const tileH = () => Math.floor((240 - LIST_TOP - FOOT_H) / Math.max(1, tileRows()));
  createGesture({
    surface: "auxiliary",
    region: { node: () => panel },
    axis: "y",
    onTap(c) {
      if (c.y < LIST_TOP) {
        // The header: × closes, anywhere else steps back a level.
        if (c.x >= 290) props.onClose(); else back();
        return;
      }
      if (c.y >= 240 - FOOT_H) return;
      const n = tiled()
        ? Math.floor((c.y - LIST_TOP) / tileH()) * 2 + (c.x < 160 ? 0 : 1)
        : top() + Math.floor((c.y - LIST_TOP) / ROW_H);
      if (n >= items().length) return;
      setSel(n);
      activate(n);
    },
    onPanMove(c) {
      if (tiled()) return;
      drag += c.fdy;
      while (drag <= -ROW_H) { scrollBy(1); drag += ROW_H; }
      while (drag >= ROW_H) { scrollBy(-1); drag -= ROW_H; }
    },
    onPanEnd() { drag = 0; },
  });

  const header = createMemo(() => {
    const fit = fitCrumbs(crumbs(), SLOT_XS, 270);
    return { prefix: fit.prefix, last: fit.last, lastLeft: 10 + textWidth(fit.prefix, SLOT_XS) };
  });
  const footer = () => {
    if (props.errors > 0) return `config has ${props.errors} problem${props.errors === 1 ? "" : "s"}: see the daemon log`;
    if (items().length === 0) return "empty: edit ~/.config/pocket-term/config.json";
    return parents().length > 0 ? "tap or A to run · B back" : props.tiles ? "tap or A to open · B close" : "tap or A to send · B close";
  };
  const slots = Array.from({ length: VISIBLE_ROWS }, (_, i) => i);

  return (
    <View ref={panel} debugName="MenuPanel" class="absolute left-0 right-0 bottom-0 bg-[#0b0c0e]" style={{ insetT: PANEL_TOP }}>
      <Text class="absolute left-[10] top-[6] text-xs text-[#7d848f]">{header().prefix}</Text>
      <Text class="absolute top-[6] text-xs text-[#e8e8e8]" style={{ insetL: header().lastLeft }}>{header().last}</Text>
      <Text class="absolute right-[12] top-[4] text-sm text-[#7d848f]">×</Text>
      <View class="absolute left-0 right-0 h-[1] bg-[#23262b]" style={{ insetT: HEAD_H - 1 }} />

      <Show when={tiled()} fallback={
        <For each={slots}>
          {(slot) => <MenuRow item={items()[top() + slot]} y={HEAD_H + slot * ROW_H} selected={sel() === top() + slot} />}
        </For>
      }>
        <For each={items()}>
          {(item, n) => (
            <View
              class={sel() === n() ? "absolute border border-[#23262b] bg-[#17191d]" : "absolute border border-[#23262b]"}
              style={{ insetL: (n() % 2) * 160 - 1, width: 161, insetT: HEAD_H - 1 + Math.floor(n() / 2) * tileH(), height: tileH() + 1 }}
            >
              <Show when={sel() === n()}>
                <View class="absolute left-[1] top-0 bottom-0 w-[2] bg-[#e8e8e8]" />
              </Show>
              <Text class="absolute left-[14] text-base font-mono text-[#e8e8e8]" style={{ insetT: Math.floor(tileH() / 2) - 16 }}>{fitEnd(item.label, 18, 120)}</Text>
              <Text class="absolute left-[14] text-xs text-[#4a4f57]" style={{ insetT: Math.floor(tileH() / 2) + 6 }}>{`${item.items?.length ?? 0} commands`}</Text>
              <Text class="absolute right-[12] text-sm text-[#7d848f]" style={{ insetT: Math.floor(tileH() / 2) - 10 }}>{item.items ? "›" : ""}</Text>
            </View>
          )}
        </For>
      </Show>

      <Show when={!tiled() && items().length > VISIBLE_ROWS}>
        <View class="absolute right-[2] w-[2] bg-[#23262b]" style={{ insetT: HEAD_H + 2, height: VISIBLE_ROWS * ROW_H - 4 }}>
          <View class="absolute left-0 right-0 bg-[#7d848f]" style={{
            insetT: Math.round(top() / items().length * (VISIBLE_ROWS * ROW_H - 4)),
            height: Math.max(8, Math.round(VISIBLE_ROWS / items().length * (VISIBLE_ROWS * ROW_H - 4))),
          }} />
        </View>
      </Show>

      <View class="absolute left-0 right-0 h-[1] bg-[#23262b]" style={{ insetT: 240 - PANEL_TOP - FOOT_H }} />
      <Text class={props.errors > 0 ? "absolute left-[10] bottom-[5] text-xs text-[#c9a36a]" : "absolute left-[10] bottom-[5] text-xs text-[#4a4f57]"}>{footer()}</Text>
    </View>
  );
}

/** One of the list's fixed rows; empty past the end of the list. */
function MenuRow(props: { item: MenuItem | undefined; y: number; selected: boolean }) {
  const text = createMemo(() => {
    const item = props.item;
    if (!item) return { label: "", detail: "" };
    const right = item.items ? 26 : 12;
    const label = fitEnd(item.label, SLOT_SM, 190);
    const room = 320 - LABEL_LEFT - textWidth(label, SLOT_SM) - 16 - right;
    return { label, detail: fitEnd(item.detail, SLOT_MONO_XS, room) };
  });
  return (
    <View class={props.selected && props.item ? "absolute left-0 right-0 bg-[#17191d]" : "absolute left-0 right-0"} style={{ insetT: props.y, height: ROW_H }}>
      <Show when={props.selected && props.item}>
        <View class="absolute left-0 top-0 bottom-0 w-[2] bg-[#e8e8e8]" />
      </Show>
      <Text class="absolute left-[12] top-[5] text-sm text-[#e8e8e8]">{text().label}</Text>
      <Text class={props.item?.items ? "absolute right-[26] top-[7] text-xs font-mono text-[#4a4f57]" : "absolute right-[12] top-[7] text-xs font-mono text-[#4a4f57]"}>{text().detail}</Text>
      <Text class="absolute right-[12] top-[4] text-sm text-[#7d848f]">{props.item?.items ? "›" : ""}</Text>
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#23262b]" />
    </View>
  );
}
