/** Folder listings for the console's file browser (shared/files.ts). */
import { readdirSync, readlinkSync, statSync, type Dirent } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fitsRecord } from "../shared/exchange.ts";
import { FILES_LIMITS, type FileEntry, type FileKind, type FilesReply, type FilesRequest } from "../shared/files.ts";

/** A shell's working directory. Linux publishes it under /proc; macOS has no
 *  /proc, and lsof is the portable way to ask. */
export function processCwd(pid: number): string | undefined {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { /* not Linux, or gone */ }
  const lsof = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 1000 });
  const line = lsof.stdout?.split("\n").find(l => l.startsWith("n/"));
  return line?.slice(1);
}

interface Listing { at: number; names: [string, boolean][] }
/** The sorted names of recently listed folders, so paging through one reads
 *  it once. A couple of seconds is long enough to page and short enough that
 *  reopening shows a change. */
const listings = new Map<string, Listing>();
const LISTING_MS = 2000;

function folderFlag(path: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try { return statSync(join(path, entry.name)).isDirectory(); } catch { return false; }
}

function sortedNames(path: string): [string, boolean][] {
  const cached = listings.get(path);
  if (cached && Date.now() - cached.at < LISTING_MS) return cached.names;
  const names = readdirSync(path, { withFileTypes: true })
    .slice(0, FILES_LIMITS.entries)
    .map(entry => [entry.name, folderFlag(path, entry)] as [string, boolean])
    // Folders first, then names without regard to case, as file managers do.
    .sort((a, b) => a[1] === b[1] ? a[0].localeCompare(b[0], undefined, { sensitivity: "base" }) : a[1] ? -1 : 1);
  listings.set(path, { at: Date.now(), names });
  for (const [key, value] of listings) if (Date.now() - value.at >= LISTING_MS) listings.delete(key);
  return names;
}

function describe(path: string, name: string, folder: boolean, link: boolean): FileEntry {
  const full = join(path, name);
  let kind: FileKind = folder ? (link ? "L" : "d") : link ? "l" : "f";
  let size = -1;
  try {
    if (folder) size = readdirSync(full).length;
    else {
      const stat = statSync(full);
      size = stat.size;
      if (!link && stat.mode & 0o111) kind = "x";
    }
  } catch { /* unreadable: no size */ }
  return [name, kind, size];
}

export function listFiles(request: FilesRequest, cwd: string | undefined): FilesReply {
  const home = homedir();
  const asked = request.path ?? cwd ?? home;
  if (typeof asked !== "string" || !isAbsolute(asked) || asked.length > FILES_LIMITS.path) throw new Error("Invalid path");
  if (!Number.isSafeInteger(request.offset) || request.offset < 0) throw new Error("Invalid offset");
  const path = resolve(asked);
  const reply: FilesReply = { path, home, total: 0, offset: request.offset, entries: [], more: false };
  let names: [string, boolean][];
  try { names = sortedNames(path); }
  catch (error) { return { ...reply, error: (error as NodeJS.ErrnoException).code ?? "unreadable" }; }
  reply.total = names.length;
  // As many entries as one offload reply holds.
  for (let at = request.offset; at < names.length; at++) {
    const [name, folder] = names[at];
    let link = false;
    try { link = readlinkSync(join(path, name)) !== ""; } catch { /* not a link */ }
    reply.entries.push(describe(path, name, folder, link));
    reply.more = at + 1 < names.length;
    if (!fitsRecord(JSON.stringify(reply), "term.files", true)) {
      reply.entries.pop();
      reply.more = true;
      break;
    }
  }
  if (reply.entries.length === 0 && request.offset < names.length) throw new Error("A file name exceeds the reply budget");
  return reply;
}
