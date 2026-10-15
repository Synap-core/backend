/**
 * The ≥lg sidebar's collapse choice, remembered per browser.
 *
 * The choice is applied as an attribute on `<html>` by an inline script that
 * runs before the nav paints (`app/layout.tsx`), and the sidebar's widths
 * key off it in CSS (the `nav-collapsed:` Tailwind variant). React state only
 * follows it for aria and tooltips, so a collapsed nav never paints wide and
 * then snaps shut on hydration.
 */

export const NAV_COLLAPSED_KEY = "pod-console.nav-collapsed";
export const NAV_COLLAPSED_ATTR = "data-nav-collapsed";

/** Inline, pre-paint. Storage can be absent or throw: the nav then starts wide. */
export function navCollapsedScript(): string {
  const key = JSON.stringify(NAV_COLLAPSED_KEY);
  const attr = JSON.stringify(NAV_COLLAPSED_ATTR);
  return `try{if(localStorage.getItem(${key})==="1")document.documentElement.setAttribute(${attr},"")}catch(e){}`;
}
