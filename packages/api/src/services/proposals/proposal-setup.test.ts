/**
 * `resolveProposalSetups` — the READ-time derivation of "what does this
 * `capability.install` proposal still need from a human".
 *
 * WHAT IS REAL HERE, AND WHY IT MATTERS:
 *   · `extractInstallParams` and `deriveConnection` are the REAL catalog
 *     functions — the whole claim of this module is that it reuses them, and a
 *     test that mocked them would prove only that a mock returns what it was
 *     told to. The `secret` flag in particular is derived by the real
 *     `extractInstallParams` name/type heuristic, never restated here.
 *   · Only the two I/O leaves are mocked: `lookupCatalogEntry` (a DB read) and
 *     `loadConnState` (a DB read + a Nango round-trip).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  lookupCatalogEntry: vi.fn(),
  loadConnState: vi.fn(),
}));

vi.mock("../capabilities/marketplace-install.js", () => ({
  lookupCatalogEntry: h.lookupCatalogEntry,
}));

vi.mock("../capabilities/capability-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // REAL extractInstallParams + deriveConnection; only the I/O leaf is faked.
  return { ...actual, loadConnState: h.loadConnState };
});

import {
  resolveProposalSetups,
  redactSecretParams,
  proposalSetupFields,
  withProposalSetup,
  REDACTED_PARAM,
  type ProposalSetup,
} from "./proposal-setup.js";

const EMPTY_CONN = {
  providerConn: new Map<string, string>(),
  providerAvailable: null,
  providerConnFault: null,
  vaultExists: new Set<string>(),
  vaultMeta: new Map<string, { name: string; service?: string }>(),
  reauthConnIds: new Set<string>(),
};

/** A vault-credential template: one required secret param feeding `vault[]`. */
const VAULT_TEMPLATE = {
  key: "acme",
  name: "Acme",
  params: [
    { name: "apiKey", label: "API Key", type: "password", required: true },
    { name: "baseUrl", label: "Base URL", type: "string", required: false },
  ],
  vault: [
    {
      ref: "acmeKey",
      name: "Acme API Key",
      value: "{{apiKey}}",
      type: "api_key",
    },
  ],
  tools: [{ name: "Acme API", credentialRef: "acmeKey" }],
  skills: [],
};

/** An OAuth template: the connection is a PROVIDER, unfillable by a form. */
const NANGO_TEMPLATE = {
  key: "gcal",
  name: "Google Calendar",
  params: [],
  vault: [],
  tools: [{ name: "Calendar", credentialRef: "nango://google" }],
  skills: [],
};

function installRow(
  id: string,
  params: Record<string, unknown>,
  slug = "acme"
) {
  return {
    id,
    proposalType: "capability.install",
    targetType: "capability",
    data: { slug, kind: "capability", params },
  };
}

beforeEach(() => {
  h.lookupCatalogEntry.mockReset();
  h.loadConnState.mockReset();
  h.loadConnState.mockResolvedValue(EMPTY_CONN);
});

