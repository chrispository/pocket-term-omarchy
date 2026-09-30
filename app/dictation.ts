import { offload } from "@pocketjs/framework/offload";
import { microphoneHost, MICROPHONE_SAMPLE_RATE } from "@pocketjs/framework/microphone";

export type DictationState =
  | "ready" | "unavailable" | "starting" | "recording" | "finishing" | "empty"
  | "transcribing" | "done" | "error" | "link-error" | "session-error"
  | "microphone-error" | "host-error" | "transcription-error";

// A 1,800-byte PCM chunk base64-encodes to 2,400 chars, fitting the pinned
// PocketJS offload payload budget with this request's id and sequence fields.
const CHUNK_BYTES = 1800;
// Keep two of PocketJS's eight pending tickets available for terminal input
// and screen exchange while dictation uploads in parallel.
const MAX_CHUNK_REQUESTS = 6;
const STATUS_POLL_FRAMES = 8;
const MAX_CAPTURE_BYTES = 1_950_000;
const MAX_QUEUED_BYTES = 256 * 1024;
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

interface QueuedChunk {
  seq: number;
  data: string;
  bytes: number;
  attempts: number;
  retryAt: number;
  inFlight: boolean;
}

function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], hasB = i + 1 < bytes.length, hasC = i + 2 < bytes.length;
    const b = hasB ? bytes[i + 1] : 0, c = hasC ? bytes[i + 2] : 0;
    out += BASE64[a >> 2] + BASE64[((a & 3) << 4) | (b >> 4)];
    out += hasB ? BASE64[((b & 15) << 2) | (c >> 6)] : "=";
    out += hasC ? BASE64[c & 63] : "=";
  }
  return out;
}

/** Captures native s16le samples and sends bounded chunks over Pocket Term's
 *  paired offload channel. The host resamples and invokes Voxtype. */
