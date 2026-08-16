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

import { db, eq, and, or, isNull, isNotNull, inArray } from "@synap/database";
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
import {
  fetchCPCapabilityTemplates,
  fetchCPCapabilityTemplateByKey,
} from "./cp-template-client.js";

// ── Contract (matched verbatim by the CLI being built in parallel) ────────────

export type CapabilityCardStatus =
  | "available"
  | "needs_connection"
  | "connected"
  | "draft"
  | "ready"
  | "partial"
  | "unavailable";

export interface CapabilityCardConnection {
  required: boolean;
  /** nango:// => "provider", vault:// => "vault". null when none/unknown. */
  kind: "provider" | "vault" | null;
  /** providerConfigKey, e.g. "google" — present for provider connections. */
  provider?: string;
  /**
   * `missing` = connectable, the user just hasn't. `unavailable` = this POD
   * cannot offer it at all (Nango answered and doesn't declare the provider), so
   * "Connect" would dead-end — only claimed when availability is actually KNOWN.
   */
  state: "connected" | "missing" | "expired" | "unavailable";
  /** connectionId (or display account) when connected. */
  account?: string;
  /**
   * True for a pod-internal credential (a `vault://<id>` secret the operator
   * holds) rather than a third-party OAuth (nango://) connection. Lets surfaces
   * distinguish "internal key" from "external account" without re-parsing refs.
   */
  internal?: boolean;
}

/** A single declared parameter of a verb (richer than `params: string[]`). */
export interface CapabilityCardVerbParam {
  name: string;
  type?: string;
  required?: boolean;
  description?: string;
}

export interface CapabilityCardVerb {
  /** Backing skill NAME — the verbId the execute door resolves. */
  verbId: string;
  /** Backing skill UUID (installed verbs only; null for an available template). */
  skillId: string | null;
  label: string;
  /** One-line description from the backing skill (`skill.description`). */
  description?: string | null;
  /**
   * read / write / action — derived (read-ish name → read; mutating-action name
   * → action; else write), honoring an explicit `metadata.verbType` override.
   * `action` is additive: a mutating verb that is an action (reply/send/…) rather
   * than a create/update. TODO: promote fully to explicit skill metadata.
   */
  type: "read" | "write" | "action";
  /** Backing skill `approved === true`. */
  enabled: boolean;
  governance: "auto" | "propose";
  /** enabled AND (no connection required OR connection connected). */
  runnable: boolean;
  /** Parameter names the verb accepts — for `cap run <verb> --<param> …` hints. */
  params: string[];
  /**
   * Typed parameter schema (name + type + required + description) derived from the
   * skill's `parameters` JSON-schema — for the run form + inspector, which need
   * types, not just names. Empty when the skill declares no parameters.
   */
  paramsSchema: CapabilityCardVerbParam[];
  /**
   * Free-form functional tag from the backing skill (`skills.category`, e.g.
   * "enrichment") — lets a surface find "the enrichment verbs for this entity"
   * by CONFIGURATION instead of hardcoding verb ids. Absent when the skill (or
   * its template definition) declares no category.
   */
  category?: string;
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

/**
 * The FLAT convention's closed value vocabulary — `"<jsonType>"` for a required
 * param, `"<jsonType>?"` for an optional one. Every seeded skill that declares
 * flat `parameters` draws from exactly these eight tokens; the map is the SSOT
 * for that fact. A token OUTSIDE this set is not an error (see below) — the set
 * only decides which values carry a trustworthy `type`.
 */
const FLAT_PARAM_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "array",
  "object",
  // `integer` is not in the seeded corpus today, but it is the one JSON-schema
  // primitive a template author would reach for next; accepting it costs
  // nothing and keeps the first such template from degrading silently.
  "integer",
]);

/**
 * Parse ONE flat-convention value (`"string"`, `"number?"`, …) into the typed
 * fields it carries.
 *
 * The flat convention encodes BOTH type and optionality — the `?` suffix means
 * optional, its absence means required. This was previously discarded wholesale
 * (`Object.keys(obj).map(name => ({ name }))`), which is why every seeded param
 * rendered as an identical, required-looking text box.
 *
 * DEGRADATION IS DELIBERATE AND TOTAL: an unrecognized value (a nested object, a
 * number, a token outside `FLAT_PARAM_TYPES`, an author's freehand
 * `"the user's email"`) yields `{}` — the param keeps its NAME and renders as an
 * untyped field. A param must never be dropped and this must never throw: a
 * form that silently omits an argument is strictly worse than one that shows it
 * untyped.
 */
