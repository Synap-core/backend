import { drizzleSql, focusSessions } from "@synap/database";
import type { SQL } from "@synap/database";
import { CHECK_GATE_METADATA_KEY } from "@synap-core/types/focus-sessions";

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

/** The dev-loop gates' approval receipt (`dev-approval.ts` executor). */
export const DEV_LOOP_METADATA_KEY = "devLoop";

/**
 * The `focus_sessions.metadata` keys ONLY the server writes, because the
 * server decides on them: an intent that answers an ask by itself, the reads
 * revoked at close, the propose-only governance of a playbook run, the client
 * a session is bound to, the automation chain the depth floor reads, and the
 * run manifest (`run`: the sources a rerun replays, the rerun lineage, the
 * cancel record — written by `recordSessionRunManifest` and the cancel door
 * only). And a gate's own record: `devLoop`, the dev-approval executor's
 * receipt (who approved the plan / the deploy, when, under which proposal — a
 * forged one reads exactly like a real approval), and `checkGate`, a check
 * gate's HOLD (`stage-gate.ts`, cleared only by `resumeCheckGateIfMet` —
 * clearing it un-holds the gate). And the provenance stamps, written only by
 * the door that did the thing: `triage` (accept / discard of a draft,
 * `acceptedBy`), `conversion` (the session → object receipt) and `recalled`
 * (what the recall door posted). A client or agent metadata write never
 * carries them ({@link withoutServerOwnedSessionMetadata}).
 */
export const SERVER_OWNED_SESSION_METADATA_KEYS = [
  PROVIDE_CONNECT_META_KEY,
  PROVIDE_GRANTS_META_KEY,
  "governance",
  "clientKey",
  "automationChainContext",
  "run",
  DEV_LOOP_METADATA_KEY,
  CHECK_GATE_METADATA_KEY,
  "triage",
  "conversion",
  "recalled",
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