describe("derivation", () => {
  it("a page with NO install rows does zero I/O", async () => {
    const out = await resolveProposalSetups(
      [
        { id: "p1", proposalType: "create", targetType: "entity", data: {} },
        { id: "p2", proposalType: "merge", targetType: "entity", data: {} },
      ],
      "u1"
    );
    expect(out.size).toBe(0);
    // Load-bearing: `loadConnState` reaches Nango. A list of ordinary proposals
    // must not pay a broker round-trip.
    expect(h.loadConnState).not.toHaveBeenCalled();
    expect(h.lookupCatalogEntry).not.toHaveBeenCalled();
  });

  it("an empty-string required param is UNSATISFIED and BLOCKING", async () => {
    h.lookupCatalogEntry.mockResolvedValue({ definition: VAULT_TEMPLATE });
    const out = await resolveProposalSetups(
      [installRow("p1", { apiKey: "" })],
      "u1"
    );
    const setup = out.get("p1")!;
    expect(setup.params.map((p) => p.name)).toEqual(["apiKey", "baseUrl"]);
    const apiKey = setup.params.find((p) => p.name === "apiKey")!;
    expect(apiKey.satisfied).toBe(false);
    expect(apiKey.required).toBe(true);
    // Derived by the REAL extractInstallParams, from type "password".
    expect(apiKey.secret).toBe(true);
    expect(setup.blocking).toBe(true);
  });

  it("a filled required param is satisfied and NOT blocking", async () => {
    h.lookupCatalogEntry.mockResolvedValue({ definition: VAULT_TEMPLATE });
    const out = await resolveProposalSetups(
      [installRow("p1", { apiKey: "sk-live-abc" })],
      "u1"
    );
    const setup = out.get("p1")!;
    expect(setup.params.find((p) => p.name === "apiKey")!.satisfied).toBe(true);
    expect(setup.blocking).toBe(false);
  });

  it("the VALUE never appears anywhere on the derived setup", async () => {
    h.lookupCatalogEntry.mockResolvedValue({ definition: VAULT_TEMPLATE });
    const out = await resolveProposalSetups(
      [installRow("p1", { apiKey: "sk-live-SHOULD-NEVER-APPEAR" })],
      "u1"
    );
    expect(JSON.stringify(out.get("p1"))).not.toContain("SHOULD-NEVER-APPEAR");
  });

  it("an unresolvable vault ref is UNSATISFIED; a resolvable one is satisfied", async () => {
    h.lookupCatalogEntry.mockResolvedValue({ definition: VAULT_TEMPLATE });
    const id = "11111111-1111-1111-1111-111111111111";

    const missing = await resolveProposalSetups(
      [installRow("p1", { apiKey: `vault://${id}` })],
      "u1"
    );
    const m = missing.get("p1")!.params.find((p) => p.name === "apiKey")!;
    expect(m.satisfied).toBe(false);
    // The REF is on the wire — it is a pointer, not a credential.
    expect(m.ref).toBe(`vault://${id}`);
    expect(missing.get("p1")!.blocking).toBe(true);

    h.loadConnState.mockResolvedValue({
      ...EMPTY_CONN,
      vaultExists: new Set([id]),
    });
    const present = await resolveProposalSetups(
      [installRow("p2", { apiKey: `vault://${id}` })],
      "u1"
    );
    expect(
      present.get("p2")!.params.find((p) => p.name === "apiKey")!.satisfied
    ).toBe(true);
    expect(present.get("p2")!.blocking).toBe(false);
  });

  it("ONE malformed pointer on the page does not poison the OTHER rows' refs", async () => {
    // `params` are writable by whoever proposed the install. A malformed id in
    // the id set reaches `inArray(uuidColumn, …)`, which throws a cast error the
    // loader swallows — so every VALID ref on the same page read as missing
    // because of one planted `vault://x`. Only well-formed ids may be looked up;
    // the malformed row is still marked unresolved on its own.
    h.lookupCatalogEntry.mockResolvedValue({ definition: VAULT_TEMPLATE });
    const good = "44444444-4444-4444-4444-444444444444";
    h.loadConnState.mockResolvedValue({
      ...EMPTY_CONN,
      vaultExists: new Set([good]),
    });
    const out = await resolveProposalSetups(
      [
        installRow("bad", { apiKey: "vault://not-a-uuid" }),
        installRow("ok", { apiKey: `vault://${good}` }),
      ],
      "u1"
    );

    // The lookup was handed ONLY the well-formed id.
    expect(h.loadConnState).toHaveBeenCalledTimes(1);
    expect(h.loadConnState.mock.calls[0]![1]).toEqual([good]);

    const okParam = out.get("ok")!.params.find((p) => p.name === "apiKey")!;
    expect(okParam.satisfied).toBe(true);

    const badParam = out.get("bad")!.params.find((p) => p.name === "apiKey")!;
    expect(badParam.satisfied).toBe(false);
    expect(badParam.refUnresolved).toBe(true);
    expect(out.get("bad")!.blocking).toBe(true);
  });

  it("NAMES the linked secret — refName/refService, never a value", async () => {
    // The blind-consent hole: an agent may file `capability.install` with
    // `params.apiKey = "vault://<one of the human's OTHER secrets>"`. Projected
    // as a bare ref it rendered "Linked vault secret" on every surface, so the
    // reviewer approved a credential nobody named.
    h.lookupCatalogEntry.mockResolvedValue({ definition: VAULT_TEMPLATE });
    const id = "22222222-2222-2222-2222-222222222222";
    h.loadConnState.mockResolvedValue({
      ...EMPTY_CONN,
      vaultExists: new Set([id]),
      vaultMeta: new Map([[id, { name: "Stripe", service: "live" }]]),
    });
    const out = await resolveProposalSetups(
      [installRow("p1", { apiKey: `vault://${id}` })],
      "u1"
    );
    const param = out.get("p1")!.params.find((p) => p.name === "apiKey")!;
    expect(param.satisfied).toBe(true);
    expect(param.refName).toBe("Stripe");
    expect(param.refService).toBe("live");
    expect(param.refUnresolved).toBeUndefined();
    // Labels only. Nothing that could be a value rides along.
    expect(Object.keys(param)).not.toContain("value");
  });

  it("an UNRESOLVABLE ref says so — refUnresolved, and NO label", async () => {
    // An empty read and a failed read are different facts (`CLAUDE.md`). A ref
    // the caller cannot resolve must not read as "not filled in yet", and must
    // not carry a name — a label for a secret outside the caller's own-or-
    // pod-wide scope would disclose that it exists.
    h.lookupCatalogEntry.mockResolvedValue({ definition: VAULT_TEMPLATE });
    const id = "33333333-3333-3333-3333-333333333333";
    h.loadConnState.mockResolvedValue({ ...EMPTY_CONN });
    const out = await resolveProposalSetups(
      [installRow("p1", { apiKey: `vault://${id}` })],
      "u1"
    );
    const param = out.get("p1")!.params.find((p) => p.name === "apiKey")!;
    expect(param.satisfied).toBe(false);
    expect(param.refUnresolved).toBe(true);
    expect(param.refName).toBeUndefined();
    expect(param.refService).toBeUndefined();
  });

  it("a param with NO ref carries none of the ref labels", async () => {
    // Non-vacuity in the other direction: the three fields are absent, not
    // defaulted to empty strings that a surface would render as a blank name.
    h.lookupCatalogEntry.mockResolvedValue({ definition: VAULT_TEMPLATE });
    h.loadConnState.mockResolvedValue({ ...EMPTY_CONN });
    const out = await resolveProposalSetups([installRow("p1", {})], "u1");
    const param = out.get("p1")!.params.find((p) => p.name === "apiKey")!;
    expect("refName" in param).toBe(false);
    expect("refUnresolved" in param).toBe(false);
  });

  it("a declared default satisfies a required param the caller omitted", async () => {
    h.lookupCatalogEntry.mockResolvedValue({
      definition: {
        ...VAULT_TEMPLATE,
        params: [{ name: "apiKey", required: true, default: "seeded" }],
      },
    });
    const out = await resolveProposalSetups([installRow("p1", {})], "u1");
    expect(out.get("p1")!.blocking).toBe(false);
  });

  it("an unconnected PROVIDER blocks and carries the ONE next action", async () => {
    h.lookupCatalogEntry.mockResolvedValue({ definition: NANGO_TEMPLATE });
    const out = await resolveProposalSetups(
      [installRow("p1", {}, "gcal")],
      "u1"
    );
    const setup = out.get("p1")!;
    expect(setup.connection).toMatchObject({
      required: true,
      kind: "provider",
      provider: "google",
      state: "missing",
    });
    expect(setup.blocking).toBe(true);
    // From `resolveCapabilityBlock` — the ONE resolver, not a local hint.
    expect(setup.nextAction?.kind).toBe("connect");
  });

  it("a CONNECTED provider does not block and carries no next action", async () => {
    h.lookupCatalogEntry.mockResolvedValue({ definition: NANGO_TEMPLATE });
    h.loadConnState.mockResolvedValue({
      ...EMPTY_CONN,
      providerConn: new Map([["google", "conn-1"]]),
    });
    const out = await resolveProposalSetups(
      [installRow("p1", {}, "gcal")],
      "u1"
    );
    expect(out.get("p1")!.blocking).toBe(false);
    expect(out.get("p1")!.nextAction).toBeUndefined();
  });

  it("a vault-kind requirement is NOT surfaced as a second connection step", async () => {
    // The template's `vault[].value` IS `{{apiKey}}`; showing a `connection:
    // missing` beside a filled param would make a complete form read blocked.
    h.lookupCatalogEntry.mockResolvedValue({ definition: VAULT_TEMPLATE });
    const out = await resolveProposalSetups(
      [installRow("p1", { apiKey: "sk-live-abc" })],
      "u1"
    );
    expect(out.get("p1")!.connection).toBeUndefined();
    expect(out.get("p1")!.blocking).toBe(false);
  });

  it("a catalog cache MISS yields NO entry — never an invented empty setup", async () => {
    h.lookupCatalogEntry.mockResolvedValue(null);
    const out = await resolveProposalSetups([installRow("p1", {})], "u1");
    // Absent ≠ `{blocking:false}`. We do not know the manifest, so we make no
    // claim that the proposal is ready.
    expect(out.has("p1")).toBe(false);
  });

  it("a non-capability kind (automation/template/cell) has no manifest gap", async () => {
    const out = await resolveProposalSetups(
      [
        {
          id: "p1",
          proposalType: "capability.install",
          targetType: "capability",
          data: { slug: "x", kind: "automation", params: {} },
        },
      ],
      "u1"
    );
    expect(out.size).toBe(0);
    expect(h.lookupCatalogEntry).not.toHaveBeenCalled();
  });

  it("one cache read per DISTINCT slug, not per row", async () => {
    h.lookupCatalogEntry.mockResolvedValue({ definition: VAULT_TEMPLATE });
    await resolveProposalSetups(
      [
        installRow("p1", {}),
        installRow("p2", {}),
        installRow("p3", {}, "gcal"),
      ],
      "u1"
    );
    expect(h.lookupCatalogEntry).toHaveBeenCalledTimes(2);
    expect(h.loadConnState).toHaveBeenCalledTimes(1);
  });
});

