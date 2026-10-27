import { Icon, List } from "@raycast/api";
import type { SessionInfo } from "../core/types";
import { tildify } from "../core/format";
import { escapeMarkdown, formatDateTime, prDescription, statusTag } from "./helpers";

function detailMarkdown(session: SessionInfo): string {
  const blocks = [`# ${escapeMarkdown(session.title)}`];
  // Marked completed: the app's summary is kept for context, labelled as the last one.
  if (session.statusDetail) {
    const detail = escapeMarkdown(session.statusDetail);
    blocks.push(session.markedDone ? `**Last summary:** ${detail}` : detail);
  }
  if (session.needsAction) {
    const label = session.markedDone ? "Last needs action" : "Needs action";
    blocks.push(`**${label}:** ${escapeMarkdown(session.needsAction)}`);
  }
  return blocks.join("\n\n");
}

export function SessionDetail({ session }: { session: SessionInfo }) {
  const { Metadata } = List.Item.Detail;
  const created = formatDateTime(session.createdAt);
  const { label, color } = statusTag(session);
  const isMarked = session.markedDone === true;

  return (
    <List.Item.Detail
      markdown={detailMarkdown(session)}
      metadata={
        <Metadata>
          <Metadata.TagList title="Status">
            <Metadata.TagList.Item text={label} color={color} />
          </Metadata.TagList>
          {session.statusDetail ? (
            <Metadata.Label title={isMarked ? "Last Summary" : "Status Detail"} text={session.statusDetail} />
          ) : null}
          {session.needsAction ? (
            <Metadata.Label
              title={isMarked ? "Last Needs Action" : "Needs Action"}
              text={session.needsAction}
              // Marked sessions no longer ask for anything, so the alert icon would mislead.
              icon={isMarked ? undefined : Icon.ExclamationMark}
            />
          ) : null}
          <Metadata.Separator />
          <Metadata.Label title="Repo" text={session.repoName} />
          <Metadata.Label title="Folder" text={tildify(session.cwd)} />
          {session.branch ? <Metadata.Label title="Branch" text={session.branch} /> : null}
          <Metadata.Label title="Worktree" text={session.isWorktree ? "Yes" : "No"} />
          {session.model ? <Metadata.Label title="Model" text={session.model} /> : null}
          <Metadata.Separator />
          {session.turns !== undefined && <Metadata.Label title="Turns" text={String(session.turns)} />}
          {session.messages !== undefined && <Metadata.Label title="Messages" text={String(session.messages)} />}
          <Metadata.Label title="Last Activity" text={formatDateTime(session.lastActivity) ?? ""} />
          {created ? <Metadata.Label title="Created" text={created} /> : null}
          {session.prs.length > 0 ? <Metadata.Separator /> : null}
          {session.prs.map((pr, index) => (
            <Metadata.Link
              key={pr.url}
              title={session.prs.length > 1 ? `Pull Request ${index + 1}` : "Pull Request"}
              target={pr.url}
              text={prDescription(pr)}
            />
          ))}
          <Metadata.Separator />
          {session.desktopId ? <Metadata.Label title="Desktop ID" text={session.desktopId} /> : null}
          {session.cliSessionId ? <Metadata.Label title="CLI Session ID" text={session.cliSessionId} /> : null}
          <Metadata.Label title="Archived" text={session.isArchived ? "Yes" : "No"} />
        </Metadata>
      }
    />
  );
}
