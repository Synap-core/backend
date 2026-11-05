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
 *  5. HUB REST (`/api/hub/*`) accepts the device token as the person too, so
 *     its routes are doors: every route registered on a `HubHono` app under
 *     `routers/hub-protocol/` (and `hub-protocol-rest.ts`), except the paths
 *     the auth middleware never authenticates (`hubAuthSkipped`, the ONE list
 *     it reads). A Hub route is guarded when its handler calls
 *     `refuseStaleDeviceSession` (itself checked to call
 *     `assertFreshAuthentication`). The hub router's own `scopedProcedure`s,
 *     reached from those routes through `getCaller`, are doors as well. A call
 *     on a tRPC caller (`x.createCaller(…)`, `getCaller(…)`) enters a
 *     procedure, which this scan judges as its own door; it is not resolved
 *     by name from the route.
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
import { hubAuthSkipped } from "../routers/hub-protocol/_middleware/auth-skip.js";

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
  // A person's approval of a key a CLI asked for (keys plan Decision 4): the
  // CLI collects a key with it.
  keyRequests: "key_requests",
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
  // A personal ICS feed URL: its token is the capability, and it keeps
  // serving every calendar entity the person reads after the token that
  // minted it has expired (`rest/calendar-feed.ts`).
  calendarFeedTokens: "calendar_feed_tokens",
  // Recovery codes take the ACCOUNT over (`/api/account-recovery/codes`).
  accountRecoveryCodes: "account_recovery_codes",
};

/**
 * Reading a secret's VALUE is a credential act too: a door that decrypts in
 * its own body and may hand the plaintext back (`secrets.reveal`), or calls
 * the vault's one resolver (`resolveVaultSecret`, which returns the
 * plaintext: Hub `POST /vault/redeem`). Matched as a direct call whose name
 * starts with `decrypt`, or is `resolveVaultSecret`. A door that decrypts
 * only to USE the value (call a provider, sign a request) and never returns
 * it is classified here, with why — a new one must be classified to pass.
 */
const SECRET_READ_CALL = /^(decrypt|resolveVaultSecret$)/;

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
  materializePodAdminsIntoWorkspace:
    "adds only the people who already administer the whole pod to a space they could already administer; it gives no one access they did not hold",
  resolveCaptureActorUserId:
    "enrolls only the pod's own built-in Capture agent (`getCaptureAgentUserId`) into the space the caller's own write targets, so its governed capture writes reach the ladder; it adds no person and no key",
};

/**
 * Doors whose only credential write gives access to the CALLER and no one
 * else: a leaked token turns into nothing an attacker keeps, because what is
 * granted is the person's own membership, read through the person's own
 * (revocable) sign-ins. Each names everything it may reach; reaching anything
 * else (a key, an invitation, someone else's membership) fails the scan. And
 * its input must name no OTHER principal (`PRINCIPAL_INPUT_KEY`): a door that
 * takes a user, member, email or target from its input can grant someone
 * else, so it is not a self-grant and needs the step-up.
 */
/** An input key that can name a principal other than the caller. */
const PRINCIPAL_INPUT_KEY =
  /(user|member|grantee|target|principal|recipient|invitee|owner|person|account|identity|subject|agent)s?(Id|Ids|Email)?$|email|^to$|^for$/i;

const SELF_GRANT_DOORS: Record<string, { reaches: string[]; why: string }> = {
  "packages/api/src/routers/workspaces.ts create": {
    reaches: ["WorkspaceMemberRepository.add"],
    why: "the caller becomes the owner of the space they just made",
  },
  "packages/api/src/routers/workspaces/invites.ts acceptInvite": {
    // backend#53 moved the membership write into the one accept door
    // `acceptInviteFor` (shared with the console's /setup/accept-invite),
    // which adds only the user it is handed: here `ctx.userId`.
    reaches: ["acceptInviteFor"],
    why: "the caller joins with an invitation addressed to their own email",
  },
  "packages/api/src/routers/shares.ts redeemLink": {
    reaches: ["redeemLink"],
    why: "the caller redeems a link for themselves",
  },
};

/**
 * Doors that MUST be seen by the scan and guarded: the obvious ways to turn a
 * token into lasting authority. If the analyzer stops finding one (a rename,
 * a new indirection it cannot follow), this fails instead of going quiet.
 */
