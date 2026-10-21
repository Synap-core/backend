import { drizzleSql, focusSessions } from "@synap/database";
import type { SQL } from "@synap/database";

/**
 * Merge a sub-object into `focus_sessions.metadata` without clobbering the
 * rest of the bag — ONE helper for every session-lifecycle stamp (triage,
 * conversion receipts). JSONB `||` is a shallow merge: pass the whole
 * sub-object you want stored under its key.
 */
export function mergeSessionMetadata(patch: Record<string, unknown>): SQL {
  return drizzleSql`${focusSessions.metadata} || ${JSON.stringify(patch)}::jsonb`;
}

/** The connect-and-answer intents (`provide-connect.ts`). */
export const PROVIDE_CONNECT_META_KEY = "provideConnect";

/** The vault reads a provide answer granted for this session (`provide-secret-grant.ts`). */
export const PROVIDE_GRANTS_META_KEY = "provideGrants";

/**
 * A playbook run's turn ledger (`services/runs/run-turn-end.ts`): how each IS
 * turn ended, and the automatic-continuation count. Server-owned: an agent that
 * could reset the count could make a run continue itself forever.
 */
export const RUN_TURNS_META_KEY = "runTurns";

/**
 * The run an agent started directly, HELD until the person accepts the draft
 * (`run-playbook.ts` `startHeldRun`, B6 founder default 2026-10-21): what to
 * dispatch then. Server-owned: an agent that could write it could change what
 * the person's acceptance runs.
 */
export const HELD_RUN_META_KEY = "heldRun";

/**
 * The `focus_sessions.metadata` keys ONLY the server writes, because the
 * server decides on them: an intent that answers an ask by itself, the reads
 * revoked at close, the propose-only governance of a playbook run, the client
 * a session is bound to, the automation chain the depth floor reads, and the
 * run manifest (`run`: the sources a rerun replays, the rerun lineage, the
 * cancel record — written by `recordSessionRunManifest` and the cancel door
 * only), and the triage receipt (`triage`: the person's accept or discard of
 * an agent's draft, written by `triage.ts` only — a forged `acceptedAt` would
 * read as accepted, so the held run could never start). A client or agent
 * metadata write never carries them ({@link withoutServerOwnedSessionMetadata}).
 */
export const SERVER_OWNED_SESSION_METADATA_KEYS = [
  PROVIDE_CONNECT_META_KEY,
  PROVIDE_GRANTS_META_KEY,
  "governance",
  "clientKey",
  "automationChainContext",
  RUN_TURNS_META_KEY,
  HELD_RUN_META_KEY,
  "run",
  "triage",
] as const;

/** A client/agent metadata bag with every server-owned key dropped. Pure. */
export function withoutServerOwnedSessionMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...metadata };
  for (const key of SERVER_OWNED_SESSION_METADATA_KEYS) delete out[key];
  return out;
}

/** Shape floor for ids that reach a query — a non-uuid can never match a row. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
