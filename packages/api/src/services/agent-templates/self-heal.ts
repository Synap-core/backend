/**
 * Self-healing agent → template links (founder decision D10, proposal
 * 3649da4d).
 *
 * Every agent a person connected is an instance of ONE program (an installed
 * agent template). An agent connected before templates existed, or under a
 * type no template names exactly (`claude-code-devbox`, `hermes` before the
 * catalog installed Hermes), has no link. This pass, run after the catalog
 * installs the official templates (each official sync, and at boot):
 *
 *   1. links every agent whose program is CLEAR (`matchAgentTemplate`): its
 *      type is a template's harness, or one of its aliases, or starts with
 *      a harness and a dash (`claude-code-devbox`); else its name is a
 *      template's name or starts with it ("Hermes", "Claude Code on devbox").
 *      More than one template at the strongest rule is not clear;
 *   2. asks the person ONCE for the rest: one owed card per person, a form
 *      with one "Which program is this?" choice per agent (the templates,
 *      plus "None of these"), on a session of its own. A later pass keeps
 *      that ONE card current (an agent linked meanwhile leaves it, a new one
 *      joins it) and never files a second while it is open;
 *   3. the answer (`agentTemplateAnswerReactor`) links each agent to the
 *      program the person picked; "None of these" is remembered on the agent
 *      (`agent_metadata.templateNone`) so it is never asked again.
 *
 * Only agents a person connected are considered: never the pod's own agents
 * (reach `pod`: the Intelligence Service runs them), never a computer, never
 * an app's agent. A link is written only where there is none
 * (`linkAgentToTemplate`). Nothing here throws to its caller.
 */

import { createLogger } from "@synap-core/core";
import {
  and,
  db,
  drizzleSql,
  eq,
  inArray,
  isNull,
  notAnAppAgent,
  focusSessions,
} from "@synap/database";
import { users } from "@synap/database/schema";
import { registerReactor, type Reactor } from "@synap/events";
import type { ExpectedOutput } from "@synap/playbooks";
import { MACHINE_AGENT_TYPE } from "@synap-core/types/agents";
import { OPEN_SESSION_STATUSES } from "@synap-core/types/focus-sessions";
import { resolveAgentReachMany } from "../agent-dispatch/agent-binding.js";
import { updateExpectedOutputsLocked } from "../focus-sessions/delegate-output.js";
import { reconcileOwedSince } from "../focus-sessions/update-session.js";
import { isOwedSlot } from "../focus-sessions/owed-outputs.js";
import {
  loadInstalledAgentTemplates,
  type InstalledAgentTemplate,
} from "./installed.js";
import { linkAgentToTemplate } from "./link.js";

const logger = createLogger({ module: "agent-template-self-heal" });

/** The owed card's kind: the answer reactor matches on it. */
export const AGENT_TEMPLATE_ASK_SLOT_KIND = "agent_template_link";
/** Marks the session this pass opened for a person's card (value = person id). */
export const AGENT_TEMPLATE_ASK_SESSION_KEY = "agentTemplateAskFor";
export const AGENT_TEMPLATE_ASK_LABEL = "Which program is each agent?";
/** The choice that says "this agent runs none of these programs". */
export const AGENT_TEMPLATE_NONE_OPTION = "None of these";
/** A form holds at most 20 fields (`ASK_LIMITS.formFieldsMax`). */
const ASK_MAX_AGENTS = 20;

export type AgentTemplateMatchRule =
  "type" | "alias" | "type_prefix" | "name" | "name_prefix";

