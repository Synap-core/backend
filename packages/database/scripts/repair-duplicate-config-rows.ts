/**
 * One-off OPERATOR repair for three verified duplicate-config families on the
 * pod `pod.antoinesrvt.synap.live`. DRY-RUN BY DEFAULT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SCRIPT AND NOT A MIGRATION
 * ─────────────────────────────────────────────────────────────────────────────
 * These are ONE pod's legacy rows, identified by their literal UUIDs. A numbered
 * migration runs on EVERY pod, has no dry run, and stamps `_migrations` so it can
 * never be re-run to be corrected. A GENERIC duplicate-merge in a migration would
 * mutate other users' configuration on rules derived from a single sample — and
 * two of the three families below (see FAMILY 2) are direction-AMBIGUOUS even
 * with the rows in front of you. Merge direction is a judgment call, so it needs
 * an operator, a report, and an explicit flag. That is this file.
 *
 * The reconcile self-heal option (detect a scope-twin at boot and converge it)
 * is rejected as the REPAIR vehicle for the same reason — unattended, on every
 * pod, on a governed path, with no dry run. Its DETECTION half is worth having:
 * every run — dry or applied — ends with a detection sweep that REPORTS
 * contentHash collisions and same-name tools, and never merges them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY CONTRACT
 * ─────────────────────────────────────────────────────────────────────────────
 *  - Default action is REPORT ONLY. `--apply` is required to write anything.
 *  - Nothing is ever DELETED. The loser row is RETIRED (status/approved flipped
 *    plus a `metadata.repair` marker); references are RE-POINTED. Every row that
 *    will be touched is snapshotted to a JSON file BEFORE the transaction opens,
 *    and `--apply` aborts if the snapshot cannot be written.
 *  - Idempotent: a family whose loser already carries `metadata.repair.retiredAt`
 *    is reported as already-repaired and skipped.
 *  - Each family applies inside ONE transaction. A failure rolls the family back
 *    whole; other families are unaffected.
 *  - A credentialRef MISMATCH between the two rows aborts the family. Two rows
 *    with the same name but different credentials are two different accounts, not
 *    a duplicate, and merging them would silently re-bind an authorization to a
 *    credential nobody approved. `--allow-credential-mismatch` overrides, loudly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *   DATABASE_URL=… pnpm tsx packages/database/scripts/repair-duplicate-config-rows.ts
 *   DATABASE_URL=… pnpm tsx … --family=1 --apply
 *   DATABASE_URL=… pnpm tsx … --family=3 --apply --snapshot-dir=/srv/synap/repairs
 *   DATABASE_URL=… pnpm tsx … --family=2 --survivor=<uuid> --apply
 *
 * ROLLBACK
 *   Every mutation is an UPDATE (or one INSERT of a cloned grant) over rows
 *   captured in the snapshot file. To roll a family back, restore the snapshot's
 *   `before` rows by primary key and delete any `insertedGrantIds`. What CANNOT
 *   be rolled back is any real-world side effect an agent produced while the
 *   re-pointed grant was live (a sent email, a provider write). See ROLLBACK
 *   notes printed at the end of an `--apply` run.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

// ─────────────────────────────────────────────────────────────────────────────
// The verified families. Confirmed live against pod.antoinesrvt.synap.live.
// ─────────────────────────────────────────────────────────────────────────────

type FamilyKind = "tool" | "capability";

interface Family {
  n: 1 | 2 | 3;
  kind: FamilyKind;
  label: string;
  /** Row that SURVIVES. Undefined for family 2 — the operator must name it. */
  survivorId?: string;
  /** Row that is retired. Undefined for family 2 (derived from --survivor). */
  loserId?: string;
  /** Both candidate ids, for family 2's operator choice. */
  candidates: [string, string];
  rationale: string;
}

