"use client";

import { ExitLink } from "../../../lib/exit-link";
import { openIn } from "../../../lib/open-in";
import { useConsoleRole } from "../../(admin)/components/side-nav-role";

/**
 * The desktop form of the object. A bare `synap://` does NOTHING when the app
 * is not installed, and these links arrive by email and CLI, so "not
 * installed" is the common case — `ExitLink` carries the way out with it.
 * `objectInApp` even for hosted kinds: the web page IS the host, so the
 * sub-action must name the app.
 *
 * Offered to a pod admin only: the desktop app is the operator's workbench and
 * not part of a client's offer (decision 7c832a88, 2026-10-30), so a member
 * is never sent to an app they do not have. The role is the page's
 * (`ConsoleRoleProvider`; outside one it is the member's).
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
  const role = useConsoleRole();
  if (role !== "admin") return null;
  return (
    <ExitLink
      exit={openIn({ kind: "objectInApp", objectKind: type, id, params })}
      label="Open in app"
    />
  );
}
