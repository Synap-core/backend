/**
 * /review — everything waiting on your decision, in one place.
 *
 * Server half: it only reads which pod this is and who is signed in, the two
 * facts every decision drawer states before asking for a click (an honest
 * approval and a phishing page look alike without them). The page itself is
 * the client component.
 */

import { Suspense } from "react";
import { headers } from "next/headers";
import { PageFallback } from "../components/page-header";
import { ReviewPage } from "./_lib/review-page";

export const dynamic = "force-dynamic";

export default async function Review() {
  const h = await headers();
  const viewer = {
    podHost: h.get("host") ?? undefined,
    identity:
      h.get("x-pod-admin-name") ?? h.get("x-pod-admin-email") ?? undefined,
  };
  return (
    // `useSearchParams` (?type=, ?focus=) needs a Suspense boundary.
    <Suspense fallback={<PageFallback />}>
      <ReviewPage viewer={viewer} />
    </Suspense>
  );
}
