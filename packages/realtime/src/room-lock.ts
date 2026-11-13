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
 * In-process only: one realtime server holds a pod's rooms.
 */

const tails = new Map<string, Promise<void>>();

/** Run `fn` while holding `room`'s lock (FIFO). Never re-entrant. */
export async function withRoomLock<T>(
  room: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = tails.get(room) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  tails.set(room, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(room) === tail) tails.delete(room);
  }
}

/** Whether anyone holds or waits for `room`'s lock (tests, health). */
export function roomLockBusy(room: string): boolean {
  return tails.has(room);
}
