/**
 * listSessionOutputs — the ONE door for "what did this session produce?".
 *
 * A session's outputs live in THREE unjoined ledgers, none of which knows about
 * the others:
 *
 *   1. `links` — `session --produced--> entity` edges (7 writers: materializer,
 *      capture, entities/create, apply-approval, executors/entity,
 *      executors/playbook, hub rest/runs). ENTITIES ONLY.
 *   2. `artifacts` — rows with `sessionId` set (kind view|cell|document|entity|
 *      url), carrying lifecycle `state` and `originKind` provenance.
 *   3. `focus_sessions.expected_outputs` — the DECLARED deliverables, stamped
 *      `done` by the one door `satisfy-expected-output.ts`.
 *
 * Until now they were joined only by a kind-string GUESS in the frontend
 * (`SessionTileContent.tsx`), which cannot tell "the document we declared" from
 * "a document". This service joins them by REF ID first — an artifact's `refId`
 * and a produced edge's `toId` are the same coordinate, and an expected
 * output's `satisfiedByProposalId` resolves through the proposal's `targetId`
 * to that same coordinate — then honours an explicit DECLARED-LABEL claim
 * (`artifacts.props.expectedLabel`, written by the human attach door), and only
 * falls back to kind matching for an expected output with no lineage at all.
 *
 * The join itself (`joinSessionOutputs`) is PURE so the precedence rule is
 * testable without a database; everything around it is fetching.
 */

import {
  db,
  focusSessions,
  artifacts as artifactsTable,
  links,
  proposals,
  entities,
  documents,
  views,
  automations,
  playbooks,
  and,
  eq,
  inArray,
} from "@synap/database";
import { normalizeObjectKind } from "@synap-core/types/vocabulary";
import type { ExpectedOutput } from "@synap/playbooks";
import { UUID_RE } from "./session-metadata.js";

/**
 * One thing a session produced. `id` is the STABLE join coordinate
 * (`<kind>:<refId>`), not a row id — two ledgers describing the same object
 * collapse onto one entry, and the frontend can key on it across refetches.
 */
export interface SessionOutput {
  /** `<kind>:<refId>` — stable across ledgers and refetches. */
  id: string;
  /** Normalized object kind (`document`, `entity`, `view`, `cell`, `url`, …). */
  kind: string;
  /**
   * The UNDERLYING object's id — what navigation must use. NOT the artifact
   * row id: `SessionRoomGroundCell.tsx` opens an artifact by row id today and
   * lands on nothing.
   */
  refId: string;
  title: string;
  icon?: string;
  /** Artifact lifecycle, when an artifact row backs this output. */
  state?: "working" | "kept" | "swept";
  producedAt: Date;
  /** Derivable from artifact provenance or the satisfying proposal's actor. */
  producedBy?: "agent" | "human";
  /** The declared deliverable this object satisfies, when one matched. */
  expected?: {
    label: string;
    status?: "pending" | "done";
    claimedDone?: boolean;
    satisfiedByProposalId?: string;
  };
  /** Which ledger(s) reported it — provenance for the join itself. */
  source: Array<"artifact" | "produced_edge" | "expected">;
}

export interface SessionOutputsResult {
  outputs: SessionOutput[];
  /** Declared deliverables with no produced object behind them. */
  pendingExpected: ExpectedOutput[];
}

export interface ListSessionOutputsParams {
  db: typeof db;
  userId: string;
  sessionId: string;
}

/** Minimal artifact shape the join needs — narrows the select, not the table. */
export interface JoinArtifactRow {
  id: string;
  kind: string;
  refId: string | null;
  cellKey: string | null;
  title: string;
  originKind: "user" | "agent" | "deeplink" | "system";
  state: "working" | "kept" | "swept";
  createdAt: Date;
  /**
   * The declared-output LABEL this artifact was attached against, when its
   * producer named one (`artifacts.props.expectedLabel`). A claim about WHICH
   * slot — never a `done` stamp; only `satisfy-expected-output.ts` writes that.
   */
  expectedLabel?: string | null;
}

/** Minimal produced-edge shape. */
export interface JoinProducedRow {
  toType: string;
  toId: string;
  createdAt: Date;
}

