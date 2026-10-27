import { Action, ActionPanel, Icon, Keyboard } from "@raycast/api";
import {
  desktopNeedsInputUrl,
  desktopUrlFor,
  openInDesktop,
  openUrl,
  resumeCommand,
  resumeInTerminal,
} from "../core/handoff";
import type { SessionInfo, TerminalApp } from "../core/types";
import { NewSessionForm } from "./NewSessionForm";
import {
  bestSessionId,
  canMarkDone,
  closeWithHUD,
  copyComputed,
  JUMP_HUD_MESSAGE,
  openHudMessage,
  prActionTitle,
  resumeHudMessage,
  runAction,
} from "./helpers";

/** "Jump to Session Needing Input" (⌘⇧I). Shown on every list item and in the empty view. */
export function JumpToNeedsInputAction() {
  return (
    <Action
      title="Jump to Session Needing Input"
      icon={Icon.Bell}
      shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
      onAction={() =>
        runAction("Could not open Claude", async () => {
          await openUrl(desktopNeedsInputUrl());
          await closeWithHUD(JUMP_HUD_MESSAGE);
        })
      }
    />
  );
}

interface SessionActionsProps {
  session: SessionInfo;
  terminalApp: TerminalApp;
  /** How many sessions in this session's repo could be marked completed (the "Needs input" and "Review" rows). */
  repoMarkableCount: number;
  onToggleDetail: () => void;
  onRefresh: () => void;
  onMarkDone: (session: SessionInfo) => void;
  onUnmarkDone: (session: SessionInfo) => void;
  onMarkRepoDone: (session: SessionInfo) => void;
}

export function SessionActions({
  session,
  terminalApp,
  repoMarkableCount,
  onToggleDetail,
  onRefresh,
  onMarkDone,
  onUnmarkDone,
  onMarkRepoDone,
}: SessionActionsProps) {
  const sessionId = bestSessionId(session);
  const isMarked = session.markedDone === true;
  const canToggleMark = isMarked || canMarkDone(session);
  // With a single markable session, "Mark as Completed" already covers it.
  const canMarkRepo = repoMarkableCount > 1;

  return (
    <ActionPanel>
      <ActionPanel.Section>
        <Action
          title="Open in Claude Desktop"
          icon={Icon.AppWindow}
          onAction={() =>
            runAction("Could not open session", async () => {
              const { method } = await openInDesktop(session);
              await closeWithHUD(openHudMessage(session, method));
            })
          }
        />
        {session.cliSessionId ? (
          // Second action in the panel: Raycast assigns it ⌘↵ itself.
          <Action
            title="Resume in Terminal"
            icon={Icon.Terminal}
            onAction={() =>
              runAction("Could not resume in terminal", async () => {
                await resumeInTerminal(session, terminalApp);
                await closeWithHUD(resumeHudMessage(terminalApp));
              })
            }
          />
        ) : null}
        <Action.Push
          title={`New Session in ${session.repoName}`}
          icon={Icon.Plus}
          shortcut={Keyboard.Shortcut.Common.New}
          target={<NewSessionForm repoRoot={session.repoRoot} repoName={session.repoName} />}
        />
        {session.prs.map((pr, index) => (
          <Action.OpenInBrowser
            key={pr.url}
            title={prActionTitle(pr)}
            url={pr.url}
            // Only the first PR gets the shortcut; the same one can't be bound twice.
            shortcut={index === 0 ? { modifiers: ["cmd", "shift"], key: "p" } : undefined}
          />
        ))}
      </ActionPanel.Section>

      {canToggleMark || canMarkRepo ? (
        <ActionPanel.Section>
          {canToggleMark ? (
            // One action that toggles, so the shortcut means the same on both states.
            <Action
              title={isMarked ? "Restore Status" : "Mark as Completed"}
              icon={isMarked ? Icon.ArrowCounterClockwise : Icon.CheckCircle}
              shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
              onAction={() => (isMarked ? onUnmarkDone(session) : onMarkDone(session))}
            />
          ) : null}
          {canMarkRepo ? (
            <Action title="Mark Repo as Completed" icon={Icon.CheckList} onAction={() => onMarkRepoDone(session)} />
          ) : null}
        </ActionPanel.Section>
      ) : null}

      <ActionPanel.Section title="Copy">
        {sessionId ? (
          <Action.CopyToClipboard
            title="Copy Session ID"
            content={sessionId}
            shortcut={Keyboard.Shortcut.Common.Copy}
          />
        ) : null}
        {session.cliSessionId ? (
          <Action
            title="Copy Resume Command"
            icon={Icon.Terminal}
            shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
            onAction={() => copyComputed("resume command", () => resumeCommand(session))}
          />
        ) : null}
        <Action
          title="Copy Desktop Link"
          icon={Icon.Link}
          onAction={() => copyComputed("desktop link", () => desktopUrlFor(session).url)}
        />
        <Action.CopyToClipboard title="Copy Title" content={session.title} />
      </ActionPanel.Section>

      <ActionPanel.Section title="Files">
        {session.transcriptPath ? (
          <Action.ShowInFinder title="Reveal Transcript in Finder" path={session.transcriptPath} />
        ) : null}
        <Action.ShowInFinder title="Open Folder in Finder" path={session.cwd} />
      </ActionPanel.Section>

      <ActionPanel.Section title="View">
        <Action
          title="Toggle Details"
          icon={Icon.Sidebar}
          shortcut={{ modifiers: ["cmd"], key: "d" }}
          onAction={onToggleDetail}
        />
        <Action
          title="Refresh"
          icon={Icon.ArrowClockwise}
          shortcut={Keyboard.Shortcut.Common.Refresh}
          onAction={onRefresh}
        />
      </ActionPanel.Section>

      <ActionPanel.Section>
        <JumpToNeedsInputAction />
      </ActionPanel.Section>
    </ActionPanel>
  );
}
