import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tool demand forwarding (D2). The DB layer and the credential read are
 * mocked; `fetch` is stubbed. Asserts the CONTRACT the CP route is built
 * against (`POST /api/demand/tools`, Bearer relay JWT, `{ tools: [{toolKey}] }`
 * and NOTHING else), that only `wanted` demand is read, and that every
 * non-forward is RECORDED with its reason — never silent.
 */

/**
 * A demand row as the DB can hand it back: the key plus arbitrary noise
 * (provider keys, titles). The noise is deliberate — the builder must drop it.
 */
type NoisyRow = { toolKey: unknown } & Record<string, unknown>;

const h = vi.hoisted(() => ({
  demandRows: [] as NoisyRow[],
  credential: null as null | { key: string; expiresAt: Date | null },
  stamps: [] as unknown[],
  demandWhereSql: [] as string[],
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function chain(rows: unknown[]) {
  const q: any = {
    from: () => q,
    where: (cond: unknown) => {
      q.cond = cond;
      return q;
    },
    orderBy: () => q,
    limit: () => q,
    then: (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
  };
  return q;
}

/** Flatten a mocked drizzle tagged template into its literal text + values. */
function render(node: unknown): string {
  if (Array.isArray(node)) return node.map(render).join(" ");
  if (node && typeof node === "object" && "strings" in node) {
    const { strings, values } = node as {
      strings: string[];
      values: unknown[];
    };
    return strings
      .map((s, i) => s + (i < values.length ? render(values[i]) : ""))
      .join("");
  }
  return String(node);
}

vi.mock("@synap/database", () => {
  const drizzleSql: any = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => ({
    strings: [...strings],
    values,
  });
  return {
    drizzleSql,
    and: (...conds: unknown[]) => conds,
    eq: () => "eq",
    isNull: () => "isNull",
    profileSlugScopeCondition: async () => "kindScope",
    readCpRelayCredential: async () => h.credential,
    db: {
      // The demand read selects `toolKey`; the pod_settings read selects `id`.
      select: (shape: Record<string, unknown>) => {
        if (!("toolKey" in shape)) return chain([{ id: "ps-1" }]);
        const q = chain(h.demandRows);
        const where = q.where;
        q.where = (cond: unknown) => {
          h.demandWhereSql.push(render(cond));
          return where(cond);
        };
        return q;
      },
      update: () => ({
        set: (v: { settings: { values: unknown[] } }) => ({
          where: async () => {
            h.stamps.push(JSON.parse(String(v.settings.values[1])));
          },
        }),
      }),
    },
  };
});

vi.mock("@synap/database/schema", () => ({
  entities: { properties: "properties", type: "type", deletedAt: "deletedAt" },
  podSettings: { id: "id", settings: "settings", createdAt: "createdAt" },
}));

vi.mock("@synap-core/core", () => ({ createLogger: () => h.logger }));

import {
  buildToolDemandPayload,
  handleToolDemandForward,
  TOOL_DEMAND_FORWARD_QUEUE,
} from "../tool-demand-forward.js";
import { TOOL_DEMAND_FORWARD_QUEUE as SHARED_QUEUE } from "@synap-core/types/tools";

const fetchMock = vi.fn();

beforeEach(() => {
  h.demandRows = [
    { toolKey: "notion" },
    { toolKey: "notion" },
    { toolKey: "google-calendar" },
    { toolKey: "Not A Key" },
    { toolKey: "Jane Doe oncology intake" },
  ];
  h.credential = { key: "relay.jwt.value", expiresAt: null };
  h.stamps = [];
  h.demandWhereSql = [];
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.CONTROL_PLANE_URL = "https://cp.example.test/";
});

describe("buildToolDemandPayload", () => {
  it("emits distinct pattern-valid KEYS only — nothing else can ride along", () => {
    const rows: NoisyRow[] = [
      ...h.demandRows,
      {
        toolKey: "linear",
        providerKey: "Jane Doe oncology intake",
        title: "x",
      },
    ];
    expect(buildToolDemandPayload(rows)).toEqual([
      { toolKey: "google-calendar" },
      { toolKey: "linear" },
      { toolKey: "notion" },
    ]);
  });
});

describe("handleToolDemandForward", () => {
  it("uses the ONE shared queue name", () => {
    expect(TOOL_DEMAND_FORWARD_QUEUE).toBe(SHARED_QUEUE);
  });

  it("reads only `wanted` demand", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await handleToolDemandForward();
    expect(h.demandWhereSql).toHaveLength(1);
    expect(h.demandWhereSql[0]).toMatch(/tr_status' = wanted/);
  });

  it("posts ONLY tool keys to the CP with the relay JWT, and records it", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const outcome = await handleToolDemandForward();
    expect(outcome).toEqual({ status: "forwarded", count: 2 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://cp.example.test/api/demand/tools");
    expect(init.headers.Authorization).toBe("Bearer relay.jwt.value");
    expect(JSON.parse(init.body)).toEqual({
      tools: [{ toolKey: "google-calendar" }, { toolKey: "notion" }],
    });
    expect(h.stamps[0]).toMatchObject({ status: "forwarded", count: 2 });
  });

  it("an absent CP credential reads as 'not forwarded: CP credential missing' — recorded, no fetch", async () => {
    h.credential = null;
    const outcome = await handleToolDemandForward();
    expect(outcome).toMatchObject({
      status: "not-forwarded",
      reason: "cp-credential-missing",
    });
    expect((outcome as { message: string }).message).toMatch(
      /CP credential missing/
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.stamps[0]).toMatchObject({
      status: "not-forwarded",
      reason: "cp-credential-missing",
    });
  });

  it("a CP rejection is recorded as not forwarded, never as success", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const outcome = await handleToolDemandForward();
    expect(outcome).toMatchObject({
      status: "not-forwarded",
      reason: "cp-rejected",
    });
    expect(h.stamps[0]).toMatchObject({ reason: "cp-rejected" });
  });

  it("an unreachable CP is recorded as not forwarded", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const outcome = await handleToolDemandForward();
    expect(outcome).toMatchObject({
      status: "not-forwarded",
      reason: "cp-unreachable",
    });
  });

  it("an expired credential is not sent", async () => {
    h.credential = { key: "old", expiresAt: new Date(Date.now() - 1000) };
    const outcome = await handleToolDemandForward();
    expect(outcome).toMatchObject({ reason: "cp-credential-expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no demand → nothing sent, still recorded", async () => {
    h.demandRows = [];
    const outcome = await handleToolDemandForward();
    expect(outcome).toEqual({ status: "nothing-to-forward" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.stamps[0]).toMatchObject({ status: "nothing-to-forward" });
  });
});

/**
 * THE POD ↔ CP CONTRACT. The pod's payload and the CP's strict `reportSchema`
 * once pinned OPPOSITE shapes (pod sent `providerKey`, CP rejected it), each
 * side green alone, so every forward 400'd. Both ends now meet at ONE checked-in
 * golden payload:
 *   - HERE: the REAL builder and the REAL handler's fetch body must equal it;
 *   - CP `src/routes/demand.contract.test.ts`: the REAL `reportSchema` must
 *     accept it (skips only when this sibling repo is absent).
 * Changing the pod shape without the CP (or vice versa) goes red on one side.
 * The jobs repo cannot import the CP schema (different repo, CP-only deps), so
 * the fixture is the seam — never hand-copy the schema here.
 */
describe("pod → CP payload contract (golden fixture)", () => {
  const GOLDEN = JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "fixtures",
        "tool-demand-forward.payload.json"
      ),
      "utf8"
    )
  ) as { tools: unknown[] };

  it("the real builder emits exactly the golden payload, even from noisy rows", () => {
    expect(GOLDEN.tools.length).toBeGreaterThan(0);
    const noisy: NoisyRow[] = [
      { toolKey: "notion", providerKey: "notion", title: "Notion" },
      { toolKey: "google-calendar", providerKey: "Jane Doe oncology intake" },
      { toolKey: "Jane Doe oncology intake" },
      { toolKey: "notion" },
    ];
    expect({ tools: buildToolDemandPayload(noisy) }).toEqual(GOLDEN);
  });

  it("the real handler POSTs exactly the golden payload body", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await handleToolDemandForward();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual(GOLDEN);
  });
});
