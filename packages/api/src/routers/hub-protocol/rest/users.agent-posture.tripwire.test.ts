import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "users.ts");

describe("GET /users/me agent posture", () => {
  const src = readFileSync(FILE, "utf8");

  it("returns an isAgent boolean derived from authenticated server context", () => {
    expect(src).toContain('isAgent: Boolean(c.get("agentUserId"))');
  });

  it("does not read agent posture from a caller-controlled query or body", () => {
    const handler = src.slice(
      src.indexOf('app.get("/users/me"'),
      src.indexOf("\n  });", src.indexOf('app.get("/users/me"'))
    );
    expect(handler).not.toMatch(/req\.(query|json).*isAgent/);
    expect(handler).not.toMatch(/req\.(query|json).*agentUserId/);
  });
});
