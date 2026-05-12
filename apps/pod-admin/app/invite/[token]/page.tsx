import { Suspense } from "react";
import { AcceptForm } from "./AcceptForm";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function InvitePage({ params }: Props) {
  const { token } = await params;
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center px-6 py-16">
          <div className="h-[320px] w-full max-w-md rounded-xl bg-foreground/[0.04] ring-1 ring-inset ring-foreground/10 shimmer-pulse" />
        </main>
      }
    >
      <AcceptForm token={token} />
    </Suspense>
  );
}
