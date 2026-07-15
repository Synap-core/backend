/**
 * Validation for a Pod session token supplied explicitly by a browser app.
 *
 * Browser-session compatibility middleware may fall back from an invalid API
 * token to a Kratos cookie. That is appropriate for first-party Pod surfaces,
 * but never for an owner-approved external app origin: it would turn an
 * ambient SameSite=None cookie into cross-site authorization. External apps
 * therefore need a valid X-Session-Token, not merely a header-shaped value.
 */
import { getKratosSessionByToken } from "@synap/auth";

export type ExplicitPodSessionTokenStatus =
  | "missing"
  | "valid"
  | "invalid"
  | "unavailable";

export async function validateExplicitPodSessionToken(
  rawToken: string | undefined
): Promise<ExplicitPodSessionTokenStatus> {
  const token = rawToken?.trim();
  if (!token) return "missing";
  try {
    const session = await getKratosSessionByToken(token);
    return session?.identity?.id ? "valid" : "invalid";
  } catch {
    return "unavailable";
  }
}