const KNOWN_CREDENTIAL_DOORS = [
  "packages/api/src/routers/api-keys.ts create",
  "packages/api/src/routers/api-keys.ts decideKeyRequest",
  "packages/api/src/routers/apps.ts create",
  'packages/api/src/routers/proposals/executors/app.ts executor "app/connect"',
  "packages/api/src/routers/governance-rules.ts create",
  "packages/api/src/routers/secrets-vault.ts reveal",
  "packages/api/src/routers/workspaces/invites.ts createInvite",
  "packages/api/src/routers/workspaces/invites.ts addMember",
  "packages/api/src/routers/webhooks.ts create",
  // An inbound webhook source's secret fires a space's automations (0362).
  "packages/api/src/routers/webhooks.ts adminCreateInboundSource",
  "packages/api/src/routers/webhooks.ts adminRotateInboundSourceSecret",
  "packages/api/src/routers/shares.ts share",
];

/**
 * Hub REST routes that MUST be seen as doors and guarded (the same promise as
 * `KNOWN_CREDENTIAL_DOORS`, for the Hub twin).
 */
const KNOWN_HUB_CREDENTIAL_DOORS = [
  "packages/api/src/routers/hub-protocol/rest/keys.ts POST /keys/rotate-cli",
  "packages/api/src/routers/hub-protocol/rest/apps.ts POST /apps",
  "packages/api/src/routers/hub-protocol/rest/agent-users.ts POST /agent-users",
  "packages/api/src/routers/hub-protocol/rest/webhooks.ts POST /webhooks",
  "packages/api/src/routers/hub-protocol/rest/shares.ts POST /shares",
  // Hands a secret's plaintext back (`resolveVaultSecret`).
  "packages/api/src/routers/hub-protocol/rest/vault.ts POST /vault/redeem",
  // Mint a bearer ICS URL that outlives the token.
  "packages/api/src/routers/hub-protocol/rest/calendar-feed.ts POST /calendar/feed",
  "packages/api/src/routers/hub-protocol/rest/calendar-feed.ts POST /calendar/feed/rotate",
  // A tRPC door that returns a secret's plaintext.
  "packages/api/src/routers/devplane.ts resolveEntitySecret",
  // Account recovery, reached through its deps' `appSessionMiddleware()`.
  "apps/api/src/routers/account-recovery.ts POST /codes",
];
/** At least this many Hub REST routes are scanned (the real count is higher). */
const HUB_ROUTE_FLOOR = 400;

/** At least this many guarded doors reach a credential (the real count is higher). */
const GUARDED_DOOR_FLOOR = 70;

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
  "lastAccessedAt",
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
/** The Hub REST guard (rest/_shared.ts); it must call `GUARD_CALL`. */
const HUB_GUARD_CALL = "refuseStaleDeviceSession";
/** Where the Hub REST routes and the hub tRPC router live. */
const HUB_DIR = "packages/api/src/routers/hub-protocol/";
const HUB_ROOT_FILE = "packages/api/src/routers/hub-protocol-rest.ts";
const isHubFile = (rel: string) =>
  rel.startsWith(HUB_DIR) || rel === HUB_ROOT_FILE;
/** The Hono methods a Hub route is registered with. */
const HUB_ROUTE_METHODS = /^(get|post|put|patch|delete|openapi)$/;
const GUARDED_BUILDERS = new Set(["credentialProcedure"]);
/**
 * A door outside tRPC and Hub REST whose own check is the step-up, with why.
 * Each must exist (checked below).
 */
