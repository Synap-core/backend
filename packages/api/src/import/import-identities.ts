/**
 * Who each imported row IS — decided at analyze the way `entities.create` will
 * decide it at apply, so approving the import cannot fail on a name.
 *
 * MEASURED (live dry run on a real contacts export, 2026-10-23): the pod
 * already held 13 people with the exact name of an imported row and analyze
 * linked none of them. At approval each would hit the create door's weak
 * same-name gate (CONFLICT) and refuse the whole 2,800-op proposal:
 *   - 2 had the SAME LinkedIn URL as the row;
 *   - 9 had no strong signal at all (a phone or calendar contact: a name only);
 *   - 2 had a strong signal of another type (an email) and none of the row's;
 *   - and one name appeared twice in the file with two different LinkedIn
 *     URLs: two real people.
 *
 * The rule, per created row (a `create_entity` op that links nothing yet),
 * against the same-kind, same-name entities the caller can see — the pod's
 * and the rows before it in this import:
 *   1. a candidate holding the SAME value of a strong signal the row carries
 *      (email, phone, LinkedIn URL, website, handles — `extractIdentitySignals`)
 *      → LINK it ("signal");
 *   2. else a candidate with NO conflicting value (for every signal type the
 *      row carries, the candidate holds none of that type) → LINK the earliest
 *      such one, flagged "matched by name" for the reviewer;
 *   3. else every candidate holds a DIFFERENT value of a type the row carries →
 *      a distinct subject: CREATE it, with the create door's one bypass of the
 *      weak same-name gate, the `separate` identity resolution. A row with no
 *      strong signal never reaches 3 (rule 2 always matches it), so the weak
 *      guard is never bypassed for a name alone.
 * A pod link also fills what the row knows and the existing entity lacks (an
 * empty property only — never overwrites) through a visible `update_entity` op.
 *
 * Pure. The pod candidates (and the ids the strong-signal index resolves) are
 * looked up by the caller.
 */

import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  extractIdentitySignals,
  isEmptyPropertyValue,
  normalizeIdentitySignal,
} from "@synap/database";
import { normalizeLinkTargetName } from "./import-items.js";

/** A same-kind, same-name entity already in the pod. */
export interface PodIdentityCandidate {
  id: string;
  type: string;
  title: string | null;
  properties: Record<string, unknown>;
}

export interface ImportIdentityDecision {
  ref: string;
  title: string;
  /** The pod entity id, or the ref of an earlier row of this import. */
  target?: string;
  matchedBy?: "signal" | "name";
  /** Created as a distinct subject despite a same-name entity. */
  separate?: true;
  /** Why it was kept separate (the conflicting signal types). */
  reason?: string;
}

export interface ImportIdentityPlan {
  operations: CompositeProposalOperation[];
  /** The `separate` resolutions the approval applies (keyed by op ref). */
  identityResolutionByRef: Record<string, { verb: "separate" }>;
  linkedBySignal: ImportIdentityDecision[];
  matchedByName: ImportIdentityDecision[];
  separate: ImportIdentityDecision[];
}

/** Signal type → normalized value, from an entity's own properties. */
export function identitySignalsOf(
  properties: Record<string, unknown> | undefined,
  kind: string
): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of extractIdentitySignals(properties ?? {}, { kind })) {
    if (!out.has(s.type)) {
      out.set(s.type, normalizeIdentitySignal(s.type, s.value));
    }
  }
  return out;
}

type Verdict = "same" | "conflict" | "compatible";

function compare(
  row: Map<string, string>,
  other: Map<string, string>
): Verdict {
  let conflict = false;
  for (const [type, value] of row) {
    const theirs = other.get(type);
    if (theirs === undefined) continue;
    if (theirs === value) return "same";
    conflict = true;
  }
  return conflict ? "conflict" : "compatible";
}

const key = (kind: string, title: string) =>
  `${kind}|${normalizeLinkTargetName(title)}`;

/** The row's properties the existing entity lacks (never an overwrite). */
function missingProperties(
  row: Record<string, unknown> | undefined,
  existing: Record<string, unknown>
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    // The row's "Header: value" dump is provenance, not a fact to merge.
    if (k === "content") continue;
    if (isEmptyPropertyValue(v)) continue;
    if (isEmptyPropertyValue(existing[k])) patch[k] = v;
  }
  return patch;
}

