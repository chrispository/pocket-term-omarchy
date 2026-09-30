// shared/files.ts — the file browser's one request: list a folder on the
// companion, a page at a time. The console asks for a folder when it opens
// it and keeps nothing else; the companion reads the folder on the spot, so
// what the browser shows is never older than the tap that opened it.

/** d folder · f file · x executable file · l link to a file · L link to a
 *  folder. */
export type FileKind = "d" | "f" | "x" | "l" | "L";

/** name, kind, then bytes for a file or the entry count for a folder (-1
 *  when it cannot be read). */
export type FileEntry = [name: string, kind: FileKind, size: number];

export interface FilesRequest {
  /** The session whose working directory to start in when `path` is
   *  absent. */
  sid: number;
  /** An absolute path; absent means the session's working directory. */
  path?: string;
  /** Index of the first entry wanted. */
  offset: number;
}

export interface FilesReply {
  /** The folder listed, absolute. */
  path: string;
  /** The companion's home folder, which the breadcrumbs show as ~. */
  home: string;
  total: number;
  offset: number;
  entries: FileEntry[];
  /** More entries follow at offset + entries.length. */
  more: boolean;
  /** The folder could not be read; `path` is still the folder asked for. */
  error?: string;
}

export const FILES_LIMITS = { path: 1024, entries: 5000 } as const;

export const isFolder = (kind: FileKind) => kind === "d" || kind === "L";
