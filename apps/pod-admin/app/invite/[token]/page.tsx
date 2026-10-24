import { Suspense } from "react";
import { headers } from "next/headers";
import { AcceptForm } from "./AcceptForm";
import { readCloudSignIn } from "../../../lib/cloud-sign-in";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function InvitePage({ params }: Props) {
  const { token } = await params;
  const incoming = await headers();
  // Which pod is inviting. This route is unauthenticated by design, so the pod
  // host is the only anchor an invitee has that the email was genuine.
  const podHost = incoming.get("host") ?? undefined;
  // "Continue with Synap Cloud" is offered only when the pod offers it (off
  // when the owner turned Synap Cloud sign-in off). A failed read hides the
  // door too: it is one of three ways, and the pod's gate decides anyway.
  const cloud = await readCloudSignIn(incoming);
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center px-6 py-16">
          <div className="h-[320px] w-full max-w-md rounded-xl bg-foreground/[0.04] ring-1 ring-inset ring-foreground/10 shimmer-pulse" />
        </main>
      }
    >
      <AcceptForm
        token={token}
        podHost={podHost}
        cloudSignIn={cloud?.available === true}
      />
    </Suspense>
  );
}
