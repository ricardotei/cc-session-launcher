import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  appleScriptString,
  desktopContinueUrl,
  desktopImportCliUrl,
  desktopNeedsInputUrl,
  desktopNewSessionUrl,
  desktopUrlFor,
  openInDesktop,
  openUrl,
  resumeCommand,
  resumeInTerminal,
  setCommandRunner,
  shellQuote,
  startNewDesktopSession,
  terminalInvocation,
} from "../src/core/handoff";
import type { SessionInfo } from "../src/core/types";

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "local_abc",
    source: "desktop",
    desktopId: "local_abc",
    cliSessionId: "11111111-1111-4111-8111-111111111111",
    title: "A session",
    cwd: "/nonexistent/repo",
    repoRoot: "/nonexistent/repo",
    repoName: "repo",
    isWorktree: false,
    lastActivity: 0,
    status: "unknown",
    prs: [],
    isArchived: false,
    ...over,
  };
}

describe("URL builders", () => {
  it("desktopContinueUrl", () => {
    assert.equal(
      desktopContinueUrl("local_0f1e2d3c-4b5a-4697-8877-665544332211"),
      "claude://code/continue?session=local_0f1e2d3c-4b5a-4697-8877-665544332211",
    );
  });

  it("desktopNeedsInputUrl with and without a session", () => {
    assert.equal(desktopNeedsInputUrl(), "claude://code/needs-input");
    assert.equal(desktopNeedsInputUrl("local_abc-1"), "claude://code/needs-input?session=local_abc-1");
  });

  it("desktopImportCliUrl", () => {
    assert.equal(
      desktopImportCliUrl("9c8b7a65-4321-4fed-8cba-0123456789ab"),
      "claude://resume?session=9c8b7a65-4321-4fed-8cba-0123456789ab",
    );
  });

  it("desktopNewSessionUrl encodes the folder", () => {
    assert.equal(
      desktopNewSessionUrl("/Users/me/My Projects/app"),
      "claude://code/new?folder=%2FUsers%2Fme%2FMy%20Projects%2Fapp",
    );
  });

  it("desktopNewSessionUrl adds an encoded prompt only when non-empty", () => {
    assert.equal(desktopNewSessionUrl("/a", ""), "claude://code/new?folder=%2Fa");
    assert.equal(desktopNewSessionUrl("/a", "   "), "claude://code/new?folder=%2Fa");
    assert.equal(desktopNewSessionUrl("/a", undefined), "claude://code/new?folder=%2Fa");
    assert.equal(
      desktopNewSessionUrl("/a", "fix the bug & add tests? 100% é\nnext"),
      "claude://code/new?folder=%2Fa&q=fix%20the%20bug%20%26%20add%20tests%3F%20100%25%20%C3%A9%0Anext",
    );
  });

  it("desktopNewSessionUrl caps the prompt at 14000 chars before encoding", () => {
    const url = desktopNewSessionUrl("/a", "x".repeat(20000));
    const q = url.split("&q=")[1];
    assert.equal(q.length, 14000);
    // "&" is 3 chars once encoded, so the cap is measured before encoding.
    const url2 = desktopNewSessionUrl("/a", "&".repeat(20000));
    assert.equal(url2.split("&q=")[1], "%26".repeat(14000));
  });

  it("desktopNewSessionUrl survives a cap that lands inside a surrogate pair", () => {
    const prompt = "a".repeat(13999) + "😀" + "tail";
    const url = desktopNewSessionUrl("/a", prompt);
    assert.equal(url.split("&q=")[1], "a".repeat(13999));
  });

  it("desktopUrlFor picks continue, import or new", () => {
    assert.deepEqual(desktopUrlFor(session()), { url: "claude://code/continue?session=local_abc", method: "continue" });
    assert.deepEqual(desktopUrlFor(session({ desktopId: undefined, source: "cli" })), {
      url: "claude://resume?session=11111111-1111-4111-8111-111111111111",
      method: "import",
    });
    assert.deepEqual(desktopUrlFor(session({ desktopId: undefined, cliSessionId: undefined, repoRoot: "/r/x y" })), {
      url: "claude://code/new?folder=%2Fr%2Fx%20y",
      method: "new",
    });
  });
});

describe("resumeCommand", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccsl-handoff-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("shellQuote escapes single quotes POSIX-style", () => {
    assert.equal(shellQuote("plain"), "'plain'");
    assert.equal(shellQuote("it's"), `'it'\\''s'`);
  });

  it("quotes cwd with spaces and a single quote", () => {
    const dir = path.join(tmp, "My Proj's dir");
    fs.mkdirSync(dir);
    const cmd = resumeCommand(session({ cwd: dir, repoRoot: dir }));
    assert.equal(cmd, `cd '${tmp}/My Proj'\\''s dir' && claude --resume 11111111-1111-4111-8111-111111111111`);
  });

  it("uses the plain shape for a simple path", () => {
    const cmd = resumeCommand(session({ cwd: tmp, repoRoot: tmp }));
    assert.equal(cmd, `cd '${tmp}' && claude --resume 11111111-1111-4111-8111-111111111111`);
  });

  it("falls back to repoRoot when cwd is gone, then to the home directory", () => {
    const gone = path.join(tmp, "gone");
    assert.match(resumeCommand(session({ cwd: gone, repoRoot: tmp })), new RegExp(`^cd '${tmp}' && `));
    assert.equal(
      resumeCommand(session({ cwd: gone, repoRoot: path.join(tmp, "also-gone") })),
      `cd '${os.homedir()}' && claude --resume 11111111-1111-4111-8111-111111111111`,
    );
  });

  it("throws a clear error without a CLI session id", () => {
    assert.throws(
      () => resumeCommand(session({ cliSessionId: undefined, title: "No id here" })),
      /no Claude Code session id/,
    );
  });

  it("refuses ids that are not shell-safe", () => {
    assert.throws(() => resumeCommand(session({ cliSessionId: "x; rm -rf /" })), /unexpected id/);
  });
});

