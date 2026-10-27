# How it works

What CC Session Launcher reads, how it decides a session's state, and which `claude://` links it uses. Observed with Claude desktop 3.6556 and Claude Code 2.1 (October 2026). None of this is a documented API, so expect it to drift with app updates.

## Desktop session index (primary source)

`~/Library/Application Support/Claude/claude-code-sessions/<accountId>/<orgId>/local_<uuid>.json`

- One JSON file per desktop Code session. Only `local_*.json` files are read; `deleted_*` entries are skipped.
- Files are often several hundred KB, mostly MCP tool lists and prompt snapshots. The indexer skips files whose mtime is older than the window. It caches the few fields it needs, keyed by path, mtime and size, so a warm load takes a few milliseconds.

| Field | Meaning |
| --- | --- |
| `sessionId` | `local_<uuid>`, the desktop id used by deep links |
| `cliSessionId` | Claude Code session uuid: transcript file name and `claude --resume` argument |
| `priorCliSessionIds` | Older CLI ids of the same desktop session |
| `cwd` | Where the session runs; for worktrees, `<repo>/.claude/worktrees/<name>` |
| `originCwd` | The repo the session was started from, used as the grouping key |
| `title`, `titleSource` | Session title |
| `createdAt`, `lastActivityAt` | Epoch ms |
| `isArchived` | Archived in the sidebar |
| `completedTurns` | Turn count |
| `branch`, `prs[]` | Git branch and pull requests (`{ prNumber, repo, url, state }`, plus legacy `prUrl` / `prNumber` / `prState`) |
| `postTurnSummary` | `{ status_category, status_detail, needs_action }`. `blocked`, `need_input` and `failed` mean "needs input"; `review_ready` means review; `completed` means done |

## Transcripts

`~/.claude/projects/<encoded cwd>/<cliSessionId>.jsonl`. In the folder name, every character other than a letter or digit becomes `-`. Subagent transcripts live in `<cliSessionId>/subagents/agent-*.jsonl`.

The launcher uses transcripts for three things:

1. **CLI-only sessions.** Transcripts whose records don't say `entrypoint: "claude-desktop"` and whose id isn't owned by a desktop session are listed from the transcript itself. The title comes from the last `custom-title`, else the last `summary`, else the first real prompt.
2. **Terminal resume.** `claude --resume <cliSessionId>` must run from the session's `cwd`.
3. **Running detection** (below).

Unknown record types and unparseable lines are ignored.

## Running detection

A session counts as running when either of these holds:

- **Its main turn is in progress.** Two things must both be true:
  - The session's `claude` process is alive (desktop processes carry `--resume=<cliSessionId>` in their arguments) and the transcript was written in the last hour, or the transcript was written in the last 2 minutes.
  - The transcript's last deciding record is mid-turn: an `assistant` record with `stop_reason: "tool_use"` (or none yet), or a `user` record (a prompt or a tool result).

  A finished turn ends with `assistant` `end_turn` followed by `system` `stop_hook_summary`. A user record starting with `[Request interrupted by user` ends the turn too.
- **A background subagent is still working.** Its transcript hasn't reached its final report-back call or final reply, and it was written in the last 10 minutes while the parent process is alive (2 minutes otherwise).

The tail of each candidate transcript is read backwards from the last 64 KB. The window grows up to 4 MB when the end of the file is all bookkeeping records. Only sessions with a recently written transcript are checked, so `ps` runs at most once per load.

## Done-marks

"Mark as completed" stores `{ lastActivity, markedAt }` per session id in `~/Library/Application Support/cc-session-launcher/state.json`. A mark applies while the session's `lastActivity` hasn't moved past the marked value and no turn is running, so the next turn brings the app's own status back. The desktop app ties its own sidebar "completed" mark to a session timestamp in the same way, but keeps it in its UI storage, which the launcher can't read.

## Deep links

Routes handled by the desktop app's `claude://` handler:

| URL | Behaviour |
| --- | --- |
| `claude://code/continue?session=local_<uuid>` | Focuses that session. `session` must match `^local_[A-Za-z0-9-]{1,64}$`. Archived sessions aren't found; the app opens Code home instead. `session=last` opens the most recent one. |
| `claude://code/needs-input[?session=local_<uuid>]` | Opens that session, or the first one waiting on the user |
| `claude://code/new?folder=<abs path>&q=<prompt>` | New session (documented); the app asks to confirm the folder every time |
| `claude://code/search` | Opens session search |
| `claude://resume?session=<cli uuid>` | Imports a CLI session into the desktop app and opens it |

Only `claude://code/new` is documented, in [Open Claude Desktop with a link](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link). The others come from reading the app's own link handler, and may change.

## Not covered

Cloud sessions (claude.ai/code) aren't stored on disk, so they aren't listed.
