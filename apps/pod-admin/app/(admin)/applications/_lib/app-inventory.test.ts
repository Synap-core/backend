import { describe, expect, it } from "vitest";
import {
  appHref,
  buildInventory,
  countByVia,
  headline,
  hostOf,
  keyAppRow,
  mcpReach,
  mcpRow,
  mcpState,
  parseVia,
  pendingSummary,
  signInRow,
  signInState,
  type KeyAppInput,
  type McpClientInput,
  type SignInInput,
} from "./app-inventory";

const NOW = new Date("2026-10-13T12:00:00Z").getTime();
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW - days * DAY);
const SALES = "11111111-1111-4111-8111-111111111111";

function keyApp(over: Partial<KeyAppInput> = {}): KeyAppInput {
  return {
    public_id: "app_1",
    name: "Raycast",
    owner: { id: "u1", name: "Antoine", email: "a@x" },
    workspace_names: { [SALES]: "Sales" },
    grants: [{ permissions: ["entity.note.read"], workspaceIds: [SALES] }],
    keys: [
      {
        isActive: true,
        revokedAt: null,
        expiresAt: null,
        lastUsedAt: ago(0),
      },
    ],
    created_at: ago(10),
    last_used_at: ago(0),
    revoked_at: null,
    pending_request: null,
    ...over,
  };
}

function signIn(over: Partial<SignInInput> = {}): SignInInput {
  return {
    id: "c0ffee00-0000-4000-8000-000000000001",
    displayName: "Synap Landing",
    publisherUrl: "https://www.synap.live",
    allowedOrigins: ["https://landing.synap.live"],
    status: "approved",
    lastUsedAt: ago(1),
    peopleCount: 12,
    ...over,
  };
}

function client(over: Partial<McpClientInput> = {}): McpClientInput {
  return {
    clientId: "dcr_abc",
    clientName: "Claude",
    redirectHosts: ["claude.ai"],
    scopes: ["mcp.read", "mcp.write"],
    mintedKeys: 1,
    activeKeys: 1,
    lastUsedAt: ago(0),
    people: [{ id: "u1", name: "Antoine", email: "a@x", active: true }],
    ...over,
  };
}

describe("via + hrefs", () => {
  it("parses only the three models", () => {
    expect(parseVia("key")).toBe("key");
    expect(parseVia("sign-in")).toBe("sign-in");
    expect(parseVia("mcp")).toBe("mcp");
    expect(parseVia("origins")).toBeNull();
    expect(parseVia(null)).toBeNull();
  });

  it("namespaces each model's id under its own segment", () => {
    expect(appHref("key", "app_1")).toBe("/applications/key/app_1");
    expect(appHref("mcp", "dcr_a/b")).toBe("/applications/mcp/dcr_a%2Fb");
  });

  it("reads a publisher host, dropping www", () => {
    expect(hostOf("https://www.acme.com/x")).toBe("acme.com");
    expect(hostOf("nope")).toBeNull();
  });
});

describe("key apps", () => {
  it("a live app names its owner, its reach and reads Connected", () => {
    const row = keyAppRow(keyApp(), NOW);
    expect(row).toMatchObject({
      via: "key",
      who: "Antoine",
      state: "ready",
      status: { kind: "healthy", label: "Connected" },
      href: "/applications/key/app_1",
    });
    expect(row.reach).toMatch(/Sales/);
  });

  it("an app asking for access says what it wants, in the space's name", () => {
    const row = keyAppRow(
      keyApp({
        grants: [],
        keys: [],
        pending_request: {
          proposal_id: "p1",
          requested_at: ago(0),
          requests: [
            { permission: "entity.person.create", workspaceId: SALES },
          ],
        },
      }),
      NOW
    );
    expect(row.state).toBe("asking");
    expect(row.status.kind).toBe("stale");
    expect(row.reach).toMatch(/^Wants to /);
    expect(row.reach).toMatch(/Sales/);
  });

  it("a revoked app is ended, grey", () => {
    const row = keyAppRow(keyApp({ revoked_at: ago(1), grants: [] }), NOW);
    expect(row.state).toBe("revoked");
    expect(row.status.kind).toBe("unknown");
  });
});