export function planImportIdentities(args: {
  operations: CompositeProposalOperation[];
  /** key(kind, title) → visible same-kind same-name pod entities, oldest first. */
  podCandidates: ReadonlyMap<string, PodIdentityCandidate[]>;
  /** op ref → pod entity the strong-signal index already holds for the row. */
  signalHits: ReadonlyMap<string, PodIdentityCandidate>;
}): ImportIdentityPlan {
  const operations: Array<CompositeProposalOperation | null> = [
    ...args.operations,
  ];
  const fills: CompositeProposalOperation[] = [];
  /** A row folded into an earlier row of this import: its ref → that row's. */
  const mergedInto = new Map<string, string>();
  const plan: ImportIdentityPlan = {
    operations: [],
    identityResolutionByRef: {},
    linkedBySignal: [],
    matchedByName: [],
    separate: [],
  };
  /** What a later row of the same kind and name can match. */
  type Earlier =
    | { pod: PodIdentityCandidate; signals: Map<string, string> }
    | { rowIndex: number; signals: Map<string, string> };
  const earlier = new Map<string, Earlier[]>();
  const remember = (k: string, e: Earlier) => {
    const list = earlier.get(k) ?? [];
    list.push(e);
    earlier.set(k, list);
  };

  args.operations.forEach((op, index) => {
    if (op.op !== "create_entity" || !op.title || !op.ref) return;
    const k = key(op.profileSlug, op.title);
    if (op.existingEntityId) return;
    const signals = identitySignalsOf(op.properties, op.profileSlug);
    const decision: ImportIdentityDecision = { ref: op.ref, title: op.title };
    const record = (matchedBy: "signal" | "name", target: string) => {
      decision.target = target;
      decision.matchedBy = matchedBy;
      (matchedBy === "signal" ? plan.linkedBySignal : plan.matchedByName).push(
        decision
      );
    };

    // A pod entity: link it, fill what it lacks (a visible update op).
    const linkPod = (
      pod: PodIdentityCandidate,
      matchedBy: "signal" | "name"
    ) => {
      operations[index] = { ...op, existingEntityId: pod.id };
      record(matchedBy, pod.id);
      const patch = missingProperties(op.properties, pod.properties);
      if (Object.keys(patch).length > 0) {
        fills.push({
          op: "update_entity",
          ref: `${op.ref}-fill`,
          entityId: pod.id,
          patch: { properties: patch },
        });
      }
      remember(k, { pod, signals });
    };
    // An earlier row of this import: fold this row into it (one subject).
    const foldInto = (rowIndex: number, matchedBy: "signal" | "name") => {
      const target = operations[rowIndex] as Extract<
        CompositeProposalOperation,
        { op: "create_entity" }
      >;
      const extra = missingProperties(op.properties, target.properties ?? {});
      operations[rowIndex] = {
        ...target,
        properties: { ...(target.properties ?? {}), ...extra },
      };
      operations[index] = null;
      mergedInto.set(op.ref!, target.ref!);
      record(matchedBy, target.ref!);
    };

    const hit = args.signalHits.get(op.ref);
    if (hit) return linkPod(hit, "signal");

    const candidates: Array<{ e: Earlier; verdict: Verdict }> = [
      ...(args.podCandidates.get(k) ?? []).map((pod) => ({
        pod,
        signals: identitySignalsOf(pod.properties, pod.type),
      })),
      ...(earlier.get(k) ?? []),
    ].map((e) => ({ e, verdict: compare(signals, e.signals) }));

    const pick =
      candidates.find((c) => c.verdict === "same") ??
      candidates.find((c) => c.verdict === "compatible");
    if (pick) {
      const matchedBy = pick.verdict === "same" ? "signal" : "name";
      if ("pod" in pick.e) return linkPod(pick.e.pod, matchedBy);
      return foldInto(pick.e.rowIndex, matchedBy);
    }

    if (candidates.length > 0) {
      // Every same-name candidate holds a different value of a strong signal
      // this row carries: a distinct subject (rule 3).
      decision.separate = true;
      decision.reason = `same name as ${candidates.length} other with a different ${[
        ...signals.keys(),
      ].join(" / ")}`;
      plan.identityResolutionByRef[op.ref] = { verb: "separate" };
      plan.separate.push(decision);
    }
    remember(k, { rowIndex: index, signals });
  });

  // A folded row's relations land on the row it was folded into.
  const retarget = (ref: string) => mergedInto.get(ref) ?? ref;
  const kept = operations
    .filter((op): op is CompositeProposalOperation => op !== null)
    .map((op) =>
      op.op === "create_relation"
        ? {
            ...op,
            sourceRef: retarget(op.sourceRef),
            targetRef: retarget(op.targetRef),
          }
        : op
    );
  // Fills run after the entity creates (pass 1u), before relations.
  plan.operations = [...kept, ...fills];
  return plan;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rows listed per bucket on the proposal (counts are always complete). */
const IDENTITY_LIST_CAP = 200;

/** What the reviewer is shown: counts, and the rows themselves (capped). */
export interface ImportIdentitiesSummary {
  /** Linked to a pod entity holding the same strong signal. */
  linkedBySignal: number;
  /** Linked to a pod entity on its NAME alone — the reviewer should check. */
  matchedByName: number;
  /** Rows of this import folded into an earlier row naming the same subject. */
  foldedInFile: number;
  /** Created as distinct subjects despite a same-name entity. */
  separate: number;
  rows: {
    matchedByName: ImportIdentityDecision[];
    separate: ImportIdentityDecision[];
    linkedBySignal: ImportIdentityDecision[];
  };
}

export function summarizeIdentities(
  plan: ImportIdentityPlan
): ImportIdentitiesSummary {
  const pod = (list: ImportIdentityDecision[]) =>
    list.filter((d) => d.target && UUID.test(d.target));
  const inFile = [...plan.linkedBySignal, ...plan.matchedByName].filter(
    (d) => !d.target || !UUID.test(d.target)
  );
  return {
    linkedBySignal: pod(plan.linkedBySignal).length,
    matchedByName: pod(plan.matchedByName).length,
    foldedInFile: inFile.length,
    separate: plan.separate.length,
    rows: {
      matchedByName: pod(plan.matchedByName).slice(0, IDENTITY_LIST_CAP),
      separate: plan.separate.slice(0, IDENTITY_LIST_CAP),
      linkedBySignal: pod(plan.linkedBySignal).slice(0, IDENTITY_LIST_CAP),
    },
  };
}
