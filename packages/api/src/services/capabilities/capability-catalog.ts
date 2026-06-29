/**
 * Capability CATALOG read-model — the pack-grouped, status-computed view that is
 * the keystone of the capability UX consolidation (see CAPABILITIES-NORTH-STAR.md).
 *
 * Where `listCapabilities` (capability-registry.ts) returns a FLAT list — every
 * tool and every skill as its own (duplicated) entry — this builder returns ONE
 * `CapabilityCard` per PACK:
 *   - one card per installed capability CONTAINER (`capabilities` table), with its
 *     member tools (→ connection) and member skills (→ verbs) folded in, plus
 *   - one card per AVAILABLE template (from the Control Plane catalog — the
 *     single source of truth) that has NO matching installed container.
 *
 * The single computed `status` per card drives every surface (CLI / browser /
 * Raycast): each card carries exactly one `nextAction`. De-dup is by pack
 * identity (a container's NAME, which the applier sets to the template's name) —
 * fixing today's read-model that surfaces duplicate bare tools/skills.
 *
 * Read-only. No writes, no governance (reads are auto-approved). Resilient: a
 * connector-resolver failure degrades a connection to `state:"missing"`, never a
 * 500 — the catalog always renders.
 */

import { db, eq, and, or, isNull, inArray } from "@synap/database";
import {
  capabilities,
  tools,
  skills,
  links,
  secrets,
} from "@synap/database/schema";
import type { CapabilityDefinition } from "@synap/playbooks";

import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { resolveNangoConnector } from "../../connectors/index.js";
import { fetchCPCapabilityTemplates } from "./cp-template-client.js";

// ── Contract (matched verbatim by the CLI being built in parallel) ────────────

export type CapabilityCardStatus =
  | "available"
  | "needs_connection"
  | "connected"
  | "draft"
  | "ready"
  | "partial";

export interface CapabilityCardConnection {
  required: boolean;
  /** nango:// => "provider", vault:// => "vault". null when none/unknown. */
  kind: "provider" | "vault" | null;
  /** providerConfigKey, e.g. "google" — present for provider connections. */
  provider?: string;
  state: "connected" | "missing" | "expired";
  /** connectionId (or display account) when connected. */
  account?: string;
}

export interface CapabilityCardVerb {
  /** Backing skill NAME — the verbId the execute door resolves. */
  verbId: string;
  /** Backing skill UUID (installed verbs only; null for an available template). */
  skillId: string | null;
  label: string;
  /** read/write by name heuristic. TODO: promote to explicit skill metadata. */
  type: "read" | "write";
  /** Backing skill `approved === true`. */
  enabled: boolean;
  governance: "auto" | "propose";
  /** enabled AND (no connection required OR connection connected). */
  runnable: boolean;
  /** Parameter names the verb accepts — for `cap run <verb> --<param> …` hints. */
  params: string[];
}

/** Extract parameter NAMES from a skill `parameters` blob (JSON-schema or flat). */
function extractParamNames(schema: unknown): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const obj = schema as Record<string, unknown>;
  if (
    obj.properties &&
    typeof obj.properties === "object" &&
    !Array.isArray(obj.properties)
  ) {
    return Object.keys(obj.properties as Record<string, unknown>);
  }
  return Object.keys(obj);
}

export interface CapabilityCard {
  /** Container id; null for an available-only template. */
  id: string | null;
  /** Stable identity: template key if known, else container id/slug. */
  key: string;
  /** Pack display name, e.g. "Nango — Google Workspace". */
  name: string;
  description?: string | null;
  source: "installed" | "available";
  status: CapabilityCardStatus;
  connection?: CapabilityCardConnection;
  verbs: CapabilityCardVerb[];
  nextAction: {
    kind: "add" | "connect" | "enable" | "run" | "none";
    hint: string;
  };
}

export interface CapabilityCatalogContext {
  workspaceId: string;
  userId: string;
}

