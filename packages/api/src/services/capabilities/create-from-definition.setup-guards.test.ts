/**
 * APPROVAL-TIME setup guards on `createCapabilityFromDefinition`.
 *
 * ── THE HOLES THESE CLOSE, ALL THREE SHIPPED ────────────────────────────────
 *  1. The required-param guard tested `=== undefined`, so `""` passed. It then
 *     interpolated into `vault[].value` and installed a BLANK credential that
 *     the catalog read as a satisfied connection.
 *  2. `interpolateString` maps an UNKNOWN `{{token}}` to the empty string with
 *     no signal (`_shared/interpolate.ts:18-21`), so a typo'd token in a
 *     secret's value produced the same blank credential by a second route.
 *  3. A `nango://` template installed with no connection at all — every verb
 *     then 401s, filed as `approval_failed` with a raw sentence.
 *
 * Each now throws a `SetupRequiredError`, whose DUCK-TYPED props
 * (`failureClass`/`missingFields`/`connection`) the classifier reads without
 * importing this lane. The assertions below go through `isSetupRequiredLike` —
 * the reader's own narrowing — rather than `instanceof`, because `instanceof`
 * is exactly what a serialization hop breaks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  loadConnState: vi.fn(),
  selectRows: [] as unknown[],
}));

vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(async () => null),
}));
vi.mock("../links/links-service.js", () => ({
  createLinks: vi.fn(async () => []),
}));
vi.mock("../../routers/capability-containers.js", () => ({
  capabilityContainersRouter: {
    createCaller: () => ({
      create: vi.fn(async () => ({ capability: { id: "cap-1" } })),
      addPart: vi.fn(async () => ({ ok: true })),
    }),
  },
}));
vi.mock("./capability-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // REAL `deriveConnection` — the guard's whole claim is that it reuses the
  // catalog's rule. Only the I/O leaf is faked.
  return { ...actual, loadConnState: m.loadConnState };
});
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => m.selectRows,
  };
  const upd = { set: () => upd, where: async () => undefined };
  return { ...actual, db: { select: () => chain, update: () => upd } };
});

import { createCapabilityFromDefinition } from "./create-from-definition.js";
import { isSetupRequiredLike } from "../proposals/setup-required-error.js";

const UID = "22222222-2222-2222-2222-222222222222";

const EMPTY_CONN = {
  providerConn: new Map<string, string>(),
  providerAvailable: null,
  providerConnFault: null,
  vaultExists: new Set<string>(),
  reauthConnIds: new Set<string>(),
};

const apply = (def: Record<string, unknown>, params: Record<string, unknown>) =>
  createCapabilityFromDefinition(def as never, params, {
    userId: UID,
    workspaceId: null,
  } as never);

const VAULT_DEF = {
  key: "acme",
  name: "Acme",
  params: [{ name: "apiKey", label: "API Key", required: true }],
  vault: [
    {
      ref: "acmeKey",
      name: "Acme API Key",
      value: "{{apiKey}}",
      type: "api_key",
    },
  ],
  tools: [],
  skills: [],
};

/** Run and return the thrown error (fails loudly if nothing throws). */
async function thrownBy(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the apply to throw, but it resolved");
}

beforeEach(() => {
  m.selectRows = [];
  m.loadConnState.mockReset();
  m.loadConnState.mockResolvedValue(EMPTY_CONN);
});

describe("blank is missing", () => {
  it.each([
    ["an empty string", ""],
    ["whitespace", "   "],
    ["null", null],
    ["absent", undefined],
  ])("%s required param is refused as missing_field", async (_label, value) => {
    const err = await thrownBy(() =>
      apply(VAULT_DEF, value === undefined ? {} : { apiKey: value })
    );
    expect(isSetupRequiredLike(err)).toBe(true);
    const e = err as { failureClass: string; missingFields: string[] };
    expect(e.failureClass).toBe("missing_field");
    expect(e.missingFields).toEqual(["apiKey"]);
    // A safe sentence naming the LABEL, never a value.
    expect((err as Error).message).toBe("Needs setup: API Key.");
  });

  it("a filled param passes the guard (it reaches the vault write)", async () => {
    // Not asserting the install succeeds — only that the SETUP guard no longer
    // rejects. A later failure is a different failure.
    const err = await thrownBy(() => apply(VAULT_DEF, { apiKey: "sk-live" }));
    expect(isSetupRequiredLike(err)).toBe(false);
  });

  /**
   * THE DISCRIMINATING INPUT.
   *
   * Every case above is ALSO caught by the second guard (the credential-token
   * scan), because `apiKey` feeds `vault[].value`. Reverting the blank check
   * alone therefore leaves them all GREEN — a control that proves nothing. The
   * input where the two rules actually disagree is a required param that feeds
   * NO credential field: only the blank check can see it.
   *
   * Negative control, measured: with `isBlankParamValue` reverted to
   * `=== undefined`, this ONE test goes red and the other thirteen stay green.
   */
  it("a required param feeding NO credential field is still refused when blank", async () => {
    const err = await thrownBy(() =>
      apply(
        {
          key: "acme",
          name: "Acme",
          params: [{ name: "baseUrl", label: "Base URL", required: true }],
          vault: [],
          tools: [{ name: "Acme API", config: { baseUrl: "{{baseUrl}}" } }],
          skills: [],
        },
        { baseUrl: "" }
      )
    );
    expect(isSetupRequiredLike(err)).toBe(true);
    expect((err as { missingFields: string[] }).missingFields).toEqual([
      "baseUrl",
    ]);
  });

  it("names EVERY missing field, not just the first", async () => {
    const err = (await thrownBy(() =>
      apply(
        {
          ...VAULT_DEF,
          params: [
            { name: "apiKey", label: "API Key", required: true },
            { name: "accountId", label: "Account ID", required: true },
          ],
          vault: [
            {
              ref: "k",
              name: "K",
              value: "{{apiKey}}:{{accountId}}",
              type: "api_key",
            },
          ],
        },
        {}
      )
    )) as { missingFields: string[] };
    expect(err.missingFields).toEqual(["apiKey", "accountId"]);
  });
});