/** kebab-case a display name: "Claude Code on devbox" → "claude-code-on-devbox". */
function slugOf(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The template an agent CLEARLY runs, or null. Rules in order; the first rule
 * that names exactly one template decides; one that names several is not
 * clear (null, the person is asked). Pure.
 */
export function matchAgentTemplate(
  agent: { agentType: string | null; name: string | null },
  templates: readonly Pick<
    InstalledAgentTemplate,
    "slug" | "harness" | "aliases" | "name"
  >[]
): { slug: string; rule: AgentTemplateMatchRule } | null {
  const type = (agent.agentType ?? "").trim();
  const name = slugOf(agent.name);
  const names = (t: (typeof templates)[number]) => [
    ...new Set([t.slug, t.harness, slugOf(t.name)].filter(Boolean)),
  ];
  const rules: Array<
    [AgentTemplateMatchRule, (t: (typeof templates)[number]) => boolean]
  > = [
    ["type", (t) => !!type && t.harness === type],
    ["alias", (t) => !!type && t.aliases.includes(type)],
    ["type_prefix", (t) => !!type && type.startsWith(`${t.harness}-`)],
    ["name", (t) => !!name && names(t).includes(name)],
    [
      "name_prefix",
      (t) => !!name && names(t).some((n) => name.startsWith(`${n}-`)),
    ],
  ];
  for (const [rule, hit] of rules) {
    const found = templates.filter(hit);
    if (found.length === 1) return { slug: found[0]!.slug, rule };
    // A prefix shared by two programs: the LONGEST harness is the clear one
    // (`claude-code-devbox` is Claude Code, not a `claude` program).
    if (found.length > 1 && rule === "type_prefix") {
      const longest = [...found].sort(
        (a, b) => b.harness.length - a.harness.length
      );
      if (longest[0]!.harness.length > longest[1]!.harness.length)
        return { slug: longest[0]!.slug, rule };
    }
    if (found.length > 1) return null;
  }
  return null;
}

interface UnlinkedAgent {
  id: string;
  name: string | null;
  agentType: string | null;
  ownerId: string | null;
}

export interface SelfHealReport {
  /** No template is installed yet: nothing linked, nobody asked. */
  skipped: boolean;
  linked: Array<{
    agentUserId: string;
    slug: string;
    rule: AgentTemplateMatchRule;
  }>;
  /** Per person: the agents their one card asks about. */
  asked: Array<{ ownerId: string; sessionId: string; agentUserIds: string[] }>;
  failed: Array<{ what: string; reason: string }>;
}

/** The form a person answers: one choice per agent. Pure. */
export function agentTemplateAskSlot(
  agents: readonly Pick<UnlinkedAgent, "id" | "name" | "agentType">[],
  templates: readonly Pick<InstalledAgentTemplate, "name">[],
  now: Date = new Date()
): ExpectedOutput {
  const options = [
    ...[...new Set(templates.map((t) => t.name))].sort((a, b) =>
      a.localeCompare(b)
    ),
    AGENT_TEMPLATE_NONE_OPTION,
  ];
  const n = agents.length;
  return reconcileOwedSince(
    {
      kind: AGENT_TEMPLATE_ASK_SLOT_KIND,
      label: AGENT_TEMPLATE_ASK_LABEL,
      status: "pending",
      owner: "human",
      blockedReason: "decision",
      why:
        n === 1
          ? "Its type and name do not say which program it runs."
          : `Their types and names do not say which program each of these ${n} agents runs.`,
      unblocks: "Each agent shows its program, and whether it can be woken",
      ask: {
        mode: "form",
        form: {
          fields: agents.slice(0, ASK_MAX_AGENTS).map((a) => ({
            key: a.id,
            label:
              a.agentType && a.agentType !== a.name
                ? `${a.name ?? a.agentType} (${a.agentType})`
                : (a.name ?? "Agent"),
            type: "enum",
            required: true,
            constraints: { enum: options },
          })),
        },
      },
    } as ExpectedOutput,
    now
  ) as ExpectedOutput;
}

const askFieldIds = (slot: ExpectedOutput): string[] => {
  const ask = slot.ask as
    { mode?: string; form?: { fields?: Array<{ key: string }> } } | undefined;
  return ask?.mode === "form" ? (ask.form?.fields ?? []).map((f) => f.key) : [];
};
const isOpenTemplateAsk = (slot: ExpectedOutput) =>
  slot?.kind === AGENT_TEMPLATE_ASK_SLOT_KIND &&
  isOwedSlot(slot) &&
  !slot.answer &&
  !slot.retiredAt;

/** The person's open card session, if this pass opened one. */
async function openAskSession(ownerId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, ownerId),
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]),
        drizzleSql`${focusSessions.metadata}->>${AGENT_TEMPLATE_ASK_SESSION_KEY} = ${ownerId}`
      )
    )
    .limit(1);
  return row?.id ?? null;
}

