import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseArgs, runCli, type CliIO } from "../src/cli-app";
import { setCommandRunner } from "../src/core/handoff";
import { setProcessLister } from "../src/core/live";
import type { SessionInfo } from "../src/core/types";
import {
  HOUR,
  NOW,
  UUID_A,
  UUID_B,
  assistant,
  base,
  finishedSubagent,
  finishedTurn,
  makeEnv,
  rec,
  userPrompt,
  workingSubagent,
  writeDesktopSession,
  writeSubagent,
  writeTranscript,
  type TestEnv,
} from "./fixtures";

const HOME_REPOS = path.join(os.homedir(), "ccsl-test-repos");
const ALPHA = path.join(HOME_REPOS, "alpha");
const BETA = path.join(HOME_REPOS, "beta");
const GAMMA = path.join(HOME_REPOS, "gamma");

const ID_FIX = "local_aaaa1111-0000-4000-8000-000000000001";
const ID_BLOCKED = "local_aaaa2222-0000-4000-8000-000000000002";
const ID_BETA = "local_bbbb3333-0000-4000-8000-000000000003";

let env: TestEnv;
let calls: { file: string; args: string[] }[];
let psCalls: number;

/** Pretends these CLI session ids belong to live claude processes. Counts every `ps` call. */
function liveSessions(...ids: string[]): void {
  setProcessLister(async () => {
    psCalls++;
    return ids.map((id) => `/usr/local/bin/claude --output-format stream-json --resume=${id}`).join("\n");
  });
}

beforeEach(() => {
  env = makeEnv();
  calls = [];
  psCalls = 0;
  setCommandRunner(async (file, args) => void calls.push({ file, args }));
  liveSessions(); // the real `ps` never runs in tests

  writeDesktopSession(env, {
    sessionId: ID_FIX,
    cliSessionId: UUID_A,
    cwd: ALPHA,
    originCwd: ALPHA,
    title: "Fix login bug",
    lastActivityAt: NOW - HOUR,
    completedTurns: 5,
    postTurnSummary: { status_category: "completed", status_detail: "fixed", needs_action: "" },
    prs: [{ prNumber: 12, repo: "o/alpha", url: "https://github.com/o/alpha/pull/12", state: "OPEN" }],
  });
  writeDesktopSession(env, {
    sessionId: ID_BLOCKED,
    cliSessionId: "99999999-9999-4999-8999-999999999999",
    cwd: `${ALPHA}/.claude/worktrees/wt1`,
    originCwd: ALPHA,
    title: "Needs a decision",
    lastActivityAt: NOW - 3 * HOUR,
    completedTurns: 1,
    postTurnSummary: { status_category: "blocked", status_detail: "waiting", needs_action: "pick option A or B" },
  });
  writeDesktopSession(env, {
    sessionId: ID_BETA,
    cwd: BETA,
    originCwd: BETA,
    title: "Beta work",
    lastActivityAt: NOW - 2 * HOUR,
    completedTurns: 2,
    postTurnSummary: { status_category: "review_ready" },
  }); // no cliSessionId: cannot be resumed in a terminal
  writeTranscript(env, GAMMA, UUID_B, [
    userPrompt(GAMMA, NOW - 6 * HOUR, "CLI only task"),
    assistant(GAMMA, NOW - 5 * HOUR),
  ]);
});

afterEach(() => {
  setCommandRunner(null);
  setProcessLister(null);
  env.cleanup();
});

async function cli(args: string[], io: Partial<CliIO> = {}) {
  let out = "";
  let err = "";
  const flags = [
    "--claude-dir",
    env.claudeDir,
    "--desktop-dir",
    env.desktopDir,
    "--state-file",
    env.stateFile,
    "--no-cache",
  ];
  const code = await runCli([...flags, ...args], {
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    isTTY: false,
    env: {},
    columns: 100,
    now: () => NOW,
    ...io,
  });
  return { code, out, err };
}

/** Order the list shows sessions in: alpha (newest 1h), beta (2h), gamma (5h). */
const DISPLAY_ORDER = [ID_FIX, ID_BLOCKED, ID_BETA, UUID_B];

