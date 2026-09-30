import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { describeKeys, literalKeys, parseKeys } from "../shared/keyseq.ts";
import { buildConfig, DEFAULT_BUTTONS, DEFAULT_TIMING, parseJsonc, type ButtonName } from "../shared/config.ts";
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

test("the shipped config.jsonc builds without errors, and so do its commented-out combos", () => {
  const text = readFileSync(new URL("../config.jsonc", import.meta.url), "utf8");
  const menus = buildConfig(parseJsonc(text));
  expect(menus.errors).toEqual([]);
  expect(menus.ctrl[0]).toMatchObject({ label: "interrupt twice", keys: "<C-c><C-c>" });
  expect(menus.commands.map(g => g.label)).toEqual(["nvim", "git", "shell", "claude"]);
  expect(menus.buttons.A).toEqual({ tap: "<CR>", hold: "alt" });
  expect(menus.buttons).toEqual(DEFAULT_BUTTONS);
  const examples = [...text.matchAll(/^\s*\/\/ (\{ "buttons".*\}),?$/gm)].map(m => m[1]);
  expect(examples.length).toBeGreaterThan(2);
  const combos = buildConfig({ combos: examples.map(e => JSON.parse(e)) });
  expect(combos.errors).toEqual([]);
  expect(combos.combos.length).toBe(examples.length);
});

