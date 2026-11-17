/**
 * THE PROCESS READ — one playbook seen whole (Process wave plan 0adf8352,
 * founder-approved 16 Nov 2026, W2): `readProcess(playbookId)` for one page,
 * `listProcesses({ workspaceId? })` for a space's index (cards + the
 * automations outside any process). The contract is
 * `@synap-core/types/processes` (`ProcessRead`, `ProcessIndex`); the doors
 * are tRPC `playbooks.process` / `playbooks.processes`, Hub REST
 * `GET /playbooks/:id/process` / `GET /processes`, and MCP
 * `synap_list_playbooks({ playbookId })` → `process` (no new MCP tool).
 *
 * COMPOSED, DERIVING NOTHING NEW. Each block is an existing read:
 *   definition  the playbook row through the playbook visibility floor
 *               (`scopedDb`, as `playbooks.get`); `preApprovedVersion` = the
 *               person's pre-approval rule (`readPreApprovedVersion`, the
 *               run door's own rule predicate);
 *               `installedFrom` = `metadata.marketSource`; `updateAvailable`
 *               = the installed-package standing (`listInstalledPackages`);
 *   when        `playbook_automations` (the ONE link, 0425) under the
 *               automation floor; `listEnabledWorkers({ playbookId })`;
 *   steps/checks the stages (`resolveStageCategory` / `resolveStageGate` /
 *               `requiresOf`) and `collectPlaybookCriteria`;
 *   moves       `readFlowOf` on the subject kind (`flow.of`);
 *   needs       the `tools` / `requires` entries, intents classified by
 *               `isKnownIntent` and covered by `foldIntentCoverage` over the
 *               run's own registry read (`listCapabilities`); a capability or
 *               verb entry is filled when the registry names it (the run
 *               profile's `namedVerbs` rule); a `requires` key is `unknown`
 *               here: it is checked against the runner's computer at hand-off;
 *   skills      `readPlaybookSkills`;
 *   runs        the session list WHERE (`sessionListConditions` with
 *               `flow: { playbookId }`), THE needs-you owed predicate
 *               (`asksYouSessionIds`), the run ledger (`listPlaybookRunGroups`,
 *               one grouped query, and `listRecentRunsByFlows`);
 *   health      `deriveProcessHealth` (the leaf, moved from the browser).
 *
 * UNMEASURED IS NOT EMPTY: a part whose read failed is listed in
 * `unavailable` and its fields read null / `unknown`, never an empty list or 0.
 */
import {
  and,
  asc,
  count,
  db,
  desc,
  eq,
  focusSessions,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  automations,
  playbookAutomations,
  playbooks,
} from "@synap/database";
import type { Playbook } from "@synap/database/schema";
import {
  collectPlaybookCriteria,
  isNeedToolEntry,
  isRunToolName,
  readToolsList,
  resolveStageCategory,
  resolveStageGate,
} from "@synap/playbooks";
import { isKnownIntent } from "@synap-core/types/capability-intents";
import {
  readSpaceNeedBindings,
  resolveNeedRefVerbs,
  type SpaceNeedBindings,
} from "../needs/space-needs.js";
import { canonicalNeedSlug, parseNeedRef } from "@synap-core/types/needs";
import { resolveProcessNeedLabels } from "@synap-core/types/vocabulary";
import {
  classifyStepRunner,
  deriveProcessHealth,
  summarizeProcessNeed,
  unmeasuredProcessRunCounts,
  type ProcessAutomation,
  type ProcessCriterion,
  type ProcessDefinition,
  type ProcessGate,
  type ProcessHealth,
  type ProcessIndex,
  type ProcessMoves,
  type ProcessNeed,
  type ProcessOutsideAutomation,
  type ProcessRead,
  type ProcessReadPart,
  type ProcessRunCounts,
  type ProcessRunRow,
  type ProcessSkill,
  type ProcessStep,
  type ProcessSummary,
  type ProcessWorker,
} from "@synap-core/types/processes";
import { createLogger } from "@synap-core/core";
import { AccessContext } from "../../access/context.js";
import { scopedDb } from "../../access/scoped-db.js";
import { resolveScope } from "../../utils/scope-filter.js";
import { readMarketSource } from "../capabilities/market-source.js";
import { listCapabilities } from "../capabilities/capability-registry.js";
import { foldIntentCoverage } from "../capabilities/capability-intent-index.js";
import { sessionListConditions } from "../focus-sessions/session-list-conditions.js";
import { OPEN_SESSION_STATUSES } from "../focus-sessions/session-statuses.js";
import { attachSessionKind } from "../focus-sessions/session-kind.js";
import { attachTriage } from "../focus-sessions/triage.js";
import { readFlowOf, flowOfInput } from "../lifecycle/flow-read.js";
import { listPlaybookRunGroups } from "../runs/index.js";
import { listRecentRunsByFlows } from "../runs/recent-by-flows.js";
import type { RunGroup } from "../runs/types.js";
import { asksYouSessionIds } from "../signals/needs-you-owed.js";
import { listEnabledWorkers } from "./workers.js";
import { readPlaybookSkills } from "./playbook-skills.js";
import { requiresOf } from "./requires-of.js";
import { readPreApprovedVersion } from "./pre-approved-run.js";

