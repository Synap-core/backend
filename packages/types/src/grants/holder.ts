/**
 * resolveHolderAccess — the ONE reading of what a HOLDER (an AI agent, an app,
 * a key) may do to the pod: the header sentence, the three tiers (read /
 * change / approve), the danger marks, where, how long, and how it acts.
 *
 * It composes the grant leaves and re-derives nothing:
 *  - words and rows come from `summarizeGrant` / `describeKeyAccess`;
 *  - whether a holder may do a thing comes from the grammar's `patternMatches`;
 *  - an agent's ceiling is `agentCapabilitiesToDraft` (+ AGENT_ALWAYS_ALLOWED).
 *
 * An agent's live keys narrow its ceiling (capability ∩ key grant). A key that
 * is revoked, expired or whose access ended cannot call, so it narrows
 * nothing; an agent with no live key acts through the pod itself and is bound
 * by its ceiling alone.
 *
 * Copy says "can read / change / approve" and "spaces" — never grant, scope or
 * permission. Pure: no I/O.
 */

import type { AppConnectRequestLike } from "../proposals/intent.js";
import {
  resolveObjectNoun,
  resolveObjectNounPlural,
  resolveStatusLabel,
} from "../vocabulary/index.js";
import {
  AGENT_ALWAYS_ALLOWED,
  AGENT_GRANT_CATALOG,
  agentCapabilitiesToDraft,
} from "./agent.js";
import {
  GRANT_SUBJECT_CATALOG,
  isQualifiedGrantSubject,
  type GrantSubjectSpec,
} from "./catalog.js";
import { isFullAccess, type GrantDraft } from "./draft.js";
import {
  parsePermission,
  patternMatches,
  type GrantRequest,
} from "./grammar.js";
import {
  describeKeyAccess,
  GRANT_FULL_ACCESS_SENTENCE,
  KEY_ACCESS_ENDED_SENTENCE,
  KEY_ACCESS_UNGRANTED_SENTENCE,
  summarizeGrant,
  type GrantSummaryRow,
  type KeyAccess,
  type KeyAccessGrant,
  type KeyAccessLine,
} from "./summary.js";

export type HolderKind = "agent" | "app" | "key";

export interface HolderKeyInput {
  readonly id: string;
  readonly access: KeyAccess;
  readonly grants: readonly KeyAccessGrant[];
  readonly expiresAt: Date | string | null;
  readonly lastUsedAt: Date | string | null;
  readonly revokedAt: Date | string | null;
}

export interface HolderAccessInput {
  readonly kind: HolderKind;
  readonly name: string;
  /** The ceiling. agent: users.agent_metadata.capabilities; app/key: live grant set. */
  readonly limits:
    | {
        readonly source: "capabilities";
        readonly capabilities: readonly string[] | null;
      }
    | {
        readonly source: "grants";
        readonly access: KeyAccess;
        readonly grants: readonly KeyAccessGrant[];
      };
  /** Agent only: its keys narrow further (grant ∩ capabilities). */
  readonly keys?: readonly HolderKeyInput[];
  /** An open connect request (app/connect, agent/connect). */
  readonly pending?: {
    readonly proposalId: string;
    readonly requests: readonly AppConnectRequestLike[];
  } | null;
  /** agentUsers.governance — null = not read (never a calm default). */
  readonly posture?: {
    readonly mode: "ask" | "auto";
    readonly workspaceId: string | null;
  } | null;
  readonly expiresAt?: Date | string | null;
  readonly lastUsedAt?: Date | string | null;
  readonly revokedAt?: Date | string | null;
  readonly workspaceNames?: Readonly<Record<string, string>>;
  readonly kindNames?: Readonly<Record<string, string>>;
  readonly now?: number;
}

