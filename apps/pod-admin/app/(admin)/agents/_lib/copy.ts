/**
 * Agents' header words (a client place, audit a48761f2 PA-G-06), as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. The title
 * is the vocabulary's plural; the roster below keeps its English words for
 * now. DRAFT French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  description:
    "Every AI that works with you, how it is doing, and who answers for it.",
  "waiting":
    "{n, plural, one {# agent is waiting for your approval} other {# agents are waiting for your approval}}",
  "wakesFailed":
    "Couldn't load whether these agents can be woken.",
  "connected.title":
    "Connected agents",
  "connected.hint":
    "Agents people brought to this pod",
  "connected.failed":
    "Couldn't load agents.",
  "own.title":
    "The pod's own agents",
  "own.hint":
    "The twin, capture agents and Intelligence personas",
} as const;

export const fr: Catalog<typeof en> = {
  description:
    "Chaque IA qui travaille avec vous, comment elle se porte, et qui en répond.",
  "waiting":
    "{n, plural, one {# agent attend votre approbation} other {# agents attendent votre approbation}}",
  "wakesFailed":
    "Impossible de savoir si ces agents peuvent être réveillés.",
  "connected.title":
    "Agents connectés",
  "connected.hint":
    "Les agents que des personnes ont apportés à ce pod",
  "connected.failed":
    "Impossible de charger les agents.",
  "own.title":
    "Les agents du pod",
  "own.hint":
    "Le jumeau, les agents de capture et les personas d’Intelligence",
};
