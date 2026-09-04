/**
 * capability-enable-link — the ONE resolver for "what is blocking this
 * capability, and where does the human unblock it".
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Measured on the live pod (2026-09-03): 0 of 11 capability containers are
 * approved, so every verb reads `granted:false` / `effectiveExecMode:"propose"`.
 * The mechanism to fix that has existed all along — the blocker was that an
 * agent hitting the wall had no way to hand the human an actionable next step.
 * The information (granted / connected / containerId) was already computed and
 * already returned; only the LINK back to a human was missing.
 *
 * ── ONE RESOLVER, NOT A SECOND ONE ───────────────────────────────────────────
 * `nextActionFor` in `capability-catalog.ts` was already the "what is blocking
 * this" resolver — status → { kind, hint } — but it was card-only, had no link,
 * and nothing on the agent path could reach it. It MOVED here verbatim
 * (`capabilityNextAction`, hint strings byte-identical so the CLI contract that
 * matches them does not shift) and `capability-catalog.ts` now imports it. The
 * agent-facing doors reach the same function through `resolveCapabilityBlock`,
 * which normalises the (connected, enabled) signals the registry/execute paths
 * carry into the same status the card computes.
 *
 * ── THE LINK IS DESKTOP-ONLY, AND IT SAYS SO ─────────────────────────────────
 * `openTypedLink("capability", id)` → `${PUBLIC_URL}/open/capability/<id>`.
 * Verified end to end:
 *   · `apps/api` serves `/open/:type/:id` for every `TYPED_OPEN_KIND`, and
 *     `capability` is now one (locked against pod-admin by open-kinds.lock.test).
 *   · The route BOUNCES to `synap://open/capability/<id>` (it does not 302 to
 *     pod-admin the way a proposal does — pod-admin hosts only entity/view).
 *   · `browser/`'s `resolveDeepLink` keeps NO kind allowlist and hands the head
 *     segment straight to `objectNavTarget`, whose `case 'capability'` opens
 *     `CapabilitiesApp` with `initialFocus:{kind:'capability',key:id}`; the
 *     container UUID resolves against `card.id` (focus-route.ts).
 *   · That surface carries BOTH affordances: `onToggleVerb` →
 *     `trpc.skills.setApproved` (ENABLE) and `onConnect` → Nango Connect
 *     (CONNECT). So the link lands where the thing can actually be done.
 *
 * What does NOT exist: a pod-admin (web) route for enabling a capability or
 * connecting a provider. `/proposal/<id>` has a web destination; a capability
 * does not — `(admin)/connectors` is an explicitly read-only aggregate whose own
 * docstring says per-workspace connector configuration lives in Studio. So this
 * link works for a human WITH the desktop app and dead-ends for one without.
 * `opensIn: "desktop"` states that in the payload rather than implying a
 * universality the route does not have. Closing that gap is a pod-admin change,
 * not a link change — never paper over it by minting a new URL shape.
 */

import { openTypedLink } from "../../utils/deep-links.js";
import type {
  CapabilityCardConnection,
  CapabilityCardStatus,
} from "./capability-catalog.js";

/**
 * Where the link opens. Only `"desktop"` today, and it is not decoration: the
 * `/open/capability/<id>` route bounces to `synap://`, so a human without the
 * desktop app cannot follow it. A future pod-admin capability route would add a
 * `"web"` value here — until then, claiming one would be a lie.
 */
export type CapabilityActionSurface = "desktop";

export interface CapabilityNextAction {
  kind: "add" | "connect" | "enable" | "run" | "none";
  hint: string;
  /**
   * Deep link to the capability's own card — where `kind` is performed.
   * Absent for a brick in NO container (`containerId` null): there is no card
   * to open, and a link to a route that resolves to nothing is worse than none.
   */
  url?: string;
  /** Present exactly when `url` is. See `CapabilityActionSurface`. */
  opensIn?: CapabilityActionSurface;
}

