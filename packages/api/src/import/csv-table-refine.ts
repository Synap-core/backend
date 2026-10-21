/**
 * Deterministic post-plan step for a CSV table import.
 *
 * The IS planner (`analyze-bulk-mapping`) decides what one row IS and gives each
 * column a slug. It is a good mapper and a poor schema reader: it slugs every
 * header in kebab-case (so it can never answer an existing camelCase property
 * like `linkedinUrl`), it may pick a ROLE (`contact`) as the row's type, and it
 * titles a person by one name column. This step corrects the plan against the
 * pod's REAL profiles, with no model call:
 *
 *   1. a role pick → the role's applicable KIND + the role as a facet
 *      (Kind + Facets: a role is never an entity's kind);
 *   2. each planned column → the kind's EXISTING property when the meaning
 *      matches (same slug modulo case/separators, or a generic contact concept
 *      recognised by header and/or value shape), else the role facet's property,
 *      else left exactly as planned (never dropped);
 *   3. first-name + last-name columns → one composed title;
 *   4. an organisation-name column on person rows → a link to an organisation
 *      entity (deduped by name downstream) through the employment relation.
 *
 * Nothing here is specific to one export tool: the concepts are the fields any
 * contacts table carries (LinkedIn, Google Contacts, a CRM export, a hand-made
 * sheet). Pure — no DB, no IS — so the seam is testable from CSV text to ops.
 */

import { isLinkedinUrl } from "@synap/database";
import type { CsvColumnPlan, CsvTablePlan } from "./import-adapters.js";

/** One profile as the refine step needs it (from `resolveProfileHints`). */
export interface CsvProfileCatalogEntry {
  slug: string;
  profileKind: "kind" | "role";
  /** For a role: the kinds it may sit on (empty = unrestricted). */
  applicableKinds: string[];
  /** Effective property slugs in this workspace lens. */
  propertySlugs: string[];
}

/**
 * The system ontology this step composes with: the people kind, the
 * organisation kind and the relation between them, all seeded on every pod
 * (`ensure-system-profiles.ts`, `default-relation-defs.ts`). Applied only when
 * the pod's catalog actually carries the organisation kind.
 */
export const PERSON_KIND = "person";
export const ORGANIZATION_KIND = "company";
export const EMPLOYMENT_RELATION = "works_at";

/** Header / slug normaliser: "Email Address" ≡ "email-address" ≡ "emailAddress". */
export function normalizeColumnKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HTTP_SHAPE = /^https?:\/\/\S+$/i;
function looksLikePhone(value: string): boolean {
  if (!/^[+()\d][\d\s().\-/]*$/.test(value)) return false;
  return value.replace(/\D/g, "").length >= 7;
}

interface Concept {
  id: string;
  /** Normalised header (or planner slug) spellings that name this concept. */
  headers: string[];
  /** Value shape a cell of this concept has. */
  shape?: (value: string) => boolean;
  /** When true, a column whose values clearly have the shape matches even
   *  under an unrelated header ("URL" holding linkedin.com profile links). */
  shapeAlone?: boolean;
  /** Existing property slugs that hold it, in preference order. */
  targets: string[];
}

const CONCEPTS: Concept[] = [
  {
    id: "linkedin",
    headers: [
      "linkedin",
      "linkedinurl",
      "linkedinprofile",
      "linkedinprofileurl",
    ],
    shape: (v) => isLinkedinUrl(v),
    shapeAlone: true,
    targets: ["linkedinUrl", "linkedin-url"],
  },
  {
    id: "email",
    headers: [
      "email",
      "emailaddress",
      "mail",
      "emails",
      "workemail",
      "personalemail",
      "primaryemail",
      "courriel",
    ],
    shape: (v) => EMAIL_SHAPE.test(v),
    shapeAlone: true,
    targets: ["email"],
  },
  {
    id: "phone",
    headers: [
      "phone",
      "phonenumber",
      "mobile",
      "mobilephone",
      "mobilenumber",
      "tel",
      "telephone",
      "cell",
      "cellphone",
    ],
    shape: looksLikePhone,
    targets: ["phone"],
  },
  {
    id: "website",
    headers: ["website", "websiteurl", "site", "web", "homepage"],
    shape: (v) => HTTP_SHAPE.test(v) && !isLinkedinUrl(v),
    targets: ["website"],
  },
  {
    id: "twitter",
    headers: ["twitter", "twitterhandle", "xhandle"],
    targets: ["twitterHandle", "twitter-handle"],
  },
  {
    id: "github",
    headers: ["github", "githubusername", "githubhandle"],
    targets: ["githubUsername", "github-username"],
  },
  {
    id: "telegram",
    headers: ["telegram", "telegramhandle"],
    targets: ["telegramHandle"],
  },
  {
    id: "position",
    headers: [
      "position",
      "jobtitle",
      "job",
      "role",
      "occupation",
      "headline",
      "function",
      "currentposition",
    ],
    targets: ["jobTitle", "position", "role", "headline"],
  },
  {
    id: "description",
    headers: ["description", "notes", "note", "bio", "about", "summary"],
    targets: ["description"],
  },
];

