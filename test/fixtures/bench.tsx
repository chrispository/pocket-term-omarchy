// Frame-cost fixture for scripts/frame-bench.ts: the production app against
// an in-bundle companion that answers the way host/terminal-worker.ts does —
// one fragment per exchange, history manifest on every grid — and plays three
// scenes the bench measures separately: idle, typing, and `ls` output
// scrolling the whole screen.
import { onFrame } from "@pocketjs/framework/lifecycle";
import { mount } from "@pocketjs/framework/solid";
import { createTermStore } from "../../app/store.ts";
import { connectTermOffload } from "../../app/offload.ts";
import TermApp from "../../app/app.tsx";
import { historyBatchReply } from "../../host/history-batch.ts";
import { TERM_PROTO, type HostLine, type Run, type RowUpdate } from "../../shared/protocol.ts";

export const SCENES = [["idle", 120, 240], ["typing", 240, 480], ["ls", 480, 720], ["keys", 720, 960]] as const;
const scene = (tick: number) => SCENES.find(([, from, to]) => tick >= from && tick < to)?.[0];

const NAMES = ["app/", "assets/", "build.sh", "config.jsonc", "docs/", "host/", "LICENSE", "mirror/", "node_modules/",
  "package.json", "README.md", "scripts/", "shared/", "test/", "tsconfig.json", "vendor/", "run.sh", "notes.txt"];
const colorOf = (name: string) => name.endsWith("/") ? 0x81a2be : name.endsWith(".sh") ? 0xb5bd68 : -1;
/** One `ls` row: five names in 16-column cells, each colored run separate. */
function lsRow(line: number): Run[] {
  const runs: Run[] = []; let x = 0;
  for (let n = 0; n < 5; n++) {
    const name = NAMES[(line * 5 + n) % NAMES.length];
    // Every third line puts a CJK name (runtime atlas, two columns a glyph)
    // or a highlighted one where a plain name sat on the line before, so
    // reused run nodes switch fonts and backgrounds as the screen scrolls.
    if (n === 2 && line % 3 === 0) runs.push([x, "文档", -1, -1, 19, 4]);
    else if (n === 3 && line % 3 === 1) runs.push([x, name, 0x10151c, 0xb5bd68]);
    else runs.push([x, name, colorOf(name), -1]);
    x += 16;
  }
  return runs;
}
const promptRow = (text: string): Run[] => [[0, "chris@ap201", 0xb5bd68, -1], [11, ":", -1, -1], [12, "~/code", 0x81a2be, -1], [18, "$ " + text, -1, -1]];

export function mountBench() {
  const queue: string[] = []; let sequence = 0, ack = 0, held: any, gen = 0, ticks = 0, gridSeq = 0, end = 0, typed = "", scrolled = 0;
  const screen: Run[][] = Array.from({ length: 24 }, () => []);
  screen[0] = promptRow("");
  const responses: string[] = [];
  function push(line: HostLine) {
    const text = JSON.stringify(line);
    for (let i = 0; i < text.length; i += 1800) queue.push(JSON.stringify({ data: text.slice(i, i + 1800), more: i + 1800 < text.length }));
  }
  const grid = (changed: number[], full = false) => push({
    t: "grid", sid: 1, gen, seq: gridSeq++, ack, ...(full ? { full: 1 as const } : {}),
    rows: changed.map(y => [y, ...screen[y]] as RowUpdate), cur: [20 + typed.length, 23, 1],
    history: { epoch: "bench", first: 0, end, alternate: false },
  });
  (globalThis as any).offload = {
    session: () => 1,
    submit(record: string) {
      const request = JSON.parse(record), input = JSON.parse(request.payload);
      if (request.method === "term.input") {
        for (const item of input.commands ?? []) if (item.id > ack) {
          ack = item.id;
          // Touch typing echoes like a shell would.
          if (item.line.t === "ch") { typed = (typed + item.line.s).slice(-40); screen[23] = promptRow(typed); grid([23]); }
          if (item.line.t === "hello") {
            push({ t: "hello", proto: TERM_PROTO, name: "ap201" });
            push({ t: "sessions", list: [{ sid: 1, title: "bash #1" }], active: 1 });
            gen++; gridSeq = 0; grid(screen.map((_, y) => y), true);
          }
        }
        responses.push(JSON.stringify({ id: request.id, payload: JSON.stringify({ epoch: "bench", ack }) })); return true;
      }
      if (request.method === "term.exchange") {
        if (input.epoch) {
          if (held && input.received === sequence) held = undefined;
          if (!held && queue.length) { held = JSON.parse(queue.shift()!); sequence++; }
        }
        responses.push(JSON.stringify({ id: request.id, payload: JSON.stringify({ epoch: "bench", ack, sequence, ...held }) })); return true;
      }
      if (request.method === "term.history.batch") {
        // The live view prefetches the rows just scrolled off, as on device.
        const reply = historyBatchReply(input, row => JSON.stringify(lsRow(row)));
        responses.push(JSON.stringify({ id: request.id, payload: JSON.stringify(reply) })); return true;
      }
      responses.push(JSON.stringify({ id: request.id, error: "not in bench" })); return true;
    },
    take() { return responses.shift(); },
  };
  mount(() => {
    const store = createTermStore({ cols: 80, rows: 24, cell: [5, 10] }, connectTermOffload());
    onFrame(() => {
      ticks++;
      const now = scene(ticks);
      if (now === "typing" && ticks % 6 === 0) {
        typed = typed.length > 40 ? "" : typed + "l";
        screen[23] = promptRow(typed); grid([23]);
      }
      if (now === "ls" && ticks % 3 === 0) {
        // Four new lines push the screen up; every row changes, as it does
        // on the wire, and the scrolled-off rows join the history.
        for (let n = 0; n < 4; n++) { screen.shift(); screen.push(lsRow(scrolled++)); }
        end += 4; grid(screen.map((_, y) => y));
      }
    });
    return <TermApp store={store} />;
  });
}