const EQUIVALENT_GUARDS: Record<string, string> = {
  guardCredentialChange:
    "apps/api/src/routers/account-recovery.ts: refuses a session that is not privileged; a device session is privileged only while its step-up clock is within the 15-min privileged window (`sessionMarks`, account-recovery/policy.ts)",
};
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
function localObject(
  arg: ts.Expression | undefined
): ts.Expression | undefined {
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

/** The leftmost identifier of a receiver chain `a.b.c`, or null. */
function rootIdentifier(e: ts.Expression): string | null {
  while (ts.isPropertyAccessExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e.text : null;
}

/**
 * The names a subtree calls, resolved to candidate unit names. A method call
 * whose receiver chain starts at a name in `skipReceivers` is not collected.
 */
function calledNames(
  node: ts.Node,
  bindings: Map<string, string>,
  singletons: Map<string, string>,
  skipReceivers: ReadonlySet<string> = new Set()
): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee)) out.add(callee.text);
      else if (
        ts.isPropertyAccessExpression(callee) &&
        skipReceivers.has(rootIdentifier(callee.expression) ?? "")
      ) {
        // A call into a tRPC caller: the procedure is its own door.
      } else if (ts.isPropertyAccessExpression(callee)) {
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
  reaches: (
    node: ts.Node,
    file: string,
    skipReceivers?: ReadonlySet<string>
  ) => string | null;
  /** Every credential write and credential unit a door's code reaches. */
  reachesAll: (
    node: ts.Node,
    file: string,
    skipReceivers?: ReadonlySet<string>
  ) => string[];
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
  const reaches = (
    node: ts.Node,
    file: string,
    skipReceivers?: ReadonlySet<string>
  ): string | null => {
    const direct = widenedTables(node);
    if (direct.length > 0) return `writes ${direct[0]}`;
    const calls = calledNames(
      node,
      bindingsByFile.get(file)!,
      a.singletons,
      skipReceivers
    );
    for (const c of calls) if (resolvable(c) && credential.has(c)) return c;
    return null;
  };

  const reachesAll = (
    node: ts.Node,
    file: string,
    skipReceivers?: ReadonlySet<string>
  ): string[] => {
    const out = widenedTables(node).map((t) => `writes ${t}`);
    const calls = calledNames(
      node,
      bindingsByFile.get(file)!,
      a.singletons,
      skipReceivers
    );
    for (const c of calls) if (resolvable(c) && credential.has(c)) out.push(c);
    return [...new Set(out)].sort();
  };

  return {
    credential,
    why,
    writers,
    reaches,
    reachesAll,
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

/** Is this expression a tRPC procedure: `<x>Procedure….query|mutation(…)`? */
function isProcedure(expr: ts.Expression): boolean {
  const { root } = chainOf(expr);
  if (!root || !/Procedure$/.test(root)) return false;
  for (let e: ts.Expression = expr; ts.isCallExpression(e);) {
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
  /** Everything it reaches; "" entries never. */
  reachesAll: string[];
  guarded: boolean;
  /**
   * Every property name in its `.input(...)` schemas, or null when an input
   * could not be read (a schema from elsewhere): then nothing is proven.
   */
  inputKeys?: string[] | null;
}

/**
 * The property names a procedure's `.input(...)` schemas declare, read from
 * the AST (an object literal, or a const bound to one in the same file), or
 * null when one is not readable here.
 */
function inputKeysOf(expr: ts.Expression): string[] | null {
  const keys: string[] = [];
  let opaque = false;
  const collect = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) {
      const k = nameOf(n);
      if (k) keys.push(k);
    }
    ts.forEachChild(n, collect);
  };
  for (let e: ts.Expression = expr; ;) {
    if (ts.isCallExpression(e)) {
      if (
        ts.isPropertyAccessExpression(e.expression) &&
        e.expression.name.text === "input"
      ) {
        for (const arg of e.arguments) {
          const local = localObjectSchema(arg);
          if (local) collect(local);
          else opaque = true;
        }
      }
      e = e.expression;
    } else if (ts.isPropertyAccessExpression(e)) e = e.expression;
    else break;
  }
  return opaque ? null : keys;
}

/**
 * An input schema readable here: an inline expression with no bare
 * identifier as its root, or a const in an enclosing scope bound to one.
 */
function localObjectSchema(arg: ts.Expression): ts.Node | null {
  if (!ts.isIdentifier(arg)) return arg;
  for (let p: ts.Node | undefined = arg.parent; p; p = p.parent) {
    if (!ts.isBlock(p) && !ts.isSourceFile(p)) continue;
    for (const st of p.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.name.text === arg.text &&
          d.initializer
        ) {
          return d.initializer;
        }
      }
    }
  }
  return null;
}

/** Is `name` declared, in an enclosing scope of `at`, with type `HubHono`? */
function isHubHonoName(name: string, at: ts.Node): boolean {
  for (let p: ts.Node | undefined = at.parent; p; p = p.parent) {
    const decls: ts.Node[] = [];
    if (ts.isFunctionLike(p)) decls.push(...p.parameters);
    if (ts.isBlock(p) || ts.isSourceFile(p)) {
      for (const st of p.statements)
        if (ts.isVariableStatement(st))
          decls.push(...st.declarationList.declarations);
    }
    for (const d of decls) {
      if (
        (ts.isParameter(d) || ts.isVariableDeclaration(d)) &&
        ts.isIdentifier(d.name) &&
        d.name.text === name
      ) {
        return d.type?.getText() === "HubHono";
      }
    }
  }
  return false;
}

