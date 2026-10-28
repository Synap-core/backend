/**
 * What the broker hands a run and takes from the world, proven WITHOUT the
 * native addon (every CI runner): the runner is a recorder, so these cases
 * read exactly what would cross into the isolate.
 *
 *   - the arguments arrive as their DECLARED types: a `number` sent as "5" is
 *     5 and a `boolean` sent as "false" is false (the check accepts both
 *     encodings; before, the skill got the strings: "false" is truthy);
 *   - only a `kind:"code"` skill runs: an instruction skill whose `code`
 *     column holds JS is refused before anything is evaluated;
 *   - the run counts against its requester: the acting agent, else the person;
 *   - `host.fetch` reads at most 100 kB of a body and stops the transfer, in
 *     the API process, instead of buffering the whole download first;
 *   - `callProvider`'s `baseUrlOverride` or absolute `path` (where the
 *     connection's credential goes) must be a host the skill may reach — its `allowedHosts`, or one an
 *     approved verb of the same tool already uses — live AND in a dry-run.
 *
 * NOT covered here: the SQL of the verb-host read (the db is a stub that
 * returns the rows a case gives; the query's own filter is not exercised).
 *
 * The real-isolate twin of the first case is in
 * `run-skill-in-sandbox.one-bridge-set.real-isolate.test.ts` (devbox).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  return {
    skillRow: null as Record<string, unknown> | null,
    runner: {
      kind: "process" as const,
      run: vi.fn(),
    },
    fetch: vi.fn(),
    trigger: vi.fn(),
    verbRows: [] as Array<{ providerSpec: Record<string, unknown> | null }>,
    verbReads: 0,
  };
});

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {
    query: { skills: { findFirst: async () => h.skillRow } },
    select: () => ({
      from: () => ({
        where: async () => {
          h.verbReads++;
          return h.verbRows;
        },
      }),
    }),
  },
}));
vi.mock("../../connectors/external-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  triggerProviderAction: (...a: unknown[]) => h.trigger(...a),
}));
vi.mock("../../routers/hub-protocol/utils.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createHubProtocolCallerContext: async () => ({}),
}));
vi.mock("../../routers/hub-protocol/index.js", () => ({
  hubProtocolRouter: { createCaller: () => ({}) },
}));
vi.mock("./runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSkillRunner: () => h.runner,
}));
vi.mock("@synap/shared-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/shared-utils")>()),
  safePublicFetch: (...a: unknown[]) => h.fetch(...a),
}));

const { runSkillInSandbox, buildSkillBridges } =
  await import("./run-skill-in-sandbox.js");

const OPERATOR = "owner-1";
const AGENT = "agent-1";

function skill(over: Record<string, unknown> = {}) {
  h.skillRow = {
    id: "skill-1",
    name: "probe",
    kind: "code",
    status: "active",
    approved: true,
    code: "return args;",
    timeoutSeconds: 10,
    metadata: { allowedHosts: ["api.allowed.test"] },
    parameters: null,
    ...over,
  };
}

beforeEach(() => {
  h.runner.run.mockReset().mockResolvedValue("ran");
  h.fetch.mockReset();
  h.trigger
    .mockReset()
    .mockResolvedValue({ success: true, status: 200, headers: {}, body: {} });
  h.verbRows = [];
  h.verbReads = 0;
});

describe("the arguments reach the skill as their declared types", () => {
  const parameters = {
    keywords: "string",
    limit: "number?",
    dryRun: "boolean?",
    strict: "boolean?",
    loose: "boolean?",
    tags: "array?",
  };

  it('"5" for a number is 5, "false"/"TRUE"/"1" for a boolean are false/true; strings and real values are untouched', async () => {
    skill({ parameters });
    const out = await runSkillInSandbox({
      skillId: "skill-1",
      userId: OPERATOR,
      parameters: {
        keywords: "42",
        limit: "5",
        dryRun: "false",
        strict: "TRUE",
        loose: "1",
        tags: ["a"],
        extra: "kept",
      },
    });
    expect(out.error).toBeUndefined();
    const [job] = h.runner.run.mock.calls[0]!;
    expect(job.args).toEqual({
      keywords: "42", // a declared string stays a string
      limit: 5,
      dryRun: false,
      strict: true,
      loose: true,
      tags: ["a"],
      extra: "kept", // undeclared keys pass through, as before
    });
  });

  it("real numbers and booleans pass as they are", async () => {
    skill({ parameters });
    await runSkillInSandbox({
      skillId: "skill-1",
      userId: OPERATOR,
      parameters: { keywords: "x", limit: 7, dryRun: true },
    });
    expect(h.runner.run.mock.calls[0]![0].args).toEqual({
      keywords: "x",
      limit: 7,
      dryRun: true,
    });
  });

  it("an invalid call still never reaches the runner", async () => {
    skill({ parameters });
    const out = await runSkillInSandbox({
      skillId: "skill-1",
      userId: OPERATOR,
      parameters: { keywords: "x", limit: "five" },
    });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/limit should be number, got string/);
    expect(h.runner.run).not.toHaveBeenCalled();
  });
});

describe("only a code skill runs", () => {
  it("an approved instruction skill whose code column holds JS is refused, and nothing is evaluated", async () => {
    skill({
      kind: "instruction",
      code: "return await callProvider('x','POST','/pay');",
    });
    const out = await runSkillInSandbox({
      skillId: "skill-1",
      userId: OPERATOR,
    });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(
      /"probe" is not a code skill \(its kind is instruction\).*Nothing ran/
    );
    expect(h.runner.run).not.toHaveBeenCalled();
  });

  it("refused in a dry-run too", async () => {
    skill({ kind: "instruction", code: "return 1;" });
    const out = await runSkillInSandbox({
      skillId: "skill-1",
      userId: OPERATOR,
      dryRun: true,
    });
    expect(out.success).toBe(false);
    expect(h.runner.run).not.toHaveBeenCalled();
  });

  it("a code skill still runs (non-vacuity)", async () => {
    skill();
    const out = await runSkillInSandbox({
      skillId: "skill-1",
      userId: OPERATOR,
    });
    expect(out).toMatchObject({ success: true, result: "ran" });
  });
});

describe("the run counts against its requester", () => {
  it("an agent's run is the agent's; a person's own run is the person's", async () => {
    skill();
    await runSkillInSandbox({
      skillId: "skill-1",
      userId: OPERATOR,
      agentUserId: AGENT,
    });
    await runSkillInSandbox({ skillId: "skill-1", userId: OPERATOR });
    expect(h.runner.run.mock.calls.map((c) => c[2])).toEqual([
      { requester: AGENT },
      { requester: OPERATOR },
    ]);
  });
});

describe("host.fetch keeps at most 100 kB of a body and stops reading there", () => {
  function bridgesFor() {
    return buildSkillBridges({
      allowedHosts: ["api.allowed.test"],
      operatorUserId: OPERATOR,
      workspaceId: null,
      agentUserId: null,
      caller: {} as never,
      failureSink: {},
    });
  }

  /** A 10 MB body served in 64 KiB chunks, counting what was pulled. */
  function hugeBody() {
    const seen = { pulls: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        seen.pulls++;
        if (seen.pulls > 160) controller.close();
        else controller.enqueue(new Uint8Array(64 * 1024).fill(97));
      },
      cancel() {
        seen.cancelled = true;
      },
    });
    return { seen, response: new Response(stream, { status: 200 }) };
  }

  it("a large download is cut at the cap, marked truncated, and the transfer is cancelled", async () => {
    const { seen, response } = hugeBody();
    h.fetch.mockResolvedValue(response);
    const out = (await bridgesFor().hostFetch(
      "https://api.allowed.test/export.csv"
    )) as { ok: boolean; body: string; truncated?: boolean };
    expect(out.ok).toBe(true);
    expect(out.body.length).toBe(100_000);
    expect(out.truncated).toBe(true);
    expect(seen.cancelled).toBe(true);
    expect(seen.pulls).toBeLessThan(10); // never the 160 chunks of the whole body
  });

  it("a body under the cap arrives whole, multi-byte text intact, not marked", async () => {
    h.fetch.mockResolvedValue(
      new Response(JSON.stringify({ name: "Zoë — café" }), { status: 201 })
    );
    const out = (await bridgesFor().hostFetch(
      "https://api.allowed.test/item"
    )) as { status: number; body: string; truncated?: boolean };
    expect(out.status).toBe(201);
    expect(JSON.parse(out.body)).toEqual({ name: "Zoë — café" });
    expect(out).not.toHaveProperty("truncated");
  });
});

