/**
 * Proposal SETUP — "what does this proposal still need from a human before it
 * can be applied", derived at READ time from the capability's own manifest.
 *
 * ── WHY IT IS DERIVED, NEVER STORED ─────────────────────────────────────────
 * The gap is a fact about the WORLD (is that vault key present? is that Nango
 * provider connected?), not about the proposal. A stored `missingSetup` snapshot
 * taken at file time would keep claiming "needs an API key" after the human adds
 * one — a queue item permanently marked blocked by a blocker that is gone. So
 * every read recomputes it and a satisfied gap simply disappears.
 *
 * ── REUSE, NOT A SECOND DERIVATION ──────────────────────────────────────────
 * Nothing here re-derives what the catalog already knows. It calls, verbatim:
 *   · `lookupCatalogEntry`   — the pod-local template cache row (marketplace-install)
 *   · `extractInstallParams` — manifest `params[]` → specs, WITH the `secret` flag
 *   · `loadConnState`        — live Nango connections + existing vault secret ids
 *   · `deriveConnection`     — credential refs + vault[] → {required,kind,provider,state}
 *   · `resolveCapabilityBlock` — the ONE "what unblocks this capability" resolver
 * A second copy of any of those is the defect this module exists to avoid.
 *
 * ── CONFIGURATION OVER CODE ─────────────────────────────────────────────────
 * There is NO per-capability branch anywhere in this file. A template that
 * declares a new param gets a new form field by existing; a template that
 * declares a `nango://` tool gets a connect step by existing.
 *
 * ── `capability.install` ONLY, AND WHY ──────────────────────────────────────
 * `capability.enable` was audited for the same gap and does NOT have it: its
 * payload is `{skillIds, toolIds}` — no slug, no `params`, nothing a manifest
 * could declare and nobody could have filled in. Its only possible blocker is a
 * connection, which is already answered on the capability CARD by the same
 * `resolveCapabilityBlock` this module calls. Claiming coverage of it here
 * would mean shipping a `setup` that is structurally always `{params: [],
 * blocking: false}` — a field that says "nothing needed" about a proposal
 * nobody asked. Add it the day `capability.enable` carries a manifest.
 *
 * ── VALUES NEVER CROSS THE WIRE ─────────────────────────────────────────────
 * A param's VALUE is never projected — only its name, its label, whether it is
 * `secret`, whether it is `satisfied`, and (when it is one) the `vault://<id>`
 * REF. A ref is a pointer, not a credential. An agent that inlined a raw key
 * into `data.params` must never have it shown back to a reviewer, which is the
 * whole reason `satisfied` is a BOOLEAN.
 */

import {
  deriveConnection,
  extractInstallParams,
  isSecretParamName,
  loadConnState,
  type CapabilityCardConnection,
} from "../capabilities/capability-catalog.js";
import {
  resolveCapabilityBlock,
  type CapabilityNextAction,
} from "../capabilities/capability-enable-link.js";
import { lookupCatalogEntry } from "../capabilities/marketplace-install.js";
import { fetchCPCapabilityTemplate } from "../capabilities/cp-template-client.js";
import { OFFICIAL_SOURCE_ID } from "@synap-core/types/marketplace-source";
import { ProposalStatus } from "@synap/database/schema";
import { isBlankParamValue } from "./setup-required-error.js";
import {
  makeVaultReference,
  parseVaultReference,
  vaultSecretIdOf,
} from "@synap-core/types/vault";
import type {
  CapabilityDefinition,
  CapabilityParamObtain,
} from "@synap/playbooks";

/** THE proposal type that carries a manifest-derived setup gap. See the docblock. */
export const SETUP_PROPOSAL_TYPE = "capability.install";

