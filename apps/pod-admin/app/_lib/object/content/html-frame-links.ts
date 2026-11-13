/**
 * The host half of the link door: a stored page runs in a script-only sandbox,
 * so a clicked link cannot be allowed to navigate the frame (it would load pod
 * admin inside it). The frame posts `synap:navigate`; this decides what the
 * reader's browser then does, through the shared policy
 * (`resolveFrameLink`, `@synap-core/types/cell-bridge`).
 *
 * Pure of React and of `window`: the page-level `HtmlFrame` passes it the
 * browser's own `FrameLinkEnv`, tests pass fakes.
 */

import {
  parseFrameNavigate,
  resolveFrameLink,
  type FrameLinkAction,
} from "@synap-core/types/cell-bridge";
import { publicPodUrl } from "../../../../lib/public-pod-url";

/** What the host knows and can do; the browser's own is `browserFrameLinkEnv`. */
export interface FrameLinkEnv {
  /** The origins this console serves: its own and the pod's. */
  ownOrigins: () => readonly string[];
  /** Whether the reader acted a moment ago; `null` when the browser cannot say. */
  activated: () => boolean | null;
  /** The reader's own tab. */
  here: (href: string) => void;
  /** A new tab, opened `noopener`. */
  newTab: (href: string) => void;
}

/**
 * One window message → what was done with it, or null when it is not a link
 * message from THIS frame. Only a message whose source is the frame's own
 * window counts: another window, an extension or the page's own `postMessage`
 * to itself is not the frame asking.
 */
export function handleFrameLink(
  event: { source: unknown; data: unknown },
  frameWindow: unknown,
  env: FrameLinkEnv
): FrameLinkAction | null {
  if (!frameWindow || event.source !== frameWindow) return null;
  const nav = parseFrameNavigate(event.data);
  if (!nav) return null;
  const action = resolveFrameLink(nav, {
    ownOrigins: env.ownOrigins(),
    activated: env.activated(),
  });
  if (action.action === "here") env.here(action.href);
  else if (action.action === "newTab") env.newTab(action.href);
  return action;
}

type UserActivation = { isActive: boolean };

/** The browser's own environment for `handleFrameLink`. */
export function browserFrameLinkEnv(): FrameLinkEnv {
  return {
    ownOrigins: () => {
      const origins = [window.location.origin];
      try {
        // Unset or malformed in a console with no pod address: only its own
        // origin is then ours, which is the safe reading.
        origins.push(new URL(publicPodUrl()).origin);
      } catch {
        /* the console's own origin alone */
      }
      return origins;
    },
    activated: () => {
      const activation = (
        navigator as Navigator & { userActivation?: UserActivation }
      ).userActivation;
      return activation ? activation.isActive : null;
    },
    here: (href) => window.location.assign(href),
    newTab: (href) => {
      window.open(href, "_blank", "noopener,noreferrer");
    },
  };
}
