/**
 * Market risk disclosure — what a package brings that a person should see
 * before it runs on their pod: CODE (cells, code skills), NETWORK reach (the
 * hosts it names) and CONNECTORS (credentials, providers, MCP servers). Read
 * off the definition the install will apply. Pure.
 *
 * Deliberately over-inclusive: the walk is structural, not kind-by-kind, so a
 * template's nested cells and capabilities are found as well as a lone cell's.
 * It discloses what the definition DECLARES — it is not a sandbox and does not
 * promise the absence of anything it did not find.
 *
 * A package from a TRUSTED third-party source needs an extra, explicit
 * confirm for code and for network reach (`requiredAcknowledgements`); the
 * install door refuses without it (marketplace-install.ts).
 */

export interface MarketRisks {
  /** Names of the parts that carry code (a cell's renderer, a code skill). */
  code: string[];
  /** Hosts the package names: declared egress and every URL it carries. */
  networkHosts: string[];
  /** Credentials, providers and servers it asks to connect. */
  connectors: string[];
}

/** Which extra confirms an install needs. */
export interface MarketAcknowledgement {
  code?: boolean;
  network?: boolean;
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
  let nodes = 0;

  const walk = (value: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return;
    if (typeof value === "string") {
      const host = hostOf(value);
      if (host) hosts.add(host);
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
  };
}

/** The extra confirms a trusted third-party install needs, from its risks. */
export function requiredAcknowledgements(
  risks: MarketRisks
): Required<MarketAcknowledgement> {
  return {
    code: risks.code.length > 0,
    network: risks.networkHosts.length > 0,
  };
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
      `It runs code (${risks.code.join(", ")}) — confirm that you accept that.`
    );
  }
  if (need.network && given?.network !== true) {
    missing.push(
      `It can reach ${risks.networkHosts.join(", ")} — confirm that you accept that.`
    );
  }
  return missing;
}

/** One-line disclosures a reviewer reads on a proposal or a preflight. */
export function riskNotices(risks: MarketRisks): string[] {
  const out: string[] = [];
  if (risks.code.length > 0) out.push(`Runs code: ${risks.code.join(", ")}.`);
  if (risks.networkHosts.length > 0) {
    out.push(`Can reach: ${risks.networkHosts.join(", ")}.`);
  }
  if (risks.connectors.length > 0) {
    out.push(`Connects: ${risks.connectors.join(", ")}.`);
  }
  return out;
}
