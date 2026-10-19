import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  isBannedAdminPath,
  isMatcherExcluded,
  isMemberConsolePath,
  isSelfService,
  MATCHER_EXCLUDED_PREFIXES,
  parseConsoleRole,
  routeAccess,
} from "./route-policy";

const PROXY_SOURCE = readFileSync(
  fileURLToPath(new URL("../proxy.ts", import.meta.url)),
  "utf8"
);

/** The `config.matcher` string literal, read from source (Next reads it statically too). */
function matcherLiteral(): string {
  const m = PROXY_SOURCE.match(/"(\/\(\(\?!([^)]*)\)\.\*\))"/);
  if (!m) throw new Error("proxy.ts matcher literal not found");
  return m[1];
}

describe("proxy matcher literal ↔ route-policy", () => {
  it("lists exactly MATCHER_EXCLUDED_PREFIXES", () => {
    const inner = matcherLiteral().match(/\(\?!([^)]*)\)/)?.[1] ?? "";
    expect(inner.split("|")).toEqual([...MATCHER_EXCLUDED_PREFIXES]);
  });

  it("agrees with isMatcherExcluded on real and near-miss paths", () => {
    // Next anchors the matcher; `.` in the literal is a regex wildcard, which
    // is why the comparison runs the literal itself rather than trusting it.
    const re = new RegExp(`^${matcherLiteral()}$`);
    for (const path of [
      "/",
      "/home",
      "/review",
      "/api/health",
      "/api-keys",
      "/apps/abc",
      "/login",
      "/login-history",
      "/invites",
      "/recovery",
      "/setup",
      "/forbidden",
      "/favicon.ico",
      "/_next/static/x.js",
      "/workspaces",
      "/settings/security",
    ]) {
      expect(re.test(path), path).toBe(!isMatcherExcluded(path));
    }
  });

  it("the proxy gates with route-policy, not an inline copy", () => {
    expect(PROXY_SOURCE).toMatch(/from "\.\/lib\/route-policy"/);
    expect(PROXY_SOURCE).not.toMatch(/const isSelfService\s*=/);
  });
});

describe("isSelfService (moved verbatim from proxy.ts)", () => {
  it.each([
    "/connect",
    "/my-connections",
    "/apps/app_123",
    "/my-vault",
    "/my-computers",
    "/my-computers/c1",
    "/my-notifications",
    "/settings/security",
    "/oauth/consent",
    "/approve-agent",
    "/approve-agents",
    "/approve-agent/x",
    "/device",
    "/connection-requests/abc",
    "/proposal/p1",
    "/open/entity/e1",
  ])("%s is self-service", (path) => {
    expect(isSelfService(path)).toBe(true);
  });

  it.each([
    "/",
    "/home",
    "/review",
    "/connectors",
    "/connect/x",
    "/apps",
    "/my-connections/x",
    "/my-notifications/x",
    "/settings",
    "/device/x",
    "/proposal",
    "/open",
    "/workspaces",
    "/computers",
  ])("%s is not self-service", (path) => {
    expect(isSelfService(path)).toBe(false);
  });
});

describe("member console (D8)", () => {
  it.each(["/", "/home", "/review"])("%s opens for any member", (path) => {
    expect(isMemberConsolePath(path)).toBe(true);
    expect(routeAccess(path)).toBe("signed-in");
  });

  it.each([
    "/homepage",
    "/reviews",
    "/home/anything",
    "/review/abc",
    "/members",
    "/workspaces/1",
  ])("%s stays admin", (path) => {
    expect(isMemberConsolePath(path)).toBe(false);
    expect(routeAccess(path)).toBe("admin");
  });

  it("public paths never reach the gate", () => {
    expect(routeAccess("/login")).toBe("public");
    expect(routeAccess("/api/health")).toBe("public");
  });
});

describe("isBannedAdminPath", () => {
  it.each([
    "/api-keys",
    "/invites",
    "/login-history",
    "/setup-wizard",
    "/apps/x",
    "/approve-agents",
    "/open/x",
    "/proposal/x",
    "/connect",
    "/connection-requests/x",
    "/device",
    "/my-anything",
    "/settings/security",
  ])("%s is banned for admin pages", (path) => {
    expect(isBannedAdminPath(path)).toBe(true);
  });

  it.each([
    "/keys",
    "/members",
    "/sources",
    "/security",
    "/settings",
    "/review",
  ])("%s is allowed", (path) => {
    expect(isBannedAdminPath(path)).toBe(false);
  });
});

describe("parseConsoleRole", () => {
  it("only an explicit admin header yields admin", () => {
    expect(parseConsoleRole("admin")).toBe("admin");
    expect(parseConsoleRole("member")).toBe("member");
    expect(parseConsoleRole(null)).toBe("member");
    expect(parseConsoleRole("ADMIN")).toBe("member");
  });
});
