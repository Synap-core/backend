"use client";

/**
 * First-admin bootstrap form.
 *
 * Posts { email, password, name, magicToken } to POST /api/hub/setup/first-admin.
 * Auth modes supported by the endpoint:
 *   - magicToken in body (JWT signed by PROVISIONING_TOKEN, generated via
 *     POST /api/hub/setup/magic-link — the URL already contains ?token=)
 *   - PROVISIONING_TOKEN in Authorization header (operator pastes it directly)
 *
 * When ?token= is present in the URL we forward it as magicToken. Otherwise
 * we show the admin-token field so the operator can paste the PROVISIONING_TOKEN.
 *
 * On success: hard-navigate to /login so the server component re-checks auth
 * and any existing session is properly flushed.
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, Card, CardBody, Input } from "@heroui/react";
import { KeyRound, AlertCircle, CheckCircle2 } from "lucide-react";

const POD_URL = process.env.NEXT_PUBLIC_POD_URL ?? "";

export function SetupForm() {
  const searchParams = useSearchParams();
  const magicToken = searchParams.get("token");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // When a magic token is embedded in the URL, pre-fill and hide the token field.
  const hasMagicToken = Boolean(magicToken);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!email.trim() || !password) {
        setError("Email and password are required.");
        return;
      }
      if (!hasMagicToken && !adminToken.trim()) {
        setError("Admin token is required when no magic link is used.");
        return;
      }

      setSubmitting(true);
      setError(null);

      try {
        const body: Record<string, string> = {
          email: email.trim(),
          password,
          name: name.trim() || email.split("@")[0],
        };

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        if (hasMagicToken) {
          body.magicToken = magicToken!;
        } else {
          headers["Authorization"] = `Bearer ${adminToken.trim()}`;
        }

        const res = await fetch(`${POD_URL}/api/hub/setup/first-admin`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          userId?: string;
        };

        if (!res.ok) {
          setError(
            data.error ??
              (res.status === 409
                ? "An admin account already exists. Sign in at /login."
                : `Setup failed (${res.status})`)
          );
          return;
        }

        setDone(true);
        // Brief pause so the user sees the success state, then go to login.
        setTimeout(() => {
          window.location.assign("/login");
        }, 1500);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Setup failed");
      } finally {
        setSubmitting(false);
      }
    },
    [email, password, name, adminToken, hasMagicToken, magicToken]
  );

  if (done) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6 py-16">
        <Card
          radius="lg"
          shadow="none"
          className="w-full max-w-md bg-foreground/[0.04] ring-1 ring-inset ring-foreground/10"
        >
          <CardBody className="flex flex-col gap-5 p-8">
            <span
              aria-hidden
              className="glass-icon flex h-12 w-12 items-center justify-center self-start"
              style={{ background: "rgba(34, 197, 94, 0.18)" }}
            >
              <CheckCircle2
                className="h-5 w-5 text-foreground/85"
                strokeWidth={2}
              />
            </span>
            <div className="flex flex-col gap-1.5">
              <h1 className="font-heading text-[20px] font-medium tracking-tight text-foreground">
                Admin account created
              </h1>
              <p className="text-[13.5px] leading-relaxed text-foreground/65">
                Redirecting to sign-in…
              </p>
            </div>
          </CardBody>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <Card
        radius="lg"
        shadow="none"
        className="w-full max-w-md bg-foreground/[0.04] ring-1 ring-inset ring-foreground/10"
      >
        <CardBody className="flex flex-col gap-5 p-8">
          <span
            aria-hidden
            className="glass-icon flex h-12 w-12 items-center justify-center self-start"
            style={{ background: "rgba(251, 191, 36, 0.18)" }}
          >
            <KeyRound className="h-5 w-5 text-foreground/85" strokeWidth={2} />
          </span>

          <div className="flex flex-col gap-1.5">
            <h1 className="font-heading text-[20px] font-medium tracking-tight text-foreground">
              Bootstrap first admin
            </h1>
            <p className="text-[13.5px] leading-relaxed text-foreground/65">
              {hasMagicToken
                ? "Magic link verified. Create your admin account below."
                : "Use the PROVISIONING_TOKEN from your pod .env to create the first admin account."}
            </p>
          </div>

          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            {error ? (
              <div className="flex items-start gap-2 rounded-medium bg-danger/10 p-3 text-[13px] text-danger ring-1 ring-inset ring-danger/30">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}

            {!hasMagicToken ? (
              <Input
                label="Admin token (PROVISIONING_TOKEN)"
                labelPlacement="outside"
                type="password"
                value={adminToken}
                onValueChange={setAdminToken}
                autoComplete="off"
                isRequired
                size="sm"
                radius="md"
                variant="flat"
                description="Paste the PROVISIONING_TOKEN value from your pod's .env file."
              />
            ) : null}

            <Input
              label="Email"
              labelPlacement="outside"
              type="email"
              value={email}
              onValueChange={setEmail}
              autoComplete="email"
              isRequired
              size="sm"
              radius="md"
              variant="flat"
            />

            <Input
              label="Display name"
              labelPlacement="outside"
              type="text"
              value={name}
              onValueChange={setName}
              autoComplete="name"
              size="sm"
              radius="md"
              variant="flat"
              description="Optional — defaults to your email username."
            />

            <Input
              label="Password"
              labelPlacement="outside"
              type="password"
              value={password}
              onValueChange={setPassword}
              autoComplete="new-password"
              isRequired
              size="sm"
              radius="md"
              variant="flat"
            />

            <Button
              type="submit"
              color="primary"
              radius="md"
              size="md"
              className="mt-2"
              isDisabled={submitting}
              isLoading={submitting}
            >
              {submitting ? "Creating account…" : "Create admin account"}
            </Button>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
