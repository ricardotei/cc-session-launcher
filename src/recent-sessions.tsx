import {
  Action,
  ActionPanel,
  getPreferenceValues,
  Icon,
  List,
  openExtensionPreferences,
  showToast,
  Toast,
} from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tildify, truncate } from "./core/format";
import { markDone, unmarkDone } from "./core/marks";
import type { SessionInfo, SessionStatus } from "./core/types";
import { SessionItem } from "./ui/SessionItem";
import { JumpToNeedsInputAction } from "./ui/SessionActions";
import { loadGroups, useActivityWindow, withoutRunning } from "./ui/data";
import {
  canMarkDone,
  countRunning,
  isWindowValue,
  noSessionsTitle,
  parseExcludePaths,
  plural,
  updateSessions,
  WINDOW_OPTIONS,
} from "./ui/helpers";

const COMMAND_TITLE = "Recent Claude Sessions";

/** Background refresh cadence: quick while a turn is in progress, so spinners start and stop promptly. */
const POLL_RUNNING_MS = 3000;
const POLL_IDLE_MS = 15000;

/** Calls `callback` every `delayMs` until unmount. A null delay pauses it. The latest callback is always the one called. */
function useInterval(callback: () => void, delayMs: number | null) {
  const latest = useRef(callback);
  latest.current = callback;

  useEffect(() => {
    if (delayMs === null) return;
    const timer = setInterval(() => latest.current(), delayMs);
    return () => clearInterval(timer);
  }, [delayMs]);
}

/**
 * Keeps returning the previous value while `value` serializes the same. A background poll that finds nothing new then
 * hands React the same objects, memoized items skip rendering, and Raycast has nothing to redraw (no hover flicker).
 */
function useStableValue<T>(value: T): T {
  const ref = useRef<{ value: T; json: string } | null>(null);
  const json = JSON.stringify(value);
  if (ref.current === null || ref.current.json !== json) ref.current = { value, json };
  return ref.current.value;
}

/**
 * Writes the marks one after the other: each write reads and rewrites the shared state file, and two at once could
 * lose one of them.
 */
async function writeMarks(sessions: SessionInfo[], done: boolean): Promise<void> {
  for (const session of sessions) {
    if (done) await markDone(session);
    else await unmarkDone(session.id);
  }
}

function WindowDropdown({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <List.Dropdown
      tooltip="Activity Window"
      value={value}
      // The caller persists the pick in useCachedState, shared with the menu bar command. No storeValue: Raycast's own
      // restore could fire onChange on open and overwrite a window picked in the menu bar.
      onChange={(next) => {
        if (isWindowValue(next)) onChange(next);
      }}
    >
      {WINDOW_OPTIONS.map((option) => (
        <List.Dropdown.Item key={option.value} title={option.title} value={option.value} />
      ))}
    </List.Dropdown>
  );
}

interface EmptyStateProps {
  days: number;
  error?: Error;
  onShowThirtyDays: () => void;
  onRefresh: () => void;
}