const FAMILIES: Family[] = [
  {
    n: 1,
    kind: "tool",
    label: "tools/google",
    survivorId: "b29a4f50-40fd-4558-8710-39faa0147d09", // workspace_id NULL
    loserId: "5351b1f8-8900-420d-8970-93aa5393479e", // workspace_id = Builder
    candidates: [
      "b29a4f50-40fd-4558-8710-39faa0147d09",
      "5351b1f8-8900-420d-8970-93aa5393479e",
    ],
    rationale: [
      "Survivor is the POD-WIDE row because it is the only one the applier can",
      "still maintain: nango-google.capability.json declares every skill",
      "scope:'pod', so createCapabilityFromDefinition computes",
      "connWorkspaceId = undefined and looks the tool up with",
      "isNull(tools.workspaceId) (create-from-definition.ts ~409 / ~596). The",
      "workspace-scoped twin is a legacy artifact that will NEVER be re-applied,",
      "which is why it alone lacks `intent` on its verbs. Direction is 'toward",
      "the row that can still converge', not 'toward the row that happens to",
      "hold the grant' — moving a grant is cheap, making a legacy row converge",
      "is impossible.",
    ].join(" "),
  },
  {
    n: 2,
    kind: "tool",
    label: "tools/discord",
    // Deliberately NO default direction — see rationale.
    candidates: [
      "5d6607f5-4fb3-44e0-ac26-01ad8d296d3d", // ws Builder, containerId NULL
      "5c68887a-f338-4823-8170-b10ac5dcb0c5", // ws CRM, container f979d634…
    ],
    rationale: [
      "DIRECTION IS A HUMAN CALL — the script refuses to pick. Both rows are",
      "workspace-scoped, in two DIFFERENT live workspaces (Builder, 861",
      "entities; CRM, 18 entities). Under a workspace-scoped model, one discord",
      "tool per workspace is legitimate, so this may not be a duplicate at all:",
      "if the two credentialRefs differ they are two different bots and merging",
      "would be destructive. Recommendation IF the credentials match: keep",
      "5c68887a (CRM) — it is a `member_of` a capability container, so a",
      "template can still own it, while 5d6607f5 is orphaned and can never be",
      "reconciled. But if the reference scan below shows the grants and stored",
      "automation flows sit on 5d6607f5, the cheaper repair is the opposite:",
      "keep 5d6607f5 and give it a container. Read the counts, then choose.",
    ].join(" "),
  },
  {
    n: 3,
    kind: "capability",
    label: "capabilities/Agency — AI Know-How",
    survivorId: "6126a194-463c-4c01-91e4-27a511d874f1", // workspace_id NULL
    loserId: "58e43215-6010-45af-b95f-57943374a3cc", // workspace_id = CRM
    candidates: [
      "6126a194-463c-4c01-91e4-27a511d874f1",
      "58e43215-6010-45af-b95f-57943374a3cc",
    ],
    rationale: [
      "Survivor is the POD-WIDE container, same applier argument as family 1.",
      "The CRM-scoped copy is the DURABLE LIE: both rows carry the IDENTICAL",
      "contentHash 42f664bb… and templateKey agency-skills while holding",
      "different content (the retired copy's description still names nango-gmail",
      "instead of nango-google). Because the stale copy is stamped current, the",
      "reconcile fast path skips it on every boot — it can never converge on its",
      "own, at any future template version. Its six member skills are retired",
      "WITH it: re-pointing them into the survivor would give the survivor twelve",
      "members for six logical skills.",
    ].join(" "),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

interface Options {
  families: Array<1 | 2 | 3>;
  apply: boolean;
  survivor?: string;
  snapshotDir: string;
  allowCredentialMismatch: boolean;
}

function parseArgs(argv: string[]): Options {
  const flag = (name: string): string | undefined => {
    const hit = argv.find(
      (a) => a === `--${name}` || a.startsWith(`--${name}=`)
    );
    if (!hit) return undefined;
    const eq = hit.indexOf("=");
    return eq === -1 ? "" : hit.slice(eq + 1);
  };
  const familyRaw = flag("family");
  const families: Array<1 | 2 | 3> = familyRaw
    ? familyRaw
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n): n is 1 | 2 | 3 => n === 1 || n === 2 || n === 3)
    : [1, 2, 3];
  return {
    families,
    apply: flag("apply") !== undefined,
    survivor: flag("survivor") || undefined,
    snapshotDir: flag("snapshot-dir") || "./repair-snapshots",
    allowCredentialMismatch: flag("allow-credential-mismatch") !== undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference surface
//
// `tools` and `capabilities` have ZERO foreign keys anywhere in the schema — no
// `REFERENCES tools`, no cascade — so every reference below is UNENFORCED and
// must be re-pointed by hand. Verified against packages/database/src/schema/.
// ─────────────────────────────────────────────────────────────────────────────

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;

interface SurfaceHit {
  /** Human name of the surface. */
  surface: string;
  /** true = the repair re-points these; false = history, reported only. */
  repointed: boolean;
  rows: Row[];
  note?: string;
}

async function scanToolReferences(
  sql: Sql,
  toolId: string
): Promise<SurfaceHit[]> {
  const hits: SurfaceHit[] = [];

  hits.push({
    surface: "vault_grants (grantable_type='tool')",
    repointed: true,
    note: "THE GRANT LIVES HERE. Cloned onto the survivor + original revoked.",
    rows: await sql`
      SELECT id, grantable_id, exec_mode, proposal_id, granted_to, workspace_id,
             scope, expires_at, max_uses, use_count, revoked_at, created_by
        FROM vault_grants
       WHERE grantable_type = 'tool' AND grantable_id = ${toolId}`,
  });

  hits.push({
    surface: "links (from_type/to_type = 'tool')",
    repointed: true,
    note: "member_of · requires · grants · provided_by · used edges.",
    rows: await sql`
      SELECT id, workspace_id, from_type, from_id, to_type, to_id, link_type
        FROM links
       WHERE (from_type = 'tool' AND from_id = ${toolId})
          OR (to_type   = 'tool' AND to_id   = ${toolId})`,
  });

  hits.push({
    surface: "links.metadata->>'toolId' (provides_credential scoping)",
    repointed: true,
    note:
      "MISSED BY THE INITIAL SURVEY. A dynamic auth binding scopes a " +
      "principal's credential to a specific tool via metadata.toolId " +
      "(schema/links.ts:112), not via an endpoint column.",
    rows: await sql`
      SELECT id, from_type, from_id, to_type, to_id, link_type, metadata
        FROM links
       WHERE metadata->>'toolId' = ${toolId}`,
  });

  hits.push({
    surface: "agent_configs.extra_tool_ids / disabled_tool_ids",
    repointed: true,
    rows: await sql`
      SELECT id, workspace_id, extra_tool_ids, disabled_tool_ids
        FROM agent_configs
       WHERE extra_tool_ids    @> ${sql.json([toolId])}::jsonb
          OR disabled_tool_ids @> ${sql.json([toolId])}::jsonb`,
  });

  hits.push({
    surface: "config_settings (scope_kind='bridge', scope_ref=toolId)",
    repointed: true,
    rows: await sql`
      SELECT id, capability_id, scope_kind, scope_ref, key, workspace_id, revoked_at
        FROM config_settings
       WHERE scope_kind = 'bridge' AND scope_ref = ${toolId}`,
  });

  hits.push({
    surface: "automations flow nodes (type='capability', data.capabilityId)",
    repointed: true,
    note:
      "MISSED BY THE INITIAL SURVEY. A Process-builder capability node stores " +
      "the TOOL ROW ID as `data.capabilityId` inside the flow JSONB " +
      "(schema/automations.ts:610-620). A stored flow pointing at a retired " +
      "tool stops resolving.",
    rows: await sql`
      SELECT id, workspace_id, name, status
        FROM automations
       WHERE flow::text LIKE ${"%" + toolId + "%"}`,
  });

  hits.push({
    surface: "playbooks (steps referencing the tool id)",
    repointed: true,
    note:
      "Text scan of the steps JSONB — playbooks grant tools via `links`, " +
      "but an inline step may embed the id.",
    rows: await sql`
      SELECT id, workspace_id, name
        FROM playbooks
       WHERE steps::text LIKE ${"%" + toolId + "%"}`,
  });

  hits.push({
    surface: "intelligence_commands.allowed_tools",
    repointed: true,
    note: "MISSED BY THE INITIAL SURVEY. jsonb string array; may hold ids.",
    rows: await sql`
      SELECT id, workspace_id, name, allowed_tools
        FROM intelligence_commands
       WHERE allowed_tools @> ${sql.json([toolId])}::jsonb`,
  });

  hits.push({
    surface: "proposals (target_id / payload)",
    repointed: false,
    note:
      "HISTORY — deliberately NOT re-pointed. A proposal records what was " +
      "decided at the time; rewriting it would falsify the audit trail.",
    rows: await sql`
      SELECT id, target_type, target_id, status, created_at
        FROM proposals
       WHERE target_id = ${toolId}
       ORDER BY created_at DESC
       LIMIT 20`,
  });

  return hits;
}

async function scanCapabilityReferences(
  sql: Sql,
  capabilityId: string
): Promise<SurfaceHit[]> {
  const hits: SurfaceHit[] = [];

  hits.push({
    surface: "secrets.capability_id (the connection registry)",
    repointed: true,
    note:
      "MISSED BY THE INITIAL SURVEY, and the sharpest one for family 3. A " +
      "capability CONNECTION is a `secrets` row bound to the CONTAINER id " +
      "(create-from-definition.ts:1177/1225/1236). Retiring a container without " +
      "re-pointing this strands a live credential.",
    rows: await sql`
      SELECT id, name, capability_id, account_hint, context_type, context_id,
             is_default, is_pod_wide, connection_state, workspace_id
        FROM secrets
       WHERE capability_id = ${capabilityId}`,
  });

  hits.push({
    surface: "config_settings.capability_id",
    repointed: true,
    rows: await sql`
      SELECT id, capability_id, scope_kind, scope_ref, key, workspace_id, revoked_at
        FROM config_settings
       WHERE capability_id = ${capabilityId}`,
  });

  hits.push({
    surface: "links member edges (to_type='capability')",
    repointed: false,
    note:
      "NOT re-pointed. These are the retired container's OWN six member skills; " +
      "moving them would give the survivor twelve members for six logical " +
      "skills. They are retired alongside their container instead.",
    rows: await sql`
      SELECT id, workspace_id, from_type, from_id, to_type, to_id, link_type
        FROM links
       WHERE (to_type = 'capability' AND to_id = ${capabilityId})
          OR (from_type = 'capability' AND from_id = ${capabilityId})`,
  });

  hits.push({
    surface: "workspaces.settings->'capabilityRenderers'->><capabilityId>",
    repointed: true,
    note:
      "MISSED BY THE INITIAL SURVEY. A per-workspace renderer override is keyed " +
      "BY the container id (schema/workspaces.ts:649). The key is re-keyed onto " +
      "the survivor only when the survivor has no override of its own.",
    rows: await sql`
      SELECT id, name, settings->'capabilityRenderers'->${capabilityId} AS override
        FROM workspaces
       WHERE settings->'capabilityRenderers' ? ${capabilityId}`,
  });

  hits.push({
    surface: "proposals (target_id)",
    repointed: false,
    note: "HISTORY — not re-pointed.",
    rows: await sql`
      SELECT id, target_type, target_id, status, created_at
        FROM proposals
       WHERE target_id = ${capabilityId}
       ORDER BY created_at DESC
       LIMIT 20`,
  });

  return hits;
}

async function scanSkillReferences(
  sql: Sql,
  skillIds: string[]
): Promise<SurfaceHit[]> {
  if (skillIds.length === 0) return [];
  return [
    {
      surface: "vault_grants (grantable_type='skill') on retiring skills",
      repointed: true,
      note:
        "Re-pointed by NAME onto the survivor container's same-named skill. A " +
        "grant with no same-named counterpart is REPORTED and left in place — " +
        "silently dropping an authorization is worse than an orphan.",
      rows: await sql`
        SELECT id, grantable_id, exec_mode, proposal_id, granted_to, workspace_id,
               scope, expires_at, max_uses, use_count, revoked_at, created_by
          FROM vault_grants
         WHERE grantable_type = 'skill' AND grantable_id = ANY(${skillIds})`,
    },
    {
      surface: "links touching the retiring skills",
      repointed: false,
      note: "Retired with their skills (skill --requires--> tool, member_of).",
      rows: await sql`
        SELECT id, from_type, from_id, to_type, to_id, link_type
          FROM links
         WHERE (from_type = 'skill' AND from_id = ANY(${skillIds}))
            OR (to_type   = 'skill' AND to_id   = ANY(${skillIds}))`,
    },
    {
      surface: "capability_run_receipts.skill_id",
      repointed: false,
      note:
        "HISTORY — an at-most-once claim for a run that already happened. Never " +
        "re-pointed. (Receipts carry skill_id + verb_id; they never carry a TOOL " +
        "id, so a tool merge cannot orphan one.)",
      rows: await sql`
        SELECT id, skill_id, verb_id, status, created_at
          FROM capability_run_receipts
         WHERE skill_id = ANY(${skillIds})
         ORDER BY created_at DESC
         LIMIT 20`,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

function printHits(hits: SurfaceHit[]): void {
  for (const h of hits) {
    const tag = h.rows.length === 0 ? "  ·" : h.repointed ? "  →" : "  ⊘";
    console.log(`${tag} ${h.surface}: ${h.rows.length} row(s)`);
    if (h.note && h.rows.length > 0) console.log(`      ${h.note}`);
    for (const r of h.rows) console.log(`      ${JSON.stringify(r)}`);
  }
}

const MARKER = "repair-duplicate-config-rows/2026-09-02";

// ─────────────────────────────────────────────────────────────────────────────
// Apply
// ─────────────────────────────────────────────────────────────────────────────

interface ApplyResult {
  updated: Record<string, number>;
  insertedGrantIds: string[];
  warnings: string[];
}

async function applyToolMerge(
  sql: Sql,
  survivorId: string,
  loserId: string
): Promise<ApplyResult> {
  const result: ApplyResult = {
    updated: {},
    insertedGrantIds: [],
    warnings: [],
  };

  await sql.begin(async (txRaw) => {
    // postgres.js types `TransactionSql` as `Omit<Sql, …>`, and `Omit` strips a
    // callable interface's call signature — so the tagged-template form is not
    // callable on the transaction handle without this cast. Runtime shape is
    // identical; this is a typings wart, not a behavioural one.
    const tx = txRaw as unknown as Sql;

    // 1. Clone every ACTIVE grant onto the survivor, carrying use_count so a
    //    max_uses budget is not silently reset, then revoke the original. A
    //    clone + revoke (rather than an UPDATE of grantable_id) keeps both sides
    //    of the audit trail readable: the original still shows what was approved
    //    against which row. `proposal_id` is carried over deliberately — the
    //    proposal DID authorize this capability; only the row id moved under it.
    const grants = await tx<Row[]>`
      SELECT * FROM vault_grants
       WHERE grantable_type = 'tool' AND grantable_id = ${loserId}
         AND revoked_at IS NULL`;
    for (const g of grants) {
      const [inserted] = await tx<Row[]>`
        INSERT INTO vault_grants
          (grantable_type, grantable_id, exec_mode, proposal_id, granted_to,
           workspace_id, scope, expires_at, max_uses, use_count, created_by)
        VALUES
          ('tool', ${survivorId}, ${g.exec_mode as string}, ${g.proposal_id as string | null},
           ${g.granted_to as string | null}, ${g.workspace_id as string | null},
           ${g.scope as string}, ${g.expires_at as Date | null},
           ${g.max_uses as number | null}, ${g.use_count as number}, ${g.created_by as string})
        RETURNING id`;
      result.insertedGrantIds.push(inserted.id as string);
      await tx`UPDATE vault_grants SET revoked_at = now() WHERE id = ${g.id as string}`;
    }
    result.updated["vault_grants(cloned+revoked)"] = grants.length;

    // 2. Graph edges. `links` carries a unique-edge index, so a re-point that
    //    would collide with an edge the survivor already has is dropped rather
    //    than allowed to abort the transaction.
    const fromLinks = await tx`
      UPDATE links SET from_id = ${survivorId}
       WHERE from_type = 'tool' AND from_id = ${loserId}
         AND NOT EXISTS (
           SELECT 1 FROM links l2
            WHERE l2.from_type = 'tool' AND l2.from_id = ${survivorId}
              AND l2.to_type = links.to_type AND l2.to_id = links.to_id
              AND l2.link_type = links.link_type)
       RETURNING id`;
    const toLinks = await tx`
      UPDATE links SET to_id = ${survivorId}
       WHERE to_type = 'tool' AND to_id = ${loserId}
         AND NOT EXISTS (
           SELECT 1 FROM links l2
            WHERE l2.to_type = 'tool' AND l2.to_id = ${survivorId}
              AND l2.from_type = links.from_type AND l2.from_id = links.from_id
              AND l2.link_type = links.link_type)
       RETURNING id`;
    result.updated["links(endpoints)"] = fromLinks.length + toLinks.length;

    const metaLinks = await tx`
      UPDATE links
         SET metadata = jsonb_set(metadata, '{toolId}', to_jsonb(${survivorId}::text))
       WHERE metadata->>'toolId' = ${loserId}
       RETURNING id`;
    result.updated["links.metadata.toolId"] = metaLinks.length;

    // 3. Agent tool allow/deny arrays — remove the loser, add the survivor once.
    const agentCfg = await tx`
      UPDATE agent_configs
         SET extra_tool_ids = CASE
               WHEN extra_tool_ids @> ${sql.json([loserId])}::jsonb
                 THEN (SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
                         FROM jsonb_array_elements(
                                extra_tool_ids || ${sql.json([survivorId])}::jsonb) t(v)
                        WHERE v <> ${sql.json(loserId)}::jsonb)
               ELSE extra_tool_ids END,
             disabled_tool_ids = CASE
               WHEN disabled_tool_ids @> ${sql.json([loserId])}::jsonb
                 THEN (SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
                         FROM jsonb_array_elements(
                                disabled_tool_ids || ${sql.json([survivorId])}::jsonb) t(v)
                        WHERE v <> ${sql.json(loserId)}::jsonb)
               ELSE disabled_tool_ids END
       WHERE extra_tool_ids    @> ${sql.json([loserId])}::jsonb
          OR disabled_tool_ids @> ${sql.json([loserId])}::jsonb
       RETURNING id`;
    result.updated["agent_configs"] = agentCfg.length;

    // 4. Bridge-scoped config rows.
    const cfg = await tx`
      UPDATE config_settings SET scope_ref = ${survivorId}
       WHERE scope_kind = 'bridge' AND scope_ref = ${loserId}
       RETURNING id`;
    result.updated["config_settings.scope_ref"] = cfg.length;

    // 5. Stored automation flows / playbook steps: a textual id swap inside the
    //    JSONB document. Safe because a UUID is unambiguous, but it is a blunt
    //    instrument — the touched rows are listed in the report and snapshot.
    const flows = await tx`
      UPDATE automations
         SET flow = REPLACE(flow::text, ${loserId}, ${survivorId})::jsonb
       WHERE flow::text LIKE ${"%" + loserId + "%"}
       RETURNING id`;
    result.updated["automations.flow"] = flows.length;

    const steps = await tx`
      UPDATE playbooks
         SET steps = REPLACE(steps::text, ${loserId}, ${survivorId})::jsonb
       WHERE steps::text LIKE ${"%" + loserId + "%"}
       RETURNING id`;
    result.updated["playbooks.steps"] = steps.length;

    const cmds = await tx`
      UPDATE intelligence_commands
         SET allowed_tools = (
               SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
                 FROM jsonb_array_elements(
                        allowed_tools || ${sql.json([survivorId])}::jsonb) t(v)
                WHERE v <> ${sql.json(loserId)}::jsonb)
       WHERE allowed_tools @> ${sql.json([loserId])}::jsonb
       RETURNING id`;
    result.updated["intelligence_commands.allowed_tools"] = cmds.length;

    // 6. Retire — never delete. `tools` has no FK anywhere, so a DELETE would
    //    succeed and silently strand anything this script failed to find. A
    //    retired row keeps the evidence. The NAME is deliberately left alone:
    //    the applier's fallback lookup matches on name when credentialRef is
    //    NULL, and a rename could change what a future re-apply resolves.
    await tx`
      UPDATE tools
         SET status = 'inactive',
             approved = false,
             metadata = metadata || ${sql.json({
               repair: {
                 marker: MARKER,
                 retiredAt: new Date().toISOString(),
                 mergedIntoToolId: survivorId,
               },
             })}::jsonb,
             updated_at = now()
       WHERE id = ${loserId}`;
    result.updated["tools(retired)"] = 1;
  });

  return result;
}

async function applyCapabilityMerge(
  sql: Sql,
  survivorId: string,
  loserId: string,
  loserSkillIds: string[]
): Promise<ApplyResult> {
  const result: ApplyResult = {
    updated: {},
    insertedGrantIds: [],
    warnings: [],
  };

  await sql.begin(async (txRaw) => {
    // See the note in applyToolMerge — postgres.js's TransactionSql loses its
    // call signature to `Omit`.
    const tx = txRaw as unknown as Sql;

    // 1. The live connection registry — a `secrets` row bound to the container.
    const secretsMoved = await tx`
      UPDATE secrets SET capability_id = ${survivorId}
       WHERE capability_id = ${loserId}
       RETURNING id`;
    result.updated["secrets.capability_id"] = secretsMoved.length;

    // 2. Container-scoped config rows.
    const cfg = await tx`
      UPDATE config_settings SET capability_id = ${survivorId}
       WHERE capability_id = ${loserId}
       RETURNING id`;
    result.updated["config_settings.capability_id"] = cfg.length;

    // 3. Per-workspace renderer override, keyed BY container id. Only re-keyed
    //    where the survivor has no override of its own — otherwise the retired
    //    container's override would silently overwrite a live one.
    const renderers = await tx`
      UPDATE workspaces
         SET settings = jsonb_set(
               settings #- ${sql.array(["capabilityRenderers", loserId])},
               ${sql.array(["capabilityRenderers", survivorId])},
               settings->'capabilityRenderers'->${loserId})
       WHERE settings->'capabilityRenderers' ? ${loserId}
         AND NOT (settings->'capabilityRenderers' ? ${survivorId})
       RETURNING id`;
    result.updated["workspaces.capabilityRenderers(re-keyed)"] =
      renderers.length;

    const rendererConflicts = await tx<Row[]>`
      SELECT id, name FROM workspaces
       WHERE settings->'capabilityRenderers' ? ${loserId}
         AND settings->'capabilityRenderers' ? ${survivorId}`;
    for (const w of rendererConflicts) {
      result.warnings.push(
        `workspace ${String(w.id)} (${String(w.name)}) has renderer overrides for ` +
          `BOTH containers — the retired one was left in place, unmoved. Decide by hand.`
      );
    }

    // 4. Skill grants: re-point by NAME onto the survivor's same-named skill.
    //    The retired container is STALE (it names nango-gmail), so its member
    //    set may not map one-to-one. An unmapped grant is reported, never dropped.
    for (const skillId of loserSkillIds) {
      const [loserSkill] = await tx<
        Row[]
      >`SELECT id, name FROM skills WHERE id = ${skillId}`;
      if (!loserSkill) continue;
      const [survivorSkill] = await tx<Row[]>`
        SELECT s.id FROM skills s
          JOIN links l ON l.from_type = 'skill' AND l.from_id = s.id::text
                      AND l.link_type = 'member_of'
                      AND l.to_type = 'capability' AND l.to_id = ${survivorId}
         WHERE s.name = ${loserSkill.name as string}
         LIMIT 1`;
      const grants = await tx<Row[]>`
        SELECT * FROM vault_grants
         WHERE grantable_type = 'skill' AND grantable_id = ${skillId}
           AND revoked_at IS NULL`;
      if (grants.length === 0) continue;
      if (!survivorSkill) {
        result.warnings.push(
          `${grants.length} active grant(s) on retiring skill "${String(loserSkill.name)}" ` +
            `(${skillId}) have NO same-named skill in the survivor container. LEFT IN ` +
            `PLACE, pointing at a retired skill. Dropping them would silently remove an ` +
            `authorization the user approved.`
        );
        continue;
      }
      for (const g of grants) {
        const [inserted] = await tx<Row[]>`
          INSERT INTO vault_grants
            (grantable_type, grantable_id, exec_mode, proposal_id, granted_to,
             workspace_id, scope, expires_at, max_uses, use_count, created_by)
          VALUES
            ('skill', ${survivorSkill.id as string}, ${g.exec_mode as string},
             ${g.proposal_id as string | null}, ${g.granted_to as string | null},
             ${g.workspace_id as string | null}, ${g.scope as string},
             ${g.expires_at as Date | null}, ${g.max_uses as number | null},
             ${g.use_count as number}, ${g.created_by as string})
          RETURNING id`;
        result.insertedGrantIds.push(inserted.id as string);
        await tx`UPDATE vault_grants SET revoked_at = now() WHERE id = ${g.id as string}`;
      }
      result.updated["vault_grants:skill(cloned+revoked)"] =
        (result.updated["vault_grants:skill(cloned+revoked)"] ?? 0) +
        grants.length;
    }

    // 5. Retire the container's member skills WITH it.
    if (loserSkillIds.length > 0) {
      await tx`
        UPDATE skills
           SET status = 'inactive',
               metadata = metadata || ${sql.json({
                 repair: {
                   marker: MARKER,
                   retiredAt: new Date().toISOString(),
                   retiredWithCapabilityId: loserId,
                 },
               })}::jsonb,
               updated_at = now()
         WHERE id = ANY(${loserSkillIds})`;
      result.updated["skills(retired)"] = loserSkillIds.length;
    }

    // 6. Retire the container. `approved = false` stops it being treated as
    //    trusted; the metadata marker makes the next run idempotent AND breaks
    //    the self-certifying contentHash — a future reconcile can no longer read
    //    this row as "clean at the current template version".
    await tx`
      UPDATE capabilities
         SET approved = false,
             metadata = metadata || ${sql.json({
               repair: {
                 marker: MARKER,
                 retiredAt: new Date().toISOString(),
                 mergedIntoCapabilityId: survivorId,
                 note: "contentHash was stamped but never earned — see reconcile drift comparator",
               },
             })}::jsonb,
             updated_at = now()
       WHERE id = ${loserId}`;
    result.updated["capabilities(retired)"] = 1;
  });

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("❌ DATABASE_URL is required");
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let exitCode = 0;

  console.log(
    opts.apply
      ? "⚠️  APPLY MODE — this run WILL write to the database.\n"
      : "🔍 DRY RUN — nothing will be written. Pass --apply to mutate.\n"
  );

  try {
    for (const n of opts.families) {
      const family = FAMILIES.find((f) => f.n === n);
      if (!family) continue;

      console.log(`\n${"═".repeat(78)}`);
      console.log(`FAMILY ${family.n} — ${family.label}`);
      console.log("═".repeat(78));
      console.log(family.rationale + "\n");

      // Resolve direction.
      let survivorId = family.survivorId;
      let loserId = family.loserId;
      if (!survivorId || !loserId) {
        if (!opts.survivor || !family.candidates.includes(opts.survivor)) {
          console.log(
            `⚠️  No direction. This family requires an explicit ` +
              `--survivor=<one of ${family.candidates.join(" | ")}>.\n` +
              `    Reporting both sides so the choice can be made from evidence.\n`
          );
          survivorId = undefined;
          loserId = undefined;
        } else {
          survivorId = opts.survivor;
          loserId = family.candidates.find((c) => c !== opts.survivor);
        }
      }

      const table = family.kind === "tool" ? "tools" : "capabilities";
      const rows = await sql<Row[]>`
        SELECT * FROM ${sql(table)} WHERE id = ANY(${family.candidates as string[]})`;
      if (rows.length < 2) {
        console.log(
          `· Only ${rows.length} of 2 rows present — nothing to merge (already ` +
            `repaired, or the pod differs from the survey).`
        );
        continue;
      }
      for (const r of rows) {
        console.log(`  row ${String(r.id)}`);
        console.log(
          `    workspace_id : ${String(r.workspace_id ?? "NULL (pod-wide)")}`
        );
        console.log(`    name         : ${String(r.name)}`);
        if (family.kind === "tool") {
          console.log(
            `    credentialRef: ${String(r.credential_ref ?? "NULL")}`
          );
          console.log(
            `    status       : ${String(r.status)} · approved=${String(r.approved)}`
          );
          const verbs =
            (r.capabilities as Array<{ id: string; intent?: string }>) ?? [];
          console.log(
            `    verbs        : ${verbs.length} (${verbs.filter((v) => v.intent).length} with intent)`
          );
        } else {
          console.log(`    description  : ${String(r.description ?? "")}`);
          const meta = (r.metadata as Record<string, unknown>) ?? {};
          console.log(`    contentHash  : ${String(meta.contentHash ?? "—")}`);
          console.log(`    templateKey  : ${String(meta.templateKey ?? "—")}`);
          console.log(
            `    repairMarker : ${meta.repair ? JSON.stringify(meta.repair) : "—"}`
          );
        }
      }

      // Idempotency.
      const already = rows.find(
        (r) =>
          (
            (r.metadata as Record<string, unknown>)?.repair as Record<
              string,
              unknown
            >
          )?.marker === MARKER
      );
      if (already) {
        console.log(
          `\n✅ Already repaired (row ${String(already.id)} carries the marker). Skipping.`
        );
        continue;
      }

      // Credential-mismatch guard (tools only).
      if (family.kind === "tool") {
        const [a, b] = rows;
        if (a.credential_ref !== b.credential_ref) {
          console.log(
            `\n🛑 credentialRef MISMATCH:\n     ${String(a.credential_ref)}\n     ${String(b.credential_ref)}\n` +
              `   These are two different accounts, not a duplicate. Merging would re-bind an\n` +
              `   authorization to a credential nobody approved. Refusing.` +
              (opts.allowCredentialMismatch
                ? "\n   (--allow-credential-mismatch given — proceeding anyway.)"
                : "")
          );
          if (!opts.allowCredentialMismatch) {
            exitCode = 2;
            continue;
          }
        }
      }

      // Reference scan for BOTH candidates — the counts are what family 2's
      // direction decision is made from.
      const scans: Record<string, SurfaceHit[]> = {};
      let loserSkillIds: string[] = [];
      for (const candidate of family.candidates) {
        console.log(`\n  ── references to ${candidate} ──`);
        const hits =
          family.kind === "tool"
            ? await scanToolReferences(sql, candidate)
            : await scanCapabilityReferences(sql, candidate);
        scans[candidate] = hits;
        printHits(hits);

        if (family.kind === "capability") {
          const memberSkills = await sql<Row[]>`
            SELECT s.id, s.name, s.status FROM skills s
              JOIN links l ON l.from_type = 'skill' AND l.from_id = s.id::text
                          AND l.link_type = 'member_of'
                          AND l.to_type = 'capability' AND l.to_id = ${candidate}`;
          console.log(`  → member skills: ${memberSkills.length}`);
          for (const s of memberSkills)
            console.log(`      ${String(s.id)}  ${String(s.name)}`);
          if (candidate === loserId) {
            loserSkillIds = memberSkills.map((s) => String(s.id));
            printHits(await scanSkillReferences(sql, loserSkillIds));
          }
        }
      }

      if (!survivorId || !loserId) {
        console.log(`\n· No direction chosen — report only for this family.`);
        continue;
      }

      console.log(`\n  PLAN: keep ${survivorId} · retire ${loserId}`);

      if (!opts.apply) {
        console.log("  (dry run — no writes)");
        continue;
      }

      // Snapshot BEFORE the transaction. Refuse to apply if it cannot be written.
      const snapshot = {
        marker: MARKER,
        family: family.n,
        survivorId,
        loserId,
        capturedAt: new Date().toISOString(),
        before: { rows, references: scans, loserSkillIds },
      };
      let snapshotPath: string;
      try {
        mkdirSync(opts.snapshotDir, { recursive: true });
        snapshotPath = join(
          opts.snapshotDir,
          `family-${family.n}-${stamp}.json`
        );
        writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
      } catch (err) {
        console.error(
          `  🛑 could not write the snapshot to ${opts.snapshotDir} (${String(err)}). ` +
            `Refusing to apply without a rollback artifact.`
        );
        exitCode = 3;
        continue;
      }
      console.log(`  📸 snapshot → ${snapshotPath}`);

      const res =
        family.kind === "tool"
          ? await applyToolMerge(sql, survivorId, loserId)
          : await applyCapabilityMerge(sql, survivorId, loserId, loserSkillIds);

      console.log("  ✅ applied:");
      for (const [k, v] of Object.entries(res.updated))
        console.log(`      ${k}: ${v}`);
      if (res.insertedGrantIds.length > 0) {
        console.log(`      inserted grant ids (delete these to roll back):`);
        for (const id of res.insertedGrantIds) console.log(`        ${id}`);
      }
      for (const w of res.warnings) console.log(`  ⚠️  ${w}`);

      writeFileSync(
        snapshotPath,
        JSON.stringify({ ...snapshot, applied: res }, null, 2),
        "utf8"
      );
    }

    // Detection sweep — the half of option (c) that is worth having. Reports,
    // never merges. A contentHash shared by two containers holding different
    // content is provably a stamp that was not earned: the fast path skips the
    // stale one forever, at every future template version.
    console.log(`\n${"═".repeat(78)}`);
    console.log("DETECTION SWEEP (report only — never auto-merges)");
    console.log("═".repeat(78));

    const hashTwins = await sql<Row[]>`
      SELECT metadata->>'templateKey' AS template_key,
             metadata->>'contentHash' AS content_hash,
             COUNT(*)::int AS n,
             array_agg(id::text) AS ids
        FROM capabilities
       WHERE metadata->>'contentHash' IS NOT NULL
       GROUP BY 1, 2
      HAVING COUNT(*) > 1`;
    console.log(
      `  contentHash collisions across containers: ${hashTwins.length}`
    );
    for (const r of hashTwins) console.log(`    ${JSON.stringify(r)}`);

    const scopeTwins = await sql<Row[]>`
      SELECT t.name, array_agg(t.id::text) AS ids,
             bool_or(t.workspace_id IS NULL)  AS has_podwide,
             bool_or(t.workspace_id IS NOT NULL) AS has_scoped
        FROM tools t
       GROUP BY t.name
      HAVING COUNT(*) > 1`;
    console.log(`  tools sharing a name: ${scopeTwins.length}`);
    for (const r of scopeTwins) console.log(`    ${JSON.stringify(r)}`);
  } finally {
    await sql.end({ timeout: 5 });
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
