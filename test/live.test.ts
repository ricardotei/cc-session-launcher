import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadSessions } from "../src/core/indexer";
import { markDone } from "../src/core/marks";
import {
  listLiveSessionIds,
  parseLiveSessionIds,
  readSubagentState,
  readTailState,
  setProcessLister,
} from "../src/core/live";
import { encodeCwd } from "../src/core/paths";
import {
  HOUR,
  NOW,
  UUID_A,
  UUID_B,
  UUID_C,
  UUID_D,
  assistant,
  base,
  finishedSubagent,
  makeEnv,
  rec,
  setMtime,
  subagentAssistant,
  subagentToolResult,
  userPrompt,
  workingSubagent,
  writeDesktopSession,
  writeSubagent,
  writeTranscript,
  type TestEnv,
} from "./fixtures";

const MINUTE = 60_000;
const REPO = "/Users/test/Projects/app";

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
  // Nothing in this file may run the real `ps`: every test installs its own lister (or none is reached).
  setProcessLister(async () => "");
});
afterEach(() => {
  setProcessLister(null);
  env.cleanup();
});

// -------------------------------------------------------------------------------------------------
// transcript record builders
// -------------------------------------------------------------------------------------------------

const ts = (n: number) => NOW - 10 * MINUTE + n * 1000;

/** An assistant record with the given stop_reason (null = still streaming). */
function asst(stopReason: string | null | undefined, extra: Record<string, unknown> = {}): string {
  const message: Record<string, unknown> = { role: "assistant", content: [{ type: "text", text: "..." }] };
  if (stopReason !== undefined) message.stop_reason = stopReason;
  return rec("assistant", { ...base(REPO, ts(2)), message, ...extra });
}

const toolResult = (): string =>
  rec("user", {
    ...base(REPO, ts(3)),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }] },
  });

const sys = (subtype: string, extra: Record<string, unknown> = {}): string =>
  rec("system", { ...base(REPO, ts(4)), subtype, ...extra });

const interrupt = (content: unknown): string =>
  rec("user", { ...base(REPO, ts(5)), message: { role: "user", content } });

/** Bookkeeping records Claude Code appends after (and between) turns. */
const BOOKKEEPING = [
  rec("last-prompt", { lastPrompt: "do the thing", sessionId: "x" }),
  rec("cost-state", { cost: 0.12 }),
  rec("custom-title", { customTitle: "A title" }),
  rec("mode", { mode: "default" }),
  rec("atis-latch", { latched: true }),
  rec("agent-name", { agentName: "main" }),
  rec("attachment", { attachment: { type: "hook_success" } }),
  rec("api-request", { id: "req_1" }),
  rec("api-request-blob", { blob: "x" }),
  rec("pr-link", { prNumber: 1 }),
];

/** Roughly `bytes` of bookkeeping lines (each one a few KB so the 64 KB window cuts through them). */
function bookkeepingBytes(bytes: number): string[] {
  const lines: string[] = [];
  let total = 0;
  while (total < bytes) {
    const line = rec("api-request-blob", { blob: "b".repeat(3000) });
    lines.push(line);
    total += line.length + 1;
  }
  return lines;
}