/** One manifest-declared install param, as a review surface sees it. */
export interface ProposalSetupParam {
  name: string;
  label?: string;
  type?: string;
  required: boolean;
  description?: string;
  /** Prompt masked and NEVER echo. Derived by `extractInstallParams`. */
  secret: boolean;
  /**
   * How a person gets this value: numbered steps and the https page they
   * start on, from the manifest's `obtain` (`param-obtain.ts`). Absent when
   * the manifest declares none, or an invalid one.
   */
  obtain?: CapabilityParamObtain;
  /** A non-blank value is present, OR a resolvable `vault://` ref is. */
  satisfied: boolean;
  /** `vault://<id>` when this param points at a vault secret. Never a value. */
  ref?: string;
  /**
   * The LABEL of the secret behind {@link ref} — its vault name, never a value.
   *
   * Why it exists: a ref projected alone renders as "Linked vault secret" on
   * every review surface, so approving a `capability.install` whose `apiKey` an
   * AGENT set to `vault://<some other secret of yours>` was BLIND consent — the
   * human could not tell which credential they were handing over. A name is the
   * minimum that makes the consent informed.
   *
   * Resolved under the SAME own-or-pod-wide, not-deleted predicate that decides
   * `satisfied`, so it can never disclose that someone else's secret exists.
   */
  refName?: string;
  /** The secret's category ("Stripe", "Google"), when it has one. Never a value. */
  refService?: string;
  /**
   * The ref does NOT resolve for this caller (deleted, or never theirs). The
   * surface must say "secret not found" rather than pre-filling the field as
   * satisfied — `satisfied` is already false in this case, and this says WHY.
   */
  refUnresolved?: boolean;
}

export interface ProposalSetup {
  params: ProposalSetupParam[];
  /** Absent when the manifest declares no credentialed tool and no `vault[]`. */
  connection?: CapabilityCardConnection;
  /** Any REQUIRED param unsatisfied, or a REQUIRED connection not `connected`. */
  blocking: boolean;
  /**
   * The ONE action that unblocks it, from `resolveCapabilityBlock`. Present only
   * for a CONNECTION block: a missing param's affordance is the form itself, and
   * minting a second hint vocabulary ("fill in API Key") beside the catalog's is
   * exactly the fork this codebase keeps paying for.
   */
  nextAction?: CapabilityNextAction;
  /**
   * The pod could NOT read the manifest of a proposal that is still to be
   * decided (not in the catalog cache, and the by-key read from the catalog
   * failed or found nothing): what it needs is UNKNOWN. `params` is then empty
   * and `blocking` true, never an invented "nothing needed". Proposal eaa77f7d
   * (github-merge, an opt-in capability the cache never holds) read as no
   * setup at all while its approval, which re-resolves by key, said "Needs
   * setup: GitHub token". Absent whenever the manifest was read.
   */
  unreadable?: true;
}

/** Still to be decided: the only rows whose setup a person can act on. */
function isActionable(row: Record<string, unknown>): boolean {
  return (
    row.status === ProposalStatus.PENDING ||
    row.status === ProposalStatus.APPROVAL_FAILED
  );
}

/**
 * A manifest read BY KEY from the catalog (`fetchCPCapabilityTemplate`, the
 * door the approval installs through), for an official package the cache
 * never held (an opt-in `syncByDefault:false` capability). Memoized briefly
 * per slug: a review list polls, and a miss costs a Control Plane round-trip
 * (8 s timeout) each time. A failed read is kept for a shorter time than a
 * found one, so a Control Plane that comes back is read again soon.
 */
const BY_KEY_TTL_MS = 5 * 60_000;
const BY_KEY_FAILED_TTL_MS = 60_000;
const byKeyMemo = new Map<
  string,
  { def: CapabilityDefinition | null; until: number }
>();

async function readDefinitionByKey(
  slug: string
): Promise<CapabilityDefinition | null> {
  const now = Date.now();
  const hit = byKeyMemo.get(slug);
  if (hit && hit.until > now) return hit.def;
  let def: CapabilityDefinition | null = null;
  try {
    def = await fetchCPCapabilityTemplate(slug);
  } catch {
    // A refused or failed read is not a manifest: the row says `unreadable`.
    def = null;
  }
  byKeyMemo.set(slug, {
    def,
    until: now + (def ? BY_KEY_TTL_MS : BY_KEY_FAILED_TTL_MS),
  });
  return def;
}

/** Tests only: forget the by-key reads. */
export function resetSetupDefinitionMemo(): void {
  byKeyMemo.clear();
}

