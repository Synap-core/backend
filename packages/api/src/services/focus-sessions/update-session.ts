/**
 * updateFocusSession — shared service behind the MCP `synap_update_session` tool.
 *
 * Mirrors createFocusSession / completeFocusSession: owns the load, governance
 * gate, the read-modify-write of the JSONB `expectedOutputs` array (row-locked
 * transaction to avoid TOCTOU), and the `stage_changed` side-effect. Extracted
 * verbatim from the MCP adapter so the tool handler just delegates + shapes the
 * response.
 *
 * NOTE: this is the MCP door's field set (goal/status(active|paused)/progress/
 * currentStage + addOutput/completeOutput/expectedOutputs + addAgentId). The Hub REST PATCH
 * /focus-sessions/:id supports a wider set (channelId, correlationId, agentIds,
 * verificationReport, metadata, status=closed, realtime event) WITHOUT the
 * output RMW lock — they are intentionally distinct doors, not unified here.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { db, focusSessions, eq, and, drizzleSql } from "@synap/database";
import {
  BLOCKED_REASONS,
  OUTPUT_RETIRED_REASONS,
  OUTPUT_REF_KINDS,
  type ExpectedOutput,
  type SessionCriterion,
} from "@synap/playbooks";
import { sessionCriteriaSchema } from "../../schemas/session-criteria.js";
import { isHttpUrl } from "@synap/shared-utils";
import { normalizeExpectedLabel } from "./satisfy-expected-output.js";
import { loadVisibleProject } from "../projects/load-visible-project.js";
// STATIC, like `block-output.ts` beside it. These three call sites used
// `await import()` with no stated reason, which reads as circular-dependency
// avoidance and is not: the static import graph rooted at
// `assert-output-ref-visible.ts` reaches 49 modules (`routers/views.ts`
// included) and NEITHER this module nor `create-session.ts` is among them, so
// there is no cycle to dodge. A dynamic import with no reason hides the edge
// from every module-graph check for nothing.
import {
  findUnreachableOutputRefs,
  isOutputRefVisible,
  unreachableOutputRefError,
} from "./assert-output-ref-visible.js";
import {
  guidanceForBlockedSlots,
  newlyBlockedSlots,
  type BlockGuidance,
  type BlockedSlotRef,
} from "./block-guidelines.js";
import type { FollowOutcome } from "./follow-playbook.js";
import {
  normalizeSessionTitle,
  SESSION_TITLE_MAX,
  titleSourcePatch,
} from "@synap-core/types/focus-sessions";

export interface UpdateFocusSessionParams {
  sessionId: string;
  /** Operator userId — the scoping floor (stops touching another user's session). */
  userId: string;
  agentUserId?: string;
  /** Rename. Blank or `null` CLEARS (untitled ⇒ goal's first line is shown). */
  title?: string | null;
  goal?: string;
  status?: "active" | "paused";
  progress?: number;
  currentStage?: string;
  /**
   * Append ONE slot. `owner`/`blockedReason`/`why` make this the door an agent
   * uses to declare a slot it CANNOT take: the work is named on the board, the
   * blocker is classified, and the human reads one line to know what to do.
   * The slot lands `pending` like any other — declaring a blocker is not a
   * claim of delivery, and `status: 'done'` is still the approval door's.
   */
  addOutput?: {
    kind: string;
    label: string;
    icon?: string;
    owner?: ExpectedOutput["owner"];
    blockedReason?: ExpectedOutput["blockedReason"];
    why?: ExpectedOutput["why"];
    /**
     * WHERE the deliverable lives / where the person must go. Accepted HERE and
     * not only on the wholesale array because this is the door an agent uses to
     * declare a blocked slot in ONE call — without it, "block this on the human
     * AND point them at the page" would need a second, wholesale patch.
     */
    ref?: ExpectedOutput["ref"];
  };
  completeOutput?: string;
  /**
   * APPEND one agent to the session roster. Mirrors `addOutput`: incremental
   * and idempotent, as against the wholesale `agentIds` assignment the tRPC and
   * Hub PATCH doors expose. Applied through the ONE append door,
   * `attachSessionAgent` — never by assigning `set.agentIds` here.
   */
  addAgentId?: string;
  expectedOutputs?: ExpectedOutput[];
  /**
   * Re-point the entity this session is ABOUT (the subject-spine anchor), or
   * CLEAR it with an explicit `null`. Omitted leaves it alone. Floored through
   * the same `isOutputRefVisible` predicate an output's ref goes through.
   */
  subjectEntityId?: string | null;
  /**
   * FILE the session into a project, or UNFILE it with an explicit `null`.
   * Omitted leaves it alone. The target is floored through
   * `loadVisibleProject` before governance, and an AGENT's filing is always a
   * proposal (`forcePropose`): which project a piece of work belongs to is the
   * person's call — an agent may suggest one, never apply it silently.
   */
  projectId?: string | null;
  /**
   * WHOLESALE replace of the session's binary acceptance criteria (an ad-hoc
   * session declaring its contract, or retuning it). Validated against
   * `sessionCriteriaSchema` — max 12, unique keys. Evaluations already
   * recorded stay; a key no longer declared simply stops counting.
   */
  criteria?: SessionCriterion[];
  /**
   * FOLLOW a playbook with this live session — or RELEASE it with `null`.
   *
   * A followed session BECOMES A RUN of that playbook (`playbookId` is written,
   * so `projectSessionKind` reclassifies it from `work` to `run`), joins the
   * playbook's runs, and leaves the owner's default work lens. That consequence
   * is intended and must be DISCLOSED by the surface before the act.
   *
   * Applied by `followPlaybook` (`follow-playbook.ts`) — the ONE implementation
   * behind every door — AFTER the field write below, so the playbook's criteria
   * and deliverables merge onto whatever this same call just wrote.
   */
  followPlaybookId?: string | null;
  /**
   * Answers to the FOLLOWED playbook's declared params — only meaningful with
   * `followPlaybookId`. Validated against the declaration, stored on
   * `metadata.params` (merged over what the session already carried) and, for
   * an unanswered required one, filed as an owed slot. See
   * `FollowPlaybookParams.params`.
   */
  params?: Record<string, unknown>;
  /**
   * Which stage this work is ALREADY in. Absent ⇒ `currentStage` is left
   * exactly as it is (NEVER seeded to stage 1 — an unmapped stage is Jira's
   * hidden-issue failure). A key the playbook does not declare is REFUSED with
   * the valid keys listed.
   */
  followStageKey?: string | null;
}

