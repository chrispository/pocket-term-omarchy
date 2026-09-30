/** Terminal worker: persistent session registry, bounded replica views,
 * authenticated local capabilities and loopback desktop mirror transport.
 * The supervisor owns process lifetime; device connections own no PTYs. */

import { createServer, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Mailbox } from "./exchange.ts";
import { LIMITS, type ExchangeRequest } from "../shared/exchange.ts";
import { HISTORY, type HistoryRequest, type HistoryBatchRequest } from "../shared/history.ts";
import { historyBatchReply, validateHistoryBatch } from "./history-batch.ts";
import { hostname, tmpdir } from "node:os";
import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { Session } from "./session.ts";
import {
  LINE_BUDGET,
  TERM_APP,
  TERM_PROTO,
  type ClientLine,
  type Cursor,
  type HostLine,
  type Role,
  type RowUpdate,
  type Run,
  type SessionInfo,
} from "../shared/protocol.ts";
import { chunkRows, resolveCell, rowKey, rowRuns, type Cell } from "./grid.ts";
import { DynamicAtlasSet, isBakedCodepoint } from "./glyphs.ts";
import { encodeKey } from "./keys.ts";
import { defaultConfigPath, KeyPlayer, watchConfig } from "./config.ts";
import { listFiles, processCwd } from "./files.ts";
import type { FilesRequest } from "../shared/files.ts";
import { KEYSEQ_LIMITS } from "../shared/keyseq.ts";
import {
  FrameParser,
  WIRE_MSG,
  WIRE_PORT,
  encodeCtrl,
  encodeFrame,
  encodeHelloAck,
  parseHello,
} from "./wire.ts";

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
/** The desktop host binary, which is also the `linux-app` one. */
const MIRROR_BIN = join(ROOT, "vendor/pocketjs/hosts/desktop/target/release/pocket-desktop-host");
const MIRROR_APP = "pocketterm-mirror-main";

function chooseDefaultShell(): string {
  const candidates = [
    process.env.SHELL,
    process.platform === "darwin" ? "/bin/zsh" : "/bin/bash",
    "/bin/sh",
  ];
  for (const shell of candidates) {
    if (!shell) continue;
    try {
      accessSync(shell, fsConstants.X_OK);
      return shell;
    } catch {
      // A stale SHELL environment variable should not keep the companion from starting.
    }
  }
  throw new Error("No executable shell found; pass --shell <path>");
}

const options = {
  port: WIRE_PORT,
  name: hostname().replace(/\.local$/, ""),
  shell: chooseDefaultShell(),
  cwd: process.env.HOME ?? process.cwd(),
  login: true,
  trace: false,
  /** Open a desktop window per session. */
  mirror: true,
  config: defaultConfigPath(),
};

{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") options.port = Number(argv[++i]);
    else if (a === "--name") options.name = argv[++i];
    else if (a === "--shell") options.shell = argv[++i];
    else if (a === "--cwd") options.cwd = argv[++i];
    else if (a === "--trace") options.trace = true;
    else if (a === "--no-login") options.login = false;
    else if (a === "--no-beacon") {} // accepted by older launch scripts
    else if (a === "--no-mirror") options.mirror = false;
    else if (a === "--config") options.config = argv[++i];
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
}

