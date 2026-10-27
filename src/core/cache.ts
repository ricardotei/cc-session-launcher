import * as fs from "fs";
import * as path from "path";
import type { SessionInfo } from "./types";

/**
 * One cached file. `info` is null for transcripts that were inspected and found to be desktop-owned
 * (nothing to show, but no need to re-read them next time).
 * Metadata only: titles are at most 120 chars, statusDetail/needsAction at most 200 chars.
 */
export interface CacheEntry {
  mtimeMs: number;
  size: number;
  info: SessionInfo | null;
  /** Desktop entries: priorCliSessionIds, used to recognise their old transcripts. */
  prior?: string[];
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

const VERSION = 1;

function looksLikeInfo(v: unknown): v is SessionInfo {
  if (typeof v !== "object" || v === null) return false;
  const i = v as Record<string, unknown>;
  return (
    typeof i.id === "string" &&
    (i.source === "desktop" || i.source === "cli") &&
    typeof i.title === "string" &&
    typeof i.cwd === "string" &&
    typeof i.repoRoot === "string" &&
    typeof i.repoName === "string" &&
    typeof i.lastActivity === "number" &&
    typeof i.status === "string" &&
    Array.isArray(i.prs) &&
    typeof i.isArchived === "boolean"
  );
}

function looksLikeEntry(v: unknown): v is CacheEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  if (typeof e.mtimeMs !== "number" || typeof e.size !== "number") return false;
  if (e.info !== null && !looksLikeInfo(e.info)) return false;
  if (e.prior !== undefined && !(Array.isArray(e.prior) && e.prior.every((x) => typeof x === "string"))) return false;
  return true;
}

/**
 * Metadata cache keyed by absolute path, validated by mtimeMs + size.
 * Loaded once, mutated in memory, written back once (atomically) only when something changed.
 * A missing, corrupt or wrong-version file is treated as empty; I/O errors never propagate.
 */
export class IndexCache {
  private entries = new Map<string, CacheEntry>();
  private dirty = false;

  private constructor(private readonly file: string | null) {}

  static load(file: string | null): IndexCache {
    const cache = new IndexCache(file);
    if (!file) return cache;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return cache;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CacheFile> | null;
      if (!parsed || parsed.version !== VERSION || typeof parsed.entries !== "object" || parsed.entries === null) {
        return cache;
      }
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (looksLikeEntry(entry)) cache.entries.set(key, entry);
      }
    } catch {
      // Corrupt cache: start over.
    }
    return cache;
  }

  /** The entry for `file` if it was cached for exactly this mtime and size. */
  get(file: string, mtimeMs: number, size: number): CacheEntry | undefined {
    const e = this.entries.get(file);
    if (e && e.mtimeMs === mtimeMs && e.size === size) return e;
    return undefined;
  }

  /** Whatever is cached for `file`, even if stale: a fallback for files that are momentarily unreadable. */
  getAny(file: string): CacheEntry | undefined {
    return this.entries.get(file);
  }

  set(file: string, entry: CacheEntry): void {
    this.entries.set(file, entry);
    this.dirty = true;
  }

  /** CLI session ids (current and prior) of every cached desktop session, whatever the window it was cached in. */
  desktopCliIds(): Set<string> {
    const ids = new Set<string>();
    for (const e of this.entries.values()) {
      if (e.info?.source !== "desktop") continue;
      if (e.info.cliSessionId) ids.add(e.info.cliSessionId);
      for (const id of e.prior ?? []) ids.add(id);
    }
    return ids;
  }

  /** Removes entries for files that are no longer present. */
  prune(exists: (file: string) => boolean): void {
    for (const key of [...this.entries.keys()]) {
      if (!exists(key)) {
        this.entries.delete(key);
        this.dirty = true;
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Writes the cache atomically (tmp + rename) if it changed. Failures are swallowed. */
  save(): void {
    if (!this.file || !this.dirty) return;
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const body: CacheFile = { version: VERSION, entries: Object.fromEntries(this.entries) };
      fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // ignore
      }
    }
  }
}
