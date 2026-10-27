import { execFile } from "child_process";
import * as fs from "fs";

// Turn-in-progress detection. A live `claude` process says a session is open (it stays alive while idle),
// the transcript tail says whether the last turn finished. The indexer combines the two.

// -------------------------------------------------------------------------------------------------
// Live processes (the `ps` call is injectable so tests never run it)
// -------------------------------------------------------------------------------------------------

/** Returns the raw stdout of `ps -axww -o command=`. The default implementation is child_process.execFile. */
export type ProcessLister = () => Promise<string>;

const defaultLister: ProcessLister = () =>
  new Promise<string>((resolve, reject) => {
    execFile("/bin/ps", ["-axww", "-o", "command="], { maxBuffer: 64 * 1024 * 1024, timeout: 5000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });

let lister: ProcessLister = defaultLister;

/** Replaces the process lister (tests). Pass null to restore the real ps-based one. */
export function setProcessLister(next: ProcessLister | null): void {
  lister = next ?? defaultLister;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** `--resume=<id>`, `--resume <id>`, `--session-id ...`, `-r ...`. The id must end there (no trailing hex or dash). */
const SESSION_FLAG = new RegExp(`(?:^|\\s)(?:--resume|--session-id|-r)(?:=|\\s+)(${UUID})(?![0-9a-f-])`, "gi");

/**
 * The argument text of a claude command line, or undefined when the executable is not claude.
 * The executable is `claude` or a path ending in `/claude`. The path may contain spaces (the desktop app lives
 * under "Application Support"), so tokens are consumed until one has the basename `claude`; an option-looking
 * token first (`zsh -c ...`, `disclaimer --pgroup ...`) means this is some other program.
 */
function claudeArgs(command: string): string | undefined {
  const line = command.trimStart();
  if (!line.startsWith("/") && !/^claude(\s|$)/.test(line)) return undefined;
  const tokens = line.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-")) return undefined;
    if (token === "claude" || token.endsWith("/claude")) return tokens.slice(i + 1).join(" ");
  }
  return undefined;
}

/** Every session id (lower-cased) that a claude process in this `ps` output was started with. */
export function parseLiveSessionIds(psOutput: string): Set<string> {
  const ids = new Set<string>();
  for (const line of psOutput.split("\n")) {
    const args = claudeArgs(line);
    if (args === undefined) continue;
    for (const m of args.matchAll(SESSION_FLAG)) ids.add(m[1].toLowerCase());
  }
  return ids;
}

/** CLI session ids of the claude processes alive right now. Any failure gives an empty set. */
export async function listLiveSessionIds(): Promise<Set<string>> {
  try {
    return parseLiveSessionIds(await lister());
  } catch {
    return new Set();
  }
}

// -------------------------------------------------------------------------------------------------
// Transcript tail
// -------------------------------------------------------------------------------------------------

/** running: the last turn is unfinished. idle: it finished. unknown: the tail does not say. */
export type TailState = "running" | "idle" | "unknown";

const TAIL_START_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 4 * 1024 * 1024;
const TAIL_GROWTH = 4;

type Rec = Record<string, unknown>;

function isObj(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when a user record is the marker Claude Code writes after an Esc / rejected tool call. */
function isInterrupt(rec: Rec): boolean {
  const message = rec.message;
  if (!isObj(message)) return false;
  const content = message.content;
  const startsWithMarker = (text: unknown) =>
    typeof text === "string" && text.startsWith("[Request interrupted by user");
  if (typeof content === "string") return startsWithMarker(content);
  if (!Array.isArray(content)) return false;
  return content.some((part) => isObj(part) && part.type === "text" && startsWithMarker(part.text));
}

/** What one transcript record says about the turn, or undefined when it says nothing. */
function recordState(rec: Rec): "running" | "idle" | undefined {
  if (rec.isSidechain === true) return undefined;
  switch (rec.type) {
    case "system":
      return rec.subtype === "stop_hook_summary" || rec.subtype === "turn_duration" ? "idle" : undefined;
    case "assistant": {
      if (rec.isApiErrorMessage === true) return "idle";
      const message = rec.message;
      const stop = isObj(message) ? message.stop_reason : undefined;
      if (stop === undefined || stop === null || stop === "tool_use" || stop === "pause_turn") return "running";
      return "idle";
    }
    case "user":
      if (rec.isMeta === true) return undefined;
      return isInterrupt(rec) ? "idle" : "running";
    default:
      return undefined; // bookkeeping records: last-prompt, cost-state, custom-title, mode, attachment, ...
  }
}

/** The parseable records of a tail window, newest first. A cut first line and unparseable lines are skipped. */
function* recordsNewestFirst(text: string, startsMidLine: boolean): Generator<Rec> {
  const lines = text.split("\n");
  if (startsMidLine) lines.shift(); // cut in the middle of a record
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue; // a record still being written, or garbage
    }
    if (isObj(rec)) yield rec;
  }
}

/** Walks a transcript tail from the end to the first record that decides the state. */
function tailStateOf(text: string, startsMidLine: boolean): TailState {
  for (const rec of recordsNewestFirst(text, startsMidLine)) {
    const state = recordState(rec);
    if (state) return state;
  }
  return "unknown";
}

/** Reads `length` bytes at `position`, or fewer if the file is shorter. */
async function readRange(handle: fs.promises.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buf, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buf.subarray(0, filled);
}

/**
 * Runs `decide` over the last 64 KB of a file and grows the window x4 up to 4 MB while it returns undefined
 * (long bookkeeping runs, huge tool results). `startsMidLine` tells it the first line may be cut. Never throws:
 * undefined when nothing decided or the file cannot be read.
 */
async function decideFromTail<T>(
  file: string,
  decide: (text: string, startsMidLine: boolean) => T | undefined,
): Promise<T | undefined> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch {
    return undefined;
  }
  try {
    const { size } = await handle.stat();
    for (let window = TAIL_START_BYTES; ; window *= TAIL_GROWTH) {
      const start = Math.max(0, size - window);
      const decided = decide((await readRange(handle, start, size - start)).toString("utf8"), start > 0);
      if (decided !== undefined || start === 0 || window >= TAIL_MAX_BYTES) return decided;
    }
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Whether the last turn of a transcript is still going. Reads the tail window described at decideFromTail. */
export async function readTailState(transcriptPath: string): Promise<TailState> {
  const state = await decideFromTail<TailState>(transcriptPath, (text, startsMidLine) => {
    const found = tailStateOf(text, startsMidLine);
    return found === "unknown" ? undefined : found;
  });
  return state ?? "unknown";
}

// -------------------------------------------------------------------------------------------------
// Subagent transcript tail
// -------------------------------------------------------------------------------------------------

/** working: the subagent has more to do. finished: it reported back or stopped. unknown: no assistant record. */
export type SubagentState = "working" | "finished" | "unknown";

/** The desktop harness's report-back tool: a subagent that called it is done. */
const HANDBACK_TOOL = "SubagentHandback";

/**
 * What an assistant record of a subagent transcript says. Unlike the main transcript there are no turn-end system
 * records, so the last assistant record decides: a report-back call, an API error or a final reply (end_turn,
 * max_tokens, refusal, ...) finishes it; any other tool call or an unfinished message (null stop_reason) means working.
 */
function subagentRecordState(rec: Rec): SubagentState | undefined {
  if (rec.type !== "assistant") return undefined;
  const message = isObj(rec.message) ? rec.message : undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  const toolNames = content.filter((part) => isObj(part) && part.type === "tool_use").map((part) => (part as Rec).name);
  if (toolNames.includes(HANDBACK_TOOL) || rec.isApiErrorMessage === true) return "finished";
  if (toolNames.length > 0) return "working";
  const stop = message?.stop_reason;
  return stop === undefined || stop === null || stop === "tool_use" || stop === "pause_turn" ? "working" : "finished";
}

/** Walks a subagent tail from the end to the last assistant record. Sidechain records count here. */
function subagentStateOf(text: string, startsMidLine: boolean): SubagentState | undefined {
  for (const rec of recordsNewestFirst(text, startsMidLine)) {
    const state = subagentRecordState(rec);
    if (state) return state;
  }
  return undefined;
}

/**
 * Whether a subagent transcript (<session>/subagents/agent-<id>.jsonl) still looks busy, from its last assistant
 * record. A killed subagent looks like a working one: the caller bounds that with the file's mtime. Never throws.
 */
export async function readSubagentState(subagentPath: string): Promise<SubagentState> {
  return (await decideFromTail(subagentPath, subagentStateOf)) ?? "unknown";
}
