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
  resolveSpacesLabel,
  resolveStatusLabel,
} from "../vocabulary/index.js";
import {
  accessModelOfParts,
  candidateRows,
  describeAccess,
  HOLDER_EVERYTHING,
  HOLDER_NOTHING,
  permissionsMatch,
  rowRequest,
  tierReachOf,
  tierValue,
  type AccessPart,
  type TierPlace,
} from "./access-model.js";
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
import { parsePermission, type GrantRequest } from "./grammar.js";
import {
  meetPlaces,
  parsePlace,
  placeKey,
  spacesPlace,
  UNBOUNDED_PLACE,
  type Place,
  type PlaceHolder,
} from "./reach.js";
import {
  describeKeyAccess,
  KEY_ACCESS_ENDED_SENTENCE,
  KEY_ACCESS_UNGRANTED_SENTENCE,
  summarizeGrant,
  type KeyAccess,
  type KeyAccessGrant,
  type KeyAccessLine,
} from "./summary.js";

/** Who holds the access: decides what a grant with no space means (`parsePlace`). */
export type HolderKind = PlaceHolder;

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
  /**
   * agentUsers.governance — null = not read (never a calm default).
   * `workspaceId`: where the mode holds — null = everywhere, one id, or
   * several (ask-first may hold in more than one space).
   */
  readonly posture?: {
    readonly mode: "ask" | "auto";
    readonly workspaceId: string | readonly string[] | null;
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
  /**
   * Per tier, where it holds and what there (`describeAccess`): the reads it
   * has pod-wide get their own place, never folded into the spaces of its
   * changes. Empty = the tier is empty. Each place is the parsed `Place`.
   */
  readonly places: {
    readonly read: readonly TierPlace[];
    readonly change: readonly TierPlace[];
    readonly approve: readonly TierPlace[];
  };
  /** Per grant (key/app: describeKeyAccess lines; agent: its ceiling). Empty once ended. */
  readonly lines: readonly KeyAccessLine[];
  readonly where: {
    readonly anywhere: boolean;
    readonly spaces: readonly { id: string; name: string }[];
    /** The projects it is narrowed to (none = no project narrowing). */
    readonly projectIds: readonly string[];
  };
  readonly lifetime: {
    readonly when: string;
    readonly expired: boolean;
    readonly expiresAt: Date | null;
  };
  /**
   * null = the holder has no posture (a person's own key); 'unread' = not
   * read. `where` null = everywhere, else the spaces it holds in ("Sales and
   * Finance", "3 spaces").
   */
  readonly posture:
    { mode: "ask" | "auto"; where: string | null } | "unread" | null;
  /** Patterns no catalog row names (vault.redeem, apiKey.*), for "Tools and secrets". */
  readonly other: readonly string[];
  /** What GrantSelector edits: agent → its capabilities; one grant → it; else null. */
  readonly draft: GrantDraft | null;
}

type Gate = (req: GrantRequest) => boolean;

function toDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  const d = typeof v === "string" ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? null : d;
}

const isPast = (v: Date | string | null | undefined, now: number) => {
  const d = toDate(v);
  return d !== null && d.getTime() <= now;
};

/** `agentUsers.governance().postures` — the posture at the pod and in each space. */
export interface AskFirstPostures {
  readonly pod: string | null;
  readonly spaces: ReadonlyArray<{
    readonly workspaceId: string;
    readonly name: string;
    readonly posture: string | null;
  }>;
}

export type AskFirstWhere =
  | null
  | { readonly kind: "pod" }
  | {
      readonly kind: "spaces";
      readonly spaces: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
      }>;
    };

/** Where ask-first holds. Pod-wide wins (it already covers every space). */
export function askFirstWhere(postures: AskFirstPostures): AskFirstWhere {
  if (postures.pod === "ask-first") return { kind: "pod" };
  const spaces = postures.spaces
    .filter((s) => s.posture === "ask-first")
    .map((s) => ({ id: s.workspaceId, name: s.name }));
  return spaces.length > 0 ? { kind: "spaces", spaces } : null;
}

/**
 * `agentUsers.governance` as the holder reader's posture. A failed read
 * (`null`) stays unread — never a calm "acts". An older pod without
 * `postures` reads the pod-wide switch. The spaces' names ride along.
 */
