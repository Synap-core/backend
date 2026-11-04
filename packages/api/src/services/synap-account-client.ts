/**
 * Which agent the "Synap account" connector (the Control Plane's MCP server,
 * mcp.synap.live) gets on this pod for each AI client (plan "one way to
 * connect an AI to Synap" W5, founder decision 3 of 4 Nov 2026: one agent per
 * person and client). Before W5 every client was the one `claude-web` agent.
 *
 * The Control Plane names the client at `/mcp/redeem` (`client.harness`,
 * derived from the client's OAuth registration), and the pod mints:
 *   - no client (a Control Plane that predates W5) → `claude-web`, unchanged;
 *   - claude.ai (`claude-ai`) → `claude-web`: it IS claude.ai's agent, so it
 *     keeps its history, rules and scorecard;
 *   - a registry client whose `doors` include `account` (`chatgpt`, `cursor`,
 *     `claude-code`; a longer CP slug such as `claude-code-cp` maps to its
 *     registry slug) → that agentType, "ChatGPT via Synap account";
 *   - anything else, a pod-only client included → `generic`, the registry's
 *     named fallback, "Other AI clients via Synap account" (the key still
 *     carries the client's own name). The name is the client's own claim.
 *
 * The agent has its own identity (review bf96d410, lane B): no computer
 * (`hostUserId` null) and the seat `SYNAP_ACCOUNT_SEAT`, so it is never the
 * agent `/setup/agent` or `synap connect` makes, nor one a computer adopts.
 *
 * Which keys the connector holds is told by the key: `/mcp/redeem` alone
 * stamps `api_keys.origin` with {@link SYNAP_ACCOUNT_KEY_ORIGIN} (0400), and
 * readers that ask "is this the connector?" (`/mcp/revoke`'s floor, the skill
 * door) use {@link isSynapAccountKey}.
 */

import { AGENT_HARNESSES, resolveHarness } from "@synap-core/types/agents";

/** The agentType every Synap account key had before W5, and claude.ai's since. */
const SYNAP_ACCOUNT_LEGACY_AGENT_TYPE = "claude-web";

/** The registry's named fallback for a client it does not know. */
const SYNAP_ACCOUNT_FALLBACK_AGENT_TYPE = "generic";

/** `api_keys.origin` of a key `/mcp/redeem` minted; no other door writes it. */
export const SYNAP_ACCOUNT_KEY_ORIGIN = "synap-account";

/** The CP harness of claude.ai (control-plane-api `CLAUDE_AI_HARNESS`). */
const CLAUDE_AI_HARNESS = "claude-ai";

/** A harness as the Control Plane sends it: a lowercase slug. */
const HARNESS_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** What `/mcp/redeem` mints for one client. */
export interface SynapAccountMint {
  agentType: string;
  agentLabel: string;
  keyName: string;
  keyDescription: string;
  agentDescription: string;
}

/** The client a Control Plane names at `/mcp/redeem`; absent before W5. */
export interface SynapAccountClient {
  harness?: unknown;
  name?: unknown;
}

const LEGACY_MINT: SynapAccountMint = {
  agentType: SYNAP_ACCOUNT_LEGACY_AGENT_TYPE,
  agentLabel: "Claude (Web)",
  keyName: "Claude Web Hub Key",
  keyDescription:
    "Hub Protocol auth token for claude-web MCP agent — created via CP-MCP pod-accept",
  agentDescription: "Claude (claude.ai web) — external MCP agent",
};

/** The registry slugs a client can reach through the Synap account. */
const ACCOUNT_DOOR_SLUGS = AGENT_HARNESSES.filter((h) =>
  h.doors.includes("account")
).map((h) => h.slug);

/**
 * The registry slug a CP harness names, among the clients whose `doors`
 * include `account`: itself, else the longest such slug it starts with
 * (`claude-code-cp` → `claude-code`), else null. A pod-only client (`grok`,
 * `raycast`…) is never minted from the connector: it gets `generic`.
 */
export function registrySlugForHarness(harness: string): string | null {
  if (ACCOUNT_DOOR_SLUGS.includes(harness)) return harness;
  const prefixed = ACCOUNT_DOOR_SLUGS.filter((slug) =>
    harness.startsWith(`${slug}-`)
  ).sort((a, b) => b.length - a.length);
  return prefixed[0] ?? null;
}

/** The agent and key `/mcp/redeem` mints for the client the Control Plane named. */
export function resolveSynapAccountMint(
  client: SynapAccountClient | null | undefined
): SynapAccountMint {
  // No client named at all: a Control Plane before W5, whose only client was
  // claude.ai. A client named in any other way is never silently claude-web.
  if (client?.harness === undefined || client.harness === null) {
    return LEGACY_MINT;
  }
  const harness =
    typeof client.harness === "string" ? client.harness.trim() : "";
  if (harness === CLAUDE_AI_HARNESS) return LEGACY_MINT;

  const name =
    typeof client.name === "string" && client.name.trim()
      ? client.name.trim().slice(0, 80)
      : null;
  const slug = HARNESS_RE.test(harness)
    ? registrySlugForHarness(harness)
    : null;
  const known = slug ? resolveHarness(slug) : null;
  if (known) {
    return {
      agentType: known.slug,
      agentLabel: `${known.label} via Synap account`,
      keyName: `${name ?? known.label} via Synap account`,
      keyDescription: `Hub Protocol key held by the Synap account connector for ${name ?? known.label}`,
      agentDescription: `${known.label}, connected through the Synap account (mcp.synap.live)`,
    };
  }
  const shown = name ?? "An AI client";
  return {
    agentType: SYNAP_ACCOUNT_FALLBACK_AGENT_TYPE,
    agentLabel: "Other AI clients via Synap account",
    keyName: `${shown} via Synap account`,
    keyDescription: `Hub Protocol key held by the Synap account connector for ${shown}`,
    agentDescription:
      "AI clients the harness registry does not name, connected through the Synap account (mcp.synap.live)",
  };
}

/**
 * Is this key held by the Synap account connector? Read from the key's origin,
 * which only `/mcp/redeem` writes (0400 backfilled the keys minted before it).
 * An instanceId is never evidence: any `/setup/agent` caller could send one.
 */
export function isSynapAccountKey(key: { origin?: string | null }): boolean {
  return key.origin === SYNAP_ACCOUNT_KEY_ORIGIN;
}
