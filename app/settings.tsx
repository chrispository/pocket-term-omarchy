import { For } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { FONT_LABELS, FONT_NAMES } from "./font.ts";

export function TermSettings(props: { font: number; speed: number; preview: boolean; layout: string; touchpad: boolean; status: string;
  onFont(n: number): void; onSpeed(n: number): void; onPreview(on: boolean): void; onLayout(): void; onTouchpad(): void; onClose(): void }) {
  let panel: NodeMirror | undefined;
  createGesture({ surface: "auxiliary", region: { node: () => panel }, onTap(c) {
    if (c.y < 34 && c.x > 250) props.onClose();
    else if (c.y >= 45 && c.y < 129) props.onFont(Math.floor((c.y - 45) / 28));
    // Four toggles in a 2 x 2 grid; each tap moves one to its next value.
    else if (c.y >= 137 && c.y < 175) {
      if (c.x < 160) props.onPreview(!props.preview);
      else props.onSpeed(props.speed === 1 ? 1.5 : 1);
    } else if (c.y >= 175 && c.y < 213) {
      if (c.x < 160) props.onLayout();
      else props.onTouchpad();
    }
  } });
  return <View ref={panel} debugName="TermSettings" class="absolute left-0 right-0 top-0 bottom-0 bg-[#10161f]">
    <Text class="absolute left-[12] top-[8] text-sm text-[#dfe6f2] font-bold">Settings</Text>
    <Text class="absolute right-[15] top-[6] text-lg text-[#9fb6d8]">×</Text>
    <Text class="absolute left-[12] top-[30] text-xs text-[#72869e]">Font</Text>
    <For each={FONT_NAMES}>{(name, n) => <View class={props.font === n() ? "absolute left-[8] right-[8] h-[26] rounded-[3] bg-[#294463]" : "absolute left-[8] right-[8] h-[26] rounded-[3] bg-[#192330]"} style={{ insetT: 45 + n() * 28 }}>
      <Text class="absolute left-[9] top-[5] text-xs text-[#dfe6f2]">{FONT_LABELS[name]}</Text>
      <Text class="absolute right-[9] top-[5] text-xs text-[#9fb6d8]">{props.font === n() ? "●" : "○"}</Text>
    </View>}</For>
    <SettingCell x={8} y={139} label="Typing preview" value={props.preview ? "Auto" : "Off"} />
    <SettingCell x={162} y={139} label="Scroll speed" value={props.speed === 1 ? "Fast" : "Faster"} />
    <SettingCell x={8} y={177} label="Keyboard" value={props.layout} />
    <SettingCell x={162} y={177} label="Touchpad" value={props.touchpad ? "On" : "Off"} />
    <Text class="absolute left-[12] right-[12] top-[218] h-[15] text-xs text-[#576d87]">{props.status}</Text>
  </View>;
}

function SettingCell(props: { x: number; y: number; label: string; value: string }) {
  return <View class="absolute w-[150] h-[34] rounded-[3] bg-[#192330]" style={{ insetL: props.x, insetT: props.y }}>
    <Text class="absolute left-[9] top-[2] text-xs text-[#72869e]">{props.label}</Text>
    <Text class="absolute left-[9] top-[17] text-xs text-[#dfe6f2]">{props.value}</Text>
  </View>;
}