let fileCounter = 0;
/** Writes raw lines (joined by \n, with a trailing newline unless `trailingNewline` is false). */
function tail(lines: string[], trailingNewline = true): string {
  const file = path.join(env.root, `tail-${++fileCounter}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + (trailingNewline ? "\n" : ""));
  return file;
}

// -------------------------------------------------------------------------------------------------
// ps parsing
// -------------------------------------------------------------------------------------------------

const DESKTOP_BIN =
  "/Users/test/Library/Application Support/Claude/claude-code/2.1.308/a93ded4b1b47/claude.app/Contents/MacOS/claude";

describe("parseLiveSessionIds", () => {
  it("reads --resume=<id> from a desktop claude process (path with spaces)", () => {
    const ps = `${DESKTOP_BIN} --output-format stream-json --verbose --input-format stream-json --model=claude-opus-5-5 --permission-prompt-tool=stdio --resume=${UUID_A} --setting-sources user\n`;
    assert.deepEqual([...parseLiveSessionIds(ps)], [UUID_A]);
  });

  it("reads `--resume <id>`, `--session-id <id>` and `-r <id>` from a terminal claude", () => {
    const ps = [
      `claude --resume ${UUID_A}`,
      `/opt/homebrew/bin/claude --session-id ${UUID_B}`,
      `/Users/test/.local/bin/claude --model opus -r ${UUID_C} --verbose`,
      `claude --session-id=${UUID_D}`,
    ].join("\n");
    assert.deepEqual([...parseLiveSessionIds(ps)].sort(), [UUID_A, UUID_B, UUID_C, UUID_D]);
  });

  it("lower-cases ids and merges duplicates", () => {
    const lower = "abcdef12-3456-4789-abcd-ef0123456789";
    const ps = [`claude --resume ${lower.toUpperCase()}`, `${DESKTOP_BIN} --resume=${lower}`].join("\n");
    const ids = parseLiveSessionIds(ps);
    assert.deepEqual([...ids], [lower]);
  });

  it("ignores processes that are not claude", () => {
    const ps = [
      `/bin/zsh -c source /Users/test/.claude/shell-snapshots/s.sh && claude --resume ${UUID_A}`,
      `/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- ${DESKTOP_BIN} --resume=${UUID_B}`,
      `/usr/bin/grep -r claude --resume ${UUID_C}`,
      `node /Users/test/server.js --resume ${UUID_C}`,
      `/Users/test/claude-notes/run.sh --resume ${UUID_C}`,
      `/usr/bin/tail -f /Users/test/.claude/projects/-Users-test-app/${UUID_D}.jsonl`,
      `vim claudefile --resume ${UUID_D}`,
    ].join("\n");
    assert.deepEqual([...parseLiveSessionIds(ps)], []);
  });

  it("ignores claude processes without a usable id", () => {
    const ps = [
      `claude`,
      `claude --continue`,
      `claude --resume`,
      `claude --resume --model opus`,
      `claude --resume=not-a-uuid`,
      `claude --resume ${UUID_A}-extra`,
      `claude --resume ${UUID_A}0`,
      `claude --output-format stream-json --verbose`,
      `claude --append-system-prompt resume ${UUID_B}`,
    ].join("\n");
    assert.deepEqual([...parseLiveSessionIds(ps)], []);
  });

  it("survives garbage output", () => {
    assert.equal(parseLiveSessionIds("").size, 0);
    assert.equal(parseLiveSessionIds("\n\n   \n").size, 0);
    assert.equal(parseLiveSessionIds("\u0000￿ garbage \r\n ---- \t").size, 0);
    assert.equal(parseLiveSessionIds("x".repeat(100_000)).size, 0);
    assert.equal(parseLiveSessionIds(`/ ${"claude ".repeat(1000)}`).size, 0);
  });

  it("tolerates CRLF and leading whitespace", () => {
    const ps = `  claude --resume ${UUID_A}\r\n\tclaude -r ${UUID_B}\r\n`;
    assert.deepEqual([...parseLiveSessionIds(ps)].sort(), [UUID_A, UUID_B]);
  });
});

describe("listLiveSessionIds", () => {
  it("uses the injected lister", async () => {
    let calls = 0;
    setProcessLister(async () => {
      calls++;
      return `claude --resume ${UUID_A}\nclaude --resume ${UUID_B}\n`;
    });
    const ids = await listLiveSessionIds();
    assert.equal(calls, 1);
    assert.deepEqual([...ids].sort(), [UUID_A, UUID_B]);
  });

  it("returns an empty set when the lister rejects or throws", async () => {
    setProcessLister(async () => {
      throw new Error("ps blew up");
    });
    assert.equal((await listLiveSessionIds()).size, 0);
    setProcessLister(() => {
      throw new Error("sync failure");
    });
    assert.equal((await listLiveSessionIds()).size, 0);
    setProcessLister((() => Promise.resolve(undefined)) as unknown as () => Promise<string>);
    assert.equal((await listLiveSessionIds()).size, 0);
  });
});

// -------------------------------------------------------------------------------------------------
// transcript tail
// -------------------------------------------------------------------------------------------------

describe("readTailState: finished turns", () => {
  it("assistant end_turn then stop_hook_summary is idle", async () => {
    const file = tail([userPrompt(REPO, ts(0), "hi"), asst("end_turn"), sys("stop_hook_summary")]);
    assert.equal(await readTailState(file), "idle");
  });

  it("skips the bookkeeping records that follow the turn", async () => {
    const file = tail([userPrompt(REPO, ts(0), "hi"), asst("end_turn"), sys("stop_hook_summary"), ...BOOKKEEPING]);
    assert.equal(await readTailState(file), "idle");
  });

  it("turn_duration is idle too", async () => {
    const file = tail([userPrompt(REPO, ts(0), "hi"), asst("tool_use"), toolResult(), sys("turn_duration")]);
    assert.equal(await readTailState(file), "idle");
  });

  it("a bare end_turn assistant record is idle", async () => {
    assert.equal(await readTailState(tail([userPrompt(REPO, ts(0), "hi"), asst("end_turn")])), "idle");
  });

  it("any other stop_reason is idle", async () => {
    for (const reason of ["end_turn", "max_tokens", "stop_sequence", "refusal", "something_new"]) {
      assert.equal(await readTailState(tail([userPrompt(REPO, ts(0), "hi"), asst(reason)])), "idle", reason);
    }
  });

  it("an API error message is idle even with a null stop_reason", async () => {
    const file = tail([userPrompt(REPO, ts(0), "hi"), asst(null, { isApiErrorMessage: true })]);
    assert.equal(await readTailState(file), "idle");
  });

  it("an interrupted turn is idle (string content)", async () => {
    const file = tail([userPrompt(REPO, ts(0), "hi"), asst("tool_use"), interrupt("[Request interrupted by user]")]);
    assert.equal(await readTailState(file), "idle");
  });

  it("an interrupted tool call is idle (text part, even next to a tool_result)", async () => {
    const part = { type: "text", text: "[Request interrupted by user for tool use]" };
    assert.equal(await readTailState(tail([asst("tool_use"), interrupt([part])])), "idle");
    const withResult = interrupt([{ type: "tool_result", tool_use_id: "t", content: "x" }, part]);
    assert.equal(await readTailState(tail([asst("tool_use"), withResult])), "idle");
  });
});

describe("readTailState: unfinished turns", () => {
  it("assistant tool_use is running", async () => {
    assert.equal(await readTailState(tail([userPrompt(REPO, ts(0), "hi"), asst("tool_use")])), "running");
  });

  it("null, missing and pause_turn stop reasons are running", async () => {
    for (const reason of [null, undefined, "pause_turn"]) {
      assert.equal(await readTailState(tail([userPrompt(REPO, ts(0), "hi"), asst(reason)])), "running", String(reason));
    }
  });

  it("a user prompt as the last record is running", async () => {
    assert.equal(await readTailState(tail([asst("end_turn"), userPrompt(REPO, ts(0), "next thing")])), "running");
  });

  it("a tool_result as the last record is running", async () => {
    assert.equal(await readTailState(tail([userPrompt(REPO, ts(0), "hi"), asst("tool_use"), toolResult()])), "running");
  });

  it("ignores bookkeeping records after an unfinished record", async () => {
    assert.equal(
      await readTailState(tail([userPrompt(REPO, ts(0), "hi"), asst("tool_use"), ...BOOKKEEPING])),
      "running",
    );
  });

  it("text that merely mentions an interruption is still a running prompt", async () => {
    const file = tail([asst("end_turn"), interrupt("why did you say [Request interrupted by user] earlier?")]);
    assert.equal(await readTailState(file), "running");
    assert.equal(await readTailState(tail([asst("end_turn"), interrupt(" [Request interrupted by user]")])), "running");
  });
});

describe("readTailState: records that are skipped", () => {
  it("other system subtypes do not decide", async () => {
    assert.equal(
      await readTailState(tail([userPrompt(REPO, ts(0), "hi"), asst("tool_use"), sys("local_command")])),
      "running",
    );
    assert.equal(
      await readTailState(tail([userPrompt(REPO, ts(0), "hi"), asst("end_turn"), sys("informational")])),
      "idle",
    );
    assert.equal(await readTailState(tail([asst("tool_use"), rec("system", { subtype: undefined })])), "running");
  });

  it("sidechain records are skipped", async () => {
    const lines = [userPrompt(REPO, ts(0), "hi"), asst("end_turn"), sys("stop_hook_summary")];
    const sidechain = [
      asst("tool_use", { isSidechain: true }),
      userPrompt(REPO, ts(6), "sub task", { isSidechain: true }),
      sys("stop_hook_summary", { isSidechain: true }),
    ];
    assert.equal(await readTailState(tail([...lines, ...sidechain])), "idle");
    const running = [userPrompt(REPO, ts(0), "hi"), asst("tool_use")];
    const idleSidechain = [asst("end_turn", { isSidechain: true }), sys("turn_duration", { isSidechain: true })];
    assert.equal(await readTailState(tail([...running, ...idleSidechain])), "running");
  });

  it("meta user records are skipped", async () => {
    const meta = userPrompt(REPO, ts(6), "<system-reminder>...</system-reminder>", { isMeta: true });
    assert.equal(await readTailState(tail([asst("end_turn"), sys("stop_hook_summary"), meta])), "idle");
    assert.equal(await readTailState(tail([asst("tool_use"), meta])), "running");
  });

  it("unparseable lines are skipped (a record still being written)", async () => {
    const half = `{"type":"assistant","message":{"role":"assis`;
    assert.equal(await readTailState(tail([asst("end_turn"), sys("stop_hook_summary"), half], false)), "idle");
    assert.equal(await readTailState(tail([userPrompt(REPO, ts(0), "hi"), asst("tool_use"), half], false)), "running");
    assert.equal(await readTailState(tail([asst("tool_use"), "not json at all", "", "   "])), "running");
  });

  it("non-object JSON lines and unknown record types are skipped", async () => {
    const lines = [asst("tool_use"), "123", "null", "[1,2]", '"text"', rec("progress", { data: 1 }), rec("summary")];
    assert.equal(await readTailState(tail(lines)), "running");
  });

  it("a user record without a message is a running prompt", async () => {
    assert.equal(await readTailState(tail([asst("end_turn"), rec("user")])), "running");
  });
});

