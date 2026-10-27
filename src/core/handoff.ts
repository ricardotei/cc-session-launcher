import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import type { OpenMethod, SessionInfo, TerminalApp } from "./types";

// -------------------------------------------------------------------------------------------------
// Side effects (injectable so tests can assert the exact command without running it)
// -------------------------------------------------------------------------------------------------

/** Runs an executable with arguments. The default implementation is child_process.execFile. */
export type CommandRunner = (file: string, args: string[]) => Promise<void>;

const defaultRunner: CommandRunner = (file, args) =>
  new Promise<void>((resolve, reject) => {
    execFile(file, args, (err, _stdout, stderr) => {
      if (err) {
        const detail = typeof stderr === "string" && stderr.trim() ? `: ${stderr.trim()}` : `: ${err.message}`;
        reject(new Error(`${file} failed${detail}`));
      } else {
        resolve();
      }
    });
  });

let runner: CommandRunner = defaultRunner;

/** Replaces the command runner (tests). Pass null to restore the real execFile-based one. */
export function setCommandRunner(next: CommandRunner | null): void {
  runner = next ?? defaultRunner;
}

// -------------------------------------------------------------------------------------------------
// URL builders
// -------------------------------------------------------------------------------------------------

/** Longest prompt we put in a claude://code/new URL (before encoding). */
export const MAX_PROMPT_CHARS = 14000;

/** encodeURIComponent that never throws on lone surrogates (they become U+FFFD). */
function encode(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    return encodeURIComponent(
      value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�"),
    );
  }
}

/** claude://code/continue?session=local_<uuid>: focuses an existing, non-archived desktop session. */
export function desktopContinueUrl(desktopId: string): string {
  return `claude://code/continue?session=${encode(desktopId)}`;
}

/** claude://code/new?folder=<abs path>[&q=<prompt>]: starts a new desktop Code session (the app asks to confirm the folder). */
export function desktopNewSessionUrl(folder: string, prompt?: string): string {
  let url = `claude://code/new?folder=${encode(folder)}`;
  if (prompt && prompt.trim().length > 0) {
    let q = prompt;
    if (q.length > MAX_PROMPT_CHARS) {
      q = q.slice(0, MAX_PROMPT_CHARS);
      // Do not cut a surrogate pair in half.
      if (/[\uD800-\uDBFF]$/.test(q)) q = q.slice(0, -1);
    }
    url += `&q=${encode(q)}`;
  }
  return url;
}

/** claude://code/needs-input[?session=local_<uuid>]: jumps to a session waiting on the user. */
export function desktopNeedsInputUrl(desktopId?: string): string {
  return desktopId ? `claude://code/needs-input?session=${encode(desktopId)}` : "claude://code/needs-input";
}

/** claude://resume?session=<cli uuid>: imports a CLI-only session into the desktop app. */
export function desktopImportCliUrl(cliSessionId: string): string {
  return `claude://resume?session=${encode(cliSessionId)}`;
}

/** The best desktop URL for this session: continue (desktop), import (CLI-only), or new (no ids). */
export function desktopUrlFor(session: SessionInfo): { url: string; method: OpenMethod } {
  if (session.desktopId) return { url: desktopContinueUrl(session.desktopId), method: "continue" };
  if (session.cliSessionId) return { url: desktopImportCliUrl(session.cliSessionId), method: "import" };
  return { url: desktopNewSessionUrl(session.repoRoot), method: "new" };
}

// -------------------------------------------------------------------------------------------------
// Terminal resume
// -------------------------------------------------------------------------------------------------

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** POSIX single-quote escaping: 'it'\''s'. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The directory a terminal resume starts in: cwd, else repoRoot, else the home directory. */
export function resumeDirectory(session: SessionInfo): string {
  if (session.cwd && isDirectory(session.cwd)) return session.cwd;
  if (session.repoRoot && isDirectory(session.repoRoot)) return session.repoRoot;
  return os.homedir();
}

/** Shell command that resumes the session in a terminal: cd '<cwd>' && claude --resume <id>. */
export function resumeCommand(session: SessionInfo): string {
  const id = session.cliSessionId;
  if (!id) {
    throw new Error(
      `"${session.title}" has no Claude Code session id, so it cannot be resumed in a terminal. Open it in the desktop app instead.`,
    );
  }
  // The id ends up unquoted in a shell command; a real one is a uuid.
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`Refusing to resume a session with an unexpected id: ${JSON.stringify(id)}`);
  }
  return `cd ${shellQuote(resumeDirectory(session))} && claude --resume ${id}`;
}

/** Escapes a string for use inside an AppleScript double-quoted literal. */
export function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface TerminalInvocation {
  file: string;
  args: string[];
}

/** The exact executable and arguments used to open `terminal` and run the resume command. */
export function terminalInvocation(session: SessionInfo, terminal: TerminalApp): TerminalInvocation {
  const cmd = resumeCommand(session);
  switch (terminal) {
    case "Terminal":
      return {
        file: "osascript",
        args: [
          "-e",
          'tell application "Terminal"',
          "-e",
          "activate",
          "-e",
          `do script ${appleScriptString(cmd)}`,
          "-e",
          "end tell",
        ],
      };
    case "iTerm":
      return {
        file: "osascript",
        args: [
          "-e",
          'tell application "iTerm"',
          "-e",
          "activate",
          "-e",
          "create window with default profile",
          "-e",
          `tell current session of current window to write text ${appleScriptString(cmd)}`,
          "-e",
          "end tell",
        ],
      };
    case "Ghostty":
      // Ghostty on macOS can only be launched with arguments through `open -na` (its own --help says so).
      // `-e` must come last: it takes the rest of the arguments as the command (no shell expansion), so the
      // shell is invoked explicitly. After claude exits we `exec` a login shell, so the window stays open
      // like it does in Terminal and iTerm (a bare -e command would close the window and quit the instance).
      return {
        file: "open",
        args: [
          "-na",
          "Ghostty",
          "--args",
          `--working-directory=${resumeDirectory(session)}`,
          "-e",
          "/bin/zsh",
          "-lc",
          `${cmd}; exec /bin/zsh -l`,
        ],
      };
    default:
      throw new Error(`Unsupported terminal: ${String(terminal)}`);
  }
}

// -------------------------------------------------------------------------------------------------
// Actions
// -------------------------------------------------------------------------------------------------

/** Opens a URL with macOS `open`. */
export async function openUrl(url: string): Promise<void> {
  // `open` treats a leading "-" as an option; real hand-off URLs always start with a scheme.
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) {
    throw new Error(`Refusing to open a non-URL: ${JSON.stringify(url)}`);
  }
  await runner("open", [url]);
}

/** Opens the session in the Claude desktop app using desktopUrlFor. */
export async function openInDesktop(session: SessionInfo): Promise<{ url: string; method: OpenMethod }> {
  const target = desktopUrlFor(session);
  await openUrl(target.url);
  return target;
}

/** Opens `terminal` in the session's cwd and runs `claude --resume <cliSessionId>`. */
export async function resumeInTerminal(session: SessionInfo, terminal: TerminalApp): Promise<void> {
  const { file, args } = terminalInvocation(session, terminal);
  await runner(file, args);
}

/** Starts a new desktop Code session in `folder`, optionally with a prefilled prompt. */
export async function startNewDesktopSession(folder: string, prompt?: string): Promise<void> {
  await openUrl(desktopNewSessionUrl(folder, prompt));
}
