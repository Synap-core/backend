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

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));

// Import AFTER mocks.
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
