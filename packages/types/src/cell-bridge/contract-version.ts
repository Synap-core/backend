/**
 * The version of the frame contract: what a cell may ask its host and what
 * the host tells it. A renderer bundle built against a newer version needs a
 * pod that answers it, so the version is what a bundle names as a requirement
 * (a pod on an older release holds the bundle instead of running cells whose
 * reads and writes it would refuse).
 *
 * Bump it, and record the new shape in its test, whenever an op gains, loses
 * or changes a param (`read-ops.ts`, `write-ops.ts`), the init context gains a
 * field a cell reads (`CellFrameInitContext`), or a message gains a field.
 *
 *   1  the contract before 23 Nov 2026
 *   2  `views.execute` limit / offset, `update_entity` title (alone or with
 *      properties), `profiles.get` fill, init `locale`, `synap:error` reason
 */
export const CELL_BRIDGE_CONTRACT_VERSION = 2;
