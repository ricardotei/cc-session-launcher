import * as os from "os";
import * as path from "path";

/** Marker that Claude Code puts in worktree directories it creates inside a repo. */
export const WORKTREE_MARKER = "/.claude/worktrees/";

export function defaultClaudeDir(): string {
  return path.join(os.homedir(), ".claude");
}

export function defaultDesktopDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "Claude");
}

export function defaultCacheFile(): string {
  return path.join(os.homedir(), "Library", "Caches", "cc-session-launcher", "index-v1.json");
}

/** Expands a leading `~` or `~/` to the home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Claude Code's project directory name for a cwd: every non-alphanumeric character becomes "-". */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Drops trailing slashes (but keeps a bare "/"). */
export function stripTrailingSlashes(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") || "/" : p;
}

/** Maps a cwd inside `<repo>/.claude/worktrees/<name>` back to `<repo>`; other paths are returned unchanged. */
export function repoRootFromCwd(cwd: string): string {
  const idx = cwd.indexOf(WORKTREE_MARKER);
  if (idx > 0) return cwd.slice(0, idx);
  return cwd;
}

/** basename that is never empty (so "/" stays "/"). */
export function repoNameOf(repoRoot: string): string {
  return path.basename(repoRoot) || repoRoot;
}
