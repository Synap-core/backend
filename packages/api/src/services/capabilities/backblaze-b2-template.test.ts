import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The SHIPPED `backblaze-b2` capability template, driven through the pod's real
 * doors — not a hand-built copy of it:
 *
 *  1. it parses through the apply door's own `CapabilityDefinitionSchema` and
 *     survives the applier's real `interpolateDeep` (skill code unmangled, the
 *     credential param lands in the vault value);
 *  2. its tool's `auth` is a valid session config for the vault handler;
 *  3. GOVERNANCE, by reachability: each skill's metadata goes through the
 *     applier's projection (`projectSkillMetadata`), the run door's read-only
 *     expression (`verbDeclaresReadOnly`) and the REAL capability gate, as an
 *     agent with no grant. Reads → `run`; the bucket write → `propose`;
 *  4. each skill's CODE runs against a fake B2 behind the REAL vault handler
 *     (session sign-in, apiUrl, accountId) — so the template's own logic
 *     (freshness, storage sum, ensure-bucket create/update/no-op/refusal) is
 *     exercised end to end with fetch mocked.
 *
 * Template location: the Control Plane seed catalog, checked out BESIDE
 * synap-backend (the same convention as
 * `__tripwires__/shipped-capability-templates-appliable.test.ts`).
 * `SYNAP_CP_CHECKOUT` overrides it (e.g. a worktree). Missing = RED, never skip.
 *
 * NOT covered: the IS isolate (`callProvider` is a local stand-in that maps to
 * the vault handler exactly as the Hub's tool-execute route does), the grant /
 * rule tables (mocked to "no grant, no rule" — the agent default), and real B2.
 */

const REPO_ROOT = join(import.meta.dirname, "../../../../../..");
const CP_ROOT =
  process.env.SYNAP_CP_CHECKOUT ?? join(REPO_ROOT, "synap-control-plane-api");
const TEMPLATE_PATH = join(
  CP_ROOT,
  "src/seeds/capability-templates/backblaze-b2.capability.json"
);

const { mockResolveVaultSecret, mockFindFirst, findGrant, resolveRule } =
  vi.hoisted(() => ({
    mockResolveVaultSecret: vi.fn(),
    mockFindFirst: vi.fn(),
    findGrant: vi.fn(),
    resolveRule: vi.fn(),
  }));

vi.mock("../../utils/vault-resolver.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../utils/vault-resolver.js")>();
  return { ...actual, resolveVaultSecret: mockResolveVaultSecret };
});
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: async () => ({}),
    findCapabilityGrant: (...a: unknown[]) => findGrant(...a),
    db: { query: { secrets: { findFirst: mockFindFirst } } },
  };
});
vi.mock("@synap/database/agent-governance", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveGovernanceRule: (...a: unknown[]) => resolveRule(...a),
    resolveOriginTrust: async () => undefined,
  };
});

import { CapabilityDefinitionSchema } from "../../routers/hub-protocol/rest/capabilities.js";
import { interpolateDeep } from "../_shared/interpolate.js";
import { projectSkillMetadata } from "./capability-drift.js";
import { verbDeclaresReadOnly } from "./execute-capability.js";
import { gateCapabilityExecution } from "./gate-capability-execution.js";
import { __vaultHandlerForTests as vaultHandler } from "../../connectors/external-dispatch.js";
import {
  __resetSessionCacheForTests,
  parseSessionAuthConfig,
} from "../../connectors/session-auth.js";

type Skill = {
  name: string;
  kind: string;
  code: string;
  intent?: string;
  metadata?: Record<string, unknown>;
};
type Template = {
  key: string;
  description: string;
  params: Array<{ name: string }>;
  vault: Array<{ value: string }>;
  tools: Array<{ name: string; config: Record<string, unknown> }>;
  skills: Skill[];
};

const RAW = existsSync(TEMPLATE_PATH)
  ? (JSON.parse(readFileSync(TEMPLATE_PATH, "utf8")) as Template)
  : null;
const tpl = () => {
  expect(
    RAW,
    `Cannot read ${TEMPLATE_PATH}. Check out synap-control-plane-api beside ` +
      `synap-backend (or set SYNAP_CP_CHECKOUT). Do not skip this test.`
  ).not.toBeNull();
  return RAW!;
};
const skill = (name: string) => {
  const s = tpl().skills.find((x) => x.name === name);
  expect(s, `skill ${name} missing from the template`).toBeDefined();
  return s!;
};

