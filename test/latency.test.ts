import { expect, test } from "bun:test";
import { createTermChannel } from "../app/offload.ts";
import { latencyScenario, outputScenario } from "./latency.ts";

test("20 Hz input stays bounded on a 100 ms link without dropping ordered keys", () => {
  const result = latencyScenario(createTermChannel);
  expect(result.inputs).toBe(60); expect(result.ordered).toBe(true); expect(result.unique).toBe(60);
  expect(result.p95Ms).toBeLessThanOrEqual(200); expect(result.peakQueue).toBeLessThanOrEqual(4);
});

test("a screen of output several fragments long crosses in two round trips, not one per fragment", () => {
  const names = ["node_modules", "package.json", "README.md", "tsconfig.json", "scripts", "vendor", "shared", "config.jsonc"];
  const rows = Array.from({ length: 24 }, (_, y) => [y, ...Array.from({ length: 8 }, (_, n) => [n * 10, names[(y + n) % names.length], n % 2 ? 0x81a2be : -1, -1])]);
  const result = outputScenario(createTermChannel, { t: "grid", sid: 1, gen: 1, seq: 0, rows, cur: [0, 23, 1] } as never);
  expect(result.fragments).toBe(3);
  // The first fragment leaves as soon as it is cut; the rest share one
  // further round trip (100 ms each, plus frame boundaries).
  expect(result.ms).toBeLessThanOrEqual(200);
});
