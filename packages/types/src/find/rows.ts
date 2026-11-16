/**
 * ONE row type for every find surface, and ONE projection onto it.
 *
 * The find wire (`knowledge.find`, MCP `synap_find`, Hub `GET /find`) answers
 * in BLOCKS, one per catalog, each its own shape (decision: absent ≠ empty ≠
 * error per catalog; scores never compared across catalogs). Every surface
 * that draws a list (browser palette, relay, Raycast, a client app) used to
 * flatten those blocks itself, and two rules forked on the way (which
 * catalogs' `why` is prose; the goal → track kind token). `toFindRows` is that
 * flattening, once; the wire keeps its blocks.
 *
 * `FindWire` declares ONLY the fields `toFindRows` reads. The backend asserts
 * that its `FindByIntentResult` is assignable to it (a type-level test beside
 * `find-intent.ts`), so a rename there fails the backend build, not a client.
 */
import type {
  ContextBinding,
  FindRequiredParam,
  FindSelection,
} from "./bind-context.js";
import { bindContext } from "./bind-context.js";
import { isQuestion } from "./question.js";

/** The object catalogs of find, in the order the wire reports them. */
export const FIND_WIRE_OBJECT_CATALOGS = [
  "entities",
  "skills",
  "automations",
  "sessions",
  "goals",
  "projects",
  "views",
  "documents",
] as const;
export type FindWireObjectCatalog = (typeof FIND_WIRE_OBJECT_CATALOGS)[number];

/** Every catalog a row can come from. `intents` is routing words, never a row. */
export type FindRowCatalog =
  "capabilities" | "playbooks" | "spaces" | FindWireObjectCatalog;

type Coverage = { hit: number; of: number };

/** One object match (`FoundObject`), as far as rows read it. */
export interface FindWireObject {
  kind: string;
  id: string;
  title: string;
  why: string | null;
  workspaceId: string | null;
  termCoverage: Coverage;
  /** Entities: the entity's kind token. */
  profileSlug?: string;
}
export type FindWireObjects =
  { matches: readonly FindWireObject[] } | { error: string };

/** A runnable action (`RunnableCapabilityAction`), as far as rows read it. */
export interface FindWireAction {
  skillId?: string;
  verbId?: string;
  label: string;
  tool: string | null;
  governance: "auto" | "propose";
  kind?: "read" | "write" | "action";
  parameters: Record<string, unknown>;
}

export interface FindWire {
  capabilities?: {
    matches: ReadonlyArray<{
      action: FindWireAction;
      whenToUse: string | null;
      termCoverage: Coverage;
    }>;
  };
  playbooks?: {
    candidates: ReadonlyArray<{
      id: string;
      name: string;
      reason: string;
      templateKind: string;
      subject?: string | null;
      requiredParams?: readonly FindRequiredParam[];
    }>;
  };
  spaces?:
    | {
        matches: ReadonlyArray<{
          workspaceId: string;
          name: string;
          purpose?: string;
          termCoverage: Coverage;
        }>;
      }
    | { error: string };
  entities?: FindWireObjects;
  skills?: FindWireObjects;
  automations?: FindWireObjects;
  sessions?: FindWireObjects;
  goals?: FindWireObjects;
  projects?: FindWireObjects;
  views?: FindWireObjects;
  documents?: FindWireObjects;
}

export type FindRowRole =
  "object" | "action" | "playbook" | "answer" | "generate";
/**
 * What running it meets. `read-only`: it only reads. `auto`: it acts at once.
 * `asks-first`: it files a review. Absent on rows that are not run. This is
 * the AGENT posture; for the person every row that is not `read-only`
 * previews before it runs, whatever the tier (b9395bde).
 */
export type FindRowTier = "read-only" | "auto" | "asks-first";

/** Where a "make it" row writes. */
export type GenerateTarget =
  | { workspaceId: string }
  | { pod: true }
  | { choose: Array<{ workspaceId: string; name: string }> };

export type FindRowRun =
  | { verbId?: string; skillId?: string; parameters: Record<string, unknown> }
  | {
      playbookId: string;
      subject: string | null;
      requiredParams: readonly FindRequiredParam[];
    }
  | { door: "knowledge.answer"; query: string }
  | {
      intent: "generate-view" | "generate-cell" | "generate-automation";
      target: GenerateTarget;
    };

