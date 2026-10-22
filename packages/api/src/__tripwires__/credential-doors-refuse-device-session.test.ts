/**
 * TRIPWIRE `credential-doors-refuse-device-session` — no door a Synap app's
 * DEVICE token reaches may create, rotate, widen or approve a CREDENTIAL
 * unless the person REALLY authenticated minutes ago (a step-up).
 *
 * WHY: a device
 * access token (`synap_pd_…`) lives 1 h and is the PERSON on the app API. Any
 * app-API door that writes an API key, a grant, an app's reach, a governance
 * rule, a computer's approval, an OAuth/MCP connection, a refresh family or a
 * secret's grant would let a leaked token become a long-lived credential.
 * Such a door takes a Kratos session, or a device whose person REALLY signed
 * in within the step-up window. The check is ONE predicate
 * (`utils/device-session.ts`), applied by `credentialProcedure` /
 * `.use(requireFreshAuthentication)` (trpc.ts), a proposal executor's
 * `widensCredential` (dispatch), or an explicit `assertFreshAuthentication(ctx)`.
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
 *     `assertFreshAuthentication` is GUARDED and does not propagate.
 *  4. The DOORS a device token reaches: every tRPC procedure (`router({...})`
 *     entries) and every Hono handler mounted with `appSessionMiddleware()`.
 *     A door that reaches a credential unit must be guarded: its builder is
 *     `credentialProcedure`, its chain has `.use(requireFreshAuthentication)`, or its
 *     body calls `assertFreshAuthentication`. A proposal EXECUTOR that reaches one
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
 * `vault_grants` IS one: a grant hands an agent a
 * secret's VALUE. Installing a template or answering a "provide" ask from a
 * Synap app therefore asks for a fresh sign-in, only when a grant is written.
 * So is everything that turns a 1 h token into LASTING access for someone:
 * an invitation (`invites`, `admin_invitations`), a membership or a role in a
 * space or a project (`workspace_members`, `project_members`), a webhook that
 * keeps delivering (`webhook_subscriptions`), and a share of a secret or of
 * a resource (`secret_shares`, `resource_shares`).
 */
const CREDENTIAL_TABLES: Record<string, string> = {
  apiKeys: "api_keys",
  grants: "grants",
  governanceRules: "governance_rules",
  apps: "apps",
  vaultGrants: "vault_grants",
  trustedIssuers: "trusted_issuers",
  deviceAuthRequests: "device_auth_requests",
  mcpConnectCodes: "mcp_connect_codes",
  oauthAuthorizationCodes: "oauth_authorization_codes",
  oauthRefreshTokens: "oauth_refresh_tokens",
  personDevices: "person_devices",
  personDeviceTokens: "person_device_tokens",
  invites: "invites",
  workspaceMembers: "workspace_members",
  projectMembers: "project_members",
  webhookSubscriptions: "webhook_subscriptions",
  secretShares: "secret_shares",
  resourceShares: "resource_shares",
};

/**
 * Reading a secret's VALUE is a credential act too: a door that decrypts in
 * its own body and may hand the plaintext back (`secrets.reveal`). Matched
 * as a direct call whose name starts with `decrypt`. A door that decrypts
 * only to USE the value (call a provider, sign a request) and never returns
 * it is classified here, with why — a new one must be classified to pass.
 */
const SECRET_READ_CALL = /^decrypt/;

/**
 * Credential tables NO pod code writes today (only their schema exists).
 * Asserted writer-less below: the day one gains a writer, it must move into
 * `CREDENTIAL_TABLES`.
 */
const CREDENTIAL_TABLES_UNWRITTEN: Record<string, string> = {
  adminInvitations: "admin_invitations",
};

/**
 * Writers of a credential table that give NO person lasting access, with
 * why. They stop the propagation to the doors that call them.
 */
const EXEMPT_WRITERS: Record<string, string> = {
  ensureAgentUser:
    "the pod's own built-in agent joins the space a person talks to it in; it adds no person and no key, and is a no-op once the agent is a member",
};