const logger = createLogger({ module: "process-read" });

/** Who reads: the access context's inputs (a tRPC ctx, a Hub REST / MCP ctx). */
export interface ProcessReader {
  userId: string;
  workspaceId?: string | null;
  agentUserId?: string | null;
  isHubProtocol?: boolean;
}

/** The reader of a door's context (tRPC, Hub REST, MCP all carry these). */
export function processReaderOf(ctx: {
  userId?: string | null;
  workspaceId?: string | null;
  agentUserId?: string | null;
  isHubProtocol?: boolean;
}): ProcessReader {
  if (!ctx.userId) throw new Error("process read: no user on the request");
  return {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId ?? null,
    agentUserId: ctx.agentUserId ?? null,
    isHubProtocol: ctx.isHubProtocol ?? false,
  };
}

/** "This week" for the counts: the last 7 days, the run ledger's own window. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Recent sessions on a process page. */
const RECENT_RUNS = 5;
/** Open sessions read for the needs-you count; past it the count is a floor. */
const OPEN_SCAN_LIMIT = 200;
/** Processes on one list read. */
const LIST_LIMIT = 200;

type Row = Playbook;

function stagesOf(row: Pick<Row, "stages">): Record<string, unknown>[] {
  return Array.isArray(row.stages)
    ? (row.stages as unknown[]).filter(
        (s): s is Record<string, unknown> =>
          !!s &&
          typeof s === "object" &&
          typeof (s as { key?: unknown }).key === "string"
      )
    : [];
}

