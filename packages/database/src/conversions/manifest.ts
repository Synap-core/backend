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
  | ConvertToKindOp
  | MergeIntoOp
  | KeepOp
  | ExtractNonEntityOp
  | DedupeProfileRowsOp
  | ReconcileEntityScopeOp;

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
 * The INVERSE of `convertToFacet`: promote a role back to a first-class kind and
 * re-home its facet-wearing entities off the `item` shell back onto it. Ships
 * the Decision-1 revert of the knowledge-workflow family (question / research /
 * decision / knowledge / user_observation) from `item` roles to KINDS.
 *
 * Retiring the forward op to a `keep` no-op only stops FRESH pods from
 * converting; the ledger makes a forward run one-way, so already-converted data
 * needs this NEW-opKey op to move back. Per active profile row for `slug`:
 *   (a) every entity currently on `fromKindSlug` (the shell `item`) that wears a
 *       live facet on this row — and is NOT wearing a facet of any OTHER
 *       `familySlugs` member (the multi-hat PARK guard) — has that facet's
 *       properties folded back onto the entity (facet-wins: `e.properties ||
 *       f.properties`), plus `statusInto`/`contextInto` restored from the facet
 *       columns, and is repointed `profile_id → this row`, `type = slug`;
 *   (b) the folded facet rows are SOFT-deleted (the `convertedFrom` audit
 *       breadcrumb survives);
 *   (c) the profile row flips `role → kind` (`applicable_kinds = NULL`) if it is
 *       still a role.
 *
 * Entity selection keys off the facet's profile slug, NOT `profile_kind`, so it
 * still moves the data even if a transient `declareKind` already flipped the
 * profile to a kind (leaving its entities stranded on `item`). Idempotent: after
 * a run the converted entities are off the shell and their facets deleted, so a
 * re-run selects an empty set. Multi-hat items are counted (`entitiesParked`),
 * never arbitrarily assigned. NOT destructive-tail (it PROMOTES a profile, never
 * deactivates one) — so it auto-applies at boot and pods self-heal to kinds.
 */
