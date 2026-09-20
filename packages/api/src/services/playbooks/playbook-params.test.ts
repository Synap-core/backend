import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * PARAMS AT THE FUNNEL — the SEAM, not the ends.
 *
 * `validatePlaybookParams` has its own unit tests in `@synap/playbooks`. What
 * those cannot prove is that the funnel CALLS it: the defect being fixed here
 * was not a wrong rule, it was no rule at all — `instantiateSessionRow`
 * consumed the param map, stringified it and threw it away, so `required`,
 * `default` and `type` were read by nobody on any run path.
 *
 * So these drive the REAL `instantiateSession` against a fake db and assert on
 * the row it actually inserts. Nothing is hand-built between the declaration
 * and the write.
 */

type Row = Record<string, unknown>;

const inserted: Array<{ table: unknown; values: Row }> = [];

/** The playbook under test — mutated per case, read by the fake db. */
let PLAYBOOK: Row = {};

function basePlaybook(over: Row = {}): Row {
  return {
    id: "pb-1",
    workspaceId: "ws-1",
    name: "Weekly digest",
    goalTemplate: "Write a @{arg:tone} digest about @{arg:topic}.",
    stages: [],
    criteria: [],
    params: [],
    expectedOutputs: [],
    executor: "is-agent",
    inputStrategy: null,
    channelSpec: {},
    metadata: {},
    version: 1,
    ...over,
  };
}

function makeDb() {
  return {
    query: {
      playbooks: { findFirst: async () => PLAYBOOK },
      entities: { findFirst: async () => undefined },
      focusSessions: { findFirst: async () => undefined },
      channels: { findFirst: async () => undefined },
    },
    insert(table: unknown) {
      return {
        values(values: Row) {
          const row = { id: `row-${inserted.length + 1}`, ...values };
          inserted.push({ table, values: row });
          const self = {
            returning: async () => [row],
            onConflictDoNothing: () => self,
            onConflictDoUpdate: async () => [row],
          };
          return self;
        },
      };
    },
  };
}

let db = makeDb();

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, getDb: async () => db };
});
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    warn: () => {},
    error: () => {},
    info: () => {},
    debug: () => {},
  }),
}));
vi.mock("../links/links-service.js", () => ({
  createLinks: async () => [],
  getLinksFor: async () => [],
  extractCapabilities: () => [],
  resolveGrantedCapabilities: async () => [],
}));

const {
  instantiateSession,
  PlaybookParamsError,
  RUN_PROMPT_METADATA_KEY,
  RUN_PARAMS_METADATA_KEY,
} = await import("./playbook-lifecycle.js");
const { focusSessions } = await import("@synap/database");
const { PARAM_SLOT_KIND } = await import("@synap-core/types/focus-sessions");

/** The focus_sessions row the funnel actually wrote. */
function sessionRow(): Row {
  const hit = inserted.find((i) => i.table === focusSessions);
  if (!hit) throw new Error("no focus_sessions insert was made");
  return hit.values;
}
function metadataOf(): Record<string, unknown> {
  return sessionRow().metadata as Record<string, unknown>;
}

const RUN = {
  playbookId: "pb-1",
  workspaceId: "ws-1",
  userId: "user-1",
} as const;

beforeEach(() => {
  inserted.length = 0;
  db = makeDb();
  PLAYBOOK = basePlaybook();
});

describe("the funnel APPLIES declared defaults to the prompt", () => {
  it("a default the caller did not supply reaches metadata.prompt", async () => {
    // THE BUG: before this, `default` was read by nobody on any run path, so
    // this rendered "Write a  digest about pricing." — the declaration was
    // decorative.
    PLAYBOOK = basePlaybook({
      params: [
        { name: "tone", type: "text", default: "warm" },
        { name: "topic", type: "text" },
      ],
    });

    await instantiateSession({ ...RUN, params: { topic: "pricing" } });

    expect(metadataOf()[RUN_PROMPT_METADATA_KEY]).toBe(
      "Write a warm digest about pricing."
    );
  });

  it("a supplied value beats the default, and a number coerces to its text", async () => {
    PLAYBOOK = basePlaybook({
      goalTemplate: "Digest @{arg:n} items, tone @{arg:tone}.",
      params: [
        { name: "tone", type: "text", default: "warm" },
        { name: "n", type: "number" },
      ],
    });

    await instantiateSession({
      ...RUN,
      params: { tone: "blunt", n: "12" },
    });

    expect(metadataOf()[RUN_PROMPT_METADATA_KEY]).toBe(
      "Digest 12 items, tone blunt."
    );
  });
});