/** The satisfying proposal's coordinate, resolved for expected-output lineage. */
export interface JoinProposalRow {
  id: string;
  targetType: string;
  targetId: string;
  agentUserId: string | null;
}

export interface JoinSessionOutputsInput {
  artifacts: JoinArtifactRow[];
  produced: JoinProducedRow[];
  expectedOutputs: ExpectedOutput[];
  proposals: JoinProposalRow[];
  /** Live titles by `<kind>:<refId>`; absent ⇒ the artifact's own title stands. */
  titles: Map<string, string>;
}

/**
 * A cell artifact has no backing object (`refId` null), so its own row id IS
 * its coordinate. Everything else joins on the referenced object.
 */
function artifactRefId(a: JoinArtifactRow): string {
  return a.refId ?? a.cellKey ?? a.id;
}

function coordinate(kind: string, refId: string): string {
  return `${normalizeObjectKind(kind)}:${refId}`;
}

/**
 * Join the three ledgers. Pure.
 *
 * Precedence, in order:
 *   1. ID JOIN — an artifact and a produced edge naming the same object are one
 *      output, sourced from both.
 *   2. PROPOSAL LINEAGE — an expected output's `satisfiedByProposalId` resolves
 *      through the proposal's `targetType:targetId` onto a produced coordinate.
 *      This is evidence, so it wins over any kind guess.
 *   3. DECLARED LABEL — an artifact recorded with `props.expectedLabel` names
 *      the slot its producer MEANT. A person attaching an existing object to a
 *      session has no proposal to leave lineage on, so without this a
 *      human-produced output could only ever land on the FIRST declared slot of
 *      its kind — wrong the moment two documents are declared. An explicit
 *      claim, so it outranks the kind guess; still evidence-free about
 *      completion, so it never stamps `done`.
 *   4. KIND FALLBACK — only for an expected output with NO proposal lineage,
 *      and only onto an output nothing else has claimed, and never onto one
 *      that claimed a different label (a guess may not overrule a claim).
 *
 * Whatever is left over is `pendingExpected`: declared, not delivered.
 */
export function joinSessionOutputs(
  input: JoinSessionOutputsInput
): SessionOutputsResult {
  const byId = new Map<string, SessionOutput>();
  /** Declared label → the coordinate whose artifact claimed it (first wins). */
  const byExpectedLabel = new Map<string, string>();
  /** The reverse: coordinate → the label its artifact claimed. */
  const labelClaimOf = new Map<string, string>();

  for (const a of input.artifacts) {
    const refId = artifactRefId(a);
    const id = coordinate(a.kind, refId);
    if (a.expectedLabel && !byExpectedLabel.has(a.expectedLabel)) {
      byExpectedLabel.set(a.expectedLabel, id);
      labelClaimOf.set(id, a.expectedLabel);
    }
    const existing = byId.get(id);
    if (existing) {
      // Two artifact rows for one object: keep the earliest, widen nothing.
      if (a.createdAt < existing.producedAt) existing.producedAt = a.createdAt;
      continue;
    }
    byId.set(id, {
      id,
      kind: normalizeObjectKind(a.kind),
      refId,
      title: input.titles.get(id) ?? a.title,
      state: a.state,
      producedAt: a.createdAt,
      ...(a.originKind === "agent"
        ? { producedBy: "agent" as const }
        : a.originKind === "user"
          ? { producedBy: "human" as const }
          : {}),
      source: ["artifact"],
    });
  }

  for (const p of input.produced) {
    const id = coordinate(p.toType, p.toId);
    const existing = byId.get(id);
    if (existing) {
      if (!existing.source.includes("produced_edge")) {
        existing.source.push("produced_edge");
      }
      if (p.createdAt < existing.producedAt) existing.producedAt = p.createdAt;
      continue;
    }
    byId.set(id, {
      id,
      kind: normalizeObjectKind(p.toType),
      refId: p.toId,
      title: input.titles.get(id) ?? p.toId,
      producedAt: p.createdAt,
      source: ["produced_edge"],
    });
  }

  const proposalById = new Map(input.proposals.map((p) => [p.id, p]));
  const claimed = new Set<string>();
  const pendingExpected: ExpectedOutput[] = [];

  for (const e of input.expectedOutputs) {
    // (2) Lineage first — an approved proposal names the object it produced.
    let target: SessionOutput | undefined;
    const proposal = e.satisfiedByProposalId
      ? proposalById.get(e.satisfiedByProposalId)
      : undefined;
    if (proposal) {
      const candidate = byId.get(
        coordinate(proposal.targetType, proposal.targetId)
      );
      if (candidate && !claimed.has(candidate.id)) target = candidate;
    }
    // (3) Declared label — an explicit claim from the producer. Allowed even
    // when a proposal exists but did not resolve: a named slot beats a guess.
    if (!target) {
      const claimedId = byExpectedLabel.get(e.label);
      const candidate = claimedId ? byId.get(claimedId) : undefined;
      if (candidate && !claimed.has(candidate.id)) target = candidate;
    }
    // (4) Kind fallback — ONLY when there is no lineage to read.
    if (!target && !proposal) {
      const wanted = normalizeObjectKind(e.kind);
      target = [...byId.values()].find(
        (o) =>
          o.kind === wanted &&
          !claimed.has(o.id) &&
          // An output that claimed a DIFFERENT slot is not up for guessing.
          // Otherwise the first declared slot would swallow it before its own
          // label was ever reached, and the claim would be inert.
          (labelClaimOf.get(o.id) ?? e.label) === e.label
      );
    }
    if (!target) {
      pendingExpected.push(e);
      continue;
    }
    claimed.add(target.id);
    target.expected = {
      label: e.label,
      ...(e.status ? { status: e.status } : {}),
      ...(e.claimedDone !== undefined ? { claimedDone: e.claimedDone } : {}),
      ...(e.satisfiedByProposalId
        ? { satisfiedByProposalId: e.satisfiedByProposalId }
        : {}),
    };
    if (e.icon) target.icon = e.icon;
    if (!target.source.includes("expected")) target.source.push("expected");
    // A proposal filed by an agent is agent provenance the artifact ledger may
    // not have recorded (a produced edge carries no origin of its own).
    if (!target.producedBy && proposal) {
      target.producedBy = proposal.agentUserId ? "agent" : "human";
    }
  }

  const outputs = [...byId.values()].sort(
    (a, b) => a.producedAt.getTime() - b.producedAt.getTime()
  );
  return { outputs, pendingExpected };
}

