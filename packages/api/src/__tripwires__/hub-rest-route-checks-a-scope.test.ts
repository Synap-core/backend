import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TRIPWIRE: every authenticated Hub REST route checks a hub scope.
 *
 * The hub auth middleware (`hub-protocol/_middleware/auth.ts`) resolves the
 * key and sets `c.get("scopes")`, but enforces no scope itself: each handler
 * must. Audit 2026-10-28 F8 found five `/projects` reads and both `/routing`
 * routes with no check, so a key minted with only a non-hub scope
 * (`read:entities`, `mcp.read`, `box.runner`) could call them; a sweep for
 * this tripwire found `PATCH /property-defs/:id`, a write, the same way.
 *
 * DERIVED, NOT HAND-LISTED: every non-test `rest/*.ts` file, every
 * `app.<method>("path", …)` registration (the call's own parentheses, matched,
 * are the route block). A block is SCOPED when it calls `hasScope(`, reads
 * `scopes.includes("…")`, or calls a helper defined in the same file whose
 * body (braces matched) does, followed through helpers up to three deep
 * (`workspace-ops.ts`: `archiveOrRestore` → `actorFor` → `hasScope`).
 * A new route joins the scan by existing.
 *
 * The only unscoped routes are the doors that take no hub key at all, each
 * listed in {@link NO_HUB_KEY} with the credential it takes instead.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REST_DIR = path.resolve(HERE, "../routers/hub-protocol/rest");

/** Routes that authenticate with something other than a hub key, and how. */
const NO_HUB_KEY: Record<string, string> = {
  "GET /health": "Liveness probe, skip-listed, no data.",
  "GET /manifest": "Static agent orientation doc, skip-listed, no data.",
  "GET /calendar/feed/:token":
    "Personal ICS feed: the path token is the capability (auth skip by prefix + .ics).",
  "POST /setup/device/token": "Device flow: the device_code is the credential.",
  "POST /setup/device": "Device flow start, skip-listed; a person approves it.",
  "POST /entity-share/deliver":
    "Control Plane assertion (requiredScope: controlPlaneIssuerScopes()).",
  "POST /federation/oidc-config":
    "Control Plane assertion (requiredScope: controlPlaneIssuerScopes()).",
  "POST /mcp/redeem":
    "Control Plane assertion (requiredScope: controlPlaneIssuerScopes()) plus the one-time code.",
  "POST /mcp/revoke":
    "Control Plane assertion (requiredScope: controlPlaneIssuerScopes()).",
  "GET /public/forms/:token": "Credentialless public door: the path token.",
  "POST /public/forms/:token": "Credentialless public door: the path token.",
  "GET /public/projection":
    "Skip-listed, default-deny: a workspace's opt-in public projection only.",
  "GET /public/shares/:token": "Credentialless public door: the path token.",
  "GET /public/sites/:siteToken": "Credentialless public door: the path token.",
  "GET /public/sites/:siteToken/collections/:key":
    "Credentialless public door: the path token.",
  "GET /public/sites/:siteToken/collections/:key/:slugOrPublicId":
    "Credentialless public door: the path token.",
  "POST /setup/agent":
    "Setup door: setup.agent key, PROVISIONING_TOKEN or trusted-issuer JWT, checked in the handler.",
  "POST /setup/service":
    "Setup door: authenticateServiceSetupRequest (provisioning token or trusted-issuer JWT).",
  "GET /setup/status": "Skip-listed setup probe.",
  "POST /setup/magic-link": "Skip-listed setup door, its own token.",
  "POST /setup/first-admin": "Skip-listed setup door, first-run only.",
  "POST /setup/accept-invite": "Skip-listed setup door: the invite token.",
  "POST /setup/agent/pending/lookup":
    "Pending-agent review: the signed-in person's Kratos session (resolveKratosPodUserId).",
  "POST /setup/agent/pending/approve-batch":
    "Pending-agent review: the signed-in person's Kratos session.",
  "GET /setup/agent/pending/:keyId": "Pending-agent review: the secret keyId.",
  "GET /setup/agent/pending/:keyId/review":
    "Pending-agent review: the secret keyId.",
  "POST /setup/agent/pending/:keyId/approve":
    "Pending-agent review: the signed-in person's Kratos session.",
  "GET /setup/agent/pending/:keyId/details":
    "Pending-agent review: the secret keyId.",
  "POST /setup/agent/pending/:keyId/reject":
    "Pending-agent review: the signed-in person's Kratos session.",
  "GET /users/me":
    "Echoes only the calling credential's own id, scopes and posture; how a client classifies ANY key it holds.",
};

