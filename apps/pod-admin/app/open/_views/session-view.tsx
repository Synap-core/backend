"use client";

/**
 * `/open/session/:id` — the shared session body (`SessionBody`) in the
 * receiver card. The console draws the same body at `/sessions/:id`.
 */

import {
  SessionBody,
  type ObjectFrame,
} from "../../_lib/object/views/session-body";
import { OpenFailure, OpenLoading, OpenObject } from "../open-shell";

const OPEN_FRAME: ObjectFrame = {
  Loading: OpenLoading,
  Failure: OpenFailure,
  Page: OpenObject,
  pathFor: (id) => `/open/session/${id}`,
};

export function SessionView({ id }: { id: string }) {
  return <SessionBody id={id} frame={OPEN_FRAME} />;
}
