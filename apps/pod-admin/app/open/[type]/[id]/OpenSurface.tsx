"use client";

/**
 * `/open/:type/:id` — route a parsed link to its page.
 *
 * Hosted kinds (`HOST_TYPES`) render here through the shared object skin
 * (`app/_lib/object`), one file each under `../../_views/`. Every other known
 * kind is a BOUNCE: a card that names the object (from
 * `diagnose.resolveOpen`, the same user-floored resolver the desktop uses)
 * and hands it to the app. This file keeps only the parse outcome, the
 * identity frame and the routing.
 */

import { ConsoleRoleProvider } from "../../../(admin)/components/side-nav-role";
import { ReceiverIdentityProvider } from "../../../_lib/receiver-shell";
import { labelForOpenType, type ParsedOpen } from "../../open-params";
import { OpenMessage } from "../../open-shell";
import { AgentView } from "../../_views/agent-view";
import { AutomationView } from "../../_views/automation-view";
import { BounceView } from "../../_views/bounce-view";
import { CapabilityView } from "../../_views/capability-view";
import { ChannelView } from "../../_views/channel-view";
import { DocumentView } from "../../_views/document-view";
import { EntityView } from "../../_views/entity-view";
import { PlaybookView } from "../../_views/playbook-view";
import { RunView } from "../../_views/run-view";
import { SessionView } from "../../_views/session-view";
import { ViewView } from "../../_views/view-view";

interface SurfaceProps {
  parsed: ParsedOpen;
  /** `?flowType=` off the link — a run's address. Validated by the run page. */
  flowType?: string;
  /** Shapes what is OFFERED (a space's console page, pod-wide verbs); never a gate. */
  viewerIsPodAdmin: boolean;
}

/**
 * The role is provided too, so every exit on the page offers a phone only the
 * console pages this viewer may open (`usePlacedExit`).
 */
export function OpenSurface({
  podHost,
  identity,
  ...props
}: SurfaceProps & { podHost?: string; identity?: string }) {
  return (
    <ReceiverIdentityProvider podHost={podHost} identity={identity}>
      <ConsoleRoleProvider role={props.viewerIsPodAdmin ? "admin" : "member"}>
        <OpenSurfaceBody {...props} />
      </ConsoleRoleProvider>
    </ReceiverIdentityProvider>
  );
}

function OpenSurfaceBody({ parsed, flowType, viewerIsPodAdmin }: SurfaceProps) {
  switch (parsed.status) {
    case "invalid-id":
      return (
        <OpenMessage
          kind={parsed.type}
          title="This link isn’t valid"
          message={`The address doesn’t look like a Synap ${labelForOpenType(parsed.type).toLowerCase()}. Check the link and try again.`}
          chip="Invalid link"
        />
      );
    case "not-found":
      return (
        <OpenMessage
          kind="open"
          title="Nothing here"
          message="This address isn’t a Synap object this page can open."
          chip="Not found"
        />
      );
    case "bounce":
      return (
        <BounceView
          type={parsed.type}
          id={parsed.id}
          viewerIsPodAdmin={viewerIsPodAdmin}
        />
      );
    case "host":
      switch (parsed.type) {
        case "entity":
          return <EntityView id={parsed.id} />;
        case "view":
          return <ViewView id={parsed.id} />;
        case "automation":
          return <AutomationView id={parsed.id} />;
        case "session":
          return <SessionView id={parsed.id} />;
        case "playbook":
          return (
            <PlaybookView id={parsed.id} viewerIsPodAdmin={viewerIsPodAdmin} />
          );
        case "run":
          return <RunView id={parsed.id} flowType={flowType} />;
        case "capability":
          return (
            <CapabilityView
              id={parsed.id}
              viewerIsPodAdmin={viewerIsPodAdmin}
            />
          );
        case "agent":
          return (
            <AgentView id={parsed.id} viewerIsPodAdmin={viewerIsPodAdmin} />
          );
        case "document":
          return <DocumentView id={parsed.id} />;
        case "channel":
          return <ChannelView id={parsed.id} />;
      }
  }
}
