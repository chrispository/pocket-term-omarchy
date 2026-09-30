/** Wire-level trace of the device connection. The transport lives in the
 * PocketJS provider, which this repository does not edit, so tracing hooks the
 * socket prototype instead: every framed record in either direction is logged
 * at the moment Bun hands it over, with the fields that let the report join a
 * keystroke to the reply that finally carries its echo. Kernel TCP state is
 * sampled from `ss` alongside, since retransmits on the handheld's Wi-Fi are
 * invisible from inside the process. */
import net from "node:net";
import { execFile } from "node:child_process";
import { OffloadDecoder } from "../vendor/pocketjs/tools/offload-wire.ts";
import { OFFLOAD } from "../vendor/pocketjs/contracts/spec/offload.ts";
import { trace } from "./trace.ts";

const port = OFFLOAD.port;
const methods = new Map<number, string>();
const decoders = new WeakMap<net.Socket, OffloadDecoder>();
const isDevice = (socket: net.Socket) => socket.remotePort === port;

function describeRequest(record: string) {
  const request = JSON.parse(record) as { id: number; method: string; payload: string };
  if (request.id === 0) return { ev: "wire.metrics", fields: { payload: request.payload } };
  methods.set(request.id, request.method);
  const fields: Record<string, unknown> = { id: request.id, method: request.method, bytes: record.length };
  try {
    const payload = JSON.parse(request.payload);
    if (request.method === "term.input") fields.cmds = payload.commands.map((c: { id: number; line: { t: string; s?: string; k?: string } }) => [c.id, c.line.t, c.line.s ?? c.line.k ?? ""]);
    if (request.method === "term.exchange") fields.received = payload.received;
    if (payload.trace) fields.device = payload.trace;
  } catch { /* opaque payload */ }
  return { ev: "wire.rx", fields };
}

function describeReply(record: string) {
  const reply = JSON.parse(record) as { id: number; payload?: string; error?: string };
  const method = methods.get(reply.id); methods.delete(reply.id);
  const fields: Record<string, unknown> = { id: reply.id, method, bytes: record.length, ...(reply.error ? { error: reply.error } : {}) };
  try {
    const payload = JSON.parse(reply.payload ?? "{}");
    fields.ack = payload.ack;
    if (method === "term.exchange") {
      fields.sequence = payload.sequence;
      if (payload.data !== undefined) { fields.dataLen = payload.data.length; fields.more = !!payload.more; fields.head = String(payload.data).slice(0, 40); }
    }
  } catch { /* opaque payload */ }
  return { ev: "wire.tx", fields };
}

const emit = net.Socket.prototype.emit;
net.Socket.prototype.emit = function (this: net.Socket, event: string | symbol, ...args: unknown[]) {
  if (event === "data" && isDevice(this)) {
    let decoder = decoders.get(this);
    if (!decoder) decoders.set(this, decoder = new OffloadDecoder());
    const chunk = args[0] as Buffer;
    trace("tcp.rx", { bytes: chunk.length });
    try { decoder.push(chunk, record => { const d = describeRequest(record); trace(d.ev, d.fields); }); }
    catch (error) { trace("wire.decode-error", { error: String(error) }); }
  } else if (event === "connect" && isDevice(this)) trace("tcp.connect");
  else if (event === "close" && isDevice(this)) trace("tcp.close");
  return emit.call(this, event, ...args);
} as typeof net.Socket.prototype.emit;

const write = net.Socket.prototype.write;
net.Socket.prototype.write = function (this: net.Socket, chunk: unknown, ...rest: unknown[]) {
  if (isDevice(this) && Buffer.isBuffer(chunk) && chunk.length > 4) {
    try { const d = describeReply(chunk.toString("utf8", 4)); trace(d.ev, { ...d.fields, queued: this.writableLength }); }
    catch { /* the pairing key, sent once unframed */ }
  }
  return (write as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
} as typeof net.Socket.prototype.write;

/** Kernel view of the link: smoothed RTT, retransmits and unacked segments. */
export function sampleTcp(address: string) {
  setInterval(() => {
    execFile("ss", ["-tinH", "dst", `${address}:${port}`], (error, out) => {
      if (error || !out.trim()) return;
      const pick = (name: string) => out.match(new RegExp(`\\b${name}:([\\d./]+)`))?.[1];
      trace("tcp.stats", { rtt: pick("rtt"), minrtt: pick("minrtt"), rto: pick("rto"), retrans: pick("retrans"), lost: pick("lost"), unacked: pick("unacked"), bytesRetrans: pick("bytes_retrans") });
    });
  }, 500).unref();
}
