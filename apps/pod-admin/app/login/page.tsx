/**
 * /login — pod-admin's native sign-in surface.
 *
 * Server component. First does a server-side `checkSession` and skips
 * the form entirely when the operator already has a valid session — that
 * is the case when they've signed in elsewhere on the parent domain (Kratos
 * cookie is `Domain=<root>` so it crosses subdomains).
 *
 * The actual flow handling lives in `LoginForm` (client). This page just
 * decides whether to render it.
 */

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { checkSession } from "../../lib/kratos";
import { safeReturnTo } from "../../lib/safe-return-to";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

interface LoginPageProps {
  searchParams: Promise<{ return?: string; flow?: string; refresh?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const sp = await searchParams;
  const returnTo = safeReturnTo(sp.return);

  const cookie = (await headers()).get("cookie") ?? "";
  // `?refresh=1`: a signed-in user re-confirms it's them (settings needs a
  // sign-in inside Kratos' privileged window) — do not bounce them on.
  const refresh = sp.refresh === "1";
  const session = await checkSession(cookie);
  if (session.state === "active" && !refresh) {
    redirect(returnTo);
  }

  return (
    <LoginForm
      returnTo={returnTo}
      initialFlowId={sp.flow ?? null}
      refresh={refresh}
      serverSession={session.state}
    />
  );
}