describe("readTailState: unknown", () => {
  it("empty and whitespace-only files", async () => {
    assert.equal(await readTailState(tail([], false)), "unknown");
    assert.equal(await readTailState(tail(["", "  ", ""])), "unknown");
  });

  it("a missing file", async () => {
    assert.equal(await readTailState(path.join(env.root, "nope.jsonl")), "unknown");
  });

  it("a path that cannot be read as a file", async () => {
    assert.equal(await readTailState(env.root), "unknown");
  });

  it("only bookkeeping records", async () => {
    assert.equal(await readTailState(tail(BOOKKEEPING)), "unknown");
  });

  it("only garbage", async () => {
    assert.equal(await readTailState(tail(["{", "}}", "nope"])), "unknown");
  });
});

describe("readTailState: reading the tail", () => {
  it("keeps the first line when the read starts at offset 0 (also without a trailing newline)", async () => {
    assert.equal(await readTailState(tail([userPrompt(REPO, ts(0), "hi")], false)), "running");
    assert.equal(await readTailState(tail([asst("end_turn")], false)), "idle");
  });

  it("drops the partial first line when the window cuts through a record", async () => {
    // A 100 KB record of 4-byte characters: the 64 KB window starts in the middle of it (and of a character).
    const big = userPrompt(REPO, ts(0), "😀".repeat(25_000));
    assert.ok(Buffer.byteLength(big) > 64 * 1024);
    assert.equal(await readTailState(tail([big, asst("tool_use")])), "running");
    assert.equal(await readTailState(tail([big, asst("end_turn"), sys("stop_hook_summary")])), "idle");
  });

  it("grows the window when the deciding record sits before more than 64 KB of bookkeeping", async () => {
    const idle = [userPrompt(REPO, ts(0), "hi"), asst("end_turn"), sys("stop_hook_summary")];
    const file = tail([...idle, ...bookkeepingBytes(200 * 1024)]);
    assert.ok(fs.statSync(file).size > 200 * 1024);
    assert.equal(await readTailState(file), "idle");
    const running = [userPrompt(REPO, ts(0), "hi"), asst("tool_use")];
    assert.equal(await readTailState(tail([...running, ...bookkeepingBytes(200 * 1024)])), "running");
  });

  it("keeps growing for a deciding record deeper than 1 MB", async () => {
    const file = tail([userPrompt(REPO, ts(0), "hi"), asst("tool_use"), ...bookkeepingBytes(1.5 * 1024 * 1024)]);
    assert.equal(await readTailState(file), "running");
  });

  it("handles a single record larger than the first window", async () => {
    const huge = asst("tool_use", { padding: "p".repeat(150 * 1024) });
    assert.equal(await readTailState(tail([userPrompt(REPO, ts(0), "hi"), huge])), "running");
  });

  it("gives up after 4 MB without a deciding record", async () => {
    const file = tail([userPrompt(REPO, ts(0), "hi"), asst("tool_use"), ...bookkeepingBytes(4.5 * 1024 * 1024)]);
    assert.equal(await readTailState(file), "unknown");
  });

  it("does not read past the window for a decisive tail", async () => {
    // 6 MB of history, but the deciding record is at the very end: still answered from the last 64 KB.
    const history = bookkeepingBytes(6 * 1024 * 1024);
    assert.equal(await readTailState(tail([...history, asst("end_turn"), sys("turn_duration")])), "idle");
  });
});

// -------------------------------------------------------------------------------------------------
// subagent transcript tail
// -------------------------------------------------------------------------------------------------

/** A subagent assistant record in this file's REPO. */
const agentAsst = (opts: Parameters<typeof subagentAssistant>[2] = {}): string => subagentAssistant(REPO, ts(2), opts);
const agentResult = (): string => subagentToolResult(REPO, ts(3));
const agentPrompt = (): string => userPrompt(REPO, ts(0), "sub task", { isSidechain: true });

