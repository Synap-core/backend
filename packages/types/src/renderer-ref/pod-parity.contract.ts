/**
 * Compile-time contract: the pod's `RendererRef` / `DeclarativeBlock`
 * (`@synap/database` `services/profile-resolution-service.ts`) are EXACTLY
 * this package's. No runtime code.
 *
 * The pod keeps its own declaration because it cannot import this package;
 * this file is what makes that second copy safe. Add a kind or a field on one
 * side only and `tsc` here fails.
 */
import type {
  DeclarativeBlock as PodDeclarativeBlock,
  RendererRef as PodRendererRef,
} from "@synap/database";
import type { DeclarativeBlock, RendererRef } from "./index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

export const _rendererRef: Equal<PodRendererRef, RendererRef> = true;
export const _declarativeBlock: Equal<PodDeclarativeBlock, DeclarativeBlock> =
  true;
