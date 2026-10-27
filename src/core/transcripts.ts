import * as fs from "fs";
import * as readline from "readline";
import { encodeCwd } from "./paths";

/** What we keep from one ~/.claude/projects/<dir>/<uuid>.jsonl transcript. Metadata only: no message bodies. */
export interface TranscriptScan {
  /** True when any record has entrypoint "claude-desktop" (the transcript belongs to a desktop session). */
  desktopOwned: boolean;
  /** cwd of the session. Prefers a cwd that encodes to the transcript's project dir (what `claude --resume` needs). */
  cwd?: string;
  /** Last git branch seen. */
  gitBranch?: string;
  /** Earliest / latest record timestamp, epoch ms. */
  minTs?: number;
  maxTs?: number;
  /** Non-sidechain real user prompts + assistant records. */
  messages: number;
  /** Last non-empty custom-title.customTitle. */
  customTitle?: string;
  /** Last non-empty summary.summary. */
  summary?: string;
  /** First real user prompt (raw text, truncated by the caller). */
  firstPrompt?: string;
}

export interface ScanOptions {
  /** The project directory name the transcript lives in, used to pick the right cwd. */
  projectDirName?: string;
  /** Stop reading as soon as a claude-desktop record is seen (the caller only wants the ownership answer). */
  stopOnDesktop?: boolean;
}

type Rec = Record<string, unknown>;

function isObj(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Plain text of a user record: string content, or the first `text` part. Undefined when there is none. */
function userText(rec: Rec): string | undefined {
  const message = rec.message;
  if (!isObj(message)) return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (isObj(part) && part.type === "text" && typeof part.text === "string") return part.text;
    }
  }
  return undefined;
}

/**
 * Returns the text of a "real" user prompt, or undefined when the record is not one:
 * isMeta records, tool results, and command/system wrappers (text starting with "<") are skipped.
 */
export function realPromptText(rec: Rec): string | undefined {
  if (rec.isMeta === true) return undefined;
  if (rec.toolUseResult !== undefined && rec.toolUseResult !== null) return undefined;
  const text = userText(rec);
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.startsWith("<")) return undefined;
  return text;
}

/**
 * Streams a transcript line by line and extracts metadata. Tolerates bad JSON lines, blank lines and
 * unknown record types. Never throws on malformed content; rejects only on I/O errors.
 */
export async function scanTranscript(file: string, opts: ScanOptions = {}): Promise<TranscriptScan> {
  const scan: TranscriptScan = { desktopOwned: false, messages: 0 };
  let firstCwd: string | undefined;
  let matchedCwd: string | undefined;

  const input = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObj(parsed)) continue;
      const rec = parsed;

      if (rec.entrypoint === "claude-desktop") {
        scan.desktopOwned = true;
        if (opts.stopOnDesktop) break;
      }

      const type = rec.type;
      if (type === "custom-title") {
        const t = str(rec.customTitle);
        if (t && t.trim()) scan.customTitle = t;
        continue;
      }
      if (type === "summary") {
        const t = str(rec.summary);
        if (t && t.trim()) scan.summary = t;
        continue;
      }

      if (typeof rec.timestamp === "string") {
        const ts = Date.parse(rec.timestamp);
        if (Number.isFinite(ts)) {
          if (scan.minTs === undefined || ts < scan.minTs) scan.minTs = ts;
          if (scan.maxTs === undefined || ts > scan.maxTs) scan.maxTs = ts;
        }
      }

      const cwd = str(rec.cwd);
      if (cwd) {
        if (firstCwd === undefined) firstCwd = cwd;
        if (matchedCwd === undefined && opts.projectDirName && encodeCwd(cwd) === opts.projectDirName) {
          matchedCwd = cwd;
        }
      }
      const branch = str(rec.gitBranch);
      if (branch) scan.gitBranch = branch;

      if (rec.isSidechain === true) continue;
      if (type === "user") {
        const text = realPromptText(rec);
        if (text !== undefined) {
          scan.messages++;
          if (scan.firstPrompt === undefined) scan.firstPrompt = text;
        }
      } else if (type === "assistant") {
        if (rec.isMeta !== true) scan.messages++;
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }

  scan.cwd = matchedCwd ?? firstCwd;
  return scan;
}
