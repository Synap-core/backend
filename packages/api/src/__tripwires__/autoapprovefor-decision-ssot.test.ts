import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative, dirname, resolve } from "path";
import { fileURLToPath } from "url";

/**
 * TRIPWIRE — `governance_rules` is the ONE decision store for auto-approve /
 * propose. The Governance Convergence Plan (Phase B) moved the AI-write
 * verdict off the legacy JSONB whitelists — `workspaces.settings.aiGovernance
 * .autoApproveFor` and `users.agentMetadata.autoApproveFor` — and onto
 * `resolveAgentGovernanceDecision` (@synap/database) /
 * `resolveGovernanceRule`, which read `governance_rules` rows. The JSONB
 * fields still exist (backfilled into rules at boot, mirrored by the write
 * surfaces) but must NEVER be read again to make an auto-approve/propose
 * decision — that would silently re-fork the decision into two concurrent
 * stores, exactly the "second concurrent store" bug Phase B closed in
 * `permission-check.ts`'s legacy AI-source path (see its own comment at the
 * `resolveGovernanceRule` call site).
 *
 * This is a SOURCE scan, not a behavioral test: it can't tell a legitimate
 * display/write/backfill read from a decision read by running code, so it
 * freezes today's verified-by-hand read sites as an ALLOWLIST (each with a
 * reason) and fails on any NEW file that references `autoApproveFor` outside
 * it. If this fails on a file you just touched: don't add it to the
 * allowlist — call `resolveAgentGovernanceDecision` (or `resolveGovernanceRule`
 * for the no-agent-row path) instead of reading the JSONB directly.
 *
 * Comment-only mentions of `autoApproveFor` (prose explaining the convention)
 * are NOT flagged — every line whose trimmed text starts with `//`, `/*`, or
 * `*` is stripped before scanning, so this only reacts to actual code:
 * property reads, type declarations, string literals, and object keys.
 *
 * SCOPE: `packages/api/src`, `packages/database/src`, and `packages/jobs/src`
 * (the automation governance door) — see SCAN_ROOTS below.
 * `packages/governance-policy/src` (the `decideAgentPolicy` engine, which takes
 * `autoApproveFor` as a plain function parameter, never reads the JSONB itself)
 * is out of scope.
 */

// Repo-root-relative path → one-line reason this file's `autoApproveFor`
// reference is NOT a decision read. Shrink-only: if a fix removes a file's
// last reference, delete its entry — never leave a stale allowlist row.
const ALLOWLIST: Record<string, string> = {
  // THE decision door itself — reads governance_rules, takes the JSONB list
  // only as a documented fallback input/reason string, never as the verdict.
  "packages/database/src/utils/resolve-agent-governance-decision.ts":
    "the resolver — the one place allowed to decide auto-approve vs propose",

  // The backfill/sync door (Phase B): reads the legacy JSONB exactly once,
  // at boot, to project it INTO governance_rules rows — never to answer an
  // auto-approve/propose question at request time.
  "packages/database/src/utils/backfill-governance-rules.ts":
    "backfill door — seeds governance_rules FROM the JSONB, does not decide with it",

  // Type declarations only (the JSONB shape itself) — no runtime read.
  "packages/database/src/schema/users.ts":
    "type declaration (AgentMetadata.autoApproveFor field), not a read",
  "packages/database/src/schema/workspaces.ts":
    "type declaration (WorkspaceSettings.aiGovernance.autoApproveFor field), not a read",

  // Display/introspection surface: `getEffectiveGovernance` reports what the
  // JSONB currently holds to the caller (GET .../governance, skills) — it
  // never gates a write. The actual write-time verdict is
  // `resolveAgentGovernanceDecision` / `resolveGovernanceRule`, called
  // elsewhere in this same file, which do not read the JSONB.
  "packages/api/src/utils/permission-check.ts":
    "getEffectiveGovernance() is read-only introspection, not the decision path",

  // Write surfaces (allowlisted, read-side SSOT only): these validate a
  // CALLER-SUPPLIED autoApproveFor list (an explicit governance-widening action,
  // itself proposal-gated) and MIRROR it into governance_rules. CONTRACT PHASE:
  // they no longer PERSIST the JSONB sub-key — they only mirror to rules. NOTE:
  // this scan does not guard the write side; it merely allowlists these files so
  // their legitimate list-handling isn't flagged as a decision read. A re-added
  // JSONB *persist* here would NOT be caught — only a JSONB decision *read*
  // (reading it back to decide whether some OTHER action auto-approves) is.
  "packages/api/src/routers/workspaces.ts":
    "workspaces.update write path — validates + mirrors an admin-supplied autoApproveFor into governance_rules; strips the JSONB sub-key before persisting",
  "packages/api/src/routers/hub-protocol/rest/agent-users.ts":
    "agent update write path — validates + mirrors a caller-supplied autoApproveFor into governance_rules; no longer persists the JSONB sub-key",
  "packages/api/src/routers/hub-protocol/rest/workspaces.ts":
    "provision-agent write path — mirrors the agent-workspace preset into governance_rules (no longer seeds the JSONB sub-key) + OpenAPI doc-string prose",
  "packages/api/src/services/capture-agent/ensure-capture-agent.ts":
    "capture-agent seed door — projects its declarative CAPTURE_AGENT_DEF into governance_rules (no longer into agent_metadata JSONB)",

  // Read-only display surfaces (introspection), not a decision read.
  "packages/api/src/routers/governance-rules.ts":
    "platformDefaults query — exposes the DEFAULT_AUTO_APPROVE floor under an `autoApproveFor` display key; read-only editor introspection, not a decision read",

  // Pure documentation string (OpenAPI `description`), not a property read.
  "packages/api/src/routers/hub-protocol/rest/channels.ts":
    "OpenAPI route description prose, not a property read",
};

