import { redirect } from "next/navigation";
import { navHref } from "../../../../lib/console-nav";

/**
 * `/marketplace/updates` with no package: the list is Marketplace's Updates
 * tab. Without this page the address would reach `[slug]` and read
 * "updates" as a catalog entry.
 */
export default function PackageUpdatesIndex() {
  redirect(navHref("marketplace", { tab: "updates" }));
}
