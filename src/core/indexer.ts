import * as fs from "fs";
import * as path from "path";
import { IndexCache } from "./cache";
import { TITLE_MAX, UNTITLED, listDesktopFiles, readDesktopSession } from "./desktop-store";
import { truncate } from "./format";
import { listLiveSessionIds, readSubagentState, readTailState } from "./live";
import { defaultStateFile, loadMarks } from "./marks";
import {
  defaultCacheFile,
  defaultClaudeDir,
  defaultDesktopDir,
  encodeCwd,
  expandHome,
  repoNameOf,
  repoRootFromCwd,
  stripTrailingSlashes,
} from "./paths";
import { scanTranscript } from "./transcripts";
import type { LoadOptions, RepoGroup, SessionInfo } from "./types";

const DAY_MS = 86_400_000;
const SCAN_CONCURRENCY = 8;
/** A live claude process counts as "maybe mid-turn" when its transcript was written within this long... */
const LIVE_WINDOW_MS = 60 * 60_000;
/** ...and any transcript written this recently counts even without a process we could match (e.g. no id in argv). */
const FRESH_WINDOW_MS = 2 * 60_000;
/** A subagent transcript counts as "maybe working" within this long if its session's process is alive (else FRESH). */
const AGENT_LIVE_WINDOW_MS = 10 * 60_000;

// -------------------------------------------------------------------------------------------------
// ~/.claude/projects listing
// -------------------------------------------------------------------------------------------------

interface ProjectTranscript {
  path: string;
  /** Project directory name (the encoded cwd). */
  dirName: string;
  /** File name without .jsonl: the CLI session id. */
  uuid: string;
}

interface ProjectsIndex {
  all: ProjectTranscript[];
  byUuid: Map<string, ProjectTranscript[]>;
  paths: Set<string>;
}

/** One readdir of projects/ plus one per project dir. Only top-level *.jsonl (subfolders hold subagent logs). */
function listProjectTranscripts(claudeDir: string): ProjectsIndex {
  const index: ProjectsIndex = { all: [], byUuid: new Map(), paths: new Set() };
  const root = path.join(claudeDir, "projects");
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return index;
  }
  for (const d of dirs) {
    const dirPath = path.join(root, d.name);
    if (!d.isDirectory()) {
      if (!d.isSymbolicLink()) continue;
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.name.endsWith(".jsonl") || f.isDirectory()) continue;
      const full = path.join(dirPath, f.name);
      const t: ProjectTranscript = { path: full, dirName: d.name, uuid: f.name.slice(0, -".jsonl".length) };
      index.all.push(t);
      index.paths.add(full);
      const list = index.byUuid.get(t.uuid);
      if (list) list.push(t);
      else index.byUuid.set(t.uuid, [t]);
    }
  }
  return index;
}

/** `<projects>/<encoded cwd>/<id>.jsonl` if present, else any `<projects>/*\/<id>.jsonl`. */
function resolveTranscriptPath(
  index: ProjectsIndex,
  claudeDir: string,
  cliSessionId: string,
  cwd: string,
  repoRoot: string,
): string | undefined {
  const candidates = index.byUuid.get(cliSessionId);
  if (!candidates || candidates.length === 0) return undefined;
  const root = path.join(claudeDir, "projects");
  for (const dir of [cwd, repoRoot]) {
    const direct = path.join(root, encodeCwd(dir), `${cliSessionId}.jsonl`);
    if (index.paths.has(direct)) return direct;
  }
  return candidates[0].path;
}

// -------------------------------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------------------------------

/** Runs `fn` over `items` with at most `limit` in flight. */
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

function titleFromScan(scan: { customTitle?: string; summary?: string; firstPrompt?: string }): string {
  const raw = scan.customTitle ?? scan.summary ?? scan.firstPrompt;
  const t = raw ? truncate(raw, TITLE_MAX) : "";
  return t || UNTITLED;
}

interface SubagentFile {
  path: string;
  /** Time since the file was last written. */
  age: number;
}

/**
 * The `agent-*.jsonl` transcripts of a session's subagents, in `<cliSessionId>/subagents/` next to the main transcript.
 * Their `.meta.json` / `.prefix.json` siblings are skipped. Empty when the folder does not exist.
 */
function listSubagentFiles(transcriptPath: string, cliSessionId: string, now: number): SubagentFile[] {
  const dir = path.join(path.dirname(transcriptPath), cliSessionId, "subagents");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const found: SubagentFile[] = [];
  for (const name of names) {
    if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile()) found.push({ path: file, age: now - st.mtimeMs });
    } catch {
      // vanished since the listing
    }
  }
  return found;
}

/**
 * Returns copies of `sessions` with `isRunning` set: a turn is in progress when the transcript was written
 * recently (live process: within an hour, otherwise: within two minutes) and its tail ends mid-turn, or when
 * background subagents of the session are still working (`activeSubagents` counts them, and stays unset at zero).
 * A subagent is a candidate when its transcript was written within ten minutes (live process) or two (otherwise)
 * and its tail does not end in a report-back or a final reply: a killed one looks the same, but stops being written.
 * Only candidates have their tail read. Never stored in the cache.
 */