function subjectSlugOf(row: Pick<Row, "subjectProfile">): string | null {
  const slug = (row.subjectProfile as { profileSlug?: unknown } | null)
    ?.profileSlug;
  return typeof slug === "string" && slug.trim() ? slug.trim() : null;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : null;

// ── Pure folds (exported for tests) ──────────────────────────────────────────

/** The steps of a playbook, from its stages. PURE. */
export function processSteps(
  row: Pick<Row, "stages" | "requires">
): ProcessStep[] {
  return stagesOf(row).map((stage) => {
    const gate = resolveStageGate(stage)?.kind ?? null;
    const runner = stage.runner ?? null;
    return {
      key: String(stage.key),
      name: str(stage.name) ?? String(stage.key),
      goal: str(stage.goal),
      category: resolveStageCategory(stage),
      runner,
      runnerKind: classifyStepRunner({ gate, runner }),
      tools: readToolsList(stage.tools),
      requires: requiresOf(null, stage as { requires?: unknown }),
      gate,
      subjectStatus: str(stage.subjectStatus),
      onApproved: str(stage.onApproved),
    };
  });
}

/** The checks of a playbook: its criteria (the playbook's and each step's) and its gates. PURE. */
export function processChecks(row: Pick<Row, "criteria" | "stages">): {
  criteria: ProcessCriterion[];
  gates: ProcessGate[];
} {
  const criteria = collectPlaybookCriteria(row).map((c): ProcessCriterion => ({
    key: c.key,
    statement: c.statement,
    checkKind: (c.check as { kind?: string } | undefined)?.kind ?? null,
    stepKey: c.stageKey ?? null,
  }));
  const gates = processSteps({ stages: row.stages, requires: [] })
    .filter((s) => s.gate !== null)
    .map((s) => ({ stepKey: s.key, kind: s.gate! }));
  return { criteria, gates };
}

/** Does the playbook name a `need:` ref (tools or requires, its own or a step's)? PURE. */
function declaresNeedRef(
  row: Pick<Row, "tools" | "requires" | "stages">
): boolean {
  return declaredNeeds(row).some((d) => d.kind === "need");
}

/** A space's need bindings; a process with no space has none (empty, read). */
async function readNeedBindings(
  workspaceId: string | null
): Promise<SpaceNeedBindings> {
  return workspaceId ? readSpaceNeedBindings(workspaceId) : new Map();
}

interface DeclaredNeed {
  slug: string;
  kind: ProcessNeed["kind"];
  source: ProcessNeed["source"];
  steps: string[];
}

/**
 * The needs a playbook declares: each `tools` entry that is not a run tool
 * (an intent slug, or a capability / verb by name or id) and each `requires`
 * key, the playbook's own then each step's, once per (source, slug), with the
 * steps that name it. PURE.
 */
export function declaredNeeds(
  row: Pick<Row, "tools" | "requires" | "stages">
): DeclaredNeed[] {
  const out = new Map<string, DeclaredNeed>();
  const add = (
    source: DeclaredNeed["source"],
    slug: string,
    step: string | null
  ) => {
    if (source === "tools" && isRunToolName(slug)) return;
    const key = `${source}:${slug}`;
    const need =
      out.get(key) ??
      ({
        slug,
        kind: isNeedToolEntry(slug)
          ? "need"
          : source === "tools" && isKnownIntent(slug)
            ? "intent"
            : "capability",
        source,
        steps: [],
      } satisfies DeclaredNeed);
    if (step && !need.steps.includes(step)) need.steps.push(step);
    out.set(key, need);
  };
  for (const t of readToolsList(row.tools)) add("tools", t, null);
  for (const k of requiresOf(row)) add("requires", k, null);
  for (const stage of stagesOf(row)) {
    const key = String(stage.key);
    for (const t of readToolsList(stage.tools)) add("tools", t, key);
    for (const k of requiresOf(null, stage as { requires?: unknown }))
      add("requires", k, key);
  }
  return [...out.values()];
}

type RegistryRow = Awaited<ReturnType<typeof listCapabilities>>[number];

/**
 * A `need:` entry against the space's bindings (0426). PURE. Unread bindings
 * (null) → `unknown`. A `requires` need is filled once a provider is bound
 * (its computer is checked when a step is handed over); a `tools` need also
 * needs the bound provider to offer a tool for it, which takes the registry
 * read (null → `unknown`). The one resolver: `resolveNeedRefVerbs`.
 */
function coverNeedRef(
  d: DeclaredNeed,
  caps: readonly RegistryRow[] | null,
  bindings: SpaceNeedBindings | null
): ProcessNeed {
  if (bindings === null) return { ...d, state: "unknown", providers: [] };
  const slug = canonicalNeedSlug(parseNeedRef(d.slug)?.need) ?? null;
  const bound = slug ? bindings.get(slug) : undefined;
  const providerId = bound?.providerCapabilityId ?? null;
  if (!providerId) return { ...d, state: "empty", providers: [] };
  const provider = {
    capabilityId: providerId,
    capabilityName: bound?.providerName ?? null,
    verbId: null,
  };
  if (d.source === "requires") {
    return { ...d, state: "filled", providers: [provider] };
  }
  if (caps === null) return { ...d, state: "unknown", providers: [] };
  const r = resolveNeedRefVerbs(d.slug, bindings, caps);
  return r.status === "ok"
    ? {
        ...d,
        state: "filled",
        providers: [{ ...provider, capabilityName: r.providerName }],
      }
    : { ...d, state: "empty", providers: [] };
}

/**
 * Each declared need with its state against ONE registry read (null = the read
 * failed → every `tools` need is `unknown`) and the space's need bindings
 * (null = unread → every `need:` entry is `unknown`). PURE.
 */
export function coverNeeds(
  declared: readonly DeclaredNeed[],
  caps: readonly RegistryRow[] | null,
  workspaceId: string | null,
  bindings: SpaceNeedBindings | null = null
): ProcessNeed[] {
  const intents = declared
    .filter((d) => d.kind === "intent")
    .map((d) => d.slug);
  const coverage =
    caps === null
      ? null
      : foldIntentCoverage({ declared: intents, caps: [...caps], workspaceId });
  return declared
    .map((d): ProcessNeed => coverOne(d))
    .map((n) => ({
      ...n,
      // The entry's words, never its token (the pod answers in English; a
      // surface in another locale calls the same resolver with its locale).
      ...resolveProcessNeedLabels(n, { locale: "en" }),
    }));

  function coverOne(d: DeclaredNeed): ProcessNeed {
    if (d.kind === "need") return coverNeedRef(d, caps, bindings);
    if (d.source === "requires" || caps === null) {
      return { ...d, state: "unknown", providers: [] };
    }
    if (d.kind === "intent") {
      const c = coverage!.intents.find((i) => i.intent === d.slug);
      const providers = (c?.providedBy ?? []).map((m) => ({
        capabilityId: m.capabilityId,
        capabilityName: m.capabilityName,
        verbId: m.verbId,
      }));
      return {
        ...d,
        state: providers.length > 0 ? "filled" : "empty",
        providers,
      };
    }
    // A capability by id or name, or a verb by id (the run profile's rule).
    const providers: ProcessNeed["providers"] = [];
    for (const cap of caps) {
      if (cap.id === d.slug || cap.name === d.slug) {
        providers.push({
          capabilityId: cap.id,
          capabilityName: cap.name,
          verbId: null,
        });
        continue;
      }
      for (const v of cap.verbs ?? []) {
        if (v.id === d.slug)
          providers.push({
            capabilityId: cap.id,
            capabilityName: cap.name,
            verbId: v.id,
          });
      }
    }
    return {
      ...d,
      state: providers.length > 0 ? "filled" : "empty",
      providers,
    };
  }
}

/** The health of a process from its ledger facts. PURE. */
export function processHealthOf(input: {
  status: string;
  group: RunGroup | null;
  recent: ReadonlyArray<{
    id: string;
    status: string;
    startedAt: Date;
    sessionId: string | null;
  }>;
  /** The group read covered this flow (absent group = zero runs, exactly). */
  groupRead: boolean;
}): ProcessHealth {
  return deriveProcessHealth({
    kind: "playbook",
    definitionStatus: input.status,
    runGroup: input.group,
    recentRuns: input.recent,
    exactRunCount: input.group
      ? input.group.runCount
      : input.groupRead
        ? 0
        : null,
  });
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** A session list WHERE for the reader's own sessions of any kind (the owner floor). */
function sessionsWhere(
  reader: ProcessReader,
  extra: Partial<Parameters<typeof sessionListConditions>[0]>
) {
  return and(
    ...sessionListConditions({
      userId: reader.userId,
      scope: resolveScope({}, {}),
      status: "all",
      kind: "all",
      lens: "all",
      ...extra,
    })
  );
}

async function readAutomations(
  reader: ProcessReader,
  playbookIds: readonly string[]
): Promise<Map<string, ProcessAutomation[]>> {
  const out = new Map<string, ProcessAutomation[]>();
  if (playbookIds.length === 0) return out;
  const visible = scopedDb(AccessContext.from(reader)).predicate(automations);
  const rows = await db
    .select({
      playbookId: playbookAutomations.playbookId,
      id: automations.id,
      name: automations.name,
      role: playbookAutomations.role,
      triggerType: automations.triggerType,
      status: automations.status,
      sortOrder: playbookAutomations.sortOrder,
      nextRunAt: automations.nextRunAt,
    })
    .from(playbookAutomations)
    .innerJoin(
      automations,
      eq(playbookAutomations.automationId, automations.id)
    )
    .where(
      and(visible, inArray(playbookAutomations.playbookId, [...playbookIds]))
    )
    .orderBy(
      asc(playbookAutomations.sortOrder),
      asc(playbookAutomations.createdAt)
    );
  for (const r of rows) {
    const list = out.get(r.playbookId) ?? [];
    list.push({
      id: r.id,
      name: r.name,
      role: r.role ?? "member",
      triggerType: r.triggerType,
      status: r.status,
      sortOrder: r.sortOrder ?? null,
      nextRunAt: r.nextRunAt ? new Date(r.nextRunAt).toISOString() : null,
    });
    out.set(r.playbookId, list);
  }
  return out;
}

/**
 * The automations the reader can see that belong to NO live process: no
 * `playbook_automations` row to a playbook that is not archived. Archived
 * automations are left out. Same space narrowing as the cards. THROWS on a
 * failed read (the caller names it unavailable, never an empty list).
 */
async function readAutomationsOutside(
  reader: ProcessReader,
  narrowSpace: "all" | null | string
): Promise<ProcessOutsideAutomation[]> {
  const access = scopedDb(AccessContext.from(reader));
  const visible = access.predicate(automations);
  // "In a process" = in a live process the reader can SEE: an automation tied
  // only to another member's private playbook is outside every process this
  // reader has, so it is listed here rather than vanishing from both lists.
  const inAProcess = db
    .select({ id: playbookAutomations.automationId })
    .from(playbookAutomations)
    .innerJoin(playbooks, eq(playbooks.id, playbookAutomations.playbookId))
    .where(and(access.predicate(playbooks), ne(playbooks.status, "archived")));
  const space =
    narrowSpace === "all"
      ? undefined
      : narrowSpace === null
        ? isNull(automations.workspaceId)
        : or(
            isNull(automations.workspaceId),
            eq(automations.workspaceId, narrowSpace)
          );
  const rows = await db
    .select({
      id: automations.id,
      name: automations.name,
      triggerType: automations.triggerType,
      status: automations.status,
      workspaceId: automations.workspaceId,
    })
    .from(automations)
    .where(
      and(
        visible,
        ne(automations.status, "archived"),
        notInArray(automations.id, inAProcess),
        space
      )
    )
    .orderBy(asc(automations.name))
    .limit(LIST_LIMIT);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    triggerType: r.triggerType,
    status: r.status,
    workspaceId: r.workspaceId ?? null,
  }));
}

