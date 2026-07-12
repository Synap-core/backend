/**
 * Capability-Template Applier — "config descriptor → instantiates a set of
 * {vault secrets · tools · skills}".
 *
 * The capability-layer counterpart to `workspaces.createFromDefinition` (which
 * instantiates {profiles · views} from a JSON PackageDefinition). Given a
 * `CapabilityDefinition` + a `params` map it:
 *   1. interpolates every `{{paramName}}` placeholder (same `{{var}}` scheme the
 *      NotificationService templates use),
 *   2. creates each vault secret — reusing the SAME server-side encryption the
 *      `POST /vault/secrets` Hub-REST route calls — capturing the `vault://<id>`,
 *   3. remaps any tool `credentialRef` that points at a template-local vault
 *      `ref` to the real `vault://<id>`,
 *   4. creates each tool via the GOVERNED `toolsRouter.create` caller,
 *   5. creates each skill via the GOVERNED `skillsRouter.create` caller and wires
 *      its `requires` (resolving template-local tool NAMES → created tool ids)
 *      through the SAME router's `setRequiredTools`.
 *
 * ZERO duplicated insert/business logic for tools & skills — everything flows
 * through the existing governed router callers, so governance
 * (checkPermissionOrPropose), audit, and side-effects are identical to Phase 1.
 * When governance defers a create, the proposal id is surfaced in the result.
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx
 */

import {
  encryptServerSide,
  db,
  and,
  eq,
  isNull,
  vaultGrants,
  assertGrantScoped,
} from "@synap/database";
import {
  secrets,
  secretAuditLog,
  tools as toolsTable,
  skills as skillsTable,
  playbooks as playbooksTable,
  automations as automationsTable,
  capabilities as capabilitiesTable,
} from "@synap/database/schema";
import type { ToolVerbCatalogEntry } from "@synap/database/schema";
import type {
  CapabilityDefinition,
  CapabilitySkillDef,
  CapabilityVaultDef,
  ToolVerbKind,
} from "@synap/playbooks";
import { fetchCPCapabilityTemplate } from "./cp-template-client.js";

import { playbooksRouter } from "../../routers/playbooks.js";
import { automationsRouter } from "../../routers/automations.js";
import { toolsRouter } from "../../routers/tools.js";
import { skillsRouter } from "../../routers/skills.js";
import { capabilityContainersRouter } from "../../routers/capability-containers.js";
import type { Context } from "../../types/context.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { interpolateDeep, interpolateString } from "../_shared/interpolate.js";

// Param interpolation (`{{var}}` scheme) is shared via services/_shared/interpolate.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

/**
 * Deep-merge a template's default `metadata`/`config` UNDER the tool's existing
 * runtime values — existing wins at every leaf, the template only supplies keys the
 * tool does not already have. Preserves operator runtime state (e.g. the Discord
 * bot's `metadata.discord` channel links) across a boot-time template reconcile that
 * would otherwise reset it to the template's empty defaults. Arrays are treated as
 * leaves (existing replaces, never concatenated).
 */
export function mergePreservingExisting(
  template: Record<string, unknown>,
  existing: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...template };
  for (const key of Object.keys(existing)) {
    const ev = existing[key];
    out[key] =
      key in template && isPlainObject(template[key]) && isPlainObject(ev)
        ? mergePreservingExisting(
            template[key] as Record<string, unknown>,
            ev as Record<string, unknown>
          )
        : ev; // existing leaf (incl. arrays / empty-string) wins
  }
  return out;
}

// ── templateKey → definition loader ───────────────────────────────────────────

/**
 * Load a `CapabilityDefinition` by templateKey from the Control Plane catalog —
 * the SINGLE source of truth (GET {CP}/api/marketplace/capabilities). The pod
 * stores NO templates of its own: no table, no files, no bundle. Discovery and
 * definitions both come from the CP, exactly like workspace packages.
 *
 * `_opts` is accepted for call-site compatibility but ignored — there is no
 * pod-local overlay anymore.
 */
export async function loadCapabilityTemplate(
  templateKey: string,
  _opts?: { workspaceId?: string | null }
): Promise<CapabilityDefinition> {
  const cpDef = await fetchCPCapabilityTemplate(templateKey);
  if (cpDef) return cpDef;

  throw new Error(
    `Capability template "${templateKey}" not found in the Control Plane catalog — is the CP reachable + seeded (pnpm seed:capabilities)?`
  );
}

// ── Playbook template shape ───────────────────────────────────────────────────
//
// Mirrors the `playbooks.create` tRPC input (createInputSchema in
// routers/playbooks.ts). A playbook is a session-template seeded alongside the
// {vault · tools · skills} of a capability. Kept local (not on the shared
// @synap/playbooks `CapabilityDefinition` contract) so the applier can accept it
// without a cross-package contract change.
export interface CapabilityPlaybookDef {
  name: string;
  description?: string;
  goalTemplate: string;
  params?: Record<string, unknown>[];
  inputStrategy?: Record<string, unknown>;
  channelSpec?: Record<string, unknown>;
  expectedOutputs?: Record<string, unknown>[];
  /** PlaybookStage[] — first-class stages (stored loosely, validated at the boundary). */
  stages?: Record<string, unknown>[];
  /** { profileSlug, filter? } — which entity type this playbook operates over (Wave 0 subject spine). */
  subjectProfile?: Record<string, unknown>;
  schedule?: unknown;
  executor?: "is-agent" | "external-agent" | "hybrid";
  status?: "draft" | "active" | "paused" | "archived";
}

