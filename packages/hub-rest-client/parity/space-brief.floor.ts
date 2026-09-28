/**
 * COMPILE FLOOR — `HubSpaceBrief` (this zero-dependency package's mirror) must
 * stay EQUAL to the canonical `SpaceBrief` (`@synap-core/types/space-brief`).
 *
 * Why a mirror at all: this package publishes with zero runtime dependencies
 * and its consumers (IS, CLI, CP) install it from npm, so it cannot import
 * `@synap-core/types`. Why this file is outside `src/`: `src` is the package's
 * `rootDir`, and a relative import of another package's source is refused
 * there (TS6059). Run by `pnpm typecheck` (tsconfig.parity.json).
 *
 * Two checks, because each alone has a hole (recorded in the brief door's
 * floor, space-brief-door.ts): mutual ASSIGNABILITY catches a type change,
 * but not an optional key present on one side only; KEYOF equality catches
 * that. Both are applied to every nested shape.
 */
import type {
  SpaceBrief,
  SpaceBriefAnchor,
  SpaceBriefCollectTarget,
  SpaceBriefExpertise,
  SpaceBriefFetchHint,
  SpaceBriefRuleRef,
} from "../../types/src/space-brief/index.js";
import type {
  HubSpaceBrief,
  HubSpaceBriefAnchor,
  HubSpaceBriefCollectTarget,
  HubSpaceBriefExpertise,
  HubSpaceBriefFetchHint,
  HubSpaceBriefRuleRef,
} from "../src/types.js";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

export const _brief: Same<HubSpaceBrief, SpaceBrief> = true;
export const _briefKeys: Same<keyof HubSpaceBrief, keyof SpaceBrief> = true;
export const _collect: Same<HubSpaceBriefCollectTarget, SpaceBriefCollectTarget> = true;
export const _collectKeys: Same<
  keyof HubSpaceBriefCollectTarget,
  keyof SpaceBriefCollectTarget
> = true;
export const _expertise: Same<HubSpaceBriefExpertise, SpaceBriefExpertise> = true;
export const _expertiseKeys: Same<
  keyof HubSpaceBriefExpertise,
  keyof SpaceBriefExpertise
> = true;
export const _anchor: Same<HubSpaceBriefAnchor, SpaceBriefAnchor> = true;
export const _anchorKeys: Same<keyof HubSpaceBriefAnchor, keyof SpaceBriefAnchor> = true;
export const _fetch: Same<HubSpaceBriefFetchHint, SpaceBriefFetchHint> = true;
export const _fetchKeys: Same<keyof HubSpaceBriefFetchHint, keyof SpaceBriefFetchHint> = true;
export const _rule: Same<HubSpaceBriefRuleRef, SpaceBriefRuleRef> = true;
export const _ruleKeys: Same<keyof HubSpaceBriefRuleRef, keyof SpaceBriefRuleRef> = true;
