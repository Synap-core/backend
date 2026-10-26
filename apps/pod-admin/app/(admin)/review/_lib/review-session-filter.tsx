"use client";

/**
 * Review's session filter line (`?session=`, `review-page.tsx`). Its own file
 * so its one rule — the session is named by its own read — is rendered under
 * test apart from the whole page.
 */

import { useEffect } from "react";
import { Button } from "@heroui/react";
import { X } from "lucide-react";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { trpc } from "../../../../lib/trpc";
import { openIn } from "../../../../lib/open-in";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { kindIcon } from "../../../_lib/object/kind-icon";
import { Pill } from "../../../_lib/object/provenance-chips";

/**
 * "From <session>" over the list while Review is narrowed to one session: the
 * session's name is a door to it, and × widens back to everything. Named by
 * the session read itself (the key the review's session strip and the
 * session page share), so the name holds on History and once the last row is
 * decided; unread or not readable, it is the kind's noun, never an id.
 */
export function SessionFilter({
  sessionId,
  onClear,
}: {
  sessionId: string;
  onClear: () => void;
}) {
  const session = trpc.focusSessions.get.useQuery(
    { id: sessionId },
    { retry: false }
  );
  useEffect(() => {
    if (session.error) redirectToLoginIfUnauthorized(session.error);
  }, [session.error]);
  const label =
    (session.data && resolveSessionTitle(session.data)) ||
    resolveObjectNoun("session");
  const SessionIcon = kindIcon("session");
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[12.5px] text-foreground/70">
      <span>From</span>
      <Pill
        exit={openIn({ kind: "object", objectKind: "session", id: sessionId })}
        title={resolveObjectNoun("session")}
      >
        <SessionIcon aria-hidden className="h-3.5 w-3.5 text-foreground/55" />
        <span className="truncate">{label}</span>
      </Pill>
      <Button
        size="sm"
        variant="light"
        radius="md"
        startContent={<X className="h-3.5 w-3.5" aria-hidden />}
        onPress={onClear}
      >
        Show everything
      </Button>
    </div>
  );
}
