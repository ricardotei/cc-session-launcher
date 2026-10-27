import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { groupByRepo, loadSessions } from "../src/core/indexer";
import { setProcessLister } from "../src/core/live";
import { markDone, unmarkDone } from "../src/core/marks";
import { encodeCwd } from "../src/core/paths";
import type { SessionInfo } from "../src/core/types";
import {
  DAY,
  HOUR,
  NOW,
  UUID_A,
  UUID_B,
  UUID_C,
  UUID_D,
  UUID_E,
  assistant,
  base,
  makeEnv,
  rec,
  setMtime,
  userPrompt,
  writeDesktopSession,
  writeTranscript,
  type TestEnv,
} from "./fixtures";

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

// Running detection (ps + transcript tails) has its own tests in live.test.ts; here it stays off.
// Done-marks are off too (stateFile: null) unless a test passes env.stateFile: never the real state file.
const load = (over: Partial<Parameters<typeof loadSessions>[0]> = {}) =>
  loadSessions({
    days: 3,
    claudeDir: env.claudeDir,
    desktopDir: env.desktopDir,
    cacheFile: null,
    stateFile: null,
    now: NOW,
    detectRunning: false,
    ...over,
  });

const REPO = "/Users/test/Projects/app";

/** Minimal valid desktop session fields. */
const desk = (id: string, over: Record<string, unknown> = {}) => ({
  sessionId: id,
  cliSessionId: UUID_A,
  cwd: REPO,
  originCwd: REPO,
  title: `Title ${id}`,
  createdAt: NOW - 2 * HOUR,
  lastActivityAt: NOW - HOUR,
  isArchived: false,
  completedTurns: 3,
  model: "claude-opus-5-5",
  ...over,
});

describe("desktop sessions: mapping", () => {
  it("maps the documented fields", async () => {
    writeDesktopSession(
      env,
      desk("local_one", {
        branch: "feature/x",
        completedTurns: 7,
        prs: [{ prNumber: 12, repo: "o/r", url: "https://github.com/o/r/pull/12", state: "OPEN" }],
      }),
    );
    const [s] = await load();
    assert.equal(s.id, "local_one");
    assert.equal(s.source, "desktop");
    assert.equal(s.desktopId, "local_one");
    assert.equal(s.cliSessionId, UUID_A);
    assert.equal(s.title, "Title local_one");
    assert.equal(s.cwd, REPO);
    assert.equal(s.repoRoot, REPO);
    assert.equal(s.repoName, "app");
    assert.equal(s.branch, "feature/x");
    assert.equal(s.isWorktree, false);
    assert.equal(s.lastActivity, NOW - HOUR);
    assert.equal(s.createdAt, NOW - 2 * HOUR);
    assert.equal(s.turns, 7);
    assert.equal(s.messages, undefined);
    assert.equal(s.model, "claude-opus-5-5");
    assert.equal(s.isArchived, false);
    assert.deepEqual(s.prs, [{ url: "https://github.com/o/r/pull/12", number: 12, state: "OPEN", repo: "o/r" }]);
    assert.ok(s.desktopMetaPath?.endsWith("local_one.json"));
  });

  it("lastActivity falls back to createdAt, then to the file mtime", async () => {
    writeDesktopSession(env, desk("local_a", { lastActivityAt: undefined, createdAt: NOW - 5 * HOUR }));
    writeDesktopSession(env, desk("local_b", { lastActivityAt: undefined, createdAt: undefined }), {
      mtimeMs: NOW - 7 * HOUR,
    });
    const out = await load();
    assert.equal(out.find((s) => s.id === "local_a")?.lastActivity, NOW - 5 * HOUR);
    assert.equal(out.find((s) => s.id === "local_b")?.lastActivity, NOW - 7 * HOUR);
  });

  it("truncates long titles to 120 chars and collapses whitespace", async () => {
    writeDesktopSession(env, desk("local_long", { title: "word  ".repeat(60) }));
    const [s] = await load();
    assert.ok(s.title.length <= 120);
    assert.ok(s.title.endsWith("…"));
    assert.ok(!/\s{2,}/.test(s.title));
  });

  it("collects PRs from prs[] and the legacy fields, deduped by url", async () => {
    writeDesktopSession(
      env,
      desk("local_pr", {
        prs: [
          { prNumber: 1, repo: "o/r", url: "https://github.com/o/r/pull/1", state: "MERGED" },
          { prNumber: 2, repo: "o/r", url: "https://github.com/o/r/pull/2", state: "OPEN" },
          { prNumber: 3, repo: "o/r", state: "OPEN" }, // no url: ignored
        ],
        prUrl: "https://github.com/o/r/pull/2", // duplicate of the one above
        prNumber: 2,
        prState: "OPEN",
        prRepository: "o/r",
      }),
    );
    writeDesktopSession(
      env,
      desk("local_legacy", {
        prUrl: "https://github.com/o/legacy/pull/9",
        prNumber: 9,
        prState: "CLOSED",
        prRepository: "o/legacy",
      }),
    );
    const out = await load();
    assert.deepEqual(
      out.find((s) => s.id === "local_pr")?.prs.map((p) => p.url),
      ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"],
    );
    assert.deepEqual(out.find((s) => s.id === "local_legacy")?.prs, [
      { url: "https://github.com/o/legacy/pull/9", number: 9, state: "CLOSED", repo: "o/legacy" },
    ]);
  });

  it("lists a session id found in two account folders once, keeping the newest copy", async () => {
    writeDesktopSession(env, desk("local_dup", { title: "older copy", lastActivityAt: NOW - 5 * HOUR }), {
      account: "acct-1",
      org: "org-1",
    });
    writeDesktopSession(env, desk("local_dup", { title: "newer copy", lastActivityAt: NOW - 1 * HOUR }), {
      account: "acct-2",
      org: "org-2",
    });
    const out = await load();
    assert.deepEqual(
      out.map((s) => s.title),
      ["newer copy"],
    );
  });

  it("reads sessions from several account/org folders and ignores non-session files", async () => {
    writeDesktopSession(env, desk("local_a1"), { account: "acct-1", org: "org-1" });
    writeDesktopSession(env, desk("local_a2"), { account: "acct-2", org: "org-9" });
    const orgDir = path.join(env.desktopDir, "claude-code-sessions", "acct-1", "org-1");
    fs.writeFileSync(path.join(orgDir, "deleted_xyz"), "{}");
    fs.writeFileSync(path.join(orgDir, "scheduled-tasks.json"), JSON.stringify(desk("local_notasession")));
    fs.writeFileSync(path.join(orgDir, "archived-sessions.idx"), "x");
    fs.mkdirSync(path.join(orgDir, "backlog"));
    fs.writeFileSync(path.join(env.desktopDir, "claude-code-sessions", "stray.json"), "{}");
    const ids = (await load()).map((s) => s.id).sort();
    assert.deepEqual(ids, ["local_a1", "local_a2"]);
  });

  it("skips unreadable or invalid files without failing", async () => {
    writeDesktopSession(env, desk("local_ok"));
    writeDesktopSession(env, {}, { raw: "{ not json", mtimeMs: NOW - HOUR });
    writeDesktopSession(env, {}, { raw: "[]", mtimeMs: NOW - HOUR });
    writeDesktopSession(env, { sessionId: "local_nocwd" });
    const out = await load();
    assert.deepEqual(
      out.map((s) => s.id),
      ["local_ok"],
    );
  });

  it("returns an empty list when the stores do not exist", async () => {
    const out = await loadSessions({
      days: 3,
      claudeDir: path.join(env.root, "nope"),
      desktopDir: path.join(env.root, "nope2"),
      cacheFile: null,
      stateFile: null,
      now: NOW,
      detectRunning: false,
    });
    assert.deepEqual(out, []);
  });
});