export function holderPostureOf(
  read: {
    readonly askFirst: boolean;
    readonly postures?: AskFirstPostures | null;
  } | null
): {
  posture: HolderAccessInput["posture"];
  spaceNames: Record<string, string>;
} {
  if (!read) return { posture: null, spaceNames: {} };
  if (!read.postures) {
    return {
      posture: { mode: read.askFirst ? "ask" : "auto", workspaceId: null },
      spaceNames: {},
    };
  }
  const where = askFirstWhere(read.postures);
  if (!where)
    return { posture: { mode: "auto", workspaceId: null }, spaceNames: {} };
  if (where.kind === "pod") {
    return { posture: { mode: "ask", workspaceId: null }, spaceNames: {} };
  }
  return {
    posture: { mode: "ask", workspaceId: where.spaces.map((s) => s.id) },
    spaceNames: Object.fromEntries(where.spaces.map((s) => [s.id, s.name])),
  };
}

export function resolveHolderAccess(input: HolderAccessInput): HolderAccess {
  const now = input.now ?? Date.now();
  const { limits } = input;
  const catalog: readonly GrantSubjectSpec[] =
    input.kind === "agent" ? AGENT_GRANT_CATALOG : GRANT_SUBJECT_CATALOG;
  const summaryOpts = { kindNames: input.kindNames };

  // ── the ceiling, as parts (a gate and its place) ────────────────────────
  let ceilingParts: AccessPart[];
  let lines: readonly KeyAccessLine[];
  let draft: GrantDraft | null;
  let accessEnded = false;
  if (limits.source === "capabilities") {
    const d = agentCapabilitiesToDraft(limits.capabilities);
    ceilingParts = [
      {
        can: (req) =>
          (AGENT_ALWAYS_ALLOWED as readonly string[]).includes(req.action) ||
          permissionsMatch(d.permissions, req),
        full: isFullAccess(d),
        // A capability list names no space: the AI acts wherever its person can.
        place: UNBOUNDED_PLACE,
      },
    ];
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
    ceilingParts = grants.map((g) => ({
      can: (req) => permissionsMatch(g.permissions, req),
      full: isFullAccess(g),
      place: parsePlace(g, input.kind),
    }));
    lines = described.lines;
    if (grants.length === 1) {
      const { expiresAt: _expiresAt, ...one } = grants[0];
      draft = one;
    } else draft = null;
  }

  // ── an agent's live keys narrow it ──────────────────────────────────────
  // A key that may touch nothing (ended, or never granted) cannot act, so it
  // narrows nothing. Each (ceiling part, key grant) pair holds where both do.
  const liveKeys = (input.keys ?? []).filter(
    (k) => !k.revokedAt && !isPast(k.expiresAt, now) && k.access === "granted"
  );
  const keyGrants = liveKeys.flatMap((k) => k.grants);
  const parts: AccessPart[] =
    liveKeys.length === 0
      ? ceilingParts
      : ceilingParts.flatMap((c) =>
          keyGrants.flatMap((g) => {
            const place = meetPlaces(c.place, parsePlace(g, input.kind));
            if (place === null) return [];
            return [
              {
                can: (req: GrantRequest) =>
                  c.can(req) && permissionsMatch(g.permissions, req),
                full: c.full && isFullAccess(g),
                place,
              },
            ];
          })
        );
  const keyLines = liveKeys.flatMap(
    (k) => describeKeyAccess(k, summaryOpts).lines
  );
  const can: Gate = (req) => parts.some((p) => p.can(req));

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
    const raw = input.posture.workspaceId;
    const ids = raw === null ? [] : typeof raw === "string" ? [raw] : raw;
    posture = {
      mode: input.posture.mode,
      where:
        ids.length === 0 ? null : resolveSpacesLabel(ids, input.workspaceNames),
    };
  } else posture = input.kind === "key" ? null : "unread";

  if (ended)
    return {
      state: "ended",
      sentence: KEY_ACCESS_ENDED_SENTENCE,
      tiers: { read: HOLDER_NOTHING, change: null, approve: null },
      places: { read: [], change: [], approve: [] },
      danger: { full: false, approves: false, deletes: false },
      lines: [],
      where: { anywhere: false, spaces: [], projectIds: [] },
      lifetime,
      posture,
      other: [],
      draft: null,
    };

  // ── the model: per tier, what and where ─────────────────────────────────
  const summaries = [...lines, ...keyLines].map((l) => l.summary);
  const model = accessModelOfParts(parts, { summaries, catalog });
  const candidates = candidateRows(summaries);
  // The tier VALUES ("Can read  Notes and people") read the whole holder.
  const whole = tierReachOf(can, model.state === "full", candidates, catalog);
  const full = model.state === "full";
  const value = (t: readonly string[] | "all" | null) =>
    t === "all" ? HOLDER_EVERYTHING : tierValue(t);
  const read = value(whole.read) ?? HOLDER_NOTHING;
  const change = value(whole.change);
  const approve = value(whole.approve);
  const deletes = full || candidates.some((r) => can(rowRequest(r, "delete")));

  // ── where (every place a part reaches) ──────────────────────────────────
  const pendingNames: Record<string, string> = {};
  for (const r of input.pending?.requests ?? [])
    if (r.workspaceId && r.workspaceName)
      pendingNames[r.workspaceId] ??= r.workspaceName;
  const names = { ...pendingNames, ...input.workspaceNames };
  const anywhere =
    model.places.some((p) => p.kind === "unbounded") ||
    (model.places.length > 0 && model.places.every((p) => p.kind === "pod"));
  const spaceIds: string[] = [];
  if (!anywhere)
    for (const p of model.places)
      if (p.kind === "spaces")
        for (const id of p.ids) if (!spaceIds.includes(id)) spaceIds.push(id);
  const spaces = spaceIds.map((id) => ({
    id,
    name: names[id] ?? resolveObjectNoun("workspace"),
  }));
  const projects = new Set<string>();
  const allGrants: readonly GrantDraft[] = [
    ...(limits.source === "grants" && limits.access === "granted"
      ? limits.grants
      : []),
    ...keyGrants,
  ];
  for (const g of allGrants)
    for (const p of g.projectIds ?? []) projects.add(p);

  const other: string[] = [];
  for (const l of [...lines, ...keyLines])
    for (const p of l.summary.other) if (!other.includes(p)) other.push(p);

  const state: HolderAccess["state"] = model.state;

  // ── the sentence ────────────────────────────────────────────────────────
  const described = describeAccess(model, { names });
  const what =
    state === "nothing" &&
    limits.source === "grants" &&
    limits.access === "ungranted"
      ? `${KEY_ACCESS_UNGRANTED_SENTENCE}.`
      : described.sentence;
  const sentenceParts = [what];
  if (posture && posture !== "unread" && state !== "nothing") {
    const scope = posture.where === null ? "" : ` in ${posture.where}`;
    sentenceParts.push(
      posture.mode === "ask"
        ? `Asks you first${scope}.`
        : `Acts without asking${scope}.`
    );
  }

  return {
    state,
    sentence: sentenceParts.join(" "),
    tiers: { read, change, approve },
    places: described.tiers,
    danger: { full, approves: approve !== null, deletes },
    lines,
    where: { anywhere, spaces, projectIds: [...projects] },
    lifetime,
    posture,
    other,
    draft,
  };
}

