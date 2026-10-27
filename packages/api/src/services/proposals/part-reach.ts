/**
 * PART REACH — what a part of a mixed proposal that acts on its own can reach
 * outside the pod, measured for its review (`ProposalPartReach`).
 *
 * A person approving an automation approves the hosts its steps will call. The
 * review graph listed the steps by name only, so "Run actor (Apify)" was
 * approved without its reach. This reads each step the way the runtime will
 * run it:
 *   - a `capability` step → the skill that answers its verb, through the run
 *     door's own rule (`answeringSkillsWhere` + `answeringSkillOrder`,
 *     `executeCapability`); a `skill` step → that skill by id, same lens;
 *   - the skill's reach by kind: a code skill's `metadata.allowedHosts` (the
 *     sandbox egress list `runSkillInSandbox` enforces), a declarative verb's
 *     provider connection and fixed `baseUrlOverride` host, nothing for a
 *     builtin (it runs in the pod);
 *   - a `fetch` step / `webhook` output → its URL's host, when the URL is
 *     written out (not built from run data).
 * Anything it cannot read — a verb no skill answers for this viewer, a URL
 * built at run time, another automation it starts — is COUNTED as unread, so
 * a surface never says "nothing" for "could not tell".
 *
 * Lens: the reviewer's (the viewer's skills in the proposal's workspace), the
 * same floor every other read of the review applies.
 */

import { db, skills, and, or, inArray } from "@synap/database";
import { resolveServiceName } from "@synap-core/types/service-marks";
import {
  isLikelyUUID,
  isCompositeProposalData,
  type ProposalPartReach,
  type StoredProposalData,
} from "@synap-core/types/proposals";
import {
  answeringSkillOrder,
  answeringSkillsWhere,
} from "../capabilities/verb-skill.js";

/** The columns of a skill row that say where it reaches. */
export interface SkillReachRow {
  kind?: unknown;
  metadata?: unknown;
  providerSpec?: unknown;
}

/** How a flow's steps find the skills they would run. */
export interface StepSkillLookup {
  byVerb(verbId: string): SkillReachRow | undefined;
  byId(skillId: string): SkillReachRow | undefined;
}

type Bag = Record<string, unknown>;

function bag(value: unknown): Bag | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Bag)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The host of a URL written out in full. Null when it is not an http(s) URL
 * or its host is built from run data (`https://{{trigger.host}}/…`).
 */