// Bun's installer drops the executable bit on prebuilt binaries; node-pty's
// posix_spawn of its helper then fails with a bare "posix_spawnp failed".
for (const helper of [
  join(
    dirname(fileURLToPath(import.meta.url)),
    "node_modules/node-pty/prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  ),
]) {
  if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
}

// ---------------------------------------------------------------------------
// sessions — PTY + authoritative terminal core
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// connections — one attached replica each
// ---------------------------------------------------------------------------

const PING_INTERVAL_MS = 2000;
const SILENCE_TIMEOUT_MS = 10_000;
/** Coalescing delay after a session produces output. A terminal's echo is a
 *  round trip through here, so this sits directly in the gap between a
 *  keystroke and the character appearing: it is a batching window, not a
 *  polling rate. A byte-at-a-time echo pays 2 ms; a screenful of output
 *  still collapses into one pass. */
const FLUSH_COALESCE_MS = 2;
/** Backstop for the changes no PTY byte announces — a scrollback scrub, a
 *  cursor that moved because a replica attached. */
const FLUSH_IDLE_MS = 100;

/** Keep one atlas piece within a typical offload reply so changed rows can
 * take the next output turn instead of waiting through a large atlas line. */
const ATLAS_CHUNK = 1536;

class Conn {
  readonly socket: Socket;
  mailbox?: Mailbox;
  readonly parser = new FrameParser();
  hello: Uint8Array | null = new Uint8Array(0);
  role: Role = "device";
  mirrorSid?: number;
  cols = 80;
  rows = 24;
  cell: [number, number] = [5, 10];
  attachedSid = -1;
  /** Atlas generation this replica holds per slot, and the chunks still owed
   *  to it for the slot in flight. One chunk goes out per flush tick: the
   *  device's line queue is 32 KiB and drops its oldest entries when full,
   *  so a whole atlas dumped at once would take the grid updates with it. */
  atlasSent = new Map<number, number>();
  atlasSlot = 0;
  atlasGen = -1;
  atlasQueue: string[] = [];
  atlasSeq = 0;
  gen = 0;
  seq = 0;
  scrollback = 0;
  localHistory = false;
  historyGlyphs: [number, number][] = [];
  pendingGlyphs?: [number, number][];
  rowCache: string[] = [];
  lastCursor = "";
  lastRx = Date.now();
  sawClientHello = false;
  paste?: { sid: number; text: string; at: number };

  constructor(socket: Socket) {
    this.socket = socket;
  }

  sendLine(line: HostLine) {
    if (this.mailbox) { this.mailbox.push(line); return; }
    if (this.socket.writableLength > LIMITS.outputChars) { this.socket.destroy(); return; }
    this.socket.write(encodeCtrl(JSON.stringify(line)));
  }

  /** Emit rows (+cursor/scrollback trailer) as ordered, chunked grid lines. */
  sendGrid(updates: RowUpdate[], cursor: Cursor, full: boolean) {
    const chunks = chunkRows(updates, LINE_BUDGET);
    for (let i = 0; i < chunks.length; i += 1) {
      const last = i === chunks.length - 1;
      this.sendLine({
        t: "grid",
        sid: this.attachedSid,
        gen: this.gen,
        seq: this.seq++,
        ...(full ? { full: 1 as const } : {}),
        ...(last ? {} : { more: 1 as const }),
        rows: chunks[i],
        ...(last ? { cur: cursor, ack: this.mailbox?.ack, sb: this.scrollback, history: hub.sessions.get(this.attachedSid)?.history.manifest() } : {}),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// the hub
// ---------------------------------------------------------------------------

class Hub {
  readonly sessions = new Map<number, Session>();
  readonly conns = new Set<Conn>();
  private nextSid = 1;
  /** Set by the mirror supervisor; called once per new session. */
  onSessionCreated: ((sid: number) => void) | null = null;

  create(cols: number, rows: number): Session {
    if (this.sessions.size >= LIMITS.sessions) throw new Error("Session limit reached (32)");
    const session = new Session(this.nextSid++, cols, rows, options, {
      output: scheduleFlush, titles: () => this.sessionsChanged(), exit: sid => this.sessionExited(sid),
    });
    this.sessions.set(session.sid, session);
    console.log(`[term] session #${session.sid} started: pid ${session.pty.pid}, ${cols}x${rows}`);
    this.sessionsChanged();
    // A replica left with nothing attached — the empty state after the last
    // session closed — shows the first session that appears, whoever opened
    // it. Without this it would sit at the empty state while sessions exist,
    // which is the empty state lying. Mirrors are bound through the pending
    // listener instead and are left alone here.
    for (const conn of this.conns) {
      if (conn.role === "device" && conn.sawClientHello && conn.attachedSid < 0) {
        attach(conn, session.sid);
      }
    }
    if (this.onSessionCreated) {
      this.onSessionCreated(session.sid);
    }
    return session;
  }

  kill(sid: number) {
    const session = this.sessions.get(sid);
    if (!session) return;
    session.dispose();
    this.sessions.delete(sid);
    closeMirror(sid);
    this.reattachOrphans(sid);
    this.sessionsChanged();
  }

  sessionExited(sid: number) {
    const session = this.sessions.get(sid);
    if (!session) return;
    session.dispose();
    this.sessions.delete(sid);
    closeMirror(sid);
    for (const conn of this.conns) {
      if (conn.sawClientHello) conn.sendLine({ t: "exit", sid });
    }
    this.reattachOrphans(sid);
    this.sessionsChanged();
  }

  private reattachOrphans(gone: number) {
    for (const conn of this.conns) {
      if (conn.attachedSid !== gone) continue;
      if (conn.role === "mirror") {
        // A mirror exists to show one session. When that session is over so
        // is the window: it is closed rather than pointed at someone else's
        // shell.
        conn.socket.destroy();
        this.conns.delete(conn);
        continue;
      }
      const fallback = [...this.sessions.values()].at(-1);
      if (fallback === undefined) {
        // Closing the last session leaves the replica with nothing attached,
        // not with a shell it did not ask for. Opening one is a decision,
        // and the operator just made the opposite one.
        conn.attachedSid = -1;
        conn.rowCache = [];
        conn.lastCursor = "";
        continue;
      }
      attach(conn, fallback.sid);
    }
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ sid: s.sid, title: s.title }));
  }

  sessionsChanged() {
    for (const conn of this.conns) {
      if (conn.sawClientHello) {
        conn.sendLine({ t: "sessions", list: this.list(), active: conn.attachedSid });
      }
    }
  }
}

const hub = new Hub();

// ---------------------------------------------------------------------------
// the replica view: serialize, diff, flush
// ---------------------------------------------------------------------------

/** Codepoints the device cannot draw from its baked atlas, noted as the grid
 *  is serialized so the next bake covers exactly what is on screen. */
const atlas = new DynamicAtlasSet();

/** Classify a resolved cell against the device's glyph coverage: baked text
 *  passes through, a character some face in the chain can draw is routed to
 *  that face's slot, and one nobody can draw becomes a placeholder of the
 *  same column width — an unrenderable glyph must not also shift the rest of
 *  the row, which is what dropping it or leaving it to a missing atlas would
 *  do. */
const uncovered = new Set<number>();

function classify(cell: Cell, want = true): void {
  if (cell.width === 0 || cell.ch === "" || cell.ch === " ") return;
  const cp = cell.ch.codePointAt(0);
  if (cp === undefined || isBakedCodepoint(cp)) return;
  const columns = cell.width === 2 ? 2 : 1;
  const slot = atlas.slotFor(cp, columns);
  if (slot >= 0) {
    if (want) atlas.want(cp, columns, slot);
    cell.slot = slot;
    return;
  }
  // A placeholder is the last resort, and the operator should be able to
  // find out which character it stood for rather than guess from a "?".
  if (!uncovered.has(cp)) {
    uncovered.add(cp);
    console.log(
      `[term] no face draws U+${cp.toString(16).toUpperCase().padStart(4, "0")} ` +
        `(${cell.ch}) — showing a placeholder`,
    );
  }
  cell.ch = "?".repeat(columns);
}

/** Resolve the connection's visible window of the session buffer to runs. */
function viewRows(session: Session, conn: Conn): Run[][] {
  const core = session.core;
  const rows: Run[][] = [];
  if (core === null) {
    for (let y = 0; y < conn.rows; y += 1) rows.push([]);
    return rows;
  }
  // Scrolled back, the top of the view comes out of history: the core
  // indexes that directly, oldest line first, so the offset is arithmetic on
  // its own count rather than on a viewport's base row.
  const history = core.getScrollbackCount();
  const back = Math.max(0, Math.min(history, conn.scrollback));
  for (let y = 0; y < conn.rows; y += 1) {
    const fromHistory = y < back;
    const offset = history - back + y;
    const cells: Cell[] = [];
    for (let x = 0; x < conn.cols; x += 1) {
      const cell = fromHistory ? core.getScrollbackCell(history - 1 - offset, x) : core.getCell(y - back, x);
      const resolved = resolveCell(cell);
      classify(resolved);
      cells.push(resolved);
    }
    rows.push(rowRuns(cells));
  }
  return rows;
}

/** Re-bake when the screen has shown codepoints the current atlas lacks. The
 *  bake is debounced: a session that dumps a page of Chinese should cost one
 *  bake, not one per row. */
let atlasDebounce = 0;
function pumpAtlasBake(): void {
  if (!atlas.dirty) {
    atlasDebounce = 0;
    return;
  }
  atlasDebounce += 1;
  if (atlasDebounce < 8) return; // ~250 ms at the flush interval
  atlasDebounce = 0;
  const conn = [...hub.conns].find((c) => c.sawClientHello);
  const [cellW, cellH] = conn?.cell ?? [5, 10];
  for (const baked of atlas.bake(cellW, cellH)) {
    console.log(
      `[term] baked ${baked.glyphCount} glyphs at ${baked.px}px into slot ${baked.slot} ` +
        `(${(baked.bytes.length / 1024).toFixed(1)} KiB)`,
    );
  }
}

/** Hand one atlas chunk to a replica per tick. Every face in the chain is
 *  delivered, one slot at a time. */
function pumpAtlasSend(conn: Conn): void {
  if (!conn.sawClientHello) return;
  if (conn.atlasQueue.length === 0) {
    for (const baked of atlas.current()) {
      if (conn.atlasSent.get(baked.slot) === baked.gen) continue;
      conn.atlasSent.set(baked.slot, baked.gen);
      conn.atlasSlot = baked.slot;
      conn.atlasGen = baked.gen;
      conn.atlasSeq = 0;
      const b64 = Buffer.from(baked.bytes).toString("base64");
      for (let at = 0; at < b64.length; at += ATLAS_CHUNK) {
        conn.atlasQueue.push(b64.slice(at, at + ATLAS_CHUNK));
      }
      break; // one atlas at a time; the next tick starts the next
    }
  }
  const chunk = conn.atlasQueue.shift();
  if (chunk === undefined) return;
  conn.sendLine({
    t: "atlas",
    slot: conn.atlasSlot,
    gen: conn.atlasGen,
    seq: conn.atlasSeq++,
    ...(conn.atlasQueue.length > 0 ? { more: 1 as const } : {}),
    b64: chunk,
  });
}

function cursorFor(session: Session, conn: Conn): Cursor {
  const cursor = session.core?.getCursor();
  if (cursor === undefined) return [0, 0, 0];
  const visible = conn.scrollback === 0 && cursor.visible;
  return [cursor.col, cursor.row, visible ? 1 : 0];
}

/** Full snapshot: a new gen, every row sent (blank rows included). */
function snapshot(conn: Conn) {
  const session = hub.sessions.get(conn.attachedSid);
  if (!session) return;
  conn.gen += 1;
  conn.seq = 0;
  const rows = viewRows(session, conn);
  conn.rowCache = rows.map(rowKey);
  const cursor = cursorFor(session, conn);
  conn.lastCursor = JSON.stringify([cursor, conn.scrollback, session.history.manifest()]);
  const updates: RowUpdate[] = rows.map((runs, y) => [y, ...runs]);
  conn.sendGrid(updates, cursor, true);
}

function flush(conn: Conn) {
  if (conn.mailbox?.busy) return;
  const session = hub.sessions.get(conn.attachedSid);
  if (!session || !conn.sawClientHello) return;
  const rows = viewRows(session, conn);
  const updates: RowUpdate[] = [];
  for (let y = 0; y < rows.length; y += 1) {
    const key = rowKey(rows[y]);
    if (conn.rowCache[y] !== key) {
      conn.rowCache[y] = key;
      updates.push([y, ...rows[y]]);
    }
  }
  const cursor = cursorFor(session, conn);
  const cursorKey = JSON.stringify([cursor, conn.scrollback, session.history.manifest()]);
  if (updates.length === 0 && cursorKey === conn.lastCursor) { pumpAtlasSend(conn); return; }
  conn.lastCursor = cursorKey;
  conn.sendGrid(updates, cursor, false);
}

function attach(conn: Conn, sid: number) {
  if (!hub.sessions.has(sid)) return;
  conn.attachedSid = sid;
  if (options.trace) console.log(`[term] ${conn.role} attached session #${sid}`);
  conn.scrollback = 0;
  conn.historyGlyphs = [];
  conn.pendingGlyphs = undefined;
  conn.sendLine({ t: "sessions", list: hub.list(), active: sid });
  snapshot(conn);
}

// ---------------------------------------------------------------------------
// config — menus and buttons from the config file, sent to every device
// ---------------------------------------------------------------------------

const keyPlayers = new Map<number, KeyPlayer>();
const config = watchConfig(options.config, () => {
  for (const conn of hub.conns) if (conn.sawClientHello) sendConfig(conn);
  scheduleFlush();
});

/** Only offload replicas get the config: a loopback mirror's svc line
 *  buffer is 8 KiB and a mirror window has no menus or buttons to use it. */
function sendConfig(conn: Conn) {
  if (conn.mailbox && conn.role === "device") conn.sendLine({ t: "config", ...config.current() });
}

// ---------------------------------------------------------------------------
// client line handling
// ---------------------------------------------------------------------------

function handleLine(conn: Conn, line: ClientLine) {
  // A mirror types into its own session, and nothing else: the window exists
  // for one session, so it may not re-point itself at another, open one, or
  // close one. That binding is enforced here rather than trusted to the
  // window's guest.
  if (conn.role === "mirror" && (line.t === "attach" || line.t === "new" || line.t === "kill")) {
    return;
  }
  validateClientLine(line);
  if (line.t !== "hello" && !conn.sawClientHello) throw new Error("Hello required");
  if (options.trace) console.log(`[term] command ${line.t}, session #${conn.attachedSid}`);
  switch (line.t) {
    case "hello": {
      if (line.proto !== TERM_PROTO) throw new Error("Terminal protocol mismatch");
      conn.role = conn.mirrorSid !== undefined ? "mirror" : line.role ?? "device";
      conn.localHistory = conn.role === "device" && line.history === 1;
      conn.cols = 80; conn.rows = 24; conn.cell = [5, 10];
      conn.sawClientHello = true;
      // A hello means a replica that has loaded nothing yet, which is not the
      // same as a new socket: the console's transport is native and survives
      // a guest reload, so the fresh guest arrives on the connection that
      // already had an atlas. Re-send it or its CJK renders as blanks.
      conn.atlasSent.clear();
      conn.atlasGen = -1;
      conn.atlasQueue = [];
      conn.atlasSeq = 0;

      if (conn.role === "mirror") {
        // A mirror shows one session and changes nothing about it: it takes
        // the session it was opened for, renders whatever size that session
        // already is, and never resizes a PTY.
        const sid = conn.mirrorSid ?? line.want;
        const session = sid === undefined ? undefined : hub.sessions.get(sid);
        if (!session) {
          conn.socket.destroy();
          hub.conns.delete(conn);
          return;
        }
        conn.cols = session.cols;
        conn.rows = session.rows;
        conn.sendLine({ t: "hello", proto: TERM_PROTO, name: options.name, sid: session.sid });
        attach(conn, session.sid);
        break;
      }

      conn.sendLine({ t: "hello", proto: TERM_PROTO, name: options.name });
      sendConfig(conn);
      // Every terminal uses the fixed primary geometry: every session tracks the driving replica's grid
      // (the tmux attach model, one window size at a time). Other replicas
      // that were sized differently get a fresh snapshot at the new size.
      for (const session of hub.sessions.values()) session.resize(conn.cols, conn.rows);
      for (const other of hub.conns) {
        if (other === conn || !other.sawClientHello) continue;
        if (other.cols !== conn.cols || other.rows !== conn.rows) {
          other.cols = conn.cols;
          other.rows = conn.rows;
          snapshot(other);
        }
      }
      // A reconnecting console names the session it was on, so the window it
      // comes back to is the one it left rather than whichever is newest.
      const wanted = line.want !== undefined ? hub.sessions.get(line.want) : undefined;
      const target = wanted ?? [...hub.sessions.values()].at(-1) ?? hub.create(conn.cols, conn.rows);
      attach(conn, target.sid);
      break;
    }
    case "new": {
      const session = hub.create(conn.cols, conn.rows);
      attach(conn, session.sid);
      break;
    }
    case "kill":
      hub.kill(line.sid);
      break;
    case "attach":
      attach(conn, line.sid);
      break;
    case "ch": {
      const session = hub.sessions.get(conn.attachedSid);
      if (session && line.s.length <= 256) {
        if (conn.scrollback !== 0) conn.scrollback = 0; // typing snaps to live
        // More than one character at a time is a paste, not typing, and a
        // program that asked for bracketed paste wants to be told which.
        session.write(line.s);
      }
      break;
    }
    case "paste": {
      const session = hub.sessions.get(conn.attachedSid);
      if (!session) break;
      if (line.phase === "single") { session.paste(line.s); conn.paste = undefined; break; }
      if (line.phase === "start") conn.paste = { sid: session.sid, text: "", at: Date.now() };
      const paste = conn.paste;
      if (!paste || paste.sid !== session.sid || Date.now() - paste.at > 15000 || paste.text.length + line.s.length > 8192) {
        conn.paste = undefined; throw new Error("Paste expired or exceeds budget");
      }
      paste.text += line.s; paste.at = Date.now();
      if (line.phase === "end") { session.paste(paste.text); conn.paste = undefined; }
      conn.scrollback = 0;
      break;
    }
    case "key": {
      const session = hub.sessions.get(conn.attachedSid);
      if (!session) break;
      if (conn.scrollback !== 0) conn.scrollback = 0;
      session.write(encodeKey(line.k, line.ctrl === 1, line.alt === 1, session.appCursor(), line.shift === 1));
      break;
    }
    case "keys": {
      const sid = conn.attachedSid;
      if (!hub.sessions.has(sid)) break;
      if (conn.scrollback !== 0) conn.scrollback = 0;
      let player = keyPlayers.get(sid);
      if (!player) keyPlayers.set(sid, player = new KeyPlayer());
      player.play(line.s, step => {
        const session = hub.sessions.get(sid);
        if (!session || session.disposed) { keyPlayers.delete(sid); return false; }
        session.write("text" in step ? step.text : encodeKey(step.key, step.ctrl, step.alt, session.appCursor(), step.shift));
        return true;
      });
      break;
    }
    case "scroll": {
      if (conn.localHistory) break;
      const session = hub.sessions.get(conn.attachedSid);
      if (!session) break;
      const max = session.core?.getScrollbackCount() ?? 0;
      conn.scrollback = Math.max(0, Math.min(max, conn.scrollback + line.d));
      // Scrolling changes this replica's view without any PTY byte to
      // announce it.
      scheduleFlush();
      break;
    }
    case "glyphs":
      if (line.reset) conn.pendingGlyphs = [];
      if (!conn.pendingGlyphs) throw new Error("Glyph demand needs an opening chunk");
      conn.pendingGlyphs.push(...[...line.one].map(ch => [ch.codePointAt(0)!, 1] as [number, number]),
        ...[...line.two].map(ch => [ch.codePointAt(0)!, 2] as [number, number]));
      if (conn.pendingGlyphs.length > 1024) { conn.pendingGlyphs = undefined; throw new Error("Visible glyph budget exceeded"); }
      if (!line.more) { conn.historyGlyphs = conn.pendingGlyphs; conn.pendingGlyphs = undefined; }
      scheduleFlush();
      break;
    case "resync":
      conn.atlasSent.clear(); conn.atlasQueue = [];
      snapshot(conn);
      break;
  }
}

// ---------------------------------------------------------------------------
// loopback mirror wire server
// ---------------------------------------------------------------------------

function acceptSocket(socket: Socket, mirrorSid?: number) {
  if (hub.conns.size >= 64) { socket.destroy(); return; }
  socket.setTimeout(15000, () => socket.destroy());
  socket.setNoDelay(true);
  const conn = new Conn(socket);
  conn.mirrorSid = mirrorSid;

  socket.on("data", (chunk: Buffer) => {
    conn.lastRx = Date.now();
    let bytes = new Uint8Array(chunk);
    try {
      if (conn.hello !== null) {
        const merged = new Uint8Array(conn.hello.length + bytes.length);
        merged.set(conn.hello);
        merged.set(bytes, conn.hello.length);
        const hello = parseHello(merged);
        if (hello === null) {
          conn.hello = merged;
          return;
        }
        if (hello.app !== TERM_APP) throw new Error(`unknown app "${hello.app}"`);
        conn.hello = null;
        socket.write(encodeHelloAck());
        hub.conns.add(conn);
        console.log(`[term] device connected (${socket.remoteAddress ?? "?"})`);
        bytes = merged.slice(hello.consumed);
        if (bytes.length === 0) return;
      }
      for (const frame of conn.parser.push(bytes)) {
        if (frame.type === WIRE_MSG.pong) continue;
        if (frame.type !== WIRE_MSG.ctrl) continue; // forward compatibility
        const text = new TextDecoder().decode(frame.payload);
        try {
          handleLine(conn, JSON.parse(text) as ClientLine);
        } catch {
          // A malformed device line is a device bug; skip it rather than drop.
        }
      }
    } catch (error) {
      console.log(`[term] dropping device: ${(error as Error).message}`);
      socket.destroy();
    }
  });

  const cleanup = () => {
    hub.conns.delete(conn);
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}
const server = createServer(socket => acceptSocket(socket));

let pingToken = 1;
setInterval(() => {
  const now = Date.now();
  for (const conn of hub.conns) {
    if (conn.mailbox) continue;
    if (now - conn.lastRx > SILENCE_TIMEOUT_MS) {
      console.log("[term] device silent, dropping");
      conn.socket.destroy();
      hub.conns.delete(conn);
      continue;
    }
    const token = new Uint8Array(4);
    new DataView(token.buffer).setUint32(0, pingToken++ >>> 0, true);
    conn.socket.write(encodeFrame(WIRE_MSG.ping, token));
  }
}, PING_INTERVAL_MS);

let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushAll(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // What a session is running changes without any output to announce it —
  // launching an editor, or leaving one.
  for (const session of hub.sessions.values()) session.refreshTitle();
  for (const conn of hub.conns) flush(conn);
  // Only visible history asks for glyph residency. Prefetching hundreds of
  // other rows must not evict the glyphs the user is currently reading.
  for (const conn of hub.conns) {
    if (conn.mailbox && Date.now() - conn.mailbox.touched > 15000) continue;
    for (const [cp, columns] of conn.historyGlyphs) {
      const slot = atlas.slotFor(cp, columns); if (slot >= 0) atlas.want(cp, columns, slot);
    }
  }
  pumpAtlasBake();
}

/** Ask for a pass shortly. Output is what makes a session worth serializing,
 *  so a session that just parsed some announces itself rather than waiting
 *  for a poll to come round. */
function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(flushAll, FLUSH_COALESCE_MS);
}

setInterval(flushAll, FLUSH_IDLE_MS);

// ---------------------------------------------------------------------------
// mirror windows
// ---------------------------------------------------------------------------

/** One desktop window per session, tracked so it closes with its session. */
const mirrors = new Map<number, ChildProcess>();
const mirrorListeners = new Map<number, ReturnType<typeof createServer>>();

/** Open a desktop window for a session. The window is an ordinary PocketJS
 *  app (mirror/) on the stock desktop host, pointed at this daemon with
 *  --svc-connect; the listener binds it to its session. */
function openMirror(sid: number, tcpPort: number): void {
  if (!options.mirror) return;
  if (!existsSync(MIRROR_BIN)) {
    console.log(
      `[term] no mirror window: ${MIRROR_BIN} is not built ` +
        `(run bun run mirror to build it), continuing without one`,
    );
    options.mirror = false;
    return;
  }
  const listener = createServer(socket => acceptSocket(socket, sid));
  mirrorListeners.set(sid, listener);
  listener.listen(0, "127.0.0.1", () => {
  if (!hub.sessions.has(sid)) { listener.close(); return; }
  const mirrorPort = (listener.address() as { port: number }).port;
  const child = spawn(
    MIRROR_BIN,
    [
      "--app", MIRROR_APP,
      "--title", `Pocket Term #${sid}`,
      "--viewport", "400x240",
      "--fixed",
      "--density", "2",
      "--companions", TERM_APP,
      "--svc-connect", `127.0.0.1:${mirrorPort}`,
    ],
    {
      env: { ...process.env, POCKETJS_DIST: join(ROOT, "dist"), RUST_LOG: "warn" },
      stdio: "ignore",
      detached: false,
    },
  );
  mirrors.set(sid, child);
  child.on("exit", () => {
    if (mirrors.get(sid) === child) { mirrors.delete(sid); listener.close(); mirrorListeners.delete(sid); }
  });
  child.on("error", (error) => {
    console.log(`[term] mirror window for #${sid} failed: ${error.message}`);
    mirrors.delete(sid); listener.close(); mirrorListeners.delete(sid);
  });
  });
}

function closeMirror(sid: number): void {
  mirrorListeners.get(sid)?.close(); mirrorListeners.delete(sid);
  const child = mirrors.get(sid);
  if (!child) return;
  mirrors.delete(sid);
  child.kill();
}

function closeAllMirrors(): void {
  for (const listener of mirrorListeners.values()) listener.close();
  mirrorListeners.clear();
  for (const [, child] of mirrors) child.kill();
  mirrors.clear();
}

for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    closeAllMirrors();
    for (const session of hub.sessions.values()) session.dispose();
    if (signal !== "exit") process.exit(0);
  });
}

