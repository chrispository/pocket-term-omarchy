import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { describeKeys, literalKeys, parseKeys } from "../shared/keyseq.ts";
import { buildMenus } from "../shared/menus.ts";
import { encodeKey } from "../host/keys.ts";
import { KeyPlayer } from "../host/menus.ts";

test("key notation: text, modifiers, named keys, waits and a literal <", () => {
  expect(parseKeys("<C-c><C-c>")).toEqual([
    { key: "c", ctrl: true, alt: false, shift: false },
    { key: "c", ctrl: true, alt: false, shift: false },
  ]);
  expect(parseKeys("<Esc><wait:75>:wq<CR>")).toEqual([
    { key: "Escape", ctrl: false, alt: false, shift: false },
    { wait: 75 },
    { text: ":wq" },
    { key: "Enter", ctrl: false, alt: false, shift: false },
  ]);
  expect(parseKeys("<C-M-a><S-Tab>")).toEqual([
    { key: "a", ctrl: true, alt: true, shift: false },
    { key: "Tab", ctrl: false, alt: false, shift: true },
  ]);
  expect(parseKeys("a <lt>b> c")).toEqual([{ text: "a <b> c" }]);
  expect(parseKeys("x < y")).toEqual([{ text: "x < y" }]);
  expect(parseKeys(literalKeys("echo <x>"))).toEqual([{ text: "echo <x>" }]);
  expect(() => parseKeys("<Nope>")).toThrow("unknown key <Nope>");
  expect(() => parseKeys("<wait:6000>")).toThrow();
  expect(() => parseKeys("<wait:5000><wait:5000><wait:5000>")).toThrow();
});

test("a ctrl step encodes to the control byte the PTY expects", () => {
  const [step] = parseKeys("<C-c>");
  if (!("key" in step)) throw new Error("expected a key");
  expect(encodeKey(step.key, step.ctrl, step.alt, false, step.shift)).toBe("\x03");
  const [tab] = parseKeys("<S-Tab>");
  if (!("key" in tab)) throw new Error("expected a key");
  expect(encodeKey(tab.key, tab.ctrl, tab.alt, false, tab.shift)).toBe("\x1b[Z");
});

test("the menu's right-hand column reads in caret form", () => {
  expect(describeKeys("<C-c><C-c>")).toBe("^C ^C");
  expect(describeKeys("<Esc><wait:75>:wq<CR>")).toBe("Esc :wq Enter");
});

test("menus reduce every entry to one key sequence and report mistakes", () => {
  const menus = buildMenus({
    ctrl: [{ label: "twice", keys: "<C-c><C-c>" }],
    commands: [
      { label: "git", items: [
        { label: "status", run: "git status" },
        { label: "commit", type: "git commit -m " },
        { label: "bad", keys: "<Bogus>" },
        { label: "both", run: "a", keys: "b" },
        { label: "café", run: "true" },
      ] },
    ],
    extra: [],
  });
  expect(menus.ctrl).toEqual([{ label: "twice", detail: "^C ^C", keys: "<C-c><C-c>" }]);
  const git = menus.commands[0];
  expect(git.items?.map(i => [i.label, i.keys])).toEqual([
    ["status", "git status<CR>"], ["commit", "git commit -m "], ["caf?", "true<CR>"],
  ]);
  expect(menus.errors.join("\n")).toContain("unknown key <Bogus>");
  expect(menus.errors.join("\n")).toContain("exactly one of");
  expect(menus.errors.join("\n")).toContain("ASCII");
  expect(menus.errors.join("\n")).toContain('unknown section "extra"');
});

test("the example config builds without errors", () => {
  const menus = buildMenus(JSON.parse(readFileSync(new URL("../menus.example.json", import.meta.url), "utf8")));
  expect(menus.errors).toEqual([]);
  expect(menus.ctrl[0]).toMatchObject({ label: "interrupt twice", keys: "<C-c><C-c>" });
  expect(menus.commands.map(g => g.label)).toEqual(["nvim", "git", "shell", "claude"]);
});

test("a key player keeps sequences in order across waits", async () => {
  const player = new KeyPlayer(), out: string[] = [];
  const write = (step: { text: string } | { key: string }) => { out.push("text" in step ? step.text : step.key); return true; };
  player.play("a<wait:20>b", write);
  player.play("c", write);
  await new Promise(done => setTimeout(done, 60));
  expect(out).toEqual(["a", "b", "c"]);
});
