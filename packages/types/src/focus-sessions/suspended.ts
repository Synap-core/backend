/**
 * `focus_sessions.metadata.suspended` — the PUSH note, read safely.
 *
 * `recordSessionSpawn` (`@synap/database`'s `session-spawn.ts`) shallow-merges
 * `{ suspended: { intent, childSessionId, at } }` onto the **PARENT** when a
 * detour is opened: "you were about to do X here, and you pushed that child
 * down to clear the way". The note describes the LAST push — `||` on jsonb
 * replaces the key wholesale — which is why {@link readSuspendedNote} hands
 * back `childSessionId` rather than the intent alone. A reader restating the
 * intent for a detour the note does NOT name would be showing a line about a
 * different, later push.
 *
 * `metadata` is jsonb: nothing types its interior, so every level is narrowed
 * here and an unexpected shape reads as "no note" — never a throw, never a
 * partially-trusted object.
 *
 * THE ONLY NARROWING. `browser`'s `goalStackStore.readSuspendedIntent` held a
 * second full copy until 2026-09-20 and now delegates here, keeping only the
 * `.metadata` hop. Two readings of one jsonb shape is the fork class, and this
 * note is where it would hurt most: the parent's line names which work was put
 * down, so a surface that narrows it differently from the pod states the wrong
 * thing confidently. If a third reader appears, it imports this — it does not
 * re-narrow.
 */

/** The push note, with every field narrowed. */
export interface SuspendedNote {
  /** One line: what the session was about to do when it was put down. */
  intent: string;
  /** The detour that was opened. `null` when the note recorded none. */
  childSessionId: string | null;
  /** ISO timestamp of the push. `null` when the note recorded none. */
  at: string | null;
}

/**
 * The suspended note on a session's `metadata`, or `undefined` for every shape
 * that is not the one `session-spawn.ts` writes (including a blank intent — a
 * note with nothing to say is not a note).
 */
export function readSuspendedNote(
  metadata: unknown
): SuspendedNote | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const suspended = (metadata as { suspended?: unknown }).suspended;
  if (!suspended || typeof suspended !== "object") return undefined;
  const raw = suspended as {
    intent?: unknown;
    childSessionId?: unknown;
    at?: unknown;
  };
  if (typeof raw.intent !== "string") return undefined;
  const intent = raw.intent.trim();
  if (intent === "") return undefined;
  return {
    intent,
    childSessionId:
      typeof raw.childSessionId === "string" && raw.childSessionId !== ""
        ? raw.childSessionId
        : null,
    at: typeof raw.at === "string" && raw.at !== "" ? raw.at : null,
  };
}

/** The intent alone, for callers that do not care which detour it names. */
export function readSuspendedIntent(metadata: unknown): string | undefined {
  return readSuspendedNote(metadata)?.intent;
}