export function createDictation(session: () => number, onState: (state: DictationState) => void) {
  const microphone = microphoneHost();
  let io: ReturnType<typeof offload> | null = null;
  try {
    if ((globalThis as { offload?: unknown }).offload) io = offload();
  } catch { /* An optional host capability can be absent on other targets. */ }

  let state: DictationState = microphone && io ? "ready" : "unavailable";
  onState(state);
  let captureId = "", targetSession = -1, sequence = 0;
  let active = false, drained = false, requestInFlight = false, beginPending = false;
  let disposed = false, cancelled = false, frameNumber = 0, retryAt = 0, retries = 0, pollAt = 0, clearAt = 0;
  let capturedBytes = 0, queuedBytes = 0, carryLength = 0, chunkRequestsInFlight = 0, captureGeneration = 0;
  let carry = new Uint8Array(CHUNK_BYTES);
  const chunks = new Map<number, QueuedChunk>();

  const setState = (next: DictationState) => {
    if (state === next) return;
    state = next;
    onState(next);
  };

  const request = (method: string, payload: string, done: (result: { ok: true; value: string } | { ok: false; error: string }) => void, parallel = false) => {
    if (!io || (!parallel && requestInFlight) || !io.connected()) return false;
    try {
      const ticket = io.request(method, payload, result => {
        if (!parallel) requestInFlight = false;
        if (!disposed) done(result);
      });
      if (!ticket) return false;
      if (!parallel) requestInFlight = true;
      return true;
    } catch {
      fail();
      return false;
    }
  };

  const cancelHostCapture = () => {
    if (captureId && io?.connected() && !requestInFlight) {
      request("term.voice.cancel", JSON.stringify({ id: captureId }), () => {});
    }
  };

  const fail = (reason: DictationState = "host-error") => {
    if (active) microphone?.stop();
    active = false;
    drained = true;
    chunks.clear();
    chunkRequestsInFlight = 0;
    carryLength = 0;
    queuedBytes = 0;
    beginPending = false;
    cancelled = true;
    cancelHostCapture();
    captureGeneration += 1;
    setState(reason);
  };

  const enqueueChunk = (bytes: Uint8Array) => {
    const seq = sequence++;
    chunks.set(seq, {
      seq, data: encodeBase64(bytes), bytes: bytes.length,
      attempts: 0, retryAt: frameNumber, inFlight: false,
    });
    queuedBytes += bytes.length;
  };

  const enqueueBytes = (bytes: Uint8Array) => {
    capturedBytes += bytes.length;
    let at = 0;
    while (at < bytes.length) {
      const take = Math.min(CHUNK_BYTES - carryLength, bytes.length - at);
      carry.set(bytes.subarray(at, at + take), carryLength);
      at += take;
      carryLength += take;
      if (carryLength === CHUNK_BYTES) {
        enqueueChunk(carry);
        carry = new Uint8Array(CHUNK_BYTES);
        carryLength = 0;
      }
    }
  };

  const finish = () => {
    if (!active) return;
    microphone!.stop();
    active = false;
    drained = false;
    setState("finishing");
  };

  const begin = () => {
    if (!microphone || !io) { setState("unavailable"); return; }
    if (!io.connected()) { setState("link-error"); return; }
    const sid = session();
    if (!Number.isSafeInteger(sid) || sid < 1) { setState("session-error"); return; }
    if (!microphone.start()) { setState("microphone-error"); return; }

    captureId = ""; targetSession = sid; sequence = 0;
    active = true; drained = false; beginPending = true;
    captureGeneration += 1;
    cancelled = false;
    capturedBytes = 0; queuedBytes = 0; carryLength = 0; chunks.clear(); chunkRequestsInFlight = 0;
    carry = new Uint8Array(CHUNK_BYTES); retries = 0;
    setState("starting");
  };

  const pumpBegin = () => {
    if (!beginPending || captureId || requestInFlight) return;
    const generation = captureGeneration;
    const started = request("term.voice.begin", JSON.stringify({ sid: targetSession, sampleRate: MICROPHONE_SAMPLE_RATE }), result => {
      if (generation !== captureGeneration) return;
      beginPending = false;
      if (!result.ok) { fail("host-error"); return; }
      try {
        const reply = JSON.parse(result.value) as { id?: unknown };
        if (typeof reply.id !== "string" || reply.id.length > 80) throw new Error("Invalid dictation session");
        captureId = reply.id;
        if (cancelled) { cancelHostCapture(); return; }
        setState(active ? "recording" : "finishing");
      } catch { fail("host-error"); }
    });
    if (!started) retryAt = frameNumber + 2;
  };

  const pumpChunk = () => {
    if (!captureId || requestInFlight || chunks.size === 0) return;
    const generation = captureGeneration;
    for (const chunk of chunks.values()) {
      if (chunk.inFlight || frameNumber < chunk.retryAt) continue;
      if (chunkRequestsInFlight >= MAX_CHUNK_REQUESTS) return;
      chunk.inFlight = true;
      chunkRequestsInFlight += 1;
      const started = request("term.voice.chunk", JSON.stringify({ id: captureId, seq: chunk.seq, data: chunk.data }), result => {
        if (generation !== captureGeneration) return;
        chunk.inFlight = false;
        chunkRequestsInFlight = Math.max(0, chunkRequestsInFlight - 1);
        if (!result.ok) {
          chunk.attempts += 1;
          if (chunk.attempts >= 5) { fail("host-error"); return; }
          chunk.retryAt = frameNumber + 2;
          return;
        }
        if (chunks.get(chunk.seq) === chunk) {
          chunks.delete(chunk.seq);
          queuedBytes -= chunk.bytes;
        }
        retries = 0;
        retryAt = frameNumber;
      }, true);
      if (!started) {
        chunk.inFlight = false;
        chunkRequestsInFlight = Math.max(0, chunkRequestsInFlight - 1);
        chunk.retryAt = frameNumber + 2;
        return;
      }
    }
  };

  const pumpEnd = () => {
    if (state !== "finishing" || !drained || !captureId || requestInFlight || chunks.size || chunkRequestsInFlight || carryLength) return;
    const generation = captureGeneration;
    if (!request("term.voice.end", JSON.stringify({ id: captureId, chunks: sequence }), result => {
      if (generation !== captureGeneration) return;
      if (!result.ok) {
        retries += 1;
        if (retries >= 5) { fail("host-error"); return; }
        retryAt = frameNumber + 2;
        return;
      }
      retries = 0;
      setState("transcribing");
      pollAt = frameNumber + STATUS_POLL_FRAMES;
    })) retryAt = frameNumber + 2;
  };

  const pollStatus = () => {
    if (state !== "transcribing" || requestInFlight || frameNumber < pollAt || !captureId) return;
    const generation = captureGeneration;
    if (!request("term.voice.status", JSON.stringify({ id: captureId }), result => {
      if (generation !== captureGeneration) return;
      pollAt = frameNumber + STATUS_POLL_FRAMES;
      if (!result.ok) return;
      try {
        const reply = JSON.parse(result.value) as { state?: unknown };
        if (reply.state === "done") {
          clearAt = frameNumber + 120;
          setState("done");
        } else if (reply.state === "empty") {
          clearAt = frameNumber + 120;
          setState("empty");
        } else if (reply.state === "error") setState("transcription-error");
        else if (reply.state !== "transcribing") setState("transcription-error");
      } catch { setState("transcription-error"); }
    })) pollAt = frameNumber + STATUS_POLL_FRAMES;
  };

  return {
    toggle() {
      if (state === "recording" || state === "starting") { finish(); return; }
      if (state === "finishing" || state === "transcribing" || state === "unavailable") return;
      begin();
    },
    frame() {
      frameNumber += 1;
      if (disposed) return;
      if ((state === "done" || state === "empty") && frameNumber >= clearAt) setState("ready");

      if ((active || state === "finishing") && io && !io.connected()) { fail("link-error"); return; }
      if (active && microphone) {
        try {
          const samples = microphone.read();
          const bytes = samples instanceof Uint8Array ? samples : new Uint8Array(samples);
          if (bytes.length) enqueueBytes(bytes);
        } catch { fail("microphone-error"); return; }
        if (capturedBytes >= MAX_CAPTURE_BYTES || queuedBytes >= MAX_QUEUED_BYTES) finish();
      } else if (state === "finishing" && !drained && microphone) {
        try {
          const samples = microphone.read();
          const bytes = samples instanceof Uint8Array ? samples : new Uint8Array(samples);
          if (bytes.length) enqueueBytes(bytes);
          else {
            drained = true;
            if (carryLength > 0) {
              const final = carry.slice(0, carryLength);
              enqueueChunk(final);
              carryLength = 0;
            }
          }
        } catch { fail("microphone-error"); return; }
      }

      pumpBegin();
      pumpChunk();
      pumpEnd();
      pollStatus();
    },
    dispose() {
      if (disposed) return;
      if (active) microphone?.stop();
      cancelHostCapture();
      captureGeneration += 1;
      active = false; disposed = true;
      chunks.clear();
      chunkRequestsInFlight = 0;
      carryLength = 0;
    },
  };
}
