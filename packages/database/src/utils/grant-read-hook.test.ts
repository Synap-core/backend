/**
 * The grant read hook fails CLOSED when no provider is registered: a scoped
 * grant reaching a process that never registered the API's clause builder
 * must read nothing, never "no limit". (Order matters: these run before any
 * registration in this file.)
 */
import { describe, it, expect } from "vitest";
import { pgTable, text } from "drizzle-orm/pg-core";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  grantReadClauseFor,
  registerGrantReadProvider,
} from "./grant-read-hook.js";
import { runWithGrant } from "./request-write-context.js";

const t = pgTable("t", { owner: text("owner") });
const render = (s: unknown) => new PgDialect().sqlToQuery(s as never).sql;

describe("grantReadClauseFor — no provider registered", () => {
  it("no grant on the request → no clause", () => {
    expect(grantReadClauseFor(t.owner)).toBeUndefined();
  });

  it("a full-access grant → no clause", () => {
    runWithGrant({ permissions: ["*"] }, () => {
      expect(grantReadClauseFor(t.owner)).toBeUndefined();
    });
  });

  it("a scoped grant → deny-all", () => {
    runWithGrant({ permissions: ["entity.note.read"] }, () => {
      expect(render(grantReadClauseFor(t.owner))).toBe("false");
    });
  });
});

describe("grantReadClauseFor — provider registered", () => {
  it("delegates to the provider for the column's table", () => {
    const seen: object[] = [];
    registerGrantReadProvider((table) => {
      seen.push(table);
      return undefined;
    });
    runWithGrant({ permissions: ["entity.note.read"] }, () => {
      expect(grantReadClauseFor(t.owner)).toBeUndefined();
    });
    expect(seen).toEqual([t]);
  });
});