export type UpdateFocusSessionResult =
  | { status: "not_found" }
  | { status: "denied"; reason: string }
  | {
      status: "proposed";
      proposalId: string;
      /**
       * Which proposed outcome this is: a CONTENT proposal, or a workspace-JOIN
       * gate filed INSTEAD of the write. Callers derive their sentence from it
       * (`proposedMessageFor`); without it on the TYPE the value cannot cross
       * this boundary and the door has to hardcode a claim it cannot check.
       */
      proposalType?: string;
      summary?: string;
      reviewPath?: string;
      reviewUrl?: string;
    }
  | {
      status: "updated";
      session: typeof focusSessions.$inferSelect;
      /**
       * What the patch's `completeOutput` did — present only when the patch
       * carried one. It MUST cross this boundary: the governance floor that
       * refuses to close a human-owned slot changes nothing on the row, so a
       * caller handed only the session object reads a refusal as a success and
       * moves on believing the work is delivered.
       */
      completeOutput?: CompleteOutputOutcome;
      /**
       * Standing guidelines for any slot this patch newly handed to the human
       * (`block-guidelines.ts`). Absent when nothing was blocked or nothing
       * applies.
       */
      blockGuidelines?: BlockGuidance;
      /**
       * What a `followPlaybookId` in the patch DID — present only when the
       * patch carried one. It MUST cross this boundary for the same reason
       * `completeOutput` does: an attach that was REFUSED (an unknown stage
       * key, a playbook already followed) changes nothing on the row, so a
       * caller handed only the session object reads the refusal as a success.
       */
      follow?: FollowOutcome;
      /**
       * Why the follow half of this patch did not land, when the rest did.
       * Absent when there was no `followPlaybookId` or when it landed.
       */
      followRefusal?: string;
    };

type OutputItem = ExpectedOutput;

/**
 * The WIRE shape of one declared deliverable — the ONE input schema, imported by
 * every door that accepts an `expectedOutputs` array (tRPC `focusSessions`
 * create/update, Hub REST POST/PATCH /focus-sessions, this service via the MCP
 * handler).
 *
 * It exists because zod STRIPS what it does not declare. The narrow
 * `{kind,label,icon,status}` shape each door used to declare separately meant a
 * client echoing a slot back lost `delegatedTo`, `returnedReason` and
 * `satisfiedByProposalId` at the PARSE, before any merge could see them — the
 * fields were erased by the schema, not by the write. Declaring them here lets a
 * caller that genuinely holds the current slot round-trip it, and
 * {@link mergeExpectedOutputs} covers the caller that does not.
 *
 * Kept in lock-step with `ExpectedOutput` (@synap/playbooks) by the
 * `satisfies` below: a new field on the type is a compile error here until it is
 * either declared or deliberately left off the wire.
 */
/**
 * The WIRE shape of {@link OutputRef} — ONE union, two arms, both `.strict()`.
 *
 * STRICT ON PURPOSE. Without it zod strips unknown keys, so `{kind, id, url}`
 * would silently parse as the FIRST arm and drop the url (or the reverse,
 * depending on member order) — a caller confused about which arm it wants would
 * be told it succeeded. Strict makes the ambiguity an error the caller can read.
 *
 * The `{url}` arm is scheme-gated HERE, at the parse, through the SAME
 * `isHttpUrl` the visibility floor calls for a `url` artifact ref — the same
 * function, not a second copy of the rule. `javascript:` / `data:` / `file:`
 * never reach storage, which matters because this string IS rendered as a link.
 *
 * The `{kind, id}` arm CANNOT be floored at the parse: visibility needs the
 * caller's identity and a database. That is `findUnreachableOutputRefs`
 * (`assert-output-ref-visible.ts`), called by every door that writes a slot.
 */
export const outputRefWireSchema = z.union([
  z.object({ kind: z.enum(OUTPUT_REF_KINDS), id: z.string().min(1) }).strict(),
  z
    .object({ url: z.string().refine(isHttpUrl, "Must be an http(s) URL") })
    .strict(),
]);

export const expectedOutputWireSchema = z.object({
  kind: z.string(),
  label: z.string(),
  icon: z.string().optional(),
  // Per-item lifecycle (defaults to "pending" when omitted). Shape-within-jsonb.
  status: z.enum(["pending", "done"]).optional(),
  claimedDone: z.boolean().optional(),
  satisfiedByProposalId: z.string().optional(),
  delegatedTo: z.string().optional(),
  delegatedAt: z.string().optional(),
  returnedReason: z.string().optional(),
  returnedAt: z.string().optional(),
  // Blocked-on-human slot. `owner` absent ⇒ `agent` (see ExpectedOutput).
  //
  // NOT cross-field-refined ("blockedReason/why only with owner:'human'"). That
  // rule is CONVENTIONAL here on purpose: this schema parses WHOLESALE patches,
  // and {@link mergeExpectedOutputs} carries forward the server-owned fields an
  // incoming item is silent about — so a legal patch may legitimately arrive
  // carrying `owner` without `blockedReason` (the stored one is about to be
  // re-attached) or vice versa. A refinement at the parse sees only the incoming
  // half and would reject writes the merge is designed to accept.
  owner: z.enum(["human", "agent"]).optional(),
  blockedReason: z.enum(BLOCKED_REASONS).optional(),
  why: z.string().max(500).optional(),
  // Server-stamped alongside `owner: 'human'` (see `reconcileOwedSince`). It is
  // ON the wire only so a caller round-tripping a stored slot does not lose it
  // at the parse — never so a client can author a time it did not observe; the
  // reconciler overwrites whatever arrives that contradicts `owner`.
  owedSince: z.string().optional(),
  // Attestation receipt — stamped by `attestExpectedOutput` alongside `done`.
  // On the wire for the same round-trip reason as `owedSince`, never so a
  // client can author one: the door is the only writer.
  attestedBy: z.string().optional(),
  attestedAt: z.string().optional(),
  // Retirement receipt — stamped when the declaring session is CANCELLED.
  retiredAt: z.string().optional(),
  retiredReason: z.enum(OUTPUT_RETIRED_REASONS).optional(),
  // WHERE to go for this deliverable. AGENT/HUMAN-authored, never stamped —
  // `.nullable()` because silence means KEEP (see `SERVER_OWNED_OUTPUT_FIELDS`)
  // and so "clear this pointer" needs an explicit way to say itself.
  ref: outputRefWireSchema.nullable().optional(),
  // The criterion a criterion slot stands for — stamped by the escalation in
  // `evaluations/record.ts`, never authored by a client. On the wire for the
  // same round-trip reason as `owedSince`: a naive echo must not lose it.
  criterionKey: z.string().optional(),
}) satisfies z.ZodType<ExpectedOutput, ExpectedOutput>;

