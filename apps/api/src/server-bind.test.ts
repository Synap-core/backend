import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serverBindHostname } from "./server-bind.js";

describe("pod HTTP bind address", () => {
  it("a LOCAL_MODE pod (the desktop's own) listens on loopback only", () => {
    expect(serverBindHostname(true)).toBe("127.0.0.1");
  });

  it("a server pod keeps listening on every interface", () => {
    expect(serverBindHostname(false)).toBe("0.0.0.0");
  });

  it("the server entry binds through serverBindHostname, never a literal address", () => {
    const entry = readFileSync(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8"
    );
    expect(entry).toContain(
      "hostname: serverBindHostname(config.server.localMode)"
    );
    expect(entry).not.toMatch(/hostname:\s*["']0\.0\.0\.0["']/);
  });
});
