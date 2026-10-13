"use client";

/**
 * Resolve a bare id and move on. See `./page.tsx` for why this page exists.
 *
 * Three honest outcomes besides the redirect, never a guess:
 *   • the id is not a uuid            → "This link isn't valid";
 *   • nothing YOU can see has this id → "Nothing here" (the resolver is
 *     user-floored, so this is also what someone else's private object reads
 *     as — by design);
 *   • the lookup FAILED                → say so, with a retry. A failure is
 *     never folded into "nothing here" (`diagnose.resolveOpen` throws for it).
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react";
import { trpc } from "../../../lib/trpc";
import { openPathForResolved } from "../open-model";
import { labelForOpenType } from "../open-params";
import { isUuid } from "../../../lib/format";
import { OpenLoading, OpenMessage, OpenObject } from "../open-shell";
import { useReauthOnUnauthorized } from "../../_lib/object/use-reauth";

const PLACEHOLDER_UUID = "00000000-0000-4000-8000-000000000000";

export function ResolveOpen({ id }: { id: string }) {
  const router = useRouter();
  const valid = isUuid(id);
  const query = trpc.diagnose.resolveOpen.useQuery(
    { id: valid ? id : PLACEHOLDER_UUID },
    { enabled: valid, retry: false }
  );
  const target = query.data ? openPathForResolved(query.data) : null;
  useReauthOnUnauthorized(query.error);

  useEffect(() => {
    // `replace`: this page is a hop, not a place — Back must skip it.
    if (target) router.replace(target);
  }, [router, target]);

  if (!valid) {
    return (
      <OpenMessage
        kind="open"
        title="This link isn’t valid"
        message="The address doesn’t look like a Synap object. Check the link and try again."
        chip="Invalid link"
      />
    );
  }
  if (query.isLoading || target) return <OpenLoading label="Opening…" />;

  if (query.error) {
    return (
      <OpenObject
        header={{
          kind: "open",
          noun: "Open",
          title: "This link couldn’t be looked up",
          summary:
            "Something went wrong while finding what this link points to. Try again in a moment.",
          status: { kind: "down", label: "Lookup failed" },
          primaryAction: (
            <Button
              size="sm"
              radius="md"
              variant="flat"
              onPress={() => void query.refetch()}
            >
              Try again
            </Button>
          ),
        }}
      />
    );
  }

  const resolved = query.data;
  // Resolved, but to a kind with no door anywhere (an external send).
  if (resolved && resolved.type !== "unknown") {
    return (
      <OpenMessage
        kind={resolved.type}
        title={
          resolved.displayName ??
          `A ${labelForOpenType(resolved.type).toLowerCase()}`
        }
        message="This exists, but it has no page to open — on the web or in the app."
        chip="Nothing to open"
      />
    );
  }
  return (
    <OpenMessage
      kind="open"
      title="Nothing here"
      message="No object you can see has this address. It may have been deleted, or it belongs to someone else."
      chip="Not found"
    />
  );
}
