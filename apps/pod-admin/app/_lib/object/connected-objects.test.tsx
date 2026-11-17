import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

type Read = { isLoading?: boolean; error?: unknown; data?: unknown };
let graph: Read = {};
let types: Read = {};
let files: Record<string, Read> = {};
let doc: Read = { isLoading: true, error: null };
const filesAsked: string[] = [];
const documentsAsked: string[] = [];
const mediaAsked: Array<{ documentId?: string; viaEntityId?: string | null }> =
  [];

vi.mock("../../../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ client: {} }),
    graph: {
      getObjectGraph: {
        useQuery: () => ({
          isLoading: false,
          isError: Boolean(graph.error),
          refetch: vi.fn(),
          ...graph,
        }),
      },
    },
    relations: {
      listTypes: {
        useQuery: () => ({
          isLoading: false,
          isError: Boolean(types.error),
          refetch: vi.fn(),
          ...types,
        }),
      },
    },
    useQueries: (
      build: (q: {
        entities: { get: (input: { id: string }) => { id: string } };
      }) => Array<{ id: string }>
    ) => {
      const asked = build({ entities: { get: (input) => input } });
      asked.forEach((a) => filesAsked.push(a.id));
      return asked.map((a) => ({
        isLoading: !files[a.id],
        isError: Boolean(files[a.id]?.error),
        refetch: vi.fn(),
        ...files[a.id],
      }));
    },
    documents: {
      get: {
        useQuery: (input: { documentId: string }) => {
          documentsAsked.push(input.documentId);
          return doc;
        },
      },
    },
  },
}));
vi.mock("../media/use-stored-media", () => ({
  useStoredMedia: (
    ref: { documentId?: string } | null,
    opts?: { viaEntityId?: string | null }
  ) => {
    mediaAsked.push({
      documentId: ref?.documentId,
      viaEntityId: opts?.viaEntityId,
    });
    return { state: "loading" };
  },
}));

import { ConnectedObjects } from "./connected-objects";
import {
  GROUP_CAP,
  collapsedItems,
  neighbourMedia,
  visibleItems,
} from "./connected-media";

const SELF = "8d6d5a59-16b8-4d33-a4de-8499487e104c";
const draw = (kind = "brand-asset", definitions?: unknown[]) =>
  renderToStaticMarkup(
    <ConnectedObjects entityId={SELF} kind={kind} definitions={definitions} />
  );

/** The open routes only take uuids for hosted kinds: a readable id per name. */
const uid = (name: string) =>
  `00000000-0000-4000-8000-${[...name]
    .map((c) => c.charCodeAt(0).toString(16))
    .join("")
    .slice(0, 12)
    .padStart(12, "0")}`;

const neighbor = (over: Record<string, unknown> & { id: string }) => ({
  kind: "entity",
  edgeType: "related_to",
  direction: "outgoing",
  via: "relations",
  ...over,
  id: uid(over.id),
});

beforeEach(() => {
  graph = { data: { neighbors: [] } };
  types = { data: { types: [] } };
  files = {};
  doc = { isLoading: true, error: null };
  filesAsked.length = 0;
  documentsAsked.length = 0;
  mediaAsked.length = 0;
});

