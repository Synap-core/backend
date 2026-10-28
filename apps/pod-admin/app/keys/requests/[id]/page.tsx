/**
 * /keys/requests/[id] — approve a key a computer asked for (keys plan §3.6,
 * Decision 4: "the CLI requests a key and opens the pod-admin page where the
 * person validates it, and never mints directly"). `synap keys create` prints
 * and opens this link (`review_url`).
 *
 * A receiver, like `/device`: the server half reads the headers so the page
 * says which pod asks and who the reader is signed in as. Auth: `proxy.ts`
 * lists `/keys/requests/` as self-service; the pod answers only the request's
 * own person, signed in.
 */

import { headers } from "next/headers";
import { KeyRequestReview } from "./KeyRequestReview";

export const dynamic = "force-dynamic";

export default async function KeyRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const h = await headers();
  return (
    <KeyRequestReview
      requestId={id}
      podHost={h.get("host") ?? undefined}
      identity={h.get("x-pod-admin-email") ?? undefined}
    />
  );
}