// Mirrors the `automations.create` tRPC input (routers/automations.ts:164). An
// automation seeded alongside the capability — a WHEN→THEN flow (e.g. a cron
// source-ingest). Stored loosely (the JSON rides the @synap/playbooks
// CapabilityDefinition contract) so the applier can accept it.
export interface CapabilityAutomationDef {
  name: string;
  description?: string;
  triggerType: "event" | "cron" | "webhook" | "manual";
  triggerConfig?: Record<string, unknown>;
  flowDefinition: {
    nodes: Record<string, unknown>[];
    edges: Record<string, unknown>[];
  };
  status?: "draft" | "active" | "paused" | "error";
  metadata?: Record<string, unknown>;
}

/** Definition the applier accepts — the shared contract plus optional playbooks + automations. */
export type CapabilityDefinitionWithPlaybooks = CapabilityDefinition & {
  playbooks?: CapabilityPlaybookDef[];
  automations?: CapabilityAutomationDef[];
};

// ── Result shape ──────────────────────────────────────────────────────────────

export interface CreateCapabilityResult {
  capabilityKey: string;
  created: {
    /** The capability CONTAINER the seeded tools + skills are grouped under. */
    container: {
      id: string;
      name: string;
      status: "created" | "reused";
    } | null;
    vault: { ref: string; vaultRef: string; secretId: string }[];
    tools: {
      name: string;
      status: "created" | "proposed";
      toolId: string | null;
      proposalId: string | null;
    }[];
    skills: {
      name: string;
      status: "created" | "proposed";
      skillId: string | null;
      proposalId: string | null;
    }[];
    playbooks: {
      name: string;
      status: "created" | "reused" | "proposed";
      playbookId: string | null;
      proposalId: string | null;
    }[];
    automations: {
      name: string;
      status: "created" | "reused" | "proposed";
      automationId: string | null;
      proposalId: string | null;
    }[];
  };
  proposals: string[];
}

// ── The applier ───────────────────────────────────────────────────────────────

/**
 * Apply a `CapabilityDefinition` (or a templateKey-loaded one), instantiating
 * its {vault · tools · skills} for the acting user/workspace in `ctx`.
 */