describe("an unresolved {{token}} on a credential field fails, never silently ''", () => {
  it("a token declared by NO param is refused", async () => {
    const err = (await thrownBy(() =>
      apply(
        {
          ...VAULT_DEF,
          // Nothing declares `apiKeyy`; the old code interpolated it to "".
          params: [],
          vault: [
            { ref: "k", name: "K", value: "{{apiKeyy}}", type: "api_key" },
          ],
        },
        { apiKey: "sk-live" }
      )
    )) as { failureClass: string; missingFields: string[] };
    expect(err.failureClass).toBe("missing_field");
    expect(err.missingFields).toEqual(["apiKeyy"]);
  });

  it("a token on a tool credentialRef is refused too", async () => {
    const err = (await thrownBy(() =>
      apply(
        {
          key: "acme",
          name: "Acme",
          params: [],
          vault: [],
          tools: [{ name: "T", credentialRef: "vault://{{missingId}}" }],
          skills: [],
        },
        {}
      )
    )) as { missingFields: string[] };
    expect(err.missingFields).toEqual(["missingId"]);
  });

  it("a RUNTIME providerSpec placeholder is NOT treated as a setup gap", async () => {
    // `query.maxResults` is resolved at CALL time from the verb's arguments and
    // the applier restores the raw providerSpec. Scanning it would refuse every
    // declarative verb template.
    const err = await thrownBy(() =>
      apply(
        {
          key: "acme",
          name: "Acme",
          params: [],
          vault: [],
          tools: [],
          skills: [
            {
              name: "acme_search",
              scope: "pod",
              providerSpec: { query: "{{maxResults}}" },
            },
          ],
        },
        {}
      )
    );
    expect(isSetupRequiredLike(err)).toBe(false);
  });
});

describe("a required provider connection must be live", () => {
  const NANGO_DEF = {
    key: "gcal",
    name: "Google Calendar",
    params: [],
    vault: [],
    tools: [{ name: "Calendar", credentialRef: "nango://google" }],
    skills: [],
  };

  it("refuses with no_connection when the provider is not connected", async () => {
    const err = (await thrownBy(() => apply(NANGO_DEF, {}))) as {
      failureClass: string;
      connection: { provider?: string; state?: string };
    };
    expect(isSetupRequiredLike(err)).toBe(true);
    expect(err.failureClass).toBe("no_connection");
    expect(err.connection).toEqual({ provider: "google", state: "missing" });
    expect((err as unknown as Error).message).toBe(
      "Needs setup: connect google."
    );
  });

  it("says RECONNECT, not connect, for an expired connection", async () => {
    m.loadConnState.mockResolvedValue({
      ...EMPTY_CONN,
      providerConn: new Map([["google", "conn-1"]]),
      reauthConnIds: new Set(["conn-1"]),
    });
    const err = (await thrownBy(() => apply(NANGO_DEF, {}))) as Error & {
      connection: { state?: string };
    };
    expect(err.connection.state).toBe("expired");
    // RECONNECT is a different act from connect, and the sentence says so.
    expect(err.message).toBe(
      "Needs setup: reconnect google — its access expired or was revoked."
    );
  });

  it("passes the guard when the provider IS connected", async () => {
    m.loadConnState.mockResolvedValue({
      ...EMPTY_CONN,
      providerConn: new Map([["google", "conn-1"]]),
    });
    const err = await thrownBy(() => apply(NANGO_DEF, {}));
    expect(isSetupRequiredLike(err)).toBe(false);
  });

  it("an UNREAD broker does NOT block — unverified ≠ not connected", async () => {
    // "Empty and failed are different facts." Refusing an install because the
    // Nango list was briefly unreachable is that defect at its most expensive.
    m.loadConnState.mockResolvedValue({
      ...EMPTY_CONN,
      providerConnFault: { reason: "unreachable", message: "boom" },
    });
    const err = await thrownBy(() => apply(NANGO_DEF, {}));
    expect(isSetupRequiredLike(err)).toBe(false);
  });

  it("a vault-only template never reaches the provider check at all", async () => {
    await thrownBy(() => apply(VAULT_DEF, {}));
    expect(m.loadConnState).not.toHaveBeenCalled();
  });
});