describe("readSubagentState: finished", () => {
  it("a SubagentHandback call is finished, with or without its tool_result after it", async () => {
    const handback = agentAsst({ tools: ["SubagentHandback"] });
    assert.equal(await readSubagentState(tail([agentPrompt(), handback, agentResult()])), "finished");
    assert.equal(await readSubagentState(tail([agentPrompt(), handback])), "finished");
  });

  it("SubagentHandback wins over a null stop_reason and over other tool_use blocks in the same record", async () => {
    const streaming = agentAsst({ tools: ["SubagentHandback"], stopReason: null });
    assert.equal(await readSubagentState(tail([agentPrompt(), streaming])), "finished");
    const mixed = agentAsst({ tools: ["Bash", "SubagentHandback"] });
    assert.equal(await readSubagentState(tail([agentPrompt(), mixed, agentResult()])), "finished");
  });

  it("an end_turn text reply is finished (subagents of other harnesses)", async () => {
    assert.equal(await readSubagentState(tail([agentPrompt(), agentAsst({ stopReason: "end_turn" })])), "finished");
  });

  it("any other stop_reason without a tool_use is finished", async () => {
    for (const reason of ["end_turn", "stop_sequence", "max_tokens", "refusal", "something_new"]) {
      const file = tail([agentPrompt(), agentAsst({ stopReason: reason })]);
      assert.equal(await readSubagentState(file), "finished", reason);
    }
  });

  it("an API error message is finished, even with a null stop_reason", async () => {
    const error = agentAsst({ stopReason: null, extra: { isApiErrorMessage: true } });
    assert.equal(
      await readSubagentState(tail([agentPrompt(), agentAsst({ tools: ["Bash"] }), agentResult(), error])),
      "finished",
    );
  });

  it("user records and bookkeeping after the deciding assistant record do not change the answer", async () => {
    const lines = [agentPrompt(), agentAsst({ tools: ["SubagentHandback"] }), agentResult(), ...BOOKKEEPING];
    assert.equal(await readSubagentState(tail(lines)), "finished");
  });

  it("only the last assistant record counts: a final reply after earlier tool calls", async () => {
    const lines = [agentPrompt(), agentAsst({ tools: ["Bash"] }), agentResult(), agentAsst({ stopReason: "end_turn" })];
    assert.equal(await readSubagentState(tail(lines)), "finished");
  });
});

describe("readSubagentState: working", () => {
  it("a Bash tool_use and its tool_result is working", async () => {
    assert.equal(await readSubagentState(tail(workingSubagent(REPO, ts(0)))), "working");
  });

  it("a tool_use that has no result yet is working", async () => {
    assert.equal(await readSubagentState(tail([agentPrompt(), agentAsst({ tools: ["Read"] })])), "working");
  });

  it("any non-handback tool_use is working, whatever the stop_reason says", async () => {
    for (const tool of ["Bash", "Read", "Edit", "Grep", "Agent", "mcp__x__y"]) {
      assert.equal(await readSubagentState(tail([agentPrompt(), agentAsst({ tools: [tool] })])), "working", tool);
    }
    const odd = agentAsst({ tools: ["Bash"], stopReason: "end_turn" });
    assert.equal(await readSubagentState(tail([agentPrompt(), odd])), "working");
  });

  it("a null, missing or pause_turn stop_reason is working", async () => {
    for (const stopReason of [null, undefined, "pause_turn", "tool_use"]) {
      const file = tail([agentPrompt(), agentAsst({ stopReason })]);
      assert.equal(await readSubagentState(file), "working", String(stopReason));
    }
  });

  it("api-request bookkeeping after a tool_result is working", async () => {
    const lines = [
      ...workingSubagent(REPO, ts(0)),
      rec("api-request", { id: "req_9" }),
      rec("api-request-blob", { blob: "x" }),
    ];
    assert.equal(await readSubagentState(tail(lines)), "working");
    assert.equal(await readSubagentState(tail([...workingSubagent(REPO, ts(0)), ...BOOKKEEPING])), "working");
  });

  it("a later working record wins over an earlier handback (the harness resumed the subagent)", async () => {
    const lines = [...finishedSubagent(REPO, ts(0)), agentAsst({ tools: ["Bash"] }), agentResult()];
    assert.equal(await readSubagentState(tail(lines)), "working");
  });
});

describe("readSubagentState: reading the file", () => {
  it("does not require the isSidechain flag, and counts sidechain records (unlike readTailState)", async () => {
    const plain = rec("assistant", {
      ...base(REPO, ts(2)),
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }],
        stop_reason: "tool_use",
      },
    });
    assert.equal(await readSubagentState(tail([plain])), "working");
    const lines = workingSubagent(REPO, ts(0));
    assert.ok(lines.every((line) => line.includes('"isSidechain":true')));
    assert.equal(await readSubagentState(tail(lines)), "working");
    assert.equal(await readTailState(tail(lines)), "unknown", "readTailState still skips sidechain records");
  });

  it("skips unparseable lines and records of other types", async () => {
    const half = `{"type":"assistant","message":{"role":"assis`;
    assert.equal(await readSubagentState(tail([...finishedSubagent(REPO, ts(0)), half], false)), "finished");
    assert.equal(
      await readSubagentState(tail([...workingSubagent(REPO, ts(0)), "not json", "", "   ", half], false)),
      "working",
    );
    const noise = [
      "123",
      "null",
      "[1,2]",
      '"text"',
      rec("progress", { data: 1 }),
      rec("system", { subtype: "turn_duration" }),
    ];
    assert.equal(await readSubagentState(tail([agentAsst({ tools: ["Bash"] }), ...noise])), "working");
  });

  it("a tool_use with a non-string name, or malformed content, does not throw", async () => {
    const weird = rec("assistant", {
      ...base(REPO, ts(2)),
      message: {
        role: "assistant",
        content: [null, 7, { type: "tool_use" }, { type: "tool_use", name: 3 }],
        stop_reason: "end_turn",
      },
    });
    assert.equal(await readSubagentState(tail([weird])), "working", "a nameless tool_use is still a tool call");
    for (const content of ["just text", null, {}, []]) {
      const r = rec("assistant", { message: { role: "assistant", content, stop_reason: "end_turn" } });
      assert.equal(await readSubagentState(tail([r])), "finished", JSON.stringify(content));
    }
    assert.equal(await readSubagentState(tail([rec("assistant")])), "working", "no message: no stop_reason: working");
    assert.equal(await readSubagentState(tail([rec("assistant", { message: "nope" })])), "working");
  });

  it("empty and whitespace-only files are unknown", async () => {
    assert.equal(await readSubagentState(tail([], false)), "unknown");
    assert.equal(await readSubagentState(tail(["", "  ", ""])), "unknown");
  });

  it("a missing file, a directory and a file with no assistant record are unknown", async () => {
    assert.equal(await readSubagentState(path.join(env.root, "nope.jsonl")), "unknown");
    assert.equal(await readSubagentState(env.root), "unknown");
    assert.equal(await readSubagentState(tail([agentPrompt(), agentResult()])), "unknown");
    assert.equal(await readSubagentState(tail(BOOKKEEPING)), "unknown");
    assert.equal(await readSubagentState(tail(["{", "}}", "nope"])), "unknown");
  });

  it("keeps the first line when the read starts at offset 0 (also without a trailing newline)", async () => {
    assert.equal(await readSubagentState(tail([agentAsst({ tools: ["SubagentHandback"] })], false)), "finished");
    assert.equal(await readSubagentState(tail([agentAsst({ tools: ["Bash"] })], false)), "working");
  });

  it("grows the window when the deciding record sits before more than 64 KB of bookkeeping", async () => {
    const finished = tail([...finishedSubagent(REPO, ts(0)), ...bookkeepingBytes(200 * 1024)]);
    assert.ok(fs.statSync(finished).size > 200 * 1024);
    assert.equal(await readSubagentState(finished), "finished");
    const working = tail([...workingSubagent(REPO, ts(0)), ...bookkeepingBytes(200 * 1024)]);
    assert.equal(await readSubagentState(working), "working");
  });

  it("keeps growing for a deciding record deeper than 1 MB", async () => {
    const file = tail([...workingSubagent(REPO, ts(0)), ...bookkeepingBytes(1.5 * 1024 * 1024)]);
    assert.equal(await readSubagentState(file), "working");
  });

  it("handles a deciding record larger than the first window", async () => {
    const huge = agentAsst({ tools: ["Bash"], extra: { padding: "p".repeat(150 * 1024) } });
    assert.equal(await readSubagentState(tail([agentPrompt(), huge])), "working");
    const hugeHandback = agentAsst({ tools: ["SubagentHandback"], extra: { padding: "p".repeat(150 * 1024) } });
    assert.equal(await readSubagentState(tail([agentPrompt(), hugeHandback, agentResult()])), "finished");
  });

  it("gives up after 4 MB without an assistant record", async () => {
    const file = tail([...workingSubagent(REPO, ts(0)), ...bookkeepingBytes(4.5 * 1024 * 1024)]);
    assert.equal(await readSubagentState(file), "unknown");
  });

  it("does not read past the window for a decisive tail", async () => {
    const history = bookkeepingBytes(6 * 1024 * 1024);
    assert.equal(await readSubagentState(tail([...history, ...finishedSubagent(REPO, ts(0))])), "finished");
  });
});

