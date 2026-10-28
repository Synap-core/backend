/**
 * EVERY part of a mixed ("capture graph") proposal, as the reviewer reads it —
 * pure, so the rule "nobody approves a part they cannot see" is tested apart
 * from the markup.
 *
 * Before this model the page drew one card per `create_entity` op and nothing
 * else: a graph carrying skills, automations, rules, a plan, playbooks, views
 * or updates was approved with those parts unseen (they sat only in the raw
 * request under Advanced). The pod's review projection
 * (`buildProposalGraph`, `routers/proposals/display.ts`) already lists every
 * part; this draws each one.
 *
 *   - WHICH parts exist comes from the pod's projection (`review.graph`), one
 *     drawer per key. `DRAWERS` is typed over every array key of
 *     `ProposalReviewGraph`, so a key the pod adds does not compile until it is
 *     drawn (the tripwire `composite-parts-drawn.test.ts` in packages/api
 *     drives the real projection through this model).
 *   - The DETAIL a part needs whole (a skill's instructions, an automation's
 *     trigger and steps, an update's new values) comes from the stored
 *     operation with the same ref: the projection keeps excerpts for lists.
 *     Instructions are drawn as code, never cut (the card folds long code
 *     behind "Show all N lines").
 *   - What acts on its own leads: skills, automations and rules come before
 *     the records, the process and the links.
 */

import { ruleThenWords, ruleWhenWords } from "@synap-core/types/automations";
import {
  partReachWords,
  type ProposalPartReach,
  type ProposalReviewGraph,
  type ProposalTurnsOn,
} from "@synap-core/types/proposals";
import {
  formatFieldLabel,
  type EffectivePropertyDef,
} from "@synap-core/types/property-render";
import {
  buildObjectActionTitle,
  humanizeToken,
  resolveObjectNoun,
  resolveStatusLabel,
  resolveVerbStepLabel,
} from "@synap-core/types/vocabulary";
import {
  codeValue,
  graphRecords,
  codeChanges,
  proseChanges,
  type ProposedRecord,
  type RecordField,
  type RecordValue,
} from "./proposal-record-model";

/** The keys of the pod's projection that list a proposal's parts. */
export type GraphItemKey = {
  [K in keyof ProposalReviewGraph]-?: NonNullable<
    ProposalReviewGraph[K]
  > extends readonly unknown[]
    ? K
    : never;
}[keyof ProposalReviewGraph];

/** One connection between two parts (a relation, a session link). */
export interface PartEdge {
  ref: string;
  from: string;
  verb: string;
  to: string;
}

export type CompositeItem =
  | { source: GraphItemKey; shape: "record"; record: ProposedRecord }
  | { source: GraphItemKey; shape: "edge"; edge: PartEdge };

type Op = Record<string, unknown>;

interface DrawContext {
  graph: ProposalReviewGraph;
  /** The stored operations, by their ref (`op.ref`, else `$opN`). */
  opByRef: ReadonlyMap<string, Op>;
  definitionsFor: (kind: string) => readonly EffectivePropertyDef[] | undefined;
  payload: unknown;
}

type Drawer = (ctx: DrawContext) => CompositeItem[];

