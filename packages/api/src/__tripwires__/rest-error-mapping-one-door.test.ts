import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — Wave-1 error-mapping sites stay on `httpStatusForTrpcError`.
 *
 * 19 catch blocks across 7 `hub-protocol/rest/*.ts` files used to hand-roll a
 * bare `500` (or a fragile `message.includes("not found") ? 404 : 500`
 * string-match ternary) around a `caller.*` tRPC call — so a real 400/403/404
 * from the wrapped tRPC procedure surfaced to the client as a misleading 500.
 * They were migrated to the canonical `httpStatusForTrpcError(err)` helper
 * (`hub-protocol/rest/_shared.ts`), which walks the error's `.cause` chain
 * (depth 4) and maps `BAD_REQUEST`→400, `FORBIDDEN`/`UNAUTHORIZED`→403,
 * `NOT_FOUND`→404, else→500 — correct even when `errorCatchingMiddleware`
 * has wrapped the original TRPCError.
 *
 * This test pins those 19 specific catch blocks (found by the distinctive
 * `logger.error(...)` tag each one carries) so a future edit can't quietly
 * reintroduce a bare `500` or a hand-rolled ternary at the SAME site.
 *
 * SCOPE NOTE — what this can and can't detect:
 *   - It is anchored to a fixed list of (file, log-tag) pairs, not a generic
 *     "any catch that wraps a caller" scan. A generic scan was tried and
 *     rejected: it also fires on the ~235 OTHER bare-500 caller-wrap catches
 *     across this repo (e.g. documents.ts's `getDocument failed` /
 *     `createDocument` sites, skills-crud.ts's `skills create failed` /
 *     `skills list failed` sites) that are real instances of the same
 *     anti-pattern but were NOT part of this wave's confirmed-safe audit —
 *     migrating them needs the same per-site review this wave got, so a
 *     force-fail here would be false urgency, not a real regression signal.
 *   - It therefore holds the line on THIS wave's 19 sites and nothing more.
 *     It does NOT catch a brand-new bare-500 catch added elsewhere, and it
 *     does NOT catch someone deleting the `logger.error` tag a pinned site
 *     uses to self-identify (a `httpStatusForTrpcError` removal is far more
 *     likely to survive as a code-review-visible diff than a silent tag
 *     rename, so this is a reasonable place to draw the line for a
 *     source-grep tripwire).
 *   - Brace-matching (not regex-only) is used to extract each catch block's
 *     full body so multi-line `c.json({...}, X)` calls are captured correctly.
 *
 * If this fails: the offending site regressed to a bare `500`/ternary status.
 * Replace it with `httpStatusForTrpcError(err)` (import from `./_shared.js`)
 * instead of hand-rolling the mapping again.
 */

const REST_DIR = join(process.cwd(), "src/routers/hub-protocol/rest");

// (relative filename, distinctive logger.error tag for the pinned catch block)
const PINNED_SITES: Array<[string, string]> = [
  // tools.ts — all 10 caller-wrap catches (audit's "8 bare-500" + 2 more found
  // during migration; all fit the same pattern, all strict improvements).
  ["tools.ts", "tools create failed"],
  ["tools.ts", "tools list failed"],
  ["tools.ts", "tools get failed"],
  ["tools.ts", "tools approve failed"],
  ["tools.ts", "tools delete failed"],
  ["tools.ts", "tools update failed"],
  ["tools.ts", "tools setAuthBinding failed"],
  ["tools.ts", "tools listBoundCredentials failed"],
  ["tools.ts", "tools bindCredential failed"],
  ["tools.ts", "tools unbindCredential failed"],

  // skills-crud.ts — the 2 flagged sites.
  ["skills-crud.ts", "skills approve failed"],
  ["skills-crud.ts", "skills delete failed"],

  // automations.ts — the remaining 404-ternary sites (the other 5 bare-500s
  // in this file were migrated earlier in this session, not part of this list).
  ["automations.ts", "automations.get failed"],
  ["automations.ts", "automations.trigger failed"],

  // documents.ts — the 2 isNotFound ternaries.
  ["documents.ts", "rawDocument failed"],
  ["documents.ts", "updateDocument failed"],

  // focus-sessions.ts — the shallow `.code === "FORBIDDEN"` read.
  ["focus-sessions.ts", "focus-sessions.create failed"],

  // vault.ts — the bare-500 caller-wrap (NOT the vault.ts:408 domain-code
  // VaultGrantError catch — that's a hard exception, see ALLOWLISTED below).
  ["vault.ts", "vault.secrets delete failed"],

  // workspaces.ts — the bare-500 caller-wrap (NOT the workspaces.ts:985
  // "Definition validation failed" plain-Error ternary — hard exception).
  ["workspaces.ts", "getUserContext failed"],
];

// Hard exceptions from the Wave-1 audit — swapping these to
// `httpStatusForTrpcError` would REGRESS a currently-correct status to 500,
// because neither throws a tRPC-shaped error the helper can read:
//   - vault.ts ~408: VaultGrantError → 403 via a DOMAIN `.code` (e.g.
//     "no_grant"), not a tRPC code.
//   - workspaces.ts ~985: `message.startsWith("Definition validation
//     failed")` on a plain Error with no `.code` at all.
//   - webhooks.ts (3 sites, `_err` discarded) and mcp-redeem.ts (2 sites,
//     deliberate S2S infra catch-all with 4xx handled before the try) are not
//     migration candidates at all — never touched, never allowlisted here.
// These are documented, not scanned for — this tripwire only asserts the
// POSITIVE list above stays fixed.

function matchForward(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Extract the full `catch (err) { ... }` block body containing `tag`. */
function catchBodyForTag(src: string, tag: string): string {
  const tagIdx = src.indexOf(tag);
  if (tagIdx === -1) {
    throw new Error(
      `pinned log tag ${JSON.stringify(tag)} not found in file — the catch ` +
        `block it identifies may have been renamed or removed. Update this ` +
        `tripwire's PINNED_SITES if the site legitimately moved.`
    );
  }
  const catchKwIdx = src.lastIndexOf("catch (err", tagIdx);
  if (catchKwIdx === -1) {
    throw new Error(`no enclosing "catch (err" found before tag ${tag}`);
  }
  const catchOpenIdx = src.indexOf("{", catchKwIdx);
  const catchCloseIdx = matchForward(src, catchOpenIdx);
  return src.slice(catchOpenIdx, catchCloseIdx + 1);
}

describe("tripwire: Wave-1 REST error-mapping sites use httpStatusForTrpcError", () => {
  for (const [file, tag] of PINNED_SITES) {
    it(`${file} — "${tag}" catch uses the helper, not a bare 500/ternary`, () => {
      const src = readFileSync(join(REST_DIR, file), "utf8");
      const body = catchBodyForTag(src, tag);

      expect(body).toContain("httpStatusForTrpcError(");
      // No hand-rolled numeric status literal left in the pinned catch body —
      // the whole point is the helper computes the status, not a ternary.
      expect(/\b(400|403|404|500)\b/.test(body)).toBe(false);
    });
  }

  it("each migrated file imports httpStatusForTrpcError from ./_shared.js", () => {
    const files = Array.from(new Set(PINNED_SITES.map(([f]) => f)));
    for (const file of files) {
      const src = readFileSync(join(REST_DIR, file), "utf8");
      expect(src).toContain("httpStatusForTrpcError");
      expect(src).toMatch(/from\s+"\.\/_shared\.js"/);
    }
  });
});