/** Counts per playbook from the session list and the run ledger. THROWS on a failed read. */
async function readCounts(
  reader: ProcessReader,
  playbookIds: readonly string[],
  groups: Map<string, RunGroup> | null
): Promise<Map<string, ProcessRunCounts>> {
  const ids = [...playbookIds];
  const out = new Map<string, ProcessRunCounts>();
  if (ids.length === 0) return out;
  const since = new Date(Date.now() - WEEK_MS).toISOString();
  const byPlaybook = inArray(focusSessions.playbookId, ids);
  const [openRows, doneRows] = await Promise.all([
    db
      .select({ id: focusSessions.id, playbookId: focusSessions.playbookId })
      .from(focusSessions)
      .where(
        and(
          sessionsWhere(reader, { status: [...OPEN_SESSION_STATUSES] }),
          byPlaybook
        )
      )
      .orderBy(desc(focusSessions.updatedAt))
      .limit(OPEN_SCAN_LIMIT),
    db
      .select({ playbookId: focusSessions.playbookId, n: count() })
      .from(focusSessions)
      .where(
        and(
          sessionsWhere(reader, { status: ["closed"], settledSince: since }),
          byPlaybook
        )
      )
      .groupBy(focusSessions.playbookId),
  ]);
  const asksYou = await asksYouSessionIds(
    reader.userId,
    openRows.map((r) => r.id)
  );
  const truncated = openRows.length >= OPEN_SCAN_LIMIT;
  for (const id of ids) {
    const open = openRows.filter((r) => r.playbookId === id);
    const group = groups?.get(id) ?? null;
    out.set(id, {
      // Past the scan cap a count is not exact: unmeasured, never a floor dressed as exact.
      open: truncated ? null : open.length,
      needsYou: truncated ? null : open.filter((r) => asksYou.has(r.id)).length,
      doneThisWeek: Number(doneRows.find((r) => r.playbookId === id)?.n ?? 0),
      failedThisWeek: groups ? (group?.recentFailedCount ?? 0) : null,
      total: groups ? (group?.runCount ?? 0) : null,
    });
  }
  return out;
}

