/**
 * Per-person limits on the Library's reader doors — a leaf, so the tRPC
 * router and the Hub REST route share each budget (and a test can stub the
 * reader service without losing them).
 */

import type { UserRateLimit } from "../../middleware/ai-rate-limit.js";

/**
 * Per-person limits on the reader doors (tRPC and Hub REST share each one).
 * Generous: a person tapping never meets them; a loop does — a `builtin`
 * readWith over hundreds of ids fans out outbound fetches from the pod's
 * address, a retryMedia tap may download a 1 GiB video, a group fold reads
 * up to `LIBRARY_READERS_SCAN_MAX` items.
 */
export const LIBRARY_READER_DOOR_LIMITS = {
  readers: { name: "library.readers", max: 120, windowMs: 60_000 },
  readWith: { name: "library.readWith", max: 20, windowMs: 60_000 },
  retryMedia: { name: "library.retryMedia", max: 30, windowMs: 60_000 },
} as const satisfies Record<string, UserRateLimit>;