const READS = [
  "b2_list_buckets",
  "b2_get_bucket_settings",
  "b2_list_keys",
  "b2_storage_by_pod",
  "b2_backup_freshness",
];
const WRITES = ["b2_ensure_backup_bucket"];

describe("backblaze-b2 template — appliable", () => {
  it("parses through the apply door's schema, with exactly the verbs we govern", () => {
    const parsed = CapabilityDefinitionSchema.parse(tpl());
    expect(parsed.key).toBe("backblaze-b2");
    expect(parsed.skills.map((s) => s.name).sort()).toEqual(
      [...READS, ...WRITES].sort()
    );
  });

  it("survives the applier's interpolation: code intact, credential → vault value", () => {
    const def = interpolateDeep(tpl(), {
      name: tpl().key,
      key: tpl().key,
      b2Credential: "KEYID:APPKEY",
    });
    expect(def.vault[0]!.value).toBe("KEYID:APPKEY");
    for (const s of tpl().skills) {
      expect(def.skills.find((x) => x.name === s.name)!.code).toBe(s.code);
    }
  });

  it("its tool auth is a valid session config (B2 sign-in, apiUrl, accountId)", () => {
    const parsed = parseSessionAuthConfig(tpl().tools[0]!.config.auth);
    expect(parsed).toMatchObject({
      ok: true,
      config: {
        signIn: {
          url: "https://api.backblazeb2.com/b2api/v4/b2_authorize_account",
          credential: "basic",
        },
        baseUrlFrom: "apiInfo.storageApi.apiUrl",
        bodyFrom: { accountId: "accountId" },
      },
    });
  });

  it("names its scope boundaries: no delete, no key minting", () => {
    const d = tpl().description;
    expect(d).toMatch(/OUT OF SCOPE ON PURPOSE/);
    expect(d).toMatch(/minting per-pod keys/);
    for (const s of tpl().skills) {
      expect(s.code).not.toMatch(/b2_(delete_|create_key|hide_file)/);
    }
  });
});

