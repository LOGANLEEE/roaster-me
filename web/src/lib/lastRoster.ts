const STORAGE_KEY = "roster-viewing-user";

/**
 * Whose roster was on screen when she last closed the app.
 *
 * Reopening used to snap back to her own calendar every time. If she is following someone
 * else's roster — which is the whole point of the crew feature, and the state she is most
 * likely to leave the app in — that is the one thing she did not ask for.
 *
 * Stores only a user id she is already paired with, and the id is not a credential: every
 * crew read is authorised server-side against the pairing, so a tampered value gets a 404
 * rather than someone else's roster. What it CAN do is name a pairing that has since been
 * revoked, which is why the caller re-checks it against the crew list and falls back.
 *
 * Every access is wrapped: `localStorage` throws outright in private-mode WebKit, and a
 * calendar that cannot render because a preference could not be read is a worse bug than
 * forgetting which roster she was on.
 */

/** The last roster she was reading, or null for her own. */
export function getLastRoster(): string | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

/** Remembers whose roster is on screen. `null` (her own) clears the key rather than storing
 *  a sentinel, so "never chose anyone" and "chose herself" read the same on the way back. */
export function setLastRoster(userId: string | null): void {
  try {
    if (userId === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, userId);
  } catch {
    // Ignore: this is a convenience, never a correctness requirement.
  }
}
