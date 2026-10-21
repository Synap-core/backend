/**
 * TRIPWIRE `credential-doors-refuse-device-session` — no door a Synap app's
 * DEVICE token reaches may create, rotate, widen or approve a CREDENTIAL.
 *
 * WHY (join plan target A; PR #59 review by console-security): a device
 * access token (`synap_pd_…`) lives 1 h and is the PERSON on the app API. Any
 * app-API door that writes an API key, a grant, an app's reach, a governance
 * rule, a computer's approval, an OAuth/MCP connection, a refresh family or a
 * secret's grant would let a leaked token become a long-lived credential.
 * Those acts belong to the console, in a Kratos session. The refusal is ONE
 * predicate (`utils/device-session.ts`), applied by `credentialProcedure` /
 * `.use(refuseDeviceSession)` (trpc.ts), a proposal executor's
 * `widensCredential` (dispatch), or an explicit `assertNotDeviceSession(ctx)`.
 *
 * HOW (derived — nothing below lists a door):
 *  1. Parse every non-test source file of packages/api, packages/database and
 *     apps/api with the TypeScript compiler into FUNCTION UNITS (functions,
 *     methods, arrow functions bound to a name).
 *  2. A unit WIDENS A CREDENTIAL when its code writes a table of
 *     `CREDENTIAL_TABLES` in a way that can GIVE authority: an INSERT, or an
 *     UPDATE that sets anything beyond the narrowing columns
 *     (`NARROWING_COLUMNS`: revoked/retired/deleted marks, `is_active = false`,
 *     use bookkeeping). A DELETE, or an UPDATE that only revokes, takes
 *     authority away and is not a widening (Drizzle `.insert(t)` /
 *     `.update(t).set({...})` / `.delete(t)` read from the AST; SQL text
 *     `INSERT INTO` / `UPDATE … SET` / `DELETE FROM` read by its columns).
 *  3. Credentialness PROPAGATES to callers through calls resolved BY NAME: a
 *     plain call `f()` or `x.f()` resolves when exactly one unit is named `f`;
 *     `obj.m()` where `obj` was bound to `new C(...)` (in the same file, or a
 *     module-level singleton anywhere) resolves to `C.m`. A unit that calls
 *     `assertNotDeviceSession` is GUARDED and does not propagate.
 *  4. The DOORS a device token reaches: every tRPC procedure (`router({...})`
 *     entries) and every Hono handler mounted with `appSessionMiddleware()`.
 *     A door that reaches a credential unit must be guarded: its builder is
 *     `credentialProcedure`, its chain has `.use(refuseDeviceSession)`, or its
 *     body calls `assertNotDeviceSession`. A proposal EXECUTOR that reaches one
 *     must declare `widensCredential: true`.
 *
 * NON-VACUITY: the scan parses > 400 files; every credential table has at
 * least one writer; known doors are classified; and a synthetic source that
 * mints a key through an unguarded procedure is flagged by the SAME analyzer
 * (the positive control below).
 *
 * WHAT IT DOES NOT SEE (stated): a call through a name defined twice or more
 * that is not a resolvable `new C()` binding (`repo.create` on an untyped
 * parameter, a callback passed around, a registry dispatch) — the chain then
 * stops; a write built from a variable table. Granularity is the FUNCTION: a
 * guard anywhere in a unit guards the whole unit.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const ROOTS = ["packages/api/src", "packages/database/src", "apps/api/src"];
const SKIP = new Set(["node_modules", "dist", "__tests__", "__tripwires__"]);

/**
 * What a CREDENTIAL is, as tables (Drizzle name → SQL name): authority over
 * the pod — keys and their grants, an app's reach, a trusted issuer, a
 * computer's approval, an OAuth/MCP connection, a refresh family or device, an
 * agent's auto-approve rule. This is the definition the scan applies, not a
 * list of doors: each must still have a widening writer (checked below), so
 * a renamed table cannot silently drop out.
 *
 * NOT here, by decision (PR #59, named in the report): `vault_grants` — a
 * capability's or a session's access to ONE secret, created by installing a
 * template or capability and by answering a "provide" ask. Those stay open to
 * a Synap app (the desktop is the workbench) and are governed by their own
 * doors.
 */
