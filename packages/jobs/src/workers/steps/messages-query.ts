/**
 * `messages_query` source step — reads a client's stored chat messages, with
 * the `all-channels` fan-out and `includeDocuments` linked-document gather.
 */
import {
  db,
  eq,
  and,
  or,
  isNull,
  inArray,
  desc,
  entities,
  channels,
  messages,
  documents,
  links,
  drizzleSql,
  EntityBodyService,
  eventRepository,
} from "@synap/database";
import { ChannelType } from "@synap/database/schema";
import { resolveTemplate } from "../template-resolve.js";
import { logger } from "../automation-executor-logger.js";
import type { StepContext } from "../automation-executor-types.js";

const MESSAGES_QUERY_TOTAL_CEILING = 200;
/** Per-document body-preview cap (chars) so a long doc can't dominate the budget. */
const MESSAGES_QUERY_DOC_BODY_CAP = 4000;
/** Bound the linked-document gather. */
const MESSAGES_QUERY_DOC_LIMIT = 20;

/** One message projected into the node's output shape. */
type MessagesQueryRow = {
  role: string;
  content: string;
  metadata: unknown;
  timestamp: Date | string;
};
function projectMessage(m: MessagesQueryRow) {
  return {
    role: m.role,
    content: m.content,
    authorName:
      (m.metadata as { sender?: { name?: string } } | null)?.sender?.name ??
      null,
    createdAt:
      m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
  };
}

/**
 * Gather the entity's linked documents (title + DB-only body preview) for the
 * `includeDocuments` flag. Mirrors how `getThreadContext` resolves linked
 * entities → documents: candidate documents are the subject entity's OWN body
 * document (`entities.documentId`) PLUS the body documents of entities linked to
 * it (`links` where either endpoint is `(entity, subjectEntityId)`), and the
 * DOCUMENT read is floored by the SAME workspace predicate as every other read
 * in this node. Bodies use `EntityBodyService.getPreview` (DB-only version
 * content, no MinIO fetch).
 */
async function gatherLinkedDocuments(
  subjectEntityId: string,
  workspaceId: string
): Promise<
  Array<{
    documentId: string;
    entityId: string;
    title: string | null;
    body: string | null;
  }>
> {
  // Linked entities (either direction) whose OTHER endpoint is an entity —
  // floored to links the automation's workspace may see (workspace OR pod-wide).
  const linkRows = await db
    .select({
      fromType: links.fromType,
      fromId: links.fromId,
      toType: links.toType,
      toId: links.toId,
    })
    .from(links)
    .where(
      and(
        or(eq(links.workspaceId, workspaceId), isNull(links.workspaceId)),
        or(
          and(eq(links.fromType, "entity"), eq(links.fromId, subjectEntityId)),
          and(eq(links.toType, "entity"), eq(links.toId, subjectEntityId))
        )
      )
    )
    .limit(100);

  const entityIds = new Set<string>([subjectEntityId]);
  for (const l of linkRows) {
    if (
      l.fromType === "entity" &&
      l.fromId === subjectEntityId &&
      l.toType === "entity"
    )
      entityIds.add(l.toId);
    if (
      l.toType === "entity" &&
      l.toId === subjectEntityId &&
      l.fromType === "entity"
    )
      entityIds.add(l.fromId);
  }

  const entityRows = await db.query.entities.findMany({
    where: and(
      inArray(entities.id, [...entityIds]),
      or(eq(entities.workspaceId, workspaceId), isNull(entities.workspaceId)),
      isNull(entities.deletedAt)
    ),
    columns: { id: true, title: true, documentId: true },
  });
  const docToEntity = new Map<
    string,
    { entityId: string; entityTitle: string | null }
  >();
  for (const e of entityRows) {
    if (e.documentId)
      docToEntity.set(e.documentId, {
        entityId: e.id,
        entityTitle: e.title ?? null,
      });
  }
  const documentIds = [...docToEntity.keys()];
  if (documentIds.length === 0) return [];

  // Content gate: documents are read through the SAME workspace floor.
  const docRows = await db.query.documents.findMany({
    where: and(
      inArray(documents.id, documentIds),
      or(eq(documents.workspaceId, workspaceId), isNull(documents.workspaceId)),
      isNull(documents.deletedAt)
    ),
    columns: { id: true, title: true },
    limit: MESSAGES_QUERY_DOC_LIMIT,
  });

  const bodyService = new EntityBodyService(db, eventRepository);
  const out: Array<{
    documentId: string;
    entityId: string;
    title: string | null;
    body: string | null;
  }> = [];
  for (const d of docRows) {
    const preview = await bodyService.getPreview(d.id);
    const owner = docToEntity.get(d.id);
    out.push({
      documentId: d.id,
      entityId: owner?.entityId ?? subjectEntityId,
      title: d.title ?? owner?.entityTitle ?? null,
      body: preview ? preview.slice(0, MESSAGES_QUERY_DOC_BODY_CAP) : null,
    });
  }
  return out;
}

