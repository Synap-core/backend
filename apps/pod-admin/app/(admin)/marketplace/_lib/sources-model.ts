/**
 * Marketplace › Sources — the pure shaping between `marketplace.sources.*`
 * and what the console says (Pod Console D11). No React, so every sentence
 * is tested.
 *
 * Trust words and their consequences come from ONE place,
 * `@synap-core/types/marketplace-source` — the module the pod's install door
 * enforces — so the console can never describe a trust level the server does
 * not apply.
 */

import {
  TRUST_LABEL,
  formatKeyFingerprint,
  type MarketplaceTrust,
} from "@synap-core/types/marketplace-source";
import { formatDate, formatRelative } from "../../../../lib/format";
import type { StatusKind } from "../../components/status-pill";
import type { CatalogDetail, MarketPreflight, MarketSource } from "./types";

/** The chip word for a trust level. */
export function trustLabel(trust: MarketplaceTrust): string {
  return TRUST_LABEL[trust];
}

/** The host a person recognises, from a source's address. */
export function sourceHost(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .replace(/\/synap-index\.json$/, "")
      .replace(/\/$/, "");
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

/**
 * The pill a source row carries — none when it is healthy (an empty slot
 * reads "all good"), otherwise what is wrong in a few words.
 */
export function sourcePill(
  source: Pick<MarketSource, "state" | "enabled">
): { kind: StatusKind; label: string } | undefined {
  if (!source.enabled) return { kind: "unknown", label: "Off" };
  switch (source.state) {
    case "ok":
      return undefined;
    case "pending":
      return { kind: "unknown", label: "Not synced yet" };
    case "unreachable":
      return { kind: "stale", label: "Couldn't reach" };
    case "expired":
      return { kind: "stale", label: "Index expired" };
    case "invalid":
      return { kind: "down", label: "Index refused" };
    case "bad_signature":
      return { kind: "down", label: "Signature doesn't match" };
    case "key_changed":
      return { kind: "down", label: "Key changed — re-approve" };
    case "off":
      return { kind: "unknown", label: "Off" };
  }
}

/** "212 packages" / "38 listings" — a showcase only lists. */
export function packageCountLabel(
  source: Pick<MarketSource, "packageCount" | "trust">
): string {
  const n = source.packageCount;
  const noun = source.trust === "showcase" ? "listing" : "package";
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The facts line under a source's name, most telling first. */
export function sourceFacts(source: MarketSource): string[] {
  const facts = [sourceHost(source.url), packageCountLabel(source)];
  if (source.official) facts.push("Built in");
  else if (source.addedAt) facts.push(`Added ${formatDate(source.addedAt)}`);
  facts.push(
    source.lastSyncAt
      ? `Synced ${formatRelative(source.lastSyncAt)}`
      : "Never synced"
  );
  return facts;
}

/** The signing line: a key's fingerprint in mono, or why there is none. */
export function signingLine(
  source: Pick<MarketSource, "official" | "keyFingerprint" | "trust">
): { mono: boolean; text: string } {
  const fp = formatKeyFingerprint(source.keyFingerprint);
  if (fp) return { mono: true, text: `ed25519 · ${fp}` };
  if (source.official) {
    return {
      mono: false,
      text: "Trusted as this pod's Control Plane address, over TLS",
    };
  }
  return { mono: false, text: "No signing key — listings only" };
}

/** What the trust level lets this pod do, in one line (the row's consequence). */
export function trustConsequenceLine(
  source: Pick<MarketSource, "trust" | "official" | "agentsMayPropose">
): string {
  if (source.official) {
    return "Every kind installs; agents may propose installs for you to review.";
  }
  if (source.trust === "showcase") {
    return "Listed in the Catalog; installing opens the publisher's site.";
  }
  return source.agentsMayPropose
    ? "You install its packages after a check; agents may propose installs for review."
    : "You install its packages after a check; agents can't install from it.";
}

/** The one action a row offers, by what the source needs most. */
export type SourceRowAction = "review_key" | "turn_on" | "sync" | null;

export function sourceRowAction(
  source: Pick<MarketSource, "state" | "enabled" | "lockedOff" | "official">
): SourceRowAction {
  if (source.state === "key_changed") return "review_key";
  if (!source.enabled) return source.lockedOff ? null : "turn_on";
  return "sync";
}

/** The Catalog's source filter: one chip per source that has anything listed. */
export function catalogSourceChips(
  sources: Pick<
    MarketSource,
    "id" | "name" | "enabled" | "blocked" | "packageCount"
  >[]
): { key: string; label: string }[] {
  return sources
    .filter((s) => s.enabled && !s.blocked && s.packageCount > 0)
    .map((s) => ({ key: s.id, label: s.name }));
}

/** What the detail page's install area shows. */
export type InstallMode =
  | { kind: "install" }
  | { kind: "open_site"; url: string | null }
  | { kind: "blocked"; reason: string };

export function installMode(
  pkg: Pick<CatalogDetail, "installMode" | "blocked" | "openUrl">
): InstallMode {
  if (pkg.installMode === "open_site") {
    return { kind: "open_site", url: pkg.openUrl };
  }
  if (pkg.installMode === "refuse") {
    return {
      kind: "blocked",
      reason: pkg.blocked ?? "This source can't install anything right now.",
    };
  }
  return { kind: "install" };
}

/**
 * The extra confirms a trusted source's package needs before Install is
 * enabled — the same `requires` the pod enforces, worded for a checkbox.
 */
export function confirmItems(
  preflight: Pick<MarketPreflight, "requires" | "risks" | "sourceName">
): { key: "code" | "network"; label: string }[] {
  const items: { key: "code" | "network"; label: string }[] = [];
  if (preflight.requires.code) {
    items.push({
      key: "code",
      label: `I accept that this runs code from ${preflight.sourceName} on my pod (${preflight.risks.code.join(", ")}).`,
    });
  }
  if (preflight.requires.network) {
    items.push({
      key: "network",
      label: `I accept that it can reach ${preflight.risks.networkHosts.join(", ")}.`,
    });
  }
  return items;
}

/** Plain lines naming what the package brings (shown for every source). */
export function riskLines(
  risks: Pick<MarketPreflight["risks"], "code" | "networkHosts" | "connectors">
): string[] {
  const lines: string[] = [];
  if (risks.code.length > 0) lines.push(`Runs code: ${risks.code.join(", ")}`);
  if (risks.networkHosts.length > 0) {
    lines.push(`Can reach: ${risks.networkHosts.join(", ")}`);
  }
  if (risks.connectors.length > 0) {
    lines.push(`Connects: ${risks.connectors.join(", ")}`);
  }
  return lines;
}
