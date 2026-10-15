/**
 * Marketplace sources — the ONE vocabulary for "where the catalog comes from,
 * and how far this pod trusts it" (Pod Console wave 3, decision D11).
 *
 * Shared by the pod (the sync that reads a source, the install door that
 * enforces its trust level, the `marketplace.sources.*` admin doors) and the
 * console (the Sources tab, the Catalog's source filter, the detail page), so
 * a trust rule cannot mean one thing on the server and another on screen.
 *
 * Pure: zod + data, no I/O, no crypto (signature checks live with the sync in
 * `@synap/jobs`, on Node's built-in ed25519).
 *
 * The public format a third party serves is `synap-index.json` next to a
 * detached ed25519 signature `synap-index.json.sig` — see
 * `docs/marketplace-source.md` for the publisher's side.
 */

import { z } from "zod";

/** The built-in source: Synap's own catalog. It can be disabled, never removed. */
export const OFFICIAL_SOURCE_ID = "synap";

/**
 * How far the pod trusts a source:
 *   official — Synap. Every kind; agents may propose installs.
 *   trusted  — a person installs, after a preflight that names network
 *              access, connectors and code. Agents may propose only when the
 *              source's own opt-in flag is on (off by default).
 *   showcase — listed only. Install opens the publisher's site; the pod never
 *              fetches a definition from it.
 */
export const MARKETPLACE_TRUST_LEVELS = [
  "official",
  "trusted",
  "showcase",
] as const;
export type MarketplaceTrust = (typeof MARKETPLACE_TRUST_LEVELS)[number];

/** The trust levels a person may give a source they add (official is built in). */
export const ADDABLE_TRUST_LEVELS = ["trusted", "showcase"] as const;
export type AddableTrust = (typeof ADDABLE_TRUST_LEVELS)[number];

/**
 * A source id: lowercase letters, digits and inner dashes, 2–40 characters.
 * It qualifies every package the source lists (`acme/crm`), and keys the
 * pod's catalog cache — it never contains `://`, so it can never be mistaken
 * for the official source's URL key.
 */
export const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

export const sourceIdSchema = z
  .string()
  .regex(
    SOURCE_ID_PATTERN,
    "A source id is 2–40 lowercase letters, digits or dashes."
  )
  .refine((id) => id !== OFFICIAL_SOURCE_ID, {
    message: `"${OFFICIAL_SOURCE_ID}" is the built-in Synap source.`,
  });

/** File names a source serves at its base address. */
export const MARKETPLACE_INDEX_FILE = "synap-index.json";
export const MARKETPLACE_SIGNATURE_SUFFIX = ".sig";

/** Hard caps — an index or definition past them is refused, never truncated. */
export const MARKETPLACE_INDEX_MAX_BYTES = 2 * 1024 * 1024;
export const MARKETPLACE_SIGNATURE_MAX_BYTES = 512;
export const MARKETPLACE_DEFINITION_MAX_BYTES = 5 * 1024 * 1024;
export const MARKETPLACE_INDEX_MAX_PACKAGES = 2000;

/** The pod's catalog kinds — the same tokens `market.search` speaks. */
export const MARKETPLACE_PACKAGE_KINDS = [
  "capability",
  "automation",
  "template",
  "cell",
  "skill",
  "view",
] as const;
export type MarketplacePackageKind = (typeof MARKETPLACE_PACKAGE_KINDS)[number];

/**
 * The Control Plane's category names, accepted as aliases so a publisher who
 * knows those words is not refused: `workspace` is a template, `workflow` an
 * automation.
 */
const KIND_ALIASES: Record<string, MarketplacePackageKind> = {
  workspace: "template",
  workflow: "automation",
};

/** An https URL — never `http:`, `javascript:` or `data:`; it may be shown as a link. */
export const httpsUrlSchema = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "Must be an https:// address.");

/** A raw 32-byte ed25519 public key, base64. */
export const ED25519_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const CELL_SLUG = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/;

export const marketplaceIndexPackageSchema = z
  .object({
    slug: z.string(),
    kind: z.preprocess(
      (k) => (typeof k === "string" ? (KIND_ALIASES[k] ?? k) : k),
      z.enum(MARKETPLACE_PACKAGE_KINDS)
    ),
    version: z.string().min(1).max(100),
    displayName: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    /** A short icon name. Never fetched: a remote image would tell its host who browses. */
    icon: z.string().max(100).optional(),
    tags: z.array(z.string().min(1).max(50)).max(30).optional(),
    /** Absolute, or relative to the index; resolved on the index's own origin. */
    definitionUrl: z.string().min(1).max(2000),
    /** sha256 (hex) of the definition's exact bytes. */
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "sha256 is 64 lowercase hex characters."),
    installUrl: httpsUrlSchema.optional(),
    homepageUrl: httpsUrlSchema.optional(),
    requiredTier: z.string().max(50).optional(),
  })
  .superRefine((pkg, ctx) => {
    const ok =
      pkg.kind === "cell" ? CELL_SLUG.test(pkg.slug) : SLUG.test(pkg.slug);
    if (!ok) {
      ctx.addIssue({
        code: "custom",
        path: ["slug"],
        message:
          pkg.kind === "cell"
            ? "A cell slug is <package>/<cell>, lowercase."
            : "A slug is lowercase letters, digits, dots, dashes or underscores.",
      });
    }
  });
export type MarketplaceIndexPackage = z.infer<
  typeof marketplaceIndexPackageSchema
>;

