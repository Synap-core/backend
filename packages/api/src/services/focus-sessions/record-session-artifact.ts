/**
 * recordSessionArtifact — the ONE producer door for "this session made that".
 *
 * The read side (`session-outputs.ts`) joins three ledgers, but two agent write
 * doors were writing into NONE of them:
 *
 *   - `synap_create_document` created a document and stopped. `documents` has
 *     no `sessionId` column and `links` has no `document` endpoint type, so
 *     there was no coordinate anywhere tying the doc to the session that asked
 *     for it. Every agent-authored document was invisible to its own session.
 *   - `synap_store_file` threaded `sessionId` all the way into
 *     `createGovernedFileEntityFromBuffer` — where it lands on the PROPOSAL,
 *     not on any output ledger. An auto-approved store therefore produced a
 *     `file` entity nothing could attribute to the session.
 *
 * `artifacts` is the only ledger that can hold both (its `kind` enum already
 * covers document and entity, and it carries `sessionId` + provenance), so this
 * writes there. It deliberately does NOT add a `file` kind: a stored file IS a
 * `file`-profile ENTITY, and `kind: "entity"` is what it actually references.
 *
 * BEST-EFFORT BY CONTRACT: a provenance row must never fail the write that
 * produced it. Errors are logged and swallowed, exactly like the `produced`
 * edge writers (`channel-origin.ts`, `entities/create.ts`).
 */

import {
  db,
  artifacts,
  and,
  asc,
  eq,
  drizzleSql,
  focusSessions,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "session-artifact" });

/**
 * What an output may reference — READ OFF the column, not retyped beside it.
 *
 * This was a hand-written literal directly under a comment claiming it was
 * "the SAME values `artifacts.kind` declares", which is the shape every
 * hand-mirrored enum in this repo has had right up until it drifted. It is now
 * `artifacts.kind.enumValues`, so widening the column IS widening both write
 * doors (tRPC `focusSessions.attachOutput`, Hub REST
 * `POST /focus-sessions/:id/outputs`), and no tripwire is needed to keep two
 * lists honest because there is only one list.
 */
export const SESSION_ARTIFACT_KINDS = artifacts.kind.enumValues;
export type SessionArtifactKind = (typeof SESSION_ARTIFACT_KINDS)[number];

export interface RecordSessionArtifactParams {
  /** The session to attribute to. No session ⇒ nothing to record. */
  sessionId: string | null | undefined;
  /**
   * The lens the row is filed under, or `null` for a POD-PERSONAL output — the
   * honest model `focus_sessions` / `entities` / `documents` already use. Not a
   * reason to drop the row (it was, until 0245 made the column nullable).
   */
  workspaceId: string | null | undefined;
  /** Owner — the human principal, even when an agent acted for them. */
  userId: string;
  /** What the artifact references. `file` is not a kind — a stored file is an entity. */
  kind: SessionArtifactKind;
  /** The UNDERLYING object's id — what the room navigates with. */
  refId: string;
  title: string;
  /** Present ⇒ an agent produced this, and the ledger says so. */
  agentUserId?: string | null;
  /**
   * The DECLARED deliverable this object is being recorded against, by label.
   *
   * Written into `artifacts.props.expectedLabel` and read back by
   * `session-outputs.ts` so a human-attached output joins the slot the person
   * MEANT, not merely the first declared output of the same kind. It is a
   * CLAIM about which slot, never a `done` stamp — only
   * `satisfy-expected-output.ts` may write `status: "done"`.
   */
  expectedLabel?: string | null;
  /**
   * Where the output lands. Omitted ⇒ `desk` only when the session DECLARED
   * an expected output of this kind (the person asked for it), else `library`
   * — an agent that writes twenty files must not bury the desk under them.
   */
  placement?: "desk" | "home" | "sidebar" | "library";
}

/**
 * The row that already holds this exact claim — the same key
 * `artifacts_session_ref_unique` enforces, including the declared-slot label
 * (`COALESCE(props->>'expectedLabel','')`), because the same object may
 * legitimately satisfy two different declared outputs.
 *
 * `asc(createdAt)` so a pre-0246 table that still carries duplicates answers
 * with the ORIGINAL row rather than an arbitrary one — the same survivor the
 * migration's dedupe keeps.
 */
