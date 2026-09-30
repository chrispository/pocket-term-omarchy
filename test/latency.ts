import { Mailbox } from "../host/exchange.ts";
import type { TermChannel } from "../app/channel.ts";
import type { HostLine } from "../shared/protocol.ts";

/** Deterministic 60 Hz native boundary: 100 ms RTT, two submissions and one
 * reply delivery per frame. Samples input arrival at the PTY capability,
 * not a network callback or an optimistic pixel. */
export function latencyScenario(factory: (io: any, replica: string) => TermChannel) {
  const mailbox = new Mailbox(), sent = new Map<number, number>(), latency: number[] = [];
  let frame = 0, requestId = 0, generation = 0, submitted = 0, peakQueue = 0;
  const pending: { id: number; method: string; request: any; sentAt: number; reply?: any; done: any; cancelled?: boolean }[] = [];
  const inputKeys: number[] = [];
  const channel = factory({ connected: () => true, session: () => 1, cancel(id: number) { const p = pending.find(p => p.id === id); if (p) p.cancelled = true; },
    request(method: string, payload: string, done: any) {
      const id = ++requestId; pending.push({ id, method, request: JSON.parse(payload), sentAt: -1, done }); return id;
    },
  }, "latency-replica");
  for (; frame < 700; frame++) {
    submitted = 0;
    for (const p of pending) {
      if (p.cancelled) continue;
      if (p.sentAt < 0 && submitted < 2) { p.sentAt = frame; submitted++; }
      if (p.sentAt < 0 || frame !== p.sentAt + 3) continue;
      const apply = (line: any) => {
        if (line.t !== "key") return;
        const n = Number(line.k); latency.push((frame - sent.get(n)!) * 1000 / 60); inputKeys.push(n);
        mailbox.push({ t: "grid", sid: 1, gen: 1, seq: generation++, rows: [], cur: [n % 80, 0, 1] });
      };
      p.reply = p.method === "term.input" ? mailbox.input(p.request, "mac", apply) : mailbox.exchange(p.request, "mac", apply);
    }
    const ready = pending.find(p => !p.cancelled && p.reply && frame >= p.sentAt + 6);
    if (ready) { ready.cancelled = true; ready.done({ ok: true, value: JSON.stringify(ready.reply) }); }
    channel.poll();
    if (frame >= 20 && frame < 200 && (frame - 20) % 3 === 0) {
      const n = (frame - 20) / 3; sent.set(n, frame); channel.send({ t: "key", k: String(n) });
    }
    peakQueue = Math.max(peakQueue, sent.size - inputKeys.length);
  }
  channel.dispose?.();
  const sorted = latency.slice().sort((a, b) => a - b);
  return { inputs: inputKeys.length, unique: new Set(inputKeys).size, ordered: inputKeys.every((n, i) => n === i), p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)], maxMs: sorted.at(-1), peakQueue };
}

/** The same 60 Hz boundary and 100 ms RTT, carrying one screen of output
 * several fragments long. The companion parks an exchange whose fragment
 * is not cut yet, as host/terminal-worker.ts does. Returns the milliseconds
 * from the line reaching the mailbox to the device holding all of it. */
export function outputScenario(factory: (io: any, replica: string) => TermChannel, line: HostLine) {
  const mailbox = new Mailbox();
  let requestId = 0, pushedAt = -1, arrivedAt = -1, fragments = 0;
  const pending: { id: number; request: any; sentAt: number; reply?: any; done: any; cancelled?: boolean }[] = [];
  const channel = factory({ connected: () => true, session: () => 1, cancel(id: number) { const p = pending.find(p => p.id === id); if (p) p.cancelled = true; },
    request(method: string, payload: string, done: any) {
      if (method !== "term.exchange" || pending.filter(p => !p.cancelled && !p.reply).length >= 8) return 0;
      const id = ++requestId; pending.push({ id, request: JSON.parse(payload), sentAt: -1, done }); return id;
    },
  }, "output-replica");
  for (let frame = 0; frame < 600 && arrivedAt < 0; frame++) {
    let submitted = 0;
    if (frame === 90) { mailbox.push(line); pushedAt = frame; }
    for (const p of pending) {
      if (p.cancelled || p.reply) continue;
      if (p.sentAt < 0 && submitted < 2) { p.sentAt = frame; submitted++; }
      if (p.sentAt < 0 || frame < p.sentAt + 3) continue;
      const reply = mailbox.exchange(p.request, "mac", () => {});
      const want = p.request.want ?? p.request.received + 1;
      // Parked until its fragment exists, or the hold expires.
      if (p.request.epoch === reply.epoch && reply.data === undefined && want > mailbox.sequence && frame < p.sentAt + 60) continue;
      if (reply.data !== undefined) fragments = Math.max(fragments, reply.sequence);
      p.reply = { reply, at: frame };
    }
    const ready = pending.find(p => !p.cancelled && p.reply && frame >= p.reply.at + 3);
    if (ready) { ready.cancelled = true; ready.done({ ok: true, value: JSON.stringify(ready.reply.reply) }); }
    for (const got of channel.poll()) if (got.t === line.t && pushedAt >= 0) arrivedAt = frame;
  }
  channel.dispose?.();
  return { ms: (arrivedAt - pushedAt) * 1000 / 60, fragments };
}
