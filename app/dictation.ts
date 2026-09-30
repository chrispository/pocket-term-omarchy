import { offload } from "@pocketjs/framework/offload";
import { microphoneHost, MICROPHONE_SAMPLE_RATE } from "@pocketjs/framework/microphone";

export type DictationState =
  | "ready" | "unavailable" | "starting" | "recording" | "finishing"
  | "transcribing" | "done" | "error";

const CHUNK_BYTES = 1200;
const MAX_CAPTURE_BYTES = 1_950_000;
const MAX_QUEUED_BYTES = 256 * 1024;
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

interface QueuedChunk { data: string; bytes: number }

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
  let capturedBytes = 0, queuedBytes = 0, carryLength = 0;
  let carry = new Uint8Array(CHUNK_BYTES);
  const chunks: QueuedChunk[] = [];

  const setState = (next: DictationState) => {
    if (state === next) return;
    state = next;
    onState(next);
  };

  const request = (method: string, payload: string, done: (result: { ok: true; value: string } | { ok: false; error: string }) => void) => {
    if (!io || requestInFlight || !io.connected()) return false;
    try {
      const ticket = io.request(method, payload, result => {
        requestInFlight = false;
        if (!disposed) done(result);
      });
      if (!ticket) return false;
      requestInFlight = true;
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

  const fail = () => {
    if (active) microphone?.stop();
    active = false;
    drained = true;
    chunks.length = 0;
    carryLength = 0;
    queuedBytes = 0;
    beginPending = false;
    cancelled = true;
    cancelHostCapture();
    setState("error");
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
        chunks.push({ data: encodeBase64(carry), bytes: carryLength });
        queuedBytes += carryLength;
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
    if (!microphone || !io || !io.connected()) { setState("error"); return; }
    const sid = session();
    if (!Number.isSafeInteger(sid) || sid < 1) { setState("error"); return; }
    if (!microphone.start()) { setState("error"); return; }

    captureId = ""; targetSession = sid; sequence = 0;
    active = true; drained = false; beginPending = true;
    cancelled = false;
    capturedBytes = 0; queuedBytes = 0; carryLength = 0; chunks.length = 0;
    carry = new Uint8Array(CHUNK_BYTES); retries = 0;
    setState("starting");
  };

  const pumpBegin = () => {
    if (!beginPending || captureId || requestInFlight) return;
    const started = request("term.voice.begin", JSON.stringify({ sid: targetSession, sampleRate: MICROPHONE_SAMPLE_RATE }), result => {
      beginPending = false;
      if (!result.ok) { fail(); return; }
      try {
        const reply = JSON.parse(result.value) as { id?: unknown };
        if (typeof reply.id !== "string" || reply.id.length > 80) throw new Error("Invalid dictation session");
        captureId = reply.id;
        if (cancelled) { cancelHostCapture(); return; }
        setState(active ? "recording" : "finishing");
      } catch { fail(); }
    });
    if (!started) retryAt = frameNumber + 2;
  };

  const pumpChunk = () => {
    if (!captureId || requestInFlight || chunks.length === 0 || frameNumber < retryAt) return;
    const chunk = chunks[0];
    const started = request("term.voice.chunk", JSON.stringify({ id: captureId, seq: sequence, data: chunk.data }), result => {
      if (!result.ok) {
        retries += 1;
        if (retries >= 5) { fail(); return; }
        retryAt = frameNumber + 2;
        return;
      }
      chunks.shift();
      queuedBytes -= chunk.bytes;
      sequence += 1;
      retries = 0;
      retryAt = frameNumber;
    });
    if (!started) retryAt = frameNumber + 2;
  };

  const pumpEnd = () => {
    if (state !== "finishing" || !drained || !captureId || requestInFlight || chunks.length || carryLength) return;
    if (!request("term.voice.end", JSON.stringify({ id: captureId }), result => {
      if (!result.ok) {
        retries += 1;
        if (retries >= 5) { fail(); return; }
        retryAt = frameNumber + 2;
        return;
      }
      retries = 0;
      setState("transcribing");
      pollAt = frameNumber + 30;
    })) retryAt = frameNumber + 2;
  };

  const pollStatus = () => {
    if (state !== "transcribing" || requestInFlight || frameNumber < pollAt || !captureId) return;
    if (!request("term.voice.status", JSON.stringify({ id: captureId }), result => {
      pollAt = frameNumber + 30;
      if (!result.ok) return;
      try {
        const reply = JSON.parse(result.value) as { state?: unknown };
        if (reply.state === "done" || reply.state === "empty") {
          clearAt = frameNumber + 120;
          setState("done");
        } else if (reply.state === "error") setState("error");
        else if (reply.state !== "transcribing") setState("error");
      } catch { setState("error"); }
    })) pollAt = frameNumber + 30;
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
      if (state === "done" && frameNumber >= clearAt) setState("ready");

      if ((active || state === "finishing") && io && !io.connected()) { fail(); return; }
      if (active && microphone) {
        try {
          const samples = microphone.read();
          if (samples.length) enqueueBytes(samples);
        } catch { fail(); return; }
        if (capturedBytes >= MAX_CAPTURE_BYTES || queuedBytes >= MAX_QUEUED_BYTES) finish();
      } else if (state === "finishing" && !drained && microphone) {
        try {
          const samples = microphone.read();
          if (samples.length) enqueueBytes(samples);
          else {
            drained = true;
            if (carryLength > 0) {
              const final = carry.slice(0, carryLength);
              chunks.push({ data: encodeBase64(final), bytes: carryLength });
              queuedBytes += carryLength;
              carryLength = 0;
            }
          }
        } catch { fail(); return; }
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
      active = false; disposed = true;
      chunks.length = 0;
      carryLength = 0;
    },
  };
}