/**
 * Fetch + join. Owner floor: the session row is loaded with `userId` in the
 * predicate — the SAME check `focusSessions.get` makes, and the row is needed
 * anyway for `expectedOutputs`, so a separate `ownsFocusSession` round-trip
 * would re-ask a question this query already answers. Returns `null` when the
 * session does not exist OR is not the caller's (indistinguishable on purpose).
 */
export async function listSessionOutputs(
  params: ListSessionOutputsParams
): Promise<SessionOutputsResult | null> {
  const { db: database, userId, sessionId } = params;

  const [session] = await database
    .select({ expectedOutputs: focusSessions.expectedOutputs })
    .from(focusSessions)
    .where(
      and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId))
    )
    .limit(1);
  if (!session) return null;

  const [artifactRows, producedRows] = await Promise.all([
    database
      .select({
        id: artifactsTable.id,
        kind: artifactsTable.kind,
        refId: artifactsTable.refId,
        cellKey: artifactsTable.cellKey,
        title: artifactsTable.title,
        originKind: artifactsTable.originKind,
        state: artifactsTable.state,
        createdAt: artifactsTable.createdAt,
        props: artifactsTable.props,
      })
      .from(artifactsTable)
      .where(eq(artifactsTable.sessionId, sessionId)),
    database
      .select({
        toType: links.toType,
        toId: links.toId,
        createdAt: links.createdAt,
      })
      .from(links)
      .where(
        and(
          eq(links.fromType, "session"),
          eq(links.fromId, sessionId),
          eq(links.linkType, "produced")
        )
      ),
  ]);

  const expectedOutputs: ExpectedOutput[] = Array.isArray(
    session.expectedOutputs
  )
    ? (session.expectedOutputs as ExpectedOutput[])
    : [];

  const proposalIds = [
    ...new Set(
      expectedOutputs
        .map((e) => e.satisfiedByProposalId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const proposalRows: JoinProposalRow[] = proposalIds.length
    ? await database
        .select({
          id: proposals.id,
          targetType: proposals.targetType,
          targetId: proposals.targetId,
          agentUserId: proposals.agentUserId,
        })
        .from(proposals)
        .where(inArray(proposals.id, proposalIds))
    : [];

  const titles = await resolveTitles(database, [
    ...artifactRows.map((a) => ({
      kind: a.kind,
      refId: artifactRefId(a as JoinArtifactRow),
    })),
    ...producedRows.map((p) => ({ kind: p.toType, refId: p.toId })),
  ]);

  return joinSessionOutputs({
    artifacts: artifactRows.map((a) => ({
      ...(a as unknown as JoinArtifactRow),
      expectedLabel: readExpectedLabel(a.props),
    })),
    produced: producedRows as JoinProducedRow[],
    expectedOutputs,
    proposals: proposalRows,
    titles,
  });
}

/**
 * Read the declared-output label an artifact was attached against.
 * `artifacts.props` is free-form JSONB, so this narrows rather than trusts.
 */
export function readExpectedLabel(props: unknown): string | null {
  if (!props || typeof props !== "object") return null;
  const value = (props as { expectedLabel?: unknown }).expectedLabel;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Live titles for every referenced object, FIVE queries total (one per backing
 * table) — never one per output. Keyed by the same `<kind>:<refId>` coordinate
 * the join uses. A kind with no backing table here (cell, url) simply has no
 * entry and keeps the artifact's own title.
 *
 * The bare `inArray(id)` carries NO visibility predicate, and that is correct
 * ONLY because the write doors now refuse a `refId` the caller cannot already
 * see (`assert-output-ref-visible.ts`). Before that floor existed, posting any
 * uuid to your own session and re-reading the room turned this join into a
 * title oracle over the whole pod. If a sixth kind is added here, add it to the
 * door's floor in the same change.
 */
async function resolveTitles(
  database: typeof db,
  refs: Array<{ kind: string; refId: string }>
): Promise<Map<string, string>> {
  const byKind = new Map<string, Set<string>>();
  for (const r of refs) {
    const kind = normalizeObjectKind(r.kind);
    if (!UUID_RE.test(r.refId)) continue;
    const set = byKind.get(kind) ?? new Set<string>();
    set.add(r.refId);
    byKind.set(kind, set);
  }

  const titles = new Map<string, string>();
  const entityIds = [...(byKind.get("entity") ?? [])];
  const documentIds = [...(byKind.get("document") ?? [])];
  const viewIds = [...(byKind.get("view") ?? [])];
  // `normalizeObjectKind` maps `workflow`/`workflows` onto `automation`, so
  // these two keys are the canonical kinds the join's coordinates already use.
  const automationIds = [...(byKind.get("automation") ?? [])];
  const playbookIds = [...(byKind.get("playbook") ?? [])];

  const [entityRows, documentRows, viewRows, automationRows, playbookRows] =
    await Promise.all([
      entityIds.length
        ? database
            .select({ id: entities.id, title: entities.title })
            .from(entities)
            .where(inArray(entities.id, entityIds))
        : Promise.resolve([]),
      documentIds.length
        ? database
            .select({ id: documents.id, title: documents.title })
            .from(documents)
            .where(inArray(documents.id, documentIds))
        : Promise.resolve([]),
      viewIds.length
        ? database
            .select({ id: views.id, name: views.name })
            .from(views)
            .where(inArray(views.id, viewIds))
        : Promise.resolve([]),
      automationIds.length
        ? database
            .select({ id: automations.id, name: automations.name })
            .from(automations)
            .where(inArray(automations.id, automationIds))
        : Promise.resolve([]),
      playbookIds.length
        ? database
            .select({ id: playbooks.id, name: playbooks.name })
            .from(playbooks)
            .where(inArray(playbooks.id, playbookIds))
        : Promise.resolve([]),
    ]);

  for (const r of entityRows) {
    if (r.title) titles.set(`entity:${r.id}`, r.title);
  }
  for (const r of documentRows) titles.set(`document:${r.id}`, r.title);
  for (const r of viewRows) titles.set(`view:${r.id}`, r.name);
  for (const r of automationRows) titles.set(`automation:${r.id}`, r.name);
  for (const r of playbookRows) titles.set(`playbook:${r.id}`, r.name);
  return titles;
}
