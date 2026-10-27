import * as fs from "fs";
import * as path from "path";
import { relativeTime, tildify, truncate } from "./core/format";
import { desktopUrlFor, openInDesktop, resumeCommand, resumeInTerminal, startNewDesktopSession } from "./core/handoff";
import { groupByRepo, loadSessions } from "./core/indexer";
import { markDone, unmarkDone } from "./core/marks";
import { expandHome } from "./core/paths";
import type { LoadOptions, RepoGroup, SessionInfo, TerminalApp } from "./core/types";

// -------------------------------------------------------------------------------------------------
// I/O and errors
// -------------------------------------------------------------------------------------------------

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /** Colors are used only when this is true and NO_COLOR is unset. */
  isTTY: boolean;
  columns?: number;
  env: NodeJS.ProcessEnv;
  now?: () => number;
}

/** A user-facing failure: printed as `ccsl: <message>` and turned into an exit code. */
class CliError extends Error {
  constructor(
    message: string,
    readonly code: number = 1,
  ) {
    super(message);
  }
}

const usageError = (message: string) => new CliError(message, 2);

export const HELP = `ccsl: list Claude Code sessions and jump back into them

Usage:
  ccsl [--days N | --all] [--archived] [--exclude a,b] [--json]   list sessions (default: last 3 days)
  ccsl open <n|id>                  open in the Claude desktop app
  ccsl resume <n|id> [--terminal Terminal|Ghostty|iTerm]
                                    resume in a terminal (claude --resume)
  ccsl new <n|id|path> [--prompt "..."]
                                    new desktop session in that repo
  ccsl url <n|id>                   print the desktop URL without opening it
  ccsl done <n|id>                  mark completed (hides its needs input / review status until new activity)
  ccsl undone <n|id>                remove that mark
  ccsl --help

<n> is the number shown in the list (pass the same --days/--all/--archived/--exclude again).
<id> is a desktop id (local_...) or a CLI session uuid; a unique prefix is enough.

Options:
  --days N       only sessions active in the last N days (0 = no limit)
  --all          no time limit
  --archived     include sessions archived in the desktop app
  --exclude a,b  hide sessions whose folder starts with one of these prefixes (~ is expanded)
  --json         print the list as JSON
  --terminal T   Terminal (default), Ghostty or iTerm
  --prompt TEXT  prefill the prompt of a new session
  -h, --help     show this help

Environment: NO_COLOR disables colors.
Advanced: --claude-dir DIR, --desktop-dir DIR, --no-cache.
`;

// -------------------------------------------------------------------------------------------------
// Argument parsing
// -------------------------------------------------------------------------------------------------

type Command = "list" | "open" | "resume" | "new" | "url" | "done" | "undone";
const COMMANDS: Command[] = ["list", "open", "resume", "new", "url", "done", "undone"];

export interface ParsedArgs {
  help: boolean;
  command: Command;
  args: string[];
  days: number;
  all: boolean;
  archived: boolean;
  exclude: string[];
  json: boolean;
  terminal?: TerminalApp;
  prompt?: string;
  claudeDir?: string;
  desktopDir?: string;
  /** Hidden: where the done-marks live (tests). */
  stateFile?: string;
  noCache: boolean;
  /** Hidden: skip the turn-in-progress detection (no `ps`, no transcript reads). */
  noRunning: boolean;
}