/**
 * The link half, alone. `undefined` for an un-packaged brick — `containerId` is
 * legitimately null for a tool/skill in no container, and that is a real answer,
 * not a missing one (see `RegistryCapability.containerId`).
 */
export function capabilityCardLink(
  containerId: string | null | undefined
): Pick<CapabilityNextAction, "url" | "opensIn"> {
  if (!containerId) return {};
  return { url: openTypedLink("capability", containerId), opensIn: "desktop" };
}

/**
 * status → the one action that unblocks it, plus the link to where it is done.
 *
 * MOVED from `capability-catalog.ts`'s `nextActionFor` — hint strings verbatim.
 * `add` and `none` carry no link on purpose: an AVAILABLE template has no
 * installed container to open, and `unavailable` has no action at all.
 */
export function capabilityNextAction(
  status: CapabilityCardStatus,
  name: string,
  connection?: CapabilityCardConnection,
  containerId?: string | null
): CapabilityNextAction {
  const link = capabilityCardLink(containerId);
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
          ...link,
        };
      }
      return {
        kind: "connect",
        hint: prov
          ? `Connect ${prov} (OAuth) to enable "${name}".`
          : `Connect the credential for "${name}".`,
        ...link,
      };
    }
    case "connected":
      return {
        kind: "enable",
        hint: `Enable verbs for "${name}" — connection is ready.`,
        ...link,
      };
    case "draft":
      return { kind: "enable", hint: `Enable verbs for "${name}".`, ...link };
    case "partial":
      return {
        kind: "enable",
        hint: `Enable the remaining verbs for "${name}".`,
        ...link,
      };
    case "ready":
      return { kind: "run", hint: `Run a verb of "${name}".`, ...link };
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

/**
 * The agent-facing entry point: the two runtime signals a discovery/execute path
 * actually carries, folded into the SAME status the card computes.
 *
 * APPROVE AND CONNECT ARE NOT THE SAME FIX and must never be collapsed. A
 * container that is approved but whose connection is dead needs an ACCOUNT, not
 * an approval; a connected container whose verbs are unapproved needs the
 * approval. Connection is checked FIRST — byte-identical to
 * `computeInstalledStatus`, which gates on `connectionOk` before counting
 * enabled verbs — so a capability that is both unconnected AND unenabled is
 * reported as `connect`, the step that has to happen first.
 *
 * Returns `undefined` when NOTHING is blocking: a resolver that always answers
 * teaches a caller to render an action for a capability that is already ready.
 */
export function resolveCapabilityBlock(input: {
  /** Human name of the capability — never a raw id. */
  name: string;
  /** Owning container; `null` for an un-packaged brick (link is then omitted). */
  containerId?: string | null;
  /** Connection state, when the capability has one. */
  connection?: CapabilityCardConnection | null;
  /** Whether the capability may actually run (granted / approved). */
  enabled: boolean;
}): CapabilityNextAction | undefined {
  const { name, containerId, connection, enabled } = input;

  if (connection?.required && connection.state !== "connected") {
    return capabilityNextAction(
      connection.state === "unavailable" ? "unavailable" : "needs_connection",
      name,
      connection,
      containerId
    );
  }
  if (!enabled) {
    return capabilityNextAction(
      connection?.required ? "connected" : "draft",
      name,
      connection ?? undefined,
      containerId
    );
  }
  return undefined;
}

/**
 * Adapt the REGISTRY's connection shape (`{required, connected, provider}` —
 * `RegistryCapability.connection`) to the CATALOG's (`{required, kind, state,
 * provider}`). Two shapes for one fact is pre-existing debt; converting in ONE
 * place is what stops a third from appearing at each call site.
 */
export function connectionFromRegistry(
  conn: { required: boolean; connected: boolean; provider?: string } | undefined
): CapabilityCardConnection | undefined {
  if (!conn) return undefined;
  return {
    required: conn.required,
    kind: "provider",
    ...(conn.provider ? { provider: conn.provider } : {}),
    state: conn.connected ? "connected" : "missing",
  };
}
