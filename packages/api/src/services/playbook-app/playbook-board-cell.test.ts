/**
 * The generated board cell of a playbook's UI, for a REAL catalog playbook
 * (CRM "Win a deal" over `deal`, `__fixtures__/crm-win-a-deal.ts`):
 *
 *   - it passes the cell door's own mount and sandbox check (`checkCellSource`,
 *     the frame mechanism): it imports only what the host provides and loads
 *     nothing from the network;
 *   - it reads `flow.of` and spells no state or stage of the fixture: two
 *     playbooks' sources differ only in the two facts they were made from;
 *   - RUN, not only read: the module is executed against a stand-in React
 *     (hooks, effects, re-render on set) and a stand-in bridge answering
 *     `flow.of` with the fixture's flow. The drawn tree has one column per
 *     state in DECLARED order, headed by the owning stage of THIS playbook;
 *     an empty flow and a failed read are different screens; a move is the
 *     governed `update_entity` on the property `flow.of` names, and its
 *     reply is shown as it is.
 *
 * Not covered here, measured: the real frame (iframe, CSP, the host's React)
 * and the desktop host's answer to `flow.of` (NEEDS-DOGFOOD).
 */
import { describe, expect, it } from "vitest";
import { checkCellSource } from "@synap-core/types/renderables";
import {
  playbookBoardCellSource,
  PLAYBOOK_BOARD_READ_OP,
} from "./playbook-board-cell.js";
import {
  DEAL_LIFECYCLE,
  WIN_A_DEAL_FLOW_WORDS,
  WIN_A_DEAL_ID,
  WIN_A_DEAL_STAGES,
} from "./__fixtures__/crm-win-a-deal.js";

const SOURCE = playbookBoardCellSource({
  playbookId: WIN_A_DEAL_ID,
  profileSlug: "deal",
});

/**
 * The bridge's own reply vocabulary (`mutate` answers approved | proposed |
 * denied): protocol words, not states. CRM's `deal` happens to have a state
 * keyed `proposed` too; the cell names the protocol word, never the state.
 */
const BRIDGE_REPLY_WORDS = new Set(["approved", "proposed", "denied"]);

/** Every string literal in the source (double quotes, single quotes, templates). */
function stringLiterals(source: string): string[] {
  return [
    ...source.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g),
  ].map((m) => (m[1] ?? m[2] ?? "").trim());
}

