/**
 * TRIPWIRE — every issuer→pod JWT (Control Plane or any other issuer) is
 * verified through the ONE door, with an audience.
 *
 * WHY (SECURITY-KEYS-2026-10-13 C2/C3). `/federation/oidc-config` verified a
 * CP push with the bare verifier and no pinned issuer — any HTTPS host could
 * sign for itself and repoint the pod's sign-in provider. `sync-setup`,
 * `entity-share/deliver` and the invite proxy verified CP tokens with no
 * audience, so a token minted for one pod was valid at every pod. The fix is
 * ONE door, `verifyTrustedIssuerJwt` (approved registry issuer + scopes +
 * REQUIRED audience + expected purpose `type` + durable single-use jti).
 *
 * HOW (derived, not hand-listed): walk every `packages/<pkg>/src` and
 * `apps/<app>/src` (tests and tripwires skipped), and parse every CALL of the
 * four verifier names (generic arguments and multi-line calls included).
 *  A. The bare `verifyIssuerJwt` may be called only by files in
 *     `LOW_LEVEL_CALLERS` (each with its reason), and always with a pinned
 *     issuer AND an audience (≥ 3 arguments). The derived set of calling files
 *     must EQUAL the list — a new caller fails, a caller that left fails.
 *  B. The retired `verifyCpJwt` (now always rejects) may be called only by
 *     `RETIRED_CALLERS` — equality again, so the list shrinks to zero.
 *  C. Every `verifyTrustedIssuerJwt` / `verifyCpJwtWithTrust` call passes an
 *     `audience` key.
 *  D. Every door call passes `expectedType`, except files in
 *     `TYPE_CHECKED_AFTER` (legacy: they compare `payload.type` after the
 *     door) — equality, so a new caller must use the in-door purpose check.
 *
 * WHAT IT DOES NOT SEE (stated): a verifier imported under another name, or
 * called through a variable, is invisible; granularity for A/B/D is the FILE
 * (a second call inside a listed file passes D). C checks the key is PRESENT,
 * not that its value is this pod's URL — the type system makes `audience` a
 * required `string` and the door rejects an empty one at runtime.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const SKIP = new Set(["node_modules", "dist", "__tests__", "__tripwires__"]);
const DOOR_FILE = "packages/api/src/utils/jwks-client.ts";

/** Files allowed to call the low-level `verifyIssuerJwt`, and why. */
const LOW_LEVEL_CALLERS: Record<string, string> = {
  "apps/api/src/routers/federation.ts":
    "Federation bootstrap / identity-link / receipt: each resolves the APPROVED registry entry itself (bootstrap: PROVISIONING_TOKEN + pending→approved), pins it, passes audience = PUBLIC_URL, and persists a durable replay receipt with a replay context (consumeJti: false).",
};

/** Files still calling the RETIRED `verifyCpJwt` (always rejects), and why. */
const RETIRED_CALLERS: Record<string, string> = {
  "packages/api/src/routers/workspaces/invites.ts":
    "acceptInviteViaCp / rejectInviteViaCp — no Control Plane mints `invite-accept` (zero signers in any repo), so failing closed breaks nothing. File held by a peer on 2026-10-13: migrate to the door or delete the procedures.",
};

/** Door callers that check the purpose AFTER the door (legacy shape). */
const TYPE_CHECKED_AFTER: Record<string, string> = {
  "apps/api/src/routers/provision.ts":
    "register/reset-intelligence, validate-credentials, addon-* … compare payload.type after the door.",
  "apps/api/src/routers/connectors.ts":
    "pod_trust_diagnostics / connector_sync_trigger — zod-parsed type after the door.",
  "apps/api/src/routers/federation.ts":
    "membership grant — schema-parsed `type`/`purpose` after the door.",
  "packages/api/src/routers/admin-source-configs.ts":
    "federated_assertion + purpose schema-parsed after the door.",
  "packages/api/src/routers/hub-protocol/rest/mcp-redeem.ts":
    "CP signs `mcp_redeem` / `mcp_revoke` boolean purpose claims (no `type`), checked after the door.",
};

const NAMES = [
  "verifyIssuerJwt",
  "verifyCpJwt",
  "verifyTrustedIssuerJwt",
  "verifyCpJwtWithTrust",
] as const;
type Name = (typeof NAMES)[number];

interface Call {
  file: string;
  name: Name;
  args: string;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (
      /\.(ts|tsx)$/.test(entry) &&
      !/\.(test|spec)\.tsx?$/.test(entry) &&
      !entry.endsWith(".d.ts")
    )
      out.push(full);
  }
}

function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const top of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(REPO, top))) {
      const src = join(REPO, top, pkg, "src");
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch {
        /* no src */
      }
    }
  }
  return roots;
}

