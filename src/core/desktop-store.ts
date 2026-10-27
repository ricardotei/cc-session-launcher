import * as fs from "fs";
import * as path from "path";
import { truncate } from "./format";
import { repoNameOf, repoRootFromCwd, stripTrailingSlashes } from "./paths";
import type { SessionInfo, SessionPR, SessionStatus } from "./types";

export const TITLE_MAX = 120;
export const DETAIL_MAX = 200;
export const UNTITLED = "Untitled session";

type Rec = Record<string, unknown>;

function isObj(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export interface DesktopFile {
  path: string;
  mtimeMs: number;
  size: number;
}

function isDir(parent: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (entry.isSymbolicLink()) {
    try {
      return fs.statSync(path.join(parent, entry.name)).isDirectory();
    } catch {
      return false;
    }
  }
  return false;
}

function readDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => isDir(dir, e))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Lists `<desktopDir>/claude-code-sessions/<account>/<org>/local_*.json` with their stat info.
 * Only `local_*.json` files are returned (deleted_*, indexes and subfolders are ignored).
 * `minMtimeMs` is the cheap pre-filter: files modified before it are left out.
 * `allPaths` receives every matching path, including the filtered-out ones (for cache pruning).
 */
export function listDesktopFiles(desktopDir: string, minMtimeMs: number, allPaths?: Set<string>): DesktopFile[] {
  const out: DesktopFile[] = [];
  const root = path.join(desktopDir, "claude-code-sessions");
  for (const account of readDirs(root)) {
    for (const org of readDirs(account)) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(org, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.name.startsWith("local_") || !e.name.endsWith(".json")) continue;
        if (e.isDirectory()) continue;
        const full = path.join(org, e.name);
        allPaths?.add(full);
        let st: fs.Stats;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        if (st.mtimeMs < minMtimeMs) continue;
        out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  }
  return out;
}

/** postTurnSummary.status_category (+ needs_action) -> SessionStatus. */
export function mapStatus(category: unknown, needsAction: unknown): SessionStatus {
  const cat = typeof category === "string" ? category : "";
  if (cat === "blocked" || cat === "need_input" || cat === "failed") return "needs_input";
  if (cat === "review_ready") return "review_ready";
  if (cat === "completed") return "completed";
  if (cat === "" && nonEmptyString(needsAction)) return "needs_input";
  return "unknown";
}

function collectPrs(meta: Rec): SessionPR[] {
  const prs: SessionPR[] = [];
  const seen = new Set<string>();
  const add = (url: unknown, number: unknown, state: unknown, repo: unknown) => {
    const u = nonEmptyString(url);
    if (!u || seen.has(u)) return;
    seen.add(u);
    const pr: SessionPR = { url: u };
    const n = finiteNumber(number);
    if (n !== undefined) pr.number = n;
    const s = nonEmptyString(state);
    if (s) pr.state = s;
    const r = nonEmptyString(repo);
    if (r) pr.repo = r;
    prs.push(pr);
  };
  if (Array.isArray(meta.prs)) {
    for (const p of meta.prs) {
      if (isObj(p)) add(p.url, p.prNumber, p.state, p.repo);
    }
  }
  add(meta.prUrl, meta.prNumber, meta.prState, meta.prRepository);
  return prs;
}

export interface ParsedDesktopSession {
  info: SessionInfo;
  /** priorCliSessionIds, kept so transcripts of older CLI ids are recognised as desktop-owned. */
  prior: string[];
  /** True when the desktop file has no usable title; the caller may fall back to the transcript. */
  needsTitle: boolean;
}

/**
 * Parses one desktop session JSON string into a SessionInfo (without transcriptPath, which depends on the
 * ~/.claude layout and is resolved by the indexer). Returns null when the file is not a usable session.
 */
export function parseDesktopSession(text: string, file: DesktopFile): ParsedDesktopSession | null {
  let meta: unknown;
  try {
    meta = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(meta)) return null;

  const sessionId = nonEmptyString(meta.sessionId);
  if (!sessionId) return null;

  const rawCwd = nonEmptyString(meta.cwd) ?? nonEmptyString(meta.originCwd);
  if (!rawCwd) return null; // nowhere to resume it from; cannot be grouped
  const cwd = stripTrailingSlashes(rawCwd);
  const origin = nonEmptyString(meta.originCwd);
  const repoRoot = origin ? stripTrailingSlashes(origin) : repoRootFromCwd(cwd);

  const cliSessionId = nonEmptyString(meta.cliSessionId);
  const prior = Array.isArray(meta.priorCliSessionIds)
    ? meta.priorCliSessionIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];

  const rawTitle = nonEmptyString(meta.title);
  const title = rawTitle ? truncate(rawTitle, TITLE_MAX) : "";

  const createdAt = finiteNumber(meta.createdAt);
  const lastActivity = finiteNumber(meta.lastActivityAt) ?? createdAt ?? file.mtimeMs;

  const summary = isObj(meta.postTurnSummary) ? meta.postTurnSummary : undefined;
  const detail = summary ? nonEmptyString(summary.status_detail) : undefined;
  const needs = summary ? nonEmptyString(summary.needs_action) : undefined;

  const info: SessionInfo = {
    id: sessionId,
    source: "desktop",
    desktopId: sessionId,
    title: title || UNTITLED,
    cwd,
    repoRoot,
    repoName: repoNameOf(repoRoot),
    isWorktree: cwd !== repoRoot,
    lastActivity,
    status: mapStatus(summary?.status_category, summary?.needs_action),
    prs: collectPrs(meta),
    isArchived: meta.isArchived === true,
    desktopMetaPath: file.path,
  };
  if (cliSessionId) info.cliSessionId = cliSessionId;
  const branch = nonEmptyString(meta.branch);
  if (branch) info.branch = branch;
  if (createdAt !== undefined) info.createdAt = createdAt;
  const turns = finiteNumber(meta.completedTurns);
  if (turns !== undefined) info.turns = turns;
  const model = nonEmptyString(meta.model);
  if (model) info.model = model;
  if (detail) info.statusDetail = truncate(detail, DETAIL_MAX);
  if (needs) info.needsAction = truncate(needs, DETAIL_MAX);

  return { info, prior, needsTitle: !title };
}

/** Reads and parses a desktop session file; null when unreadable or not a session. */
export function readDesktopSession(file: DesktopFile): ParsedDesktopSession | null {
  let text: string;
  try {
    text = fs.readFileSync(file.path, "utf8");
  } catch {
    return null;
  }
  return parseDesktopSession(text, file);
}
