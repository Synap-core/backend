/**
 * Agent connection — the ONE rule for "has an agent reached this pod, and
 * which one was seen last".
 *
 * Browser Home (the "Connect your agent" invite) and Relay's first-run screen
 * ("Your agents can reach you here") both answer this question. They read the
 * same `agentUsers.list` rows and must never disagree, so the rule lives here
 * and neither surface re-derives it.
 *
 * Zero imports on purpose: this leaf is loaded by Electron, React Native and
 * Node alike.
 */

/**
 * The one command that connects a person's own agents (Claude Code, Codex,
 * Cursor…) to their pod. Every surface that invites them to connect shows this
 * exact string, so the copy cannot drift from what the CLI accepts.
 */
export const AGENT_CONNECT_COMMAND = "npx @synap-core/cli init";

/** The slice of an `agentUsers.list` row this rule reads. */
export interface AgentPresenceLike {
  id: string;
  name: string | null;
  /**
   * When the agent last called the pod. `null` / absent = it never has.
   * A string is accepted because tRPC without a transformer serialises dates.
   */
  lastSeenAt?: Date | string | null;
}

export type AgentConnection =
  /** No agent has ever called the pod (or the pod has no agents at all). */
  | { kind: "never" }
  /**
   * The pod has agents but does not report when they were last seen (a pod
   * older than the `lastSeenAt` field). NOT "never": nobody measured it.
   */
  | { kind: "unmeasured" }
  /** At least one agent has; `agent` is the one seen most recently. */
  | {
      kind: "seen";
      agent: { id: string; name: string | null; lastSeenAt: Date };
      /** How many OTHER agents have also been seen. */
      others: number;
    };

function seenAt(value: AgentPresenceLike["lastSeenAt"]): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Resolve the connection state from the roster rows.
 *
 * A row whose timestamp cannot be parsed counts as not seen: it proves
 * nothing, and "seen" is the state that hides the invite. Rows that do not
 * carry the field at all are `unmeasured`, never `never`: an older pod cannot
 * tell, and saying "no agent connected" to someone whose agent is working
 * would be a calm, wrong screen.
 */
export function resolveAgentConnection(
  rows: readonly AgentPresenceLike[]
): AgentConnection {
  let latest: { row: AgentPresenceLike; at: Date } | null = null;
  let seenCount = 0;
  for (const row of rows) {
    const at = seenAt(row.lastSeenAt);
    if (!at) continue;
    seenCount += 1;
    if (!latest || at.getTime() > latest.at.getTime()) latest = { row, at };
  }
  if (!latest) {
    const measured =
      rows.length === 0 || rows.some((row) => "lastSeenAt" in row);
    return measured ? { kind: "never" } : { kind: "unmeasured" };
  }
  return {
    kind: "seen",
    agent: { id: latest.row.id, name: latest.row.name, lastSeenAt: latest.at },
    others: seenCount - 1,
  };
}

// ---------------------------------------------------------------------------
// Agent MARK — one agent's state as a mark (kind + tone + words), for every
// surface that lists agents (browser Settings › Agents, relay Settings › AI &
// agents). Before this rule each surface derived its own and they disagreed:
// the same agent read "Disconnected" on the desktop and a green "Seen" on the
// phone.
// ---------------------------------------------------------------------------

/**
 * Seen more than this many days ago ⇒ `stale`: neutral, never healthy green.
 * A week is one working cycle — an agent a person uses at all calls at least
 * that often, so older silence is worth noticing, not yet an error.
 */
export const AGENT_STALE_AFTER_DAYS = 7;

/** The slice of an `agentUsers.list` row the mark reads. */
export interface AgentMarkRowLike extends AgentPresenceLike {
  /** Raw instance label of the key last seen (`api_keys.instance_id`). */
  host?: string | null;
  /** Live keys. Absent on a pod older than V1 G3. */
  activeKeys?: number;
  /** Keys awaiting the person's approval. Absent on older pods. */
  pendingKeys?: number;
  /**
   * Keys that existed and can no longer authenticate (revoked or expired).
   * The ONLY evidence for "Disconnected". Absent on older pods ⇒ never claimed.
   */
  revokedKeys?: number;
  /** The pod made this agent for itself and it never held a key. */
  builtIn?: boolean;
  /**
   * The pod's answer to "may THIS viewer disconnect it" (owner or pod admin).
   * Absent on older pods ⇒ offered, and the pod's refusal is said plainly.
   */
  viewerCanDisconnect?: boolean;
  /** The ONE approval door for its pending keys, for this viewer; `null` = none. */
  approveUrl?: string | null;
}