/**
 * Parse every CALL of a verifier name in `text`: `name<…>(…)` with the
 * generic and argument lists balanced (multi-line). Definitions
 * (`function name`), aliases (`= name;`), imports and re-exports have no `(`
 * after the name, so they are not calls.
 */
export function parseCalls(file: string, text: string): Call[] {
  const calls: Call[] = [];
  const re = new RegExp(`\\b(${NAMES.join("|")})\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 9), m.index);
    if (/function\s+$/.test(before)) continue;
    let i = m.index + m[0].length;
    while (/\s/.test(text[i] ?? "")) i++;
    if (text[i] === "<") {
      let depth = 0;
      for (; i < text.length; i++) {
        if (text[i] === "<") depth++;
        else if (text[i] === ">" && text[i - 1] !== "=") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      while (/\s/.test(text[i] ?? "")) i++;
    }
    if (text[i] !== "(") continue;
    let depth = 0;
    const start = i;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push({ file, name: m[1] as Name, args: text.slice(start + 1, i) });
  }
  return calls;
}

/** Top-level comma count of an argument list (nesting-aware). */
function argCount(args: string): number {
  if (!args.trim()) return 0;
  let depth = 0;
  let n = 1;
  for (const ch of args) {
    if ("({[<".includes(ch)) depth++;
    else if (")}]>".includes(ch)) depth--;
    else if (ch === "," && depth === 0) n++;
  }
  return args.trim().endsWith(",") ? n - 1 : n;
}

function allCalls(): Call[] {
  const files: string[] = [];
  for (const root of sourceRoots()) walk(root, files);
  return files.flatMap((full) => {
    const rel = relative(REPO, full);
    if (rel === DOOR_FILE) return [];
    return parseCalls(rel, readFileSync(full, "utf8"));
  });
}

const filesOf = (calls: Call[]) =>
  [...new Set(calls.map((c) => c.file))].sort();

describe("issuer→pod JWTs go through ONE door, with an audience", () => {
  const calls = allCalls();
  const doorCalls = calls.filter(
    (c) =>
      c.name === "verifyTrustedIssuerJwt" || c.name === "verifyCpJwtWithTrust"
  );

  it("scanner self-check: parses a multi-line generic call and skips definitions", () => {
    const sample = [
      "export async function verifyIssuerJwt<T>(token: string) {}",
      "export const verifyCpJwtWithTrust = verifyTrustedIssuerJwt;",
      "const p = await verifyTrustedIssuerJwt<{",
      "  type: string; n: () => void;",
      "}>(token, {",
      "  audience,",
      "  expectedType: 'x',",
      "});",
    ].join("\n");
    const parsed = parseCalls("sample.ts", sample);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.name).toBe("verifyTrustedIssuerJwt");
    expect(parsed[0]!.args).toMatch(/audience/);
    expect(argCount("token, issuer, audience, { consumeJti: false }")).toBe(4);
  });

  it("non-vacuity: the scan sees the known door callers", () => {
    // provision.ts alone holds ~10 door calls; the migrated routes add 6.
    expect(doorCalls.length).toBeGreaterThanOrEqual(15);
    expect(filesOf(doorCalls)).toEqual(
      expect.arrayContaining([
        "packages/api/src/routers/hub-protocol/rest/federation.ts",
        "packages/api/src/routers/sync.ts",
        "packages/api/src/routers/hub-protocol/rest/entity-share.ts",
        "packages/api/src/routers/hub-protocol/rest/setup.ts",
        "apps/api/src/routers/provision.ts",
      ])
    );
  });

  it("A. the bare verifier is called only by classified low-level callers, pinned + audience-bound", () => {
    const bare = calls.filter((c) => c.name === "verifyIssuerJwt");
    expect(filesOf(bare)).toEqual(Object.keys(LOW_LEVEL_CALLERS).sort());
    const short = bare.filter((c) => argCount(c.args) < 3);
    expect(short.map((c) => `${c.file}: ${c.args.slice(0, 80)}`)).toEqual([]);
  });

  it("B. the retired audience-less CP verifier has no new callers", () => {
    const retired = calls.filter((c) => c.name === "verifyCpJwt");
    expect(filesOf(retired)).toEqual(Object.keys(RETIRED_CALLERS).sort());
  });

  it("C. every door call passes an audience", () => {
    const missing = doorCalls.filter((c) => !/\baudience\b/.test(c.args));
    expect(missing.map((c) => `${c.file}: ${c.args.slice(0, 80)}`)).toEqual([]);
  });

  it("D. every door call checks the purpose IN the door, except classified legacy callers", () => {
    const untyped = doorCalls.filter((c) => !/\bexpectedType\b/.test(c.args));
    expect(filesOf(untyped)).toEqual(Object.keys(TYPE_CHECKED_AFTER).sort());
  });
});