/**
 * The slot fields the SERVER owns — written by governance, delegation and
 * approval, never by whoever is patching the list.
 *
 * WHY A MERGE AT ALL. `expectedOutputs` is patched WHOLESALE by three doors
 * (this service, the tRPC `focusSessions.update`, the Hub REST PATCH), and the
 * surfaces that patch it — the browser session board above all — read the list,
 * edit one label, and send the whole array back. Every field they did not know
 * about was therefore ERASED on the next edit: a slot's delegation, its
 * reviewer's return note, and the approval lineage behind its `done` all
 * vanished because someone renamed a sibling. Widening the wire schema alone
 * does not fix that (a client written before the field still omits it); the
 * write has to CARRY FORWARD what it was not told about.
 *
 * The rule is: an incoming item that is SILENT about a server-owned field keeps
 * the stored value; one that carries the field explicitly wins. Silence is not
 * an instruction to delete.
 *
 * MEMBERSHIP IS ABOUT ERASURE, NOT AUTHORITY. Being listed here does not make a
 * field unwritable by an agent — `owner`/`blockedReason`/`why` are the agent's
 * own declaration, written through `addOutput`. It makes the field survive the
 * NEXT wholesale patch by a client that has never heard of it. Every key of
 * `ExpectedOutput` except the three a client authors (`kind`, `label`, `icon`)
 * belongs here, and `__tripwires__/expected-output-server-owned-coverage.test.ts`
 * derives that set from the type so a new field cannot be silently omitted —
 * `satisfies ReadonlyArray<keyof ExpectedOutput>` permits omission, which is
 * exactly the erasure bug described above.
 */
export const CLIENT_AUTHORED_OUTPUT_FIELDS = [
  "kind",
  "label",
  "icon",
] as const satisfies ReadonlyArray<keyof ExpectedOutput>;

/**
 * THE SECOND AXIS: WHO MAY WRITE THE FIELD, as against who may ERASE it.
 *
 * The set above answers "what does a silent patch destroy". It says nothing
 * about AUTHORITY, and its own docblock says so — which left the wholesale path
 * with no floor at all. `completeOutput` refuses to close a slot the agent
 * declared `owner: 'human'`, but ONE `expectedOutputs: [{kind, label, status:
 * "done"}]` stamped the same slot done with no receipt, or forged an
 * `attestedBy` naming the user, or hid an owed slot behind a `retiredAt`. The
 * floor was a fence with a gate beside it.
 *
 * So the fields split a SECOND way, and this is the split that carries the
 * governance meaning:
 *
 *   CLIENT-DECLARABLE — what an agent legitimately SAYS about a deliverable.
 *   `kind`/`label`/`icon` name it; `owner`/`blockedReason`/`why` are the agent's
 *   own declaration that it cannot take the work (written through `addOutput`,
 *   and re-assertable through a wholesale patch). Declaring a blocker is not a
 *   claim of delivery, so none of these can close anything.
 *
 *   SERVER-STAMPED — every RECEIPT: what happened, who said so, and when. Each
 *   has exactly one writing door already (`attestExpectedOutput`,
 *   `satisfyExpectedOutputs`, `delegateOutput`, `returnDelegatedSlot`,
 *   `retirementForClose`, `reconcileOwedSince`). A client may round-trip them —
 *   the wire schema accepts them so a naive echo does not lose them at the
 *   PARSE — but may never author or change one. {@link mergeExpectedOutputs}
 *   enforces that.
 */
export const CLIENT_DECLARABLE_OUTPUT_FIELDS = [
  ...CLIENT_AUTHORED_OUTPUT_FIELDS,
  "owner",
  "blockedReason",
  "why",
  // The pointer the declarer supplies. Declaring WHERE something lives is not a
  // claim that it landed, so it closes nothing — same footing as `why`.
  "ref",
] as const satisfies ReadonlyArray<keyof ExpectedOutput>;

export const SERVER_STAMPED_OUTPUT_FIELDS = [
  "status",
  "claimedDone",
  "satisfiedByProposalId",
  "delegatedTo",
  "delegatedAt",
  "returnedReason",
  "returnedAt",
  "owedSince",
  "attestedBy",
  "attestedAt",
  "retiredAt",
  "retiredReason",
  // Stamped by the escalation that files a criterion slot. SERVER-STAMPED, not
  // merely erasure-protected: an agent that could author it would point the
  // scorecard at a criterion it did not fail.
  "criterionKey",
] as const satisfies ReadonlyArray<keyof ExpectedOutput>;

/**
 * DERIVED, not hand-maintained — a third list is a third place to forget a
 * field. Everything the server stamps must survive a silent patch, and so must
 * the agent's own declaration, which the client authors but a client that has
 * never heard of it would otherwise erase.
 */
export const SERVER_OWNED_OUTPUT_FIELDS = [
  ...SERVER_STAMPED_OUTPUT_FIELDS,
  "owner",
  "blockedReason",
  "why",
  // Listed for ERASURE, not authority (see the docblock above): a browser that
  // has never heard of `ref` reads the array, renames a sibling, sends it back —
  // and must not silently drop the door the agent put on the card.
  "ref",
] as const satisfies ReadonlyArray<keyof ExpectedOutput>;

/**
 * COMPILE-TIME coverage floor for the list above.
 *
 * `satisfies ReadonlyArray<keyof ExpectedOutput>` only checks that each listed
 * name IS a field — it happily accepts a list that OMITS one, and an omitted
 * field is silently erased by the next wholesale patch. This says the other
 * direction: every key of `ExpectedOutput` that is not client-authored must be
 * in the list, or `Exclude<...>` fails to extend the tuple union, the alias
 * resolves to `never`, and this assignment stops the build. A new field on the
 * interface is therefore a TYPECHECK error until it is classified — no test run
 * required, and nothing for a regex to be blinded by.
 */
type _ServerOwnedCoversEveryField =
  Exclude<
    keyof ExpectedOutput,
    (typeof CLIENT_AUTHORED_OUTPUT_FIELDS)[number]
  > extends (typeof SERVER_OWNED_OUTPUT_FIELDS)[number]
    ? true
    : never;