function parseFlatParamValue(
  raw: unknown
): Pick<CapabilityCardVerbParam, "type" | "required"> {
  if (typeof raw !== "string") return {};
  const trimmed = raw.trim();
  const optional = trimmed.endsWith("?");
  const token = (optional ? trimmed.slice(0, -1) : trimmed).trim();
  if (!FLAT_PARAM_TYPES.has(token)) return {};
  return { type: token, required: !optional };
}

/**
 * Extract a TYPED parameter list from a skill `parameters` blob. Honors the
 * JSON-schema shape (`{ properties: { name: { type, description } }, required }`)
 * — pulling `type`/`description` per property and `required` from the schema's
 * `required[]`. Falls back to the flat `{ name: "type?" }` map, whose value
 * carries type + optionality (see `parseFlatParamValue`). Mirrors
 * `extractParamNames`' two shapes additively.
 *
 * Exported for test only — the catalog is the sole production caller.
 */
export function extractParamsSchema(
  schema: unknown
): CapabilityCardVerbParam[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const obj = schema as Record<string, unknown>;
  const props = obj.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    const requiredList = Array.isArray(obj.required)
      ? (obj.required as unknown[]).filter(
          (r): r is string => typeof r === "string"
        )
      : [];
    return Object.entries(props as Record<string, unknown>).map(
      ([name, raw]) => {
        const def =
          raw && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {};
        return {
          name,
          ...(typeof def.type === "string" ? { type: def.type } : {}),
          required: requiredList.includes(name),
          ...(typeof def.description === "string"
            ? { description: def.description }
            : {}),
        };
      }
    );
  }
  // Flat shape — the value carries type + optionality; an unparseable value
  // degrades to a named-but-untyped param rather than being dropped.
  return Object.entries(obj).map(([name, raw]) => ({
    name,
    ...parseFlatParamValue(raw),
  }));
}

/** A template's INSTALL parameter — what the caller supplies to `apply` it. */
export interface CapabilityCardInstallParam {
  name: string;
  label?: string;
  type?: string;
  required?: boolean;
  description?: string;
  secret?: boolean;
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
  /**
   * The pack's composition — the names of its member tools + skills and the
   * backing credential ref/kind (provider/vault). Lets the hero UI render "what's
   * inside" without re-deriving from verbs/connection. Derived from the same
   * container members (or template def) the card folds in.
   */
  anatomy: {
    tools: string[];
    skills: string[];
    credential?: string;
  };
  /**
   * The template's INSTALL params — what the caller must supply to apply it (e.g.
   * a vault credential, a baseUrl). Surfaced so the CLI can prompt for them and
   * apply WITH params (which wires the credential into the tool), instead of a
   * disconnected post-hoc vault write. Empty when the template declares none.
   */
  installParams: CapabilityCardInstallParam[];
  nextAction: {
    kind: "add" | "connect" | "enable" | "run" | "none";
    hint: string;
  };
}

/** Map a template definition's declared params → the card's install-param specs. */
function extractInstallParams(
  def: CapabilityDefinition
): CapabilityCardInstallParam[] {
  const params = (def as { params?: Array<Record<string, unknown>> }).params;
  if (!Array.isArray(params)) return [];
  return params.map((p) => {
    const type = typeof p.type === "string" ? p.type : undefined;
    return {
      name: String(p.name),
      ...(typeof p.label === "string" ? { label: p.label } : {}),
      ...(type ? { type } : {}),
      ...(typeof p.required === "boolean" ? { required: p.required } : {}),
      ...(typeof p.description === "string"
        ? { description: p.description }
        : {}),
      // Prompt these masked: an explicit secret/password type, or the
      // conventional credential param names used by vault-generic templates.
      ...(type === "password" ||
      type === "secret" ||
      /key|token|secret|password/i.test(String(p.name))
        ? { secret: true }
        : {}),
    };
  });
}

