/**
 * TRIPWIRE: every approve door pod admin calls goes through the ONE
 * proof-of-presence helper (W3, plan "Proof of presence, pod-first").
 *
 * A sensitive approval (connect an AI, change who may do what, deploy,
 * delete) is refused `PRESENCE_REQUIRED` once a pod runs `enforce`; the
 * helper in `app/_lib/presence/` asks the person for a passkey and approves
 * again. A page that calls an approve door around it typechecks, works in
 * `report` mode, and breaks the day the pod flips to `enforce`. So:
 *
 *  - every non-test source file is scanned (derived, never hand-listed), and
 *    an approve door may be called only inside `app/_lib/presence/`;
 *  - W3 slice 3: every SENSITIVE ACTION (`SENSITIVE_ACTIONS`,
 *    `@synap-core/types/presence`, a tRPC path that creates, rotates or
 *    widens a credential or a rule) is a door too, DERIVED from the pod's
 *    list: a path added there joins this scan by existing. Outside the
 *    helper, neither its tRPC accessor (`<router>.<proc>.useMutation /
 *    mutate / mutateAsync`) nor its quoted path (a proxy route forwarding
 *    it, `callPodMutation("<path>"`) may appear;
 *  - inside it, each file that calls a door goes through
 *    `approveWithPresence` / `approveEachWithPresence`, or the shared door
 *    `usePresenceDoor` (which itself goes through `approveWithPresence`);
 *    each sensitive action hook names the SAME path as the procedure it
 *    wraps (the path is what the proof is bound to);
 *  - the doors are checked against the pod: every router file that takes a
 *    proof (`presenceProofSchema`) is one this guard knows, with as many
 *    proof inputs as it knows. A new door that takes a proof fails here until
 *    it is added to DOORS (and so routed through the helper);
 *  - the dialog is mounted once, in `app/providers.tsx`.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SENSITIVE_ACTIONS } from "@synap-core/types/presence";
import { stripComments } from "../../../scripts/strip-comments.mjs";

const APP_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const API_ROUTERS = join(APP_ROOT, "../../packages/api/src/routers");
const HOME = "app/_lib/presence/";

/** Each pod approve door that takes a proof, as pod admin would call it. */
const DOORS: Record<string, RegExp> = {
  "tRPC proposals.approve":
    /\bproposals\s*\.\s*approve\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  "tRPC proposals.batchApprove":
    /\bproposals\s*\.\s*batchApprove\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  "tRPC secretsVault.grantAIAccess":
    /\bsecretsVault\s*\.\s*grantAIAccess\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  // `…/approve`, `/approve-batch`, or a templated verb (`…/${action}`), which
  // is how the agent-connect page once sent approve and reject alike.
  "REST /setup/agent/pending/:keyId/approve and /approve-batch":
    /\/setup\/agent\/pending\/[^`"'\s]*?(?:approve(?:-batch)?\b|\/\$\{)/,
  "REST /proposals/:id/approve": /\/api\/hub\/proposals\/[^`"'\s]*\/approve\b/,
  // W3 slice 2 (backend#808): the decisions that settle no proposal.
  "tRPC apiKeys.decideKeyRequest":
    /\bapiKeys\s*\.\s*decideKeyRequest\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  "tRPC apiKeys.decideOAuthAuthorization":
    /\bapiKeys\s*\.\s*decideOAuthAuthorization\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  // The page posts to its own route, which forwards to
  // apiKeys.decideDeviceRequest (the route's forwarding is checked below).
  "route POST /api/device (apiKeys.decideDeviceRequest)":
    /["'`]\/api\/device["'`]/,
  "tRPC applicationConnections.approveRequest":
    /\bapplicationConnections\s*\.\s*approveRequest\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  "tRPC capabilities.setToolEnabled":
    /\bcapabilities\s*\.\s*setToolEnabled\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  "tRPC skills.setApproved":
    /\bskills\s*\.\s*setApproved\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  "tRPC tools.setApproved":
    /\btools\s*\.\s*setApproved\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  "tRPC mcpServers.setApproved":
    /\bmcpServers\s*\.\s*setApproved\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  "tRPC intelligenceRegistry.approveMcp":
    /\bintelligenceRegistry\s*\.\s*approveMcp\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  "tRPC marketplace.sources.approveKeyChange":
    /\bsources\s*\.\s*approveKeyChange\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  "tRPC trustedIssuers.approve":
    /\btrustedIssuers\s*\.\s*approve\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  "REST /skills/:id/approve": /\/api\/hub\/skills\/[^`"'\s]*\/approve\b/,
  "REST /tools/:id/approve": /\/api\/hub\/tools\/[^`"'\s]*\/approve\b/,
  // W3 slice 3: a skill born ON, the mode switched off, a passkey change, and
  // a second device key each take a proof (no pod-admin page calls them yet).
  "tRPC skills.create":
    /\bskills\s*\.\s*create\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  "tRPC presence.setMode":
    /\bpresence\s*\.\s*setMode\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  // W5: what asks for a passkey; switching a row off takes a proof.
  "tRPC presence.setSensitivity":
    /\bpresence\s*\.\s*setSensitivity\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  "tRPC presence.authorizePasskeyChange":
    /\bpresence\s*\.\s*authorizePasskeyChange\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  // The recovery ladder (6 Nov): a 2FA app added by a person who holds a factor.
  "tRPC presence.totp.confirm":
    /\bpresence\s*\.\s*totp\s*\.\s*confirm\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
  "tRPC presence.devices.enroll":
    /\bdevices\s*\.\s*enroll\s*\.\s*(?:useMutation|mutate|mutateAsync)\b/,
};

const SENSITIVE_PATHS = Object.keys(SENSITIVE_ACTIONS);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Each sensitive action, derived: its tRPC accessor (the last two segments,
 * `governanceRules.create.useMutation`) or its full path in quotes that is not
 * an object key (a proxy route's procedure name; a table keyed by path is
 * not a call).
 */
for (const path of SENSITIVE_PATHS) {
  const [router, proc] = path.split(".").slice(-2) as [string, string];
  DOORS[`action ${path}`] = new RegExp(
    `\\b${esc(router)}\\s*\\.\\s*${esc(proc)}\\s*\\.\\s*(?:useMutation|mutate|mutateAsync)\\b` +
      `|["'\`]${esc(path)}["'\`](?!\\s*:)`
  );
}

/**
 * The pod's router files that take a proof, and how many proof inputs each
 * has (imports not counted). Contract: pod document "W3 pod-first: proof of
 * presence on the pod", section "As built".
 */
const POD_DOORS: Record<string, { inputs: number; doors: string[] }> = {
  "proposals.ts": {
    inputs: 2,
    doors: ["tRPC proposals.approve", "tRPC proposals.batchApprove"],
  },
  "secrets-vault.ts": {
    inputs: 1,
    doors: ["tRPC secretsVault.grantAIAccess"],
  },
  "hub-protocol/rest/setup.ts": {
    inputs: 2,
    doors: ["REST /setup/agent/pending/:keyId/approve and /approve-batch"],
  },
  "hub-protocol/rest/proposals.ts": {
    inputs: 1,
    doors: ["REST /proposals/:id/approve"],
  },
  // W3 slice 2 (backend#808): the decisions that settle no proposal, each
  // with a proof bound to its own request (`{request}` / `{oauthConsent}`).
  "api-keys.ts": {
    inputs: 3,
    doors: [
      "tRPC apiKeys.decideKeyRequest",
      "tRPC apiKeys.decideOAuthAuthorization",
      "route POST /api/device (apiKeys.decideDeviceRequest)",
    ],
  },
  "application-connections.ts": {
    inputs: 1,
    doors: ["tRPC applicationConnections.approveRequest"],
  },
  "capabilities.ts": { inputs: 1, doors: ["tRPC capabilities.setToolEnabled"] },
  "hub-protocol/rest/skills-crud.ts": {
    inputs: 1,
    doors: ["REST /skills/:id/approve"],
  },
  "hub-protocol/rest/tools.ts": {
    inputs: 1,
    doors: ["REST /tools/:id/approve"],
  },
  "intelligence-registry.ts": {
    inputs: 1,
    doors: ["tRPC intelligenceRegistry.approveMcp"],
  },
  "marketplace.ts": {
    inputs: 1,
    doors: ["tRPC marketplace.sources.approveKeyChange"],
  },
  "mcp-servers.ts": { inputs: 1, doors: ["tRPC mcpServers.setApproved"] },
  // Slice 3: skills.create also takes a proof, for a skill born ON.
  "skills.ts": {
    inputs: 2,
    doors: ["tRPC skills.setApproved", "tRPC skills.create"],
  },
  // Slice 3: presence.setMode (back to report), presence.authorizePasskeyChange
  // and presence.devices.enroll (a second factor) take a proof themselves.
  // The recovery ladder (6 Nov): presence.totp.confirm (a 2FA app added by a
  // person who already holds a factor) takes one too.
  "presence.ts": {
    inputs: 5,
    doors: [
      "tRPC presence.setMode",
      "tRPC presence.setSensitivity",
      "tRPC presence.authorizePasskeyChange",
      "tRPC presence.devices.enroll",
      "tRPC presence.totp.confirm",
    ],
  },
  "tools.ts": { inputs: 1, doors: ["tRPC tools.setApproved"] },
  "trusted-issuers.ts": { inputs: 1, doors: ["tRPC trustedIssuers.approve"] },
  // Review of 6 Nov (backend#874): the Hub twins of sensitive actions take
  // the proof of the SAME action (`action:<tRPC path>:<digest>`). Pod admin
  // calls the tRPC doors, through use-sensitive-actions.
  "hub-protocol/rest/_presence.ts": {
    inputs: 1,
    doors: [
      "action apps.issueKey",
      "action apps.setRedirectUris",
      "action apps.setWriteMode",
      "action agentUsers.create",
      "action agentUsers.setPosture",
    ],
  },
  "hub-protocol/services.ts": {
    inputs: 1,
    doors: ["action intelligenceRegistry.register"],
  },
};

function walk(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "__tests__")
      continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, keep));
    else if (keep(name)) out.push(p);
  }
  return out;
}

