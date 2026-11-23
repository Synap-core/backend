/**
 * The `storybook` capability's two verbs (plan 48854969 §9), behind
 * `builtin-verbs.ts`:
 *
 *   storybook.sync     names a Storybook (a pod file holding a bundle, or a
 *                      public URL), records it as a SOURCE connection (a
 *                      registry row with no secret, account hint
 *                      `storybook:<repo|url>`), stores what to read on the `ui`
 *                      kind's state, and runs connection sync on it. The first
 *                      run of a connection is ONE import proposal the person
 *                      approves; a failed read is a failed sync, recorded on
 *                      the kind state like any other, never an empty mirror.
 *   storybook.changed  READ-ONLY: the ui-components whose `source-hash`
 *                      differs from their `reviewed-hash`, most used first,
 *                      through the caller's entity read floor.
 *
 * The brand identity is the SOURCE's config (stored on the kind state with the
 * rest of the input), never written onto the mirrored records.
 */
import {
  and,
  asc,
  db,
  desc,
  drizzleSql,
  entities,
  eq,
  isNull,
  links,
  profiles,
  tools,
} from "@synap/database";
import {
  STORYBOOK_CHANGED_DEFAULT,
  STORYBOOK_PROVIDER,
} from "@synap-core/types/storybook";
import { isFailureErrorClass } from "@synap-core/types/failures";
import { entityReadVisibleWhere } from "../../access/entity-read-floor.js";
import { addSourceConnection } from "../capabilities/capability-connections.js";
import { VerbRefusal } from "../capabilities/verb-refusal.js";
import {
  runConnectionSync,
  type KindSyncResult,
} from "./connection-sync.js";
import {
  APP_PROFILE,
  STORYBOOK_SYNC_KIND,
  UI_COMPONENT_PROFILE,
  RELATION_COMPOSED_OF,
} from "./map-storybook-to-graph.js";
import { SyncReadError } from "./sync-kind-registry.js";
import { patchKindState } from "./sync-state-store.js";
import { readableEntityOfKind } from "./storybook-refs.js";
import {
  loadStorybookBundle,
  storybookAccountHint,
  type StorybookSyncInput,
} from "./storybook-sync.js";

export const BRAND_IDENTITY_PROFILE = "brand-identity";

/** A read failure, as the verb's refusal (its class kept). */
function asRefusal(err: unknown): never {
  if (err instanceof SyncReadError) {
    const cls = err.failure.errorClass;
    throw new VerbRefusal(err.message, isFailureErrorClass(cls) ? cls : "provider");
  }
  throw err;
}

/**
 * The storybook provider tool the run covers: the acting space's row first,
 * else the pod-wide one. Null when the capability is not installed.
 */
async function storybookTool(
  workspaceId: string | null
): Promise<{ id: string; capabilityId: string } | null> {
  const rows = await db
    .select({ id: tools.id, workspaceId: tools.workspaceId, capabilityId: links.toId })
    .from(tools)
    .innerJoin(
      links,
      and(
        eq(links.fromType, "tool"),
        eq(links.fromId, drizzleSql`${tools.id}::text`),
        eq(links.linkType, "member_of"),
        eq(links.toType, "capability")
      )
    )
    .where(eq(tools.name, STORYBOOK_PROVIDER))
    .orderBy(asc(tools.createdAt));
  const row =
    (workspaceId ? rows.find((r) => r.workspaceId === workspaceId) : undefined) ??
    rows.find((r) => r.workspaceId === null) ??
    null;
  return row ? { id: row.id, capabilityId: row.capabilityId } : null;
}

export interface StorybookSyncOutcome {
  /** The source connection (registry row) the sync ran on. */
  connectionId: string;
  /** True when this call recorded the source for the first time. */
  connectionCreated: boolean;
  /** What the source connection names (`storybook:<repo|url>`). */
  source: string;
  /** The `ui` kind's run: its phase, counts, the import proposal, or why it did not run. */
  run: KindSyncResult | { skipped: true; reason: string };
}

