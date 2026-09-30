/** The config file (menus and buttons): read from the user's config
 *  folder, falling back to the repository's example, and re-read whenever
 *  the file changes. */
import { existsSync, readFileSync, unwatchFile, watchFile } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig, CONFIG_LIMITS, EMPTY_CONFIG, type TermConfig } from "../shared/config.ts";
import { parseKeys, type KeyStep } from "../shared/keyseq.ts";

const EXAMPLE = fileURLToPath(new URL("../config.example.json", import.meta.url));

export function defaultConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "pocket-term", "config.json");
}

function load(path: string): TermConfig {
  const file = existsSync(path) ? path : EXAMPLE;
  try {
    const text = readFileSync(file, "utf8");
    if (text.length > CONFIG_LIMITS.chars) return { ...EMPTY_CONFIG, errors: [`${file} is larger than ${CONFIG_LIMITS.chars} characters`] };
    return buildConfig(JSON.parse(text));
  } catch (error) {
    return { ...EMPTY_CONFIG, errors: [`${file}: ${(error as Error).message}`.slice(0, 200)] };
  }
}

/** Load once, then call `changed` with the new config after each save.
 *  Polled rather than fs.watch'd: editors that save by renaming a temporary
 *  file over the original leave a directory watch pointing at nothing. */
export function watchConfig(path: string, changed: (config: TermConfig) => void): { current(): TermConfig; close(): void } {
  const resolved = resolve(path);
  let config = load(resolved);
  const report = () => {
    const source = existsSync(resolved) ? resolved : `${EXAMPLE} (no ${resolved})`;
    console.log(`[term] config from ${source}: ${config.ctrl.length} ctrl, ${config.commands.length} command groups`);
    for (const error of config.errors) console.log(`[term] config: ${error}`);
  };
  report();
  const listener = () => { config = load(resolved); report(); changed(config); };
  watchFile(resolved, { interval: 1000 }, listener);
  return { current: () => config, close: () => unwatchFile(resolved, listener) };
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