describe("the funnel STORES the answers", () => {
  it("resolved values land on metadata.params", async () => {
    PLAYBOOK = basePlaybook({
      params: [
        { name: "tone", type: "text", default: "warm" },
        { name: "topic", type: "text" },
      ],
    });

    await instantiateSession({ ...RUN, params: { topic: "pricing" } });

    expect(metadataOf()[RUN_PARAMS_METADATA_KEY]).toEqual({
      tone: "warm",
      topic: "pricing",
    });
  });

  it("a param-less playbook stores {}, not nothing — absent must stay readable as 'predates the field'", async () => {
    await instantiateSession(RUN);
    expect(metadataOf()[RUN_PARAMS_METADATA_KEY]).toEqual({});
  });

  it("does not disturb the caller's own metadata or the title source", async () => {
    await instantiateSession({ ...RUN, metadata: { mine: 1 } });
    const md = metadataOf();
    expect(md.mine).toBe(1);
    expect(md.titleSource).toBe("derived");
  });
});

describe("unanswered REQUIRED param — the two doors", () => {
  beforeEach(() => {
    PLAYBOOK = basePlaybook({
      params: [
        { name: "tone", type: "text", default: "warm" },
        { name: "topic", type: "text", label: "Topic", required: true },
      ],
    });
  });

  it("REFUSES by default (the interactive doors — the form is the gate)", async () => {
    await expect(instantiateSession(RUN)).rejects.toThrow(PlaybookParamsError);
    // Nothing was written: a refusal that left a half-row behind would be worse
    // than the bug.
    expect(inserted).toHaveLength(0);
  });

  it("the refusal NAMES the field by its label", async () => {
    await expect(instantiateSession(RUN)).rejects.toThrow(/Topic/);
  });

  it("OWES a slot on the headless path instead of refusing", async () => {
    const session = await instantiateSession({
      ...RUN,
      onMissingRequired: "owe",
    });
    expect(session).toBeTruthy();

    const slots = sessionRow().expectedOutputs as Array<
      Record<string, unknown>
    >;
    const slot = slots.find((s) => s.kind === PARAM_SLOT_KIND);
    expect(slot).toBeTruthy();
    expect(slot!.owner).toBe("human");
    expect(slot!.blockedReason).toBe("decision");
    // `owedSince` is present IFF owner === 'human' — the feed has nothing to
    // order or age the row by otherwise.
    expect(typeof slot!.owedSince).toBe("string");
    expect(slot!.why).toMatch(/Topic/);
  });

  it("the owed run still starts, and the unanswered param is simply absent from the prompt", async () => {
    await instantiateSession({ ...RUN, onMissingRequired: "owe" });
    // The default still applied; the missing one renders as it always did.
    expect(metadataOf()[RUN_PROMPT_METADATA_KEY]).toBe(
      "Write a warm digest about ."
    );
  });

  it("the playbook's OWN declared outputs survive beside the param slot", async () => {
    PLAYBOOK = basePlaybook({
      params: [{ name: "topic", type: "text", required: true }],
      expectedOutputs: [{ kind: "document", label: "The digest" }],
    });
    await instantiateSession({ ...RUN, onMissingRequired: "owe" });
    const slots = sessionRow().expectedOutputs as Array<
      Record<string, unknown>
    >;
    expect(slots.map((s) => s.label)).toEqual(["The digest", "Answer: topic"]);
  });

  it("files NO slot when every required param was answered", async () => {
    await instantiateSession({
      ...RUN,
      params: { topic: "pricing" },
      onMissingRequired: "owe",
    });
    const slots = sessionRow().expectedOutputs as Array<
      Record<string, unknown>
    >;
    expect(slots.some((s) => s.kind === PARAM_SLOT_KIND)).toBe(false);
  });
});

describe("a MISTYPED value refuses on BOTH paths", () => {
  beforeEach(() => {
    PLAYBOOK = basePlaybook({
      params: [{ name: "n", type: "number" }],
      goalTemplate: "Digest @{arg:n} items.",
    });
  });

  it("refuses on the interactive path", async () => {
    await expect(
      instantiateSession({ ...RUN, params: { n: "soon" } })
    ).rejects.toThrow(/"n" must be a number/);
  });

  it("refuses on the OWE path too — a malformed call is not a question for a human", async () => {
    await expect(
      instantiateSession({
        ...RUN,
        params: { n: "soon" },
        onMissingRequired: "owe",
      })
    ).rejects.toThrow(PlaybookParamsError);
    expect(inserted).toHaveLength(0);
  });
});

describe("a playbook that declares nothing is untouched", () => {
  it("an undeclared supplied key still substitutes (pre-existing behaviour)", async () => {
    PLAYBOOK = basePlaybook({
      goalTemplate: "Do @{arg:whatever}.",
      params: [],
    });
    await instantiateSession({ ...RUN, params: { whatever: "the thing" } });
    expect(metadataOf()[RUN_PROMPT_METADATA_KEY]).toBe("Do the thing.");
  });
});
