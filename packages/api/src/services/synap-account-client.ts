/**
 * Which agent the "Synap account" connector (the Control Plane's MCP server,
 * mcp.synap.live) gets on this pod for each AI client (plan "one way to
 * connect an AI to Synap" W5, founder decision 3 of 4 Nov 2026: one agent per
 * person and client).
 *
 * Until W5 every client behind that connector was ONE agent, `claude-web`
 * ("Claude (Web)"): Grok, ChatGPT, claude.ai and Cursor shared its scorecard,
 * its rate-limit bucket and its revoke. The Control Plane now names the client
 * at `/mcp/redeem` (`client.harness`, derived from the client's OAuth
 * registration), and the pod mints that client's own agent:
 *   - no client (a Control Plane that predates W5) → `claude-web`, unchanged;
 *   - claude.ai (`claude-ai`) → `claude-web`: it IS claude.ai's agent, so it
 *     keeps its history, rules and scorecard;
 *   - a client the harness registry knows (`grok`, `chatgpt`, `cursor`…; a
 *     longer CP slug such as `raycast-mcp-client` or `claude-code-cp` maps to
 *     its registry slug) → that agentType, "Grok via Synap account";
 *   - anything else → `generic`, the registry's named fallback, "Other AI
 *     clients via Synap account" (the key still carries the client's own name).
 * The agent is host-less (`hostUserId` null): it runs on no computer of the
 * person's, so it is never the same agent as the one `synap connect grok`
 * makes for a computer.
 *
 * Which keys the connector holds is told by the key, not the agent: the
 * Control Plane redeems every key with an instanceId `mcp:<cp user>:<pod>[:
 * <client>]` (control-plane-api `lib/mcp-client-grants.ts`). Readers that ask
 * "is this the connector?" (`/mcp/revoke`'s floor, the skill door) use
 * {@link isSynapAccountKey}.
 */

import { AGENT_HARNESSES, resolveHarness } from "@synap-core/types/agents";

/** The agentType every Synap account key had before W5, and claude.ai's since. */
export const SYNAP_ACCOUNT_LEGACY_AGENT_TYPE = "claude-web";

/** The registry's named fallback for a client it does not know. */
export const SYNAP_ACCOUNT_FALLBACK_AGENT_TYPE = "generic";

/** Every key the Control Plane redeems carries an instanceId with this prefix. */
export const SYNAP_ACCOUNT_INSTANCE_PREFIX = "mcp:";

/** The CP harness of claude.ai (control-plane-api `CLAUDE_AI_HARNESS`). */
const CLAUDE_AI_HARNESSES = new Set(["claude-ai", "claude"]);

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

/**
 * The registry slug a CP harness names: itself, else the longest registry slug
 * it starts with (`raycast-mcp-client` → `raycast`, `claude-code-cp` →
 * `claude-code`), else null.
 */
export function registrySlugForHarness(harness: string): string | null {
  if (resolveHarness(harness)) return harness;
  const prefixed = AGENT_HARNESSES.map((h) => h.slug)
    .filter((slug) => harness.startsWith(`${slug}-`))
    .sort((a, b) => b.length - a.length);
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
  if (CLAUDE_AI_HARNESSES.has(harness)) return LEGACY_MINT;

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
 * Is this key held by the Synap account connector? Every key the Control
 * Plane redeems carries an `mcp:` instanceId; a pre-W5 key is also told by its
 * agent (`claude-web`, the only agent that door minted).
 */
export function isSynapAccountKey(key: {
  agentType?: string | null;
  instanceId?: string | null;
}): boolean {
  return (
    key.agentType === SYNAP_ACCOUNT_LEGACY_AGENT_TYPE ||
    (key.instanceId?.startsWith(SYNAP_ACCOUNT_INSTANCE_PREFIX) ?? false)
  );
}