// -------------------------------------------------------------------------------------------------
// loadSessions integration
// -------------------------------------------------------------------------------------------------

const RUNNING_TAIL = [userPrompt(REPO, NOW - 30 * MINUTE, "do the thing"), asst("tool_use")];
const IDLE_TAIL = [
  userPrompt(REPO, NOW - 30 * MINUTE, "do the thing"),
  assistant(REPO, NOW - 29 * MINUTE),
  asst("end_turn"),
  sys("stop_hook_summary"),
  ...BOOKKEEPING,
];

const desk = (id: string, cliSessionId: string | undefined, over: Record<string, unknown> = {}) => ({
  sessionId: id,
  ...(cliSessionId ? { cliSessionId } : {}),
  cwd: REPO,
  originCwd: REPO,
  title: `Title ${id}`,
  createdAt: NOW - 3 * HOUR,
  lastActivityAt: NOW - HOUR,
  isArchived: false,
  completedTurns: 3,
  ...over,
});

const liveLister = (...ids: string[]) => {
  const state = { calls: 0 };
  setProcessLister(async () => {
    state.calls++;
    return ids.map((id) => `${DESKTOP_BIN} --output-format stream-json --resume=${id}`).join("\n");
  });
  return state;
};

const load = (over: Partial<Parameters<typeof loadSessions>[0]> = {}) =>
  loadSessions({
    days: 3,
    claudeDir: env.claudeDir,
    desktopDir: env.desktopDir,
    cacheFile: null,
    stateFile: null,
    now: NOW,
    ...over,
  });

const runningOf = async (id: string, over: Partial<Parameters<typeof loadSessions>[0]> = {}) =>
  (await load(over)).find((s) => s.id === id)?.isRunning;