const _serverOwnedCoverage: _ServerOwnedCoversEveryField = true;
void _serverOwnedCoverage;

/**
 * The SAME floor for the authority axis, and it is the load-bearing one: a new
 * `ExpectedOutput` field that is not named client-declarable must be
 * server-stamped, or this alias resolves to `never` and the build stops.
 *
 * WHY THE DEFAULT IS SAFE. Omission cannot make a field silently
 * client-writable — the only way to reach a green build is to classify it, and
 * classifying it as declarable is a visible edit to a list whose docblock says
 * what that means. The failure mode the old single list had (add a field, forget
 * it, and it is writable by anyone) is not reachable from here.
 */
type _ServerStampedCoversEveryField =
  Exclude<
    keyof ExpectedOutput,
    (typeof CLIENT_DECLARABLE_OUTPUT_FIELDS)[number]
  > extends (typeof SERVER_STAMPED_OUTPUT_FIELDS)[number]
    ? true
    : never;
const _serverStampedCoverage: _ServerStampedCoversEveryField = true;
void _serverStampedCoverage;

/**
 * Merge an incoming `expectedOutputs` array onto the stored one BY LABEL — the
 * ONE merge, called by all three wholesale-update doors so they cannot drift
 * into three answers about what a patch destroys.
 *
 * Matching uses `normalizeExpectedLabel`, the same trim+casefold every other
 * slot lookup uses (delegation, return, satisfy). A label the stored array does
 * not carry is a NEW slot and lands verbatim; a stored slot the incoming array
 * omits is DELETED — that is the existing, deliberate semantic of a wholesale
 * assignment, and the merge does not change it.
 */
export function mergeExpectedOutputs(
  current: OutputItem[],
  incoming: OutputItem[]
): OutputItem[] {
  const violations = detectServerStampedWrites(current, incoming);
  if (violations.length > 0) {
    throw serverStampedWriteError(violations);
  }

  const stored = indexByLabel(current);

  return incoming.map((item) => {
    const key = normalizeExpectedLabel(item?.label);
    const prior = key ? stored.get(key) : undefined;
    // A slot the stored array does not carry is NEW, and a new slot has no
    // receipts by definition. Server-stamped fields on it are DROPPED rather
    // than refused: there is no stored value being contradicted, so nothing is
    // being overwritten — and refusing would break the legitimate rename (read
    // the array, change one label, send it back), which arrives as exactly this
    // shape. Dropping still defeats the bypass: a patch inventing a `done` slot
    // under an unmatched label lands it pending, like any other declaration.
    if (!prior)
      return dropClearedRef(reconcileOwedSince(stripServerStamped(item)));
    // Only the fields the incoming item is SILENT about are carried; a
    // client-declarable field it states explicitly wins. Server-stamped fields
    // are always carried from storage — an incoming one either equalled the
    // stored value (a round-trip) or the detector above already refused.
    const carried: Partial<ExpectedOutput> = {};
    for (const field of SERVER_OWNED_OUTPUT_FIELDS) {
      if (
        item[field] !== undefined &&
        !SERVER_STAMPED_FIELD_SET.has(field as string)
      ) {
        continue;
      }
      const value = prior[field];
      if (value !== undefined) {
        Object.assign(carried, { [field]: value });
      }
    }
    // Stripped first so a server-stamped field the STORED slot does not carry
    // cannot survive as the incoming value — `carried` can only overwrite keys
    // it has, and an absent stored receipt has none.
    return dropClearedRef(
      reconcileOwedSince({ ...stripServerStamped(item), ...carried })
    );
  });
}

/**
 * `ref: null` is the WIRE's way of saying CLEAR; storage must not keep the null.
 *
 * Silence on a wholesale patch means KEEP for every server-owned field, so
 * "remove the pointer" has no way to say itself except explicitly — and the
 * explicit value has to be erased here or `ref` becomes a tri-state
 * (`present` / `absent` / `null`) that every reader downstream has to know
 * about. One targeted normalizer, exactly the shape of {@link reconcileOwedSince}
 * beside it, keeps the stored slot two-state: a `ref` or no key at all.
 */
export function dropClearedRef(item: OutputItem): OutputItem {
  if (item.ref !== null) return item;
  const { ref: _cleared, ...rest } = item;
  return rest;
}

const SERVER_STAMPED_FIELD_SET: ReadonlySet<string> = new Set(
  SERVER_STAMPED_OUTPUT_FIELDS
);

/** Every incoming slot indexed by the casefolded label the doors match on. */
function indexByLabel(outputs: OutputItem[]): Map<string, OutputItem> {
  const stored = new Map<string, OutputItem>();
  for (const o of outputs) {
    const key = normalizeExpectedLabel(o?.label);
    // First wins: two slots sharing a label are already ambiguous everywhere
    // else (the delegation and satisfy doors both take the first match), so
    // this resolves it the same way rather than inventing a second answer.
    if (key && !stored.has(key)) stored.set(key, o);
  }
  return stored;
}

/**
 * WHAT A CLIENT MAY AUTHOR AT DECLARATION TIME — the CREATE half of the write
 * authority floor that {@link mergeExpectedOutputs} enforces on every update.
 *
 * A create has no stored slot to carry anything forward from, which makes the
 * rule simpler than the merge's, not laxer: every server-stamped field is by
 * definition UNEARNED on a slot that is being born, so all of them are dropped
 * and the reconciler then stamps the one the server owes.
 *
 * ⚠️ This existed only as the merge's private strip, so `startFocusSession`
 * wrote the caller's array through `reconcileOwedSince` ALONE. That reconciler
 * touches `owedSince` and nothing else, so a create could persist a slot
 * carrying `attestedBy`/`attestedAt` — a forged receipt saying a human
 * confirmed work nobody confirmed — or `retiredAt`, which makes the slot
 * invisible to `owedSlotWhere` from birth. The update door had refused both
 * since the floor was built; the create door had never been asked.
 *
 * Order is load-bearing: strip FIRST (which also drops a client-supplied
 * `owedSince`), then reconcile, so the stamp is the server's observation and
 * never the caller's claim.
 */
export function sanitizeDeclaredOutputs(
  outputs: readonly OutputItem[],
  now: Date = new Date()
): OutputItem[] {
  return outputs.map((o) => reconcileOwedSince(stripServerStamped(o), now));
}

