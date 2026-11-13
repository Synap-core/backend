/**
 * One async lock per whiteboard room: whoever loads, saves or writes a
 * board's records holds it, so two of them never interleave.
 *
 * WHY. A board has two copies: the open room's Y.Doc and the stored file.
 * The place door writes into whichever is the board right now (the room when
 * open, else the file). Without a lock, a person opening the board while the
 * door writes the FILE could load the file before the write lands; their
 * room then starts without the agent's shapes and its next save overwrites
 * the file without them: a silent loss. With the lock, the room's load waits
 * for the write (or the write waits for the load and then writes into the
 * room), and a room's saves never race the door's save.
 *
 * BOUNDED. A holder that does not finish within `maxHoldMs` (a storage call
 * that never answers) loses the lock: the next waiter proceeds and the
 * holder's caller gets `RoomLockTimeoutError`. The holder's work is not
 * cancelled, so its outcome is UNKNOWN: callers word it that way.
 *
 * Covers the realtime server's own writers, in one process (one realtime
 * server holds a pod's rooms). A writer in another process
 * (`views.updateContent` replaces the stored file from the API) is NOT
 * covered: that call is a deliberate whole-board replace.
 */

export const ROOM_LOCK_MAX_HOLD_MS = 15_000;

export class RoomLockTimeoutError extends Error {
  constructor(
    readonly room: string,
    readonly maxHoldMs: number
  ) {
    super(
      `The board's lock was held for more than ${Math.round(maxHoldMs / 1000)} s (storage did not answer). The write may or may not have landed: retry is safe.`
    );
    this.name = "RoomLockTimeoutError";
  }
}

const tails = new Map<string, Promise<void>>();

/** Run `fn` while holding `room`'s lock (FIFO). Never re-entrant. */
export async function withRoomLock<T>(
  room: string,
  fn: () => Promise<T>,
  opts: { maxHoldMs?: number } = {}
): Promise<T> {
  const maxHoldMs = opts.maxHoldMs ?? ROOM_LOCK_MAX_HOLD_MS;
  const previous = tails.get(room) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  tails.set(room, tail);
  await previous;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RoomLockTimeoutError(room, maxHoldMs)),
          maxHoldMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release();
    if (tails.get(room) === tail) tails.delete(room);
  }
}