function parseTerminal(value: string): TerminalApp {
  switch (value.trim().toLowerCase()) {
    case "terminal":
      return "Terminal";
    case "ghostty":
      return "Ghostty";
    case "iterm":
    case "iterm2":
      return "iTerm";
    default:
      throw usageError(`Unknown terminal "${value}". Use Terminal, Ghostty or iTerm.`);
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    command: "list",
    args: [],
    days: 3,
    all: false,
    archived: false,
    exclude: [],
    json: false,
    noCache: false,
    noRunning: false,
  };
  let daysGiven = false;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    let name = token;
    let inline: string | undefined;
    const eq = token.indexOf("=");
    if (token.startsWith("--") && eq > 0) {
      name = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw usageError(`Option ${name} needs a value.`);
      return next;
    };
    const flag = (): void => {
      if (inline !== undefined) throw usageError(`Option ${name} does not take a value.`);
    };

    switch (name) {
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "--days": {
        const raw = value();
        const n = Number(raw);
        if (raw.trim() === "" || !Number.isFinite(n) || n < 0) {
          throw usageError(`--days needs a non-negative number, got "${raw}".`);
        }
        parsed.days = n;
        daysGiven = true;
        break;
      }
      case "--all":
        flag();
        parsed.all = true;
        break;
      case "--archived":
        flag();
        parsed.archived = true;
        break;
      case "--json":
        flag();
        parsed.json = true;
        break;
      case "--exclude":
        parsed.exclude.push(
          ...value()
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
        break;
      case "--terminal":
        parsed.terminal = parseTerminal(value());
        break;
      case "--prompt":
        parsed.prompt = value();
        break;
      case "--claude-dir":
        parsed.claudeDir = value();
        break;
      case "--desktop-dir":
        parsed.desktopDir = value();
        break;
      case "--state-file":
        parsed.stateFile = value();
        break;
      case "--no-cache":
        flag();
        parsed.noCache = true;
        break;
      case "--no-running":
        flag();
        parsed.noRunning = true;
        break;
      default:
        throw usageError(`Unknown option ${token}. Try ccsl --help.`);
    }
  }

  if (parsed.all && daysGiven) throw usageError("Use either --all or --days, not both.");
  if (parsed.all) parsed.days = 0;

  if (positionals.length > 0) {
    const first = positionals[0];
    if (!COMMANDS.includes(first as Command)) {
      throw usageError(`Unknown command "${first}". Try ccsl --help.`);
    }
    parsed.command = first as Command;
    parsed.args = positionals.slice(1);
  }

  if (parsed.terminal && parsed.command !== "resume") {
    throw usageError("--terminal only applies to `ccsl resume`.");
  }
  if (parsed.prompt !== undefined && parsed.command !== "new") {
    throw usageError("--prompt only applies to `ccsl new`.");
  }
  if (parsed.command === "list" && parsed.args.length > 0) {
    throw usageError(`Unexpected argument "${parsed.args[0]}".`);
  }
  if (parsed.command !== "list" && parsed.args.length !== 1) {
    const what = parsed.command === "new" ? "<n|id|path>" : "<n|id>";
    throw usageError(`\`ccsl ${parsed.command}\` needs exactly one ${what}.`);
  }
  return parsed;
}

// -------------------------------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------------------------------