/** The slot with every receipt removed — what a client may actually author. */
function stripServerStamped(item: OutputItem): OutputItem {
  const out: OutputItem = { ...item };
  for (const field of SERVER_STAMPED_OUTPUT_FIELDS) delete out[field];
  return out;
}

/** One attempt to write a field the client does not own. */
export interface ServerStampedWrite {
  /** The slot's label, verbatim — so the caller can find it. */
  label: string;
  field: (typeof SERVER_STAMPED_OUTPUT_FIELDS)[number];
}

/**
 * Every server-stamped field an incoming patch is trying to CHANGE — the
 * authority floor for the wholesale path, pure and exported so both its
 * consumers share one derivation.
 *
 * ROUND-TRIP IS NOT A WRITE. A client that read the array and sends it back
 * unchanged carries every receipt verbatim, and must not error — that is the
 * shape `useDeclareOutput` (browser) and every naive echo already produce. So
 * the test is on the VALUE: equal to the stored one is a round-trip and passes;
 * DIFFERENT is a caller trying to author a receipt and is refused, loudly.
 *
 * Refused rather than silently dropped, deliberately. A silent no-op is the
 * "guard works, report lies" defect this codebase has shipped repeatedly: the
 * caller is told its patch landed, reads back a slot that is still pending, and
 * has no way to tell a refusal from a bug. (The one place silence IS correct is
 * a slot with no stored twin — see {@link mergeExpectedOutputs}.)
 */
export function detectServerStampedWrites(
  current: OutputItem[],
  incoming: OutputItem[]
): ServerStampedWrite[] {
  const stored = indexByLabel(current);
  const violations: ServerStampedWrite[] = [];
  for (const item of incoming) {
    const key = normalizeExpectedLabel(item?.label);
    const prior = key ? stored.get(key) : undefined;
    if (!prior) continue;
    for (const field of SERVER_STAMPED_OUTPUT_FIELDS) {
      const value = item[field];
      if (value === undefined) continue;
      if (value === prior[field]) continue;
      violations.push({ label: item.label, field });
    }
  }
  return violations;
}

/**
 * The refusal, as a `BAD_REQUEST` — this is a caller error, not a server fault,
 * and every door must say so rather than returning a 500 that reads like a bug
 * on our side. `TRPCError` is used at all four merge call sites (tRPC ×2, Hub
 * REST, the approval executor) so the message survives to the caller on each.
 */
export function serverStampedWriteError(
  violations: ServerStampedWrite[]
): TRPCError {
  const named = violations
    .map((v) => `"${v.label}".${v.field}`)
    .slice(0, 5)
    .join(", ");
  const more = violations.length > 5 ? ` (+${violations.length - 5} more)` : "";
  return new TRPCError({
    code: "BAD_REQUEST",
    message:
      `Refused: ${named}${more} — these are server-stamped receipts and a patch ` +
      `cannot author or change one. Nothing was changed. Mark a deliverable done ` +
      `by approving the proposal that produced it, or — if it is your own slot — ` +
      `by attesting it (focusSessions.attestOutput). Round-tripping the stored ` +
      `value unchanged is always fine.`,
  });
}

/**
 * THE `owedSince` INVARIANT, in one place: the stamp is present IFF the slot is
 * owned by the human.
 *
 * `owner: 'human'` is authored by an agent (through `addOutput`, a wholesale
 * patch, or `blockExpectedOutput`), but the TIME it became owed is an
 * observation only the server can make — the same split `delegatedAt` has from
 * `delegatedTo`. So every path that can change `owner` runs the slot through
 * here rather than each stamping its own timestamp, and a client that sends a
 * fabricated `owedSince` on a slot it is handing BACK to the agent has it
 * dropped rather than believed.
 *
 * An ALREADY-owed slot keeps its original stamp: re-declaring the same blocker
 * must not reset the clock the "needs you" feed ages rows by.
 *
 * ⚠️ SCOPE, stated because the neighbouring rule reads wider than this one.
 * `block-output.ts` writes `owner`/`blockedReason`/`why`/`owedSince` as a UNIT
 * and `unblockExpectedOutput` clears all four together. This reconciler is NOT
 * that unit: it reconciles `owedSince` with `owner` and touches nothing else.
 * So a WHOLESALE patch that sets `owner: 'agent'` on a previously blocked slot
 * drops `owedSince` here while the stored `blockedReason`/`why` are carried
 * forward by the merge — those are client-declarable, and silence means KEEP.
 *
 * That is deliberate, not an oversight: reconciling them here would mean
 * silently DELETING an agent's own declaration on a patch that never mentioned
 * it, which is the erasure the merge exists to prevent. The resulting state
 * (agent-owned, still carrying a blocker) is unreachable through the targeted
 * doors and inert on every surface — `blockerChipLabel`
 * (`relay-app/src/lib/session-outputs-model.ts`) returns null unless
 * `owner === 'human'`, and that owner guard is the enforcement point.
 */
export function reconcileOwedSince(
  item: OutputItem,
  now: Date = new Date()
): OutputItem {
  if (item.owner === "human") {
    return item.owedSince ? item : { ...item, owedSince: now.toISOString() };
  }
  if (item.owedSince === undefined) return item;
  const { owedSince: _dropped, ...rest } = item;
  return rest;
}

/**
 * What a `completeOutput` in the patch ACTUALLY did — the report that makes the
 * governance floor below observable to whoever asked.
 *
 * Three outcomes, and they must stay tellable apart. `completed` is the write.
 * `refused` is the floor: the slot is the human's and the agent may not close
 * it — actionable, the caller should stop claiming the work is done. `no_match`
 * is the DOCUMENTED contract of this field (the MCP tool advertises "no-op if no
 * deliverable matches the label exactly"), not an error — but a caller still has
 * to be able to distinguish "you spelled the label wrong" from "you are not
 * allowed", which is exactly what a bare 200 with an unchanged row cannot do.
 */
export type CompleteOutputOutcome = {
  /** The label the caller asked to complete, verbatim. */
  label: string;
  /** Matching slots that were stamped done. */
  completed: number;
  /** Matching slots REFUSED because `owner: 'human'`. */
  refusedHumanOwned: number;
  /** The one-word verdict, derived from the two counts above. */
  result: "completed" | "refused" | "no_match";
  /**
   * Caller-facing sentence for the two non-success verdicts. Absent when the
   * mark landed — a success needs no explanation, and an always-present message
   * is the thing callers learn to ignore.
   */
  message?: string;
};