/** A string literal's text (plain or no-substitution template), else null. */
function literalText(e: ts.Node | undefined): string | null {
  return e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
    ? e.text
    : null;
}

/** An identifier's initializer when a const in the same file binds it; else `e`. */
function constValue(e: ts.Expression): ts.Expression {
  if (!ts.isIdentifier(e)) return e;
  let found: ts.Expression | undefined;
  const find = (n: ts.Node) => {
    if (
      !found &&
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === e.text &&
      n.initializer
    )
      found = n.initializer;
    ts.forEachChild(n, find);
  };
  find(e.getSourceFile());
  return found ?? e;
}

/** `createRoute({ method, path })` — inline, or a const bound to one in the file. */
function openapiRouteOf(
  arg: ts.Expression,
  sf: ts.SourceFile
): { method: string | null; path: string | null } {
  let e: ts.Expression | undefined = arg;
  if (ts.isIdentifier(arg)) {
    e = undefined;
    const find = (n: ts.Node) => {
      if (
        !e &&
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === arg.text
      )
        e = n.initializer;
      ts.forEachChild(n, find);
    };
    find(sf);
  }
  const obj =
    e && ts.isCallExpression(e) ? e.arguments[0] : (e as ts.Node | undefined);
  if (!obj || !ts.isObjectLiteralExpression(obj))
    return { method: null, path: null };
  const prop = (k: string) =>
    literalText(
      (
        obj.properties.find(
          (p) => ts.isPropertyAssignment(p) && nameOf(p) === k
        ) as ts.PropertyAssignment | undefined
      )?.initializer
    );
  return { method: prop("method"), path: prop("path") };
}

/**
 * A Hub REST route registration: its method, path (`:param` form; "?" when
 * not readable, which is never skipped), its handler arguments, and whether
 * the auth middleware skips its path (then no credential reaches it).
 */
function hubRouteOf(node: ts.Node): {
  method: string;
  path: string;
  handlers: ts.Node[];
  skipped: boolean;
} | null {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !HUB_ROUTE_METHODS.test(node.expression.name.text) ||
    !ts.isIdentifier(node.expression.expression) ||
    !isHubHonoName(node.expression.expression.text, node)
  )
    return null;
  const verb = node.expression.name.text;
  const first = node.arguments[0];
  if (!first) return null;
  const route =
    verb === "openapi"
      ? openapiRouteOf(first, node.getSourceFile())
      : { method: verb, path: literalText(constValue(first)) };
  const path = route.path?.replace(/\{(\w+)\}/g, ":$1") ?? "?";
  const sample = path.replace(/:\w+/g, "x");
  return {
    method: (route.method ?? "?").toUpperCase(),
    path,
    handlers: node.arguments.slice(1),
    skipped: route.path !== null && hubAuthSkipped(`/api/hub${sample}`),
  };
}

/**
 * Per file: the paths a router guards with a deps middleware list that the
 * real deps fill with `appSessionMiddleware()`. Derived in three steps: (1) a
 * variable typed `T` whose object literal has a property `p` = an array
 * holding `appSessionMiddleware()`; (2) the file that declares `interface T`;
 * (3) in it, `x.use("<path>", ...<any>.p)`.
 */