describe("redaction — a secret param's value never reaches a reader", () => {
  const setup = (over: Partial<ProposalSetup> = {}): ProposalSetup => ({
    params: [
      { name: "apiKey", required: true, secret: true, satisfied: true },
      { name: "baseUrl", required: false, secret: false, satisfied: true },
    ],
    blocking: false,
    ...over,
  });

  it("masks a secret param and leaves a non-secret one alone", () => {
    const out = redactSecretParams(
      {
        slug: "acme",
        params: { apiKey: "sk-live-LEAK", baseUrl: "https://x" },
      },
      setup()
    ) as { params: Record<string, unknown> };
    expect(out.params.apiKey).toBe(REDACTED_PARAM);
    expect(out.params.baseUrl).toBe("https://x");
    expect(JSON.stringify(out)).not.toContain("sk-live-LEAK");
  });

  it("KEEPS a vault ref — it is a pointer, and the form needs it", () => {
    const ref = "vault://22222222-2222-2222-2222-222222222222";
    const out = redactSecretParams({ params: { apiKey: ref } }, setup()) as {
      params: Record<string, unknown>;
    };
    expect(out.params.apiKey).toBe(ref);
  });

  it("does not invent a key for a param that was never supplied", () => {
    const out = redactSecretParams({ params: { baseUrl: "u" } }, setup()) as {
      params: Record<string, unknown>;
    };
    expect("apiKey" in out.params).toBe(false);
  });

  it("is total over an odd payload", () => {
    expect(redactSecretParams(null, setup())).toBeNull();
    expect(redactSecretParams({ params: "not-an-object" }, setup())).toEqual({
      params: "not-an-object",
    });
  });

  it("the stamp door redacts AND sets setup, or does neither", () => {
    const setups = new Map([["p1", setup()]]);
    const row = { id: "p1", data: { params: { apiKey: "sk-live-LEAK" } } };
    const stamped = withProposalSetup(row, setups);
    expect(stamped.setup).toBeDefined();
    expect(JSON.stringify(stamped)).not.toContain("sk-live-LEAK");

    // No setup AND nothing secret-shaped ⇒ the fields spread to a no-op.
    expect(proposalSetupFields("p-unknown", { a: 1 }, setups)).toEqual({});
  });
});

