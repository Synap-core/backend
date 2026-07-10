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
      note: "Superseded by w3c.merge.note-capture-into-item — note merges into the universal 'item' kind (entry retained per append-only opKey discipline).",
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
    // sharing one of these slugs. convertToFacet handles this: it iterates
    // EVERY active same-slug profile row (each flips to a role; each row's
    // entities repoint to a target resolved for that row's scope — see
    // applyConvertToFacet in engine.ts). Dry-run counts aggregate across
    // all rows.

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
      note: "Knowledge-family kind; converted to an `item` role by w4.convert.question.",
    },
    {
      op: "keep",
      opKey: "w3c.keep.research",
      slug: "research",
      note: "Knowledge-family kind; converted to an `item` role by w4.convert.research.",
    },
    {
      op: "keep",
      opKey: "w3c.keep.decision",
      slug: "decision",
      note: "Knowledge-family kind; converted to an `item` role by w4.convert.decision.",
    },
    {
      op: "keep",
      opKey: "w3c.keep.knowledge",
      slug: "knowledge",
      note: "Knowledge-family kind; converted to an `item` role (carrying ek_* as facet properties) by w4.convert.knowledge.",
    },
    {
      op: "keep",
      opKey: "w3c.keep.user_observation",
      slug: "user_observation",
      note: "Knowledge-family kind; converted to an `item` role by w4.convert.user_observation.",
    },
    {
      op: "keep",
      opKey: "w3c.keep.signal_item",
      slug: "signal_item",
      note: "Child of `bookmark` with external-feed semantics (sourcePlatform/sourceRoute/topics/relevanceScore); kept as a primary kind, not converted, in W4 — see w4.keep.signal_item.",
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

    // ─── Wave 4: knowledge-family conversions ──────────────────────────────
    //
    // Turns the five rigid knowledge-family kinds into roles on `item` (the
    // universal capture kind seeded by w3a.seed.item, settled as the capture
    // home by w3c.merge.note-capture-into-item). Ordered AFTER that merge —
    // `item` must already be the canonical capture kind before anything else
    // converts onto it.
    //
    // Common shape: base fields already present on every capture-ish profile
    // (title, tags, description) are NOT remapped onto the facet — they carry
    // the same names on `item` already (item inherited them via the note
    // merge), so remapping would just duplicate them. Only the fields
    // distinctive to each role are mapped, mirroring the w3c CRM entries'
    // "role/companyId only, not title/email/phone" precedent.
    //
    // applicableKinds is deliberately minimal (['item']) for all five — e.g.
    // a `question` or `decision` COULD plausibly also apply to `work` (a
    // paper/project kind) or other future kinds, but that's a real product
    // decision (does a decision-role attach to a work-item too?) that
    // shouldn't be smuggled into a data-conversion manifest. Extend
    // applicableKinds in a later wave once that's decided explicitly.

    // question → item: the entry point of question → research → decision.
    // questionStatus is the lifecycle field (open/answered/abandoned per its
    // enum-ish default "open"); projectId is the thematic container so it
    // seeds context_entity_id; answeredByDecisionId is a real cross-reference
    // but the engine allows only one contextFromProperty per op, and projectId
    // is the more load-bearing link (every question view is likely scoped by
    // project), so answeredByDecisionId stays a plain mapped property.
    {
      op: "convertToFacet",
      opKey: "w4.convert.question",
      slug: "question",
      targetKindSlug: "item",
      applicableKinds: ["item"],
      propertyMapping: {
        questionStatus: "questionStatus",
        askedAt: "askedAt",
        answeredByDecisionId: "answeredByDecisionId",
      },
      statusFrom: "questionStatus",
      contextFromProperty: "projectId",
    },

    // research → item: sources/findings/confidence, answers a question.
    // researchStatus (ongoing/concluded-ish) is the status-like field.
    // questionId is a real cross-reference (research answers a question) but,
    // as with `question` above, projectId wins the single contextFromProperty
    // slot as the more universally-scoped container; questionId stays mapped.
    {
      op: "convertToFacet",
      opKey: "w4.convert.research",
      slug: "research",
      targetKindSlug: "item",
      applicableKinds: ["item"],
      propertyMapping: {
        researchStatus: "researchStatus",
        questionId: "questionId",
        conclusion: "conclusion",
        researchConfidence: "researchConfidence",
      },
      statusFrom: "researchStatus",
      contextFromProperty: "projectId",
    },

    // decision → item: rationale/alternatives/lifecycle. decisionStatus
    // (proposed/accepted/superseded/rejected) is the status-like field;
    // projectId is the thematic container (context); supersededBy is a real
    // decision→decision link but, same reasoning as above, stays a plain
    // mapped property rather than contending for the one context slot.
    {
      op: "convertToFacet",
      opKey: "w4.convert.decision",
      slug: "decision",
      targetKindSlug: "item",
      applicableKinds: ["item"],
      propertyMapping: {
        decisionStatus: "decisionStatus",
        decidedAt: "decidedAt",
        rationale: "rationale",
        alternatives: "alternatives",
        supersededBy: "supersededBy",
      },
      statusFrom: "decisionStatus",
      contextFromProperty: "projectId",
    },

    // user_observation → item: AI-inferred observations about the user.
    // No status-like field (uo_validated is a boolean confirm-flag, not a
    // lifecycle state) and no UUID cross-reference, so no statusFrom /
    // contextFromProperty here — all four uo_* properties map straight
    // through.
    {
      op: "convertToFacet",
      opKey: "w4.convert.user_observation",
      slug: "user_observation",
      targetKindSlug: "item",
      applicableKinds: ["item"],
      propertyMapping: {
        uo_observation: "uo_observation",
        uo_category: "uo_category",
        uo_confidence: "uo_confidence",
        uo_validated: "uo_validated",
      },
    },

    // knowledge → item: validated knowledge (gotchas/lessons/decisions/
    // references). `knowledge` is special: ONE profile whose entities are
    // discriminated into gotcha/lesson/decision/reference via the ek_type
    // enum property, not via separate profiles. The engine's convertToFacet
    // attaches exactly one role per source profile — it has no notion of
    // "split this source into N target roles by a property value". Two ways
    // to model that:
    //   (a) [IMPLEMENTED] convert knowledge → item + ONE `knowledge` facet
    //       role that carries ek_type as an ordinary facet property. The
    //       gotcha/lesson/decision/reference discrimination survives as data
    //       (facet.properties.ek_type), just not as a first-class sub-role.
    //       Ships now with the existing engine, zero new ops.
    //   (b) [DEFERRED] a new engine op (e.g. `splitByProperty`) that reads
    //       ek_type per-entity and attaches one of four distinct facet roles
    //       (gotcha/lesson/decision/reference) instead of one `knowledge`
    //       role — sharper modeling (each sub-kind could carry its own
    //       applicableKinds/propertyMapping) but needs new engine work, so
    //       it's the refinement path for a later wave, not W4.
    // ek_type is NOT used as statusFrom — it's a category discriminator, not
    // a lifecycle status (contrast decisionStatus/questionStatus above).
    {
      op: "convertToFacet",
      opKey: "w4.convert.knowledge",
      slug: "knowledge",
      targetKindSlug: "item",
      applicableKinds: ["item"],
      propertyMapping: {
        ek_type: "ek_type",
        ek_claim: "ek_claim",
        ek_why: "ek_why",
        ek_evidence: "ek_evidence",
      },
    },

    // Duplicate-row note: the live perso pod has TWO `knowledge` profile
    // rows — the system one (2172aa81) and a workspace-scoped duplicate
    // (ff8924b2). convertToFacet iterates EVERY active same-slug row (see
    // applyConvertToFacet in engine.ts), so w4.convert.knowledge converts
    // BOTH: each row flips to a role and its entities repoint to the `item`
    // target resolved for that row's scope. No manual pre-cleanup needed;
    // the dry-run counts will show both rows' entities.

    // signal_item: audited, NOT converted in W4. It is a child of `bookmark`
    // (parentSlug: bookmark in ensure-system-profiles.ts) with external-feed
    // semantics — sourcePlatform/sourceRoute/authorUsername/publishedAt/
    // topics/relevanceScore/sentiment/capturedFromFeed — that read as a
    // capture provenance record, not a knowledge role someone attaches to an
    // arbitrary item. It doesn't fit the knowledge-family shape (no
    // ek_type-like discriminator, no question/research/decision lifecycle)
    // and its bookmark parentage already gives it a capture-kind home once
    // bookmark itself is addressed. Converting it now would be scope creep
    // for this wave; W5 (radar/signal-feed work) is the natural place to
    // revisit whether it becomes an `item` role or stays a bookmark child.
    {
      op: "keep",
      opKey: "w4.keep.signal_item",
      slug: "signal_item",
      note: "Child of `bookmark`, external-feed provenance shape — not a knowledge-family role. Revisit in W5 (radar/signal-feed wave), not converted here.",
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