export type FindRowOpen =
  { by: "id"; id: string } | { by: "nav"; kind: string; id: string };

export interface FindRow {
  /** `${catalog}:${id}`, unique in the list. */
  key: string;
  role: FindRowRole;
  /** The find catalog it came from ("answer" / "generate" for those). */
  catalog: string;
  /** Vocabulary kind token (goal → track folded HERE, once). */
  kind: string;
  id: string;
  title: string;
  /** The row's own prose only, else null (see {@link PROSE_CATALOGS}). */
  line: string | null;
  /**
   * The server's user noun when the vocabulary cannot derive it from `kind`:
   * a playbook's `templateKind` ("Goal template" / "Work template").
   */
  noun?: string;
  workspaceId: string | null;
  open?: FindRowOpen;
  /** Action rows. */
  tier?: FindRowTier;
  run?: FindRowRun;
  /** Filled by `bindContext` when a selection is given. */
  binding?: ContextBinding;
  /** The absolute signal. Confidence stays per catalog and is NOT on the row. */
  termCoverage?: Coverage;
}

export interface FindRows {
  rows: FindRow[];
  /** Catalogs that were searched and whose read FAILED: never "nothing". */
  failedCatalogs: string[];
}

export interface ToFindRowsOptions {
  /** The catalogs to draw, in the order their rows interleave. */
  catalogs: readonly FindRowCatalog[];
  /** Most rows, the answer row included. */
  max: number;
  /** Bound into each runnable row when given. */
  selection?: FindSelection;
  /** The query: an `answer` row leads when it is a question. */
  query: string;
}

/**
 * Catalogs whose line is the object's OWN prose. Every other object catalog
 * builds `why` from raw values when the row has none ("markdown document",
 * "Session, in_progress"), and the wire does not say which came, so those rows
 * show no line (finding a444b014).
 */
export const PROSE_CATALOGS: ReadonlySet<FindRowCatalog> = new Set([
  "entities",
  "skills",
  "capabilities",
  "playbooks",
  "spaces",
]);

/**
 * The wire's spelling of a kind whose vocabulary token differs: a goal is the
 * `track` kind (`@synap-core/types/vocabulary`), the find wire says `goal`.
 */
const KIND_TOKEN: Readonly<Record<string, string>> = { goal: "track" };
function kindToken(wireKind: string): string {
  return KIND_TOKEN[wireKind] ?? wireKind;
}

function prose(line: string | null | undefined): string | null {
  const t = (line ?? "").replace(/\s+/g, " ").trim();
  return t ? t : null;
}

/**
 * The tier from fields already on the wire. An unknown verb kind (a
 * skill-only action) is NEVER read-only: the projection's honest-unknown rule.
 */
export function actionTier(
  action: Pick<FindWireAction, "kind" | "governance">
): FindRowTier {
  if (action.kind === "read") return "read-only";
  return action.governance === "auto" ? "auto" : "asks-first";
}

