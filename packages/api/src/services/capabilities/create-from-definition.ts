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
  drizzleSql,
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
  mcpServers as mcpServersTable,
} from "@synap/database/schema";
import type { ToolVerbCatalogEntry } from "@synap/database/schema";
import { ABSTRACT_VERBS, isAbstractVerb } from "@synap/database/schema";
import { invalidateMcpCache } from "../../routers/channels.js";
import type {
  CapabilityDefinition,
  CapabilitySkillDef,
  CapabilityVaultDef,
  ToolVerbKind,
} from "@synap/playbooks";
import type { PlaybookStageInput } from "../../schemas/playbook-stage.js";
import { fetchCPCapabilityTemplate } from "./cp-template-client.js";
import { mergeVerbCatalog } from "./verb-catalog.js";

import { createLogger } from "@synap-core/core";
// Validate DECLARED emit patterns before persisting them to `metadata.emits` —
// the SAME grammar the honest-menu "catalog"/"declared" tiers use. Sub-path
// import for the same tsup code-splitting reason routers/automations.ts cites.
import { validateEventPattern } from "@synap-core/types/events/unified";
import { playbooksRouter } from "../../routers/playbooks.js";
import { automationsRouter } from "../../routers/automations.js";
import { toolsRouter } from "../../routers/tools.js";
import {
  skillsRouter,
  assertSkillGlobalsAllowed,
} from "../../routers/skills.js";
import { capabilityContainersRouter } from "../../routers/capability-containers.js";
import type { Context } from "../../types/context.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { interpolateDeep, interpolateString } from "../_shared/interpolate.js";

const logger = createLogger({ module: "create-capability-from-definition" });

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
 * Normalize a definition's declared `emits` into the validated, deduped pattern
 * list stored on `capabilities.metadata.emits`. Each entry is checked with
 * `validateEventPattern`; a non-string or validator-illegal entry is silently
 * dropped so a phantom pattern is NEVER persisted (it would surface a fake
 * option in the honest WHEN menu). Returns `undefined` when the definition
 * declares no `emits` at all — so the applier leaves any existing declaration
 * untouched, and a boot backfill can tell "never declared" apart from
 * "explicitly declares nothing" (`[]`).
 */
export function sanitizeEmitPatterns(
  raw: string[] | undefined
): string[] | undefined {
  if (raw === undefined) return undefined;
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== "string") continue;
    try {
      out.push(validateEventPattern(p));
    } catch {
      // Drop the phantom — never store an option the matcher can't fire.
    }
  }
  return [...new Set(out)];
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
  /**
   * PlaybookStage[] — validated by the ONE runtime schema (`playbookStagesSchema`)
   * at the Hub REST door and again by `playbooks.create`. `category` is required.
   */
  stages?: PlaybookStageInput[];
  /** { profileSlug, filter? } — which entity type this playbook operates over (Wave 0 subject spine). */
  subjectProfile?: Record<string, unknown>;
  schedule?: unknown;
  /** Free-form playbook metadata → `playbooks.metadata` (e.g. propose-only governance marker). */
  metadata?: Record<string, unknown>;
  executor?: "is-agent" | "external-agent" | "hybrid";
  status?: "draft" | "active" | "paused" | "archived";
  /**
   * What this template instantiates (0240): `session` (a template of ONE focus
   * session — today's default) or `project` (a blueprint for a long-running
   * container whose ordered `stages` coordinate rather than execute). Omitted
   * reads as `session` at `playbooks.create`, so absence is a no-op.
   *
   * Without this a package could never SHIP a project template: every playbook
   * a capability seeded was forced session-scoped regardless of what it authored.
   */
  scope?: "session" | "project";
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
  /** Per-automation persistent config/state — resolves `{{automation.state.*}}`
   * (e.g. the grant-provision automation's clientsFolderId/grantTemplateFileId).
   * `automations.create` accepts it (routers/automations.ts:188); without this
   * the prefill is dropped when a capability seeds its automations. */
  state?: Record<string, unknown>;
}