/** The outputs array a patch produced, plus the report of what it refused. */
export interface OutputMutationResult {
  outputs: OutputItem[];
  /** Present only when the patch carried a `completeOutput`. */
  completeOutput?: CompleteOutputOutcome;
}

/**
 * Turn the two match counts into the verdict + its sentence. Lives OUTSIDE
 * {@link applyOutputMutations} deliberately: prose wedged between that
 * function's `patch.completeOutput` read and its `status: "done"` literal blinds
 * the `__tripwires__/expected-output-done-one-door.test.ts` proximity window to
 * the residual it exists to pin.
 */
function describeCompleteOutput(
  label: string,
  completed: number,
  refusedHumanOwned: number
): CompleteOutputOutcome {
  if (completed > 0) {
    return { label, completed, refusedHumanOwned, result: "completed" };
  }
  if (refusedHumanOwned > 0) {
    return {
      label,
      completed,
      refusedHumanOwned,
      result: "refused",
      message: `"${label}" is the human's slot — you declared it owner: "human", so you cannot mark it done. Nothing was changed. Reclaim the slot first (clear its blocker) if you did the work after all, or leave it for the human.`,
    };
  }
  return {
    label,
    completed,
    refusedHumanOwned,
    result: "no_match",
    message: `No deliverable is labelled exactly "${label}". Nothing was changed. Labels match verbatim — list the session's deliverables and resend the exact label.`,
  };
}

/**
 * The three output mutations a `focus_session/update` can carry, applied to the
 * CURRENT stored array. Pure, and EXPORTED because it has two callers that must
 * not drift: this service's row-locked write, and the `focus_session/update`
 * proposal executor, which re-applies the very same patch on approval. When the
 * executor had its own inline field list it applied none of these at all, and
 * approving a slot change returned success while changing nothing.
 *
 * Returns the new array ALONGSIDE the `completeOutput` report rather than
 * throwing on a refusal: a wholesale patch that merely happens to mention a
 * blocked label must still land its other mutations, and both callers already
 * run inside a row lock a throw would abort.
 */
export function applyOutputMutations(
  current: OutputItem[],
  patch: {
    expectedOutputs?: OutputItem[];
    addOutput?: UpdateFocusSessionParams["addOutput"];
    completeOutput?: string;
  }
): OutputMutationResult {
  // Wholesale replace goes through the ONE merge, so a client that sends back
  // the four fields it knows about cannot erase a delegation, a return note or
  // an approval's lineage.
  let next: OutputItem[] = patch.expectedOutputs
    ? mergeExpectedOutputs(current, patch.expectedOutputs)
    : current;

  if (patch.addOutput) {
    const add = patch.addOutput;
    next = [
      ...next,
      reconcileOwedSince({
        kind: add.kind,
        label: add.label,
        icon: add.icon,
        status: "pending",
        // Only spread what was actually declared — an absent `owner` MUST
        // stay absent (it is what "the agent never said" looks like), not
        // become an explicit "agent".
        ...(add.owner !== undefined ? { owner: add.owner } : {}),
        ...(add.blockedReason !== undefined
          ? { blockedReason: add.blockedReason }
          : {}),
        ...(add.why !== undefined ? { why: add.why } : {}),
        // `null` here is the same CLEAR the wire uses; a brand-new slot has
        // nothing to clear, so it simply carries no key.
        ...(add.ref ? { ref: add.ref } : {}),
      }),
    ];
  }
  // GOVERNANCE FLOOR on the branch below — an agent may not complete a slot it
  // handed to the human. `owner: 'human'` is the agent's own declaration that it
  // CANNOT do this work; letting the same caller then mark it done would make
  // the declaration a way to close work nobody did. (The wider residual — that
  // this stamps `status` at all instead of `claimedDone` — is pinned in
  // `__tripwires__/expected-output-done-one-door.test.ts` and deliberately
  // untouched here. Keep this prose OUTSIDE the branch: that tripwire matches
  // `completeOutput` within 400 chars of the `done` literal, and a comment
  // wedged between the two blinds it to the very residual it pins.)

  let completeOutput: CompleteOutputOutcome | undefined;
  if (typeof patch.completeOutput === "string") {
    const label = patch.completeOutput;
    let completed = 0;
    let refused = 0;
    next = next.map((o) => {
      if (o.label !== label) return o;
      if (o.owner === "human") {
        refused += 1;
        return o;
      }
      completed += 1;
      return { ...o, status: "done" as const };
    });
    completeOutput = describeCompleteOutput(label, completed, refused);
  }

  return { outputs: next, ...(completeOutput ? { completeOutput } : {}) };
}

