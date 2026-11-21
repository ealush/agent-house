/**
 * An error as a person reads it. A request that never reached the host fails
 * with the browser's own words ("Failed to fetch" in Chrome, "Load failed" in
 * Safari, "NetworkError when attempting to fetch resource." in Firefox), which
 * say nothing about what happened or what ah does next.
 */
export function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError && /failed to fetch|load failed|networkerror|network request failed/i.test(e.message);
}

export function errorText(e: unknown): string {
  if (isNetworkError(e)) return "The host can't be reached right now. ah keeps trying to reconnect.";
  return e instanceof Error ? e.message : String(e || 'Unknown error');
}

/** Why the live state stopped arriving, for the sidebar. */
export function reachText(e: unknown): string {
  return isNetworkError(e) ? "Can't reach the host. Reconnecting…" : `Can't reach server: ${errorText(e)}`;
}