/**
 * What approving connect requests attaches: one grant per place, exactly the
 * permissions asked there (deduplicated). The connect card reads the holder
 * through these, so it says what approving WILL enable.
 */
export function grantsOfRequests(
  requests: readonly AppConnectRequestLike[]
): KeyAccessGrant[] {
  // By the space each request names (none = one grant with no space, which
  // the holder reads for its kind: `parsePlace`). A blank id is no space:
  // `spacesPlace` refuses it rather than reading it as "no space".
  const byPlace = new Map<string, { place: Place | null; perms: string[] }>();
  for (const r of requests) {
    const place = r.workspaceId === null ? null : spacesPlace([r.workspaceId]);
    const k = place ? placeKey(place) : "none";
    const entry = byPlace.get(k) ?? { place, perms: [] };
    if (!entry.perms.includes(r.permission)) entry.perms.push(r.permission);
    byPlace.set(k, entry);
  }
  return [...byPlace.values()].map(({ place, perms }) => ({
    permissions: perms,
    workspaceIds: place?.kind === "spaces" ? [...place.ids] : null,
    projectIds: null,
    entityIds: null,
    expiresAt: null,
  }));
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
    if (!permissionsMatch([r.permission], req)) continue;
    push(
      r,
      kind === null || kind === "*"
        ? `${segs[0]}.read`
        : `${segs[0]}.${kind}.read`
    );
  }
  return out;
}
