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
 *     sandbox egress list `runSkillInSandbox` enforces) plus the connections
 *     its code names in `callProvider(...)` (the runtime lets it call any of
 *     the person's connections, each call governed), a declarative verb's
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

import {
  db,
  skills,
  links,
  tools,
  and,
  or,
  eq,
  inArray,
  drizzleSql,
  userVisibleWhere,
} from "@synap/database";
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
  code?: unknown;
  /** The tools it declares it calls (`requires` edges), by name. */
  requiredTools?: readonly string[];
}

/**
 * The tools each skill declares it calls (`requires` edges, the scope a
 * person approves with the skill), by name — only tools `userId` can see,
 * the same floor `visibleRequiredTools` applies at filing and approval.
 */
export async function readRequiredToolNames(
  userId: string,
  skillIds: readonly string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (skillIds.length === 0) return out;
  const edges = await db
    .select({ skillId: links.fromId, name: tools.name })
    .from(links)
    // `links.to_id` is text, `tools.id` a uuid.
    .innerJoin(tools, drizzleSql`${tools.id}::text = ${links.toId}`)
    .where(
      and(
        eq(links.fromType, "skill"),
        eq(links.toType, "tool"),
        eq(links.linkType, "requires"),
        inArray(links.fromId, [...skillIds]),
        userVisibleWhere(tools.workspaceId, userId)
      )
    );
  for (const e of edges) {
    out.set(e.skillId, [...(out.get(e.skillId) ?? []), e.name]);
  }
  return out;
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

const PROVIDER_CALL = /\bcallProvider\s*\(/g;
const LITERAL_PROVIDER_CALL =
  /\bcallProvider\s*\(\s*(["'`])([A-Za-z0-9_.:-]+)\1/g;

/**
 * The connections a code skill's source calls through `callProvider`. A call
 * whose provider is written out names it; any other call (a provider held in
 * a variable or built at run time) is counted as unread, never dropped.
 */
export function codeProviderCalls(code: unknown): {
  providers: string[];
  unread: number;
} {
  const source = typeof code === "string" ? code : "";
  const calls = source.match(PROVIDER_CALL)?.length ?? 0;
  const providers = [...source.matchAll(LITERAL_PROVIDER_CALL)].map(
    (m) => m[2]!
  );
  return { providers, unread: calls - providers.length };
}

/**
 * Where a skill reaches, by kind. Null for an instruction: it runs nothing,
 * so it has no reach to draw.
 */
export function skillReach(row: SkillReachRow): ProposalPartReach | null {
  switch (row.kind) {
    case "instruction":
      return null;
    case "builtin":
      return { hosts: [], connections: [], unreadSteps: 0 };
    case "declarative": {
      const spec = bag(row.providerSpec);
      const tool = str(spec?.tool);
      const host = literalHost(spec?.baseUrlOverride);
      return {
        hosts: host ? [host] : [],
        connections: tool ? [resolveServiceName(tool)] : [],
        unreadSteps: 0,
      };
    }
    default: {
      // A code skill (the column's default kind): its egress allowlist, as
      // written — the sandbox matches it exactly — and the connections its
      // code calls through the pod.
      const allowed = bag(row.metadata)?.allowedHosts;
      const calls = codeProviderCalls(row.code);
      return {
        hosts: Array.isArray(allowed)
          ? allowed.flatMap((h) => {
              const host = str(h);
              return host ? [host] : [];
            })
          : [],
        connections: [
          ...new Set(
            [...(row.requiredTools ?? []), ...calls.providers].map((p) =>
              resolveServiceName(p)
            )
          ),
        ].sort(),
        unreadSteps: calls.unread > 0 ? 1 : 0,
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
    unreadSteps += reach?.unreadSteps ?? 0;
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
        code: skills.code,
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
    const required = await readRequiredToolNames(
      userId,
      found.map((row) => row.id)
    );
    const byName = new Map<string, SkillReachRow>();
    const byId = new Map<string, SkillReachRow>();
    for (const skillRow of found) {
      const row = { ...skillRow, requiredTools: required.get(skillRow.id) };
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
