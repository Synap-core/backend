/**
 * ROLES — named, reusable grants: `{ id, name, description, grant }`. The
 * built-in ones are GRANT_PRESETS; a person's own are stored (`grantRoles.*`,
 * `stored: true`). Every picker reads both through the same `GrantRole` type,
 * so a preset and a stored role render, apply and mint the same way.
 *
 * A preset carries PERMISSIONS (and, if it says so, narrowing). Applying one
 * keeps the draft's own lifetime and narrowing unless the preset sets them —
 * choosing "Read-only site" must not silently undo "only the Brand space".
 */

import {
  EMPTY_GRANT_DRAFT,
  normalizeGrantPermissions,
  toGrantMintInput,
  type GrantDraft,
  type GrantMintInput,
} from "./draft.js";
import { parsePermission } from "./grammar.js";

/**
 * "AI — read & propose" — the limits every NEW AI agent starts with (founder
 * Option A, 2026-10-11): read everything, create and change anything, never
 * delete, never approve, no secret reads (it may store one it holds), keys,
 * space administration or governance.
 * Its writes still follow the review rules (ask first by default).
 *
 * Built from two subject lists, each pinned to its real source by the api
 * tripwire `__tripwires__/ai-preset.tripwire.test.ts` — this package cannot
 * import them (types → database → governance-policy → types is a build cycle):
 *  - READS: every subject the access layer's read hook knows
 *    (`api/src/access/grant-read.ts` GRANT_READ_SPECS), minus AI_PRESET_EXCLUSIONS.
 *  - WRITES: create/update on every subject a governed write door
 *    (`governance-policy` GATE_WRITE_DOORS) creates or updates, minus the
 *    exclusions. A new door or read subject fails the tripwire until it is
 *    added here or excluded with its reason.
 *
 *  - VERBS: the non-destructive gate verbs an agent uses daily (AI_GATE_VERBS),
 *    each named — a bare subject never covers one.
 *
 * Never delete, archive, merge, purge or approve: a bare subject would cover
 * delete, so every pattern names its verb. Subjects are in the grammar's
 * spelling (`session`, `relation_def`, `view.update_content`); every refusing
 * layer folds a door name to it through governance-policy `grantRequestKey`.
 */
export const AI_READ_SUBJECTS = [
  "agent",
  "artifact",
  "automation",
  "cell",
  "channel",
  "command",
  "document",
  "entity",
  "event",
  "facet",
  "feed",
  "inbox",
  "link",
  "messaging",
  "notification",
  "playbook",
  "preference",
  "project",
  "proposal",
  "relation",
  "relation_def",
  "renderer",
  "role",
  "session",
  "share",
  "source",
  "tool",
  "track",
  "view",
  "widget",
] as const;

/** Subject → the create/update verbs an AI holds on it by default. */
export const AI_WRITE_SUBJECTS: Readonly<
  Record<string, readonly ("create" | "update")[]>
> = {
  artifact: ["create"],
  automation: ["create", "update"],
  capability: ["create"],
  cell: ["create", "update"],
  document: ["create", "update"],
  entity: ["create", "update"],
  facet: ["update"],
  link: ["create"],
  playbook: ["create", "update"],
  playbook_run: ["update"],
  profile: ["create"],
  project: ["create", "update"],
  property_def: ["create", "update"],
  relation: ["create", "update"],
  relation_def: ["create"],
  // Store a credential the agent already holds (`POST /vault/secrets`, S4
  // 2026-10-20). Never `vault.read`: it never reads one back.
  secret: ["create"],
  session: ["create", "update"],
  skill: ["create", "update"],
  track: ["create", "update"],
  view: ["create", "update"],
};

/**
 * The gate verbs (not read/create/update/delete) an AI holds by default —
 * "change anything" (founder Option A) minus every destructive, approving,
 * access-widening or administrative verb, which AI_PRESET_EXCLUSIONS names.
 * Rejecting a proposal is in (an agent withdraws or discards its own work);
 * approving never is.
 */
export const AI_GATE_VERBS: readonly string[] = [
  "a2ai.join",
  "artifact.set_state",
  "bento.arrange",
  "capability.attach",
  "capability.renderer_set",
  "cell.define",
  "channel.create_branch",
  "context.link",
  "document.section_update",
  "document.session_narrative_update",
  "entity.*.renderer_set",
  // A lifecycle status move (the moveStatus door): reversible, and the door
  // floors done/lost and humanOnly options on its own.
  "entity.*.transition",
  "facet.attach",
  "facet.detach",
  // Propose how to organise the person's Library (always a proposal).
  "library.organize",
  "playbook.promote",
  "playbook.run",
  "proactive.recap",
  "profile.renderer_set",
  "project.file_entities",
  "project.instantiate_from_playbook",
  "project.spawn_from_session",
  "proposal.reject",
  "view.update_content",
  "whiteboard.place",
  "widget.register",
];