export interface CapabilityCatalogContext {
  /** Absent/null = POD-WIDE view (pod-global capabilities only, no workspace
   *  overlay) — capabilities are viewable without an active workspace lens. */
  workspaceId?: string | null;
  userId: string;
  /** Resolve this key/name even if excluded from the default-sync list
   *  (syncByDefault=false) — see `loadTemplates`'s doc. */
  extraKey?: string;
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
// An `action` is a mutating verb that is a DISPATCH (reply/send/run/…) rather than
// a create/update — a third class layered onto the read/write split. Same token
// style as READ_TOKEN (whole `_`-delimited token anywhere).
const ACTION_TOKEN =
  /(^|_)(reply|invite|send|post|run|trigger|cancel|dispatch)(_|$)/i;

type VerbType = "read" | "write" | "action";

/**
 * Classify a verb. An explicit `metadata.verbType` ("read"|"write"|"action") wins;
 * otherwise read-ish names → read, action/dispatch names → action, else write.
 * read is checked before action to keep existing read classification stable.
 */
function verbType(
  verbId: string,
  metadata?: Record<string, unknown> | null
): VerbType {
  const override = metadata?.verbType;
  if (override === "read" || override === "write" || override === "action") {
    return override;
  }
  if (READ_TOKEN.test(verbId)) return "read";
  if (ACTION_TOKEN.test(verbId)) return "action";
  return "write";
}

// Reads run inline (auto); writes/actions ask approval each run (propose).
// Independent of `enabled` (the operator's one-time approval gate). Mirrors the
// north star: "search email (read)" inline vs "send email (action · asks approval)".
function verbGovernance(type: VerbType): "auto" | "propose" {
  return type === "read" ? "auto" : "propose";
}

// ── Credential-ref → connection requirement ───────────────────────────────────

interface ConnState {
  /** Provider keys connected for the user → their connectionId. */
  providerConn: Map<string, string>;
  /**
   * Provider keys this pod's Nango DECLARES (uniqueKey and provider, lowercased).
   * `null` means UNKNOWN — the lookup failed, so availability is unproven and no
   * caller may claim a provider is unavailable.
   */
  providerAvailable: Set<string> | null;
  /** Real `vault://<id>` secret ids that exist (not soft-deleted). */
  vaultExists: Set<string>;
  /**
   * Nango connectionIds (`secrets.account_hint`) whose connection-health mirror
   * reads `needs_reauth` (dispatch saw ≥2 auth failures). A provider that is
   * LISTED in Nango but whose connection is here reads `expired`, not `connected` —
   * this is what finally makes "connected" mean USABLE instead of merely listed.
   */
  reauthConnIds: Set<string>;
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
 *
 * Exported for unit testing (pure over its `ConnState` arg) — mirrors
 * `extractParamsSchema` above. It carries the health-derivation branch
 * (`reauthConnIds` → `expired`), the wave's core logic.
 */
export function deriveConnection(
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
      if (connectionId) {
        // Listed in Nango — but "connected" must mean USABLE. If the health mirror
        // flagged this connection `needs_reauth` (dispatch saw repeated auth
        // failures), report `expired` so the surface offers a reconnect instead of
        // letting the next run 500 on a dead token.
        return {
          required: true,
          kind: "provider",
          provider,
          state: conn.reauthConnIds.has(connectionId) ? "expired" : "connected",
          account: connectionId,
        };
      }
      // Only downgrade to `unavailable` when availability is KNOWN (non-null) and
      // the provider is absent from it. Unknown → `missing`, the connectable state.
      const unavailable =
        conn.providerAvailable !== null &&
        !conn.providerAvailable.has(provider.toLowerCase());
      return {
        required: true,
        kind: "provider",
        provider,
        state: unavailable ? "unavailable" : "missing",
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
        account: secretId,
        internal: true,
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
  if (!connectionOk) {
    // A pod that can't offer the provider must not render "Needs connection" —
    // there is no connect action behind it.
    return connection.state === "unavailable"
      ? "unavailable"
      : "needs_connection";
  }

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
      // `expired` = previously connected, token now dead → RECONNECT, not connect.
      if (connection?.state === "expired") {
        return {
          kind: "connect",
          hint: prov
            ? `Reconnect ${prov} — its access expired or was revoked.`
            : `Reconnect the credential for "${name}" — it expired or was revoked.`,
        };
      }
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
    case "unavailable": {
      const prov = connection?.provider;
      return {
        kind: "none",
        hint: prov
          ? `"${name}" needs ${prov}, which this pod doesn't offer yet.`
          : `"${name}" needs a provider this pod doesn't offer yet.`,
      };
    }
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
  let providerAvailable: Set<string> | null = null;
  try {
    const nango = await resolveNangoConnector();
    if (nango) {
      const connections = await nango.listConnections(userId);
      for (const cn of connections) {
        if (!providerConn.has(cn.provider)) {
          providerConn.set(cn.provider, cn.connectionId);
        }
      }
      // Availability stays null unless Nango actually ANSWERED — see ConnState.
      const declared = await nango.listIntegrationsResult();
      if (declared.ok) {
        providerAvailable = new Set(
          declared.integrations.flatMap((i) => [
            i.uniqueKey.toLowerCase(),
            i.provider.toLowerCase(),
          ])
        );
      }
    }
  } catch {
    // Degrade: no provider connections known → providers read as "missing".
  }

  // Connection-health mirror (0229): which of this user's capability connections
  // have been marked `needs_reauth` by the dispatch auth-failure signal. Read from
  // the SAME store the CRUD registry owns (`secrets`), so "connected" reflects
  // health, not raw Nango existence. Degrades to empty (all healthy) on failure —
  // the catalog must always render.
  const reauthConnIds = new Set<string>();
  try {
    const unhealthy = await db
      .select({ accountHint: secrets.accountHint })
      .from(secrets)
      .where(
        and(
          isNotNull(secrets.capabilityId),
          eq(secrets.connectionState, "needs_reauth"),
          or(eq(secrets.userId, userId), eq(secrets.isPodWide, true)),
          isNull(secrets.deletedAt)
        )
      );
    for (const r of unhealthy) {
      if (r.accountHint) reauthConnIds.add(r.accountHint);
    }
  } catch {
    // Degrade: no health signal → connections read by existence alone (prior behavior).
  }

  const vaultExists = new Set<string>();
  if (vaultSecretIds.length > 0) {
    try {
      const rows = await db
        .select({ id: secrets.id })
        .from(secrets)
        .where(
          and(
            inArray(secrets.id, vaultSecretIds),
            // A connection reads "connected" when the caller can actually resolve
            // it: their OWN secret, OR a POD-WIDE (0211) shared vault key they may
            // use without a per-user grant. Matching by id ALONE would let a secret
            // the caller can't resolve read as "connected" (the false-positive that
            // hid the workspace-scope bug and made the CLI skip the key prompt);
            // scoping to own-or-pod-wide keeps the signal truthful for members.
            or(eq(secrets.userId, userId), eq(secrets.isPodWide, true)),
            isNull(secrets.deletedAt)
          )
        );
      for (const r of rows) vaultExists.add(r.id);
    } catch {
      // Degrade: treat all as missing.
    }
  }

  return { providerConn, providerAvailable, vaultExists, reauthConnIds };
}

// ── Template loading (DB rows + on-disk family templates) ─────────────────────

interface TemplateEntry {
  key: string;
  name: string;
  description?: string | null;
  def: CapabilityDefinition;
}

/**
 * Load every available capability template definition. Reads from the pod-local
 * `capability_template_cache` (fast DB read, no network) — a stale-while-revalidate
 * mirror of the Control-Plane catalog, kept fresh by the background sync job. The
 * CP remains the SINGLE source of truth; the cache only ensures the catalog NEVER
 * blocks on the CP. On a cold first boot (empty cache) `fetchCPCapabilityTemplates`
 * does ONE inline CP fetch to populate it. Never throws — returns [] worst case.
 */
/**
 * @param extraKey — an explicit key/name to resolve even if it's excluded from
 * the default-sync list (syncByDefault=false, e.g. a paid third-party connector
 * like Unipile). Appended via ONE extra by-key CP lookup — see
 * `fetchCPCapabilityTemplateByKey`'s doc for why it's never merged into the
 * cached bulk list. No-op if already present or not found (never throws).
 */
async function loadTemplates(extraKey?: string): Promise<TemplateEntry[]> {
  const cpItems = await fetchCPCapabilityTemplates();
  const entries = cpItems.map((item) => ({
    key: item.key,
    name: item.name,
    description: item.description ?? null,
    def: item.definition,
  }));

  if (extraKey) {
    const lower = extraKey.toLowerCase();
    const alreadyPresent = entries.some(
      (t) => t.key.toLowerCase() === lower || t.name.toLowerCase() === lower
    );
    if (!alreadyPresent) {
      const byKey = await fetchCPCapabilityTemplateByKey(extraKey);
      if (byKey) {
        entries.push({
          key: byKey.key,
          name: byKey.name,
          description: byKey.description ?? null,
          def: byKey.definition,
        });
      }
    }
  }

  return entries;
}

// ── The builder ───────────────────────────────────────────────────────────────

export async function buildCapabilityCatalog(
  ctx: CapabilityCatalogContext
): Promise<CapabilityCard[]> {
  const { workspaceId, userId, extraKey } = ctx;

  // 1. Installed containers visible to the caller: pod-wide (NULL) + this
  //    workspace, narrowed by the user-visible predicate (membership floor).
  const containerRows = await db
    .select()
    .from(capabilities)
    .where(
      and(
        // Pod-wide (NULL) always; the active workspace's own containers ADD to
        // that when a lens is present. NO lens = the canonical FULL FLOOR (every
        // workspace the caller can see, via `userVisibleWhere`) — the same
        // three-state contract `listCapabilityCompositions` (Integrations) uses.
        // The prior `isNull(workspaceId)` narrowing hid the caller's OWN
        // workspace-scoped containers whenever no lens was active, so a
        // workspace-scoped standing capability (e.g. a bridge) showed in
        // Integrations but NOT here, and `nav('capability', id)` — which carries
        // no workspaceId — could not focus it and dumped the user on the list.
        workspaceId
          ? or(
              isNull(capabilities.workspaceId),
              eq(capabilities.workspaceId, workspaceId)
            )
          : undefined,
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
            description: skills.description,
            approved: skills.approved,
            parameters: skills.parameters,
            metadata: skills.metadata,
            category: skills.category,
          })
          .from(skills)
          .where(inArray(skills.id, memberSkillIds))
      : [];

  const toolById = new Map(toolRows.map((t) => [t.id, t]));
  const skillById = new Map(skillRows.map((s) => [s.id, s]));

  // 4. Available templates (DB + on-disk family set).
  const templates = await loadTemplates(extraKey);
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
    const myTools = myLinks
      .filter((l) => l.fromType === "tool")
      .map((l) => toolById.get(l.fromId))
      .filter((t): t is NonNullable<typeof t> => !!t);
    const myToolRefs = myTools.map((t) => t.credentialRef ?? null);

    const connection = deriveConnection(myToolRefs, false, conn);

    const mySkills = myLinks
      .filter((l) => l.fromType === "skill")
      .map((l) => skillById.get(l.fromId))
      .filter((s): s is NonNullable<typeof s> => !!s);

    const verbs: CapabilityCardVerb[] = mySkills.map((s) => {
      const type = verbType(s.name, s.metadata);
      const enabled = s.approved === true;
      // `skills.category` is the first-class column the capability applier
      // persists from the definition; `metadata.category` is a tolerated
      // fallback for rows tagged out-of-band.
      const category =
        s.category ??
        (typeof (s.metadata as Record<string, unknown> | null)?.category ===
        "string"
          ? ((s.metadata as Record<string, unknown>).category as string)
          : undefined);
      const connectionOk =
        !connection.required || connection.state === "connected";
      return {
        verbId: s.name,
        skillId: s.id,
        label: s.name,
        description: s.description ?? null,
        type,
        enabled,
        governance: verbGovernance(type),
        runnable: enabled && connectionOk,
        params: extractParamNames(s.parameters),
        paramsSchema: extractParamsSchema(s.parameters),
        ...(category ? { category } : {}),
      };
    });

    const credentialRef = myToolRefs.find((r): r is string => !!r);
    const anatomy: CapabilityCard["anatomy"] = {
      tools: myTools.map((t) => t.name),
      skills: mySkills.map((s) => s.name),
      ...(credentialRef ? { credential: credentialRef } : {}),
    };

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
      anatomy,
      installParams: matchedTemplate
        ? extractInstallParams(matchedTemplate.def)
        : [],
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
      // Honor an explicit `metadata.verbType` override on an AVAILABLE verb too —
      // it was previously only read for installed rows, so the same template
      // rendered a different `type` before vs after install.
      const type = verbType(s.name, s.metadata);
      return {
        verbId: s.name,
        skillId: null,
        label: s.name,
        description: s.description ?? null,
        type,
        enabled: false,
        governance: verbGovernance(type),
        runnable: false,
        params: extractParamNames(s.parameters),
        paramsSchema: extractParamsSchema(s.parameters),
        ...(s.category ? { category: s.category } : {}),
      };
    });

    const tplCredential =
      toolRefs.find((r): r is string => !!r) ??
      (hasVaultRequirement ? "vault" : undefined);
    const anatomy: CapabilityCard["anatomy"] = {
      tools: (def.tools ?? []).map((t) => t.name),
      skills: (def.skills ?? []).map((s) => s.name),
      ...(tplCredential ? { credential: tplCredential } : {}),
    };

    cards.push({
      id: null,
      key: tpl.key,
      name: tpl.name,
      description: tpl.description ?? null,
      source: "available",
      status: "available",
      ...(connection.required || connection.kind ? { connection } : {}),
      verbs,
      anatomy,
      installParams: extractInstallParams(def),
      nextAction: nextActionFor("available", tpl.name, connection),
    });
  }

  return cards;
}
