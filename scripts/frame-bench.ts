/** Per-frame cost of the production app on the engine's WASM core.
 *
 *   bun scripts/frame-bench.ts
 *
 * The console's UI core is the same Rust as the WASM build, so its per-frame
 * work — layout in `tick`, the draw list — is the real code; only the JS
 * engine differs (JIT here, QuickJS interpreter on the ARM11), so JS time is
 * a relative figure and native op counts are the absolute one. Scenes come
 * from test/fixtures/bench.tsx.
 *
 * The last lines are the draw list's hash and the live node count at the end
 * of each scene: a change meant to render identically must keep the hashes,
 * and a growing count is a leak. BENCH_CHURN=1 lists every frame that
 * created nodes. Needs hosts/web/pocketjs.wasm (`bun tools/wasm.ts` in
 * vendor/pocketjs). */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";
import { resolve3dsBuildPlan } from "../vendor/pocketjs/tools/3ds-profile.ts";
import { ROOT } from "./paths.ts";

const VENDOR = resolve(ROOT, "vendor/pocketjs");
const root = resolve(ROOT, ".pocket/bench"); mkdirSync(root, { recursive: true });
const manifest = JSON.parse(readFileSync(resolve(ROOT, "pocket.json"), "utf8"));
manifest.id += ".bench"; manifest.app.output = "pocketterm-bench"; manifest.app.entry = "main.tsx";
writeFileSync(resolve(root, "pocket.json"), JSON.stringify(manifest));
writeFileSync(resolve(root, "main.tsx"), `import { mountBench } from "../../test/fixtures/bench.tsx";\nmountBench();\n`);
const planPath = resolve(root, "plan.json"); writeFileSync(planPath, JSON.stringify(resolve3dsBuildPlan(manifest)));
await $`bun tools/build.ts --plan=${planPath} --project-root=${root} --outdir=${root}`.cwd(VENDOR).quiet();

const { createWasmUi } = await import("../vendor/pocketjs/hosts/web/wasm-ops.js");
const { SCENES } = await import("../test/fixtures/bench.tsx");
const wasm = await createWasmUi(await Bun.file(resolve(VENDOR, "hosts/web/pocketjs.wasm")).arrayBuffer(), { width: 400, height: 240, auxiliary: [320, 240] });
let maxId = 0;
const counts = new Map<string, number>(), opTime = new Map<string, number>();
const ops = wasm.ops as unknown as Record<string, unknown>;
for (const [name, fn] of Object.entries(ops)) {
  if (typeof fn !== "function") continue;
  ops[name] = (...args: unknown[]) => {
    const start = performance.now();
    try {
      const result = (fn as (...a: unknown[]) => unknown)(...args);
      if (name === "createNode" && typeof result === "number") maxId = Math.max(maxId, result);
      return result;
    }
    finally { counts.set(name, (counts.get(name) ?? 0) + 1); opTime.set(name, (opTime.get(name) ?? 0) + performance.now() - start); }
  };
}
const g = globalThis as Record<string, unknown>;
g.ui = ops; g.__pak = await Bun.file(resolve(root, "pocketterm-bench.pak")).arrayBuffer();
g.__pocketApp = "pocketterm-bench"; g.__simHz = 60;
(0, eval)(await Bun.file(resolve(root, "pocketterm-bench.js")).text());
const frame = g.frame as (buttons: number, analog?: number, touches?: readonly number[], hits?: readonly number[], surfaces?: readonly number[]) => void;

// Touch typing: the classic layout's own geometry locates a letter and
// Shift, so the keys scene taps real keys and switches layers as a user
// typing capitals does.
const { KEYBOARD } = await import("../app/keyboard-layout.ts");
const { keyAt } = await import("../app/keyboard.tsx");
const { keyboardGeometry } = await import("../shared/keyboard.ts");
const { __packTouch } = await import("../vendor/pocketjs/framework/src/touch.ts");
const layout = KEYBOARD.layouts[KEYBOARD.defaults.layout as keyof typeof KEYBOARD.layouts];
const geometry = keyboardGeometry(layout, KEYBOARD.defaults.touchpad);
function findKey(test: (act: Record<string, unknown>) => boolean): [number, number] {
  for (let y = 1; y < geometry.rows * geometry.keyH; y += geometry.keyH)
    for (let x = 1; x < 320; x += 4) {
      const hit = keyAt(layout, "lower", x, y + geometry.keyH / 2, geometry.keyH);
      if (hit && test(hit.def.act as Record<string, unknown>)) return [x + 4, geometry.top + y + geometry.keyH / 2];
    }
  throw new Error("key not found");
}
const letter = findKey(act => act.ch === "a"), shift = findKey(act => act.mod === "shift");
const hitAux = (ops as { hitTestBoundsAuxiliary?: (x: number, y: number) => number }).hitTestBoundsAuxiliary;
/** Taps on the keys scene: down for two frames every eight, Shift before
 *  every other letter. */
