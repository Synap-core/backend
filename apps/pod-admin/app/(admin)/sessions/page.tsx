/**
 * /sessions — every piece of work on the pod, by where it stands. The page is
 * the client component; this file only gives `useSearchParams` (?filter=,
 * ?focus=) its Suspense boundary.
 */

import { Suspense } from "react";
import { PageHeader } from "../components/page-header";
import { ResourceRowSkeleton } from "../components/resource-row";
import { SessionsPage } from "./_lib/sessions-page";
import { SESSIONS_DESCRIPTION, SESSIONS_TITLE } from "./_lib/session-rows";

export default function Sessions() {
  return (
    <Suspense
      fallback={
        <div className="max-w-[1100px] px-4 py-6 sm:px-6">
          <PageHeader
            title={SESSIONS_TITLE}
            description={SESSIONS_DESCRIPTION}
          />
          <ResourceRowSkeleton count={5} />
        </div>
      }
    >
      <SessionsPage />
    </Suspense>
  );
}
