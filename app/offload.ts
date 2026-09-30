import { offload } from "@pocketjs/framework/offload";
import { LIMITS, fitsRecord, type ExchangeReply, type ExchangeRequest, type InputCommand, type InputReply } from "../shared/exchange.ts";
import type { ClientLine, HostInputLine, HostLine } from "../shared/protocol.ts";
import type { TermChannel } from "./channel.ts";

type IO = Pick<ReturnType<typeof offload>, "connected" | "session" | "request" | "cancel">;

/** Input and output have independent tickets. One ordered input batch stays
 * in flight; its ids survive uncertain replies. Output keeps its own cursor
 * and cannot hold a key behind a large grid or atlas fragment. While output
 * is flowing, several exchanges ask for successive fragments at once, so a
 * screen of output costs one round trip instead of one per fragment; idle,
 * a single exchange waits on the companion. */
export function createTermChannel(io: IO, replica = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`): TermChannel {
  let epoch: string | undefined, received = 0, nextId = 1, input = 0, generation = 0, flowing = false;
  let partial = "", outputRetry = 0, inputRetry = 0, lastHello: ClientLine | undefined, error = "";
  /** Exchange tickets by the fragment each asked for, and fragments that
   *  arrived ahead of the next one owed. */
  const outputs = new Map<number, number>(), ahead = new Map<number, { data: string; more: boolean }>();
  const cancelOutputs = () => { for (const id of outputs.values()) io.cancel(id); outputs.clear(); ahead.clear(); };
  const commands: InputCommand[] = [], incoming: (HostLine | HostInputLine)[] = [];
  const enqueue = (lines: ClientLine[]) => {
    if (commands.length + lines.length > LIMITS.commands) { error = "Input queue full; wait for the companion"; return false; }
    for (const line of lines) { if (line.t === "hello") lastHello = line; commands.push({ id: nextId++, line }); }
    return true;
  };
  function adopt(reply: InputReply): boolean {
    if (typeof reply.epoch !== "string" || !Number.isSafeInteger(reply.ack) || reply.ack < 0) throw new Error("Invalid terminal reply");
    if (epoch && reply.epoch !== epoch) {
      generation++;
      if (input) io.cancel(input); input = 0; cancelOutputs();
      commands.length = 0; nextId = 1; received = 0; partial = ""; incoming.length = 0; flowing = false;
      incoming.push({ t: "transport-reset" });
      error = "Companion restarted; pending input discarded";
      epoch = reply.epoch;
      if (lastHello) enqueue([lastHello]);
      return false;
    }
    epoch = reply.epoch; error = reply.error ?? "";
    while (commands[0] && commands[0].id <= reply.ack) commands.shift();
    return true;
  }
  function pumpInput() {
    if (input || inputRetry || !epoch || !io.connected() || !commands.length) return;
    let payload = "";
    for (let n = 1; n <= Math.min(LIMITS.inputBatch, commands.length); n++) {
      const candidate = JSON.stringify({ replica, epoch, commands: commands.slice(0, n) });
      if (!fitsRecord(candidate, "term.input")) break;
      payload = candidate;
    }
    if (!payload) { error = "Input record exceeds budget"; return; }
    const ticketGeneration = generation;
    input = io.request("term.input", payload, result => {
      if (ticketGeneration !== generation) return;
      input = 0;
      if (!result.ok) { error = result.error; inputRetry = 2; return; }
      try { adopt(JSON.parse(result.value)); }
      catch (cause) { error = String(cause).slice(0, 120); inputRetry = 2; }
    });
  }
  return {
    historyIO: io,
    open: () => io.connected(), status: () => error,
    inputPending: () => commands.length > 0 || input !== 0,
    send(line) { const id = nextId; if (!enqueue([line])) return 0; pumpInput(); return id; },
    sendBatch(lines) { const accepted = enqueue(lines); if (accepted) pumpInput(); return accepted; },
    dispose() { generation++; if (input) io.cancel(input); cancelOutputs(); commands.length = incoming.length = 0; partial = ""; },
    poll() {
      if (outputRetry > 0) outputRetry--; if (inputRetry > 0) inputRetry--;
      pumpInput();
      // Before the epoch is known, one handshake; after, a window of
      // fragments while output flows. One new exchange a frame: the host
      // submits two records a frame, oldest first, and takes one reply a
      // frame, so a second would only queue a keystroke behind it.
      const window = epoch && flowing ? LIMITS.outputWindow : 1;
      let opened = 0;
      for (let want = received + 1; want <= received + window && !opened && !outputRetry && io.connected(); want++) {
        if (outputs.has(want) || ahead.has(want)) continue;
        opened++;
        const request: ExchangeRequest = { replica, epoch, received, want }, ticketGeneration = generation;
        const id = io.request("term.exchange", JSON.stringify(request), result => {
          if (ticketGeneration !== generation) return;
          if (outputs.get(want) === id) outputs.delete(want);
          if (!result.ok) { error = result.error; outputRetry = 2; return; }
          try {
            const reply = JSON.parse(result.value) as ExchangeReply;
            if (!adopt(reply)) return;
            if (!Number.isSafeInteger(reply.sequence) || reply.sequence < 0) throw new Error("Invalid terminal delivery");
            flowing = reply.data !== undefined;
            // A companion without windows answers every request with the
            // next fragment owed; keep whatever sequence arrives.
            if (reply.data !== undefined && reply.sequence > received) {
              if (reply.sequence > received + LIMITS.outputWindow || typeof reply.data !== "string") throw new Error("Invalid terminal delivery");
              ahead.set(reply.sequence, { data: reply.data, more: reply.more === true });
            }
            for (let next = ahead.get(received + 1); next; next = ahead.get(received + 1)) {
              ahead.delete(received + 1); received++;
              if (partial.length + next.data.length > LIMITS.lineChars) throw new Error("Invalid terminal delivery");
              partial += next.data;
              if (!next.more) { incoming.push(JSON.parse(partial)); partial = ""; }
            }
          } catch (cause) { error = String(cause).slice(0, 120); outputRetry = 2; }
        });
        if (!id) break; // every pending ticket is taken; ask next frame
        outputs.set(want, id);
      }
      return incoming.splice(0);
    },
  };
}

export function connectTermOffload(): TermChannel | null {
  if (!(globalThis as { offload?: unknown }).offload) return null;
  return createTermChannel(offload());
}
