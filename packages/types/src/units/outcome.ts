/**
 * OUTCOMES and INPUTS of a session — ONE read-time projection over today's
 * storage, so every surface (pod read doors, browser room, Relay) shows the
 * same two lists.
 *
 * A session stores what it must yield in three places that never knew about
 * each other: `focus_sessions.expected_outputs` (declared slots), `criteria`
 * (graded facts, verdicts in `session_evaluations`), and what it PRODUCED
 * (`artifacts` rows + `produced` links, joined by the pod's
 * `listSessionOutputs`). This module re-reads them as:
 *
 *   OUTCOME — a thing the work must yield. A deliverable slot (the agent's, or
 *     a person's own real deliverable) or a criterion (an outcome whose thing
 *     is a FACT). Each carries a stable `key`, how it is checked (`verify`),
 *     its state mark (`resolveUnitState`, never a sentence) and the produced
 *     items that are its `evidence`.
 *   INPUT — what the work needs FROM THE PERSON: a playbook param slot, an
 *     escalated criterion's grade, a slot the agent handed over on a blocker
 *     (`owner: 'human'` + `blockedReason`/`ask`) and an asked-and-answered
 *     question. An input POINTS AT the outcome it blocks (`blocksOutcomeKey`)
 *     — it is never a second outcome.
 *   UNATTACHED — produced items that serve no outcome.
 *
 * NO STORAGE MOVES. Inputs stay physically in `expected_outputs`, because every
 * "needs you" count (the pod's `owedSlotWhere` SQL, partial index 0250, the
 * notifications, Relay's tray, the browser's signals) reads human-owned slots
 * out of that one array. Splitting it at READ time keeps all of them true.
 *
 * ── THE RULES, EACH WITH A FIXTURE ROW THAT RULES OUT ITS RIVAL ────────────
 *  1. A param slot (`PARAM_SLOT_KIND`) is an input ONLY — it asks for a value,
 *     it yields nothing.
 *  2. An escalated criterion slot (`CRITERION_SLOT_KIND`) is an input ONLY,
 *     pointing at its criterion's outcome through `criterionKey` (never by
 *     matching its prose label back).
 *  3. Every other slot is an outcome — including one the person owns. A
 *     person's own deliverable (no blocker, no ask) is an outcome checked by
 *     `human`, and NOT an input: it is something the work yields, not something
 *     the agent is waiting on.
 *  4. A slot handed to the person on a blocker (or with an ask) is BOTH: the
 *     outcome stays on the list (the work still owes it) and an input points
 *     at it. Rival "blocked ⇒ input instead" would make "50 qualified leads"
 *     vanish from the outcome list the moment the agent asks a question.
 *  5. RETIRED is never met, never owed: the outcome shows done-stopped, and no
 *     input is raised for a retired human slot.
 *  6. `claimedDone` is not met — it reads `needs_review` until a door stamps
 *     `done` (the agent grading its own homework is not a verdict). Since A3
 *     the agent brings EVIDENCE and a door decides: approval, attestation, or
 *     the pod's evidence verdict (a claim + a produced object attributed to
 *     the slot, or its `ref`). `metBy` names which one — a `done` with no
 *     lineage is `unverified` (stamped by the pre-A3 agent mark).
 *  7. A criterion's state is its CURRENT verdict (`latestEvaluationPerCriterion`
 *     — a human row beats any later non-human row). A slot and a criterion that
 *     share a key are ONE outcome (the slot names it, the criterion checks it).
 *  8. Evidence joins by KEY first, then by the normalised label; a produced
 *     item that names no outcome is UNATTACHED. (Known edge: two LEGACY slots
 *     sharing one label, neither keyed yet — label evidence lands on the
 *     first. The first write through any slot door keys them, A2.)
 *
 * KEYS. A slot's identity is its stored `key` (server-stamped since A2). A
 * slot stored before keys existed gets one DERIVED here by the SAME function
 * the pod stamps with ({@link deriveSlotKeys}): a slug of its label, suffixed
 * `-2`, `-3`… on collision, in array order. So the key a reader sees today is
 * the key the next write stamps.
 *
 * PURE and dependency-free, like `deliverable.ts`: shapes are structural so a
 * stored jsonb array, a wire payload and a fixture all fit.
 */

