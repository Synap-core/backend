import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * TRIPWIRE — an agent holds no space or project seat; membership is read
 * through `membershipHolderIds` (database `utils/owner-person.ts`).
 *
 * 1. RAW READS. `eq(<workspaceMembers|projectMembers>.userId, …)` reads the
 *    membership of an id as given: for an agent id it finds nothing (it holds
 *    no seat) or, worse, a stray seat. A read keyed on a caller goes through
 *    `getWorkspaceMembership` / `memberWorkspaceIds` / `inArray(…,
 *    membershipHolderIds(id))`. The raw reads that remain (invites, rosters,
 *    provisioning, removal, the pod-admin check an agent must never pass) are
 *    a ratchet per file: a new one, or one more in a file, fails here.
 * 2. SEAT WRITERS. Every `.insert(workspaceMembers|projectMembers)` site is
 *    listed: a new writer must be reviewed as a person-only seat writer (agent
 *    seats were deleted with their writers and by migration 0450).
 *
 * Granularity is the file (a moved read inside a listed file under its count
 * is not seen), and the regexes see only the drizzle builder spellings below:
 * a raw SQL `workspace_members.user_id = …` is not scanned.
 */

const PACKAGES = join(__dirname, "../../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "__tripwires__") continue;
      walk(p, out);
      continue;
    }
    if (!p.endsWith(".ts") || p.endsWith(".test.ts") || p.endsWith(".d.ts"))
      continue;
    out.push(p);
  }
  return out;
}

