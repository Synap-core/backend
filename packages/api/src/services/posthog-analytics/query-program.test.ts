/**
 * posthog-analytics — the FIXED query program's security + honesty properties.
 *
 * These are not shape tests. Each one pins a property that, if it regressed,
 * would let the capability be MISUSED or would let a broken read read as a calm
 * empty:
 *
 *  - SCOPE: no builder can name a host or a project, and every param schema is
 *    `.strict()`, so `projectId`/`host`/`hogql` from a caller is a rejection —
 *    the whole cross-tenant story rests on the project id being an INSTALL-TIME
 *    value baked into the tool's baseUrl (see the definition test).
 *  - INJECTION: a HogQL string is either a literal or built from a validated
 *    integer / allow-listed event name. The allow-list is asserted by trying to
 *    defeat it with the payloads that would actually break out of a literal.
 *  - EMPTY ≠ FAILED: an empty array is a successful empty read; every other
 *    payload shape throws.
 */
import { describe, expect, it } from "vitest";
import {
  EVENT_NAME_PATTERN,
  PostHogQueryError,
  buildEventTrendRequest,
  buildStepReachRequest,
  buildTopEventsRequest,
  buildUniqueUsersRequest,
  eventTrendParams,
  readHogQLTable,
  readStepReach,
  readTrend,
  stepReachHogQL,
  stepReachParams,
  topEventsHogQL,
  topEventsParams,
  uniqueUsersParams,
} from "./query-program.js";

