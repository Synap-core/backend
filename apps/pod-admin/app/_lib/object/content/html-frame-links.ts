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
  parseFrameOpen,
  resolveFrameLink,
  type FrameExternalLink,
  type FrameLinkAction,
} from "@synap-core/types/cell-bridge";
import { publicPodUrl } from "../../../../lib/public-pod-url";
import { objectPage } from "./markdown-model";

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
  /**
   * Another site: ask the reader first, showing `link.host`, and open
   * `link.href` (origin and path only) in a new tab only on their yes
   * (security review H2: a page that read the viewer's data must not carry
   * it out through a link). The console's own confirmation, never the page's.
   */
  confirmExternal: (link: FrameExternalLink) => void;
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
  else if (action.action === "external")
    env.confirmExternal({ href: action.href, host: action.host });
  return action;
}

/**
 * The "open this" intent (`window.synap.open(kind, id)`, `parseFrameOpen`):
 * the object's console page (`objectPage`, the one door content links use),
 * in the reader's own tab. Like a console link, it never opens while the
 * browser says the reader did not act. Null when it is not an open message
 * from THIS frame, or when the console has no page for it.
 */
export function handleFrameOpen(
  event: { source: unknown; data: unknown },
  frameWindow: unknown,
  env: FrameLinkEnv
): FrameLinkAction | null {
  if (!frameWindow || event.source !== frameWindow) return null;
  const open = parseFrameOpen(event.data);
  if (!open) return null;
  const href = objectPage(open.surface.objectKind, open.surface.objectId);
  if (!href) return null;
  if (env.activated() === false) {
    return { action: "ignore", reason: "not-activated" };
  }
  env.here(href);
  return { action: "here", href };
}

type UserActivation = { isActive: boolean };

/**
 * The browser's own environment for `handleFrameLink`. `confirmExternal` is
 * the host's question to the reader (`useFrameLinkDoor` shows it); its yes
 * calls `env.newTab`, a click of its own, so the browser lets the tab open.
 */
export function browserFrameLinkEnv(
  confirmExternal: (link: FrameExternalLink) => void
): FrameLinkEnv {
  return {
    confirmExternal,
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
