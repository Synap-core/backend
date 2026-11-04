/**
 * The manifest rule accepts the shapes Stage 1 ships and refuses each one a
 * door must never install (plan U3). Each refusal rules out one hole:
 *  - a need, offer or composite naming an intent nobody knows;
 *  - a verb claiming an op its intent's contract does not declare (or an intent
 *    with no contract at all);
 *  - a composite step using a need it never declared, or reading a need's
 *    output before that need ran;
 *  - an offer that says `public: true` without enforcing `public` access;
 *  - a host service that is privileged, on the host network, mounts a host
 *    path, binds a port beyond the loopback, or pulls an image by tag.
 *
 * The contracts below are a fixture of the frame 0398 seeds (the seed itself is
 * tested in `@synap/api` `intent-contracts.test.ts`); the checker only reads
 * `ops` and `constraints`.
 */
import { describe, expect, it } from "vitest";
import type { IntentContract } from "../capability-intents/index.js";
import {
  capabilityManifestProblems,
  manifestIntents,
  parseCapabilityManifest,
  type ManifestContext,
} from "./index.js";

const lifecycle = (
  constraints: string[],
  ops: Array<"status" | "renew" | "revoke"> = ["status", "revoke"]
): IntentContract => ({
  version: 1,
  output: { type: "object" },
  ops: {
    create: { required: true },
    ...Object.fromEntries(
      ops.map((op) => [op, { required: true, input: { type: "object" } }])
    ),
  },
  constraints,
});

const CONTRACTS: Record<string, IntentContract | null> = {
  expose_http: lifecycle(
    ["auth", "source", "hostname", "runsOn", "public", "port"],
    ["status", "renew", "revoke"]
  ),
  tunnel: lifecycle(["runsOn", "source"], ["status", "renew", "revoke"]),
  dns_record: lifecycle(["zone", "type"]),
  render_video: {
    version: 1,
    output: { type: "object" },
    ops: {
      create: { required: true },
      status: { required: false, input: { type: "object" } },
    },
    constraints: ["format"],
  },
  // A known one-shot intent: no contract.
  send_message: null,
};
const CTX: ManifestContext = {
  isKnownIntent: (s) => s in CONTRACTS,
  contractFor: (s) => CONTRACTS[s],
};

const DIGEST = "a".repeat(64);
const studio = {
  id: "studio",
  image: `ghcr.io/synap-core/hyperframes-studio:0.9.12@sha256:${DIGEST}`,
  ports: [{ container: 3002, host: 3002 }],
  health: { http: "/", port: 3002 },
  env: { HYPERFRAMES_NO_TELEMETRY: "1" },
  limits: { cpus: 2, memoryMb: 4096, diskMb: 20000 },
};

/** HyperFrames: a consumer (needs a URL for its studio) that provides render_video. */
const HYPERFRAMES = {
  key: "hyperframes",
  skills: [
    {
      name: "hyperframes_render",
      intent: "render_video",
      intentOp: "create",
      executionMode: "hosted",
    },
  ],
  services: [studio],
  needs: [
    {
      key: "studio_url",
      intent: "expose_http",
      for: "studio",
      constraints: {
        source: "local_port",
        port: 3002,
        auth: { anyOf: ["pod", "tailnet", "provider"] },
        hostname: { prefer: "hyperframes" },
      },
    },
  ],
};

/** Tailnet Expose: a provider, its verbs implementing create/status/revoke. */
const TAILNET = {
  key: "tailnet-expose",
  offers: {
    expose_http: {
      auth: ["tailnet"],
      source: ["local_port"],
      hostname: { kind: "machine" },
      runsOn: "computer",
      public: false,
    },
  },
  skills: ["create", "status", "revoke"].map((op) => ({
    name: `tailnet_expose_${op}`,
    intent: "expose_http",
    intentOp: op,
  })),
};