describe("ConnectedObjects", () => {
  it("draws a group per relation, each object a door to its own page", () => {
    graph = {
      data: {
        neighbors: [
          neighbor({
            id: "c",
            name: "Brand voice",
            subtype: "brand-voice-guide",
          }),
          neighbor({ id: "d", name: "Acme", subtype: "company" }),
        ],
      },
    };
    const html = draw();
    expect(html).toContain(`href="/open/entity/${uid("c")}"`);
    expect(html).toContain("Brand voice");
    expect(html).toContain(`href="/open/entity/${uid("d")}"`);
    expect(html).toContain("Related to");
  });

  it("names an incoming group with the relation's inverse label", () => {
    types = {
      data: {
        types: [
          {
            type: "works_at",
            label: "Works at",
            inverseLabel: "Employs",
            directionality: "unidirectional",
          },
        ],
      },
    };
    graph = {
      data: {
        neighbors: [
          neighbor({
            id: "p",
            name: "Ada",
            subtype: "person",
            edgeType: "works_at",
            direction: "incoming",
          }),
        ],
      },
    };
    const html = draw("company");
    expect(html).toContain("Employs");
    expect(html).not.toContain("Works at");
  });

  it("marks an incoming group with no inverse label as reversed", () => {
    graph = {
      data: {
        neighbors: [neighbor({ id: "t", name: "Task", direction: "incoming" })],
      },
    };
    expect(draw()).toContain('data-reversed="true"');
  });

  it("caps a group and offers Show all with the full count", () => {
    graph = {
      data: {
        neighbors: Array.from({ length: 9 }, (_, i) =>
          neighbor({ id: `n${i}`, name: `Note ${i}`, subtype: "note" })
        ),
      },
    };
    const html = draw();
    expect(html).toContain("Note 5");
    expect(html).not.toContain("Note 6");
    expect(html).toContain("Show all 9");
    expect(html).toContain('aria-label="Show all 9, Related to"');
  });

  it("reads connected files lazily (first four only) and draws an image through the media door", () => {
    graph = {
      data: {
        neighbors: Array.from({ length: 6 }, (_, i) =>
          neighbor({ id: `f${i}`, name: `file-${i}.png`, subtype: "file" })
        ),
      },
    };
    files = {
      [uid("f0")]: {
        data: {
          entity: {
            id: uid("f0"),
            documentId: "doc-f0",
            properties: { mimeType: "image/png" },
          },
        },
      },
    };
    const html = draw();
    expect(filesAsked).toEqual(["f0", "f1", "f2", "f3"].map(uid));
    expect(mediaAsked).toContainEqual({
      documentId: "doc-f0",
      viaEntityId: uid("f0"),
    });
    expect(html).toContain(`href="/open/entity/${uid("f0")}"`);
    expect(html).not.toContain("<iframe");
  });

  it("opens the first stored HTML page in the frame path; the others stay doors", () => {
    graph = {
      data: {
        neighbors: [
          neighbor({ id: "h1", name: "quote.html", subtype: "file" }),
          neighbor({ id: "h2", name: "other.html", subtype: "file" }),
        ],
      },
    };
    const page = (id: string) => ({
      data: {
        entity: {
          id: uid(id),
          documentId: `doc-${id}`,
          properties: { mimeType: "text/html" },
        },
      },
    });
    files = { [uid("h1")]: page("h1"), [uid("h2")]: page("h2") };
    const html = draw();
    expect(documentsAsked).toEqual(["doc-h1"]);
    expect(html).toContain(`href="/open/entity/${uid("h2")}"`);
  });

  it("says a failed file preview failed, and keeps the door", () => {
    graph = {
      data: {
        neighbors: [neighbor({ id: "f", name: "x.png", subtype: "file" })],
      },
    };
    files = { [uid("f")]: { error: new Error("nope") } };
    const html = draw();
    expect(html).toContain("Preview couldn’t be read.");
    expect(html).toContain(`href="/open/entity/${uid("f")}"`);
  });

  it("says a failed read failed, never 'nothing connected'", () => {
    graph = { data: undefined, error: new Error("x") };
    const html = draw();
    expect(html).toContain("couldn’t be read");
    expect(html).not.toContain("Nothing is connected");
  });

  it("is a sized skeleton while the graph reads", () => {
    graph = { data: undefined, isLoading: true };
    expect(draw()).toContain('aria-busy="true"');
  });

  it("with nothing connected, invites: the suggested nouns and the app door", () => {
    const html = draw("task", [
      {
        slug: "project",
        valueType: "entity_id",
        uiHints: { linkedProfileSlug: "project" },
      },
    ]);
    expect(html).toContain("Nothing is connected yet.");
    expect(html).toContain("Project");
    expect(html).toContain("Open in app");
  });

  it("with nothing connected and nothing to suggest, is omitted", () => {
    expect(draw("task", [])).toBe("");
  });

  it("a graph with no node yet (NOT_FOUND) is an honest empty, not a failure", () => {
    graph = { data: undefined, error: { data: { code: "NOT_FOUND" } } };
    const html = draw("task", [
      {
        slug: "project",
        valueType: "entity_id",
        uiHints: { linkedProfileSlug: "project" },
      },
    ]);
    expect(html).toContain("Nothing is connected yet.");
    expect(html).not.toContain("couldn’t be read");
  });

  it("a non-entity neighbour's door goes through the route table, not /open/entity", () => {
    graph = {
      data: {
        neighbors: [
          neighbor({ id: "s1", name: "Review run", kind: "session" }),
        ],
      },
    };
    const html = draw();
    expect(html).toContain(`href="/open/session/${uid("s1")}"`);
    expect(html).not.toContain(`/open/entity/${uid("s1")}`);
  });

  it("a kind with no page is plain text, not a link", () => {
    graph = {
      data: {
        neighbors: [neighbor({ id: "x1", name: "Odd thing", kind: "gizmo" })],
      },
    };
    const html = draw();
    expect(html).toContain("Odd thing");
    expect(html).not.toContain("<a ");
  });

  it("a hidden neighbour is a non-link row that never shows its raw id", () => {
    graph = {
      data: {
        neighbors: [
          neighbor({ id: "raw-uuid-1", name: "raw-uuid-1", hidden: true }),
        ],
      },
    };
    const html = draw();
    expect(html).toContain("Not visible to you");
    expect(html).not.toContain("raw-uuid-1");
    expect(html).not.toContain("<a ");
  });

  it("provenance-only neighbours never claim 'nothing is connected'", () => {
    graph = {
      data: {
        neighbors: [
          neighbor({
            id: "cap1",
            name: "Memo",
            kind: "capture",
            edgeType: "produced",
            direction: "incoming",
            via: "links",
          }),
        ],
      },
    };
    const html = draw("task", [
      {
        slug: "project",
        valueType: "entity_id",
        uiHints: { linkedProfileSlug: "project" },
      },
    ]);
    expect(html).not.toContain("Nothing is connected");
    expect(html).not.toContain("<a ");
  });

  it("a non-file neighbour never reads an entity", () => {
    graph = {
      data: {
        neighbors: [
          neighbor({ id: "a", name: "A", subtype: "note" }),
          neighbor({ id: "b", name: "B", subtype: "company" }),
        ],
      },
    };
    draw();
    expect(filesAsked).toEqual([]);
  });

  it("a failed relation vocabulary still draws every tie, named plainly", () => {
    types = { data: undefined, error: new Error("x") };
    graph = {
      data: {
        neighbors: [neighbor({ id: "c", name: "Acme", edgeType: "works_at" })],
      },
    };
    const html = draw();
    expect(html).toContain(`href="/open/entity/${uid("c")}"`);
    expect(html).toContain("Works at");
  });

  it("a pending preview reserves the thumbnail box and is not 'failed'", () => {
    graph = {
      data: {
        neighbors: [neighbor({ id: "f", name: "x.png", subtype: "file" })],
      },
    };
    const html = draw();
    expect(html).toContain("h-40 w-full max-w-[16rem]");
    expect(html).not.toContain("Preview couldn’t be read.");
  });

  it("a failed preview offers Try again", () => {
    graph = {
      data: {
        neighbors: [neighbor({ id: "f", name: "x.png", subtype: "file" })],
      },
    };
    files = { [uid("f")]: { error: new Error("nope") } };
    expect(draw()).toContain("Try again");
  });

  it("a connected HTML page is drawn WITHOUT the pod bridge and says so", () => {
    graph = {
      data: {
        neighbors: [
          neighbor({ id: "h1", name: "quote.html", subtype: "file" }),
        ],
      },
    };
    files = {
      [uid("h1")]: {
        data: {
          entity: {
            id: uid("h1"),
            documentId: "doc-h1",
            properties: { mimeType: "text/html" },
          },
        },
      },
    };
    doc = {
      isLoading: false,
      error: null,
      data: {
        document: {
          type: "file",
          mimeType: "text/html",
          storageKey: "k",
          workspaceId: "w1",
        },
        content:
          "<!DOCTYPE html><html><body><div id=root></div><script>SynapWidget.onInit(function(i){});</script></body></html>",
      },
    };
    const html = draw();
    const frames = html.match(/<iframe\b[^>]*>/gi) ?? [];
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatch(/sandbox="allow-scripts"/);
    expect(html).toContain("Shown without reading your pod.");
    expect(html).not.toContain("reads nothing from your pod until approved");
    const m = /srcDoc="([^"]*)"|srcdoc="([^"]*)"/i.exec(html);
    const srcdoc = (m?.[1] ?? m?.[2] ?? "").replace(/&quot;/g, '"');
    // `sample: !bridge`: only a frame with NO bridge is served the sample
    // entity (html-preview.test.tsx asserts the same marker).
    expect(srcdoc).toContain("Léa Martin");
  });

  it("reads a file that sits in a later group", () => {
    graph = {
      data: {
        neighbors: [
          ...Array.from({ length: 7 }, (_, i) =>
            neighbor({ id: `n${i}`, name: `Note ${i}`, subtype: "note" })
          ),
          neighbor({
            id: "late",
            name: "late.png",
            subtype: "file",
            edgeType: "other",
          }),
        ],
      },
    };
    draw();
    // The file sits in its own group, inside that group's first 6: read.
    expect(filesAsked).toEqual([uid("late")]);
  });

  it("a hidden FILE neighbour is never read, never a figure, never a link", () => {
    graph = {
      data: {
        neighbors: [
          neighbor({
            id: "hf",
            name: "secret.png",
            subtype: "file",
            hidden: true,
          }),
        ],
      },
    };
    const html = draw();
    expect(filesAsked).toEqual([]);
    expect(html).not.toContain("h-40 w-full");
    expect(html).not.toContain("<a ");
    expect(html).toContain("Not visible to you");
  });

  it("a hidden row reveals nothing of its kind", () => {
    graph = {
      data: {
        neighbors: [
          neighbor({ id: "hp", name: "x", subtype: "person", hidden: true }),
          neighbor({ id: "ok", name: "Acme", subtype: "company" }),
        ],
      },
    };
    const html = draw();
    expect(html).toContain("Not visible to you");
    expect(html).not.toContain("Person");
    expect(html).toContain("lucide-box");
    expect(html).not.toContain("lucide-user");
  });
});

