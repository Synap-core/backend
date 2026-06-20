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

import { encryptServerSide, db } from "@synap/database";
import { secrets, secretAuditLog } from "@synap/database/schema";
import type {
  CapabilityDefinition,
  CapabilityVaultDef,
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

/** Load a `CapabilityDefinition` by templateKey from the seed-template dir. */
export function loadCapabilityTemplate(
  templateKey: string
): CapabilityDefinition {
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
  const toolsCaller = toolsRouter.createCaller(ctx as never);
  const toolIdByName = new Map<string, string>();
  const createdTools: CreateCapabilityResult["created"]["tools"] = [];
  for (const t of def.tools) {
    const credentialRef =
      t.credentialRef && vaultByRef.has(t.credentialRef)
        ? vaultByRef.get(t.credentialRef)
        : t.credentialRef;

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