/** Cloudflare Expose: a composite (tunnel + DNS record = expose_http). */
const COMPOSITE = {
  key: "cloudflare-expose",
  skills: [],
  offers: {
    expose_http: {
      auth: ["provider", "public"],
      source: ["local_port"],
      hostname: { kind: "subdomain_of" },
      runsOn: "computer",
      public: true,
    },
  },
  needs: [
    { key: "tunnel", intent: "tunnel", constraints: { runsOn: "computer" } },
    { key: "dns", intent: "dns_record" },
  ],
  compose: {
    expose_http: {
      create: [
        {
          need: "tunnel",
          op: "create",
          input: { computer: "$.computer", upstream: "$.source" },
        },
        {
          need: "dns",
          op: "create",
          input: {
            name: "$.hostname.fqdn",
            type: { const: "CNAME" },
            target: "$tunnel.output.hostname",
          },
        },
      ],
      status: "all",
      revoke: "reverse",
      output: {
        url: { join: [{ const: "https://" }, "$dns.output.fqdn"] },
        handle: ["$tunnel.output.handle", "$dns.output.handle"],
      },
    },
  },
};

describe("the manifest rule accepts what Stage 1 ships", () => {
  it.each([
    ["a consumer", HYPERFRAMES],
    ["a provider", TAILNET],
    ["a composite", COMPOSITE],
  ])("%s passes", (_label, def) => {
    expect(capabilityManifestProblems(def, CTX)).toEqual([]);
  });

  it("returns only the fields a definition declares, normalised", () => {
    const r = parseCapabilityManifest(HYPERFRAMES, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.manifest).sort()).toEqual(["needs", "services"]);
    // Ports default to the loopback, volumes and egress to none.
    expect(r.manifest.services![0]).toMatchObject({
      ports: [
        { container: 3002, host: 3002, bind: "127.0.0.1", protocol: "tcp" },
      ],
      volumes: [],
      egress: [],
    });
  });

  it("a definition with no manifest fields has nothing to check or persist", () => {
    const r = parseCapabilityManifest({ key: "gmail", skills: [] }, CTX);
    expect(r).toEqual({ ok: true, manifest: {} });
  });

  it("names the intents a manifest uses (for the caller's contract lookup)", () => {
    expect(manifestIntents(COMPOSITE).sort()).toEqual([
      "dns_record",
      "expose_http",
      "tunnel",
    ]);
    expect(manifestIntents(HYPERFRAMES).sort()).toEqual([
      "expose_http",
      "render_video",
    ]);
  });
});

