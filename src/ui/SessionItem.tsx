import { Color, Icon, List } from "@raycast/api";
import { basename } from "node:path";
import { memo } from "react";
import { relativeTime, truncate } from "../core/format";
import type { SessionInfo, TerminalApp } from "../core/types";
import { SessionActions } from "./SessionActions";
import { SessionDetail } from "./SessionDetail";
import { countLabel, formatDateTime, prColor, prDescription, prLabel, SPINNER_ICON, statusTag } from "./helpers";

const MAX_BRANCH_LENGTH = 32;

function subtitleFor(session: SessionInfo): List.Item.Props["subtitle"] {
  const { branch, isWorktree, cwd } = session;
  if (!branch && !isWorktree) return undefined;
  const value = branch ? truncate(branch, MAX_BRANCH_LENGTH) : basename(cwd);
  const tooltip = isWorktree ? `Worktree: ${cwd}${branch ? `\nBranch: ${branch}` : ""}` : branch;
  return { value, tooltip };
}

function iconFor(session: SessionInfo): List.Item.Props["icon"] {
  if (session.isRunning) return { value: { source: SPINNER_ICON }, tooltip: "Turn in progress" };
  const isDesktop = session.source === "desktop";
  return {
    value: {
      source: isDesktop ? Icon.AppWindow : Icon.Terminal,
      tintColor: session.status === "needs_input" ? Color.Orange : undefined,
    },
    tooltip: isDesktop ? "Claude desktop session" : "Claude Code CLI session (no desktop entry)",
  };
}

function accessoriesFor(session: SessionInfo): List.Item.Accessory[] {
  const accessories: List.Item.Accessory[] = [];

  // Only colored statuses get a tag (Running, Needs input, Review). A session marked completed gets none; the detail
  // pane still says so.
  const { label, color } = statusTag(session);
  if (color) {
    accessories.push({
      tag: { value: label, color },
      tooltip: [session.statusDetail, session.needsAction].filter(Boolean).join("\n") || undefined,
    });
  }

  const [firstPr] = session.prs;
  if (firstPr) {
    accessories.push({
      tag: { value: prLabel(firstPr), color: prColor(firstPr) },
      tooltip: session.prs.map(prDescription).join("\n"),
    });
  }

  if (session.isArchived) {
    accessories.push({ icon: Icon.Tray, tooltip: "Archived in the Claude desktop app" });
  }

  const count = countLabel(session);
  if (count) accessories.push({ text: count });

  accessories.push({
    text: relativeTime(session.lastActivity),
    tooltip: formatDateTime(session.lastActivity),
  });

  return accessories;
}

interface SessionItemProps {
  session: SessionInfo;
  isShowingDetail: boolean;
  terminalApp: TerminalApp;
  repoMarkableCount: number;
  onToggleDetail: () => void;
  onRefresh: () => void;
  onMarkDone: (session: SessionInfo) => void;
  onUnmarkDone: (session: SessionInfo) => void;
  onMarkRepoDone: (session: SessionInfo) => void;
}

// Memoized: background polls re-render the list, and unchanged sessions (same object, see useStableValue) can skip it.
export const SessionItem = memo(function SessionItem({
  session,
  isShowingDetail,
  terminalApp,
  repoMarkableCount,
  onToggleDetail,
  onRefresh,
  onMarkDone,
  onUnmarkDone,
  onMarkRepoDone,
}: SessionItemProps) {
  const keywords = [
    session.repoName,
    session.branch,
    session.cwd,
    session.statusDetail,
    session.needsAction,
    session.cliSessionId,
    session.desktopId,
  ].filter((keyword): keyword is string => Boolean(keyword));

  return (
    <List.Item
      id={session.id}
      title={{ value: session.title, tooltip: session.title }}
      subtitle={subtitleFor(session)}
      icon={iconFor(session)}
      keywords={keywords}
      // With the detail pane open the list gets narrow, so accessories move into the pane's metadata.
      accessories={isShowingDetail ? undefined : accessoriesFor(session)}
      detail={isShowingDetail ? <SessionDetail session={session} /> : undefined}
      actions={
        <SessionActions
          session={session}
          terminalApp={terminalApp}
          repoMarkableCount={repoMarkableCount}
          onToggleDetail={onToggleDetail}
          onRefresh={onRefresh}
          onMarkDone={onMarkDone}
          onUnmarkDone={onUnmarkDone}
          onMarkRepoDone={onMarkRepoDone}
        />
      }
    />
  );
});
