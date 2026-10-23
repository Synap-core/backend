/**
 * The consent procedures' input stays BOUNDED (spec 17 PB1).
 *
 * `clientId` was widened from 200 to 512 characters so a pod app's metadata
 * URL fits (CIMD caps it at 512). Pinned at the tRPC door itself: a 513-char
 * client_id is refused by the input schema before any OAuth code runs (no
 * metadata fetch, no database read), and a 512-char one gets through to the
 * OAuth layer.
 *
 * No live Postgres: `@synap/database`'s `db` and the CIMD resolver are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const resolveCimdClient = vi.fn();

vi.mock("@synap/database", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    db: {
      query: {
        users: { findFirst: vi.fn() },
        oauthClients: { findFirst: vi.fn(async () => null) },
      },
    },
  };
});

vi.mock("./oauth/client-metadata.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveCimdClient: (...a: unknown[]) => resolveCimdClient(...a),
  };
});

// The pod admin's unverified-apps policy (PB4) reads pod settings before the
// metadata fetch; it is not what this file pins, so it lets the app through.
vi.mock("../services/pod-app-policy.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, podAppMayConnect: vi.fn(async () => true) };
});

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
// The refusal log line (review A6): a spy, so a test can count the lines.
const refusals = vi.hoisted(() => vi.fn());
vi.mock("./oauth/refusal-log.js", () => ({
  logOAuthRefusal: (fields: unknown) => refusals(fields),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));

// Import AFTER mocks.
import { db } from "@synap/database";
import { apiKeysRouter } from "./api-keys.js";
import { ClientMetadataError } from "./oauth/client-metadata.js";

const caller = () =>
  apiKeysRouter.createCaller({
    authenticated: true,
    userId: "human-1",
  } as never);

const BASE = "https://studio.example.com/";
const urlOf = (n: number) => BASE + "a".repeat(n - BASE.length);

const params = (clientId: string) => ({
  clientId,
  redirectUri: "https://studio.example.com/cb",
  responseType: "code",
  scope: "entity.post.read",
  codeChallenge: "c".repeat(43),
  codeChallengeMethod: "S256",
});

async function errorOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  process.env.PUBLIC_URL = "https://pod.test.synap.live";
  resolveCimdClient.mockReset();
  resolveCimdClient.mockRejectedValue(
    new ClientMetadataError("the document URL answered 404")
  );
});

describe("consent procedures — client_id length is bounded", () => {
  it("getOAuthConsentContext refuses a 513-char client_id at the input schema", async () => {
    const err = await errorOf(
      caller().getOAuthConsentContext(params(urlOf(513)))
    );
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.message).toMatch(/512/);
    expect(resolveCimdClient).not.toHaveBeenCalled();
  });

  it("decideOAuthAuthorization refuses a 513-char client_id at the input schema", async () => {
    const err = await errorOf(
      caller().decideOAuthAuthorization({
        ...params(urlOf(513)),
        approve: true,
      })
    );
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.message).toMatch(/512/);
    expect(resolveCimdClient).not.toHaveBeenCalled();
  });

  it("a 512-char client_id passes the schema and reaches the OAuth layer", async () => {
    const err = await errorOf(
      caller().getOAuthConsentContext(params(urlOf(512)))
    );
    expect(err.message).toMatch(/could not be read/);
    expect(resolveCimdClient).toHaveBeenCalledTimes(1);
  });
});

describe("consent decision — a cross-site form cannot drive it (T8, app-person-token.ts)", () => {
  it("a multipart (FormData) body, the one shape a plain HTML form can POST that tRPC parses, fails the input schema", async () => {
    // tRPC answers text/plain and url-encoded with 415 before any procedure;
    // multipart reaches the procedure as a FormData, which must not pass.
    const form = new FormData();
    for (const [k, v] of Object.entries(params(urlOf(100)))) form.set(k, v);
    form.set("approve", "true");
    const err = await errorOf(caller().decideOAuthAuthorization(form as never));
    expect(err.code).toBe("BAD_REQUEST");
    expect(resolveCimdClient).not.toHaveBeenCalled();
  });
});

describe("consent decision — a cookie-carrying call must come from this pod's console (L2, PR #29)", () => {
  const withReq = (headers: Record<string, string>) =>
    apiKeysRouter.createCaller({
      authenticated: true,
      userId: "human-1",
      req: new Request("https://pod.test.synap.live/trpc/x", {
        method: "POST",
        headers,
      }),
    } as never);
  const decide = (headers: Record<string, string>) =>
    errorOf(
      withReq(headers).decideOAuthAuthorization({
        ...params(urlOf(100)),
        approve: true,
      })
    );

  it("a cookie from another origin is refused before the OAuth layer", async () => {
    const err = await decide({
      cookie: "ory_kratos_session=x",
      origin: "https://evil.example.com",
    });
    expect(err.code).toBe("FORBIDDEN");
    expect(resolveCimdClient).not.toHaveBeenCalled();
  });

  it("a cookie with no origin at all is refused", async () => {
    const err = await decide({ cookie: "ory_kratos_session=x" });
    expect(err.code).toBe("FORBIDDEN");
  });

  it("control: the pod's console origin reaches the OAuth layer", async () => {
    process.env.POD_ADMIN_URL = "https://admin.pod.test.synap.live";
    try {
      const err = await decide({
        cookie: "ory_kratos_session=x",
        origin: "https://admin.pod.test.synap.live",
      });
      expect(err.message).toMatch(/could not be read/);
      expect(resolveCimdClient).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.POD_ADMIN_URL;
    }
  });
});

describe("consent refusals leave one log line each (review A6)", () => {
  const id = "https://studio.example.com/.well-known/synap-client.json";

  it("an unreadable document: the client_id, the phase and the reason", async () => {
    refusals.mockClear();
    await errorOf(caller().getOAuthConsentContext(params(id)));
    expect(refusals).toHaveBeenCalledTimes(1);
    expect(refusals).toHaveBeenCalledWith({
      phase: "consent",
      clientId: id,
      reason: "app_description_unreadable",
      detail: expect.stringMatching(/could not be read/),
    });
  });

  it("the decision's refusal is logged too", async () => {
    refusals.mockClear();
    await errorOf(
      caller().decideOAuthAuthorization({ ...params(id), approve: true })
    );
    expect(refusals).toHaveBeenCalledTimes(1);
    expect(refusals.mock.calls[0]![0]).toMatchObject({
      phase: "consent",
      reason: "app_description_unreadable",
    });
  });

  it("a refusal of who decides (FORBIDDEN) is logged too", async () => {
    refusals.mockClear();
    // A registered MCP client; the caller is no person of this pod.
    vi.mocked(db.query.oauthClients.findFirst).mockResolvedValueOnce({
      clientId: "dcr_a6",
      clientKind: "dcr",
      clientName: "A6 client",
      redirectUris: ["https://studio.example.com/cb"],
      scopes: ["mcp.read"],
      requestedPermissions: [],
    } as never);
    const err = await errorOf(
      caller().decideOAuthAuthorization({
        ...params("dcr_a6"),
        approve: true,
      })
    );
    expect(err.code).toBe("FORBIDDEN");
    expect(refusals).toHaveBeenCalledTimes(1);
    expect(refusals).toHaveBeenCalledWith({
      phase: "consent",
      clientId: "dcr_a6",
      reason: "forbidden",
      detail: err.message,
    });
  });
});