// ── Verb type heuristic ───────────────────────────────────────────────────────
//
// read if ANY token of the verb (backing skill) name is a read-ish word, else
// write. Matches the read word as a whole `_`-delimited token ANYWHERE — verb
// names put the action LAST (gmail_search, calendar_list, drive_search), so a
// start-anchored test would wrongly classify those as writes.
// TODO: this should become EXPLICIT skill metadata (a `read`/`write` field on the
// skill row) rather than a name heuristic — the heuristic is the bootstrap.
const READ_TOKEN =
  /(^|_)(list|search|get|read|find|fetch|show|query|view|count)(_|$)/i;
function verbType(verbId: string): "read" | "write" {
  return READ_TOKEN.test(verbId) ? "read" : "write";
}

// Reads run inline (auto); writes ask approval each run (propose). Independent of
// `enabled` (which is the operator's one-time approval gate). Mirrors the north
// star: "search email (read)" inline vs "send email (write · asks approval)".
function verbGovernance(type: "read" | "write"): "auto" | "propose" {
  return type === "read" ? "auto" : "propose";
}

// ── Credential-ref → connection requirement ───────────────────────────────────

interface ConnState {
  /** Provider keys connected for the user → their connectionId. */
  providerConn: Map<string, string>;
  /** Real `vault://<id>` secret ids that exist (not soft-deleted). */
  vaultExists: Set<string>;
}

/**
 * Derive a card's `connection` from the credential refs of its member tools (or a
 * template's tools), plus whether the source declares any vault requirement.
 *
 * A `nango://<provider>` ref => a provider connection (OAuth); state is connected
 * when the user has a live Nango connection for that provider. A `vault://<id>`
 * ref => a vault credential; state is connected when the secret row exists. A
 * template-local vault ref (e.g. "apiKeySecret", not yet materialized) or a
 * declared `vault[]` => a vault requirement that is necessarily `missing` until
 * installed. No credentialed tool => no connection required.
 */
function deriveConnection(
  credentialRefs: Array<string | null | undefined>,
  hasVaultRequirement: boolean,
  conn: ConnState
): CapabilityCardConnection {
  const refs = credentialRefs.filter((r): r is string => !!r);

  // Provider (nango://) takes precedence — it's the OAuth connection step.
  for (const ref of refs) {
    const m = /^nango:\/\/(.+)$/.exec(ref);
    if (m) {
      const provider = m[1];
      const connectionId = conn.providerConn.get(provider);
      return {
        required: true,
        kind: "provider",
        provider,
        state: connectionId ? "connected" : "missing",
        ...(connectionId ? { account: connectionId } : {}),
      };
    }
  }

  // Real vault credential (vault://<id>) — state from secret-row existence.
  for (const ref of refs) {
    const m = /^vault:\/\/(.+)$/.exec(ref);
    if (m) {
      const secretId = m[1];
      return {
        required: true,
        kind: "vault",
        state: conn.vaultExists.has(secretId) ? "connected" : "missing",
      };
    }
  }

  // A template-local vault ref (not yet a real vault://) or a declared vault[]
  // requirement — needs a key, not yet satisfied.
  const hasLocalVaultRef = refs.length > 0;
  if (hasVaultRequirement || hasLocalVaultRef) {
    return { required: true, kind: "vault", state: "missing" };
  }

  return { required: false, kind: null, state: "missing" };
}

// ── Status + next action (the state machine, §3 of the north star) ────────────

function computeInstalledStatus(
  connection: CapabilityCardConnection,
  verbs: CapabilityCardVerb[]
): CapabilityCardStatus {
  const connectionOk = !connection.required || connection.state === "connected";
  if (!connectionOk) return "needs_connection";

  const enabledCount = verbs.filter((v) => v.enabled).length;
  const total = verbs.length;
  if (enabledCount === 0) {
    // Connection satisfied (or none): a connected pack awaiting enable, or a
    // local pack (no connection) still in draft.
    return connection.required ? "connected" : "draft";
  }
  if (total > 0 && enabledCount === total) return "ready";
  // Some enabled, some not.
  return "partial";
}

