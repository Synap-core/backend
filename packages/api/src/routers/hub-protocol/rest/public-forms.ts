/**
 * Hub Protocol REST — the PUBLIC GUEST FORM door (Sites W4).
 *
 *   GET  /public/forms/:token   the form's public field definition + a
 *                               time-to-submit ticket. Unknown / disabled →
 *                               the same 404 as every other public miss.
 *   POST /public/forms/:token   a guest submission. ALWAYS `202
 *                               {"received":true}` — success, duplicate,
 *                               unknown token, honeypot, captcha failure, cap,
 *                               refusal and internal error alike. The caller
 *                               learns nothing about the pod from the reply.
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
  GUEST_FORM_RECEIVED,
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
    try {
      loaded =
        token && token.length <= 256
          ? await (deps?.loadFormByTokenHash ?? loadFormByTokenHash)(
              hashToken(token)
            )
          : null;
    } catch (err) {
      // A FAILED read is a 5xx, never a calm 404. The token is never logged.
      logger.error({ err }, "public form read failed");
      return c.json({ error: "Internal error" }, httpStatusForTrpcError(err));
    }
    if (!loaded) return c.json(PUBLIC_NOT_FOUND_BODY, 404);
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
    // The door re-checks the size (GUEST_FORM_MAX_BODY_BYTES); the outcome
    // is for the log only and never reaches the caller.
    const outcome = await submitGuestForm(
      { token: c.req.param("token") ?? "", rawBody: raw },
      deps
    );
    logger.info({ outcome }, "guest form submission");
    return c.json(GUEST_FORM_RECEIVED, 202);
  });
}