/** The shape `data` must have for a setup to be derivable. */
function installTarget(
  row: { proposalType: string; data: unknown } | Record<string, unknown>
): {
  slug: string;
  params: Record<string, unknown>;
  name: string;
  source: string | null;
} | null {
  const r = row as { proposalType?: unknown; data?: unknown };
  if (r.proposalType !== SETUP_PROPOSAL_TYPE) return null;
  const data = (r.data ?? {}) as Record<string, unknown>;
  // Only the `capability` kind carries a CapabilityDefinition manifest with
  // `params[]`/`vault[]`/`tools[].credentialRef`. automation/template/cell
  // packages install without one — an honest absence, not a gap.
  if (data.kind !== "capability") return null;
  const slug = typeof data.slug === "string" ? data.slug : null;
  if (!slug) return null;
  const params =
    data.params && typeof data.params === "object"
      ? (data.params as Record<string, unknown>)
      : {};
  // The source the approval installs from (`runMarketInstall` stamps it);
  // absent on older rows, which were official.
  const source =
    typeof data.source === "string" && data.source ? data.source : null;
  return { slug, params, name: slug, source };
}

/**
 * Batch-derive `setup` for every `capability.install` row in a page.
 *
 * Returns a Map keyed by proposal id, with NO entry for a row that has no
 * derivable setup — an absent key means "not applicable", never "nothing
 * needed". A page with no install rows does ZERO database and ZERO broker work:
 * the early return is load-bearing, because `loadConnState` talks to Nango.
 *
 * A catalog cache MISS of an official package still to be decided (an opt-in
 * `syncByDefault:false` capability, or one just published) is read BY KEY from
 * the catalog, the same door its approval installs through, so the setup the
 * person sees is the one the approval will check. When that read fails too,
 * the row gets `{params: [], blocking: true, unreadable: true}`: what it needs
 * is unknown, which is neither "nothing needed" nor an absent setup a surface
 * would read as "no setup". A decided row on a miss keeps no entry (nothing is
 * left to hand over, and a history page never pays a Control Plane read).
 */
