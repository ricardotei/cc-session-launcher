import * as os from "os";

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

/** "now", "5m", "3h", "2d", "3w", "5mo", "2y": compact age of `ms` relative to `now`. */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (!Number.isFinite(seconds) || seconds < MINUTE) return "now";
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h`;
  const days = Math.floor(seconds / DAY);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.min(11, Math.floor(days / 30))}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** Collapses whitespace and cuts to `max` chars with a trailing ellipsis (the ellipsis counts toward `max`). */
export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  if (max <= 0) return "";
  if (max === 1) return "…";
  let cut = clean.slice(0, max - 1);
  // Never leave half of a surrogate pair at the cut.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.trimEnd() + "…";
}

/** Replaces the home directory prefix with ~. */
export function tildify(path: string): string {
  const home = os.homedir();
  if (!home || home === "/") return path;
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}