export type AgentMarkKind =
  /** The pod's own agent — no key to connect, nothing to cut. */
  | "builtIn"
  /** Called the pod within `AGENT_STALE_AFTER_DAYS`. */
  | "seen"
  /** Called the pod, but longer ago than `AGENT_STALE_AFTER_DAYS`. */
  | "stale"
  /** Its only key awaits the person's approval — the person's move. */
  | "approve"
  /** A live key, and it has never called. */
  | "waiting"
  /** It had a key, the key was revoked or expired, and no live or pending one is left. */
  | "disconnected"
  /** It never had a key (nor a call): nothing has started. */
  | "noKey"
  /** The pod does not report presence (older pod): no mark at all. */
  | "unmeasured";

/** A tone token — each surface maps it to its own chip / dot. Never a colour. */
export type AgentMarkTone = "success" | "warning" | "danger" | "neutral";

export interface AgentMark {
  kind: AgentMarkKind;
  tone: AgentMarkTone;
  /**
   * The mark's words WITHOUT the time — `null` = no mark (unmeasured). When
   * `seenAt` is set the surface appends its relative time ("Seen" + " 3m ago"):
   * this package has no relative-time formatter, and value formatting is its
   * own SSOT (`.claude/rules/vocabulary.md`), so the time clause is the one
   * part each surface formats.
   */
  label: string | null;
  /** ISO instant of the last call, or `null` (never / unmeasured / builtIn). */
  seenAt: string | null;
  /** Readable machine / client name (`humanizeAgentHost`), or `null`. */
  host: string | null;
  /** A live or pending key exists AND this viewer may cut it. */
  canDisconnect: boolean;
  /** Where to approve its pending keys (the pod's door), or `null`. */
  approveUrl: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
/** A machine-minted id segment: long hex, or digits only. */
const ID_RE = /^(?:[0-9a-f]{8,}|\d+)$/i;
/** Transport prefixes a door stamps on an instance label; they name no machine. */
const TRANSPORT_SEGMENTS = new Set(["mcp", "oauth", "hub", "cli", "key"]);

/**
 * An instance label as a person reads it. Labels are written by the door that
 * minted the key — `mcp:<userId>:<podId>` (the claude.ai connector),
 * `oauth:<clientId>:<userId>`, or whatever the CLI sent (a hostname). Keeps the
 * readable segments (a machine or client name), drops ids and transport
 * prefixes; `null` when nothing readable is left.
 */
export function humanizeAgentHost(
  raw: string | null | undefined
): string | null {
  if (raw == null) return null;
  const parts = raw
    .split(/[:/|]/)
    .map((p) => p.trim().replace(/\.local$/i, ""))
    .filter(
      (p) =>
        p.length > 0 &&
        !UUID_RE.test(p) &&
        !ID_RE.test(p) &&
        !TRANSPORT_SEGMENTS.has(p.toLowerCase())
    );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The ONE agent mark. Order of the rules, and why:
 *  1. `builtIn` — key-based presence says nothing about the pod's own agents.
 *  2. unmeasured — a pod that serves no `lastSeenAt` gets no mark, never a guess.
 *  3. `approve` — no live key but one awaits approval: the person's move
 *     outranks everything the agent did before.
 *  4. no live key, a revoked/expired one on record ⇒ `disconnected`. Without
 *     that evidence (field absent, or zero) it is never claimed.
 *  5. seen ⇒ `seen`, or `stale` past `AGENT_STALE_AFTER_DAYS`.
 *  6. never seen: a live key ⇒ `waiting` ("Waiting for first call"); no key at
 *     all ⇒ `noKey` ("No key yet") — "Waiting for first call" there would
 *     promise a call that cannot come, since there is no key to call with.
 */
export function resolveAgentMark(
  row: AgentMarkRowLike | null | undefined,
  now: number = Date.now()
): AgentMark {
  const host = humanizeAgentHost(row?.host);
  const active = row?.activeKeys ?? 0;
  const pending = row?.pendingKeys ?? 0;
  const canDisconnect =
    !!row &&
    !row.builtIn &&
    active + pending > 0 &&
    row.viewerCanDisconnect !== false;
  const approveUrl = (pending > 0 && row?.approveUrl) || null;
  const mark = (
    kind: AgentMarkKind,
    tone: AgentMarkTone,
    label: string | null,
    seenAt: string | null = null
  ): AgentMark => ({
    kind,
    tone,
    label,
    seenAt,
    host,
    canDisconnect,
    approveUrl,
  });

  if (!row) return mark("unmeasured", "neutral", null);
  if (row.builtIn)
    return { ...mark("builtIn", "neutral", "Built-in"), host: null };
  const connection = resolveAgentConnection([row]);
  if (connection.kind === "unmeasured")
    return mark("unmeasured", "neutral", null);
  const seenAt =
    connection.kind === "seen"
      ? connection.agent.lastSeenAt.toISOString()
      : null;

  if (active === 0 && pending > 0) {
    return mark("approve", "warning", "Key awaiting your approval", seenAt);
  }
  if (active === 0 && (row.revokedKeys ?? 0) > 0) {
    return mark("disconnected", "danger", "Disconnected", seenAt);
  }
  if (connection.kind === "seen") {
    const ageMs = now - connection.agent.lastSeenAt.getTime();
    return ageMs > AGENT_STALE_AFTER_DAYS * 86_400_000
      ? mark("stale", "neutral", "Seen", seenAt)
      : mark("seen", "success", "Seen", seenAt);
  }
  if (active > 0) return mark("waiting", "neutral", "Waiting for first call");
  return mark("noKey", "neutral", "No key yet");
}

/**
 * The mark's full words, given the surface's relative rendering of `seenAt`
 * ("3m ago"). Composition lives here so the two surfaces cannot word it
 * differently: seen/stale ⇒ "Seen 3m ago"; any other mark with a last call ⇒
 * "Disconnected · seen 3m ago"; otherwise the label alone. `null` = no mark.
 */
export function agentMarkText(
  mark: AgentMark,
  relativeSeen: (iso: string) => string
): string | null {
  if (mark.label == null) return null;
  if (!mark.seenAt) return mark.label;
  const rel = relativeSeen(mark.seenAt);
  if (!rel) return mark.label;
  if (mark.kind === "seen" || mark.kind === "stale")
    return `${mark.label} ${rel}`;
  return `${mark.label} · seen ${rel}`;
}

// ---------------------------------------------------------------------------
// Agent DIRECTION — whose agent is this: one the person brought to the pod
// (`external`), or the pod's own intelligence (`house`: the twin, the capture
// and form agents, Intelligence Service personas).
//
// WHY. `builtIn` answers a different question ("would a key-based mark lie
// about it?") and is false for an IS persona, because the registry mints it a
// hub key — so every persona listed among "your agents". Direction is decided
// from ORIGIN alone, never from keys, and the pod computes it once
// (`agentUsers.list` → `direction`) so every surface reads the same value.
// ---------------------------------------------------------------------------

/**
 * Every value `users.created_via` may hold for an agent. The database column
 * is typed with its own copy of this union (`@synap/database` does not depend
 * on this package), and `agent-users.ts` holds a compile-time equality floor
 * between the two — so a new writer value fails the build until it is added
 * here, and adding it here fails the build until {@link AGENT_DIRECTION_BY_ORIGIN}
 * classifies it.
 */
export const AGENT_ORIGINS = [
  "cli",
  "ui",
  "system",
  "intelligence-service",
] as const;
export type AgentOrigin = (typeof AGENT_ORIGINS)[number];

export type AgentDirection = "external" | "house";

/**
 * Every origin, classified. `satisfies Record<AgentOrigin, …>` is the coverage
 * floor: an unclassified origin is a missing key, and the build stops.
 *  - `cli`  — a person ran `synap init` for their own agent;
 *  - `ui`   — a person made or activated it from the app (an add-on agent);
 *  - `system` — the pod made it for itself (twin, capture, form agents);
 *  - `intelligence-service` — an IS persona the pod runs.
 */
export const AGENT_DIRECTION_BY_ORIGIN = {
  cli: "external",
  ui: "external",
  system: "house",
  "intelligence-service": "house",
} as const satisfies Record<AgentOrigin, AgentDirection>;

/** The slice of an agent row the direction reads. */
export interface AgentDirectionInput {
  /** `users.created_via` (`agentUsers.list` → `origin`). */
  origin: string | null | undefined;
  isPersonalAgent?: boolean | null;
}

/**
 * The ONE direction rule:
 *  1. a personal agent (the twin) is the pod's own, whatever its origin says;
 *  2. a known origin → its classification;
 *  3. no origin (an agent older than migration 0225 that 0285 did not
 *     backfill) or an origin this build does not know → `external`. Hiding a
 *     person's connected agent under "the pod's own" is the worse error, so the
 *     unknown case is shown as theirs — the same stance `builtIn` takes on NULL.
 */
export function resolveAgentDirection(
  row: AgentDirectionInput
): AgentDirection {
  if (row.isPersonalAgent === true) return "house";
  const origin = row.origin;
  if (
    origin != null &&
    Object.prototype.hasOwnProperty.call(AGENT_DIRECTION_BY_ORIGIN, origin)
  ) {
    return AGENT_DIRECTION_BY_ORIGIN[origin as AgentOrigin];
  }
  return "external";
}

/** A roster row as a surface receives it (`agentUsers.list`). */
export interface ServedAgentDirectionRow {
  /** The pod's own answer (`agentUsers.list` → `direction`), when it sends one. */
  direction?: string | null;
  /** `users.created_via` — what an older pod without `direction` still sends. */
  origin?: string | null;
  isPersonalAgent?: boolean | null;
}

/**
 * Whose agent a SERVED roster row is: the pod's `direction` when it sent a
 * known one, else {@link resolveAgentDirection} over the origin it did send.
 * Surfaces read this, never `builtIn` — `builtIn` is "pod-made AND never
 * keyed", so a keyed IS persona has `builtIn: false` and would be listed as
 * the person's own agent.
 */
export function agentDirectionOf(row: ServedAgentDirectionRow): AgentDirection {
  if (row.direction === "house" || row.direction === "external") {
    return row.direction;
  }
  return resolveAgentDirection({
    origin: row.origin,
    isPersonalAgent: row.isPersonalAgent,
  });
}

// ---------------------------------------------------------------------------
// Agent WRITE MODE — how an agent's writes land, as ONE rule + ONE sentence.
// ---------------------------------------------------------------------------

/**
 * How one agent's writes land (founder, 2026-09-28: "reversible writes act"):
 *  - `pod-default`      — creates and edits apply directly with Undo;
 *  - `create-with-undo` — only creates apply directly (a stricter preset);
 *  - `ask-first`        — every change asks (the agent's "Require approval"
 *                          override, or the pod default switched off for a
 *                          strict agent).
 * Deletions and structural changes ask in every mode (engine floors).
 */
export type AgentWriteMode = "pod-default" | "create-with-undo" | "ask-first";

export interface AgentWriteModeInput {
  /** The agent's named override (`agentMetadata.governancePosture`), if any. */
  posture: string | null | undefined;
  /** Is the pod default (`@reversible` rule) on? */
  podDefaultEnabled: boolean;
  /** Legacy rung-5 flag — only matters when the pod default is off. */
  writesRequireProposal: boolean;
}

/** The ONE derivation — the pod computes it, every surface reads it. */
export function resolveAgentWriteMode(
  input: AgentWriteModeInput
): AgentWriteMode {
  if (input.posture === "ask-first") return "ask-first";
  if (input.posture === "create-with-undo") return "create-with-undo";
  if (input.podDefaultEnabled) return "pod-default";
  // Pod default off: a strict agent proposes everything; a non-strict one
  // (twin / capture) keeps the platform floor's creates and edits.
  return input.writesRequireProposal ? "ask-first" : "pod-default";
}

/** The ONE sentence per mode — summary line and switch caption both read it. */
export const AGENT_WRITE_MODE_LINE: Record<AgentWriteMode, string> = {
  "pod-default":
    "Creates and edits apply directly with Undo; deletions and structural changes ask you.",
  "create-with-undo":
    "Creates apply directly with Undo; edits, deletions and structural changes ask you.",
  "ask-first": "Every change asks you first.",
};