export interface Painter {
  dim(s: string): string;
  bold(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

export function makePainter(enabled: boolean): Painter {
  const wrap = (open: string) => (s: string) => (enabled && s ? `\x1b[${open}m${s}\x1b[0m` : s);
  return { dim: wrap("2"), bold: wrap("1"), yellow: wrap("1;33"), cyan: wrap("36") };
}

function statusLabel(s: SessionInfo): { text: string; paint: keyof Painter | null } {
  if (s.isRunning) {
    const agents = s.activeSubagents ?? 0;
    return { text: agents > 0 ? `running (${agents} ${agents === 1 ? "agent" : "agents"})` : "running", paint: "cyan" };
  }
  if (s.markedDone) return { text: "done ✓", paint: "dim" };
  switch (s.status) {
    case "needs_input":
      return { text: "needs input", paint: "yellow" };
    case "review_ready":
      return { text: "review ready", paint: "cyan" };
    case "completed":
      return { text: "done", paint: "dim" };
    default:
      return { text: "", paint: null };
  }
}

function countLabel(s: SessionInfo): string {
  if (s.source === "desktop" && s.turns !== undefined) return `${s.turns} ${s.turns === 1 ? "turn" : "turns"}`;
  if (s.messages !== undefined) return `${s.messages} ${s.messages === 1 ? "msg" : "msgs"}`;
  if (s.turns !== undefined) return `${s.turns} ${s.turns === 1 ? "turn" : "turns"}`;
  return "";
}

function prLabel(s: SessionInfo): string {
  if (s.prs.length === 0) return "";
  const pick = s.prs.find((p) => p.state?.toUpperCase() === "OPEN") ?? s.prs[0];
  let text = pick.number !== undefined ? `PR #${pick.number}` : "PR";
  const state = pick.state?.toLowerCase();
  if (state && state !== "open") text += ` ${state}`;
  if (s.prs.length > 1) text += ` +${s.prs.length - 1}`;
  return text;
}

export interface RenderOptions {
  now: number;
  color: boolean;
  columns: number;
}

/** Plain list view: one header per repo, then numbered rows. Numbering follows groups, then sessions. */
export function renderList(groups: RepoGroup[], opts: RenderOptions): string[] {
  const paint = makePainter(opts.color);
  const flat = groups.flatMap((g) => g.sessions);
  const numWidth = String(flat.length).length;

  const rows = flat.map((s) => ({
    s,
    age: relativeTime(s.lastActivity, opts.now),
    count: countLabel(s),
    status: statusLabel(s),
    extra: [prLabel(s), s.isArchived ? "archived" : ""].filter(Boolean).join(" "),
  }));
  const ageW = Math.max(3, ...rows.map((r) => r.age.length));
  const countW = Math.max(0, ...rows.map((r) => r.count.length));
  const statusW = Math.max(0, ...rows.map((r) => r.status.text.length));
  const extraW = Math.max(0, ...rows.map((r) => r.extra.length));
  const longestTitle = Math.max(0, ...rows.map((r) => r.s.title.length));
  const fixed =
    2 + numWidth + 2 + 2 + ageW + (countW ? 2 + countW : 0) + (statusW ? 2 + statusW : 0) + (extraW ? 2 + extraW : 0);
  const titleW = Math.max(12, Math.min(longestTitle, opts.columns - fixed));

  const lines: string[] = [];
  let n = 0;
  groups.forEach((g, gi) => {
    if (gi > 0) lines.push("");
    lines.push(paint.bold(g.repoName) + "  " + paint.dim(tildify(g.repoRoot)));
    for (let k = 0; k < g.sessions.length; k++) {
      const row = rows[n];
      n++;
      const cells: string[] = [
        paint.dim(String(n).padStart(numWidth)),
        truncate(row.s.title, titleW).padEnd(titleW),
        paint.dim(row.age.padStart(ageW)),
      ];
      if (countW) cells.push(paint.dim(row.count.padEnd(countW)));
      if (statusW) {
        const padded = row.status.text.padEnd(statusW);
        cells.push(row.status.paint ? paint[row.status.paint](padded) : padded);
      }
      if (extraW) cells.push(row.extra);
      lines.push("  " + cells.join("  ").trimEnd());
    }
  });
  return lines;
}

// -------------------------------------------------------------------------------------------------
// Session resolution
// -------------------------------------------------------------------------------------------------

interface Ctx {
  p: ParsedArgs;
  now: number;
}

/** The --state-file override, or undefined for the default state file. */
function stateFileOf(p: ParsedArgs): string | undefined {
  return p.stateFile ? expandHome(p.stateFile) : undefined;
}

function loadOptionsFrom(ctx: Ctx, overrides: Partial<LoadOptions> = {}): LoadOptions {
  const { p } = ctx;
  const o: LoadOptions = {
    now: ctx.now,
    days: p.days,
    includeArchived: p.archived,
    excludePaths: p.exclude,
    cacheFile: p.noCache ? null : undefined,
    detectRunning: p.noRunning ? false : undefined,
    ...overrides,
  };
  if (p.claudeDir) o.claudeDir = expandHome(p.claudeDir);
  if (p.desktopDir) o.desktopDir = expandHome(p.desktopDir);
  const stateFile = stateFileOf(p);
  if (stateFile) o.stateFile = stateFile;
  return o;
}

function describe(s: SessionInfo): string {
  return `${s.id}  ${truncate(s.title, 60)}`;
}

function matchById(all: SessionInfo[], sel: string): SessionInfo | undefined {
  const exact = all.filter((s) => s.id === sel || s.desktopId === sel || s.cliSessionId === sel);
  if (exact.length >= 1) return exact[0];
  const prefix = all.filter(
    (s) =>
      s.id.startsWith(sel) || (s.desktopId?.startsWith(sel) ?? false) || (s.cliSessionId?.startsWith(sel) ?? false),
  );
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) {
    const shown = prefix.slice(0, 5).map((s) => `  ${describe(s)}`);
    throw new CliError(
      `"${sel}" matches ${prefix.length} sessions, be more specific:\n${shown.join("\n")}${prefix.length > 5 ? "\n  ..." : ""}`,
    );
  }
  return undefined;
}

/** Resolves <n|id> to a session. Indexes use the same flags as the list; ids search everything. */
async function resolveSession(sel: string, ctx: Ctx): Promise<SessionInfo> {
  // Short all-digit selectors are list numbers, never uuid prefixes: an out-of-range number must be an
  // error, not a lucky match on some session id that happens to start with those digits.
  if (/^\d{1,7}$/.test(sel)) {
    const flat = groupByRepo(await loadSessions(loadOptionsFrom(ctx, { detectRunning: false }))).flatMap(
      (g) => g.sessions,
    );
    const n = Number(sel);
    if (n >= 1 && n <= flat.length) return flat[n - 1];
    throw new CliError(
      flat.length === 0
        ? `No session #${n}: nothing is listed with these options (try --days or --all).`
        : `No session #${n}: only ${flat.length} listed with these options (try --days or --all).`,
    );
  }
  const all = await loadSessions(loadOptionsFrom(ctx, { days: 0, includeArchived: true, detectRunning: false }));
  const found = matchById(all, sel);
  if (!found) throw new CliError(`No session matches "${sel}".`);
  return found;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `new` target: a path, a list number, or a session id (its repo root). */
async function resolveFolder(sel: string, ctx: Ctx): Promise<string> {
  const looksLikePath = sel.startsWith("/") || sel.startsWith("~") || sel.startsWith(".");
  const asPath = (raw: string): string => {
    const abs = path.resolve(expandHome(raw));
    if (!isDirectory(abs)) throw new CliError(`Not a folder: ${abs}`);
    return abs;
  };
  if (looksLikePath) return asPath(sel);
  try {
    return (await resolveSession(sel, ctx)).repoRoot;
  } catch (e) {
    if (e instanceof CliError && !/^\d{1,7}$/.test(sel) && isDirectory(path.resolve(sel))) return asPath(sel);
    throw e;
  }
}

// -------------------------------------------------------------------------------------------------
// Entry point
// -------------------------------------------------------------------------------------------------

export async function runCli(argv: string[], io: Partial<CliIO> = {}): Promise<number> {
  const out = io.out ?? ((t: string) => void process.stdout.write(t));
  const err = io.err ?? ((t: string) => void process.stderr.write(t));
  const env = io.env ?? process.env;
  const isTTY = io.isTTY ?? Boolean(process.stdout.isTTY);
  const columns = io.columns ?? process.stdout.columns ?? 100;
  const now = io.now ?? Date.now;
  const color = isTTY && !env.NO_COLOR;

  try {
    const p = parseArgs(argv);
    const ctx: Ctx = { p, now: now() };
    if (p.help) {
      out(HELP);
      return 0;
    }

    switch (p.command) {
      case "list": {
        const sessions = await loadSessions(loadOptionsFrom(ctx));
        const groups = groupByRepo(sessions);
        const flat = groups.flatMap((g) => g.sessions);
        if (p.json) {
          out(JSON.stringify(flat, null, 2) + "\n");
          return 0;
        }
        if (flat.length === 0) {
          out(
            p.days > 0 ? `No sessions in the last ${p.days} day${p.days === 1 ? "" : "s"}.\n` : "No sessions found.\n",
          );
          return 0;
        }
        const lines = renderList(groups, { now: ctx.now, color, columns });
        const paint = makePainter(color);
        const window = p.days > 0 ? `last ${p.days} day${p.days === 1 ? "" : "s"}` : "all time";
        const running = flat.filter((s) => s.isRunning).length;
        lines.push(
          "",
          paint.dim(
            `${flat.length} session${flat.length === 1 ? "" : "s"} in ${groups.length} repo${groups.length === 1 ? "" : "s"} (${window})${running > 0 ? `, ${running} running` : ""}. ccsl open|resume|url <n>`,
          ),
        );
        out(lines.join("\n") + "\n");
        return 0;
      }
      case "url": {
        const s = await resolveSession(p.args[0], ctx);
        out(desktopUrlFor(s).url + "\n");
        return 0;
      }
      case "open": {
        const s = await resolveSession(p.args[0], ctx);
        const { url, method } = await openInDesktop(s);
        out(`Opened "${truncate(s.title, 80)}" in the Claude desktop app (${method}): ${url}\n`);
        return 0;
      }
      case "resume": {
        const s = await resolveSession(p.args[0], ctx);
        const cmd = resumeCommand(s); // throws a clear error when there is no CLI session id
        const terminal = p.terminal ?? "Terminal";
        await resumeInTerminal(s, terminal);
        out(`Resuming "${truncate(s.title, 80)}" in ${terminal}: ${cmd}\n`);
        return 0;
      }
      case "done": {
        const s = await resolveSession(p.args[0], ctx);
        await markDone(s, stateFileOf(p));
        out(`Marked "${truncate(s.title, 80)}" completed. It comes back if the session has new activity.\n`);
        return 0;
      }
      case "undone": {
        const s = await resolveSession(p.args[0], ctx);
        await unmarkDone(s.id, stateFileOf(p));
        out(`Unmarked "${truncate(s.title, 80)}". Its status is back.\n`);
        return 0;
      }
      case "new": {
        const folder = await resolveFolder(p.args[0], ctx);
        await startNewDesktopSession(folder, p.prompt);
        out(`Started a new desktop session in ${tildify(folder)} (confirm the folder in the app).\n`);
        return 0;
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    err(`ccsl: ${message}\n`);
    return e instanceof CliError ? e.code : 1;
  }
}
