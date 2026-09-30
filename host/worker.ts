import { dispatchOffload } from "@pocketjs/framework/offload/provider";
import { nowUs, trace, traceAs } from "./trace.ts";
traceAs("worker");
declare const self: { onmessage: (event: MessageEvent) => void; postMessage(value: unknown): void };
let config: { endpoint: string; token: string };
self.onmessage = async event => {
  if (event.data.init) { config = event.data.init; return; }
  const received = nowUs();
  const forward = async (path: string, payload: string) => {
      const start = nowUs();
      const response = await fetch(config.endpoint.replace(/\/exchange$/, path), {
        method: "POST", headers: { authorization: `Bearer ${config.token}` }, body: payload,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Terminal worker: ${await response.text()}`);
      const text = await response.text();
      trace("fetch", { id: event.data.id, path, queueUs: start - received, fetchUs: nowUs() - start });
      return text;
  };
  self.postMessage(await dispatchOffload({
    "term.exchange": payload => forward("/exchange", payload),
    "term.history": payload => forward("/history", payload),
    "term.history.batch": payload => forward("/history-batch", payload),
    "term.input": payload => forward("/input", payload),
    "term.voice.begin": payload => forward("/voice/begin", payload),
    "term.voice.chunk": payload => forward("/voice/chunk", payload),
    "term.voice.end": payload => forward("/voice/end", payload),
    "term.voice.status": payload => forward("/voice/status", payload),
    "term.voice.cancel": payload => forward("/voice/cancel", payload),
    "term.files": payload => forward("/files", payload),
  }, event.data));
};