export async function resolveProposalSetups(
  rows: ReadonlyArray<Record<string, unknown>>,
  userId: string
): Promise<Map<string, ProposalSetup>> {
  const out = new Map<string, ProposalSetup>();

  const targets: Array<{
    id: string;
    /** `source` + slug: one manifest per package of one source. */
    key: string;
    slug: string;
    source: string | null;
    params: Record<string, unknown>;
    actionable: boolean;
  }> = [];
  for (const row of rows) {
    const t = installTarget(row);
    const id = typeof row.id === "string" ? row.id : null;
    if (t && id) {
      targets.push({
        id,
        key: `${t.source ?? OFFICIAL_SOURCE_ID}\u0000${t.slug}`,
        slug: t.slug,
        source: t.source,
        params: t.params,
        actionable: isActionable(row),
      });
    }
  }
  if (targets.length === 0) return out;

  // One cache read per DISTINCT package, not per row; a miss of an official
  // package still to be decided is read by key (see the docblock).
  const defByKey = new Map<string, CapabilityDefinition | null>();
  const distinct = new Map<string, (typeof targets)[number]>();
  for (const t of targets) {
    const seen = distinct.get(t.key);
    if (!seen || (t.actionable && !seen.actionable)) distinct.set(t.key, t);
  }
  await Promise.all(
    [...distinct.values()].map(async (t) => {
      let def: CapabilityDefinition | null = null;
      try {
        const entry = await lookupCatalogEntry("capability", t.slug, t.source);
        def = (entry?.definition as CapabilityDefinition | undefined) ?? null;
      } catch {
        // A failed cache read is NOT an empty manifest.
        def = null;
      }
      const official = !t.source || t.source === OFFICIAL_SOURCE_ID;
      if (!def && official && t.actionable) {
        def = await readDefinitionByKey(t.slug);
      }
      defByKey.set(t.key, def);
    })
  );

  // Every vault id the page could need, resolved in ONE `loadConnState` pass:
  // the ids params point at, plus the ids the manifests' tools already name.
  const vaultIds = new Set<string>();
  for (const t of targets) {
    const def = defByKey.get(t.key);
    if (!def) continue;
    for (const p of extractInstallParams(def)) {
      // Only a WELL-FORMED id may reach the lookup: a malformed pointer in
      // `inArray(uuidColumn, …)` throws a cast error the loader swallows, which
      // would read EVERY ref on the page as missing because of one bad row.
      // The lenient parse below still marks that param unresolved.
      const ref = vaultSecretIdOf(t.params[p.name]);
      if (ref) vaultIds.add(ref);
    }
    for (const tool of def.tools ?? []) {
      const ref = vaultSecretIdOf(tool.credentialRef);
      if (ref) vaultIds.add(ref);
    }
  }

  const conn = await loadConnState(userId, [...vaultIds]);

  for (const t of targets) {
    const def = defByKey.get(t.key);
    if (!def) {
      // Unknown manifest: say so on a row the person can still act on.
      if (t.actionable) {
        out.set(t.id, { params: [], blocking: true, unreadable: true });
      }
      continue;
    }

    const params: ProposalSetupParam[] = extractInstallParams(def).map((p) => {
      const raw = t.params[p.name];
      const ref = parseVaultReference(raw);
      // A declared `default` IS a value — `createCapabilityFromDefinition`
      // seeds it before the required-param guard runs, so a form that showed it
      // as unsatisfied would demand something the installer never needs.
      const declaredDefault = (def.params ?? []).find(
        (d) => d.name === p.name
      )?.default;
      const refResolved = ref ? conn.vaultExists.has(ref) : false;
      const refMeta = ref ? conn.vaultMeta.get(ref) : undefined;
      const satisfied = ref
        ? refResolved
        : !isBlankParamValue(raw) || !isBlankParamValue(declaredDefault);
      return {
        name: p.name,
        ...(p.label ? { label: p.label } : {}),
        ...(p.type ? { type: p.type } : {}),
        required: p.required === true,
        ...(p.description ? { description: p.description } : {}),
        secret: p.secret === true,
        ...(p.obtain ? { obtain: p.obtain } : {}),
        satisfied,
        ...(ref ? { ref: makeVaultReference(ref) } : {}),
        // LABELS ONLY. `refName`/`refService` come from the same scoped read
        // that decided `refResolved`, so an unresolvable ref carries neither —
        // it carries `refUnresolved` instead, which is a different fact from
        // "not filled in yet" and must not be folded into it.
        ...(refMeta?.name ? { refName: refMeta.name } : {}),
        ...(refMeta?.service ? { refService: refMeta.service } : {}),
        ...(ref && !refResolved ? { refUnresolved: true } : {}),
      };
    });

    const toolRefs = (def.tools ?? []).map(
      (tool) => tool.credentialRef ?? null
    );
    const hasVaultRequirement = (def.vault?.length ?? 0) > 0;
    const connection = deriveConnection(toolRefs, hasVaultRequirement, conn);
    // A vault-kind requirement is the SAME fact the params already carry — the
    // template's `vault[].value` is `{{param}}`. Surfacing it twice would make
    // a filled form still read "needs a connection". Only a PROVIDER connection
    // (OAuth, unfillable by a form) is a separate step.
    const providerConnection =
      connection.kind === "provider" ? connection : undefined;

    const paramsBlock = params.some((p) => p.required && !p.satisfied);
    const connectionBlock =
      providerConnection !== undefined &&
      providerConnection.required &&
      providerConnection.state !== "connected";

    out.set(t.id, {
      params,
      ...(providerConnection ? { connection: providerConnection } : {}),
      blocking: paramsBlock || connectionBlock,
      ...(connectionBlock
        ? (() => {
            const next = resolveCapabilityBlock({
              name: t.slug,
              containerId: null,
              connection: providerConnection,
              enabled: true,
            });
            return next ? { nextAction: next } : {};
          })()
        : {}),
    });
  }

  return out;
}

/** What a redacted secret param reads as on the wire. Never the value, never "". */
export const REDACTED_PARAM = "***REDACTED***";

/**
 * Strip the VALUE of every `secret` install param out of a proposal payload.
 *
 * THE hole this closes: `market.install` accepts `params` from the AGENT, and
 * nothing stopped an agent inlining a raw API key there. That payload is then
 * echoed back by `proposals.get`, the Hub REST `view=full` row, and the MCP
 * `detail:"full"` result — so a key an agent typed once became readable by
 * every later reader of the queue, including other agents.
 *
 * A `vault://<id>` ref is KEPT: it is a pointer, not a credential, and it is
 * precisely what the review form needs in order to show "already linked".
 *
 * Pure, and total over a missing/odd payload — a row whose `data.params` is not
 * an object is returned untouched rather than coerced.
 */
