# CC Session Launcher

Jump back into your recent Claude Code sessions in one keystroke, from Raycast or the macOS menu bar.

The Claude desktop app groups Code sessions by folder. With a few dozen repos, the sessions you're actually working on get buried. CC Session Launcher lists only the sessions with activity in the last few days, grouped by repo, shows which ones are running or waiting on you, and hands you straight back into the desktop app, so its harness stays in use.

> **Unofficial.** Not affiliated with or endorsed by Anthropic. It reads files and uses `claude://` links that the Claude desktop app doesn't document, so an app update can break it. macOS only.

## Features

- **Recent sessions, grouped by repo.** Title, age, turn count, PRs and branch. Worktree sessions are grouped under their parent repo. Choose a window of 1, 3, 7 or 30 days, or All.
- **Live status.**
  - A spinner and a "Running" tag while a turn is in progress, or while the session's background subagents are still working.
  - "Needs input" and "Review" tags from the desktop app's own turn summaries.
- **One-step hand-off.**
  - Open the session in the Claude desktop app.
  - Resume it with `claude --resume` in Terminal, Ghostty or iTerm.
  - Start a new session in the same repo, with an optional prompt.
  - Jump to whichever session needs your input.
- **Mark as completed.** Clear a "Needs input" or "Review" tag you've dealt with, like marking mail read. It comes back by itself if the session has new activity.
- **Three ways to use it:**
  - A Raycast command with search.
  - A Raycast menu bar item, where one click opens a session.
  - A `ccsl` CLI.
- **Read-only.** It never writes to `~/.claude` or the desktop app's files.

## Requirements