export interface ConvertToKindOp extends BaseOp {
  op: "convertToKind";
  /** Slug of the profile being promoted from a role back into a primary kind. */
  slug: string;
  /** Kind the facet-wearing entities currently sit on (the shell — `item`). */
  fromKindSlug: string;
  /**
   * All slugs in the revert family. An entity also wearing a facet of ANY OTHER
   * member is PARKED (left as-is, counted) — a multi-hat item has no single
   * correct kind.
   */
  familySlugs: string[];
  /** Facet.status → this entity-property key (inverse of `statusFrom`). */
  statusInto?: string;
  /** Facet.context_entity_id → this entity-property key (inverse of `contextFromProperty`). */
  contextInto?: string;
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

/**
 * Collapse DUPLICATE profile rows for ONE slug into a single canonical row.
 * Distinct from `mergeInto` (which merges DIFFERENT slugs, matched within the
 * same scope+workspace): this merges SAME-slug rows ACROSS scope — the shape a
 * pod-scope kind ends up in when it has both a `scope='system'` row and a
 * `scope='workspace'` copy of the same slug (the live pod's two `knowledge`
 * rows). Every OTHER active same-slug row's entities / entity_facets /
 * property_defs / profile_properties / views are repointed to the canonical
 * row (each collision-skipped), then — under `destructiveTail` only — the
 * now-empty duplicates are deactivated.
 *
 * Targets a NAMED slug on purpose: legitimately-distinct per-workspace role
 * profiles (a `client` row per workspace) are NOT duplicates and must never be
 * collapsed — so this op is opt-in per slug, never a blanket same-slug sweep.
 * Idempotent: after the merge only the canonical row is active, so a re-run
 * finds no other rows and is a no-op.
 */
export interface DedupeProfileRowsOp extends BaseOp {
  op: "dedupeProfileRows";
  /** Slug whose duplicate rows collapse into one canonical row. */
  slug: string;
  /**
   * How the surviving canonical row is chosen among active same-slug rows:
   * `system` = prefer the `scope='system'` row (fallback: earliest created_at);
   * `earliest` = the earliest created_at outright. Default `system`.
   */
  canonical?: "system" | "earliest";
}

/**
 * Re-null the `workspace_id` of entities whose profile is now pod-scope
 * (`profiles.entity_scope = 'pod'`) but that still carry a stamped
 * `workspace_id` from before the scope changed — so an entity's stored scope
 * matches its profile's current `entityScope` and the pod-wide lens sees it
 * everywhere. Only the pod→NULL direction (the safe, unambiguous one): a
 * workspace-scope entity with a NULL `workspace_id` is left alone, since which
 * workspace to stamp is not derivable here.
 *
 * `slug` optional: omitted = every pod-scope kind; set = just that kind.
 * Idempotent: a second run finds no pod-scope entity with a non-null
 * `workspace_id`.
 */
export interface ReconcileEntityScopeOp extends BaseOp {
  op: "reconcileEntityScope";
  /** Restrict to one kind's entities; omit to reconcile all pod-scope kinds. */
  slug?: string;
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
    // harmless no-op kept for audit completeness.
    //
    // DECISION D2 (approved): note is retired as a kind and folded into
    // `item` — a note IS an item with a prose doc. This op is authoritative
    // over the earlier `w3a.keep.note` audit entry (whose note text now points
    // here). There is NO runtime contradiction: `keep` ops are pure ledger
    // no-ops (applyOp returns {} — see engine.ts), so they touch no data; the
    // engine applies ops in array order and this `mergeInto` is the only op
    // that acts on `note`. Ordering alone makes the merge win outright, so the
    // resolution is documentation-only — no clarifying op is required. Per the
    // append-only discipline the earlier keep was NOT deleted.
    //
    // Data preserved (mergeInto semantics — engine.ts applyMergeInto): each
    // note/capture entity is repointed to the `item` profile and its
    // entities.type set to "item"; the row's `properties` JSONB and its
    // `documentId` (the prose doc) are untouched, so a note survives as an item
    // carrying the same prose + props. property_defs / profile_properties move
    // onto `item` (collision-skipped) and views are re-pointed. Deactivation of
    // the drained `note`/`capture` source profiles is gated behind
    // --destructive-tail (the canary), so the kind is retired only on a
    // deliberate operator run.
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
      note: "Knowledge-family kind; stays a primary KIND (Decision 1 — research-base.yaml + research templates declare it as a kind). The W4 convert into an `item` role was withdrawn — see the retired w4.convert.question.",
    },
    {
      op: "keep",
      opKey: "w3c.keep.research",
      slug: "research",
      note: "Knowledge-family kind; stays a primary KIND (Decision 1 — research-base.yaml + research templates declare it as a kind). The W4 convert into an `item` role was withdrawn — see the retired w4.convert.research.",
    },
    {
      op: "keep",
      opKey: "w3c.keep.decision",
      slug: "decision",
      note: "Knowledge-family kind; stays a primary KIND (Decision 1 — research-base.yaml + research templates declare it as a kind). The W4 convert into an `item` role was withdrawn — see the retired w4.convert.decision.",
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
    // Turns the knowledge-family kinds that ARE roles-in-disguise into roles on
    // `item` (the universal capture kind seeded by w3a.seed.item, settled as the
    // capture home by w3c.merge.note-capture-into-item). Ordered AFTER that
    // merge — `item` must already be the canonical capture kind before anything
    // else converts onto it.
    //
    // Only `knowledge` and `user_observation` convert here. The original W4
    // intent also converted `question`, `research`, and `decision` onto `item`
    // roles — those three convert ops are now RETIRED (see the retire block
    // immediately below): Decision 1 keeps question/research/decision as primary
    // KINDS, since research-base.yaml + the research workspace templates declare
    // them as first-class kinds with their own lifecycle/graph. The convert
    // entries are retained as ledger no-ops per the append-only opKey discipline
    // (mirroring the w3a.keep.note supersession), not deleted.
    //
    // Common shape (for the two that DO convert): base fields already present on
    // every capture-ish profile (title, tags, description) are NOT remapped onto
    // the facet — they carry the same names on `item` already (item inherited
    // them via the note merge), so remapping would just duplicate them. Only the
    // fields distinctive to each role are mapped, mirroring the w3c CRM entries'
    // "role/companyId only, not title/email/phone" precedent.

    // ── RETIRED (Decision 1): question / research / decision stay primary KINDS.
    //
    // These three convert ops were authored in W4 to fold the question →
    // research → decision family into `item` roles. That intent is WITHDRAWN:
    // research-base.yaml + the research workspace templates now declare
    // question, research, and decision as first-class primary kinds, so
    // converting them into `item` roles would contradict the SSOT.
    //
    // The ops were DORMANT — `runConversions()` is manual + dry-run-by-default
    // and never auto-runs, so these never applied on any pod. Per the
    // append-only ledger discipline the opKeys are NOT deleted; each is turned
    // into a `keep` ledger no-op (applyOp returns {} — engine.ts) recording that
    // the slug is deliberately kept as a primary kind. This mirrors how
    // w3a.keep.note was superseded in place rather than removed. The
    // corresponding `w3c.keep.{question,research,decision}` notes above are
    // updated to match (they no longer claim a w4 conversion).
    {
      op: "keep",
      opKey: "w4.convert.question",
      slug: "question",
      note: "RETIRED (Decision 1): question stays a primary kind — research-base.yaml + the research templates declare it as a kind. The earlier W4 intent to convert it into an `item` role is withdrawn; entry kept as a ledger no-op per append-only opKey discipline (never applied — runConversions is manual/dry-run-default).",
    },
    {
      op: "keep",
      opKey: "w4.convert.research",
      slug: "research",
      note: "RETIRED (Decision 1): research stays a primary kind — research-base.yaml + the research templates declare it as a kind. The earlier W4 intent to convert it into an `item` role is withdrawn; entry kept as a ledger no-op per append-only opKey discipline (never applied — runConversions is manual/dry-run-default).",
    },
    {
      op: "keep",
      opKey: "w4.convert.decision",
      slug: "decision",
      note: "RETIRED (Decision 1): decision stays a primary kind — research-base.yaml + the research templates declare it as a kind. The earlier W4 intent to convert it into an `item` role is withdrawn; entry kept as a ledger no-op per append-only opKey discipline (never applied — runConversions is manual/dry-run-default).",
    },

    // user_observation → item: AI-inferred observations about the user.
    // No status-like field (uo_validated is a boolean confirm-flag, not a
    // lifecycle state) and no UUID cross-reference, so no statusFrom /
    // contextFromProperty here — all four uo_* properties map straight
    // through.
    {
      op: "keep",
      opKey: "w4.convert.user_observation",
      slug: "user_observation",
      note: "RETIRED (Decision 1): user_observation stays a primary KIND. The earlier W4 intent to convert it into an `item` role is withdrawn; kept as a ledger no-op per append-only opKey discipline. Boot AUTO-APPLIES conversions (index.ts runs runConversions with dryRun:false), so pods that already booted this convert carry it as a role — they are moved back by w6.revert.user_observation below; retiring this op to a keep only stops FRESH pods converting.",
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
      op: "keep",
      opKey: "w4.convert.knowledge",
      slug: "knowledge",
      note: "RETIRED (Decision 1): knowledge stays a primary KIND, with ek_type as an ordinary PROPERTY enum (gotcha/lesson/decision/reference) — NOT four sub-roles (facets are an additive set; ek_type is a mutually-exclusive choice an enum enforces for free). The W4 convert into an `item` role is withdrawn; kept as a ledger no-op per append-only opKey discipline. Already-converted pods (boot auto-applies) are moved back by w6.revert.knowledge below.",
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

    // ─── Wave 4: post-conversion data-quality cleanup ──────────────────────
    //
    // Ordered LAST — after every convert/merge — so it collapses whatever
    // duplicate rows the conversions left and reconciles scope on the final
    // entity set. Both are idempotent and dry-run-first (run-conversions.ts
    // defaults to dry run); they run only when a W4 operator passes --apply.

    // The live pod carries two `knowledge` profile rows (a system row + a
    // workspace-scope copy) — the duplicate `profileSlugScopeCondition` ORs
    // defensively. Collapse them into the canonical system row so entities /
    // facets / property_defs all point at ONE `knowledge` profile. Deactivation
    // of the drained duplicate is gated behind --destructive-tail.
    {
      op: "dedupeProfileRows",
      opKey: "w4.dedupe.knowledge",
      slug: "knowledge",
      canonical: "system",
    },

    // Align stored entity scope with profile scope across every pod-scope kind:
    // an entity on a pod-scope profile that still carries a stamped
    // workspace_id (from before its kind became pod-wide) gets workspace_id
    // re-nulled so the pod-wide lens sees it everywhere. Pod→NULL only.
    {
      op: "reconcileEntityScope",
      opKey: "w4.reconcile-entity-scope",
    },

    // ── W5: drift repair ─────────────────────────────────────────────────
    // Between the w4 conversions (2026-07-11 03:51) and the role-adapter
    // landing in EntityRepository.create, live doors (capture,
    // remember_fact) kept creating entities directly on the now-role
    // knowledge profile. Same op as w4 under a fresh opKey: convertToFacet is
    // idempotent, so each re-run sweeps whatever drifted since the last
    // recorded run and no-ops otherwise.
    {
      op: "keep",
      opKey: "w5.reconvert.knowledge-drift",
      slug: "knowledge",
      note: "RETIRED (Decision 1): the knowledge drift-reconvert onto an `item` role is withdrawn with w4.convert.knowledge — knowledge stays a primary kind. Kept as a ledger no-op per append-only opKey discipline. Any entities this op or w4.convert.knowledge moved to a role are reverted by w6.revert.knowledge below.",
    },
    // RETIRED (Decision 1): the research-drift reconvert is withdrawn alongside
    // w4.convert.research — research stays a primary kind, so there is no
    // now-role research profile to sweep drift onto. Kept as a ledger no-op per
    // the append-only opKey discipline (never applied — runConversions is
    // manual/dry-run-default).
    {
      op: "keep",
      opKey: "w5.reconvert.research-drift",
      slug: "research",
      note: "RETIRED (Decision 1): research stays a primary kind — the W5 drift-reconvert onto an `item` role is withdrawn with w4.convert.research. Entry kept as a ledger no-op per append-only opKey discipline (never applied).",
    },

    // ─── Enterprise-OS Wave 1: campaign schema-drift repair ────────────────
    //
    // `campaign` drifted across THREE workspace templates, each declaring it as
    // its own WORKSPACE-scope `kind` with divergent property_defs:
    //   • content-os.yaml — 12 props, Title-case status enum
    //   • crm.yaml        — 6 props, camelCase (CRM is being de-scoped to
    //                        identity, so its campaign is retired here)
    //   • marketing.yaml  — 10 props, semanticSlug `marketing.campaign`, the
    //                        richest funnel props — the RATIFIED canonical
    // A pod built from several of these templates therefore carries multiple
    // WORKSPACE-scope `campaign` profile rows. Canonical: ONE pod-wide
    // `campaign` kind based on marketing's def (funnel props: campaign-status
    // [planning|active|paused|completed|cancelled], campaign-channel,
    // campaign-goal, campaign-target-audience, campaign-start-date,
    // campaign-end-date, campaign-budget, campaign-lead-count,
    // campaign-conversion-rate, campaign-notes). content-os's campaign folds in
    // as a superset; CRM's is removed.
    //
    // Same shape as the w4 knowledge cleanup (seed → dedupeProfileRows →
    // reconcileEntityScope): seed the canonical pod-scope row, collapse every
    // drifted same-slug workspace row onto it, then align entity scope. All
    // three are idempotent and dry-run-first; deactivation of the drained
    // duplicate rows is gated behind --destructive-tail.

    // (1) Seed the canonical pod-wide `campaign` kind. slug is `campaign` — the
    // shared slug EVERY template uses (marketing carries it plus a
    // semanticSlug) — so the dedupe below can collapse the drifted rows onto
    // it; the marketing semantic identity is recorded in uiHints.semanticSlug.
    // Create-if-missing (an existing system `campaign` row is left untouched).
    // The 10 funnel property_defs are NOT seeded here — SeedKindProfileOp seeds
    // only the profile row; property_defs arrive via template instantiation and
    // are repointed onto this canonical row by the dedupe.
    {
      op: "seedKindProfile",
      opKey: "w4.seed.campaign",
      slug: "campaign",
      displayName: "Campaign",
      entityScope: "pod",
      uiHints: {
        icon: "megaphone",
        color: "#EC4899",
        description:
          "A marketing campaign — email, social, event, content, or partnership",
        semanticSlug: "marketing.campaign",
      },
    },

    // (2) Collapse the drifted workspace-scope `campaign` rows (content-os,
    // crm, marketing) into the seeded pod-scope system row. canonical:'system'
    // makes resolveDedupTarget prefer the seeded system row; every other active
    // same-slug row's entities / entity_facets / property_defs /
    // profile_properties / views repoint onto it (each collision-skipped).
    // Idempotent; drained rows are deactivated only under --destructive-tail.
    {
      op: "dedupeProfileRows",
      opKey: "w4.dedupe.campaign",
      slug: "campaign",
      canonical: "system",
    },

    // (3) Align stored entity scope with the now pod-scope `campaign` profile:
    // an entity repointed in (2) still carries its old workspace_id, so re-null
    // it (pod→NULL only) so the pod-wide lens sees every campaign everywhere.
    // Scoped to `campaign` because the global w4.reconcile-entity-scope op runs
    // EARLIER in the manifest — before this seed exists — so it cannot catch
    // these rows.
    {
      op: "reconcileEntityScope",
      opKey: "w4.reconcile.campaign",
      slug: "campaign",
    },

    // ─── Wave 6: Decision 1 — revert the knowledge-workflow family to KINDS ────
    //
    // The knowledge-workflow family (question/research/decision/knowledge/
    // user_observation) are distinct entities related by EDGES, not co-occurring
    // identity hats — so they are first-class KINDS, not `item` facet-roles. The
    // forward w4/w5 `convertToFacet` ops (now retired to `keep` above) auto-ran
    // on boot (index.ts runs runConversions with dryRun:false) on any pod that
    // booted an earlier manifest, so those pods carry the family as ROLES with
    // real data. Retiring the forward op froze that state (a ledgered opKey never
    // re-runs); moving the data back needs these NEW-opKey `convertToKind` ops.
    //
    // convertToKind flips the profile role→kind AND re-homes its facet-wearing
    // entities off the `item` shell (folding facet props, restoring status/
    // context, soft-deleting the facet). Non-destructive → auto-applies on boot,
    // so converted pods SELF-HEAL to kinds; a fresh pod (already kinds) selects
    // empty and no-ops. `familySlugs` is the whole family so the multi-hat PARK
    // guard is symmetric — an `item` wearing two family facets is left as-is
    // (counted `entitiesParked`), never arbitrarily assigned to one kind.
    //
    // question/research/decision restore their forward statusFrom/
    // contextFromProperty (questionStatus/researchStatus/decisionStatus +
    // projectId) from the facet columns; knowledge/user_observation had neither.
    //
    // POST-MIGRATION: the repoint changes entities.type (item → the kind), so the
    // Typesense `entityType`/`facetSlugs` docs and `entity_vectors.entityType`
    // for the reverted entities are stale — a targeted reindex of the five kinds
    // must follow a real (non-dry) run (W3).
    {
      op: "convertToKind",
      opKey: "w6.revert.question",
      slug: "question",
      fromKindSlug: "item",
      familySlugs: [
        "question",
        "research",
        "decision",
        "knowledge",
        "user_observation",
      ],
      statusInto: "questionStatus",
      contextInto: "projectId",
    },
    {
      op: "convertToKind",
      opKey: "w6.revert.research",
      slug: "research",
      fromKindSlug: "item",
      familySlugs: [
        "question",
        "research",
        "decision",
        "knowledge",
        "user_observation",
      ],
      statusInto: "researchStatus",
      contextInto: "projectId",
    },
    {
      op: "convertToKind",
      opKey: "w6.revert.decision",
      slug: "decision",
      fromKindSlug: "item",
      familySlugs: [
        "question",
        "research",
        "decision",
        "knowledge",
        "user_observation",
      ],
      statusInto: "decisionStatus",
      contextInto: "projectId",
    },
    {
      op: "convertToKind",
      opKey: "w6.revert.knowledge",
      slug: "knowledge",
      fromKindSlug: "item",
      familySlugs: [
        "question",
        "research",
        "decision",
        "knowledge",
        "user_observation",
      ],
    },
    {
      op: "convertToKind",
      opKey: "w6.revert.user_observation",
      slug: "user_observation",
      fromKindSlug: "item",
      familySlugs: [
        "question",
        "research",
        "decision",
        "knowledge",
        "user_observation",
      ],
    },
  ],
};

// ─── Pure helpers (DB-less, unit-tested) ─────────────────────────────────────

/** Every op's discriminant, for exhaustive iteration/validation. */
export const CONVERSION_OP_TYPES = [
  "declareKind",
  "seedKindProfile",
  "convertToFacet",
  "convertToKind",
  "mergeInto",
  "keep",
  "extractNonEntity",
  "dedupeProfileRows",
  "reconcileEntityScope",
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
      case "convertToKind":
        requireSlug(op.opKey, op.slug);
        requireSlug(op.opKey, op.fromKindSlug, "fromKindSlug");
        if (op.slug === op.fromKindSlug) {
          throw new Error(
            `Conversion manifest: convertToKind '${op.opKey}' cannot promote from its own slug '${op.slug}'`
          );
        }
        if (!Array.isArray(op.familySlugs) || op.familySlugs.length === 0) {
          throw new Error(
            `Conversion manifest: convertToKind '${op.opKey}' needs a non-empty familySlugs (the park-guard set)`
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
      case "dedupeProfileRows":
        requireSlug(op.opKey, op.slug);
        if (
          op.canonical !== undefined &&
          op.canonical !== "system" &&
          op.canonical !== "earliest"
        ) {
          throw new Error(
            `Conversion manifest: dedupeProfileRows '${op.opKey}' has invalid canonical '${op.canonical}'`
          );
        }
        break;
      case "reconcileEntityScope":
        // slug is OPTIONAL (omitted = all pod-scope kinds); when present it
        // must be non-empty.
        if (op.slug !== undefined) requireSlug(op.opKey, op.slug);
        break;
    }
  }
}

function requireSlug(opKey: string, slug: string, field = "slug"): void {
  if (!slug || slug.trim().length === 0) {
    throw new Error(`Conversion manifest: op '${opKey}' is missing a ${field}`);
  }
}
