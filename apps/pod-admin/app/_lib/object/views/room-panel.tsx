"use client";

/**
 * A session's room in a side panel: the room's latest messages beside the
 * session, without leaving it (founder, 2026-10-28). The SAME transcript the
 * room's own page draws (`RoomMessages`), at the panel's width — the page
 * grammar's side panel is "the same page at sm", never a second room view.
 * Read-only, like that page: replying stays in the app.
 *
 * It slides in from the right edge, closes on Esc, the backdrop or its close
 * button, and carries the two ways on: the room's full page, and the app.
 */

import Link from "next/link";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
} from "@heroui/react";
import { RoomMessages } from "../room-messages";
import { OpenInAppLink } from "../open-in-app-link";
import { objectPage } from "../content/markdown-model";

const DOOR =
  "rounded-sm text-[12.5px] text-foreground/70 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

export function RoomPanel({
  channelId,
  name,
  isOpen,
  onClose,
}: {
  channelId: string;
  /** The room's name, as the session page read it. */
  name: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const href = objectPage("channel", channelId);
  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      placement="right"
      size="md"
      radius="none"
      scrollBehavior="inside"
    >
      <DrawerContent>
        <DrawerHeader className="flex flex-col gap-0.5 border-b border-foreground/[0.06] pb-3">
          <h2 className="break-words text-[15px] font-medium text-foreground">
            {name}
          </h2>
          <p className="text-[12px] font-normal text-foreground/65">
            You can read it here. Reply in the Synap app.
          </p>
        </DrawerHeader>
        <DrawerBody className="py-4">
          {/* Mounted only while open: a closed panel reads nothing. */}
          {isOpen && <RoomMessages channelId={channelId} />}
        </DrawerBody>
        <DrawerFooter className="justify-start gap-4 border-t border-foreground/[0.06]">
          {href && (
            <Link href={href} className={DOOR}>
              Open the room’s page
            </Link>
          )}
          <OpenInAppLink type="channel" id={channelId} />
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
