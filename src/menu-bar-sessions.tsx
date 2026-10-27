import {
  Color,
  getPreferenceValues,
  Icon,
  launchCommand,
  LaunchType,
  MenuBarExtra,
  openExtensionPreferences,
  showHUD,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useMemo, useState } from "react";
import { relativeTime, truncate } from "./core/format";
import { desktopNeedsInputUrl, openInDesktop, openUrl, resumeInTerminal } from "./core/handoff";
import { markDone, unmarkDone } from "./core/marks";
import type { RepoGroup, SessionInfo, TerminalApp } from "./core/types";
import { loadGroups, useActivityWindow, withoutRunning } from "./ui/data";
import {
  canMarkDone,
  countNeedsInput,
  countRunning,
  JUMP_HUD_MESSAGE,
  noSessionsTitle,
  openHudMessage,
  parseExcludePaths,
  plural,
  resumeHudMessage,
  runAction,
  SPINNER_ICON,
  statusTag,
  WINDOW_OPTIONS,
} from "./ui/helpers";

/** The menu lists at most this many sessions; the rest is one click away in the full list. */
const MAX_SESSIONS = 25;
const MAX_TITLE_LENGTH = 48;
/** Room left for the session title in the ⌥ row, after "Resume in Terminal: ". */
const MAX_ALTERNATE_TITLE_LENGTH = 28;

