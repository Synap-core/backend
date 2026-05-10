/**
 * /login — pod-admin's native sign-in surface.
 *
 * Server component. First does a server-side `whoamiFromCookie` and skips
 * the form entirely when the operator already has a valid session — that
 * is the case when they've signed in elsewhere on the parent domain (Kratos
 * cookie is `Domain=<root>` so it crosses subdomains).
 *
 * The actual flow handling lives in `LoginForm` (client). This page just
 * decides whether to render it.
 */

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { whoamiFromCookie } from "../../lib/kratos";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

interface LoginPageProps {
  searchParams: Promise<{ return?: string; flow?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const sp = await searchParams;
  const returnTo = safeReturnTo(sp.return);

  const cookie = (await headers()).get("cookie") ?? "";
  const identity = await whoamiFromCookie(cookie);
  if (identity) {
    redirect(returnTo);
  }

  return <LoginForm returnTo={returnTo} initialFlowId={sp.flow ?? null} />;
}

/**
 * Constrain `?return=` to same-origin pathnames so a malicious link can't
 * bounce a logged-in operator to an attacker-controlled URL.
 */
function safeReturnTo(raw: string | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  // `/login` itself would loop — kick to root instead.
  if (raw === "/login" || raw.startsWith("/login?")) return "/";
  return raw;
}