function catalogRows(
  wire: FindWire,
  catalog: FindRowCatalog,
  selection: FindSelection | undefined
): { rows: FindRow[]; failed: boolean } {
  if (catalog === "capabilities") {
    const rows = (wire.capabilities?.matches ?? []).map((m): FindRow => {
      const a = m.action;
      const id = a.verbId ?? a.skillId ?? a.label;
      const open: FindRowOpen | undefined = a.tool
        ? { by: "nav", kind: "tool", id: a.tool }
        : a.skillId
          ? { by: "nav", kind: "skill", id: a.skillId }
          : undefined;
      return {
        key: `${catalog}:${id}`,
        role: "action",
        catalog,
        kind: "capability",
        id,
        title: a.label,
        line: prose(m.whenToUse),
        workspaceId: null,
        ...(open ? { open } : {}),
        tier: actionTier(a),
        run: {
          ...(a.verbId ? { verbId: a.verbId } : {}),
          ...(a.skillId ? { skillId: a.skillId } : {}),
          parameters: a.parameters,
        },
        ...(selection
          ? {
              binding: bindContext(selection, {
                vocabulary: "action",
                parameters: a.parameters,
              }),
            }
          : {}),
        termCoverage: m.termCoverage,
      };
    });
    return { rows, failed: false };
  }
  if (catalog === "playbooks") {
    const rows = (wire.playbooks?.candidates ?? []).map((c): FindRow => {
      const subject = c.subject ?? null;
      const requiredParams = c.requiredParams ?? [];
      return {
        key: `${catalog}:${c.id}`,
        role: "playbook",
        catalog,
        kind: "playbook",
        id: c.id,
        title: c.name,
        line: prose(c.reason),
        noun: c.templateKind,
        workspaceId: null,
        open: { by: "nav", kind: "playbook", id: c.id },
        run: { playbookId: c.id, subject, requiredParams },
        ...(selection
          ? {
              binding: bindContext(selection, {
                vocabulary: "playbook",
                subject,
                requiredParams,
              }),
            }
          : {}),
      };
    });
    return { rows, failed: false };
  }
  if (catalog === "spaces") {
    const block = wire.spaces;
    if (!block) return { rows: [], failed: false };
    if ("error" in block) return { rows: [], failed: true };
    return {
      rows: block.matches.map((m) => ({
        key: `${catalog}:${m.workspaceId}`,
        role: "object",
        catalog,
        kind: "workspace",
        id: m.workspaceId,
        title: m.name,
        line: prose(m.purpose),
        workspaceId: m.workspaceId,
        open: { by: "nav", kind: "workspace", id: m.workspaceId },
        termCoverage: m.termCoverage,
      })),
      failed: false,
    };
  }
  const block = wire[catalog];
  if (!block) return { rows: [], failed: false };
  if ("error" in block) return { rows: [], failed: true };
  return {
    rows: block.matches.map((m) => ({
      key: `${catalog}:${m.id}`,
      role: "object",
      catalog,
      kind: kindToken(
        catalog === "entities" && m.profileSlug ? m.profileSlug : m.kind
      ),
      id: m.id,
      title: m.title,
      line: PROSE_CATALOGS.has(catalog) ? prose(m.why) : null,
      workspaceId: m.workspaceId,
      open: { by: "id", id: m.id },
      termCoverage: m.termCoverage,
    })),
    failed: false,
  };
}

/** The `answer` row a question leads with (`knowledge.answer`, run in parallel). */
export function answerRow(query: string): FindRow {
  const q = query.trim();
  return {
    key: `answer:${q}`,
    role: "answer",
    catalog: "answer",
    kind: "answer",
    id: q,
    title: q,
    line: null,
    workspaceId: null,
    run: { door: "knowledge.answer", query: q },
  };
}

/**
 * The find answer as rows: each catalog's best first, then each one's second…
 * (catalog scores are on different scales and are never compared), at most
 * `max`. A catalog whose read failed is listed in `failedCatalogs`, never
 * folded into "nothing". An `answer` row leads when the query is a question.
 */
export function toFindRows(
  wire: FindWire | undefined,
  opts: ToFindRowsOptions
): FindRows {
  const rows: FindRow[] = [];
  const failedCatalogs: string[] = [];
  if (opts.max <= 0) return { rows, failedCatalogs };
  if (isQuestion(opts.query)) rows.push(answerRow(opts.query));
  if (!wire) return { rows, failedCatalogs };
  const perCatalog: FindRow[][] = [];
  for (const catalog of opts.catalogs) {
    const { rows: r, failed } = catalogRows(wire, catalog, opts.selection);
    if (failed) failedCatalogs.push(catalog);
    if (r.length) perCatalog.push(r);
  }
  const seen = new Set(rows.map((r) => r.key));
  for (
    let i = 0;
    rows.length < opts.max && perCatalog.some((c) => c.length > i);
    i++
  ) {
    for (const c of perCatalog) {
      const r = c[i];
      if (!r || seen.has(r.key)) continue;
      seen.add(r.key);
      rows.push(r);
      if (rows.length >= opts.max) break;
    }
  }
  return { rows, failedCatalogs };
}