function text(value: string | null | undefined): RecordValue | null {
  const t = value?.trim();
  return t
    ? { kind: "text", text: t, long: t.length > 80 || t.includes("\n") }
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A field when it has a value; the label through the one label door. */
function field(key: string, value: RecordValue | null): RecordField[] {
  if (!value) return [];
  return [
    {
      key,
      label: formatFieldLabel(key),
      op: "add",
      before: undefined,
      after: value,
      stale: false,
      wide: value.kind === "code" || (value.kind === "text" && value.long),
    },
  ];
}

function tags(items: readonly string[] | null | undefined): RecordValue | null {
  const clean = (items ?? []).map((i) => i.trim()).filter(Boolean);
  return clean.length ? { kind: "tags", items: clean } : null;
}

/**
 * What a part that acts on its own can reach, in the words every surface
 * says (`partReachWords`). Not measured (an older pod) ⇒ no fact: never
 * "nothing" for "not read".
 */
function reach(value: ProposalPartReach | undefined): RecordValue | null {
  return value ? text(partReachWords(value)) : null;
}

function status(raw: string): RecordValue {
  return { kind: "status", label: resolveStatusLabel(raw), raw };
}

function record(
  source: GraphItemKey,
  ref: string,
  kind: string,
  title: string | null,
  fields: RecordField[],
  op: ProposedRecord["op"] = "create"
): CompositeItem {
  return {
    source,
    shape: "record",
    record: { ref, title, kind, op, fields },
  };
}

/** The roles this proposal attaches (`isNew`), each with its stage when set. */
function newRoles(
  roles: ProposalReviewGraph["entities"][number]["roles"]
): RecordValue | null {
  return tags(
    (roles ?? [])
      .filter((r) => r.isNew)
      .map((r) => {
        const noun = resolveObjectNoun(r.profileSlug);
        return r.status ? `${noun} · ${resolveStatusLabel(r.status)}` : noun;
      })
  );
}

/** What a stored flow runs: its first action in words, else every step named. */
function flowRuns(flow: unknown): RecordValue | null {
  const then = ruleThenWords(flow, new Map());
  if (then.kind === "playbook" || then.kind === "record")
    return text(then.text);
  const nodes = (flow as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return null;
  const steps = (nodes as Array<{ type?: unknown; data?: Op | null }>)
    .filter((n) => n?.type !== "trigger")
    .map((n) => {
      const d = n.data ?? {};
      const verbId = str(d.verbId);
      const name =
        str(d.skillName) ??
        (verbId ? resolveVerbStepLabel(verbId) : null) ??
        str(d.playbookName) ??
        str(d.name) ??
        str(d.label);
      const what = humanizeToken(String(n.type ?? "step"));
      return name ? `${what} · ${name}` : what;
    });
  return tags(steps);
}

/**
 * One drawer per key of the projection. Typed over EVERY array key, so a part
 * the pod starts listing cannot ship undrawn: the build stops here first.
 */
const DRAWERS = {
  skills: ({ graph, opByRef }) =>
    (graph.skills ?? []).map((s) => {
      const op = opByRef.get(s.ref);
      // Whole, from the stored op; the projection's excerpt only when the
      // op is not there to read, ending in "…" when it was cut.
      const body = str(op?.body) ?? null;
      return record("skills", s.ref, "skill", s.name, [
        ...field(
          "body",
          body
            ? codeValue(body)
            : text(s.bodyTruncated ? `${s.bodyExcerpt}…` : s.bodyExcerpt)
        ),
        ...field("scope", text(resolveObjectNoun(s.scope))),
        ...field("agentTypes", tags(s.agentTypes)),
      ]);
    }),
  automations: ({ graph, opByRef }) =>
    (graph.automations ?? []).map((a) => {
      const flow = opByRef.get(a.ref)?.flowDefinition as
        { triggerConfig?: Record<string, unknown> } | null | undefined;
      return record("automations", a.ref, "automation", a.name, [
        // Born off: an approved automation never starts firing on its own.
        ...field("status", status(a.bornEnabled ? "active" : "draft")),
        ...field(
          "trigger",
          text(ruleWhenWords(a.triggerType, flow?.triggerConfig ?? null).text)
        ),
        ...field("runs", flowRuns(flow)),
        ...field("canReach", reach(a.reach)),
        ...field("description", text(a.description)),
      ]);
    }),
  rules: ({ graph }) =>
    (graph.rules ?? []).map((r) => {
      const skillName = (ref: string) =>
        graph.skills?.find((s) => s.ref === ref)?.name ?? null;
      const automationName = (ref: string) =>
        graph.automations?.find((a) => a.ref === ref)?.name ?? null;
      return record("rules", r.ref, "rule", r.intent, [
        ...field("scope", text(resolveObjectNoun(r.scopeKind))),
        ...field(
          "knows",
          r.factRef
            ? text(skillName(r.factRef) ?? resolveObjectNoun("skill"))
            : null
        ),
        ...field(
          "does",
          tags(
            (r.behaviourRefs ?? []).map(
              (ref) => automationName(ref) ?? resolveObjectNoun("automation")
            )
          )
        ),
      ]);
    }),
  entities: ({ graph, payload, definitionsFor }) => {
    // A new record reads as its full card (`graphRecords`, the kind's
    // labels). A record the graph only LINKS is not created: it is drawn
    // only when it gains a role, as a change to that record.
    const full = new Map(
      graphRecords(payload, definitionsFor).map((r) => [r.ref, r])
    );
    return graph.entities.flatMap((e) => {
      const roles = field("roles", newRoles(e.roles));
      if (e.existingEntityId) {
        if (!roles.length) return [];
        return [
          record(
            "entities",
            e.ref,
            e.profileSlug,
            e.title || null,
            [
              ...field("target", {
                kind: "ref",
                objectKind: e.profileSlug,
                id: e.existingEntityId,
                name: e.title || resolveObjectNoun(e.profileSlug),
              }),
              { ...roles[0]!, op: "change" as const },
            ],
            "update"
          ),
        ];
      }
      const base = full.get(e.ref) ?? {
        ref: e.ref,
        title: e.title || null,
        kind: e.profileSlug,
        op: "create" as const,
        fields: [],
      };
      return [
        {
          source: "entities" as const,
          shape: "record" as const,
          record: { ...base, fields: [...base.fields, ...roles] },
        },
      ];
    });
  },
  playbooks: ({ graph }) =>
    (graph.playbooks ?? []).map((p) =>
      record("playbooks", p.ref, "playbook", p.name, [
        ...field("status", status(p.bornStatus)),
        ...field("goalTemplate", text(p.goalTemplate)),
        ...field("subject", text(resolveObjectNoun(p.subjectProfileSlug))),
        ...field("description", text(p.description)),
      ])
    ),
  views: ({ graph }) =>
    (graph.views ?? []).map((v) =>
      record("views", v.ref, "view", v.name, [
        ...field("viewType", text(humanizeToken(v.viewType))),
        ...field(
          "kinds",
          tags((v.scopeProfileSlugs ?? []).map((k) => resolveObjectNoun(k)))
        ),
        ...field("members", text(String(v.memberCount))),
      ])
    ),
  updates: ({ graph, opByRef }) =>
    (graph.updates ?? []).map((u) => {
      // The new values whole, from the stored op's patch.
      const patch = (opByRef.get(u.ref)?.patch ?? {}) as Op;
      const fields = u.fields.flatMap((f) => {
        const whole = patch[f.key];
        // What it holds now (the pod reads it while pending): a short
        // instruction read whole becomes its changes; else before → after.
        const rewrite =
          f.before === undefined || f.beforeTruncated
            ? null
            : f.key === "body"
              ? proseChanges(f.before, whole)
              : f.key === "code"
                ? codeChanges(f.before, whole)
                : null;
        const value =
          rewrite ??
          (typeof whole === "string"
            ? f.key === "body" || f.key === "code"
              ? codeValue(whole)
              : text(whole)
            : text(f.truncated ? `${f.value}…` : f.value));
        if (!value) return [];
        const before =
          rewrite || f.before === undefined
            ? undefined
            : text(f.beforeTruncated ? `${f.before}…` : f.before);
        const base = field(f.key, value)[0]!;
        return [
          {
            ...base,
            op: "change" as const,
            before,
            wide: base.wide || before !== undefined,
          },
        ];
      });
      return record(
        "updates",
        u.ref,
        u.kind,
        buildObjectActionTitle({
          action: "update",
          objectKind: u.kind,
          objectName: u.targetName,
        }),
        [
          ...field("target", {
            kind: "ref",
            objectKind: u.kind,
            id: u.targetId,
            name: u.targetName ?? resolveObjectNoun(u.kind),
          }),
          ...field("canReach", reach(u.reach)),
          ...fields,
        ],
        "update"
      );
    }),
  projects: ({ graph }) =>
    (graph.projects ?? []).map((p) =>
      record("projects", p.ref, "project", p.name, [
        ...field("description", text(p.description)),
      ])
    ),
  sessions: ({ graph }) =>
    (graph.sessions ?? []).map((s) =>
      record("sessions", s.ref, "focus_session", s.displayTitle, [
        ...field("goal", text(s.goal)),
      ])
    ),
  documents: ({ graph, opByRef }) =>
    (graph.documents ?? []).map((d) =>
      record("documents", d.ref, "document", d.title, [
        ...field("content", text(str(opByRef.get(d.ref)?.content))),
      ])
    ),
  relations: ({ graph }) =>
    graph.relations.map((r, i) => ({
      source: "relations" as const,
      shape: "edge" as const,
      edge: {
        ref: r.itemRef ?? `$rel${i}`,
        from: r.sourceLabel,
        verb: humanizeToken(r.type),
        to: r.targetLabel,
      },
    })),
  links: ({ graph }) =>
    (graph.links ?? []).map((l) => ({
      source: "links" as const,
      shape: "edge" as const,
      edge: {
        ref: l.itemRef,
        from: l.fromLabel,
        verb: humanizeToken(l.type),
        to: l.toLabel,
      },
    })),
} satisfies Record<GraphItemKey, Drawer>;

/** The stored operations by the ref the projection names them with. */
function operationsByRef(payload: unknown): Map<string, Op> {
  const ops =
    payload && typeof payload === "object"
      ? (payload as { operations?: unknown }).operations
      : undefined;
  const out = new Map<string, Op>();
  if (!Array.isArray(ops)) return out;
  ops.forEach((op: unknown, index) => {
    if (!op || typeof op !== "object") return;
    const ref = str((op as Op).ref) ?? `$op${index}`;
    out.set(ref, op as Op);
  });
  return out;
}

/**
 * Every part of a graph proposal, in reading order: what acts on its own,
 * then the records, the process, and last the links between them.
 */
export function compositeItems(
  graph: ProposalReviewGraph,
  payload: unknown,
  definitionsFor: (kind: string) => readonly EffectivePropertyDef[] | undefined
): CompositeItem[] {
  const ctx: DrawContext = {
    graph,
    opByRef: operationsByRef(payload),
    definitionsFor,
    payload,
  };
  return (Object.keys(DRAWERS) as GraphItemKey[]).flatMap((key) =>
    (DRAWERS[key] as Drawer)(ctx)
  );
}

/**
 * What a `capability.enable` turns on (`review.turnsOn`): one record per
 * skill, drawn whole, so the person switching it on reads the code or the
 * instructions it runs and what it can reach, never only its name. A box
 * script shows its own declaration: it runs on the person's computer, not in
 * the pod's sandbox, so the pod reads no reach for it.
 */
export function turnOnRecords(turnsOn: ProposalTurnsOn): ProposedRecord[] {
  return turnsOn.skills.map((s) => {
    const instruction = s.kind === "instruction";
    return {
      ref: `turn-on:${s.id}`,
      title: s.name,
      kind: "skill",
      op: "update",
      fields: [
        ...field("code", codeValue(s.code)),
        ...field(
          instruction ? "instructions" : "description",
          instruction ? codeValue(s.body) : text(s.body)
        ),
        ...field(
          "declaration",
          s.box ? codeValue(JSON.stringify(s.box, null, 2)) : null
        ),
        ...field("canReach", reach(s.reach)),
      ],
    };
  });
}
