/**
 * Proposal fingerprint + cluster collapse — the PURE core behind
 * `proposals.groups`.
 *
 * ONE fingerprint per proposal = proposalType × targetType × a normalized
 * target-signature. Identical-shape PENDING proposals collapse to a single
 * cluster card (count + sample + sources), so the redesigned inbox can show
 * "12 proposals want to set `industry`" as one reviewable group instead of 12
 * rows.
 *
 * v1 groups STRUCTURALLY — the same change on the same target. The deeper
 * "shared cause" (e.g. all these updates set the SAME missing property) is a
 * later axis; see FINGERPRINT_CAUSE_EXTENSION below. The AI names that cause
 * later — not this code.
 *
 * PURE + DB-free by construction: the router resolves provenance labels (agent
 * display name / automationId) then hands rows here. Everything in this file is
 * unit-testable without a database.
 *
 * NOTE: this is intentional review-GROUPING, not a duplicate detector — the
 * strict, preventive de-dup mechanism is `dedup_hash` + the 0208 partial
 * unique index (`WHERE status='pending' AND agent_user_id IS NOT NULL`), which
 * runs at write time and is unaffected by anything in this file.
 */

import type { PROPOSE_REASON } from "@synap/governance-policy";
import { proposalClassFields, type ProposalClass } from "./proposal-class.js";

/**
 * The minimum a proposal row must expose to be fingerprinted. Mirrors the
 * `proposals` columns (proposalType / targetType / targetId / data) — no DB
 * dependency, so callers can pass a real row or a synthetic test row.
 */
export interface ProposalFingerprintInput {
  proposalType: string;
  targetType: string;
  targetId: string;
  /** The raw `proposals.data` JSONB payload (request envelope or flat entity). */
  data: unknown;
}

/** The three change classes that decide HOW the target-signature is derived. */
type ChangeClass = "create" | "delete" | "mutate";

/**
 * Classify a proposalType into a change class. Deliberately the same vocabulary
 * `runs`' `deriveChangeKind` reads (create/update/delete family + `.create` /
 * `.delete` suffixes), collapsed to a 3-way: anything that is not a create or a
 * delete (update / edit / merge / …) is a `mutate` of an existing target.
 */
function classifyChange(proposalType: string): ChangeClass {
  const t = proposalType.toLowerCase();
  if (t === "delete" || t.startsWith("delete") || t.endsWith(".delete")) {
    return "delete";
  }
  if (
    t === "create" ||
    t === "create_composite" ||
    // Structured graph imports create entities (import-orchestrator stamps
    // "import.graph"), so they cluster with the create signature.
    t === "import.graph" ||
    t.startsWith("create") ||
    t.endsWith(".create")
  ) {
    return "create";
  }
  return "mutate";
}

/**
 * Normalize a free-text signature token: trim, lowercase, collapse internal
 * whitespace. So "Acme Corp", "acme corp", and " Acme  Corp " share a
 * fingerprint (repeated "create company Acme Corp" attempts cluster).
 */
export function normalizeSignatureToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The proposal `data` payload is either a request envelope `{ ..., data: {...} }`
 * or a flat entity record. Return the inner record to read title/name from —
 * the same unwrap `buildRequestFromProposal` performs.
 */