/**
 * Execute a messages_query SOURCE step: read a client's stored chat messages.
 *
 * Resolution: an explicit `channelId` wins; otherwise, for `subjectEntityId`:
 *   - DEFAULT `scope: "single-external"` — the single EXTERNAL client-comms
 *     channel bound to the entity (today's exact, unchanged behavior). An entity
 *     often has BOTH a team THREAD and an EXTERNAL client-comms channel bound to
 *     the same contextObjectId; the default reads the EXTERNAL one only.
 *   - `scope: "all-channels"` — the "gathering primitive": EVERY channel bound
 *     to the entity (optionally filtered by `channelTypes` / `branchPurpose`),
 *     each channel's recent history MERGED chronologically, each message tagged
 *     with its `source` channel so a downstream `ai.generate` can attribute it.
 *
 * ACCESS FLOOR (mandatory, identical in every branch): a channel/document must
 * live in the automation's workspace OR be pod-wide (workspace_id NULL). This is
 * the SAME `or(eq(workspaceId, ws), isNull(workspaceId))` predicate the
 * single-channel path has always used and that the access layer / `channel.resolve`
 * enforce — the fan-out never widens it. (jobs cannot import @synap/api's
 * `channel.resolve` / `queryChannelMessages` — a documented circular dep — so the
 * SAME query SHAPE + SAME floor is applied here over @synap/database directly,
 * generalizing this node's own existing channel query rather than adding a new
 * channel-resolution philosophy.)
 *
 * DEFAULT output (single channel):
 * `{ messages: [{ role, content, authorName, createdAt }], channelId, count }`.
 * FAN-OUT output is a SUPERSET (see MessagesQueryNodeDef doc). `includeDocuments`
 * adds `documents` in either mode.
 */