describe("desktop sessions: status mapping", () => {
  const cases: [string, Record<string, unknown> | undefined, string][] = [
    ["blocked", { status_category: "blocked" }, "needs_input"],
    ["need_input", { status_category: "need_input" }, "needs_input"],
    ["failed", { status_category: "failed" }, "needs_input"],
    ["review_ready", { status_category: "review_ready" }, "review_ready"],
    ["completed", { status_category: "completed" }, "completed"],
    ["missing category, needs_action set", { needs_action: "approve the deploy" }, "needs_input"],
    ["missing category, needs_action empty", { needs_action: "", status_detail: "x" }, "unknown"],
    ["unrecognised category", { status_category: "working" }, "unknown"],
    ["completed beats needs_action", { status_category: "completed", needs_action: "something" }, "completed"],
    ["no postTurnSummary", undefined, "unknown"],
  ];
  for (const [name, summary, expected] of cases) {
    it(name, async () => {
      writeDesktopSession(env, desk("local_s", summary ? { postTurnSummary: summary } : {}));
      const [s] = await load();
      assert.equal(s.status, expected);
    });
  }

  it("carries statusDetail and needsAction, truncated to 200 and omitted when empty", async () => {
    writeDesktopSession(
      env,
      desk("local_d", {
        postTurnSummary: { status_category: "blocked", status_detail: "d".repeat(500), needs_action: "n".repeat(300) },
      }),
    );
    writeDesktopSession(
      env,
      desk("local_e", { postTurnSummary: { status_category: "completed", status_detail: "ok", needs_action: "" } }),
    );
    const out = await load();
    const d = out.find((s) => s.id === "local_d")!;
    assert.equal(d.statusDetail!.length, 200);
    assert.equal(d.needsAction!.length, 200);
    const e = out.find((s) => s.id === "local_e")!;
    assert.equal(e.statusDetail, "ok");
    assert.equal("needsAction" in e, false);
  });
});

describe("worktrees and grouping", () => {
  it("uses originCwd as repoRoot for desktop worktree sessions", async () => {
    const wt = `${REPO}/.claude/worktrees/quirky-name-123456`;
    writeDesktopSession(env, desk("local_wt", { cwd: wt, originCwd: REPO }));
    const [s] = await load();
    assert.equal(s.cwd, wt);
    assert.equal(s.repoRoot, REPO);
    assert.equal(s.repoName, "app");
    assert.equal(s.isWorktree, true);
  });

  it("maps a worktree cwd back to its repo when originCwd is missing", async () => {
    const wt = `${REPO}/.claude/worktrees/some-wt`;
    writeDesktopSession(env, desk("local_nowt", { cwd: wt, originCwd: undefined }));
    const [s] = await load();
    assert.equal(s.repoRoot, REPO);
    assert.equal(s.isWorktree, true);
  });

  it("maps CLI-only worktree transcripts via the /.claude/worktrees/ rule", async () => {
    const wt = `${REPO}/.claude/worktrees/cli-wt`;
    writeTranscript(env, wt, UUID_B, [
      userPrompt(wt, NOW - 3 * HOUR, "hello from a worktree"),
      assistant(wt, NOW - 2 * HOUR),
    ]);
    const [s] = await load();
    assert.equal(s.source, "cli");
    assert.equal(s.cwd, wt);
    assert.equal(s.repoRoot, REPO);
    assert.equal(s.repoName, "app");
    assert.equal(s.isWorktree, true);
  });

  it("groups main-repo and worktree sessions under one repoRoot", async () => {
    writeDesktopSession(env, desk("local_main", { cliSessionId: UUID_A, lastActivityAt: NOW - 5 * HOUR }));
    writeDesktopSession(
      env,
      desk("local_wt", { cliSessionId: UUID_B, cwd: `${REPO}/.claude/worktrees/w1`, lastActivityAt: NOW - 1 * HOUR }),
    );
    const groups = groupByRepo(await load());
    assert.equal(groups.length, 1);
    assert.equal(groups[0].repoRoot, REPO);
    assert.deepEqual(
      groups[0].sessions.map((s) => s.id),
      ["local_wt", "local_main"],
    );
  });
});

describe("transcriptPath resolution", () => {
  it("prefers <projects>/<encoded cwd>/<cliSessionId>.jsonl", async () => {
    const cwd = "/Users/test/Projects/my.app v2";
    writeDesktopSession(env, desk("local_t", { cwd, originCwd: cwd }));
    const file = writeTranscript(env, cwd, UUID_A, [userPrompt(cwd, NOW - HOUR, "hi")], { dirName: encodeCwd(cwd) });
    assert.equal(encodeCwd(cwd), "-Users-test-Projects-my-app-v2");
    const [s] = await load();
    assert.equal(s.transcriptPath, file);
  });

  it("prefers the encoded cwd over a copy in another project dir", async () => {
    writeDesktopSession(env, desk("local_t"));
    writeTranscript(env, REPO, UUID_A, [userPrompt(REPO, NOW - HOUR, "hi")], { dirName: "-aaa-other" });
    const right = writeTranscript(env, REPO, UUID_A, [userPrompt(REPO, NOW - HOUR, "hi")]);
    const [s] = await load();
    assert.equal(s.transcriptPath, right);
  });

  it("falls back to any project dir containing the cliSessionId", async () => {
    writeDesktopSession(env, desk("local_t"));
    const elsewhere = writeTranscript(env, REPO, UUID_A, [userPrompt(REPO, NOW - HOUR, "hi")], {
      dirName: "-some-other-dir",
    });
    const [s] = await load();
    assert.equal(s.transcriptPath, elsewhere);
  });

  it("is undefined when there is no transcript or no cliSessionId", async () => {
    writeDesktopSession(env, desk("local_none", { cliSessionId: UUID_C }));
    writeDesktopSession(env, desk("local_nocli", { cliSessionId: undefined }));
    const out = await load();
    for (const s of out) assert.equal(s.transcriptPath, undefined);
  });

  it("is not stored in the cache (it depends on the live file layout)", async () => {
    writeDesktopSession(env, desk("local_t"));
    writeTranscript(env, REPO, UUID_A, [userPrompt(REPO, NOW - HOUR, "hi")]);
    await load({ cacheFile: env.cacheFile });
    assert.ok(!fs.readFileSync(env.cacheFile, "utf8").includes("transcriptPath"));
    const [s] = await load({ cacheFile: env.cacheFile });
    assert.ok(s.transcriptPath?.endsWith(`${UUID_A}.jsonl`));
  });
});

