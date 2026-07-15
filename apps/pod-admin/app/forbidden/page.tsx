"use client";

/**
 * Shown when the user is signed in but does not have the `pod_admin`
 * role (admin or owner of the pod-admin workspace). Single Card with a
 * sign-out button — sign-out clears the Kratos cookie via the pod's
 * logout endpoint, then bounces back to login on next visit.
 */

import { Button, Card, CardBody } from "@heroui/react";
import { ShieldOff, LogOut } from "lucide-react";
import { publicPodUrl } from "../../lib/public-pod-url";

const POD_URL = publicPodUrl();

export default function ForbiddenPage() {
  const handleSignOut = async () => {
    // Initiate Kratos browser logout. Kratos returns a logout URL we
    // navigate to — that endpoint clears the session cookie and redirects.
    try {
      const res = await fetch(
        `${POD_URL}/.ory/kratos/public/self-service/logout/browser`,
        {
          credentials: "include",
          headers: { Accept: "application/json" },
        }
      );
      if (res.ok) {
        const data = (await res.json()) as { logout_url?: string };
        if (data.logout_url) {
          window.location.assign(data.logout_url);
          return;
        }
      }
    } catch {
      // Fall through to a hard reload so middleware re-checks auth.
    }
    window.location.assign("/");
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      <Card
        radius="lg"
        shadow="none"
        className="
          w-full max-w-md
          bg-foreground/[0.04]
          ring-1 ring-inset ring-foreground/10
        "
      >
        <CardBody className="flex flex-col gap-5 p-8">
          <span
            aria-hidden
            className="
              glass-icon
              flex h-12 w-12 items-center justify-center
              self-start
            "
            style={{ background: "rgba(248, 113, 113, 0.18)" }}
          >
            <ShieldOff className="h-5 w-5 text-foreground/85" strokeWidth={2} />
          </span>

          <div className="flex flex-col gap-1.5">
            <h1 className="font-heading text-[20px] font-medium tracking-tight text-foreground">
              Pod admin access required
            </h1>
            <p className="text-[13.5px] leading-relaxed text-foreground/65">
              You are signed in, but this surface is restricted to operators of
              the pod-admin workspace. Ask your pod operator to grant you the{" "}
              <span className="font-mono text-[12px] text-foreground">
                pod_admin
              </span>{" "}
              role.
            </p>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              size="sm"
              variant="flat"
              radius="md"
              startContent={<LogOut className="h-3.5 w-3.5" />}
              onPress={handleSignOut}
            >
              Sign out
            </Button>
          </div>
        </CardBody>
      </Card>
    </main>
  );
}