function touchAt(t: number): [number, number] | undefined {
  const scene = SCENES.find(([name]) => name === "keys")!;
  if (t < scene[1] || t >= scene[2]) return;
  const step = Math.floor((t - scene[1]) / 8), phase = (t - scene[1]) % 8;
  if (phase >= 2) return;
  return step % 4 === 1 ? shift : letter;
}

type Sample = { js: number; ops: number; tick: number; draw: number; byOp: Map<string, number> };
const samples = new Map<string, Sample[]>(), hashes: string[] = [], live: string[] = [];
const last = SCENES.at(-1)![2];
for (let t = 1; t <= last; t++) {
  const before = new Map(counts), opsBefore = [...opTime.values()].reduce((a, b) => a + b, 0);
  const touch = touchAt(t);
  const touches = touch ? [__packTouch(1, touch[0], touch[1])] : undefined;
  const hits = touch && hitAux ? [hitAux(touch[0], touch[1])] : undefined;
  const start = performance.now(); frame(0, undefined, touches, hits, touch ? [1] : undefined); const js = performance.now() - start;
  const opsSpent = [...opTime.values()].reduce((a, b) => a + b, 0) - opsBefore;
  const tickStart = performance.now(); wasm.tick(); const tick = performance.now() - tickStart;
  const drawStart = performance.now(); wasm.drawHash?.(); const draw = performance.now() - drawStart;
  // The draw list's hash at each scene's last frame: a rendering change
  // that should look identical must leave these unchanged.
  for (const [scene, , to] of SCENES) if (t === to - 1) {
    hashes.push(`${scene}=${wasm.drawHash?.()}`);
    // Probe every id handed out so far: destroying a subtree's root frees
    // its children natively, so op counts cannot say what is still alive.
    let alive = 0;
    for (let id = 1; id <= maxId; id++) if ((wasm.exports.ui_node_type as (id: number) => number)(id) >= 0) alive++;
    live.push(`${scene}=${alive}`);
  }
  const name = SCENES.find(([, from, to]) => t >= from && t < to)?.[0];
  if (!name) continue;
  const byOp = new Map<string, number>();
  for (const [op, n] of counts) { const d = n - (before.get(op) ?? 0); if (d) byOp.set(op, d); }
  if (process.env.BENCH_CHURN && byOp.get("createNode")) console.log(`t=${t} ${name} ${[...byOp].map(([op, n]) => `${op}=${n}`).join(" ")}`);
  const list = samples.get(name) ?? []; list.push({ js: js - opsSpent, ops: opsSpent, tick, draw, byOp }); samples.set(name, list);
}

const pct = (xs: number[], p: number) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const f = (n: number) => n.toFixed(3).padStart(8);
for (const [name, list] of samples) {
  console.log(`\n== ${name} (${list.length} frames)       p50      p90      max  ms`);
  for (const key of ["js", "ops", "tick", "draw"] as const) {
    const xs = list.map(s => s[key]);
    console.log(`${key === "js" ? "guest JS (excl. ops)" : key === "ops" ? "native UI ops" : key === "tick" ? "core tick (layout)" : "draw list"}`.padEnd(24) + f(pct(xs, .5)) + " " + f(pct(xs, .9)) + " " + f(Math.max(...xs)));
  }
  const total = new Map<string, number>();
  for (const s of list) for (const [op, n] of s.byOp) total.set(op, (total.get(op) ?? 0) + n);
  const perFrame = [...total].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([op, n]) => `${op} ${(n / list.length).toFixed(1)}`);
  console.log("ops/frame: " + perFrame.join(", "));
  const busiest = list.reduce((a, b) => [...a.byOp.values()].reduce((x, y) => x + y, 0) >= [...b.byOp.values()].reduce((x, y) => x + y, 0) ? a : b);
  console.log("busiest frame: " + [...busiest.byOp].sort((a, b) => b[1] - a[1]).map(([op, n]) => `${op} ${n}`).join(", "));
}
console.log(`\ndraw hashes: ${hashes.join(" ")}`);
console.log(`live nodes at scene end: ${live.join(" ")}`);
