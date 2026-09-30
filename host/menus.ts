/** The ctrl and >_ menus: read from the user's config file, falling back to
 *  the repository's example, and re-read whenever the file changes. */
import { existsSync, readFileSync, unwatchFile, watchFile } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMenus, MENU_LIMITS, type Menus } from "../shared/menus.ts";
import { parseKeys, type KeyStep } from "../shared/keyseq.ts";

const EXAMPLE = fileURLToPath(new URL("../menus.example.json", import.meta.url));

export function defaultMenusPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "pocket-term", "menus.json");
}

function load(path: string): Menus {
  const file = existsSync(path) ? path : EXAMPLE;
  try {
    const text = readFileSync(file, "utf8");
    if (text.length > MENU_LIMITS.chars) return { ctrl: [], commands: [], errors: [`${file} is larger than ${MENU_LIMITS.chars} characters`] };
    return buildMenus(JSON.parse(text));
  } catch (error) {
    return { ctrl: [], commands: [], errors: [`${file}: ${(error as Error).message}`.slice(0, 200)] };
  }
}

/** Load once, then call `changed` with the new menus after each save. Polled
 *  rather than fs.watch'd: editors that save by renaming a temporary file
 *  over the original leave a directory watch pointing at nothing. */
export function watchMenus(path: string, changed: (menus: Menus) => void): { current(): Menus; close(): void } {
  const resolved = resolve(path);
  let menus = load(resolved);
  const report = () => {
    const source = existsSync(resolved) ? resolved : `${EXAMPLE} (no ${resolved})`;
    console.log(`[term] menus from ${source}: ${menus.ctrl.length} ctrl, ${menus.commands.length} command groups`);
    for (const error of menus.errors) console.log(`[term] menus: ${error}`);
  };
  report();
  const listener = () => { menus = load(resolved); report(); changed(menus); };
  watchFile(resolved, { interval: 1000 }, listener);
  return { current: () => menus, close: () => unwatchFile(resolved, listener) };
}

/** Plays key sequences into a session one at a time, so a second menu tap
 *  queues behind the first one's waits instead of interleaving with it. */
export class KeyPlayer {
  private queue: Promise<void> = Promise.resolve();

  play(source: string, write: (step: Exclude<KeyStep, { wait: number }>) => boolean): void {
    const steps = parseKeys(source);
    this.queue = this.queue.then(async () => {
      for (const step of steps) {
        if ("wait" in step) await new Promise(done => setTimeout(done, step.wait));
        // The session is gone: drop the rest of the sequence.
        else if (!write(step)) return;
      }
    });
  }
}