/**
 * An MCP server the capability registers so agents get live tools and
 * `mcp://<slug>` tools can resolve. Idempotent on (workspaceId, slug).
 * Installing a trusted package may set `approved: true` (the install IS the
 * trust decision); default is false (owner must approve under Settings).
 */
export interface CapabilityMcpServerDef {
  slug: string;
  name: string;
  description?: string;
  transport: "http" | "stdio";
  /** Required when transport is "http". */
  url?: string;
  /** Required when transport is "stdio". */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  /** Default false — supply-chain gate. Trusted public MCP packs may set true. */
  approved?: boolean;
  metadata?: Record<string, unknown>;
}

/** Definition the applier accepts — the shared contract plus optional playbooks + automations + MCP servers. */
export type CapabilityDefinitionWithPlaybooks = CapabilityDefinition & {
  playbooks?: CapabilityPlaybookDef[];
  automations?: CapabilityAutomationDef[];
  /** Register MCP server rows (live agent tools + mcp:// credential resolution). */
  mcpServers?: CapabilityMcpServerDef[];
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
      /**
       * Parts the installer seeded but could NOT attach to the container —
       * `addPart` refused (a pod-scoped container owned by someone else, and the
       * installer is not a pod admin). Reported, never swallowed: the tools and
       * skills are already written by this point, so throwing would abort a
       * half-finished install with no rollback, and a silent catch would claim a
       * complete install that is missing its membership edges.
       */
      partsNotAttached: number;
    } | null;
    vault: { ref: string; vaultRef: string; secretId: string }[];
    mcpServers: {
      slug: string;
      status: "created" | "reused";
      serverId: string | null;
    }[];
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
      status: "created" | "reused" | "proposed" | "error";
      playbookId: string | null;
      proposalId: string | null;
      message?: string;
    }[];
    automations: {
      name: string;
      status: "created" | "reused" | "proposed" | "error";
      automationId: string | null;
      proposalId: string | null;
      message?: string;
    }[];
  };
  proposals: string[];
}

// ── The applier ───────────────────────────────────────────────────────────────

/**
 * Stamp `metadata.sourceCapability = <templateKey>` on a seeded playbook or
 * automation — the back-pointer mirror of the `member_of` link and of the
 * mcpServers stamp. Read-modify-write so other metadata keys survive; non-fatal
 * (a stamp failure must never abort the apply). Two typed branches rather than a
 * union-typed drizzle table (whose `.set()` param does not narrow cleanly).
 */