describe("desktop title fallback", () => {
  it("uses the transcript custom title when the desktop title is empty", async () => {
    writeDesktopSession(env, desk("local_e", { title: "" }));
    writeTranscript(env, REPO, UUID_A, [
      userPrompt(REPO, NOW - 3 * HOUR, "first prompt text"),
      rec("custom-title", { customTitle: "Renamed in the app", sessionId: "x" }),
    ]);
    const [s] = await load();
    assert.equal(s.title, "Renamed in the app");
  });

  it("uses the first prompt when the transcript has no title records", async () => {
    writeDesktopSession(env, desk("local_e", { title: undefined }));
    writeTranscript(env, REPO, UUID_A, [
      userPrompt(REPO, NOW - 3 * HOUR, "Investigate flaky test"),
      assistant(REPO, NOW - 2 * HOUR),
    ]);
    const [s] = await load();
    assert.equal(s.title, "Investigate flaky test");
  });

  it('falls back to "Untitled session" with no transcript', async () => {
    writeDesktopSession(env, desk("local_e", { title: "   " }));
    const [s] = await load();
    assert.equal(s.title, "Untitled session");
  });
});

describe("window, pre-filter, archived and exclude filters", () => {
  it("filters by lastActivity within the window", async () => {
    writeDesktopSession(env, desk("local_new", { cliSessionId: UUID_A, lastActivityAt: NOW - 2 * DAY }));
    writeDesktopSession(env, desk("local_old", { cliSessionId: UUID_B, lastActivityAt: NOW - 3 * DAY - HOUR })); // file mtime is recent
    assert.deepEqual(
      (await load({ days: 3 })).map((s) => s.id),
      ["local_new"],
    );
    assert.deepEqual(
      (await load({ days: 4 })).map((s) => s.id),
      ["local_new", "local_old"],
    );
    assert.deepEqual(
      (await load({ days: 1 })).map((s) => s.id),
      [],
    );
  });

  it("days = 0 means no limit", async () => {
    writeDesktopSession(env, desk("local_ancient", { lastActivityAt: NOW - 400 * DAY }), { mtimeMs: NOW - 400 * DAY });
    assert.deepEqual(
      (await load({ days: 3 })).map((s) => s.id),
      [],
    );
    assert.deepEqual(
      (await load({ days: 0 })).map((s) => s.id),
      ["local_ancient"],
    );
  });

  it("pre-filters desktop files by mtime before parsing them", async () => {
    // Claims recent activity but the file itself is older than the window: skipped by the mtime pre-filter.
    const stale = writeDesktopSession(
      env,
      desk("local_stale_mtime", { cliSessionId: UUID_B, lastActivityAt: NOW - HOUR }),
      {
        mtimeMs: NOW - 10 * DAY,
      },
    );
    // Old and unparseable: must not even be read.
    writeDesktopSession(env, {}, { raw: "{ broken", mtimeMs: NOW - 10 * DAY });
    writeDesktopSession(env, desk("local_fresh", { cliSessionId: UUID_A }));

    assert.deepEqual(
      (await load({ days: 3, cacheFile: env.cacheFile })).map((s) => s.id),
      ["local_fresh"],
    );
    const cached = JSON.parse(fs.readFileSync(env.cacheFile, "utf8"));
    assert.equal(
      Object.keys(cached.entries).some((k) => k === stale),
      false,
      "stale file must not be parsed or cached",
    );

    // With no window the same file is read and shows up.
    assert.deepEqual((await load({ days: 0 })).map((s) => s.id).sort(), ["local_fresh", "local_stale_mtime"]);
  });

  it("pre-filters transcripts by mtime too", async () => {
    writeTranscript(
      env,
      REPO,
      UUID_A,
      [userPrompt(REPO, NOW - HOUR, "recent timestamps, old file"), assistant(REPO, NOW - HOUR)],
      {
        mtimeMs: NOW - 10 * DAY,
      },
    );
    writeTranscript(env, "/Users/test/Projects/other", UUID_B, [
      userPrompt("/Users/test/Projects/other", NOW - HOUR, "fresh"),
      assistant("/Users/test/Projects/other", NOW - HOUR),
    ]);
    assert.deepEqual(
      (await load({ days: 3 })).map((s) => s.cliSessionId),
      [UUID_B],
    );
  });

  it("drops archived sessions unless includeArchived", async () => {
    writeDesktopSession(env, desk("local_live", { cliSessionId: UUID_A }));
    writeDesktopSession(env, desk("local_arch", { cliSessionId: UUID_B, isArchived: true }));
    assert.deepEqual(
      (await load()).map((s) => s.id),
      ["local_live"],
    );
    const all = await load({ includeArchived: true });
    assert.deepEqual(all.map((s) => s.id).sort(), ["local_arch", "local_live"]);
    assert.equal(all.find((s) => s.id === "local_arch")?.isArchived, true);
  });

  it("a cached desktop session outside the window still owns its transcript", async () => {
    // Old desktop file, but its transcript was touched recently and claims to come from the CLI.
    writeDesktopSession(env, desk("local_old", { cliSessionId: UUID_B, lastActivityAt: NOW - 10 * DAY }), {
      mtimeMs: NOW - 10 * DAY,
    });
    writeTranscript(env, REPO, UUID_B, [userPrompt(REPO, NOW - HOUR, "hi"), assistant(REPO, NOW - HOUR)]);
    // Without a cache the old desktop file is never read, so the transcript looks CLI-only.
    assert.deepEqual(
      (await load({ days: 3 })).map((s) => s.source),
      ["cli"],
    );
    // Once a wider run has cached the desktop session, narrower runs know the transcript is not CLI-only.
    await load({ days: 30, cacheFile: env.cacheFile });
    assert.deepEqual(await load({ days: 3, cacheFile: env.cacheFile }), []);
    // A deleted desktop session no longer claims anything.
    fs.rmSync(path.join(env.desktopDir, "claude-code-sessions", "acct-1", "org-1", "local_old.json"));
    assert.deepEqual(
      (await load({ days: 3, cacheFile: env.cacheFile })).map((s) => s.source),
      ["cli"],
    );
  });

  it("an archived desktop session still hides its transcript from the CLI-only list", async () => {
    writeDesktopSession(env, desk("local_arch", { cliSessionId: UUID_A, isArchived: true }));
    writeTranscript(env, REPO, UUID_A, [userPrompt(REPO, NOW - HOUR, "hi"), assistant(REPO, NOW - HOUR)]);
    assert.deepEqual(await load(), []);
  });

  it("excludes by cwd or repoRoot prefix, expanding ~", async () => {
    const home = os.homedir();
    writeDesktopSession(env, desk("local_keep", { cliSessionId: UUID_A }));
    writeDesktopSession(
      env,
      desk("local_scratch", { cliSessionId: UUID_B, cwd: `${home}/scratch/x`, originCwd: `${home}/scratch/x` }),
    );
    writeDesktopSession(
      env,
      desk("local_dl", { cliSessionId: UUID_C, cwd: "/tmp/Downloads/proj", originCwd: "/tmp/Downloads/proj" }),
    );
    // Excluded through repoRoot even though cwd (a worktree) is elsewhere.
    writeDesktopSession(
      env,
      desk("local_wt", { cliSessionId: UUID_D, cwd: "/elsewhere/wt", originCwd: `${home}/scratch/repo` }),
    );
    writeTranscript(env, `${home}/scratch/cli`, UUID_E, [
      userPrompt(`${home}/scratch/cli`, NOW - HOUR, "hi"),
      assistant(`${home}/scratch/cli`, NOW - HOUR),
    ]);

    assert.deepEqual(
      (await load({ excludePaths: ["~/scratch", "/tmp/Downloads"] })).map((s) => s.id),
      ["local_keep"],
    );
    // Empty entries must not match everything.
    assert.equal((await load({ excludePaths: ["", "  "] })).length, 5);
    assert.equal((await load({ excludePaths: [] })).length, 5);
  });

  it("sorts newest first", async () => {
    writeDesktopSession(env, desk("local_b", { cliSessionId: UUID_B, lastActivityAt: NOW - 5 * HOUR }));
    writeDesktopSession(env, desk("local_a", { cliSessionId: UUID_A, lastActivityAt: NOW - 1 * HOUR }));
    writeDesktopSession(env, desk("local_c", { cliSessionId: UUID_C, lastActivityAt: NOW - 9 * HOUR }));
    assert.deepEqual(
      (await load()).map((s) => s.id),
      ["local_a", "local_b", "local_c"],
    );
  });
});