/**
 * The run ledger's exact group per playbook (absent = zero runs), in ONE
 * grouped query over every id. THROWS on a failed read.
 */
function readGroups(
  reader: ProcessReader,
  playbookIds: readonly string[]
): Promise<Map<string, RunGroup>> {
  return listPlaybookRunGroups({ userId: reader.userId, playbookIds });
}

async function readRecentMarks(
  reader: ProcessReader,
  playbookIds: readonly string[]
) {
  const out = new Map<
    string,
    Array<{
      id: string;
      status: string;
      startedAt: Date;
      sessionId: string | null;
    }>
  >();
  for (let i = 0; i < playbookIds.length; i += 100) {
    const histories = await listRecentRunsByFlows({
      userId: reader.userId,
      flows: playbookIds
        .slice(i, i + 100)
        .map((flowId) => ({ flowType: "playbook" as const, flowId })),
    });
    for (const h of histories) out.set(h.flowId, h.runs);
  }
  return out;
}

/** Run a part's read; a failure names the part unavailable (logged), never empty. */
async function part<T>(
  name: ProcessReadPart,
  unavailable: Set<ProcessReadPart>,
  read: () => Promise<T>,
  ctx: Record<string, unknown>
): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    logger.warn(
      { err, part: name, ...ctx },
      "process read: a part could not be read"
    );
    unavailable.add(name);
    return null;
  }
}

