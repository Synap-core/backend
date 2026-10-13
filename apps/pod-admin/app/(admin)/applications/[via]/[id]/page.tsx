"use client";

/**
 * `/applications/<via>/<id>` — one app, whichever way it connects. The model
 * is the first segment (`appHref`), so a key app's `app_…` id, a sign-in
 * connection's uuid and a Claude/MCP `dcr_…` client id each reach their own
 * door. The route supplies the console frame (crumb back to Apps); each body
 * reads its own pod-admin door and composes the shared object page.
 */

import { useParams } from "next/navigation";
import { navHref, navLabel } from "../../../../../lib/console-nav";
import { consoleFrame } from "../../../../_lib/object/views/object-frame";
import { parseVia } from "../../_lib/app-inventory";
import { appFailure } from "../../_lib/app-object-parts";
import { KeyAppObject } from "../../_lib/key-app-object";
import { McpAppObject } from "../../_lib/mcp-app-object";
import { SignInAppObject } from "../../_lib/sign-in-app-object";

const FRAME = consoleFrame({
  label: navLabel("apps"),
  href: navHref("apps"),
});

export default function AppPage() {
  const params = useParams<{ via: string; id: string }>();
  const { id } = params;
  switch (parseVia(params.via)) {
    case "key":
      return <KeyAppObject publicId={id} frame={FRAME} />;
    case "sign-in":
      return <SignInAppObject id={id} frame={FRAME} />;
    case "mcp":
      return <McpAppObject clientId={id} frame={FRAME} />;
    default:
      // An unknown model is a stale link, read as "not found".
      return appFailure(FRAME, { data: { code: "NOT_FOUND" } });
  }
}