/** Keep the person's ONE card asking about exactly `agents`. Returns the session. */
async function ensureAsk(
  ownerId: string,
  agents: UnlinkedAgent[],
  templates: InstalledAgentTemplate[],
  now: Date
): Promise<string | null> {
  let sessionId = await openAskSession(ownerId);
  if (!sessionId) {
    if (agents.length === 0) return null;
    const { createFocusSession } =
      await import("../focus-sessions/create-session.js");
    const res = await createFocusSession({
      userId: ownerId,
      title: AGENT_TEMPLATE_ASK_LABEL,
      goal: "Each of your agents is linked to the program it runs.",
    });
    if (res.status !== "created" && res.status !== "deduped") {
      throw new Error(
        `the card's session could not be created (${res.status})`
      );
    }
    sessionId = res.session.id;
    await db
      .update(focusSessions)
      .set({
        metadata: drizzleSql`coalesce(${focusSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(
          {
            [AGENT_TEMPLATE_ASK_SESSION_KEY]: ownerId,
          }
        )}::jsonb`,
      })
      .where(eq(focusSessions.id, sessionId));
  }
  const wanted = agents.map((a) => a.id).sort();
  await updateExpectedOutputsLocked(sessionId, (current) => {
    const open = current.findIndex(isOpenTemplateAsk);
    if (open >= 0) {
      const has = askFieldIds(current[open]!).sort();
      if (JSON.stringify(has) === JSON.stringify(wanted)) return null;
      if (wanted.length === 0) {
        return current.map((o, i) =>
          i === open
            ? {
                ...o,
                retiredAt: now.toISOString(),
                retiredReason: "withdrawn" as const,
              }
            : o
        ) as ExpectedOutput[];
      }
      // The SAME card, kept current: never a second one.
      const fresh = agentTemplateAskSlot(agents, templates, now);
      return current.map((o, i) =>
        i === open ? { ...o, ask: fresh.ask, why: fresh.why } : o
      ) as ExpectedOutput[];
    }
    if (wanted.length === 0) return null;
    // An earlier card was answered: whoever is still unlinked is new since.
    const others = current.filter(
      (o) => o?.kind !== AGENT_TEMPLATE_ASK_SLOT_KIND || o.answer || o.retiredAt
    );
    const answeredSameLabel = current.some(
      (o) => o?.label === AGENT_TEMPLATE_ASK_LABEL
    );
    const slot = agentTemplateAskSlot(agents, templates, now);
    return [
      ...others,
      answeredSameLabel
        ? {
            ...slot,
            label: `${AGENT_TEMPLATE_ASK_LABEL} (${now.toISOString().slice(0, 10)})`,
          }
        : slot,
    ] as ExpectedOutput[];
  });
  return sessionId;
}