function nextActionFor(
  status: CapabilityCardStatus,
  name: string,
  connection?: CapabilityCardConnection
): CapabilityCard["nextAction"] {
  switch (status) {
    case "available":
      return { kind: "add", hint: `Add "${name}" to install its verbs.` };
    case "needs_connection": {
      const prov = connection?.provider;
      return {
        kind: "connect",
        hint: prov
          ? `Connect ${prov} (OAuth) to enable "${name}".`
          : `Connect the credential for "${name}".`,
      };
    }
    case "connected":
      return {
        kind: "enable",
        hint: `Enable verbs for "${name}" — connection is ready.`,
      };
    case "draft":
      return { kind: "enable", hint: `Enable verbs for "${name}".` };
    case "partial":
      return {
        kind: "enable",
        hint: `Enable the remaining verbs for "${name}".`,
      };
    case "ready":
      return { kind: "run", hint: `Run a verb of "${name}".` };
  }
}

// ── Connection-state snapshot (resilient) ─────────────────────────────────────

/**
 * Resolve the user's live provider connections and the set of existing vault
 * secrets referenced by the given refs. A connector-resolver failure degrades to
 * an EMPTY provider map (every provider reads `missing`) rather than throwing —
 * the catalog must always render.
 */
async function loadConnState(
  userId: string,
  vaultSecretIds: string[]
): Promise<ConnState> {
  const providerConn = new Map<string, string>();
  try {
    const nango = await resolveNangoConnector();
    if (nango) {
      const connections = await nango.listConnections(userId);
      for (const cn of connections) {
        if (!providerConn.has(cn.provider)) {
          providerConn.set(cn.provider, cn.connectionId);
        }
      }
    }
  } catch {
    // Degrade: no provider connections known → providers read as "missing".
  }

  const vaultExists = new Set<string>();
  if (vaultSecretIds.length > 0) {
    try {
      const rows = await db
        .select({ id: secrets.id })
        .from(secrets)
        .where(
          and(inArray(secrets.id, vaultSecretIds), isNull(secrets.deletedAt))
        );
      for (const r of rows) vaultExists.add(r.id);
    } catch {
      // Degrade: treat all as missing.
    }
  }

  return { providerConn, vaultExists };
}

// ── Template loading (DB rows + on-disk family templates) ─────────────────────

interface TemplateEntry {
  key: string;
  name: string;
  description?: string | null;
  def: CapabilityDefinition;
}

/**
 * Load every available capability template definition from the Control Plane
 * catalog — the SINGLE source of truth. The pod stores none of its own.
 */
async function loadTemplates(): Promise<TemplateEntry[]> {
  // CONTROL PLANE catalog — the SINGLE source of truth. The pod stores no
  // templates of its own (no table, no files, no bundle).
  const cpItems = await fetchCPCapabilityTemplates();
  return cpItems.map((item) => ({
    key: item.key,
    name: item.name,
    description: item.description ?? null,
    def: item.definition,
  }));
}

// ── The builder ───────────────────────────────────────────────────────────────

