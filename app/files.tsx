// app/files.tsx — the file browser SELECT opens in place of the keyboard.
//
// It starts in the active shell's working directory and asks the companion
// for one folder at a time (shared/files.ts); nothing is crawled ahead. A
// folder's pages load one after another and the list shows what has
// arrived. Folders seen this session are kept (LRU, CACHE_FOLDERS) so going
// back up draws at once while the fresh listing loads over it.
//
// A opens a folder, B or ↑ up goes to the parent, SELECT cds the shell into
// the folder showing and closes, START closes without changing anything.

import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { analogX, analogY, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { offload } from "@pocketjs/framework/offload";
import { isFolder, type FileEntry, type FilesReply, type FilesRequest } from "../shared/files.ts";
import { createCursorStick } from "./stick.ts";
import { FOOT_H, HEAD_H, LIST_TOP, PANEL_TOP, ROW_H, SLOT_SM, SLOT_XS, VISIBLE_ROWS, fitEnd, textWidth } from "./panel.ts";

const CACHE_FOLDERS = 16;
/** Entries the console keeps for one folder; the companion sends at most
 *  FILES_LIMITS.entries. */
const MAX_ENTRIES = 2000;
const UP_W = 46;
const DPAD_DELAY = 18;
const DPAD_REPEAT = 4;

const cache = new Map<string, FileEntry[]>();
function remember(path: string, entries: FileEntry[]) {
  cache.delete(path);
  cache.set(path, entries);
  if (cache.size > CACHE_FOLDERS) cache.delete(cache.keys().next().value!);
}

let io: ReturnType<typeof offload> | null | undefined;
function files(): ReturnType<typeof offload> | null {
  if (io === undefined) {
    io = null;
    try { if ((globalThis as { offload?: unknown }).offload) io = offload(); } catch { /* no offload on this host */ }
  }
  return io;
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}

/** Shell-quoted for `cd`: single quotes, with any single quote spelled '\''. */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/** The console draws ASCII from its baked atlases; other characters in a
 *  file name show as ?. The real name is kept for the cd. */
const drawable = (name: string) => name.replace(/[^\x20-\x7e]/g, "?");

function sizeLabel(entry: FileEntry): string {
  const [, kind, size] = entry;
  if (kind === "L" || kind === "l") return "link";
  if (size < 0) return "";
  if (isFolder(kind)) return `${size} item${size === 1 ? "" : "s"}`;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

interface Crumb { text: string; path: string; x: number; w: number }

export function FileBrowser(props: { sid: number; onCd(path: string): void; onClose(): void }) {
  const [path, setPath] = createSignal("");
  const [home, setHome] = createSignal("");
  const [entries, setEntries] = createSignal<FileEntry[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [sel, setSel] = createSignal(0);
  const [top, setTop] = createSignal(0);
  let ticket = 0, generation = 0;
  /** After going up, the folder we came out of, to select once it lists. */
  let reselect = "";

  const select = (n: number) => {
    const count = entries().length;
    if (count === 0) { setSel(0); setTop(0); return; }
    const next = Math.max(0, Math.min(count - 1, n));
    setSel(next);
    if (next < top()) setTop(next);
    else if (next >= top() + VISIBLE_ROWS) setTop(next - VISIBLE_ROWS + 1);
  };

  const request = (req: FilesRequest, done: (reply: FilesReply) => void) => {
    const channel = files();
    if (!channel) { setError("No companion connection"); setLoading(false); return; }
    const mine = ++generation;
    if (ticket) channel.cancel(ticket);
    ticket = channel.request("term.files", JSON.stringify(req), result => {
      if (mine !== generation) return;
      ticket = 0;
      if (!result.ok) { setError(result.error.slice(0, 80)); setLoading(false); return; }
      try { done(JSON.parse(result.value) as FilesReply); }
      catch { setError("Unreadable reply from the companion"); setLoading(false); }
    });
  };

  const open = (target?: string) => {
    setError("");
    setLoading(true);
    const cached = target !== undefined ? cache.get(target) : undefined;
    if (target !== undefined) { setPath(target); setEntries(cached ?? []); }
    setSel(0); setTop(0);
    if (cached && reselect) {
      const at = cached.findIndex(e => e[0] === reselect);
      if (at >= 0) select(at);
    }
    let gathered: FileEntry[] = [];
    const page = (offset: number) => request({ sid: props.sid, ...(target !== undefined ? { path: target } : {}), offset }, reply => {
      if (offset === 0) { setPath(reply.path); setHome(reply.home); target = reply.path; }
      if (reply.error) { setError(reply.error === "EACCES" ? "Permission denied" : reply.error === "ENOENT" ? "No such folder" : reply.error); setEntries([]); setLoading(false); return; }
      gathered = gathered.concat(reply.entries);
      setEntries(gathered);
      if (reselect) {
        const at = gathered.findIndex(e => e[0] === reselect);
        if (at >= 0) { select(at); reselect = ""; }
      } else if (sel() >= gathered.length) select(gathered.length - 1);
      if (reply.more && gathered.length < MAX_ENTRIES) page(offset + reply.entries.length);
      else { setLoading(false); reselect = ""; remember(reply.path, gathered); }
    });
    page(0);
  };
  const up = () => {
    const here = path();
    if (!here || here === "/") return;
    reselect = baseName(here);
    open(parentOf(here));
  };
  const enter = (n: number) => {
    const entry = entries()[n];
    if (!entry || !isFolder(entry[1])) return;
    const here = path();
    open(here === "/" ? `/${entry[0]}` : `${here}/${entry[0]}`);
  };
  open();
  onCleanup(() => { generation++; if (ticket) files()?.cancel(ticket); });

  let prev = -1;
  const held = new Map<number, number>();
  const stick = createCursorStick();
  onFrame((buttons) => {
    if (prev < 0) { prev = buttons; return; }
    const pressed = buttons & ~prev;
    prev = buttons;
    if (pressed & BTN.START) { props.onClose(); return; }
    if (pressed & BTN.SELECT) { if (path()) props.onCd(path()); return; }
    if (pressed & BTN.CIRCLE) enter(sel());
    if (pressed & BTN.CROSS) up();
    for (const [mask, step] of [[BTN.UP, -1], [BTN.DOWN, 1], [BTN.LEFT, -VISIBLE_ROWS], [BTN.RIGHT, VISIBLE_ROWS]] as const) {
      if (buttons & mask) {
        const count = (held.get(mask) ?? 0) + 1;
        held.set(mask, count);
        if (count === 1 || (count > DPAD_DELAY && (count - DPAD_DELAY) % DPAD_REPEAT === 0)) select(sel() + step);
      } else held.set(mask, 0);
    }
    // The Circle Pad moves like the d-pad: up and down by one, left and
    // right by a page.
    const direction = stick.step(analogX(), analogY());
    if (direction === "Up") select(sel() - 1);
    else if (direction === "Down") select(sel() + 1);
    else if (direction === "Left") select(sel() - VISIBLE_ROWS);
    else if (direction === "Right") select(sel() + VISIBLE_ROWS);
  });

  /** The path as breadcrumbs, the home folder as ~, with each crumb's x
   *  range so a tap can jump to it. Leading crumbs give way to "…" until the
   *  rest fits. */
  const crumbs = createMemo((): Crumb[] => {
    const full = path();
    if (!full) return [];
    const inHome = home() !== "" && (full === home() || full.startsWith(`${home()}/`));
    const base = inHome ? home() : "";
    const parts = (inHome ? full.slice(home().length) : full).split("/").filter(Boolean);
    const all: { text: string; path: string }[] = [{ text: inHome ? "~" : "/", path: inHome ? home() : "/" }];
    let at = base;
    for (const part of parts) { at = `${at}/${part}`; all.push({ text: drawable(part), path: at }); }
    const left = UP_W + 8, room = 320 - left - 8, sep = textWidth(" › ", SLOT_XS);
    for (let from = 0; from < all.length; from++) {
      const shown = from === 0 ? all : [{ text: "…", path: all[from - 1].path }, ...all.slice(from)];
      const widths = shown.map((c, i) => textWidth(i === shown.length - 1 ? fitEnd(c.text, SLOT_XS, room) : c.text, SLOT_XS));
      const total = widths.reduce((sum, w) => sum + w, 0) + sep * (shown.length - 1);
      if (total <= room || from === all.length - 1) {
        let x = left;
        return shown.map((c, i) => {
          const crumb = { text: i === shown.length - 1 ? fitEnd(c.text, SLOT_XS, room) : c.text, path: c.path, x, w: widths[i] };
          x += widths[i] + sep;
          return crumb;
        });
      }
    }
    return [];
  });

  let panel: NodeMirror | undefined;
  let drag = 0;
  createGesture({
    surface: "auxiliary",
    region: { node: () => panel },
    axis: "y",
    onTap(c) {
      if (c.y < LIST_TOP) {
        if (c.x < UP_W) { up(); return; }
        const crumb = crumbs().find(k => c.x >= k.x - 4 && c.x < k.x + k.w + 4);
        if (crumb && crumb.path !== path()) { reselect = ""; open(crumb.path); }
        return;
      }
      if (c.y >= 240 - FOOT_H) return;
      const n = top() + Math.floor((c.y - LIST_TOP) / ROW_H);
      if (n >= entries().length) return;
      // A folder opens; a file only takes the selection.
      select(n);
      enter(n);
    },
    onPanMove(c) {
      drag += c.fdy;
      const max = Math.max(0, entries().length - VISIBLE_ROWS);
      while (drag <= -ROW_H) { setTop(Math.min(max, top() + 1)); drag += ROW_H; }
      while (drag >= ROW_H) { setTop(Math.max(0, top() - 1)); drag -= ROW_H; }
    },
    onPanEnd() { drag = 0; },
  });

  const slots = Array.from({ length: VISIBLE_ROWS }, (_, i) => i);
  const count = () => entries().length;

  return (
    <View ref={panel} debugName="FileBrowser" class="absolute left-0 right-0 bottom-0 bg-[#0b0c0e]" style={{ insetT: PANEL_TOP }}>
      <View class="absolute left-[-1] top-[-1] border border-[#23262b] items-center justify-center" style={{ width: UP_W + 1, height: HEAD_H + 1 }}>
        <Text class="text-xs text-[#e8e8e8]">↑ up</Text>
      </View>
      <For each={crumbs()}>
        {(crumb, i) => (
          <>
            <Text class={i() === crumbs().length - 1 ? "absolute top-[6] text-xs text-[#e8e8e8]" : "absolute top-[6] text-xs text-[#7d848f]"} style={{ insetL: crumb.x }}>{crumb.text}</Text>
            <Show when={i() < crumbs().length - 1}>
              <Text class="absolute top-[6] text-xs text-[#4a4f57]" style={{ insetL: crumb.x + crumb.w }}>{" › "}</Text>
            </Show>
          </>
        )}
      </For>
      <View class="absolute left-0 right-0 h-[1] bg-[#23262b]" style={{ insetT: HEAD_H - 1 }} />

      <For each={slots}>
        {(slot) => <FileRow entry={entries()[top() + slot]} y={HEAD_H + slot * ROW_H} selected={sel() === top() + slot} />}
      </For>
      <Show when={error() !== "" || (!loading() && count() === 0)}>
        <Text class="absolute left-[12] text-sm text-[#7d848f]" style={{ insetT: HEAD_H + 8 }}>{error() || "Empty folder"}</Text>
      </Show>

      <Show when={count() > VISIBLE_ROWS}>
        <View class="absolute right-[2] w-[2] bg-[#23262b]" style={{ insetT: HEAD_H + 2, height: VISIBLE_ROWS * ROW_H - 4 }}>
          <View class="absolute left-0 right-0 bg-[#7d848f]" style={{
            insetT: Math.round(top() / count() * (VISIBLE_ROWS * ROW_H - 4)),
            height: Math.max(8, Math.round(VISIBLE_ROWS / count() * (VISIBLE_ROWS * ROW_H - 4))),
          }} />
        </View>
      </Show>

      <View class="absolute left-0 right-0 h-[1] bg-[#23262b]" style={{ insetT: 240 - PANEL_TOP - FOOT_H }} />
      <Text class="absolute left-[10] bottom-[5] text-xs text-[#4a4f57]">{loading() ? "loading…" : "A open · B up · SELECT cd here · START cancel"}</Text>
    </View>
  );
}

function FileRow(props: { entry: FileEntry | undefined; y: number; selected: boolean }) {
  const view = createMemo(() => {
    const entry = props.entry;
    if (!entry) return { name: "", meta: "", kind: "" };
    const meta = sizeLabel(entry);
    const room = 320 - 32 - textWidth(meta, SLOT_XS) - 22;
    return { name: fitEnd(drawable(entry[0]), SLOT_SM, room), meta, kind: entry[1] as string };
  });
  const folder = () => view().kind === "d" || view().kind === "L";
  const hidden = () => props.entry?.[0].startsWith(".") ?? false;
  return (
    <View class={props.selected && props.entry ? "absolute left-0 right-0 bg-[#17191d]" : "absolute left-0 right-0"} style={{ insetT: props.y, height: ROW_H }}>
      <Show when={props.selected && props.entry}>
        <View class="absolute left-0 top-0 bottom-0 w-[2] bg-[#e8e8e8]" />
      </Show>
      {/* A folder is a tab over a body; a file is an outlined page, green
          when it is executable. */}
      <View class={folder() ? "absolute left-[10] top-[9] w-[6] h-[3] bg-[#8a9099]" : "absolute left-[10] top-[9] w-0 h-0"} />
      <View class={fileIconClass(view().kind)} />
      <Text class={nameClass(hidden(), view().kind === "l" || view().kind === "L")} style={{ insetL: 32 }}>{view().name}</Text>
      <Text class="absolute right-[12] top-[7] text-xs text-[#4a4f57]">{view().meta}</Text>
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#23262b]" />
    </View>
  );
}

function fileIconClass(kind: string): string {
  if (kind === "d" || kind === "L") return "absolute left-[10] top-[11] w-[14] h-[9] rounded-[1] bg-[#8a9099]";
  if (kind === "x") return "absolute left-[12] top-[7] w-[10] h-[13] rounded-[1] border border-[#5f8f6a]";
  if (kind === "") return "absolute left-[12] top-[7] w-0 h-0";
  return "absolute left-[12] top-[7] w-[10] h-[13] rounded-[1] border border-[#4a4f57]";
}

function nameClass(hidden: boolean, link: boolean): string {
  if (hidden) return "absolute top-[5] text-sm text-[#7d848f]";
  if (link) return "absolute top-[5] text-sm text-[#a9b4c2]";
  return "absolute top-[5] text-sm text-[#e8e8e8]";
}