const started = () => {
  const bound = (server.address() as { port: number }).port;
  console.log(`[term] PKNT listener on tcp/${bound} (app "${TERM_APP}")`);
  if (options.mirror) {
    // Every session gets a window, including ones that already exist when
    // the mirror feature comes up.
    hub.onSessionCreated = (sid) => openMirror(sid, bound);
    for (const sid of hub.sessions.keys()) openMirror(sid, bound);
  }
};

// Local applications can already occupy the preferred port. Dedicated
// mirror listeners carry their actual ports, so the control listener may
// fall back to an ephemeral one.
server.once("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EADDRINUSE") throw error;
  console.log(`[term] tcp/${options.port} is taken — falling back to an ephemeral port`);
  server.listen(0, "127.0.0.1");
});
server.once("listening", started);
server.listen(options.port, "127.0.0.1");

console.log(`[term] shell ${options.shell}, host name "${options.name}"`);

// Authenticated local capability broker. The LAN transport only forwards to
// this process; reconnecting its worker never tears down a PTY.
const epoch = randomUUID(), token = randomBytes(32).toString("hex");
const replicas = new Map<string, Conn>();
type VoiceState = "recording" | "transcribing" | "done" | "empty" | "error" | "cancelled";
interface VoiceCapture {
  id: string;
  sid: number;
  state: VoiceState;
  createdAt: number;
  profileStartedAt: number;
  firstChunkAt?: number;
  lastChunkAt?: number;
  endAt?: number;
  resampleDoneAt?: number;
  wavReadyAt?: number;
  voxtypeStartedAt?: number;
  resultAt?: number;
  resultObservedAt?: number;
  profileLogged: boolean;
  touched: number;
  parts: Buffer[];
  receivedChunks: Map<number, string>;
  bytes: number;
  chunks: number;
  child?: ChildProcess;
  directory?: string;
  error?: string;
}
const voiceCaptures = new Map<string, VoiceCapture>();
const VOICE_SAMPLE_RATE = 16364.479;
const VOICE_MAX_BYTES = Math.ceil(VOICE_SAMPLE_RATE * 2 * 60);
const VOICE_CHUNK_BYTES = 1800;
const VOICE_MAX_CHUNKS = Math.ceil(VOICE_MAX_BYTES / VOICE_CHUNK_BYTES);

