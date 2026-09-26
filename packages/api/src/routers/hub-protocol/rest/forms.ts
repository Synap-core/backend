/**
 * Hub REST — Forms (Sites W4): the owner's public-form doors.
 *
 *   GET  /forms?workspaceId=…        the workspace's forms (owner)
 *   GET  /forms/:id                  one form (owner)
 *   POST /forms                      { workspaceId, config } → token ONCE
 *   PUT  /forms/:id                  { config }
 *   POST /forms/:id/rotate-token     → token ONCE
 *   POST /forms/:id/enabled          { enabled }
 *
 * Every rule lives in `services/forms/form-service.ts` (the same core the tRPC
 * `forms` router calls). Writes are a signed-in person's act: the core refuses
 * agents and API keys, so on this door only a session caller can write. No
 * route here serves a token hash or the ticket secret. The CREDENTIALLESS guest
 * door is `rest/public-forms.ts`.
 */

import { z } from "zod";
import type { Context } from "hono";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  type HubHono,
  type HubVariables,
} from "./_shared.js";
import {
  createForm,
  getForm,
  listForms,
  rotateFormToken,
  setFormEnabled,
  updateForm,
  type FormActor,
} from "../../../services/forms/form-service.js";

const Uuid = z.string().uuid();
const Config = z.record(z.string(), z.unknown());

type Ctx = Context<{ Variables: HubVariables }, any, any>;

function actorOf(c: Ctx): FormActor {
  return {
    userId: c.get("userId"),
    agentUserId: (c.get("agentUserId") as string | undefined) ?? null,
    keyType: (c.get("keyType") as string | undefined) ?? null,
    source: "hub-rest",
  };
}

function fail(c: Ctx, err: unknown, what: string) {
  const status = httpStatusForTrpcError(err);
  if (status === 500) logger.error({ err }, `${what} failed`);
  return c.json(
    { error: err instanceof Error ? err.message : `${what} failed` },
    status
  );
}

export function registerFormsRoutes(app: HubHono): void {
  app.get("/forms", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const ws = Uuid.safeParse(c.req.query("workspaceId"));
    if (!ws.success) {
      return c.json({ error: "workspaceId (uuid) is required" }, 400);
    }
    try {
      return c.json({ forms: await listForms(actorOf(c), ws.data) });
    } catch (err) {
      return fail(c, err, "GET /forms");
    }
  });

  app.post("/forms", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = z
      .object({ workspaceId: Uuid, config: Config })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      return c.json(await createForm(actorOf(c), body.data), 201);
    } catch (err) {
      return fail(c, err, "POST /forms");
    }
  });

  app.get("/forms/:id", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid form id" }, 400);
    try {
      return c.json(await getForm(actorOf(c), id.data));
    } catch (err) {
      return fail(c, err, "GET /forms/:id");
    }
  });

  app.put("/forms/:id", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid form id" }, 400);
    const body = z
      .object({ config: Config })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      return c.json(
        await updateForm(actorOf(c), {
          formId: id.data,
          config: body.data.config,
        })
      );
    } catch (err) {
      return fail(c, err, "PUT /forms/:id");
    }
  });

  app.post("/forms/:id/rotate-token", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid form id" }, 400);
    try {
      return c.json(await rotateFormToken(actorOf(c), id.data));
    } catch (err) {
      return fail(c, err, "POST /forms/:id/rotate-token");
    }
  });

  app.post("/forms/:id/enabled", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid form id" }, 400);
    const body = z
      .object({ enabled: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      return c.json(
        await setFormEnabled(actorOf(c), {
          formId: id.data,
          enabled: body.data.enabled,
        })
      );
    } catch (err) {
      return fail(c, err, "POST /forms/:id/enabled");
    }
  });
}
