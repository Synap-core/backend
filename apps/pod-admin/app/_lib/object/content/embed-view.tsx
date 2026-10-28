"use client";

/**
 * One `:::synap-*` embed, drawn from the shared embed model
 * (`describeEmbed`, `@synap-core/types/renderables`) — the console decides
 * nothing about what an embed IS, only how it looks here.
 *
 *   chart-snapshot  the chart, drawn from its numbers (`embed-chart`)
 *   chart-broken    a visible error row with the reason — never an empty chart
 *   entity          a card that opens the record's console page; its title
 *                   only when the reader's own read returns it
 *   view            a chip that opens the view's console page
 *   cell-frame      an HTML page cell RUNS, in the isolated frame of
 *                   `html-frame`, its source read on the viewer's own floor
 *                   (`widgetDefinitions.get`); any other cell is a chip that
 *                   opens its `/open/cell/<key>` card (handed to the app)
 *   chart-live, cell-builtin, unknown
 *                   a quiet chip naming it + the object's "Open in app"
 *   broken          says the embed names nothing
 *
 * HTML runs in the isolated frame in exactly two places: a stored HTML
 * document's own page, and an HTML cell embedded in a body (here) — the same
 * `HtmlFrame`, sandbox and policy (`@synap-core/types/cell-bridge`), never
 * same-origin and never inline in the console's DOM. Nothing else in content
 * runs: a React cell is never mounted here. The author's fallback prose stays
 * visible under every block.
 */

import { useContext, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, BarChart3, Lock, type LucideIcon } from "lucide-react";
import type { Embed } from "@synap-core/markdown-core";
import { CELL_FRAME_MAX_BYTES } from "@synap-core/types/cell-bridge";
import { describeEmbed, type EmbedModel } from "@synap-core/types/renderables";
import {
  nounInSentence,
  resolveEmbedWords,
  type EmbedWords,
} from "@synap-core/types/vocabulary";
import { kindIcon } from "../kind-icon";
import { ChartSnapshot } from "./embed-chart";
import { EmbedHostContext, type EmbedHost } from "./embed-context";
import { HtmlFrame } from "./html-frame";
import {
  objectPage,
  type EmbedCellRead,
  type EmbedEntityRead,
} from "./markdown-model";
import { MediaView } from "../../media/media-view";
import { humanizeBytes } from "../../../../lib/format";

const CHIP =
  "inline-flex max-w-full items-center gap-1.5 rounded-md bg-foreground/[0.05] px-2 py-1 text-[12.5px] text-foreground/80 ring-1 ring-inset ring-foreground/10";
const DOOR =
  "underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

function embedModelOf(embed: Embed): EmbedModel {
  return describeEmbed({
    kind: embed.kind,
    attrs: embed.ref,
    props: embed.props,
    propsError: embed.propsError,
  });
}

function iconFor(model: EmbedModel): LucideIcon {
  switch (model.kind) {
    case "chart-snapshot":
    case "chart-broken":
    case "chart-live":
      return BarChart3;
    case "entity":
      return kindIcon("entity");
    case "view":
      return kindIcon("view");
    default:
      return kindIcon("cell");
  }
}

/** "Line Chart · Live chart" — the label, then what kind of thing it is. */
function chipMark(model: EmbedModel, words: EmbedWords): string {
  return model.kind === "chart-live"
    ? `Live ${nounInSentence(words.noun)}`
    : words.noun;
}

function Chip({
  model,
  words,
  href,
}: {
  model: EmbedModel;
  words: EmbedWords;
  href?: string | null;
}) {
  const Icon = iconFor(model);
  const { label } = words;
  const mark = chipMark(model, words);
  const body = (
    <>
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{label}</span>
      {!label.toLowerCase().includes(mark.toLowerCase()) && (
        <span className="shrink-0 text-foreground/55">· {mark}</span>
      )}
    </>
  );
  return href ? (
    <Link href={href} className={`${CHIP} ${DOOR}`}>
      {body}
    </Link>
  ) : (
    <span className={CHIP}>{body}</span>
  );
}