export async function createCapabilityFromDefinition(
  rawDef: CapabilityDefinitionWithPlaybooks,
  params: Record<string, unknown>,
  ctx: Context
): Promise<CreateCapabilityResult> {
  const userId = ctx.userId;
  if (!userId)
    throw new Error("createCapabilityFromDefinition: missing userId");
  const workspaceId = ctx.workspaceId ?? undefined;

  // Interpolate the whole definition up front so every downstream value (vault
  // values, tool config, skill code, names) has params substituted. The
  // template-local `ref` / `requires` handles are plain identifiers (no `{{}}`)
  // and survive interpolation unchanged. The definition's own `name`/`key` are
  // exposed as implicit params so a template can self-reference (e.g. naming a
  // tool "{{name}} API"); explicit params win on collision.
  const effectiveParams: Record<string, unknown> = {
    name: rawDef.name,
    key: rawDef.key,
    ...params,
  };
  // Seed declared defaults so a Hub-direct caller that omits an optional param
  // with a `default` still gets it. Explicit params (already spread above) win.
  for (const p of rawDef.params ?? []) {
    if (p.default !== undefined && !(p.name in params)) {
      effectiveParams[p.name] = p.default;
    }
  }

  // A pod-scoped capability (all its skills are pod-scoped) exposes a POD-WIDE
  // connection: its vault secret, credentialed tool, skills and container must be
  // created with `workspace_id = null`, because every consumer reads pod-wide —
  // the Hub vault list, and the IS→dispatcher tool lookup (which never forwards a
  // workspaceId). Stamping the caller's ACTIVE workspace here is exactly what made
  // a pod capability install as a hidden, unrunnable workspace-scoped one. A
  // genuinely workspace-scoped capability (non-pod skills) keeps the workspace.
  // (Playbooks + automations stay on `workspaceId` — they are workspace-scoped by
  // construction.) Computed up-front (from RAW skills — `scope` is a fixed enum,
  // never a `{{param}}`) so the required-param guard below can look a candidate
  // secret up in the SAME scope createVaultSecret keys it by.
  const skillScopes = (rawDef.skills ?? []).map((s) => s.scope ?? "pod");
  const isPodScoped =
    skillScopes.length > 0 && skillScopes.every((sc) => sc === "pod");
  const connWorkspaceId = isPodScoped ? undefined : workspaceId;

  // Reject a missing REQUIRED param up front. Otherwise `{{param}}` interpolates
  // to "" and we would store a BLANK credential — which then reads as a falsely
  // "connected" connection (the bug that let `cap add` install a keyless cap).
  //
  // EXCEPTION (boot-time RECONCILE): a capability template is re-applied with `{}`
  // params to converge drifted verb specs. A required param exists only to SEED a
  // vault secret the FIRST time; on a re-apply that secret already exists, so the
  // param is not needed again. When the secret this param feeds is already
  // established (same userId + name + scope createVaultSecret keys by), SKIP the
  // param and let the tool/skill upserts proceed. A genuinely fresh install (the
  // secret does not exist yet) still throws exactly as before.
  for (const p of rawDef.params ?? []) {
    const required = (p as { required?: boolean }).required;
    if (required && effectiveParams[p.name] === undefined) {
      const established = await requiredParamSecretsExist(
        p.name,
        rawDef,
        effectiveParams,
        userId,
        connWorkspaceId
      );
      if (established) continue;
      throw new Error(
        `Capability "${rawDef.key}" requires parameter "${p.name}" — pass it in \`params\`.`
      );
    }
  }

  const def = interpolateDeep(rawDef, effectiveParams);

  // A skill's `providerSpec` holds RUNTIME `{{param}}` placeholders (maxResults,
  // id, calendarId, …) that `executeProviderVerb` resolves at CALL time from the
  // verb's own arguments — NOT capability-template params. interpolateDeep above
  // would wipe those unknown tokens to "" (e.g. `query.maxResults` → ""), silently
  // breaking every declarative verb. Restore the RAW providerSpec (by index; the
  // interpolation preserves skill order) so runtime placeholders survive apply.
  if (Array.isArray(def.skills) && Array.isArray(rawDef.skills)) {
    def.skills.forEach((s, i) => {
      const raw = rawDef.skills[i]?.providerSpec;
      if (raw !== undefined) {
        (s as { providerSpec?: unknown }).providerSpec = raw;
      }
    });
  }

  const proposals: string[] = [];

  // 1. Vault secrets — reuse the SAME server-side encryption the
  //    POST /vault/secrets route calls (encryptServerSide + secrets insert +
  //    audit row). Capture each created `vault://<id>` keyed by template-local ref.
  const vaultByRef = new Map<string, string>();
  const createdVault: CreateCapabilityResult["created"]["vault"] = [];
  for (const v of def.vault ?? []) {
    const vaultRef = await createVaultSecret(
      v,
      userId,
      connWorkspaceId ?? null
    );
    vaultByRef.set(v.ref, vaultRef.vaultRef);
    createdVault.push({ ref: v.ref, ...vaultRef });
  }

  // 2. Tools — through the GOVERNED toolsRouter caller. Remap a credentialRef
  //    that points at a template-local vault `ref` to the real `vault://<id>`.
  //    Each created tool's structured verb catalog (`tools.capabilities`) is
  //    DERIVED from the definition's skills that `requires` it — the
  //    capability-matrix axis, source-of-truth = this CapabilityDefinition.
  const toolsCaller = toolsRouter.createCaller(ctx as never);
  const toolIdByName = new Map<string, string>();
  const createdTools: CreateCapabilityResult["created"]["tools"] = [];
  for (const t of def.tools) {
    const credentialRef =
      t.credentialRef && vaultByRef.has(t.credentialRef)
        ? vaultByRef.get(t.credentialRef)
        : t.credentialRef;

    // Idempotent: reuse an existing tool in scope. The match key is the tool's
    // STABLE IDENTITY: for a credentialed tool that is `credentialRef` (which
    // carries a pod-wide unique index, mig 0140), NOT the name. This is what lets
    // a template converge with the verb-less provider tool `connect`/syncToolRows
    // already materialized for the same `nango://<provider>` ref — whose name is
    // Nango's integration displayName, which need not equal the template's tool
    // name. Matching by name there would miss, then the create below would throw
    // on the unique index. Tools without a credentialRef (builtin/script) fall
    // back to name-matching. Re-apply refreshes the name + verb catalog.
    const [existingTool] = await db
      .select({
        id: toolsTable.id,
        metadata: toolsTable.metadata,
        config: toolsTable.config,
      })
      .from(toolsTable)
      .where(
        and(
          credentialRef
            ? eq(toolsTable.credentialRef, credentialRef)
            : eq(toolsTable.name, t.name),
          connWorkspaceId
            ? eq(toolsTable.workspaceId, connWorkspaceId)
            : isNull(toolsTable.workspaceId)
        )
      )
      .limit(1);
    if (existingTool) {
      toolIdByName.set(t.name, existingTool.id);
      const verbs = deriveToolVerbs(
        t.name,
        def.skills,
        GRANT_DEFAULT_EXEC_MODE
      );
      await db
        .update(toolsTable)
        .set({
          // Adopt the template's canonical name so skills can address the tool by
          // a known name (the bare provider tool was named by Nango's displayName).
          name: t.name,
          description: t.description,
          credentialRef: credentialRef ?? null,
          // Read-modify-write: the template provides STRUCTURE + defaults, but the
          // tool's config/metadata also hold RUNTIME state written by the operator
          // at runtime (e.g. the Discord bot's `metadata.discord` channel links set
          // via /setup). A blind overwrite here reset that config on every boot-time
          // reconcile after a template drifted — so merge template UNDER existing
          // (existing runtime values win; template only fills NEW keys). Mirrors the
          // container-metadata read-modify-write below.
          config: mergePreservingExisting(
            t.config ?? {},
            (existingTool.config ?? {}) as Record<string, unknown>
          ),
          metadata: mergePreservingExisting(
            t.metadata ?? {},
            (existingTool.metadata ?? {}) as Record<string, unknown>
          ),
          ...(verbs.length > 0 ? { capabilities: verbs } : {}),
          updatedAt: new Date(),
        })
        .where(eq(toolsTable.id, existingTool.id));
      createdTools.push({
        name: t.name,
        status: "created",
        toolId: existingTool.id,
        proposalId: null,
      });
      continue;
    }

    const result = await toolsCaller.create({
      name: t.name,
      kind: t.kind,
      description: t.description,
      inputSchema: t.inputSchema,
      credentialRef,
      executor: t.executor ?? "is-agent",
      config: t.config,
      metadata: t.metadata,
      workspaceId: connWorkspaceId,
    });

    const toolId = result.tool?.id ?? null;
    if (toolId) toolIdByName.set(t.name, toolId);
    if (result.proposalId) proposals.push(result.proposalId);
    // Seed the ENFORCEMENT grant so an APPROVED tool is runnable by agents once
    // the born-draft tool is approved (Wave 2 + 3b: seed(draft) → approve →
    // grant → agent run is governed). Conservative `execMode: "propose"` for a
    // side-effecting tool — an agent run routes to review unless re-granted auto.
    if (result.status === "created" && toolId) {
      await issueCapabilityGrant(
        "tool",
        toolId,
        userId,
        connWorkspaceId ?? null
      );
      // Derive + persist the verb catalog from the skills that require this tool.
      // `govDefault` aligns to the exec-mode `issueCapabilityGrant` just seeded
      // ("propose") so the verb never bypasses the approved+grant model.
      const verbs = deriveToolVerbs(
        t.name,
        def.skills,
        GRANT_DEFAULT_EXEC_MODE
      );
      if (verbs.length > 0) {
        await db
          .update(toolsTable)
          .set({ capabilities: verbs })
          .where(eq(toolsTable.id, toolId));
      }
    }
    createdTools.push({
      name: t.name,
      status: result.status,
      toolId,
      proposalId: result.proposalId,
    });
  }

  // 3. Skills — through the GOVERNED skillsRouter caller. Resolve each `requires`
  //    template-local tool NAME to the created tool id and wire it via the SAME
  //    router's setRequiredTools (which writes `skill → requires → tool` links).
  const skillsCaller = skillsRouter.createCaller(ctx as never);
  const createdSkills: CreateCapabilityResult["created"]["skills"] = [];
  for (const s of def.skills) {
    // Idempotent: reuse an existing skill with the same name in scope, refreshing
    // its code + required-tool links instead of creating a duplicate.
    const [existingSkill] = await db
      .select({
        id: skillsTable.id,
        kind: skillsTable.kind,
        code: skillsTable.code,
        providerSpec: skillsTable.providerSpec,
        body: skillsTable.body,
        approved: skillsTable.approved,
      })
      .from(skillsTable)
      .where(
        and(
          eq(skillsTable.name, s.name),
          connWorkspaceId
            ? eq(skillsTable.workspaceId, connWorkspaceId)
            : isNull(skillsTable.workspaceId)
        )
      )
      .limit(1);
    if (existingSkill) {
      // Reconcile ALL code-owned (definition) fields — not just kind/code/
      // providerSpec — so a verb that gains a parameter or changes its
      // description/scope on re-seed actually projects into the catalog (the
      // catalog read-model derives typed params from skills.parameters; the old
      // shallow update left them stale forever — e.g. channel.resolve's new
      // branchPurpose param). STATE fields (status/errorMessage/metadata) are
      // NOT touched — DB owns those. `approved` is state too, with ONE
      // exception (security review 2026-07-12): when the EXECUTION-DEFINING
      // content actually changes (kind/code/providerSpec), the row is demoted
      // to unapproved — same rule skillsRouter.update enforces. Without it a
      // drifted CP template could swap an approved skill's code while keeping
      // its approval (content-swap-under-approval). Unchanged content (the
      // common reconcile no-op-heal) never demotes.
      const execContentChanged =
        (s.kind ?? "code") !== existingSkill.kind ||
        (s.code ?? null) !== existingSkill.code ||
        JSON.stringify(s.providerSpec ?? null) !==
          JSON.stringify(existingSkill.providerSpec ?? null);
      await db
        .update(skillsTable)
        .set({
          kind: s.kind ?? "code",
          code: s.code ?? null,
          providerSpec: s.providerSpec ?? null,
          description: s.description,
          parameters: s.parameters,
          scope: s.scope ?? "pod",
          category: s.category,
          agentTypes: s.agentTypes,
          executionMode: s.executionMode ?? "sync",
          timeoutSeconds: s.timeoutSeconds ?? 30,
          updatedAt: new Date(),
          ...(execContentChanged && existingSkill.approved
            ? { approved: false }
            : {}),
        })
        .where(eq(skillsTable.id, existingSkill.id));
      if (s.requires && s.requires.length > 0) {
        const toolIds = s.requires
          .map((name) => toolIdByName.get(name))
          .filter((id): id is string => !!id);
        if (toolIds.length > 0) {
          await skillsCaller.setRequiredTools({
            skillId: existingSkill.id,
            toolIds,
          });
        }
      }
      createdSkills.push({
        name: s.name,
        status: "created",
        skillId: existingSkill.id,
        proposalId: null,
      });
      continue;
    }

    const result = await skillsCaller.create({
      name: s.name,
      kind: s.kind ?? "code",
      scope: s.scope ?? "pod",
      agentTypes: s.agentTypes,
      description: s.description,
      code: s.code,
      providerSpec: s.providerSpec as Record<string, unknown> | undefined,
      parameters: s.parameters,
      category: s.category,
      executionMode: s.executionMode ?? "sync",
      timeoutSeconds: s.timeoutSeconds ?? 30,
      workspaceId: connWorkspaceId,
    });

    const proposalId =
      "proposalId" in result ? (result.proposalId ?? null) : null;
    if (proposalId) proposals.push(proposalId);

    // Definition-sourced INSTRUCTION skills land unapproved, unconditionally —
    // matching the tools rows' own semantics in this applier (approved defaults
    // false, explicit enable required). skillsRouter.create's
    // `approved = kind === "instruction"` formula is for the UI door where the
    // author IS the operator; here the content comes from a capability
    // definition (CP template / marketplace / package), and an agent-initiated
    // install is approved via a generic proposal summary the user never reads
    // the instruction text in (security review 2026-07-12 — the same
    // prompt-injection hole insertSkillGoverned closed for the URL/import
    // doors). Trusted system seeds (ensure-synap-core) post-approve explicitly.
    if (result.status === "created" && (s.kind ?? "code") === "instruction") {
      await db
        .update(skillsTable)
        .set({ approved: false })
        .where(eq(skillsTable.id, result.id));
    }

    // Wire required-tool links only when the skill was actually created and the
    // referenced tools resolved to real ids (proposed tools have no id yet).
    if (result.status === "created" && s.requires && s.requires.length > 0) {
      const toolIds = s.requires
        .map((name) => toolIdByName.get(name))
        .filter((id): id is string => !!id);
      if (toolIds.length > 0) {
        await skillsCaller.setRequiredTools({ skillId: result.id, toolIds });
      }
    }

    // Seed the enforcement grant for a created skill (same conservative policy
    // as tools — approved skill runnable by agents, execMode propose by default).
    if (result.status === "created") {
      await issueCapabilityGrant(
        "skill",
        result.id,
        userId,
        connWorkspaceId ?? null
      );
    }

    createdSkills.push({
      name: s.name,
      status: result.status,
      skillId: result.status === "created" ? result.id : null,
      proposalId,
    });
  }

  // 4. Playbooks — session-templates seeded alongside the capability. Idempotent:
  //    reuse an existing playbook with the same name in scope (a no-op reapply, so
  //    a launch never duplicates). When absent, create through the GOVERNED
  //    playbooksRouter.create caller — ZERO duplicated insert / cron / governance
  //    logic (same delegation pattern tools & skills use above). Playbooks are
  //    workspace-scoped: `create` is a workspaceProcedure, so a workspaceId is
  //    required for any playbook item.
  const createdPlaybooks: CreateCapabilityResult["created"]["playbooks"] = [];
  if ((def.playbooks?.length ?? 0) > 0) {
    if (!workspaceId) {
      throw new Error(
        "createCapabilityFromDefinition: playbooks require a workspaceId (playbooks are workspace-scoped)"
      );
    }
    const playbooksCaller = playbooksRouter.createCaller(ctx as never);
    for (const p of def.playbooks ?? []) {
      // Idempotent reuse keyed on the stable natural key: name within scope.
      const [existing] = await db
        .select({ id: playbooksTable.id })
        .from(playbooksTable)
        .where(
          and(
            eq(playbooksTable.name, p.name),
            eq(playbooksTable.workspaceId, workspaceId)
          )
        )
        .limit(1);
      if (existing) {
        createdPlaybooks.push({
          name: p.name,
          status: "reused",
          playbookId: existing.id,
          proposalId: null,
        });
        continue;
      }

      const result = await playbooksCaller.create({
        name: p.name,
        description: p.description,
        goalTemplate: p.goalTemplate,
        params: p.params,
        inputStrategy: p.inputStrategy,
        channelSpec: p.channelSpec,
        expectedOutputs: p.expectedOutputs,
        stages: p.stages,
        subjectProfile: p.subjectProfile,
        schedule: p.schedule,
        executor: p.executor ?? "is-agent",
        status: p.status ?? "draft",
      });

      if (result.proposalId) proposals.push(result.proposalId);
      createdPlaybooks.push({
        name: p.name,
        status: result.status === "proposed" ? "proposed" : "created",
        playbookId: result.playbook?.id ?? null,
        proposalId: result.proposalId,
      });
    }
  }

  // 4b. AUTOMATIONS — WHEN→THEN flows seeded alongside the capability (e.g. a
  //     cron source-ingest). Idempotent on name within scope (matches the
  //     bridge's applyAutomationTemplates idempotency). Routed through the
  //     governed automations.create caller — ZERO duplicated insert logic.
  const createdAutomations: CreateCapabilityResult["created"]["automations"] =
    [];
  if ((def.automations?.length ?? 0) > 0) {
    const automationsCaller = automationsRouter.createCaller(ctx as never);
    for (const a of def.automations ?? []) {
      // Idempotent reuse keyed on the stable natural key: name within scope
      // (workspace-scoped when a workspaceId is present, else pod-wide/NULL).
      const [existing] = await db
        .select({ id: automationsTable.id })
        .from(automationsTable)
        .where(
          and(
            eq(automationsTable.name, a.name),
            workspaceId
              ? eq(automationsTable.workspaceId, workspaceId)
              : isNull(automationsTable.workspaceId)
          )
        )
        .limit(1);
      if (existing) {
        createdAutomations.push({
          name: a.name,
          status: "reused",
          automationId: existing.id,
          proposalId: null,
        });
        continue;
      }

      const created = await automationsCaller.create({
        workspaceId: workspaceId ?? null,
        name: a.name,
        description: a.description,
        triggerType: a.triggerType,
        triggerConfig: a.triggerConfig ?? {},
        flowDefinition: a.flowDefinition,
        status: a.status ?? "draft",
        metadata: a.metadata,
      });
      createdAutomations.push({
        name: a.name,
        status: "created",
        automationId: created?.id ?? null,
        proposalId: null,
      });
    }
  }

  // 5. Capability CONTAINER — group the seeded tools + skills under ONE named
  //    capability (the container model). Idempotent on name within scope; parts
  //    attach as `tool|skill --member_of--> capability` via the GOVERNED container
  //    router (addPart is itself idempotent — re-apply never duplicates a member).
  const containersCaller = capabilityContainersRouter.createCaller(
    ctx as never
  );
  let container: CreateCapabilityResult["created"]["container"] = null;
  const [existingContainer] = await db
    .select({ id: capabilitiesTable.id })
    .from(capabilitiesTable)
    .where(
      and(
        eq(capabilitiesTable.name, def.name),
        connWorkspaceId
          ? eq(capabilitiesTable.workspaceId, connWorkspaceId)
          : isNull(capabilitiesTable.workspaceId)
      )
    )
    .limit(1);
  const containerId = existingContainer
    ? existingContainer.id
    : ((
        await containersCaller.create({
          name: def.name,
          description: def.description,
          workspaceId: connWorkspaceId,
        })
      ).capability?.id ?? null);
  if (containerId) {
    container = {
      id: containerId,
      name: def.name,
      status: existingContainer ? "reused" : "created",
    };

    // W1: stamp TEMPLATE PROVENANCE into the container's `metadata` jsonb — no
    // migration, the column already exists. `templateKey` = `def.key` (a
    // CapabilityDefinition's own identity IS the key `loadCapabilityTemplate`
    // resolves it by). `contentHash` is read off the RAW (pre-interpolation)
    // definition — the CP-injected hash describes the template as served, not a
    // post-`{{param}}`-substitution artifact — and omitted when the definition
    // carries none (inline/hashless apply, e.g. `ensureSynapCoreCapability`'s
    // in-repo definition). Read-modify-write: preserves any other metadata keys,
    // never clobbers. Re-applying (reused container) refreshes both fields, so a
    // legacy container converges to having provenance on its next apply.
    const [containerRow] = await db
      .select({ metadata: capabilitiesTable.metadata })
      .from(capabilitiesTable)
      .where(eq(capabilitiesTable.id, containerId))
      .limit(1);
    const existingMetadata = (containerRow?.metadata ?? {}) as Record<
      string,
      unknown
    >;
    await db
      .update(capabilitiesTable)
      .set({
        metadata: {
          ...existingMetadata,
          templateKey: def.key,
          ...(rawDef.contentHash ? { contentHash: rawDef.contentHash } : {}),
        },
        updatedAt: new Date(),
      })
      .where(eq(capabilitiesTable.id, containerId));

    // Attach every created tool (connections + built-ins) and skill as a member.
    for (const toolId of toolIdByName.values()) {
      await containersCaller.addPart({
        capabilityId: containerId,
        partType: "tool",
        partId: toolId,
      });
    }
    for (const s of createdSkills) {
      if (s.skillId) {
        await containersCaller.addPart({
          capabilityId: containerId,
          partType: "skill",
          partId: s.skillId,
        });
      }
    }

    // W3: the vault IS the connection registry. Stamp the secrets this applier
    // created as THIS capability's connections (`capability_id`), promoting one to
    // the capability's DEFAULT connection. Respect the partial-unique index
    // `idx_secrets_capability_default` (one default per capability): if a default
    // already exists (a prior apply), keep it; otherwise the first created secret
    // becomes default. Idempotent — re-apply preserves the existing default.
    if (createdVault.length > 0) {
      const [existingDefault] = await db
        .select({ id: secrets.id })
        .from(secrets)
        .where(
          and(
            eq(secrets.capabilityId, containerId),
            eq(secrets.isDefault, true),
            isNull(secrets.deletedAt)
          )
        )
        .limit(1);
      const defaultSecretId = existingDefault?.id ?? createdVault[0]!.secretId;
      for (const v of createdVault) {
        await db
          .update(secrets)
          .set({
            capabilityId: containerId,
            isDefault: v.secretId === defaultSecretId,
            updatedAt: new Date(),
          })
          .where(eq(secrets.id, v.secretId));
      }
    }
  }

  return {
    capabilityKey: def.key,
    created: {
      container,
      vault: createdVault,
      tools: createdTools,
      skills: createdSkills,
      playbooks: createdPlaybooks,
      automations: createdAutomations,
    },
    proposals,
  };
}