export function literalHost(raw: unknown): string | null {
  const url = str(raw);
  const authority = url ? /^https?:\/\/([^/?#]+)/i.exec(url)?.[1] : undefined;
  if (!url || !authority || authority.includes("{")) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Where a skill reaches, by kind. Null for an instruction: it runs nothing,
 * so it has no reach to draw.
 */
export function skillReach(
  row: SkillReachRow
): Pick<ProposalPartReach, "hosts" | "connections"> | null {
  switch (row.kind) {
    case "instruction":
      return null;
    case "builtin":
      return { hosts: [], connections: [] };
    case "declarative": {
      const spec = bag(row.providerSpec);
      const tool = str(spec?.tool);
      const host = literalHost(spec?.baseUrlOverride);
      return {
        hosts: host ? [host] : [],
        connections: tool ? [resolveServiceName(tool)] : [],
      };
    }
    default: {
      // A code skill (the column's default kind): its egress allowlist, as
      // written — the sandbox matches it exactly.
      const allowed = bag(row.metadata)?.allowedHosts;
      return {
        hosts: Array.isArray(allowed)
          ? allowed.flatMap((h) => {
              const host = str(h);
              return host ? [host] : [];
            })
          : [],
        connections: [],
      };
    }
  }
}

/** The action nodes of a stored flow. */
function flowNodes(flow: unknown): Bag[] {
  const nodes = bag(flow)?.nodes;
  return Array.isArray(nodes)
    ? nodes.flatMap((n) => {
        const node = bag(n);
        return node && node.type !== "trigger" ? [node] : [];
      })
    : [];
}

/** What an automation's flow can reach, step by step. */
export function flowReach(
  flow: unknown,
  lookup: StepSkillLookup
): ProposalPartReach {
  const hosts = new Set<string>();
  const connections = new Set<string>();
  let unreadSteps = 0;
  const addSkill = (row: SkillReachRow | undefined) => {
    if (!row) {
      unreadSteps++;
      return;
    }
    const reach = skillReach(row);
    reach?.hosts.forEach((h) => hosts.add(h));
    reach?.connections.forEach((c) => connections.add(c));
  };
  const addUrl = (url: unknown) => {
    const host = literalHost(url);
    if (host) hosts.add(host);
    else unreadSteps++;
  };
  for (const node of flowNodes(flow)) {
    const data = bag(node.data) ?? {};
    switch (node.type) {
      case "capability": {
        const verbId = str(data.verbId);
        addSkill(verbId ? lookup.byVerb(verbId) : undefined);
        break;
      }
      case "skill": {
        const skillId = str(data.skillId);
        addSkill(skillId ? lookup.byId(skillId) : undefined);
        break;
      }
      case "fetch":
        addUrl(data.url);
        break;
      case "output":
        if (data.outputType === "webhook") addUrl(bag(data.config)?.url);
        break;
      case "sub_automation":
        // Another automation: its steps are not in this proposal.
        unreadSteps++;
        break;
      default:
        break;
    }
  }
  return {
    hosts: [...hosts].sort(),
    connections: [...connections].sort(),
    unreadSteps,
  };
}

/** The verbs and skill ids the automations of a composite payload run. */
function stepSkillRefs(data: unknown): { verbs: string[]; ids: string[] } {
  const verbs: string[] = [];
  const ids: string[] = [];
  const stored = data as StoredProposalData | null;
  if (!isCompositeProposalData(stored)) return { verbs, ids };
  for (const op of stored.operations) {
    if (op.op !== "create_automation") continue;
    for (const node of flowNodes(op.flowDefinition)) {
      const d = bag(node.data) ?? {};
      const verbId = node.type === "capability" ? str(d.verbId) : null;
      const skillId = node.type === "skill" ? str(d.skillId) : null;
      if (verbId) verbs.push(verbId);
      if (skillId && isLikelyUUID(skillId)) ids.push(skillId);
    }
  }
  return { verbs, ids };
}

/**
 * Read, for every row's workspace, the skills its automations' steps would
 * run — one query per workspace, through the run door's rule. Returns the
 * lookup for a row's workspace. A failed read throws: never "reaches
 * nothing" for "could not read".
 */
export async function readStepSkillLookups(
  rows: ReadonlyArray<{ workspaceId: string | null; data: unknown }>,
  userId: string
): Promise<(workspaceId: string | null) => StepSkillLookup> {
  const wanted = new Map<
    string | null,
    { verbs: Set<string>; ids: Set<string> }
  >();
  for (const row of rows) {
    const { verbs, ids } = stepSkillRefs(row.data);
    if (!verbs.length && !ids.length) continue;
    const slot = wanted.get(row.workspaceId) ?? {
      verbs: new Set<string>(),
      ids: new Set<string>(),
    };
    verbs.forEach((v) => slot.verbs.add(v));
    ids.forEach((i) => slot.ids.add(i));
    wanted.set(row.workspaceId, slot);
  }
  const lookups = new Map<string | null, StepSkillLookup>();
  for (const [workspaceId, { verbs, ids }] of wanted) {
    const found = await db
      .select({
        id: skills.id,
        name: skills.name,
        kind: skills.kind,
        metadata: skills.metadata,
        providerSpec: skills.providerSpec,
      })
      .from(skills)
      .where(
        and(
          answeringSkillsWhere(userId, workspaceId),
          or(
            verbs.size ? inArray(skills.name, [...verbs]) : undefined,
            ids.size ? inArray(skills.id, [...ids]) : undefined
          )
        )
      )
      .orderBy(...answeringSkillOrder());
    const byName = new Map<string, SkillReachRow>();
    const byId = new Map<string, SkillReachRow>();
    for (const row of found) {
      // Ordered: the first of a name is the one the run door would pick.
      if (!byName.has(row.name)) byName.set(row.name, row);
      byId.set(row.id, row);
    }
    lookups.set(workspaceId, {
      byVerb: (verbId) => byName.get(verbId),
      byId: (skillId) => byId.get(skillId),
    });
  }
  const none: StepSkillLookup = {
    byVerb: () => undefined,
    byId: () => undefined,
  };
  return (workspaceId) => lookups.get(workspaceId) ?? none;
}
