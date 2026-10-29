/**
 * Pod files as BYTES (plan e7c3c98e phase 2b), end to end through the REAL
 * post-gate runner (`runResolvedSkill` → `resolvePodFilesAtRun`), the REAL
 * `isolated-vm` sandbox running the skill's code, the REAL `callProvider`
 * bridge (`pod-file-body.ts`), the REAL `triggerProviderAction` and the REAL
 * vault handler encoding the body (`provider-file-body.ts`). Stubbed: rows
 * (db), the file read floor (a map), storage (a map), the vault decrypt, the
 * event log (captured) and `fetch` (the provider, which reads the streamed
 * body).
 *
 * Rows rule out:
 *  - the bytes, or a storage key, reaching the isolate (it sees a handle);
 *  - a handle sent as text instead of the file (multipart, base64 JSON);
 *  - a run's files sent to a tool its verb does not require;
 *  - a handle the run did not receive resolving (forged, or another run's);
 *  - a `:bytes` file signed as a URL, or sent with no `file.sent` event.
 *
 * Harness: copied from `run-skill-in-sandbox.verb-act.test.ts` (same stubs).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const h = vi.hoisted(() => {
  const SKILL_ID = "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e";
  const TOOL_ID = "c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f";
  const OTHER_TOOL_ID = "d3e4f5a6-b7c8-4d9e-8f1a-2b3c4d5e6f70";
  const SECRET_ID = "e4f5a6b7-c8d9-4e0f-9a2b-3c4d5e6f7081";
  const tool = (id: string, name: string, approved = true) => ({
    id,
    name,
    kind: "external",
    approved,
    createdBy: "owner-1",
    credentialRef: `vault://${SECRET_ID}`,
    authBinding: "static",
    workspaceId: null,
    config: {
      baseUrl: "https://api.vendor.test",
      auth: { in: "header", name: "x-api-key", prefix: "" },
    },
    metadata: {},
  });
  return {
    SKILL_ID,
    TOOL_ID,
    OTHER_TOOL_ID,
    SECRET_ID,
    tools: [
      tool(TOOL_ID, "vendor_api"),
      tool(OTHER_TOOL_ID, "other_api"),
    ] as Array<ReturnType<typeof tool>>,
    requiresLinks: [] as Array<{ toolId: string }>,
    skillRow: null as Record<string, unknown> | null,
    proposals: [] as Array<Record<string, unknown>>,
    audits: [] as Array<Record<string, unknown>>,
    findGrant: vi.fn(),
    resolveRule: vi.fn(),
    events: [] as Array<Record<string, unknown>>,
    /** Storage objects by key, and every key opened for reading. */
    objects: new Map<string, Buffer>(),
    opened: [] as string[],
    /** The file entities the read floor admits, by id. */
    files: new Map<string, Record<string, unknown>>(),
  };
});