// ── Verb-catalog derivation (the capability-matrix axis) ──────────────────────
//
// The exec-mode the applier seeds on every tool/skill grant (`issueCapabilityGrant`
// below). The verb catalog's `govDefault` reuses this SAME constant so a verb's
// governance default can never drift from the grant the gate actually enforces.
const GRANT_DEFAULT_EXEC_MODE = "propose" as const;

/**
 * Infer a verb's read/push axis from the skill that backs it. A `code` skill that
 * SENDS/WRITES (its name or description signals a mutation) is an `action` (push);
 * a `read` skill is a pull. Heuristic + conservative default: anything that looks
 * like it mutates is treated as a push (`action`) so it stays behind governance.
 */
function deriveVerbKind(s: CapabilitySkillDef): ToolVerbKind {
  const haystack = `${s.name} ${s.description ?? ""}`.toLowerCase();
  const writeSignals = [
    "send",
    "invite",
    "post",
    "create",
    "write",
    "update",
    "delete",
    "reply",
    "message",
    "email",
    "publish",
    "comment",
    "add",
    "remove",
    "set",
  ];
  const readSignals = [
    "search",
    "list",
    "get",
    "fetch",
    "read",
    "find",
    "lookup",
    "query",
    "pull",
  ];
  if (writeSignals.some((w) => haystack.includes(w))) return "action";
  if (readSignals.some((r) => haystack.includes(r))) return "read";
  // Unknown intent → conservative push so it stays governed.
  return "action";
}