/** Builders that authenticate an `api_keys` row: a device token never passes. */
const KEY_ONLY_BUILDERS = new Set(["apiKeyProcedure", "scopedProcedure"]);
const DECRYPTS_WITHOUT_RETURNING: Record<string, string> = {};

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
  // A publication taken back to draft: nothing is exposed any more.
  "draft",
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

const GUARD_CALL = "assertFreshAuthentication";
const GUARDED_BUILDERS = new Set(["credentialProcedure"]);
const GUARD_MIDDLEWARE = "requireFreshAuthentication";

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
    const rawArg = ts.isCallExpression(n) ? n.arguments[0] : undefined;
    // `.insert(t)` or through a namespace, `.insert(schema.t)`.
    const arg =
      rawArg && ts.isPropertyAccessExpression(rawArg) ? rawArg.name : rawArg;
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
        const setArg = localObject(
          access &&
            ts.isPropertyAccessExpression(access) &&
            access.name.text === "set" &&
            setCall &&
            ts.isCallExpression(setCall)
            ? setCall.arguments[0]
            : undefined
        );
        const ends =
          !!setArg &&
          ts.isObjectLiteralExpression(setArg) &&
          setArg.properties.some(
            (p) =>
              ts.isPropertyAssignment(p) &&
              (nameOf(p) === "status" || nameOf(p) === "state") &&
              ENDING_STATUSES.has(stringValue(p.initializer) ?? "")
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

/** A string literal's text, through `as const`; else null. */
function stringValue(e: ts.Expression): string | null {
  const inner = ts.isAsExpression(e) ? e.expression : e;
  return ts.isStringLiteral(inner) ? inner.text : null;
}

/**
 * `.set(revoke)` where `const revoke = {...}` sits in an enclosing block: the
 * literal, so its columns are judged too. Anything else is returned as is.
 */
function localObject(arg: ts.Expression | undefined): ts.Expression | undefined {
  if (!arg || !ts.isIdentifier(arg)) return arg;
  for (let p: ts.Node | undefined = arg.parent; p; p = p.parent) {
    if (!ts.isBlock(p) && !ts.isSourceFile(p)) continue;
    for (const st of p.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.name.text === arg.text &&
          d.initializer &&
          ts.isObjectLiteralExpression(d.initializer)
        ) {
          return d.initializer;
        }
      }
    }
  }
  return arg;
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
    const widened = u.name in EXEMPT_WRITERS ? [] : widenedTables(u.node);
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
      if (u.name in EXEMPT_WRITERS) continue;
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

/** Is this expression a tRPC procedure: `<x>Procedure…​.query|mutation(…)`? */
function isProcedure(expr: ts.Expression): boolean {
  const { root } = chainOf(expr);
  if (!root || !/Procedure$/.test(root)) return false;
  for (let e: ts.Expression = expr; ts.isCallExpression(e); ) {
    const callee = e.expression;
    if (!ts.isPropertyAccessExpression(callee)) break;
    if (/^(query|mutation|subscription)$/.test(callee.name.text)) return true;
    e = callee.expression;
  }
  return false;
}

