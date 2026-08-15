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
export declare const HOST_TYPES: readonly ["entity", "view"];
export type HostType = (typeof HOST_TYPES)[number];
/** Known `synap://` bounce kinds that are not hosted on this page. */
export declare const BOUNCE_TYPES: readonly [
  "proposal",
  "document",
  "cell",
  "channel",
  "session",
  "project",
  "workspace",
];
export type BounceType = (typeof BOUNCE_TYPES)[number];
export type KnownOpenType = HostType | BounceType;
export type ParsedOpen =
  | {
      status: "host";
      type: HostType;
      id: string;
    }
  | {
      status: "bounce";
      type: KnownOpenType;
      id: string;
    }
  | {
      status: "invalid-id";
      type: KnownOpenType;
      id: string;
    }
  | {
      status: "not-found";
      type: string;
      id: string;
    };
export declare function isUuid(value: string): boolean;
export declare function isSafeOpenId(value: string): boolean;
export declare function parseOpenParams(type: string, id: string): ParsedOpen;
export declare function openDocumentTitle(parsed: ParsedOpen): string;
export declare function labelForOpenType(type: string): string;
export declare function openInAppHref(type: string, id: string): string;
//# sourceMappingURL=open-params.d.ts.map