/** `synap-index.json`, schema version 1. */
export const marketplaceIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.object({
      id: sourceIdSchema,
      name: z.string().min(1).max(100),
      homepage: httpsUrlSchema.optional(),
      /** The key that signs this index (raw ed25519, base64). */
      publicKey: z
        .string()
        .regex(
          ED25519_PUBLIC_KEY_PATTERN,
          "publicKey is a raw ed25519 key, base64."
        )
        .optional(),
    }),
    /** After this instant the index is refused — a frozen copy cannot live forever. */
    expires: z.string().datetime({ offset: true }),
    packages: z
      .array(marketplaceIndexPackageSchema)
      .max(MARKETPLACE_INDEX_MAX_PACKAGES),
  })
  .superRefine((index, ctx) => {
    const seen = new Set<string>();
    index.packages.forEach((pkg, i) => {
      const key = `${pkg.kind}|${pkg.slug}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["packages", i, "slug"],
          message: `"${pkg.slug}" (${pkg.kind}) is listed twice.`,
        });
      }
      seen.add(key);
    });
  });
export type MarketplaceIndex = z.infer<typeof marketplaceIndexSchema>;

/**
 * A key fingerprint as a person compares it: the first 32 hex characters of
 * sha256(raw key), in groups of four. `null` reads as "no signing key".
 */
export function formatKeyFingerprint(
  hex: string | null | undefined
): string | null {
  if (!hex) return null;
  const head = hex.toLowerCase().slice(0, 32);
  return head.match(/.{1,4}/g)?.join(" ") ?? null;
}

/** Strip the spacing a person may paste with a fingerprint. */
export function normalizeKeyFingerprint(value: string): string {
  return value.replace(/[\s:]/g, "").toLowerCase();
}

/** `acme/crm` — the id that names a package together with where it comes from. */
export function qualifiedPackageId(sourceId: string, slug: string): string {
  return `${sourceId}/${slug}`;
}

/**
 * Split a source-qualified id. Only a prefix that names a KNOWN source is
 * read as one, and never for a cell (whose own slug is `<package>/<cell>`, so
 * a prefix there is ambiguous — a cell names its source explicitly). A bare
 * slug carries no source: it resolves to the official source only.
 */
export function parseQualifiedPackageId(
  kind: string,
  id: string,
  knownSourceIds: readonly string[]
): { source: string | null; slug: string } {
  const cut = id.indexOf("/");
  if (kind === "cell" || cut <= 0) return { source: null, slug: id };
  const prefix = id.slice(0, cut);
  return knownSourceIds.includes(prefix)
    ? { source: prefix, slug: id.slice(cut + 1) }
    : { source: null, slug: id };
}

/** Who is asking to install. */
export type MarketActor = "person" | "agent";

export type MarketInstallDecision =
  | { allow: "install" }
  | { allow: "propose" }
  /** Showcase: the pod never installs it; the publisher's site does. */
  | { allow: "open_site" }
  | { allow: "refuse"; reason: string };

export interface MarketSourceGate {
  trust: MarketplaceTrust;
  /** Trusted sources only: may agents propose installs from it? Default off. */
  agentsMayPropose?: boolean;
  /** Set when the source may not serve installs right now, with the reason. */
  blocked?: string | null;
}

/**
 * THE trust rule. The install door enforces it; the console reads it to
 * decide which button to draw — the same function, so they cannot disagree.
 */
export function decideMarketInstall(
  source: MarketSourceGate,
  actor: MarketActor
): MarketInstallDecision {
  if (source.blocked) return { allow: "refuse", reason: source.blocked };
  if (source.trust === "showcase") return { allow: "open_site" };
  if (source.trust === "official") {
    return actor === "agent" ? { allow: "propose" } : { allow: "install" };
  }
  if (actor === "person") return { allow: "install" };
  return source.agentsMayPropose
    ? { allow: "propose" }
    : {
        allow: "refuse",
        reason:
          "Agents can't install from this source — a person installs its packages, or turns on agent proposals for it in the Pod Console.",
      };
}

/** One plain sentence per trust level — what it lets this pod do. */
export const TRUST_CONSEQUENCE: Record<MarketplaceTrust, string> = {
  official:
    "Synap's own catalog. Every kind installs; agents may propose installs for you to review.",
  trusted:
    "Its packages can be installed on this pod by a person, after a check that names the network access, connectors and code they bring.",
  showcase:
    "Its packages are listed in the Catalog; installing opens the publisher's site. Nothing from it runs here.",
};

/** The chip word for a trust level. */
export const TRUST_LABEL: Record<MarketplaceTrust, string> = {
  official: "Official",
  trusted: "Trusted",
  showcase: "Showcase only",
};

/** Where a source stands after its last sync. */
export const MARKETPLACE_SOURCE_STATES = [
  "pending",
  "ok",
  "unreachable",
  "invalid",
  "bad_signature",
  "expired",
  "key_changed",
] as const;
export type MarketplaceSourceState = (typeof MARKETPLACE_SOURCE_STATES)[number];

/**
 * The reason a third-party source may not serve installs, or null. A key
 * change blocks until a person re-approves; a lapsed index blocks until the
 * source publishes a fresh one; a disabled source serves nothing.
 */
export function sourceBlockReason(input: {
  enabled: boolean;
  state: MarketplaceSourceState;
  /** `expires` of the last index the pod accepted. */
  validUntil: string | null;
  now: Date;
}): string | null {
  if (!input.enabled) return "This source is turned off on this pod.";
  if (input.state === "key_changed") {
    return "This source is now signed by a different key. A pod admin must re-approve it before anything installs from it.";
  }
  if (!input.validUntil) {
    return "This source has not delivered a verified catalog yet.";
  }
  if (new Date(input.validUntil).getTime() <= input.now.getTime()) {
    return "This source's catalog has expired and it has not published a fresh one.";
  }
  return null;
}
