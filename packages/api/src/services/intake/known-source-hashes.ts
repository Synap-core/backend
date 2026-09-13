/**
 * The "already imported" ledger — which file bytes has this user already
 * brought in, and where.
 *
 * Two keys, both written by the one staging door (`stageIntakeSource`) under
 * `metadata.intakeSource`:
 *   - `fileSha256`   — plain sha256 of the bytes the pod RECEIVED (always).
 *   - `sourceSha256` — client-declared sha256 of the ORIGINAL asset, when the
 *                      client re-encoded before sending (relay: HEIC→JPEG,
 *                      2048px). A re-encode is not byte-stable, so only this
 *                      key lets a camera-roll scan recognise a photo after the
 *                      phone's own ledger is lost.
 * A lookup matches EITHER key.
 *
 * No column: `documents` has no checksum of its own (`document_versions` does,
 * but over whatever body the version stores — extracted markdown for a
 * text-only source, not the photo), so the ledger lives in the jsonb marker
 * the staging door already owns. Unindexed per-user jsonb scan: add an
 * expression index if volumes grow.
 *
 * Owner floor: every read is `documents.user_id = userId`. A hash another user
 * imported is indistinguishable from an unknown hash — never revealed.
 */

import { createHash } from "crypto";
import {
  documents as documentsTable,
  proposals as proposalsTable,
  ProposalStatus,
  and,
  eq,
  isNull,
  inArray,
  or,
  desc,
  drizzleSql,
  type db as DbType,
} from "@synap/database";

/**
 * Most file sources (photos, PDFs) one run accepts. Kept ≤ `RERUN_MAX_SOURCES`
 * so a full run can always be rerun whole (pinned by a test). A client over the
 * cap splits into a new run; the door never silently drops the rest.
 */
export const PHOTO_RUN_MAX_ITEMS = 25;

/** Max hashes one `capture.knownSourceHashes` call may ask about. */
export const KNOWN_SOURCE_HASHES_MAX = 500;

/** The ledger key: lowercase hex sha256 of the file bytes, nothing folded in. */
export function fileSha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface KnownSourceHash {
  /** The hash as ASKED (matched against either ledger key). */
  hash: string;
  sessionId: string | null;
  documentId: string;
  /**
   * `analyzed` — structuring ran on it. `kept_unanalyzed` — stored with a
   * degraded marker (vision down, budget): the bytes are on the pod, but
   * nothing was extracted, so re-sending it re-analyzes rather than dedups.
   */
  status: "analyzed" | "kept_unanalyzed";
  /**
   * The run still stands: its session holds a pending or applied proposal.
   * False once every proposal was reverted / rejected / withdrawn / expired
   * (an undone run), or when the run filed nothing at all.
   */
  inEffect: boolean;
  /** The workspace the source was captured into (`null` = pod-wide). */
  workspaceId: string | null;
}

/** Proposal states under which a run's work still stands. */
const IN_EFFECT_PROPOSAL_STATUSES = [
  ProposalStatus.PENDING,
  ProposalStatus.APPROVED,
  ProposalStatus.AUTO_APPROVED,
];

const fileHashExpr = drizzleSql<
  string | null
>`${documentsTable.metadata} #>> '{intakeSource,fileSha256}'`;
const sourceHashExpr = drizzleSql<
  string | null
>`${documentsTable.metadata} #>> '{intakeSource,sourceSha256}'`;

/**
 * The caller's own staged sources whose bytes match `hashes` (either key). One
 * entry per known hash, best first: analyzed in a run still in effect, then
 * analyzed, then kept-unanalyzed; newest within a rank.
 *
 * `workspaceId` (when passed, `null` = pod-wide) scopes the lookup to sources
 * captured into THAT workspace — the capture short-circuit's scope, so a photo
 * imported into workspace A never silences a capture into B. Unscoped (the
 * phone's camera-roll question) every workspace counts, and each entry names
 * its own.
 */
export async function findKnownSourceHashes(input: {
  database: typeof DbType;
  userId: string;
  hashes: string[];
  workspaceId?: string | null;
}): Promise<KnownSourceHash[]> {
  const wanted = [...new Set(input.hashes.map((h) => h.toLowerCase()))];
  if (wanted.length === 0) return [];
  const sessionIdExpr = drizzleSql<
    string | null
  >`${documentsTable.metadata} #>> '{intakeSource,sessionId}'`;
  const rows = await input.database
    .select({
      id: documentsTable.id,
      workspaceId: documentsTable.workspaceId,
      fileHash: fileHashExpr,
      sourceHash: sourceHashExpr,
      sessionId: sessionIdExpr,
      degraded: drizzleSql<boolean>`(${documentsTable.metadata} #> '{intakeSource,degraded}') is not null`,
      // `session_id` is uuid, the marker is text: compare as text.
      inEffect: drizzleSql<boolean>`exists (select 1 from ${proposalsTable} where ${proposalsTable.sessionId}::text = ${sessionIdExpr} and ${inArray(proposalsTable.status, IN_EFFECT_PROPOSAL_STATUSES)})`,
    })
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.userId, input.userId),
        isNull(documentsTable.deletedAt),
        or(inArray(fileHashExpr, wanted), inArray(sourceHashExpr, wanted)),
        ...(input.workspaceId === undefined
          ? []
          : [
              input.workspaceId === null
                ? isNull(documentsTable.workspaceId)
                : eq(documentsTable.workspaceId, input.workspaceId),
            ])
      )
    )
    .orderBy(desc(documentsTable.createdAt));

  const rank = (k: Pick<KnownSourceHash, "status" | "inEffect">) =>
    (k.status === "analyzed" ? 2 : 0) + (k.inEffect ? 1 : 0);
  const best = new Map<string, KnownSourceHash>();
  for (const row of rows) {
    const entry = {
      sessionId: row.sessionId ?? null,
      documentId: row.id,
      status: row.degraded
        ? ("kept_unanalyzed" as const)
        : ("analyzed" as const),
      inEffect: Boolean(row.inEffect),
      workspaceId: row.workspaceId ?? null,
    };
    for (const hash of new Set([row.fileHash, row.sourceHash])) {
      if (!hash || !wanted.includes(hash)) continue;
      const prior = best.get(hash);
      // Rows arrive newest first: a later row replaces only by a HIGHER rank.
      if (prior && rank(prior) >= rank(entry)) continue;
      best.set(hash, { hash, ...entry });
    }
  }
  return wanted.flatMap((h) => (best.has(h) ? [best.get(h)!] : []));
}

