// The guard that makes "follow the file live" safe next to auto-save.
//
// The diff window refreshes on `repo://changed`, and its own auto-save writes
// trip that same watcher. Adopting disk content unconditionally would therefore
// (a) fight the user's typing and (b) overwrite the buffer with an older echo of
// what we just wrote. So a refresh replaces the right-hand pane only when the
// disk genuinely holds something newer than the buffer.

export interface AdoptCheck {
  /** Working-tree content just read from disk; null when the file is gone. */
  fetched: string | null;
  /** What the editor currently holds. */
  buffer: string | null;
  /** Content of our last successful save, i.e. what our own write echoes as. */
  lastWritten: string | null;
  /** Whether a debounced save is still waiting to run. */
  savePending: boolean;
}

/**
 * Whether a refresh should replace the editor buffer with `fetched`.
 *
 * Rejects three cases: a save still queued (the buffer is ahead of disk), an
 * identical read (nothing to do), and our own write coming back through the
 * watcher (disk matches our last save, so the buffer is the newer copy).
 */
export function shouldAdoptDiskContent({
  fetched,
  buffer,
  lastWritten,
  savePending,
}: AdoptCheck): boolean {
  if (savePending) return false;
  if (fetched === buffer) return false;
  if (fetched === lastWritten) return false;
  return true;
}
