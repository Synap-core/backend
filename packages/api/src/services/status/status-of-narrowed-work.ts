/**
 * `include: ["work"]` for a key NARROWED by its grant (`GET /status-of`, D7,
 * founder decision of 21 Nov 2026: a grant-aware work projection, field by
 * field). The full `work` part (`status-work.ts`) reads each session's packet,
 * and several of its sections read rows by session id with NO grant clause
 * (the pending proposals, the gate proposals, the holds, the next move's
 * blockers). So a narrowed key is never handed that object. It is handed a
 * PROJECTION built here, by an ALLOW-LIST, from fields that a floor already
 * bounds:
 *
 *   - WHICH sessions: the full read lists them under `sessionStatusFloor`
 *     (`sessionReadableWhere`, which ANDs the key's grant): a session the key
 *     cannot read is never listed, never counted.
 *   - ROW fields (session, name, kind, status, label, category, tone, on,
 *     playbook, room, link): columns of that session row, the same ones
 *     `GET /focus-sessions/:id` serves a key that reads the session.
 *   - STAGES and ASKS: the row's declared stages and owed slots; the stage
 *     ledger of that session (its entry status and times). A runner's NAME
 *     only when the key reads the person's agents (`sessionHolderReadable`),
 *     as the session door's `holder`.
 *   - OUTCOMES: the declared outputs and criteria of the row (key, label,
 *     kind, owner, verdicts), never a produced object's reference.
 *   - GATES: a gate is a PROPOSAL row filed against the session, read by
 *     session id with no grant clause. A gate keeps its proposal id, state,
 *     reviewer verdict and sentence ONLY when the access layer's proposal
 *     floor (`statusAccess`, which ANDs the grant) reads that proposal
 *     ({@link readableWorkProposalIds}); else it reads `withheld`. Its stage
 *     is named from the session's own declared stages, never the gate's.
 *   - HOLD: only its kind (`on`) and `since`; its reference, reason and
 *     resume condition name other objects and are dropped.
 *
 * WITHHELD, whole: `proposals` (title and id of proposals read by session id),
 * `nextMove` (it reads proposals, links and rooms), `lastCompletion` (free
 * text). Any key the item gains later is dropped until listed here
 * (`status-of-narrowed.test.ts` pins the exact set).
 *
 * Pure; the proposal floor is read by `status-of-narrowed-proposals.ts`.
 */
type Rec = Record<string, unknown>;

/** What the narrowed work part carries, and what it leaves out, named on the wire. */
export const STATUS_OF_WORK_WITHHELD_FIELDS: readonly string[] = [
  "proposals",
  "nextMove",
  "lastCompletion",
  "hold.ref",
  "hold.reason",
  "hold.until",
  "gates.proposal (a proposal the grant does not read)",
  "agentName (without agent.read)",
];

export const STATUS_OF_WORK_WITHHELD_REASON =
  "This key's grant does not read everything a session's work packet reads: the pending proposals, the next move, a hold's reference and last completion are not shown, a gate's proposal only when the key may read it, and an agent's name only with agent.read.";

/** The keys one narrowed work item carries (pinned by the test). */
export const STATUS_OF_NARROWED_WORK_ITEM_KEYS = [
  "sessionId",
  "name",
  "kind",
  "status",
  "label",
  "category",
  "tone",
  "on",
  "playbookId",
  "roomId",
  "run",
  "stages",
  "gates",
  "asks",
  "proposals",
  "outcomes",
  "hold",
  "holder",
  "live",
  "stopped",
  "continue",
  "link",
] as const;

/** What the projection needs beyond the answer itself. */
export interface NarrowWorkContext {
  /** Gate proposals the access layer's proposal floor (with the grant) reads. */
  readableProposalIds: ReadonlySet<string>;
  /** The key reads the person's agents (`sessionHolderReadable`). */
  holderReadable: boolean;
}

/** Fail closed: no proposal readable, no agent name. */
export const NO_WORK_CONTEXT: NarrowWorkContext = {
  readableProposalIds: new Set(),
  holderReadable: false,
};