/** "<running>" and "<needsInput>!", e.g. "2 · 3!". Nothing when both are 0, so the icon stays on its own. */
function menuBarTitle(running: number, needsInput: number): string | undefined {
  const parts: string[] = [];
  if (running > 0) parts.push(String(running));
  if (needsInput > 0) parts.push(`${needsInput}!`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function menuBarTooltip(running: number, needsInput: number): string {
  const parts: string[] = [];
  if (running > 0) parts.push(`${plural(running, "session")} running`);
  if (needsInput > 0) parts.push(`${plural(needsInput, "session")} ${needsInput === 1 ? "needs" : "need"} input`);
  return parts.length > 0 ? `Claude Code: ${parts.join(", ")}` : "Claude Code sessions";
}

/** "Last 3 Days", "Last Day", "All Time": the current window, for the "Show" submenu title. */
function windowLabel(days: number): string {
  if (days === 0) return "All Time";
  return days === 1 ? "Last Day" : `Last ${days} Days`;
}

/** The first `limit` sessions in list order (repos by recency, sessions newest first), and how many were left out. */
function limitSessions(groups: RepoGroup[], limit: number): { groups: RepoGroup[]; hidden: number } {
  const shown: RepoGroup[] = [];
  let remaining = limit;
  let total = 0;
  for (const group of groups) {
    total += group.sessions.length;
    if (remaining === 0) continue;
    const sessions = group.sessions.slice(0, remaining);
    remaining -= sessions.length;
    shown.push(sessions.length === group.sessions.length ? group : { ...group, sessions });
  }
  return { groups: shown, hidden: total - (limit - remaining) };
}

function iconFor(session: SessionInfo): MenuBarExtra.Item.Props["icon"] {
  if (session.isRunning) return SPINNER_ICON;
  // Needs input (orange) and Review (blue) get a dot in their tag color. Every other row gets a dim one, so the titles
  // in the menu stay aligned.
  const { color } = statusTag(session);
  return color ? { source: Icon.CircleFilled, tintColor: color } : { source: Icon.Dot, tintColor: Color.SecondaryText };
}

/** The app's status lines, the full title when it was cut, and what a right-click would do. */
function tooltipFor(session: SessionInfo): string | undefined {
  const lines = [
    session.title.length > MAX_TITLE_LENGTH ? session.title : undefined,
    session.statusDetail,
    session.needsAction,
  ];
  if (session.markedDone) lines.push("Right-click to restore the status");
  else if (canMarkDone(session)) lines.push("Right-click to mark as completed");
  return lines.filter(Boolean).join("\n") || undefined;
}

function openSession(session: SessionInfo): Promise<void> {
  return runAction("Could not open session", async () => {
    const { method } = await openInDesktop(session);
    // No Raycast window is open when a menu bar item is clicked, so there is nothing to close before the HUD.
    await showHUD(openHudMessage(session, method));
  });
}

function resumeSession(session: SessionInfo, terminalApp: TerminalApp): Promise<void> {
  return runAction("Could not resume in terminal", async () => {
    await resumeInTerminal(session, terminalApp);
    await showHUD(resumeHudMessage(terminalApp));
  });
}

/** Marks a "Needs input" or "Review" session completed, or restores one marked that way. Any other session is left alone. */
async function toggleMark(session: SessionInfo, reload: () => void): Promise<void> {
  const isMarked = session.markedDone === true;
  if (!isMarked && !canMarkDone(session)) return;
  await runAction(isMarked ? "Could not restore status" : "Could not mark as completed", async () => {
    if (isMarked) await unmarkDone(session.id);
    else await markDone(session);
    reload();
    await showHUD(isMarked ? "Restored status" : "Marked completed");
  });
}

function jumpToNeedsInput(): Promise<void> {
  return runAction("Could not open Claude", async () => {
    await openUrl(desktopNeedsInputUrl());
    await showHUD(JUMP_HUD_MESSAGE);
  });
}

function openFullList(): Promise<void> {
  return runAction("Could not open the full list", () =>
    launchCommand({ name: "recent-sessions", type: LaunchType.UserInitiated }),
  );
}

interface SessionMenuItemProps {
  session: SessionInfo;
  terminalApp: TerminalApp;
  onToggleMark: (session: SessionInfo) => void;
}

/** A click opens the session in the desktop app, a right-click toggles its mark and ⌥ turns the row into "Resume in Terminal". */
function SessionMenuItem({ session, terminalApp, onToggleMark }: SessionMenuItemProps) {
  const subtitle = relativeTime(session.lastActivity);

  return (
    <MenuBarExtra.Item
      title={truncate(session.title, MAX_TITLE_LENGTH)}
      subtitle={subtitle}
      icon={iconFor(session)}
      tooltip={tooltipFor(session)}
      onAction={(event) => (event.type === "right-click" ? onToggleMark(session) : openSession(session))}
      alternate={
        // Only sessions with a Claude Code id can be resumed in a terminal.
        session.cliSessionId ? (
          <MenuBarExtra.Item
            // Holding ⌥ switches every row at once, so each one keeps its own title.
            title={`Resume in Terminal: ${truncate(session.title, MAX_ALTERNATE_TITLE_LENGTH)}`}
            subtitle={subtitle}
            icon={Icon.Terminal}
            tooltip={`Opens ${terminalApp} and runs claude --resume`}
            onAction={() => resumeSession(session, terminalApp)}
          />
        ) : undefined
      }
    />
  );
}

export default function Command() {
  const preferences = getPreferenceValues<Preferences>();
  const excludePaths = useMemo(() => parseExcludePaths(preferences.excludePaths), [preferences.excludePaths]);

  // The same cached pick as the list's dropdown, so a window chosen in either command applies to both.
  const { windowValue, days, setWindow } = useActivityWindow(preferences.defaultDays);
  const [hasLiveData, setHasLiveData] = useState(false);

  // One load per run. No polling: a background run is short-lived and Raycast starts the next one on the interval.
  const { data, isLoading, error, revalidate } = useCachedPromise(
    loadGroups,
    [days, preferences.includeArchived, excludePaths],
    {
      keepPreviousData: true,
      onData: () => setHasLiveData(true),
      // The menu reports a failed load itself; the default would toast on every user-initiated run.
      onError: () => undefined,
    },
  );

  const groups = useMemo(() => (data ? (hasLiveData ? data : withoutRunning(data)) : []), [data, hasLiveData]);
  const runningCount = useMemo(() => countRunning(groups), [groups]);
  const needsInputCount = useMemo(() => countNeedsInput(groups), [groups]);
  const visible = useMemo(() => limitSessions(groups, MAX_SESSIONS), [groups]);

  return (
    <MenuBarExtra
      icon={Icon.Terminal}
      title={menuBarTitle(runningCount, needsInputCount)}
      tooltip={menuBarTooltip(runningCount, needsInputCount)}
      isLoading={isLoading}
    >
      {error ? (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item title="Could not load sessions" icon={Icon.Warning} tooltip={error.message} />
        </MenuBarExtra.Section>
      ) : null}
      {visible.groups.length === 0 && !error ? (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item title={isLoading ? "Loading sessions…" : noSessionsTitle(days)} />
        </MenuBarExtra.Section>
      ) : null}
      {visible.groups.map((group) => (
        <MenuBarExtra.Section key={group.repoRoot} title={group.repoName}>
          {group.sessions.map((session) => (
            <SessionMenuItem
              key={session.id}
              session={session}
              terminalApp={preferences.terminalApp}
              onToggleMark={(target) => toggleMark(target, revalidate)}
            />
          ))}
        </MenuBarExtra.Section>
      ))}
      {visible.hidden > 0 ? (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item
            title={`${visible.hidden} more… Open Full List`}
            icon={Icon.List}
            onAction={openFullList}
          />
        </MenuBarExtra.Section>
      ) : null}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item title="Jump to Session Needing Input" icon={Icon.Bell} onAction={jumpToNeedsInput} />
        <MenuBarExtra.Submenu title={`Show: ${windowLabel(days)}`} icon={Icon.Calendar}>
          {WINDOW_OPTIONS.map((option) => (
            <MenuBarExtra.Item
              key={option.value}
              title={option.title}
              icon={option.value === windowValue ? Icon.Checkmark : undefined}
              onAction={() => setWindow(option.value)}
            />
          ))}
        </MenuBarExtra.Submenu>
        <MenuBarExtra.Item title="Open Full List…" icon={Icon.List} onAction={openFullList} />
        <MenuBarExtra.Item title="Refresh" icon={Icon.ArrowClockwise} onAction={() => revalidate()} />
        <MenuBarExtra.Item title="Preferences…" icon={Icon.Gear} onAction={openExtensionPreferences} />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