/** The `decrypt…` a subtree calls directly, or null. */
function secretRead(node: ts.Node): string | null {
  let hit: string | null = null;
  const visit = (n: ts.Node) => {
    if (hit) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name && SECRET_READ_CALL.test(name)) hit = name;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

interface DoorVerdict extends Door {
  /** What it reaches (a credential write, or a secret read), or "". */
  reaches: string;
  guarded: boolean;
}

/**
 * Every door a device token can reach, with what it reaches and whether it
 * is guarded. A tRPC procedure is found WHEREVER it is defined — inside
 * `router({...})`, bound to a const (`const send = protectedProcedure…`,
 * then `router({ send })`), or in an object of procedures spread into a
 * router — because each is a procedure chain on its own.
 */
function doorsOf(a: Analysis, v: Verdicts): DoorVerdict[] {
  const out: DoorVerdict[] = [];
  for (const [rel, sf] of a.files) {
    const visit = (node: ts.Node) => {
      // tRPC: any `name: <builder>…` or `const name = <builder>…`.
      if (
        (ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) &&
        node.initializer &&
        isProcedure(node.initializer)
      ) {
        const init = node.initializer;
        const { root, uses } = chainOf(init);
        const door = `${rel} ${nameOf(node)}`;
        if (KEY_ONLY_BUILDERS.has(root!)) {
          ts.forEachChild(node, visit);
          return;
        }
        const guarded =
          GUARDED_BUILDERS.has(root!) ||
          uses.includes(GUARD_MIDDLEWARE) ||
          calledNames(init, new Map(), new Map()).has(GUARD_CALL);
        const read = secretRead(init);
        const reaches =
          v.reaches(init, rel) ??
          (read && !(door in DECRYPTS_WITHOUT_RETURNING)
            ? `reads a secret value (${read})`
            : null);
        out.push({ door, reaches: reaches ?? "", guarded });
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
        out.push({
          door: `${rel} executor ${key?.initializer.getText() ?? "?"}`,
          reaches: v.reaches(obj, rel) ?? "",
          guarded:
            flag || calledNames(obj, new Map(), new Map()).has(GUARD_CALL),
        });
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
            out.push({
              door: `${rel} app route`,
              reaches: v.reaches(scope, rel) ?? "",
              guarded: calledNames(scope, new Map(), new Map()).has(GUARD_CALL),
            });
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
const allDoors = doorsOf(real, verdicts);
const unguarded = (ds: DoorVerdict[]) =>
  ds.filter((d) => d.reaches && !d.guarded);
const doors = unguarded(allDoors);

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

  it("an unwritten credential table stays unwritten; every exemption still exists", () => {
    for (const [t, sqlName] of Object.entries(CREDENTIAL_TABLES_UNWRITTEN)) {
      expect(
        verdicts.writers.has(t) || verdicts.writers.has(sqlName),
        `${t} now has a writer: move it into CREDENTIAL_TABLES`
      ).toBe(false);
    }
    for (const n of Object.keys(EXEMPT_WRITERS)) {
      expect(verdicts.unitNames.has(n), n).toBe(true);
    }
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
    // Self-contained (a mint, a grant writer, a singleton), so the control
    // exercises write detection, singleton method resolution, the builder and
    // `.use` guards and the executor flag, in milliseconds.
    const sample = analyse([
      {
        rel: "packages/api/src/services/__sample_mint__.ts",
        code: `
          class ApiKeyService {
            async generateApiKey(userId, name, scopes) {
              return db.insert(apiKeys).values({ userId, name, scopes });
            }
          }
          export const apiKeyService = new ApiKeyService();
          export async function attachGrantsOrRevoke(input) {
            await db.insert(grants).values(input);
          }
          export async function revokeEverything(id) {
            await db.update(apiKeys).set({ isActive: false, revokedAt: new Date() });
          }
        `,
      },
      {
        rel: "packages/api/src/routers/__sample__.ts",
        code: `
          export const sampleRouter = router({
            narrowOnly: protectedProcedure.mutation(() => revokeEverything("k")),
            mint: protectedProcedure.mutation(({ ctx }) =>
              apiKeyService.generateApiKey(ctx.userId, "x", [])),
            fine: credentialProcedure.mutation(({ ctx }) =>
              apiKeyService.generateApiKey(ctx.userId, "x", [])),
            alsoFine: protectedProcedure.use(requireFreshAuthentication).mutation(({ ctx }) =>
              apiKeyService.generateApiKey(ctx.userId, "x", [])),
            read: protectedProcedure.query(() => 1),
          });
          registerProposalExecutor({ key: "sample/x", async execute() { await attachGrantsOrRevoke({}); } });
          registerProposalExecutor({ key: "sample/y", widensCredential: true, async execute() { await attachGrantsOrRevoke({}); } });
        `,
      },
    ]);
    const flagged = unguarded(doorsOf(sample, judge(sample)))
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
