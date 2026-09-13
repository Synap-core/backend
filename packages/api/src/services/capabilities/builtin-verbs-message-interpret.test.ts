import { describe, it, expect, vi, beforeEach } from "vitest";

// message.interpret is the proactive keystone: its handler runs the EXISTING
// extraction engine (client.structure — reached the SAME way, via
// resolveIntelligenceService) over a message's `content`, then files ONE governed
// pending proposal through the SAME capture door (submitCaptureGraph →
// insertPendingProposal). We mock the IS routing + the capture-graph door to
// assert (a) `guidelines` is injected as the structure `instructions`, (b) the
// tempId-keyed structure plan is routed into submitCaptureGraph via the REAL
// shared mapper (kept unmocked), (c) no agentUserId is threaded (default propose),
// and (d) the verb is registered read-only (auto-runs inside an automation).
const h = vi.hoisted(() => ({
  structure: vi.fn(),
  submitCaptureGraph: vi.fn(),
  fetchRoutingMemory: vi.fn(async () => null),
  // The extractor's offered kinds. Default: none (no `availableProfiles` hint).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildAvailableProfiles: vi.fn((_p: any): any => undefined),
  // Default: no stored guidelines → merged instructions == explicit only, so the
  // pre-existing assertions (explicit `guidelines` → `instructions`) are unchanged.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveGuidelines: vi.fn(async (_arg: any) => [] as Array<{ text: string }>),
  // Default: no producer edge → channelType/bridgeId both omitted (honest,
  // never fabricated), matching a channel with no derivable origin.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getChannelOrigin: vi.fn(async (..._args: any[]) => ({
    channelId: "chan-1",
    workspaceId: null as string | null,
    externalSource: null as string | null,
    origin: null as {
      producerType: string;
      producerId: string | null;
      producerName: string | null;
      label: string | null;
    } | null,
  })),
}));

vi.mock("../../utils/intelligence-routing.js", () => ({
  resolveIntelligenceService: vi.fn(async () => ({
    client: { structure: h.structure },
  })),
}));
vi.mock("../routing-memory.js", () => ({
  fetchRoutingMemory: h.fetchRoutingMemory,
}));
vi.mock("../capture-agent/submit-capture-graph.js", () => ({
  submitCaptureGraph: h.submitCaptureGraph,
}));
// NOTE: capture-agent/capture-structure-to-graph.js is deliberately NOT mocked —
// the real shared mapper (tempId→ref, contextTempId→contextRef, dangling-drop)
// is exercised so we prove the structure plan actually reaches the graph door.

// Keep sibling module-load deps happy (mirrors builtin-verbs-generate.test.ts).
vi.mock("@synap/database", () => {
  const mk = (name: string) =>
    new Proxy(
      { __table: name },
      { get: (t, p) => (p in t ? (t as never)[p] : `${name}.${String(p)}`) }
    );
  return {
    db: {},
    eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
    and: (...xs: unknown[]) => ({ op: "and", xs }),
    or: (...xs: unknown[]) => ({ op: "or", xs }),
    isNull: (col: unknown) => ({ op: "isNull", col }),
    desc: (col: unknown) => ({ op: "desc", col }),
    drizzleSql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({
      op: "sql",
      strings,
      vals,
    }),
    channels: mk("channels"),
    views: mk("views"),
    entities: mk("entities"),
    relations: mk("relations"),
    messages: mk("messages"),
    getWorkspaceMembership: vi.fn(),
    insertChannelMessage: vi.fn(),
    resolveGuidelines: h.resolveGuidelines,
    ProfileResolutionService: class {
      async getAccessibleProfiles() {
        return [];
      }
    },
    // THE REAL assembler (database src), with only its resolver swapped for the
    // hoisted mock below — so interpret's instructions go through the actual
    // compose/budget/framing code, not a test re-implementation.
    assembleStructureContext: async (input: unknown) => {
      // Untyped on purpose: a `typeof import()` of another package's src trips
      // project references (TS6305); the handler's own call is typed.
      const real = (await vi.importActual(
        "../../../../database/src/utils/structure-context.js"
      )) as { assembleStructureContext: (i: unknown) => Promise<unknown> };
      return real.assembleStructureContext(input);
    },
  };
});
// importOriginal + spread, never a total mock: the real assembler imports more
// than `resolveGuidelines` from this module (e.g. `GUIDELINE_TEXT_MAX`), and a
// total factory went dark — every test died at collection — the moment one was
// added. Only the resolver is swapped. Untyped on purpose (TS6305, see above).
vi.mock(
  "../../../../database/src/utils/config-settings.js",
  async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, resolveGuidelines: h.resolveGuidelines };
  }
);
vi.mock("../../routers/capture.js", () => ({
  buildAvailableProfiles: h.buildAvailableProfiles,
  withEffectiveProperties: async (_svc: unknown, p: unknown) => p,
}));
vi.mock("./place-artboard-deck.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./place-artboard-deck.js")>();
  return { ...actual, placeArtboardDeck: vi.fn() };
});
vi.mock("../mail-feed/triage.js", () => ({ triageEmails: vi.fn() }));
vi.mock("../mail-feed/generate.js", () => ({ generateViaIS: vi.fn() }));
vi.mock("../signal/channel-stack.js", () => ({
  getChannelOrigin: h.getChannelOrigin,
}));