describe("CLI-only transcripts", () => {
  const CWD = "/Users/test/Projects/cli-proj";

  it("skips transcripts that belong to a desktop session (entrypoint)", async () => {
    writeTranscript(env, CWD, UUID_B, [
      rec("file-history-snapshot", { snapshot: {} }), // no entrypoint on the first record
      userPrompt(CWD, NOW - HOUR, "from desktop", { entrypoint: "claude-desktop" }),
      assistant(CWD, NOW - HOUR, "ok", { entrypoint: "claude-desktop" }),
    ]);
    assert.deepEqual(await load(), []);
  });

  it("skips transcripts whose uuid is a desktop cliSessionId or a prior id, whatever the entrypoint", async () => {
    writeDesktopSession(env, desk("local_d", { cliSessionId: UUID_A, priorCliSessionIds: [UUID_B] }));
    for (const id of [UUID_A, UUID_B]) {
      writeTranscript(env, REPO, id, [userPrompt(REPO, NOW - HOUR, "hi"), assistant(REPO, NOW - HOUR)]); // entrypoint "cli"
    }
    const out = await load();
    assert.deepEqual(
      out.map((s) => s.source),
      ["desktop"],
    );
  });

  it("builds a CLI SessionInfo from the records", async () => {
    const lines = [
      rec("file-history-snapshot", {}),
      userPrompt(CWD, NOW - 5 * HOUR, "Add a retry to the uploader", { gitBranch: "main" }),
      assistant(CWD, NOW - 5 * HOUR + 1000),
      userPrompt(CWD, NOW - 3 * HOUR, "now make it configurable", { gitBranch: "feat/retry" }),
      assistant(CWD, NOW - 2 * HOUR, "done", { gitBranch: "feat/retry" }),
    ];
    const file = writeTranscript(env, CWD, UUID_B, lines);
    const [s] = await load();
    assert.equal(s.id, UUID_B);
    assert.equal(s.source, "cli");
    assert.equal(s.cliSessionId, UUID_B);
    assert.equal(s.desktopId, undefined);
    assert.equal(s.cwd, CWD);
    assert.equal(s.repoRoot, CWD);
    assert.equal(s.repoName, "cli-proj");
    assert.equal(s.isWorktree, false);
    assert.equal(s.branch, "feat/retry");
    assert.equal(s.createdAt, NOW - 5 * HOUR);
    assert.equal(s.lastActivity, NOW - 2 * HOUR);
    assert.equal(s.messages, 4);
    assert.equal(s.turns, undefined);
    assert.equal(s.status, "unknown");
    assert.deepEqual(s.prs, []);
    assert.equal(s.isArchived, false);
    assert.equal(s.transcriptPath, file);
    assert.equal(s.title, "Add a retry to the uploader");
  });

  it("uses the file mtime when records have no timestamps", async () => {
    writeTranscript(
      env,
      CWD,
      UUID_B,
      [
        rec("user", { cwd: CWD, message: { role: "user", content: "no timestamps here" } }),
        rec("assistant", { cwd: CWD, message: { role: "assistant", content: [] } }),
      ],
      { mtimeMs: NOW - 6 * HOUR },
    );
    const [s] = await load();
    assert.equal(s.lastActivity, NOW - 6 * HOUR);
  });

  describe("title precedence", () => {
    it("last custom-title wins over summary and prompts", async () => {
      writeTranscript(env, CWD, UUID_B, [
        rec("summary", { summary: "A summary" }),
        userPrompt(CWD, NOW - 3 * HOUR, "the first prompt"),
        rec("custom-title", { customTitle: "First custom" }),
        assistant(CWD, NOW - 2 * HOUR),
        rec("custom-title", { customTitle: "Second custom" }),
        rec("custom-title", { customTitle: "" }), // cleared titles are ignored
      ]);
      assert.equal((await load())[0].title, "Second custom");
    });

    it("last summary wins over the first prompt", async () => {
      writeTranscript(env, CWD, UUID_B, [
        rec("summary", { summary: "Old summary" }),
        userPrompt(CWD, NOW - 3 * HOUR, "the first prompt"),
        assistant(CWD, NOW - 2 * HOUR),
        rec("summary", { summary: "Newest summary" }),
      ]);
      assert.equal((await load())[0].title, "Newest summary");
    });

    it("falls back to the first real prompt, skipping meta, tool results and < wrappers", async () => {
      writeTranscript(env, CWD, UUID_B, [
        userPrompt(CWD, NOW - 6 * HOUR, "meta caveat text", { isMeta: true }),
        userPrompt(CWD, NOW - 6 * HOUR, "<command-name>/model</command-name>"),
        userPrompt(CWD, NOW - 6 * HOUR, "<local-command-stdout>ok</local-command-stdout>"),
        rec("user", {
          ...base(CWD, NOW - 5 * HOUR),
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "tool output text" }] },
          toolUseResult: { stdout: "tool output text" },
        }),
        rec("user", {
          ...base(CWD, NOW - 5 * HOUR),
          message: { role: "user", content: [{ type: "text", text: "Refactor the parser" }] },
        }),
        userPrompt(CWD, NOW - 4 * HOUR, "a later prompt"),
      ]);
      const [s] = await load();
      assert.equal(s.title, "Refactor the parser");
      assert.equal(s.messages, 2, "only the two real prompts count");
    });

    it("truncates a long first prompt to 120 chars", async () => {
      writeTranscript(env, CWD, UUID_B, [userPrompt(CWD, NOW - HOUR, "x".repeat(400)), assistant(CWD, NOW - HOUR)]);
      const [s] = await load();
      assert.equal(s.title.length, 120);
      assert.ok(s.title.endsWith("…"));
    });

    it('is "Untitled session" when there is nothing to use', async () => {
      writeTranscript(env, CWD, UUID_B, [
        userPrompt(CWD, NOW - HOUR, "<command-name>/clear</command-name>"),
        assistant(CWD, NOW - HOUR),
      ]);
      assert.equal((await load())[0].title, "Untitled session");
    });
  });

  it("counts messages: real prompts + assistant records, not meta, tool results or sidechains", async () => {
    writeTranscript(env, CWD, UUID_B, [
      userPrompt(CWD, NOW - 5 * HOUR, "real one"),
      assistant(CWD, NOW - 5 * HOUR),
      assistant(CWD, NOW - 5 * HOUR, "meta", { isMeta: true }),
      assistant(CWD, NOW - 5 * HOUR, "sub", { isSidechain: true }),
      userPrompt(CWD, NOW - 5 * HOUR, "sub prompt", { isSidechain: true }),
      rec("user", {
        ...base(CWD, NOW - 4 * HOUR),
        message: { role: "user", content: [{ type: "tool_result", content: "x" }] },
        toolUseResult: {},
      }),
      userPrompt(CWD, NOW - 3 * HOUR, "real two"),
      assistant(CWD, NOW - 3 * HOUR),
    ]);
    assert.equal((await load())[0].messages, 4);
  });

  it("tolerates bad JSON lines, blank lines, unknown record types and a truncated last line", async () => {
    writeTranscript(env, CWD, UUID_B, [
      "this is not json",
      "",
      "{ broken",
      rec("some-future-type", { whatever: [1, 2, 3] }),
      "123",
      "null",
      userPrompt(CWD, NOW - 4 * HOUR, "survives the noise"),
      '{"type":"assistant","timestamp":"2026-',
      assistant(CWD, NOW - 3 * HOUR),
      '{"type":"user","message":{"content":"cut off mid-wr',
    ]);
    const out = await load();
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "survives the noise");
    assert.equal(out[0].messages, 2);
    assert.equal(out[0].lastActivity, NOW - 3 * HOUR);
  });

  it("drops transcripts with no messages or no cwd", async () => {
    writeTranscript(env, CWD, UUID_B, [
      rec("custom-title", { customTitle: "Only a title" }),
      rec("file-history-snapshot", {}),
    ]);
    writeTranscript(env, CWD, UUID_C, [
      rec("user", {
        message: { role: "user", content: "no cwd anywhere" },
        timestamp: new Date(NOW - HOUR).toISOString(),
      }),
    ]);
    assert.deepEqual(await load(), []);
  });

  it("prefers the cwd that matches the project directory (what `claude --resume` needs)", async () => {
    const moved = "/Users/test/Projects/moved-elsewhere";
    writeTranscript(
      env,
      CWD,
      UUID_B,
      [
        userPrompt(moved, NOW - 3 * HOUR, "started elsewhere"),
        userPrompt(CWD, NOW - 2 * HOUR, "continued here"),
        assistant(CWD, NOW - 2 * HOUR),
      ],
      { dirName: encodeCwd(CWD) },
    );
    assert.equal((await load())[0].cwd, CWD);
  });

  it("ignores subagent transcripts in subfolders", async () => {
    const dir = path.join(env.claudeDir, "projects", encodeCwd(CWD), UUID_B, "subagents");
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "agent-1.jsonl");
    fs.writeFileSync(f, [userPrompt(CWD, NOW - HOUR, "sub"), assistant(CWD, NOW - HOUR)].join("\n"));
    setMtime(f, NOW - HOUR);
    assert.deepEqual(await load(), []);
  });
});

