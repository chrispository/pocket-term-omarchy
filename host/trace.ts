/** Latency trace, off unless POCKET_TERM_TRACE names a file prefix. Every
 * process — the Node terminal worker, the Bun provider and its capability
 * worker — writes its own `<prefix>.<proc>.jsonl`, so no two writers share a
 * file. Timestamps are wall-clock microseconds from `timeOrigin + now()`:
 * Bun's `hrtime` restarts at zero in each process, which makes it useless
 * for joining events across them. `scripts/trace-report.ts` merges the files. */
import { appendFileSync } from "node:fs";

const prefix = process.env.POCKET_TERM_TRACE;
export const tracing = !!prefix;
let proc = "", pending: string[] = [];

export const nowUs = () => Math.round((performance.timeOrigin + performance.now()) * 1000);

export function traceAs(name: string) {
  proc = name;
  if (!prefix) return;
  // Buffered so a traced event costs a push, not a write syscall.
  const flush = () => { if (pending.length) { appendFileSync(`${prefix}.${proc}.jsonl`, pending.join("\n") + "\n"); pending = []; } };
  const timer = setInterval(flush, 250) as { unref?: () => void };
  timer.unref?.();
  process.on("exit", flush);
}

export function trace(ev: string, fields?: Record<string, unknown>) {
  if (!prefix) return;
  pending.push(JSON.stringify({ us: nowUs(), p: proc, ev, ...fields }));
}

/** Time a synchronous span; records its duration in microseconds. */
export function span<T>(ev: string, fields: Record<string, unknown> | undefined, run: () => T): T {
  if (!prefix) return run();
  const start = performance.now();
  try { return run(); }
  finally { trace(ev, { ...fields, durUs: Math.round((performance.now() - start) * 1000) }); }
}