function voiceCapture(id: unknown): VoiceCapture {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid dictation id");
  const capture = voiceCaptures.get(id);
  if (!capture) throw new Error("Dictation session expired");
  capture.touched = Date.now();
  return capture;
}

function resampleVoiceWav(parts: Buffer[], byteLength: number): Buffer {
  const pcm = Buffer.concat(parts, byteLength);
  const inputFrames = Math.floor(pcm.length / 2);
  const outputFrames = Math.floor(inputFrames * 16000 / VOICE_SAMPLE_RATE);
  const outputBytes = outputFrames * 2;
  const wav = Buffer.allocUnsafe(44 + outputBytes);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + outputBytes, 4); wav.write("WAVE", 8);
  wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(outputBytes, 40);
  for (let i = 0; i < outputFrames; i += 1) {
    const position = i * VOICE_SAMPLE_RATE / 16000;
    const left = Math.floor(position), fraction = position - left;
    const a = pcm.readInt16LE(left * 2);
    const b = left + 1 < inputFrames ? pcm.readInt16LE((left + 1) * 2) : a;
    const sample = Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * fraction)));
    wav.writeInt16LE(sample, 44 + i * 2);
  }
  return wav;
}

function voxtypeTranscript(output: string): string {
  if (output.includes("No speech detected, skipping transcription.")) return "";
  // Voxtype 1.0.1 prints progress lines, then the transcript after a blank
  // line. `transcribe` writes to stdout; its configured output mode does not
  // control this command.
  const separator = output.lastIndexOf("\n\n");
  return (separator >= 0 ? output.slice(separator + 2) : output)
    .replace(/[\r\n]+$/, "");
}