/**
 * Build a tool's structured verb catalog from the definition's skills that
 * `requires` it (by tool NAME). One verb per requiring skill: `id` = skill name
 * (the callable, dispatched via callProvider/the dispatcher), `label` = skill
 * name, `kind` = read/push axis, `argsSchema` = the skill's declared parameters,
 * `govDefault` = the seeded grant exec-mode (passed in, never re-derived here).
 */
function deriveToolVerbs(
  toolName: string,
  skills: CapabilitySkillDef[],
  govDefault: "auto" | "propose" | "dry-run"
): ToolVerbCatalogEntry[] {
  const verbs: ToolVerbCatalogEntry[] = [];
  for (const s of skills) {
    if (!s.requires?.includes(toolName)) continue;
    verbs.push({
      id: s.name,
      label: s.name,
      kind: deriveVerbKind(s),
      argsSchema:
        s.parameters && typeof s.parameters === "object"
          ? s.parameters
          : undefined,
      govDefault,
    });
  }
  return verbs;
}

// ── Capability-grant seeding (Wave 3b applier grant) ──────────────────────────
//
// Issue a `capability_grants` (vault_grants) row for a freshly-created tool/skill
// so that — once the born-draft capability is approved — an agent can RUN it
// under governance. Workspace-scoped when a workspace is present (grantedTo null,
// runnable by any agent in that workspace); otherwise pod-wide, bound to the
// acting user (grantedTo = userId) so the canonical wildcard firewall
// (`assertGrantScoped`: never both null) is satisfied. `execMode: "propose"` is
// the conservative default for a side-effecting tool/skill — the capability
// runs through review unless an explicit auto grant is later issued.
async function issueCapabilityGrant(
  grantableType: "tool" | "skill",
  grantableId: string,
  userId: string,
  workspaceId: string | null
): Promise<void> {
  // Workspace grant → grantedTo null (any agent in the ws); pod-wide → bind to
  // the owner so the grant is never fully-wildcard.
  const grantedTo = workspaceId ? null : userId;
  assertGrantScoped({ grantedTo, workspaceId });
  await db.insert(vaultGrants).values({
    grantableType,
    grantableId,
    execMode: GRANT_DEFAULT_EXEC_MODE,
    grantedTo,
    workspaceId,
    // `permanent` (not `session`): a seeded capability grant persists beyond any
    // single focus-session window — the scope enum is once|session|permanent.
    scope: "permanent",
    createdBy: userId,
  });
}

