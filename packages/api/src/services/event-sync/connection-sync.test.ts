/**
 * Connection sync door — phase switch, cursor resume, and the sync-origin write.
 *
 * SEAM: recorded capability-verb RESULTS (the shape each nango-google verb's
 * responseShape produces) → the REAL kind handlers → the REAL mappers + graph
 * merge → the REAL operation builder / upsert loop. Only the edges are faked:
 * the capability door, the tool-row state store (an in-memory jsonb stand-in),
 * the proposal filer, the entity/relation writers, the event bus, and the
 * connection rule (`resolveConnectionSyncDecision`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  sync: { enabled: true, kinds: {} as Record<string, unknown> },
  state: {} as Record<string, Record<string, unknown>>,
  executeCapability: vi.fn(),
  submit: vi.fn(),
  decision: vi.fn(),
  upsert: vi.fn(),
  relCreate: vi.fn(),
  emit: vi.fn(),
  send: vi.fn(),
  notify: vi.fn(),
  proposalStatus: vi.fn(),
  register: vi.fn(),
  entityRows: [] as unknown[],
  toolRows: [] as unknown[],
  connections: [] as Array<{ id: string; userId: string }>,
  owned: new Set<string>(),
  findApproved: vi.fn(),
  lookup: vi.fn(),
  record: vi.fn(),
  dbUpdate: vi.fn(),
}));

vi.mock("../../utils/domain-mutation.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../utils/domain-mutation.js")>();
  return { ...actual, recordDomainMutation: h.record };
});

vi.mock("./sync-state-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sync-state-store.js")>();
  const metadataFor = (kind: string, connectionId: string) => ({
    sync: {
      ...h.sync,
      kinds: {
        ...h.sync.kinds,
        [kind]: {
          ...((h.sync.kinds[kind] as object) ?? {}),
          connections: { [connectionId]: h.state[kind] ?? {} },
        },
      },
    },
  });
  return {
    ...actual,
    resolveSyncTool: vi.fn(async () => ({
      id: "tool-1",
      createdBy: "creator",
      workspaceId: "ws-1",
      metadata: { sync: h.sync },
    })),
    resolveSyncConnections: vi.fn(async () => h.connections),
    readOwnedConnectionIds: vi.fn(async () => h.owned),
    findApprovedConnectionImport: h.findApproved,
    acquireLease: vi.fn(async (key: { kind: string; connectionId: string }) => {
      const held = h.state[key.kind]?.leaseUntil as string | null | undefined;
      if (held && Date.parse(held) > Date.now()) return null;
      h.state[key.kind] = {
        ...(h.state[key.kind] ?? {}),
        leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      };
      return metadataFor(key.kind, key.connectionId);
    }),
    patchKindState: vi.fn(
      async (key: { kind: string }, patch: Record<string, unknown>) => {
        h.state[key.kind] = { ...(h.state[key.kind] ?? {}), ...patch };
      }
    ),
    proposalStatus: h.proposalStatus,
  };
});

vi.mock("../capabilities/execute-capability.js", () => ({
  executeCapability: h.executeCapability,
}));

vi.mock("../connector-import-bridge.js", () => ({
  submitSyncGraphToImport: h.submit,
}));

vi.mock("../../utils/entity-link-idempotency.js", () => ({
  makeExternalLinkIdempotency: () => ({
    namespace: "connection-sync",
    provider: "google",
    lookup: (provider: string, externalId: string) =>
      h.lookup(provider, externalId),
    register: h.register,
    relationExists: async () => false,
  }),
}));

vi.mock(
  "../connection-health/notify-connector-unhealthy.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../connection-health/notify-connector-unhealthy.js")
      >();
    return { ...actual, notifyConnectorUnhealthy: h.notify };
  }
);

vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/events")>();
  return {
    ...actual,
    emitSideEffects: h.emit,
    getBoss: () => ({ send: h.send }),
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        entities: { findMany: async () => h.entityRows },
        tools: { findMany: async () => h.toolRows },
      },
      // The event kind refreshes a matched event's times through db.update.
      update: (...args: unknown[]) => {
        h.dbUpdate(...args);
        return { set: () => ({ where: async () => undefined }) };
      },
    },
    getDb: async () => ({}),
    resolveIdentity: async () => ({ match: null }),
    resolveConnectionSyncDecision: h.decision,
    EntityUpsertService: class {
      upsert = h.upsert;
    },
    RelationRepository: class {
      create = h.relCreate;
    },
  };
});

import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  runConnectionSync,
  enqueueConnectionSync,
  getConnectionSyncStatus,
  CONNECTION_SYNC_QUEUE,
} from "./connection-sync.js";
import { materializeCompositeGraph } from "../../utils/materialize-composite.js";
import { ProposalStatus } from "@synap/database/schema";

// ── Recorded verb results (post-responseShape) ─────────────────────────────────

const CAL_PAGE_1 = {
  calendarId: "primary",
  count: 1,
  nextPageToken: "cal-p2",
  events: [
    {
      id: "ev1",
      status: "confirmed",
      summary: "Acme sync",
      start: { dateTime: "2026-09-01T10:00:00Z" },
      end: { dateTime: "2026-09-01T10:30:00Z" },
      htmlLink: "https://www.google.com/calendar/event?eid=ZXYx",
      attendees: [
        { email: "jelle@acme-corp.io", displayName: "Jelle Bets" },
        { email: "me@perso.me", self: true },
      ],
    },
  ],
};
const CAL_PAGE_2 = {
  calendarId: "primary",
  count: 1,
  nextPageToken: null,
  events: [
    {
      id: "ev2",
      summary: "Acme follow-up",
      start: { dateTime: "2026-09-08T10:00:00Z" },
      htmlLink: "https://www.google.com/calendar/event?eid=ZXYy",
      attendees: [{ email: "jelle@acme-corp.io" }],
    },
  ],
};
const GMAIL_PAGE = {
  query: "newer_than:90d",
  count: 1,
  nextPageToken: null,
  threads: [
    {
      id: "18f2a1b3c4d5e6f7",
      snippet: "see you",
      messages: [
        {
          id: "m1",
          internalDate: "1784000000000",
          labelIds: ["INBOX"],
          headers: [
            { name: "From", value: "Ana Lima <ana@acme-corp.io>" },
            { name: "To", value: "me@perso.me" },
          ],
        },
        {
          id: "m2",
          internalDate: "1784000500000",
          labelIds: ["SENT"],
          headers: [
            { name: "From", value: "me@perso.me" },
            { name: "To", value: "ana@acme-corp.io" },
          ],
        },
      ],
    },
  ],
};
const CONTACTS_PAGE = {
  count: 1,
  nextPageToken: null,
  contacts: [
    {
      resourceName: "people/c1",
      names: [{ displayName: "Jelle Bets" }],
      emailAddresses: [{ value: "jelle@acme-corp.io" }],
      phoneNumbers: [{ value: "+33612345678" }],
    },
  ],
};

function run(result: unknown) {
  return { kind: "run", skillId: "s", result, ackState: "applied" };
}

function scriptVerbs(
  overrides: Partial<
    Record<string, (p: Record<string, unknown>) => unknown>
  > = {}
) {
  h.executeCapability.mockImplementation(
    async ({
      verbId,
      parameters,
    }: {
      verbId: string;
      parameters: Record<string, unknown>;
    }) => {
      if (overrides[verbId]) return overrides[verbId]!(parameters);
      if (verbId === "calendar_list") {
        return run(parameters.pageToken === "cal-p2" ? CAL_PAGE_2 : CAL_PAGE_1);
      }
      if (verbId === "gmail_list_threads") return run(GMAIL_PAGE);
      if (verbId === "contacts_list") return run(CONTACTS_PAGE);
      throw new Error(`unscripted verb ${verbId}`);
    }
  );
}

function callsOf(verbId: string): Record<string, unknown>[] {
  return h.executeCapability.mock.calls
    .map((c) => c[0] as { verbId: string; parameters: Record<string, unknown> })
    .filter((c) => c.verbId === verbId)
    .map((c) => c.parameters);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.sync = { enabled: true, kinds: {} };
  h.state = {};
  h.submit.mockResolvedValue({ proposalId: "prop-1", deduplicated: false });
  h.upsert.mockImplementation(
    async (input: { source: string; externalId: string }) => ({
      entity: { id: `id:${input.source}:${input.externalId}` },
      action: "created",
    })
  );
  h.relCreate.mockResolvedValue({ id: "rel" });
  h.entityRows = [];
  h.toolRows = [];
  h.connections = [{ id: "conn-1", userId: "u1" }];
  h.owned = new Set();
  h.lookup.mockResolvedValue(null);
  h.decision.mockResolvedValue({ verdict: "propose", source: "none" });
  h.findApproved.mockResolvedValue(null);
  scriptVerbs();
});

describe("first import approved → steady run: no duplicates", () => {
  it("lands ZERO new entities for records the approved import created, and links carry url", async () => {
    // ── A tiny model of the pod's identity stores, shared by the fakes ─────────
    const links = new Map<string, string>(); // "provider:externalId" → entityId
    const signals = new Map<string, string>(); // "type:value" → entityId
    const linkUrls = new Map<string, string | null>();
    const linkConnections = new Map<string, string | null>();
    h.lookup.mockImplementation(
      async (p: string, x: string) => links.get(`${p}:${x}`) ?? null
    );
    h.register.mockImplementation(async (id: string, p: string, x: string) => {
      if (!links.has(`${p}:${x}`)) links.set(`${p}:${x}`, id);
    });
    let nextId = 0;
    // EntityUpsertService's contract: exact external link → strong signal → create.
    h.upsert.mockImplementation(
      async (input: {
        source: string;
        externalId: string;
        url?: string | null;
        signals: Array<{ type: string; value: string }>;
      }) => {
        const key = `${input.source}:${input.externalId}`;
        const linked = links.get(key);
        if (linked) {
          if (input.url) linkUrls.set(key, input.url);
          return { entity: { id: linked }, action: "updated" };
        }
        for (const s of input.signals) {
          const hit = signals.get(`${s.type}:${s.value.toLowerCase()}`);
          if (hit) {
            links.set(key, hit);
            linkUrls.set(key, input.url ?? null);
            return { entity: { id: hit }, action: "matched" };
          }
        }
        const id = `new-${nextId++}`;
        links.set(key, id);
        return { entity: { id }, action: "created" };
      }
    );

    // ── 1. First run → the grouped proposal ────────────────────────────────────
    await runConnectionSync({ provider: "google", reason: "connect" });
    const ops = h.submit.mock.calls[0]![0].operations as Array<{
      op: string;
      ref?: string;
      profileSlug?: string;
      title?: string;
      properties?: Record<string, unknown>;
    }>;

    // ── 2. Approval: the REAL composite materializer, called as apply-approval
    //       calls it — entities.create per op (registers strong signals) plus the
    //       proposal's link door, which also registers each op's externalLinks.
    const approvedEvents: unknown[] = [];
    const entityCaller = {
      create: vi.fn(
        async (input: {
          profileSlug: string;
          title?: string;
          properties?: Record<string, unknown>;
        }) => {
          const p = input.properties ?? {};
          const key =
            (typeof p.googleEventId === "string" && p.googleEventId) ||
            (typeof p.email === "string" && p.email) ||
            (typeof p.website === "string" &&
              p.website.replace(/^https?:\/\//, "")) ||
            input.title;
          const id = `approved:${input.profileSlug}:${key}`;
          if (typeof p.email === "string")
            signals.set(`email:${p.email.toLowerCase()}`, id);
          if (typeof p.website === "string")
            signals.set(`website:${p.website.toLowerCase()}`, id);
          if (typeof p.phone === "string")
            signals.set(`phone:${p.phone.toLowerCase()}`, id);
          if (input.profileSlug === "event") {
            const changedSinceImport = p.googleEventId === "ev2";
            approvedEvents.push({
              id,
              // ev2 was RENAMED and MOVED in Google after the import. The fake
              // findMany cannot evaluate the SQL hour bucket, so the title must
              // differ too — otherwise the title fallback would adopt it.
              title: changedSinceImport
                ? "Old title before rename"
                : input.title,
              properties: changedSinceImport
                ? {
                    ...p,
                    title: "Old title before rename",
                    startDate: "2026-10-20T15:00:00Z",
                  }
                : p,
            });
          }
          return { id };
        }
      ),
    };
    const approvalDoor = {
      namespace: "u1:prop-1",
      provider: "import",
      lookup: async () => null,
      register: async (
        id: string,
        p: string,
        x: string,
        link?: { url?: string | null; connectionId?: string | null }
      ) => {
        const key = `${p}:${x}`;
        if (!links.has(key)) links.set(key, id);
        if (link) {
          linkUrls.set(key, link.url ?? null);
          linkConnections.set(key, link.connectionId ?? null);
        }
      },
      relationExists: async () => false,
    };
    await materializeCompositeGraph(
      ops as CompositeProposalOperation[],
      entityCaller,
      { create: async () => ({ id: "rel" }) },
      undefined,
      { idempotency: approvalDoor }
    );
    expect(approvedEvents).toHaveLength(2);
    h.entityRows = approvedEvents;

    // Provider links + url + connection stamp exist RIGHT AFTER approval —
    // before any steady run (Places can open the event immediately).
    expect(links.get("google:ev1")).toBe("approved:event:ev1");
    expect(linkUrls.get("google:ev1")).toBe(
      "https://www.google.com/calendar/event?eid=ZXYx"
    );
    expect(linkConnections.get("google:ev1")).toBe("conn-1");
    expect(links.get("google:ev2")).toBe("approved:event:ev2");
    expect(links.get("google:people/c1")).toBe(
      "approved:person:jelle@acme-corp.io"
    );
    expect(linkConnections.get("google:people/c1")).toBe("conn-1");

    // ── 3. Steady run under the minted rule, same Google ids ───────────────────
    for (const kind of ["event", "email.thread", "contact"]) {
      h.state[kind] = {
        phase: "review_ready",
        proposalId: "prop-1",
        cursor: "2026-09-10T00:00:00.000Z",
      };
    }
    h.proposalStatus.mockResolvedValue("approved");
    h.decision.mockResolvedValue({
      verdict: "auto",
      source: "rule",
      ruleId: "r1",
    });
    h.upsert.mockClear();
    const res = await runConnectionSync({ provider: "google" });

    const kinds = res.connections![0]!.kinds;
    for (const kind of ["event", "email.thread", "contact"]) {
      expect(
        kinds[kind],
        `${kind}: ${JSON.stringify(kinds[kind])}`
      ).toMatchObject({ phase: "synced", counts: { created: 0 } });
    }
    expect(h.upsert).toHaveBeenCalled();
    expect(links.get("google:ev1")).toBe("approved:event:ev1");
    expect(links.get("google:ev2")).toBe("approved:event:ev2");
    expect(linkUrls.get("google:ev1")).toBe(
      "https://www.google.com/calendar/event?eid=ZXYx"
    );
    expect(linkUrls.get("google:ev2")).toBe(
      "https://www.google.com/calendar/event?eid=ZXYy"
    );
    expect(links.get("email:jelle@acme-corp.io")).toBe(
      "approved:person:jelle@acme-corp.io"
    );
    expect(links.get("google:people/c1")).toBe(
      "approved:person:jelle@acme-corp.io"
    );
    expect(links.get("domain:acme-corp.io")).toBe(
      "approved:company:acme-corp.io"
    );
  });
});

describe("steady run after an approved first import", () => {
  const CURSOR = "2026-09-10T00:00:00.000Z";
  beforeEach(() => {
    h.sync.kinds = {
      "email.thread": { enabled: false },
      contact: { enabled: false },
    };
  });

  it("with no connection rule, proposes — the steady run never mints a rule itself", async () => {
    h.state.event = {
      phase: "review_ready",
      proposalId: "11111111-1111-4111-8111-111111111111",
      cursor: CURSOR,
    };
    h.proposalStatus.mockResolvedValue("approved");
    h.decision.mockResolvedValue({ verdict: "propose", source: "none" });

    await runConnectionSync({ provider: "google" });

    // Exactly one connection-level read; no re-resolve loop behind it.
    expect(
      h.decision.mock.calls.filter(
        (c) => (c[0] as { action?: string }).action === undefined
      )
    ).toHaveLength(1);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it("adopts an event the approved import created (googleEventId, no link) even after it moved", async () => {
    h.state.event = { phase: "synced", cursor: CURSOR };
    h.decision.mockResolvedValue({ verdict: "auto", source: "rule" });
    // Created by the first-run approval: renamed and moved since — no title/hour match.
    h.entityRows = [
      {
        id: "existing-ev1",
        title: "Renamed meeting",
        properties: { googleEventId: "ev1", startDate: "2026-01-01T08:00:00Z" },
      },
    ];
    await runConnectionSync({ provider: "google" });
    expect(h.register).toHaveBeenCalledWith("existing-ev1", "google", "ev1");
    expect(h.register).not.toHaveBeenCalledWith(
      "existing-ev1",
      "google",
      "ev2"
    );
  });
});

describe("getConnectionSyncStatus", () => {
  it("names the profiles each kind writes and the ones that open in the source app", async () => {
    h.toolRows = [
      {
        name: "google",
        workspaceId: "ws-1",
        metadata: {
          sync: {
            enabled: true,
            kinds: {
              event: {
                connections: {
                  "conn-1": {
                    phase: "synced",
                    lastRunAt: "2026-09-12T00:00:00.000Z",
                  },
                },
              },
            },
          },
        },
      },
    ];
    const rows = await getConnectionSyncStatus({ provider: "google" });
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          provider: "google",
          workspaceId: "ws-1",
          kind: "event",
          connectionId: "conn-1",
          enabled: true,
          phase: "synced",
          lastRunAt: "2026-09-12T00:00:00.000Z",
          profileSlugs: ["event", "person", "company"],
          openableProfileSlugs: ["event"],
          keepSyncing: { enabled: false, available: false },
        },
        {
          provider: "google",
          workspaceId: "ws-1",
          kind: "email.thread",
          connectionId: "conn-1",
          enabled: true,
          profileSlugs: ["person", "company"],
          openableProfileSlugs: [],
          keepSyncing: { enabled: false, available: false },
        },
      ])
    );
  });

  it("reports a sync-enabled row with no live connection as not_connected per kind — no failure, no error", async () => {
    h.connections = [];
    h.toolRows = [
      {
        id: "tool-1",
        name: "google",
        metadata: { sync: { enabled: true, kinds: {} } },
      },
    ];
    const rows = await getConnectionSyncStatus({ provider: "google" });
    expect(rows.map((r) => [r.kind, r.phase, r.error, r.connectionId])).toEqual(
      [
        ["event", "not_connected", undefined, undefined],
        ["email.thread", "not_connected", undefined, undefined],
        ["contact", "not_connected", undefined, undefined],
      ]
    );
    // A pod-wide tool row (no workspace) reports null, never undefined.
    expect(rows.every((r) => r.workspaceId === null)).toBe(true);
  });
});

describe("first run of a connection → ONE grouped import proposal", () => {
  it("reads every kind, merges them, and files exactly one proposal", async () => {
    const res = await runConnectionSync({
      provider: "google",
      reason: "connect",
    });

    expect(h.submit).toHaveBeenCalledTimes(1);
    const input = h.submit.mock.calls[0]![0];
    expect(input.connectionSync).toEqual({
      connectionId: "conn-1",
      provider: "google",
      kinds: ["event", "email.thread", "contact"],
      keepSyncing: true,
    });
    expect(input.userId).toBe("u1");
    expect(input.workspaceId).toBe("ws-1");
    expect(h.upsert).not.toHaveBeenCalled();

    const entityOps = input.operations.filter(
      (o: { op: string }) => o.op === "create_entity"
    );
    expect(entityOps.map((o: { ref: string }) => o.ref).sort()).toEqual([
      "company:acme-corp.io",
      "event:ev1",
      "event:ev2",
      "person:ana@acme-corp.io",
      "person:jelle@acme-corp.io",
    ]);
    // The same person from an event, a second event, and a contact is ONE op,
    // carrying the contact's phone.
    const jelle = entityOps.find(
      (o: { ref: string }) => o.ref === "person:jelle@acme-corp.io"
    );
    expect(jelle.properties).toMatchObject({
      email: "jelle@acme-corp.io",
      phone: "+33612345678",
      googleContactId: "people/c1",
    });
    expect(input.operations).toEqual(
      expect.arrayContaining([
        {
          op: "create_relation",
          type: "attended_by",
          sourceRef: "event:ev1",
          targetRef: "person:jelle@acme-corp.io",
        },
        {
          op: "create_relation",
          type: "attended_by",
          sourceRef: "event:ev2",
          targetRef: "person:jelle@acme-corp.io",
        },
        {
          op: "create_relation",
          type: "works_at",
          sourceRef: "person:ana@acme-corp.io",
          targetRef: "company:acme-corp.io",
        },
      ])
    );

    expect(res.connections?.[0]?.kinds.event).toMatchObject({
      phase: "review_ready",
      proposalId: "prop-1",
      counts: { fetched: 2 },
    });
  });

  it("pages within the bound and reads as the connection owner, pinned to the connection", async () => {
    await runConnectionSync({ provider: "google" });
    const cal = callsOf("calendar_list");
    expect(cal).toHaveLength(2);
    expect(cal[0]).not.toHaveProperty("updatedMin");
    expect(cal[0]).toHaveProperty("timeMin");
    expect(cal[1]!.pageToken).toBe("cal-p2");
    expect(callsOf("gmail_list_threads")[0]!.query).toBe("newer_than:90d");
    const first = h.executeCapability.mock.calls[0]![0];
    expect(first.userId).toBe("u1");
    expect(first.connectionSelector).toEqual({ connectionId: "conn-1" });
  });

  it("stops at itemLimit", async () => {
    h.sync.kinds = {
      event: { itemLimit: 1 },
      "email.thread": { enabled: false },
      contact: { enabled: false },
    };
    const res = await runConnectionSync({ provider: "google" });
    expect(callsOf("calendar_list")).toHaveLength(1);
    expect(res.connections?.[0]?.kinds.event).toMatchObject({
      counts: { fetched: 1 },
    });
  });

  it("stamps review_ready + cursor on every kind and emits sync-origin progress", async () => {
    await runConnectionSync({ provider: "google" });
    for (const kind of ["event", "email.thread", "contact"]) {
      expect(h.state[kind]).toMatchObject({
        phase: "review_ready",
        proposalId: "prop-1",
        leaseUntil: null,
      });
      expect(typeof h.state[kind]!.cursor).toBe("string");
    }
    expect(h.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "connection_sync",
        action: "progress",
        subjectId: "conn-1",
        origin: "sync",
        data: expect.objectContaining({
          kind: "event",
          phase: "review_ready",
          proposalId: "prop-1",
        }),
      })
    );
  });
});

describe("while the first proposal is pending", () => {
  it("does not read or file again", async () => {
    for (const kind of ["event", "email.thread", "contact"]) {
      h.state[kind] = {
        phase: "review_ready",
        proposalId: "prop-1",
        cursor: "2026-09-01T00:00:00.000Z",
      };
    }
    h.proposalStatus.mockResolvedValue("pending");
    const res = await runConnectionSync({ provider: "google" });
    expect(h.executeCapability).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(res.connections?.[0]?.kinds.event).toEqual({
      skipped: true,
      reason: "awaiting_review",
      proposalId: "prop-1",
    });
    expect(h.state.event!.leaseUntil).toBeNull();
  });
});

describe("steady run under an auto rule", () => {
  const CURSOR = "2026-09-10T00:00:00.000Z";
  beforeEach(() => {
    h.sync.kinds = {
      "email.thread": { enabled: false },
      contact: { enabled: false },
    };
    h.state.event = { phase: "synced", cursor: CURSOR };
    h.decision.mockResolvedValue({
      verdict: "auto",
      source: "rule",
      ruleId: "r1",
    });
  });

  it("upserts through EntityUpsertService with identity, url and signals — no proposal", async () => {
    await runConnectionSync({ provider: "google" });

    expect(h.decision).toHaveBeenCalledWith({
      userId: "u1",
      workspaceId: "ws-1",
      connectionId: "conn-1",
    });
    expect(h.submit).not.toHaveBeenCalled();
    expect(callsOf("calendar_list")[0]!.updatedMin).toBe(CURSOR);

    expect(h.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        profileSlug: "event",
        source: "google",
        externalId: "ev1",
        url: "https://www.google.com/calendar/event?eid=ZXYx",
        connectionId: "conn-1",
        userId: "u1",
        workspaceId: "ws-1",
        provenance: { createdByKind: "system", createdByUserId: "u1" },
      })
    );
    expect(h.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        profileSlug: "person",
        source: "email",
        externalId: "jelle@acme-corp.io",
        signals: expect.arrayContaining([
          { type: "email", value: "jelle@acme-corp.io" },
        ]),
      })
    );
    expect(h.relCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEntityId: "id:google:ev1",
        targetEntityId: "id:email:jelle@acme-corp.io",
        type: "attended_by",
        userId: "u1",
      }),
      "u1"
    );
  });

  it("records every write through recordDomainMutation with origin:'sync' (event log + fan-out)", async () => {
    await runConnectionSync({ provider: "google" });
    expect(h.record).toHaveBeenCalledWith({
      subjectType: "entity",
      action: "create",
      subjectId: "id:google:ev1",
      userId: "u1",
      workspaceId: "ws-1",
      source: "connection_sync",
      data: { profileSlug: "event", source: "google" },
      origin: "sync",
    });
    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "relation",
        action: "create",
        origin: "sync",
      })
    );
    // No bare fan-out for a write — progress events are the only direct emits.
    expect(
      h.emit.mock.calls.filter(
        (c) =>
          (c[0] as { subjectType: string }).subjectType !== "connection_sync"
      )
    ).toEqual([]);
  });

  it("gates each write on ITS action: a refresh the rule does not auto-approve is not written", async () => {
    h.decision.mockImplementation(
      async (input: { subjectType?: string; action?: string }) =>
        input.subjectType === "entity" && input.action === "update"
          ? {
              verdict: "propose",
              source: "rule",
              ruleId: "r1",
              reason: "floor",
            }
          : { verdict: "auto", source: "rule", ruleId: "r1" }
    );
    // ev1 already exists (created by the approved import) → a matched event.
    h.entityRows = [
      {
        id: "existing-ev1",
        title: "Acme sync",
        properties: { googleEventId: "ev1", startDate: "2026-09-01T10:00:00Z" },
      },
    ];
    h.upsert.mockImplementation(
      async (input: { source: string; externalId: string }) =>
        input.externalId === "ev1"
          ? { entity: { id: "existing-ev1" }, action: "updated" }
          : {
              entity: { id: `id:${input.source}:${input.externalId}` },
              action: "created",
            }
    );

    const res = await runConnectionSync({ provider: "google" });

    expect(h.decision).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "entity",
        action: "update",
        connectionId: "conn-1",
      })
    );
    expect(h.dbUpdate).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "update" })
    );
    expect(res.connections?.[0]?.kinds.event).toMatchObject({
      phase: "synced",
    });
    expect(
      (res.connections![0]!.kinds.event as { counts: { skipped: number } })
        .counts.skipped
    ).toBeGreaterThanOrEqual(1);
  });

  it("a CREATE the rule does not auto-approve is filed for review, never written", async () => {
    h.decision.mockImplementation(
      async (input: { subjectType?: string; action?: string }) =>
        input.subjectType === "entity" && input.action === "create"
          ? {
              verdict: "propose",
              source: "rule",
              ruleId: "r1",
              reason: "floor",
            }
          : { verdict: "auto", source: "rule", ruleId: "r1" }
    );

    const res = await runConnectionSync({ provider: "google" });

    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.relCreate).not.toHaveBeenCalled();
    expect(h.submit).toHaveBeenCalled();
    const input = h.submit.mock.calls[0]![0];
    expect(input.connectionSync).toMatchObject({
      kinds: ["event"],
      keepSyncing: false,
    });
    expect(
      input.operations
        .filter((o: { op: string }) => o.op === "create_entity")
        .map((o: { ref: string }) => o.ref)
    ).toEqual(
      expect.arrayContaining(["event:ev1", "person:jelle@acme-corp.io"])
    );
    expect(res.connections?.[0]?.kinds.event).toMatchObject({
      phase: "review_ready",
      proposalId: "prop-1",
    });
  });

  it("completes with a new cursor and no pending page", async () => {
    await runConnectionSync({ provider: "google" });
    expect(h.state.event).toMatchObject({
      phase: "synced",
      pageToken: null,
      leaseUntil: null,
    });
    expect(h.state.event!.cursor).not.toBe(CURSOR);
  });

  it("RESUMES an interrupted run from its checkpointed page and keeps its window", async () => {
    const STARTED = "2026-09-12T08:00:00.000Z";
    h.state.event = {
      phase: "failed",
      cursor: CURSOR,
      runStartedAt: STARTED,
      pageToken: JSON.stringify({ calendar: 0, token: "cal-p2" }),
      counts: { fetched: 1, created: 3, merged: 0, skipped: 0 },
    };
    await runConnectionSync({ provider: "google" });
    const cal = callsOf("calendar_list");
    expect(cal).toHaveLength(1);
    expect(cal[0]!.pageToken).toBe("cal-p2");
    expect(cal[0]!.updatedMin).toBe(CURSOR);
    expect(h.state.event).toMatchObject({
      phase: "synced",
      cursor: STARTED,
      counts: { fetched: 2 },
    });
  });

  it("a mid-run failure records the error and checkpoints the next page", async () => {
    scriptVerbs({
      calendar_list: (p) =>
        p.pageToken === "cal-p2"
          ? {
              kind: "error",
              message: "invalid_grant: Token has been expired or revoked.",
            }
          : run(CAL_PAGE_1),
    });
    const res = await runConnectionSync({ provider: "google" });
    expect(res.connections?.[0]?.kinds.event).toMatchObject({
      phase: "failed",
      error: "invalid_grant: Token has been expired or revoked.",
    });
    expect(h.state.event).toMatchObject({
      phase: "failed",
      cursor: CURSOR,
      pageToken: JSON.stringify({ calendar: 0, token: "cal-p2" }),
      leaseUntil: null,
    });
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({ connectorKey: "google", userId: "u1" })
    );
  });
});

describe("steady run with no auto rule", () => {
  it("files a grouped proposal that does NOT re-arm keepSyncing", async () => {
    h.sync.kinds = {
      "email.thread": { enabled: false },
      contact: { enabled: false },
    };
    h.state.event = { phase: "synced", cursor: "2026-09-10T00:00:00.000Z" };
    h.decision.mockResolvedValue({ verdict: "propose", source: "none" });
    await runConnectionSync({ provider: "google" });
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0]![0].connectionSync).toEqual({
      connectionId: "conn-1",
      provider: "google",
      kinds: ["event"],
      keepSyncing: false,
    });
  });
});

describe("enqueueConnectionSync", () => {
  it("sends one debounced job per provider + connection", async () => {
    await enqueueConnectionSync({
      provider: "google",
      connectionId: "conn-1",
      reason: "webhook",
    });
    expect(h.send).toHaveBeenCalledWith(
      "connection-sync-run",
      { provider: "google", connectionId: "conn-1", reason: "webhook" },
      { singletonKey: "google:conn-1", singletonSeconds: 30 }
    );
  });

  it("names the SAME queue the jobs worker creates", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const worker = readFileSync(
      join(
        here,
        "..",
        "..",
        "..",
        "..",
        "jobs",
        "src",
        "workers",
        "connection-sync-run.ts"
      ),
      "utf8"
    );
    const m = worker.match(
      /export const CONNECTION_SYNC_RUN_QUEUE = "([^"]+)"/
    );
    expect(
      m,
      "jobs worker queue constant not found — the scan broke"
    ).not.toBeNull();
    expect(CONNECTION_SYNC_QUEUE).toBe(m![1]);
  });

  it("persists `fetching` per enabled kind at enqueue, keeping a kind held on a pending review", async () => {
    h.send.mockResolvedValue("job-1");
    const held = { phase: "review_ready", proposalId: "prop-9" };
    h.sync.kinds = {
      event: { connections: { "conn-1": held } },
      contact: { enabled: false },
    };
    h.state.event = { ...held };
    h.state["email.thread"] = { phase: "failed", error: "old" };
    h.proposalStatus.mockResolvedValue(ProposalStatus.PENDING);

    await enqueueConnectionSync({
      provider: "google",
      connectionId: "conn-1",
      reason: "connect",
    });

    expect(h.state["email.thread"]).toMatchObject({
      phase: "fetching",
      error: null,
    });
    expect(h.state.event).toEqual(held);
    expect(h.state.contact).toBeUndefined();
  });

  it("a deduped send (the window already holds a job) marks nothing", async () => {
    h.send.mockResolvedValue(null);
    await enqueueConnectionSync({
      provider: "google",
      connectionId: "conn-1",
      reason: "webhook",
    });
    expect(h.state).toEqual({});
  });
});

describe("getConnectionSyncStatus — userId filter", () => {
  it("keeps the user's own connections and rows naming none; drops another member's connection", async () => {
    h.connections = [
      { id: "conn-1", userId: "u1" },
      { id: "conn-2", userId: "u2" },
    ];
    h.owned = new Set(["conn-1"]);
    h.toolRows = [
      {
        id: "tool-1",
        name: "google",
        workspaceId: "ws-1",
        metadata: { sync: { enabled: true, kinds: {} } },
      },
      { id: "tool-2", name: "google", workspaceId: "ws-2", metadata: {} },
    ];

    const all = await getConnectionSyncStatus({ provider: "google" });
    expect(all.filter((r) => r.connectionId === "conn-2")).toHaveLength(3);

    const mine = await getConnectionSyncStatus({
      provider: "google",
      userId: "u1",
    });
    expect(mine.filter((r) => r.connectionId === "conn-1")).toHaveLength(3);
    expect(mine.some((r) => r.connectionId === "conn-2")).toBe(false);
    expect(
      mine.filter((r) => !r.connectionId).map((r) => r.workspaceId)
    ).toEqual(["ws-2", "ws-2", "ws-2"]);
  });
});

describe("getConnectionSyncStatus — keepSyncing, computed server-side", () => {
  const googleRow = (workspaceId: string | null) => ({
    id: `tool-${workspaceId ?? "pod"}`,
    name: "google",
    workspaceId,
    metadata: { sync: { enabled: true, kinds: {} } },
  });

  it("an auto rule is ON and names the rule — one rule read per connection × scope", async () => {
    h.toolRows = [googleRow("ws-1")];
    h.decision.mockResolvedValue({
      verdict: "auto",
      ruleId: "rule-auto",
      source: "rule",
    });
    const rows = await getConnectionSyncStatus({ provider: "google" });
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.keepSyncing).toEqual({
        enabled: true,
        ruleId: "rule-auto",
        available: false,
      });
    }
    expect(h.decision).toHaveBeenCalledTimes(1);
    expect(h.decision).toHaveBeenCalledWith({
      userId: "u1",
      workspaceId: "ws-1",
      connectionId: "conn-1",
    });
  });

  it("each row asks under ITS workspace: a workspace propose rule outranks a pod auto rule", async () => {
    h.toolRows = [googleRow("ws-1"), googleRow(null)];
    // The precedence itself belongs to the resolver (connection-governance.test.ts);
    // what this pins is that a row resolves under its own scope, not the pod's.
    h.decision.mockImplementation(
      async ({ workspaceId }: { workspaceId: string | null }) =>
        workspaceId === "ws-1"
          ? { verdict: "propose", ruleId: "rule-ws-propose", source: "rule" }
          : { verdict: "auto", ruleId: "rule-pod-auto", source: "rule" }
    );
    const rows = await getConnectionSyncStatus({ provider: "google" });
    const inWorkspace = rows.filter((r) => r.workspaceId === "ws-1");
    const podWide = rows.filter((r) => r.workspaceId === null);
    expect(inWorkspace).toHaveLength(3);
    expect(podWide).toHaveLength(3);
    for (const r of inWorkspace) {
      expect(r.keepSyncing).toEqual({
        enabled: false,
        ruleId: "rule-ws-propose",
        available: false,
      });
    }
    for (const r of podWide) {
      expect(r.keepSyncing).toEqual({
        enabled: true,
        ruleId: "rule-pod-auto",
        available: false,
      });
    }
  });

  it("available only once the connection has an approved first import — one lookup per connection", async () => {
    h.toolRows = [googleRow("ws-1"), googleRow(null)];
    h.findApproved.mockResolvedValue({ id: "prop-approved" });
    const rows = await getConnectionSyncStatus({ provider: "google" });
    expect(rows).toHaveLength(6);
    for (const r of rows)
      expect(r.keepSyncing).toEqual({ enabled: false, available: true });
    expect(h.findApproved).toHaveBeenCalledTimes(1);
    expect(h.findApproved).toHaveBeenCalledWith("conn-1");
  });

  it("no rule is OFF; a row naming no live connection is OFF and unavailable without any read", async () => {
    h.toolRows = [
      googleRow("ws-1"),
      { id: "tool-2", name: "google", workspaceId: "ws-2", metadata: {} },
    ];
    const rows = await getConnectionSyncStatus({ provider: "google" });
    expect(rows).toHaveLength(6);
    for (const r of rows)
      expect(r.keepSyncing).toEqual({ enabled: false, available: false });
    expect(h.decision).toHaveBeenCalledTimes(1);
    expect(h.findApproved).toHaveBeenCalledTimes(1);
  });
});

describe("first-import consent on the proposal the user reviews", () => {
  const CONSENT =
    "Approving also keeps Google syncing automatically. You can turn this off in Settings → Connections.";

  it("the first import's summary says approving keeps Google syncing automatically", async () => {
    await runConnectionSync({ provider: "google", reason: "connect" });
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0]![0].connectionSync.keepSyncing).toBe(true);
    expect(h.submit.mock.calls[0]![0].summary).toContain(CONSENT);
  });

  it("a steady review (keepSyncing false) never claims approval turns automatic syncing on", async () => {
    h.sync.kinds = {
      "email.thread": { enabled: false },
      contact: { enabled: false },
    };
    h.state.event = { phase: "synced", cursor: "2026-09-10T00:00:00.000Z" };
    await runConnectionSync({ provider: "google" });
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0]![0].connectionSync.keepSyncing).toBe(false);
    expect(h.submit.mock.calls[0]![0].summary).not.toContain(
      "syncing automatically"
    );
  });
});

describe("counts.byProfile — what a run found", () => {
  type Tally = Record<string, { created: number; merged: number }>;
  const add = (t: Tally, slug: string, outcome: "created" | "merged") => {
    (t[slug] ??= { created: 0, merged: 0 })[outcome] += 1;
  };

  it("first run: every proposed entity is tallied once under its profile, across kinds", async () => {
    await runConnectionSync({ provider: "google", reason: "connect" });
    const expected: Tally = {};
    for (const o of h.submit.mock.calls[0]![0]
      .operations as CompositeProposalOperation[]) {
      if (o.op === "create_entity") add(expected, o.profileSlug, "created");
    }
    expect(expected.event?.created).toBeGreaterThan(0);
    expect(expected.person?.created).toBeGreaterThan(0);

    const summed: Tally = {};
    for (const state of Object.values(h.state)) {
      const byProfile =
        (state.counts as { byProfile?: Tally } | undefined)?.byProfile ?? {};
      for (const [slug, t] of Object.entries(byProfile)) {
        const into = (summed[slug] ??= { created: 0, merged: 0 });
        into.created += t.created;
        into.merged += t.merged;
      }
    }
    expect(summed).toEqual(expected);
  });

  it("steady auto run: landed entities are tallied by profile, created vs merged", async () => {
    h.sync.kinds = {
      "email.thread": { enabled: false },
      contact: { enabled: false },
    };
    h.state.event = { phase: "synced", cursor: "2026-09-10T00:00:00.000Z" };
    h.decision.mockResolvedValue({ verdict: "auto", source: "rule" });
    const outcomeOf = (slug: string) =>
      slug === "company" ? "merged" : "created";
    h.upsert.mockImplementation(
      async (input: { profileSlug: string; externalId: string }) => ({
        entity: { id: `id:${input.externalId}` },
        action: outcomeOf(input.profileSlug),
      })
    );

    await runConnectionSync({ provider: "google" });

    const expected: Tally = {};
    for (const [input] of h.upsert.mock.calls as Array<
      [{ profileSlug: string }]
    >) {
      add(expected, input.profileSlug, outcomeOf(input.profileSlug));
    }
    expect(expected.event?.created).toBeGreaterThan(0);
    expect(expected.company?.merged).toBeGreaterThan(0);
    expect((h.state.event!.counts as { byProfile?: Tally }).byProfile).toEqual(
      expected
    );
  });
});
