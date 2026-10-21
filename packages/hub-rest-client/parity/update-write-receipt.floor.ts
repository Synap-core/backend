/**
 * COMPILE FLOOR — `HubEntityUpdateReceipt` (this zero-dependency package's
 * mirror) must stay EQUAL to the pod's `UpdateWriteReceipt`
 * (`api/src/routers/hub-protocol/update-write-receipt.ts`, a pure module with
 * no imports). The client typed the applied update answer as `HubEntity` and a
 * consumer printed `Updated entity "undefined"` (decision C5); a receipt field
 * added on one side and not the other now stops the build.
 *
 * Two checks, as in space-brief.floor.ts: mutual assignability catches a type
 * change, keyof equality catches an optional key present on one side only.
 */
import type { UpdateWriteReceipt } from "../../api/src/routers/hub-protocol/update-write-receipt.js";
import type { HubEntityUpdateReceipt } from "../src/types.js";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

export const _receipt: Same<HubEntityUpdateReceipt, UpdateWriteReceipt> = true;
export const _receiptKeys: Same<
  keyof HubEntityUpdateReceipt,
  keyof UpdateWriteReceipt
> = true;