const ROUTE_RE = /app\.(get|post|patch|put|delete)\(\s*[`"]([^`"]+)[`"]/g;
const DIRECT_IDIOMS = [/\bhasScope\(/, /\bscopes\.includes\(\s*["'`]/];

/** Index just past the bracket matching the one at `open`. */
function matchClose(src: string, open: number, o: string, cl: string): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === cl && --depth === 0) return i + 1;
  }
  return src.length;
}

/** Same-file helper bodies: `function NAME(…) {…}` and `const NAME = …{…}`. */
function helperBodies(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const decl =
    /(?:function\s+(\w+)\s*(?:<[^>]*>)?\s*\(|const\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|\w+\s*=>))/g;
  for (const m of src.matchAll(decl)) {
    const name = m[1] ?? m[2];
    // The body brace follows `)`, `>` (`=>`, or a generic return type such as
    // `Promise<…>`) or a word (`: boolean {`); an object type in the
    // signature follows `<`, `|`, `:` or `,` instead.
    const rest = src.slice(m.index ?? 0);
    const at = /[)>\w]\s*\{/.exec(rest);
    if (!at) continue;
    const brace = (m.index ?? 0) + at.index + at[0].length - 1;
    out.set(name, src.slice(brace, matchClose(src, brace, "{", "}")));
  }
  return out;
}

function checksScope(
  block: string,
  helpers: Map<string, string>,
  depth: number,
  seen: Set<string>
): boolean {
  if (DIRECT_IDIOMS.some((re) => re.test(block))) return true;
  if (depth === 0) return false;
  for (const m of block.matchAll(/\b(\w+)\s*\(/g)) {
    const name = m[1];
    const body = helpers.get(name);
    if (!body || seen.has(name)) continue;
    seen.add(name);
    if (checksScope(body, helpers, depth - 1, seen)) return true;
  }
  return false;
}

function scan(): { files: number; routes: Map<string, boolean> } {
  const files = fs
    .readdirSync(REST_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const routes = new Map<string, boolean>();
  for (const file of files) {
    const src = fs.readFileSync(path.join(REST_DIR, file), "utf8");
    const helpers = helperBodies(src);
    for (const m of src.matchAll(ROUTE_RE)) {
      const start = m.index ?? 0;
      const open = src.indexOf("(", start);
      const block = src.slice(start, matchClose(src, open, "(", ")"));
      const key = `${m[1].toUpperCase()} ${m[2]}`;
      const scoped = checksScope(block, helpers, 3, new Set());
      // A path registered twice is scoped only if every registration is.
      routes.set(key, (routes.get(key) ?? true) && scoped);
    }
  }
  return { files: files.length, routes };
}

describe("tripwire: every authenticated Hub REST route checks a hub scope", () => {
  const { files, routes } = scan();

  it("walks the real route files (non-vacuity)", () => {
    expect(files).toBeGreaterThan(30);
    expect(routes.size).toBeGreaterThan(200);
    // The routes this tripwire was written for are in the scanned set.
    for (const key of [
      "GET /projects",
      "GET /projects/:id",
      "GET /routing/lanes",
      "PATCH /property-defs/:id",
      "POST /workspaces/:workspaceId/archive",
    ]) {
      expect(routes.has(key), key).toBe(true);
    }
  });

  it("no route outside NO_HUB_KEY skips the scope check", () => {
    const unscoped = [...routes]
      .filter(([key, scoped]) => !scoped && !(key in NO_HUB_KEY))
      .map(([key]) => key)
      .sort();
    expect(
      unscoped,
      'check the key\'s scope first: hasScope(c.get("scopes") as string[], ' +
        '"hub-protocol.read" | "hub-protocol.write"), as the sibling routes do. ' +
        "A door that takes no hub key goes in NO_HUB_KEY with the credential it takes."
    ).toEqual([]);
  });

  it("NO_HUB_KEY names only live routes that really check no hub scope", () => {
    const stale = Object.keys(NO_HUB_KEY)
      .filter((key) => routes.get(key) !== false)
      .sort();
    expect(
      stale,
      "these are gone or now check a scope: drop them from NO_HUB_KEY"
    ).toEqual([]);
  });
});
