"use client";

/**
 * `/open/channel/:id` — one conversation, read-only: its latest messages,
 * oldest first so it reads top to bottom, each drawn by the console's one
 * content renderer. Replying stays in the app.
 *
 * Read doors: `chat.getChannel` and `chat.getMessages`, both through
 * the canonical channel-visibility gate (`channelVisibilityWhere` /
 * `queryChannelMessages`). A conversation the viewer cannot see is today's
 * named card (`BounceView`), never an admin read.
 */

import { trpc } from "../../../lib/trpc";
import { formatRelative, formatTimestamp } from "../../../lib/format";
import {
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../(admin)/components/resource-row";
import { SectionCard } from "../../(admin)/components/section-card";
import { ContentBody } from "../../_lib/object/content/content-block";
import { prepareContent } from "../../_lib/object/content/markdown-model";
import { couldNotLoad, loadFailure } from "../../_lib/object/load-failure";
import { OpenInAppLink } from "../../_lib/object/open-in-app-link";
import { useReauthOnUnauthorized } from "../../_lib/object/use-reauth";
import { OpenFailure, OpenLoading, OpenObject } from "../open-shell";
import { BounceView } from "./bounce-view";
import {
  MESSAGE_MAX_CHARS,
  messageAuthor,
  readingOrder,
  TRANSCRIPT_LIMIT,
  type TranscriptMessage,
} from "./channel-model";

export function ChannelView({ id }: { id: string }) {
  const channel = trpc.chat.getChannel.useQuery(
    { channelId: id, includeContext: false },
    { retry: false }
  );
  const messages = trpc.chat.getMessages.useQuery(
    { threadId: id, limit: TRANSCRIPT_LIMIT },
    { enabled: Boolean(channel.data), retry: false }
  );
  useReauthOnUnauthorized(channel.error, messages.error);

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
  const transcript: TranscriptMessage[] = readingOrder(
    messages.data?.messages ?? []
  );
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
      <SectionCard
        variant="flat"
        title="Latest messages"
        hint={
          messages.data?.hasMore
            ? `The latest ${TRANSCRIPT_LIMIT}. Open in app for the whole conversation.`
            : undefined
        }
      >
        {messages.isLoading ? (
          <div role="status" aria-busy="true" aria-label="Loading messages…">
            <ResourceRowSkeleton count={2} />
          </div>
        ) : messages.error ? (
          <ResourceRowError
            message="The messages couldn’t be loaded. Try again, or open it in the app."
            onRetry={() => void messages.refetch()}
          />
        ) : transcript.length === 0 ? (
          <p className="text-[12.5px] text-foreground/65">No messages yet.</p>
        ) : (
          <ol className="flex flex-col">
            {transcript.map((message) => (
              <TranscriptRow key={message.id} message={message} />
            ))}
          </ol>
        )}
      </SectionCard>
    </OpenObject>
  );
}

function TranscriptRow({ message }: { message: TranscriptMessage }) {
  const prepared = prepareContent(message.content, "markdown", {
    maxChars: MESSAGE_MAX_CHARS,
  });
  return (
    <li className="flex flex-col gap-1.5 border-b border-foreground/[0.06] py-3 first:pt-0 last:border-b-0">
      <p className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
        <span className="font-medium text-foreground">
          {messageAuthor(message)}
        </span>
        <time
          className="text-foreground/65"
          dateTime={new Date(message.timestamp).toISOString()}
          title={formatTimestamp(message.timestamp)}
        >
          {formatRelative(message.timestamp)}
        </time>
      </p>
      <ContentBody prepared={prepared} />
      {prepared.truncated && (
        <p className="text-[12px] text-foreground/65">
          This message is longer. Open in app to read all of it.
        </p>
      )}
    </li>
  );
}
