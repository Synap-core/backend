/**
 * The pod's third-party decision-model consent, driven through the REAL
 * `capture.structure` procedure and the REAL consent reader
 * (`readPodThirdPartyDecisionModelConsent`).
 *
 * Asserts what leaves the pod, by recording every IS `workspaceTiebreak` call:
 *  - consent OFF (absent) / FAILED read ⇒ the step-3a decision call (the one
 *    with `allowFallback: false`) is never made, and the step-1c tie-break
 *    carries `allowDecisionModel: false`;
 *  - consent ON ⇒ step 3a fires and step 1c allows the decision model.
 *
 * Stubbed at module boundaries (same shape as `capture.structure-progress`):
 * `getDb` → a select chain answering per table (two domain workspaces; the
 * pod_settings row under test, or a thrown read), the IS client, profiles,
 * placement (two candidates ⇒ step 1c runs), search, routing memory, relation
 * types, embeddings, the read-only guard, the intake recorder.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  podSettings: null as unknown,
  workspaces: null as unknown,
  consentRow: undefined as unknown,
  consentReadFails: false,
  tiebreaks: [] as Array<Record<string, unknown>>,
}));

const WS = [
  {
    id: "ws-crm",
    name: "CRM",
    description: "clients",
    workspaceType: "personal",
    systemSlug: null,
    settings: {},
  },
  {
    id: "ws-fin",
    name: "Finance",
    description: "money",
    workspaceType: "personal",
    systemSlug: null,
    settings: {},
  },
];

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  h.podSettings = actual.podSettings;
  h.workspaces = actual.workspaces;
  const chain = (table: unknown): unknown =>
    new Proxy(() => {}, {
      get: (_t, prop) => {
        if (prop === "then") {
          return (
            resolve: (rows: unknown[]) => void,
            reject: (e: unknown) => void
          ) => {
            if (table === h.podSettings) {
              if (h.consentReadFails) return reject(new Error("db down"));
              return resolve(h.consentRow === undefined ? [] : [h.consentRow]);
            }
            if (table === h.workspaces) return resolve(WS);
            return resolve([]);
          };
        }
        if (prop === "from") return (t: unknown) => chain(t);
        return () => chain(table);
      },
    });
  return {
    ...actual,
    getDb: async () => ({ select: () => chain(null) }),
    ProfileResolutionService: class {
      async getAccessibleProfiles() {
        return [{ id: "p-deal", slug: "deal", displayName: "Deal" }];
      }
      async getEffectiveProperties() {
        return [];
      }
    },
    resolveWorkspacePlacement: async () => ({
      candidates: [
        { id: "ws-crm", name: "CRM" },
        { id: "ws-fin", name: "Finance" },
      ],
      rung: 2,
      workspaceId: null,
      reason: "role enabled in two workspaces",
      confidence: null,
    }),
    assembleStructureContext: async () => ({
      instructions: undefined,
      guidelines: [],
      guidelineStatus: "ok",
    }),
  };
});

vi.mock("../../utils/intelligence-routing.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveIntelligenceService: async () => ({
    client: {
      structure: async () => ({
        entities: [
          {
            tempId: "t1",
            profileSlug: "deal",
            title: "Acme deal",
            confidence: 0.9,
            properties: {},
          },
        ],
        relations: [],
        followUp: null,
      }),
      workspaceTiebreak: async (input: Record<string, unknown>) => {
        h.tiebreaks.push(input);
        return null;
      },
    },
  }),
}));

vi.mock("@synap/search", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  searchService: { searchCollection: async () => ({ results: [] }) },
}));
vi.mock("../../services/routing-memory.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchRoutingMemory: async () => undefined,
}));
vi.mock("../../utils/relation-types.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listEffectiveRelationTypes: async () => [],
}));
vi.mock(
  "../../services/retrieval/hybrid-recall.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    embedQuery: async () => ({ embedding: null }),
  })
);
vi.mock("../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: async () => false,
}));
vi.mock(
  "../../services/intake/record-structure-intake.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    recordStructureIntake: async () => ({
      sessionId: "33333333-3333-4333-8333-333333333333",
      intake: { requestedSessionIgnored: false },
    }),
  })
);

import { captureRouter } from "../capture.js";

const structure = () =>
  captureRouter
    .createCaller({
      authenticated: true,
      userId: `user-${randomUUID()}`,
      workspaceId: null,
      sessionId: null,
      agentUserId: null,
    } as never)
    .structure({ text: "Acme deal closes Friday" });

/** Step 3a is the ONLY call that asks for the decision model alone. */
const step3a = () => h.tiebreaks.filter((t) => t.allowFallback === false);
const step1c = () => h.tiebreaks.filter((t) => t.allowFallback !== false);

beforeEach(() => {
  h.consentRow = undefined;
  h.consentReadFails = false;
  h.tiebreaks.length = 0;
});

describe("capture.structure honours the pod's decision-model consent", () => {
  it("OFF by default (no setting): no step-3a call; step 1c disallows the decision model", async () => {
    await structure();
    expect(step3a()).toHaveLength(0);
    // Non-vacuity: the tie-break path really ran.
    expect(step1c()).toHaveLength(1);
    expect(step1c()[0]!.allowDecisionModel).toBe(false);
  });

  it("OFF when the read FAILS (fail closed)", async () => {
    h.consentReadFails = true;
    await structure();
    expect(step3a()).toHaveLength(0);
    expect(step1c()).toHaveLength(1);
    expect(step1c()[0]!.allowDecisionModel).toBe(false);
  });

  it("ON (opted in): step 3a asks the decision model; step 1c allows it", async () => {
    h.consentRow = {
      settings: { intelligenceDefaults: { thirdPartyDecisionModel: true } },
    };
    await structure();
    expect(step3a()).toHaveLength(1);
    expect(step3a()[0]!.candidates).toEqual([
      { id: "ws-crm", name: "CRM", description: "clients" },
      { id: "ws-fin", name: "Finance", description: "money" },
    ]);
    expect(step1c()).toHaveLength(1);
    expect(step1c()[0]!.allowDecisionModel).toBe(true);
  });
});