async function withRunning(sessions: SessionInfo[], now: number): Promise<SessionInfo[]> {
  const probes: { session: SessionInfo; id: string; file: string; age: number; agents: SubagentFile[] }[] = [];
  for (const session of sessions) {
    if (!session.cliSessionId || !session.transcriptPath) continue;
    try {
      const age = now - fs.statSync(session.transcriptPath).mtimeMs;
      const agents = listSubagentFiles(session.transcriptPath, session.cliSessionId, now);
      probes.push({ session, id: session.cliSessionId.toLowerCase(), file: session.transcriptPath, age, agents });
    } catch {
      // transcript vanished: not running
    }
  }
  // A process only matters for transcripts written within the live windows: skip `ps` when there are none. A subagent
  // can keep writing long after its parent's last write, so a fresh subagent file counts too.
  const needsPs = probes.some((p) => p.age <= LIVE_WINDOW_MS || p.agents.some((a) => a.age <= AGENT_LIVE_WINDOW_MS));
  const live = needsPs ? await listLiveSessionIds() : new Set<string>();
  const candidates = probes.filter((p) => p.age <= FRESH_WINDOW_MS || (p.age <= LIVE_WINDOW_MS && live.has(p.id)));

  const running = new Set<SessionInfo>();
  const working = new Map<SessionInfo, number>();
  const tasks: (() => Promise<void>)[] = candidates.map((p) => async () => {
    if ((await readTailState(p.file)) === "running") running.add(p.session);
  });
  for (const p of probes) {
    const window = live.has(p.id) ? AGENT_LIVE_WINDOW_MS : FRESH_WINDOW_MS;
    for (const agent of p.agents) {
      if (agent.age > window) continue;
      tasks.push(async () => {
        if ((await readSubagentState(agent.path)) !== "working") return;
        working.set(p.session, (working.get(p.session) ?? 0) + 1);
      });
    }
  }
  await mapPool(tasks, SCAN_CONCURRENCY, (task) => task());

  return sessions.map((s) => {
    const activeSubagents = working.get(s) ?? 0;
    const copy: SessionInfo = { ...s, isRunning: running.has(s) || activeSubagents > 0 };
    if (activeSubagents > 0) copy.activeSubagents = activeSubagents;
    return copy;
  });
}

/**
 * Returns copies of `sessions` with the user's done-marks applied: a session with a mark made at (or after) its current
 * lastActivity, and no turn in progress, gets `markedDone: true` and status "completed" (statusDetail and needsAction
 * stay). Anything else is returned as is. Never stored in the cache.
 */
function withMarks(sessions: SessionInfo[], stateFile: string): SessionInfo[] {
  const marks = loadMarks(stateFile);
  if (marks.size === 0) return sessions;
  return sessions.map((s) => {
    const mark = marks.get(s.id);
    if (!mark || mark.lastActivity < s.lastActivity || s.isRunning) return s;
    return { ...s, markedDone: true, status: "completed" };
  });
}

// -------------------------------------------------------------------------------------------------
// loadSessions
// -------------------------------------------------------------------------------------------------

/**
 * Read-only scan of the desktop app's session store and ~/.claude/projects transcripts.
 * Returns sessions active within `opts.days`, newest first. Never writes outside opts.cacheFile.
 * Done-marks come from opts.stateFile (read only here; see marks.ts for writing them).
 */