describe("cache", () => {
  const readCache = () => JSON.parse(fs.readFileSync(env.cacheFile, "utf8"));

  it("writes { version: 1, entries } keyed by absolute path, atomically", async () => {
    const file = writeDesktopSession(env, desk("local_c"));
    await load({ cacheFile: env.cacheFile });
    const cache = readCache();
    assert.equal(cache.version, 1);
    const entry = cache.entries[file];
    assert.ok(entry);
    assert.equal(typeof entry.mtimeMs, "number");
    assert.equal(entry.size, fs.statSync(file).size);
    assert.equal(entry.info.id, "local_c");
    assert.deepEqual(fs.readdirSync(path.dirname(env.cacheFile)), ["index-v1.json"], "no tmp files left behind");
  });

  it("reuses entries when path, mtime and size are unchanged", async () => {
    const file = writeDesktopSession(env, desk("local_c", { title: "AAAA" }));
    const mtime = fs.statSync(file).mtimeMs;
    assert.equal((await load({ cacheFile: env.cacheFile }))[0].title, "AAAA");

    // Same size, same mtime, different content: only a cache hit can return the old title.
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("AAAA", "BBBB"));
    setMtime(file, mtime);
    assert.equal(fs.statSync(file).mtimeMs, mtime);
    assert.equal((await load({ cacheFile: env.cacheFile }))[0].title, "AAAA");

    // Without the cache the new content is visible.
    assert.equal((await load())[0].title, "BBBB");
  });

  it("re-parses when the mtime changes", async () => {
    const file = writeDesktopSession(env, desk("local_c", { title: "AAAA" }));
    await load({ cacheFile: env.cacheFile });
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("AAAA", "BBBB"));
    setMtime(file, NOW - 30 * 60 * 1000);
    assert.equal((await load({ cacheFile: env.cacheFile }))[0].title, "BBBB");
    assert.equal(readCache().entries[file].info.title, "BBBB");
  });

  it("keeps a session's last known state when its file is caught mid-write", async () => {
    const file = writeDesktopSession(env, desk("local_c", { title: "AAAA" }));
    assert.equal((await load({ cacheFile: env.cacheFile }))[0].title, "AAAA");
    fs.writeFileSync(file, '{"sessionId":"local_c","title":"BB'); // truncated: the app is still writing
    setMtime(file, NOW - 10 * 60 * 1000);
    const out = await load({ cacheFile: env.cacheFile });
    assert.deepEqual(
      out.map((s) => [s.id, s.title]),
      [["local_c", "AAAA"]],
    );
    // Without a cache entry there is nothing to fall back to.
    assert.deepEqual(await load(), []);
  });

  it("re-parses when the size changes", async () => {
    const file = writeDesktopSession(env, desk("local_c", { title: "AAAA" }));
    const mtime = fs.statSync(file).mtimeMs;
    await load({ cacheFile: env.cacheFile });
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("AAAA", "CCCCCC"));
    setMtime(file, mtime);
    assert.equal((await load({ cacheFile: env.cacheFile }))[0].title, "CCCCCC");
  });

  it("caches CLI transcripts and invalidates them on change", async () => {
    const cwd = "/Users/test/Projects/cli";
    const file = writeTranscript(env, cwd, UUID_B, [
      userPrompt(cwd, NOW - 3 * HOUR, "first title"),
      assistant(cwd, NOW - 3 * HOUR),
    ]);
    const mtime = fs.statSync(file).mtimeMs;
    assert.equal((await load({ cacheFile: env.cacheFile }))[0].title, "first title");

    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("first title", "other title"));
    setMtime(file, mtime);
    assert.equal(
      (await load({ cacheFile: env.cacheFile }))[0].title,
      "first title",
      "unchanged mtime+size: served from cache",
    );

    setMtime(file, mtime + 5000);
    assert.equal((await load({ cacheFile: env.cacheFile }))[0].title, "other title");
  });

  it("remembers desktop-owned transcripts so they are not re-read", async () => {
    const cwd = "/Users/test/Projects/cli";
    const file = writeTranscript(env, cwd, UUID_B, [
      userPrompt(cwd, NOW - HOUR, "x", { entrypoint: "claude-desktop" }),
    ]);
    assert.deepEqual(await load({ cacheFile: env.cacheFile }), []);
    assert.equal(readCache().entries[file].info, null);
  });

  it("prunes entries for files that no longer exist", async () => {
    const keep = writeDesktopSession(env, desk("local_keep", { cliSessionId: UUID_A }));
    const gone = writeDesktopSession(env, desk("local_gone", { cliSessionId: UUID_B }));
    await load({ cacheFile: env.cacheFile });
    assert.deepEqual(Object.keys(readCache().entries).sort(), [gone, keep].sort());
    fs.rmSync(gone);
    await load({ cacheFile: env.cacheFile });
    assert.deepEqual(Object.keys(readCache().entries), [keep]);
  });

  it("keeps entries for files outside the current window", async () => {
    const old = writeDesktopSession(env, desk("local_old", { cliSessionId: UUID_B, lastActivityAt: NOW - 8 * DAY }), {
      mtimeMs: NOW - 8 * DAY,
    });
    writeDesktopSession(env, desk("local_new", { cliSessionId: UUID_A }));
    await load({ days: 30, cacheFile: env.cacheFile });
    await load({ days: 3, cacheFile: env.cacheFile });
    assert.ok(readCache().entries[old]);
  });

  it("ignores a corrupt cache and rewrites it", async () => {
    writeDesktopSession(env, desk("local_c"));
    fs.mkdirSync(path.dirname(env.cacheFile), { recursive: true });
    fs.writeFileSync(env.cacheFile, "{ this is not json ::::");
    const out = await load({ cacheFile: env.cacheFile });
    assert.equal(out.length, 1);
    assert.equal(readCache().version, 1);
  });

  it("ignores a wrong-version cache", async () => {
    const file = writeDesktopSession(env, desk("local_c", { title: "real title" }));
    const st = fs.statSync(file);
    fs.mkdirSync(path.dirname(env.cacheFile), { recursive: true });
    const poisoned = {
      version: 2,
      entries: { [file]: { mtimeMs: st.mtimeMs, size: st.size, info: { id: "poison" } } },
    };
    fs.writeFileSync(env.cacheFile, JSON.stringify(poisoned));
    const out = await load({ cacheFile: env.cacheFile });
    assert.equal(out[0].title, "real title");
    assert.equal(readCache().version, 1);
  });

  it("ignores malformed entries inside an otherwise valid cache", async () => {
    const file = writeDesktopSession(env, desk("local_c", { title: "real title" }));
    const st = fs.statSync(file);
    fs.mkdirSync(path.dirname(env.cacheFile), { recursive: true });
    const bad = {
      version: 1,
      entries: { [file]: { mtimeMs: st.mtimeMs, size: st.size, info: { id: "poison", nonsense: true } }, "/x": 5 },
    };
    fs.writeFileSync(env.cacheFile, JSON.stringify(bad));
    assert.equal((await load({ cacheFile: env.cacheFile }))[0].title, "real title");
  });

  it("cacheFile: null writes nothing anywhere", async () => {
    writeDesktopSession(env, desk("local_c"));
    const before = fs.readdirSync(env.root).sort();
    await load({ cacheFile: null });
    assert.deepEqual(fs.readdirSync(env.root).sort(), before);
    assert.equal(fs.existsSync(path.dirname(env.cacheFile)), false);
  });

  it("an unwritable cache location never fails loadSessions", async () => {
    writeDesktopSession(env, desk("local_c"));
    const blocker = path.join(env.root, "file-not-dir");
    fs.writeFileSync(blocker, "x");
    const out = await load({ cacheFile: path.join(blocker, "sub", "index.json") });
    assert.equal(out.length, 1);
  });

  it("stores metadata only: no prompt bodies, no tool surface blobs", async () => {
    const cwd = "/Users/test/Projects/cli";
    writeDesktopSession(env, {
      ...desk("local_c"),
      enabledMcpTools: { secret: "SECRET_TOOL_BLOB" },
      promptAppendSnapshot: { text: "SECRET_PROMPT_SNAPSHOT" },
      postTurnSummary: { status_category: "blocked", status_detail: "d".repeat(400), needs_action: "n".repeat(400) },
    });
    writeTranscript(env, cwd, UUID_B, [
      userPrompt(cwd, NOW - 3 * HOUR, "T".repeat(120) + "PROMPT_BODY_TAIL"),
      assistant(cwd, NOW - 3 * HOUR, "ASSISTANT_REPLY_BODY"),
      rec("user", {
        ...base(cwd, NOW - 2 * HOUR),
        message: { role: "user", content: [{ type: "tool_result", content: "TOOL_OUTPUT_BODY" }] },
        toolUseResult: { stdout: "TOOL_OUTPUT_BODY" },
      }),
    ]);
    const out = await load({ cacheFile: env.cacheFile });
    assert.equal(out.length, 2);
    const text = fs.readFileSync(env.cacheFile, "utf8");
    for (const secret of [
      "SECRET_TOOL_BLOB",
      "SECRET_PROMPT_SNAPSHOT",
      "PROMPT_BODY_TAIL",
      "ASSISTANT_REPLY_BODY",
      "TOOL_OUTPUT_BODY",
    ]) {
      assert.ok(!text.includes(secret), `${secret} leaked into the cache`);
    }
    for (const entry of Object.values(readCache().entries) as { info: SessionInfo | null }[]) {
      const info = entry.info!;
      assert.ok(info.title.length <= 120);
      assert.ok((info.statusDetail ?? "").length <= 200);
      assert.ok((info.needsAction ?? "").length <= 200);
    }
  });

  it("never modifies the Claude data it reads", async () => {
    const d = writeDesktopSession(env, desk("local_c"));
    const t = writeTranscript(env, REPO, UUID_A, [userPrompt(REPO, NOW - HOUR, "hi")]);
    const snapshot = (f: string) => `${fs.statSync(f).mtimeMs}:${fs.statSync(f).size}`;
    const before = [snapshot(d), snapshot(t)];
    await load({ cacheFile: env.cacheFile });
    await load({ cacheFile: env.cacheFile });
    assert.deepEqual([snapshot(d), snapshot(t)], before);
  });
});

