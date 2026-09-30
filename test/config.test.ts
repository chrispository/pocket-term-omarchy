import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { describeKeys, literalKeys, parseKeys } from "../shared/keyseq.ts";
import { buildConfig, DEFAULT_BUTTONS } from "../shared/config.ts";
import { encodeKey } from "../host/keys.ts";
import { KeyPlayer } from "../host/config.ts";

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
  const menus = buildConfig({
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

test("the shipped config.json builds without errors", () => {
  const menus = buildConfig(JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8")));
  expect(menus.errors).toEqual([]);
  expect(menus.ctrl[0]).toMatchObject({ label: "interrupt twice", keys: "<C-c><C-c>" });
  expect(menus.commands.map(g => g.label)).toEqual(["nvim", "git", "shell", "claude"]);
  expect(menus.buttons.A).toEqual({ tap: "<CR>", hold: "alt" });
});

test("buttons fill in defaults, replace a named button outright and reject what they cannot do", () => {
  const config = buildConfig({ buttons: {
    A: { tap: "<CR>" },
    Y: { tap: "<Esc>", hold: "shift" },
    ZR: { hold: "alt" },
    B: { tap: "<Nope>" },
    L: { tap: "x" },
    X: { hold: "super" },
  } });
  expect(config.buttons.A).toEqual({ tap: "<CR>" });
  expect(config.buttons.Y).toEqual({ tap: "<Esc>", hold: "shift" });
  expect(config.buttons.ZR).toEqual({ hold: "alt" });
  expect(config.buttons.B).toEqual(DEFAULT_BUTTONS.B);
  expect(config.buttons.X).toEqual(DEFAULT_BUTTONS.X);
  expect(config.buttons.ZL).toEqual({ hold: "ctrl" });
  const errors = config.errors.join("\n");
  expect(errors).toContain("unknown key <Nope>");
  expect(errors).toContain("buttons > L: only A, B, X, Y, START, ZL, ZR can be set");
  expect(errors).toContain("hold must be ctrl, alt or shift");
  expect(buildConfig({}).buttons).toEqual(DEFAULT_BUTTONS);
});

test("a key player keeps sequences in order across waits", async () => {
  const player = new KeyPlayer(), out: string[] = [];
  const write = (step: { text: string } | { key: string }) => { out.push("text" in step ? step.text : step.key); return true; };
  player.play("a<wait:20>b", write);
  player.play("c", write);
  await new Promise(done => setTimeout(done, 60));
  expect(out).toEqual(["a", "b", "c"]);
});

test("a dual-role button taps on a clean release and is only a modifier when used", async () => {
  const { createButtons, tapAction } = await import("../app/buttons.ts");
  const masks = { A: 1, B: 2, X: 4, Y: 8, START: 16, ZL: 32, ZR: 64 };
  const buttons = createButtons(masks), bindings = DEFAULT_BUTTONS;
  // Tap A: nothing on press, Enter on release.
  expect(buttons.frame(1, 0, bindings)).toEqual([]);
  expect(buttons.held().alt).toBe(true);
  expect(buttons.frame(0, 1, bindings)).toEqual([{ tap: "<CR>", mods: { ctrl: false, alt: false, shift: false } }]);
  // Hold A, press B: B goes out with Alt on its press; A's release is silent.
  buttons.frame(1, 0, bindings);
  expect(buttons.frame(3, 1, bindings)).toEqual([{ tap: "<BS>", mods: { ctrl: false, alt: true, shift: false } }]);
  expect(buttons.frame(1, 3, bindings)).toEqual([]);
  expect(buttons.frame(0, 1, bindings)).toEqual([]);
  // A touch key under A spends it the same way.
  buttons.frame(1, 0, bindings); buttons.use();
  expect(buttons.frame(0, 1, bindings)).toEqual([]);
  // ZL has no tap; a reset (a menu opened) drops a held A's tap.
  buttons.frame(32, 0, bindings);
  expect(buttons.held().ctrl).toBe(true);
  expect(buttons.frame(0, 32, bindings)).toEqual([]);
  buttons.frame(1, 0, bindings); buttons.reset();
  expect(buttons.frame(0, 1, bindings)).toEqual([]);

  expect(tapAction("<BS>", { ctrl: false, alt: true, shift: false })).toEqual({ kind: "key", key: "Backspace", ctrl: false, alt: true, shift: false });
  expect(tapAction("<C-c>", { ctrl: false, alt: false, shift: false })).toEqual({ kind: "key", key: "c", ctrl: true, alt: false, shift: false });
  expect(tapAction("ls", { ctrl: false, alt: false, shift: false })).toEqual({ kind: "text", text: "ls" });
  expect(tapAction("x", { ctrl: true, alt: false, shift: false })).toEqual({ kind: "key", key: "x", ctrl: true, alt: false, shift: false });
  expect(tapAction("<Esc>:w<CR>", { ctrl: false, alt: false, shift: false })).toEqual({ kind: "keys", sequence: "<Esc>:w<CR>" });
});