function EmptyState({ days, error, onShowThirtyDays, onRefresh }: EmptyStateProps) {
  const title = error ? "Could not load sessions" : noSessionsTitle(days);

  return (
    <List.EmptyView
      icon={error ? Icon.Warning : Icon.Terminal}
      title={title}
      description={
        error
          ? error.message
          : "Sessions from the Claude desktop app and the Claude Code CLI show up here. Check the extension preferences if folders are hidden."
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            {!error && days !== 0 && days < 30 ? (
              <Action title="Show Last 30 Days" icon={Icon.Calendar} onAction={onShowThirtyDays} />
            ) : null}
            <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={onRefresh} />
          </ActionPanel.Section>
          <ActionPanel.Section>
            <JumpToNeedsInputAction />
            <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

export default function Command() {
  const preferences = getPreferenceValues<Preferences>();
  const excludePaths = useMemo(() => parseExcludePaths(preferences.excludePaths), [preferences.excludePaths]);

  const { windowValue, days, setWindow: setStoredWindow } = useActivityWindow(preferences.defaultDays);

  const [isShowingDetail, setIsShowingDetail] = useState(false);
  const [hasLiveData, setHasLiveData] = useState(false);
  // Raised by background polls so the loading bar stays hidden. The first load, ⌘R and a window change leave it down.
  const isSilentRef = useRef(false);

  const { data, isLoading, error, revalidate, mutate } = useCachedPromise(
    loadGroups,
    [days, preferences.includeArchived, excludePaths],
    {
      keepPreviousData: true,
      onData: () => {
        isSilentRef.current = false;
        setHasLiveData(true);
      },
      onError: (loadError) => {
        const wasSilent = isSilentRef.current;
        isSilentRef.current = false;
        // A failing background poll must not toast every few seconds.
        if (!wasSilent) showFailureToast(loadError, { title: "Could not load sessions" });
      },
    },
  );

  const groups = useStableValue(
    useMemo(() => (data ? (hasLiveData ? data : withoutRunning(data)) : []), [data, hasLiveData]),
  );
  const runningCount = useMemo(() => countRunning(groups), [groups]);
  const hasRunning = runningCount > 0;

  // A window or preference change starts a regular load, which must not inherit the silence of a poll in flight.
  useEffect(() => {
    isSilentRef.current = false;
  }, [days, preferences.includeArchived, excludePaths]);

  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const showLoading = isLoading && !isSilentRef.current;
  // Marks being written. A poll that read the state file meanwhile would put the old status over the optimistic one.
  const writesInFlightRef = useRef(0);

  // Keeps running/finished state live. revalidate() cancels the call in flight, so a poll never starts over a load that
  // is still going: a load slower than the interval would otherwise never land.
  useInterval(
    () => {
      if (isLoadingRef.current || writesInFlightRef.current > 0) return;
      isSilentRef.current = true;
      revalidate();
    },
    hasRunning ? POLL_RUNNING_MS : POLL_IDLE_MS,
  );

  const refresh = useCallback(() => {
    isSilentRef.current = false;
    revalidate();
  }, [revalidate]);
  const toggleDetail = useCallback(() => setIsShowingDetail((showing) => !showing), []);

  // Read by the mark callbacks below, so they stay stable and memoized rows aren't redrawn by every data change.
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  // The status each session had when it was marked here. A restore can then bring the tag back at once; for a mark
  // made elsewhere (the CLI, an earlier run) the status isn't known, and the reload after the restore supplies it.
  const statusBeforeMarkRef = useRef(new Map<string, SessionStatus>());

  /**
   * Marks sessions completed, or restores them. The rows change at once (optimistic update); the file write follows,
   * then the reload brings in what the core reports. A failed write rolls the rows back.
   */
  const setMarks = useCallback(
    async (targets: SessionInfo[], done: boolean) => {
      if (targets.length === 0) return;
      const ids = new Set(targets.map((session) => session.id));
      // Unlike a poll, the reload after a mark shows the loading bar and reports its failures.
      isSilentRef.current = false;
      writesInFlightRef.current += 1;
      try {
        await mutate(writeMarks(targets, done), {
          optimisticUpdate: (current) =>
            updateSessions(current, ids, (session) =>
              done
                ? { ...session, markedDone: true, status: "completed" }
                : {
                    ...session,
                    markedDone: false,
                    status: statusBeforeMarkRef.current.get(session.id) ?? session.status,
                  },
            ),
        });
      } catch (markError) {
        await showFailureToast(markError, { title: done ? "Could not mark as completed" : "Could not restore status" });
        return;
      } finally {
        writesInFlightRef.current -= 1;
      }

      if (!done) {
        for (const id of ids) statusBeforeMarkRef.current.delete(id);
        await showToast({ style: Toast.Style.Success, title: "Restored status" });
        return;
      }
      for (const session of targets) statusBeforeMarkRef.current.set(session.id, session.status);
      const [first] = targets;
      await showToast({
        style: Toast.Style.Success,
        title: targets.length === 1 ? "Marked completed" : `Marked ${plural(targets.length, "session")} completed`,
        message: targets.length === 1 ? truncate(first.title, 80) : first.repoName,
        primaryAction: {
          title: "Undo",
          onAction: (toast) => {
            void toast.hide();
            void setMarks(targets, false);
          },
        },
      });
    },
    [mutate],
  );
  const onMarkDone = useCallback((session: SessionInfo) => setMarks([session], true), [setMarks]);
  const onUnmarkDone = useCallback((session: SessionInfo) => setMarks([session], false), [setMarks]);
  const onMarkRepoDone = useCallback(
    (session: SessionInfo) => {
      const group = groupsRef.current.find((candidate) => candidate.repoRoot === session.repoRoot);
      return setMarks(group ? group.sessions.filter(canMarkDone) : [], true);
    },
    [setMarks],
  );

  return (
    <List
      isLoading={showLoading}
      navigationTitle={hasRunning ? `${COMMAND_TITLE} · ${runningCount} running` : undefined}
      isShowingDetail={isShowingDetail}
      searchBarPlaceholder="Filter sessions by title, repo, branch…"
      searchBarAccessory={<WindowDropdown value={windowValue} onChange={setStoredWindow} />}
    >
      {groups.map((group) => (
        <List.Section
          key={group.repoRoot}
          title={group.repoName}
          subtitle={`${tildify(group.repoRoot)} · ${plural(group.sessions.length, "session")}`}
        >
          {group.sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isShowingDetail={isShowingDetail}
              terminalApp={preferences.terminalApp}
              repoMarkableCount={group.sessions.filter(canMarkDone).length}
              onToggleDetail={toggleDetail}
              onRefresh={refresh}
              onMarkDone={onMarkDone}
              onUnmarkDone={onUnmarkDone}
              onMarkRepoDone={onMarkRepoDone}
            />
          ))}
        </List.Section>
      ))}
      {groups.length === 0 && !showLoading ? (
        <EmptyState days={days} error={error} onShowThirtyDays={() => setStoredWindow("30")} onRefresh={refresh} />
      ) : null}
    </List>
  );
}