vi.mock("@synap/storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storage: {
    async downloadStream(key: string) {
      h.opened.push(key);
      const bytes = h.objects.get(key);
      if (!bytes) {
        throw Object.assign(new Error(`File not found: ${key}`), {
          code: "STORAGE_OBJECT_NOT_FOUND",
        });
      }
      async function* body(data: Buffer) {
        yield data;
      }
      return {
        body: body(bytes),
        size: bytes.length,
        contentType: "application/octet-stream",
        cancel() {},
      };
    },
    getSignedUrl: async () => {
      throw new Error("a :bytes file must never be signed");
    },
  },
}));
// The file read floor (its own PGlite suite is stored-file-access.pglite):
// here, a file is readable when it is in `h.files`.
vi.mock("../../routers/file-upload.js", () => ({
  readableFileEntity: async (_userId: string, id: string) => {
    const entity = h.files.get(id);
    return entity
      ? { ok: true, entity }
      : { ok: false, status: 404, error: "File entity not found" };
  },
  signFileEntityUrl: async () => {
    throw new Error("a :bytes file must never be signed");
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const schema = await import("@synap/database/schema");
  const select = () => {
    let table: unknown;
    const rows = (): unknown[] =>
      table === schema.links
        ? h.requiresLinks
        : table === schema.tools
          ? h.tools
          : [];
    const chain = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      where: (cond: unknown) => {
        // The tool lookup is by NAME: honour it so a call to `other_api`
        // resolves `other_api`, not the first row.
        if (table === schema.tools) {
          // Collect the bound string params of the drizzle condition (a
          // cyclic object graph — walked with a seen-set, never stringified).
          const strings = new Set<string>();
          const seen = new WeakSet<object>();
          const walk = (v: unknown, depth: number): void => {
            if (typeof v === "string") strings.add(v);
            if (!v || typeof v !== "object" || depth > 8 || seen.has(v)) return;
            seen.add(v);
            for (const x of Object.values(v as Record<string, unknown>))
              walk(x, depth + 1);
          };
          walk(cond, 0);
          const hit = h.tools.filter((t) => strings.has(t.name));
          const filtered = {
            ...chain,
            limit: async () => hit,
            then: (r: (v: unknown) => unknown) => r(hit),
          };
          return filtered;
        }
        return chain;
      },
      innerJoin: () => chain,
      orderBy: () => chain,
      limit: async () => rows(),
      then: (r: (v: unknown) => unknown) => r(rows()),
    };
    return chain;
  };
  const update = () => {
    const c = { set: () => c, where: async () => undefined };
    return c;
  };
  return {
    ...actual,
    getDb: async () => ({}),
    findCapabilityGrant: (...a: unknown[]) => h.findGrant(...a),
    eventRepository: {
      append: async (e: Record<string, unknown>) => {
        h.events.push(e);
        return { id: e.id };
      },
    },
    resolveCapabilityGrant: async () => ({ ok: true }),
    // A session reaches the worker send ceiling (worker-send-ceiling.ts), which
    // asks which worker started it; these sessions are no worker's.
    workerAutomationOfSession: async () => null,
    db: {
      select,
      update,
      query: {
        skills: { findFirst: async () => h.skillRow },
        secrets: {
          findFirst: async () => ({
            userId: "owner-1",
            providerIntegrationId: null,
            accountHint: null,
            isPodWide: false,
          }),
        },
      },
    },
  };
});
vi.mock("@synap/database/agent-governance", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveGovernanceRule: (...a: unknown[]) => h.resolveRule(...a),
    resolveOriginTrust: async () => undefined,
  };
});
// The vault handler sends through the pinned door (`safePublicFetch`,
// node:http), which a stubbed global `fetch` cannot see. Keep the door's URL
// check, then hand the request to the stubbed `fetch` below so the provider
// stays faked. The door itself (DNS pin, bodies, redirects) is tested in
// shared-utils `pinned-fetch.test.ts`.
vi.mock("@synap/shared-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/shared-utils")>();
  return {
    ...actual,
    safePublicFetch: async (
      url: string,
      init: RequestInit = {},
      _maxRedirects?: number,
      deps?: { allowedPorts?: ReadonlySet<number> | "any" }
    ) => {
      const check = actual.validateExternalUrl(url, {
        allowedPorts: deps?.allowedPorts,
      });
      if (!check.valid) throw new actual.BlockedOutboundError(check.reason);
      return fetch(url, init);
    },
  };
});
vi.mock("../../utils/vault-resolver.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../utils/vault-resolver.js")>();
  return { ...actual, resolveVaultSecret: async () => "sk-vendor-KEY" };
});
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: async (input: Record<string, unknown>) => {
    h.proposals.push(input);
    return { id: `prop-${h.proposals.length}` };
  },
}));
vi.mock("../../utils/domain-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordDomainMutation: async (input: Record<string, unknown>) => {
    h.audits.push(input);
  },
}));
vi.mock("../../routers/hub-protocol/utils.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createHubProtocolCallerContext: async () => ({ userId: "owner-1" }),
}));
vi.mock("../capabilities/capability-registry.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  containerMemberKey: (kind: string, id: string) => `${kind}:${id}`,
  loadContainerRefs: async () => new Map(),
}));
vi.mock("../links/links-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCapabilityMemberParts: async () => [],
}));

const { runResolvedSkill } =
  await import("../capabilities/execute-capability.js");

const FILE_ID = "f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b";
const KEY = "users/owner-1/photo.jpg";
const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x50, 0x4f, 0x44, 0x21]);

interface Sent {
  url: string;
  contentType: string;
  body: Buffer;
}
const sent: Sent[] = [];
const asAgent = {
  userId: "owner-1",
  workspaceId: null,
  agentUserId: "agent-1",
};

