// bun run keyboard [--port 5175] — a browser editor for the touch keyboard.
//
// Serves scripts/keyboard-editor.html on loopback. The page edits the layout
// in memory; saving sends it back here, where it is checked with the same
// rules as shared/keyboard.ts and written to app/keyboard-layout.ts as source.
// The build then bakes the labels like any other literal. Build and deploy
// run the repository's own `bun run 3ds` and `bun run deploy`, streaming their
// output to the page.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import opentype from "opentype.js";
import { DEFAULT_REGULAR } from "../vendor/pocketjs/framework/compiler/bake-font.ts";
import { KEY_NAMES, checkLayout, layoutSource, type KeyboardLayout } from "../shared/keyboard.ts";
import { ROOT } from "./paths.ts";

const LAYOUT_FILE = resolve(ROOT, "app/keyboard-layout.ts");
const PAGE = resolve(import.meta.dir, "keyboard-editor.html");
const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 5175);

// Key labels are drawn in the UI font's text-xs slot (Inter Regular). A label
// character Inter does not map bakes as tofu, so the editor flags it.
const fontBytes = readFileSync(DEFAULT_REGULAR);
const font = opentype.parse(fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength));

async function loadLayout(): Promise<KeyboardLayout> {
  // A query string gives each read its own module instance, so edits made to
  // the file by hand since the last read are picked up.
  return (await import(`${LAYOUT_FILE}?v=${Date.now()}`)).KEYBOARD_LAYOUT;
}

function check(layout: KeyboardLayout) {
  const result = checkLayout(layout);
  const missing = new Set<string>();
  for (const row of [layout.actionRow, ...Object.values(layout.layers).flat()]) {
    for (const def of row) for (const ch of def.label) if (font.charToGlyphIndex(ch) <= 0) missing.add(ch);
  }
  if (missing.size) {
    result.warnings.push(`the key font has no glyph for ${[...missing].map((ch) => `"${ch}" (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`).join(", ")}; it will draw as a box`);
  }
  return result;
}

/** One build or deploy at a time; its output is streamed to whoever asked. */
let running: Bun.Subprocess | null = null;

function stream(cmd: string[]): Response {
  if (running) return new Response("another build or deploy is still running\n", { status: 409 });
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, FORCE_COLOR: "0" } });
  running = proc;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`$ ${cmd.join(" ")}\n`));
      const pump = async (source: ReadableStream<Uint8Array>) => {
        for await (const chunk of source) controller.enqueue(chunk);
      };
      await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
      const code = await proc.exited;
      running = null;
      controller.enqueue(encoder.encode(`\n[exit ${code}]\n`));
      controller.close();
    },
    cancel() { proc.kill(); running = null; },
  });
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        return new Response(Bun.file(PAGE), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (req.method === "GET" && url.pathname === "/font.ttf") {
        return new Response(fontBytes, { headers: { "content-type": "font/ttf" } });
      }
      if (req.method === "GET" && url.pathname === "/api/layout") {
        const layout = await loadLayout();
        return json({ layout, keyNames: KEY_NAMES, check: check(layout) });
      }
      if (req.method === "POST" && url.pathname === "/api/check") {
        return json(check(await req.json() as KeyboardLayout));
      }
      if (req.method === "POST" && url.pathname === "/api/layout") {
        const layout = await req.json() as KeyboardLayout;
        const result = check(layout);
        if (result.errors.length) return json({ saved: false, ...result }, 422);
        writeFileSync(LAYOUT_FILE, layoutSource(layout));
        return json({ saved: true, file: "app/keyboard-layout.ts", ...result });
      }
      if (req.method === "POST" && url.pathname === "/api/build") {
        return stream(["bun", "run", "3ds"]);
      }
      if (req.method === "POST" && url.pathname === "/api/deploy") {
        const { host, ftpPort } = await req.json() as { host?: string; ftpPort?: number };
        if (!host || !/^[\w.:-]+$/.test(host)) return new Response("enter the console's IP address\n", { status: 400 });
        return stream(["bun", "run", "deploy", "--host", host, "--ftp-port", String(ftpPort || 5000)]);
      }
      return new Response("not found", { status: 404 });
    } catch (error) {
      return json({ error: String(error instanceof Error ? error.message : error) }, 500);
    }
  },
});

console.log(`keyboard editor: http://${server.hostname}:${server.port}/`);
console.log(`editing ${LAYOUT_FILE}`);