describe("callProvider's baseUrlOverride is a host the skill may reach", () => {
  function bridgesFor(recordedEffects?: unknown[]) {
    return buildSkillBridges({
      allowedHosts: ["api.allowed.test"],
      operatorUserId: OPERATOR,
      workspaceId: null,
      agentUserId: AGENT,
      caller: {} as never,
      failureSink: {},
      ...(recordedEffects ? { recordedEffects: recordedEffects as never } : {}),
    });
  }
  const call = (b: ReturnType<typeof bridgesFor>, override: string) =>
    b.callProvider("google", "GET", "/x", null, { baseUrlOverride: override });

  it("a host nobody approved is refused before the provider is called (the token never leaves)", async () => {
    h.verbRows = [
      {
        providerSpec: {
          tool: "google",
          baseUrlOverride: "https://gmail.googleapis.com",
        },
      },
    ];
    await expect(
      call(bridgesFor(), "https://collector.example")
    ).rejects.toThrow(
      /"collector\.example" is not a host this skill may reach/
    );
    expect(h.trigger).not.toHaveBeenCalled();
  });

  it("refused in a dry-run too, and nothing is recorded", async () => {
    const effects: unknown[] = [];
    await expect(
      call(bridgesFor(effects), "https://collector.example")
    ).rejects.toThrow(/not a host this skill may reach/);
    expect(effects).toEqual([]);
  });

  it("a non-http override is refused", async () => {
    await expect(call(bridgesFor(), "file:///etc/passwd")).rejects.toThrow(
      /not a host this skill may reach/
    );
    expect(h.trigger).not.toHaveBeenCalled();
  });

  it("a host in the skill's allowedHosts goes through", async () => {
    await call(bridgesFor(), "https://API.allowed.test/v2");
    expect(h.trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrlOverride: "https://API.allowed.test/v2",
      })
    );
  });

  it("a host an approved verb of the same tool uses goes through (gmail_send beside gmail_search)", async () => {
    h.verbRows = [
      { providerSpec: null },
      {
        providerSpec: {
          tool: "google",
          baseUrlOverride: "https://gmail.googleapis.com",
        },
      },
    ];
    await call(bridgesFor(), "https://gmail.googleapis.com");
    expect(h.trigger).toHaveBeenCalledTimes(1);
  });

  it("an absolute path is held to the same rule: a foreign host is refused, an approved one goes", async () => {
    h.verbRows = [
      {
        providerSpec: {
          tool: "google",
          baseUrlOverride: "https://gmail.googleapis.com",
        },
      },
    ];
    await expect(
      bridgesFor().callProvider("google", "POST", "https://collector.example/x")
    ).rejects.toThrow(
      /path host "collector\.example" is not a host this skill may reach/
    );
    expect(h.trigger).not.toHaveBeenCalled();
    await bridgesFor().callProvider(
      "google",
      "GET",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages"
    );
    expect(h.trigger).toHaveBeenCalledTimes(1);
  });

  it("no override: no host read, the call goes as before", async () => {
    await bridgesFor().callProvider("google", "GET", "/x");
    expect(h.verbReads).toBe(0);
    expect(h.trigger).toHaveBeenCalledTimes(1);
  });
});
