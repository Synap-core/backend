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

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  encryptServerSide,
  db,
  and,
  eq,
  or,
  isNull,
  drizzleSql,
  vaultGrants,
  assertGrantScoped,
} from "@synap/database";
import {
  secrets,
  secretAuditLog,
  capabilityTemplates,
  tools as toolsTable,
  skills as skillsTable,
} from "@synap/database/schema";
import type { ToolVerbCatalogEntry } from "@synap/database/schema";
import type {
  CapabilityDefinition,
  CapabilitySkillDef,
  CapabilityVaultDef,
  ToolVerbKind,
} from "@synap/playbooks";

import { toolsRouter } from "../../routers/tools.js";
import { skillsRouter } from "../../routers/skills.js";
import type { Context } from "../../types/context.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { interpolateDeep } from "../_shared/interpolate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Param interpolation (`{{var}}` scheme) is shared via services/_shared/interpolate.

// ── templateKey → JSON loader ─────────────────────────────────────────────────

/** Candidate roots for the seed-template directory (dev + built + env). */
function templateDirCandidates(): string[] {
  const dirs: string[] = [];
  if (process.env.CAPABILITY_TEMPLATES_DIR) {
    dirs.push(process.env.CAPABILITY_TEMPLATES_DIR);
  }
  // From packages/api/src/services/capabilities → synap-backend/templates/capabilities
  dirs.push(path.resolve(__dirname, "../../../../../templates/capabilities"));
  // Built layout: packages/api/dist/services/capabilities → same backend root.
  dirs.push(path.resolve(__dirname, "../../../../templates/capabilities"));
  // cwd fallbacks (backend root or packages/api).
  dirs.push(path.resolve(process.cwd(), "templates/capabilities"));
  dirs.push(path.resolve(process.cwd(), "../../templates/capabilities"));
  return dirs;
}

/**
 * Load a `CapabilityDefinition` by templateKey — DB-first.
 *
 * Resolution order:
 *   1. DB: a live `capability_templates` row whose key matches and whose scope is
 *      the requested workspace OR pod-wide (`workspace_id IS NULL`). A workspace
 *      overlay wins over the pod-wide row (ORDER BY workspace_id NULLS LAST).
 *   2. File fallback: the on-disk seed JSONs (templateDirCandidates) — kept for
 *      local-dev ergonomics and as the bootstrap before `eve capabilities sync`
 *      has populated the DB. The containment guard is a security control, not a
 *      workaround — it stays.
 *
 * Making this DB-first is what closes the deployed-pod `templateKey` 404: the
 * JSONs are NOT bundled into the @synap/api image, so on a deployed pod only the
 * DB path resolves.
 */
export async function loadCapabilityTemplate(
  templateKey: string,
  opts?: { workspaceId?: string | null }
): Promise<CapabilityDefinition> {
  // 1. DB-first: workspace overlay (if any) wins over the pod-wide row.
  const workspaceId = opts?.workspaceId ?? null;
  const scopePredicate = workspaceId
    ? or(
        eq(capabilityTemplates.workspaceId, workspaceId),
        isNull(capabilityTemplates.workspaceId)
      )
    : isNull(capabilityTemplates.workspaceId);

  const [row] = await db
    .select({ definition: capabilityTemplates.definition })
    .from(capabilityTemplates)
    .where(
      and(
        eq(capabilityTemplates.key, templateKey),
        isNull(capabilityTemplates.deletedAt),
        scopePredicate
      )
    )
    .orderBy(drizzleSql`${capabilityTemplates.workspaceId} ASC NULLS LAST`)
    .limit(1);

  if (row) {
    return row.definition as CapabilityDefinition;
  }

  // 2. File fallback (dev ergonomics / pre-sync bootstrap).
  const fileName = `${templateKey}.capability.json`;
  for (const dir of templateDirCandidates()) {
    const filePath = path.join(dir, fileName);
    // Containment guard: a crafted key (e.g. "../../etc/passwd") must never
    // escape the candidate dir. Resolve both and require the file to live
    // strictly inside the dir.
    if (!path.resolve(filePath).startsWith(path.resolve(dir) + path.sep)) {
      throw new Error("invalid template key");
    }
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as CapabilityDefinition;
    }
  }
  throw new Error(`Capability template not found: ${templateKey}`);
}

// ── Result shape ──────────────────────────────────────────────────────────────

export interface CreateCapabilityResult {
  capabilityKey: string;
  created: {
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
  };
  proposals: string[];
}

// ── The applier ───────────────────────────────────────────────────────────────

/**
 * Apply a `CapabilityDefinition` (or a templateKey-loaded one), instantiating
 * its {vault · tools · skills} for the acting user/workspace in `ctx`.
 */
export async function createCapabilityFromDefinition(
  rawDef: CapabilityDefinition,
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
  const def = interpolateDeep(rawDef, effectiveParams);

  const proposals: string[] = [];

  // 1. Vault secrets — reuse the SAME server-side encryption the
  //    POST /vault/secrets route calls (encryptServerSide + secrets insert +
  //    audit row). Capture each created `vault://<id>` keyed by template-local ref.
  const vaultByRef = new Map<string, string>();
  const createdVault: CreateCapabilityResult["created"]["vault"] = [];
  for (const v of def.vault ?? []) {
    const vaultRef = await createVaultSecret(v, userId, workspaceId ?? null);
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

    // Idempotent: reuse an existing tool with the same name in scope. Re-apply
    // refreshes its credentialRef + verb catalog instead of creating a duplicate.
    const [existingTool] = await db
      .select({ id: toolsTable.id })
      .from(toolsTable)
      .where(
        and(
          eq(toolsTable.name, t.name),
          workspaceId
            ? eq(toolsTable.workspaceId, workspaceId)
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
          credentialRef: credentialRef ?? null,
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
      workspaceId,
    });

    const toolId = result.tool?.id ?? null;
    if (toolId) toolIdByName.set(t.name, toolId);
    if (result.proposalId) proposals.push(result.proposalId);
    // Seed the ENFORCEMENT grant so an APPROVED tool is runnable by agents once
    // the born-draft tool is approved (Wave 2 + 3b: seed(draft) → approve →
    // grant → agent run is governed). Conservative `execMode: "propose"` for a
    // side-effecting tool — an agent run routes to review unless re-granted auto.
    if (result.status === "created" && toolId) {
      await issueCapabilityGrant("tool", toolId, userId, workspaceId ?? null);
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
      .select({ id: skillsTable.id })
      .from(skillsTable)
      .where(
        and(
          eq(skillsTable.name, s.name),
          workspaceId
            ? eq(skillsTable.workspaceId, workspaceId)
            : isNull(skillsTable.workspaceId)
        )
      )
      .limit(1);
    if (existingSkill) {
      await db
        .update(skillsTable)
        .set({ code: s.code, updatedAt: new Date() })
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
      parameters: s.parameters,
      category: s.category,
      executionMode: s.executionMode ?? "sync",
      timeoutSeconds: s.timeoutSeconds ?? 30,
      workspaceId,
    });

    const proposalId =
      "proposalId" in result ? (result.proposalId ?? null) : null;
    if (proposalId) proposals.push(proposalId);

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
        workspaceId ?? null
      );
    }

    createdSkills.push({
      name: s.name,
      status: result.status,
      skillId: result.status === "created" ? result.id : null,
      proposalId,
    });
  }

  return {
    capabilityKey: def.key,
    created: {
      vault: createdVault,
      tools: createdTools,
      skills: createdSkills,
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