describe("the manifest rule refuses", () => {
  it("an unknown intent, in a need, an offer or a composite", () => {
    const def = {
      needs: [{ key: "x", intent: "teleport" }],
      offers: { make_coffee: { auth: ["pod"] } },
    };
    const problems = capabilityManifestProblems(def, CTX);
    expect(problems).toContain('needs.0: "teleport" is not a known intent.');
    expect(problems).toContain(
      'offers.make_coffee: "make_coffee" is not a known intent.'
    );
  });

  it("a verb claiming an op its intent's contract does not declare", () => {
    const def = {
      skills: [
        { name: "render_cancel", intent: "render_video", intentOp: "revoke" },
      ],
    };
    expect(capabilityManifestProblems(def, CTX)).toEqual([
      "skills.0 (render_cancel): render_video's contract declares no revoke op.",
    ]);
  });

  it("an op that is not one of the four, an op without an intent, an op on a one-shot intent", () => {
    const problems = capabilityManifestProblems(
      {
        skills: [
          { name: "a", intent: "expose_http", intentOp: "delete" },
          { name: "b", intentOp: "create" },
          { name: "c", intent: "send_message", intentOp: "create" },
        ],
      },
      CTX
    );
    expect(problems).toEqual([
      'skills.0 (a): "delete" is not an op (they are create, status, renew, revoke).',
      "skills.1 (b): it declares intentOp without an intent.",
      "skills.2 (c): send_message has no contract, so a verb cannot implement its create op.",
    ]);
  });

  it("a compose step naming a need that is not declared", () => {
    const def = structuredClone(COMPOSITE);
    def.needs = def.needs.filter((n) => n.key !== "dns");
    const problems = capabilityManifestProblems(def, CTX);
    expect(problems).toContain(
      'compose.expose_http.create.1: it uses the need "dns", which the manifest does not declare.'
    );
  });

  it("a step reading a need's output before a step of that need ran", () => {
    const def = structuredClone(COMPOSITE);
    def.compose.expose_http.create.reverse();
    expect(capabilityManifestProblems(def, CTX)).toContain(
      'compose.expose_http.create.0: $tunnel.output.hostname reads the need "tunnel" before a step of it ran.'
    );
  });

  it("a compose op the provided intent's contract does not declare, and a composite of a one-shot intent", () => {
    const def = structuredClone(COMPOSITE) as Record<string, unknown> & {
      compose: Record<string, unknown>;
    };
    def.compose = {
      dns_record: {
        create: [{ need: "dns", op: "create", input: {} }],
        renew: [{ need: "dns", op: "renew", input: {} }],
        output: {},
      },
      send_message: { create: [{ need: "dns", op: "create" }], output: {} },
    };
    const problems = capabilityManifestProblems(def, CTX);
    expect(problems).toContain(
      "compose.dns_record.renew: dns_record's contract declares no renew op."
    );
    expect(problems).toContain(
      "compose.dns_record.renew.0: dns_record's contract declares no renew op."
    );
    expect(problems).toContain(
      "compose.send_message: send_message has no contract, so it has no ops to compose."
    );
  });

  it("an expression in a compose value (only paths, const, lists and join)", () => {
    const def = structuredClone(COMPOSITE);
    (def.compose.expose_http.output as Record<string, unknown>).url =
      "https://$.hostname";
    const problems = capabilityManifestProblems(def, CTX);
    expect(problems.join("\n")).toMatch(/compose\.expose_http\.output\.url/);
  });

  it("an offer saying public: true without enforcing public access", () => {
    const def = structuredClone(COMPOSITE);
    def.offers.expose_http.auth = ["provider"];
    expect(capabilityManifestProblems(def, CTX)).toEqual([
      'offers.expose_http: it says public: true, but "public" is not among the access modes it enforces (auth).',
    ]);
  });

  it("a constraint the intent's contract does not have, on a need or an offer", () => {
    const problems = capabilityManifestProblems(
      {
        needs: [
          { key: "dns", intent: "dns_record", constraints: { proxied: true } },
        ],
        offers: { tunnel: { runsOn: "computer", vendor: "acme" } },
      },
      CTX
    );
    expect(problems).toEqual([
      'needs.0: "proxied" is not a constraint of dns_record (it has zone, type).',
      'offers.tunnel: "vendor" is not a constraint of tunnel (it has runsOn, source).',
    ]);
  });

  it("a need for a service the manifest does not declare, and a key declared twice", () => {
    const def = structuredClone(HYPERFRAMES);
    def.needs.push({ ...def.needs[0]!, for: "render" });
    const problems = capabilityManifestProblems(def, CTX);
    expect(problems).toContain(
      'needs.1: the need key "studio_url" is declared twice.'
    );
    expect(problems).toContain(
      'needs.1: it is for the service "render", which the manifest does not declare.'
    );
  });

  it.each([
    ["privileged mode", { privileged: true }],
    ["the host network", { network_mode: "host" }],
    [
      "a host path",
      { volumes: [{ name: "data", path: "/data", host: "/etc" }] },
    ],
    [
      "a port beyond the loopback",
      { ports: [{ container: 3002, host: 3002, bind: "0.0.0.0" }] },
    ],
    [
      "an image by tag",
      { image: "ghcr.io/synap-core/hyperframes-studio:latest" },
    ],
    ["an added Linux capability", { cap_add: ["SYS_ADMIN"] }],
  ])("a host service with %s", (_label, patch) => {
    const def = { services: [{ ...studio, ...patch }] };
    expect(capabilityManifestProblems(def, CTX).length).toBeGreaterThan(0);
  });

  it("two services on one host port", () => {
    const def = { services: [studio, { ...studio, id: "render" }] };
    expect(capabilityManifestProblems(def, CTX)).toEqual([
      "services.1: the host port 3002 is used twice.",
    ]);
  });
});

describe("without contracts (the caller did not look them up)", () => {
  it("checks the vocabulary and the frame, and skips what needs a contract", () => {
    // Default context: the published vocabulary, no contracts.
    expect(capabilityManifestProblems(TAILNET)).toEqual([]);
    expect(
      capabilityManifestProblems({
        skills: [{ name: "x", intent: "expose_http", intentOp: "renewal" }],
      })
    ).toEqual([
      'skills.0 (x): "renewal" is not an op (they are create, status, renew, revoke).',
    ]);
  });
});
