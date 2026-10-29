"use client";

/**
 * `/open/channel/:id` — one conversation, read-only: its latest messages
 * (`RoomMessages`, the transcript a session's room panel draws too).
 * Replying stays in the app.
 *
 * Read doors: `chat.getChannel` and `chat.getMessages`, both through
 * the canonical channel-visibility gate (`channelVisibilityWhere` /
 * `queryChannelMessages`). A conversation the viewer cannot see is today's
 * named card (`BounceView`), never an admin read.
 */

import { trpc } from "../../../lib/trpc";
import { formatRelative } from "../../../lib/format";
import { couldNotLoad, loadFailure } from "../../_lib/object/load-failure";
import { OpenInAppLink } from "../../_lib/object/open-in-app-link";
import { useReauthOnUnauthorized } from "../../_lib/object/use-reauth";
import { OpenFailure, OpenLoading, OpenObject } from "../open-shell";
import { RoomMessages } from "../../_lib/object/room-messages";
import { BounceView } from "./bounce-view";

export function ChannelView({ id }: { id: string }) {
  const channel = trpc.chat.getChannel.useQuery(
    { channelId: id, includeContext: false },
    { retry: false }
  );
  useReauthOnUnauthorized(channel.error);

  if (channel.isLoading) return <OpenLoading label="Loading conversation…" />;
  const code = channel.error?.data?.code;
  if (code === "NOT_FOUND" || code === "FORBIDDEN") {
    return <BounceView type="channel" id={id} viewerIsPodAdmin={false} />;
  }
  const row = channel.data?.channel;
  const fail = loadFailure(channel.error, "Channel");
  if (fail || !row) {
    return (
      <OpenFailure
        kind="channel"
        id={id}
        failure={fail ?? couldNotLoad("Channel")}
      />
    );
  }

  const openInApp = <OpenInAppLink type="channel" id={id} />;
  return (
    <OpenObject
      header={{
        kind: "channel",
        title: row.title?.trim() || "Untitled conversation",
        summary: "You can read it here. Reply in the Synap app.",
        primaryAction: openInApp,
      }}
      facts={
        row.updatedAt
          ? [{ label: "Updated", value: formatRelative(row.updatedAt) }]
          : undefined
      }
      advanced={{
        ids: [
          { label: "Conversation id", value: row.id },
          ...(row.workspaceId
            ? [{ label: "Space id", value: row.workspaceId }]
            : []),
        ],
      }}
    >
      <RoomMessages channelId={id} enabled={Boolean(channel.data)} />
    </OpenObject>
  );
}
