/**
 * The link door: how a framed page hands a clicked link to its host.
 *
 * Why it exists. A stored page runs in `<iframe sandbox="allow-scripts"
 * srcdoc>` (`CELL_FRAME_SANDBOX`). A plain `<a href>` in it (no `target`)
 * navigates the FRAME, not the reader's tab: pod admin's own login then loads
 * inside the sandbox, an opaque-origin frame that carries no session, and the
 * report that was meant to open an object shows a login page. The sandbox
 * cannot be loosened (`allow-top-navigation*` and `allow-popups` would let the
 * page take the tab), so the frame hands the click UP and the host decides.
 *
 *   frame → host   `synap:navigate`  { href, newTab }   (a click, nothing else)
 *   host           `resolveFrameLink` → here | new tab | ignore
 *
 * OPT-IN. The door is injected only when a host asks (the `links` option of
 * `wrapHtmlForFrame`): a host that does not handle `synap:navigate` (the
 * desktop, relay) keeps today's frame byte for byte, so its links never die
 * silently.
 *
 * What it does NOT cover (so nobody reads more into it): a page that sets
 * `location` from its own script, or submits a form (`form-action 'none'`
 * already refuses that), is not a click on a link and is not intercepted.
 */

export const FRAME_NAVIGATE_TYPE = "synap:navigate" as const;

/** Frame → host: the reader clicked a link in the page. */
export interface FrameNavigateMessage {
  type: typeof FRAME_NAVIGATE_TYPE;
  /** Absolute, http(s), no credentials, normalised. */
  href: string;
  /** The click asked for a new tab (middle button, a modifier, `target`). */
  newTab: boolean;
}

const MAX_HREF_LENGTH = 2048;

/**
 * A link message, validated, or null. A frame is stored code the host does not
 * trust: anything but an absolute http(s) address without credentials is
 * dropped, whatever it claims to be.
 */
export function parseFrameNavigate(data: unknown): FrameNavigateMessage | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const msg = data as Record<string, unknown>;
  if (msg.type !== FRAME_NAVIGATE_TYPE) return null;
  const { href } = msg;
  if (
    typeof href !== "string" ||
    href.length === 0 ||
    href.length > MAX_HREF_LENGTH
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // `https://pod.example@evil.example/` reads as the pod and goes elsewhere.
  if (url.username || url.password) return null;
  return {
    type: FRAME_NAVIGATE_TYPE,
    href: url.href,
    newTab: msg.newTab === true,
  };
}

/** What the host does with a clicked link. */
export type FrameLinkAction =
  /** The reader's own tab: the console draws this. */
  | { action: "here"; href: string }
  /** A new tab, opened with `noopener`: the console's tab is not replaced. */
  | { action: "newTab"; href: string }
  | { action: "ignore"; reason: "not-activated" };

/**
 * Where a link goes. Pure: the host supplies what it knows.
 *
 *   - `ownOrigins`: the origins the console itself serves (its own, the pod's).
 *     Compared by EXACT origin: `pod.example.evil.example`, another port and
 *     `http:` for `https:` are all someone else.
 *   - `activated`: whether the reader acted a moment ago
 *     (`navigator.userActivation.isActive`); `null` when the browser cannot
 *     say. A page's script can post this message with no click at all, so
 *     without an activation nothing opens, except that an unknown activation
 *     still lets the reader's own tab follow a console link (a page can send a
 *     reader only to the console, never away from it).
 *
 * The reader's own tab only ever goes to an object door on the console
 * (`/open/…`). Everything else, even on the pod's origin, is a new tab.
 */
export function resolveFrameLink(
  nav: FrameNavigateMessage,
  env: { ownOrigins: readonly string[]; activated: boolean | null }
): FrameLinkAction {
  if (env.activated === false)
    return { action: "ignore", reason: "not-activated" };
  const url = new URL(nav.href);
  const consoleDoor =
    env.ownOrigins.includes(url.origin) &&
    (url.pathname === "/open" || url.pathname.startsWith("/open/"));
  if (consoleDoor && !nav.newTab) return { action: "here", href: url.href };
  if (env.activated === null)
    return { action: "ignore", reason: "not-activated" };
  return { action: "newTab", href: url.href };
}

/**
 * The in-frame half, as a script string injected after the SDK. It catches a
 * click (and a middle click) on a link, lets an in-page `#anchor` jump stay in
 * the page, and for an http(s) link cancels the frame's own navigation and
 * posts `synap:navigate` to the parent. Anything that is not http(s)
 * (`javascript:`, `mailto:`, `data:`) is left exactly as it was.
 *
 * Plain ES2015 in a string, like the SDK. It never contains a closing script
 * tag (a test pins that).
 */
export const CELL_FRAME_LINK_DOOR = `(function () {
  "use strict";
  if (window.__synapLinkDoor) return;
  window.__synapLinkDoor = true;
  var parentWindow = window.parent;
  function onLink(event) {
    if (event.defaultPrevented) return;
    var node = event.target;
    var anchor = node && node.closest ? node.closest("a[href]") : null;
    if (!anchor) return;
    var raw = anchor.getAttribute("href") || "";
    if (raw.charAt(0) === "#") return;
    var href = anchor.href;
    if (href && typeof href === "object" && "baseVal" in href) {
      try {
        href = new URL(href.baseVal, document.baseURI).href;
      } catch (err) {
        return;
      }
    }
    if (typeof href !== "string" || !/^https?:/i.test(href)) return;
    event.preventDefault();
    var newTab =
      event.type === "auxclick" ||
      event.button === 1 ||
      !!(event.ctrlKey || event.metaKey || event.shiftKey) ||
      anchor.getAttribute("target") === "_blank";
    try {
      parentWindow.postMessage(
        { type: "${FRAME_NAVIGATE_TYPE}", href: href, newTab: newTab },
        "*"
      );
    } catch (err) {}
  }
  document.addEventListener("click", onLink, true);
  document.addEventListener("auxclick", onLink, true);
})();`;