export async function executeMessagesQueryStep(
  data: {
    subjectEntityId?: string;
    channelId?: string;
    limit?: number;
    scope?: string;
    channelTypes?: string[];
    branchPurpose?: string;
    includeDocuments?: boolean;
  },
  context: StepContext,
  workspaceId: string
): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(Number(data.limit ?? 40), 1), 200);

  // The id fields may reference trigger payload / prior step outputs.
  const subjectEntityId = data.subjectEntityId
    ? resolveTemplate(data.subjectEntityId, context) || undefined
    : undefined;
  let channelId = data.channelId
    ? resolveTemplate(data.channelId, context) || undefined
    : undefined;

  // Additive linked-document gather (either mode; requires a resolved subject).
  const documentsOut =
    data.includeDocuments && subjectEntityId
      ? await gatherLinkedDocuments(subjectEntityId, workspaceId)
      : undefined;
  const withDocs = (out: Record<string, unknown>): Record<string, unknown> =>
    documentsOut ? { ...out, documents: documentsOut } : out;

  // ---- FAN-OUT: scope="all-channels" over a subject entity (no explicit channelId) ----
  if (data.scope === "all-channels" && !channelId && subjectEntityId) {
    const typeFilter = data.channelTypes?.length
      ? or(
          ...data.channelTypes.map(
            (t) => drizzleSql`${channels.channelType} = ${t}`
          )
        )
      : undefined;
    const chans = await db.query.channels.findMany({
      where: and(
        eq(channels.contextObjectType, "entity"),
        eq(channels.contextObjectId, subjectEntityId),
        data.branchPurpose
          ? eq(channels.branchPurpose, data.branchPurpose)
          : undefined,
        typeFilter,
        // SAME FLOOR as the single-channel path.
        or(eq(channels.workspaceId, workspaceId), isNull(channels.workspaceId))
      ),
      columns: {
        id: true,
        channelType: true,
        branchPurpose: true,
        title: true,
      },
      orderBy: [desc(channels.updatedAt)],
      limit: 50,
    });

    if (chans.length === 0) {
      return withDocs({
        messages: [],
        channelId: null,
        count: 0,
        channels: [],
        truncated: false,
      });
    }

    const merged: Array<
      ReturnType<typeof projectMessage> & { source: unknown }
    > = [];
    for (const ch of chans) {
      const rows = await db.query.messages.findMany({
        where: and(
          eq(messages.channelId, ch.id),
          isNull(messages.deletedAt),
          // Ephemeral recaps ("catch me up") are live-only — never gathered
          // into a fresh synthesis context (the canonical read triad).
          eq(messages.ephemeral, false)
        ),
        columns: { role: true, content: true, metadata: true, timestamp: true },
        orderBy: [desc(messages.timestamp)],
        limit,
      });
      const source = {
        channelId: ch.id,
        channelType: ch.channelType,
        branchPurpose: ch.branchPurpose ?? null,
        title: ch.title ?? null,
      };
      for (const m of rows) merged.push({ ...projectMessage(m), source });
    }

    // Merge chronologically (oldest → newest) across all channels.
    merged.sort((a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt))
    );

    let truncated = false;
    let capped = merged;
    if (merged.length > MESSAGES_QUERY_TOTAL_CEILING) {
      truncated = true;
      // Keep the MOST-RECENT ceiling messages.
      capped = merged.slice(merged.length - MESSAGES_QUERY_TOTAL_CEILING);
      logger.warn(
        {
          subjectEntityId,
          workspaceId,
          gathered: merged.length,
          ceiling: MESSAGES_QUERY_TOTAL_CEILING,
          channels: chans.length,
        },
        "messages_query all-channels: gathered history exceeded ceiling — truncated to most-recent"
      );
    }

    return withDocs({
      messages: capped,
      channelId: null,
      count: capped.length,
      channels: chans.map((c) => ({
        id: c.id,
        channelType: c.channelType,
        branchPurpose: c.branchPurpose ?? null,
        title: c.title ?? null,
      })),
      truncated,
    });
  }

  // ---- DEFAULT: single channel (explicit channelId, or single-external subject) ----
  if (channelId) {
    const ch = await db.query.channels.findFirst({
      where: and(
        eq(channels.id, channelId),
        or(eq(channels.workspaceId, workspaceId), isNull(channels.workspaceId))
      ),
      columns: { id: true },
    });
    if (!ch) {
      throw new Error(
        `messages_query: channel ${channelId} not visible in workspace ${workspaceId}`
      );
    }
  } else if (subjectEntityId) {
    // Resolve the client's CLIENT-COMMS channel (where the client's messages are
    // ingested) — channelType EXTERNAL. An entity often has BOTH a team THREAD
    // and an EXTERNAL client-comms channel bound to the same contextObjectId; we
    // must read the EXTERNAL one, never the team thread (which carries team
    // chatter, not the client's messages).
    const ch = await db.query.channels.findFirst({
      where: and(
        eq(channels.contextObjectType, "entity"),
        eq(channels.contextObjectId, subjectEntityId),
        eq(channels.channelType, ChannelType.EXTERNAL),
        or(eq(channels.workspaceId, workspaceId), isNull(channels.workspaceId))
      ),
      columns: { id: true },
      orderBy: [desc(channels.updatedAt)],
    });
    channelId = ch?.id;
  }

  if (!channelId) {
    // No channel given and none bound to the entity — empty set (additive).
    return withDocs({ messages: [], channelId: null, count: 0 });
  }

  const rows = await db
    .select({
      role: messages.role,
      content: messages.content,
      metadata: messages.metadata,
      timestamp: messages.timestamp,
    })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        isNull(messages.deletedAt),
        // Canonical read triad: ephemeral "catch me up" recaps are live-only and
        // must never be gathered into a fresh synthesis context (matches the
        // all-channels fan-out branch above — the invariant holds on BOTH paths).
        eq(messages.ephemeral, false)
      )
    )
    .orderBy(desc(messages.timestamp))
    .limit(limit);

  // Re-order oldest → newest for downstream iteration.
  const ordered = rows.reverse().map(projectMessage);

  return withDocs({ messages: ordered, channelId, count: ordered.length });
}
