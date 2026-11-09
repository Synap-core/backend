"use client";

import { createContext, type ReactNode } from "react";
import type {
  EmbedCellInstanceRead,
  EmbedCellRead,
  EmbedEntityRead,
  ObjectRefRead,
} from "./markdown-model";

/**
 * What the page around a body lends its embeds: how to read a record or a
 * cell on the viewer's own floor, and the object's own "Open in app". The
 * renderer stays a pure drawing of its source — without a provider an entity
 * card names its kind only, a cell is its chip, a reference shows its own
 * words, and nothing asks the pod (tests, a surface with no reader).
 */
export interface EmbedHost {
  /** A hook: called once per entity card, unconditionally. */
  useEntity: (id: string) => EmbedEntityRead;
  /** A hook: called once per block cell embed that names a key. */
  useCell?: (cellKey: string) => EmbedCellRead;
  /**
   * A hook: called once per cell embed that names only an instance — its
   * name and type, on the viewer's own floor. Without it the embed is a
   * chip the directive alone names ("Card").
   */
  useCellInstance?: (instanceId: string) => EmbedCellInstanceRead;
  /**
   * A hook: called once per reference in prose (a marker or a bare id) —
   * what the id is, its name and its kind, on the viewer's own floor.
   * Without it a marker shows its label or its kind's noun, a bare id its text.
   */
  useObjectRef?: (id: string) => ObjectRefRead;
  openInApp?: ReactNode;
}

export const EmbedHostContext = createContext<EmbedHost | null>(null);