import { CRITERION_SLOT_KIND } from "../focus-sessions/criterion-slot.js";
import { PARAM_SLOT_KIND } from "../focus-sessions/param-slot.js";
import {
  latestEvaluationPerCriterion,
  type EvaluationRowLike,
  type EvaluationVerdict,
  type EvaluatorKind,
} from "../focus-sessions/verdict.js";
import { humanizeToken } from "../vocabulary/index.js";
import {
  deliverableUnitInput,
  isDeliverableOutstanding,
  type DeliverableFacts,
} from "./deliverable.js";
import {
  resolveUnitState,
  type UnitStateInput,
  type UnitStateView,
} from "./state.js";

// ─── Slot shape (structural; three template shapes accepted) ───────────────

/**
 * One stored slot, read leniently. Three shapes reach `expected_outputs`:
 * `{kind, label}` (every door that declares one), `{type, description}`
 * (CP pack templates, e.g. deep-research) and `{kind, profileSlug,
 * description}` (capability templates). A slot with no `label` is NOT
 * malformed — it is a template slot, and it still gets a name and a key.
 */
export interface SlotFacts extends DeliverableFacts {
  key?: string | null;
  kind?: string | null;
  label?: string | null;
  /** Template shape: `{type, description}`. */
  type?: string | null;
  description?: string | null;
  /** Template shape: `{kind, profileSlug, description}`. */
  profileSlug?: string | null;
  blockedReason?: string | null;
  why?: string | null;
  owedSince?: string | null;
  /** Present ⇒ the person has a typed way to answer (opaque here). */
  ask?: unknown;
  /** Present ⇒ the person answered (opaque here). */
  answer?: unknown;
  criterionKey?: string | null;
  paramName?: string | null;
  icon?: string | null;
  ref?: unknown;
  /** Receipts behind a `done` — which door earned it (see `OutcomeMetBy`). */
  satisfiedByProposalId?: string | null;
  attestedBy?: string | null;
  satisfiedByEvidence?: unknown;
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asSlot(raw: unknown): SlotFacts | null {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as SlotFacts)
    : null;
}

/** The slot's kind across the three shapes; `"output"` when none is named. */
export function slotKindOf(slot: SlotFacts): string {
  return text(slot.kind) ?? text(slot.type) ?? "output";
}

/**
 * The slot's NAME across the three shapes: its `label`, else the template's
 * `description`, else its kind in words (`humanizeToken`). Never empty.
 */
export function slotLabelOf(slot: SlotFacts): string {
  return (
    text(slot.label) ??
    text(slot.description) ??
    humanizeToken(text(slot.profileSlug) ?? slotKindOf(slot))
  );
}

/**
 * Trim + casefold — the label comparison every pod slot door uses
 * (`normalizeExpectedLabel`). Restated here, not imported: the pod's copy
 * lives in `@synap/api`, which no client can resolve. Same two operations.
 */
export function normalizeSlotLabel(
  label: string | null | undefined
): string | undefined {
  if (typeof label !== "string") return undefined;
  const t = label.trim().toLowerCase();
  return t || undefined;
}

/** Longest derived key, before a collision suffix. */
export const SLOT_KEY_MAX_CHARS = 48;

/** A label as a key: ascii, lowercase, `-` separated, never empty. */
export function slotKeyBase(label: string): string {
  const slug = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLOT_KEY_MAX_CHARS)
    .replace(/-+$/g, "");
  return slug || "output";
}

/**
 * The key of every slot, by index — the STORED key when the slot carries a
 * usable one (first holder wins on a duplicate), else one derived from its
 * name, unique within the array. Deterministic in array order, so a reader and
 * the stamping write agree on a legacy slot's key. Non-object entries get
 * `null`.
 */
export function deriveSlotKeys(
  slots: readonly unknown[]
): Array<string | null> {
  const taken = new Set<string>();
  const stored: Array<string | undefined> = slots.map((raw) => {
    const key = text(asSlot(raw)?.key);
    if (!key || taken.has(key)) return undefined;
    taken.add(key);
    return key;
  });
  return slots.map((raw, i) => {
    const slot = asSlot(raw);
    if (!slot) return null;
    const own = stored[i];
    if (own) return own;
    const base = slotKeyBase(slotLabelOf(slot));
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
    taken.add(key);
    return key;
  });
}

/**
 * Every slot with its key STAMPED — the write-side twin of
 * {@link deriveSlotKeys}. Slots that already carry their key are returned as
 * the same object; a non-array is returned untouched (a reader of a corrupt
 * bag must not have it "repaired" into a different shape on write).
 */
