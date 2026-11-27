/**
 * The follow receipt on `focus_sessions.metadata` (`follow-playbook.ts`
 * writes it). A leaf, so the close door can read it without importing the
 * follow door and what it imports.
 */

/** Where the follow receipt lives on `focus_sessions.metadata`. */
export const FOLLOWED_AT_METADATA_KEY = "followedAt";
/** How the session came to follow its playbook — `"attach"` is the follow door. */
export const FOLLOWED_VIA_METADATA_KEY = "followedVia";
/** Stamped on release; the `followedAt` stays, because it happened. */
export const UNFOLLOWED_AT_METADATA_KEY = "unfollowedAt";
/**
 * Stamped at the start when an agent's door was told `templateId: null`: the
 * session never inherits its parent's playbook, at the start or later (finding
 * 42e4af30). A subject or `main red:` fact still binds; the caller can still
 * follow one itself (`followPlaybookId`).
 */
export const PARENT_PLAYBOOK_DECLINED_AT_METADATA_KEY =
  "parentPlaybookDeclinedAt";
/** The only value the follow door writes for {@link FOLLOWED_VIA_METADATA_KEY}. */
export const FOLLOWED_VIA_ATTACH = "attach";
