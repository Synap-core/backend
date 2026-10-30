"use client";

import { ExitLink } from "../../../lib/exit-link";
import { openIn } from "../../../lib/open-in";

/**
 * The desktop form of the object. A bare `synap://` does NOTHING when the app
 * is not installed, and these links arrive by email and CLI, so "not
 * installed" is the common case — `ExitLink` carries the way out with it.
 * `objectInApp` even for hosted kinds: the web page IS the host, so the
 * sub-action must name the app.
 */
export function OpenInAppLink({
  type,
  id,
  params,
}: {
  type: string;
  id: string;
  /** Address parameters the app needs to find it (a run's `flowType`). */
  params?: Record<string, string>;
}) {
  return (
    <ExitLink
      exit={openIn({ kind: "objectInApp", objectKind: type, id, params })}
      label="Open in app"
    />
  );
}
