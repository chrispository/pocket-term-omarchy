/** Join the per-process traces written under POCKET_TERM_TRACE into a
 * per-keystroke latency breakdown.
 *
 *   bun scripts/trace-report.ts <prefix> [--timeline]
 *
 * Every stage is measured on the companion; the device is seen only through
 * the records it sends. A keystroke's chain is: its term.input record arrives
 * → the worker's HTTP call → the PTY write → the shell's echo → ghostty
 * parse → flush into the mailbox → the term.exchange reply that carries it
 * leaves the socket → the device's next exchange acknowledges that sequence,
 * which bounds when the device had the bytes in hand. */
import { existsSync, readFileSync } from "node:fs";

const prefix = process.argv[2];
if (!prefix) throw new Error("usage: bun scripts/trace-report.ts <prefix> [--timeline]");
type Ev = { us: number; p: string; ev: string; [k: string]: any };
const events: Ev[] = [];
for (const proc of ["provider", "worker", "term"]) {
  const path = `${prefix}.${proc}.jsonl`;
  if (!existsSync(path)) { console.log(`(missing ${path})`); continue; }
  for (const line of readFileSync(path, "utf8").split("\n")) if (line) events.push(JSON.parse(line));
}
events.sort((a, b) => a.us - b.us);
if (!events.length) throw new Error("no events");
const t0 = events[0].us;
const ms = (us: number | undefined) => us === undefined ? "    -  " : (us / 1000).toFixed(2).padStart(7);
const pct = (xs: number[], p: number) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const stats = (name: string, xs: number[]) => {
  if (!xs.length) return;
  console.log(`${name.padEnd(34)} n=${String(xs.length).padStart(4)}  p50 ${ms(pct(xs, .5))}  p90 ${ms(pct(xs, .9))}  max ${ms(Math.max(...xs))}  ms`);
};
const after = (from: number, pred: (e: Ev) => boolean) => { for (let i = from; i < events.length; i++) if (pred(events[i])) return i; return -1; };

if (process.argv.includes("--timeline")) {
  for (const e of events) {
    const { us, p, ev, ...rest } = e;
    console.log(`${((us - t0) / 1000).toFixed(3).padStart(10)} ${p.padEnd(8)} ${ev.padEnd(16)} ${JSON.stringify(rest)}`);
  }
}

// --- per keystroke --------------------------------------------------------
const typed = new Set(["ch", "key", "keys", "paste"]);
const rows: Record<string, number | undefined>[] = [];
events.forEach((e, i) => {
  if (e.ev !== "wire.rx" || e.method !== "term.input" || !e.cmds?.some((c: any[]) => typed.has(c[1]))) return;
  const r: Record<string, number | undefined> = {};
  const label = e.cmds.map((c: any[]) => `${c[1]}:${JSON.stringify(c[2])}`).join(" ");
  const fetch = events.find(x => x.ev === "fetch" && x.id === e.id && x.us >= e.us);
  const inputTx = after(i, x => x.ev === "wire.tx" && x.id === e.id);
  const write = after(i, x => x.ev === "pty.write");
  if (write < 0) return;
  const echo = after(write, x => x.ev === "pty.data");
  const grid = echo < 0 ? -1 : after(echo, x => x.ev === "flush.grid");
  const out = grid < 0 ? -1 : after(grid, x => x.ev === "wire.tx" && x.method === "term.exchange" && x.dataLen > 0);
  const seq = out < 0 ? undefined : events[out].sequence;
  const ackd = out < 0 ? -1 : after(out, x => x.ev === "wire.rx" && x.method === "term.exchange" && x.received >= seq);
  // The exchange that carried the echo was requested before or after the
  // grid was ready; if before, it was already parked on the companion.
  const carrierRx = out < 0 ? -1 : (() => { for (let k = out; k >= 0; k--) if (events[k].ev === "wire.rx" && events[k].id === events[out].id) return k; return -1; })();
  r.rxToWrite = events[write].us - e.us;
  r.fetchHttp = fetch?.fetchUs;
  r.inputReply = inputTx < 0 ? undefined : events[inputTx].us - e.us;
  r.shellEcho = echo < 0 ? undefined : events[echo].us - events[write].us;
  r.ghostty = echo < 0 ? undefined : events[echo].ghosttyUs + events[echo].observeUs + events[echo].historyUs;
  r.echoToGrid = grid < 0 ? undefined : events[grid].us - events[echo].us;
  r.gridWaitsForPoll = out < 0 ? undefined : events[out].us - events[grid].us;
  r.carrierRequestedAfterGrid = carrierRx < 0 || grid < 0 ? undefined : events[carrierRx].us - events[grid].us;
  r.companion = out < 0 ? undefined : events[out].us - e.us;
  r.deviceAck = ackd < 0 || out < 0 ? undefined : events[ackd].us - events[out].us;
  r.total = ackd < 0 ? undefined : events[ackd].us - e.us;
  (r as any).label = label; (r as any).at = e.us - t0;
  rows.push(r);
});

