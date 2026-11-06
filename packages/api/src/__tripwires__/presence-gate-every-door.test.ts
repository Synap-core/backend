/**
 * TRIPWIRE — every door that APPROVES a proposal passes the proof-of-presence
 * gate (W3, founder decision of 4 Nov 2026: a session proves the account, not
 * the person; sensitive approvals need a fresh proof bound to that proposal).
 *
 * The doors are DERIVED from the source, never hand-listed: every non-test
 * file under `packages/api/src` that writes a proposal's status to APPROVED
 * (`to:`/`status: ProposalStatus.APPROVED`, or `settleProposal(…, "approved")`).
 * Each one must be:
 *   - `apply-approval.ts`, which calls the gate BEFORE the background hand-off
 *     and before any executor runs (checked by position); or
 *   - an approve EXECUTOR (`routers/proposals/executors/`, the share
 *     executors), which only `applyProposalApproval` dispatches; or
 *   - a "mark it approved" helper whose every caller is an executor or
 *     `apply-approval.ts` (callers derived by name); or
 *   - a door that calls `assertPresenceForApproval` itself (the pending-key
 *     pages through `approvePendingAgentKey`, `secretsVault.grantAIAccess`); or
 *   - listed in NOT_A_DOOR with the reason it approves nothing sensitive.
 *
 * And every key of `SENSITIVE_APPROVALS` names a real approval (a registered
 * executor key, or a type `apply-approval.ts` handles inline): a typo would
 * otherwise drop a sensitive type out of the gate in silence.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRESENCE_REQUEST_KINDS,
  SENSITIVE_ACTIONS,
  SENSITIVE_APPROVALS,
  SENSITIVE_PROPOSAL_TYPE_PREFIXES,
} from "@synap-core/types/presence";

const SRC = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__tests__") continue;
      walk(full, out);
    } else if (
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !/\.(test|spec)\.ts$/.test(name)
    ) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(SRC).map((f) => ({
  path: relative(SRC, f),
  src: readFileSync(f, "utf8"),
}));

const APPROVES =
  /(?:to|status):\s*ProposalStatus\.APPROVED\b|settleProposal\([^)]*"approved"/;
const GATE = /\bassertPresenceForApproval\(/;
const isExecutor = (p: string) =>
  p.startsWith("routers/proposals/executors/") ||
  p === "services/sharing/share-executors.ts";

/** Files that write APPROVED but are no approval door, and why. */
const NOT_A_DOOR: Record<string, string> = {
  "services/import/session.ts":
    "closes the import's own proposal once the person's import.apply (through applyProposalApproval) landed; an import is never sensitive",
  "services/guidelines/guideline-versions.ts":
    "its write (structureGuidelineApprovalDbDeps) runs only inside approveStructureGuidelineProposal, which applyProposalApproval calls after the gate; a structure guideline is not sensitive",
};

/**
 * The exported function (or const) that holds each APPROVED write: the
 * nearest `export … function NAME` / `export const NAME` above it.
 */
function enclosingExports(src: string): string[] {
  const names = new Set<string>();
  const writes = new RegExp(APPROVES.source, "g");
  for (const m of src.matchAll(writes)) {
    const before = src.slice(0, m.index);
    const decls = [
      ...before.matchAll(
        /export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_]+)/g
      ),
    ];
    const last = decls.at(-1);
    if (last) names.add(last[1]!);
  }
  return [...names];
}