describe("done-marks", () => {
  const blocked = (id: string, over: Record<string, unknown> = {}) =>
    desk(id, {
      cliSessionId: undefined,
      postTurnSummary: { status_category: "blocked", status_detail: "waiting on you", needs_action: "pick A or B" },
      ...over,
    });
  const marked = (over: Partial<Parameters<typeof loadSessions>[0]> = {}) =>
    load({ stateFile: env.stateFile, ...over });

  beforeEach(() => setProcessLister(async () => "")); // the real `ps` never runs in tests
  afterEach(() => setProcessLister(null));

  it("a mark applies while lastActivity is unchanged: markedDone, status completed", async () => {
    writeDesktopSession(env, blocked("local_m"));
    writeDesktopSession(env, blocked("local_other"));
    await markDone({ id: "local_m", lastActivity: NOW - HOUR }, env.stateFile);
    const out = await marked();
    const m = out.find((s) => s.id === "local_m")!;
    assert.equal(m.markedDone, true);
    assert.equal(m.status, "completed");
    const other = out.find((s) => s.id === "local_other")!;
    assert.equal(other.status, "needs_input");
    assert.equal("markedDone" in other, false, "left undefined on every other session");
  });

  it("keeps statusDetail and needsAction as the app wrote them", async () => {
    writeDesktopSession(env, blocked("local_m"));
    await markDone({ id: "local_m", lastActivity: NOW - HOUR }, env.stateFile);
    const [s] = await marked();
    assert.equal(s.status, "completed");
    assert.equal(s.statusDetail, "waiting on you");
    assert.equal(s.needsAction, "pick A or B");
  });

  it("marks review_ready and unknown sessions too", async () => {
    writeDesktopSession(env, blocked("local_r", { postTurnSummary: { status_category: "review_ready" } }));
    writeDesktopSession(env, desk("local_u", { cliSessionId: undefined }));
    for (const id of ["local_r", "local_u"]) await markDone({ id, lastActivity: NOW - HOUR }, env.stateFile);
    const out = await marked();
    assert.deepEqual(out.map((s) => [s.id, s.status, s.markedDone]).sort(), [
      ["local_r", "completed", true],
      ["local_u", "completed", true],
    ]);
  });

  it("a mark expires when lastActivity moves forward: the app's status is back", async () => {
    writeDesktopSession(env, blocked("local_m"));
    await markDone({ id: "local_m", lastActivity: NOW - HOUR }, env.stateFile);
    assert.equal((await marked())[0].markedDone, true);

    writeDesktopSession(env, blocked("local_m", { lastActivityAt: NOW - HOUR + 1 })); // a new turn, 1 ms later
    const [s] = await marked();
    assert.equal(s.status, "needs_input");
    assert.equal("markedDone" in s, false);
    assert.equal(s.lastActivity, NOW - HOUR + 1);
  });

  it("the comparison is mark.lastActivity >= session.lastActivity", async () => {
    writeDesktopSession(env, blocked("local_eq"));
    writeDesktopSession(env, blocked("local_newer", { lastActivityAt: NOW - HOUR + 5000 }));
    writeDesktopSession(env, blocked("local_older", { lastActivityAt: NOW - HOUR - 5000 }));
    for (const id of ["local_eq", "local_newer", "local_older"]) {
      await markDone({ id, lastActivity: NOW - HOUR }, env.stateFile);
    }
    const byId = new Map((await marked()).map((s) => [s.id, s.markedDone]));
    assert.equal(byId.get("local_eq"), true, "equal: applies");
    assert.equal(byId.get("local_older"), true, "mark newer than the session: applies");
    assert.equal(byId.get("local_newer"), undefined, "session newer than the mark: expired");
  });

  it("marks CLI-only sessions, by their transcript uuid", async () => {
    const cwd = "/Users/test/Projects/cli";
    writeTranscript(env, cwd, UUID_B, [userPrompt(cwd, NOW - 3 * HOUR, "hi"), assistant(cwd, NOW - 2 * HOUR)]);
    assert.equal((await marked())[0].status, "unknown");
    await markDone({ id: UUID_B, lastActivity: NOW - 2 * HOUR }, env.stateFile);
    const [s] = await marked();
    assert.equal(s.source, "cli");
    assert.equal(s.markedDone, true);
    assert.equal(s.status, "completed");
  });

  it("unmarking brings the status back", async () => {
    writeDesktopSession(env, blocked("local_m"));
    await markDone({ id: "local_m", lastActivity: NOW - HOUR }, env.stateFile);
    assert.equal((await marked())[0].status, "completed");
    await unmarkDone("local_m", env.stateFile);
    const [s] = await marked();
    assert.equal(s.status, "needs_input");
    assert.equal("markedDone" in s, false);
  });

  it("no mark while a turn is running; it applies again once the turn is over", async () => {
    // The desktop session says it was last active an hour ago, but its transcript was written 30 s ago, mid-turn.
    writeDesktopSession(env, blocked("local_run", { cliSessionId: UUID_A }));
    const toolUse = rec("assistant", {
      ...base(REPO, NOW - 60_000),
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
        stop_reason: "tool_use",
      },
    });
    const file = writeTranscript(env, REPO, UUID_A, [userPrompt(REPO, NOW - 5 * 60_000, "go"), toolUse], {
      mtimeMs: NOW - 30_000,
    });
    await markDone({ id: "local_run", lastActivity: NOW - HOUR }, env.stateFile);

    const [running] = await marked({ detectRunning: true });
    assert.equal(running.isRunning, true);
    assert.equal(running.status, "needs_input");
    assert.equal("markedDone" in running, false);

    setMtime(file, NOW - 30 * 60_000); // the turn ended: no longer a candidate
    const [idle] = await marked({ detectRunning: true });
    assert.equal(idle.isRunning, false);
    assert.equal(idle.markedDone, true);
    assert.equal(idle.status, "completed");
  });

  it("stateFile: null ignores marks, and reads nothing", async () => {
    writeDesktopSession(env, blocked("local_m"));
    await markDone({ id: "local_m", lastActivity: NOW - HOUR }, env.stateFile);
    const [s] = await load({ stateFile: null });
    assert.equal(s.status, "needs_input");
    assert.equal("markedDone" in s, false);
  });

  it("a missing, corrupt or wrong-version state file means no marks, and is never created or changed", async () => {
    writeDesktopSession(env, blocked("local_m"));
    assert.equal((await marked())[0].status, "needs_input");
    assert.equal(fs.existsSync(path.dirname(env.stateFile)), false, "loading does not create the state file or folder");

    fs.mkdirSync(path.dirname(env.stateFile), { recursive: true });
    for (const text of [
      "{ not json",
      JSON.stringify({ version: 9, marks: { local_m: { lastActivity: NOW, markedAt: NOW } } }),
    ]) {
      fs.writeFileSync(env.stateFile, text);
      assert.equal((await marked())[0].status, "needs_input");
      assert.equal(fs.readFileSync(env.stateFile, "utf8"), text);
    }
  });

  it("is applied on copies and never reaches the cache file", async () => {
    writeDesktopSession(env, blocked("local_m"));
    const cwd = "/Users/test/Projects/cli";
    writeTranscript(env, cwd, UUID_B, [userPrompt(cwd, NOW - 3 * HOUR, "hi"), assistant(cwd, NOW - 2 * HOUR)]);
    await markDone({ id: "local_m", lastActivity: NOW - HOUR }, env.stateFile);
    await markDone({ id: UUID_B, lastActivity: NOW - 2 * HOUR }, env.stateFile);

    for (const pass of ["cold cache", "warm cache"]) {
      const out = await marked({ cacheFile: env.cacheFile });
      assert.deepEqual(
        out.map((s) => s.markedDone),
        [true, true],
        pass,
      );
      const text = fs.readFileSync(env.cacheFile, "utf8");
      assert.ok(!text.includes("markedDone"), `markedDone leaked into the cache (${pass})`);
      const entries = Object.values(JSON.parse(text).entries) as { info: SessionInfo | null }[];
      assert.equal(entries.length, 2);
      const statuses = entries.map((e) => e.info?.status).sort();
      assert.deepEqual(statuses, ["needs_input", "unknown"], `the cache keeps the app's own status (${pass})`);
    }

    // Marks come from the state file, not from the cache: unmark and the cached entries show the app's status.
    await unmarkDone("local_m", env.stateFile);
    const [first] = await marked({ cacheFile: env.cacheFile });
    assert.equal(first.status, "needs_input");
  });

  it("every call reads the current marks: nothing is remembered between calls", async () => {
    writeDesktopSession(env, blocked("local_a"));
    writeDesktopSession(env, blocked("local_b", { lastActivityAt: NOW - 2 * HOUR }));
    await markDone({ id: "local_a", lastActivity: NOW - HOUR }, env.stateFile);
    const first = await marked();
    await markDone({ id: "local_b", lastActivity: NOW - 2 * HOUR }, env.stateFile);
    assert.deepEqual(
      first.map((s) => s.markedDone),
      [true, undefined],
      "an earlier result does not change",
    );
    assert.deepEqual(
      (await marked()).map((s) => s.markedDone),
      [true, true],
    );
  });
});

