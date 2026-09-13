import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

/**
 * Invariant: every door that reads sync status scopes it to the caller.
 *
 * A per-connection sync-status row carries a member's connection id, error,
 * proposal id and counts. `getConnectionSyncStatus({ userId })` keeps only the
 * caller's own rows; called without `userId` it returns EVERY member's. The
 * tRPC door was scoped while the Hub REST door was not — the same leak on a
 * second door — so this scans every caller instead of trusting each door.
 *
 * The CALLER SET is DERIVED: every non-test .ts under packages/api/src and
 * apps/api/src containing `getConnectionSyncStatus(` (the definition excluded).
 * Each call's argument text must name `userId`, OR the three lines above it must
 * carry the marker `sync-status: pod-admin view` — the one deliberate unscoped
 * read, behind `podAdminProcedure`.
 *
 * WHAT IT CANNOT SEE: it reads text, not values. `userId: someoneElse` passes;
 * so does a marker placed above a door that is not actually admin-gated. The
 * argument text is taken by paren depth from the call's `(`, so a `)` inside a
 * string literal in the arguments would cut it short (the non-vacuity and
 * self-check below go red if extraction breaks, rather than passing silently).
 */

const apiSrc = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const appsSrc = join(apiSrc, "..", "..", "..", "apps", "api", "src");
const MARKER = "sync-status: pod-admin view";
const CALL = "getConnectionSyncStatus(";

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true }) as string[])
    .filter(
      (rel) =>
        rel.endsWith(".ts") &&
        !rel.endsWith(".test.ts") &&
        !rel.includes("__tests__") &&
        !rel.includes("__tripwires__")
    )
    .map((rel) => join(root, rel));
}

interface CallSite {
  file: string;
  args: string;
  above: string;
}

/** Every call of `getConnectionSyncStatus(` in `text`, with its argument text. */
export function extractCalls(file: string, text: string): CallSite[] {
  const out: CallSite[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(CALL, from);
    if (at < 0) break;
    from = at + CALL.length;
    if (/function\s+$/.test(text.slice(Math.max(0, at - 20), at))) continue;
    let depth = 1;
    let i = from;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      i++;
    }
    const lineStart = text.lastIndexOf("\n", at);
    const above = text.slice(0, lineStart).split("\n").slice(-3).join("\n");
    out.push({ file, args: text.slice(from, i - 1), above });
  }
  return out;
}

const calls = [...sourceFiles(apiSrc), ...sourceFiles(appsSrc)].flatMap((f) =>
  extractCalls(f, readFileSync(f, "utf-8"))
);

describe("sync status is scoped to the caller on every door", () => {
  it("finds the known doors (non-vacuity)", () => {
    const files = new Set(calls.map((c) => c.file.replace(/\\/g, "/")));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(
      [...files].some((f) => f.endsWith("routers/connectors-trpc.ts"))
    ).toBe(true);
    expect(
      [...files].some((f) =>
        f.endsWith("routers/hub-protocol/rest/connectors.ts")
      )
    ).toBe(true);
  });

  it("the extractor can see a scoped call and an unscoped one (self-check)", () => {
    const sample = [
      "const a = await getConnectionSyncStatus({ provider, userId: ctx.userId });",
      "const b = await getConnectionSyncStatus({});",
      "export async function getConnectionSyncStatus(input: X) {}",
    ].join("\n");
    const found = extractCalls("sample.ts", sample);
    expect(found.map((c) => c.args)).toEqual([
      "{ provider, userId: ctx.userId }",
      "{}",
    ]);
  });

  it("every call passes userId, or is the marked pod-admin view", () => {
    const unscoped = calls
      .filter((c) => !/\buserId\b/.test(c.args) && !c.above.includes(MARKER))
      .map((c) => `${c.file}: getConnectionSyncStatus(${c.args.trim()})`);
    expect(unscoped).toEqual([]);
  });
});
