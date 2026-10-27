import { environment } from "@raycast/api";
import { useCachedState } from "@raycast/utils";
import path from "node:path";
import { groupByRepo, loadSessions } from "../core/indexer";
import type { RepoGroup, SessionInfo } from "../core/types";
import { isWindowValue, parseDays } from "./helpers";

/**
 * Cache key of the activity window pick. Raycast's cache is shared by all commands of an extension, so the list's
 * dropdown and the menu bar's "Show" submenu read and write the same value.
 */
const WINDOW_CACHE_KEY = "window-days";

/** The activity window both commands use: the stored pick, else the "Default Window" preference. */
export function useActivityWindow(defaultDays: string) {
  const [storedWindow, setWindow] = useCachedState<string>(WINDOW_CACHE_KEY, defaultDays);
  const windowValue = isWindowValue(storedWindow) ? storedWindow : defaultDays;
  return { windowValue, days: parseDays(windowValue), setWindow };
}

/**
 * The indexer's metadata cache. Kept out of loadGroups on purpose: useCachedPromise keys its cache on the function's
 * source, and a bundler renames the imports a function body uses differently in each command. With the path here,
 * loadGroups reads the same in both bundles, so the two commands share their loaded results.
 */
const INDEX_CACHE_FILE = path.join(environment.supportPath, "index-v1.json");

export async function loadGroups(days: number, includeArchived: boolean, excludePaths: string[]): Promise<RepoGroup[]> {
  const sessions = await loadSessions({ days, includeArchived, excludePaths, cacheFile: INDEX_CACHE_FILE });
  return groupByRepo(sessions);
}

/**
 * Cached results keep the isRunning flags from the run that stored them, which may be long over. This drops the flags
 * until a load has landed in this run.
 */
export function withoutRunning(groups: RepoGroup[]): RepoGroup[] {
  const clear = (session: SessionInfo): SessionInfo => (session.isRunning ? { ...session, isRunning: false } : session);
  return groups.map((group) => ({ ...group, sessions: group.sessions.map(clear) }));
}