export interface HolderAccess {
  readonly state: "nothing" | "limited" | "full" | "ended";
  /** The header sentence: "Reads everything, changes Notes in Sales. Asks you first." */
  readonly sentence: string;
  /** "Everything", "Nothing" or the labels ("Notes, Documents"). change/approve null = it cannot. */
  readonly tiers: {
    readonly read: string;
    readonly change: string | null;
    readonly approve: string | null;
  };
  readonly danger: {
    readonly full: boolean;
    readonly approves: boolean;
    readonly deletes: boolean;
  };
  /** Per grant (key/app: describeKeyAccess lines; agent: its ceiling). Empty once ended. */
  readonly lines: readonly KeyAccessLine[];
  readonly where: {
    readonly anywhere: boolean;
    readonly spaces: readonly { id: string; name: string }[];
    readonly projectCount: number;
  };
  readonly lifetime: {
    readonly when: string;
    readonly expired: boolean;
    readonly expiresAt: Date | null;
  };
  /** null = the holder has no posture (a person's own key); 'unread' = not read. */
  readonly posture: { mode: "ask" | "auto"; where: string } | "unread" | null;
  /** Patterns no catalog row names (vault.redeem, apiKey.*), for "Tools and secrets". */
  readonly other: readonly string[];
  /** What GrantSelector edits: agent → its capabilities; one grant → it; else null. */
  readonly draft: GrantDraft | null;
}

export const HOLDER_EVERYTHING = "Everything";
export const HOLDER_NOTHING = "Nothing";
export const HOLDER_NO_ACCESS_SENTENCE = "No access yet";

const CHANGE_ACTIONS = ["create", "update", "delete"] as const;

type Gate = (req: GrantRequest) => boolean;

function matches(permissions: readonly string[], req: GrantRequest): boolean {
  return permissions.some((p) => {
    try {
      return patternMatches(p, req);
    } catch {
      return false;
    }
  });
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  const d = typeof v === "string" ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? null : d;
}

const isPast = (v: Date | string | null | undefined, now: number) => {
  const d = toDate(v);
  return d !== null && d.getTime() <= now;
};

/** Spaces a set of grants reaches: null = anywhere, else the union. */
function grantSpaces(grants: readonly GrantDraft[]): Set<string> | null {
  const out = new Set<string>();
  for (const g of grants) {
    if (!g.workspaceIds || g.workspaceIds.length === 0) return null;
    for (const id of g.workspaceIds) out.add(id);
  }
  return out;
}

function intersectSpaces(
  a: Set<string> | null,
  b: Set<string> | null
): Set<string> | null {
  if (a === null) return b;
  if (b === null) return a;
  return new Set([...a].filter((id) => b.has(id)));
}

const rowRequest = (row: GrantSummaryRow, action: string): GrantRequest => ({
  subject: row.subject,
  qualifier: row.kind === null || row.kind === "*" ? null : row.kind,
  action,
});

/** One tier's text from the candidate rows: a kind row hides under its subject's every-kind row. */
function tierText(
  rows: readonly GrantSummaryRow[],
  test: (row: GrantSummaryRow) => boolean
): string | null {
  const hit = rows.filter(test);
  const covered = new Set(
    hit.filter((r) => r.kind === "*").map((r) => r.subject)
  );
  const labels: string[] = [];
  for (const r of hit) {
    if (r.kind !== null && r.kind !== "*" && covered.has(r.subject)) continue;
    if (!labels.includes(r.label)) labels.push(r.label);
  }
  return labels.length > 0 ? labels.join(", ") : null;
}

const phrase = (tier: string) =>
  tier === HOLDER_EVERYTHING || tier === HOLDER_NOTHING
    ? tier.toLowerCase()
    : tier;

function and(parts: readonly string[]): string {
  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
    : (parts[0] ?? "");
}

