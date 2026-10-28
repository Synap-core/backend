import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * A provider call that carries pod files (`fileBody`), through the dispatcher:
 *
 *  1. the vault:// handler, with `fetch` mocked the way undici behaves (it
 *     drains a streamed body, and rejects with "fetch failed" when the body
 *     throws): the multipart and base64 requests on the wire, a file gone
 *     mid-request reported as that file, the session mode rebuilding the body
 *     for its one retry, and the default JSON request unchanged;
 *  2. `triggerProviderAction`: a file body is never stored in a proposal, is
 *     refused on a JSON-only scheme, and never rides with a JSON body.
 *
 * Storage is `@synap/storage` mocked with a `downloadStream` that answers like
 * the real one (typed `code`s). The encoder's own cases are
 * `provider-file-body.test.ts`.
 */

const SECRET_ID = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  mockResolveVaultSecret: vi.fn(),
  mockFindFirst: vi.fn(),
  objects: new Map<string, Buffer>(),
  opened: [] as string[],
  toolRows: [] as unknown[],
  inserted: [] as unknown[],
  gate: { decision: "propose" as string },
  door: [] as Array<{ url: string; maxRedirects?: number; deps?: unknown }>,
}));

// The pinned door speaks node:http, not `fetch` (it streams an AsyncIterable
// body chunked itself: `pinned-fetch.test.ts`). Record what each request asked
// of the door, then hand it (minus the timeout signal) to the recorded global
// `fetch` below, so every assertion still sees the exact outbound request.
vi.mock("@synap/shared-utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safePublicFetch: (
    url: string,
    init: RequestInit = {},
    maxRedirects?: number,
    deps?: unknown
  ) => {
    h.door.push({ url, maxRedirects, deps });
    const { signal: _signal, ...rest } = init;
    return fetch(url, rest);
  },
}));

vi.mock("@synap/storage", () => ({
  storage: {
    async downloadStream(key: string, o?: { maxBytes?: number }) {
      h.opened.push(key);
      const bytes = h.objects.get(key);
      if (!bytes) {
        throw Object.assign(new Error(`File not found: ${key}`), {
          code: "STORAGE_OBJECT_NOT_FOUND",
        });
      }
      if (o?.maxBytes !== undefined && bytes.length > o.maxBytes) {
        throw Object.assign(new Error("too large"), {
          code: "STORAGE_OBJECT_TOO_LARGE",
        });
      }
      async function* body(data: Buffer) {
        for (let i = 0; i < data.length; i += 3) yield data.subarray(i, i + 3);
      }
      return {
        body: body(bytes),
        size: bytes.length,
        contentType: "application/octet-stream",
        cancel() {},
      };
    },
  },
}));

vi.mock("../utils/vault-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveVaultSecret: h.mockResolveVaultSecret,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      query: { secrets: { findFirst: h.mockFindFirst } },
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const rows = table === (actual as any).tools ? h.toolRows : [];
            return {
              limit: async () => rows,
              then: (resolve: (v: unknown) => unknown) => resolve(rows),
            };
          },
        }),
      }),
    },
  };
});

vi.mock("../services/capabilities/gate-capability-execution.js", () => ({
  gateCapabilityExecution: async () => ({ decision: h.gate.decision }),
}));

vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: async (input: unknown) => {
    h.inserted.push(input);
    return { id: `prop-${h.inserted.length}` };
  },
}));

const { __vaultHandlerForTests: vaultHandler, triggerProviderAction } =
  await import("./external-dispatch.js");
const { __resetSessionCacheForTests } = await import("./session-auth.js");
import type { ProviderFileBody } from "./provider-file-body.js";

