"use client";

import { createContext, type ReactNode } from "react";
import type { EmbedEntityRead } from "./markdown-model";

/**
 * What the page around a body lends its embeds: how to read a record on the
 * viewer's own floor, and the object's own "Open in app". The renderer stays a
 * pure drawing of its source — without a provider an entity card names its
 * kind only and asks nothing of the pod (tests, a surface with no reader).
 */
export interface EmbedHost {
  /** A hook: called once per entity card, unconditionally. */
  useEntity: (id: string) => EmbedEntityRead;
  openInApp?: ReactNode;
}

export const EmbedHostContext = createContext<EmbedHost | null>(null);
