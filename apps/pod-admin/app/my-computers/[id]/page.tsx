"use client";

/**
 * /my-computers/[id] — one of YOUR computers. The same `ComputerObject` the
 * admin's `/computers/[id]` draws, from your own floored `machines.list`; a
 * computer that is not yours reads as not found. No links out to admin pages
 * (Agents, Keys, Members), which a member cannot open.
 */

import { useParams } from "next/navigation";
import { trpc } from "../../../lib/trpc";
import { useReauthOnUnauthorized } from "../../_lib/object/use-reauth";
import { consoleFrame } from "../../_lib/object/views/object-frame";
import { ComputerObject } from "../../(admin)/computers/_lib/computer-object";

const FRAME = consoleFrame({ label: "My computers", href: "/my-computers" });

export default function MyComputerPage() {
  const { id } = useParams<{ id: string }>();
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
      frame={FRAME}
      viewerId={null}
      links={{}}
    />
  );
}