describe("groupByRepo", () => {
  const mk = (id: string, repoRoot: string, lastActivity: number): SessionInfo => ({
    id,
    source: "desktop",
    title: id,
    cwd: repoRoot,
    repoRoot,
    repoName: path.basename(repoRoot),
    isWorktree: false,
    lastActivity,
    status: "unknown",
    prs: [],
    isArchived: false,
  });

  it("orders groups by their newest session and sessions newest first", () => {
    const groups = groupByRepo([
      mk("a-old", "/r/a", 100),
      mk("b-mid", "/r/b", 500),
      mk("a-new", "/r/a", 900),
      mk("c-old", "/r/c", 50),
      mk("b-old", "/r/b", 10),
      mk("a-mid", "/r/a", 400),
    ]);
    assert.deepEqual(
      groups.map((g) => [g.repoRoot, g.repoName, g.lastActivity]),
      [
        ["/r/a", "a", 900],
        ["/r/b", "b", 500],
        ["/r/c", "c", 50],
      ],
    );
    assert.deepEqual(
      groups[0].sessions.map((s) => s.id),
      ["a-new", "a-mid", "a-old"],
    );
    assert.deepEqual(
      groups[1].sessions.map((s) => s.id),
      ["b-mid", "b-old"],
    );
  });

  it("handles empty input", () => {
    assert.deepEqual(groupByRepo([]), []);
  });
});