describe("collapsed and visible items", () => {
  const item = (id: string) =>
    ({
      id,
      name: id,
      kind: "file",
      graphKind: "entity",
      edgeType: "t",
      direction: "outgoing",
      via: null,
    }) as const;
  const many = Array.from({ length: GROUP_CAP + 2 }, (_, i) => item(`i${i}`));

  it("the collapsed set stops at the cap", () => {
    const out = collapsedItems([{ items: many }], new Set());
    expect(out).toHaveLength(GROUP_CAP);
    expect(out.map((i) => i.id)).not.toContain(`i${GROUP_CAP}`);
  });
  it("hidden items are not in the collapsed set", () => {
    expect(
      collapsedItems([{ items: many }], new Set(["i0"])).map((i) => i.id)
    ).not.toContain("i0");
  });
  it("expanded returns everything", () => {
    expect(visibleItems({ items: many }, { expanded: true })).toHaveLength(
      many.length
    );
  });
  it("every previewed file is in the drawn (collapsed) set", () => {
    const drawn = new Set(
      visibleItems({ items: many }, { expanded: false }).map((i) => i.id)
    );
    for (const f of collapsedItems([{ items: many }], new Set())) {
      expect(drawn.has(f.id)).toBe(true);
    }
  });
});

describe("neighbourMedia", () => {
  const read = (mimeType: string | undefined, documentId = "d1") => ({
    entity: {
      id: "f",
      documentId,
      properties: mimeType ? { mimeType } : {},
    },
  });
  it("reads an image mime in any case", () => {
    expect(neighbourMedia("f", read("IMAGE/PNG")).kind).toBe("image");
  });
  it("reads text/html with a charset as a page", () => {
    expect(neighbourMedia("f", read("text/html; charset=utf-8"))).toEqual({
      kind: "page",
      documentId: "d1",
    });
  });
  it("an html file with no document is plain", () => {
    expect(neighbourMedia("f", read("text/html", "")).kind).toBe("plain");
  });
  it("a pdf is plain, never an image", () => {
    expect(neighbourMedia("f", read("application/pdf")).kind).toBe("plain");
  });
});
