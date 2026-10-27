// Shared contract between the indexer, the hand-off helpers, the CLI and the Raycast UI.
// Everything in src/core is plain Node: no Raycast imports.

export type SessionSource = "desktop" | "cli";

/** Derived from the desktop app's postTurnSummary.status_category. */
export type SessionStatus = "needs_input" | "review_ready" | "completed" | "unknown";

export interface SessionPR {
  url: string;
  number?: number;
  state?: string; // e.g. OPEN, MERGED, CLOSED
  repo?: string; // owner/name
}

export interface SessionInfo {
  /** Unique key: the desktop `local_<uuid>` id, or the CLI transcript uuid for CLI-only sessions. */
  id: string;
  source: SessionSource;
  /** Desktop session id (`local_<uuid>`). Present only for desktop sessions. */
  desktopId?: string;
  /** Claude Code session id: transcript file name and the `claude --resume` argument. */
  cliSessionId?: string;
  /** Session title, or the first prompt; at most 120 chars, never empty. */
  title: string;
  /** Directory the session runs in (may be a worktree). */
  cwd: string;
  /** Grouping key: the repo the session belongs to (worktrees mapped back to their parent repo). */
  repoRoot: string;
  /** basename(repoRoot) */
  repoName: string;
  branch?: string;
  isWorktree: boolean;
  /** Epoch ms of the last activity. */
  lastActivity: number;
  createdAt?: number;
  /** Desktop: completed turns. */
  turns?: number;
  /** CLI: count of user + assistant transcript records (excluding meta and tool results). */
  messages?: number;
  status: SessionStatus;
  /**
   * A turn is in progress right now (live claude process and an unfinished transcript tail), or background subagents
   * of the session are still working. Never cached.
   */
  isRunning?: boolean;
  /** Subagents of this session still working (their own transcripts, under <session>/subagents/). Never cached. */
  activeSubagents?: number;
  /**
   * The user marked this session completed in the launcher, and it has had no activity since. `status` is then
   * "completed"; the mark expires on its own when the session's lastActivity moves past the marked one. Never cached.
   */
  markedDone?: boolean;
  /** One-line status from the desktop app (postTurnSummary.status_detail), at most 200 chars. */
  statusDetail?: string;
  /** What the session needs from the user (postTurnSummary.needs_action), at most 200 chars. */
  needsAction?: string;
  model?: string;
  prs: SessionPR[];
  isArchived: boolean;
  /** ~/.claude/projects/<encoded cwd>/<cliSessionId>.jsonl, when it exists. */
  transcriptPath?: string;
  /** The desktop app's metadata JSON for this session, when it exists. */
  desktopMetaPath?: string;
}

export interface LoadOptions {
  /** Activity window in days. 0 means no limit. */
  days: number;
  /** Include sessions archived in the desktop app. Default false. */
  includeArchived?: boolean;
  /** Folder prefixes to hide, matched against cwd and repoRoot. A leading ~ expands to the home dir. */
  excludePaths?: string[];
  /** Default: ~/.claude */
  claudeDir?: string;
  /** Default: ~/Library/Application Support/Claude */
  desktopDir?: string;
  /** Metadata cache file. Default: ~/Library/Caches/cc-session-launcher/index-v1.json. null disables caching. */
  cacheFile?: string | null;
  /** Current time in epoch ms, for tests. Default Date.now(). */
  now?: number;
  /** Detect sessions with a turn in progress (sets SessionInfo.isRunning). Default true. */
  detectRunning?: boolean;
  /**
   * The launcher's own state (done-marks), shared by the CLI and Raycast.
   * Default: ~/Library/Application Support/cc-session-launcher/state.json. null ignores marks.
   */
  stateFile?: string | null;
}

export interface RepoGroup {
  repoRoot: string;
  repoName: string;
  /** Newest lastActivity among the group's sessions. */
  lastActivity: number;
  /** Newest first. */
  sessions: SessionInfo[];
}

export type TerminalApp = "Terminal" | "Ghostty" | "iTerm";

export type OpenMethod = "continue" | "import" | "new";