export async function updateFocusSession(
  params: UpdateFocusSessionParams
): Promise<UpdateFocusSessionResult> {
  const { sessionId, userId, agentUserId } = params;

  // Load scoped by the operator userId — the floor that stops an agent key
  // from touching another user's session (mirrors completeFocusSession).
  const existing = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, sessionId),
      eq(focusSessions.userId, userId)
    ),
  });
  if (!existing) {
    return { status: "not_found" };
  }

  // AUTHORITY FLOOR, BEFORE THE MEMBRANE. The merge enforces this too — it is
  // the one door and it throws — but reaching it via governance would mean an
  // agent's forged receipt becomes a PROPOSAL, sits in the human's queue looking
  // like ordinary work, and only explodes at approval time, on the human. So the
  // same pure detector runs here against the row we already loaded, and the
  // refusal goes back to the caller that tried it, as the `denied` this result
  // type already carries.
  //
  // Not a second derivation: `detectServerStampedWrites` is the derivation, and
  // both call sites pass it the stored array. This one races (the load is
  // unlocked) — harmlessly, because the merge inside the row lock is the one
  // that decides; this only spares the human a poisoned proposal.
  if (params.expectedOutputs !== undefined) {
    const storedOutputs: OutputItem[] = Array.isArray(existing.expectedOutputs)
      ? (existing.expectedOutputs as OutputItem[])
      : [];
    const violations = detectServerStampedWrites(
      storedOutputs,
      params.expectedOutputs
    );
    if (violations.length > 0) {
      return {
        status: "denied",
        reason: serverStampedWriteError(violations).message,
      };
    }
  }

  // VISIBILITY FLOOR for the refs this patch declares, and BEFORE the membrane
  // for the same reason as the authority floor above: a ref the caller cannot
  // see must be refused to the caller who wrote it, not laundered into a
  // proposal that explodes on the human at approval time.
  //
  // ONE door: `isOutputRefVisible`, the same predicate the attach-output doors
  // apply to a produced artifact's ref.
  {
    const declared = [
      ...(params.expectedOutputs ?? []),
      ...(params.addOutput ? [params.addOutput] : []),
    ];
    if (declared.length > 0) {
      const unreachable = await findUnreachableOutputRefs({
        userId,
        outputs: declared,
      });
      if (unreachable.length > 0) {
        return {
          status: "denied",
          reason: unreachableOutputRefError(unreachable),
        };
      }
    }
  }

  // Criteria are a CONTROL: refused whole when malformed, never half-applied.
  if (params.criteria !== undefined) {
    const parsed = sessionCriteriaSchema.safeParse(params.criteria);
    if (!parsed.success) {
      return {
        status: "denied",
        reason: `Invalid criteria: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "criteria"}: ${i.message}`)
          .join("; ")}`,
      };
    }
  }

  // A title is ONE line of at most SESSION_TITLE_MAX — refused, never clipped.
  if (
    params.title !== undefined &&
    (normalizeSessionTitle(params.title)?.length ?? 0) > SESSION_TITLE_MAX
  ) {
    return {
      status: "denied",
      reason: `title must be at most ${SESSION_TITLE_MAX} characters — ONE line naming the session; put the outcome in goal.`,
    };
  }

  // THE SAME FLOOR for the SUBJECT anchor. The room resolves the subject's
  // live title by bare id, so an unfloored re-point is the identical read
  // oracle one field over. `null` clears and names nothing, so it skips.
  if (params.subjectEntityId) {
    const visible = await isOutputRefVisible({
      userId,
      kind: "entity",
      refId: params.subjectEntityId,
    });
    if (!visible) {
      return {
        status: "denied",
        reason: `Cannot reference an object you cannot see, on: subject ${params.subjectEntityId}`,
      };
    }
  }

  // THE SAME FLOOR for a filing target: a project the caller cannot see is
  // refused here, not laundered into a proposal. `null` unfiles and names
  // nothing, so it skips.
  let filingProjectName: string | undefined;
  if (params.projectId) {
    const project = await loadVisibleProject(db, params.projectId, userId);
    if (!project) {
      return {
        status: "denied",
        reason: `Cannot file into a project you cannot see: ${params.projectId}`,
      };
    }
    filingProjectName = project.name;
  }

  // Governance membrane — AI callers route through proposals (same gate the
  // Hub PATCH /focus-sessions/:id and synap_complete_session use). Always carry
  // goal (for proposal summary / targetName) plus every intended mutation so
  // the focus_session/update executor can materialize the full patch on approve.
  const { checkPermissionOrPropose } =
    await import("../../utils/permission-check.js");
  const perm = await checkPermissionOrPropose({
    userId,
    agentUserId,
    workspaceId: existing.workspaceId ?? undefined,
    subjectType: "focus_session",
    action: "update",
    source: "intelligence",
    // Filing is always reviewed when an agent does it (honoured on the AI
    // paths only — a person filing their own session is never forced).
    ...(params.projectId !== undefined ? { forcePropose: true } : {}),
    data: {
      id: sessionId,
      // Always include goal so summaries resolve even when goal is not changing.
      goal: params.goal !== undefined ? params.goal : existing.goal,
      ...(params.title !== undefined ? { title: params.title } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
      ...(params.progress !== undefined ? { progress: params.progress } : {}),
      ...(params.currentStage !== undefined
        ? { currentStage: params.currentStage }
        : {}),
      ...(params.expectedOutputs !== undefined
        ? { expectedOutputs: params.expectedOutputs }
        : {}),
      ...(params.addOutput !== undefined
        ? { addOutput: params.addOutput }
        : {}),
      ...(params.completeOutput !== undefined
        ? { completeOutput: params.completeOutput }
        : {}),
      // Carried so the PROPOSED path is not a silent no-op: the
      // `focus_session/update` executor re-applies it through the same append
      // door on approval.
      ...(params.addAgentId !== undefined
        ? { addAgentId: params.addAgentId }
        : {}),
      // Carried for the same reason as `addAgentId`: without it on the proposal
      // the PROPOSED path is a silent no-op — the human approves "re-point the
      // subject" and the executor has no subject to point at.
      ...(params.subjectEntityId !== undefined
        ? { subjectEntityId: params.subjectEntityId }
        : {}),
      ...(params.criteria !== undefined ? { criteria: params.criteria } : {}),
      // Carried so the approved filing is applied, not a silent no-op; `null`
      // (unfile) must survive, hence `!== undefined`.
      ...(params.projectId !== undefined
        ? { projectId: params.projectId }
        : {}),
      // Display only — the proposal title names WHICH project (the executor
      // applies `projectId` and ignores this).
      ...(filingProjectName ? { projectName: filingProjectName } : {}),
      // Carried for the same reason as `addAgentId` and `subjectEntityId`: the
      // `focus_session/update` executor re-applies it on approval, so the
      // PROPOSED path is not a silent no-op. `null` is the RELEASE and must
      // survive the payload, hence the `!== undefined` test.
      ...(params.followPlaybookId !== undefined
        ? { followPlaybookId: params.followPlaybookId }
        : {}),
      ...(params.followStageKey !== undefined
        ? { followStageKey: params.followStageKey }
        : {}),
      // Same reason: without this the answers land on the direct path and
      // vanish on the approved one.
      ...(params.params !== undefined ? { params: params.params } : {}),
    },
  });
  if ("denied" in perm && perm.denied) {
    return { status: "denied", reason: perm.reason };
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      // The discriminator MUST cross this boundary: this door is join-gate
      // reachable (the MCP handler threads `agentUserId`), and without it the
      // caller cannot tell a session-update proposal from a workspace-JOIN
      // gate filed instead of it. Its two siblings (create-session,
      // complete-session) already forward it.
      proposalType: perm.proposalType,
      summary: perm.summary,
      reviewPath: perm.reviewPath,
      reviewUrl: perm.reviewUrl,
    };
  }

  // Build the field set. status is constrained to active|paused — closing a
  // session is synap_complete_session's job (it also closes the running
  // playbook_run); a raw status='closed' here would orphan that run.
  const set: Partial<typeof focusSessions.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (params.goal !== undefined) set.goal = params.goal;
  if (params.title !== undefined) {
    set.title = normalizeSessionTitle(params.title);
    // An agent's rename is never overwritten by the background titler; a
    // CLEAR hands the name back to it. Merged, never assigned over metadata.
    set.metadata = drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(
      titleSourcePatch(set.title ? "agent" : "derived")
    )}::jsonb`;
  }
  if (params.status !== undefined) set.status = params.status;
  if (params.progress !== undefined) set.progress = params.progress;
  if (params.currentStage !== undefined) set.currentStage = params.currentStage;
  // `undefined` leaves the anchor; `null` is the CLEAR.
  if (params.subjectEntityId !== undefined)
    set.subjectEntityId = params.subjectEntityId;
  // `undefined` leaves the filing; `null` unfiles.
  if (params.projectId !== undefined) set.projectId = params.projectId;
  if (params.criteria !== undefined) set.criteria = params.criteria;

  // Roster append goes through the ONE append door, which owns its own row lock
  // and its own idempotency. Deliberately NOT folded into `set` below: assigning
  // `agentIds` here would be a second wholesale writer of the column, which is
  // exactly the shape that left it unappendable in the first place.
  if (params.addAgentId !== undefined) {
    const { attachSessionAgent } = await import("./attach-session-agent.js");
    await attachSessionAgent({
      sessionId,
      agentId: params.addAgentId,
      userId,
    });
  }

  // addOutput / completeOutput / a full expectedOutputs replace mutate the
  // JSONB deliverables array. Do the read-modify-write inside a transaction
  // with a row lock (`FOR UPDATE`) so two concurrent edits can't both read
  // the same base array and lose one's item (TOCTOU).
  const mutatesOutputs =
    params.addOutput !== undefined ||
    typeof params.completeOutput === "string" ||
    params.expectedOutputs !== undefined;

  // Captured out of the transaction so the RETURN can report it — see the
  // `completeOutput` field on UpdateFocusSessionResult.
  let completeOutputOutcome: CompleteOutputOutcome | undefined;
  // Diffed against the LOCKED base, so only blocks this patch declared count.
  let blockedByThisPatch: BlockedSlotRef[] = [];

  const [updated] = await db.transaction(async (tx) => {
    if (mutatesOutputs) {
      const [locked] = await tx
        .select({ expectedOutputs: focusSessions.expectedOutputs })
        .from(focusSessions)
        .where(eq(focusSessions.id, sessionId))
        .for("update");
      const current: OutputItem[] = Array.isArray(locked?.expectedOutputs)
        ? (locked.expectedOutputs as OutputItem[])
        : [];
      const applied = applyOutputMutations(current, {
        expectedOutputs: params.expectedOutputs,
        addOutput: params.addOutput,
        completeOutput: params.completeOutput,
      });
      set.expectedOutputs = applied.outputs;
      completeOutputOutcome = applied.completeOutput;
      blockedByThisPatch = newlyBlockedSlots(current, applied.outputs);
    }
    return tx
      .update(focusSessions)
      .set(set)
      .where(eq(focusSessions.id, sessionId))
      .returning();
  });

  // ── STAGE ADVANCE ───────────────────────────────────────────────────────────
  // The `stage_changed` fan-out AND the human gate both live in ONE door now
  // (`advance-stage.ts`). This service used to carry the only wired gate while
  // the tRPC, Hub REST and automation doors each hand-copied the emit and walked
  // straight through it — four copies of one rule, three a field behind.
  //
  // `stageWrite: "caller"` because the stage rode along in the multi-field UPDATE
  // above (inside the outputs row lock); the door must not write it a second time.
  let gatedStatus: typeof updated.status | undefined;
  if (params.currentStage !== undefined) {
    const { advanceSessionStage } = await import("./advance-stage.js");
    const advance = await advanceSessionStage({
      session: {
        id: updated.id,
        currentStage: existing.currentStage,
        workspaceId: existing.workspaceId,
        projectId: existing.projectId,
        channelId: existing.channelId,
        playbookId: existing.playbookId,
        subjectEntityId: existing.subjectEntityId,
      },
      toStage: params.currentStage,
      userId,
      agentUserId,
      stageWrite: "caller",
    });
    // Report the status the ROW now holds, not the one this call asked for —
    // a caller told "active" while the pod has it paused would step straight
    // past the gate it just opened.
    if (advance.paused) gatedStatus = "paused";
  }

  // ── FOLLOW / RELEASE A PLAYBOOK ─────────────────────────────────────────────
  // AFTER the field write on purpose: the playbook's criteria and deliverables
  // MERGE onto what this same call may just have written (caller's first), and
  // `followPlaybook` takes its own row lock to read that post-write state.
  //
  // A refusal does NOT throw: the rest of the patch legitimately landed, and
  // failing the whole call would leave the caller unable to tell which half
  // applied. It rides back on `followRefusal`, like `completeOutput` does.
  let followOutcome: FollowOutcome | undefined;
  let followRefusal: string | undefined;
  let followedSession: typeof updated | undefined;
  if (params.followPlaybookId !== undefined) {
    const { followPlaybook } = await import("./follow-playbook.js");
    const followed = await followPlaybook({
      sessionId,
      userId,
      agentUserId,
      followPlaybookId: params.followPlaybookId,
      followStageKey: params.followStageKey,
      params: params.params,
    });
    switch (followed.status) {
      case "ok":
        followOutcome = followed.follow;
        followedSession = followed.session as typeof updated;
        break;
      case "refused":
        followRefusal = followed.reason;
        break;
      case "proposed":
        followRefusal = followed.reason;
        break;
      case "not_found":
        followRefusal = `Focus session ${sessionId} not found`;
        break;
    }
  }

  // After the write: a guideline annotates the block, it never gates it.
  const blockGuidelines = await guidanceForBlockedSlots({
    userId,
    workspaceId: existing.workspaceId ?? null,
    slots: blockedByThisPatch,
  });

  // The row the FOLLOW wrote wins when there was one — it is strictly later
  // than `updated` and carries the `playbookId`, the merged criteria and the
  // merged deliverables. Returning the pre-follow row would tell the caller its
  // attach did nothing.
  const finalSession = followedSession ?? updated;
  return {
    status: "updated",
    session: gatedStatus
      ? { ...finalSession, status: gatedStatus }
      : finalSession,
    ...(completeOutputOutcome ? { completeOutput: completeOutputOutcome } : {}),
    ...(blockGuidelines ? { blockGuidelines } : {}),
    ...(followOutcome ? { follow: followOutcome } : {}),
    ...(followRefusal ? { followRefusal } : {}),
  };
}