type FetchCall = { url: string; init: RequestInit; sent: Buffer | string };
let calls: FetchCall[] = [];
let responder: (url: string, init: RequestInit) => Response;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  h.objects.clear();
  h.opened.length = 0;
  h.inserted.length = 0;
  h.door.length = 0;
  __resetSessionCacheForTests();
  h.mockFindFirst.mockResolvedValue({
    userId: "owner-1",
    providerIntegrationId: null,
    accountHint: null,
    isPodWide: false,
  });
  h.mockResolveVaultSecret.mockResolvedValue("s3cret-static");
  responder = () => json(200, { object: "PostCreated", post_id: "p1" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      // undici: a streamed body is read while sending; a body that throws
      // rejects the request with "fetch failed" (the cause behind it).
      let sent: Buffer | string = "";
      const body = init.body as unknown;
      if (body && typeof body === "object" && Symbol.asyncIterator in body) {
        const parts: Buffer[] = [];
        try {
          for await (const c of body as AsyncIterable<Uint8Array>) {
            parts.push(Buffer.from(c));
          }
        } catch (cause) {
          throw new TypeError("fetch failed", { cause });
        }
        sent = Buffer.concat(parts);
      } else if (typeof body === "string") {
        sent = body;
      }
      calls.push({ url: String(url), init, sent });
      return responder(String(url), init);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ref = (storageKey: string, filename: string, contentType: string) => ({
  storageKey,
  filename,
  contentType,
  size: h.objects.get(storageKey)?.length ?? 1,
});

function runVault(
  config: Record<string, unknown>,
  call: {
    path: string;
    body?: Record<string, unknown>;
    fileBody?: ProviderFileBody;
  }
) {
  return vaultHandler({
    input: {
      userId: "owner-1",
      provider: `vault://${SECRET_ID}`,
      method: "POST",
      path: call.path,
      body: call.body,
      fileBody: call.fileBody,
      headers: { "x-v": "1" },
    } as never,
    tool: {
      id: "tool-1",
      name: "unipile",
      kind: "api",
      credentialRef: `vault://${SECRET_ID}`,
      config,
    } as never,
  });
}

const UNIPILE = {
  baseUrl: "https://api1.unipile.com:13111/api/v1",
  auth: { in: "header", name: "X-API-KEY", prefix: "" },
};
const headersOf = (c: FetchCall) => c.init.headers as Record<string, string>;

describe("vault:// with a multipart file body", () => {
  it("sends the form with each file part streamed from storage, auth winning over caller headers", async () => {
    const img = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    h.objects.set("users/u/files/a.jpg", img);
    const r = await runVault(UNIPILE, {
      path: "/posts",
      fileBody: {
        encoding: "multipart",
        fields: { account_id: "acc-1", text: "Launch day" },
        files: [
          {
            field: "attachments",
            file: ref("users/u/files/a.jpg", "a.jpg", "image/jpeg"),
          },
        ],
      },
    });
    expect(r).toMatchObject({ success: true, status: 200 });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe("https://api1.unipile.com:13111/api/v1/posts");
    const ct = headersOf(c)["Content-Type"]!;
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(ct)?.[1];
    expect(boundary).toMatch(/^----SynapFormBoundary[0-9a-f]{32}$/);
    expect(headersOf(c)).toEqual({
      "x-v": "1",
      "Content-Type": ct,
      "X-API-KEY": "s3cret-static",
    });
    // Streamed through the pinned door, never buffered: the body handed to it
    // is the lazy file stream; no redirect is followed (the key is a header);
    // the tool's configured baseUrl may name its own port (13111).
    expect(
      typeof (c.init.body as unknown as AsyncIterable<Uint8Array>)[
        Symbol.asyncIterator
      ]
    ).toBe("function");
    expect(h.door).toEqual([
      {
        url: "https://api1.unipile.com:13111/api/v1/posts",
        maxRedirects: 0,
        deps: { allowedPorts: "any" },
      },
    ]);
    expect(c.init.method).toBe("POST");
    expect(
      (c.sent as Buffer).equals(
        Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="account_id"\r\n\r\nacc-1\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nLaunch day\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="attachments"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`
          ),
          img,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ])
      )
    ).toBe(true);
  });

  it("a file gone mid-request is reported as that file (404), not as an unreachable provider", async () => {
    h.objects.set("k/a.jpg", Buffer.from("aaaa"));
    const r = await runVault(UNIPILE, {
      path: "/posts",
      fileBody: {
        encoding: "multipart",
        files: [
          { field: "attachments", file: ref("k/a.jpg", "a.jpg", "image/jpeg") },
          {
            field: "attachments",
            file: ref("k/gone.jpg", "gone.jpg", "image/jpeg"),
          },
        ],
      },
    });
    expect(r).toMatchObject({
      success: false,
      status: 404,
      errorCode: "not_found",
    });
    expect(r.error).toContain("gone.jpg");
    expect(calls).toHaveLength(0);
  });

  it("a provider that cannot be reached is still a 502 unavailable", async () => {
    h.objects.set("k/a.jpg", Buffer.from("aaaa"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    const r = await runVault(UNIPILE, {
      path: "/posts",
      fileBody: {
        encoding: "multipart",
        files: [{ field: "f", file: ref("k/a.jpg", "a.jpg", "image/jpeg") }],
      },
    });
    expect(r).toMatchObject({
      success: false,
      status: 502,
      errorCode: "unavailable",
    });
  });
});

describe("vault:// with a base64 file body", () => {
  it("fills the slot with the file's base64 and sends application/json", async () => {
    const pdf = Buffer.from("%PDF-1.7 tiny");
    h.objects.set("k/d.pdf", pdf);
    const r = await runVault(UNIPILE, {
      path: "/documents",
      fileBody: {
        encoding: "json-base64",
        json: { title: "Brief", file: { name: "d.pdf", data: "" } },
        files: [
          {
            path: ["file", "data"],
            file: ref("k/d.pdf", "d.pdf", "application/pdf"),
          },
        ],
      },
    });
    expect(r.success).toBe(true);
    const c = calls[0]!;
    expect(headersOf(c)["Content-Type"]).toBe("application/json");
    expect(typeof c.init.body).toBe("string");
    expect(JSON.parse(c.sent as string)).toEqual({
      title: "Brief",
      file: { name: "d.pdf", data: pdf.toString("base64") },
    });
  });

  it("a missing object is refused before anything is sent (404)", async () => {
    const r = await runVault(UNIPILE, {
      path: "/documents",
      fileBody: {
        encoding: "json-base64",
        json: { data: "" },
        files: [{ path: ["data"], file: ref("k/none", "n.pdf", "x/y") }],
      },
    });
    expect(r).toMatchObject({ success: false, status: 404 });
    expect(calls).toHaveLength(0);
  });
});

describe("vault:// default JSON body — unchanged", () => {
  it("no file body: the exact request of before (a JSON string, no redirect)", async () => {
    await runVault(UNIPILE, { path: "/posts", body: { text: "hi" } });
    expect(calls[0]!.init).toEqual({
      method: "POST",
      headers: {
        "x-v": "1",
        "Content-Type": "application/json",
        "X-API-KEY": "s3cret-static",
      },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(h.door[0]).toMatchObject({ maxRedirects: 0 });
    expect(h.opened).toEqual([]);
  });
});

describe('vault:// auth.type "session" with a file body', () => {
  const AUTH_URL = "https://api.example.com/authorize";
  const API = "https://api7.example.com";
  const CONFIG = {
    auth: {
      type: "session",
      signIn: { url: AUTH_URL, method: "GET", credential: "basic" },
      token: { path: "token", header: "Authorization", prefix: "" },
      baseUrlFrom: "apiUrl",
      bodyFrom: { accountId: "accountId" },
      reauthOn: { status: 401, codePath: "code", codes: ["expired"] },
    },
  };

  beforeEach(() => {
    h.mockResolveVaultSecret.mockResolvedValue("keyid:appkey");
    let issued = 0;
    responder = (url, init) => {
      if (url === AUTH_URL) {
        issued++;
        return json(200, {
          token: `T${issued}`,
          apiUrl: API,
          accountId: "acct-9",
        });
      }
      return (init.headers as Record<string, string>).Authorization === "T1"
        ? json(401, { code: "expired" })
        : json(200, { ok: true });
    };
  });

  it("the one retry after a dead token sends the whole multipart body again", async () => {
    const bytes = Buffer.from("0123456789");
    h.objects.set("k/f.bin", bytes);
    const r = await runVault(CONFIG, {
      path: "/upload",
      fileBody: {
        encoding: "multipart",
        files: [{ field: "file", file: ref("k/f.bin", "f.bin", "x/y") }],
      },
    });
    expect(r).toMatchObject({ success: true, body: { ok: true } });
    const ops = calls.filter((c) => c.url !== AUTH_URL);
    expect(ops.map((c) => headersOf(c).Authorization)).toEqual(["T1", "T2"]);
    for (const op of ops) {
      expect((op.sent as Buffer).includes(bytes)).toBe(true);
      expect((op.sent as Buffer).toString()).toMatch(/--\r\n$/);
    }
    expect(h.opened).toEqual(["k/f.bin", "k/f.bin"]);
  });

  it("session fields fill a declared slot of a base64 body", async () => {
    responder = (url) =>
      url === AUTH_URL
        ? json(200, { token: "T9", apiUrl: API, accountId: "acct-9" })
        : json(200, { ok: true });
    h.objects.set("k/f.bin", Buffer.from("xyz"));
    await runVault(CONFIG, {
      path: "/upload",
      fileBody: {
        encoding: "json-base64",
        json: { accountId: "spoofed", data: "" },
        files: [{ path: ["data"], file: ref("k/f.bin", "f.bin", "x/y") }],
      },
    });
    const op = calls.find((c) => c.url !== AUTH_URL)!;
    expect(JSON.parse(op.sent as string)).toEqual({
      accountId: "acct-9",
      data: Buffer.from("xyz").toString("base64"),
    });
  });
});

describe("triggerProviderAction with a file body", () => {
  const VAULT_TOOL = {
    id: "tool-unipile",
    name: "unipile",
    kind: "api",
    approved: true,
    createdBy: "owner-1",
    credentialRef: `vault://${SECRET_ID}`,
    authBinding: "static",
    workspaceId: null,
    config: UNIPILE,
  };
  const FILE_BODY: ProviderFileBody = {
    encoding: "multipart",
    files: [
      {
        field: "attachments",
        file: {
          storageKey: "k/a.jpg",
          filename: "a.jpg",
          contentType: "image/jpeg",
          size: 4,
        },
      },
    ],
  };

  beforeEach(() => {
    h.toolRows = [VAULT_TOOL];
    h.gate.decision = "propose";
    h.objects.set("k/a.jpg", Buffer.from("aaaa"));
  });

  it("is never stored in a proposal: the gate's propose is refused, nothing filed or read", async () => {
    const r = await triggerProviderAction({
      userId: "owner-1",
      agentUserId: "agent-1",
      provider: `vault://${SECRET_ID}`,
      method: "POST",
      path: "/posts",
      fileBody: FILE_BODY,
    });
    expect(r).toMatchObject({ success: false, status: 409 });
    expect(r.proposed).toBeUndefined();
    expect(h.inserted).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a dry-run names the files and reads none", async () => {
    h.gate.decision = "dry-run";
    const r = await triggerProviderAction({
      userId: "owner-1",
      provider: `vault://${SECRET_ID}`,
      method: "POST",
      path: "/posts",
      fileBody: FILE_BODY,
    });
    expect(r.body).toMatchObject({
      dryRun: true,
      files: [
        {
          filename: "a.jpg",
          contentType: "image/jpeg",
          size: 4,
          encoding: "multipart",
        },
      ],
    });
    expect(h.opened).toEqual([]);
  });

  it("is refused on a JSON-only scheme (nango://), before the gate", async () => {
    h.toolRows = [
      { ...VAULT_TOOL, name: "gmail", credentialRef: "nango://gmail" },
    ];
    const r = await triggerProviderAction({
      userId: "owner-1",
      provider: "nango://gmail",
      method: "POST",
      path: "/send",
      fileBody: FILE_BODY,
    });
    expect(r).toMatchObject({
      success: false,
      status: 400,
      errorCode: "bad_request",
    });
    expect(h.inserted).toEqual([]);
  });

  it("never rides with a JSON body", async () => {
    const r = await triggerProviderAction({
      userId: "owner-1",
      provider: `vault://${SECRET_ID}`,
      method: "POST",
      path: "/posts",
      body: { text: "hi" },
      fileBody: FILE_BODY,
    });
    expect(r).toMatchObject({ success: false, status: 400 });
    expect(h.inserted).toEqual([]);
  });
});