describe("loadSessions: isRunning", () => {
  it("live process + unfinished tail: running", async () => {
    writeDesktopSession(env, desk("local_a", UUID_A));
    writeTranscript(env, REPO, UUID_A, RUNNING_TAIL, { mtimeMs: NOW - 5 * MINUTE });
    liveLister(UUID_A);
    assert.equal(await runningOf("local_a"), true);
  });

  it("live process + finished tail: not running", async () => {
    writeDesktopSession(env, desk("local_a", UUID_A));
    writeTranscript(env, REPO, UUID_A, IDLE_TAIL, { mtimeMs: NOW - 5 * MINUTE });
    liveLister(UUID_A);
    assert.equal(await runningOf("local_a"), false);
  });

  it("no process but a transcript written seconds ago with an unfinished tail: running", async () => {
    writeDesktopSession(env, desk("local_a", UUID_A));
    writeTranscript(env, REPO, UUID_A, RUNNING_TAIL, { mtimeMs: NOW - 30_000 });
    liveLister(); // no id matched (e.g. a fresh session whose argv carries none)
    assert.equal(await runningOf("local_a"), true);
  });

  it("no process and a transcript 10 minutes old: not running", async () => {
    writeDesktopSession(env, desk("local_a", UUID_A));
    writeTranscript(env, REPO, UUID_A, RUNNING_TAIL, { mtimeMs: NOW - 10 * MINUTE });
    liveLister(UUID_B);
    assert.equal(await runningOf("local_a"), false);
  });

  it("live process but a transcript 2 hours old: not running (a stuck or abandoned turn)", async () => {
    writeDesktopSession(env, desk("local_a", UUID_A));
    writeTranscript(env, REPO, UUID_A, RUNNING_TAIL, { mtimeMs: NOW - 2 * HOUR });
    liveLister(UUID_A);
    assert.equal(await runningOf("local_a"), false);
  });

  it("the live window is 60 minutes, the fresh window 2 minutes", async () => {
    writeDesktopSession(env, desk("local_a", UUID_A));
    const file = writeTranscript(env, REPO, UUID_A, RUNNING_TAIL, { mtimeMs: NOW - 59 * MINUTE });
    liveLister(UUID_A);
    assert.equal(await runningOf("local_a"), true);
    setMtime(file, NOW - 61 * MINUTE);
    assert.equal(await runningOf("local_a"), false);
    liveLister();
    setMtime(file, NOW - 110_000);
    assert.equal(await runningOf("local_a"), true);
    setMtime(file, NOW - 130_000);
    assert.equal(await runningOf("local_a"), false);
  });

  it("matches ids case-insensitively", async () => {
    writeDesktopSession(env, desk("local_a", UUID_A));
    writeTranscript(env, REPO, UUID_A, RUNNING_TAIL, { mtimeMs: NOW - 5 * MINUTE });
    const mixed = "ABCDEF12-3456-4789-abcd-EF0123456789";
    writeDesktopSession(env, desk("local_b", mixed.toLowerCase()));
    writeTranscript(env, REPO, mixed.toLowerCase(), RUNNING_TAIL, { mtimeMs: NOW - 5 * MINUTE });
    setProcessLister(async () => `claude --resume ${UUID_A.toUpperCase()}\nclaude -r ${mixed}`);
    assert.equal(await runningOf("local_a"), true);
    assert.equal(await runningOf("local_b"), true);
  });

  it("sets the flag per session, including CLI-only sessions and sessions without a transcript", async () => {
    const cliDir = "/Users/test/Projects/cli-only";
    writeDesktopSession(env, desk("local_run", UUID_A));
    writeDesktopSession(env, desk("local_idle", UUID_B));
    writeDesktopSession(env, desk("local_nocli", undefined));
    writeDesktopSession(env, desk("local_notranscript", UUID_D));
    writeTranscript(env, REPO, UUID_A, RUNNING_TAIL, { mtimeMs: NOW - 5 * MINUTE });
    writeTranscript(env, REPO, UUID_B, IDLE_TAIL, { mtimeMs: NOW - 5 * MINUTE });
    writeTranscript(
      env,
      cliDir,
      UUID_C,
      [userPrompt(cliDir, NOW - 20 * MINUTE, "terminal work"), asst("tool_use", { cwd: cliDir })],
      { mtimeMs: NOW - 4 * MINUTE },
    );
    liveLister(UUID_A, UUID_B, UUID_C, UUID_D);
    const byId = new Map((await load()).map((s) => [s.id, s.isRunning]));
    assert.equal(byId.get("local_run"), true);
    assert.equal(byId.get("local_idle"), false);
    assert.equal(byId.get("local_nocli"), false);
    assert.equal(byId.get("local_notranscript"), false);
    assert.equal(byId.get(UUID_C), true);
    assert.equal(byId.size, 5);
    for (const [id, value] of byId) assert.equal(typeof value, "boolean", id);
  });

  it("detectRunning: false leaves the flag undefined and never lists processes", async () => {
    writeDesktopSession(env, desk("local_a", UUID_A));
    writeTranscript(env, REPO, UUID_A, RUNNING_TAIL, { mtimeMs: NOW - 30_000 });
    const lister = liveLister(UUID_A);
    const sessions = await load({ detectRunning: false });
    assert.equal(sessions.length, 1);
    assert.equal("isRunning" in sessions[0], false);
    assert.equal(lister.calls, 0);
    // the default is on
    assert.equal((await load())[0].isRunning, true);
    assert.equal(lister.calls, 1);
  });

  it("lists processes once per load, and not at all when no transcript is recent", async () => {
    writeDesktopSession(env, desk("local_a", UUID_A));
    writeDesktopSession(env, desk("local_b", UUID_B));
    const a = writeTranscript(env, REPO, UUID_A, RUNNING_TAIL, { mtimeMs: NOW - 5 * MINUTE });
    const b = writeTranscript(env, REPO, UUID_B, RUNNING_TAIL, { mtimeMs: NOW - 6 * MINUTE });
    const lister = liveLister(UUID_A);
    await load();
    assert.equal(lister.calls, 1);

    setMtime(a, NOW - 3 * HOUR);
    setMtime(b, NOW - 3 * HOUR);
    const sessions = await load();
    assert.equal(lister.calls, 1, "no process can matter: ps is skipped");
    assert.deepEqual(
      sessions.map((s) => s.isRunning),
      [false, false],
    );
  });

  it("never writes the flag into the cache file", async () => {
    writeDesktopSession(env, desk("local_a", UUID_A));
    const cliDir = "/Users/test/Projects/cli-only";
    const file = writeTranscript(env, REPO, UUID_A, RUNNING_TAIL, { mtimeMs: NOW - 5 * MINUTE });
    writeTranscript(
      env,
      cliDir,
      UUID_C,
      [userPrompt(cliDir, NOW - 20 * MINUTE, "terminal work"), asst("tool_use", { cwd: cliDir })],
      {
        mtimeMs: NOW - 4 * MINUTE,
      },
    );
    liveLister(UUID_A, UUID_C);
    const first = await load({ cacheFile: env.cacheFile });
    assert.deepEqual(first.map((s) => s.isRunning).sort(), [true, true]);
    assert.ok(fs.existsSync(env.cacheFile));
    assert.ok(!fs.readFileSync(env.cacheFile, "utf8").includes("isRunning"), "cache holds no isRunning");

    // A warm run must not replay the flag: the turn finished and the process is gone.
    fs.writeFileSync(file, IDLE_TAIL.join("\n") + "\n");
    setMtime(file, NOW - 5 * MINUTE);
    liveLister();
    const second = await load({ cacheFile: env.cacheFile });
    assert.equal(second.find((s) => s.id === "local_a")?.isRunning, false);
    assert.equal(second.find((s) => s.id === UUID_C)?.isRunning, false, "a cached CLI session is re-evaluated too");
    assert.ok(!fs.readFileSync(env.cacheFile, "utf8").includes("isRunning"));
  });

  it("a transcript that cannot be statted (dangling symlink) is just not running", async () => {
    writeDesktopSession(env, desk("local_a", UUID_A));
    const dir = path.join(env.claudeDir, "projects", encodeCwd(REPO));
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(env.root, "nowhere.jsonl"), path.join(dir, `${UUID_A}.jsonl`));
    liveLister(UUID_A);
    const sessions = await load();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].isRunning, false);
  });

  it("a transcript that vanishes before its tail is read is just not running", async () => {
    writeDesktopSession(env, desk("local_a", UUID_A));
    const file = writeTranscript(env, REPO, UUID_A, RUNNING_TAIL, { mtimeMs: NOW - 30_000 });
    setProcessLister(async () => {
      fs.rmSync(file);
      return "";
    });
    assert.equal(await runningOf("local_a"), false);
  });

  it("returns every session even when the lister fails", async () => {
    writeDesktopSession(env, desk("local_a", UUID_A));
    writeTranscript(env, REPO, UUID_A, RUNNING_TAIL, { mtimeMs: NOW - 5 * MINUTE });
    setProcessLister(async () => {
      throw new Error("no ps");
    });
    const sessions = await load();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].isRunning, false);
  });
});