describe("parseArgs", () => {
  it("defaults to listing 3 days", () => {
    const p = parseArgs([]);
    assert.equal(p.command, "list");
    assert.equal(p.days, 3);
    assert.equal(p.json, false);
  });

  it("parses options with = or a separate value", () => {
    const p = parseArgs(["--days=7", "--archived", "--exclude", "~/a, ~/b", "--exclude=/c", "--json"]);
    assert.equal(p.days, 7);
    assert.equal(p.archived, true);
    assert.deepEqual(p.exclude, ["~/a", "~/b", "/c"]);
    assert.equal(p.json, true);
  });

  it("--no-running is a hidden flag without a value", () => {
    assert.equal(parseArgs([]).noRunning, false);
    assert.equal(parseArgs(["--no-running"]).noRunning, true);
    assert.equal(parseArgs(["--no-running", "--json"]).noRunning, true);
    assert.throws(() => parseArgs(["--no-running=1"]), /does not take a value/);
  });

  it("--all means no limit; --days 0 too", () => {
    assert.equal(parseArgs(["--all"]).days, 0);
    assert.equal(parseArgs(["--days", "0"]).days, 0);
  });

  it("parses subcommands and their options", () => {
    assert.deepEqual(parseArgs(["open", "3"]).args, ["3"]);
    assert.equal(parseArgs(["resume", "3", "--terminal", "ghostty"]).terminal, "Ghostty");
    assert.equal(parseArgs(["resume", "3", "--terminal", "iterm"]).terminal, "iTerm");
    assert.equal(parseArgs(["resume", "3", "--terminal=Terminal"]).terminal, "Terminal");
    assert.equal(parseArgs(["new", "/tmp", "--prompt", "hello there"]).prompt, "hello there");
    assert.equal(parseArgs(["--days", "5", "url", "2"]).command, "url");
    assert.deepEqual(parseArgs(["new", "--", "-weird-folder"]).args, ["-weird-folder"]);
  });

  it("parses done and undone, and the hidden --state-file", () => {
    assert.equal(parseArgs(["done", "3"]).command, "done");
    assert.deepEqual(parseArgs(["undone", "local_abc"]).args, ["local_abc"]);
    assert.equal(parseArgs([]).stateFile, undefined);
    assert.equal(parseArgs(["--state-file", "/x/state.json", "done", "1"]).stateFile, "/x/state.json");
    assert.equal(parseArgs(["done", "1", "--state-file=/y.json"]).stateFile, "/y.json");
    assert.throws(() => parseArgs(["--state-file"]), /needs a value/);
    assert.throws(() => parseArgs(["done"]), /`ccsl done` needs exactly one <n\|id>/);
    assert.throws(() => parseArgs(["undone", "1", "2"]), /`ccsl undone` needs exactly one <n\|id>/);
    assert.throws(() => parseArgs(["done", "1", "--terminal", "Ghostty"]), /only applies to `ccsl resume`/);
    assert.throws(() => parseArgs(["done", "1", "--prompt", "x"]), /only applies to `ccsl new`/);
  });

  it("rejects bad input with usage errors", () => {
    assert.throws(() => parseArgs(["--days", "abc"]), /--days needs/);
    assert.throws(() => parseArgs(["--days", "-2"]), /--days needs/);
    assert.throws(() => parseArgs(["--days"]), /needs a value/);
    assert.throws(() => parseArgs(["--all", "--days", "3"]), /either --all or --days/);
    assert.throws(() => parseArgs(["--bogus"]), /Unknown option/);
    assert.throws(() => parseArgs(["frobnicate"]), /Unknown command/);
    assert.throws(() => parseArgs(["open"]), /exactly one/);
    assert.throws(() => parseArgs(["open", "1", "2"]), /exactly one/);
    assert.throws(() => parseArgs(["resume", "1", "--terminal", "xterm"]), /Unknown terminal/);
    assert.throws(() => parseArgs(["--terminal", "Ghostty"]), /only applies to `ccsl resume`/);
    assert.throws(() => parseArgs(["open", "1", "--prompt", "x"]), /only applies to `ccsl new`/);
    assert.throws(() => parseArgs(["--json=yes"]), /does not take a value/);
  });
});

