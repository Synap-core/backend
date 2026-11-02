/**
 * Hub Protocol REST — package updates, for the CLI and agents.
 *
 *   GET  /package-updates               every installed package whose catalog moved
 *   GET  /package-updates/{slug}        one update, field by field
 *   POST /package-updates/{slug}/apply  apply it with a choice per field
 *
 * The same service as pod admin's tRPC `packageUpdates.*`
 * (`services/package-updates/`): one plan, one apply. Pod admins only, like
 * the tRPC doors. An agent's apply goes through each row's own governed
 * `.update` door, which files a proposal (unlike `POST /configs/reconcile`, a
 * pod-wide operator pass an agent cannot run, this is one package a person
 * reviews).
 */

import { z } from "zod";
import {
  applyPackageUpdateInputSchema,
  INSTALLED_PACKAGE_KINDS,
  PACKAGE_FIELD_STATES,
  PACKAGE_UPDATE_COMPARED_BY,
  PACKAGE_UPDATE_NEEDS,
} from "@synap-core/types/package-updates";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  errCode,
  hasScope,
  httpStatusForTrpcError,
  logger,
  readJsonBody,
  type HubHono,
} from "./_shared.js";
import { createHubProtocolCallerContext } from "../utils.js";
import { assertPodAdmin } from "../../../trpc.js";
import {
  getPackageUpdatePlan,
  listPackageUpdates,
} from "../../../services/package-updates/plan.js";
import { applyPackageUpdate } from "../../../services/package-updates/apply.js";

const CountsSchema = z.object({
  updates: z.number(),
  yours: z.number(),
  both: z.number(),
  same: z.number(),
});

const ComparedBySchema = z
  .enum(PACKAGE_UPDATE_COMPARED_BY)
  .describe(
    "`field`: compared and applied field by field (view, skill, automation). `package`: applied as a whole through the kind's own template door (workspace, capability); no field rows."
  );

const SummarySchema = z.object({
  slug: z.string(),
  kind: z.string(),
  comparedBy: ComparedBySchema,
  name: z.string(),
  installedVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
  counts: CountsSchema,
  dataChanges: z.number(),
  needs: z.enum(PACKAGE_UPDATE_NEEDS),
  reviewUrl: z.string(),
});

const ListResponseSchema = z.object({
  updates: z.array(SummarySchema),
  unreadable: z.array(
    z.object({
      slug: z.string(),
      kind: z.string(),
      name: z.string(),
      reason: z.string(),
    })
  ),
  installed: z
    .array(
      z.object({
        slug: z.string(),
        kind: z.enum(INSTALLED_PACKAGE_KINDS),
        name: z.string(),
        installedVersion: z.string().nullable(),
        latestVersion: z.string().nullable(),
        hasUpdate: z
          .boolean()
          .nullable()
          .describe(
            "true/false = compared by the one rule (the catalog's content-hash version against the one the pod converged to). null = not compared: `reason` says why. Never a defaulted false."
          ),
        reason: z.string().optional(),
      })
    )
    .describe(
      "Every installed package (one per slug and kind) with its verdict, the up-to-date ones included."
    ),
});

const FieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  state: z.enum(PACKAGE_FIELD_STATES),
  base: z.unknown(),
  desired: z.unknown(),
  live: z.unknown(),
  merged: z.string().nullable().optional(),
  overlap: z.boolean().optional(),
});

const PlanResponseSchema = z.object({
  slug: z.string(),
  kind: z.string(),
  comparedBy: ComparedBySchema,
  name: z.string(),
  installedVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
  rows: z.array(
    z.object({
      rowKind: z.enum(["view", "skill", "automation"]),
      rowId: z.string(),
      name: z.string(),
      fields: z.array(FieldSchema),
    })
  ),
  recommended: z.record(z.string(), z.enum(["catalog", "combine"])).optional(),
  counts: CountsSchema,
  needs: z.enum(PACKAGE_UPDATE_NEEDS),
});

const ApplyRequestSchema = applyPackageUpdateInputSchema.omit({ slug: true });

const ApplyResponseSchema = z.union([
  z.object({
    status: z.literal("applied"),
    warning: z
      .string()
      .optional()
      .describe(
        "A whole-package update that landed but did not finish: what is left."
      ),
    receipt: z
      .object({
        id: z.string(),
        slug: z.string(),
        kind: z.string(),
        name: z.string(),
        fromVersion: z.string().nullable(),
        toVersion: z.string().nullable(),
        appliedAt: z.string(),
        source: z.enum(["person", "automatic"]),
        changes: z.array(
          z.object({
            rowKind: z.enum(["view", "skill", "automation"]),
            rowId: z.string(),
            field: z.string(),
            before: z.unknown(),
            after: z.unknown(),
          })
        ),
        undoUntil: z.string(),
        undoneAt: z.string().nullable(),
      })
      .nullable(),
  }),
  z.object({
    status: z.literal("proposed"),
    proposalIds: z.array(z.string()),
  }),
]);

const SlugParams = z.object({ slug: z.string().min(1) });

