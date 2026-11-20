/**
 * Approvals › Calibration, as catalogs (`@synap-core/types/i18n`): English is
 * the source and the type. What happened ("Created notes") comes from the
 * vocabulary in the viewer's locale, never from here. DRAFT French ("vous"),
 * awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  title: "Calibration",
  description:
    "What agents did that an approval could change: writes no request covered, requests you keep refusing, the same request waiting twice, and what ran without asking.",
  back: "Approvals",
  "kind.label": "Pattern",
  "kind.ungoverned": "Ran with no request",
  "kind.rejected": "Keeps getting refused",
  "kind.repeats": "Asked more than once",
  "kind.auto": "Ran without asking",
  "hint.ungoverned":
    "Writes an agent ran that no request or approval covered. Make it ask first to see the next one before it lands.",
  "hint.rejected":
    "Requests you refused twice or more. An approval cannot stop an agent from asking; mark them expected to stop seeing them here.",
  "hint.repeats":
    "The same change waiting more than once. An approval decides the next write, so review the copies together.",
  "hint.auto":
    "Writes that ran on their own. Open the approval that let them, or make the agent ask first.",
  "list.failed": "Couldn’t load this pattern.",
  "list.empty.ungoverned": "Every agent write went through a request.",
  "list.empty.rejected": "No request was refused twice.",
  "list.empty.repeats": "No change is waiting twice.",
  "list.empty.auto": "Nothing ran without asking lately.",
  "list.more": "Show {count} more",
  allClear: "All clear: nothing here calls for a new approval.",
  "row.agents": "{count, plural, one {# agent} other {# agents}}",
  "row.unknownAgent": "An agent",
  "row.ranOnItsOwn": "Ran without asking",
  "row.times": "{count, plural, one {Once} other {# times}}",
  "row.last": "last {when}",
  "row.request": "Request {n}",
  "row.object": "{noun} {n}",
  "act.askFirst": "Make it ask first",
  "act.askFirst.aria": "Make {who} ask first before: {what}",
  "act.askFirst.done": "{who} now asks you first",
  "act.askFirst.open": "Open the approval",
  "act.askFirst.failed": "Couldn’t add the approval",
  "act.approval": "Its approval",
  "act.markExpected": "Mark expected",
  "act.markExpected.done": "Marked expected: it no longer shows here",
  "act.markExpected.failed": "Couldn’t mark it expected",
  "act.reviewTogether": "Review together",
  "muted.title": "Marked expected",
  "muted.unknown": "A refused request",
  "muted.undo": "Show again",
  "muted.undo.done": "It shows again when it is refused",
  "muted.failed": "Couldn’t read what was marked expected.",
  "muted.retry": "Try again",
} as const;

export const fr: Catalog<typeof en> = {
  title: "Calibrage",
  description:
    "Ce que les agents ont fait et qu’une approbation pourrait changer : des écritures qu’aucune demande ne couvrait, des demandes que vous refusez sans cesse, la même demande en attente deux fois, et ce qui s’est exécuté sans demander.",
  back: "Approbations",
  "kind.label": "Motif",
  "kind.ungoverned": "Exécuté sans demande",
  "kind.rejected": "Toujours refusé",
  "kind.repeats": "Demandé plus d’une fois",
  "kind.auto": "Exécuté sans demander",
  "hint.ungoverned":
    "Des écritures qu’un agent a exécutées sans demande ni approbation. Faites-le demander d’abord pour voir la prochaine avant qu’elle ne s’applique.",
  "hint.rejected":
    "Des demandes refusées deux fois ou plus. Une approbation n’empêche pas un agent de demander ; marquez-les attendues pour ne plus les voir ici.",
  "hint.repeats":
    "La même modification en attente plus d’une fois. Une approbation décide de la prochaine écriture : examinez les copies ensemble.",
  "hint.auto":
    "Des écritures exécutées seules. Ouvrez l’approbation qui les a permises, ou faites demander l’agent d’abord.",
  "list.failed": "Impossible de charger ce motif.",
  "list.empty.ungoverned":
    "Toutes les écritures d’agents sont passées par une demande.",
  "list.empty.rejected": "Aucune demande n’a été refusée deux fois.",
  "list.empty.repeats": "Aucune modification n’attend deux fois.",
  "list.empty.auto": "Rien ne s’est exécuté sans demander récemment.",
  "list.more": "Afficher {count} de plus",
  allClear: "Tout va bien : rien ici n’appelle une nouvelle approbation.",
  "row.agents": "{count, plural, one {# agent} other {# agents}}",
  "row.unknownAgent": "Un agent",
  "row.ranOnItsOwn": "Exécuté sans demander",
  "row.times": "{count, plural, one {Une fois} other {# fois}}",
  "row.last": "dernière {when}",
  "row.request": "Demande {n}",
  "row.object": "{noun} {n}",
  "act.askFirst": "Faire demander d’abord",
  "act.askFirst.aria": "Faire demander {who} d’abord avant : {what}",
  "act.askFirst.done": "{who} vous demande désormais d’abord",
  "act.askFirst.open": "Ouvrir l’approbation",
  "act.askFirst.failed": "Impossible d’ajouter l’approbation",
  "act.approval": "Son approbation",
  "act.markExpected": "Marquer attendu",
  "act.markExpected.done": "Marqué attendu : il n’apparaît plus ici",
  "act.markExpected.failed": "Impossible de le marquer attendu",
  "act.reviewTogether": "Examiner ensemble",
  "muted.title": "Marqués attendus",
  "muted.unknown": "Une demande refusée",
  "muted.undo": "Afficher à nouveau",
  "muted.undo.done": "Il réapparaît quand il est refusé",
  "muted.failed": "Impossible de lire ce qui a été marqué attendu.",
  "muted.retry": "Réessayer",
};