let prevRuntime: string | undefined;
beforeAll(() => {
  prevRuntime = process.env.SKILL_RUNTIME;
  delete process.env.SKILL_RUNTIME;
});
afterAll(() => {
  if (prevRuntime !== undefined) process.env.SKILL_RUNTIME = prevRuntime;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  h.proposals.length = 0;
  h.audits.length = 0;
  h.events.length = 0;
  h.opened.length = 0;
  sent.length = 0;
  h.requiresLinks = [{ toolId: h.TOOL_ID }];
  h.tools.forEach((t) => (t.approved = true));
  h.findGrant.mockReset().mockResolvedValue({ ok: false });
  h.resolveRule.mockReset().mockResolvedValue(null);
  h.objects.set(KEY, BYTES);
  h.files.set(FILE_ID, {
    id: FILE_ID,
    documentId: "doc-1",
    storageKey: KEY,
    mimeType: "image/jpeg",
    title: "photo.jpg",
    size: BYTES.length,
    deletedAt: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const raw = init.body as unknown;
      let body = Buffer.alloc(0);
      if (raw && typeof raw === "object" && Symbol.asyncIterator in raw) {
        const parts: Buffer[] = [];
        for await (const c of raw as AsyncIterable<Uint8Array>)
          parts.push(Buffer.from(c));
        body = Buffer.concat(parts);
      } else if (typeof raw === "string") body = Buffer.from(raw);
      const headers = (init.headers ?? {}) as Record<string, string>;
      sent.push({
        url: String(url),
        contentType: headers["Content-Type"] ?? "",
        body,
      });
      return new Response(JSON.stringify({ id: "post-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    })
  );
});

/** Run a code verb declaring `parameters`, with `code`, as an agent. */
const run = (
  parameters: Record<string, string>,
  code: string,
  args: Record<string, unknown>
) => {
  h.skillRow = {
    id: h.SKILL_ID,
    name: "vendor_post",
    kind: "code",
    status: "active",
    approved: true,
    code,
    parameters,
    timeoutSeconds: 10,
    metadata: {},
  };
  return runResolvedSkill(
    {
      id: h.SKILL_ID,
      name: "vendor_post",
      kind: "code",
      providerSpec: null,
      metadata: {},
      parameters,
      executionMode: "sync",
    },
    args,
    asAgent
  );
};

describe("a :bytes file reaches the verb's own tool as bytes, never the isolate", () => {
  it("multipart: the isolate sees a handle; the provider gets the file part and the text field", async () => {
    const out = await run(
      { text: "string", attachments: "file[]:bytes" },
      `const r = await callProvider('vendor_api', 'POST', '/v1/posts', { text: args.text, attachments: args.attachments }, { multipart: true });\n` +
        `return { seen: args.attachments, status: r.status };`,
      { text: "Launch day", attachments: [FILE_ID] }
    );
    expect(out.kind, JSON.stringify(out)).toBe("run");
    const result = (out as { result: { seen: string[]; status: number } })
      .result;
    expect(result.status).toBe(200);
    expect(result.seen).toHaveLength(1);
    expect(result.seen[0]).toMatch(/^podfile:[A-Za-z0-9_-]{20,}$/);
    expect(JSON.stringify(result)).not.toContain(KEY);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.vendor.test/v1/posts");
    expect(sent[0]!.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const form = sent[0]!.body;
    expect(form.includes(BYTES)).toBe(true);
    expect(form.toString("latin1")).toContain(
      'name="attachments"; filename="photo.jpg"'
    );
    expect(form.toString("latin1")).toContain('name="text"');
    expect(form.toString("latin1")).toContain("Launch day");
    expect(form.toString("latin1")).not.toContain("podfile:");
    expect(h.opened).toEqual([KEY]);
    // One act: the verb's own tool, no second proposal.
    expect(h.proposals).toEqual([]);

    const events = h.events.filter((e) => e.type === "file.sent");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      subjectId: FILE_ID,
      data: {
        delivery: "bytes",
        urlTtlSeconds: null,
        urlExpiresAt: null,
        name: "photo.jpg",
        verb: "vendor_post",
        agentUserId: "agent-1",
      },
    });
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it("JSON: the handle's slot becomes the file's base64", async () => {
    const out = await run(
      { image: "file:bytes" },
      `const r = await callProvider('vendor_api', 'POST', '/v1/edit', { input: { image: args.image, strength: 0.5 } });\n` +
        `return r.status;`,
      { image: FILE_ID }
    );
    expect(out.kind, JSON.stringify(out)).toBe("run");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.contentType).toBe("application/json");
    expect(JSON.parse(sent[0]!.body.toString())).toEqual({
      input: { image: BYTES.toString("base64"), strength: 0.5 },
    });
  });
});

describe("a run's files go nowhere else", () => {
  it("to a tool the verb does not require: refused, nothing read, nothing sent", async () => {
    const out = await run(
      { image: "file:bytes" },
      `return await callProvider('other_api', 'POST', '/v1/edit', { image: args.image });`,
      { image: FILE_ID }
    );
    expect(out.kind).toBe("error");
    expect((out as { message: string }).message).toContain(
      "only to the tools its verb requires"
    );
    expect(sent).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.proposals).toEqual([]);
  });

  it("a handle this run did not receive does not resolve (and is never sent as text)", async () => {
    const out = await run(
      { image: "file:bytes" },
      `return await callProvider('vendor_api', 'POST', '/v1/edit', { image: 'podfile:forged-or-from-another-run' });`,
      { image: FILE_ID }
    );
    expect(out.kind).toBe("error");
    expect((out as { message: string }).message).toContain(
      "not a file of this run"
    );
    expect(sent).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  it("control: a body with no handle is the plain JSON call of before", async () => {
    const out = await run(
      { image: "file:bytes" },
      `const r = await callProvider('vendor_api', 'POST', '/v1/ping', { a: 1 });\nreturn r.status;`,
      { image: FILE_ID }
    );
    expect(out.kind, JSON.stringify(out)).toBe("run");
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.body.toString())).toEqual({ a: 1 });
    expect(h.opened).toEqual([]);
  });
});