export async function loadSessions(opts: LoadOptions): Promise<SessionInfo[]> {
  const now = opts.now ?? Date.now();
  const days = Number.isFinite(opts.days) && opts.days > 0 ? opts.days : 0;
  const cutoff = days > 0 ? now - days * DAY_MS : Number.NEGATIVE_INFINITY;
  const claudeDir = opts.claudeDir ?? defaultClaudeDir();
  const desktopDir = opts.desktopDir ?? defaultDesktopDir();
  const cacheFile = opts.cacheFile === undefined ? defaultCacheFile() : opts.cacheFile;
  const cache = IndexCache.load(cacheFile);

  const existing = new Set<string>(); // every session/transcript file seen on disk, for cache pruning
  const projects = listProjectTranscripts(claudeDir);
  for (const p of projects.paths) existing.add(p);

  // 1. Desktop store ------------------------------------------------------------------------------
  const desktop: SessionInfo[] = [];
  const ownedIds = new Set<string>(); // CLI ids that belong to a desktop session
  const files = listDesktopFiles(desktopDir, cutoff, existing);
  // `existing` is complete now: drop entries for vanished files before they can claim any transcripts.
  cache.prune((file) => existing.has(file));
  // Desktop sessions cached by wider runs (outside this window) still own their transcripts.
  for (const id of cache.desktopCliIds()) ownedIds.add(id);
  for (const file of files) {
    let entry = cache.get(file.path, file.mtimeMs, file.size);
    if (!entry || !entry.info) {
      const parsed = readDesktopSession(file);
      if (!parsed) {
        // The app rewrites these files often; one caught mid-write keeps its last known state.
        const stale = cache.getAny(file.path);
        if (!stale?.info) continue;
        entry = stale;
      } else {
        if (parsed.needsTitle && parsed.info.cliSessionId) {
          const tp = resolveTranscriptPath(
            projects,
            claudeDir,
            parsed.info.cliSessionId,
            parsed.info.cwd,
            parsed.info.repoRoot,
          );
          if (tp) {
            try {
              parsed.info.title = titleFromScan(await scanTranscript(tp));
            } catch {
              // transcript unreadable: keep "Untitled session"
            }
          }
        }
        entry = { mtimeMs: file.mtimeMs, size: file.size, info: parsed.info, prior: parsed.prior };
        cache.set(file.path, entry);
      }
    }
    const info = entry.info as SessionInfo;
    desktop.push(info);
    if (info.cliSessionId) ownedIds.add(info.cliSessionId);
    for (const id of entry.prior ?? []) ownedIds.add(id);
  }

  // Resolve transcript paths on copies (never stored in the cache: they depend on the live file layout).
  const resolvedDesktop = desktop.map((info) => {
    if (!info.cliSessionId) return info;
    const transcriptPath = resolveTranscriptPath(projects, claudeDir, info.cliSessionId, info.cwd, info.repoRoot);
    return transcriptPath ? { ...info, transcriptPath } : info;
  });

  // 2. CLI-only transcripts -----------------------------------------------------------------------
  const cliSessions: SessionInfo[] = [];
  const candidates: { t: ProjectTranscript; mtimeMs: number; size: number }[] = [];
  for (const t of projects.all) {
    if (ownedIds.has(t.uuid)) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(t.path);
    } catch {
      continue;
    }
    if (!st.isFile() || st.mtimeMs < cutoff) continue;
    candidates.push({ t, mtimeMs: st.mtimeMs, size: st.size });
  }
  await mapPool(candidates, SCAN_CONCURRENCY, async ({ t, mtimeMs, size }) => {
    let entry = cache.get(t.path, mtimeMs, size);
    if (!entry) {
      let info: SessionInfo | null = null;
      try {
        const scan = await scanTranscript(t.path, { projectDirName: t.dirName, stopOnDesktop: true });
        if (!scan.desktopOwned && scan.messages > 0) {
          const rawCwd = scan.cwd;
          if (rawCwd) {
            const cwd = stripTrailingSlashes(rawCwd);
            const repoRoot = repoRootFromCwd(cwd);
            const lastActivity = scan.maxTs ?? mtimeMs;
            info = {
              id: t.uuid,
              source: "cli",
              cliSessionId: t.uuid,
              title: titleFromScan(scan),
              cwd,
              repoRoot,
              repoName: repoNameOf(repoRoot),
              isWorktree: cwd !== repoRoot,
              lastActivity,
              createdAt: scan.minTs ?? lastActivity,
              messages: scan.messages,
              status: "unknown",
              prs: [],
              isArchived: false,
            };
            if (scan.gitBranch) info.branch = scan.gitBranch;
          }
        }
      } catch {
        return; // unreadable right now; try again next time
      }
      entry = { mtimeMs, size, info };
      cache.set(t.path, entry);
    }
    if (entry.info) cliSessions.push({ ...entry.info, transcriptPath: t.path });
  });

  // 3. Persist cache --------------------------------------------------------------------------------
  cache.save();

  // 4. Filter + sort ------------------------------------------------------------------------------
  const excludes = (opts.excludePaths ?? [])
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map(expandHome);

  // Same id in two places (e.g. a session file copied between account folders): keep the newest.
  const byId = new Map<string, SessionInfo>();
  for (const s of [...resolvedDesktop, ...cliSessions]) {
    const prev = byId.get(s.id);
    if (!prev || s.lastActivity > prev.lastActivity) byId.set(s.id, s);
  }

  const out: SessionInfo[] = [];
  for (const s of byId.values()) {
    if (s.lastActivity < cutoff) continue;
    if (s.isArchived && !opts.includeArchived) continue;
    if (excludes.some((prefix) => s.cwd.startsWith(prefix) || s.repoRoot.startsWith(prefix))) continue;
    out.push(s);
  }
  out.sort((a, b) => b.lastActivity - a.lastActivity || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sessions = opts.detectRunning === false ? out : await withRunning(out, now);
  const stateFile = opts.stateFile === undefined ? defaultStateFile() : opts.stateFile;
  return stateFile === null ? sessions : withMarks(sessions, stateFile);
}

/** Groups sessions by repoRoot. Groups are ordered by their newest session; sessions newest first. */
export function groupByRepo(sessions: SessionInfo[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const s of sessions) {
    let g = groups.get(s.repoRoot);
    if (!g) {
      g = { repoRoot: s.repoRoot, repoName: s.repoName, lastActivity: s.lastActivity, sessions: [] };
      groups.set(s.repoRoot, g);
    }
    g.sessions.push(s);
    if (s.lastActivity > g.lastActivity) g.lastActivity = s.lastActivity;
  }
  const result = [...groups.values()];
  for (const g of result) g.sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  result.sort((a, b) => b.lastActivity - a.lastActivity);
  return result;
}
