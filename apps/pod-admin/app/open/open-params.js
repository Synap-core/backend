"use strict";
/**
 * `/open/:type/:id` param parser — keeps the page dumb.
 *
 * Host types (`entity`, `view`) are the only ones this surface fetches.
 * Bounce kinds match the Hono `/open/:type/:id` ALLOWED set minus host
 * types: we never render them here, we point at `synap://open/{type}/{id}`.
 *
 * HOST_TYPES ∪ BOUNCE_TYPES MUST equal TYPED_OPEN_KINDS in
 * apps/api/src/open-dispatch.ts (enforced by open-kinds.lock.test.ts).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BOUNCE_TYPES = exports.HOST_TYPES = void 0;
exports.isUuid = isUuid;
exports.isSafeOpenId = isSafeOpenId;
exports.parseOpenParams = parseOpenParams;
exports.openDocumentTitle = openDocumentTitle;
exports.labelForOpenType = labelForOpenType;
exports.openInAppHref = openInAppHref;
exports.HOST_TYPES = ["entity", "view"];
/** Known `synap://` bounce kinds that are not hosted on this page. */
exports.BOUNCE_TYPES = [
    "proposal",
    "document",
    "cell",
    "channel",
    "session",
    "project",
    "workspace",
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Same allowlist Hono uses for `/open/:type/:id` interpolation. */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function isUuid(value) {
    return UUID_RE.test(value);
}
function isSafeOpenId(value) {
    return SAFE_ID_RE.test(value);
}
function isHostType(type) {
    return exports.HOST_TYPES.includes(type);
}
function isBounceType(type) {
    return exports.BOUNCE_TYPES.includes(type);
}
function parseOpenParams(type, id) {
    const kind = type.trim().toLowerCase();
    const rawId = id.trim();
    if (isHostType(kind)) {
        if (!isUuid(rawId))
            return { status: "invalid-id", type: kind, id: rawId };
        return { status: "host", type: kind, id: rawId };
    }
    if (isBounceType(kind)) {
        if (!isSafeOpenId(rawId)) {
            return { status: "invalid-id", type: kind, id: rawId };
        }
        return { status: "bounce", type: kind, id: rawId };
    }
    return { status: "not-found", type: kind || type, id: rawId };
}
function openDocumentTitle(parsed) {
    switch (parsed.status) {
        case "host":
            return parsed.type === "entity" ? "Entity" : "View";
        case "bounce":
            return labelForOpenType(parsed.type);
        case "invalid-id":
            return "Invalid link";
        case "not-found":
            return "Not found";
    }
}
function labelForOpenType(type) {
    if (!type)
        return "Object";
    return type.charAt(0).toUpperCase() + type.slice(1);
}
function openInAppHref(type, id) {
    return `synap://open/${type}/${id}`;
}
//# sourceMappingURL=open-params.js.map