async function stampSourceCapability(
  table: typeof playbooksTable | typeof automationsTable,
  id: string,
  capabilityKey: string
): Promise<void> {
  try {
    if (table === playbooksTable) {
      const [row] = await db
        .select({ metadata: playbooksTable.metadata })
        .from(playbooksTable)
        .where(eq(playbooksTable.id, id))
        .limit(1);
      const existing = (row?.metadata ?? {}) as Record<string, unknown>;
      await db
        .update(playbooksTable)
        .set({
          metadata: { ...existing, sourceCapability: capabilityKey },
          updatedAt: new Date(),
        })
        .where(eq(playbooksTable.id, id));
    } else {
      const [row] = await db
        .select({ metadata: automationsTable.metadata })
        .from(automationsTable)
        .where(eq(automationsTable.id, id))
        .limit(1);
      const existing = (row?.metadata ?? {}) as Record<string, unknown>;
      await db
        .update(automationsTable)
        .set({
          metadata: { ...existing, sourceCapability: capabilityKey },
          updatedAt: new Date(),
        })
        .where(eq(automationsTable.id, id));
    }
  } catch (err) {
    logger.warn(
      { err, id, capabilityKey },
      "createFromDefinition: sourceCapability stamp failed (non-fatal)"
    );
  }
}

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

  // 1b. MCP servers — register before tools so `mcp://<slug>` credentialRefs
  //     resolve. Idempotent on (workspace scope, slug). Scope mirrors tools:
  //     pod-scoped capability → null workspaceId; else active workspace.
  const createdMcpServers: CreateCapabilityResult["created"]["mcpServers"] = [];
  const mcpDefs = (def as CapabilityDefinitionWithPlaybooks).mcpServers ?? [];
  for (const m of mcpDefs) {
    if (m.transport === "http" && !m.url) {
      throw new Error(
        `Capability "${def.key}" mcpServers["${m.slug}"] transport=http requires url`
      );
    }
    if (m.transport === "stdio" && !m.command) {
      throw new Error(
        `Capability "${def.key}" mcpServers["${m.slug}"] transport=stdio requires command`
      );
    }
    const [existingMcp] = await db
      .select({ id: mcpServersTable.id })
      .from(mcpServersTable)
      .where(
        and(
          eq(mcpServersTable.slug, m.slug),
          connWorkspaceId
            ? eq(mcpServersTable.workspaceId, connWorkspaceId)
            : isNull(mcpServersTable.workspaceId)
        )
      )
      .limit(1);

    if (existingMcp) {
      await db
        .update(mcpServersTable)
        .set({
          name: m.name,
          description: m.description ?? null,
          transport: m.transport,
          command: m.command ?? null,
          args: m.args ?? [],
          url: m.url ?? null,
          env: m.env ?? {},
          enabled: m.enabled !== false,
          // Only promote approval (never silently demote on re-apply).
          ...(m.approved === true ? { approved: true } : {}),
          metadata: {
            ...((m.metadata as Record<string, unknown>) ?? {}),
            sourceCapability: def.key,
          },
          updatedAt: new Date(),
        })
        .where(eq(mcpServersTable.id, existingMcp.id));
      createdMcpServers.push({
        slug: m.slug,
        status: "reused",
        serverId: existingMcp.id,
      });
    } else {
      const [row] = await db
        .insert(mcpServersTable)
        .values({
          workspaceId: connWorkspaceId ?? null,
          slug: m.slug,
          name: m.name,
          description: m.description ?? null,
          transport: m.transport,
          command: m.command ?? null,
          args: m.args ?? [],
          url: m.url ?? null,
          env: m.env ?? {},
          enabled: m.enabled !== false,
          approved: m.approved === true,
          metadata: {
            ...((m.metadata as Record<string, unknown>) ?? {}),
            sourceCapability: def.key,
          },
        })
        .returning({ id: mcpServersTable.id });
      createdMcpServers.push({
        slug: m.slug,
        status: "created",
        serverId: row?.id ?? null,
      });
    }
    invalidateMcpCache(connWorkspaceId ?? null);
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
      // Row-locked read-modify-write on `tools.capabilities`: the verb catalog
      // is a jsonb array with a SECOND writer — `createDeclarativeVerb`, which
      // takes the same `.for("update")` lock for the same reason (see its
      // `wireCreatedVerb` step 3). `existingTool` above was read long before
      // this write, so merging against it would clobber a verb minted in the
      // gap; re-read under the lock instead.
      await db.transaction(async (tx) => {
        // The template owns the verbs it DECLARES (re-projected here — that is
        // how a template-side field like `intent` reaches the pod) but not the
        // ones it doesn't: a wholesale `capabilities: verbs` destroyed every
        // user-minted verb on a template-owned tool at the next re-apply. Merge
        // additively, matching the subset semantics `capabilityVerbCatalogDrift`
        // compares with, so a converged tool reports no drift next pass.
        let mergedVerbs: ToolVerbCatalogEntry[] | undefined;
        if (verbs.length > 0) {
          const [locked] = await tx
            .select({ capabilities: toolsTable.capabilities })
            .from(toolsTable)
            .where(eq(toolsTable.id, existingTool.id))
            .for("update")
            .limit(1);
          mergedVerbs = mergeVerbCatalog(locked?.capabilities, verbs);
        }
        await tx
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
            ...(mergedVerbs ? { capabilities: mergedVerbs } : {}),
            updatedAt: new Date(),
          })
          .where(eq(toolsTable.id, existingTool.id));
      });
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

      // Save-time global-reference scan (B1) — this reconcile branch is a
      // DIRECT db.update (not the governed `skillsCaller.create` a few lines
      // below), so it's the one seeding path that bypassed the scan: a
      // re-applied/drifted CP template could silently persist code that
      // references an unprovided global. Only scan when the reconciled row is
      // actually a code skill AND the code is actually changing — same gate
      // `skillsRouter.update` uses (`input.code?.trim()`), via the
      // `execContentChanged` flag computed above. Without this gate, a skill
      // grandfathered with a disallowed global before this scan existed would
      // hard-fail on every future metadata-only reconcile (description/
      // parameters/scope/category), even though its code never changed.
      if ((s.kind ?? "code") === "code" && execContentChanged) {
        assertSkillGlobalsAllowed(s.code);
      }

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
      // Per-item isolation: a single playbook that fails to create must NOT abort
      // the rest of the apply — the remaining playbooks, the automations (step 4b),
      // and crucially the container + member-attach (step 5) must still run.
      // Mirrors the sibling per-item try/catch in applyPackagePostWorkspace's
      // body.automations/playbooks loops. Without it, one failing item left the
      // capability half-materialized (an empty container, missing later items).
      try {
        // Idempotent reuse keyed on the stable natural key: name within scope.
        // Case-INSENSITIVE on name to match the DB identity (0227's
        // playbooks_workspace_name_active_uq is on lower(name)); a case-variant
        // re-seed would otherwise miss here and only be caught by the governed
        // create's 23505 recovery — mislabeling a pre-existing playbook "created".
        const [existing] = await db
          .select({ id: playbooksTable.id })
          .from(playbooksTable)
          .where(
            and(
              drizzleSql`lower(${playbooksTable.name}) = lower(${p.name})`,
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
          metadata: p.metadata,
          executor: p.executor ?? "is-agent",
          status: p.status ?? "draft",
          scope: p.scope,
        });

        if (result.proposalId) proposals.push(result.proposalId);
        createdPlaybooks.push({
          name: p.name,
          status: result.status === "proposed" ? "proposed" : "created",
          playbookId: result.playbook?.id ?? null,
          proposalId: result.proposalId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err, capabilityKey: def.key, playbook: p.name },
          "capability playbook create failed (isolated — apply continues)"
        );
        createdPlaybooks.push({
          name: p.name,
          status: "error",
          playbookId: null,
          proposalId: null,
          message,
        });
      }
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
      // Per-item isolation: one automation that fails to create must NOT abort the
      // rest of the apply. Before this guard, a single throw here aborted the whole
      // `createCapabilityFromDefinition` — so any automations AFTER the failing one,
      // AND step 5 (container creation + member-attach + vault stamping), silently
      // never ran, leaving the capability half-materialized (a member-less container
      // and a partial automation set that only completed over repeated re-applies).
      // Mirrors the sibling per-item try/catch in applyPackagePostWorkspace.
      try {
        // Idempotent reuse keyed on the stable natural key: name within scope
        // (workspace-scoped when a workspaceId is present, else pod-wide/NULL).
        // Case-INSENSITIVE on name to match the DB identity (0230's
        // automations_workspace_name_active_uq is on lower(name)); a case-variant
        // re-seed would otherwise miss here and only be caught by the governed
        // create's 23505 recovery — mislabeling a pre-existing automation "created".
        const [existing] = await db
          .select({ id: automationsTable.id })
          .from(automationsTable)
          .where(
            and(
              drizzleSql`lower(${automationsTable.name}) = lower(${a.name})`,
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
          state: a.state,
        });
        createdAutomations.push({
          name: a.name,
          status: "created",
          automationId: created?.id ?? null,
          proposalId: null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err, capabilityKey: def.key, automation: a.name },
          "capability automation create failed (isolated — apply continues)"
        );
        createdAutomations.push({
          name: a.name,
          status: "error",
          automationId: null,
          proposalId: null,
          message,
        });
      }
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
      partsNotAttached: 0,
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
    // `def.metadata` (declared container-level config, e.g. `mode`) is spread
    // BEFORE templateKey/contentHash so those two stay authoritative even if a
    // template mistakenly declares them under `metadata`.
    const [containerRow] = await db
      .select({ metadata: capabilitiesTable.metadata })
      .from(capabilitiesTable)
      .where(eq(capabilitiesTable.id, containerId))
      .limit(1);
    const existingMetadata = (containerRow?.metadata ?? {}) as Record<
      string,
      unknown
    >;
    // DECLARED emit patterns (rules-ecosystem WHEN menu). Read off the RAW
    // definition — patterns carry no `{{param}}` so interpolation is a no-op, and
    // this keeps the field validator-checked at the source. `undefined` (the
    // definition declares no `emits`) leaves any existing declaration untouched;
    // an explicit `[]` is persisted so a boot backfill knows not to fill it.
    const declaredEmits = sanitizeEmitPatterns(rawDef.emits);
    await db
      .update(capabilitiesTable)
      .set({
        metadata: {
          ...existingMetadata,
          ...(def.metadata ?? {}),
          templateKey: def.key,
          ...(rawDef.contentHash ? { contentHash: rawDef.contentHash } : {}),
          ...(declaredEmits !== undefined ? { emits: declaredEmits } : {}),
        },
        updatedAt: new Date(),
      })
      .where(eq(capabilitiesTable.id, containerId));

    // Attach every created tool (connections + built-ins) and skill as a member.
    //
    // NON-FATAL, but COUNTED. `addPart` carries an authorization floor for
    // pod-scoped containers (owner or pod admin), and the installer resolves an
    // existing container by NAME, so a second installer is routinely not its
    // creator. Letting that throw aborted the install AFTER the tools and skills
    // were already written — a partial install with no rollback. Swallowing it
    // would be just as wrong: the caller would be told the install succeeded
    // while the container has no members. So: keep going, count, and surface it.
    let partsNotAttached = 0;
    const attachPart = async (
      partType: "tool" | "skill" | "playbook" | "automation",
      partId: string
    ): Promise<void> => {
      try {
        await containersCaller.addPart({
          capabilityId: containerId,
          partType,
          partId,
        });
      } catch (err) {
        partsNotAttached += 1;
        logger.warn(
          { containerId, partType, partId, err },
          "createFromDefinition: could not attach part to capability container"
        );
      }
    };
    for (const toolId of toolIdByName.values()) {
      await attachPart("tool", toolId);
    }
    for (const s of createdSkills) {
      if (s.skillId) await attachPart("skill", s.skillId);
    }

    // Seeded PROCESS flows become members too — this is THE edge that makes
    // "installed capability → what it materialized" derivable from data. Each
    // also gets a `metadata.sourceCapability` back-pointer (mirrors the mcpServers
    // stamp above), so the flow knows which capability seeded it even without the
    // link. Non-fatal + idempotent, like the tool/skill attach.
    for (const p of createdPlaybooks) {
      if (!p.playbookId) continue;
      await attachPart("playbook", p.playbookId);
      await stampSourceCapability(playbooksTable, p.playbookId, def.key);
    }
    for (const a of createdAutomations) {
      if (!a.automationId) continue;
      await attachPart("automation", a.automationId);
      await stampSourceCapability(automationsTable, a.automationId, def.key);
    }
    container = { ...container, partsNotAttached };

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
      mcpServers: createdMcpServers,
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
export const GRANT_DEFAULT_EXEC_MODE = "propose" as const;

