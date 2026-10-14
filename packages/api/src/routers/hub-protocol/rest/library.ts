/**
 * Hub Protocol REST — the Library for first-party clients (CLI, browser
 * extension, Raycast): CAPTURE_LIBRARY_PLAN L2/L4.
 *
 *   POST /library/add     keep items (hub-protocol.write) — LibraryAddRequest
 *   GET  /library/list    items, newest first (hub-protocol.read) — LibraryListRequest as query
 *   GET  /library/search  one search over captures and the Library (hub-protocol.read)
 *
 * Same services as the tRPC `library` router, owner-floored on the
 * authenticated user. Static routes only (no `/library/:id` here).
 *
 * NOTHING AN AGENT SENDS LANDS IN THE LIBRARY (founder, 2026-10-13): an agent
 * key (or the IS's internal key) is refused on `add` and pointed at its own
 * door, MCP `synap_capture`, which stays exactly as it is.
 */

import { z } from "@hono/zod-openapi";
import { TRPCError } from "@trpc/server";
import {
  LIBRARY_LIMITS,
  LIBRARY_READ_STATUSES,
  type LibraryAddResult,
  type LibraryListResult,
  type LibrarySearchResult,
} from "@synap-core/types/imports";
import {
  LibraryAddInputSchema,
  LibrarySearchInputSchema,
} from "../../library.js";
import { addToLibrary } from "../../../services/library/add.js";
import { adoptImportGroups } from "../../../services/library/groups.js";
import { listLibraryItems } from "../../../services/library/read-model.js";
import { searchLibrary } from "../../../services/library/search.js";
import {
  AGENT_USE_CAPTURE,
  AGENT_USE_CAPTURE_MESSAGE,
  isAgentCaller,
} from "../../../services/library/agent-door.js";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  readJsonBody,
  type HubHono,
} from "./_shared.js";

const ListQuerySchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(LIBRARY_LIMITS.pageMax).optional(),
  groupId: z.union([z.string().uuid(), z.literal("ungrouped")]).optional(),
  status: z.enum(LIBRARY_READ_STATUSES).optional(),
  archived: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  workspaceId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
});

function failure(
  c: { json: (b: unknown, s: number) => Response },
  err: unknown
) {
  if (!(err instanceof TRPCError)) logger.error({ err }, "library REST failed");
  return c.json(
    { error: err instanceof Error ? err.message : "Unknown error" },
    httpStatusForTrpcError(err) as 400
  );
}

export function registerLibraryRoutes(app: HubHono): void {
  app.post("/library/add", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    if (
      isAgentCaller({
        agentUserId: c.get("agentUserId") as string | undefined,
        keyType: c.get("keyType") as string | undefined,
      })
    ) {
      return c.json(
        { error: AGENT_USE_CAPTURE_MESSAGE, code: AGENT_USE_CAPTURE },
        403
      );
    }
    const read = await readJsonBody(c);
    if (!read.ok) return read.res;
    const parsed = LibraryAddInputSchema.safeParse(read.body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", issues: parsed.error.issues },
        400
      );
    }
    const userId = c.get("userId");
    try {
      const result: LibraryAddResult = await addToLibrary({
        userId,
        request: { ...parsed.data, readNow: false },
      });
      return c.json(result, 200);
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get("/library/list", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const parsed = ListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: "Invalid query params", issues: parsed.error.issues },
        400
      );
    }
    const userId = c.get("userId");
    try {
      await adoptImportGroups({ userId });
      const result: LibraryListResult = await listLibraryItems({
        userId,
        input: parsed.data,
      });
      return c.json(result, 200);
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get("/library/search", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const parsed = LibrarySearchInputSchema.safeParse({
      q: c.req.query("q"),
      ...(c.req.query("limit") ? { limit: Number(c.req.query("limit")) } : {}),
    });
    if (!parsed.success) {
      return c.json(
        { error: "Invalid query params", issues: parsed.error.issues },
        400
      );
    }
    try {
      const result: LibrarySearchResult = await searchLibrary({
        userId: c.get("userId"),
        q: parsed.data.q,
        limit: parsed.data.limit,
      });
      return c.json(result, 200);
    } catch (err) {
      return failure(c, err);
    }
  });
}
