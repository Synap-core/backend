/**
 * Entity Type Guards
 *
 * Type guard functions for narrowing entity types.
 */

import type { Entity, Task, Note, Person, Event, File } from "./types.js";

/**
 * Type guard for Task entities
 */
export function isTask(entity: Entity): entity is Task {
  return entity.type === "task";
}

/**
 * Type guard for Note entities
 */
export function isNote(entity: Entity): entity is Note {
  return entity.type === "note";
}

/**
 * Type guard for Person entities
 */
export function isPerson(entity: Entity): entity is Person {
  return entity.type === "person";
}

/**
 * Type guard for Event entities
 */
export function isEvent(entity: Entity): entity is Event {
  return entity.type === "event";
}

/**
 * Type guard for File entities
 */
export function isFile(entity: Entity): entity is File {
  return entity.type === "file";
}

/**
 * Generic type guard for any entity type
 */
export function isEntityOfType<T extends Entity["type"]>(
  entity: Entity,
  type: T
): entity is Extract<Entity, { type: T }> {
  return entity.type === type;
}