export function resolveHolderAccess(input: HolderAccessInput): HolderAccess {
  const now = input.now ?? Date.now();
  const { limits } = input;
  const catalog: readonly GrantSubjectSpec[] =
    input.kind === "agent" ? AGENT_GRANT_CATALOG : GRANT_SUBJECT_CATALOG;
  const summaryOpts = { kindNames: input.kindNames };

  // ── the ceiling ──────────────────────────────────────────────────────────
  let ceiling: Gate;
  let ceilingFull: boolean;
  let ceilingSpaces: Set<string> | null;
  let lines: readonly KeyAccessLine[];
  let draft: GrantDraft | null;
  let accessEnded = false;
  if (limits.source === "capabilities") {
    const d = agentCapabilitiesToDraft(limits.capabilities);
    ceiling = (req) =>
      (AGENT_ALWAYS_ALLOWED as readonly string[]).includes(req.action) ||
      matches(d.permissions, req);
    ceilingFull = isFullAccess(d);
    ceilingSpaces = null;
    lines = [
      {
        label: null,
        summary: summarizeGrant(d, {
          ...summaryOpts,
          catalog: AGENT_GRANT_CATALOG,
          alwaysAllowed: AGENT_ALWAYS_ALLOWED,
          expiresAt: input.expiresAt ?? null,
        }),
      },
    ];
    draft = d;
  } else {
    // A never-granted holder touches nothing (P5); it is not "ended" — it
    // never started — so it reads as `nothing`, in the ungranted wording.
    const described = describeKeyAccess(limits, summaryOpts);
    accessEnded = limits.access === "ended";
    const grants = limits.access === "granted" ? limits.grants : [];
    ceiling = (req) => grants.some((g) => matches(g.permissions, req));
    ceilingFull = described.full;
    ceilingSpaces =
      limits.access === "granted" ? grantSpaces(grants) : new Set();
    lines = described.lines;
    if (grants.length === 1) {
      const { expiresAt: _expiresAt, ...one } = grants[0];
      draft = one;
    } else draft = null;
  }

  // ── an agent's live keys narrow it ──────────────────────────────────────
  // A key that may touch nothing (ended, or never granted) cannot act, so it
  // narrows nothing.
  const liveKeys = (input.keys ?? []).filter(
    (k) => !k.revokedAt && !isPast(k.expiresAt, now) && k.access === "granted"
  );
  const narrowed = liveKeys.length > 0;
  const keyGate: Gate = (req) =>
    !narrowed ||
    liveKeys.some((k) => k.grants.some((g) => matches(g.permissions, req)));
  const keysFull =
    !narrowed || liveKeys.some((k) => describeKeyAccess(k, summaryOpts).full);
  const keySpaces = narrowed
    ? grantSpaces(liveKeys.flatMap((k) => k.grants))
    : null;
  const keyLines = liveKeys.flatMap(
    (k) => describeKeyAccess(k, summaryOpts).lines
  );

  const can: Gate = (req) => ceiling(req) && keyGate(req);

  // ── ended ───────────────────────────────────────────────────────────────
  const expiresAt = toDate(input.expiresAt);
  const expired = isPast(input.expiresAt, now);
  const ended = Boolean(input.revokedAt) || expired || accessEnded;
  const lifetime = {
    when: expired
      ? resolveStatusLabel("expired")
      : summarizeGrant({ permissions: [] }, { expiresAt: expiresAt ?? null })
          .when,
    expired,
    expiresAt,
  };

  let posture: HolderAccess["posture"];
  if (input.posture) {
    const id = input.posture.workspaceId;
    posture = {
      mode: input.posture.mode,
      where:
        id === null
          ? "Everywhere"
          : (input.workspaceNames?.[id] ?? resolveObjectNoun("workspace")),
    };
  } else posture = input.kind === "key" ? null : "unread";

  if (ended)
    return {
      state: "ended",
      sentence: KEY_ACCESS_ENDED_SENTENCE,
      tiers: { read: HOLDER_NOTHING, change: null, approve: null },
      danger: { full: false, approves: false, deletes: false },
      lines: [],
      where: { anywhere: false, spaces: [], projectCount: 0 },
      lifetime,
      posture,
      other: [],
      draft: null,
    };

  // ── tiers ───────────────────────────────────────────────────────────────
  const full = ceilingFull && keysFull;
  const candidates: GrantSummaryRow[] = [];
  for (const l of [...lines, ...keyLines])
    for (const r of l.summary.rows)
      if (!candidates.some((c) => c.key === r.key)) candidates.push(r);
  const top = (subject: string, action: string): GrantRequest => ({
    subject,
    qualifier: null,
    action,
  });

  const readAll = catalog.every((s) => can(top(s.subject, "read")));
  const read = readAll
    ? HOLDER_EVERYTHING
    : (tierText(candidates, (r) => can(rowRequest(r, "read"))) ??
      HOLDER_NOTHING);
  const changeAll = catalog.every((s) =>
    s.actions.filter((a) => a !== "read").every((a) => can(top(s.subject, a)))
  );
  const change = changeAll
    ? HOLDER_EVERYTHING
    : tierText(candidates, (r) =>
        CHANGE_ACTIONS.some((a) => can(rowRequest(r, a)))
      );
  const approve = full
    ? HOLDER_EVERYTHING
    : tierText(candidates, (r) => can(rowRequest(r, "approve")));
  const deletes = full || candidates.some((r) => can(rowRequest(r, "delete")));

  // ── where ───────────────────────────────────────────────────────────────
  const spaceIds = intersectSpaces(ceilingSpaces, keySpaces);
  const nameOf = (id: string) =>
    input.workspaceNames?.[id] ??
    input.pending?.requests.find((r) => r.workspaceId === id && r.workspaceName)
      ?.workspaceName ??
    resolveObjectNoun("workspace");
  const spaces = spaceIds
    ? [...spaceIds].map((id) => ({ id, name: nameOf(id) }))
    : [];
  const projects = new Set<string>();
  const allGrants: readonly GrantDraft[] = [
    ...(limits.source === "grants" && limits.access === "granted"
      ? limits.grants
      : []),
    ...liveKeys.flatMap((k) => k.grants),
  ];
  for (const g of allGrants)
    for (const p of g.projectIds ?? []) projects.add(p);

  const other: string[] = [];
  for (const l of [...lines, ...keyLines])
    for (const p of l.summary.other) if (!other.includes(p)) other.push(p);

  const nothing =
    !full &&
    read === HOLDER_NOTHING &&
    change === null &&
    approve === null &&
    other.length === 0;
  const state: HolderAccess["state"] = full
    ? "full"
    : nothing
      ? "nothing"
      : "limited";

  // ── the sentence ────────────────────────────────────────────────────────
  let what: string;
  if (state === "nothing")
    what =
      limits.source === "grants" && limits.access === "ungranted"
        ? KEY_ACCESS_UNGRANTED_SENTENCE
        : HOLDER_NO_ACCESS_SENTENCE;
  else if (full) what = GRANT_FULL_ACCESS_SENTENCE;
  else {
    const verbs = [`Reads ${phrase(read)}`];
    if (change) verbs.push(`changes ${phrase(change)}`);
    if (approve) verbs.push(`approves ${phrase(approve)}`);
    what = verbs.join(", ");
    if (spaces.length > 0)
      what += ` in ${
        spaces.length <= 2
          ? and(spaces.map((s) => s.name))
          : `${spaces.length} ${resolveObjectNounPlural("workspace").toLowerCase()}`
      }`;
  }
  const parts = [`${what}.`];
  if (posture && posture !== "unread" && state !== "nothing") {
    const scope = posture.where === "Everywhere" ? "" : ` in ${posture.where}`;
    parts.push(
      posture.mode === "ask"
        ? `Asks you first${scope}.`
        : `Acts without asking${scope}.`
    );
  }

  return {
    state,
    sentence: parts.join(" "),
    tiers: { read, change, approve },
    danger: { full, approves: approve !== null, deletes },
    lines,
    where: {
      anywhere: spaceIds === null,
      spaces,
      projectCount: projects.size,
    },
    lifetime,
    posture,
    other,
    draft,
  };
}

