// Streamed fetch/pull/push over the Tauri IPC.
//
// Unlike every other git call in the app these do not resolve with their result:
// the command returns as soon as git is spawned, then progress arrives on
// `git://progress/<opId>` and exactly one terminal event on `git://done/<opId>`.
//
// Two ordering rules matter here:
//
//  1. The op id is generated on this side (like lib/ptySession's PTY ids) and
//     the listeners are registered BEFORE the invoke, so an op that produces
//     output immediately cannot slip a line past us.
//  2. Exactly one `done` ever arrives per op, whether it finished or was
//     cancelled — the backend latches it. So `runRemoteOp` can resolve its
//     promise from that single event without any dedupe of its own.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type RemoteOpKind = "fetch" | "pull" | "push";

export interface RemoteOpSpec {
  kind: RemoteOpKind;
  remote: string;
  /** Current branch. Required for a push; unused by fetch. */
  branch?: string;
  /** Publish: `push -u`, setting the upstream as a side effect. */
  setUpstream?: boolean;
}

export interface RemoteOpResult {
  exitCode: number;
  /**
   * Everything git said, on both pipes, verbatim. Never parsed. Both, because
   * a conflicting pull reports the conflict on stdout while stderr holds only
   * the fetch progress — see the backend's `remote` module.
   */
  output: string;
  cancelled: boolean;
}

/** Payload of `git://done/<opId>`. Mirrors Rust `OpDonePayload`. */
interface DonePayload {
  exitCode: number;
  output: string;
  cancelled: boolean;
}

export interface RunRemoteOpOptions {
  repoRoot: string;
  spec: RemoteOpSpec;
  /**
   * Called with the op's id the moment it is minted, before any listener is
   * registered. Lets the caller record the running op straight away, so an early
   * progress line has somewhere to land and can be attributed to the right op.
   */
  onStart?: (opId: string) => void;
  /** Called for each line of git's own progress output, verbatim. */
  onProgress?: (line: string) => void;
}

let opSeq = 0;

/** A distinct id per op, so concurrent listeners can never cross-talk. */
function nextOpId(kind: RemoteOpKind): string {
  opSeq += 1;
  return `${kind}-${opSeq}`;
}

export interface RunningRemoteOp {
  opId: string;
  /**
   * Resolves with the outcome once the single terminal event arrives, including
   * a non-zero exit — a failed git op is a result to display, not a rejection.
   * Rejects only when the op could not be started at all.
   */
  result: Promise<RemoteOpResult>;
}

/**
 * Start a fetch, pull or push. Resolves once the op has been *started*, giving
 * back its id (for `cancelRemoteOp`) and a promise for its outcome.
 */
export async function runRemoteOp(opts: RunRemoteOpOptions): Promise<RunningRemoteOp> {
  const opId = nextOpId(opts.spec.kind);
  opts.onStart?.(opId);
  const unlisteners: UnlistenFn[] = [];

  let settle: (result: RemoteOpResult) => void;
  const result = new Promise<RemoteOpResult>((resolve) => {
    settle = resolve;
  });

  const cleanup = () => {
    for (const unlisten of unlisteners) unlisten();
    unlisteners.length = 0;
  };

  try {
    unlisteners.push(
      await listen<string>(`git://progress/${opId}`, (event) => {
        opts.onProgress?.(event.payload);
      }),
    );
    unlisteners.push(
      await listen<DonePayload>(`git://done/${opId}`, (event) => {
        // One event per op, guaranteed by the backend's latch, so unsubscribing
        // here cannot drop a later one.
        cleanup();
        settle({
          exitCode: event.payload.exitCode,
          output: event.payload.output,
          cancelled: event.payload.cancelled,
        });
      }),
    );

    await invoke<void>("git_remote_op", {
      repoRoot: opts.repoRoot,
      opId,
      spec: {
        kind: opts.spec.kind,
        remote: opts.spec.remote,
        branch: opts.spec.branch ?? null,
        setUpstream: opts.spec.setUpstream ?? false,
      },
    });
  } catch (error) {
    // Nothing will ever emit for this id, so drop the listeners rather than
    // leaking them for the lifetime of the window.
    cleanup();
    throw error;
  }

  return { opId, result };
}

/**
 * Cancel a running op. The terminal event still arrives (with `cancelled`), so
 * callers awaiting `result` always finish.
 */
export function cancelRemoteOp(opId: string): Promise<void> {
  return invoke<void>("git_cancel_op", { opId });
}

/** The command line to show for "Retry in terminal". */
export function remoteOpCommand(spec: RemoteOpSpec): string {
  switch (spec.kind) {
    case "fetch":
      return `git fetch ${spec.remote}`;
    case "pull":
      // Bare, exactly as the backend runs it: the user's config decides.
      return "git pull";
    case "push":
      return spec.setUpstream
        ? `git push --set-upstream ${spec.remote} ${spec.branch ?? ""}`.trimEnd()
        : `git push ${spec.remote} ${spec.branch ?? ""}`.trimEnd();
  }
}
