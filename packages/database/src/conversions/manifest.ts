/**
 * Conversion Manifest — Kind + Facets Wave 3A
 *
 * A versioned, typed list of DATA operations the conversion engine applies to a
 * pod, in order. This is the SSOT that replaces per-family migrations: instead
 * of hand-writing a numbered `.sql` for every kind/facet cutover, each cutover
 * is a declarative `ConversionOp` entry here, and `runConversions()`
 * (engine.ts) interprets it against the live DB.
 *
 * Every op carries a stable `opKey` — the engine records it in the
 * `_conversions` ledger so a real run is idempotent (an already-applied op is
 * skipped). Op keys are namespaced by wave (`w3a.*`, `w3c.*`, `w4.*`) so later
 * waves append to the manifest without renumbering.
 *
 * This module is intentionally free of any DB import: the types, the manifest,
 * and the validation/serialisation helpers are pure so they can be unit-tested
 * without a database.
 */

/** Discriminated union of every conversion operation the engine understands. */
export type ConversionOp =
  | DeclareKindOp
  | SeedKindProfileOp
  | ConvertToFacetOp
  | MergeIntoOp
  | KeepOp
  | ExtractNonEntityOp;

interface BaseOp {
  /** Stable, globally-unique key. Recorded in `_conversions`; never reused. */
  opKey: string;
}

/**
 * Assert a profile is a base 'kind' (profiles.profile_kind = 'kind'). Usually a
 * no-op because 'kind' is the column default — its value is the recorded intent
 * that this slug is meant to stay a primary kind. `protected` stamps
 * `ui_hints.protected = true` so downstream UX can refuse to demote it.
 */
export interface DeclareKindOp extends BaseOp {
  op: "declareKind";
  slug: string;
  protected?: boolean;
}

/**
 * Create a SYSTEM 'kind' profile if it does not already exist. Used to
 * introduce a brand-new kind (e.g. the generic `item`). Create-if-missing:
 * an existing profile with this slug is left untouched.
 */
export interface SeedKindProfileOp extends BaseOp {
  op: "seedKindProfile";
  slug: string;
  displayName: string;
  entityScope: "pod" | "workspace";
  uiHints?: Record<string, unknown>;
}

/**
 * Turn a profile that is currently a primary 'kind' into an attachable 'role'
 * (facet), and re-home every live entity of that profile onto `targetKindSlug`.
 *
 * Default entity handling (never duplicates, never deletes, idempotent):
 *   (a) the profile row flips to profile_kind='role' with `applicableKinds`;
 *   (b) for every live entity currently on this profile, a facet row is
 *       attached (entity_facets, profile_id = this now-role profile) carrying
 *       the mapped `properties` / `status` / `context`; then
 *   (c) the entity row itself BECOMES the target — its profile_id/type are
 *       repointed to `targetKindSlug`'s profile.
 *
 * Idempotency is inherent: after (c) no entity remains on the source profile,
 * so a re-run selects an empty set. A NOT-EXISTS facet guard covers partial
 * states defensively.
 */
export interface ConvertToFacetOp extends BaseOp {
  op: "convertToFacet";
  /** Slug of the profile being converted from a kind into a role. */
  slug: string;
  /** Slug of the kind the entity row becomes. Must resolve to a live profile. */
  targetKindSlug: string;
  /** Kind slugs this role may attach to (profiles.applicable_kinds). */
  applicableKinds: string[];
  /** Map of source entity-property key → facet-property key. */
  propertyMapping?: Record<string, string>;
  /** Entity-property key whose value seeds facet.status. */
  statusFrom?: string;
  /** Entity-property key whose (uuid) value seeds facet.context_entity_id. */
  contextFromProperty?: string;
}

/**
 * Merge one or more profiles into a canonical one (the 0127 pattern). Entities
 * (including soft-deleted) are repointed to the canonical profile matched by
 * slug + same scope + workspace-aware (`IS NOT DISTINCT FROM`); entities.type is
 * updated; profile_properties / property_defs are repointed with collision-skip;
 * views.scope_profile_ids is array_replace'd. The source profiles are
 * deactivated ONLY when the runner is invoked with `destructiveTail` (default
 * off — the canary constraint).
 */