describe("sign in with your pod", () => {
  it("approved is live; untouched for a month is quiet; pending asks; the rest ended", () => {
    expect(signInState(signIn(), NOW)).toBe("ready");
    expect(signInState(signIn({ lastUsedAt: ago(45) }), NOW)).toBe("quiet");
    expect(signInState(signIn({ lastUsedAt: null }), NOW)).toBe("ready");
    expect(signInState(signIn({ status: "pending" }), NOW)).toBe("asking");
    expect(signInState(signIn({ status: "revoked" }), NOW)).toBe("revoked");
    expect(signInState(signIn({ status: "rejected" }), NOW)).toBe("revoked");
  });

  it("counts people and names the publisher", () => {
    const row = signInRow(signIn(), NOW);
    expect(row).toMatchObject({
      who: "12 people",
      publisher: "synap.live",
      href: "/applications/sign-in/c0ffee00-0000-4000-8000-000000000001",
    });
    expect(signInRow(signIn({ peopleCount: 0 }), NOW).who).toBe("No one yet");
  });
});

describe("claude / mcp", () => {
  it("live with a key, ended once every key is revoked, setting up before any", () => {
    expect(mcpState(client(), NOW)).toBe("ready");
    expect(mcpState(client({ activeKeys: 0 }), NOW)).toBe("revoked");
    expect(mcpState(client({ activeKeys: 0, mintedKeys: 0 }), NOW)).toBe(
      "setting_up"
    );
  });

  it("names the one person, or counts the live ones", () => {
    expect(mcpRow(client(), NOW).who).toBe("Antoine");
    const two = client({
      people: [
        { id: "u1", name: "A", email: null, active: true },
        { id: "u2", name: "B", email: null, active: true },
        { id: "u3", name: "C", email: null, active: false },
      ],
    });
    expect(mcpRow(two, NOW).who).toBe("2 people");
  });

  it("words reach from the granted scopes", () => {
    expect(mcpReach(["mcp.read"])).toBe("Reads as the person who connected it");
    expect(mcpReach(["mcp:write"])).toBe(
      "Reads and writes as the person who connected it"
    );
  });
});

describe("the list", () => {
  it("live first by last use, then waiting, then ended; counts per model", () => {
    const rows = buildInventory(
      {
        keyApps: [
          keyApp({ revoked_at: ago(1), grants: [], name: "Old" }),
          keyApp({ public_id: "app_2", name: "Recent" }),
        ],
        signIns: [signIn({ status: "pending", displayName: "Waiting" })],
        clients: [client({ lastUsedAt: ago(2), clientName: "Claude" })],
      },
      NOW
    );
    expect(rows.map((r) => r.name)).toEqual([
      "Recent",
      "Claude",
      "Waiting",
      "Old",
    ]);
    expect(countByVia(rows)).toEqual({ key: 2, "sign-in": 1, mcp: 1 });
    expect(headline(rows)).toBe("2 active · 2 people use them");
    expect(headline([])).toBeNull();
  });

  it("the waiting banner names each request and its model", () => {
    expect(
      pendingSummary({
        keyApps: [
          keyApp({
            name: "Acme CRM",
            pending_request: {
              proposal_id: "p",
              requests: [],
              requested_at: ago(0),
            },
          }),
          keyApp({ name: "Live" }),
        ],
        requests: [
          { displayName: "Notion importer", status: "pending" },
          { displayName: "Done", status: "completed" },
        ],
      })
    ).toEqual({
      count: 2,
      line: "Acme CRM wants a key · Notion importer asks to sign in with your pod.",
    });
    expect(pendingSummary({ keyApps: [], requests: [] })).toBeNull();
  });
});
