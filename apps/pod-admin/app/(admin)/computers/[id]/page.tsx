"use client";

/**
 * `/computers/[id]` — one computer in the console (pod admin, any member's).
 * The row comes from `machines.adminList` (there is no single-computer read;
 * the list is the same cache the Computers page holds). The body is
 * `ComputerObject`, the same page `/my-computers/[id]` draws for the owner;
 * this route adds the admin's links out (the agent, the key, the owner).
 */

import { useParams } from "next/navigation";
import { trpc } from "../../../../lib/trpc";
import { navHref, navLabel } from "../../../../lib/console-nav";
import { useReauthOnUnauthorized } from "../../../_lib/object/use-reauth";
import { consoleFrame } from "../../../_lib/object/views/object-frame";
import { ComputerObject, type ComputerLinks } from "../_lib/computer-object";
import { usePodKeyDefaults } from "../_lib/pod-key-lifetime";

const FRAME = consoleFrame({
  label: navLabel("computers"),
  href: navHref("computers"),
});

const LINKS: ComputerLinks = {
  agentHref: (agentId) => navHref("agents", { focus: agentId }),
  keyHref: (keyId) => navHref("keys", { focus: keyId }),
  ownerHref: (userId) => navHref("members", { focus: userId }),
};

export default function ComputerPage() {
  const { id } = useParams<{ id: string }>();
  const list = trpc.machines.adminList.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
  });
  const me = trpc.users.me.useQuery(undefined, { staleTime: 300_000 });
  const defaults = usePodKeyDefaults();
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
      viewerId={me.data?.id ?? null}
      links={LINKS}
      podDefaultDays={
        defaults.read.state === "ok" ? defaults.read.value.keyTtlDays : null
      }
    />
  );
}
