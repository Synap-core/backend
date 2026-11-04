/**
 * The Synap mark on a pod's own host (pod.<name>.synap.live, or a self-hosted domain).
 *
 * MCP clients and favicon services draw a connector with the icon of the
 * server's host. A pod answered /favicon.ico with 404 JSON, so a pod connector
 * fell back to whatever a cache held for its host. These routes serve the
 * current mark: the amber S (vector source synap-landing/public/brand/
 * synap-mark.svg, raster copies synap-landing/app/{favicon.ico,icon.png,
 * apple-icon.png}; the control plane serves the same, control-plane-api
 * src/routes/brand-icons.ts). The gradient is brand content: never recolour it.
 *
 * The pod's MCP server also names the mark in its `serverInfo.icons`
 * (SYNAP_MCP_ICONS below, routers/mcp/index.ts). The favicon and the vector
 * mark are served from the pod itself, so a pod with no internet still has
 * them; only the raster redirects and the MCP icon URLs point at the website.
 */
import { Hono } from "hono";

/** The public website, which hosts the raster sizes of the mark. */
export const SYNAP_WEBSITE_URL = "https://www.synap.live";

/** The amber S, as served at /favicon.svg and /icon.svg. */
export const SYNAP_MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 724 1584" width="724" height="1584">' +
  '<defs><radialGradient id="synap-mark-grad" cx="50%" cy="50%" r="100%" fx="68.2%" fy="59.1%">' +
  '<stop offset="0%" stop-color="#c35100"/><stop offset="20%" stop-color="#db6500"/>' +
  '<stop offset="40%" stop-color="#eb8105"/><stop offset="60%" stop-color="#fa9d09"/>' +
  '<stop offset="80%" stop-color="#fcbd16"/><stop offset="100%" stop-color="#ffdb23"/>' +
  "</radialGradient></defs>" +
  '<path d="M 723 0 L 671 17 L 609 41 L 521 81 L 433 128 L 354 178 L 324 199 L 270 241 L 239 268 L 207 299 L 186 322 L 161 354 L 149 372 L 133 403 L 126 421 L 119 449 L 116 473 L 116 495 L 120 525 L 126 548 L 134 570 L 147 597 L 157 614 L 176 641 L 210 680 L 240 709 L 268 733 L 310 765 L 337 783 L 341 787 L 341 792 L 103 1346 L 101 1348 L 60 1445 L 3 1573 L 0 1583 L 90 1548 L 94 1545 L 124 1533 L 183 1505 L 279 1455 L 377 1396 L 445 1348 L 475 1324 L 504 1298 L 521 1281 L 548 1249 L 569 1217 L 578 1199 L 590 1167 L 594 1150 L 597 1126 L 597 1095 L 594 1072 L 588 1046 L 581 1026 L 564 990 L 535 947 L 491 899 L 455 867 L 427 845 L 378 810 L 345 788 L 345 783 L 387 700 L 398 675 L 411 651 L 517 430 L 523 420 L 527 409 L 555 353 L 600 256 L 605 248 L 608 239 L 612 233 Z" fill="url(#synap-mark-grad)"/></svg>';

/** synap-landing/app/favicon.ico (16, 32 and 48 px), byte for byte. */
const FAVICON_ICO_BASE64 =
  "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";

const FAVICON_ICO = Buffer.from(FAVICON_ICO_BASE64, "base64");

/** The icons the pod MCP server advertises in `serverInfo.icons` (MCP 2025-11-25). */
export const SYNAP_MCP_ICONS = [
  {
    src: `${SYNAP_WEBSITE_URL}/icon.png`,
    mimeType: "image/png",
    sizes: ["512x512"],
  },
  {
    src: `${SYNAP_WEBSITE_URL}/brand/synap-mark.svg`,
    mimeType: "image/svg+xml",
    sizes: ["any"],
  },
];

/** A day in the browser, a week in shared caches: the mark rarely changes. */
const ICON_CACHE = "public, max-age=86400, s-maxage=604800";

export const brandIconsApp = new Hono();

brandIconsApp.get("/favicon.ico", (c) =>
  c.body(new Uint8Array(FAVICON_ICO), 200, {
    "Content-Type": "image/x-icon",
    "Cache-Control": ICON_CACHE,
  })
);

for (const path of ["/favicon.svg", "/icon.svg"]) {
  brandIconsApp.get(path, (c) =>
    c.body(SYNAP_MARK_SVG, 200, {
      "Content-Type": "image/svg+xml",
      "Cache-Control": ICON_CACHE,
      // An SVG opened as a document can run script; this one has none, and
      // the policy keeps it that way.
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'",
    })
  );
}

// The raster sizes live on the website; a permanent redirect keeps one copy.
brandIconsApp.get("/icon.png", (c) =>
  c.redirect(`${SYNAP_WEBSITE_URL}/icon.png`, 301)
);
for (const path of [
  "/apple-touch-icon.png",
  "/apple-touch-icon-precomposed.png",
]) {
  brandIconsApp.get(path, (c) =>
    c.redirect(`${SYNAP_WEBSITE_URL}/apple-icon.png`, 301)
  );
}