function logVoiceProfile(capture: VoiceCapture) {
  if (capture.profileLogged || capture.resultAt === undefined || capture.resultObservedAt === undefined) return;
  capture.profileLogged = true;
  const ms = (start: number | undefined, end: number | undefined) =>
    start === undefined || end === undefined ? null : Math.round((end - start) * 10) / 10;
  console.log(`[voice-profile] ${JSON.stringify({
    id: capture.id.slice(0, 8),
    result: capture.state,
    pcmBytes: capture.bytes,
    chunks: capture.chunks,
    audioMs: Math.round(capture.bytes / 2 / VOICE_SAMPLE_RATE * 1000),
    beginToEndMs: ms(capture.profileStartedAt, capture.endAt),
    firstToLastChunkMs: ms(capture.firstChunkAt, capture.lastChunkAt),
    lastChunkToEndMs: ms(capture.lastChunkAt, capture.endAt),
    wavPrepMs: ms(capture.endAt, capture.resampleDoneAt),
    wavWriteMs: ms(capture.resampleDoneAt, capture.wavReadyAt),
    voxtypeMs: ms(capture.voxtypeStartedAt, capture.resultAt),
    endToResultMs: ms(capture.endAt, capture.resultAt),
    resultToPollMs: ms(capture.resultAt, capture.resultObservedAt),
  })}`);
}

