/**
 * The chevron of an object page's disclosure (Advanced, More fields, the
 * danger zone): it points to the side while the section is closed and down
 * once open. HeroUI's own points LEFT while closed (finding 47ff4216), which
 * reads as "back"; this replaces it on every object-page accordion.
 */

import { ChevronRight } from "lucide-react";

/** Spread on an `AccordionItem`: › closed, ⌄ open. */
export const DISCLOSURE_INDICATOR_PROPS = {
  indicator: <ChevronRight aria-hidden size={14} />,
  classNames: {
    indicator:
      "rotate-0 data-[open=true]:rotate-90 rtl:rotate-180 rtl:data-[open=true]:rotate-90",
  },
} as const;