async function loadPlaybook(
  reader: ProcessReader,
  playbookId: string
): Promise<Row | null> {
  const row = await scopedDb(AccessContext.from(reader)).findFirst<Row>(
    playbooks,
    {
      where: eq(playbooks.id, playbookId),
    }
  );
  return row ?? null;
}

function definitionOf(
  row: Row
): Omit<ProcessDefinition, "preApprovedVersion" | "updateAvailable"> {
  const source = readMarketSource(
    row.metadata as Record<string, unknown> | null
  );
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    workspaceId: row.workspaceId ?? null,
    status: row.status,
    version: row.version,
    executor: row.executor,
    runner: row.runner ?? null,
    scope: row.scope ?? "session",
    subjectProfileSlug: subjectSlugOf(row),
    installedFrom: source
      ? {
          packageSlug: source.packageSlug,
          packageVersion: source.packageVersion,
          installedAt: source.installedAt || null,
        }
      : null,
  };
}

function movesOf(
  flow: Awaited<ReturnType<typeof readFlowOf>>,
  playbookId: string,
  profileSlug: string
): ProcessMoves {
  const mine = flow.flows.find((f) => f.id === playbookId);
  return {
    profileSlug,
    states: flow.states.map((s) => ({
      key: s.key,
      label: s.label,
      category: s.category,
      ownedBy: s.owners
        .filter((o) => o.playbookId === playbookId)
        .map((o) => o.stageKey),
    })),
    undeclaredStatuses: mine?.undeclaredStatuses ?? [],
  };
}

/**
 * ONE process, whole. `null` when the reader cannot see the playbook (the door
 * answers NOT_FOUND). A part whose read fails is named in `unavailable`.
 */