export async function buildCapabilityCatalog(
  ctx: CapabilityCatalogContext
): Promise<CapabilityCard[]> {
  const { workspaceId, userId } = ctx;

  // 1. Installed containers visible to the caller: pod-wide (NULL) + this
  //    workspace, narrowed by the user-visible predicate (membership floor).
  const containerRows = await db
    .select()
    .from(capabilities)
    .where(
      and(
        or(
          isNull(capabilities.workspaceId),
          eq(capabilities.workspaceId, workspaceId)
        ),
        userVisibleWhere(capabilities.workspaceId, userId)
      )
    );

  // 2. Member links (tool|skill --member_of--> capability) for those containers.
  const containerIds = containerRows.map((c) => c.id);
  const memberLinks =
    containerIds.length > 0
      ? await db
          .select()
          .from(links)
          .where(
            and(
              eq(links.toType, "capability"),
              inArray(links.toId, containerIds),
              eq(links.linkType, "member_of")
            )
          )
      : [];

  const memberToolIds = Array.from(
    new Set(
      memberLinks.filter((l) => l.fromType === "tool").map((l) => l.fromId)
    )
  );
  const memberSkillIds = Array.from(
    new Set(
      memberLinks.filter((l) => l.fromType === "skill").map((l) => l.fromId)
    )
  );

  // 3. Load member tool + skill rows (the parts the cards fold in).
  const toolRows =
    memberToolIds.length > 0
      ? await db
          .select({
            id: tools.id,
            name: tools.name,
            credentialRef: tools.credentialRef,
          })
          .from(tools)
          .where(inArray(tools.id, memberToolIds))
      : [];
  const skillRows =
    memberSkillIds.length > 0
      ? await db
          .select({
            id: skills.id,
            name: skills.name,
            approved: skills.approved,
            parameters: skills.parameters,
          })
          .from(skills)
          .where(inArray(skills.id, memberSkillIds))
      : [];

  const toolById = new Map(toolRows.map((t) => [t.id, t]));
  const skillById = new Map(skillRows.map((s) => [s.id, s]));

  // 4. Available templates (DB + on-disk family set).
  const templates = await loadTemplates();
  const templateByName = new Map<string, TemplateEntry>();
  for (const t of templates) templateByName.set(t.name.toLowerCase(), t);

  // 5. Connection snapshot — gather every real vault://<id> referenced by member
  //    tools so the secret-existence check is ONE query.
  const vaultSecretIds: string[] = [];
  for (const t of toolRows) {
    const m = t.credentialRef ? /^vault:\/\/(.+)$/.exec(t.credentialRef) : null;
    if (m) vaultSecretIds.push(m[1]);
  }
  const conn = await loadConnState(userId, vaultSecretIds);

  // ── Installed cards ─────────────────────────────────────────────────────────
  const cards: CapabilityCard[] = [];
  const installedNames = new Set<string>();
  const installedKeys = new Set<string>();

  for (const container of containerRows) {
    installedNames.add(container.name.toLowerCase());

    const myLinks = memberLinks.filter((l) => l.toId === container.id);
    const myToolRefs = myLinks
      .filter((l) => l.fromType === "tool")
      .map((l) => toolById.get(l.fromId)?.credentialRef ?? null);

    const connection = deriveConnection(myToolRefs, false, conn);

    const verbs: CapabilityCardVerb[] = myLinks
      .filter((l) => l.fromType === "skill")
      .map((l) => skillById.get(l.fromId))
      .filter((s): s is NonNullable<typeof s> => !!s)
      .map((s) => {
        const type = verbType(s.name);
        const enabled = s.approved === true;
        const connectionOk =
          !connection.required || connection.state === "connected";
        return {
          verbId: s.name,
          skillId: s.id,
          label: s.name,
          type,
          enabled,
          governance: verbGovernance(type),
          runnable: enabled && connectionOk,
          params: extractParamNames(s.parameters),
        };
      });

    const status = computeInstalledStatus(connection, verbs);

    // Recover the stable key by matching the container name to a known template.
    const matchedTemplate = templateByName.get(container.name.toLowerCase());
    const key = matchedTemplate?.key ?? container.id;
    if (matchedTemplate) installedKeys.add(matchedTemplate.key);

    cards.push({
      id: container.id,
      key,
      name: container.name,
      description: container.description ?? null,
      source: "installed",
      status,
      ...(connection.required || connection.kind ? { connection } : {}),
      verbs,
      nextAction: nextActionFor(status, container.name, connection),
    });
  }

  // ── Available cards (templates with no installed container) ──────────────────
  for (const tpl of templates) {
    if (installedNames.has(tpl.name.toLowerCase())) continue;
    if (installedKeys.has(tpl.key)) continue;

    const def = tpl.def;
    const toolRefs = (def.tools ?? []).map((t) => t.credentialRef ?? null);
    const hasVaultRequirement = (def.vault?.length ?? 0) > 0;
    const connection = deriveConnection(toolRefs, hasVaultRequirement, conn);

    // Verbs come from the template's skills — none enabled (not installed yet).
    const verbs: CapabilityCardVerb[] = (def.skills ?? []).map((s) => {
      const type = verbType(s.name);
      return {
        verbId: s.name,
        skillId: null,
        label: s.name,
        type,
        enabled: false,
        governance: verbGovernance(type),
        runnable: false,
        params: extractParamNames((s as { parameters?: unknown }).parameters),
      };
    });

    cards.push({
      id: null,
      key: tpl.key,
      name: tpl.name,
      description: tpl.description ?? null,
      source: "available",
      status: "available",
      ...(connection.required || connection.kind ? { connection } : {}),
      verbs,
      nextAction: nextActionFor("available", tpl.name, connection),
    });
  }

  return cards;
}
