import { Suspense } from "react";
import { headers } from "next/headers";
import { AcceptForm } from "./AcceptForm";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function InvitePage({ params }: Props) {
  const { token } = await params;
  // Which pod is inviting. This route is unauthenticated by design, so the pod
  // host is the only anchor an invitee has that the email was genuine.
  const podHost = (await headers()).get("host") ?? undefined;
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center px-6 py-16">
          <div className="h-[320px] w-full max-w-md rounded-xl bg-foreground/[0.04] ring-1 ring-inset ring-foreground/10 shimmer-pulse" />
        </main>
      }
    >
      <AcceptForm token={token} podHost={podHost} />
    </Suspense>
  );
}
