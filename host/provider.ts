import { connectOffloadProvider } from "@pocketjs/framework/offload/provider";
import { tracing, traceAs } from "./trace.ts";
const config = JSON.parse(process.env.POCKET_TERM_PROVIDER!);
if (tracing) { traceAs("provider"); (await import("./trace-socket.ts")).sampleTcp(config.address); }
const provider = connectOffloadProvider({
  address: config.address, port: config.port, key: config.key, worker: new URL("./worker.ts", import.meta.url),
  data: { endpoint: config.endpoint, token: config.token }, log: console.log,
});
process.on("SIGTERM", () => { provider.close(); process.exit(0); });
