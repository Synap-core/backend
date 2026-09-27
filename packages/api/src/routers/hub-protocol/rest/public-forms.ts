/**
 * Hub Protocol REST — the PUBLIC GUEST FORM door.
 *
 *   GET  /public/forms/:token   the form's public field definition, its
 *                               `minSubmitMs` and a time-to-submit ticket.
 *                               Unknown / disabled → the same 404 as every
 *                               other public miss. A live form whose
 *                               workspace's public doors are switched off →
 *                               403 `public_doors_disabled`.
 *   POST /public/forms/:token   a guest submission. The reply is
 *                               `guestFormReply` (services/forms/guest-submit):
 *                               202 received (filed, or any outcome a caller
 *                               must not learn: unknown token, honeypot,
 *                               captcha failure, the pending cap), 422 with
 *                               the invalid field keys or `retry`, 403
 *                               `public_doors_disabled` for a live form
 *                               behind a closed switch, 503 when the pod
 *                               failed to file it.
 *
 * It lives under `/public/`, so the ONE predicate (`public-doors.ts`) skips hub
 * auth + idempotency, and the pod edge gives it the credentialless CORS policy,
 * the 16 KB stream cap and the `public_submit` rate class (IP ceiling, then a
 * per-form bucket keyed on the token segment). An over-rate caller is refused
 * by that edge limiter (429) before this handler runs.
 *
 * The handlers never read a principal (`c.get("userId")`, a credential header, a
 * session) and never build a hub caller context: identity comes ONLY from the
 * stored form row (`services/forms/guest-submit.ts`).
 */

import { logger, httpStatusForTrpcError, type HubHono } from "./_shared.js";
import { PUBLIC_NOT_FOUND_BODY } from "../../../services/sharing/public-read.js";
import {
  guestFormReply,
  loadFormByTokenHash,
  submitGuestForm,
  type GuestDeps,
} from "../../../services/forms/guest-submit.js";
import {
  mintTicket,
  publicFormView,
} from "../../../services/forms/form-definition.js";
import { captchaConfigFromEnv } from "../../../services/forms/captcha.js";
import { hashToken } from "../../../utils/share-token.js";
import {
  PUBLIC_DOORS_DISABLED_BODY,
  PUBLIC_DOORS_DISABLED_STATUS,
  publicDoorsOpenFor,
} from "../../../services/sharing/public-doors-switch.js";

/** The ticket is time-bound: never cache the form definition response. */
export const PUBLIC_FORM_CACHE_CONTROL = "no-store";

export function registerPublicFormsRoutes(
  app: HubHono,
  deps?: GuestDeps
): void {
  app.get("/public/forms/:token", async (c) => {
    c.header("Cache-Control", PUBLIC_FORM_CACHE_CONTROL);
    const token = c.req.param("token") ?? "";
    let loaded;
    let open = true;
    try {
      loaded =
        token && token.length <= 256
          ? await (deps?.loadFormByTokenHash ?? loadFormByTokenHash)(
              hashToken(token)
            )
          : null;
      if (loaded) {
        open = await (
          deps?.publicDoorsOpen ?? ((l) => publicDoorsOpenFor(l.workspaceId))
        )(loaded);
      }
    } catch (err) {
      // A FAILED read is a 5xx, never a calm 404. The token is never logged.
      logger.error({ err }, "public form read failed");
      return c.json({ error: "Internal error" }, httpStatusForTrpcError(err));
    }
    if (!loaded) return c.json(PUBLIC_NOT_FOUND_BODY, 404);
    if (!open) {
      return c.json(PUBLIC_DOORS_DISABLED_BODY, PUBLIC_DOORS_DISABLED_STATUS);
    }
    const captcha = captchaConfigFromEnv();
    const now = deps?.now?.() ?? Date.now();
    return c.json(
      {
        ...publicFormView(loaded.form.config),
        ticket: mintTicket(loaded.form.ticketSecret, loaded.formId, now),
        captcha: loaded.form.config.captcha.enabled
          ? { required: true, siteKey: captcha?.siteKey ?? null }
          : { required: false },
      },
      200
    );
  });

  app.post("/public/forms/:token", async (c) => {
    let raw = "";
    try {
      raw = await c.req.text();
    } catch {
      raw = "";
    }
    // The door re-checks the size (GUEST_FORM_MAX_BODY_BYTES).
    const result = await submitGuestForm(
      { token: c.req.param("token") ?? "", rawBody: raw },
      deps
    );
    logger.info({ outcome: result.outcome }, "guest form submission");
    const reply = guestFormReply(result);
    return c.json(reply.body, reply.status);
  });
}
