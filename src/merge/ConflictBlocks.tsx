// The read-only conflict view: the whole file with each conflict rendered as a
// block of ours-then-theirs and a button row.
//
// Read-only, and plain React rather than an editor, is deliberate for this part.
// Part 7 replaces this pane with a 3-pane CodeMirror editor built on a chunk
// model from `git show :1: :2: :3:`, so anything invested in a single-pane
// marker editor here would be thrown away — and hand-editing stays available
// through the diff window and the terminal.
//
// Long files are not virtualised. A conflicted source file is a few thousand
// lines at worst, and the moment that stops being true is the moment Part 7's
// editor takes this over anyway.

import type { ConflictBlock } from "../lib/gitMerge";

export type Side = "ours" | "theirs" | "base";

interface ConflictBlocksProps {
  lines: string[];
  blocks: ConflictBlock[];
  /** Called with the index of the conflict and the side to keep. */
  onResolve: (index: number, choice: "ours" | "theirs" | "both") => void;
  /** Disables the buttons while a resolution is in flight. */
  busy: boolean;
}

/**
 * Line numbers are 1-based for display, and they are the numbers of the file *as
 * it is on disk* — markers included. That is what the terminal and any editor
 * will agree with while the conflict is still there.
 */
function LineRow({ number, text, side }: { number: number; text: string; side?: Side }) {
  return (
    <div className={side ? `merge-line merge-line--${side}` : "merge-line"}>
      <span className="merge-line-number" aria-hidden="true">
        {number}
      </span>
      {/* A zero-width space keeps an empty line's height without adding content
          that could be copied out as whitespace. */}
      <span className="merge-line-text">{text === "" ? "​" : text}</span>
    </div>
  );
}

function Section({
  lines,
  start,
  end,
  side,
  label,
}: {
  lines: string[];
  start: number;
  end: number;
  side: Side;
  label: string;
}) {
  return (
    <div className={`merge-section merge-section--${side}`}>
      <p className="merge-section-label">{label}</p>
      {start === end ? (
        // An empty side is a real resolution ("delete these lines"), so it has to
        // be visible rather than an absent block.
        <p className="merge-section-empty">(nothing on this side)</p>
      ) : (
        lines
          .slice(start, end)
          .map((text, offset) => (
            <LineRow key={start + offset} number={start + offset + 1} text={text} side={side} />
          ))
      )}
    </div>
  );
}

export function ConflictBlocks({ lines, blocks, onResolve, busy }: ConflictBlocksProps) {
  const pieces: React.ReactNode[] = [];
  let cursor = 0;

  blocks.forEach((block, index) => {
    // Context between the previous block and this one, verbatim.
    for (let line = cursor; line < block.start; line += 1) {
      pieces.push(<LineRow key={`context-${line}`} number={line + 1} text={lines[line] ?? ""} />);
    }

    pieces.push(
      <section
        key={`block-${block.start}`}
        className="merge-block"
        aria-label={`Conflict ${index + 1} of ${blocks.length}`}
      >
        <header className="merge-block-header">
          <span className="merge-block-count">{`Conflict ${index + 1} of ${blocks.length}`}</span>
          {block.complete ? (
            <div className="merge-block-actions">
              <button
                type="button"
                className="merge-choice"
                disabled={busy}
                onClick={() => onResolve(index, "ours")}
              >
                Accept ours
              </button>
              <button
                type="button"
                className="merge-choice"
                disabled={busy}
                onClick={() => onResolve(index, "theirs")}
              >
                Accept theirs
              </button>
              <button
                type="button"
                className="merge-choice"
                disabled={busy}
                title="Keep our lines followed by theirs"
                onClick={() => onResolve(index, "both")}
              >
                Accept both
              </button>
            </div>
          ) : (
            // No buttons at all rather than buttons that guess. Without both
            // markers there is no boundary between the sides, and inventing one
            // writes a marker line back into the file.
            <span className="merge-block-broken">
              missing its ======= or {">>>>>>>"} marker — fix it by hand
            </span>
          )}
        </header>

        <Section
          lines={lines}
          start={block.ours.start}
          end={block.ours.end}
          side="ours"
          // git's own label, shown verbatim and never interpreted. "(ours)"
          // spells out which side of the merge it is, since "HEAD" does not.
          label={`${block.oursLabel || "ours"} (ours)`}
        />
        {block.base && (
          <Section
            lines={lines}
            start={block.base.start}
            end={block.base.end}
            side="base"
            label="common ancestor (dropped by Accept both)"
          />
        )}
        <Section
          lines={lines}
          start={block.theirs.start}
          end={block.theirs.end}
          side="theirs"
          label={`${block.theirsLabel || "theirs"} (theirs)`}
        />
      </section>,
    );

    cursor = block.end;
  });

  // Everything after the last conflict.
  for (let line = cursor; line < lines.length; line += 1) {
    pieces.push(<LineRow key={`context-${line}`} number={line + 1} text={lines[line] ?? ""} />);
  }

  return <div className="merge-file">{pieces}</div>;
}
