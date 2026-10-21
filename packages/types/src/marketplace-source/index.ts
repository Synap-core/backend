/**
 * Marketplace sources — the ONE vocabulary for "where the catalog comes from,
 * and how far this pod trusts it".
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
export const MARKETPLACE_KIND_ALIASES: Readonly<
  Record<string, MarketplacePackageKind>
> = {
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

export const MARKETPLACE_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export const MARKETPLACE_CELL_SLUG_PATTERN =
  /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/;

const SHA256_HEX = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "sha256 is 64 lowercase hex characters.");

const ed25519KeySchema = z
  .string()
  .regex(ED25519_PUBLIC_KEY_PATTERN, "publicKey is a raw ed25519 key, base64.");

/** The fields every listing carries, whoever serves the index. */
const indexPackageShape = {
  slug: z.string(),
  kind: z.preprocess(
    (k) => (typeof k === "string" ? (MARKETPLACE_KIND_ALIASES[k] ?? k) : k),
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
  sha256: SHA256_HEX,
  installUrl: httpsUrlSchema.optional(),
  homepageUrl: httpsUrlSchema.optional(),
  requiredTier: z.string().max(50).optional(),
};

function checkPackageSlug(
  pkg: { kind: MarketplacePackageKind; slug: string },
  ctx: z.RefinementCtx
): void {
  const ok =
    pkg.kind === "cell"
      ? MARKETPLACE_CELL_SLUG_PATTERN.test(pkg.slug)
      : MARKETPLACE_SLUG_PATTERN.test(pkg.slug);
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
}

function checkNoDuplicates(
  index: { packages: { kind: string; slug: string }[] },
  ctx: z.RefinementCtx
): void {
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
}

export const marketplaceIndexPackageSchema = z
  .object(indexPackageShape)
  .superRefine(checkPackageSlug);
export type MarketplaceIndexPackage = z.infer<
  typeof marketplaceIndexPackageSchema
>;

const indexSourceShape = {
  name: z.string().min(1).max(100),
  homepage: httpsUrlSchema.optional(),
};

/** `synap-index.json`, schema version 1 — a source a person adds. */
export const marketplaceIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.object({
      ...indexSourceShape,
      id: sourceIdSchema,
      /** The key that signs this index (raw ed25519, base64). */
      publicKey: ed25519KeySchema.optional(),
    }),
    /** After this instant the index is refused — a frozen copy cannot live forever. */
    expires: z.string().datetime({ offset: true }),
    packages: z
      .array(marketplaceIndexPackageSchema)
      .max(MARKETPLACE_INDEX_MAX_PACKAGES),
  })
  .superRefine(checkNoDuplicates);
export type MarketplaceIndex = z.infer<typeof marketplaceIndexSchema>;

// ── Synap's own catalog, signed (docs/pod-console/open-hosting-and-catalog-signing.md §B) ──

/**
 * Where the Control Plane serves its signed files, under the official
 * catalog's base URL: the index (signed by the online catalog key) and the
 * keys statement naming that key (signed by an offline root key). Each has
 * its detached `.sig` beside it.
 */
export const OFFICIAL_INDEX_PATH = "/api/marketplace/synap-index.json";
export const OFFICIAL_KEYS_PATH = "/api/marketplace/synap-catalog-keys.json";

/** The longest an online catalog key may be named valid for, from now. */
export const CATALOG_KEY_MAX_LIFETIME_DAYS = 90;
/** The longest a keys statement may say it stays valid, from now. */
export const CATALOG_KEYS_MAX_LIFETIME_DAYS = 366;
export const CATALOG_KEYS_MAX_BYTES = 64 * 1024;
/** A keys statement names 1 to this many online keys. */
export const CATALOG_KEYS_MAX_KEYS = 8;

/**
 * One listing of Synap's signed index. Same fields as any source, plus the
 * CONTENT digest the pod recomputes from the definition the Control Plane's
 * endpoints serve (`contentHash`, see `canonicalDefinitionJson`). The
 * definition URL serves exactly those canonical bytes, so `sha256` is the
 * same value — an index where they differ is refused.
 */
