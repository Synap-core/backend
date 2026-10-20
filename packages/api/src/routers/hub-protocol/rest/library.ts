/**
 * Hub Protocol REST — the Library for first-party clients (CLI, browser
 * extension, Raycast): capture-vs-library decision, wave L2/L4.
 *
 *   POST /library/add     keep items (hub-protocol.write) — LibraryAddRequest
 *   GET  /library/list    items, newest first (hub-protocol.read) — LibraryListRequest as query
 *   GET  /library/search  one search over captures and the Library (hub-protocol.read)
 *   GET  /library/readers ?itemId= | ?groupId= | ?waiting=true | ?missingMedia=true — who can read it (hub-protocol.read).
 *        Agents may SEE the offers; spending them (`library.readWith`) is the
 *        person's tap only, so there is no REST write for it.
 *
 *   GET  /library/groups  every live group with counts (hub-protocol.read) — ids for /library/propose
 *   POST /library/propose an AGENT proposes how to organise the Library (hub-protocol.write) —
 *        LibraryProposeRequest → LibraryProposeResult (always a proposal; a person is refused)
 *
 * Same services as the tRPC `library` router, owner-floored on the
 * authenticated user. Static routes only (no `/library/:id` here).
 *
 * NOTHING AN AGENT SENDS LANDS IN THE LIBRARY; AN AGENT MAY PROPOSE HOW TO
 * ORGANISE WHAT IS ALREADY THERE (founder, 2026-10-13 / 2026-10-18): an agent
 * key (or the IS's internal key) is refused on `add` and pointed at its own
 * door, MCP `synap_capture`; its organisation ideas go to `propose`.
 */

import { z } from "@hono/zod-openapi";
import { TRPCError } from "@trpc/server";
import {
  LIBRARY_LIMITS,
  LIBRARY_READ_STATUSES,
  type LibraryAddResult,
  type LibraryListResult,
  type LibrarySearchResult,
  type LibraryReadersResult,
  type LibraryGroupsResult,
  type LibraryProposeResult,
} from "@synap-core/types/imports";
import {
  LibraryAddInputSchema,
  LibraryReadersInputSchema,
  LibrarySearchInputSchema,
} from "../../library.js";
import { libraryReaders } from "../../../services/library/readers.js";
import { LIBRARY_READER_DOOR_LIMITS } from "../../../services/library/door-limits.js";
import { assertUserRateLimit } from "../../../middleware/ai-rate-limit.js";
import { addToLibrary } from "../../../services/library/add.js";
import {
  adoptImportGroups,
  readLibraryGroups,
} from "../../../services/library/groups.js";
import {
  LibraryProposeInputSchema,
  proposeLibraryOrganize,
} from "../../../services/library/organize.js";
import { listLibraryItems } from "../../../services/library/read-model.js";
import { searchLibraryWithReadText } from "../../../services/library/search.js";
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
  app.get("/library/groups", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId");
    try {
      await adoptImportGroups({ userId });
      const result: LibraryGroupsResult = await readLibraryGroups({ userId });
      return c.json(result, 200);
    } catch (err) {
      return failure(c, err);
    }
  });

  app.post("/library/propose", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const read = await readJsonBody(c);
    if (!read.ok) return read.res;
    const parsed = LibraryProposeInputSchema.safeParse(read.body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", issues: parsed.error.issues },
        400
      );
    }
    const userId = c.get("userId");
    try {
      assertUserRateLimit(userId, LIBRARY_READER_DOOR_LIMITS.propose);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Too many requests" },
        429
      );
    }
    try {
      const result: LibraryProposeResult = await proposeLibraryOrganize({
        userId,
        caller: {
          agentUserId: c.get("agentUserId") as string | undefined,
          keyType: c.get("keyType") as string | undefined,
        },
        ops: parsed.data.ops,
        ...(parsed.data.reasoning ? { reasoning: parsed.data.reasoning } : {}),
      });
      return c.json(result, 200);
    } catch (err) {
      return failure(c, err);
    }
  });

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
      const result: LibrarySearchResult = await searchLibraryWithReadText({
        userId: c.get("userId"),
        q: parsed.data.q,
        limit: parsed.data.limit,
      });
      return c.json(result, 200);
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get("/library/readers", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const parsed = LibraryReadersInputSchema.safeParse({
      ...(c.req.query("itemId") ? { itemId: c.req.query("itemId") } : {}),
      ...(c.req.query("groupId") ? { groupId: c.req.query("groupId") } : {}),
      ...(c.req.query("waiting") === "true" ? { waiting: true } : {}),
      ...(c.req.query("missingMedia") === "true" ? { missingMedia: true } : {}),
    });
    if (!parsed.success) {
      return c.json(
        { error: "Invalid query params", issues: parsed.error.issues },
        400
      );
    }
    try {
      // The same per-person budget as `library.readers` (an agent folding a
      // group in a loop meets it).
      assertUserRateLimit(c.get("userId"), LIBRARY_READER_DOOR_LIMITS.readers);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Too many requests" },
        429
      );
    }
    try {
      const result: LibraryReadersResult = await libraryReaders({
        userId: c.get("userId"),
        caller: {
          agentUserId: c.get("agentUserId") as string | undefined,
          keyType: c.get("keyType") as string | undefined,
        },
        ...(parsed.data.itemId ? { itemId: parsed.data.itemId } : {}),
        ...(parsed.data.groupId ? { groupId: parsed.data.groupId } : {}),
        ...(parsed.data.waiting ? { waiting: true } : {}),
        ...(parsed.data.missingMedia ? { missingMedia: true } : {}),
      });
      return c.json(result, 200);
    } catch (err) {
      return failure(c, err);
    }
  });
}