/**
 * What the AI preset leaves out on purpose, keyed `<subject>.<action>` as the
 * read hook / write door names it. The tripwire refuses an entry that names
 * nothing real, and checks each one is refused.
 */
export const AI_PRESET_EXCLUSIONS: Readonly<Record<string, string>> = {
  "vault.read":
    "Secrets: an AI reads a secret only through an explicit vault grant.",
  "vault.grant": "Secrets: widens who may use a secret.",
  "api_key.read": "Credentials.",
  "api_key.create": "Credentials: an AI never mints keys.",
  "api_key.update": "Credentials.",
  "ai_provider.create":
    "Sets where prompts are sent: a credential-shaped write.",
  "ai_provider.update":
    "Sets where prompts are sent: a credential-shaped write.",
  "agent.update_capabilities":
    "Governance: an AI never widens an agent's limits.",
  "app.connect": "Access: what an app may reach is a person's approval.",
  "session.grant_capability": "Access: widens what a session's agent may do.",
  "profile.grant_access": "Access: shares a kind with another space.",
  "profile.change_scope":
    "Access: changes which spaces see a kind and its records.",
  "relation.expose": "Access: widens who may see a record.",
  "share.create": "Sharing exposes a record to guests: an access decision.",
  "project_member.create":
    "Membership: widens who may read across a project's spaces.",
  "workspace_member.add": "Membership.",
  "workspace_member.remove": "Membership.",
  "workspace_member.update_role": "Membership.",
  "channel.merge_branch":
    "A merge: folds a branch's work back into its thread.",
  "channel.bind": "Connects the pod to an outside service.",
  "channel.unbind": "Disconnects the pod from an outside service.",
  "channel.create_external": "Connects the pod to an outside service.",
  "workspace.create": "Space administration.",
  "workspace.update": "Space administration.",
  "workspace.adopt": "Space administration.",
  "workspace.restore": "Space administration.",
  "workspace.declare_source": "Space administration.",
  "workspace.configure_public_projection":
    "Space administration: publishes a space.",
  "role.create": "Role definitions are the permission table itself.",
  "role.update": "Role definitions are the permission table itself.",
  "rule.create": "Governance: a rule decides what agents may do unasked.",
  "rule.update": "Governance: a rule decides what agents may do unasked.",
  "automation.activate":
    "Authority: an active automation runs later with the person's authority, unreviewed. Drafts are created disabled.",
  "automation.execute":
    "Authority: running a flow acts with the person's authority, beyond this agent's own limits.",
  "command.execute":
    "Authority: a command runs a stored flow with the person's authority.",
  "tool.create":
    "Authority: a tool is code other flows run with the person's authority.",
  "tool.update":
    "Authority: a tool is code other flows run with the person's authority.",
};

const AI_READ_PROPOSE_PERMISSIONS: readonly string[] =
  normalizeGrantPermissions([
    ...AI_READ_SUBJECTS.map((s) => `${s}.read`),
    ...Object.entries(AI_WRITE_SUBJECTS).flatMap(([s, actions]) =>
      actions.map((a) => `${s}.${a}`)
    ),
    ...AI_GATE_VERBS,
  ]);

/** The preset id every surface and test names the AI default by. */
export const AI_READ_PROPOSE_ROLE_ID = "agent-read-propose";

export interface GrantRole {
  /** Stable id (a preset slug, or a stored role's uuid). */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly grant: GrantDraft;
  /** True for a role the person saved (`grantRoles.*`); absent for a preset. */
  readonly stored?: boolean;
}

export const GRANT_PRESETS: readonly GrantRole[] = [
  {
    id: "read-only-site",
    name: "Read-only site",
    description: "Reads your records, documents and views. Changes nothing.",
    grant: { permissions: ["entity.*.read", "document.read", "view.read"] },
  },
  {
    id: AI_READ_PROPOSE_ROLE_ID,
    name: "AI — read & propose",
    description:
      "Reads everything and creates or changes records, documents, sessions, links, views and kinds; runs playbooks and may reject a proposal. May store a credential it already holds, never read one. Never deletes, never approves, and has no keys, sharing or space settings. Its writes still follow your review rules.",
    grant: { permissions: AI_READ_PROPOSE_PERMISSIONS },
  },
  {
    id: "full-access",
    name: "Full access",
    description:
      "Everything you can do yourself, approving and deleting included. Still bounded by your own access.",
    grant: { permissions: ["*"] },
  },
];

