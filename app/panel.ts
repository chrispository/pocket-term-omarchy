// app/panel.ts — geometry and text fitting shared by the panels that take
// the keyboard's place on the touch screen (the ctrl and >_ menus, the file
// browser). They sit under the session tabs: a header, a list of fixed rows
// and a footer, drawn in the Hairline palette whatever the keyboard theme.

import { getOps } from "@pocketjs/framework/host";

export const PANEL_TOP = 26;
export const HEAD_H = 26;
export const FOOT_H = 22;
export const ROW_H = 27;
export const LIST_TOP = PANEL_TOP + HEAD_H;
/** Rows between the header and the footer. The list draws this many row
 *  nodes and changes what they show as it scrolls, rather than one node per
 *  entry. */
export const VISIBLE_ROWS = Math.floor((240 - LIST_TOP - FOOT_H) / ROW_H);

/** Font slots of the classes the panels draw text in (vendor/pocketjs
 *  framework/compiler/tailwind.ts): text-xs, text-sm, text-xs font-mono. */
export const SLOT_XS = 0;
export const SLOT_SM = 1;
export const SLOT_MONO_XS = 16;

export function textWidth(text: string, slot: number): number {
  return getOps().measureText(text, slot);
}

/** The longest prefix of `text` that fits `maxW` with an ellipsis after it. */
export function fitEnd(text: string, slot: number, maxW: number): string {
  if (maxW <= 0) return "";
  if (textWidth(text, slot) <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(`${text.slice(0, mid)}…`, slot) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : "";
}

/** Breadcrumbs that fit `maxW`: the last one always shows, and the leading
 *  ones collapse into "…" from the left. Returns the dim prefix (ending in
 *  its separator) and the bright last crumb. */
export function fitCrumbs(crumbs: readonly string[], slot: number, maxW: number): { prefix: string; last: string } {
  const last = fitEnd(crumbs[crumbs.length - 1] ?? "", slot, maxW);
  const room = maxW - textWidth(last, slot);
  const lead = crumbs.slice(0, -1);
  for (let from = 0; from <= lead.length; from++) {
    const shown = lead.slice(from);
    const prefix = shown.length === 0 ? "" : `${from > 0 ? "… › " : ""}${shown.join(" › ")} › `;
    if (textWidth(prefix, slot) <= room) return { prefix, last };
  }
  return { prefix: "", last };
}
