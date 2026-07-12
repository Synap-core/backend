/**
 * Define (upsert) a cell from raw renderer source — the shared write path.
 *
 * SINGLE SOURCE OF TRUTH for the "AI-generated cell" create path, used by BOTH
 * the Hub REST route (`POST /cells/define`) AND the MCP `synap_create_cell`
 * verb. Idempotent upsert on (typeKey, workspaceId); when workspaceId is omitted
 * the cell is pod-global (visible in all workspaces). Emits the
 * widget_definition change so connected browsers refresh live.
 */

import { getDb, and, eq, isNull } from "@synap/database";
import { widgetDefinitions } from "@synap/database/schema";
import { emitHubRealtimeEvent } from "../../utils/domain-event-bridge.js";

// deps are spliced into esm.sh import-map URLs inside the sandboxed iframe
// (cell-runtime ViewFrame) — the regexes are what stops a crafted name/version
// from manipulating the request path/query (CSP pins the origin, not the path).
// Enforced HERE, inside the one door, so no caller (route, MCP, marketplace
// install, future) can reach the upsert with unvalidated deps.
const NPM_PKG_NAME_RE =
  /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const NPM_VERSION_RE = /^[a-zA-Z0-9^~><= .*|-]{1,64}$/;

/** Returns an error message, or null when valid. */
export function validateDeps(
  deps: Record<string, string> | undefined
): string | null {
  if (!deps) return null;
  const entries = Object.entries(deps);
  if (entries.length > 30) return "deps must have at most 30 entries";
  for (const [pkg, version] of entries) {
    if (!NPM_PKG_NAME_RE.test(pkg)) {
      return `Invalid package name in deps: "${pkg}"`;
    }
    if (!NPM_VERSION_RE.test(version)) {
      return `Invalid version string for "${pkg}": "${version}"`;
    }
  }
  return null;
}

export interface DefineCellInput {
  name: string;
  rendererSource: string;
  /** Omit / null → pod-global cell (workspaceId IS NULL). */
  workspaceId?: string | null;
  /** Explicit typeKey; defaults to `generated:${slug(name)}`. */
  typeKey?: string;
  description?: string | null;
  defaultSize?: { w: number; h: number };
  deps?: Record<string, string>;
  /** Acting user — stamped on the realtime event. */
  userId: string;
}

export async function defineCell(
  input: DefineCellInput
): Promise<{ typeKey: string; changeType: "created" | "updated" }> {
  const depsError = validateDeps(input.deps);
  if (depsError) {
    throw new Error(`defineCell: ${depsError}`);
  }
  const db = await getDb();
  const workspaceId = input.workspaceId ?? null;

  const slug = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const typeKey = input.typeKey ?? `generated:${slug}`;

  const values = {
    typeKey,
    workspaceId,
    name: input.name,
    description: input.description ?? null,
    category: "installed" as const,
    rendererType: "frame" as const,
    rendererSource: input.rendererSource,
    deps: (input.deps ?? {}) as Record<string, string>,
    configSchema: {},
    defaultConfig: {},
    defaultSize: input.defaultSize ?? { w: 6, h: 4 },
    isActive: true,
    trustLevel: "generated" as const,
  };

  let changeType: "created" | "updated" = "created";

  if (workspaceId) {
    // Workspace-scoped: unique constraint on (typeKey, workspaceId) works normally.
    const result = await db
      .insert(widgetDefinitions)
      .values(values)
      .onConflictDoUpdate({
        target: [widgetDefinitions.typeKey, widgetDefinitions.workspaceId],
        set: {
          name: input.name,
          description: input.description ?? null,
          rendererSource: input.rendererSource,
          deps: (input.deps ?? {}) as Record<string, string>,
          isActive: true,
          updatedAt: new Date(),
        },
      })
      .returning({
        id: widgetDefinitions.id,
        updatedAt: widgetDefinitions.updatedAt,
        createdAt: widgetDefinitions.createdAt,
      });
    const row = result[0];
    if (
      row &&
      row.updatedAt &&
      row.createdAt &&
      row.updatedAt.getTime() !== row.createdAt.getTime()
    ) {
      changeType = "updated";
    }
  } else {
    // Pod-global (workspaceId IS NULL): PostgreSQL treats NULLs as distinct in
    // unique indexes, so onConflictDoUpdate won't fire. Manual upsert.
    const updated = await db
      .update(widgetDefinitions)
      .set({
        name: input.name,
        description: input.description ?? null,
        rendererSource: input.rendererSource,
        deps: (input.deps ?? {}) as Record<string, string>,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(widgetDefinitions.typeKey, typeKey),
          isNull(widgetDefinitions.workspaceId)
        )
      )
      .returning({ id: widgetDefinitions.id });
    if (updated.length === 0) {
      await db.insert(widgetDefinitions).values(values);
    } else {
      changeType = "updated";
    }
  }

  emitHubRealtimeEvent({
    eventType:
      changeType === "created"
        ? "widget_definition.create.completed"
        : "widget_definition.update.completed",
    subjectId: typeKey,
    userId: input.userId,
    data: {
      id: typeKey,
      typeKey,
      workspaceId: workspaceId ?? undefined,
      changeType,
    },
  });

  return { typeKey, changeType };
}