const FIRST_NAME_HEADERS = ["firstname", "givenname", "forename", "first"];
const LAST_NAME_HEADERS = ["lastname", "surname", "familyname", "last"];
const ORGANIZATION_HEADERS = [
  "company",
  "companyname",
  "currentcompany",
  "organization",
  "organisation",
  "organizationname",
  "organisationname",
  "org",
  "employer",
  "account",
  "accountname",
];

/** A slug that is never a column's mapping target: the title is the title. */
const NEVER_A_TARGET = new Set(["title"]);

/** Values sampled per column to judge its shape. */
const SHAPE_SAMPLE = 50;

function columnValues(
  rows: Record<string, string>[],
  header: string
): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const v = String(row[header] ?? "").trim();
    if (v) out.push(v);
    if (out.length >= SHAPE_SAMPLE) break;
  }
  return out;
}

function shareMatching(values: string[], shape: (v: string) => boolean) {
  if (values.length === 0) return 0;
  return values.filter(shape).length / values.length;
}

/** Does this column carry this concept? Header (or planner slug) naming it,
 *  not contradicted by the values; or — for `shapeAlone` concepts — values
 *  that overwhelmingly have the concept's shape. */
function columnIsConcept(
  concept: Concept,
  col: CsvColumnPlan,
  values: string[]
): boolean {
  const named =
    concept.headers.includes(normalizeColumnKey(col.header)) ||
    concept.headers.includes(normalizeColumnKey(col.slug));
  if (named) {
    if (!concept.shape || values.length === 0) return true;
    return shareMatching(values, concept.shape) >= 0.6;
  }
  if (concept.shapeAlone && concept.shape && values.length >= 3) {
    return shareMatching(values, concept.shape) >= 0.8;
  }
  return false;
}

function findHeader(headers: string[], spellings: string[]): string | null {
  return headers.find((h) => spellings.includes(normalizeColumnKey(h))) ?? null;
}

/** The existing property a column maps to on `propertySlugs`, if any. */
function existingTarget(
  col: CsvColumnPlan,
  values: string[],
  propertySlugs: string[],
  taken: Set<string>
): { slug: string; concept?: Concept } | null {
  const available = propertySlugs.filter(
    (p) => !NEVER_A_TARGET.has(p) && !taken.has(p)
  );
  // 1. Same slug modulo case and separators ("linkedin-url" → "linkedinUrl").
  for (const key of [col.slug, col.header]) {
    const k = normalizeColumnKey(key);
    const hit = available.find((p) => normalizeColumnKey(p) === k);
    if (hit) return { slug: hit };
  }
  // 2. A contact concept recognised by header and/or value shape.
  for (const concept of CONCEPTS) {
    if (!columnIsConcept(concept, col, values)) continue;
    const hit = concept.targets.find((t) => available.includes(t));
    if (hit) return { slug: hit, concept };
  }
  return null;
}

/** For a role pick: the applicable kind whose properties the columns match
 *  best (ties keep the role's own order). */
