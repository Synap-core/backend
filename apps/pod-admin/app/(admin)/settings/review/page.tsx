/**
 * /settings/review — how the person reviews what agents ask (founder B-3,
 * B-4): the grouping, each package's layout, and the agents they always let
 * take hand-offs. A member page (route-policy `MEMBER_CONSOLE_PATHS`): every
 * read and write is the caller's own preference or a rule `governanceRules`
 * gates itself.
 */

import { Suspense } from "react";
import { PageFallback } from "../../components/page-header";
import { ReviewSettings } from "./_lib/review-settings";

export const dynamic = "force-dynamic";

export default function ReviewSettingsPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <ReviewSettings />
    </Suspense>
  );
}
