"use client";

/**
 * `/keys/[id]` — one API key's own page (pod admin). The row comes from
 * `apiKeys.adminListAll` (there is no single-key read; the list is the same
 * cache the Keys page holds, and it carries what each key may touch). The
 * body is `KeyObject`. A computer's or an app's key row opens its holder's
 * page first (`keyHref`), which links here.
 */

import { useParams } from "next/navigation";
import { useMemo } from "react";
import { trpc } from "../../../../lib/trpc";
import { navHref, navLabel } from "../../../../lib/console-nav";
import { useReauthOnUnauthorized } from "../../../_lib/object/use-reauth";
import { consoleFrame } from "../../../_lib/object/views/object-frame";
import { KeyObject } from "../_lib/key-object";
import type { UnifiedKey } from "../_lib/key-model";

const FRAME = consoleFrame({
  label: navLabel("keys"),
  href: navHref("keys"),
});

export default function KeyPage() {
  const { id } = useParams<{ id: string }>();
  const list = trpc.apiKeys.adminListAll.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
  });
  const me = trpc.users.me.useQuery(undefined, { staleTime: 300_000 });
  const profiles = trpc.profiles.list.useQuery(undefined, {
    staleTime: 60_000,
  });
  const spaces = trpc.workspaces.list.useQuery(undefined, {
    staleTime: 60_000,
  });
  useReauthOnUnauthorized(list.error);

  const ctx = useMemo(
    () => ({
      kinds: (profiles.data?.profiles ?? []).map((p) => ({
        slug: p.slug,
        name: p.displayName || undefined,
      })),
    }),
    [profiles.data]
  );

  return (
    <KeyObject
      id={id}
      apiKey={
        list.data
          ? ((list.data as UnifiedKey[]).find((k) => k.id === id) ?? null)
          : undefined
      }
      isLoading={list.isLoading}
      error={list.error}
      frame={FRAME}
      viewerId={me.data?.id ?? null}
      ctx={ctx}
      spaces={(spaces.data ?? []).map((w) => ({ id: w.id, name: w.name }))}
    />
  );
}
