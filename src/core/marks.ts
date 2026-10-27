import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SessionInfo } from "./types";

// "Mark as completed" lives in the launcher's own state file, never in Claude's files. A mark records the session's
// lastActivity when it was made and applies only while the session has had no activity since, the same way the desktop
// app ties its own sidebar "completed" mark to a session timestamp. The file holds ids and numbers only.

export interface Mark {
  /** The session's lastActivity (epoch ms) when it was marked. */
  lastActivity: number;
  /** When the mark was made (epoch ms). */
  markedAt: number;
}

interface StateFile {
  version: 1;
  marks: Record<string, Mark>;
}

const VERSION = 1;
/** Marks older than this are dropped on the next write: by then the session is long out of any window. */
const MARK_TTL_MS = 90 * 86_400_000;
/** At most this many marks are kept (the newest ones). */
const MAX_MARKS = 2000;

/** ~/Library/Application Support/cc-session-launcher/state.json */
export function defaultStateFile(): string {
  return path.join(os.homedir(), "Library", "Application Support", "cc-session-launcher", "state.json");
}

// -------------------------------------------------------------------------------------------------
// Reading and writing
// -------------------------------------------------------------------------------------------------

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The marks in `stateFile`, by session id. A missing, unreadable, corrupt or wrong-version file reads as empty
 * and an entry of the wrong shape is skipped: this never throws.
 */
export function loadMarks(stateFile: string = defaultStateFile()): Map<string, Mark> {
  const marks = new Map<string, Mark>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return marks;
  }
  if (typeof parsed !== "object" || parsed === null) return marks;
  const file = parsed as Partial<StateFile>;
  if (file.version !== VERSION || typeof file.marks !== "object" || file.marks === null || Array.isArray(file.marks)) {
    return marks;
  }
  for (const [id, entry] of Object.entries(file.marks)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { lastActivity, markedAt } = entry as Partial<Mark>;
    if (isTime(lastActivity) && isTime(markedAt)) marks.set(id, { lastActivity, markedAt });
  }
  return marks;
}

/** Prunes (marks older than 90 days, then all but the newest 2000) and writes the file atomically (tmp + rename). */
function writeMarks(stateFile: string, marks: Map<string, Mark>, now: number): void {
  const kept = [...marks]
    .filter(([, m]) => m.markedAt >= now - MARK_TTL_MS)
    .sort((a, b) => b[1].markedAt - a[1].markedAt)
    .slice(0, MAX_MARKS);
  const body: StateFile = { version: VERSION, marks: Object.fromEntries(kept) };
  const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    throw e;
  }
}

// -------------------------------------------------------------------------------------------------
// Changing marks
// -------------------------------------------------------------------------------------------------

// Both functions read and write synchronously, with no await in between, so two calls in one process cannot lose
// each other's update. Unlike reads, a failed write throws: the caller has to tell the user the mark did not stick.

/** Marks the session completed at its current lastActivity. Marking it again updates the mark. */
export async function markDone(
  session: Pick<SessionInfo, "id" | "lastActivity">,
  stateFile: string = defaultStateFile(),
): Promise<void> {
  if (!session.id || !isTime(session.lastActivity)) {
    throw new Error("Cannot mark a session without an id and activity.");
  }
  const marks = loadMarks(stateFile);
  const now = Date.now();
  marks.set(session.id, { lastActivity: session.lastActivity, markedAt: now });
  writeMarks(stateFile, marks, now);
}

/** Removes the session's mark, if any. An id that is not marked changes nothing, not even by creating the file. */
export async function unmarkDone(sessionId: string, stateFile: string = defaultStateFile()): Promise<void> {
  const marks = loadMarks(stateFile);
  if (!marks.delete(sessionId)) return;
  writeMarks(stateFile, marks, Date.now());
}
