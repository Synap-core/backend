"use client";

/**
 * `/open/automation/:id` — one rule, hosted on the web (D6), in the receiver
 * card. The page itself is `AutomationObject`, shared with the console's
 * `/rules/[id]`; this file is only the receiver frame around it.
 */

import { AutomationObject } from "../../_lib/object/views/automation-object";
import type { ObjectFrame } from "../../_lib/object/views/object-frame";
import { OpenFailure, OpenLoading, OpenObject } from "../open-shell";

const OPEN_FRAME: ObjectFrame = {
  loading: (label) => <OpenLoading label={label} />,
  failure: ({ kind, id, failure }) => (
    <OpenFailure kind={kind} id={id} failure={failure} />
  ),
  object: (props) => <OpenObject {...props} />,
};

export function AutomationView({ id }: { id: string }) {
  return <AutomationObject id={id} frame={OPEN_FRAME} />;
}