function completeVoiceCapture(capture: VoiceCapture) {
  capture.resultAt ??= performance.now();
  capture.touched = Date.now();
  cleanVoiceFiles(capture);
}

function cleanVoiceFiles(capture: VoiceCapture) {
  if (!capture.directory) return;
  try { rmSync(capture.directory, { recursive: true, force: true }); } catch { /* best effort */ }
  capture.directory = undefined;
}

function transcribeVoice(capture: VoiceCapture) {
  try {
    const directory = mkdtempSync(join(tmpdir(), "pocket-term-voice-"));
    capture.directory = directory;
    const wavPath = join(directory, "capture.wav");
    const wav = resampleVoiceWav(capture.parts, capture.bytes);
    capture.resampleDoneAt = performance.now();
    writeFileSync(wavPath, wav, { mode: 0o600 });
    capture.wavReadyAt = performance.now();
    capture.parts = [];
    capture.voxtypeStartedAt = performance.now();
    const child = spawn("voxtype", ["transcribe", wavPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    capture.child = child;
    let diagnostic = "", outputBytes = 0, outputTooLarge = false, settled = false;
    const outputParts: Buffer[] = [];
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      capture.state = "error";
      capture.error = "Voxtype transcription timed out";
      settled = true;
      completeVoiceCapture(capture);
    }, 5 * 60 * 1000);
    child.stdout?.on("data", chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) {
        outputTooLarge = true;
        child.kill("SIGTERM");
        return;
      }
      outputParts.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", chunk => { diagnostic = (diagnostic + String(chunk)).slice(-500); });
    child.once("error", error => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      capture.child = undefined;
      capture.state = "error"; capture.error = error.message.slice(0, 160);
      completeVoiceCapture(capture);
    });
    child.once("close", code => {
      if (settled) return;
      settled = true; clearTimeout(timeout); capture.child = undefined;
      if (capture.state === "cancelled") { completeVoiceCapture(capture); return; }
      if (outputTooLarge) {
        capture.state = "error"; capture.error = "Voxtype output exceeded limit";
        completeVoiceCapture(capture); return;
      }
      if (code !== 0) {
        capture.state = "error";
        capture.error = (diagnostic.trim() || `Voxtype exited with code ${code}`).slice(-160);
        completeVoiceCapture(capture); return;
      }
      try {
        const transcript = voxtypeTranscript(Buffer.concat(outputParts).toString("utf8"));
        if (!transcript.trim()) capture.state = "empty";
        else if (transcript.length > 8192) throw new Error("Dictation transcript exceeds limit");
        else {
          const session = hub.sessions.get(capture.sid);
          if (!session) throw new Error("Terminal session closed before dictation completed");
          session.paste(transcript);
          capture.state = "done";
          scheduleFlush();
        }
      } catch (error) {
        capture.state = "error";
        capture.error = String(error).slice(0, 160);
      }
      completeVoiceCapture(capture);
    });
  } catch (error) {
    capture.state = "error";
    capture.error = String(error).slice(0, 160);
    completeVoiceCapture(capture);
  }
}