/**
 * How many FILE sources a run already holds, and whether this item (by either
 * key) is one of them — a retry of an item already in the run never counts
 * against the cap.
 */
export async function countRunFileSources(input: {
  database: typeof DbType;
  userId: string;
  sessionId: string;
  fileSha256: string;
  sourceSha256?: string;
}): Promise<{ count: number; containsHash: boolean }> {
  const rows = await input.database
    .select({ fileHash: fileHashExpr, sourceHash: sourceHashExpr })
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.userId, input.userId),
        isNull(documentsTable.deletedAt),
        drizzleSql`${documentsTable.metadata} #>> '{intakeSource,sessionId}' = ${input.sessionId}`,
        drizzleSql`${documentsTable.metadata} #>> '{intakeSource,kind}' = 'file'`
      )
    );
  const source = input.sourceSha256?.toLowerCase();
  return {
    count: rows.length,
    containsHash: rows.some(
      (r) =>
        r.fileHash === input.fileSha256 ||
        (source !== undefined && r.sourceHash === source)
    ),
  };
}

/**
 * The file source a run ALREADY holds for this capture, as a staged-blob
 * reference `capture.execute` can attach instead of uploading a second copy
 * (decision C, 2026-09-13). Matched by the structure-echoed
 * `sourceDocumentId`, or by either hash of a re-sent file.
 *
 * Only a source whose ORIGINAL bytes were kept qualifies (the stored mime is
 * the file's own, not the markdown of a text-only source): a text rendition
 * is not the user's file and must never be attached as if it were.
 * Owner-floored and run-scoped — a document id from another run or another
 * user reads as none.
 */
export async function findRunStagedSource(input: {
  database: typeof DbType;
  userId: string;
  sessionId: string;
  sourceDocumentId?: string;
  fileSha256?: string;
  sourceSha256?: string;
}): Promise<{
  documentId: string;
  storageKey: string;
  storageUrl: string;
  size: number;
  mimeType: string;
  filename?: string;
} | null> {
  const matchers = [
    input.sourceDocumentId
      ? eq(documentsTable.id, input.sourceDocumentId)
      : undefined,
    input.fileSha256
      ? drizzleSql`${fileHashExpr} = ${input.fileSha256.toLowerCase()}`
      : undefined,
    input.sourceSha256
      ? drizzleSql`${sourceHashExpr} = ${input.sourceSha256.toLowerCase()}`
      : undefined,
  ].filter((m): m is NonNullable<typeof m> => m !== undefined);
  if (matchers.length === 0) return null;

  const [row] = await input.database
    .select({
      id: documentsTable.id,
      storageKey: documentsTable.storageKey,
      storageUrl: documentsTable.storageUrl,
      size: documentsTable.size,
      mimeType: documentsTable.mimeType,
      filename: drizzleSql<
        string | null
      >`${documentsTable.metadata} #>> '{intakeSource,filename}'`,
    })
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.userId, input.userId),
        isNull(documentsTable.deletedAt),
        drizzleSql`${documentsTable.metadata} #>> '{intakeSource,sessionId}' = ${input.sessionId}`,
        drizzleSql`${documentsTable.metadata} #>> '{intakeSource,kind}' = 'file'`,
        // Bytes kept: the row stores the file's own mime, not a text rendition.
        drizzleSql`${documentsTable.mimeType} = ${documentsTable.metadata} #>> '{intakeSource,mimeType}'`,
        or(...matchers)
      )
    )
    .orderBy(desc(documentsTable.createdAt))
    .limit(1);
  if (!row?.storageKey || !row.mimeType) return null;
  return {
    documentId: row.id,
    storageKey: row.storageKey,
    storageUrl: row.storageUrl ?? "",
    size: row.size,
    mimeType: row.mimeType,
    ...(row.filename ? { filename: row.filename } : {}),
  };
}

/** The one refusal sentence; clients detect it by the `run_full:` prefix. */
export function runFullMessage(count: number): string {
  return `run_full: this run already holds ${count} files (max ${PHOTO_RUN_MAX_ITEMS}). Start a new run for the rest.`;
}