export interface MergeIntoOp extends BaseOp {
  op: "mergeInto";
  fromSlugs: string[];
  intoSlug: string;
}

/** Ledger-recorded no-op: this slug is intentionally kept as-is. Audit trail. */
export interface KeepOp extends BaseOp {
  op: "keep";
  slug: string;
  note: string;
}

/**
 * Ledger-recorded no-op: this slug's data is (or will be) extracted to a
 * non-entity home elsewhere; the engine takes no action. Audit trail.
 */
export interface ExtractNonEntityOp extends BaseOp {
  op: "extractNonEntity";
  slug: string;
  note: string;
}

/** A versioned manifest — the ordered list the engine walks. */
export interface ConversionManifest {
  version: number;
  ops: ConversionOp[];
}

/**
 * The Wave 3A manifest.
 *
 * Wave 3A ships the ENGINE plus the `item` kind seed. The CRM (person/company)
 * and knowledge-family conversions are appended in W3C/W4 — here they appear
 * only as `keep` audit entries so the ledger records that they were considered
 * and deliberately deferred, not forgotten.
 */
export const CONVERSION_MANIFEST: ConversionManifest = {
  version: 1,
  ops: [
    {
      op: "seedKindProfile",
      opKey: "w3a.seed.item",
      slug: "item",
      displayName: "Item",
      entityScope: "pod",
      uiHints: {
        icon: "box",
        color: "#64748B",
        description: "A generic captured item — the default kind for capture",
        captureDefault: true,
      },
    },
    {
      op: "keep",
      opKey: "w3a.keep.person",
      slug: "person",
      note: "Person stays a primary kind; CRM facet conversions land in W3C.",
    },
    {
      op: "keep",
      opKey: "w3a.keep.company",
      slug: "company",
      note: "Company stays a primary kind; CRM facet conversions land in W3C.",
    },
    {
      op: "keep",
      opKey: "w3a.keep.note",
      slug: "note",
      note: "Note stays a primary kind; knowledge-family entries land in W4.",
    },

    // ─── Wave 3C: CRM-family conversions + merges ──────────────────────────
    //
    // `contact` is a SYSTEM profile (ensure-system-profiles.ts, parentSlug:
    // person) so resolveProfileId finds one canonical row pod-wide. `client`,
    // `partner`, `sponsor`, `competitor`, `lead` are NOT system profiles —
    // they only exist as WORKSPACE-scope profiles baked into workspace
    // templates (synap-app/packages/workspace-templates/src/templates.ts:
    // crm, content-os, radar, marketing). A pod with multiple workspaces
    // built from the same template can therefore have several profile rows
    // sharing one of these slugs. resolveProfileId() picks a single winner
    // (oldest `created_at` among scope='workspace' rows) — so each of these
    // six ops converts entities on ONE such profile row and silently leaves
    // any sibling same-slug profile in other workspaces untouched. This is
    // a real limitation flagged for the team lead, not fixed here (engine.ts
    // is out of scope for this file) — the dry-run counts on the live pod
    // will show whether more than one workspace actually seeded a given
    // slug.

    // contact → person: a contact IS a person wearing a business-contact
    // hat. Real property_defs on the system `contact` profile (title, email,
    // phone, role, companyId, tags, description) — title/email/phone/tags/
    // description are generic person fields already; only role and
    // companyId are contact-specific enough to carry onto the facet.
    {
      op: "convertToFacet",
      opKey: "w3c.convert.contact",
      slug: "contact",
      targetKindSlug: "person",
      applicableKinds: ["person"],
      propertyMapping: { role: "role", companyId: "companyId" },
    },

    // client → company: org-level relationship (deal won → active client).
    // applicableKinds includes 'person' for solo/freelance clients. All
    // client-specific property_defs from the CRM workspace template carried
    // 1:1 onto the facet; clientStatus is the only status-like field.
    {
      op: "convertToFacet",
      opKey: "w3c.convert.client",
      slug: "client",
      targetKindSlug: "company",
      applicableKinds: ["company", "person"],
      propertyMapping: {
        clientStatus: "clientStatus",
        accountManager: "accountManager",
        engagementStartDate: "engagementStartDate",
        satisfactionScore: "satisfactionScore",
        lifetimeValue: "lifetimeValue",
        notes: "notes",
        contractValue: "contractValue",
        renewalDate: "renewalDate",
        healthScore: "healthScore",
      },
      statusFrom: "clientStatus",
    },

    // partner → company: referral / co-delivery relationship. Same shape as
    // `client` plus `partnerType`; applicableKinds includes 'person' for
    // solo partners/affiliates.
    {
      op: "convertToFacet",
      opKey: "w3c.convert.partner",
      slug: "partner",
      targetKindSlug: "company",
      applicableKinds: ["company", "person"],
      propertyMapping: {
        partnerStatus: "partnerStatus",
        partnerType: "partnerType",
        accountManager: "accountManager",
        engagementStartDate: "engagementStartDate",
        satisfactionScore: "satisfactionScore",
        lifetimeValue: "lifetimeValue",
        notes: "notes",
        contractValue: "contractValue",
        renewalDate: "renewalDate",
        healthScore: "healthScore",
      },
      statusFrom: "partnerStatus",
    },

    // sponsor → company (Content OS): a brand deal from first contact to
    // paid. applicableKinds includes 'person' — sponsors can be an
    // individual creator/affiliate, not only a brand. deal-status is the
    // status-like field (Prospecting → Paid/Declined).
    {
      op: "convertToFacet",
      opKey: "w3c.convert.sponsor",
      slug: "sponsor",
      targetKindSlug: "company",
      applicableKinds: ["company", "person"],
      propertyMapping: {
        "deal-status": "deal-status",
        "sponsor-type": "sponsor-type",
        "contact-name": "contact-name",
        "contact-email": "contact-email",
        "deal-value": "deal-value",
        "payment-status": "payment-status",
        "contract-date": "contract-date",
        "deliverable-deadline": "deliverable-deadline",
        "exclusivity-end": "exclusivity-end",
        deliverables: "deliverables",
        "talking-points": "talking-points",
        "performance-notes": "performance-notes",
        "sponsor-tags": "sponsor-tags",
      },
      statusFrom: "deal-status",
    },

    // competitor → company (Radar): rivals are always orgs in this
    // template, so applicableKinds is company-only (no 'person'). `status`
    // (watching/active-threat/adjacent/archived) is the status-like field.
    {
      op: "convertToFacet",
      opKey: "w3c.convert.competitor",
      slug: "competitor",
      targetKindSlug: "company",
      applicableKinds: ["company"],
      propertyMapping: {
        positioning: "positioning",
        strengths: "strengths",
        weaknesses: "weaknesses",
        pricing: "pricing",
        url: "url",
      },
      statusFrom: "status",
    },

    // lead → person (Marketing): a lead is usually a person contact, but
    // applicableKinds keeps 'company' too since leads can represent an
    // account before a specific contact is identified. lead-stage is the
    // status-like field; lead-campaign is a UUID reference to a `campaign`
    // entity so it seeds contextFromProperty rather than being duplicated
    // into propertyMapping.
    {
      op: "convertToFacet",
      opKey: "w3c.convert.lead",
      slug: "lead",
      targetKindSlug: "person",
      applicableKinds: ["person", "company"],
      propertyMapping: {
        "lead-stage": "lead-stage",
        "lead-source": "lead-source",
        "lead-email": "lead-email",
        "lead-company": "lead-company",
        "lead-title": "lead-title",
        "lead-linkedin": "lead-linkedin",
        "lead-score": "lead-score",
        "lead-last-contacted": "lead-last-contacted",
        "lead-notes": "lead-notes",
        "lead-ai-summary": "lead-ai-summary",
      },
      statusFrom: "lead-stage",
      contextFromProperty: "lead-campaign",
    },

    // note + capture → item, the universal capture kind (item seeded by
    // w3a.seed.item above — op order keeps that seed first). `capture` was
    // already removed from ensure-system-profiles.ts (see its comment there)
    // so that fromSlug resolves to zero rows on every pod — a permanent,
    // harmless no-op kept for audit completeness. NOTE: this contradicts
    // w3a.keep.note ("Note stays a primary kind") above — that entry was a
    // W3A placeholder deferring the decision, superseded here by explicit
    // W3C direction to fold note into item. Flagged for the team lead rather
    // than silently deleting the earlier keep (ops are append-only/immutable
    // once shipped).
    {
      op: "mergeInto",
      opKey: "w3c.merge.note-capture-into-item",
      fromSlugs: ["note", "capture"],
      intoSlug: "item",
    },

    // Primary kinds staying as-is (relationship-objects / time-bound /
    // actionable — not facets of person/company).
    {
      op: "keep",
      opKey: "w3c.keep.deal",
      slug: "deal",
      note: "Deal is a relationship-THING (buyer × seller × stage), stays a primary kind.",
    },
    {
      op: "keep",
      opKey: "w3c.keep.event",
      slug: "event",
      note: "Event stays a primary kind — time-bound container, not a role.",
    },
    {
      op: "keep",
      opKey: "w3c.keep.task",
      slug: "task",
      note: "Task stays a primary kind — actionable item, not a role.",
    },

    // Knowledge-family kinds — audited, deliberately deferred to W4 (mirrors
    // the w3a.keep.note precedent).
    {
      op: "keep",
      opKey: "w3c.keep.question",
      slug: "question",
      note: "Knowledge-family kind; conversion (if any) deferred to W4.",
    },
    {
      op: "keep",
      opKey: "w3c.keep.research",
      slug: "research",
      note: "Knowledge-family kind; conversion (if any) deferred to W4.",
    },
    {
      op: "keep",
      opKey: "w3c.keep.decision",
      slug: "decision",
      note: "Knowledge-family kind; conversion (if any) deferred to W4.",
    },
    {
      op: "keep",
      opKey: "w3c.keep.knowledge",
      slug: "knowledge",
      note: "Knowledge-family kind; conversion (if any) deferred to W4.",
    },
    {
      op: "keep",
      opKey: "w3c.keep.user_observation",
      slug: "user_observation",
      note: "Knowledge-family kind; conversion (if any) deferred to W4.",
    },
    {
      op: "keep",
      opKey: "w3c.keep.signal_item",
      slug: "signal_item",
      note: "Knowledge-family kind; conversion (if any) deferred to W4.",
    },

    // anchor: borderline (programmatically created, hideFromCreate — reads
    // config-ish) but kept as a first-class kind rather than extracted,
    // per explicit W3C direction — pinned-message entities are queried and
    // rendered as entities elsewhere in the codebase, not as config.
    {
      op: "keep",
      opKey: "w3c.keep.anchor",
      slug: "anchor",
      note: "Borderline (programmatic, hideFromCreate) but kept as a kind, not extracted — pinned-message entities are read/rendered as entities elsewhere.",
    },
  ],
};