describe("side effects go through the injected runner", () => {
  let tmp: string;
  let calls: { file: string; args: string[] }[];
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccsl-handoff-"));
    calls = [];
    setCommandRunner(async (file, args) => void calls.push({ file, args }));
  });
  afterEach(() => {
    setCommandRunner(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const ID = "11111111-1111-4111-8111-111111111111";

  it("openUrl runs `open <url>`", async () => {
    await openUrl("claude://code/needs-input");
    assert.deepEqual(calls, [{ file: "open", args: ["claude://code/needs-input"] }]);
  });

  it("openUrl refuses things that are not URLs (no option injection)", async () => {
    await assert.rejects(() => openUrl("-a Calculator"), /non-URL/);
    assert.equal(calls.length, 0);
  });

  it("openUrl propagates runner failures", async () => {
    setCommandRunner(async () => {
      throw new Error("boom");
    });
    await assert.rejects(() => openUrl("claude://x"), /boom/);
  });

  it("openInDesktop opens the continue URL and reports the method", async () => {
    const result = await openInDesktop(session());
    assert.deepEqual(result, { url: "claude://code/continue?session=local_abc", method: "continue" });
    assert.deepEqual(calls, [{ file: "open", args: ["claude://code/continue?session=local_abc"] }]);
  });

  it("openInDesktop imports CLI-only sessions", async () => {
    const result = await openInDesktop(session({ desktopId: undefined, source: "cli" }));
    assert.equal(result.method, "import");
    assert.deepEqual(calls, [{ file: "open", args: [`claude://resume?session=${ID}`] }]);
  });

  it("startNewDesktopSession opens the new-session URL", async () => {
    await startNewDesktopSession("/work/app", "do it");
    assert.deepEqual(calls, [{ file: "open", args: ["claude://code/new?folder=%2Fwork%2Fapp&q=do%20it"] }]);
    calls.length = 0;
    await startNewDesktopSession("/work/app");
    assert.deepEqual(calls, [{ file: "open", args: ["claude://code/new?folder=%2Fwork%2Fapp"] }]);
  });

  it("Terminal: osascript with tell/activate/do script", async () => {
    await resumeInTerminal(session({ cwd: tmp, repoRoot: tmp }), "Terminal");
    assert.deepEqual(calls, [
      {
        file: "osascript",
        args: [
          "-e",
          'tell application "Terminal"',
          "-e",
          "activate",
          "-e",
          `do script "cd '${tmp}' && claude --resume ${ID}"`,
          "-e",
          "end tell",
        ],
      },
    ]);
  });

  it("iTerm: osascript with create window and write text", async () => {
    await resumeInTerminal(session({ cwd: tmp, repoRoot: tmp }), "iTerm");
    assert.deepEqual(calls, [
      {
        file: "osascript",
        args: [
          "-e",
          'tell application "iTerm"',
          "-e",
          "activate",
          "-e",
          "create window with default profile",
          "-e",
          `tell current session of current window to write text "cd '${tmp}' && claude --resume ${ID}"`,
          "-e",
          "end tell",
        ],
      },
    ]);
  });

  it("Ghostty: open -na Ghostty --args with working directory and an explicit shell", async () => {
    await resumeInTerminal(session({ cwd: tmp, repoRoot: tmp }), "Ghostty");
    assert.deepEqual(calls, [
      {
        file: "open",
        args: [
          "-na",
          "Ghostty",
          "--args",
          `--working-directory=${tmp}`,
          "-e",
          "/bin/zsh",
          "-lc",
          `cd '${tmp}' && claude --resume ${ID}; exec /bin/zsh -l`,
        ],
      },
    ]);
  });

  it("AppleScript terminals escape backslashes and double quotes", () => {
    assert.equal(appleScriptString(`a"b\\c`), `"a\\"b\\\\c"`);
    const dir = path.join(tmp, `we"ird\\dir`);
    fs.mkdirSync(dir);
    const inv = terminalInvocation(session({ cwd: dir, repoRoot: dir }), "Terminal");
    const script = inv.args[5];
    assert.equal(script, `do script "cd '${tmp}/we\\"ird\\\\dir' && claude --resume ${ID}"`);
  });

  it("resumeInTerminal rejects sessions without a CLI id before running anything", async () => {
    await assert.rejects(
      () => resumeInTerminal(session({ cliSessionId: undefined }), "Terminal"),
      /no Claude Code session id/,
    );
    assert.equal(calls.length, 0);
  });
});