const isSource = (name: string) =>
  /\.(ts|tsx)$/.test(name) &&
  !name.endsWith(".d.ts") &&
  !/\.(test|spec)\.tsx?$/.test(name);

const rel = (p: string) => relative(APP_ROOT, p).split(sep).join("/");

const SOURCES = [
  ...walk(join(APP_ROOT, "app"), isSource),
  ...walk(join(APP_ROOT, "lib"), isSource),
].map((p) => ({
  path: rel(p),
  src: stripComments(readFileSync(p, "utf8"), "ts"),
}));

function doorsIn(src: string): string[] {
  return Object.entries(DOORS)
    .filter(([, re]) => re.test(src))
    .map(([name]) => name);
}

describe("TRIPWIRE: pod admin approves only through the proof-of-presence helper", () => {
  it("scans the whole app, and finds the doors in the helper (the scan works)", () => {
    expect(SOURCES.length).toBeGreaterThan(200);
    const home = SOURCES.filter((f) => f.path.startsWith(HOME));
    const found = new Set(home.flatMap((f) => doorsIn(f.src)));
    expect([...found].sort()).toEqual(
      [
        "REST /setup/agent/pending/:keyId/approve and /approve-batch",
        "route POST /api/device (apiKeys.decideDeviceRequest)",
        "tRPC apiKeys.decideKeyRequest",
        "tRPC apiKeys.decideOAuthAuthorization",
        "tRPC applicationConnections.approveRequest",
        "tRPC capabilities.setToolEnabled",
        "tRPC marketplace.sources.approveKeyChange",
        "tRPC proposals.approve",
        "tRPC proposals.batchApprove",
        "tRPC skills.setApproved",
        "tRPC tools.setApproved",
        "tRPC trustedIssuers.approve",
        // W3 slice 3: the mode switched off, a passkey change.
        "tRPC presence.setMode",
        "tRPC presence.authorizePasskeyChange",
        // W5: what asks for a passkey (switching a row off takes a proof).
        "tRPC presence.setSensitivity",
        // The recovery ladder (6 Nov): a 2FA app added with a factor's proof.
        "tRPC presence.totp.confirm",
        // W3 slice 3: the sensitive actions pod admin calls (derived doors).
        "action agentUsers.setPosture",
        "action apiKeys.adminCreateServiceKey",
        "action apiKeys.beginMcpConnect",
        "action apiKeys.connectIntegration",
        "action apiKeys.create",
        "action apiKeys.createSystemKey",
        "action apiKeys.rotate",
        "action apiKeys.setGrants",
        "action apiKeys.setMachineDefaults",
        "action apps.setWriteMode",
        "action governanceRules.create",
        "action governanceRules.setActionMode",
        "action governanceRules.setOwnOrganiseDefault",
        "action governanceRules.setReversibleDefault",
        "action governanceRules.widenCell",
        "action machines.setKeyTtl",
        "action machines.setRunsScripts",
        "action machines.setBelongsTo",
      ].sort()
    );
  });

  it("derives the sensitive actions from the pod's list, and can still see one (non-vacuity)", () => {
    expect(SENSITIVE_PATHS.length).toBeGreaterThanOrEqual(30);
    const actionDoors = Object.keys(DOORS).filter((d) =>
      d.startsWith("action ")
    );
    expect(actionDoors).toHaveLength(SENSITIVE_PATHS.length);
    // Literal samples of each shape the scan hunts, and of what it must not.
    const create = DOORS["action governanceRules.create"]!;
    expect(create.test("trpc.governanceRules.create.useMutation(")).toBe(true);
    expect(create.test("utils.client.governanceRules .create.mutate(")).toBe(
      true
    );
    expect(create.test('callPodMutation("governanceRules.create", i)')).toBe(
      true
    );
    expect(create.test('  "governanceRules.create": "words",')).toBe(false);
    expect(create.test("trpc.workspaces.create.useMutation(")).toBe(false);
    expect(
      DOORS["action apps.setWriteMode"]!.test(
        '{ "write-mode": "apps.setWriteMode" }'
      )
    ).toBe(true);
  });

  it("each sensitive action hook binds the proof to the procedure it calls", () => {
    const HOOK =
      /\buseSensitiveAction\(\s*["']([\w.]+)["']\s*,\s*trpc\.([\w.]+)\.useMutation\(/g;
    const home = SOURCES.filter((f) => f.path.startsWith(HOME));
    const pairs = home.flatMap((f) =>
      [...f.src.matchAll(HOOK)].map((m) => ({
        file: f.path,
        path: m[1]!,
        procedure: m[2]!,
      }))
    );
    expect(pairs.length).toBeGreaterThanOrEqual(15);
    expect(pairs.filter((p) => p.path !== p.procedure)).toEqual([]);
    expect(pairs.filter((p) => !SENSITIVE_PATHS.includes(p.path))).toEqual([]);
    // Every sensitive accessor in the helper is one of those pairs: none is
    // called around `useSensitiveAction`.
    for (const f of home) {
      const accessors = SENSITIVE_PATHS.filter((path) => {
        const [router, proc] = path.split(".").slice(-2) as [string, string];
        return new RegExp(
          `\\b${esc(router)}\\s*\\.\\s*${esc(proc)}\\s*\\.\\s*(?:useMutation|mutate|mutateAsync)\\b`
        ).test(f.src);
      });
      const paired = new Set(
        pairs.filter((p) => p.file === f.path).map((p) => p.path)
      );
      expect(
        accessors.filter((a) => !paired.has(a)),
        `${f.path}: a sensitive procedure called around useSensitiveAction`
      ).toEqual([]);
    }
  });

  it("no page calls an approve door around the helper", () => {
    const bypass = SOURCES.filter((f) => !f.path.startsWith(HOME)).flatMap(
      (f) => doorsIn(f.src).map((door) => `${f.path}: ${door}`)
    );
    expect(
      bypass,
      "These call an approve door or a sensitive action directly. Go through app/_lib/presence (useApproveProposal, useBatchApproveProposals, approvePendingKey(s), use-request-doors, use-sensitive-actions, use-factor-doors), so the call carries its passkey proof."
    ).toEqual([]);
  });

  it("inside the helper, every door goes through approveWithPresence / approveEachWithPresence", () => {
    const THROUGH =
      /\b(?:approve(?:Each)?WithPresence|usePresenceDoor)\s*(?:<[^>]*>)?\s*\(/;
    const raw = SOURCES.filter(
      (f) =>
        f.path.startsWith(HOME) &&
        doorsIn(f.src).length > 0 &&
        !THROUGH.test(f.src)
    ).map((f) => f.path);
    expect(raw).toEqual([]);
    // The shared door itself proves through approveWithPresence.
    const door = SOURCES.find((f) => f.path === `${HOME}use-presence-door.ts`);
    expect(door, "use-presence-door.ts").toBeDefined();
    expect(door!.src).toMatch(/\bapproveWithPresence\s*\(\s*\{/);
  });

  it("the doors match the pod: every router input that takes a proof is known", () => {
    expect(existsSync(API_ROUTERS), API_ROUTERS).toBe(true);
    const found: Record<string, number> = {};
    for (const p of walk(API_ROUTERS, isSource)) {
      const src = stripComments(readFileSync(p, "utf8"), "ts").replace(
        /import\s*(?:type\s*)?\{[^}]*\}\s*from\s*["'][^"']+["'];?/g,
        ""
      );
      const n = (src.match(/\bpresenceProofSchema\b/g) ?? []).length;
      if (n > 0) found[relative(API_ROUTERS, p).split(sep).join("/")] = n;
    }
    expect(
      found,
      "A pod door's proof inputs changed. Add the door to DOORS / POD_DOORS and route pod admin through app/_lib/presence."
    ).toEqual(
      Object.fromEntries(
        Object.entries(POD_DOORS).map(([file, d]) => [file, d.inputs])
      )
    );
    for (const d of Object.values(POD_DOORS)) {
      expect(
        d.doors.length,
        "every pod door has a pattern here"
      ).toBeGreaterThan(0);
      for (const door of d.doors) expect(DOORS[door], door).toBeDefined();
    }
  });

  it("the dialog is mounted once, around every page and toast", () => {
    const mounts = SOURCES.filter((f) => /<PresenceProvider\b/.test(f.src));
    expect(mounts.map((f) => f.path)).toEqual(["app/providers.tsx"]);
    const providers = mounts[0]!.src;
    expect(providers.indexOf("<PresenceProvider")).toBeLessThan(
      providers.indexOf("<ToastProvider")
    );
    expect(providers.indexOf("</PresenceProvider>")).toBeGreaterThan(
      providers.indexOf("{children}")
    );
  });

  it("the device route forwards the proof to apiKeys.decideDeviceRequest, and the refusal's code back", () => {
    const route = SOURCES.find((f) => f.path === "app/api/device/route.ts");
    expect(route, "app/api/device/route.ts").toBeDefined();
    expect(route!.src).toMatch(/["']apiKeys\.decideDeviceRequest["']/);
    expect(route!.src).toMatch(
      /presenceProofSchema\.safeParse\(body\?\.presence\)/
    );
    expect(route!.src).toMatch(/input\.presence\s*=/);
    expect(route!.src).toMatch(/reasonCode:\s*res\.reasonCode/);
  });
});