function handleVoiceRequest(path: string, body: string): string {
  const input = JSON.parse(body) as Record<string, unknown>;
  if (path === "/voice/begin") {
    const sid = input.sid;
    if (!Number.isSafeInteger(sid) || (sid as number) < 1 || !hub.sessions.has(sid as number)) throw new Error("Terminal no longer exists");
    if (typeof input.sampleRate !== "number" || Math.abs(input.sampleRate - VOICE_SAMPLE_RATE) > 0.5) throw new Error("Unsupported microphone sample rate");
    const active = [...voiceCaptures.values()].filter(c => c.state === "recording" || c.state === "transcribing");
    if (active.length >= 2) throw new Error("Dictation limit reached");
    const id = randomUUID(), now = Date.now();
    voiceCaptures.set(id, {
      id, sid: sid as number, state: "recording", createdAt: now,
      profileStartedAt: performance.now(), profileLogged: false,
      touched: now, parts: [], receivedChunks: new Map(), bytes: 0, chunks: 0,
    });
    return JSON.stringify({ id, state: "recording" });
  }

  const capture = voiceCapture(input.id);
  if (path === "/voice/chunk") {
    if (capture.state !== "recording") throw new Error("Dictation is not recording");
    if (!Number.isSafeInteger(input.seq) || (input.seq as number) < 0 || (input.seq as number) >= VOICE_MAX_CHUNKS || typeof input.data !== "string" || input.data.length > 2400 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) throw new Error("Invalid audio chunk");
    const seq = input.seq as number;
    const prior = capture.receivedChunks.get(seq);
    if (prior !== undefined) {
      if (prior === input.data) return JSON.stringify({ seq, duplicate: true });
      throw new Error("Conflicting audio chunk retry");
    }
    const bytes = Buffer.from(input.data, "base64");
    if (bytes.length === 0 || bytes.length > VOICE_CHUNK_BYTES || bytes.length % 2 || bytes.toString("base64") !== input.data) throw new Error("Invalid PCM data");
    if (capture.bytes + bytes.length > VOICE_MAX_BYTES) throw new Error("Dictation reached the 60 second limit");
    const receivedAt = performance.now();
    capture.firstChunkAt ??= receivedAt;
    capture.lastChunkAt = receivedAt;
    capture.parts[seq] = bytes;
    capture.receivedChunks.set(seq, input.data);
    capture.bytes += bytes.length; capture.chunks += 1;
    return JSON.stringify({ seq });
  }
  if (path === "/voice/end") {
    if (capture.state === "recording") {
      if (!Number.isSafeInteger(input.chunks) || (input.chunks as number) < 0 || (input.chunks as number) > VOICE_MAX_CHUNKS || capture.chunks !== input.chunks || capture.parts.length !== input.chunks) throw new Error("Audio chunks are incomplete");
      for (let seq = 0; seq < (input.chunks as number); seq += 1) {
        if (!capture.parts[seq]) throw new Error("Audio chunks are incomplete");
      }
      capture.state = "transcribing";
      capture.endAt = performance.now();
      transcribeVoice(capture);
    }
    return JSON.stringify({ state: capture.state });
  }
  if (path === "/voice/status") {
    if (capture.state !== "recording" && capture.state !== "transcribing") {
      capture.resultObservedAt ??= performance.now();
      logVoiceProfile(capture);
    }
    return JSON.stringify({ state: capture.state, error: capture.error });
  }
  if (path === "/voice/cancel") {
    if (capture.state === "recording" || capture.state === "transcribing") {
      capture.state = "cancelled";
      capture.resultAt = performance.now();
      capture.child?.kill("SIGTERM");
      capture.parts = [];
      cleanVoiceFiles(capture);
    }
    return JSON.stringify({ state: capture.state });
  }
  throw new Error("Unknown dictation route");
}