/**
 * ROUND-2: redaction must not fail OPEN when derivation fails.
 *
 * `resolveProposalSetups` does `if (!def) continue`, so a `lookupCatalogEntry`
 * MISS (unsynced/unpublished slug, or a slug an agent invented on
 * `market.install`) or THROW produced NO map entry — and `proposalSetupFields`
 * then returned `{}`, echoing the agent's raw inlined `data.params` through
 * `proposals.get`, Hub `view=full` and MCP `detail:"full"`. The case where we
 * know least about the payload was the case that redacted nothing.
 *
 * Driven through the REAL `resolveProposalSetups` + `proposalSetupFields` /
 * `withProposalSetup` — the doors the read paths actually call — with only the
 * catalog I/O leaf faked.
 */
describe("a row whose setup cannot be derived is STILL redacted", () => {
  const LEAK = "sk-live-UNDERIVABLE-0123456789";

  it("non-vacuity: the fixture really is underivable and really carries a key", async () => {
    h.lookupCatalogEntry.mockResolvedValue(undefined);
    const setups = await resolveProposalSetups(
      [installRow("p1", { apiKey: LEAK }, "never-synced")],
      "u1"
    );
    // The derivation genuinely produced nothing — this is the `!def` branch,
    // not a test that accidentally got a setup and proved the other path.
    expect(setups.size).toBe(0);
    expect(installRow("p1", { apiKey: LEAK }).data.params.apiKey).toBe(LEAK);
  });

  it("catalog MISS: the key is absent from every projection", async () => {
    h.lookupCatalogEntry.mockResolvedValue(undefined);
    const row = installRow(
      "p1",
      { apiKey: LEAK, baseUrl: "https://x" },
      "nope"
    );
    const setups = await resolveProposalSetups([row], "u1");

    const fields = proposalSetupFields(row.id, row.data, setups);
    expect(JSON.stringify(fields)).not.toContain(LEAK);
    expect(
      (fields.data as { params: Record<string, unknown> }).params.apiKey
    ).toBe(REDACTED_PARAM);
    // Non-secret params are untouched — this is a mask, not a wipe.
    expect(
      (fields.data as { params: Record<string, unknown> }).params.baseUrl
    ).toBe("https://x");
    // …and there is still NO `setup`: we did not invent a claim we cannot make.
    expect(fields.setup).toBeUndefined();

    expect(JSON.stringify(withProposalSetup(row, setups))).not.toContain(LEAK);
  });

  it("catalog THROW: the key is absent from every projection", async () => {
    h.lookupCatalogEntry.mockRejectedValue(new Error("catalog unavailable"));
    const row = installRow("p1", { apiKey: LEAK }, "boom");
    const setups = await resolveProposalSetups([row], "u1");
    expect(setups.size).toBe(0);
    expect(
      JSON.stringify(proposalSetupFields(row.id, row.data, setups))
    ).not.toContain(LEAK);
    expect(JSON.stringify(withProposalSetup(row, setups))).not.toContain(LEAK);
  });

  it("covers the name spellings an invented slug can carry, and keeps a ref", async () => {
    h.lookupCatalogEntry.mockResolvedValue(undefined);
    const ref = "vault://33333333-3333-3333-3333-333333333333";
    const row = installRow(
      "p1",
      {
        apiKey: "a-leak",
        access_token: "b-leak",
        clientSecret: "c-leak",
        password: "d-leak",
        linked: ref,
        region: "eu",
      },
      "nope"
    );
    const setups = await resolveProposalSetups([row], "u1");
    const out = (
      proposalSetupFields(row.id, row.data, setups).data as {
        params: Record<string, unknown>;
      }
    ).params;
    for (const k of ["apiKey", "access_token", "clientSecret", "password"]) {
      expect(out[k]).toBe(REDACTED_PARAM);
    }
    expect(out.linked).toBe(ref); // a pointer, kept — the form needs it
    expect(out.region).toBe("eu");
  });
});
