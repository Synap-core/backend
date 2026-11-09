import { describe, it, expect, vi, beforeEach } from "vitest";

// snippet.render reads the snippet AND the subject through the access layer
// (`scopedDb(...).findFirst`), never a raw select. The access layer is mocked
// with a "floor": findFirst returns a row only when its id is in `readable`,
// which is what the real floor does for a row the caller cannot see. A handler
// that read an entity through anything else would not see the fixtures at all.
const h = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  readable: new Set<string>(),
  lens: vi.fn(),
}));

vi.mock("../../access/index.js", () => ({
  AccessContext: {
    operator: () => ({
      withLens: (lens: unknown) => {
        h.lens(lens);
        return { __access: true };
      },
    }),
  },
  scopedDb: () => ({
    findFirst: async (
      _table: unknown,
      opts: { where: { xs?: Array<{ val: unknown }>; val?: unknown } }
    ) => {
      const id = (opts.where.xs ?? [opts.where]).find(
        (c) => typeof c.val === "string" && h.rows.has(c.val)
      )?.val as string | undefined;
      const row = id ? h.rows.get(id) : undefined;
      return id && row && h.readable.has(id) ? row : undefined;
    },
    findMany: async () => [],
  }),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const mk = (name: string) =>
    new Proxy(
      { __table: name },
      { get: (t, p) => (p in t ? (t as never)[p] : `${name}.${String(p)}`) }
    );
  return {
    ...(await importOriginal<typeof import("@synap/database")>()),
    // Only the caller's own display name ({me}) is read from `db`.
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ name: "Ada Lovelace" }] }),
        }),
      }),
    },
    eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
    and: (...xs: unknown[]) => ({ op: "and", xs }),
    or: (...xs: unknown[]) => ({ op: "or", xs }),
    isNull: (col: unknown) => ({ op: "isNull", col }),
    desc: (col: unknown) => ({ op: "desc", col }),
    drizzleSql: Object.assign(() => ({ op: "sql" }), {
      raw: (s: string) => ({ op: "sql.raw", s }),
      identifier: (s: string) => ({ op: "sql.identifier", s }),
    }),
    entities: mk("entities"),
    users: mk("users"),
    channels: mk("channels"),
    views: mk("views"),
    relations: mk("relations"),
    messages: mk("messages"),
    getWorkspaceMembership: vi.fn(),
    insertChannelMessage: vi.fn(),
  };
});

vi.mock("./place-artboard-deck.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./place-artboard-deck.js")>();
  return { ...actual, placeArtboardDeck: vi.fn() };
});
vi.mock("../mail-feed/triage.js", () => ({ triageEmails: vi.fn() }));
vi.mock("../../utils/workspace-membership.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/workspace-membership.js")
  >()),
  resolveFacetVisibilityScope: vi.fn().mockResolvedValue({ userId: "u1" }),
}));
vi.mock("../../utils/assert-known-profile-slug.js", () => ({
  assertKnownProfileSlug: vi.fn(),
}));
vi.mock("../../utils/resolve-or-create-channel.js", () => ({
  resolveOrCreateChannel: vi.fn(),
  CONTEXT_OBJECT_TYPE_VALUES: ["entity"],
}));

import { BUILTIN_VERBS } from "./builtin-verbs.js";

const SNIPPET = "11111111-1111-4111-8111-111111111111";
const SUBJECT = "22222222-2222-4222-8222-222222222222";
const ctx = { userId: "u1", workspaceId: "ws1" };

function snippet(over: Record<string, unknown> = {}) {
  return {
    id: SNIPPET,
    status: "current",
    properties: {
      body: "Hi {first}, I am {me} on {today}. {{steps.a.b}} {unknown}",
      variables: [
        { name: "first", type: "text", required: true, from: "subject.title" },
        { name: "tone", type: "text", default: "warm" },
      ],
    },
    ...over,
  };
}

function render(params: Record<string, unknown>) {
  return BUILTIN_VERBS["snippet.render"]!(
    { snippetId: SNIPPET, ...params },
    ctx
  ) as Promise<{
    text: string;
    misses: Array<{ name: string; kind: string; count: number }>;
  }>;
}

beforeEach(() => {
  h.rows.clear();
  h.readable.clear();
  h.rows.set(SNIPPET, snippet());
  h.readable.add(SNIPPET);
  h.rows.set(SUBJECT, {
    id: SUBJECT,
    title: "Grace",
    preview: null,
    properties: {},
  });
  h.readable.add(SUBJECT);
});

describe("snippet.render", () => {
  it("renders values, the built-ins and leaves {{steps}} and unknown braces", async () => {
    const out = await render({ values: { first: "Ada" } });
    expect(out.text).toMatch(
      /^Hi Ada, I am Ada Lovelace on \d{4}-\d{2}-\d{2}\. \{\{steps\.a\.b\}\} \{unknown\}$/
    );
    expect(out.misses).toEqual([
      { name: "unknown", kind: "literal-brace", count: 1 },
    ]);
  });

  it("a missing required variable refuses and names it", async () => {
    await expect(render({})).rejects.toThrow(
      /Missing required variable: first/
    );
  });

  it("a value containing {x} stays literal", async () => {
    const out = await render({ values: { first: "{tone} {me}" } });
    expect(out.text.startsWith("Hi {tone} {me}, I am")).toBe(true);
  });

  it("fills a `from: subject.title` variable from the subject it may read", async () => {
    const out = await render({ subjectEntityId: SUBJECT });
    expect(out.text.startsWith("Hi Grace,")).toBe(true);
  });

  it("an explicit value beats the subject", async () => {
    const out = await render({
      subjectEntityId: SUBJECT,
      values: { first: "Ada" },
    });
    expect(out.text.startsWith("Hi Ada,")).toBe(true);
  });

  it("a subject the caller cannot read fills nothing and is recorded", async () => {
    h.readable.delete(SUBJECT);
    // `first` is required and only the subject could fill it: blocked, not "Grace".
    await expect(render({ subjectEntityId: SUBJECT })).rejects.toThrow(
      /Missing required variable: first/
    );
    // With the value given another way the render goes through and records the miss.
    h.rows.set(
      SNIPPET,
      snippet({
        properties: {
          body: "Hi {first}",
          variables: [{ name: "first", from: "subject.title" }],
        },
      })
    );
    const out = await render({ subjectEntityId: SUBJECT });
    expect(out.text).toBe("Hi ");
    expect(out.misses).toContainEqual({
      name: "subject.title",
      kind: "unresolved-context",
      count: 1,
    });
    expect(out.text).not.toContain("Grace");
  });

  it("a retired snippet is refused", async () => {
    h.rows.set(SNIPPET, snippet({ status: "retired" }));
    await expect(render({ values: { first: "Ada" } })).rejects.toThrow(
      /retired/
    );
  });

  it("a draft renders on a direct call", async () => {
    h.rows.set(SNIPPET, snippet({ status: "draft" }));
    const out = await render({ values: { first: "Ada" } });
    expect(out.text.startsWith("Hi Ada,")).toBe(true);
  });

  it("a snippet the caller cannot read is not found", async () => {
    h.readable.delete(SNIPPET);
    await expect(render({ values: { first: "Ada" } })).rejects.toThrow(
      /not found/i
    );
  });

  it("a mistyped value is refused by the one param validator", async () => {
    h.rows.set(
      SNIPPET,
      snippet({
        properties: {
          body: "{n}",
          variables: [{ name: "n", type: "number" }],
        },
      })
    );
    await expect(render({ values: { n: "lots" } })).rejects.toThrow(
      /must be a number/
    );
  });
});