async function findExistingArtifact(params: {
  sessionId: string;
  kind: SessionArtifactKind;
  refId: string;
  expectedLabel?: string | null;
}): Promise<{ id: string } | undefined> {
  const { sessionId, kind, refId, expectedLabel } = params;
  return db.query.artifacts.findFirst({
    where: and(
      eq(artifacts.sessionId, sessionId),
      eq(artifacts.kind, kind),
      eq(artifacts.refId, refId),
      drizzleSql`COALESCE(${artifacts.props}->>'expectedLabel', '') = ${expectedLabel ?? ""}`
    ),
    orderBy: [asc(artifacts.createdAt)],
    columns: { id: true },
  });
}

async function sessionDeclaresKind(
  sessionId: string,
  kind: RecordSessionArtifactParams["kind"]
): Promise<boolean> {
  const row = await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, sessionId),
    columns: { expectedOutputs: true },
  });
  const declared = (row?.expectedOutputs ?? []) as Array<{ kind?: string }>;
  return declared.some((o) => o.kind === kind);
}

/**
 * Record one session output. No-ops (silently) without a session or a `refId`:
 * with no session there is nothing to attribute to, and with no `refId` there is
 * nothing to navigate to.
 *
 * A NULL `workspaceId` is NOT a no-op — it is the pod-personal case, and since
 * 0245 `artifacts.workspace_id` is nullable exactly so it can be recorded. The
 * access layer floors a NULL-workspace artifact to `userId` (the `ownerPrivate`
 * rule in `access/registry.ts`), the same way it floors a pod-personal session,
 * entity or document. Most of a founder's sessions have no workspace; refusing
 * their outputs turned the session room off for the majority of sessions.
 *
 * Returns the new artifact row id, or `null` when it no-opped OR the write was
 * swallowed. Agent callers ignore it (best-effort by contract, above); the
 * HUMAN door (`focusSessions.attachOutput`) reads it, because a person who
 * clicked "record this as an output" must not be told `ok` for a row that was
 * never written.
 */
export async function recordSessionArtifact(
  params: RecordSessionArtifactParams
): Promise<string | null> {
  const {
    sessionId,
    workspaceId,
    userId,
    kind,
    refId,
    title,
    agentUserId,
    expectedLabel,
  } = params;
  if (!sessionId || !refId) return null;
  try {
    const placement =
      params.placement ??
      ((await sessionDeclaresKind(sessionId, kind)) ? "desk" : "library");
    const [row] = await db
      .insert(artifacts)
      .values({
        workspaceId: workspaceId ?? null,
        userId,
        kind,
        refId,
        title,
        originKind: agentUserId ? "agent" : "user",
        actorId: agentUserId ?? null,
        sessionId,
        state: "working",
        placement,
        ...(expectedLabel ? { props: { expectedLabel } } : {}),
      })
      // IDEMPOTENT (0246). A retry after a failed request, or a double-click on
      // "record this as an output", used to write a SECOND row asserting the
      // same fact — and the room then listed the object twice. No conflict
      // TARGET: `artifacts_session_ref_unique` is an expression index, which
      // drizzle cannot name cleanly (the same reason
      // `automations_workspace_name_active_uq` re-selects instead of
      // ON CONFLICT). A bare DO NOTHING covers it.
      .onConflictDoNothing()
      .returning({ id: artifacts.id });
    if (row?.id) return row.id;

    // DO NOTHING returns no row. The caller asked "is this recorded?", and the
    // answer is yes — by the row that won the race. Returning null here would
    // report the honest, successful, idempotent case as a FAILURE: the human
    // door turns null into "Could not record the session output", so a retry
    // after a timeout would have shown an error over a ledger that was already
    // correct.
    return (
      (await findExistingArtifact({ sessionId, kind, refId, expectedLabel }))
        ?.id ?? null
    );
  } catch (err) {
    logger.warn(
      { err, sessionId, kind, refId },
      "session-artifact: output ledger write failed (non-fatal)"
    );
    return null;
  }
}