describe("the playbook board cell: the source", () => {
  it("mounts in the frame: host modules only, no network, no deps", () => {
    const check = checkCellSource({
      source: SOURCE,
      mechanism: "frame",
      deps: null,
      externalHosts: null,
    });
    expect(check.refusals).toEqual([]);
    expect(SOURCE).toMatch(/^import React from "react";/);
    expect(SOURCE).not.toMatch(
      /\bfetch\(|XMLHttpRequest|WebSocket|https?:\/\//
    );
    // Far under the cell door's 2 MB bound.
    expect(Buffer.byteLength(SOURCE, "utf8")).toBeLessThan(20_000);
  });

  it("reads flow.of, and spells no state or stage of the playbook it was made for", () => {
    expect(PLAYBOOK_BOARD_READ_OP).toBe("flow.of");
    expect(SOURCE).toContain(`query(${JSON.stringify("flow.of")}`);
    const literals = new Set(
      stringLiterals(SOURCE).map((s) => s.toLowerCase())
    );
    // Non-vacuity: the scan sees the literals it is meant to judge.
    expect(literals.has("flow.of")).toBe(true);
    expect(literals.has("update_entity")).toBe(true);
    const spelled = WIN_A_DEAL_FLOW_WORDS.filter(
      (w) =>
        !BRIDGE_REPLY_WORDS.has(w.toLowerCase()) &&
        literals.has(w.toLowerCase())
    );
    expect(spelled).toEqual([]);
    // Labels and stage names are not anywhere in the source, as text either.
    for (const word of [
      ...DEAL_LIFECYCLE.options.map((o) => o.label),
      ...WIN_A_DEAL_STAGES.map((s) => s.name),
    ]) {
      expect(SOURCE.includes(word), word).toBe(false);
    }
  });

  it("is made from two facts only: another playbook's source differs in those two", () => {
    const other = playbookBoardCellSource({
      playbookId: "00000000-0000-4000-8000-0000000000aa",
      profileSlug: "lead",
    });
    const strip = (s: string, id: string, slug: string) =>
      s
        .replace(JSON.stringify(id), "<ID>")
        .replace(JSON.stringify(slug), "<SLUG>");
    expect(strip(other, "00000000-0000-4000-8000-0000000000aa", "lead")).toBe(
      strip(SOURCE, WIN_A_DEAL_ID, "deal")
    );
  });
});

// ── Run it ──────────────────────────────────────────────────────────────────

type El = {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
};

/**
 * A stand-in React: `createElement`, `Fragment`, and the three hooks the cell
 * uses, with a re-render on every state set and effects run after each
 * render. Enough to run the component's real code; not a DOM.
 */
function standInReact() {
  const states: unknown[] = [];
  const effectDeps: Array<unknown[] | undefined> = [];
  const cleanups: Array<(() => void) | undefined> = [];
  let cursor = 0;
  let effectCursor = 0;
  let pending: Array<() => void> = [];
  let rerender: () => void = () => undefined;
  const Fragment = Symbol("Fragment");
  const React = {
    Fragment,
    createElement(
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ): El {
      return { type, props: props ?? {}, children: children.flat() };
    },
    useState<T>(initial: T): [T, (next: T | ((p: T) => T)) => void] {
      const at = cursor++;
      if (!(at in states)) states[at] = initial;
      return [
        states[at] as T,
        (next) => {
          states[at] =
            typeof next === "function"
              ? (next as (p: T) => T)(states[at] as T)
              : next;
          rerender();
        },
      ];
    },
    useCallback<F>(fn: F): F {
      const at = cursor++;
      if (!(at in states)) states[at] = fn;
      return states[at] as F;
    },
    useEffect(fn: () => void | (() => void), deps?: unknown[]) {
      const at = effectCursor++;
      const prev = effectDeps[at];
      const changed =
        !deps ||
        !prev ||
        deps.length !== prev.length ||
        deps.some((d, i) => d !== prev[i]);
      if (!changed) return;
      effectDeps[at] = deps;
      pending.push(() => {
        cleanups[at]?.();
        const c = fn();
        cleanups[at] = typeof c === "function" ? c : undefined;
      });
    },
  };
  return {
    React,
    Fragment,
    mount(Component: () => El) {
      let tree: El | null = null;
      rerender = () => {
        cursor = 0;
        effectCursor = 0;
        tree = Component();
        const run = pending;
        pending = [];
        for (const e of run) e();
      };
      rerender();
      return () => tree as El;
    },
  };
}

/** Expand function components and flatten to a plain tree. */
function expand(node: unknown, Fragment: symbol): unknown {
  if (node === null || node === undefined || node === false) return null;
  if (typeof node === "string" || typeof node === "number") return node;
  if (Array.isArray(node)) return node.map((n) => expand(n, Fragment));
  const el = node as El;
  if (typeof el.type === "function") {
    return expand(
      (el.type as (p: unknown) => unknown)({
        ...el.props,
        children: el.children,
      }),
      Fragment
    );
  }
  return {
    type: el.type === Fragment ? "#fragment" : el.type,
    props: el.props,
    children: el.children.map((c) => expand(c, Fragment)),
  };
}

function textOf(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const n = node as { type: unknown; children: unknown[] };
  if (n.type === "style") return "";
  return n.children.map(textOf).join(" ");
}

function findAll(
  node: unknown,
  match: (n: { type: unknown; props: Record<string, unknown> }) => boolean
): Array<{
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
}> {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((n) => findAll(n, match));
  const n = node as {
    type: unknown;
    props: Record<string, unknown>;
    children: unknown[];
  };
  return [
    ...(match(n) ? [n] : []),
    ...n.children.flatMap((c) => findAll(c, match)),
  ];
}

/** The module's code as a function of (React, window, document) → component. */
function loadCell(source: string) {
  const body = source
    .replace(/^import React from "react";\n/, "")
    .replace(
      "export default function PlaybookBoard",
      "return function PlaybookBoard"
    );
  return new Function("React", "window", "document", body) as (
    react: unknown,
    win: unknown,
    doc: unknown
  ) => () => El;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** The fixture's flow, shaped as `flow.of` answers (states in declared order). */
function fixtureFlow(cardsInDraft: number) {
  const owner = (state: string) =>
    WIN_A_DEAL_STAGES.filter(
      (s) => "subjectStatus" in s && s.subjectStatus === state
    ).map((s) => ({
      playbookId: WIN_A_DEAL_ID,
      playbookName: "Win a deal",
      stageKey: s.key,
      stageName: s.name,
    }));
  return {
    profileSlug: "deal",
    profileKind: "kind",
    property: DEAL_LIFECYCLE.property,
    states: DEAL_LIFECYCLE.options.map((o, order) => ({
      key: o.key,
      label: o.label,
      category: o.category,
      order,
      owners: owner(o.key),
      count: o.key === "draft" ? cardsInDraft : 0,
      stuck: null,
      cards:
        o.key === "draft"
          ? Array.from({ length: cardsInDraft }, (_, i) => ({
              id: `deal-${i}`,
              facetId: null,
              name: `Acme ${i}`,
              since: new Date().toISOString(),
              enteredAt: null,
              stuck: false,
              next: {
                to: "proposed",
                label: "Proposal sent",
                humanOnly: false,
                owners: [],
              },
            }))
          : [],
    })),
    unclassified: null,
    flows: [{ id: WIN_A_DEAL_ID, name: "Win a deal" }],
    totals: {
      total: cardsInDraft,
      live: cardsInDraft,
      doneWindowed: 0,
      lostWindowed: 0,
    },
    window: { days: 30 },
    withheld: [],
  };
}

function run(answer: () => Promise<unknown>) {
  const queries: Array<{ op: string; params: unknown }> = [];
  const mutations: Array<{ op: string; params: unknown }> = [];
  let reply: unknown = { status: "proposed", proposalId: "p1" };
  const bridge = {
    query: (op: string, params: unknown) => {
      queries.push({ op, params });
      return answer();
    },
    mutate: (op: string, params: unknown) => {
      mutations.push({ op, params });
      return Promise.resolve(reply);
    },
    navigate: () => undefined,
    subscribe: () => () => undefined,
    resize: () => undefined,
  };
  const r = standInReact();
  const Component = loadCell(SOURCE)(
    r.React,
    { SynapWidget: bridge },
    {
      body: { scrollHeight: 100 },
    }
  );
  const tree = r.mount(Component);
  return {
    queries,
    mutations,
    setReply: (v: unknown) => (reply = v),
    view: () => expand(tree(), r.Fragment as unknown as symbol),
  };
}

describe("the playbook board cell: run against flow.of", () => {
  it("draws one column per state, in declared order, headed by this playbook's owning stage", async () => {
    const cell = run(async () => fixtureFlow(2));
    await flush();
    expect(cell.queries).toEqual([
      { op: "flow.of", params: { profileSlug: "deal", firstN: 8 } },
    ]);
    const columns = findAll(cell.view(), (n) => n.type === "section");
    expect(columns.map((c) => c.props["aria-label"])).toEqual(
      DEAL_LIFECYCLE.options.map((o) => o.label)
    );
    const text = columns.map(textOf);
    expect(text[0]).toContain("Qualify");
    expect(text[1]).toContain("Send proposal");
    expect(text[2]).toContain("Negotiate");
    // A state no stage of this playbook owns says so.
    expect(text[4]).toContain("No stage owns this");
    expect(text[0]).toContain("Acme 0");
    expect(textOf(cell.view())).toContain("Win a deal");
  });

  it("an empty flow and a failed read are different screens", async () => {
    const empty = run(async () => fixtureFlow(0));
    await flush();
    expect(textOf(empty.view())).toContain("Nothing in this flow yet.");
    expect(findAll(empty.view(), (n) => n.props.role === "alert")).toHaveLength(
      0
    );

    const failed = run(async () => ({ error: "pod returned 403" }));
    await flush();
    const alert = findAll(failed.view(), (n) => n.props.role === "alert");
    expect(alert).toHaveLength(1);
    expect(textOf(alert[0])).toContain("pod returned 403");
    expect(textOf(failed.view())).not.toContain("Nothing in this flow yet.");

    const thrown = run(async () => {
      throw new Error('Operation "flow.of" not implemented');
    });
    await flush();
    expect(textOf(thrown.view())).toContain(
      'Operation "flow.of" not implemented'
    );
  });

  it("a move is the governed update_entity on the property flow.of names, and says what came back", async () => {
    const cell = run(async () => fixtureFlow(1));
    await flush();
    const move = findAll(
      cell.view(),
      (n) => n.type === "button" && n.props.className === "pb-move"
    );
    expect(move).toHaveLength(1);
    (move[0]!.props.onClick as () => void)();
    await flush();
    expect(cell.mutations).toEqual([
      {
        op: "update_entity",
        params: { id: "deal-0", properties: { commercialStage: "proposed" } },
      },
    ]);
    expect(textOf(cell.view())).toContain("Waiting for review");
  });

  it("a role's flow offers no move (its status lives on the role)", async () => {
    const cell = run(async () => ({ ...fixtureFlow(1), profileKind: "role" }));
    await flush();
    expect(
      findAll(
        cell.view(),
        (n) => n.type === "button" && n.props.className === "pb-move"
      )
    ).toHaveLength(0);
  });
});
