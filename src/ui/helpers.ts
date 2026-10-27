import { Clipboard, Color, closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import type { OpenMethod, RepoGroup, SessionInfo, SessionPR, SessionStatus, TerminalApp } from "../core/types";

/** Activity windows offered by the search bar dropdown. "0" means no limit (All). */
export const WINDOW_OPTIONS = [
  { value: "1", title: "1 day" },
  { value: "3", title: "3 days" },
  { value: "7", title: "7 days" },
  { value: "30", title: "30 days" },
  { value: "0", title: "All" },
] as const;

export function isWindowValue(value: string | undefined): value is (typeof WINDOW_OPTIONS)[number]["value"] {
  return WINDOW_OPTIONS.some((option) => option.value === value);
}

/** Dropdown value to a number of days. Anything unparseable falls back to 3. */
export function parseDays(value: string): number {
  const days = Number(value);
  return Number.isInteger(days) && days >= 0 ? days : 3;
}

/** Splits the comma-separated "Exclude Folders" preference, dropping empty entries. */
export function parseExcludePaths(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * "Turn in progress" icon: one animated GIF (12 frames). Raycast plays it itself, so the extension never re-renders to
 * animate; swapping PNG frames from a timer redrew the whole list 10 times a second and made hover flicker.
 */
export const SPINNER_ICON = "spinner.gif";

/** Sessions with a turn in progress, across all groups. */
export function countRunning(groups: RepoGroup[]): number {
  return groups.reduce((total, group) => total + group.sessions.filter((session) => session.isRunning).length, 0);
}

/** Sessions showing a "Needs input" tag across all groups. A running session shows "Running" instead, so it isn't counted. */
export function countNeedsInput(groups: RepoGroup[]): number {
  return groups.reduce(
    (total, group) =>
      total + group.sessions.filter((session) => !session.isRunning && session.status === "needs_input").length,
    0,
  );
}

/** Empty-state headline for an activity window of `days` (0 means no limit). */
export function noSessionsTitle(days: number): string {
  return days === 0 ? "No sessions" : `No sessions in the last ${days === 1 ? "day" : `${days} days`}`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "87 turns" for desktop sessions, "42 msgs" for CLI-only ones. */
export function countLabel(session: SessionInfo): string | undefined {
  if (session.turns !== undefined) return plural(session.turns, "turn");
  if (session.messages !== undefined) return plural(session.messages, "msg");
  return undefined;
}

export function statusLabel(status: SessionStatus): string {
  switch (status) {
    case "needs_input":
      return "Needs input";
    case "review_ready":
      return "Review";
    case "completed":
      return "Completed";
    default:
      return "Unknown";
  }
}

export function statusColor(status: SessionStatus): Color | undefined {
  switch (status) {
    case "needs_input":
      return Color.Orange;
    case "review_ready":
      return Color.Blue;
    default:
      return undefined;
  }
}

/**
 * The status tag for a session. While a turn is in progress it reads "Running" (blue); otherwise it is the stored
 * status, which describes the previous turn. A session marked completed in the launcher has no color, so no row tag.
 */
export function statusTag(session: SessionInfo): { label: string; color: Color | undefined } {
  if (session.isRunning) return { label: "Running", color: Color.Blue };
  if (session.markedDone) return { label: "Completed (marked)", color: undefined };
  return { label: statusLabel(session.status), color: statusColor(session.status) };
}

/**
 * Whether "Mark as Completed" applies: the row carries a "Needs input" or "Review" tag. A running session shows
 * "Running" instead, and a mark made now would expire when its turn lands, so it is left out.
 */
export function canMarkDone(session: SessionInfo): boolean {
  if (session.markedDone || session.isRunning) return false;
  return session.status === "needs_input" || session.status === "review_ready";
}

/** Applies `update` to the sessions whose id is in `ids`. Groups and sessions it does not touch keep their identity. */
export function updateSessions(
  groups: RepoGroup[] | undefined,
  ids: ReadonlySet<string>,
  update: (session: SessionInfo) => SessionInfo,
): RepoGroup[] | undefined {
  return groups?.map((group) =>
    group.sessions.some((session) => ids.has(session.id))
      ? { ...group, sessions: group.sessions.map((session) => (ids.has(session.id) ? update(session) : session)) }
      : group,
  );
}

/** Open green, merged purple, closed grey; anything else gets the default tag color. */
export function prColor(pr: SessionPR): Color | undefined {
  switch (pr.state?.toUpperCase()) {
    case "OPEN":
      return Color.Green;
    case "MERGED":
      return Color.Purple;
    case "CLOSED":
      return Color.SecondaryText;
    default:
      return undefined;
  }
}

/** The PR number from the record, or parsed from a github-style /pull/<n> URL. */
export function prNumber(pr: SessionPR): number | undefined {
  if (pr.number !== undefined) return pr.number;
  const match = /\/pull\/(\d+)/.exec(pr.url);
  return match ? Number(match[1]) : undefined;
}

export function prLabel(pr: SessionPR): string {
  const number = prNumber(pr);
  return number !== undefined ? `#${number}` : "PR";
}

/** "Open PR #123", or "Open Pull Request" when the number is unknown. */
export function prActionTitle(pr: SessionPR): string {
  const number = prNumber(pr);
  return number !== undefined ? `Open PR #${number}` : "Open Pull Request";
}

/** "owner/repo #12 (merged)" for tooltips and detail links. */
export function prDescription(pr: SessionPR): string {
  const parts = [pr.repo ? `${pr.repo} ${prLabel(pr)}` : prLabel(pr)];
  if (pr.state) parts.push(`(${pr.state.toLowerCase()})`);
  return parts.join(" ");
}

export function formatDateTime(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toLocaleString();
}

/** The most useful session id to copy: the Claude Code id, else the desktop id. */
export function bestSessionId(session: SessionInfo): string | undefined {
  return session.cliSessionId ?? session.desktopId;
}

/** Escapes characters that would change how a session title renders in markdown. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, "\\$1");
}

/** HUD text shown after handing a session off to the desktop app. */
export function openHudMessage(session: SessionInfo, method: OpenMethod): string {
  let message: string;
  switch (method) {
    case "import":
      message = "Importing CLI session into Claude";
      break;
    case "new":
      message = `Starting a new session in ${session.repoName}`;
      break;
    default:
      message = "Opening in Claude";
  }
  return session.isArchived ? `${message} (archived: opens Code home)` : message;
}

/** HUD text shown after opening a terminal to resume a session. */
export function resumeHudMessage(terminalApp: TerminalApp): string {
  return `Resuming in ${terminalApp}`;
}

/** HUD text shown after jumping to the session that needs input. */
export const JUMP_HUD_MESSAGE = "Jumping to a session that needs input";

/** Runs an async action; failures become a failure toast instead of an unhandled rejection. */
export async function runAction(failureTitle: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    await showFailureToast(error, { title: failureTitle });
  }
}

/** Closes the Raycast window and confirms with a HUD. */
export async function closeWithHUD(message: string): Promise<void> {
  await closeMainWindow();
  await showHUD(message);
}

/** Computes some text (the compute step may throw) and copies it, reporting either outcome with a toast. */
export async function copyComputed(what: string, compute: () => string): Promise<void> {
  await runAction(`Could not copy ${what}`, async () => {
    await Clipboard.copy(compute());
    await showToast({ style: Toast.Style.Success, title: `Copied ${what}` });
  });
}