export function stampSlotKeys<T>(slots: T): T {
  if (!Array.isArray(slots)) return slots;
  const keys = deriveSlotKeys(slots);
  let changed = false;
  const out = slots.map((raw, i) => {
    const key = keys[i];
    const slot = asSlot(raw);
    if (!slot || !key || slot.key === key) return raw;
    changed = true;
    return { ...slot, key };
  });
  return (changed ? out : slots) as T;
}

// ─── Criteria + produced items (structural) ────────────────────────────────

/** The fields of a `SessionCriterion` (already read by `readCriteria`). */
export interface OutcomeCriterionLike {
  key: string;
  statement: string;
  required?: boolean;
  check: {
    kind: EvaluatorKind;
    capability?: string;
    evidenceKey?: string;
    hint?: string;
  };
  stageKey?: string;
}

/**
 * One produced item (`SessionOutput` from the pod's three-ledger join).
 * `expected` is the slot the join matched it to, if any — key and/or label.
 */
export interface ProducedItemLike {
  id: string;
  expected?: { key?: string | null; label?: string | null } | null;
}

// ─── The projection ────────────────────────────────────────────────────────

/** How an outcome gets checked — the trust ladder, cheapest first. */
export type OutcomeVerify = EvaluatorKind;

/**
 * WHICH door met an outcome: an approved proposal, the person's attestation,
 * the pod's evidence verdict, a criterion's `pass` verdict — or `unverified`,
 * a `done` with no receipt at all (the pre-A3 agent self-mark).
 */
export type OutcomeMetBy =
  "approval" | "attestation" | "evidence" | "verdict" | "unverified";

function slotMetBy(slot: SlotFacts): OutcomeMetBy {
  if (text(slot.satisfiedByProposalId)) return "approval";
  if (text(slot.attestedBy)) return "attestation";
  if (slot.satisfiedByEvidence != null) return "evidence";
  return "unverified";
}

/** The CURRENT verdict behind a criterion outcome. */
export interface OutcomeVerdict {
  verdict: EvaluationVerdict;
  evaluatorKind: EvaluatorKind;
  at: string;
}

export interface SessionOutcome<P extends ProducedItemLike = ProducedItemLike> {
  /** Stable identity: the slot's key, or the criterion's key. */
  key: string;
  /** What it is, in words. */
  label: string;
  /** Slot kind (`report`, `document`, …), or `"fact"` for a criterion. */
  kind: string;
  /** Which store(s) declared it. */
  source: "slot" | "criterion" | "slot+criterion";
  /** Who yields it. */
  owner: "agent" | "human";
  verify: OutcomeVerify;
  /** Absent on the criterion = true; a declared slot is always required. */
  required: boolean;
  /** Delivered (slot stamped done) or proven (current verdict `pass`). */
  met: boolean;
  /** Which door met it; `null` while not met. */
  metBy: OutcomeMetBy | null;
  /** Let go when its session was cancelled — neither met nor owed. */
  retired: boolean;
  /** THE mark (tone + glyph), from the one derivation. */
  state: UnitStateView;
  /** Criterion outcomes only: the current verdict, or null if never checked. */
  verdict: OutcomeVerdict | null;
  /** Produced items joined to it (key first, then label). */
  evidence: P[];
  stageKey?: string;
  /** The stored slot's label — what the label-matching slot doors address. */
  slotLabel?: string;
  /** Criterion check detail, when it names one. */
  capability?: string;
  evidenceKey?: string;
}

/** What an input asks the person for. */
export type SessionInputNeed =
  /** A playbook param value (`PARAM_SLOT_KIND`). */
  | "param"
  /** A pass/fail grade on an escalated criterion (`CRITERION_SLOT_KIND`). */
  | "grade"
  /** A blocker class (`BLOCKED_REASONS`: decision, credential, …). */
  | (string & {});

export interface SessionInput {
  /** The slot's key. */
  key: string;
  label: string;
  need: SessionInputNeed;
  /** Still waiting on the person. */
  open: boolean;
  /** The person answered it (the agent has it now). */
  answered: boolean;
  state: UnitStateView;
  /** The outcome this blocks — null when it names none it can be traced to. */
  blocksOutcomeKey: string | null;
  blockedReason?: string;
  why?: string;
  owedSince?: string;
  /** Opaque: the typed ask, for the surface's ask renderer. */
  ask?: unknown;
  paramName?: string;
  criterionKey?: string;
  /** The stored slot's label — what the label-matching answer doors address. */
  slotLabel: string;
}

export interface SessionOutcomesView<
  P extends ProducedItemLike = ProducedItemLike,
