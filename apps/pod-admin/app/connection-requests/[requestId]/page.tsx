/**
 * /connection-requests/[requestId] — review surface for an external
 * application asking to call this Pod (CORS / transport admission).
 *
 * Server half of the house receiver shape. It exists only to read the request
 * headers: a page where a stranger's application is granted access to this Pod
 * has to say WHICH pod is asking and who the reader is signed in as, or an
 * honest approval request is indistinguishable from a phishing page. The
 * decision itself lives in the client component.
 */

import { headers } from "next/headers";
import { ConnectionRequestReview } from "./ConnectionRequestReview";

export const dynamic = "force-dynamic";

export default async function ConnectionRequestPage() {
  const h = await headers();
  return (
    <ConnectionRequestReview
      podHost={h.get("host") ?? undefined}
      identity={h.get("x-pod-admin-email") ?? undefined}
    />
  );
}
