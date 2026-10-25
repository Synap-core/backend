/**
 * Compile-time contract: the pod's `RendererRef` / `DeclarativeBlock`
 * (`services/profile-resolution-service.ts`) are EXACTLY
 * `@synap-core/types/renderer-ref`'s. No runtime code. Add a kind or a field on
 * one side only and `tsc` here fails.
 */
import type {
  DeclarativeBlock,
  RendererRef,
} from "@synap-core/types/renderer-ref";
import type {
  DeclarativeBlock as PodDeclarativeBlock,
  RendererRef as PodRendererRef,
} from "../services/profile-resolution-service.js";
import type { Equal } from "./equal.js";

export const _rendererRef: Equal<PodRendererRef, RendererRef> = true;
export const _declarativeBlock: Equal<PodDeclarativeBlock, DeclarativeBlock> =
  true;
