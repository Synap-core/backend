/**
 * TRIPWIRE — every route in this app that signs a person in with the session
 * `authMiddleware` also refuses a GUEST (`refuseGuestSession` from
 * `@synap/api`).
 *
 * A guest (a project guest with no pod participation) is let in to read what an
 * owner shared, through the app's floors. The doors mounted here (the model and
 * credential lists, the schemas, the terminal WebSocket ticket) serve pod
 * participants; a guest has no use for them. The `@synap/api` Hono apps mounted
 * by `index.ts` (`/api/chat`, `/api/files`, `/api/capture`) are covered
 * behaviourally by `packages/api/src/__tripwires__/guest-containment-session-doors.test.ts`.
 *
 * DERIVED: every non-test source file here is scanned; a file joins by using
 * `authMiddleware`. Per file, each use must be matched by a `refuseGuestSession`
 * use, except the uses classified in ALLOWED below, each with its reason.
 *
 * NOT COVERED, stated: the check is a COUNT per file, not a placement check. A
 * refusal mounted on the wrong route of the same file balances the count. The
 * behavioural guard in packages/api is the one that requests routes.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.dirname(fileURLToPath(import.meta.url));

/** Session-auth uses that are deliberately NOT followed by the guest refusal. */
const ALLOWED: Record<string, { uses: number; why: string }> = {
  "index.ts": {
    uses: 1,
    why: "the `/trpc/*` session gate: every tRPC mutation a guest sends is refused by guestContainmentMiddleware on publicProcedure",
  },
  "routers/federation.ts": {
    uses: 1,
    why: "POST /identity-links links the caller's OWN sign-in identity to an issuer subject; it writes no pod data",
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** Code only: comments and static import statements removed. */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^import\s[\s\S]*?\sfrom\s+["'][^"']+["'];?/gm, "");
}

const count = (code: string, name: string) =>
  [...code.matchAll(new RegExp(`\\b${name}\\b`, "g"))].length;

const scanned = walk(SRC).map((file) => {
  const code = codeOnly(readFileSync(file, "utf8"));
  return {
    rel: path.relative(SRC, file),
    auth: count(code, "authMiddleware"),
    refuse: count(code, "refuseGuestSession"),
  };
});
const sessionFiles = scanned.filter((f) => f.auth > 0);

describe("tripwire: session-authenticated routes refuse a guest", () => {
  it("self-check: the counter ignores imports and comments and sees a use", () => {
    const sample = codeOnly(
      [
        'import { authMiddleware } from "@synap/auth";',
        "// authMiddleware in a comment",
        "/* authMiddleware in a block */",
        'r.get("/x", authMiddleware, refuseGuestSession, h);',
      ].join("\n")
    );
    expect(count(sample, "authMiddleware")).toBe(1);
    expect(count(sample, "refuseGuestSession")).toBe(1);
  });

  it("the scan is not vacuous", () => {
    expect(scanned.length).toBeGreaterThan(40);
    // Measured 2026-09-27: index, providers, both schemas, federation.
    expect(sessionFiles.map((f) => f.rel)).toEqual(
      expect.arrayContaining([
        "index.ts",
        "routers/providers.ts",
        "routers/connectors-schema.ts",
        "routers/automations-schema.ts",
        "routers/federation.ts",
      ])
    );
  });

  it("every session-auth use is matched by a guest refusal, or classified", () => {
    const unmatched = sessionFiles
      .filter((f) => f.auth - (ALLOWED[f.rel]?.uses ?? 0) !== f.refuse)
      .map(
        (f) =>
          `${f.rel}: ${f.auth} authMiddleware, ${f.refuse} refuseGuestSession, ${ALLOWED[f.rel]?.uses ?? 0} allowed`
      );
    expect(unmatched).toEqual([]);
  });

  it("every ALLOWED entry still names a session-auth file (no stale entry)", () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(
        sessionFiles.some((f) => f.rel === rel),
        rel
      ).toBe(true);
    }
  });
});