const RAW_READ =
  /eq\(\s*[\w.]*\b(?:workspaceMembers|projectMembers)\.userId\s*,/g;
const SEAT_INSERT =
  /\.insert\(\s*[\w.]*\b(?:workspaceMembers|projectMembers)\s*\)/g;

/** Raw reads left, per file (relative to `packages/`). Ceilings only fall. */
const RAW_READ_BASELINE: Record<string, number> = {
  "api/src/access/door.ts": 1,
  "api/src/lib/permissions.ts": 1,
  "api/src/routers/admin-source-configs.ts": 2,
  "api/src/routers/agent-users.ts": 2,
  "api/src/routers/ai-provider-credentials.ts": 2,
  "api/src/routers/capture.ts": 1,
  "api/src/routers/channels/helpers.ts": 2,
  "api/src/routers/channels/send-message.ts": 1,
  "api/src/routers/external/chat.ts": 1,
  "api/src/routers/external/openai-compat.ts": 1,
  "api/src/routers/guidelines.ts": 1,
  "api/src/routers/hub-protocol/rest/agent-users.ts": 1,
  "api/src/routers/hub-protocol/rest/briefs.ts": 1,
  "api/src/routers/hub-protocol/rest/connectors.ts": 2,
  "api/src/routers/hub-protocol/rest/discord-identity.ts": 1,
  "api/src/routers/hub-protocol/rest/setup.ts": 3,
  "api/src/routers/hub-protocol/rest/workspaces.ts": 9,
  "api/src/routers/mcp/http-handler.ts": 1,
  "api/src/routers/onboarding.ts": 1,
  "api/src/routers/playbooks.ts": 1,
  "api/src/routers/proposals.ts": 1,
  "api/src/routers/proposals/review-authority.ts": 1,
  "api/src/routers/relations.ts": 1,
  "api/src/routers/system.ts": 3,
  "api/src/routers/typesense.ts": 1,
  "api/src/routers/views.ts": 1,
  "api/src/routers/workspaces.ts": 4,
  "api/src/routers/workspaces/accept-invite-for.ts": 1,
  "api/src/routers/workspaces/definition-engine.ts": 3,
  "api/src/routers/workspaces/invites.ts": 12,
  "api/src/routers/workspaces/mcp-servers.ts": 2,
  "api/src/scripts/create-admin-user.ts": 2,
  "api/src/services/app-connect.ts": 1,
  "api/src/services/capabilities/builtin-verbs.ts": 1,
  "api/src/services/capabilities/marketplace-install.ts": 1,
  "api/src/services/discover/discover.ts": 1,
  "api/src/services/external-user-mapping.ts": 1,
  "api/src/services/import/structuring.ts": 1,
  "api/src/services/messaging/room-people.ts": 1,
  "api/src/services/package-dependency-resolver.ts": 1,
  "api/src/services/sharing/share-service.ts": 3,
  "api/src/services/signal/index.ts": 1,
  "api/src/services/template-apply/resolve-target.ts": 4,
  "api/src/services/workspace-creation-service.ts": 1,
  "api/src/services/workspace-materialization-service.ts": 1,
  "api/src/trpc.ts": 1,
  "api/src/utils/resolve-chat-target.ts": 1,
  "api/src/utils/workspace-membership.ts": 1,
  "api/src/utils/workspace-role.ts": 1,
  "database/src/repositories/project-member-repository.ts": 2,
  "database/src/repositories/workspace-member-repository.ts": 2,
  "database/src/services/pod-user-access.ts": 2,
  "database/src/services/user-provisioning.ts": 6,
  "database/src/services/workspace-resolution-service.ts": 2,
  "database/src/utils/automation-owner-access.ts": 1,
  "database/src/utils/pod-membership.ts": 2,
  "database/src/utils/user-default-workspace.ts": 1,
  "scripts/src/generate-table-code.ts": 1,
};

/** Where a seat may be written (always a person's), per file. */
const SEAT_WRITERS: Record<string, number> = {
  "api/src/routers/hub-protocol/rest/setup.ts": 1,
  "api/src/routers/sync.ts": 1,
  "api/src/scripts/create-admin-user.ts": 2,
  "api/src/services/external-user-mapping.ts": 1,
  "api/src/utils/workspace-role.ts": 1,
  "database/src/repositories/project-member-repository.ts": 1,
  "database/src/repositories/workspace-member-repository.ts": 1,
  "database/src/services/user-provisioning.ts": 3,
  "jobs/src/workers/materializer.ts": 1,
};

const files = walk(PACKAGES);
const count = (re: RegExp) => {
  const out: Record<string, number> = {};
  for (const f of files) {
    const n = (readFileSync(f, "utf8").match(re) ?? []).length;
    if (n > 0) out[relative(PACKAGES, f)] = n;
  }
  return out;
};
const rawReads = count(RAW_READ);
const seatInserts = count(SEAT_INSERT);

describe("tripwire: agents hold no seat; membership reads go through the holder", () => {
  it("NON-VACUITY: the scan sees the source and both patterns", () => {
    expect(files.length).toBeGreaterThan(1000);
    expect("eq(workspaceMembers.userId, userId)".match(RAW_READ)).toHaveLength(
      1
    );
    expect(".insert(workspaceMembers)".match(SEAT_INSERT)).toHaveLength(1);
    expect(Object.keys(seatInserts).length).toBeGreaterThan(3);
    const holder = readFileSync(
      join(PACKAGES, "database/src/utils/permissions.ts"),
      "utf8"
    );
    expect(holder).toContain("membershipHolderIds(context.userId)");
  });

  it("no new raw membership read keyed on an id", () => {
    const over = Object.entries(rawReads)
      .filter(([f, n]) => n > (RAW_READ_BASELINE[f] ?? 0))
      .map(([f, n]) => `${f}: ${n} (allowed ${RAW_READ_BASELINE[f] ?? 0})`);
    expect(
      over,
      "Read membership through getWorkspaceMembership / memberWorkspaceIds / " +
        "inArray(…, membershipHolderIds(id)): an agent's membership is its person's."
    ).toEqual([]);
  });

  it("the raw-read ceilings only fall (a read routed away lowers its row)", () => {
    const stale = Object.entries(RAW_READ_BASELINE)
      .filter(([f, n]) => (rawReads[f] ?? 0) < n)
      .map(([f, n]) => `${f}: ${rawReads[f] ?? 0} < ${n}`);
    expect(stale, "Lower these rows in RAW_READ_BASELINE.").toEqual([]);
  });

  it("no new seat writer", () => {
    expect(
      seatInserts,
      "A new workspace/project member insert: an agent is never a member. " +
        "Write a person's seat through the repositories, then list it here."
    ).toEqual(SEAT_WRITERS);
  });
});