describe("scope: the project id and host are not reachable from a call", () => {
  it("every param schema is STRICT — an undeclared scope field is rejected, not ignored", () => {
    const schemas = [
      eventTrendParams,
      uniqueUsersParams,
      topEventsParams,
      stepReachParams,
    ] as const;
    for (const schema of schemas) {
      expect(schema.safeParse({ projectId: 2 }).success).toBe(false);
      expect(schema.safeParse({ host: "https://evil.example" }).success).toBe(
        false
      );
      expect(schema.safeParse({ hogql: "SELECT 1" }).success).toBe(false);
    }
    // And a legitimate call still passes — the guard must not be "reject all".
    expect(eventTrendParams.safeParse({ event: "$pageview" }).success).toBe(
      true
    );
  });

  it("a caller cannot smuggle a query through a scope-ish field on a valid call", () => {
    const parsed = eventTrendParams.safeParse({
      event: "$pageview",
      days: 7,
      projectId: 999,
    });
    expect(parsed.success).toBe(false);
  });

  it("every built request path is RELATIVE and carries no project id", () => {
    const requests = [
      buildEventTrendRequest({ event: "$pageview" }),
      buildUniqueUsersRequest({}),
      buildTopEventsRequest({}),
      buildStepReachRequest({ steps: ["a", "b"] }),
    ];
    for (const req of requests) {
      expect(req.path.startsWith("/")).toBe(true);
      expect(req.path).not.toMatch(/^[a-z]+:\/\//i);
      expect(req.path).not.toContain("://");
      // The project id is baked into the installed tool's config.baseUrl; it must
      // never travel in a call-time path.
      expect(req.path).not.toMatch(/projects\//);
    }
  });
});

describe("injection: HogQL text is never assembled from unvalidated caller input", () => {
  const HOSTILE = [
    "'",
    '"',
    "\\",
    "a' OR 1=1 --",
    "a' UNION SELECT 1 --",
    "a{placeholder}",
    "a; DROP TABLE events",
    "a*/ /*",
    "a`b`",
    "a\nb",
    "a)b(",
    "a,b",
    "a%2e",
    "a=b",
  ];

  it("the event-name allow-list refuses every literal-breaking payload", () => {
    for (const payload of HOSTILE) {
      expect(
        EVENT_NAME_PATTERN.test(payload),
        `${JSON.stringify(payload)} must NOT be an acceptable event name`
      ).toBe(false);
      expect(
        eventTrendParams.safeParse({ event: payload }).success,
        `event_trend accepted ${JSON.stringify(payload)}`
      ).toBe(false);
      expect(
        stepReachParams.safeParse({ steps: [payload, "b"] }).success,
        `step_reach accepted ${JSON.stringify(payload)}`
      ).toBe(false);
    }
  });

  it("the allow-list still admits real PostHog event names", () => {
    for (const name of [
      "$pageview",
      "$pageleave",
      "synap_deploy_verified",
      "2fa_verified",
      "checkout started",
      "synap:deploy",
      "app/v2/open",
      "a.b-c_d",
    ]) {
      expect(EVENT_NAME_PATTERN.test(name), `${name} should be allowed`).toBe(
        true
      );
    }
  });

  it("top-events HogQL is a STATIC program — no quote character can appear", () => {
    const q = topEventsHogQL(7, 10);
    expect(q).not.toContain("'");
    expect(q).not.toContain("\\");
    expect(q).toBe(
      "SELECT event, count() AS event_count FROM events " +
        "WHERE timestamp >= now() - INTERVAL 7 DAY " +
        "GROUP BY event ORDER BY event_count DESC LIMIT 10"
    );
  });

  it("step-reach inlines each name ONCE, inside a single-quoted literal, and only after validation", () => {
    const q = stepReachHogQL(["$pageview", "synap_deploy_verified"], 14);
    expect(q).toContain("event = '$pageview'");
    expect(q).toContain("event = 'synap_deploy_verified'");
    expect(q).toContain("event IN ('$pageview', 'synap_deploy_verified')");
    expect(q).toContain("now() - INTERVAL 14 DAY");
    // Two steps → two count columns, no more.
    expect(q.match(/count\(DISTINCT/g)).toHaveLength(2);
  });

  it("out-of-range integers are REJECTED, not clamped into a wider read", () => {
    expect(topEventsParams.safeParse({ days: 0 }).success).toBe(false);
    expect(topEventsParams.safeParse({ days: 91 }).success).toBe(false);
    expect(topEventsParams.safeParse({ limit: 101 }).success).toBe(false);
    expect(stepReachParams.safeParse({ steps: ["only-one"] }).success).toBe(
      false
    );
    expect(
      stepReachParams.safeParse({
        steps: Array.from({ length: 9 }, (_, i) => `e${i}`),
      }).success
    ).toBe(false);
  });
});

describe("request builders: defaults and shapes", () => {
  it("event_trend defaults to 7 days / day buckets and carries math=total", () => {
    const req = buildEventTrendRequest(
      eventTrendParams.parse({ event: "$pageview" })
    );
    expect(req.method).toBe("GET");
    const qs = new URLSearchParams(req.path.split("?")[1]);
    expect(qs.get("date_from")).toBe("-7d");
    expect(qs.get("interval")).toBe("day");
    expect(JSON.parse(qs.get("events") ?? "[]")).toEqual([
      { id: "$pageview", type: "events", math: "total" },
    ]);
  });

  it("unique_users asks for math=dau on the default event", () => {
    const req = buildUniqueUsersRequest(uniqueUsersParams.parse({}));
    const qs = new URLSearchParams(req.path.split("?")[1]);
    expect(JSON.parse(qs.get("events") ?? "[]")).toEqual([
      { id: "$pageview", type: "events", math: "dau" },
    ]);
  });

  it("top_events POSTs a HogQL body to the query path", () => {
    const req = buildTopEventsRequest(topEventsParams.parse({ days: 30 }));
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/query/");
    expect(req.body).toEqual({
      query: { kind: "HogQLQuery", query: topEventsHogQL(30, 10) },
    });
  });

  it("step_reach POSTs a HogQL body carrying the caller's own step order", () => {
    const input = stepReachParams.parse({ steps: ["a", "b"], days: 3 });
    const req = buildStepReachRequest(input);
    expect(req.body).toEqual({
      query: { kind: "HogQLQuery", query: stepReachHogQL(input.steps, 3) },
    });
  });
});

describe("readers: an empty result and a failed read are different facts", () => {
  it("readHogQLTable: an empty results array is a SUCCESSFUL empty read", () => {
    const table = readHogQLTable({
      columns: ["event", "event_count"],
      results: [],
    });
    expect(table.rowCount).toBe(0);
    expect(table.rows).toEqual([]);
  });

  it("readHogQLTable: zips array rows onto columns and keeps object rows", () => {
    const zipped = readHogQLTable({
      columns: ["event", "event_count"],
      results: [["$pageview", 12]],
    });
    expect(zipped.rows).toEqual([{ event: "$pageview", event_count: 12 }]);
    const objects = readHogQLTable({
      columns: ["event"],
      results: [{ event: "$pageview" }],
    });
    expect(objects.rows).toEqual([{ event: "$pageview" }]);
  });

  it("readHogQLTable: a missing results array THROWS (never a fake empty)", () => {
    expect(() => readHogQLTable({ columns: [] })).toThrow(PostHogQueryError);
    expect(() => readHogQLTable(null)).toThrow(PostHogQueryError);
    expect(() => readHogQLTable("nope")).toThrow(PostHogQueryError);
  });

  it("readHogQLTable: a 200 carrying PostHog's own error is a FAILURE with its reason", () => {
    expect(() =>
      readHogQLTable({ detail: "HogQL is not enabled for this project" })
    ).toThrow(/HogQL is not enabled for this project/);
  });

  it("readHogQLTable: rows with no columns THROW rather than returning unnamed data", () => {
    expect(() => readHogQLTable({ results: [[1, 2]] })).toThrow(
      /no `columns` array/
    );
  });

  it("readTrend: an empty result array is a SUCCESSFUL empty read", () => {
    const trend = readTrend({ result: [] });
    expect(trend.seriesCount).toBe(0);
  });

  it("readTrend: a missing result array THROWS", () => {
    expect(() => readTrend({})).toThrow(PostHogQueryError);
    expect(() => readTrend({ result: { data: [] } })).toThrow(
      PostHogQueryError
    );
  });

  it("readTrend: a series without a data array THROWS (not a zero-length series)", () => {
    expect(() => readTrend({ result: [{ label: "$pageview" }] })).toThrow(
      /no `data` array/
    );
  });

  it("readTrend: normalizes label/labels/data and never invents a count", () => {
    const trend = readTrend({
      result: [{ label: "$pageview", labels: ["2026-10-01"], data: [3] }],
    });
    expect(trend.series).toEqual([
      { label: "$pageview", count: null, labels: ["2026-10-01"], data: [3] },
    ]);
  });

  it("readStepReach: all-zero reach IS an empty read, not an error", () => {
    const table = readHogQLTable({
      columns: ["step_1_users", "step_2_users"],
      results: [[0, 0]],
    });
    expect(readStepReach(table, ["a", "b"])).toEqual([
      { step: 1, event: "a", users: 0 },
      { step: 2, event: "b", users: 0 },
    ]);
  });

  it("readStepReach: a missing column or a non-numeric value THROWS", () => {
    expect(() =>
      readStepReach(
        readHogQLTable({ columns: ["step_1_users"], results: [[1]] }),
        ["a", "b"]
      )
    ).toThrow(/missing the `step_2_users` column/);
    expect(() =>
      readStepReach(
        readHogQLTable({ columns: ["step_1_users"], results: [["many"]] }),
        ["a"]
      )
    ).toThrow(/is not a number/);
    expect(() =>
      readStepReach(
        readHogQLTable({ columns: ["step_1_users"], results: [] }),
        ["a"]
      )
    ).toThrow(/no row/);
  });
});