// ── Re-apply guard helper — is a required param's secret already established? ──
//
// A credentialed template declares a `required` param whose ONLY job is to feed a
// vault secret's `value` (`value: "{{apiKey}}"`) the first time it is installed. On
// a boot-time RECONCILE the template is re-applied with `{}` params to converge
// drifted verb specs — the param is absent, but the secret it feeds already exists,
// so re-establishing it is neither needed nor possible. This returns TRUE when every
// vault secret this param feeds already exists in the target scope (guard skips it),
// and FALSE when the param feeds no secret OR any fed secret is missing (guard throws
// — preserving fresh-install behaviour exactly). Existence is checked the SAME way
// createVaultSecret keys a secret: userId + name + scope + not-deleted.
async function requiredParamSecretsExist(
  paramName: string,
  rawDef: CapabilityDefinitionWithPlaybooks,
  effectiveParams: Record<string, unknown>,
  userId: string,
  workspaceId: string | undefined
): Promise<boolean> {
  const token = `{{${paramName}}}`;
  // The vault defs whose (raw, pre-interpolation) value is fed by THIS param.
  const fed = (rawDef.vault ?? []).filter(
    (v) => typeof v.value === "string" && v.value.includes(token)
  );
  // Param feeds no vault secret → its target isn't cleanly determinable → throw.
  if (fed.length === 0) return false;
  for (const v of fed) {
    // A secret's stored `name` may carry OTHER (present) params — interpolate it
    // with what we have; the missing required param never appears in a name.
    const name = interpolateString(v.name, effectiveParams);
    const [existing] = await db
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.userId, userId),
          eq(secrets.name, name),
          workspaceId
            ? eq(secrets.workspaceId, workspaceId)
            : isNull(secrets.workspaceId),
          isNull(secrets.deletedAt)
        )
      )
      .limit(1);
    // A fed secret is missing → genuine fresh install → let the guard throw.
    if (!existing) return false;
  }
  return true;
}