function extractPayload(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== "object") return undefined;
  const raw = data as Record<string, unknown>;
  const nested = raw.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return raw;
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const v = record?.[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * Best-effort human name for a proposal's target, from its data payload. Same
 * priority `resolveTargetName` / `displayLabelFromRecord` use: an explicit
 * envelope `targetName`, then title / name / displayName / label on the payload.
 * Returns undefined when nothing usable is present.
 */
export function extractProposalName(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const envelope = data as Record<string, unknown>;
  const payload = extractPayload(data);
  return (
    stringField(envelope, "targetName") ??
    stringField(payload, "title") ??
    stringField(payload, "name") ??
    stringField(payload, "displayName") ??
    stringField(payload, "label")
  );
}

// NUL separator: can never appear in a proposalType / targetType / normalized
// name, so distinct triples can never collide into one fingerprint.
const SEP = "\x00";

/**
 * The proposal's structural fingerprint: proposalType × targetType × a
 * normalized target-signature.
 *
 *  - create   → signature is the normalized proposed NAME (a create has no
 *               stable target entity yet — `targetId` is a fresh placeholder,
 *               unique per attempt — so id-grouping would never cluster
 *               "create company X" repeats). Falls back to the id when the
 *               payload carries no name.
 *  - mutate / delete / merge → signature is the target ENTITY id (the sharpest
 *               "same thing" key). Falls back to a normalized name only when no
 *               usable id is stamped.
 *
 * FINGERPRINT_CAUSE_EXTENSION (v2, NOT this task): to make clusters reflect a
 * SHARED CAUSE — e.g. "all these updates set the SAME missing property
 * `industry`" — extend the signature with a 4th axis derived from the change
 * payload (the sorted set of `data.properties` keys, or an AI-named cause
 * label) here, keyed into the string below. `collapseProposalsToClusters`
 * needs NO change — it groups on whatever this returns. Kept out of v1
 * deliberately: structural grouping is safe and needs no semantic model.
 */
export function computeProposalFingerprint(
  p: ProposalFingerprintInput
): string {
  const cls = classifyChange(p.proposalType);

  let signature: string;
  if (cls === "create") {
    const name = extractProposalName(p.data);
    signature = name
      ? `name:${normalizeSignatureToken(name)}`
      : `id:${p.targetId}`;
  } else {
    const id = p.targetId?.trim();
    if (id) {
      signature = `id:${id}`;
    } else {
      const name = extractProposalName(p.data);
      signature = name ? `name:${normalizeSignatureToken(name)}` : "id:";
    }
  }

  return `${p.proposalType}${SEP}${p.targetType}${SEP}${signature}`;
}

// ── Cluster collapse (pure) ──────────────────────────────────────────────────

/**
 * A row fed to the collapse. Extends the fingerprint input with the display /
 * provenance fields the router has already resolved (agent display name from
 * `users`, automationId from the step-run chain) so this stays DB-free.
 */
export interface ClusterInputRow extends ProposalFingerprintInput {
  id: string;
  createdAt: Date;
  workspaceId: string | null;
  /** Resolved agent display name (proposals.agentUserId → users). */
  agentLabel?: string | null;
  /** Raw proposals.agentUserId — carried alongside agentLabel so a source can
   *  deep-link to the agent dossier without a second lookup. */
  agentUserId?: string | null;
  sessionId?: string | null;
  /** Resolved automationId (proposals.stepRunId → step_run → run). */
  automationId?: string | null;
  /**
   * `proposals.governance_reason` — the PROPOSE_REASON the pure engine stamped.
   * Carried because it is NOT type-determined: rungs 2 (ADMIN), 2.5
   * (DESTRUCTIVE), 2.55 (UNTRUSTED_ORIGIN) and SCOPE_IDENTITY_CHANGE escalate
   * on the WRITE's circumstances, not on its `proposalType`/`targetType`. So a
   * floor-escalated proposal fingerprints IDENTICALLY to a routine one, and
   * without this the cluster card cannot tell a reviewer that one of its 411
   * members only reached review because its instruction came from an untrusted
   * channel.
   */
  governanceReason?: string | null;
}

/**
 * Reasons whose entire purpose is to force a HUMAN to look at that specific
 * write. A member carrying one of these must never be summarised away inside a
 * group — the floors exist to buy per-item attention, and folding them into a
 * count is the one operation that spends it.
 *
 * `DAILY_WRITE_CEILING` is deliberately NOT here: it means "this agent is
 * noisy", which is precisely what grouping is for. It is a volume signal, not a
 * danger signal.
 */
const ATTENTION_FLOOR_KEYS = [
  "ADMIN",
  "DESTRUCTIVE_HARD_FLOOR",
  "AGENT_OWNED_DESTRUCTIVE",
  "SCOPE_IDENTITY_CHANGE",
  "UNTRUSTED_ORIGIN",
  // `satisfies` ties this list to the engine's own key set: renaming or
  // removing a PROPOSE_REASON key is a compile error here, not a silent
  // floor that stops matching. The Set stays string-typed because the
  // stored `governance_reason` column is a plain string.
] as const satisfies readonly (keyof typeof PROPOSE_REASON)[];

export const ATTENTION_FLOOR_REASONS: ReadonlySet<string> = new Set(
  ATTENTION_FLOOR_KEYS
);

/** One distinct origin behind a cluster's proposals. */
export interface ProposalClusterSource {
  agentLabel?: string;
  /** Stable agent id, carried alongside agentLabel for deep-linking (e.g. the
   *  agent dossier) — optional so existing callers that never populated it on
   *  `ClusterInputRow` keep compiling unchanged. */
  agentUserId?: string;
  sessionId?: string;
  automationId?: string;
}

/** One collapsed cluster card. */
export interface ProposalCluster {
  fingerprint: string;
  proposalType: string;
  targetType: string;
  /** Human label for the shared target (name, else `<type> · <shortId>`). */
  targetLabel: string;
  /**
   * Decision CLASS of the cluster — derived from the fingerprint's own
   * (proposalType, targetType), which every member shares BY CONSTRUCTION:
   * both columns are fingerprint inputs, so a cluster can never mix classes.
   */
  class: ProposalClass;
  /** Hours this class stays answerable; `null` when it never expires. */
  lifetimeHours: number | null;
  count: number;
  /** Up to `sampleCap` member proposal ids (newest-first as fed). */
  sampleProposalIds: string[];
  /** Distinct origins that produced the cluster's proposals. */
  sources: ProposalClusterSource[];
  latestAt: Date;
  /** Distinct workspaces the cluster's proposals span. */
  workspaceIds: string[];
  /**
   * Member count per `governance_reason`, so a card can render its composition
   * ("152 routine · 2 destructive · 1 untrusted origin") instead of a bare
   * total. Terraform's plan rollup is the precedent: never "N changes", always
   * N-to-add / N-to-change / N-to-destroy BEFORE the verb.
   */
  reasonCounts: Record<string, number>;
  /**
   * How many members carry an {@link ATTENTION_FLOOR_REASONS} reason. NON-ZERO
   * MEANS THE GROUP IS NOT SAFE TO APPROVE AS A UNIT — those members were
   * escalated precisely so a human would look at each one. Callers must carve
   * them out, never sweep them in.
   */
  attentionFloorCount: number;
}

const DEFAULT_SAMPLE_CAP = 20;

/** The target label for a cluster: proposed name, else `<type> · <shortId>`. */
function resolveTargetLabel(row: ProposalFingerprintInput): string {
  const name = extractProposalName(row.data);
  if (name) return name;
  const type = row.targetType || "entity";
  const id = row.targetId ? row.targetId.slice(0, 8) : "";
  return id ? `${type} · ${id}` : type;
}

interface ClusterAccumulator {
  fingerprint: string;
  proposalType: string;
  targetType: string;
  targetLabel: string;
  count: number;
  sampleProposalIds: string[];
  sourceKeys: Set<string>;
  sources: ProposalClusterSource[];
  latestAt: Date;
  workspaceIds: Set<string>;
  reasonCounts: Record<string, number>;
  attentionFloorCount: number;
}

/**
 * Collapse proposal rows into fingerprint clusters. Pure: identical-shape rows
 * share a fingerprint and fold into one cluster; rows differing in proposalType,
 * targetType, or target-signature land in different clusters. Clusters are
 * returned newest-active first (max `createdAt`), mirroring `runs.groups`.
 */
export function collapseProposalsToClusters(
  rows: ClusterInputRow[],
  opts?: { sampleCap?: number }
): ProposalCluster[] {
  const sampleCap = opts?.sampleCap ?? DEFAULT_SAMPLE_CAP;
  const byFingerprint = new Map<string, ClusterAccumulator>();

  for (const row of rows) {
    const fingerprint = computeProposalFingerprint(row);
    let acc = byFingerprint.get(fingerprint);
    if (!acc) {
      acc = {
        fingerprint,
        proposalType: row.proposalType,
        targetType: row.targetType,
        targetLabel: resolveTargetLabel(row),
        count: 0,
        sampleProposalIds: [],
        sourceKeys: new Set<string>(),
        sources: [],
        latestAt: row.createdAt,
        workspaceIds: new Set<string>(),
        reasonCounts: {},
        attentionFloorCount: 0,
      };
      byFingerprint.set(fingerprint, acc);
    }

    acc.count += 1;
    if (acc.sampleProposalIds.length < sampleCap) {
      acc.sampleProposalIds.push(row.id);
    }
    if (row.createdAt.getTime() > acc.latestAt.getTime()) {
      acc.latestAt = row.createdAt;
    }
    if (row.workspaceId) acc.workspaceIds.add(row.workspaceId);

    // Composition. An absent reason is counted under "unspecified" rather than
    // dropped — a member whose escalation cause is unknown must still show up
    // in the rollup, or the counts silently stop summing to `count`.
    const reason = row.governanceReason?.trim() || "unspecified";
    acc.reasonCounts[reason] = (acc.reasonCounts[reason] ?? 0) + 1;
    if (ATTENTION_FLOOR_REASONS.has(reason)) acc.attentionFloorCount += 1;

    // A source tuple only when at least one provenance dimension is present —
    // deduped across the cluster so N proposals from one session count once.
    const source: ProposalClusterSource = {};
    if (row.agentLabel) source.agentLabel = row.agentLabel;
    if (row.agentUserId) source.agentUserId = row.agentUserId;
    if (row.sessionId) source.sessionId = row.sessionId;
    if (row.automationId) source.automationId = row.automationId;
    if (source.agentLabel || source.sessionId || source.automationId) {
      // Keyed on agentUserId (not just the display label) so two distinct
      // agents that happen to share a display name never dedupe into one
      // source — mirrors the scorecard's rationale for keying on the stable id.
      const key = `${source.agentUserId ?? source.agentLabel ?? ""}${SEP}${
        source.sessionId ?? ""
      }${SEP}${source.automationId ?? ""}`;
      if (!acc.sourceKeys.has(key)) {
        acc.sourceKeys.add(key);
        acc.sources.push(source);
      }
    }
  }

  const clusters = [...byFingerprint.values()].map((acc) => ({
    fingerprint: acc.fingerprint,
    proposalType: acc.proposalType,
    targetType: acc.targetType,
    targetLabel: acc.targetLabel,
    ...proposalClassFields(acc.proposalType, acc.targetType),
    count: acc.count,
    sampleProposalIds: acc.sampleProposalIds,
    sources: acc.sources,
    latestAt: acc.latestAt,
    workspaceIds: [...acc.workspaceIds],
    reasonCounts: acc.reasonCounts,
    attentionFloorCount: acc.attentionFloorCount,
  }));
  clusters.sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime());
  return clusters;
}