/** Apply a role: its permissions, plus any narrowing/lifetime it sets itself. */
export function applyGrantRole(draft: GrantDraft, role: GrantRole): GrantDraft {
  const next: { -readonly [K in keyof GrantDraft]: GrantDraft[K] } = {
    ...draft,
    permissions: normalizeGrantPermissions(role.grant.permissions),
  };
  if (role.grant.workspaceIds !== undefined)
    next.workspaceIds = role.grant.workspaceIds;
  if (role.grant.projectIds !== undefined)
    next.projectIds = role.grant.projectIds;
  if (role.grant.entityIds !== undefined) next.entityIds = role.grant.entityIds;
  if (role.grant.expiresInDays !== undefined)
    next.expiresInDays = role.grant.expiresInDays;
  return next;
}

/**
 * The stored role a mint should record as its lineage (`grant.roleId`): the
 * person's own role whose permissions the draft still equals. A preset, or a
 * draft edited away from every role, records none.
 */
export function grantRoleLineage(
  draft: GrantDraft,
  roles: readonly GrantRole[]
): string | undefined {
  const role = matchGrantRole(draft, roles);
  return role?.stored ? role.id : undefined;
}

/** The role whose permissions equal the draft's (by value), if any. */
export function matchGrantRole(
  draft: GrantDraft,
  roles: readonly GrantRole[] = GRANT_PRESETS
): GrantRole | undefined {
  const mine = normalizeGrantPermissions(draft.permissions);
  return roles.find((r) => {
    const theirs = normalizeGrantPermissions(r.grant.permissions);
    return (
      theirs.length === mine.length && theirs.every((p, i) => p === mine[i])
    );
  });
}

/** The `grantRoles.create` / `.update` input (`id` added for an update). */
export interface GrantRoleInput {
  name: string;
  description?: string;
  grant: Omit<GrantMintInput["grant"], "label" | "roleId"> & {
    /** Omitted → the role sets no lifetime; a number → days; null → never. */
    expiresInDays?: number | null;
  };
}

/**
 * A draft saved as a role: its permissions, narrowing and lifetime choice —
 * the same projection a mint of it gets (`toGrantMintInput`), minus the
 * per-key label and lineage.
 */
export function toGrantRoleInput(
  name: string,
  description: string,
  draft: GrantDraft
): GrantRoleInput {
  const { grant, expiresInDays } = toGrantMintInput(draft);
  const { label: _label, ...rest } = grant;
  return {
    name: name.trim(),
    ...(description.trim() ? { description: description.trim() } : {}),
    grant: {
      ...rest,
      ...(expiresInDays !== undefined ? { expiresInDays } : {}),
    },
  };
}

/**
 * The full mint input for a key made from a role, as-is: its permissions AND
 * its narrowing and lifetime, plus `roleId` lineage for the person's own
 * stored role (never for a preset).
 */
export function grantMintFromRole(role: GrantRole): GrantMintInput {
  const input = toGrantMintInput(applyGrantRole(EMPTY_GRANT_DRAFT, role));
  if (role.stored) input.grant.roleId = role.id;
  return input;
}

/** What a NEW AI agent's `users.agent_metadata.capabilities` holds: the AI preset. */
export function aiDefaultCapabilities(): string[] {
  return [...AI_READ_PROPOSE_PERMISSIONS];
}

/**
 * The grant an AGENT's key carries, from the agent's one limit — its stored
 * capabilities (`users.agent_metadata.capabilities`):
 *  - `[]`, `*` or the legacy `*.*` → `["*"]`: full access, as before;
 *  - otherwise the patterns that parse, plus a read of every AI read subject —
 *    an agent reads what its person reads (AGENT_ALWAYS_ALLOWED), so its
 *    capabilities never bound reads and its key must not either.
 * A pattern that does not parse is left out (`dropped`) — the key is narrower
 * than the stored list, never wider.
 */
export function agentKeyGrantPermissions(
  capabilities: readonly string[] | null | undefined
): { permissions: string[]; dropped: string[] } {
  const caps = (capabilities ?? []).map((c) => c.trim()).filter(Boolean);
  if (caps.length === 0 || caps.includes("*") || caps.includes("*.*"))
    return { permissions: ["*"], dropped: [] };
  const valid: string[] = [];
  const dropped: string[] = [];
  for (const c of caps) {
    try {
      parsePermission(c);
      valid.push(c);
    } catch {
      dropped.push(c);
    }
  }
  return {
    permissions: normalizeGrantPermissions([
      ...AI_READ_SUBJECTS.map((s) => `${s}.read`),
      ...valid,
    ]),
    dropped,
  };
}