export async function syncStorybook(
  actor: { userId: string; workspaceId: string | null },
  input: StorybookSyncInput
): Promise<StorybookSyncOutcome> {
  if (!!input.bundleFileId === !!input.url) {
    throw new VerbRefusal(
      "Name one Storybook: a bundleFileId (a pod file holding a synap.storybook-bundle/v1) or a url.",
      "validation"
    );
  }
  if (input.url && !/^https:\/\//i.test(input.url)) {
    throw new VerbRefusal("The Storybook url must be https.", "validation");
  }
  if (input.appId && !(await readableEntityOfKind(actor.userId, input.appId, APP_PROFILE))) {
    throw new VerbRefusal(`No app (${APP_PROFILE}) ${input.appId} you can read.`, "target_missing");
  }
  if (
    input.brandIdentityId &&
    !(await readableEntityOfKind(actor.userId, input.brandIdentityId, BRAND_IDENTITY_PROFILE))
  ) {
    throw new VerbRefusal(
      `No brand identity ${input.brandIdentityId} you can read.`,
      "target_missing"
    );
  }

  const tool = await storybookTool(actor.workspaceId);
  if (!tool) {
    throw new VerbRefusal(
      "The storybook capability is not installed on this pod: install it from the market first.",
      "kind_missing"
    );
  }

  // A bundle names its repo: read it once here to name the source (a bundle
  // that does not read is refused before anything is recorded). The run reads
  // it again, so a failure there is a failed sync on the source.
  const bundle = input.bundleFileId
    ? await loadStorybookBundle(actor.userId, input).catch(asRefusal)
    : null;
  const source = storybookAccountHint(input, bundle);
  const conn = await addSourceConnection({
    capabilityId: tool.capabilityId,
    actorUserId: actor.userId,
    label: `Storybook · ${source.slice(STORYBOOK_PROVIDER.length + 1)}`,
    accountHint: source,
  });

  const stored: StorybookSyncInput = {
    ...(input.bundleFileId ? { bundleFileId: input.bundleFileId } : {}),
    ...(input.url ? { url: input.url.replace(/\/+$/, "") } : {}),
    ...(input.appId ? { appId: input.appId } : {}),
    ...(input.brandIdentityId ? { brandIdentityId: input.brandIdentityId } : {}),
  };
  await patchKindState(
    { toolId: tool.id, kind: STORYBOOK_SYNC_KIND, connectionId: conn.id },
    { input: stored as Record<string, unknown> }
  );

  const ran = await runConnectionSync({
    provider: STORYBOOK_PROVIDER,
    toolId: tool.id,
    connectionId: conn.id,
    reason: "manual",
  });
  const run: StorybookSyncOutcome["run"] =
    ran.connections?.find((c) => c.connectionId === conn.id)?.kinds[STORYBOOK_SYNC_KIND] ??
    { skipped: true, reason: ran.reason ?? "not_run" };
  return { connectionId: conn.id, connectionCreated: conn.created, source, run };
}

export interface ChangedComponent {
  id: string;
  title: string;
  status: string | null;
  sourcePath: string | null;
  sourceHash: string | null;
  reviewedHash: string | null;
  /** How many records are composed of it (pages and components): the order. */
  usedBy: number;
}

/**
 * The ui-components changed since their last review, most used first. A
 * component never reviewed (no `reviewed-hash`) counts as changed; a gone one
 * does not (there is nothing left to review).
 */
export async function changedStorybookComponents(
  userId: string,
  opts: { limit?: number; appId?: string }
): Promise<{ components: ChangedComponent[] }> {
  const limit = opts.limit ?? STORYBOOK_CHANGED_DEFAULT;
  const props = entities.properties;
  const usedBy = drizzleSql<number>`(
    SELECT count(*)::int FROM relations r
    WHERE r.target_entity_id = ${entities.id}
      AND r.type = ${RELATION_COMPOSED_OF}
  )`;
  const rows = await db
    .select({
      id: entities.id,
      title: entities.title,
      status: entities.status,
      sourcePath: drizzleSql<string | null>`${props}->>'source-path'`,
      sourceHash: drizzleSql<string | null>`${props}->>'source-hash'`,
      reviewedHash: drizzleSql<string | null>`${props}->>'reviewed-hash'`,
      usedBy,
    })
    .from(entities)
    .innerJoin(profiles, eq(profiles.id, entities.profileId))
    .where(
      and(
        eq(profiles.slug, UI_COMPONENT_PROFILE),
        isNull(entities.deletedAt),
        entityReadVisibleWhere(userId),
        drizzleSql`COALESCE(${entities.status}, '') <> 'gone'`,
        drizzleSql`(${props}->>'source-hash') IS DISTINCT FROM (${props}->>'reviewed-hash')`,
        ...(opts.appId ? [drizzleSql`${props}->>'design-app' = ${opts.appId}`] : [])
      )
    )
    .orderBy(desc(usedBy), asc(entities.title))
    .limit(limit);
  return {
    components: rows.map((r) => ({
      id: r.id,
      title: r.title ?? "",
      status: r.status ?? null,
      sourcePath: r.sourcePath,
      sourceHash: r.sourceHash,
      reviewedHash: r.reviewedHash,
      usedBy: Number(r.usedBy),
    })),
  };
}