export function redactSecretParams<T>(data: T, setup: ProposalSetup): T {
  // No manifest, no `secret` flags: mask by NAME, as for an absent setup.
  if (setup.unreadable) return redactSecretParamsByName(data);
  const secretNames = setup.params.filter((p) => p.secret).map((p) => p.name);
  if (secretNames.length === 0) return data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const obj = data as Record<string, unknown>;
  const params = obj.params;
  if (!params || typeof params !== "object" || Array.isArray(params))
    return data;
  const src = params as Record<string, unknown>;
  let touched = false;
  const next: Record<string, unknown> = { ...src };
  for (const name of secretNames) {
    if (!(name in src)) continue;
    if (parseVaultReference(src[name])) continue; // a pointer, safe to keep
    if (isBlankParamValue(src[name])) continue; // nothing to hide
    next[name] = REDACTED_PARAM;
    touched = true;
  }
  return touched ? ({ ...obj, params: next } as T) : data;
}

/**
 * The FALLBACK redactor, for a row whose setup could NOT be derived.
 *
 * ## The hole this closes (round-2 review)
 *
 * Redaction was coupled to derivation: `resolveProposalSetups` does
 * `if (!def) continue`, so a `lookupCatalogEntry` MISS or THROW — an unsynced
 * or unpublished slug, or any slug an agent invents on `market.install` —
 * produced no map entry, `proposalSetupFields` returned `{}`, and the agent's
 * raw inlined `data.params` were echoed verbatim by `proposals.get`, the Hub
 * `view=full` row and the MCP `detail:"full"` result. The one case where we
 * know LEAST about the payload was the one case where we redacted NOTHING —
 * failing open on a security boundary.
 *
 * With no manifest there are no `secret` flags, so the only signal left is the
 * param NAME. It is the same signal `extractInstallParams` already trusts for
 * exactly this purpose, imported from its one home rather than re-written.
 *
 * Deliberately NOT gated on `proposalType === "capability.install"`: this runs
 * precisely when the row could not be identified, and a param called `apiKey`
 * on any proposal is better masked than echoed. Returns the SAME reference when
 * nothing was touched, so the caller's "empty spread" contract is unchanged.
 */
export function redactSecretParamsByName<T>(data: T): T {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const obj = data as Record<string, unknown>;
  const params = obj.params;
  if (!params || typeof params !== "object" || Array.isArray(params))
    return data;
  const src = params as Record<string, unknown>;
  let touched = false;
  const next: Record<string, unknown> = { ...src };
  for (const name of Object.keys(src)) {
    if (!isSecretParamName(name)) continue;
    if (parseVaultReference(src[name])) continue; // a pointer, not a value
    if (isBlankParamValue(src[name])) continue; // nothing to hide
    next[name] = REDACTED_PARAM;
    touched = true;
  }
  return touched ? ({ ...obj, params: next } as T) : data;
}

/**
 * The fields a read door stamps for one row — the setup, and the REDACTED
 * payload that must travel with it.
 *
 * The two go together ON PURPOSE. They are the same decision seen from two
 * sides ("these params are secret"), and a door that stamped the setup while
 * echoing the raw params would be the exact severance this codebase keeps
 * shipping: the flag that says "mask this" arriving beside the thing it was
 * supposed to mask. Returned as a PAIR, and only as a pair — the same reason
 * `proposalClassFields` returns `class` and `lifetimeHours` together.
 *
 * Empty object when the row has no derivable setup, so it spreads to a no-op.
 */
export function proposalSetupFields(
  id: unknown,
  data: unknown,
  setups: ReadonlyMap<string, ProposalSetup>
): { data?: unknown; setup?: ProposalSetup } {
  const setup = typeof id === "string" ? setups.get(id) : undefined;
  if (!setup) {
    // No setup ⇒ no `secret` flags to redact by. Fall back to the NAME
    // heuristic rather than passing the payload through raw — see
    // {@link redactSecretParamsByName}. `{}` only when nothing was touched,
    // so the no-op spread contract holds for every non-install row.
    const fallback = redactSecretParamsByName(data);
    return fallback === data ? {} : { data: fallback };
  }
  return { data: redactSecretParams(data, setup), setup };
}

/** Row-shaped convenience over {@link proposalSetupFields} — the codec doors' form. */
export function withProposalSetup<T extends Record<string, unknown>>(
  row: T,
  setups: ReadonlyMap<string, ProposalSetup>
): T & { setup?: ProposalSetup } {
  return { ...row, ...proposalSetupFields(row.id, row.data, setups) };
}