function Note({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <p className="flex items-start gap-1.5 text-[12.5px] text-foreground/65">
      <Icon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

// ─── Entity card ─────────────────────────────────────────────────────────────

const UNRESOLVED: EmbedEntityRead = { state: "unresolved" };

function EntityCardBody({
  model,
  words: { noun, label },
  read,
  inline,
}: {
  model: Extract<EmbedModel, { kind: "entity" }>;
  words: EmbedWords;
  read: EmbedEntityRead;
  inline: boolean;
}) {
  const href = objectPage("entity", model.id);
  const Icon = iconFor(model);
  if (read.state === "hidden" || !href) {
    // Neither the title nor which (gone / not yours) — the pod says NOT_FOUND
    // for both, and the authored label is not repeated either.
    const words = href
      ? "This isn’t visible to you, or no longer exists."
      : `This ${nounInSentence(noun)} link can’t be opened here.`;
    return inline ? (
      <span className={CHIP}>
        <Lock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        {words}
      </span>
    ) : (
      <Note icon={Lock}>{words}</Note>
    );
  }
  if (read.state === "failed") {
    return (
      <span className={`${CHIP} flex-wrap`}>
        <AlertTriangle
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-danger"
        />
        This {nounInSentence(noun)} couldn’t be loaded.
        {read.retry && (
          <button
            type="button"
            onClick={read.retry}
            className={`font-medium text-foreground ${DOOR}`}
          >
            Try again
          </button>
        )}
      </span>
    );
  }
  if (read.state === "loading") {
    return (
      <span
        role="status"
        aria-busy="true"
        aria-label={`Loading ${nounInSentence(noun)}…`}
        className={`${CHIP} w-40`}
      >
        <span className="h-3 w-full rounded bg-foreground/[0.07] shimmer-pulse" />
      </span>
    );
  }
  const title = read.state === "ready" ? read.title : label;
  const words = (
    <>
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words font-medium text-foreground">
        {title}
      </span>
      {title !== noun && (
        <span className="shrink-0 text-foreground/55">· {noun}</span>
      )}
    </>
  );
  if (inline) {
    return (
      <Link href={href} className={`${CHIP} ${DOOR}`}>
        {words}
      </Link>
    );
  }
  const card = (
    <Link
      href={href}
      className={`flex max-w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] ring-1 ring-inset ring-foreground/10 hover:bg-foreground/[0.03] ${DOOR}`}
    >
      {words}
    </Link>
  );
  // A record that IS an image (an uploaded file) shows it, as a thumbnail.
  const media = read.state === "ready" ? read.media : undefined;
  return media ? (
    <div className="flex flex-col gap-2">
      <MediaView
        media={media}
        alt={title}
        size="thumb"
        viaEntityId={model.id}
      />
      {card}
    </div>
  ) : (
    card
  );
}

type EntityCardProps = {
  model: Extract<EmbedModel, { kind: "entity" }>;
  words: EmbedWords;
  inline: boolean;
};

function EntityCardRead({
  host,
  ...props
}: EntityCardProps & { host: EmbedHost }) {
  const read = host.useEntity(props.model.id);
  return <EntityCardBody {...props} read={read} />;
}

function EntityCard(props: EntityCardProps) {
  const host = useContext(EmbedHostContext);
  return host ? (
    <EntityCardRead host={host} {...props} />
  ) : (
    <EntityCardBody {...props} read={UNRESOLVED} />
  );
}

// ─── Cell ────────────────────────────────────────────────────────────────────

/** A chip with the object's own "Open in app" beside it, for a block. */
function ChipWithExit({
  model,
  words,
  inline,
}: {
  model: EmbedModel;
  words: EmbedWords;
  inline: boolean;
}) {
  const host = useContext(EmbedHostContext);
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Chip model={model} words={words} />
      {!inline && host?.openInApp}
    </span>
  );
}

type CellFrameModel = Extract<EmbedModel, { kind: "cell-frame" }>;

/**
 * A cell the console does not run, as a door: the chip opens the cell's
 * `/open/cell/<key>` card, which hands it to the app. With no key (an
 * instance only the pod knows) the object's own "Open in app" stands beside.
 */
function CellDoor({
  model,
  words,
  inline,
}: {
  model: CellFrameModel;
  words: EmbedWords;
  inline: boolean;
}) {
  const href = model.cellKey ? objectPage("cell", model.cellKey) : null;
  return href ? (
    <Chip model={model} words={words} href={href} />
  ) : (
    <ChipWithExit model={model} words={words} inline={inline} />
  );
}

function CellFrameBody({
  model,
  words,
  read,
}: {
  model: CellFrameModel;
  words: EmbedWords;
  read: EmbedCellRead;
}) {
  const noun = nounInSentence(words.noun);
  switch (read.state) {
    case "loading":
      return (
        <span
          role="status"
          aria-busy="true"
          aria-label={`Loading ${noun}…`}
          className={`${CHIP} w-40`}
        >
          <span className="h-3 w-full rounded bg-foreground/[0.07] shimmer-pulse" />
        </span>
      );
    case "hidden":
      // Neither its source nor which (gone / not yours): the pod answers
      // `null` for both.
      return (
        <Note icon={Lock}>This isn’t visible to you, or no longer exists.</Note>
      );
    case "failed":
      return (
        <span className={`${CHIP} flex-wrap`}>
          <AlertTriangle
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-danger"
          />
          This {noun} couldn’t be loaded.
          {read.retry && (
            <button
              type="button"
              onClick={read.retry}
              className={`font-medium text-foreground ${DOOR}`}
            >
              Try again
            </button>
          )}
        </span>
      );
    case "page":
      if (read.tooLarge) {
        return (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[12.5px] text-foreground/65">
              This {noun} is {humanizeBytes(read.bytes)}. The console runs pages
              up to {humanizeBytes(CELL_FRAME_MAX_BYTES)}.
            </span>
            <CellDoor model={model} words={words} inline={false} />
          </span>
        );
      }
      return (
        <HtmlFrame
          html={read.html}
          workspaceId={read.workspaceId}
          title={words.label}
        />
      );
    case "app":
    case "unresolved":
      return <CellDoor model={model} words={words} inline={false} />;
  }
}

function CellFrameRead({
  useCell,
  cellKey,
  ...props
}: {
  useCell: (cellKey: string) => EmbedCellRead;
  cellKey: string;
  model: CellFrameModel;
  words: EmbedWords;
}) {
  const read = useCell(cellKey);
  return <CellFrameBody {...props} read={read} />;
}

/**
 * A cell embed. An HTML page RUNS here, in the one isolated frame
 * (`html-frame`); any other cell is a door to it. Inline in a sentence it is
 * always the door — a page never runs mid-line.
 */
function CellFrame({
  model,
  words,
  inline,
}: {
  model: CellFrameModel;
  words: EmbedWords;
  inline: boolean;
}) {
  const host = useContext(EmbedHostContext);
  if (inline || !model.cellKey || !host?.useCell) {
    return <CellDoor model={model} words={words} inline={inline} />;
  }
  return (
    <CellFrameRead
      useCell={host.useCell}
      cellKey={model.cellKey}
      model={model}
      words={words}
    />
  );
}

// ─── The block ───────────────────────────────────────────────────────────────

function Head({
  model,
  words,
  inline,
}: {
  model: EmbedModel;
  words: EmbedWords;
  inline: boolean;
}) {
  switch (model.kind) {
    case "chart-snapshot":
      return inline ? (
        <Chip model={model} words={words} />
      ) : (
        <ChartSnapshot model={model} title={words.label} />
      );
    case "chart-broken": {
      const Tag = inline ? "span" : "p";
      return (
        <Tag
          className={`${inline ? "inline-flex" : "flex"} items-start gap-1.5 rounded-md bg-danger/10 px-2 py-1 text-[12.5px] text-foreground ring-1 ring-inset ring-danger/30`}
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger"
          />
          <span className="min-w-0 break-words">
            <span className="font-medium">{words.label}</span> can’t be drawn:{" "}
            {model.message}
          </span>
        </Tag>
      );
    }
    case "entity":
      return <EntityCard model={model} words={words} inline={inline} />;
    case "view":
      return (
        <Chip
          model={model}
          words={words}
          href={objectPage("view", model.viewId)}
        />
      );
    case "broken":
      return inline ? (
        <span className={CHIP}>
          This {nounInSentence(words.noun)} embed names nothing to show.
        </span>
      ) : (
        <Note icon={AlertTriangle}>
          This {nounInSentence(words.noun)} embed names nothing to show.
        </Note>
      );
    case "cell-frame":
      return <CellFrame model={model} words={words} inline={inline} />;
    default:
      return <ChipWithExit model={model} words={words} inline={inline} />;
  }
}

/**
 * `fallback` is the author's prose, already drawn by the caller (the one
 * markdown walker); it shows under the head.
 */
export function EmbedBlock({
  embed,
  inline,
  fallback,
}: {
  embed: Embed;
  inline: boolean;
  fallback: ReactNode;
}) {
  const model = embedModelOf(embed);
  const words = resolveEmbedWords(model);
  if (inline) return <Head model={model} words={words} inline />;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-embed={model.kind}>
      <Head model={model} words={words} inline={false} />
      {embed.fallback.length > 0 && (
        <div className="flex flex-col gap-2 text-foreground/80">{fallback}</div>
      )}
    </div>
  );
}