export async function readProcess(
  reader: ProcessReader,
  playbookId: string
): Promise<ProcessRead | null> {
  const row = await loadPlaybook(reader, playbookId);
  if (!row) return null;
  const unavailable = new Set<ProcessReadPart>();
  const ctx = { playbookId };
  const profileSlug = subjectSlugOf(row);

  const [
    preApprovedVersion,
    updateAvailable,
    automationsBy,
    workers,
    caps,
    skills,
    flow,
    groups,
    marks,
    recent,
    bindings,
  ] = await Promise.all([
    part(
      "preApproval",
      unavailable,
      () => readPreApprovedVersion(db, row.id, reader.userId),
      ctx
    ),
    part("updateAvailable", unavailable, () => readUpdateAvailable(row), ctx),
    part("when", unavailable, () => readAutomations(reader, [row.id]), ctx),
    part(
      "when",
      unavailable,
      () => listEnabledWorkers({ userId: reader.userId, playbookId: row.id }),
      ctx
    ),
    part(
      "needs",
      unavailable,
      () =>
        listCapabilities(
          { workspaceId: row.workspaceId ?? null, userId: reader.userId },
          { limit: null }
        ),
      ctx
    ),
    part(
      "skills",
      unavailable,
      () =>
        readPlaybookSkills({
          playbook: row,
          userId: reader.userId,
          workspaceId: row.workspaceId ?? null,
        }),
      ctx
    ),
    profileSlug
      ? part(
          "moves",
          unavailable,
          () =>
            readFlowOf(
              flowOfInput.parse({
                profileSlug,
                workspaceId: row.workspaceId ?? null,
                firstN: 0,
              }),
              reader
            ),
          ctx
        )
      : Promise.resolve(null),
    part("runs", unavailable, () => readGroups(reader, [row.id]), ctx),
    part("health", unavailable, () => readRecentMarks(reader, [row.id]), ctx),
    part("runs", unavailable, () => readRecentRuns(reader, row.id), ctx),
    // The space's need bindings (0426): a `need:` entry's state and provider,
    // read only when the playbook names a need.
    declaresNeedRef(row)
      ? part(
          "needs",
          unavailable,
          () => readNeedBindings(row.workspaceId ?? null),
          ctx
        )
      : Promise.resolve(new Map() as SpaceNeedBindings),
  ]);
  const counts =
    (
      await part(
        "runs",
        unavailable,
        () => readCounts(reader, [row.id], groups),
        ctx
      )
    )?.get(row.id) ?? unmeasuredProcessRunCounts();
  if (groups === null || marks === null) unavailable.add("health");

  const health = processHealthOf({
    status: row.status,
    group: groups?.get(row.id) ?? null,
    recent: marks?.get(row.id) ?? [],
    groupRead: groups !== null,
  });

  return {
    playbook: {
      ...definitionOf(row),
      preApprovedVersion,
      updateAvailable,
    },
    when: {
      automations: automationsBy?.get(row.id) ?? [],
      workers: (workers ?? []).map((w): ProcessWorker => ({
        ruleId: w.ruleId,
        activatorKey: w.activatorKey,
        mode: w.mode,
        scope: w.scope,
        state: w.state,
        automationId: w.automationId,
        projectId: w.projectId,
        trackId: w.trackId,
      })),
      manualStart:
        row.status === "active" && (row.scope ?? "session") === "session",
    },
    steps: processSteps(row),
    checks: processChecks(row),
    moves: flow && profileSlug ? movesOf(flow, row.id, profileSlug) : null,
    needs: coverNeeds(
      declaredNeeds(row),
      caps,
      row.workspaceId ?? null,
      bindings
    ),
    skills: (skills ?? []) as ProcessSkill[],
    runs: { counts, recent: recent ?? [] },
    health,
    unavailable: [...unavailable],
  };
}

/**
 * The process's recent sessions, a session LIST: each row carries the two
 * derived lenses every list door attaches (`attachSessionKind`,
 * `attachTriage`), so no surface re-derives them from origin and metadata.
 */
async function readRecentRuns(
  reader: ProcessReader,
  playbookId: string
): Promise<ProcessRunRow[]> {
  const rows = await db
    .select({
      sessionId: focusSessions.id,
      title: focusSessions.title,
      status: focusSessions.status,
      currentStage: focusSessions.currentStage,
      updatedAt: focusSessions.updatedAt,
      origin: focusSessions.origin,
      playbookId: focusSessions.playbookId,
      metadata: focusSessions.metadata,
    })
    .from(focusSessions)
    .where(sessionsWhere(reader, { flow: { playbookId } }))
    .orderBy(desc(focusSessions.updatedAt))
    .limit(RECENT_RUNS);
  return attachTriage(attachSessionKind(rows)).map((r) => ({
    sessionId: r.sessionId,
    title: r.title ?? null,
    status: r.status,
    currentStage: r.currentStage ?? null,
    updatedAt: new Date(r.updatedAt).toISOString(),
    kind: r.kind,
    triage: {
      pending: r.triage.pending,
      acceptedAt: r.triage.acceptedAt,
      acceptedBy: r.triage.acceptedBy,
      heldBecause: r.triage.heldBecause ?? null,
    },
  }));
}

/** Whether the package this playbook was installed from has an update (null = not compared). */
async function readUpdateAvailable(row: Row): Promise<boolean | null> {
  const source = readMarketSource(
    row.metadata as Record<string, unknown> | null
  );
  if (!source) return null;
  const { listInstalledPackages } =
    await import("../package-updates/standing.js");
  const standing = (await listInstalledPackages()).find(
    (p) => p.slug === source.packageSlug
  );
  return standing?.hasUpdate ?? null;
}