test("buttons fill in defaults, replace a named button outright and reject what they cannot do", () => {
  const config = buildConfig({ buttons: {
    A: { tap: "<CR>" },
    Y: { tap: "<Esc>", hold: "shift" },
    ZR: { hold: "alt" },
    B: { tap: "<Nope>" },
    DPAD: { tap: "x" },
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
  expect(errors).toContain("buttons > DPAD: only A, B, X, Y, L, R, ZL, ZR, START, SELECT can be set");
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

test("a tap-and-hold button is the tap inside holdMs and the modifier after it", async () => {
  const { createButtons, tapAction } = await import("../app/buttons.ts");
  const masks = { A: 1, B: 2, X: 4, Y: 8, L: 16, R: 32, ZL: 64, ZR: 128, START: 256, SELECT: 512 };
  const settings = { buttons: DEFAULT_BUTTONS, combos: [], timing: DEFAULT_TIMING };
  const none = { ctrl: false, alt: false, shift: false }, alt = { ...none, alt: true };
  const buttons = createButtons(masks);
  // A tapped alone: nothing on press, Enter on release, whatever the length.
  expect(buttons.frame(1, 0, settings, 0)).toEqual([]);
  expect(buttons.held(100).alt).toBe(false);
  expect(buttons.held(250).alt).toBe(true);
  expect(buttons.frame(0, 1, settings, 400)).toEqual([{ kind: "tap", tap: "<CR>", mods: none }]);
  // B inside A's 200 ms: Enter first, then B unmodified; A's release is silent.
  buttons.frame(1, 0, settings, 1000);
  expect(buttons.frame(3, 1, settings, 1100)).toEqual([{ kind: "tap", tap: "<CR>", mods: none }, { kind: "tap", tap: "<BS>", mods: none }]);
  expect(buttons.frame(0, 3, settings, 1200)).toEqual([]);
  // B after A's 200 ms: Alt+Backspace, and no Enter.
  buttons.frame(1, 0, settings, 2000);
  expect(buttons.frame(3, 1, settings, 2300)).toEqual([{ kind: "tap", tap: "<BS>", mods: alt }]);
  expect(buttons.frame(0, 3, settings, 2400)).toEqual([]);
  // A touch key goes through beforeSend the same way.
  buttons.frame(1, 0, settings, 3000);
  expect(buttons.beforeSend(3050)).toEqual([{ kind: "tap", tap: "<CR>", mods: none }]);
  expect(buttons.held(3060).alt).toBe(false);
  expect(buttons.frame(0, 1, settings, 3100)).toEqual([]);
  buttons.frame(1, 0, settings, 4000);
  expect(buttons.beforeSend(4300)).toEqual([]);
  expect(buttons.held(4300).alt).toBe(true);
  expect(buttons.frame(0, 1, settings, 4400)).toEqual([]);
  // ZL is only a modifier; L is an action on press; reset drops a held A.
  buttons.frame(64, 0, settings, 5000);
  expect(buttons.held(5000).ctrl).toBe(true);
  expect(buttons.frame(0, 64, settings, 5100)).toEqual([]);
  expect(buttons.frame(16, 0, settings, 5200)).toEqual([{ kind: "action", action: "prev-session" }]);
  buttons.frame(0, 16, settings, 5300);
  buttons.frame(1, 0, settings, 6000); buttons.reset();
  expect(buttons.frame(0, 1, settings, 6100)).toEqual([]);
  // A holdMs of its own.
  const slow = { ...settings, buttons: { ...DEFAULT_BUTTONS, A: { tap: "<CR>", hold: "alt" as const, holdMs: 500 } } };
  buttons.frame(1, 0, slow, 7000);
  expect(buttons.held(7300).alt).toBe(false);
  expect(buttons.held(7500).alt).toBe(true);
  buttons.reset();

  expect(tapAction("<BS>", alt)).toEqual({ kind: "key", key: "Backspace", ctrl: false, alt: true, shift: false });
  expect(tapAction("<C-c>", none)).toEqual({ kind: "key", key: "c", ctrl: true, alt: false, shift: false });
  expect(tapAction("ls", none)).toEqual({ kind: "text", text: "ls" });
  expect(tapAction("x", { ...none, ctrl: true })).toEqual({ kind: "key", key: "x", ctrl: true, alt: false, shift: false });
  expect(tapAction("<Esc>:w<CR>", none)).toEqual({ kind: "keys", sequence: "<Esc>:w<CR>" });
});

test("a combo fires when its buttons land within comboMs, and suppresses their own jobs", async () => {
  const { createButtons } = await import("../app/buttons.ts");
  const masks = { A: 1, B: 2, X: 4, Y: 8, L: 16, R: 32, ZL: 64, ZR: 128, START: 256, SELECT: 512 };
  const settings = { buttons: DEFAULT_BUTTONS, combos: [{ buttons: ["L", "R"] as ButtonName[], tap: "<C-c><C-c>" }], timing: DEFAULT_TIMING };
  const buttons = createButtons(masks);
  // L then R 30 ms later: the combo, and no session switching.
  expect(buttons.frame(16, 0, settings, 0)).toEqual([]);
  expect(buttons.frame(48, 16, settings, 30)).toEqual([{ kind: "tap", tap: "<C-c><C-c>", mods: { ctrl: false, alt: false, shift: false } }]);
  expect(buttons.frame(0, 48, settings, 200)).toEqual([]);
  // L alone: its own job once comboMs has passed.
  expect(buttons.frame(16, 0, settings, 1000)).toEqual([]);
  expect(buttons.frame(16, 16, settings, 1060)).toEqual([{ kind: "action", action: "prev-session" }]);
  // R well after L: each does its own job.
  expect(buttons.frame(48, 16, settings, 1200)).toEqual([]);
  expect(buttons.frame(48, 48, settings, 1260)).toEqual([{ kind: "action", action: "next-session" }]);
  buttons.frame(0, 48, settings, 1300);
  // A quick L tap shorter than comboMs still switches.
  buttons.frame(16, 0, settings, 2000);
  expect(buttons.frame(0, 16, settings, 2030)).toEqual([{ kind: "action", action: "prev-session" }]);
});

test("config parses with comments and checks buttons, combos and timing", () => {
  const config = buildConfig(parseJsonc(`{
    // A comment, and a trailing comma.
    "timing": { "holdMs": 300, "comboMs": 80 },
    "buttons": { "L": { "action": "files" }, "R": { "action": "nope" } },
    "combos": [
      { "buttons": ["L", "R"], "action": "commands" },
      { "buttons": ["L"], "tap": "x" },
      { "buttons": ["L", "START"] },
    ],
  }`));
  expect(config.timing).toEqual({ holdMs: 300, comboMs: 80, ctrlMenuMs: DEFAULT_TIMING.ctrlMenuMs });
  expect(config.buttons.L).toEqual({ action: "files" });
  expect(config.buttons.R).toEqual(DEFAULT_BUTTONS.R);
  expect(config.combos).toEqual([{ buttons: ["L", "R"], action: "commands" }]);
  const errors = config.errors.join("\n");
  expect(errors).toContain("action must be one of");
  expect(errors).toContain("two or more different buttons");
  expect(errors).toContain("needs a tap or an action");
});
