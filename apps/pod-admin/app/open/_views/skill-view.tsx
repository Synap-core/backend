"use client";

/**
 * `/open/skill/:id` — one skill in the receiver card, the page a Tools row
 * opens: on or off, its instructions or its runs. The body is `SkillObject`.
 */

import { SkillObject } from "../../_lib/object/views/skill-object";
import { OPEN_FRAME } from "../open-shell";

export function SkillView({ id }: { id: string }) {
  return <SkillObject id={id} frame={OPEN_FRAME} />;
}