function kindForRole(
  role: CsvProfileCatalogEntry,
  catalog: Map<string, CsvProfileCatalogEntry>,
  columns: CsvColumnPlan[],
  rows: Record<string, string>[]
): CsvProfileCatalogEntry | null {
  const kinds = role.applicableKinds
    .map((slug) => catalog.get(slug))
    .filter((p): p is CsvProfileCatalogEntry => p?.profileKind === "kind");
  let best: CsvProfileCatalogEntry | null = null;
  let bestScore = -1;
  for (const kind of kinds) {
    const score = columns.filter(
      (c) =>
        existingTarget(
          c,
          columnValues(rows, c.header),
          kind.propertySlugs,
          new Set()
        ) !== null
    ).length;
    if (score > bestScore) {
      best = kind;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Correct a planner's table plan against the pod's real profiles. Returns a
 * NEW plan; the input is never mutated. A plan whose row type is unknown to the
 * catalog comes back with only the title/column passes applied.
 */
export function refineCsvTablePlan(input: {
  plan: CsvTablePlan;
  headers: string[];
  rows: Record<string, string>[];
  catalog: CsvProfileCatalogEntry[];
}): CsvTablePlan {
  const { plan, headers, rows } = input;
  const catalog = new Map(input.catalog.map((p) => [p.slug, p]));

  // 1. Role → kind + facet.
  let kind = catalog.get(plan.profileSlug) ?? null;
  let role: CsvProfileCatalogEntry | null = null;
  if (kind?.profileKind === "role") {
    const resolved = kindForRole(kind, catalog, plan.columns, rows);
    if (resolved) {
      role = kind;
      kind = resolved;
    } else {
      // No applicable kind on this pod: leave the pick for the create door,
      // which resolves a role slug itself; nothing here can do better.
      kind = null;
    }
  }
  const profileSlug = kind?.slug ?? plan.profileSlug;
  const kindProps = kind?.propertySlugs ?? [];
  const roleProps = role?.propertySlugs ?? [];

  // 3. Title from first + last name, when the planner's title is one of them
  //    (or it named none).
  const first = findHeader(headers, FIRST_NAME_HEADERS);
  const last = findHeader(headers, LAST_NAME_HEADERS);
  const composeTitle =
    first !== null &&
    last !== null &&
    first !== last &&
    (plan.titleColumn === null ||
      plan.titleColumn === first ||
      plan.titleColumn === last ||
      !headers.includes(plan.titleColumn));
  const titleColumns = composeTitle ? [first, last] : undefined;
  const titleColumn = composeTitle ? first : plan.titleColumn;

  // 4. Organisation column on person rows.
  const orgHeader =
    profileSlug === PERSON_KIND &&
    catalog.get(ORGANIZATION_KIND)?.profileKind === "kind"
      ? findHeader(
          headers.filter((h) => h !== titleColumn),
          ORGANIZATION_HEADERS
        )
      : null;

  // 2. Columns → existing properties (kind first, then the role facet).
  const takenKind = new Set<string>();
  const takenRole = new Set<string>();
  const columns: CsvColumnPlan[] = plan.columns.map((col) => {
    if (titleColumns?.includes(col.header)) {
      return { ...col, routedTo: "title" as const };
    }
    if (orgHeader !== null && col.header === orgHeader) {
      return { ...col, routedTo: "organization" as const };
    }
    if (col.scope === "skip") return col;
    const values = columnValues(rows, col.header);
    const onKind = existingTarget(col, values, kindProps, takenKind);
    if (onKind) {
      takenKind.add(onKind.slug);
      return {
        ...col,
        slug: onKind.slug,
        // Identity atoms and labels are text; never let a guessed number/date
        // coercion reshape an email or a phone number.
        ...(onKind.concept ? { valueType: "string" as const } : {}),
        routedTo: "entity" as const,
      };
    }
    if (role) {
      const onRole = existingTarget(col, values, roleProps, takenRole);
      if (onRole) {
        takenRole.add(onRole.slug);
        return {
          ...col,
          slug: onRole.slug,
          ...(onRole.concept ? { valueType: "string" as const } : {}),
          routedTo: "facet" as const,
        };
      }
    }
    return col;
  });

  return {
    profileSlug,
    titleColumn,
    ...(titleColumns ? { titleColumns } : {}),
    columns,
    ...(role ? { rowFacet: { profileSlug: role.slug } } : {}),
    ...(orgHeader !== null
      ? {
          organization: {
            header: orgHeader,
            profileSlug: ORGANIZATION_KIND,
            relationType: EMPLOYMENT_RELATION,
          },
        }
      : {}),
  };
}