// ── Vault helper — mirrors POST /vault/secrets server-encryption path ─────────

async function createVaultSecret(
  v: CapabilityVaultDef,
  userId: string,
  workspaceId: string | null
): Promise<{ vaultRef: string; secretId: string }> {
  // Governance: gate the vault write on the TARGET workspaceId (never a
  // request-supplied one — here it is the same id the row is written with).
  // For a pod-wide secret (workspaceId null) the acting user is the owner, so
  // pass ownerId:userId to satisfy the pod-wide owner branch.
  await assertWorkspaceWrite(db, userId, { workspaceId, ownerId: userId });

  const blob = encryptServerSide(v.value);

  // Idempotent: reuse an existing secret with the same name in scope, updating
  // its encrypted value (re-apply rotates the credential instead of duplicating).
  const [existing] = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.userId, userId),
        eq(secrets.name, v.name),
        workspaceId
          ? eq(secrets.workspaceId, workspaceId)
          : isNull(secrets.workspaceId),
        isNull(secrets.deletedAt)
      )
    )
    .limit(1);
  if (existing) {
    // BUG-2 guard: NEVER overwrite a live credential with a blank value. A re-apply
    // that couldn't interpolate this secret's param yields `value === ""`; writing
    // it would encrypt-and-store an empty string, WIPING the real credential. When
    // the interpolated value is empty/blank AND a secret already exists, keep the
    // existing credential untouched. (Bug-1's guard already prevents the common
    // path; this is the defensive floor.)
    if (typeof v.value !== "string" || v.value.trim() === "") {
      return { vaultRef: `vault://${existing.id}`, secretId: existing.id };
    }
    await db
      .update(secrets)
      .set({
        type: v.type ?? "api_key",
        description: v.description ?? null,
        serviceId: v.service ?? null,
        encryptedData: blob.encryptedData,
        iv: blob.iv,
        authTag: blob.authTag,
        encryptionVersion: 1,
        encryptionMode: "server",
        updatedAt: new Date(),
      })
      .where(eq(secrets.id, existing.id));
    return { vaultRef: `vault://${existing.id}`, secretId: existing.id };
  }

  const [secret] = await db
    .insert(secrets)
    .values({
      userId,
      workspaceId,
      name: v.name,
      type: v.type ?? "api_key",
      url: null,
      description: v.description ?? null,
      serviceId: v.service ?? null,
      encryptedData: blob.encryptedData,
      iv: blob.iv,
      authTag: blob.authTag,
      encryptionVersion: 1,
      encryptionMode: "server",
    })
    .returning();

  await db.insert(secretAuditLog).values({
    secretId: secret.id,
    userId,
    action: "created",
    metadata: { via: "capability-template", service: v.service ?? null },
  });

  return { vaultRef: `vault://${secret.id}`, secretId: secret.id };
}
