/**
 * Market risk disclosure — what a package brings that a person should see
 * before it runs on their pod: CODE (cells, code skills), NETWORK reach (the
 * hosts it names), CONNECTORS (credentials, providers, MCP servers) and, among
 * those, the pod's EXISTING provider connections it would use (a `nango://`
 * ref or a `providerConfigKey` binds a tool to the connection the pod already
 * has for that provider — the owner's own Gmail, say). Read off the definition
 * the install will apply. Pure.
 *
 * Deliberately over-inclusive: the walk is structural, not kind-by-kind, so a
 * template's nested cells and capabilities are found as well as a lone cell's.
 * It discloses what the definition DECLARES — it is not a sandbox and does not
 * promise the absence of anything it did not find. The walk is bounded; a
 * definition too large or too deep to read to the end is reported `incomplete`
 * and then FAILS CLOSED: code, network reach and existing connections are all
 * treated as present.
 *
 * A package from a TRUSTED third-party source needs an extra, explicit
 * confirm for code, for network reach and for using existing connections
 * (`requiredAcknowledgements`); the install door refuses without it
 * (marketplace-install.ts).
 */

import { resolveServiceName } from "@synap-core/types/service-marks";

export interface MarketRisks {
  /** Names of the parts that carry code (a cell's renderer, a code skill). */
  code: string[];
  /** Hosts the package names: declared egress and every URL it carries. */
  networkHosts: string[];
  /** Credentials, providers and servers it asks to connect. */
  connectors: string[];
  /**
   * The services whose EXISTING connection on this pod it would use, by name
   * (`Gmail`): every `nango://<provider>` ref and `providerConfigKey` it
   * carries. Those bind to the connection the pod already has, not a new one.
   */
  connections: string[];
  /**
   * Set (true) only when the walk ran out of budget before it read the whole
   * definition, so the lists above may be missing entries. Code, network reach
   * and existing connections then count as present (`requiredAcknowledgements`).
   */
  incomplete?: true;
}

/** The sentence a person and a reviewer read when the walk could not finish. */
export const INCOMPLETE_RISK_NOTICE =
  "This package is too large to inspect fully.";

/** Which extra confirms an install needs. */
export interface MarketAcknowledgement {
  code?: boolean;
  network?: boolean;
  connectors?: boolean;
}

const MAX_NODES = 50_000;
const MAX_DEPTH = 24;
const CONNECTOR_KEYS = new Set([
  "provider",
  "providerKey",
  "connector",
  "connectorKey",
  "integration",
  "credentialRef",
]);

type Bag = Record<string, unknown>;

function isBag(v: unknown): v is Bag {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function label(node: Bag | null): string {
  if (!node) return "package";
  for (const key of ["displayName", "name", "key", "slug"]) {
    const v = node[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "package";
}

const NANGO_REF = /^nango:\/\/(.+)$/i;

function hostOf(value: string): string | null {
  if (!/^(https?|wss?):\/\//i.test(value)) return null;
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

/** Walk a definition and collect what it brings. Pure; bounded. */
export function assessMarketRisks(definition: unknown): MarketRisks {
  const code = new Set<string>();
  const hosts = new Set<string>();
  const connectors = new Set<string>();
  const connections = new Set<string>();
  const addConnection = (provider: string) => {
    const name = resolveServiceName(provider.trim());
    if (name) connections.add(name);
  };
  let nodes = 0;
  let incomplete = false;

  const walk = (value: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
      incomplete = true;
      return;
    }
    if (typeof value === "string") {
      const host = hostOf(value);
      if (host) hosts.add(host);
      const provider = NANGO_REF.exec(value.trim())?.[1];
      if (provider) addConnection(provider);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!isBag(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "code" && typeof child === "string" && child.trim()) {
        code.add(label(value));
      } else if (key === "kind" && child === "code") {
        code.add(label(value));
      } else if (key === "externalHosts" && Array.isArray(child)) {
        for (const h of child) {
          if (typeof h === "string" && h.trim()) {
            hosts.add(hostOf(h) ?? h.trim());
          }
        }
        continue;
      } else if (
        CONNECTOR_KEYS.has(key) &&
        typeof child === "string" &&
        child.trim()
      ) {
        connectors.add(child.trim());
      } else if (
        key === "providerConfigKey" &&
        typeof child === "string" &&
        child.trim()
      ) {
        addConnection(child);
      } else if (key === "vault" && Array.isArray(child)) {
        for (const item of child) {
          if (isBag(item)) connectors.add(`secret: ${label(item)}`);
        }
      } else if (key === "mcpServers" && Array.isArray(child)) {
        for (const item of child) {
          if (isBag(item)) connectors.add(`MCP server: ${label(item)}`);
        }
      }
      walk(child, depth + 1);
    }
  };

  walk(definition, 0);
  return {
    code: [...code].sort(),
    networkHosts: [...hosts].sort(),
    connectors: [...connectors].sort(),
    connections: [...connections].sort(),
    ...(incomplete ? { incomplete: true as const } : {}),
  };
}

/** The extra confirms a trusted third-party install needs, from its risks. */
export function requiredAcknowledgements(
  risks: MarketRisks
): Required<MarketAcknowledgement> {
  return {
    code: risks.incomplete || risks.code.length > 0,
    network: risks.incomplete || risks.networkHosts.length > 0,
    connectors: risks.incomplete || risks.connections.length > 0,
  };
}

/** "Gmail" / "Gmail and Slack" / "Gmail, Notion and Slack". */
function joinNames(names: string[]): string {
  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The confirms still missing, as plain sentences (empty = nothing missing). */
export function missingAcknowledgements(
  risks: MarketRisks,
  given: MarketAcknowledgement | undefined
): string[] {
  const need = requiredAcknowledgements(risks);
  const missing: string[] = [];
  if (need.code && given?.code !== true) {
    missing.push(
      risks.code.length > 0
        ? `It runs code (${risks.code.join(", ")}) — confirm that you accept that.`
        : "It may run code — confirm that you accept that."
    );
  }
  if (need.network && given?.network !== true) {
    missing.push(
      risks.networkHosts.length > 0
        ? `It can reach ${risks.networkHosts.join(", ")} — confirm that you accept that.`
        : "It may reach the network — confirm that you accept that."
    );
  }
  if (need.connectors && given?.connectors !== true) {
    missing.push(
      risks.connections.length > 0
        ? `It can use your existing ${joinNames(risks.connections)} connection${risks.connections.length === 1 ? "" : "s"} — confirm that you accept that.`
        : "It may use connections this pod already has — confirm that you accept that."
    );
  }
  if (missing.length > 0 && risks.incomplete) {
    missing.unshift(INCOMPLETE_RISK_NOTICE);
  }
  return missing;
}

/** One-line disclosures a reviewer reads on a proposal or a preflight. */
export function riskNotices(risks: MarketRisks): string[] {
  const out: string[] = [];
  if (risks.incomplete) out.push(INCOMPLETE_RISK_NOTICE);
  if (risks.code.length > 0) out.push(`Runs code: ${risks.code.join(", ")}.`);
  if (risks.networkHosts.length > 0) {
    out.push(`Can reach: ${risks.networkHosts.join(", ")}.`);
  }
  if (risks.connectors.length > 0) {
    out.push(`Connects: ${risks.connectors.join(", ")}.`);
  }
  if (risks.connections.length > 0) {
    out.push(
      `Uses your existing ${joinNames(risks.connections)} connection${risks.connections.length === 1 ? "" : "s"}.`
    );
  }
  return out;
}
