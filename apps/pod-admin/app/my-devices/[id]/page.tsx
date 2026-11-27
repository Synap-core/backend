"use client";

/**
 * /my-devices/[id] — one of YOUR computers. The same `ComputerObject` the
 * admin's `/devices/[id]` draws, from your own floored `machines.list`; a
 * computer that is not yours reads as not found. No links out to admin pages
 * (Agents, Keys, Members), which a member cannot open.
 */

import { useMemo } from "react";
import { useParams } from "next/navigation";
import { trpc } from "../../../lib/trpc";
import { useReauthOnUnauthorized } from "../../_lib/object/use-reauth";
import { consoleFrame } from "../../_lib/object/views/object-frame";
import { ComputerObject } from "../../(admin)/devices/_lib/computer-object";
import { useT } from "../../../lib/i18n/locale-provider";
import { en, fr } from "../../(admin)/components/copy";

const SHELL_CATALOGS = { en, fr };

export default function MyComputerPage() {
  const { id } = useParams<{ id: string }>();
  const t = useT(SHELL_CATALOGS);
  const label = t("user.devices");
  const frame = useMemo(
    () => consoleFrame({ label, href: "/my-devices", width: "personal" }),
    [label]
  );
  const list = trpc.machines.list.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
  });
  useReauthOnUnauthorized(list.error);

  return (
    <ComputerObject
      id={id}
      computer={
        list.data ? (list.data.find((c) => c.id === id) ?? null) : undefined
      }
      isLoading={list.isLoading}
      error={list.error}
      frame={frame}
      viewerId={null}
      links={{}}
    />
  );
}