> {
  outcomes: SessionOutcome<P>[];
  inputs: SessionInput[];
  /** Produced items that serve no outcome. */
  unattached: P[];
  /** Met / total over outcomes that were not retired. */
  counts: { met: number; total: number };
}

export interface OutcomeProjectionInput<
  P extends ProducedItemLike = ProducedItemLike,
> {
  /** `focus_sessions.expected_outputs`, raw. */
  expectedOutputs: unknown;
  /** `focus_sessions.criteria`, already read (`readCriteria`). */
  criteria?: readonly OutcomeCriterionLike[] | null;
  /** Every `session_evaluations` row of the session. */
  evaluations?: readonly EvaluationRowLike[] | null;
  /** The joined produced items (`listSessionOutputs().outputs`). */
  produced?: readonly P[] | null;
  /** The session is closed / cancelled / failed. Required: see deliverable.ts. */
  sessionTerminal: boolean;
}

function isoOf(v: Date | string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function slotOwner(slot: SlotFacts): "agent" | "human" {
  return slot.owner === "human" ? "human" : "agent";
}

function inputState(slot: SlotFacts): UnitStateInput {
  if (!isDeliverableOutstanding(slot)) return { terminal: true };
  if (slot.owner === "human") return { owedFromYou: 1 };
  if (slot.answer != null) return { terminal: true };
  return { running: true };
}

function criterionState(
  c: OutcomeCriterionLike,
  verdict: OutcomeVerdict | null,
  gradeOwed: boolean,
  sessionTerminal: boolean
): UnitStateInput {
  if (verdict?.verdict === "pass") return { terminal: true };
  if (verdict?.verdict === "fail") return { failed: true };
  if (gradeOwed || c.check.kind === "human") return { owedFromYou: 1 };
  if (verdict?.verdict === "unmeasured") return { unreadable: true };
  return sessionTerminal ? { unreadable: true } : { running: true };
}

/** The one projection. See the header for the rules and their order. */
export function projectSessionOutcomes<P extends ProducedItemLike>(
  input: OutcomeProjectionInput<P>
): SessionOutcomesView<P> {
  const raw = Array.isArray(input.expectedOutputs) ? input.expectedOutputs : [];
  const keys = deriveSlotKeys(raw);
  const criteria = input.criteria ?? [];
  const criterionByKey = new Map(criteria.map((c) => [c.key, c]));
  const verdictByKey = new Map<string, OutcomeVerdict>();
  for (const row of latestEvaluationPerCriterion(input.evaluations ?? [])) {
    verdictByKey.set(row.criterionKey, {
      verdict: row.verdict,
      evaluatorKind: row.evaluatorKind,
      at: isoOf(row.createdAt),
    });
  }

  const outcomes: SessionOutcome<P>[] = [];
  const inputs: SessionInput[] = [];
  /** Criterion keys an OPEN grade input is waiting on. */
  const gradeOwed = new Set<string>();
  const folded = new Set<string>();

  raw.forEach((entry, i) => {
    const slot = asSlot(entry);
    const key = keys[i];
    if (!slot || !key) return;
    const kind = slotKindOf(slot);
    const label = slotLabelOf(slot);
    const slotLabel = typeof slot.label === "string" ? slot.label : label;
    const answered = slot.answer != null;
    const open = isDeliverableOutstanding(slot) && slot.owner === "human";
    const common = {
      key,
      label,
      open,
      answered,
      state: resolveUnitState(inputState(slot)),
      slotLabel,
      ...(text(slot.blockedReason)
        ? { blockedReason: text(slot.blockedReason)! }
        : {}),
      ...(text(slot.why) ? { why: text(slot.why)! } : {}),
      ...(text(slot.owedSince) ? { owedSince: text(slot.owedSince)! } : {}),
      ...(slot.ask != null ? { ask: slot.ask } : {}),
    };

    // (1) A param slot asks for a value; it yields nothing.
    if (kind === PARAM_SLOT_KIND) {
      inputs.push({
        ...common,
        need: "param",
        blocksOutcomeKey: null,
        ...(text(slot.paramName) ? { paramName: text(slot.paramName)! } : {}),
      });
      return;
    }
    // (2) An escalated criterion is that criterion's grade — never an outcome.
    if (kind === CRITERION_SLOT_KIND) {
      const criterionKey = text(slot.criterionKey);
      if (criterionKey && open) gradeOwed.add(criterionKey);
      inputs.push({
        ...common,
        need: "grade",
        blocksOutcomeKey:
          criterionKey && criterionByKey.has(criterionKey)
            ? criterionKey
            : null,
        ...(criterionKey ? { criterionKey } : {}),
      });
      return;
    }

    // (3) Every other slot is an outcome.
    const criterion = criterionByKey.get(key);
    if (criterion) folded.add(key);
    const verdict = criterion ? (verdictByKey.get(key) ?? null) : null;
    const retired = slot.retiredAt != null;
    const delivered = slot.status === "done";
    const met = !retired && (delivered || verdict?.verdict === "pass");
    const state = resolveUnitState(
      // A verdict on the folded criterion is the stronger fact; without one
      // the slot answers by the deliverable rule.
      verdict && !delivered && !retired
        ? criterionState(criterion!, verdict, false, input.sessionTerminal)
        : deliverableUnitInput(slot, {
            sessionTerminal: input.sessionTerminal,
          })
    );
    outcomes.push({
      key,
      label,
      kind,
      source: criterion ? "slot+criterion" : "slot",
      owner: slotOwner(slot),
      verify: criterion
        ? criterion.check.kind
        : slot.owner === "human"
          ? "human"
          : "evidence",
      required: criterion ? criterion.required !== false : true,
      met,
      metBy: !met ? null : delivered ? slotMetBy(slot) : "verdict",
      retired,
      state,
      verdict,
      evidence: [],
      slotLabel,
      ...(criterion?.stageKey ? { stageKey: criterion.stageKey } : {}),
      ...(criterion?.check.capability
        ? { capability: criterion.check.capability }
        : {}),
      ...(criterion?.check.evidenceKey
        ? { evidenceKey: criterion.check.evidenceKey }
        : {}),
    });

    // (4) Handed to the person on a blocker / with an ask, or asked and
    // answered: ALSO an input, pointing at the outcome it blocks (itself).
    if ((open && (text(slot.blockedReason) || slot.ask != null)) || answered) {
      inputs.push({
        ...common,
        need: text(slot.blockedReason) ?? "decision",
        blocksOutcomeKey: key,
      });
    }
  });

  // Criteria no slot already named, in declared order.
  for (const c of criteria) {
    if (folded.has(c.key)) continue;
    const verdict = verdictByKey.get(c.key) ?? null;
    outcomes.push({
      key: c.key,
      label: c.statement,
      kind: "fact",
      source: "criterion",
      owner: c.check.kind === "human" ? "human" : "agent",
      verify: c.check.kind,
      required: c.required !== false,
      met: verdict?.verdict === "pass",
      metBy: verdict?.verdict === "pass" ? "verdict" : null,
      retired: false,
      state: resolveUnitState(
        criterionState(c, verdict, gradeOwed.has(c.key), input.sessionTerminal)
      ),
      verdict,
      evidence: [],
      ...(c.stageKey ? { stageKey: c.stageKey } : {}),
      ...(c.check.capability ? { capability: c.check.capability } : {}),
      ...(c.check.evidenceKey ? { evidenceKey: c.check.evidenceKey } : {}),
    });
  }

  // (8) Evidence: key first, then the normalised label (first slot wins, the
  // same tie-break every pod slot door uses).
  const outcomeByKey = new Map(outcomes.map((o) => [o.key, o]));
  const outcomeByLabel = new Map<string, SessionOutcome<P>>();
  for (const o of outcomes) {
    if (o.source === "criterion") continue;
    const n = normalizeSlotLabel(o.slotLabel);
    if (n && !outcomeByLabel.has(n)) outcomeByLabel.set(n, o);
  }
  const unattached: P[] = [];
  for (const item of input.produced ?? []) {
    const claimedKey = text(item.expected?.key);
    const target =
      (claimedKey ? outcomeByKey.get(claimedKey) : undefined) ??
      outcomeByLabel.get(normalizeSlotLabel(item.expected?.label) ?? "");
    if (target) target.evidence.push(item);
    else unattached.push(item);
  }

  let met = 0;
  let total = 0;
  for (const o of outcomes) {
    if (o.retired) continue;
    total += 1;
    if (o.met) met += 1;
  }
  return { outcomes, inputs, unattached, counts: { met, total } };
}

/** The outcome list alone. */
export function readOutcomes<P extends ProducedItemLike>(
  input: OutcomeProjectionInput<P>
): SessionOutcome<P>[] {
  return projectSessionOutcomes(input).outcomes;
}

/** The input list alone. */
export function readInputs(
  input: OutcomeProjectionInput<ProducedItemLike>
): SessionInput[] {
  return projectSessionOutcomes(input).inputs;
}