// -------------------------------------------------------------------------------------------------
// loadSessions: background subagents
// -------------------------------------------------------------------------------------------------

describe("loadSessions: running subagents", () => {
  /** The session's main turn is over (IDLE_TAIL, written 5 minutes ago) and its process is alive or not. */
  function idleSession(mainMtime = NOW - 5 * MINUTE): string {
    writeDesktopSession(env, desk("local_a", UUID_A));
    return writeTranscript(env, REPO, UUID_A, IDLE_TAIL, { mtimeMs: mainMtime });
  }
  const workingAgent = (id: string, ageMs: number, opts: { meta?: boolean } = {}) =>
    writeSubagent(env, REPO, UUID_A, id, workingSubagent(REPO, NOW - 20 * MINUTE), { mtimeMs: NOW - ageMs, ...opts });
  const finishedAgent = (id: string, ageMs: number) =>
    writeSubagent(env, REPO, UUID_A, id, finishedSubagent(REPO, NOW - 20 * MINUTE), { mtimeMs: NOW - ageMs });
  const first = async (over: Partial<Parameters<typeof loadSessions>[0]> = {}) => (await load(over))[0];

  it("main turn over, process alive, a working agent written 3 minutes ago: running with 1 subagent", async () => {
    idleSession();
    workingAgent("w1", 3 * MINUTE);
    liveLister(UUID_A);
    const s = await first();
    assert.equal(s.isRunning, true);
    assert.equal(s.activeSubagents, 1);
  });

  it("the same with a finished agent: not running, and activeSubagents stays absent", async () => {
    idleSession();
    finishedAgent("f1", 3 * MINUTE);
    liveLister(UUID_A);
    const s = await first();
    assert.equal(s.isRunning, false);
    assert.equal("activeSubagents" in s, false);
  });

  it("a working-looking agent last written 30 minutes ago is not running (killed, or long gone)", async () => {
    idleSession();
    workingAgent("w1", 30 * MINUTE);
    liveLister(UUID_A);
    const s = await first();
    assert.equal(s.isRunning, false);
    assert.equal("activeSubagents" in s, false);
  });

  it("without a live process, a working-looking agent written 5 minutes ago is not running", async () => {
    idleSession();
    workingAgent("w1", 5 * MINUTE);
    liveLister(UUID_B); // some other session's process
    const s = await first();
    assert.equal(s.isRunning, false);
    assert.equal("activeSubagents" in s, false);
  });

  it("without a live process, the same agent written 1 minute ago is running", async () => {
    idleSession();
    workingAgent("w1", MINUTE);
    liveLister();
    const s = await first();
    assert.equal(s.isRunning, true);
    assert.equal(s.activeSubagents, 1);
  });

  it("the agent windows are 10 minutes with a live process and 2 minutes without", async () => {
    idleSession();
    const file = workingAgent("w1", 9 * MINUTE);
    liveLister(UUID_A);
    assert.equal((await first()).activeSubagents, 1);
    setMtime(file, NOW - 11 * MINUTE);
    assert.equal((await first()).isRunning, false);
    liveLister();
    setMtime(file, NOW - 110_000);
    assert.equal((await first()).activeSubagents, 1);
    setMtime(file, NOW - 130_000);
    assert.equal((await first()).isRunning, false);
  });

  it("counts every working agent: two working, one finished, one stale, one unreadable", async () => {
    idleSession();
    workingAgent("w1", 2 * MINUTE);
    workingAgent("w2", 4 * MINUTE);
    finishedAgent("f1", MINUTE);
    workingAgent("old", 25 * MINUTE);
    writeSubagent(env, REPO, UUID_A, "empty", [], { mtimeMs: NOW - MINUTE });
    liveLister(UUID_A);
    const s = await first();
    assert.equal(s.isRunning, true);
    assert.equal(s.activeSubagents, 2);
  });

  it("no subagents folder: unchanged behaviour, with the field absent", async () => {
    idleSession();
    liveLister(UUID_A);
    const idle = await first();
    assert.equal(idle.isRunning, false);
    assert.equal("activeSubagents" in idle, false);

    writeTranscript(env, REPO, UUID_A, RUNNING_TAIL, { mtimeMs: NOW - 5 * MINUTE });
    const mainOnly = await first();
    assert.equal(mainOnly.isRunning, true);
    assert.equal("activeSubagents" in mainOnly, false, "a main turn alone never sets the count");
  });

  it("a running main turn and working agents: running, and the count only covers the agents", async () => {
    idleSession();
    writeTranscript(env, REPO, UUID_A, RUNNING_TAIL, { mtimeMs: NOW - 5 * MINUTE });
    workingAgent("w1", MINUTE);
    workingAgent("w2", 2 * MINUTE);
    liveLister(UUID_A);
    const s = await first();
    assert.equal(s.isRunning, true);
    assert.equal(s.activeSubagents, 2);
  });

  it("an empty subagents folder, and only the agent-*.jsonl files, count", async () => {
    idleSession();
    const dir = path.join(env.claudeDir, "projects", encodeCwd(REPO), UUID_A, "subagents");
    fs.mkdirSync(dir, { recursive: true });
    liveLister(UUID_A);
    assert.equal((await first()).isRunning, false);

    const working = workingSubagent(REPO, NOW - 20 * MINUTE).join("\n") + "\n";
    for (const name of [
      "agent-x.meta.json",
      "agent-x.prefix.json",
      "notes.jsonl",
      "agent-y.jsonl.bak",
      "agent-z.txt",
    ]) {
      fs.writeFileSync(path.join(dir, name), working);
      setMtime(path.join(dir, name), NOW - MINUTE);
    }
    fs.mkdirSync(path.join(dir, "agent-dir.jsonl")); // a directory that happens to match the name
    const s = await first();
    assert.equal(s.isRunning, false);
    assert.equal("activeSubagents" in s, false);

    workingAgent("w1", MINUTE); // and a real one next to them is the only one counted
    assert.equal((await first()).activeSubagents, 1);
  });

  it("a fresh subagent file alone makes `ps` run, and decides with its process", async () => {
    idleSession(NOW - 3 * HOUR); // the parent has been quiet for hours...
    workingAgent("w1", 3 * MINUTE); // ...while a background agent kept writing
    const lister = liveLister(UUID_A);
    const s = await first();
    assert.equal(lister.calls, 1);
    assert.equal(s.isRunning, true);
    assert.equal(s.activeSubagents, 1);
  });

  it("a quiet parent and a fresh agent without a live process: ps runs, but only the 2 minute window applies", async () => {
    idleSession(NOW - 3 * HOUR);
    const file = workingAgent("w1", 5 * MINUTE);
    const lister = liveLister();
    assert.equal((await first()).isRunning, false);
    assert.equal(lister.calls, 1);
    setMtime(file, NOW - MINUTE);
    assert.equal((await first()).activeSubagents, 1);
  });

  it("ps stays skipped when neither the transcript nor any agent file is recent", async () => {
    idleSession(NOW - 3 * HOUR);
    workingAgent("w1", 11 * MINUTE);
    workingAgent("w2", 5 * HOUR);
    const lister = liveLister(UUID_A);
    const s = await first();
    assert.equal(lister.calls, 0);
    assert.equal(s.isRunning, false);
    assert.equal("activeSubagents" in s, false);
  });

  it("a live parent with an old transcript still counts its agents (the live window is the process's, not the file's)", async () => {
    idleSession(NOW - 2 * HOUR);
    workingAgent("w1", 8 * MINUTE);
    liveLister(UUID_A);
    const s = await first();
    assert.equal(s.isRunning, true);
    assert.equal(s.activeSubagents, 1);
  });

  it("finds subagents next to the transcript, wherever its project folder is", async () => {
    writeDesktopSession(env, desk("local_a", UUID_A));
    writeTranscript(env, REPO, UUID_A, IDLE_TAIL, { mtimeMs: NOW - 5 * MINUTE, dirName: "-custom-dir" });
    writeSubagent(env, REPO, UUID_A, "w1", workingSubagent(REPO, NOW - 20 * MINUTE), {
      mtimeMs: NOW - MINUTE,
      dirName: "-custom-dir",
    });
    liveLister(UUID_A);
    assert.equal((await first()).activeSubagents, 1);
  });

  it("covers CLI-only sessions, and never mixes up sessions that share a project folder", async () => {
    writeDesktopSession(env, desk("local_a", UUID_A));
    writeTranscript(env, REPO, UUID_A, IDLE_TAIL, { mtimeMs: NOW - 5 * MINUTE });
    writeTranscript(
      env,
      REPO,
      UUID_C,
      [userPrompt(REPO, NOW - 20 * MINUTE, "terminal work"), assistant(REPO, NOW - 19 * MINUTE)],
      {
        mtimeMs: NOW - 5 * MINUTE,
      },
    );
    writeSubagent(env, REPO, UUID_C, "w1", workingSubagent(REPO, NOW - 20 * MINUTE), { mtimeMs: NOW - MINUTE });
    liveLister(UUID_A, UUID_C);
    const byId = new Map((await load()).map((s) => [s.id, s]));
    assert.equal(byId.get(UUID_C)?.source, "cli");
    assert.equal(byId.get(UUID_C)?.isRunning, true);
    assert.equal(byId.get(UUID_C)?.activeSubagents, 1);
    assert.equal(byId.get("local_a")?.isRunning, false);
    assert.equal("activeSubagents" in (byId.get("local_a") ?? {}), false);
  });

  it("an agent file that vanishes before its tail is read is just not counted", async () => {
    idleSession();
    const file = workingAgent("w1", MINUTE);
    setProcessLister(async () => {
      fs.rmSync(file);
      return `claude --resume ${UUID_A}`;
    });
    const s = await first();
    assert.equal(s.isRunning, false);
    assert.equal("activeSubagents" in s, false);
  });

  it("a failing lister still reports fresh agents (the 2 minute window needs no process)", async () => {
    idleSession();
    workingAgent("w1", MINUTE);
    workingAgent("w2", 5 * MINUTE);
    setProcessLister(async () => {
      throw new Error("no ps");
    });
    const s = await first();
    assert.equal(s.isRunning, true);
    assert.equal(s.activeSubagents, 1);
  });

  it("detectRunning: false never looks at subagents", async () => {
    idleSession();
    workingAgent("w1", MINUTE);
    const lister = liveLister(UUID_A);
    const s = await first({ detectRunning: false });
    assert.equal("isRunning" in s, false);
    assert.equal("activeSubagents" in s, false);
    assert.equal(lister.calls, 0);
  });

  it("activeSubagents never reaches the cache file, and a warm run re-evaluates it", async () => {
    const main = idleSession();
    const agent = workingAgent("w1", MINUTE);
    liveLister(UUID_A);
    const cold = await first({ cacheFile: env.cacheFile });
    assert.equal(cold.activeSubagents, 1);
    assert.ok(fs.existsSync(env.cacheFile));
    assert.ok(!fs.readFileSync(env.cacheFile, "utf8").includes("activeSubagents"));

    // the agent reports back: the warm run must not replay the count
    writeSubagent(env, REPO, UUID_A, "w1", finishedSubagent(REPO, NOW - 20 * MINUTE), { mtimeMs: NOW - MINUTE });
    assert.equal(agent, path.join(path.dirname(main), UUID_A, "subagents", "agent-w1.jsonl"));
    const warm = await first({ cacheFile: env.cacheFile });
    assert.equal(warm.isRunning, false);
    assert.equal("activeSubagents" in warm, false);
    assert.ok(!fs.readFileSync(env.cacheFile, "utf8").includes("activeSubagents"));
    assert.ok(!fs.readFileSync(env.cacheFile, "utf8").includes("isRunning"));
  });

  it("a running session with working subagents never shows markedDone; the mark applies once they are done", async () => {
    idleSession();
    const agent = workingAgent("w1", MINUTE);
    liveLister(UUID_A);
    await markDone({ id: "local_a", lastActivity: NOW - HOUR }, env.stateFile);

    const running = await first({ stateFile: env.stateFile });
    assert.equal(running.isRunning, true);
    assert.equal(running.activeSubagents, 1);
    assert.equal("markedDone" in running, false);
    assert.equal(running.status, "unknown", "the app's own status, not completed");

    setMtime(agent, NOW - 30 * MINUTE); // stale: the agent is gone
    const idle = await first({ stateFile: env.stateFile });
    assert.equal(idle.isRunning, false);
    assert.equal(idle.markedDone, true);
    assert.equal(idle.status, "completed");
  });
});
