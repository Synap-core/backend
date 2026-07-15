"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, Button, Card, CardBody } from "@heroui/react";
import { ArrowLeft, Settings2 } from "lucide-react";

const messages: Record<string, string> = {
  POD_ADMIN_URL_REQUIRED:
    "This Pod does not yet have a public Pod Admin URL. Its owner needs to finish Pod deployment configuration.",
  POD_ADMIN_URL_INVALID:
    "This Pod's Admin URL does not match its deployed console. Its owner needs to correct the Pod configuration.",
  POD_CONNECTION_START_FAILED:
    "The Pod could not prepare this connection. Try again shortly; if it persists, ask the Pod owner to inspect Pod Admin.",
};

export default function ConnectionRequestErrorPage() {
  return (
    <Suspense fallback={null}>
      <ConnectionRequestErrorContent />
    </Suspense>
  );
}

function ConnectionRequestErrorContent() {
  const router = useRouter();
  const code = useSearchParams().get("code") ?? "";
  const message =
    messages[code] ??
    "This Pod could not prepare the requested connection. Return to the application and try again.";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl items-center px-5 py-10">
      <Card
        shadow="none"
        className="w-full border border-foreground/10 bg-content1"
      >
        <CardBody className="gap-5 px-6 py-7">
          <div className="flex items-start gap-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning/10 text-warning"
              aria-hidden
            >
              <Settings2 size={19} />
            </span>
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-foreground/50">
                Pod connection
              </p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight">
                Connection setup needs attention
              </h1>
            </div>
          </div>
          <Alert
            color="warning"
            title="The request was not started"
            role="alert"
          >
            {message}
          </Alert>
          <p className="text-sm leading-6 text-foreground/65">
            Your application never received your Pod credentials. You can safely
            return and retry after the Pod owner has fixed the configuration.
          </p>
          <Button
            variant="flat"
            startContent={<ArrowLeft size={16} />}
            onPress={() => router.back()}
          >
            Return to the application
          </Button>
        </CardBody>
      </Card>
    </main>
  );
}
