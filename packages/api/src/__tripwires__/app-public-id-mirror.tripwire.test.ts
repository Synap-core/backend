/**
 * Tripwire: the app `public_id` prefix has ONE rule in two places.
 *
 * `@synap-core/types/membrane` owns `isAppPublicId` (the browser, relay and
 * the key-identity door read it). `@synap/database` mints public ids with its
 * own `APP_PUBLIC_ID_PREFIX`, because it cannot import `@synap-core/types`
 * (types → dev @synap/database is a build cycle). If the two drifted, a
 * freshly minted app's grant would stop being recognised as an app's — its
 * legacy key would skip adoption and its writes would lose "via <app>".
 */
import { describe, expect, it } from "vitest";
import { APP_PUBLIC_ID_PREFIX as MINTED } from "@synap/database";
import {
  APP_PUBLIC_ID_PREFIX as READ,
  isAppPublicId,
} from "@synap-core/types/membrane";

describe("app public id — the mint and the reader agree", () => {
  it("one prefix, and a minted-shape id is recognised as an app's", () => {
    expect(MINTED).toBe(READ);
    expect(isAppPublicId(`${MINTED}1e1e1e1e-0000-4000-8000-0000000000aa`)).toBe(
      true
    );
  });
});