const CREDENTIAL_TABLES: Record<string, string> = {
  apiKeys: "api_keys",
  grants: "grants",
  governanceRules: "governance_rules",
  apps: "apps",
  trustedIssuers: "trusted_issuers",
  deviceAuthRequests: "device_auth_requests",
  mcpConnectCodes: "mcp_connect_codes",
  oauthAuthorizationCodes: "oauth_authorization_codes",
  oauthRefreshTokens: "oauth_refresh_tokens",
  personDevices: "person_devices",
  personDeviceTokens: "person_device_tokens",
};

/**
 * Columns an UPDATE may set without giving authority: it revokes, retires,
 * deletes, consumes, or keeps use bookkeeping (`is_active` only to the
 * literal `false`). Anything else set on a credential table is a widening,
 * unless the UPDATE sets an ending `status` (below).
 */
const NARROWING_COLUMNS = new Set([
  "revokedAt",
  "revokedBy",
  "revokedReason",
  "revokedByUserId",
  "retiredAt",
  "deletedAt",
  "lastUsedAt",
  "updatedAt",
  "replacedBy",
  "consumedAt",
]);
/**
 * A `status` set to one of these ENDS the row's authority; the columns beside
 * it are its audit stamps (who, when, why), so the whole UPDATE narrows.
 */
const ENDING_STATUSES = new Set([
  "revoked",
  "rejected",
  "retired",
  "disabled",
  "denied",
  "expired",
]);
const NARROWING_SQL_COLUMNS = new Set([
  "revoked_at",
  "revoked_by",
  "revoked_reason",
  "retired_at",
  "deleted_at",
  "last_used_at",
  "updated_at",
  "use_count",
]);

const GUARD_CALL = "assertNotDeviceSession";
const GUARDED_BUILDERS = new Set(["credentialProcedure"]);
const GUARD_MIDDLEWARE = "refuseDeviceSession";

// ─── Parsing ─────────────────────────────────────────────────────────────────

interface Unit {
  id: number;
  /** `f` for a function, `C.m` for a method of class C. */
  name: string;
  file: string;
  node: ts.Node;
}

interface Analysis {
  units: Unit[];
  files: Map<string, ts.SourceFile>;
  /** Module-level `const x = new C(...)` anywhere: x → C. */
  singletons: Map<string, string>;
}

const sqlNames = Object.values(CREDENTIAL_TABLES).join("|");
const SQL_INSERT = new RegExp(`insert\\s+into\\s+"?(${sqlNames})"?\\b`, "gi");
const SQL_UPDATE = new RegExp(
  `update\\s+"?(${sqlNames})"?\\s+set\\s+([\\s\\S]*?)(?:\\bwhere\\b|\\breturning\\b|$)`,
  "gi"
);

/**
 * The credential tables a subtree WIDENS (step 2 above), read from the AST
 * for Drizzle and from the SET columns for SQL text. Empty = it writes none,
 * or only narrows.
 */
function widenedTables(node: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    const arg = ts.isCallExpression(n) ? n.arguments[0] : undefined;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.arguments.length === 1 &&
      arg &&
      ts.isIdentifier(arg) &&
      CREDENTIAL_TABLES[arg.text]
    ) {
      const op = n.expression.name.text;
      if (op === "insert") out.push(arg.text);
      if (op === "update") {
        // `.update(t).set(obj)`: the `.set` call wraps this one.
        const access = n.parent;
        const setCall = access?.parent;
        const setArg =
          access &&
          ts.isPropertyAccessExpression(access) &&
          access.name.text === "set" &&
          setCall &&
          ts.isCallExpression(setCall)
            ? setCall.arguments[0]
            : undefined;
        const ends =
          !!setArg &&
          ts.isObjectLiteralExpression(setArg) &&
          setArg.properties.some(
            (p) =>
              ts.isPropertyAssignment(p) &&
              nameOf(p) === "status" &&
              ts.isStringLiteral(p.initializer) &&
              ENDING_STATUSES.has(p.initializer.text)
          );
        const narrowing =
          ends ||
          (!!setArg &&
            ts.isObjectLiteralExpression(setArg) &&
            setArg.properties.every((p) => {
              const key = nameOf(p);
              if (!key || !ts.isPropertyAssignment(p)) return false;
              if (key === "isActive") {
                return p.initializer.kind === ts.SyntaxKind.FalseKeyword;
              }
              return NARROWING_COLUMNS.has(key);
            }));
        if (!narrowing) out.push(arg.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  const text = node.getText();
  for (const m of text.matchAll(SQL_INSERT)) out.push(m[1]!.toLowerCase());
  for (const m of text.matchAll(SQL_UPDATE)) {
    const cols = [...m[2]!.matchAll(/"?(\w+)"?\s*=/g)].map((c) => c[1]!);
    if (!cols.every((c) => NARROWING_SQL_COLUMNS.has(c)))
      out.push(m[1]!.toLowerCase());
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts")
    )
      out.push(full);
  }
  return out;
}

function nameOf(node: ts.Node): string | null {
  const n = (node as { name?: ts.Node }).name;
  if (n && (ts.isIdentifier(n) || ts.isStringLiteral(n))) return n.text;
  return null;
}

function className(node: ts.Node): string | null {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isClassDeclaration(p) || ts.isClassExpression(p)) {
      return p.name?.text ?? null;
    }
    if (ts.isSourceFile(p)) return null;
  }
  return null;
}

