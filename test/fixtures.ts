// Synthetic fixtures for the indexer/CLI tests. Everything is built in a temp dir; nothing here is
// copied from real Claude data.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { encodeCwd } from "../src/core/paths";

/** Fixed "current time" used by the deterministic tests. */
export const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export interface TestEnv {
  root: string;
  claudeDir: string;
  desktopDir: string;
  cacheFile: string;
  /** The launcher's done-marks. Tests always point at this (or null), never at the real default. */
  stateFile: string;
  cleanup(): void;
}

export function makeEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccsl-test-"));
  const env: TestEnv = {
    root,
    claudeDir: path.join(root, "claude"),
    desktopDir: path.join(root, "desktop"),
    cacheFile: path.join(root, "cache", "index-v1.json"),
    stateFile: path.join(root, "state", "state.json"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
  fs.mkdirSync(env.claudeDir, { recursive: true });
  fs.mkdirSync(env.desktopDir, { recursive: true });
  return env;
}

export function setMtime(file: string, ms: number): void {
  const d = new Date(ms);
  fs.utimesSync(file, d, d);
}

export interface DesktopOpts {
  account?: string;
  org?: string;
  /** File mtime in epoch ms. Default: NOW - 1h. */
  mtimeMs?: number;
  /** Write this exact text instead of JSON.stringify(fields). */
  raw?: string;
}

let counter = 0;

/** Writes `<desktopDir>/claude-code-sessions/<account>/<org>/<sessionId>.json`. */
export function writeDesktopSession(env: TestEnv, fields: Record<string, unknown>, opts: DesktopOpts = {}): string {
  counter++;
  const sessionId =
    (fields.sessionId as string | undefined) ?? `local_${String(counter).padStart(8, "0")}-aaaa-bbbb-cccc-000000000000`;
  const dir = path.join(env.desktopDir, "claude-code-sessions", opts.account ?? "acct-1", opts.org ?? "org-1");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.json`);
  const body = opts.raw ?? JSON.stringify({ sessionId, ...fields });
  fs.writeFileSync(file, body);
  setMtime(file, opts.mtimeMs ?? NOW - HOUR);
  return file;
}

/** A transcript record (as one JSONL line). */
export function rec(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...extra });
}

export interface TranscriptOpts {
  /** Project dir name; default: encodeCwd(cwd). */
  dirName?: string;
  /** File mtime in epoch ms. Default: NOW - 1h. */
  mtimeMs?: number;
}

/** Writes `<claudeDir>/projects/<dir>/<uuid>.jsonl` from raw lines. */
export function writeTranscript(
  env: TestEnv,
  cwd: string,
  uuid: string,
  lines: string[],
  opts: TranscriptOpts = {},
): string {
  const dir = path.join(env.claudeDir, "projects", opts.dirName ?? encodeCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  setMtime(file, opts.mtimeMs ?? NOW - HOUR);
  return file;
}

export const iso = (ms: number): string => new Date(ms).toISOString();

/** Common per-record fields. */
export function base(cwd: string, ts: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionId: "ignored", cwd, gitBranch: "main", timestamp: iso(ts), entrypoint: "cli", ...extra };
}

export function userPrompt(cwd: string, ts: number, text: string, extra: Record<string, unknown> = {}): string {
  return rec("user", { ...base(cwd, ts), message: { role: "user", content: text }, ...extra });
}

export function assistant(cwd: string, ts: number, text = "ok", extra: Record<string, unknown> = {}): string {
  return rec("assistant", {
    ...base(cwd, ts),
    message: { role: "assistant", content: [{ type: "text", text }] },
    ...extra,
  });
}

/** A finished main turn: the prompt, the final assistant reply (end_turn) and the stop-hook summary after it. */
export function finishedTurn(cwd: string, ts: number): string[] {
  return [
    userPrompt(cwd, ts, "go"),
    rec("assistant", {
      ...base(cwd, ts + 1000),
      message: { role: "assistant", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
    }),
    rec("system", { ...base(cwd, ts + 2000), subtype: "stop_hook_summary" }),
  ];
}

export interface SubagentRecordOpts {
  /** tool_use blocks to put in the record, by tool name. Default: none (a text block). */
  tools?: string[];
  /** The message's stop_reason. Default: "tool_use" with tools, else "end_turn". null and undefined (omitted) are allowed. */
  stopReason?: string | null;
  extra?: Record<string, unknown>;
}

/** A subagent (sidechain) assistant record. */
export function subagentAssistant(cwd: string, ts: number, opts: SubagentRecordOpts = {}): string {
  const tools = opts.tools ?? [];
  const content =
    tools.length > 0
      ? tools.map((name, i) => ({ type: "tool_use", id: `toolu_${i}`, name, input: {} }))
      : [{ type: "text", text: "..." }];
  const message: Record<string, unknown> = { role: "assistant", content };
  const stopReason = "stopReason" in opts ? opts.stopReason : tools.length > 0 ? "tool_use" : "end_turn";
  if (stopReason !== undefined) message.stop_reason = stopReason;
  return rec("assistant", { ...base(cwd, ts), isSidechain: true, agentId: "a1", message, ...opts.extra });
}

/** The tool_result a subagent gets back (a sidechain user record). */
export function subagentToolResult(cwd: string, ts: number): string {
  return rec("user", {
    ...base(cwd, ts),
    isSidechain: true,
    agentId: "a1",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_0", content: "ok" }] },
  });
}

/** A subagent that is busy: its last assistant record is a Bash call, answered by a tool_result. */
export function workingSubagent(cwd: string, ts: number): string[] {
  return [
    userPrompt(cwd, ts, "sub task", { isSidechain: true, agentId: "a1" }),
    subagentAssistant(cwd, ts + 1000, { tools: ["Bash"] }),
    subagentToolResult(cwd, ts + 2000),
  ];
}

/** A subagent that reported back with the desktop harness's SubagentHandback tool. */
export function finishedSubagent(cwd: string, ts: number): string[] {
  return [
    userPrompt(cwd, ts, "sub task", { isSidechain: true, agentId: "a1" }),
    subagentAssistant(cwd, ts + 1000, { tools: ["SubagentHandback"] }),
    subagentToolResult(cwd, ts + 2000),
  ];
}

export interface SubagentOpts extends TranscriptOpts {
  /** Also write the sibling `agent-<id>.meta.json`, as the harness does. Default true. */
  meta?: boolean;
}

/**
 * Writes `<claudeDir>/projects/<dir>/<cliSessionId>/subagents/agent-<agentId>.jsonl` from raw lines
 * (plus the `.meta.json` sibling), next to the session's main transcript.
 */
export function writeSubagent(
  env: TestEnv,
  cwd: string,
  cliSessionId: string,
  agentId: string,
  lines: string[],
  opts: SubagentOpts = {},
): string {
  const dir = path.join(env.claudeDir, "projects", opts.dirName ?? encodeCwd(cwd), cliSessionId, "subagents");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  setMtime(file, opts.mtimeMs ?? NOW - HOUR);
  if (opts.meta !== false) {
    const meta = path.join(dir, `agent-${agentId}.meta.json`);
    fs.writeFileSync(
      meta,
      JSON.stringify({ agentType: "general-purpose", description: "sub task", requestShape: "background" }),
    );
    setMtime(meta, opts.mtimeMs ?? NOW - HOUR);
  }
  return file;
}

export const UUID_A = "11111111-1111-4111-8111-111111111111";
export const UUID_B = "22222222-2222-4222-8222-222222222222";
export const UUID_C = "33333333-3333-4333-8333-333333333333";
export const UUID_D = "44444444-4444-4444-8444-444444444444";
export const UUID_E = "55555555-5555-4555-8555-555555555555";