export async function selfHealAgentTemplateLinks(
  opts: { now?: Date } = {}
): Promise<SelfHealReport> {
  const now = opts.now ?? new Date();
  const report: SelfHealReport = {
    skipped: false,
    linked: [],
    asked: [],
    failed: [],
  };
  let templates: InstalledAgentTemplate[];
  let candidates: UnlinkedAgent[];
  let noneMarked: Set<string>;
  try {
    templates = await loadInstalledAgentTemplates();
    if (templates.length === 0) return { ...report, skipped: true };
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        agentType: users.agentType,
        ownerId: users.createdByUserId,
        agentMetadata: users.agentMetadata,
      })
      .from(users)
      .where(
        and(
          eq(users.userType, "agent"),
          isNull(users.agentTemplateSlug),
          drizzleSql`${users.agentType} IS DISTINCT FROM ${MACHINE_AGENT_TYPE}`,
          notAnAppAgent(users.id)
        )
      );
    const reach = await resolveAgentReachMany(rows.map((r) => r.id));
    const external = rows.filter((r) => reach.get(r.id) !== "pod");
    noneMarked = new Set(
      external
        .filter(
          (r) =>
            (r.agentMetadata as { templateNone?: boolean } | null)
              ?.templateNone === true
        )
        .map((r) => r.id)
    );
    candidates = external.map((r) => ({
      id: r.id,
      name: r.name,
      agentType: r.agentType,
      ownerId: r.ownerId,
    }));
  } catch (err) {
    logger.error(
      { err },
      "Agent template self-heal could not read the agents — nothing linked, nobody asked"
    );
    report.failed.push({
      what: "read",
      reason: err instanceof Error ? err.message : String(err),
    });
    return report;
  }

  const unclear: UnlinkedAgent[] = [];
  for (const agent of candidates) {
    const match = matchAgentTemplate(agent, templates);
    if (!match) {
      if (!noneMarked.has(agent.id)) unclear.push(agent);
      continue;
    }
    try {
      if (await linkAgentToTemplate(agent.id, match.slug))
        report.linked.push({
          agentUserId: agent.id,
          slug: match.slug,
          rule: match.rule,
        });
    } catch (err) {
      report.failed.push({
        what: `link ${agent.id}`,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ONE card per person: every owner with an open card is visited too, so a
  // card whose agents were all linked meanwhile is retired.
  const byOwner = new Map<string, UnlinkedAgent[]>();
  for (const a of unclear)
    if (a.ownerId)
      byOwner.set(a.ownerId, [...(byOwner.get(a.ownerId) ?? []), a]);
  const withCards = await db
    .select({ userId: focusSessions.userId })
    .from(focusSessions)
    .where(
      and(
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]),
        drizzleSql`${focusSessions.metadata}->>${AGENT_TEMPLATE_ASK_SESSION_KEY} IS NOT NULL`
      )
    )
    .catch((err: unknown) => {
      report.failed.push({
        what: "read cards",
        reason: err instanceof Error ? err.message : String(err),
      });
      return [] as Array<{ userId: string }>;
    });
  for (const { userId } of withCards)
    if (!byOwner.has(userId)) byOwner.set(userId, []);

  for (const [ownerId, agents] of byOwner) {
    try {
      const sessionId = await ensureAsk(ownerId, agents, templates, now);
      if (sessionId && agents.length > 0)
        report.asked.push({
          ownerId,
          sessionId,
          agentUserIds: agents.map((a) => a.id),
        });
    } catch (err) {
      logger.error(
        { err, ownerId },
        "Agent template self-heal could not ask the person"
      );
      report.failed.push({
        what: `ask ${ownerId}`,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (report.linked.length || report.asked.length || report.failed.length)
    logger.info(report, "Agent template self-heal");
  return report;
}

/**
 * Apply the person's answer: each agent to the program they picked. Only the
 * agent's own person may answer for it (the card is on their session, so the
 * one answering IS them; checked again here). Pure of side effects beyond the
 * link and the "None of these" mark.
 */
export async function applyAgentTemplateAnswer(p: {
  answeredBy: string;
  values: Record<string, unknown>;
}): Promise<{ linked: string[]; none: string[]; ignored: string[] }> {
  const out = {
    linked: [] as string[],
    none: [] as string[],
    ignored: [] as string[],
  };
  const ids = Object.keys(p.values);
  if (ids.length === 0) return out;
  const templates = await loadInstalledAgentTemplates();
  const owned = await db
    .select({ id: users.id, ownerId: users.createdByUserId })
    .from(users)
    .where(and(inArray(users.id, ids), eq(users.userType, "agent")));
  const ownerOf = new Map(owned.map((r) => [r.id, r.ownerId]));
  for (const [agentId, choice] of Object.entries(p.values)) {
    if (ownerOf.get(agentId) !== p.answeredBy || typeof choice !== "string") {
      out.ignored.push(agentId);
      continue;
    }
    if (choice === AGENT_TEMPLATE_NONE_OPTION) {
      await db
        .update(users)
        .set({
          agentMetadata: drizzleSql`coalesce(${users.agentMetadata}, '{}'::jsonb) || '{"templateNone": true}'::jsonb`,
        })
        .where(eq(users.id, agentId));
      out.none.push(agentId);
      continue;
    }
    const template = templates.find(
      (t) => t.name === choice || t.slug === choice
    );
    if (template && (await linkAgentToTemplate(agentId, template.slug)))
      out.linked.push(agentId);
    else out.ignored.push(agentId);
  }
  return out;
}

export const agentTemplateAnswerReactor: Reactor = {
  id: "agent-template-answer",
  match: (payload) =>
    payload.subjectType === "focus_session" &&
    payload.action === "slot_answered" &&
    payload.data?.kind === AGENT_TEMPLATE_ASK_SLOT_KIND,
  async handler(payload) {
    const value = payload.data?.value as {
      type?: string;
      values?: Record<string, unknown>;
    } | null;
    const answeredBy =
      (payload.data?.answeredBy as string | undefined) ?? payload.userId;
    if (value?.type !== "form" || !value.values || !answeredBy) return;
    try {
      const out = await applyAgentTemplateAnswer({
        answeredBy,
        values: value.values,
      });
      logger.info(
        { sessionId: payload.subjectId, ...out },
        "Agent template answer applied"
      );
    } catch (err) {
      logger.error(
        { err, sessionId: payload.subjectId },
        "Applying the agent template answer FAILED — the answer is recorded"
      );
    }
  },
};

let registered = false;

/** Register the answer reactor. Called once at API boot. */
export function registerAgentTemplateAnswerReactor(): void {
  if (registered) return;
  registered = true;
  registerReactor(agentTemplateAnswerReactor);
}
