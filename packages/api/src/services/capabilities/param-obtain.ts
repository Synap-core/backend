/**
 * `obtain` — how a PERSON gets the value a capability param needs (a key, a
 * token): the page to open and the numbered steps there (finding 91a3bfd3,
 * plan d717d6ac addendum B3: the tutorial lives per param in the manifest).
 *
 * Before it, the steps lived in free text in `params[].description`
 * ("Settings -> Developer -> API Keys"), which the install proposal never
 * showed. A manifest now declares them as data and the proposal's setup row
 * carries them (`proposal-setup.ts`), so every review surface draws the same
 * steps beside the field that takes the key.
 *
 * ONE shape, the `act` ask's bounds (`ASK_LIMITS`): at most 7 steps of at most
 * 200 characters, and a url that is https and nothing else (a manifest is
 * published content; a `javascript:` or plain-http link in a review card is
 * never acceptable).
 *
 *   - `ParamObtainSchema` is what the Hub door validates a definition with
 *     (`routers/hub-protocol/rest/capabilities.ts`): an invalid `obtain`
 *     refuses the definition there.
 *   - `readParamObtain` is the READ side: a manifest from the catalog cache
 *     was not necessarily validated by this pod, so an invalid `obtain` is
 *     dropped (absent), never projected half-valid.
 */
import { z } from "zod";
import { ASK_LIMITS } from "@synap-core/types/ask";
import type { CapabilityParamObtain } from "@synap/playbooks";

const HTTPS_URL = /^https:\/\//i;

export const ParamObtainSchema = z
  .object({
    url: z
      .string()
      .trim()
      .max(ASK_LIMITS.urlMaxChars)
      .refine((u) => HTTPS_URL.test(u) && URL.canParse(u), {
        message: "obtain.url must be an https URL",
      })
      .optional(),
    steps: z
      .array(z.string().trim().min(1).max(ASK_LIMITS.stepMaxChars))
      .min(1)
      .max(ASK_LIMITS.stepsMax),
  })
  .strict();

/** The manifest's `obtain`, when it is valid; `undefined` otherwise. */
export function readParamObtain(
  raw: unknown
): CapabilityParamObtain | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = ParamObtainSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return {
    ...(parsed.data.url ? { url: parsed.data.url } : {}),
    steps: parsed.data.steps,
  };
}