// ─── Pure helpers (DB-less, unit-tested) ─────────────────────────────────────

/** Every op's discriminant, for exhaustive iteration/validation. */
export const CONVERSION_OP_TYPES = [
  "declareKind",
  "seedKindProfile",
  "convertToFacet",
  "mergeInto",
  "keep",
  "extractNonEntity",
] as const;

export type ConversionOpType = (typeof CONVERSION_OP_TYPES)[number];

/** Collect every opKey in the manifest, in order. */
export function collectOpKeys(manifest: ConversionManifest): string[] {
  return manifest.ops.map((o) => o.opKey);
}

/**
 * Serialise a convertToFacet propertyMapping into the `[[src, tgt], …]` JSON
 * the engine hands to Postgres (`jsonb_array_elements` builds the facet
 * properties from it). Deterministic ordering by source key. Pure — unit-tested.
 */
export function buildPropertyMappingJson(
  mapping: Record<string, string> | undefined
): string {
  if (!mapping) return "[]";
  const pairs = Object.entries(mapping)
    .filter(([src, tgt]) => src.length > 0 && tgt.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(pairs);
}

/**
 * Validate a manifest's structural invariants. Throws `Error` on the first
 * violation with a message naming the offending op. Pure — no DB access.
 *
 * Checks:
 *   - opKeys are present and globally unique
 *   - every op has a known discriminant
 *   - slugs are non-empty where required
 *   - convertToFacet has a targetKindSlug and ≥1 applicableKinds
 *   - mergeInto has ≥1 fromSlugs, an intoSlug, and never merges a slug into itself
 */
export function validateManifest(manifest: ConversionManifest): void {
  if (!Number.isInteger(manifest.version) || manifest.version < 1) {
    throw new Error(
      `Conversion manifest: version must be a positive integer (got ${manifest.version})`
    );
  }

  const seen = new Set<string>();
  for (const op of manifest.ops) {
    if (!op.opKey || op.opKey.trim().length === 0) {
      throw new Error(
        `Conversion manifest: op of type '${op.op}' is missing an opKey`
      );
    }
    if (seen.has(op.opKey)) {
      throw new Error(
        `Conversion manifest: duplicate opKey '${op.opKey}' — op keys must be globally unique`
      );
    }
    seen.add(op.opKey);

    if (!(CONVERSION_OP_TYPES as readonly string[]).includes(op.op)) {
      throw new Error(
        `Conversion manifest: op '${op.opKey}' has unknown type '${op.op}'`
      );
    }

    switch (op.op) {
      case "declareKind":
      case "keep":
      case "extractNonEntity":
        requireSlug(op.opKey, op.slug);
        break;
      case "seedKindProfile":
        requireSlug(op.opKey, op.slug);
        if (!op.displayName || op.displayName.trim().length === 0) {
          throw new Error(
            `Conversion manifest: seedKindProfile '${op.opKey}' is missing displayName`
          );
        }
        if (op.entityScope !== "pod" && op.entityScope !== "workspace") {
          throw new Error(
            `Conversion manifest: seedKindProfile '${op.opKey}' has invalid entityScope '${op.entityScope}'`
          );
        }
        break;
      case "convertToFacet":
        requireSlug(op.opKey, op.slug);
        requireSlug(op.opKey, op.targetKindSlug, "targetKindSlug");
        if (op.slug === op.targetKindSlug) {
          throw new Error(
            `Conversion manifest: convertToFacet '${op.opKey}' cannot target its own slug '${op.slug}'`
          );
        }
        if (
          !Array.isArray(op.applicableKinds) ||
          op.applicableKinds.length === 0
        ) {
          throw new Error(
            `Conversion manifest: convertToFacet '${op.opKey}' needs at least one applicableKind`
          );
        }
        break;
      case "mergeInto":
        requireSlug(op.opKey, op.intoSlug, "intoSlug");
        if (!Array.isArray(op.fromSlugs) || op.fromSlugs.length === 0) {
          throw new Error(
            `Conversion manifest: mergeInto '${op.opKey}' needs at least one fromSlug`
          );
        }
        for (const from of op.fromSlugs) {
          requireSlug(op.opKey, from, "fromSlug");
          if (from === op.intoSlug) {
            throw new Error(
              `Conversion manifest: mergeInto '${op.opKey}' cannot merge slug '${from}' into itself`
            );
          }
        }
        break;
    }
  }
}

function requireSlug(opKey: string, slug: string, field = "slug"): void {
  if (!slug || slug.trim().length === 0) {
    throw new Error(`Conversion manifest: op '${opKey}' is missing a ${field}`);
  }
}