const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const UNAVAILABLE = {
  status: "unavailable",
  reason: "This part could not be read.",
} as const;

/** The listed keys of `src`, those that are present. */
function pick(src: Rec, keys: readonly string[]): Rec {
  const out: Rec = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

function isUnavailable(v: unknown): boolean {
  return !isRec(v) || v.status === "unavailable";
}

/** A declared stage reference: key and name only. */
function stageRef(v: unknown): Rec | null {
  return isRec(v) && typeof v.key === "string"
    ? { key: v.key, name: typeof v.name === "string" ? v.name : v.key }
    : null;
}

function narrowRun(v: unknown): unknown {
  if (v === null) return null;
  if (isUnavailable(v)) return UNAVAILABLE;
  return pick(v as Rec, [
    "id",
    "status",
    "label",
    "category",
    "startedAt",
    "completedAt",
  ]);
}

function narrowLive(v: unknown): unknown {
  if (isUnavailable(v)) return UNAVAILABLE;
  return pick(v as Rec, ["status", "state", "lastActivityAt"]);
}

function narrowHolder(v: unknown, ctx: NarrowWorkContext): unknown {
  if (isUnavailable(v)) return UNAVAILABLE;
  const h = v as Rec;
  return {
    ...pick(h, ["kind", "waitKind", "since", "reason"]),
    agentName:
      ctx.holderReadable && typeof h.agentName === "string"
        ? h.agentName
        : null,
  };
}

function narrowHold(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (isUnavailable(v)) return UNAVAILABLE;
  const h = v as Rec;
  return typeof h.on === "string" ? pick(h, ["on", "since"]) : undefined;
}

function narrowAsks(v: unknown): unknown {
  if (isUnavailable(v)) return UNAVAILABLE;
  const a = v as Rec;
  return {
    status: "ok",
    total: typeof a.total === "number" ? a.total : 0,
    items: (Array.isArray(a.items) ? a.items : []).flatMap((i) =>
      isRec(i)
        ? [
            pick(i, [
              "label",
              "kind",
              "noun",
              "askMode",
              "prompt",
              "owedSince",
            ]),
          ]
        : []
    ),
  };
}

function narrowOutcomes(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (isUnavailable(v)) return UNAVAILABLE;
  const o = v as Rec;
  const counts = isRec(o.counts) ? pick(o.counts, ["met", "total"]) : undefined;
  return {
    status: "ok",
    ...(counts ? { counts } : {}),
    items: (Array.isArray(o.items) ? o.items : []).flatMap((i) => {
      if (!isRec(i)) return [];
      const criteria = Array.isArray(i.criteria)
        ? i.criteria.flatMap((c) =>
            isRec(c)
              ? [pick(c, ["key", "label", "met", "state", "outputKey"])]
              : []
          )
        : undefined;
      return [
        {
          ...pick(i, [
            "key",
            "label",
            "kind",
            "owner",
            "met",
            "retired",
            "state",
          ]),
          ...(criteria?.length ? { criteria } : {}),
        },
      ];
    }),
  };
}

/** The declared stages, with the ledger entry cut to its plain fields. */
function narrowStages(
  v: unknown,
  ctx: NarrowWorkContext
): { out: unknown; names: Map<string, string> } {
  const names = new Map<string, string>();
  if (isUnavailable(v)) return { out: UNAVAILABLE, names };
  const s = v as Rec;
  const items = (Array.isArray(s.items) ? s.items : []).flatMap((i) => {
    const ref = stageRef(i);
    if (!ref || !isRec(i)) return [];
    names.set(ref.key as string, ref.name as string);
    const e = isRec(i.entry) ? i.entry : null;
    return [
      {
        ...ref,
        position: i.position,
        entry: e
          ? {
              ...pick(e, ["status", "attempt", "startedAt", "endedAt"]),
              agentName:
                ctx.holderReadable && typeof e.agentName === "string"
                  ? e.agentName
                  : null,
            }
          : null,
      },
    ];
  });
  return {
    out: {
      status: "ok",
      items,
      current: typeof s.current === "string" ? s.current : null,
    },
    names,
  };
}

/**
 * The gates, every one named from the session's own declared stages. A gate
 * with a proposal keeps it only when the proposal floor reads it; a gate
 * whose state needs a proposal that is not readable (or names a stage the
 * session does not declare) is dropped or `withheld`.
 */
function narrowGates(
  v: unknown,
  stages: unknown,
  names: ReadonlyMap<string, string>,
  ctx: NarrowWorkContext
): unknown {
  // The stages could not be read, so no gate can be named from the row: the
  // gates are unavailable (never an empty list). A run that declares no stage
  // has no gate to show.
  if (isUnavailable(v) || isUnavailable(stages)) return UNAVAILABLE;
  const g = v as Rec;
  const items = (Array.isArray(g.items) ? g.items : []).flatMap((i) => {
    if (!isRec(i) || typeof i.stageKey !== "string") return [];
    const stageName = names.get(i.stageKey);
    if (stageName === undefined) return [];
    const base = {
      stageKey: i.stageKey,
      stageName,
      kind: i.kind,
      decidedByHuman: false,
      canReview: false,
    };
    const proposalId = typeof i.proposalId === "string" ? i.proposalId : null;
    if (!proposalId) {
      // Only the two states that read no proposal (`deriveSessionGates`).
      return i.state === "not_reached" || i.state === "by_criteria"
        ? [{ ...base, state: i.state }]
        : [{ ...base, state: "withheld" }];
    }
    if (!ctx.readableProposalIds.has(proposalId))
      return [{ ...base, state: "withheld" }];
    const from =
      typeof i.fromStage === "string" && names.has(i.fromStage)
        ? i.fromStage
        : undefined;
    return [
      {
        ...base,
        state: i.state,
        proposalId,
        decidedByHuman: i.decidedByHuman === true,
        ...(typeof i.decidedAt === "string" ? { decidedAt: i.decidedAt } : {}),
        ...(from ? { fromStage: from } : {}),
        ...(typeof i.summary === "string" ? { summary: i.summary } : {}),
        canReview: i.canReview === true,
      },
    ];
  });
  return { status: "ok", items };
}

function narrowStopped(v: unknown): unknown {
  if (!isRec(v)) return null;
  return {
    at: stageRef(v.at),
    left: (Array.isArray(v.left) ? v.left : []).flatMap((s) => {
      const r = stageRef(s);
      return r ? [r] : [];
    }),
    label: typeof v.label === "string" ? v.label : "",
  };
}

function narrowContinue(v: unknown): unknown {
  if (!isRec(v)) return undefined;
  return { ...(narrowStopped(v) as Rec), canAct: v.canAct === true };
}

/** One work item, an allow-listed copy; `undefined` fields are left out. */
export function narrowWorkItem(raw: Rec, ctx: NarrowWorkContext): Rec {
  const stages = narrowStages(raw.stages, ctx);
  const out: Rec = {
    ...pick(raw, [
      "sessionId",
      "name",
      "kind",
      "status",
      "label",
      "category",
      "tone",
      "on",
      "playbookId",
      "roomId",
      "link",
    ]),
    run: narrowRun(raw.run),
    stages: stages.out,
    gates: narrowGates(raw.gates, stages.out, stages.names, ctx),
    asks: narrowAsks(raw.asks),
    proposals: {
      status: "withheld",
      reason: "Pending proposals are read by session id, with no grant clause.",
    },
    outcomes: narrowOutcomes(raw.outcomes),
    hold: narrowHold(raw.hold),
    holder: narrowHolder(raw.holder, ctx),
    live: narrowLive(raw.live),
    stopped: narrowStopped(raw.stopped),
    continue: narrowContinue(raw.continue),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** The `work` part of one answer, narrowed. */
export function narrowStatusOfWork(
  work: unknown,
  ctx: NarrowWorkContext = NO_WORK_CONTEXT
): unknown {
  if (!isRec(work) || work.status === "unavailable") return UNAVAILABLE;
  return {
    items: (Array.isArray(work.items) ? work.items : []).flatMap((i) =>
      isRec(i) ? [narrowWorkItem(i, ctx)] : []
    ),
    truncated: work.truncated === true,
  };
}