import { BUILTIN_VERBS, READ_ONLY_BUILTIN_VERBS } from "./builtin-verbs.js";

describe("message.interpret — registry", () => {
  it("is registered and marked read-only (files a governed review item → auto-run)", () => {
    expect(typeof BUILTIN_VERBS["message.interpret"]).toBe("function");
    expect(READ_ONLY_BUILTIN_VERBS.has("message.interpret")).toBe(true);
  });
});

describe("message.interpret — handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("injects `guidelines` as the structure `instructions` and routes the plan into the governed proposal door", async () => {
    h.structure.mockResolvedValueOnce({
      entities: [
        {
          tempId: "e0",
          profileSlug: "person",
          title: "Ada Lovelace",
          properties: { email: "ada@acme.com" },
          confidence: 0.9,
          facets: [{ profileSlug: "client", contextTempId: "e1" }],
        },
        {
          tempId: "e1",
          profileSlug: "deal",
          title: "March demo",
          confidence: 0.8,
        },
      ],
      relations: [
        { sourceTempId: "e0", targetTempId: "e1", relationType: "involved_in" },
      ],
      followUp: null,
    });
    h.submitCaptureGraph.mockResolvedValueOnce({
      proposalId: "prop-1",
      reviewUrl: "https://pod/open/proposal/prop-1",
      entityCount: 2,
      relationCount: 1,
      bindingCount: 0,
      summary: "…",
      applied: false,
      writeReceipt: { state: "pending" },
    });

    const out = (await BUILTIN_VERBS["message.interpret"](
      {
        content: "Met Ada from Acme, she wants a March demo",
        guidelines: "new-lead intake: prefer contact/deal",
        workspaceId: "ws-1",
      },
      { userId: "u1", workspaceId: "ws-ambient" }
    )) as { status: string; proposalId?: string; entityCount: number };

    // (a) guidelines → instructions on the SAME client.structure call.
    expect(h.structure).toHaveBeenCalledTimes(1);
    const structureArg = h.structure.mock.calls[0][0];
    expect(structureArg.text).toBe("Met Ada from Acme, she wants a March demo");
    expect(structureArg.instructions).toBe(
      "new-lead intake: prefer contact/deal"
    );

    // (b) the REAL mapper turned the tempId plan into a ref-keyed graph and (c)
    // it reached submitCaptureGraph with NO agentUserId (default propose), scoped
    // to the explicit workspace lens.
    expect(h.submitCaptureGraph).toHaveBeenCalledTimes(1);
    const graphArg = h.submitCaptureGraph.mock.calls[0][0];
    expect(graphArg.agentUserId).toBeUndefined();
    expect(graphArg.userId).toBe("u1");
    expect(graphArg.workspaceId).toBe("ws-1");
    expect(graphArg.entities).toHaveLength(2);
    expect(graphArg.entities[0]).toMatchObject({
      ref: "e0",
      profileSlug: "person",
      title: "Ada Lovelace",
      facets: [{ profileSlug: "client", contextRef: "e1" }],
    });
    expect(graphArg.relations).toEqual([
      { sourceRef: "e0", targetRef: "e1", type: "involved_in" },
    ]);

    // (d) governed receipt surfaced verbatim.
    expect(out.status).toBe("proposed");
    expect(out.proposalId).toBe("prop-1");
    expect(out.entityCount).toBe(2);
  });

  it("merges scoped guidelines (general → specific) with the explicit `guidelines`, explicit LAST (wins)", async () => {
    // Stored guidelines, already ordered general → specific by resolveGuidelines.
    h.resolveGuidelines.mockResolvedValueOnce([
      { text: "Default: prefer contact/deal" },
      { text: "This channel: use Proton not Google Drive" },
    ]);
    h.structure.mockResolvedValueOnce({
      entities: [],
      relations: [],
      followUp: null,
    });

    await BUILTIN_VERBS["message.interpret"](
      {
        content: "some message",
        guidelines: "explicit override wins",
        channelId: "chan-1",
        workspaceId: "ws-1",
      },
      { userId: "u1", workspaceId: "ws-1", verbId: "verb-xyz" }
    );

    expect(h.resolveGuidelines).toHaveBeenCalledTimes(1);
    const resolveArg = h.resolveGuidelines.mock.calls[0][0] as unknown as {
      userId: string;
      channelId?: string;
      capabilityId?: string;
      envelope?: { content?: string };
    };
    expect(resolveArg.userId).toBe("u1");
    expect(resolveArg.channelId).toBe("chan-1");
    expect(resolveArg.capabilityId).toBe("verb-xyz");
    expect(resolveArg.envelope?.content).toBe("some message");

    // Scoped guidelines first (general → specific), explicit appended LAST.
    const structureArg = h.structure.mock.calls[0][0];
    expect(structureArg.instructions).toBe(
      "Default: prefer contact/deal\n\n" +
        "This channel: use Proton not Google Drive\n\n" +
        "explicit override wins"
    );
  });

  it("derives channelType + bridgeId from the channel's origin and passes them to resolveGuidelines", async () => {
    h.getChannelOrigin.mockResolvedValueOnce({
      channelId: "chan-1",
      workspaceId: "ws-1",
      externalSource: "discord",
      origin: {
        producerType: "tool",
        producerId: "tool-42",
        producerName: null,
        label: null,
      },
    });
    h.structure.mockResolvedValueOnce({
      entities: [],
      relations: [],
      followUp: null,
    });

    await BUILTIN_VERBS["message.interpret"](
      { content: "some message", channelId: "chan-1", workspaceId: "ws-1" },
      { userId: "u1", workspaceId: "ws-1", verbId: "verb-xyz" }
    );

    expect(h.getChannelOrigin).toHaveBeenCalledWith("u1", "chan-1");
    const resolveArg = h.resolveGuidelines.mock.calls[0][0] as unknown as {
      channelType?: string;
      bridgeId?: string;
    };
    expect(resolveArg.channelType).toBe("discord");
    expect(resolveArg.bridgeId).toBe("tool-42");
  });

  it("omits bridgeId when the producer isn't a tool (honest — never fabricated)", async () => {
    h.getChannelOrigin.mockResolvedValueOnce({
      channelId: "chan-1",
      workspaceId: "ws-1",
      externalSource: "discord",
      origin: {
        producerType: "source",
        producerId: "discord-bridge-slug",
        producerName: null,
        label: null,
      },
    });
    h.structure.mockResolvedValueOnce({
      entities: [],
      relations: [],
      followUp: null,
    });

    await BUILTIN_VERBS["message.interpret"](
      { content: "some message", channelId: "chan-1", workspaceId: "ws-1" },
      { userId: "u1", workspaceId: "ws-1" }
    );

    const resolveArg = h.resolveGuidelines.mock.calls[0][0] as unknown as {
      channelType?: string;
      bridgeId?: string;
    };
    expect(resolveArg.channelType).toBe("discord");
    expect(resolveArg.bridgeId).toBeUndefined();
  });

  it("omits channelType/bridgeId when there is no channelId (no lookup attempted)", async () => {
    h.structure.mockResolvedValueOnce({
      entities: [],
      relations: [],
      followUp: null,
    });

    await BUILTIN_VERBS["message.interpret"](
      { content: "some message" },
      { userId: "u1", workspaceId: "ws-1" }
    );

    expect(h.getChannelOrigin).not.toHaveBeenCalled();
    const resolveArg = h.resolveGuidelines.mock.calls[0][0] as unknown as {
      channelType?: string;
      bridgeId?: string;
    };
    expect(resolveArg.channelType).toBeUndefined();
    expect(resolveArg.bridgeId).toBeUndefined();
  });

  it("injects scoped guidelines even when no explicit `guidelines` is given", async () => {
    h.resolveGuidelines.mockResolvedValueOnce([
      { text: "Only stored guideline" },
    ]);
    h.structure.mockResolvedValueOnce({
      entities: [],
      relations: [],
      followUp: null,
    });

    await BUILTIN_VERBS["message.interpret"](
      { content: "hello" },
      { userId: "u1", workspaceId: null }
    );

    expect(h.structure.mock.calls[0][0].instructions).toBe(
      "Only stored guideline"
    );
  });

  it("a kind-scoped and a source-scoped guideline both reach the structure instructions (framed by kind), with sourceKind 'text' and the extractor's kinds in play", async () => {
    // The resolver gets the SAME context the rungs match on; return what a
    // real store would match for it.
    h.resolveGuidelines.mockImplementationOnce(
      async (arg: { sourceKind?: string; entityKinds?: string[] }) => [
        ...(arg.sourceKind === "text"
          ? [
              {
                id: "g-src",
                version: 1,
                scopeKind: "sourceKind",
                scopeRef: "text",
                specificity: 2,
                text: "Messages: one idea per entity",
              },
            ]
          : []),
        ...(arg.entityKinds?.includes("person")
          ? [
              {
                id: "g-kind",
                version: 4,
                scopeKind: "entityKind",
                scopeRef: "person",
                specificity: 3,
                text: "Capture the LinkedIn URL",
              },
            ]
          : []),
      ]
    );
    h.structure.mockResolvedValueOnce({
      entities: [],
      relations: [],
      followUp: null,
    });

    // availableProfiles comes from capture.ts's builder — `person` is a kind
    // the extractor is offered.
    h.buildAvailableProfiles.mockReturnValueOnce([
      { slug: "person", displayName: "Person" },
    ]);

    await BUILTIN_VERBS["message.interpret"](
      { content: "Met Ada", guidelines: "explicit" },
      { userId: "u1", workspaceId: null }
    );

    const resolveArg = h.resolveGuidelines.mock.calls[0][0] as unknown as {
      sourceKind?: string;
      entityKinds?: string[];
    };
    expect(resolveArg.sourceKind).toBe("text");
    expect(resolveArg.entityKinds).toEqual(["person"]);
    expect(h.structure.mock.calls[0][0].instructions).toBe(
      "Messages: one idea per entity\n\n" +
        'When structuring a "person": Capture the LinkedIn URL\n\n' +
        "explicit"
    );
  });

  it("NO-OP: with no stored guideline the instructions are exactly the explicit text, and absent when there is none", async () => {
    h.structure.mockResolvedValue({
      entities: [],
      relations: [],
      followUp: null,
    });
    await BUILTIN_VERBS["message.interpret"](
      { content: "a", guidelines: "  only explicit  " },
      { userId: "u1", workspaceId: null }
    );
    await BUILTIN_VERBS["message.interpret"](
      { content: "b" },
      { userId: "u1", workspaceId: null }
    );
    expect(h.structure.mock.calls[0][0].instructions).toBe("only explicit");
    expect("instructions" in h.structure.mock.calls[1][0]).toBe(false);
    h.structure.mockReset();
  });

  it("a FAILED guideline read still structures with the explicit text (never a silent 'no guidelines')", async () => {
    h.resolveGuidelines.mockRejectedValueOnce(new Error("db down"));
    h.structure.mockResolvedValueOnce({
      entities: [],
      relations: [],
      followUp: null,
    });
    const out = (await BUILTIN_VERBS["message.interpret"](
      { content: "a", guidelines: "explicit" },
      { userId: "u1", workspaceId: null }
    )) as { guidelineStatus?: string };
    expect(h.structure.mock.calls[0][0].instructions).toBe("explicit");
    expect(out.guidelineStatus).toBe("unavailable");
  });

  it("does NOT file a proposal when the plan is a clarifying followUp", async () => {
    h.structure.mockResolvedValueOnce({
      entities: [],
      relations: [],
      followUp: "Which Acme — the Berlin or the SF one?",
    });

    const out = (await BUILTIN_VERBS["message.interpret"](
      { content: "book a demo with Acme" },
      { userId: "u1", workspaceId: null }
    )) as { status: string; reason: string };

    expect(h.submitCaptureGraph).not.toHaveBeenCalled();
    expect(out.status).toBe("no_proposal");
    expect(out.reason).toBe("needs-clarification");
  });

  it("reports structuring-unavailable (no proposal) when the IS returns null", async () => {
    h.structure.mockResolvedValueOnce(null);

    const out = (await BUILTIN_VERBS["message.interpret"](
      { content: "anything" },
      { userId: "u1", workspaceId: null }
    )) as { status: string; reason: string };

    expect(h.submitCaptureGraph).not.toHaveBeenCalled();
    expect(out.status).toBe("no_proposal");
    expect(out.reason).toBe("structuring-unavailable");
  });
});
