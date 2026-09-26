/**
 * Forms Router — the owner's public-form doors (Sites W4).
 *
 * Every rule lives in `services/forms/form-service.ts` (the same core the Hub
 * REST `/forms` routes call). This router only maps the tRPC context to a
 * {@link FormActor} and validates the envelope; the form config itself is
 * validated by the strict `FormConfigSchema` inside the service.
 *
 * Writes (create / update / rotateToken / setEnabled) are the workspace
 * owner's, signed in as a person — agents and API keys are refused. `create`
 * and `rotateToken` return the public token ONCE; only its hash is stored.
 * There is no delete: disable a form instead (its actor and history stay).
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import {
  createForm,
  getForm,
  listForms,
  rotateFormToken,
  setFormEnabled,
  updateForm,
  type FormActor,
} from "../services/forms/form-service.js";

const Uuid = z.string().uuid();
/** Re-validated strictly by the service (`FormConfigSchema`). */
const Config = z.record(z.string(), z.unknown());

export function formActorFromCtx(ctx: {
  userId: string;
  agentUserId?: string | null;
  source?: string | null;
  keyType?: string | null;
}): FormActor {
  return {
    userId: ctx.userId,
    agentUserId: ctx.agentUserId ?? null,
    source: ctx.source ?? null,
    keyType: ctx.keyType ?? null,
  };
}

export const formsRouter = router({
  list: protectedProcedure
    .input(z.object({ workspaceId: Uuid }))
    .query(({ input, ctx }) =>
      listForms(formActorFromCtx(ctx), input.workspaceId)
    ),

  get: protectedProcedure
    .input(z.object({ formId: Uuid }))
    .query(({ input, ctx }) => getForm(formActorFromCtx(ctx), input.formId)),

  create: protectedProcedure
    .input(z.object({ workspaceId: Uuid, config: Config }))
    .mutation(({ input, ctx }) => createForm(formActorFromCtx(ctx), input)),

  update: protectedProcedure
    .input(z.object({ formId: Uuid, config: Config }))
    .mutation(({ input, ctx }) => updateForm(formActorFromCtx(ctx), input)),

  rotateToken: protectedProcedure
    .input(z.object({ formId: Uuid }))
    .mutation(({ input, ctx }) =>
      rotateFormToken(formActorFromCtx(ctx), input.formId)
    ),

  setEnabled: protectedProcedure
    .input(z.object({ formId: Uuid, enabled: z.boolean() }))
    .mutation(({ input, ctx }) => setFormEnabled(formActorFromCtx(ctx), input)),
});