const TOKEN = "autoApproveFor";

function isCommentOnlyLine(line: string): boolean {
  const t = line.trim();
  return (
    t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")
  );
}

function tsFilesUnderSrc(root: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "__tripwires__")
        continue;
      tsFilesUnderSrc(p, acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

// Anchor on THIS test file, not process.cwd() — vitest may run from the repo
// root or from packages/api, and a cwd-relative root silently scans nothing
// (→ 0 hits → false failures). src/__tripwires__ → up 4 = the backend repo root.
const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".."
);
const SCAN_ROOTS = [
  join(REPO_ROOT, "packages", "api", "src"),
  join(REPO_ROOT, "packages", "database", "src"),
  // The automation governance door (`automation-governance.ts`) lives here and
  // decides auto-approve vs propose via `resolveAgentGovernanceDecision` — scan
  // it too so a re-introduced direct JSONB decision read there is caught.
  join(REPO_ROOT, "packages", "jobs", "src"),
];

function liveOffenders(): { file: string; reason: string | undefined }[] {
  const files = SCAN_ROOTS.flatMap((root) => tsFilesUnderSrc(root));
  const hits: { file: string; reason: string | undefined }[] = [];
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    const codeText = lines.filter((l) => !isCommentOnlyLine(l)).join("\n");
    if (codeText.includes(TOKEN)) {
      const rel = relative(REPO_ROOT, f).split("\\").join("/");
      hits.push({ file: rel, reason: ALLOWLIST[rel] });
    }
  }
  return hits;
}

describe("tripwire: autoApproveFor is never read outside the governance-rules resolver's allowlist", () => {
  it("self-guard: the scan actually finds the known reference sites (dead-regex guard)", () => {
    const hits = liveOffenders();
    expect(
      hits.length,
      "expected several allowlisted files to reference autoApproveFor in code " +
        "(not just comments) — if this is 0, the scan/token broke silently"
    ).toBeGreaterThan(5);
  });

  it("every non-comment autoApproveFor reference is in the allowlist", () => {
    const hits = liveOffenders();
    const offenders = hits
      .filter((h) => h.reason === undefined)
      .map((h) => h.file);
    expect(
      offenders,
      "a new direct read of autoApproveFor was introduced outside the " +
        "resolver's allowlist. Route the decision through " +
        "resolveAgentGovernanceDecision() / resolveGovernanceRule() instead " +
        "of reading workspaces.settings.aiGovernance.autoApproveFor or " +
        "users.agentMetadata.autoApproveFor directly. Do NOT add the file " +
        "to ALLOWLIST unless the read is genuinely display/write/backfill, " +
        "not a decision — and document why."
    ).toEqual([]);
  });

  it("allowlist has no stale entries (every listed file still references autoApproveFor in code)", () => {
    const hits = liveOffenders();
    const liveFiles = new Set(hits.map((h) => h.file));
    const stale = Object.keys(ALLOWLIST).filter((f) => !liveFiles.has(f));
    expect(
      stale,
      "these allowlist entries no longer reference autoApproveFor in code — remove them (shrink-only)"
    ).toEqual([]);
  });
});
