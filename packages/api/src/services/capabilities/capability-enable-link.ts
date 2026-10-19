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
 * ── WHERE THE LINK OPENS, PER ACTION ─────────────────────────────────────────
 * `openTypedLink("capability", id)` → `${PUBLIC_URL}/open/capability/<id>`.
 * Verified end to end:
 *   · `apps/api` serves `/open/:type/:id` for every `TYPED_OPEN_KIND`, and
 *     `capability` is one (locked against pod-admin by open-kinds.lock.test).
 *   · A signed-in human is 302'd to pod-admin's `/open/capability/<id>`, which
 *     shows the capability's state and lets whoever the pod allows turn its
 *     verbs on (`capabilities.setToolEnabled`, the same gate as everywhere).
 *   · A bot or a `?client=mobile` link bounces to `synap://open/capability/<id>`;
 *     the desktop's `CapabilitiesApp` carries both affordances (ENABLE and
 *     Nango CONNECT).
 *
 * CONNECTING an account is not on the web: pod-admin has no Nango Connect
 * frontend, so its page says "Connect in the app" for that step. `opensIn`
 * states which client can perform THIS action — `"web"` for enable / run /
 * none (the web page does them, or there is nothing to do), `"desktop"` for
 * connect — rather than implying a universality the web page does not have.
 * The URL is the same either way; never mint a second URL shape for it.
 */

import { openTypedLink } from "../../utils/deep-links.js";
import type {
  CapabilityCardConnection,
  CapabilityCardStatus,
} from "./capability-catalog.js";

/**
 * Which client can perform the action the link is for. `"web"`: the pod's own
 * `/open/capability/<id>` page does it in any browser (turning verbs on, or
 * reading a capability that needs nothing). `"desktop"`: only the desktop app
 * can (connecting an account — the web has no Connect flow).
 */
export type CapabilityActionSurface = "web" | "desktop";

/** The ONE rule: connecting an account needs the app; everything else is on the web. */
export function capabilityActionSurface(
  kind: CapabilityNextAction["kind"]
): CapabilityActionSurface {
  return kind === "connect" ? "desktop" : "web";
}

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
 * The link half, alone, for the action `kind`. `{}` for an un-packaged brick —
 * `containerId` is legitimately null for a tool/skill in no container, and that
 * is a real answer, not a missing one (see `RegistryCapability.containerId`).
 */
export function capabilityCardLink(
  containerId: string | null | undefined,
  kind: CapabilityNextAction["kind"]
): Pick<CapabilityNextAction, "url" | "opensIn"> {
  if (!containerId) return {};
  return {
    url: openTypedLink("capability", containerId),
    opensIn: capabilityActionSurface(kind),
  };
}

/**
 * status → the one action that unblocks it, plus the link to where it is done.
 *
 * MOVED from `capability-catalog.ts`'s `nextActionFor` — hint strings verbatim.
 * `add` and `none` carry no link on purpose: an AVAILABLE template has no
 * installed container to open, and `unavailable` has no action at all.
 *
 * `launchable` — whether the execute door can launch at least one of this
 * card's verbs, judged by the shared runnable-action projection
 * (`action-projection.ts`, via `runnableVerbIdsByContainer`). `ready` only means
 * "every verb is enabled"; it becomes `run` ONLY when that projection agrees.
 * `false` → `none` with the reason. `undefined` = not measured by this caller
 * (the agent-path doors below never reach `ready`), which keeps `run`.
 */
export function capabilityNextAction(
  status: CapabilityCardStatus,
  name: string,
  connection?: CapabilityCardConnection,
  containerId?: string | null,
  launchable?: boolean
): CapabilityNextAction {
  const link = (kind: CapabilityNextAction["kind"]) =>
    capabilityCardLink(containerId, kind);
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
          ...link("connect"),
        };
      }
      return {
        kind: "connect",
        hint: prov
          ? `Connect ${prov} (OAuth) to enable "${name}".`
          : `Connect the credential for "${name}".`,
        ...link("connect"),
      };
    }
    // The `enable` hints are shown VERBATIM (browser activity rows read
    // `fixHint`, the refusal body carries `enable.hint`) and always sit beside
    // the capability they describe, so they name no capability: a container
    // name can be a raw token ("google"), and "verbs" is our jargon, not the
    // person's word. `kind: "enable"` is what a UI branches on.
    case "connected":
      return {
        kind: "enable",
        hint: "Connected, but its actions are off. Turn them on to use it.",
        ...link("enable"),
      };
    case "draft":
      return {
        kind: "enable",
        hint: "Its actions are off. Turn them on to use it.",
        ...link("enable"),
      };
    case "partial":
      return {
        kind: "enable",
        hint: "Some of its actions are off. Turn them on to use them.",
        ...link("enable"),
      };
    case "ready":
      if (launchable === false) {
        return {
          kind: "none",
          hint: `Every verb of "${name}" is enabled, but none can be launched through the execute door yet — no verb has an active, approved backing skill on an approved tool.`,
          ...link("none"),
        };
      }
      return { kind: "run", hint: `Run a verb of "${name}".`, ...link("run") };
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