describe("ccsl list", () => {
  it("prints help", async () => {
    const r = await cli(["--help"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /ccsl open <n\|id>/);
    assert.match(r.out, /--terminal/);
  });

  it("help lists done and undone, and does not advertise --state-file", async () => {
    const r = await cli(["--help"]);
    assert.match(r.out, /^ {2}ccsl done <n\|id> +mark completed/m);
    assert.match(r.out, /^ {2}ccsl undone <n\|id> +remove that mark/m);
    assert.ok(!r.out.includes("--state-file"));
  });

  it("groups by repo with numbered rows (plain output)", async () => {
    const r = await cli([]);
    assert.equal(r.code, 0);
    assert.equal(r.err, "");
    assert.ok(!r.out.includes("\x1b["), "no ANSI when not a TTY");
    const lines = r.out.split("\n");
    assert.equal(lines[0], "alpha  ~/ccsl-test-repos/alpha");
    assert.match(lines[1], /^ {2}1 {2}Fix login bug +1h +5 turns +done +PR #12$/);
    assert.match(lines[2], /^ {2}2 {2}Needs a decision +3h +1 turn +needs input$/);
    assert.equal(lines[3], "");
    assert.equal(lines[4], "beta  ~/ccsl-test-repos/beta");
    assert.match(lines[5], /^ {2}3 {2}Beta work +2h +2 turns +review ready$/);
    assert.equal(lines[7], "gamma  ~/ccsl-test-repos/gamma");
    assert.match(lines[8], /^ {2}4 {2}CLI only task +5h +2 msgs *$/); // age = newest record
    assert.match(r.out, /4 sessions in 3 repos \(last 3 days\)/);
    for (const line of lines) assert.equal(line, line.trimEnd(), "no trailing whitespace");
  });

  it("aligns the columns", async () => {
    const r = await cli([]);
    const rows = r.out.split("\n").filter((l) => /^ {2}\d /.test(l));
    const ageCol = rows.map((l) => l.search(/ (1h|3h|2h|5h) /));
    assert.equal(new Set(ageCol).size, 1, "age column lines up");
  });

  it("uses colors only on a TTY without NO_COLOR, and highlights needs-input", async () => {
    const tty = await cli([], { isTTY: true, env: {} });
    assert.ok(tty.out.includes("\x1b["));
    assert.ok(tty.out.includes("\x1b[1;33mneeds input"), "needs input is highlighted");
    const noColor = await cli([], { isTTY: true, env: { NO_COLOR: "1" } });
    assert.ok(!noColor.out.includes("\x1b["));
    const piped = await cli([], { isTTY: false, env: {} });
    assert.ok(!piped.out.includes("\x1b["));
  });

  it("truncates titles to the terminal width", async () => {
    writeDesktopSession(env, {
      sessionId: "local_long-title",
      cliSessionId: "88888888-8888-4888-8888-888888888888",
      cwd: ALPHA,
      originCwd: ALPHA,
      title: "An extremely long session title that goes on and on and on, well past any reasonable terminal width",
      lastActivityAt: NOW - 30 * 60 * 1000,
      completedTurns: 12,
      postTurnSummary: { status_category: "completed" },
    });
    for (const columns of [60, 80, 100]) {
      const r = await cli([], { columns });
      const rows = r.out.split("\n").filter((l) => /^ {2}\d+ /.test(l));
      assert.ok(
        rows.some((l) => l.includes("…")),
        `truncated at ${columns}`,
      );
      for (const l of rows) assert.ok(l.length <= columns, `row fits ${columns} columns: ${l.length}`);
    }
    const wide = await cli([], { columns: 300 });
    assert.ok(wide.out.includes("past any reasonable terminal width"));
  });

  it("--json prints the SessionInfo[] in display order", async () => {
    const r = await cli(["--json"]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.out) as SessionInfo[];
    assert.deepEqual(
      parsed.map((s) => s.id),
      DISPLAY_ORDER,
    );
    assert.equal(parsed[3].source, "cli");
    assert.equal(parsed[1].status, "needs_input");
    assert.equal(parsed[1].repoRoot, ALPHA);
  });

  it("respects --days, --all, --archived and --exclude", async () => {
    assert.equal(JSON.parse((await cli(["--json", "--days", "0.1"])).out).length, 2);
    writeDesktopSession(env, {
      sessionId: "local_arch",
      cliSessionId: "77777777-7777-4777-8777-777777777777",
      cwd: ALPHA,
      originCwd: ALPHA,
      title: "Shelved work",
      lastActivityAt: NOW - HOUR,
      isArchived: true,
    });
    assert.equal(JSON.parse((await cli(["--json"])).out).length, 4);
    const withArchived = JSON.parse((await cli(["--json", "--archived"])).out) as SessionInfo[];
    assert.equal(withArchived.length, 5);
    const archivedRow = (await cli(["--archived"])).out.split("\n").find((l) => l.includes("Shelved work"));
    assert.ok(archivedRow?.endsWith(" archived"), "archived sessions are marked");
    const excluded = JSON.parse(
      (await cli(["--json", "--exclude", `${HOME_REPOS}/alpha,~/ccsl-test-repos/beta`])).out,
    ) as SessionInfo[];
    assert.deepEqual(
      excluded.map((s) => s.id),
      [UUID_B],
    );
    const all = await cli(["--all", "--json"]);
    assert.equal(JSON.parse(all.out).length, 4);
  });

  it("says so when there is nothing to list", async () => {
    const r = await cli(["--exclude", HOME_REPOS]);
    assert.equal(r.code, 0);
    assert.equal(r.out, "No sessions in the last 3 days.\n");
    assert.equal((await cli(["--exclude", HOME_REPOS, "--json"])).out, "[]\n");
  });
});

describe("ccsl list: running sessions", () => {
  /** A transcript for the "Fix login bug" session whose last turn is unfinished, written 30 s ago. */
  function startRunningTurn(): void {
    const toolUse = rec("assistant", {
      ...base(ALPHA, NOW - 60_000),
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
        stop_reason: "tool_use",
      },
    });
    writeTranscript(env, ALPHA, UUID_A, [userPrompt(ALPHA, NOW - 5 * 60_000, "go"), toolUse], {
      mtimeMs: NOW - 30_000,
    });
  }

  it("shows `running` instead of the stored status and counts them in the footer", async () => {
    startRunningTurn();
    liveSessions(UUID_A);
    const r = await cli([]);
    assert.equal(r.code, 0);
    const lines = r.out.split("\n");
    assert.match(lines[1], /^ {2}1 {2}Fix login bug +1h +5 turns +running +PR #12$/);
    assert.match(lines[2], /^ {2}2 {2}Needs a decision +3h +1 turn +needs input$/);
    assert.match(r.out, /4 sessions in 3 repos \(last 3 days\), 1 running\. ccsl open\|resume\|url <n>/);
    assert.equal(psCalls, 1);
    for (const line of lines) assert.equal(line, line.trimEnd(), "no trailing whitespace");
  });

  it("paints `running` cyan on a TTY", async () => {
    startRunningTurn();
    liveSessions(UUID_A);
    const tty = await cli([], { isTTY: true, env: {} });
    assert.ok(tty.out.includes("\x1b[36mrunning"));
    const plain = await cli([], { isTTY: true, env: { NO_COLOR: "1" } });
    assert.ok(!plain.out.includes("\x1b[") && plain.out.includes("running"));
  });

  it("says nothing about running when no turn is in progress", async () => {
    const r = await cli([]);
    assert.ok(!r.out.includes("running"), r.out);
    assert.match(r.out, /4 sessions in 3 repos \(last 3 days\)\. ccsl open\|resume\|url <n>/);
  });

  it("--json carries isRunning on every session", async () => {
    startRunningTurn();
    liveSessions(UUID_A);
    const parsed = JSON.parse((await cli(["--json"])).out) as SessionInfo[];
    assert.deepEqual(
      parsed.map((s) => [s.id, s.isRunning]),
      [
        [ID_FIX, true],
        [ID_BLOCKED, false],
        [ID_BETA, false],
        [UUID_B, false],
      ],
    );
  });

  it("--no-running skips the detection entirely", async () => {
    startRunningTurn();
    liveSessions(UUID_A);
    const r = await cli(["--no-running"]);
    assert.equal(psCalls, 0);
    assert.ok(!r.out.includes("running"));
    assert.match(r.out.split("\n")[1], /Fix login bug +1h +5 turns +done +PR #12$/);
    const parsed = JSON.parse((await cli(["--no-running", "--json"])).out) as SessionInfo[];
    assert.ok(parsed.every((s) => !("isRunning" in s)));
    assert.equal(psCalls, 0);
    assert.ok(!r.out.includes("--no-running"), "the flag is not advertised");
    assert.ok(!(await cli(["--help"])).out.includes("--no-running"));
  });

  describe("with background subagents", () => {
    const rowOf = (out: string, title: string) => out.split("\n").find((l) => l.includes(title)) ?? "";

    /** "Fix login bug": its main turn is over (written 5 minutes ago), `working` background agents are still busy. */
    function backgroundAgents(working: number, finished = 0): void {
      writeTranscript(env, ALPHA, UUID_A, finishedTurn(ALPHA, NOW - 9 * 60_000), { mtimeMs: NOW - 5 * 60_000 });
      for (let i = 0; i < working; i++) {
        writeSubagent(env, ALPHA, UUID_A, `w${i}`, workingSubagent(ALPHA, NOW - 6 * 60_000), { mtimeMs: NOW - 60_000 });
      }
      for (let i = 0; i < finished; i++) {
        writeSubagent(env, ALPHA, UUID_A, `f${i}`, finishedSubagent(ALPHA, NOW - 6 * 60_000), {
          mtimeMs: NOW - 60_000,
        });
      }
    }

    it("shows `running (2 agents)` and counts the session in the footer", async () => {
      backgroundAgents(2, 1);
      liveSessions(UUID_A);
      const r = await cli([]);
      const lines = r.out.split("\n");
      assert.match(lines[1], /^ {2}1 {2}Fix login bug +1h +5 turns +running \(2 agents\) +PR #12$/);
      assert.match(lines[2], /^ {2}2 {2}Needs a decision +3h +1 turn +needs input$/);
      assert.match(r.out, /4 sessions in 3 repos \(last 3 days\), 1 running\. ccsl open\|resume\|url <n>/);
      for (const line of lines) assert.equal(line, line.trimEnd(), "no trailing whitespace");
    });

    it("says `running (1 agent)` in the singular", async () => {
      backgroundAgents(1);
      liveSessions(UUID_A);
      assert.match(rowOf((await cli([])).out, "Fix login bug"), /turns +running \(1 agent\) +PR #12$/);
    });

    it("keeps plain `running` for a main turn alone, and adds the agents to a main turn that is still going", async () => {
      startRunningTurn();
      liveSessions(UUID_A);
      assert.match(rowOf((await cli([])).out, "Fix login bug"), /turns +running +PR #12$/);
      writeSubagent(env, ALPHA, UUID_A, "w0", workingSubagent(ALPHA, NOW - 6 * 60_000), { mtimeMs: NOW - 60_000 });
      assert.match(rowOf((await cli([])).out, "Fix login bug"), /turns +running \(1 agent\) +PR #12$/);
    });

    it("finished agents do not make a session running", async () => {
      backgroundAgents(0, 2);
      liveSessions(UUID_A);
      const r = await cli([]);
      assert.ok(!r.out.includes("running"), r.out);
      assert.match(rowOf(r.out, "Fix login bug"), /turns +done +PR #12$/);
    });

    it("lines the status column up, and paints the whole label cyan on a TTY", async () => {
      backgroundAgents(2);
      liveSessions(UUID_A);
      const lines = (await cli([])).out.split("\n");
      assert.equal(lines[1].indexOf("running"), lines[2].indexOf("needs input"));
      assert.equal(lines[1].indexOf("PR #12") - lines[1].indexOf("running"), "running (2 agents)".length + 2);
      const tty = await cli([], { isTTY: true, env: {} });
      assert.ok(tty.out.includes("\x1b[36mrunning (2 agents)\x1b[0m"));
    });

    it("--json carries activeSubagents on the running session only", async () => {
      backgroundAgents(2);
      liveSessions(UUID_A);
      const parsed = JSON.parse((await cli(["--json"])).out) as SessionInfo[];
      assert.deepEqual(
        parsed.map((s) => [s.id, s.isRunning, s.activeSubagents]),
        [
          [ID_FIX, true, 2],
          [ID_BLOCKED, false, undefined],
          [ID_BETA, false, undefined],
          [UUID_B, false, undefined],
        ],
      );
      assert.ok(parsed.slice(1).every((s) => !("activeSubagents" in s)));
    });

    it("a done-mark does not hide the running state, agents included", async () => {
      backgroundAgents(2);
      liveSessions(UUID_A);
      assert.equal((await cli(["done", "1"])).code, 0);
      assert.match(rowOf((await cli([])).out, "Fix login bug"), /turns +running \(2 agents\) +PR #12$/);
      const [fix] = JSON.parse((await cli(["--json"])).out) as SessionInfo[];
      assert.equal(fix.markedDone, undefined);
      assert.equal(fix.status, "completed", "the app's own status, as stored");
    });

    it("--no-running skips the agents too", async () => {
      backgroundAgents(2);
      liveSessions(UUID_A);
      const r = await cli(["--no-running"]);
      assert.equal(psCalls, 0);
      assert.ok(!r.out.includes("running") && !r.out.includes("agent"));
      const parsed = JSON.parse((await cli(["--no-running", "--json"])).out) as SessionInfo[];
      assert.ok(parsed.every((s) => !("activeSubagents" in s) && !("isRunning" in s)));
    });
  });

  it("open, resume, url and new never run ps", async () => {
    startRunningTurn();
    liveSessions(UUID_A);
    assert.equal((await cli(["url", "1"])).code, 0);
    assert.equal((await cli(["url", ID_FIX])).code, 0);
    assert.equal((await cli(["open", "2"])).code, 0);
    assert.equal((await cli(["resume", UUID_A.slice(0, 8)])).code, 0);
    assert.equal((await cli(["new", "3"])).code, 0);
    assert.equal(psCalls, 0);
  });
});

describe("ccsl done / undone", () => {
  const stateMarks = () => JSON.parse(fs.readFileSync(env.stateFile, "utf8")).marks as Record<string, unknown>;
  const rowOf = (out: string, title: string) => out.split("\n").find((l) => l.includes(title)) ?? "";

  it("done marks the session, and the list shows `done ✓` instead of the app's status", async () => {
    const r = await cli(["done", "2"]);
    assert.equal(r.code, 0);
    assert.equal(r.err, "");
    assert.equal(r.out, 'Marked "Needs a decision" completed. It comes back if the session has new activity.\n');

    const list = await cli([]);
    const lines = list.out.split("\n");
    assert.match(
      lines[1],
      /^ {2}1 {2}Fix login bug +1h +5 turns +done +PR #12$/,
      "a genuinely completed session stays `done`",
    );
    assert.match(lines[2], /^ {2}2 {2}Needs a decision +3h +1 turn +done ✓$/);
    assert.match(lines[5], /^ {2}3 {2}Beta work +2h +2 turns +review ready$/, "other sessions are untouched");
    assert.ok(!list.out.includes("needs input"));
    for (const line of lines) assert.equal(line, line.trimEnd(), "no trailing whitespace");
  });

  it("paints `done ✓` dim on a TTY", async () => {
    await cli(["done", "2"]);
    const tty = await cli([], { isTTY: true, env: {} });
    assert.ok(tty.out.includes("\x1b[2mdone ✓"));
    const plain = await cli([], { isTTY: true, env: { NO_COLOR: "1" } });
    assert.ok(!plain.out.includes("\x1b[") && plain.out.includes("done ✓"));
  });

  it("stores the session's lastActivity in the state file, and nothing else about it", async () => {
    await cli(["done", "2"]);
    const marks = stateMarks();
    assert.deepEqual(Object.keys(marks), [ID_BLOCKED]);
    const mark = marks[ID_BLOCKED] as { lastActivity: number; markedAt: number };
    assert.equal(mark.lastActivity, NOW - 3 * HOUR);
    assert.deepEqual(Object.keys(mark).sort(), ["lastActivity", "markedAt"]);
    const text = fs.readFileSync(env.stateFile, "utf8");
    assert.ok(!text.includes("Needs a decision") && !text.includes(ALPHA), "no titles or paths");
  });

  it("--json carries markedDone and status completed, keeping statusDetail and needsAction", async () => {
    await cli(["done", "2"]);
    const parsed = JSON.parse((await cli(["--json"])).out) as SessionInfo[];
    assert.deepEqual(
      parsed.map((s) => [s.id, s.status, s.markedDone]),
      [
        [ID_FIX, "completed", undefined],
        [ID_BLOCKED, "completed", true],
        [ID_BETA, "review_ready", undefined],
        [UUID_B, "unknown", undefined],
      ],
    );
    assert.equal(parsed[1].statusDetail, "waiting");
    assert.equal(parsed[1].needsAction, "pick option A or B");
  });

  it("resolves <n> like open and url: same flags, and ids and prefixes work too", async () => {
    // 0.1 days = 2.4h: only the 1h and 2h sessions are listed, so #2 is Beta work here.
    await cli(["done", "2", "--days", "0.1"]);
    assert.deepEqual(Object.keys(stateMarks()), [ID_BETA]);
    await cli(["done", UUID_B.slice(0, 8)]);
    await cli(["done", ID_FIX]);
    assert.deepEqual(Object.keys(stateMarks()).sort(), [ID_BETA, ID_FIX, UUID_B].sort());
    const list = await cli([]);
    assert.match(rowOf(list.out, "CLI only task"), /msgs +done ✓$/);
    assert.match(rowOf(list.out, "Beta work"), /turns +done ✓$/);
  });

  it("marking again is fine and keeps a single mark", async () => {
    assert.equal((await cli(["done", "2"])).code, 0);
    assert.equal((await cli(["done", "2"])).code, 0);
    assert.deepEqual(Object.keys(stateMarks()), [ID_BLOCKED]);
  });

  it("the mark expires when the session has new activity: the app's status comes back", async () => {
    await cli(["done", "2"]);
    assert.match(rowOf((await cli([])).out, "Needs a decision"), /done ✓$/);
    writeDesktopSession(env, {
      sessionId: ID_BLOCKED,
      cliSessionId: "99999999-9999-4999-8999-999999999999",
      cwd: `${ALPHA}/.claude/worktrees/wt1`,
      originCwd: ALPHA,
      title: "Needs a decision",
      lastActivityAt: NOW - 2.5 * HOUR, // a new turn
      completedTurns: 2,
      postTurnSummary: { status_category: "blocked", status_detail: "waiting", needs_action: "pick option A or B" },
    });
    const list = await cli([]);
    assert.match(rowOf(list.out, "Needs a decision"), /^ {2}2 {2}Needs a decision +2h +2 turns +needs input$/);
    assert.ok(!list.out.includes("done ✓"));
    assert.ok(!("markedDone" in (JSON.parse((await cli(["--json"])).out) as SessionInfo[])[1]));
  });

  it("undone removes the mark: the status is back", async () => {
    await cli(["done", "2"]);
    const r = await cli(["undone", "2"]);
    assert.equal(r.code, 0);
    assert.equal(r.err, "");
    assert.equal(r.out, 'Unmarked "Needs a decision". Its status is back.\n');
    assert.deepEqual(stateMarks(), {});
    const lines = (await cli([])).out.split("\n");
    assert.match(lines[2], /^ {2}2 {2}Needs a decision +3h +1 turn +needs input$/);
    assert.ok(!lines.join("\n").includes("done ✓"));
  });

  it("undone works with an id, and on a session that was never marked", async () => {
    await cli(["done", ID_BETA]);
    assert.equal((await cli(["undone", ID_BETA])).code, 0);
    assert.deepEqual(stateMarks(), {});
    const fresh = await cli(["undone", "1"]); // marked nothing before: a plain no-op
    assert.equal(fresh.code, 0);
    assert.deepEqual(stateMarks(), {});
  });

  it("undone on a session that was never marked does not create the state file", async () => {
    assert.equal((await cli(["undone", "1"])).code, 0);
    assert.equal(fs.existsSync(env.stateFile), false);
  });

  it("a running session keeps showing `running`, mark or not", async () => {
    const toolUse = rec("assistant", {
      ...base(ALPHA, NOW - 60_000),
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
        stop_reason: "tool_use",
      },
    });
    writeTranscript(env, ALPHA, UUID_A, [userPrompt(ALPHA, NOW - 5 * 60_000, "go"), toolUse], {
      mtimeMs: NOW - 30_000,
    });
    liveSessions(UUID_A);
    assert.equal((await cli(["done", "1"])).code, 0);
    assert.match(rowOf((await cli([])).out, "Fix login bug"), /turns +running +PR #12$/);
    assert.match(rowOf((await cli(["--no-running"])).out, "Fix login bug"), /turns +done ✓ +PR #12$/);
  });

  it("errors on a bad selector, with a non-zero exit and no state file", async () => {
    for (const cmd of ["done", "undone"]) {
      const range = await cli([cmd, "99"]);
      assert.equal(range.code, 1, `${cmd} 99`);
      assert.match(range.err, /^ccsl: No session #99: only 4 listed/);
      assert.equal(range.out, "");

      const unknown = await cli([cmd, "local_nope"]);
      assert.equal(unknown.code, 1);
      assert.match(unknown.err, /^ccsl: No session matches "local_nope"\./);

      const ambiguous = await cli([cmd, "local_aaaa"]);
      assert.equal(ambiguous.code, 1);
      assert.match(ambiguous.err, /matches 2 sessions/);

      const none = await cli([cmd, "0"]);
      assert.equal(none.code, 1);
      assert.match(none.err, /No session #0/);
    }
    assert.equal(fs.existsSync(env.stateFile), false);
  });

  it("bad arguments exit with code 2", async () => {
    for (const args of [
      ["done"],
      ["undone"],
      ["done", "1", "2"],
      ["undone", "1", "--prompt", "x"],
      ["done", "1", "--terminal", "Ghostty"],
    ]) {
      const r = await cli(args);
      assert.equal(r.code, 2, args.join(" "));
      assert.match(r.err, /^ccsl: /);
      assert.equal(r.out, "");
    }
    assert.equal(fs.existsSync(env.stateFile), false);
  });

  it("fails clearly when the state file cannot be written", async () => {
    const blocker = path.join(env.root, "blocker");
    fs.writeFileSync(blocker, "a file");
    const r = await cli(["done", "2", "--state-file", path.join(blocker, "state.json")]);
    assert.equal(r.code, 1);
    assert.match(r.err, /^ccsl: /);
    assert.equal(r.out, "");
  });

  it("never runs ps and never launches anything", async () => {
    liveSessions(UUID_A);
    await cli(["done", "1"]);
    await cli(["done", ID_BETA]);
    await cli(["undone", "1"]);
    assert.equal(psCalls, 0);
    assert.equal(calls.length, 0);
  });
});

describe("ccsl url", () => {
  it("resolves a list number", async () => {
    assert.equal((await cli(["url", "1"])).out, `claude://code/continue?session=${ID_FIX}\n`);
    assert.equal((await cli(["url", "2"])).out, `claude://code/continue?session=${ID_BLOCKED}\n`);
  });

  it("resolves a number with the same flags (--days narrows the list)", async () => {
    // 0.1 days = 2.4h: only the 1h and 2h sessions are listed, so #3 does not exist.
    const r = await cli(["url", "3", "--days", "0.1"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /No session #3: only 2 listed/);
    assert.equal((await cli(["url", "2", "--days", "0.1"])).out, `claude://code/continue?session=${ID_BETA}\n`);
  });

  it("resolves a desktop id and a unique prefix", async () => {
    assert.equal((await cli(["url", ID_BETA])).out, `claude://code/continue?session=${ID_BETA}\n`);
    assert.equal((await cli(["url", "local_bbbb"])).out, `claude://code/continue?session=${ID_BETA}\n`);
  });

  it("resolves a CLI uuid (import URL for CLI-only sessions) and a uuid prefix", async () => {
    assert.equal((await cli(["url", UUID_B])).out, `claude://resume?session=${UUID_B}\n`);
    assert.equal((await cli(["url", "22222222"])).out, `claude://resume?session=${UUID_B}\n`);
  });

  it("a desktop session is also found by its CLI uuid, and ids outside the window still resolve", async () => {
    assert.equal((await cli(["url", UUID_A, "--days", "1"])).out, `claude://code/continue?session=${ID_FIX}\n`);
    writeDesktopSession(
      env,
      {
        sessionId: "local_ancient-1",
        cwd: ALPHA,
        originCwd: ALPHA,
        title: "old",
        lastActivityAt: NOW - 90 * 24 * HOUR,
      },
      { mtimeMs: NOW - 90 * 24 * HOUR },
    );
    assert.equal((await cli(["url", "local_ancient"])).out, "claude://code/continue?session=local_ancient-1\n");
  });

  it("a short all-digit selector is always a list number, never an id prefix", async () => {
    // One fixture session id starts with 99999999-...; "99" must still be reported as out of range.
    const r = await cli(["url", "99"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /No session #99/);
    assert.equal(
      (await cli(["url", "99999999"])).out,
      `claude://code/continue?session=${ID_BLOCKED}\n`,
      "8+ digits can be a uuid prefix",
    );
  });

  it("reports ambiguous prefixes and unknown sessions with a non-zero exit", async () => {
    const amb = await cli(["url", "local_aaaa"]);
    assert.equal(amb.code, 1);
    assert.match(amb.err, /matches 2 sessions/);
    assert.ok(amb.err.includes(ID_FIX) && amb.err.includes(ID_BLOCKED));
    assert.equal(amb.out, "");

    const unknown = await cli(["url", "local_nope"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /^ccsl: No session matches "local_nope"\./);

    const range = await cli(["url", "99"]);
    assert.equal(range.code, 1);
    assert.match(range.err, /No session #99: only 4 listed/);
  });
});

describe("ccsl open / resume / new", () => {
  it("open runs `open <continue url>`", async () => {
    const r = await cli(["open", "1"]);
    assert.equal(r.code, 0);
    assert.deepEqual(calls, [{ file: "open", args: [`claude://code/continue?session=${ID_FIX}`] }]);
    assert.match(r.out, /Opened "Fix login bug".*\(continue\)/);
  });

  it("open imports CLI-only sessions", async () => {
    await cli(["open", "4"]);
    assert.deepEqual(calls, [{ file: "open", args: [`claude://resume?session=${UUID_B}`] }]);
  });

  it("resume defaults to Terminal (falls back to the home dir when the folder is gone)", async () => {
    const r = await cli(["resume", "1"]);
    assert.equal(r.code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, "osascript");
    assert.ok(calls[0].args.includes(`do script "cd '${os.homedir()}' && claude --resume ${UUID_A}"`));
    assert.match(r.out, /Resuming "Fix login bug" in Terminal/);
  });

  it("resume --terminal Ghostty / iTerm", async () => {
    await cli(["resume", "1", "--terminal", "Ghostty"]);
    assert.equal(calls[0].file, "open");
    assert.deepEqual(calls[0].args.slice(0, 3), ["-na", "Ghostty", "--args"]);
    assert.ok(calls[0].args.some((a) => a.includes(`claude --resume ${UUID_A}`)));
    calls.length = 0;
    await cli(["resume", "1", "--terminal", "iTerm"]);
    assert.equal(calls[0].file, "osascript");
    assert.ok(calls[0].args.includes('tell application "iTerm"'));
  });

  it("resume fails clearly for a session without a CLI id and does not launch anything", async () => {
    const r = await cli(["resume", "3"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /no Claude Code session id/);
    assert.equal(calls.length, 0);
  });

  it("new <path> starts a desktop session in that folder", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccsl new "));
    try {
      const r = await cli(["new", dir]);
      assert.equal(r.code, 0);
      assert.deepEqual(calls, [{ file: "open", args: [`claude://code/new?folder=${encodeURIComponent(dir)}`] }]);
      calls.length = 0;
      await cli(["new", dir, "--prompt", "write tests & ship"]);
      assert.deepEqual(calls, [
        { file: "open", args: [`claude://code/new?folder=${encodeURIComponent(dir)}&q=write%20tests%20%26%20ship`] },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("new <n> and new <id> use that session's repo root", async () => {
    await cli(["new", "2"]); // a worktree session: its repo root, not the worktree
    assert.deepEqual(calls, [{ file: "open", args: [`claude://code/new?folder=${encodeURIComponent(ALPHA)}`] }]);
    calls.length = 0;
    await cli(["new", ID_BETA, "--prompt", "hi"]);
    assert.deepEqual(calls, [{ file: "open", args: [`claude://code/new?folder=${encodeURIComponent(BETA)}&q=hi`] }]);
  });

  it("new rejects a path that is not a folder", async () => {
    const r = await cli(["new", "/definitely/not/here"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /Not a folder/);
    assert.equal(calls.length, 0);
  });

  it("bad arguments exit with code 2 and a message on stderr", async () => {
    for (const args of [["--nope"], ["open"], ["resume", "1", "--terminal", "kitty"], ["--days", "x"]]) {
      const r = await cli(args);
      assert.equal(r.code, 2, args.join(" "));
      assert.match(r.err, /^ccsl: /);
      assert.equal(r.out, "");
    }
    assert.equal(calls.length, 0);
  });
});