describe("backblaze-b2 template — governance reaches the gate", () => {
  beforeEach(() => {
    findGrant.mockReset().mockResolvedValue({ ok: false });
    resolveRule.mockReset().mockResolvedValue(null);
  });

  async function gateAsAgent(name: string) {
    const s = skill(name);
    // What the applier writes on INSERT, then the run door's exact expression.
    const metadata = projectSkillMetadata(null, s.metadata) ?? null;
    const readOnly = verbDeclaresReadOnly({ metadata });
    return gateCapabilityExecution({
      capabilityKind: "skill",
      capabilityId: `skill-${name}`,
      skill: { id: `skill-${name}`, approved: true, userId: "owner-1", name } as never,
      actorUserId: "owner-1",
      agentUserId: "agent-1",
      workspaceId: null,
      issuer: "hub.capabilities-execute",
      readOnly,
    } as never);
  }

  it.each(READS)("%s auto-runs for an agent with no grant (declared read)", async (n) => {
    expect((await gateAsAgent(n)).decision).toBe("run");
  });

  it.each(WRITES)("%s is PROPOSED for an agent with no grant (write)", async (n) => {
    expect((await gateAsAgent(n)).decision).toBe("propose");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const AUTH_URL = "https://api.backblazeb2.com/b2api/v4/b2_authorize_account";
const API_URL = "https://api005.backblazeb2.com";
const POD = "3f1c9a2e-0000-4000-8000-00000000abcd";
const RULE = {
  fileNamePrefix: "pods/",
  daysFromHidingToDeleting: 30,
  daysFromUploadingToHiding: null,
};

type Op = { op: string; body: Record<string, unknown> };
let ops: Op[] = [];
let b2: (op: string, body: Record<string, unknown>) => unknown;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Run a template skill's code with callProvider wired to the real vault handler. */
async function runSkill(name: string, args: Record<string, unknown>) {
  const s = skill(name);
  const t = tpl().tools[0]!;
  const callProvider = async (
    provider: string,
    method: string,
    path: string,
    body?: Record<string, unknown>
  ) => {
    expect(provider).toBe(t.name);
    const r = await vaultHandler({
      input: { userId: "owner-1", provider: "vault://v1", method, path, body } as never,
      tool: { id: "t1", name: t.name, kind: "api", credentialRef: "vault://v1", config: t.config } as never,
    });
    if (!r.success) throw new Error(`callProvider failed: ${r.error}`);
    return { status: r.status, headers: r.headers, body: r.body };
  };
  const fn = new Function(
    "callProvider",
    `return (async (args, context) => {\n${s.code}\n});`
  )(callProvider) as (a: unknown, c: unknown) => Promise<Record<string, unknown>>;
  return fn(args, {});
}

describe("backblaze-b2 template — skill code against a fake B2 (real vault handler)", () => {
  beforeEach(() => {
    __resetSessionCacheForTests();
    ops = [];
    mockResolveVaultSecret.mockResolvedValue("0051keyid:K005appkey");
    mockFindFirst.mockResolvedValue({
      userId: "owner-1",
      providerIntegrationId: null,
      accountHint: null,
      isPodWide: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url === AUTH_URL) {
          return json(200, {
            accountId: "acct-1",
            authorizationToken: "tok-1",
            apiInfo: { storageApi: { apiUrl: API_URL } },
          });
        }
        expect(url.startsWith(`${API_URL}/b2api/v4/`)).toBe(true);
        const op = url.slice(`${API_URL}/b2api/v4/`.length);
        const body = JSON.parse(String(init.body ?? "{}"));
        ops.push({ op, body });
        return json(200, b2(op, body));
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const bucket = (over: Record<string, unknown> = {}) => ({
    bucketName: "synap-pod-backups",
    bucketId: "bkt-1",
    bucketType: "allPrivate",
    lifecycleRules: [RULE],
    revision: 7,
    fileLockConfiguration: {
      isClientAuthorizedToRead: true,
      value: { isFileLockEnabled: false },
    },
    ...over,
  });

  it("a declared accountId slot is filled from the sign-in (bodyFrom)", async () => {
    b2 = () => ({ buckets: [bucket()] });
    await runSkill("b2_list_buckets", {});
    expect(ops[0]).toEqual({ op: "b2_list_buckets", body: { accountId: "acct-1" } });
  });

  it("b2_get_bucket_settings reports a compliant bucket as compliant", async () => {
    b2 = () => ({ buckets: [bucket()] });
    const r = await runSkill("b2_get_bucket_settings", { bucketName: "synap-pod-backups" });
    expect(r.backupPolicy).toMatchObject({
      private: true,
      lifecycleRule: true,
      objectLock: "off",
      compliant: true,
    });
  });

  it("b2_get_bucket_settings flags a public bucket and an unreadable Object Lock", async () => {
    b2 = () => ({
      buckets: [bucket({ bucketType: "allPublic", fileLockConfiguration: { isClientAuthorizedToRead: false, value: null } })],
    });
    const r = await runSkill("b2_get_bucket_settings", { bucketName: "synap-pod-backups" });
    expect(r.backupPolicy).toMatchObject({ private: false, objectLock: "unreadable", compliant: false });
  });

  it("b2_backup_freshness: newest snapshot under pods/<id>/snapshots/, recent within maxAgeHours", async () => {
    const now = Date.now();
    b2 = (op) =>
      op === "b2_list_buckets"
        ? { buckets: [bucket()] }
        : {
            files: [
              { fileName: `pods/${POD}/snapshots/aa`, action: "upload", uploadTimestamp: now - 50 * 3600_000 },
              { fileName: `pods/${POD}/snapshots/bb`, action: "upload", uploadTimestamp: now - 2 * 3600_000 },
            ],
            nextFileName: null,
          };
    const r = await runSkill("b2_backup_freshness", { bucketName: "synap-pod-backups", podId: POD });
    expect(ops[1]).toEqual({
      op: "b2_list_file_names",
      // No accountId: b2_list_file_names does not take one (B2 rejects unknown fields).
      body: { bucketId: "bkt-1", prefix: `pods/${POD}/snapshots/`, maxFileCount: 1000 },
    });
    expect(r).toMatchObject({ present: true, snapshotCount: 2, recent: true, maxAgeHours: 26 });
    expect(r.ageHours).toBeCloseTo(2, 0);
  });

  it("b2_backup_freshness: no snapshots → not present, not recent", async () => {
    b2 = (op) => (op === "b2_list_buckets" ? { buckets: [bucket()] } : { files: [], nextFileName: null });
    const r = await runSkill("b2_backup_freshness", { bucketName: "synap-pod-backups", podId: POD });
    expect(r).toMatchObject({ present: false, recent: false, newestSnapshotAt: null });
  });

  it("a podId that is a path is refused before any listing", async () => {
    b2 = () => ({ buckets: [bucket()] });
    await expect(
      runSkill("b2_backup_freshness", { bucketName: "synap-pod-backups", podId: "../other" })
    ).rejects.toThrow(/podId/);
    expect(ops.some((o) => o.op === "b2_list_file_names")).toBe(false);
  });

  it("b2_storage_by_pod sums every stored version across pages, counts hide markers", async () => {
    b2 = (op, body) => {
      if (op === "b2_list_buckets") return { buckets: [bucket()] };
      if (!body.startFileName) {
        return {
          files: [
            { action: "upload", contentLength: 100 },
            { action: "upload", contentLength: 50 },
            { action: "hide", contentLength: 0 },
          ],
          nextFileName: "pods/x/next",
          nextFileId: "f2",
        };
      }
      return { files: [{ action: "upload", contentLength: 25 }], nextFileName: null };
    };
    const r = await runSkill("b2_storage_by_pod", { bucketName: "synap-pod-backups", podId: POD });
    expect(r.pods).toEqual([
      { podId: POD, prefix: `pods/${POD}/`, bytes: 175, versions: 3, hiddenMarkers: 1, truncated: false },
    ]);
    expect(ops.filter((o) => o.op === "b2_list_file_versions")[1]!.body).toMatchObject({
      startFileName: "pods/x/next",
      startFileId: "f2",
    });
  });

  it("b2_ensure_backup_bucket CREATES a missing bucket with the exact policy", async () => {
    b2 = (op, body) =>
      op === "b2_list_buckets" ? { buckets: [] } : { ...bucket(), ...body, bucketId: "new-1" };
    const r = await runSkill("b2_ensure_backup_bucket", { bucketName: "synap-pod-backups" });
    expect(ops[1]).toEqual({
      op: "b2_create_bucket",
      body: {
        bucketName: "synap-pod-backups",
        bucketType: "allPrivate",
        lifecycleRules: [RULE],
        fileLockEnabled: false,
        accountId: "acct-1",
      },
    });
    expect(r).toMatchObject({ action: "created", bucketId: "new-1" });
  });

  it("b2_ensure_backup_bucket UPDATES a drifted bucket, keeping unrelated rules", async () => {
    const other = { fileNamePrefix: "logs/", daysFromHidingToDeleting: 1, daysFromUploadingToHiding: 7 };
    b2 = (op, body) =>
      op === "b2_list_buckets"
        ? { buckets: [bucket({ bucketType: "allPublic", lifecycleRules: [other, { fileNamePrefix: "pods/", daysFromHidingToDeleting: 1 }] })] }
        : { ...bucket(), ...body };
    const r = await runSkill("b2_ensure_backup_bucket", { bucketName: "synap-pod-backups" });
    expect(ops[1]).toEqual({
      op: "b2_update_bucket",
      body: {
        bucketId: "bkt-1",
        bucketType: "allPrivate",
        lifecycleRules: [other, RULE],
        ifRevisionIs: 7,
        accountId: "acct-1",
      },
    });
    expect(r).toMatchObject({ action: "updated" });
  });

  it("b2_ensure_backup_bucket is a no-op on a compliant bucket", async () => {
    b2 = () => ({ buckets: [bucket()] });
    const r = await runSkill("b2_ensure_backup_bucket", { bucketName: "synap-pod-backups" });
    expect(r).toMatchObject({ action: "unchanged" });
    expect(ops.map((o) => o.op)).toEqual(["b2_list_buckets"]);
  });

  it("b2_ensure_backup_bucket refuses a bucket with Object Lock on (B2 cannot undo it)", async () => {
    b2 = () => ({
      buckets: [bucket({ fileLockConfiguration: { isClientAuthorizedToRead: true, value: { isFileLockEnabled: true } } })],
    });
    await expect(
      runSkill("b2_ensure_backup_bucket", { bucketName: "synap-pod-backups" })
    ).rejects.toThrow(/Object Lock/);
    expect(ops.map((o) => o.op)).toEqual(["b2_list_buckets"]);
  });
});