describe("TRIPWIRE: every approve door passes the proof-of-presence gate", () => {
  const doors = FILES.filter((f) => APPROVES.test(f.src));

  it("derives a non-trivial set of doors (the scan works)", () => {
    expect(doors.map((d) => d.path)).toContain(
      "routers/proposals/apply-approval.ts"
    );
    expect(doors.length).toBeGreaterThan(10);
  });

  it("applyProposalApproval gates before the background hand-off and before any executor", () => {
    const src = FILES.find(
      (f) => f.path === "routers/proposals/apply-approval.ts"
    )!.src;
    const body = src.slice(
      src.indexOf("export async function applyProposalApproval(")
    );
    const gate = body.search(GATE);
    expect(
      gate,
      "applyProposalApproval must call assertPresenceForApproval"
    ).toBeGreaterThan(0);
    expect(gate).toBeLessThan(body.indexOf("handOffBackgroundApproval("));
    expect(gate).toBeLessThan(body.indexOf("applyProposalApprovalInner("));
  });

  it("every other door is an executor, an executor-only helper, a gated door, or not a door", () => {
    const ungated: string[] = [];
    for (const door of doors) {
      if (door.path === "routers/proposals/apply-approval.ts") continue;
      if (isExecutor(door.path)) continue;
      if (GATE.test(door.src)) continue;
      if (door.path in NOT_A_DOOR) continue;
      // A helper: every file that calls one of its exports must be an
      // executor or apply-approval.ts.
      const names = enclosingExports(door.src);
      const callers = FILES.filter(
        (f) =>
          f.path !== door.path &&
          names.some((n) => new RegExp(`\\b${n}\\(`).test(f.src))
      );
      const outside = callers.filter(
        (f) =>
          !isExecutor(f.path) &&
          f.path !== "routers/proposals/apply-approval.ts"
      );
      if (callers.length === 0 || outside.length > 0) {
        ungated.push(
          `${door.path}${outside.length ? ` (called from ${outside.map((o) => o.path).join(", ")})` : ""}`
        );
      }
    }
    expect(
      ungated,
      "These write a proposal APPROVED outside applyProposalApproval without assertPresenceForApproval. Gate them, or list them in NOT_A_DOOR with the reason."
    ).toEqual([]);
  });

  it("every sensitive key names a real approval", () => {
    const executorSrc = FILES.filter((f) => isExecutor(f.path))
      .map((f) => f.src)
      .join("\n");
    const applySrc = FILES.find(
      (f) => f.path === "routers/proposals/apply-approval.ts"
    )!.src;
    const missing = Object.keys(SENSITIVE_APPROVALS).filter((key) => {
      if (executorSrc.includes(`"${key}"`)) return false;
      const [target, type] = key.split("/");
      // A templated key (`workspace/${action}`) or a constant pair.
      if (type && executorSrc.includes(`\`${target}/\${`)) return false;
      if (key === "trusted_issuer/trusted_issuer.widen_scopes") {
        return !executorSrc.includes(
          "TRUSTED_ISSUER_WIDEN_SCOPES_PROPOSAL_TYPE"
        );
      }
      if (key === "vault/grant" || key === "settings.update") {
        return (
          !(executorSrc + applySrc).includes(`"${key}"`) &&
          !applySrc.includes(`"${key.split("/").pop()}"`)
        );
      }
      return true;
    });
    expect(missing, "sensitive keys no executor registers").toEqual([]);
    expect(Object.keys(SENSITIVE_PROPOSAL_TYPE_PREFIXES)).toEqual([
      "governance.",
    ]);
  });

  // ── W3 slice 2: decisions that settle no proposal ──────────────────────────

  /** Approve/decide mutations that are everyday (or no pod approval), and why. */
  const EVERYDAY_DECISIONS: Record<string, string> = {
    "routers/intelligence.ts approveProposal":
      "forwards to the AI service's own proposal list (hubProxyFetch); any pod write it leads to comes back through the pod's own approve doors",
  };

  /** Every tRPC mutation named approve…/…Approve…/decide…, with its body. */
  function decisionProcedures(): Array<{ key: string; body: string }> {
    const out: Array<{ key: string; body: string }> = [];
    for (const f of FILES.filter((x) => x.path.startsWith("routers/"))) {
      const starts = [...f.src.matchAll(/^ {2}([A-Za-z]+):\s*[A-Za-z.]+/gm)];
      starts.forEach((m, i) => {
        const name = m[1]!;
        if (!/(?:approve|Approve|decide|Decide)/.test(name)) return;
        const body = f.src.slice(m.index, starts[i + 1]?.index ?? undefined);
        if (!body.includes(".mutation(")) return;
        out.push({ key: `${f.path} ${name}`, body });
      });
    }
    return out;
  }

  it("every approve/decide mutation gates with a proof, applies through applyProposalApproval, or is listed as everyday", () => {
    const procs = decisionProcedures();
    expect(procs.map((p) => p.key)).toEqual(
      expect.arrayContaining([
        "routers/proposals.ts approve",
        "routers/api-keys.ts decideKeyRequest",
        "routers/trusted-issuers.ts approve",
      ])
    );
    const ungated = procs
      .filter(
        (p) =>
          !/\bassertPresenceFor(?:Request|Approval)\(|\bapplyProposalApproval\(|\bdecideOAuthAuthorization\(|\bsetSkillApproved\(/.test(
            p.body
          ) && !(p.key in EVERYDAY_DECISIONS)
      )
      .map((p) => p.key);
    expect(
      ungated,
      "Gate these with assertPresenceForRequest (services/presence/gate.ts), or list them in EVERYDAY_DECISIONS with the reason"
    ).toEqual([]);
    // The OAuth consent's decision function gates itself.
    expect(
      FILES.find((f) => f.path === "routers/oauth/consent.ts")!.src
    ).toMatch(/kind: "oauth_consent"/);
  });

  it("every request kind is gated by a door, and the skip hooks are held by their one door each", () => {
    const all = FILES.map((f) => f.src).join("\n");
    for (const kind of Object.keys(PRESENCE_REQUEST_KINDS)) {
      expect(all, `no door gates "${kind}"`).toMatch(
        new RegExp(`kind: "${kind}"`)
      );
    }
    const holders = (hook: string) =>
      FILES.filter((f) => f.src.includes(hook))
        .map((f) => f.path)
        .sort();
    expect(holders('presenceChecked: "oauth.consent",')).toEqual([
      "routers/oauth/consent.ts",
    ]);
    expect(holders('presenceChecked: "applyProposalApproval",')).toEqual([
      "routers/proposals/executors/agent.ts",
      "routers/proposals/executors/capability.ts",
      "routers/proposals/executors/skill.ts",
    ]);
  });

  // ── W3 slice 3: sensitive ACTIONS (founder decision 1, 4 Nov) ──────────────

  /**
   * Credential doors that need no proof of presence, and why. Keyed by tRPC
   * path, or by `<file> <name>` for a procedure spread into a router from
   * another file (no path the scan can name). Rows marked FOUNDER are a
   * default the PR names for the founder to confirm.
   */
  const EVERYDAY_CREDENTIAL_DOORS: Record<string, string> = {
    "apiKeys.getDeviceRequest": "a read of a pending device request",
    "apiKeys.getKeyRequest": "a read of a pending key request",
    "applicationConnections.redeemRequest":
      "redeems a connection request already approved at applicationConnections.approveRequest (gated)",
    "apps.create":
      "registers an app with no reach; its reach comes from apps.requestAccess, an app/connect approval (gated)",
    "apps.requestAccess":
      "files an app/connect proposal; approving it is gated",
    "apps.rename": "a label",
    "apps.narrow": "only takes reach away",
    "apps.revoke": "only takes power away",
    "apps.remove": "only takes power away",
    "apps.adminRevoke": "only takes power away",
    "apps.adminRemove": "only takes power away",
    "apps.adminRevokeClient": "only takes power away",
    "machines.rename": "a label",
    "machines.revoke": "only takes power away",
    "govConfig.revoke": "only takes power away",
    "focusSessions.grantCapability":
      "a tool for ONE session room; an AI's grant routes to a proposal (checkPermissionOrPropose)",
    "relations.exposeToAnchor":
      "client-portal exposure on one anchor; the exposure floor scopes what it reads",
    "relations.grantAnchorMembership":
      "client-portal membership on one anchor; the exposure floor scopes what it reads",
    "capabilities.install":
      "FOUNDER: installs a catalog pack the person chose; the grants it writes take a step-up where written",
    "capabilities.applyUpdates":
      "FOUNDER: updates installed catalog packs; the grants it writes take a step-up where written",
    "marketplace.install":
      "FOUNDER: installs a catalog package the person chose",
    "packageUpdates.applyUpdate": "FOUNDER: updates an installed package",
    "forms.create": "FOUNDER: a form whose public link posts into the pod",
    "forms.update": "FOUNDER: a form whose public link posts into the pod",
    "shares.share":
      "FOUNDER: shares the person's own content; revocable; no key or rule over the pod",
    "shares.rotateLink": "replaces a share link (the old one stops)",
    "shares.publish": "FOUNDER: publishes the person's own content; revocable",
    "shares.configureSite": "FOUNDER: a public site of the person's content",
    "shares.publishSite": "FOUNDER: a public site of the person's content",
    "shares.rotateSiteToken": "replaces a site token (the old one stops)",
    "shares.publishToSite":
      "FOUNDER: publishes the person's content to their site",
    "shares.publishChartsToSite":
      "FOUNDER: publishes the person's charts to their site",
    "integrations.create":
      "FOUNDER: an outbound webhook delivers events the person chose",
    "integrations.update":
      "FOUNDER: an outbound webhook delivers events the person chose",
    "integrations.createForWorkspace":
      "FOUNDER: an outbound webhook delivers events the person chose",
    "integrations.toggleForWorkspace": "FOUNDER: switches a workspace webhook",
    "integrations.adminCreateForWorkspace":
      "FOUNDER: an outbound webhook (pod admin)",
    "integrations.adminToggleForWorkspace":
      "FOUNDER: switches a workspace webhook (pod admin)",
    "integrations.adminCreateInboundSource":
      "FOUNDER: an inbound source posts INTO the pod with its own secret",
    "integrations.adminRotateInboundSourceSecret":
      "replaces an inbound source's secret (the old one stops)",
    "routers/workspaces.ts installFromCatalog":
      "FOUNDER: installs a workspace template the person chose",
    "routers/workspaces.ts ensureTemplate":
      "FOUNDER: installs a workspace template the person chose",
    "routers/workspaces/definition-engine.ts createFromDefinition":
      "FOUNDER: creates a workspace from a definition",
    "routers/workspaces/definition-engine.ts reconcileFromDefinition":
      "FOUNDER: reconciles a workspace with its definition",
    "routers/workspaces/definition-engine.ts applyDefinition":
      "FOUNDER: applies a workspace definition",
    "routers/workspaces/invites.ts addMember":
      "FOUNDER: adds a member who signs in with their own credentials",
    "routers/workspaces/invites.ts updateMemberRole":
      "FOUNDER: changes a member's role (can make someone an admin)",
    "routers/workspaces/invites.ts createInvite":
      "FOUNDER: an invitation the invitee redeems with their own sign-in",
    "routers/workspaces/invites.ts regenerateInvite":
      "replaces an invitation link (the old one stops)",
  };

  /**
   * Every credential door: a router entry whose builder chain carries
   * `credentialProcedure` or `requireFreshAuthentication`, with its tRPC path
   * (the root mounts `<key>: <xRouter>`; the entry belongs to the nearest
   * `export const <xRouter> = router({` above it).
   */
  function credentialDoors(): Array<{
    key: string;
    path: string | null;
    body: string;
  }> {
    const root = FILES.find((f) => f.path === "root.ts")!.src;
    const prefixOf = new Map<string, string>();
    for (const m of root.matchAll(/^ {2}(\w+):\s*(\w+Router)\s*,?\s*$/gm)) {
      prefixOf.set(m[2]!, m[1]!);
    }
    const out: Array<{ key: string; path: string | null; body: string }> = [];
    for (const f of FILES.filter((x) => x.path.startsWith("routers/"))) {
      const routers = [
        ...f.src.matchAll(/export const (\w+)\s*(?::[^=]+)?=\s*router\(\{/g),
      ].map((m) => ({ name: m[1]!, at: m.index! }));
      const starts = [
        ...f.src.matchAll(/^ {2}([A-Za-z]+):\s*([A-Za-z]+Procedure)\b/gm),
      ];
      starts.forEach((m, i) => {
        const body = f.src.slice(m.index, starts[i + 1]?.index ?? undefined);
        const head = body.split(/\.(?:mutation|query|subscription)\(/)[0]!;
        if (!/\bcredentialProcedure\b|requireFreshAuthentication/.test(head)) {
          return;
        }
        const owner = routers.filter((r) => r.at < m.index!).pop()?.name;
        const prefix = owner ? prefixOf.get(owner) : undefined;
        out.push({
          key: `${f.path} ${m[1]}`,
          path: prefix ? `${prefix}.${m[1]}` : null,
          body,
        });
      });
    }
    return out;
  }

  /** A door that already asks for its own request's or approval's proof. */
  const GATED_ITSELF =
    /\bassertPresenceFor(?:Request|Approval)\(|\bapplyProposalApproval\(|\bdecideOAuthAuthorization\(|\bsetSkillApproved\(/;

  it("every credential door is a sensitive action, gates its own request, or is listed as everyday", () => {
    const doors = credentialDoors();
    // Non-vacuity: the scan sees the doors the founder named, by path.
    expect(doors.map((d) => d.path)).toEqual(
      expect.arrayContaining([
        "apiKeys.create",
        "governanceRules.widenCell",
        "apiKeys.setMachineDefaults",
      ])
    );
    expect(doors.length).toBeGreaterThan(70);
    const unclassified = doors
      .filter(
        (d) =>
          !(d.path && d.path in SENSITIVE_ACTIONS) &&
          !GATED_ITSELF.test(d.body) &&
          !((d.path ?? d.key) in EVERYDAY_CREDENTIAL_DOORS)
      )
      .map((d) => d.path ?? d.key);
    expect(
      unclassified,
      "Add the door to SENSITIVE_ACTIONS (@synap-core/types/presence) or to EVERYDAY_CREDENTIAL_DOORS with the reason"
    ).toEqual([]);
    // Both lists stay true: each names a real credential door.
    const known = new Set(doors.map((d) => d.path ?? d.key));
    expect(
      Object.keys(SENSITIVE_ACTIONS).filter((p) => !known.has(p)),
      "SENSITIVE_ACTIONS names a path that is no credential door (renamed? not credentialProcedure?)"
    ).toEqual([]);
    expect(
      Object.keys(EVERYDAY_CREDENTIAL_DOORS).filter((k) => !known.has(k)),
      "EVERYDAY_CREDENTIAL_DOORS names a door that no longer exists"
    ).toEqual([]);
  });

  it("the ONE step-up middleware asks SENSITIVE_ACTIONS for a proof bound to the call", () => {
    const trpc = FILES.find((f) => f.path === "trpc.ts")!.src;
    const mw = trpc.slice(
      trpc.indexOf("export const requireFreshAuthentication"),
      trpc.indexOf("export const credentialProcedure")
    );
    expect(mw).toMatch(/sensitiveActionReason\(opts\.path\)/);
    expect(mw).toMatch(/assertPresenceForAction\(/);
    expect(mw).toMatch(/getRawInput\(\)/);
  });

  /** Writes that turn a skill, tool or MCP server ON with no gate, and why. */
  const ON_WRITERS: Record<string, string> = {
    "routers/intelligence.ts":
      "provisions the pod's own Firecrawl MCP service for the workspace (intelligence.provisionMcpService)",
    "routers/proposals/executors/workspace.ts":
      "a workspace/template proposal's own tools and skills, applied on its (person's) approval",
    "routers/proposals/executors/skill.ts":
      "the skill/create executor: skill/create is a sensitive approval",
    "routers/hub-protocol/rest/mcp-servers.ts":
      "selects the column (a read: `columns: { approved: true }`), writes nothing",
    "connectors/materialize-tools.ts":
      "a connector's own tools, materialized when the person connects it",
    "services/capabilities/ensure-system-skills.ts":
      "boot seed: the pod's own system skills",
    "services/capabilities/ensure-synap-core.ts":
      "boot seed: the Synap core pack",
  };

  it("every write that turns a skill, tool or MCP server ON is gated or listed", () => {
    const writers = FILES.filter((f) =>
      /^\s+(?:\.set\(\{\s*)?approved: true\b(?!.*\/\/ read)/m.test(
        f.src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
      )
    ).map((f) => f.path);
    expect(writers.length).toBeGreaterThan(3);
    const unlisted = writers.filter(
      (p) =>
        !(p in ON_WRITERS) &&
        !GATED_ITSELF.test(FILES.find((f) => f.path === p)!.src)
    );
    expect(
      unlisted,
      "Gate this write (assertPresenceForRequest) or list it in ON_WRITERS with the reason"
    ).toEqual([]);
    expect(
      Object.keys(ON_WRITERS).filter((p) => !writers.includes(p)),
      "ON_WRITERS names a file that no longer turns anything on"
    ).toEqual([]);
  });
});