export const officialIndexPackageSchema = z
  .object({
    ...indexPackageShape,
    contentHash: SHA256_HEX,
    vendor: z.string().max(200).nullable().optional(),
    retiredAt: z.string().datetime({ offset: true }).nullable().optional(),
    replacedBySlug: z.string().max(200).nullable().optional(),
    retiredReason: z.string().max(2000).nullable().optional(),
  })
  .superRefine((pkg, ctx) => {
    checkPackageSlug(pkg, ctx);
    if (pkg.contentHash !== pkg.sha256) {
      ctx.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "contentHash and sha256 must be the same digest.",
      });
    }
  });
export type OfficialIndexPackage = z.infer<typeof officialIndexPackageSchema>;

/** Synap's signed `synap-index.json`: the only index whose source id is `synap`. */
export const officialIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.object({
      ...indexSourceShape,
      id: z.literal(OFFICIAL_SOURCE_ID),
      /** The online catalog key that signs this index. */
      publicKey: ed25519KeySchema,
    }),
    expires: z.string().datetime({ offset: true }),
    packages: z
      .array(officialIndexPackageSchema)
      .max(MARKETPLACE_INDEX_MAX_PACKAGES),
  })
  .superRefine(checkNoDuplicates);
export type OfficialIndex = z.infer<typeof officialIndexSchema>;

/**
 * `synap-catalog-keys.json`, signed by one of the root keys compiled into
 * the pod: which online keys may sign the index, each until `notAfter`.
 * `version` only moves forward, so an older statement cannot be replayed.
 */
export const catalogKeysStatementSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.number().int().min(1),
  expires: z.string().datetime({ offset: true }),
  keys: z
    .array(
      z.object({
        publicKey: ed25519KeySchema,
        notAfter: z.string().datetime({ offset: true }),
      })
    )
    .min(1)
    .max(CATALOG_KEYS_MAX_KEYS),
});
export type CatalogKeysStatement = z.infer<typeof catalogKeysStatementSchema>;

/**
 * A PRIVATE capability (`isPublic: false`) owned by the pod's owner is not in
 * Synap's public signed index — a public file must not reveal it. It reaches
 * the pod only through the authenticated owner door of the Control Plane
 * (`GET /internal/capabilities/:key`), so THAT connection is what it is
 * trusted by. Never a public catalog row: a key the signed index lists is
 * checked against it whatever door served it. The words logs use for it:
 */
export const PRIVATE_CAPABILITY_TRUST =
  "private, verified by the Control Plane connection";
/** The same rule, in the words Marketplace › Sources shows a person. */
export const PRIVATE_CAPABILITY_TRUST_LINE =
  "Private capabilities you own aren't in Synap's public catalog. They install through your Synap Cloud account.";

/** Top-level fields of a served definition that are not its content. */
export const NON_CONTENT_DEFINITION_FIELDS = [
  "_meta",
  "contentHash",
  "sourcePackage",
] as const;

/**
 * What `GET /api/marketplace/cells` adds to each cell's own definition. The
 * digest covers the cell definition, so these are left out of it.
 */
export const CELL_LISTING_FIELDS = [
  "packageSlug",
  "packageName",
  "author",
  "packageVersion",
  "installCount",
  "isVerified",
] as const;

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * The canonical form Synap's index digests: the definition as the Control
 * Plane serves it for `kind`, minus the fields that are not content, with
 * every object's keys sorted (arrays keep their order), as compact JSON. The
 * same rule as the Control Plane's `canonicalJSON` / `templateContentHash`,
 * so its first 12 hex are the package's `h-` version.
 */
export function canonicalDefinitionJson(
  kind: MarketplacePackageKind,
  definition: Record<string, unknown>
): string {
  const content: Record<string, unknown> = { ...definition };
  for (const key of NON_CONTENT_DEFINITION_FIELDS) delete content[key];
  if (kind === "cell") {
    for (const key of CELL_LISTING_FIELDS) delete content[key];
  }
  return JSON.stringify(sortKeysDeep(content));
}

/** Where the official catalog's signature check stands after its last sync. */
export const OFFICIAL_SIGNATURE_STATES = [
  "ok",
  "unreachable",
  "invalid",
  "bad_signature",
  "expired",
  "replayed",
] as const;
export type OfficialSignatureState = (typeof OFFICIAL_SIGNATURE_STATES)[number];

