"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, Button, Card, CardBody, Spinner } from "@heroui/react";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { trpc } from "../../../lib/trpc";

/**
 * Pod-owned continuation of an application handoff. The proxy guarantees a
 * local Kratos session before this page renders; this page deliberately never
 * receives or renders the external application's credentials.
 */
export default function NewConnectionRequestPage() {
  return (
    <Suspense fallback={<Loading />}>
      <NewConnectionRequestContent />
    </Suspense>
  );
}

function NewConnectionRequestContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestId = searchParams.get("requestId");
  const [error, setError] = useState<string | null>(null);
  const redeemed = useRef<string | null>(null);
  const returnPath = requestId
    ? `/connection-requests/new?requestId=${encodeURIComponent(requestId)}`
    : null;
  const redeem = trpc.applicationConnections.redeemRequest.useMutation({
    onSuccess: ({ requestId }) => {
      // This marker is only a browser-local UX signal. It distinguishes the
      // requester who completed native Pod sign-in from a different owner who
      // later reviews the request, so only the requester browser can return
      // automatically to the external application after approval.
      try {
        window.sessionStorage.setItem(
          `application-connection-requester:${requestId}`,
          "1"
        );
      } catch {
        // Losing this marker is safe: the requester can still poll from the
        // application, and Pod Admin simply will not auto-return this browser.
      }
      window.sessionStorage.removeItem(
        `application-connection-redeem:${requestId}`
      );
      router.replace(`/connection-requests/${requestId}`);
      router.refresh();
    },
    onError: (error) => {
      if (error.data?.code === "UNAUTHORIZED" && returnPath) {
        window.location.assign(
          `/login?return=${encodeURIComponent(returnPath)}`
        );
        return;
      }
      setError(
        "This setup link is no longer available. Return to the application and start the connection again."
      );
    },
  });

  useEffect(() => {
    if (!requestId || redeemed.current === requestId) return;
    const storageKey = `application-connection-redeem:${requestId}`;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const fragmentSecret = fragment.get("redeem");

    // Fragments never reach the server. Persist the proof only in this
    // Pod-Admin origin's session storage, then remove it before any further
    // navigation so neither the login return URL nor the referrer contains it.
    if (fragmentSecret) {
      try {
        window.sessionStorage.setItem(storageKey, fragmentSecret);
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${window.location.search}`
        );
      } catch {
        setError(
          "This browser could not securely preserve the setup proof. Return to the application and start again."
        );
        return;
      }
    }

    const redemptionSecret = window.sessionStorage.getItem(storageKey);
    if (!redemptionSecret) {
      setError(
        "This setup link is incomplete. Return to the application and start the connection again."
      );
      return;
    }

    redeemed.current = requestId;
    redeem.mutate({ requestId, redemptionSecret });
  }, [requestId, redeem]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl items-center px-5 py-10">
      <Card
        shadow="none"
        className="w-full border border-foreground/10 bg-content1"
      >
        <CardBody className="gap-5 px-6 py-7">
          <div className="flex items-start gap-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
              aria-hidden
            >
              <ShieldCheck size={19} />
            </span>
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-foreground/50">
                Pod connection
              </p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight">
                Prepare application review
              </h1>
            </div>
          </div>

          {error ? (
            <>
              <Alert
                color="warning"
                title="Setup link unavailable"
                role="alert"
              >
                {error}
              </Alert>
              <Button
                variant="flat"
                startContent={<ArrowLeft size={16} />}
                onPress={() => router.back()}
              >
                Go back
              </Button>
            </>
          ) : !requestId ? (
            <Alert color="danger" title="Missing setup link" role="alert">
              Return to the application and start the connection again.
            </Alert>
          ) : (
            <div
              className="flex items-center gap-3 text-sm text-foreground/65"
              role="status"
            >
              <Spinner size="sm" />
              Preparing the Pod-owned review. Your app never receives your Pod
              credentials.
            </div>
          )}
        </CardBody>
      </Card>
    </main>
  );
}

function Loading() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl items-center px-5 py-10">
      <div className="flex w-full items-center justify-center gap-3 text-sm text-foreground/60">
        <Spinner size="sm" /> Loading Pod connection request…
      </div>
    </main>
  );
}