const cols: [string, string][] = [
  ["rxToWrite", "wire rx → pty write"], ["fetchHttp", "worker HTTP round trip"], ["inputReply", "wire rx → input reply tx"],
  ["shellEcho", "pty write → echo bytes"], ["ghostty", "ghostty+history parse"], ["echoToGrid", "echo → grid in mailbox"],
  ["gridWaitsForPoll", "grid → exchange reply tx"], ["companion", "wire rx → echo tx (companion)"],
  ["deviceAck", "echo tx → device acks it"], ["total", "wire rx → device ack"],
];
console.log(`\n=== ${rows.length} keystrokes (companion-side clock) ===`);
for (const [key, name] of cols) stats(name, rows.map(r => r[key]).filter((x): x is number => x !== undefined));
const parked = rows.filter(r => (r.carrierRequestedAfterGrid ?? 0) < 0).length;
console.log(`echo carried by an exchange already parked on companion: ${parked}/${rows.length}` +
  " (otherwise the grid sat in the mailbox until the device's next poll arrived)");

console.log(`\n${"t(ms)".padStart(9)} ${"key".padEnd(14)}` + cols.map(([k]) => k.slice(0, 9).padStart(10)).join(""));
for (const r of rows.slice(0, 80)) {
  console.log(`${((r as any).at / 1000).toFixed(0).padStart(9)} ${String((r as any).label).slice(0, 14).padEnd(14)}` + cols.map(([k]) => ms(r[k]).padStart(10)).join(""));
}

// --- transport cadence -----------------------------------------------------
// The device can have one exchange in flight. The gap between replying to it
// and the next exchange arriving is the device's own turnaround: Wi-Fi both
// ways, the network thread's 1 ms sleeps, and the frames the guest spends
// before it asks again.
const turn: number[] = [], inFlight: number[] = [];
const byId = new Map<number, number>();
let lastTx: number | undefined;
for (const e of events) {
  if (e.method !== "term.exchange") continue;
  if (e.ev === "wire.rx") { if (lastTx !== undefined) turn.push(e.us - lastTx); byId.set(e.id, e.us); lastTx = undefined; }
  if (e.ev === "wire.tx") { lastTx = e.us; const rx = byId.get(e.id); if (rx) inFlight.push(e.us - rx); }
}
console.log("\n=== transport ===");
stats("exchange: reply tx → next request rx", turn);
stats("exchange: request rx → reply tx", inFlight);
stats("worker queue (onmessage → fetch)", events.filter(e => e.ev === "fetch").map(e => e.queueUs));
stats("worker fetch /exchange", events.filter(e => e.ev === "fetch" && e.path === "/exchange").map(e => e.fetchUs));
stats("worker fetch /input", events.filter(e => e.ev === "fetch" && e.path === "/input").map(e => e.fetchUs));
stats("term http total", events.filter(e => e.ev === "http").map(e => e.totalUs));
const methods = new Map<string, number>();
for (const e of events) if (e.ev === "wire.rx") methods.set(e.method, (methods.get(e.method) ?? 0) + 1);
console.log("requests by method:", Object.fromEntries(methods));
const span = (events.at(-1)!.us - t0) / 1e6;
console.log(`requests/s: ${(events.filter(e => e.ev === "wire.rx" && e.method).length / span).toFixed(1)} over ${span.toFixed(1)} s`);

console.log("\n=== companion internals ===");
stats("pty.data ghostty writeString", events.filter(e => e.ev === "pty.data").map(e => e.ghosttyUs));
stats("pty.data history.update", events.filter(e => e.ev === "pty.data").map(e => e.historyUs));
stats("pty.title (reads /proc)", events.filter(e => e.ev === "pty.title").map(e => e.titleUs));
stats("flush viewRows", events.filter(e => e.ev === "flush.viewRows").map(e => e.durUs));
stats("flush total (grid emitted)", events.filter(e => e.ev === "flush.grid").map(e => e.totalUs));
stats("flush timer lateness", events.filter(e => e.ev === "flush.all" && e.lateUs !== undefined).map(e => e.lateUs));
console.log(`flush skipped (mailbox busy): ${events.filter(e => e.ev === "flush.busy").length}`);
stats("event loop p99 (per second)", events.filter(e => e.ev === "loop").map(e => e.p99Us));
stats("event loop max (per second)", events.filter(e => e.ev === "loop").map(e => e.maxUs));

console.log("\n=== link ===");
const tcp = events.filter(e => e.ev === "tcp.stats");
if (tcp.length) {
  const rtts = tcp.map(e => Number(String(e.rtt).split("/")[0]) * 1000);
  stats("kernel srtt", rtts);
  console.log(`retrans first→last: ${tcp[0].retrans} → ${tcp.at(-1)!.retrans}, bytes_retrans ${tcp[0].bytesRetrans} → ${tcp.at(-1)!.bytesRetrans}`);
}
for (const e of events.filter(e => e.ev === "wire.metrics").slice(-3)) console.log("device:", e.payload);
