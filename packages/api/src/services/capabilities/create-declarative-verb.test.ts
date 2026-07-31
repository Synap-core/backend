import { describe, expect, it } from "vitest";
import {
  buildProviderVerbSpec,
  parentToolMissingMessage,
  parentToolWhere,
} from "./create-declarative-verb.js";
import type { CreateVerbInput } from "../../routers/mcp/validate-create-verb.js";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const base: CreateVerbInput = {
  toolName: "linear",
  verbName: "linear_list_issues",
  method: "GET",
  pathTemplate: "/issues",
};

describe("buildProviderVerbSpec", () => {
  it("maps the required fields onto the canonical ProviderVerbSpec names", () => {
    expect(buildProviderVerbSpec(base)).toEqual({
      tool: "linear",
      method: "GET",
      pathTemplate: "/issues",
    });
  });

  it("carries responseShape through — the verb's output contract", () => {
    const spec = buildProviderVerbSpec({
      ...base,
      responseShape: {
        collectionPath: "data.issues",
        collectionAs: "issues",
        item: { title: "title" },
      },
    });
    expect(spec.responseShape).toEqual({
      collectionPath: "data.issues",
      collectionAs: "issues",
      item: { title: "title" },
    });
  });

  it("omits optional keys entirely rather than emitting undefined", () => {
    const spec = buildProviderVerbSpec(base);
    expect(Object.keys(spec).sort()).toEqual([
      "method",
      "pathTemplate",
      "tool",
    ]);
  });

  it("carries query and body templates", () => {
    const spec = buildProviderVerbSpec({
      ...base,
      method: "POST",
      query: { limit: "{{limit}}" },
      body: { title: "{{title}}" },
    });
    expect(spec.query).toEqual({ limit: "{{limit}}" });
    expect(spec.body).toEqual({ title: "{{title}}" });
  });
});

describe("parentToolMissingMessage", () => {
  it("names the tool and both ways forward", () => {
    const msg = parentToolMissingMessage("linear");
    expect(msg).toContain("'linear' is not installed");
    expect(msg).toContain("ALREADY-installed");
    expect(msg).toContain("catalogue");
  });

  it("names the workspace when the lens is workspace-scoped", () => {
    expect(parentToolMissingMessage("linear", "ws-1")).toContain(
      "for workspace ws-1"
    );
  });

  it("says nothing about a workspace at pod altitude", () => {
    expect(parentToolMissingMessage("linear", null)).not.toContain("workspace");
  });
});

describe("parentToolWhere", () => {
  /**
   * The predicate is drizzle SQL; assert on its rendered shape rather than on a
   * live DB. What must hold: the owner/membership predicate is re-ANDed ON TOP
   * of the workspace lens (a lens alone is owner-blind), and pod altitude never
   * emits a workspace equality.
   */
  const dialect = new PgDialect();
  const render = (sql: SQL) => dialect.sqlToQuery(sql);
  const WS = "11111111-1111-1111-1111-111111111111";

  it("at pod altitude matches pod-wide tools only — no workspace equality", () => {
    const { sql, params } = render(
      parentToolWhere({ userId: "u1", toolName: "linear" })
    );
    // The lens is `workspace_id is null` — never an equality against a lens the
    // caller did not select.
    expect(sql).toContain('"tools"."workspace_id" is null');
    expect(sql).not.toContain('"tools"."workspace_id" = ');
    expect(params).not.toContain(WS);
  });

  it("with a workspace lens binds that workspace id", () => {
    const { sql, params } = render(
      parentToolWhere({ userId: "u1", toolName: "linear", workspaceId: WS })
    );
    expect(sql).toContain('"tools"."workspace_id" = ');
    expect(params).toContain(WS);
  });

  it("re-ANDs the caller's identity on top of the lens (never lens-only)", () => {
    for (const workspaceId of [undefined, WS]) {
      const { sql, params } = render(
        parentToolWhere({ userId: "u-abc", toolName: "linear", workspaceId })
      );
      // `userVisibleWhere` emits member/owner subqueries bound to the caller.
      expect(params).toContain("u-abc");
      expect(sql).toContain("workspace_members");
    }
  });

  it("always constrains the tool NAME", () => {
    const { sql, params } = render(
      parentToolWhere({ userId: "u1", toolName: "linear" })
    );
    expect(sql).toContain('"tools"."name" = ');
    expect(params).toContain("linear");
  });
});
