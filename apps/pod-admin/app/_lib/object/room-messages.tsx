"use client";

/**
 * A room's latest messages, read-only — the ONE transcript the room's own
 * page (`/open/channel/:id`) and a session's room panel draw. Oldest first,
 * so it reads top to bottom; each message through the console's one content
 * renderer. Replying stays in the app.
 *
 * Read door: `chat.getMessages`, through the canonical channel-visibility
 * gate (`queryChannelMessages`). Loading, a failed read and an empty room are
 * three different states, each said as itself.
 */

import { trpc } from "../../../lib/trpc";
import { formatRelative, formatTimestamp } from "../../../lib/format";
import {
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../(admin)/components/resource-row";
import { SectionCard } from "../../(admin)/components/section-card";
import { ContentBody } from "./content/content-block";
import { prepareContent } from "./content/markdown-model";
import { useReauthOnUnauthorized } from "./use-reauth";
import {
  MESSAGE_MAX_CHARS,
  messageAuthor,
  readingOrder,
  TRANSCRIPT_LIMIT,
  type TranscriptMessage,
} from "../../open/_views/channel-model";

export function RoomMessages({
  channelId,
  enabled = true,
}: {
  channelId: string;
  /** Hold the read until the room itself has been read (its page does). */
  enabled?: boolean;
}) {
  const messages = trpc.chat.getMessages.useQuery(
    { threadId: channelId, limit: TRANSCRIPT_LIMIT },
    { enabled, retry: false }
  );
  useReauthOnUnauthorized(messages.error);
  const transcript: TranscriptMessage[] = readingOrder(
    messages.data?.messages ?? []
  );
  return (
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