/** A service error as its HTTP answer (409 for a moved catalog); a 500 is logged. */
function errorBody(err: unknown, what: string) {
  const status = httpStatusForTrpcError(err);
  if (status === 500) logger.error({ err }, `package-updates ${what} failed`);
  return {
    body: { error: err instanceof Error ? err.message : "Unknown error" },
    status,
  };
}

async function refuseNonAdmin(userId: string): Promise<string | null> {
  try {
    await assertPodAdmin(userId);
    return null;
  } catch (err) {
    if (errCode(err) === "FORBIDDEN")
      return err instanceof Error ? err.message : "Forbidden";
    throw err;
  }
}

export function registerPackageUpdatesRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/package-updates",
    tags: ["Packages"],
    summary: "List the package updates waiting on this pod",
    description:
      "Every installed package (space template, overlay pack, capability, " +
      "view, skill, automation) whose catalog version moved, by the one rule " +
      "every surface reads: the catalog's content-hash version against the " +
      "one the pod converged to. A view/skill/automation update counts how " +
      "many fields it changes per state (updates / yours / both / same); a " +
      "space or capability is updated as a whole (`comparedBy: package`). A " +
      "package that cannot be compared is listed under `unreadable` with the " +
      "reason; `installed` carries every package's verdict. " +
      "Pod admins only. Requires hub-protocol.read scope.",
    responses: {
      200: { description: "Waiting updates", schema: ListResponseSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/package-updates", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    try {
      const denied = await refuseNonAdmin(c.get("userId") as string);
      if (denied) return c.json({ error: denied }, 403);
      return c.json(await listPackageUpdates(), 200);
    } catch (err) {
      const e = errorBody(err, "list");
      return c.json(e.body, e.status);
    }
  });

  registerOpenApi(app, {
    method: "get",
    path: "/package-updates/{slug}",
    tags: ["Packages"],
    summary: "One package update, field by field",
    description:
      "For each installed row of the package, each field the catalog " +
      "provides with its state and its three values: the catalog's when " +
      "installed (`base`), the catalog's now (`desired`) and the pod's " +
      "(`live`). A text field both sides changed carries the line-level " +
      "merge (`merged`, null when the edits overlap). `recommended` names " +
      "the suggested choice per `<rowId>:<field>`. Pod admins only. " +
      "Requires hub-protocol.read scope.",
    request: { params: SlugParams },
    responses: {
      200: { description: "The update plan", schema: PlanResponseSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Nothing installed from it", schema: ErrorSchema },
      412: { description: "The catalog cannot be read", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/package-updates/:slug", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    try {
      const denied = await refuseNonAdmin(c.get("userId") as string);
      if (denied) return c.json({ error: denied }, 403);
      return c.json(await getPackageUpdatePlan(c.req.param("slug")), 200);
    } catch (err) {
      const e = errorBody(err, "get");
      return c.json(e.body, e.status);
    }
  });

  registerOpenApi(app, {
    method: "post",
    path: "/package-updates/{slug}/apply",
    tags: ["Packages"],
    summary: "Apply a package update with a choice per field",
    description:
      "`choices` is keyed `<rowId>:<field>`: `catalog`, `mine`, `combine` " +
      "or `{value}`. Every field both sides changed needs one; a field only " +
      "the catalog changed defaults to `catalog`. `expectedVersion` is the " +
      "catalog version the plan showed: a newer one answers 409. Each row is " +
      "written through its own governed `.update` door as the caller: a " +
      "person's write lands and returns its receipt (Undo for 30 days, on " +
      "pod admin); an agent's is filed as proposals. A space or capability " +
      "package (`comparedBy: package`) takes no choices: a person's apply " +
      "runs the space's agreed `acceptDataChanges`, then its template apply " +
      "(or the capability's reconcile); an agent is refused (403). " +
      "Pod admins only. Requires hub-protocol.write scope.",
    request: { params: SlugParams, body: ApplyRequestSchema },
    responses: {
      200: { description: "Applied or proposed", schema: ApplyResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Nothing installed from it", schema: ErrorSchema },
      409: { description: "The catalog moved", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/package-updates/:slug/apply", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const jsonRead = await readJsonBody(c);
    if (!jsonRead.ok) return jsonRead.res;
    const parsed = ApplyRequestSchema.safeParse(jsonRead.body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const userId = c.get("userId") as string;
    try {
      const denied = await refuseNonAdmin(userId);
      if (denied) return c.json({ error: denied }, 403);
      // The caller's own context, with the authenticated agent, so each row's
      // governed door sees who is writing.
      const keyType = c.get("keyType") as string | undefined;
      const ctx = await createHubProtocolCallerContext(
        userId,
        c.get("scopes") as string[],
        null,
        null,
        (c.get("sessionId") as string | undefined) ?? null,
        keyType === "is_internal"
          ? undefined
          : ((c.get("agentUserId") as string | undefined) ?? undefined),
        keyType,
        c.get("keyWorkspaceId") as string | null | undefined
      );
      const result = await applyPackageUpdate(ctx, {
        ...parsed.data,
        slug: c.req.param("slug"),
      });
      return c.json(result, 200);
    } catch (err) {
      const e = errorBody(err, "apply");
      return c.json(e.body, e.status);
    }
  });
}