/**
 * A space's process index: its processes as cards (or every visible one with
 * no space) and the automations outside any process. User-floored (the
 * access layer), so a pod admin sees every space they can see. Archived
 * playbooks are not processes a person works. Parts read in batches: one
 * registry read per space, one session read per count, one grouped ledger read.
 */
export async function listProcesses(
  reader: ProcessReader,
  input: { workspaceId?: string | null } = {}
): Promise<ProcessIndex> {
  const indexUnavailable = new Set<ProcessReadPart>();
  const [processes, automationsOutsideProcess] = await Promise.all([
    listProcessCards(reader, input),
    part(
      "when",
      indexUnavailable,
      () =>
        readAutomationsOutside(
          reader,
          input.workspaceId === undefined ? "all" : input.workspaceId
        ),
      { workspaceId: input.workspaceId ?? null }
    ),
  ]);
  return {
    processes,
    automationsOutsideProcess,
    unavailable: [...indexUnavailable],
  };
}

async function listProcessCards(
  reader: ProcessReader,
  input: { workspaceId?: string | null }
): Promise<ProcessSummary[]> {
  const narrow =
    typeof input.workspaceId === "string"
      ? or(
          isNull(playbooks.workspaceId),
          eq(playbooks.workspaceId, input.workspaceId)
        )
      : input.workspaceId === null
        ? isNull(playbooks.workspaceId)
        : undefined;
  const rows = await scopedDb(AccessContext.from(reader)).findMany<Row>(
    playbooks,
    {
      where: and(ne(playbooks.status, "archived"), narrow),
      orderBy: [asc(playbooks.name)],
      limit: LIST_LIMIT,
    }
  );
  const ids = rows.map((r) => r.id);
  const unavailable = new Set<ProcessReadPart>();
  const ctx = { workspaceId: input.workspaceId ?? null };

  const spaces = [...new Set(rows.map((r) => r.workspaceId ?? null))];
  // The spaces whose processes name a need (0426): their bindings are read.
  const needSpaces = [
    ...new Set(rows.filter(declaresNeedRef).map((r) => r.workspaceId ?? null)),
  ];
  const [automationsBy, groups, marks, capsBySpace, bindingsBySpace] =
    await Promise.all([
      part("when", unavailable, () => readAutomations(reader, ids), ctx),
      part("runs", unavailable, () => readGroups(reader, ids), ctx),
      part("health", unavailable, () => readRecentMarks(reader, ids), ctx),
      part(
        "needs",
        unavailable,
        async () =>
          new Map(
            await Promise.all(
              spaces.map(
                async (ws) =>
                  [
                    ws,
                    await listCapabilities(
                      { workspaceId: ws, userId: reader.userId },
                      { limit: null }
                    ),
                  ] as const
              )
            )
          ),
        ctx
      ),
      part(
        "needs",
        unavailable,
        async () =>
          new Map(
            await Promise.all(
              needSpaces.map(
                async (ws) => [ws, await readNeedBindings(ws)] as const
              )
            )
          ),
        ctx
      ),
    ]);
  const countsBy = await part(
    "runs",
    unavailable,
    () => readCounts(reader, ids, groups),
    ctx
  );
  if (groups === null || marks === null) unavailable.add("health");

  return rows.map((row): ProcessSummary => {
    const needs = coverNeeds(
      declaredNeeds(row),
      capsBySpace?.get(row.workspaceId ?? null) ?? null,
      row.workspaceId ?? null,
      declaresNeedRef(row)
        ? (bindingsBySpace?.get(row.workspaceId ?? null) ?? null)
        : new Map()
    );
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      workspaceId: row.workspaceId ?? null,
      status: row.status,
      health: processHealthOf({
        status: row.status,
        group: groups?.get(row.id) ?? null,
        recent: marks?.get(row.id) ?? [],
        groupRead: groups !== null,
      }),
      counts: countsBy?.get(row.id) ?? unmeasuredProcessRunCounts(),
      stepCount: stagesOf(row).length,
      automationCount:
        automationsBy === null
          ? null
          : (automationsBy.get(row.id)?.length ?? 0),
      needs: needs.map(summarizeProcessNeed),
      unavailable: [...unavailable],
    };
  });
}