const broker = createHttpServer(async (request, response) => {
  if (request.method !== "POST" || !["/exchange", "/history", "/history-batch", "/input", "/voice/begin", "/voice/chunk", "/voice/end", "/voice/status", "/voice/cancel", "/files"].includes(request.url ?? "") || request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(403).end(); return;
  }
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > 4096) throw new Error("Request exceeds budget");
    }
    if (request.url?.startsWith("/voice/")) {
      response.setHeader("content-type", "application/json");
      response.end(handleVoiceRequest(request.url, body));
      return;
    }
    if (request.url === "/files") {
      const input = JSON.parse(body) as FilesRequest;
      if (!Number.isSafeInteger(input.sid)) throw new Error("Invalid session");
      const session = hub.sessions.get(input.sid);
      const cwd = input.path === undefined && session ? processCwd(session.pty.pid) : undefined;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(listFiles(input, cwd)));
      return;
    }
    if (request.url === "/history-batch") {
      const input = JSON.parse(body) as HistoryBatchRequest;
      validateHistoryBatch(input);
      const session = hub.sessions.get(input.sid);
      if (!session?.core) throw new Error("Terminal no longer exists");
      // Validate every address before reading any cells. Appends preserve
      // absolute rows; pruning or a changed epoch rejects the batch.
      for (const row of input.rows) session.history.offset(row, input.epoch);
      const reply = historyBatchReply(input, row => {
        const offset = session.history.offset(row, input.epoch), cells: Cell[] = [];
        for (let x = 0; x < session.cols; x++) {
          const cell = resolveCell(session.core!.getScrollbackCell(offset, x)); classify(cell, false); cells.push(cell);
        }
        return JSON.stringify(rowRuns(cells));
      });
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(reply));
      return;
    }
    if (request.url === "/history") {
      const input = JSON.parse(body) as HistoryRequest;
      if (!Number.isSafeInteger(input.sid) || !Number.isSafeInteger(input.part) || input.part < 0 || input.part > Math.ceil(HISTORY.rowChars / HISTORY.fragmentChars)) throw new Error("Invalid history request");
      const session = hub.sessions.get(input.sid);
      if (!session?.core) throw new Error("Terminal no longer exists");
      const offset = session.history.offset(input.row, input.epoch);
      const cells: Cell[] = [];
      for (let x = 0; x < session.cols; x++) {
        const cell = resolveCell(session.core.getScrollbackCell(offset, x)); classify(cell, false); cells.push(cell);
      }
      const raw = JSON.stringify(rowRuns(cells));
      if (raw.length > HISTORY.rowChars) throw new Error("History row exceeds budget");
      const parts = Math.ceil(raw.length / HISTORY.fragmentChars);
      if (input.part >= parts) throw new Error("Invalid history fragment");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ epoch: input.epoch, row: input.row, part: input.part, parts,
        data: raw.slice(input.part * HISTORY.fragmentChars, (input.part + 1) * HISTORY.fragmentChars) }));
      scheduleFlush();
      return;
    }
    const input = JSON.parse(body) as ExchangeRequest;
    if (typeof input.replica !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(input.replica)) throw new Error("Invalid replica");
    let conn = replicas.get(input.replica);
    if (!conn) {
      if (replicas.size >= LIMITS.replicas) {
        const idle = [...replicas].sort((a, b) => a[1].mailbox!.touched - b[1].mailbox!.touched)[0];
        if (idle && Date.now() - idle[1].mailbox!.touched > 15000) {
          replicas.delete(idle[0]); hub.conns.delete(idle[1]);
        }
      }
      if (replicas.size >= LIMITS.replicas) throw new Error("Replica limit reached");
      // This adapter owns no socket; PTYs and views remain in the same hub
      // as the loopback desktop mirrors.
      conn = new Conn({ destroy() {}, writableLength: 0 } as unknown as Socket);
      conn.mailbox = new Mailbox(); replicas.set(input.replica, conn); hub.conns.add(conn);
    }
    const reply = request.url === "/input"
      ? conn.mailbox!.input(input as unknown as import("../shared/exchange.ts").InputRequest, `${epoch}-${conn.mailbox!.identity}`, line => handleLine(conn!, line))
      : conn.mailbox!.exchange(input, `${epoch}-${conn.mailbox!.identity}`, line => handleLine(conn!, line));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(reply));
    if (!conn.mailbox!.busy) scheduleFlush();
  } catch (error) { response.writeHead(400).end(String(error).slice(0, 160)); }
});
broker.requestTimeout = 5000;
broker.listen(0, "127.0.0.1", () => {
  const endpoint = `http://127.0.0.1:${(broker.address() as { port: number }).port}/exchange`;
  process.send?.({ ready: true, endpoint, token });
  console.log("[term] durable terminal worker ready (paired offload + loopback mirrors)");
});
setInterval(() => {
  const now = Date.now();
  for (const [id, capture] of voiceCaptures) {
    if (capture.state === "recording" && now - capture.createdAt > 75_000) {
      capture.state = "error"; capture.error = "Dictation expired"; capture.parts = []; capture.touched = now;
    }
    if (now - capture.touched > 10 * 60 * 1000) {
      capture.child?.kill("SIGTERM"); cleanVoiceFiles(capture); voiceCaptures.delete(id);
    }
  }
  for (const [id, conn] of replicas) {
    if (now - conn.mailbox!.touched > 30 * 60 * 1000) {
      replicas.delete(id); hub.conns.delete(conn);
    }
  }
}, 60000).unref();

process.once("exit", () => {
  for (const capture of voiceCaptures.values()) {
    capture.child?.kill("SIGTERM");
    cleanVoiceFiles(capture);
  }
});

function validateClientLine(line: ClientLine) {
  if (!line || typeof line !== "object") throw new Error("Invalid terminal command");
  const integer = (n: unknown, min: number, max: number) => typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
  switch (line.t) {
    case "hello":
      if (!integer(line.cols, 20, 200) || !integer(line.rows, 5, 80) ||
          (line.role !== undefined && line.role !== "device" && line.role !== "mirror") ||
          (line.cell && (!integer(line.cell[0], 1, 32) || !integer(line.cell[1], 1, 40)))) throw new Error("Invalid terminal dimensions");
      return;
    case "ch": case "paste":
      if (typeof line.s !== "string" || line.s.length > 256) throw new Error("Input exceeds budget");
      if (line.t === "paste" && !["start", "more", "end", "single"].includes(line.phase)) throw new Error("Invalid paste phase");
      return;
    case "key":
      if (typeof line.k !== "string" || line.k.length > 16) throw new Error("Invalid key"); return;
    case "keys":
      if (typeof line.s !== "string" || line.s.length > KEYSEQ_LIMITS.chars) throw new Error("Invalid key sequence"); return;
    case "glyphs":
      if (typeof line.one !== "string" || typeof line.two !== "string" || line.one.length + line.two.length > 448 || [...line.one, ...line.two].length > 224) throw new Error("Glyph demand exceeds budget"); return;
    case "kill": case "attach":
      if (!integer(line.sid, 1, Number.MAX_SAFE_INTEGER)) throw new Error("Invalid session"); return;
    case "scroll":
      if (!integer(line.d, -2000, 2000)) throw new Error("Invalid scroll"); return;
    case "new": case "resync": return;
    default: throw new Error("Unknown terminal command");
  }
}