const VERB_WRITE_SIGNALS = [
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
  "run",
  "execute",
];
const VERB_READ_SIGNALS = [
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

// Split on non-alphanumerics only — verb names/descriptions are snake_case or
// prose, never camelCase, so this is enough to yield whole words.
function tokenizeVerbText(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
}

function classifyVerbTokens(tokens: Set<string>): ToolVerbKind | null {
  if (VERB_WRITE_SIGNALS.some((w) => tokens.has(w))) return "action";
  if (VERB_READ_SIGNALS.some((r) => tokens.has(r))) return "read";
  return null;
}

/**
 * Infer a verb's read/push axis from the skill that backs it. A `code` skill that
 * SENDS/WRITES (its name or description signals a mutation) is an `action` (push);
 * a `read` skill is a pull. Heuristic + conservative default: anything that looks
 * like it mutates is treated as a push (`action`) so it stays behind governance.
 *
 * Matches whole words only (never substrings) — a naive `.includes()` scan
 * misfires on incidental substrings inside real words (e.g. "dataset" contains
 * "set", "thread" contains "read", "publishedDate" contains "publish"). The
 * verb's own NAME is checked first: it's a structured `verb_object` identifier
 * (`apify_run_actor`, `apify_list_actor_runs`), whereas the description is prose
 * that often mentions a sibling verb or an unrelated noun ("no actor run",
 * "past run") without describing what THIS verb does. Only when the name is
 * inconclusive does the description get consulted.
 */
export function deriveVerbKind(s: CapabilitySkillDef): ToolVerbKind {
  const fromName = classifyVerbTokens(tokenizeVerbText(s.name));
  if (fromName) return fromName;
  const fromDescription = classifyVerbTokens(
    tokenizeVerbText(s.description ?? "")
  );
  if (fromDescription) return fromDescription;
  // Unknown intent → conservative push so it stays governed.
  return "action";
}

/**
 * Resolve a skill's declared abstract `intent` for the derived catalog entry.
 *
 * The vocabulary is CLOSED, so an unrecognised value is REJECTED here — the
 * boundary where a template's DATA first becomes a stored catalog entry —
 * rather than silently persisted. Templates are `z.unknown()`-shaped JSON from
 * the Control Plane, so without this check a typo would land in the jsonb and
 * quietly split the routing axis into a vendor-keyed one all over again.
 *
 * An `instruction` skill is a TEACHING doc, not a callable verb — it never
 * reaches here, because `deriveToolVerbs` only walks skills that `requires` a
 * tool and the applier derives no catalog entry for prose.
 */
function resolveVerbIntent(
  s: CapabilitySkillDef
): ToolVerbCatalogEntry["intent"] {
  const raw = (s as { intent?: unknown }).intent;
  if (raw === undefined || raw === null) return undefined;
  if (!isAbstractVerb(raw)) {
    throw new Error(
      `Capability skill "${s.name}" declares an unknown intent ${JSON.stringify(raw)}. ` +
        `The intent vocabulary is CLOSED — use one of: ${ABSTRACT_VERBS.join(", ")}, ` +
        `or omit the field entirely if none fits.`
    );
  }
  return raw;
}

/**
 * Build a tool's structured verb catalog from the definition's skills that
 * `requires` it (by tool NAME). One verb per requiring skill: `id` = skill name
 * (the callable, dispatched via callProvider/the dispatcher), `label` = skill
 * name, `kind` = read/push axis, `argsSchema` = the skill's declared parameters,
 * `govDefault` = the seeded grant exec-mode (passed in, never re-derived here).
 */
export function deriveToolVerbs(
  toolName: string,
  skills: CapabilitySkillDef[],
  govDefault: "auto" | "propose" | "dry-run"
): ToolVerbCatalogEntry[] {
  const verbs: ToolVerbCatalogEntry[] = [];
  for (const s of skills) {
    if (!s.requires?.includes(toolName)) continue;
    const intent = resolveVerbIntent(s);
    verbs.push({
      id: s.name,
      label: s.name,
      kind: deriveVerbKind(s),
      argsSchema:
        s.parameters && typeof s.parameters === "object"
          ? s.parameters
          : undefined,
      govDefault,
      // Routing axis — omitted entirely when the template declares none, so a
      // legacy entry's shape is unchanged.
      ...(intent ? { intent } : {}),
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
export async function issueCapabilityGrant(
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