- macOS, with the [Claude desktop app](https://claude.ai/download) and Code sessions in it. Sessions started from the `claude` CLI are listed too.
- Node.js 22 or newer.
- [Raycast](https://www.raycast.com/) for the list and the menu bar (`brew install --cask raycast`). The CLI works without it.

Tested with Claude desktop 3.6556, Claude Code 2.1, and Raycast 1.104.

## Install

```bash
git clone https://github.com/ricardotei/cc-session-launcher.git
cd cc-session-launcher
npm install
npm run dev
```

`npm run dev` builds the extension and adds it to Raycast, which keeps it after you stop the command (Ctrl+C). Run it again after pulling updates.

Then, in Raycast:

1. Search **Recent Claude Sessions** to open the list.
2. Give it a hotkey: Raycast Settings (⌘,) → Extensions → Recent Claude Sessions → Record Hotkey.
3. Run **Claude Sessions in Menu Bar** once to switch on the menu bar item.

## Usage

### Raycast list

| Key | Action |
| --- | --- |
| ↵ | Open in Claude Desktop |
| ⌘↵ | Resume in Terminal |
| ⌘N | New session in this repo, with an optional prompt |
| ⌘⇧D | Mark as completed, or restore the status |
| ⌘⇧I | Jump to the session needing input |
| ⌘⇧P | Open the session's pull request |
| ⌘⇧C / ⌘⇧R | Copy session ID / copy resume command |
| ⌘D | Toggle details (status summary, branch, PRs, ids) |
| ⌘R | Refresh |

- The dropdown next to the search field sets the window and remembers your choice.
- The list refreshes itself every 3 s while a session is running, and every 15 s otherwise.
- **Preferences:** default window, terminal app, show archived sessions, and folders to hide.

### Menu bar

The menu bar item shows `2 · 3!`: 2 sessions have a turn in progress and 3 are waiting on you. When both are 0 it shows only the icon.

- **Click** a session to open it in Claude Desktop.
- **Right-click** to mark it completed or restore its status.
- **⌥-click** to resume it in a terminal.

The footer has Jump to Session Needing Input, the activity window (shared with the list), Open Full List, Refresh and Preferences.

If the icon doesn't appear, your menu bar is probably full. macOS hides the newest icons behind the notch: free some space, then ⌘-drag the icon toward the clock.

### CLI

```bash
npm run build:cli
ln -s "$PWD/bin/ccsl" ~/.local/bin/ccsl   # optional: put it on your PATH
ccsl
```

```
acme-api  ~/code/acme-api
   1  Fix flaky payment webhook test               now  12 turns  running
   2  Add rate limiting to /v2/orders              25m  8 turns   needs input   PR #142
web-dashboard  ~/code/web-dashboard
   3  Dark mode for the settings page               2h  5 turns   review ready  PR #87 +1
   4  Upgrade to React 19                           1d  21 turns  done ✓

4 sessions in 2 repos (last 3 days), 1 running. ccsl open|resume|url <n>
```

| Command | Does |
| --- | --- |
| `ccsl [--days N \| --all] [--archived] [--exclude a,b] [--json]` | List sessions (default: last 3 days) |
| `ccsl open <n>` | Open that session in the Claude desktop app |
| `ccsl resume <n> [--terminal Terminal\|Ghostty\|iTerm]` | `claude --resume` in a new terminal window, in the session's folder |
| `ccsl new <n\|path> [--prompt "..."]` | New desktop session in that repo |
| `ccsl done <n>` / `ccsl undone <n>` | Mark completed / restore the status |
| `ccsl url <n>` | Print the desktop link without opening it |

`<n>` is the number from the list, so pass the same `--days` again. A `local_…` desktop id or a session uuid also works.

## How it works

| Source | Gives |
| --- | --- |
| `~/Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json` | Desktop sessions: title, last activity, repo, branch, PRs, turn count, and the "needs input" / "review" status |
| `~/.claude/projects/*/*.jsonl` | Transcripts: sessions started from the CLI, and whether a turn is still in progress |
| `ps` | Which sessions have a live `claude` process (it carries `--resume=<session id>`) |

| Action | How |
| --- | --- |
| Open in Claude Desktop | `claude://code/continue?session=local_…` |
| Open a CLI-only session | `claude://resume?session=<uuid>` (imports it into the desktop app) |
| New session | `claude://code/new?folder=…&q=…` (the app asks you to confirm the folder) |
| Jump to the session needing input | `claude://code/needs-input` |
| Resume in a terminal | `cd <cwd> && claude --resume <uuid>` |

[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) has the field map, the running-detection rules, and the deep links (`claude://code/continue` isn't documented by Anthropic; it was found in the desktop app's own link handler).

## Privacy

- **Read-only on Claude's data.** It only reads the desktop app's session index and the `~/.claude/projects` transcripts.
- **What it writes:**
  - A metadata cache: titles, timestamps and status, with no prompt or tool content, file mode 0600. It lives in `~/Library/Caches/cc-session-launcher/` for the CLI and Raycast's support folder for the extension.
  - Your done-marks: session ids and timestamps, in `~/Library/Application Support/cc-session-launcher/state.json`.
- **No network calls.** Everything stays on your Mac.

## Limitations

- **Unofficial routes.** `claude://code/continue` and the session index layout aren't public APIs and may change with a desktop app update.
- **Archived sessions** can't be focused by link; the app opens Code home instead.
- **Cloud sessions** (claude.ai/code) aren't stored on disk, so they aren't listed.
- **Resume in Terminal** needs the session's transcript. Claude Code deletes transcripts after `cleanupPeriodDays` (default 30); raise it in `~/.claude/settings.json` if you want older sessions to stay resumable.
- **Done-marks are local.** They don't sync to the desktop app's sidebar.
- **Permission prompts look like running.** A session waiting on a permission prompt shows as running, for up to an hour.

## Development

```bash
npm test            # node:test suites on synthetic fixtures
npm run typecheck   # needs raycast-env.d.ts, generated by the first `npm run dev` or `npm run build`
npm run build       # ray build
npm run build:cli   # bundles the CLI into dist-cli/ccsl.cjs
```

- **Layout:**
  - `src/core/` is plain Node: indexer, cache, live detection, marks, hand-off.
  - `src/cli-app.ts` is the CLI.
  - `src/recent-sessions.tsx`, `src/menu-bar-sessions.tsx` and `src/ui/` are the Raycast commands.
- **`npm run lint`** (`ray lint`) checks that `author` in `package.json` is a Raycast Store username. Running the extension locally doesn't need it.

Issues and pull requests are welcome, especially reports when a Claude desktop update changes the session index or the links.

## License

[MIT](LICENSE)