function deviceWiredPaths(a: Analysis): Map<string, Set<string>> {
  const wiredProps = new Map<string, Set<string>>(); // T → props
  const declaredIn = new Map<string, string>(); // T → file
  for (const [rel, sf] of a.files) {
    const visit = (n: ts.Node) => {
      if (ts.isInterfaceDeclaration(n)) declaredIn.set(n.name.text, rel);
      if (
        ts.isVariableDeclaration(n) &&
        n.type &&
        n.initializer &&
        ts.isObjectLiteralExpression(n.initializer)
      ) {
        for (const prop of n.initializer.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            ts.isArrayLiteralExpression(prop.initializer) &&
            prop.initializer.elements.some(
              (e) =>
                ts.isCallExpression(e) &&
                e.expression.getText() === "appSessionMiddleware"
            )
          ) {
            const t = n.type.getText();
            wiredProps.set(
              t,
              (wiredProps.get(t) ?? new Set()).add(nameOf(prop)!)
            );
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const out = new Map<string, Set<string>>();
  for (const [t, props] of wiredProps) {
    const rel = declaredIn.get(t);
    if (!rel) continue;
    const paths = new Set<string>();
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "use"
      ) {
        const path = literalText(n.arguments[0]);
        const wires = n.arguments
          .slice(1)
          .some(
            (arg) =>
              ts.isSpreadElement(arg) &&
              ts.isPropertyAccessExpression(arg.expression) &&
              props.has(arg.expression.name.text)
          );
        if (path && wires) paths.add(path);
      }
      ts.forEachChild(n, visit);
    };
    visit(a.files.get(rel)!);
    out.set(rel, paths);
  }
  return out;
}

/** A route `x.<method>("<path>", …handlers)` whose path is device-wired. */
function depsWiredRoute(
  node: ts.Node,
  paths: Set<string> | undefined
): { method: string; path: string; handlers: ts.Node[] } | null {
  if (
    !paths ||
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !/^(get|post|put|patch|delete)$/.test(node.expression.name.text)
  )
    return null;
  const path = literalText(node.arguments[0]);
  if (!path || !paths.has(path)) return null;
  return {
    method: node.expression.name.text.toUpperCase(),
    path,
    handlers: node.arguments.slice(1),
  };
}

/**
 * The names bound in `scope` to a tRPC caller (`x.createCaller(…)`, or
 * `getCaller(…)`, awaited or not): a call on one enters a procedure.
 */
function trpcCallerNames(scope: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer
    ) {
      let init: ts.Expression = n.initializer;
      while (ts.isAwaitExpression(init) || ts.isParenthesizedExpression(init))
        init = init.expression;
      if (ts.isCallExpression(init)) {
        const callee = init.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : null;
        if (name === "createCaller" || name === "getCaller")
          out.add(n.name.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return out;
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
  const depsWired = deviceWiredPaths(a);
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
        // A key-only builder keeps a device out, except in the hub router,
        // which Hub REST reaches through `getCaller` for a device too.
        if (KEY_ONLY_BUILDERS.has(root!) && !isHubFile(rel)) {
          ts.forEachChild(node, visit);
          return;
        }
        const guarded =
          GUARDED_BUILDERS.has(root!) ||
          uses.includes(GUARD_MIDDLEWARE) ||
          calledNames(init, new Map(), new Map()).has(GUARD_CALL);
        const read = secretRead(init);
        const readsSecret =
          read && !(door in DECRYPTS_WITHOUT_RETURNING)
            ? `reads a secret value (${read})`
            : null;
        const reaches = v.reaches(init, rel) ?? readsSecret;
        const reachesAll = v.reachesAll(init, rel);
        if (readsSecret) reachesAll.push(readsSecret);
        out.push({
          door,
          reaches: reaches ?? "",
          reachesAll,
          guarded,
          inputKeys: inputKeysOf(init),
        });
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
          reachesAll: v.reachesAll(obj, rel),
          guarded:
            flag || calledNames(obj, new Map(), new Map()).has(GUARD_CALL),
        });
      }
      // Hub REST: <app: HubHono>.<method>(route, …handlers), unless the auth
      // middleware never authenticates its path.
      const hub = isHubFile(rel) ? hubRouteOf(node) : null;
      if (hub && !hub.skipped) {
        for (const scope of hub.handlers) {
          const callers = trpcCallerNames(scope);
          const door = `${rel} ${hub.method} ${hub.path}`;
          const read = secretRead(scope);
          const readsSecret =
            read && !(door in DECRYPTS_WITHOUT_RETURNING)
              ? `reads a secret value (${read})`
              : null;
          const reachesAll = v.reachesAll(scope, rel, callers);
          if (readsSecret) reachesAll.push(readsSecret);
          out.push({
            door,
            reaches: v.reaches(scope, rel, callers) ?? readsSecret ?? "",
            reachesAll,
            guarded: calledNames(scope, new Map(), new Map()).has(
              HUB_GUARD_CALL
            ),
          });
        }
      }
      // A router whose deps wire `appSessionMiddleware()` into a middleware
      // list: `x.use("<path>", ...deps.<list>)` makes `<path>`'s handlers
      // doors (account recovery).
      const wired = depsWiredRoute(node, depsWired.get(rel));
      if (wired) {
        for (const scope of wired.handlers) {
          const door = `${rel} ${wired.method} ${wired.path}`;
          const read = secretRead(scope);
          const reachesAll = v.reachesAll(scope, rel);
          if (read) reachesAll.push(`reads a secret value (${read})`);
          const called = calledNames(scope, new Map(), new Map());
          out.push({
            door,
            reaches:
              v.reaches(scope, rel) ??
              (read ? `reads a secret value (${read})` : ""),
            reachesAll,
            guarded:
              called.has(GUARD_CALL) ||
              Object.keys(EQUIVALENT_GUARDS).some((g) => called.has(g)),
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
            out.push({
              door: `${rel} app route`,
              reaches: v.reaches(scope, rel) ?? "",
              reachesAll: v.reachesAll(scope, rel),
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
/** A self-grant door that reaches only what it declares. */
/** Input keys that could name someone other than the caller; null = unreadable. */
const principalInputs = (d: DoorVerdict): string[] | null =>
  d.inputKeys ? d.inputKeys.filter((k) => PRINCIPAL_INPUT_KEY.test(k)) : null;

/** A self-grant door that reaches only what it declares and names no one else. */
const isDeclaredSelfGrant = (d: DoorVerdict) => {
  const declared = SELF_GRANT_DOORS[d.door];
  return (
    !!declared &&
    d.reachesAll.every((r) => declared.reaches.includes(r)) &&
    principalInputs(d)?.length === 0
  );
};
const unguarded = (ds: DoorVerdict[]) =>
  ds.filter((d) => d.reaches && !d.guarded && !isDeclaredSelfGrant(d));
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

  it("the known credential doors are seen and guarded, above a floor", () => {
    const seen = new Map(allDoors.map((d) => [d.door, d]));
    for (const name of KNOWN_CREDENTIAL_DOORS) {
      const d = seen.get(name);
      expect(d, `${name} is no longer seen by the scan`).toBeDefined();
      expect(d!.reaches, `${name} no longer reaches a credential`).not.toBe("");
      expect(d!.guarded, `${name} is not guarded`).toBe(true);
    }
    // Procedures bound to a const and mounted by shorthand are doors too.
    for (const name of [
      "packages/api/src/routers/channels/send-message.ts sendMessageProcedure",
      "packages/api/src/routers/channels/route-choice.ts answerRouteChoiceProcedure",
    ]) {
      expect(seen.has(name), `${name} is not seen as a door`).toBe(true);
    }
    const guardedDoors = allDoors.filter((d) => d.reaches && d.guarded);
    expect(guardedDoors.length).toBeGreaterThanOrEqual(GUARDED_DOOR_FLOOR);
  });

  it("every self-grant door exists, reaches only what it declares, and its input names no one else", () => {
    const seen = new Map(allDoors.map((d) => [d.door, d]));
    for (const [name, declared] of Object.entries(SELF_GRANT_DOORS)) {
      const d = seen.get(name);
      expect(d, `${name} is no longer seen by the scan`).toBeDefined();
      expect(d!.reachesAll, name).toEqual(declared.reaches);
      expect(
        principalInputs(d!),
        `${name}: its input must be readable and name no other principal`
      ).toEqual([]);
      // Non-vacuity: the input WAS read (each takes at least one field).
      expect(d!.inputKeys!.length, name).toBeGreaterThan(0);
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
            reveal: protectedProcedure.mutation(() => decryptServerSide("x")),
            send,
          });
          const send = protectedProcedure.mutation(({ ctx }) =>
            apiKeyService.generateApiKey(ctx.userId, "x", []));
          const sendFine = credentialProcedure.mutation(({ ctx }) =>
            apiKeyService.generateApiKey(ctx.userId, "x", []));
          export const otherRouter = router({ sendFine });
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
      "packages/api/src/routers/__sample__.ts reveal",
      "packages/api/src/routers/__sample__.ts send",
    ]);
  });

  it("POSITIVE CONTROL — a self-grant door that reaches more than it declares is flagged", () => {
    const [name, declared] = Object.entries(SELF_GRANT_DOORS)[0]!;
    const door = (reachesAll: string[]): DoorVerdict => ({
      door: name,
      reaches: reachesAll[0]!,
      reachesAll,
      guarded: false,
      inputKeys: ["token"],
    });
    expect(unguarded([door(declared.reaches)])).toEqual([]);
    expect(
      unguarded([door([...declared.reaches, "ApiKeyService.generateApiKey"])])
    ).toHaveLength(1);
  });

  it("POSITIVE CONTROL — a self-grant whose input names a target user is flagged", () => {
    const sample = analyse([
      {
        rel: "packages/api/src/routers/__sample_self__.ts",
        code: `
          const memberInput = z.object({ workspaceId: z.string(), targetUserId: z.string() });
          export const r = router({
            joinOther: protectedProcedure.input(memberInput).mutation(() => 1),
            joinSelf: protectedProcedure.input(z.object({ token: z.string() })).mutation(() => 1),
            opaque: protectedProcedure.input(importedSchema).mutation(() => 1),
          });
        `,
      },
    ]);
    const byName = new Map(
      doorsOf(sample, judge(sample)).map((d) => [d.door.split(" ")[1], d])
    );
    expect(principalInputs(byName.get("joinOther")!)).toEqual(["targetUserId"]);
    expect(principalInputs(byName.get("joinSelf")!)).toEqual([]);
    expect(principalInputs(byName.get("opaque")!)).toBeNull();
    // Declared as a self-grant, a door taking a target is still unguarded.
    const [name, declared] = Object.entries(SELF_GRANT_DOORS)[0]!;
    const asDeclared = (inputKeys: string[] | null): DoorVerdict => ({
      door: name,
      reaches: declared.reaches[0]!,
      reachesAll: declared.reaches,
      guarded: false,
      inputKeys,
    });
    expect(unguarded([asDeclared(["token"])])).toEqual([]);
    expect(unguarded([asDeclared(["token", "userId"])])).toHaveLength(1);
    expect(unguarded([asDeclared(null)])).toHaveLength(1);
  });

  it("the Hub REST routes are doors: seen, the auth-skipped ones left out, the known ones guarded", () => {
    const hubDoors = allDoors.filter((d) =>
      d.door.startsWith("packages/api/src/routers/hub-protocol")
    );
    const routes = hubDoors.filter((d) =>
      / (GET|POST|PUT|PATCH|DELETE|\?) /.test(d.door)
    );
    expect(routes.length).toBeGreaterThan(HUB_ROUTE_FLOOR);
    // Nearly every path is read; an unreadable one ("?", a path built at run
    // time) is still a door, never skipped (the positive control below).
    expect(routes.filter((d) => / \?$/.test(d.door)).length).toBeLessThan(10);
    const seen = new Map(allDoors.map((d) => [d.door, d]));
    for (const name of KNOWN_HUB_CREDENTIAL_DOORS) {
      const d = seen.get(name);
      expect(d, `${name} is no longer seen by the scan`).toBeDefined();
      expect(d!.reaches, `${name} no longer reaches a credential`).not.toBe("");
      expect(d!.guarded, `${name} is not guarded`).toBe(true);
    }
    // A path the auth middleware never authenticates reads no device token.
    for (const skipped of [
      "packages/api/src/routers/hub-protocol/rest/device.ts POST /setup/device",
      "packages/api/src/routers/hub-protocol/rest/mcp-redeem.ts POST /mcp/redeem",
    ]) {
      expect(seen.has(skipped), `${skipped} is auth-skipped`).toBe(false);
    }
    // The Hub guard is the ONE predicate underneath.
    const guard = real.units.find((u) => u.name === HUB_GUARD_CALL);
    expect(guard, `${HUB_GUARD_CALL} exists`).toBeDefined();
    expect(calledNames(guard!.node, new Map(), new Map()).has(GUARD_CALL)).toBe(
      true
    );
  });

  it("every register*Routes mounted on the Hub app takes a HubHono (so the scan finds its routes)", () => {
    const root = real.files.get(HUB_ROOT_FILE)!;
    const registered = new Set<string>();
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        /^register\w+Routes$/.test(n.expression.text)
      )
        registered.add(n.expression.text);
      ts.forEachChild(n, visit);
    };
    visit(root);
    expect(registered.size).toBeGreaterThan(90);
    const notHubHono = [...registered].filter((name) => {
      const unit = real.units.find(
        (u) => u.name === name && isHubFile(u.file) && u.file !== HUB_ROOT_FILE
      );
      const fn = unit?.node as ts.FunctionLikeDeclaration | undefined;
      return fn?.parameters[0]?.type?.getText() !== "HubHono";
    });
    expect(notHubHono).toEqual([]);
  });

  it("account recovery's device-wired routes are doors; every equivalent guard exists", () => {
    const seen = new Map(allDoors.map((d) => [d.door, d]));
    for (const route of ["GET /status", "POST /codes", "PUT /cloud-trust"]) {
      expect(
        seen.has(`apps/api/src/routers/account-recovery.ts ${route}`),
        route
      ).toBe(true);
    }
    // The unauthenticated doors are not wired: no session reaches them.
    expect(
      seen.has("apps/api/src/routers/account-recovery.ts POST /redeem")
    ).toBe(false);
    for (const g of Object.keys(EQUIVALENT_GUARDS)) {
      expect(verdicts.unitNames.has(g), g).toBe(true);
    }
  });

  it("POSITIVE CONTROL — deps that wire appSessionMiddleware() make a router's routes doors", () => {
    const sample = analyse([
      {
        rel: "apps/api/src/routers/__sample_deps__.ts",
        code: `
          export const sampleDeps: SampleDeps = {
            authenticate: [appSessionMiddleware(), refuseGuestSession],
          };
        `,
      },
      {
        rel: "apps/api/src/routers/__sample_router__.ts",
        code: `
          export interface SampleDeps { authenticate: MiddlewareHandler[] }
          class CodeRepo { async replace(u) { await db.insert(apiKeys).values({ u }); } }
          const repo = new CodeRepo();
          export function createSampleRouter(deps: SampleDeps) {
            const router = new Hono();
            router.post("/open", async (c) => repo.replace("x"));
            router.use("/mint", ...deps.authenticate);
            router.use("/guarded", ...deps.authenticate);
            router.post("/mint", async (c) => repo.replace("x"));
            router.post("/guarded", async (c) => { await guardCredentialChange(c); return repo.replace("x"); });
            return router;
          }
        `,
      },
    ]);
    const flagged = unguarded(doorsOf(sample, judge(sample)))
      .filter((d) => d.door.includes("__sample_router__"))
      .map((d) => d.door);
    expect(flagged).toEqual([
      "apps/api/src/routers/__sample_router__.ts POST /mint",
    ]);
  });

  it("POSITIVE CONTROL — an unguarded Hub route that mints a key is flagged", () => {
    const sample = analyse([
      {
        rel: "packages/api/src/services/__sample_hub_mint__.ts",
        code: `
          class ApiKeyService {
            async generateApiKey(userId) { return db.insert(apiKeys).values({ userId }); }
          }
          export const apiKeyService = new ApiKeyService();
        `,
      },
      {
        rel: "packages/api/src/routers/hub-protocol/rest/__sample__.ts",
        code: `
          const mintRoute = createRoute({ method: "post", path: "/sample/{id}/mint" });
          export function registerSampleRoutes(app: HubHono, other: Hono) {
            app.post("/sample/mint", async (c) => apiKeyService.generateApiKey(c.get("userId")));
            app.openapi(mintRoute, async (c) => apiKeyService.generateApiKey("x"));
            app.post("/sample/guarded", async (c) => {
              const stale = refuseStaleDeviceSession(c);
              if (stale) return stale;
              return apiKeyService.generateApiKey(c.get("userId"));
            });
            // A path built at run time is never skipped: still a door.
            for (const p of ["/setup/device"]) {
              app.post(p, async (c) => apiKeyService.generateApiKey("x"));
            }
            // Auth-skipped: no credential is read on this path.
            app.post("/setup/device", async (c) => apiKeyService.generateApiKey("x"));
            // A procedure call through a tRPC caller is that procedure's door.
            app.post("/sample/through-caller", async (c) => {
              const caller = await getCaller(c);
              return caller.keys.generateApiKey({});
            });
            // Hands a secret's plaintext back, unguarded.
            app.post("/sample/redeem", async (c) => c.json({ value: await resolveVaultSecret("s", "u") }));
            // Not a Hub app: not a Hub route.
            other.post("/sample/elsewhere", async (c) => apiKeyService.generateApiKey("x"));
          }
        `,
      },
    ]);
    const flagged = unguarded(doorsOf(sample, judge(sample)))
      .filter((d) => d.door.includes("__sample__"))
      .map((d) => d.door);
    expect(flagged.sort()).toEqual([
      "packages/api/src/routers/hub-protocol/rest/__sample__.ts POST /sample/:id/mint",
      "packages/api/src/routers/hub-protocol/rest/__sample__.ts POST /sample/mint",
      "packages/api/src/routers/hub-protocol/rest/__sample__.ts POST /sample/redeem",
      "packages/api/src/routers/hub-protocol/rest/__sample__.ts POST ?",
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