/**
 * Connect requests narrowed to read only, for "Approve read-only":
 * `entity.note.*` / `entity.note` → `entity.note.read`, `*` → a read of every
 * catalog subject. A request whose pattern does not already cover the read it
 * would become (`entity.note.create`) is DROPPED — narrowing never adds a read
 * that was not asked for. Unparseable requests are dropped. Deduplicated per
 * space.
 */
export function narrowRequestsToRead(
  requests: readonly AppConnectRequestLike[]
): AppConnectRequestLike[] {
  const out: AppConnectRequestLike[] = [];
  const push = (r: AppConnectRequestLike, permission: string) => {
    if (
      !out.some(
        (o) => o.permission === permission && o.workspaceId === r.workspaceId
      )
    )
      out.push({ ...r, permission });
  };
  for (const r of requests) {
    let segs: string[];
    try {
      segs = parsePermission(r.permission);
    } catch {
      continue;
    }
    if (segs[0] === "*") {
      for (const s of GRANT_SUBJECT_CATALOG)
        if (s.actions.includes("read")) push(r, `${s.subject}.read`);
      continue;
    }
    const kind = isQualifiedGrantSubject(segs[0]) ? (segs[1] ?? "*") : null;
    const req: GrantRequest = {
      subject: segs[0],
      qualifier: kind && kind !== "*" ? kind : null,
      action: "read",
    };
    if (!matches([r.permission], req)) continue;
    push(
      r,
      kind === null || kind === "*"
        ? `${segs[0]}.read`
        : `${segs[0]}.${kind}.read`
    );
  }
  return out;
}