function analyse(sources: Array<{ rel: string; code: string }>): Analysis {
  const units: Unit[] = [];
  const files = new Map<string, ts.SourceFile>();
  const singletons = new Map<string, string>();
  for (const { rel, code } of sources) {
    const sf = ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true);
    files.set(rel, sf);
    const visit = (node: ts.Node) => {
      let name: string | null = null;
      if (ts.isFunctionDeclaration(node)) name = nameOf(node);
      else if (ts.isMethodDeclaration(node)) {
        const m = nameOf(node);
        const c = className(node);
        name = m ? (c ? `${c}.${m}` : m) : null;
      } else if (
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
        node.parent &&
        (ts.isVariableDeclaration(node.parent) ||
          ts.isPropertyAssignment(node.parent) ||
          ts.isPropertyDeclaration(node.parent))
      ) {
        const n = nameOf(node.parent);
        const c = ts.isPropertyDeclaration(node.parent)
          ? className(node.parent)
          : null;
        name = n ? (c ? `${c}.${n}` : n) : null;
      }
      if (name) units.push({ id: units.length, name, file: rel, node });
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isNewExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.parent?.parent &&
        ts.isVariableStatement(node.parent.parent) &&
        ts.isSourceFile(node.parent.parent.parent)
      ) {
        singletons.set(node.name.text, node.initializer.expression.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { units, files, singletons };
}

/** `new C(...)` bindings visible in a file: local consts and class fields. */
function localBindings(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression)
    ) {
      const n = nameOf(node);
      if (n) out.set(n, node.initializer.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The names a subtree calls, resolved to candidate unit names. */
function calledNames(
  node: ts.Node,
  bindings: Map<string, string>,
  singletons: Map<string, string>
): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee)) out.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        out.add(method);
        let recv: ts.Expression = callee.expression;
        if (
          ts.isPropertyAccessExpression(recv) &&
          recv.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          recv = recv.name;
        }
        if (ts.isIdentifier(recv)) {
          const cls = bindings.get(recv.text) ?? singletons.get(recv.text);
          if (cls) out.add(`${cls}.${method}`);
        } else if (
          ts.isNewExpression(recv) &&
          ts.isIdentifier(recv.expression)
        ) {
          out.add(`${recv.expression.text}.${method}`);
        } else if (recv.kind === ts.SyntaxKind.ThisKeyword) {
          const cls = className(n);
          if (cls) out.add(`${cls}.${method}`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

interface Verdicts {
  credential: Set<string>;
  /** Why a unit is credential: the table it writes, or the unit it calls. */
  why: Map<string, string>;
  writers: Map<string, Set<string>>;
  reaches: (node: ts.Node, file: string) => string | null;
  unitNames: Set<string>;
}

function judge(a: Analysis): Verdicts {
  const byName = new Map<string, Unit[]>();
  for (const u of a.units) {
    byName.set(u.name, [...(byName.get(u.name) ?? []), u]);
  }
  const bindingsByFile = new Map<string, Map<string, string>>();
  for (const [rel, sf] of a.files) bindingsByFile.set(rel, localBindings(sf));

  const resolvable = (n: string) =>
    n.includes(".") ? byName.has(n) : byName.get(n)?.length === 1;

  const writers = new Map<string, Set<string>>();
  const unitCalls = new Map<number, string[]>();
  const credential = new Set<string>();
  const why = new Map<string, string>();
  const guarded = new Set<number>();
  for (const u of a.units) {
    const calls = calledNames(
      u.node,
      bindingsByFile.get(u.file)!,
      a.singletons
    );
    if (calls.has(GUARD_CALL)) guarded.add(u.id);
    unitCalls.set(
      u.id,
      [...calls].filter((c) => c !== u.name && resolvable(c))
    );
    const widened = widenedTables(u.node);
    if (widened.length > 0) {
      const table = widened[0]!;
      for (const t of widened)
        writers.set(t, (writers.get(t) ?? new Set()).add(u.name));
      if (!guarded.has(u.id)) {
        credential.add(u.name);
        if (!why.has(u.name)) why.set(u.name, `writes ${table} (${u.file})`);
      }
    }
  }
  // A write inline in a procedure belongs to no named unit: count its file.
  for (const [rel, sf] of a.files) {
    for (const t of widenedTables(sf))
      writers.set(t, (writers.get(t) ?? new Set()).add(rel));
  }
  // Fixpoint over resolved calls.
  let grew = true;
  while (grew) {
    grew = false;
    for (const u of a.units) {
      if (credential.has(u.name) || guarded.has(u.id)) continue;
      const hit = unitCalls.get(u.id)!.find((c) => credential.has(c));
      if (hit) {
        credential.add(u.name);
        why.set(u.name, hit);
        grew = true;
      }
    }
  }

  /** The credential unit a door's code reaches first, or null. */
  const reaches = (node: ts.Node, file: string): string | null => {
    const direct = widenedTables(node);
    if (direct.length > 0) return `writes ${direct[0]}`;
    const calls = calledNames(node, bindingsByFile.get(file)!, a.singletons);
    for (const c of calls) if (resolvable(c) && credential.has(c)) return c;
    return null;
  };

  return {
    credential,
    why,
    writers,
    reaches,
    unitNames: new Set(a.units.map((u) => u.name)),
  };
}

// ─── Doors ───────────────────────────────────────────────────────────────────

interface Door {
  door: string;
  reaches: string;
}

/** The leftmost identifier of `a.b(...).c(...)`, and every `.use(x)` name. */
function chainOf(expr: ts.Expression): { root: string | null; uses: string[] } {
  const uses: string[] = [];
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isCallExpression(e)) {
      if (
        ts.isPropertyAccessExpression(e.expression) &&
        e.expression.name.text === "use"
      ) {
        for (const arg of e.arguments)
          if (ts.isIdentifier(arg)) uses.push(arg.text);
      }
      e = e.expression;
    } else if (ts.isPropertyAccessExpression(e)) e = e.expression;
    else break;
  }
  return { root: ts.isIdentifier(e) ? e.text : null, uses };
}

function unguardedDoors(a: Analysis, v: Verdicts): Door[] {
  const out: Door[] = [];
  for (const [rel, sf] of a.files) {
    const visit = (node: ts.Node) => {
      // tRPC: router({ name: <builder>...<handler> })
      if (
        ts.isCallExpression(node) &&
        /(^|\.)router$/.test(node.expression.getText()) &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        for (const prop of node.arguments[0].properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const { root, uses } = chainOf(prop.initializer);
          if (!root || !/Procedure$/.test(root)) continue;
          const guarded =
            GUARDED_BUILDERS.has(root) ||
            uses.includes(GUARD_MIDDLEWARE) ||
            calledNames(prop.initializer, new Map(), new Map()).has(GUARD_CALL);
          if (guarded) continue;
          const hit = v.reaches(prop.initializer, rel);
          if (hit) out.push({ door: `${rel} ${nameOf(prop)}`, reaches: hit });
        }
      }
      // Proposal executors: registerProposalExecutor({ key, execute })
      if (
        ts.isCallExpression(node) &&
        node.expression.getText() === "registerProposalExecutor" &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const obj = node.arguments[0];
        const flag = obj.properties.some(
          (p) =>
            ts.isPropertyAssignment(p) &&
            nameOf(p) === "widensCredential" &&
            p.initializer.kind === ts.SyntaxKind.TrueKeyword
        );
        const key = obj.properties.find(
          (p) => ts.isPropertyAssignment(p) && nameOf(p) === "key"
        ) as ts.PropertyAssignment | undefined;
        if (!flag && !calledNames(obj, new Map(), new Map()).has(GUARD_CALL)) {
          const hit = v.reaches(obj, rel);
          if (hit)
            out.push({
              door: `${rel} executor ${key?.initializer.getText() ?? "?"}`,
              reaches: hit,
            });
        }
      }
      // Hono: x.use(path, appSessionMiddleware()) → the whole file;
      //       x.post(path, appSessionMiddleware(), …handlers) → those handlers.
      if (ts.isCallExpression(node)) {
        const idx = node.arguments.findIndex(
          (arg) =>
            ts.isCallExpression(arg) &&
            arg.expression.getText() === "appSessionMiddleware"
        );
        if (idx >= 0) {
          const isUse =
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "use";
          const scopes: ts.Node[] = isUse
            ? [sf]
            : node.arguments.slice(idx + 1);
          for (const scope of scopes) {
            if (calledNames(scope, new Map(), new Map()).has(GUARD_CALL))
              continue;
            const hit = v.reaches(scope, rel);
            if (hit) out.push({ door: `${rel} app route`, reaches: hit });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

// ─── The real code ───────────────────────────────────────────────────────────

const sources = ROOTS.flatMap((root) =>
  walk(join(REPO, root)).map((file) => ({
    rel: relative(REPO, file),
    code: stripComments(readFileSync(file, "utf8"), "ts") as string,
  }))
);
const real = analyse(sources);
const verdicts = judge(real);
const doors = unguardedDoors(real, verdicts);

describe("credential doors refuse a Synap app's device session", () => {
  it("scans the real code (non-vacuity)", () => {
    expect(real.files.size).toBeGreaterThan(400);
    expect(real.units.length).toBeGreaterThan(5000);
  });

  it("every credential table has a writer (the definition is not stale)", () => {
    const silent = Object.keys(CREDENTIAL_TABLES).filter(
      (t) =>
        !verdicts.writers.has(t) && !verdicts.writers.has(CREDENTIAL_TABLES[t]!)
    );
    expect(silent).toEqual([]);
  });

  it("revocations are not widenings; the known mints are credential units", () => {
    // The revocation doors only narrow: they are NOT credential units.
    for (const n of [
      "revokeApiKeys",
      "GrantRepository.revokeForKeys",
      "revokePersonDevice",
    ]) {
      expect(verdicts.unitNames.has(n), n).toBe(true);
      expect(verdicts.credential.has(n), n).toBe(false);
    }
    // Spot-checks that resolution reaches through services, not just raw writes.
    for (const n of [
      "ApiKeyService.generateApiKey",
      "provisionSurfaceAgentKey",
      "decideDeviceRequest",
      "issueAuthorizationCode",
      "attachGrantsOrRevoke",
    ]) {
      expect(verdicts.credential.has(n), n).toBe(true);
    }
  });

  it("POSITIVE CONTROL — an unguarded procedure that mints a key is flagged", () => {
    const sample = analyse([
      ...sources,
      {
        rel: "packages/api/src/routers/__sample__.ts",
        code: `
          export const sampleRouter = router({
            mint: protectedProcedure.mutation(({ ctx }) =>
              apiKeyService.generateApiKey(ctx.userId, "x", [])),
            fine: credentialProcedure.mutation(({ ctx }) =>
              apiKeyService.generateApiKey(ctx.userId, "x", [])),
            alsoFine: protectedProcedure.use(refuseDeviceSession).mutation(({ ctx }) =>
              apiKeyService.generateApiKey(ctx.userId, "x", [])),
            read: protectedProcedure.query(() => 1),
          });
          registerProposalExecutor({ key: "sample/x", async execute() { await attachGrantsOrRevoke({}); } });
          registerProposalExecutor({ key: "sample/y", widensCredential: true, async execute() { await attachGrantsOrRevoke({}); } });
        `,
      },
    ]);
    const flagged = unguardedDoors(sample, judge(sample))
      .filter((d) => d.door.includes("__sample__"))
      .map((d) => d.door);
    expect(flagged.sort()).toEqual([
      'packages/api/src/routers/__sample__.ts executor "sample/x"',
      "packages/api/src/routers/__sample__.ts mint",
    ]);
  });

  it("every door that reaches a credential is guarded", () => {
    // Each line names the chain down to the write, so a red names its path.
    const chain = (start: string) => {
      const out = [start];
      for (let n = start; verdicts.why.has(n) && out.length < 12;) {
        n = verdicts.why.get(n)!;
        out.push(n);
        if (n.startsWith("writes ")) break;
      }
      return out.join(" → ");
    };
    expect(doors.map((d) => `${d.door} → ${chain(d.reaches)}`).sort()).toEqual(
      []
    );
  });
});
