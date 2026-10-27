"use client";

/**
 * The console's ONE image door, drawn: give it a `MediaRef` (from
 * `resolveEntityMedia`, `documentFileMedia`, …) and it signs, loads and draws
 * it, every state worded. Never an `<img>` anywhere else in the console.
 *
 *   · loading — a sized placeholder, so the page does not jump;
 *   · image   — lazy, bounded (`thumb` in a card or list, `full` on the
 *               object's own page); a click opens it full size;
 *   · file    — a stored file that is not a drawable raster (an SVG, a type
 *               the pod did not name): named, and downloaded on purpose;
 *   · external — an address outside the pod: a link the reader follows,
 *               never loaded;
 *   · failed  — why, in the reader's words, with "Try again" when asking
 *               again can help. A failure never looks like "no image".
 */

import { useState } from "react";
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
} from "@heroui/react";
import { Download, ExternalLink, ImageOff } from "lucide-react";
import type { MediaRef } from "@synap-core/types/presentation";
import { EXTERNAL_REL } from "../object/content/markdown-model";
import {
  fileTypeLabel,
  imageDraw,
  withLoadFailure,
  type ImageDraw,
} from "./stored-media-model";
import { useStoredMedia } from "./use-stored-media";

/** `thumb` in a card or list; `full` on the object's own page. */
export type MediaSize = "thumb" | "full";

const BOX: Record<MediaSize, string> = {
  thumb: "h-40 w-full max-w-[16rem]",
  full: "h-64 w-full max-w-xl",
};

const IMG: Record<MediaSize, string> = {
  thumb: "max-h-40 max-w-[16rem]",
  full: "max-h-[70vh] max-w-full",
};

/**
 * The image's edge: an outline drawn just inside it. An inset ring is a box
 * shadow, which an image's own pixels paint over, so it never showed.
 */
export const IMAGE_EDGE =
  "outline outline-1 -outline-offset-1 outline-foreground/10";

const CHIP =
  "inline-flex max-w-full items-center gap-1.5 rounded-md bg-foreground/[0.05] px-2 py-1 text-[12.5px] text-foreground/80 ring-1 ring-inset ring-foreground/10";

const DOOR =
  "underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

/**
 * One `ImageDraw`, drawn. Pure of the pod: the page-level `MediaView` feeds it
 * the signing; tests feed it each state.
 */
export function MediaFrame({
  draw,
  alt,
  size,
  onRetry,
  onOpen,
  onImageError,
}: {
  draw: ImageDraw;
  /** The record's name or caption. */
  alt: string;
  size: MediaSize;
  onRetry?: () => void;
  onOpen?: () => void;
  onImageError?: (src: string) => void;
}) {
  const name = alt.trim() || "Image";
  switch (draw.state) {
    case "none":
      return null;
    case "loading":
      return (
        <div
          role="status"
          aria-busy="true"
          aria-label={`Loading ${name}…`}
          className={`${BOX[size]} rounded-lg bg-foreground/[0.07] shimmer-pulse`}
        />
      );
    case "failed":
      return (
        <div
          className={`${BOX[size]} flex flex-col items-center justify-center gap-2 rounded-lg px-4 text-center ring-1 ring-inset ring-foreground/10`}
        >
          <ImageOff aria-hidden="true" className="h-5 w-5 text-foreground/45" />
          <p className="text-[12.5px] text-foreground/70">{draw.message}</p>
          {draw.retryable && onRetry && (
            <Button size="sm" variant="flat" onPress={onRetry}>
              Try again
            </Button>
          )}
        </div>
      );
    case "external":
      return (
        <a
          href={draw.href}
          target="_blank"
          rel={EXTERNAL_REL}
          className={`${CHIP} ${DOOR}`}
        >
          <ExternalLink aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{`Image: ${name}`}</span>
        </a>
      );
    case "file": {
      const label = `${fileTypeLabel(draw.mime)} · ${name}`;
      return draw.href ? (
        <a href={draw.href} className={`${CHIP} ${DOOR}`}>
          <Download aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </a>
      ) : (
        <span className={CHIP}>
          <span className="truncate">{label}</span>
        </span>
      );
    }
    case "image": {
      const { src } = draw;
      return (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${name} full size`}
          className="block w-fit max-w-full cursor-zoom-in rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {/* A plain <img>, not next/image: the URL is signed and expires,
              and the console's server must never fetch or cache it. */}
          <img
            src={src}
            alt={name}
            loading="lazy"
            decoding="async"
            onError={() => onImageError?.(src)}
            className={`${IMG[size]} h-auto w-auto rounded-lg object-contain ${IMAGE_EDGE}`}
          />
        </button>
      );
    }
  }
}

/**
 * A `MediaRef` signed for the person reading and drawn. `viaEntityId` names
 * the record the media is drawn FOR, so the pod checks that one record holds
 * it (`?entityId=` on the document door).
 */
export function MediaView({
  media,
  alt,
  size,
  viaEntityId,
}: {
  media: MediaRef;
  alt: string;
  size: MediaSize;
  viaEntityId?: string | null;
}) {
  const stored = media.via === "stored" ? media : null;
  const sign = useStoredMedia(stored, { viaEntityId });
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const draw = withLoadFailure(
    imageDraw(media, stored ? sign : null, {
      podConfigured: sign.podConfigured,
    }),
    brokenSrc
  );
  const name = alt.trim() || "Image";
  return (
    <>
      <MediaFrame
        draw={draw}
        alt={name}
        size={size}
        onRetry={() => {
          setBrokenSrc(null);
          sign.refetch();
        }}
        onOpen={() => setOpen(true)}
        onImageError={setBrokenSrc}
      />
      {draw.state === "image" && (
        <Modal
          isOpen={open}
          onClose={() => setOpen(false)}
          size="5xl"
          scrollBehavior="inside"
        >
          <ModalContent>
            <ModalHeader className="flex items-center justify-between gap-3 pr-12 text-[14px] font-semibold">
              <span className="truncate">{name}</span>
              <a
                href={draw.src}
                className={`inline-flex shrink-0 items-center gap-1.5 text-[12.5px] font-normal text-foreground/75 ${DOOR}`}
              >
                <Download aria-hidden="true" className="h-3.5 w-3.5" />
                Download
              </a>
            </ModalHeader>
            <ModalBody className="items-center pb-6">
              <img
                src={draw.src}
                alt={name}
                decoding="async"
                className="max-h-[80vh] max-w-full rounded-lg object-contain"
              />
            </ModalBody>
          </ModalContent>
        </Modal>
      )}
    </>
  );
}