export interface OfficialCatalogSignatureStatus {
  state: OfficialSignatureState;
  lastCheckAt: string;
  /** Last time a signed index verified. */
  lastOkAt: string | null;
  /** `expires` of the last verified index. */
  validUntil: string | null;
  /** `version` of the last verified keys statement (null: operator keys). */
  keysVersion: number | null;
  /** Fingerprint of the key that signed the last verified index. */
  keyFingerprint: string | null;
  /** Listings in the last verified index. */
  packageCount: number;
  /** Cached official rows the verified index does not vouch for (last check). */
  unverifiedRows: number | null;
  /** One plain sentence on the last attempt when it did not verify. */
  message: string | null;
  /**
   * sha256 of the exact bytes of the last verified keys statement and index:
   * a later file under the same `keysVersion` / `validUntil` must be the same
   * file. Absent on a status recorded before they were kept.
   */
  keysSha256?: string | null;
  indexSha256?: string | null;
}

/**
 * How the pod treats Synap's catalog signature:
 *   unsigned — no trust anchor is configured yet (the root key ceremony has
 *              not happened): nothing is checked, nothing is blocked;
 *   report   — every check runs and is logged, nothing is blocked;
 *   enforce  — an unverified definition does not install or converge, and a
 *              failed or lapsed index pauses installs and automatic updates.
 */
export type OfficialCatalogMode = "unsigned" | "report" | "enforce";

export interface OfficialCatalogStanding {
  mode: OfficialCatalogMode;
  /** A verified, current index backs the cached digests. */
  verified: boolean;
  /** Enforce only: why nothing installs from Synap's catalog right now. */
  blocked: string | null;
  /** The one sentence the console shows about the signature, or null. */
  notice: string | null;
}

/**
 * THE freeze rule for Synap's catalog — the install door, the converge and
 * the console all read it. A transient outage keeps the last verified index
 * in force until it expires; a bad signature, a refused index or a replayed
 * keys statement does not.
 */
export function officialCatalogStanding(input: {
  /** Root keys compiled in, or operator keys set. */
  anchors: boolean;
  enforce: boolean;
  /** `SYNAP_CATALOG_ALLOW_EXPIRED=1`: an expired but signed index still counts. */
  allowExpired: boolean;
  status: OfficialCatalogSignatureStatus | null;
  now: Date;
}): OfficialCatalogStanding {
  if (!input.anchors) {
    return {
      mode: "unsigned",
      verified: false,
      blocked: null,
      notice:
        "Synap's catalog isn't signed yet. Installs work as before; this pod starts checking the signature once Synap publishes its signing keys.",
    };
  }
  const mode: OfficialCatalogMode = input.enforce ? "enforce" : "report";
  const { status } = input;
  const lapsed =
    !status?.validUntil ||
    new Date(status.validUntil).getTime() <= input.now.getTime();
  let problem: string | null = null;
  let expiredNote: string | null = null;
  if (!status) {
    problem =
      "Synap's catalog hasn't been checked yet; the first check runs with the next catalog sync.";
  } else if (status.state !== "ok" && status.state !== "unreachable") {
    problem = `Synap's catalog failed its signature check: ${status.message ?? "the signed index was refused."}`;
  } else if (!status.lastOkAt) {
    problem = `Synap's catalog couldn't be checked: ${status.message ?? "its signed index was unreachable."}`;
  } else if (lapsed) {
    if (input.allowExpired) {
      expiredNote =
        "Synap's catalog is checked against expired signed files, because this pod allows that (SYNAP_CATALOG_ALLOW_EXPIRED).";
    } else {
      problem = `Synap's signed catalog expired${status.validUntil ? ` on ${status.validUntil.slice(0, 10)}` : ""} and no fresh copy has verified since.`;
    }
  }
  if (!problem) {
    return { mode, verified: true, blocked: null, notice: expiredNote };
  }
  if (mode === "enforce") {
    const sentence = `${problem} Installs and automatic updates from it are paused; what is already listed stays listed.`;
    return { mode, verified: false, blocked: sentence, notice: sentence };
  }
  return {
    mode,
    verified: false,
    blocked: null,
    notice: `${problem} This pod only reports the check for now, so installs still work.`,
  };
}

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
