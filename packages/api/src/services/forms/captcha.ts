/**
 * Server-side captcha verification for public forms (Sites W4) — a Turnstile-
 * style `siteverify` call. OFF unless configured:
 *
 *   FORMS_CAPTCHA_SECRET        the provider secret (required to turn it on)
 *   FORMS_CAPTCHA_VERIFY_URL    default Cloudflare Turnstile siteverify
 *   FORMS_CAPTCHA_SITE_KEY      public site key, served to the form page
 *   FORMS_CAPTCHA_TIMEOUT_MS    default 3000
 *
 * Three outcomes, and the door treats them differently on purpose:
 *   - `pass`         → continue.
 *   - `fail`         → the provider ANSWERED "no": the submission is dropped
 *                      (the caller still gets the constant reply).
 *   - `unavailable`  → not configured, unreachable, timed out or an unreadable
 *                      answer: we could not tell. The door does NOT fail
 *                      closed (a provider outage would silently eat every lead);
 *                      it degrades to a FORCED PROPOSAL, so a human sees it.
 *
 * The client IP is not sent (no IP is stored or forwarded by the forms door).
 */

export type CaptchaOutcome = "pass" | "fail" | "unavailable";

export interface CaptchaConfig {
  secret: string;
  verifyUrl: string;
  siteKey: string | null;
  timeoutMs: number;
}

const DEFAULT_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function captchaConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): CaptchaConfig | null {
  const secret = env.FORMS_CAPTCHA_SECRET?.trim();
  if (!secret) return null;
  const timeout = Number(env.FORMS_CAPTCHA_TIMEOUT_MS);
  return {
    secret,
    verifyUrl: env.FORMS_CAPTCHA_VERIFY_URL?.trim() || DEFAULT_VERIFY_URL,
    siteKey: env.FORMS_CAPTCHA_SITE_KEY?.trim() || null,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 3000,
  };
}

/**
 * Verify a client token with the provider. Never throws. `fetchImpl` is
 * injectable so tests can drive every outcome without the network.
 */
export async function verifyCaptcha(
  token: string | undefined,
  config: CaptchaConfig | null,
  fetchImpl: typeof fetch = fetch
): Promise<CaptchaOutcome> {
  if (!config) return "unavailable";
  if (!token) return "fail";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const body = new URLSearchParams({
      secret: config.secret,
      response: token,
    });
    const res = await fetchImpl(config.verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
    if (!res.ok) return "unavailable";
    const json = (await res.json().catch(() => null)) as {
      success?: unknown;
    } | null;
    if (!json || typeof json.success !== "boolean") return "unavailable";
    return json.success ? "pass" : "fail";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}
