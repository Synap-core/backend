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
vi.mock("@synap-core/core", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
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

/** What `subjectKindSlugs` answers (kind, ancestors, roles) — per case. */
let SUBJECT_KINDS: string[] = [];
const kindReads: string[] = [];
vi.mock("./assert-subject-kind.js", () => ({
  subjectKindSlugs: async (input: { subjectId: string }) => {
    kindReads.push(input.subjectId);
    return SUBJECT_KINDS;
  },
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
  SUBJECT_KINDS = [];
  kindReads.length = 0;
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

  it("an optional declared {name} param left unanswered renders empty, never as braces", async () => {
    PLAYBOOK = basePlaybook({
      goalTemplate: "Write about {topic} for {audience}.",
      params: [
        { name: "topic", type: "text", required: true },
        { name: "audience", type: "text" },
      ],
    });
    await instantiateSession({ ...RUN, params: { topic: "tides" } });
    expect(metadataOf()[RUN_PROMPT_METADATA_KEY]).toBe(
      "Write about tides for ."
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

describe("a subject-bound run answers its entity param with the subject", () => {
  // The live defect (thearch pod, every daily "Stellar Grant Client" run): the
  // cron binds the subject, never supplies `company`, so the prompt read
  // "Advance  through the Stellar grant process" — and on the `owe` path a
  // person was asked for the very entity the run was bound to.
  const SUBJECT = "5183440e-c841-45f5-982a-b8c95af687fd";
  const stellar = () =>
    basePlaybook({
      name: "Stellar Grant Client",
      goalTemplate:
        "Advance @{arg:company:entity} through the Stellar grant process: understand the project, then Abstract, then Build.",
      params: [
        {
          name: "company",
          type: "entity",
          label: "Company",
          required: true,
          description:
            "The client company this engagement runs for (the session subject).",
        },
      ],
    });
  const withSubjectTitle = (title: string) => {
    db.query.entities.findFirst = (async () => ({ title })) as never;
  };

  it("renders the subject's NAME in the prompt and owes no param slot", async () => {
    PLAYBOOK = stellar();
    withSubjectTitle("Acme Labs");

    await instantiateSession({
      ...RUN,
      params: {},
      subjectId: SUBJECT,
      onMissingRequired: "owe",
    });

    expect(metadataOf()[RUN_PROMPT_METADATA_KEY]).toBe(
      "Advance Acme Labs through the Stellar grant process: understand the project, then Abstract, then Build."
    );
    // The stored answer is the id (what the run was given), not the title.
    expect(metadataOf()[RUN_PARAMS_METADATA_KEY]).toEqual({ company: SUBJECT });
    const slots = (sessionRow().expectedOutputs ?? []) as Array<{
      kind?: string;
    }>;
    expect(slots.some((s) => s.kind === PARAM_SLOT_KIND)).toBe(false);
  });

  it("a caller-supplied entity beats the subject", async () => {
    PLAYBOOK = stellar();
    withSubjectTitle("Acme Labs");
    const OTHER = "11111111-2222-4333-8444-555555555555";

    await instantiateSession({
      ...RUN,
      params: { company: OTHER },
      subjectId: SUBJECT,
    });

    expect(metadataOf()[RUN_PARAMS_METADATA_KEY]).toEqual({ company: OTHER });
    // Not the subject, so not named — its visibility was never checked here.
    expect(metadataOf()[RUN_PROMPT_METADATA_KEY]).toContain(
      `Advance ${OTHER} through`
    );
  });

  it("two entity params ⇒ the subject binds neither (which one it is is not derivable)", async () => {
    PLAYBOOK = basePlaybook({
      goalTemplate: "Introduce @{arg:a:entity} to @{arg:b:entity}.",
      params: [
        { name: "a", type: "entity", required: true },
        { name: "b", type: "entity", required: true },
      ],
    });
    withSubjectTitle("Acme Labs");

    await instantiateSession({
      ...RUN,
      params: {},
      subjectId: SUBJECT,
      onMissingRequired: "owe",
    });

    expect(metadataOf()[RUN_PARAMS_METADATA_KEY]).toEqual({});
    const slots = (sessionRow().expectedOutputs ?? []) as Array<{
      kind?: string;
    }>;
    expect(slots.filter((s) => s.kind === PARAM_SLOT_KIND)).toHaveLength(2);
  });
});

describe("a run on a subject answers what the playbook declares the subject answers", () => {
  // The live defect (antoinesrvt pod, 2026-11-09, proposal bff02fbb): "Brief
  // it" moved a post to Briefed, its activator filed a run proposal with
  // `params: {}` and the post as subject, and the approval was refused —
  // "This playbook requires Platform" — though the post held post-platform
  // "Instagram". The funnel now reads the declared `from` on each param.
  const POST = "2f500b2f-6610-4c9a-ab59-64039e21561c";
  const produceContent = () =>
    basePlaybook({
      name: "Produce Content",
      goalTemplate:
        "Produce content for {platform} from this idea ({post}) in the {format} format.",
      params: [
        { name: "post", type: "entity", label: "Post", required: true },
        {
          name: "platform",
          type: "text",
          label: "Platform",
          required: true,
          from: "subject.post-platform",
        },
        {
          name: "format",
          type: "text",
          label: "Format",
          from: "subject.post-format",
        },
        { name: "takes", type: "text", label: "Takes (file ids)" },
        { name: "composition", type: "entity", label: "Composition" },
      ],
    });
  const withPost = (properties: Record<string, unknown>) => {
    db.query.entities.findFirst = (async () => ({
      title: "Video 01",
      preview: null,
      properties,
    })) as never;
  };

  it("an activator's run (no params, the post as subject) starts with the post, its platform and its format", async () => {
    PLAYBOOK = produceContent();
    SUBJECT_KINDS = ["post"];
    withPost({ "post-platform": "Instagram", "post-format": "Short Video" });

    await instantiateSession({ ...RUN, params: {}, subjectId: POST });

    expect(metadataOf()[RUN_PARAMS_METADATA_KEY]).toEqual({
      post: POST,
      platform: "Instagram",
      format: "Short Video",
    });
    expect(metadataOf()[RUN_PROMPT_METADATA_KEY]).toBe(
      "Produce content for Instagram from this idea (Video 01) in the Short Video format."
    );
    // Two entity params: which one is the post was read from its kinds.
    expect(kindReads).toEqual([POST]);
  });

  it("a post with no platform is still REFUSED, naming Platform — never a blank", async () => {
    PLAYBOOK = produceContent();
    SUBJECT_KINDS = ["post"];
    withPost({ "post-format": "Short Video" });

    await expect(
      instantiateSession({ ...RUN, params: {}, subjectId: POST })
    ).rejects.toThrow(/^This playbook requires Platform\./);
    expect(inserted).toHaveLength(0);
  });

  it("the caller's platform wins over the post's", async () => {
    PLAYBOOK = produceContent();
    SUBJECT_KINDS = ["post"];
    withPost({ "post-platform": "Instagram" });

    await instantiateSession({
      ...RUN,
      params: { platform: "LinkedIn" },
      subjectId: POST,
    });

    expect(metadataOf()[RUN_PARAMS_METADATA_KEY]).toMatchObject({
      post: POST,
      platform: "LinkedIn",
    });
  });

  it("one entity param needs no kind read", async () => {
    PLAYBOOK = basePlaybook({
      goalTemplate: "Read {touch}.",
      params: [{ name: "touch", type: "entity", required: true }],
    });
    withPost({});

    await instantiateSession({ ...RUN, params: {}, subjectId: POST });

    expect(metadataOf()[RUN_PARAMS_METADATA_KEY]).toEqual({ touch: POST });
    expect(kindReads).toEqual([]);
  });
});
