//! The rebuilt three-way merge: what each side changed, and where they collide.
//!
//! Part 6 read a conflict out of the markers git had already written into the
//! working tree. This module reads it out of the *index stages* instead — base,
//! ours and theirs as git stored them — and re-derives the merge itself. That is
//! what the three-pane editor needs and the marker file cannot give: a marker
//! only shows the regions git could not decide, whereas a chunk model also shows
//! every change one side made on its own, which is most of what a reviewer wants
//! to look at.
//!
//! Three things to know before reading on:
//!
//! - **Chunks tile the base exactly.** Every base line belongs to exactly one
//!   chunk, unchanged runs included, so [`serialize_result`] can rebuild the file
//!   by walking the list once and the panes can map a chunk to a line range in
//!   any of the three texts without a second index.
//! - **Changes with no common base line between them become one chunk.** That is
//!   the classic diff3 grouping rule, and it is why two edits that merely touch
//!   are a single conflict rather than two adjacent ones the user would have to
//!   resolve consistently by hand.
//! - **This will not always split hunks the way git's xdiff does.** A rebuild can
//!   produce two conflicts where `git merge` wrote one. Nothing here tries to
//!   match git line for line; [`equivalent_ignoring_marker_labels`] exists so the
//!   *window* can tell "the user edited this file" from "our diff drew the
//!   boundaries differently", by comparing against git's own output rather than
//!   against ours.

use serde::Serialize;
use similar::{capture_diff_slices, Algorithm, DiffOp};

use crate::diff::normalize_to_lf;
use crate::merge::{marker_char, LineRange};

/// What happened to a run of base lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChunkKind {
    /// Neither side touched it.
    Unchanged,
    /// Only our side changed it, so the result already holds our version.
    Ours,
    /// Only their side changed it.
    Theirs,
    /// Both sides changed it to the *same* text. No decision to make, which is
    /// why this is not a conflict — git merges it silently too.
    Agreed,
    /// Both sides changed it, differently. The only kind that needs a decision.
    Conflict,
}

impl ChunkKind {
    /// Whether this chunk is written into the result as conflict markers.
    pub fn is_conflict(self) -> bool {
        self == ChunkKind::Conflict
    }
}

/// One run of the file, as line ranges into each of the three texts.
///
/// Ranges rather than copies, for the same reason [`crate::merge::ConflictBlock`]
/// uses them: the window renders all three panes from the same three line
/// vectors, and duplicating the text here would mean two sources of truth for one
/// file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub kind: ChunkKind,
    pub base: LineRange,
    pub ours: LineRange,
    pub theirs: LineRange,
}

/// A chunk together with where it landed in the initial result buffer.
///
/// The `result` span is what lets the editor's arrows act on a chunk at all: a
/// non-conflicting chunk has no markers to find it by, so without a position from
/// the serialiser there would be nothing to replace. It describes the buffer **as
/// first written** — the window maps it through the user's own edits from there,
/// which is what CodeMirror's `mapPos` is for.
///
/// Computed here rather than re-derived in the frontend on purpose: a second
/// implementation of the layout would be a second thing to keep in step with
/// [`serialize_result`], and a drift would put the arrows on the wrong lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacedChunk {
    pub kind: ChunkKind,
    pub base: LineRange,
    pub ours: LineRange,
    pub theirs: LineRange,
    /// Line span in the serialised result, markers included for a conflict.
    pub result: LineRange,
}

/// Marker labels for [`serialize_result`], shown verbatim and never parsed back.
#[derive(Debug, Clone, Copy)]
pub struct Labels<'a> {
    /// Follows `<<<<<<<`. `HEAD` in git's own output.
    pub ours: &'a str,
    /// Follows `>>>>>>>`. The merged ref in git's own output.
    pub theirs: &'a str,
}

/// One side's edit to the base, in both coordinate systems.
///
/// A deletion has an empty `new` range and an insertion an empty `base` range;
/// keeping both as plain half-open pairs is what lets the grouping loop treat all
/// three op shapes identically.
#[derive(Debug, Clone, Copy)]
struct Edit {
    base: (usize, usize),
    new: (usize, usize),
}

impl Edit {
    fn from_op(op: DiffOp) -> Option<Self> {
        match op {
            DiffOp::Equal { .. } => None,
            DiffOp::Delete {
                old_index,
                old_len,
                new_index,
            } => Some(Edit {
                base: (old_index, old_index + old_len),
                new: (new_index, new_index),
            }),
            DiffOp::Insert {
                old_index,
                new_index,
                new_len,
            } => Some(Edit {
                base: (old_index, old_index),
                new: (new_index, new_index + new_len),
            }),
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => Some(Edit {
                base: (old_index, old_index + old_len),
                new: (new_index, new_index + new_len),
            }),
        }
    }
}

fn edits(base: &[String], side: &[String]) -> Vec<Edit> {
    capture_diff_slices(Algorithm::Myers, base, side)
        .into_iter()
        .filter_map(Edit::from_op)
        .collect()
}

/// How far `side` has drifted from `base` once `consumed` edits are behind us.
///
/// Read off the last consumed edit rather than accumulated, because the edit
/// already carries both of its end positions — one fewer running total to get
/// wrong.
fn drift(edits: &[Edit], consumed: usize) -> isize {
    match consumed.checked_sub(1).and_then(|last| edits.get(last)) {
        Some(edit) => edit.new.1 as isize - edit.base.1 as isize,
        None => 0,
    }
}

/// The line range a group of base lines occupies on one side.
///
/// With edits on this side, the group's own first and last edit pin it exactly.
/// Without any, the side did not touch these lines, so they are the same lines
/// shifted by the drift so far.
fn side_range(group: &[Edit], base: (usize, usize), drift: isize) -> LineRange {
    match (group.first(), group.last()) {
        (Some(first), Some(last)) => {
            // Base lines inside the group but before the first edit / after the
            // last one are unchanged on this side, so they appear verbatim right
            // before / after it. Neither subtraction can underflow — those lines
            // exist on this side too — but saturating beats a panic in a command.
            let lead = first.base.0.saturating_sub(base.0);
            let trail = base.1.saturating_sub(last.base.1);
            LineRange::new(first.new.0.saturating_sub(lead), last.new.1 + trail)
        }
        _ => {
            let start = (base.0 as isize + drift).max(0) as usize;
            LineRange::new(start, start + (base.1 - base.0))
        }
    }
}

/// Split the three texts into chunks covering every base line exactly once.
///
/// An empty `base` is normal, not an error: a both-added conflict has no stage 1,
/// so every line of both sides is an insertion at position 0.
pub fn chunks(base: &[String], ours: &[String], theirs: &[String]) -> Vec<Chunk> {
    let our_edits = edits(base, ours);
    let their_edits = edits(base, theirs);
    let mut out = Vec::new();
    let mut ours_done = 0;
    let mut theirs_done = 0;
    let mut pos = 0;

    let unchanged = |from: usize, to: usize, ours_done: usize, theirs_done: usize| Chunk {
        kind: ChunkKind::Unchanged,
        base: LineRange::new(from, to),
        ours: side_range(&[], (from, to), drift(&our_edits, ours_done)),
        theirs: side_range(&[], (from, to), drift(&their_edits, theirs_done)),
    };

    loop {
        let next = match (our_edits.get(ours_done), their_edits.get(theirs_done)) {
            (Some(a), Some(b)) => a.base.0.min(b.base.0),
            (Some(a), None) => a.base.0,
            (None, Some(b)) => b.base.0,
            (None, None) => break,
        };
        if next > pos {
            out.push(unchanged(pos, next, ours_done, theirs_done));
            pos = next;
        }

        // Grow one group: an edit joins when it starts at or before the group's
        // current end, i.e. when no common base line separates the two. Each side
        // can extend the end and so pull in more of the other's edits, hence the
        // outer loop.
        let mut end = pos;
        let mut mine: Vec<Edit> = Vec::new();
        let mut yours: Vec<Edit> = Vec::new();
        loop {
            let before = (mine.len(), yours.len());
            while let Some(edit) = our_edits.get(ours_done).filter(|e| e.base.0 <= end) {
                end = end.max(edit.base.1);
                mine.push(*edit);
                ours_done += 1;
            }
            while let Some(edit) = their_edits.get(theirs_done).filter(|e| e.base.0 <= end) {
                end = end.max(edit.base.1);
                yours.push(*edit);
                theirs_done += 1;
            }
            if (mine.len(), yours.len()) == before {
                break;
            }
        }

        let span = (pos, end);
        // The drift used for an untouched side is the one *before* this group,
        // since a side with no edit here has not moved across it.
        let our_range = side_range(&mine, span, drift(&our_edits, ours_done - mine.len()));
        let their_range = side_range(&yours, span, drift(&their_edits, theirs_done - yours.len()));
        let kind = match (mine.is_empty(), yours.is_empty()) {
            (false, true) => ChunkKind::Ours,
            (true, false) => ChunkKind::Theirs,
            (false, false) => {
                if our_range.slice(ours) == their_range.slice(theirs) {
                    ChunkKind::Agreed
                } else {
                    ChunkKind::Conflict
                }
            }
            // A group only forms around an edit, so at least one side has one.
            (true, true) => unreachable!("a group always contains an edit"),
        };
        out.push(Chunk {
            kind,
            base: LineRange::new(span.0, span.1),
            ours: our_range,
            theirs: their_range,
        });
        pos = end;
    }

    if pos < base.len() {
        out.push(unchanged(pos, base.len(), ours_done, theirs_done));
    }
    out
}

/// The initial result buffer: every chunk resolved the way git would resolve it,
/// with conflicts left as markers.
///
/// The markers are real text because that keeps one definition of "resolved" in
/// play — [`crate::merge::parse_conflicts`] finding nothing, which is git's own
/// definition and the one the write path enforces. A widget-based placeholder
/// would need a second definition maintained in the frontend, and the two would
/// eventually disagree.
pub fn serialize_result(
    chunks: &[Chunk],
    base: &[String],
    ours: &[String],
    theirs: &[String],
    labels: Labels,
) -> (String, Vec<PlacedChunk>) {
    // Built before the loop so the borrows below can point at them.
    let open = marker("<<<<<<<", labels.ours);
    let close = marker(">>>>>>>", labels.theirs);
    let mut out: Vec<&str> = Vec::new();
    let mut placed = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        let start = out.len();
        match chunk.kind {
            ChunkKind::Unchanged => push(&mut out, chunk.base.slice(base)),
            // Agreed means both sides wrote the same text, so either side is the
            // same answer; ours is the arbitrary pick.
            ChunkKind::Ours | ChunkKind::Agreed => push(&mut out, chunk.ours.slice(ours)),
            ChunkKind::Theirs => push(&mut out, chunk.theirs.slice(theirs)),
            ChunkKind::Conflict => {
                out.push(&open);
                push(&mut out, chunk.ours.slice(ours));
                out.push("=======");
                push(&mut out, chunk.theirs.slice(theirs));
                out.push(&close);
            }
        }
        placed.push(PlacedChunk {
            kind: chunk.kind,
            base: chunk.base,
            ours: chunk.ours,
            theirs: chunk.theirs,
            result: LineRange::new(start, out.len()),
        });
    }
    (out.join("\n"), placed)
}

fn push<'a>(out: &mut Vec<&'a str>, lines: &'a [String]) {
    out.extend(lines.iter().map(String::as_str));
}

/// A marker line, without the trailing space when there is no label to follow it.
fn marker(prefix: &str, label: &str) -> String {
    if label.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix} {label}")
    }
}

/// Whether two rendered merges differ only in what follows their conflict
/// markers.
///
/// This is the divergence guard's comparison, and label-insensitivity is what
/// makes it usable at all: `git merge` labels its markers `HEAD` and the merged
/// ref, `git merge-file` labels them from its `-L` arguments, and
/// [`serialize_result`] labels them from whatever the caller passed. Part 6
/// already established that marker labels are display-only and never drive
/// logic; this is the same rule applied to a comparison.
///
/// Both sides are LF-normalised first: the working-tree file may be CRLF while
/// blobs are stored LF, and that difference is not a divergence.
pub fn equivalent_ignoring_marker_labels(left: &str, right: &str) -> bool {
    let left = normalize_to_lf(left);
    let right = normalize_to_lf(right);
    let mut left = left.split('\n');
    let mut right = right.split('\n');
    loop {
        match (left.next(), right.next()) {
            (None, None) => return true,
            (Some(a), Some(b)) if equivalent_line(a, b) => {}
            _ => return false,
        }
    }
}

fn equivalent_line(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    // Same marker character means the same structural line; only the label
    // after it differs, and that is display-only.
    match (marker_char(left), marker_char(right)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::merge::parse_conflicts;

    fn lines(text: &str) -> Vec<String> {
        text.split('\n').map(str::to_string).collect()
    }

    fn labels() -> Labels<'static> {
        Labels {
            ours: "ours",
            theirs: "theirs",
        }
    }

    /// Just the rebuilt text, for the tests that do not care where each chunk
    /// landed in it. The placed ranges have their own test below.
    fn serialized(chunks: &[Chunk], base: &[String], ours: &[String], theirs: &[String]) -> String {
        serialize_result(chunks, base, ours, theirs, labels()).0
    }

    /// Every base line in exactly one chunk, chunks in order, no gaps: the
    /// invariant `serialize_result` and the panes both lean on.
    fn assert_tiles(chunks: &[Chunk], base_len: usize) {
        let mut at = 0;
        for chunk in chunks {
            assert_eq!(chunk.base.start, at, "gap or overlap before {chunk:?}");
            assert!(chunk.base.end >= chunk.base.start);
            at = chunk.base.end;
        }
        assert_eq!(at, base_len, "chunks do not reach the end of the base");
    }

    fn kinds(chunks: &[Chunk]) -> Vec<ChunkKind> {
        chunks.iter().map(|c| c.kind).collect()
    }

    #[test]
    fn identical_sides_are_one_unchanged_chunk() {
        let base = lines("a\nb\nc");
        let got = chunks(&base, &base, &base);
        assert_eq!(kinds(&got), vec![ChunkKind::Unchanged]);
        assert_tiles(&got, base.len());
    }

    #[test]
    fn a_change_only_we_made_is_ours() {
        let base = lines("a\nb\nc");
        let ours = lines("a\nB\nc");
        let got = chunks(&base, &ours, &base);
        assert_eq!(
            kinds(&got),
            vec![ChunkKind::Unchanged, ChunkKind::Ours, ChunkKind::Unchanged]
        );
        let chunk = got[1];
        assert_eq!(chunk.ours.slice(&ours), ["B".to_string()]);
        // The result takes it without asking, which is what "auto-apply of
        // non-conflicting changes" means.
        assert_eq!(serialized(&got, &base, &ours, &base), "a\nB\nc");
        assert_tiles(&got, base.len());
    }

    #[test]
    fn a_change_only_they_made_is_theirs() {
        let base = lines("a\nb\nc");
        let theirs = lines("a\nB\nc");
        let got = chunks(&base, &base, &theirs);
        assert_eq!(kinds(&got)[1], ChunkKind::Theirs);
        assert_eq!(serialized(&got, &base, &base, &theirs), "a\nB\nc");
    }

    #[test]
    fn the_same_change_on_both_sides_is_agreed_not_a_conflict() {
        let base = lines("a\nb\nc");
        let side = lines("a\nB\nc");
        let got = chunks(&base, &side, &side);
        assert_eq!(kinds(&got)[1], ChunkKind::Agreed);
        // No markers: there is nothing for the user to decide.
        let text = serialized(&got, &base, &side, &side);
        assert_eq!(text, "a\nB\nc");
        assert!(parse_conflicts(&text).is_empty());
    }

    #[test]
    fn different_changes_to_the_same_lines_conflict() {
        let base = lines("a\nb\nc");
        let ours = lines("a\nMINE\nc");
        let theirs = lines("a\nYOURS\nc");
        let got = chunks(&base, &ours, &theirs);
        assert_eq!(kinds(&got)[1], ChunkKind::Conflict);
        assert_eq!(
            serialized(&got, &base, &ours, &theirs),
            "a\n<<<<<<< ours\nMINE\n=======\nYOURS\n>>>>>>> theirs\nc"
        );
    }

    #[test]
    fn changes_far_apart_stay_separate_chunks() {
        let base = lines("a\nb\nc\nd\ne");
        let ours = lines("A\nb\nc\nd\ne");
        let theirs = lines("a\nb\nc\nd\nE");
        let got = chunks(&base, &ours, &theirs);
        assert_eq!(
            kinds(&got),
            vec![ChunkKind::Ours, ChunkKind::Unchanged, ChunkKind::Theirs]
        );
        // Both apply: neither side has to be chosen over the other.
        assert_eq!(serialized(&got, &base, &ours, &theirs), "A\nb\nc\nd\nE");
    }

    #[test]
    fn touching_changes_become_one_conflict() {
        // Ours rewrites line 2, theirs rewrites line 3: adjacent, with no common
        // base line between them, so diff3 grouping makes them a single decision
        // rather than two the user would have to keep consistent by hand.
        let base = lines("a\nb\nc\nd");
        let ours = lines("a\nB\nc\nd");
        let theirs = lines("a\nb\nC\nd");
        let got = chunks(&base, &ours, &theirs);
        assert_eq!(
            kinds(&got),
            vec![
                ChunkKind::Unchanged,
                ChunkKind::Conflict,
                ChunkKind::Unchanged
            ]
        );
        let conflict = got[1];
        assert_eq!(conflict.base.start, 1);
        assert_eq!(conflict.base.end, 3);
        // Each side carries the whole span, its own edit included.
        assert_eq!(
            conflict.ours.slice(&ours),
            ["B".to_string(), "c".to_string()]
        );
        assert_eq!(
            conflict.theirs.slice(&theirs),
            ["b".to_string(), "C".to_string()]
        );
        assert_tiles(&got, base.len());
    }

    #[test]
    fn both_inserting_at_the_same_place_conflicts() {
        let base = lines("a\nz");
        let ours = lines("a\nmine\nz");
        let theirs = lines("a\ntheirs\nz");
        let got = chunks(&base, &ours, &theirs);
        assert!(got.iter().any(|c| c.kind == ChunkKind::Conflict));
        let text = serialized(&got, &base, &ours, &theirs);
        assert_eq!(parse_conflicts(&text).len(), 1);
        assert_tiles(&got, base.len());
    }

    #[test]
    fn an_empty_base_is_a_both_added_conflict() {
        // Stage 1 is absent for a both-added path, so every line is an insertion.
        let base: Vec<String> = Vec::new();
        let ours = lines("mine");
        let theirs = lines("theirs");
        let got = chunks(&base, &ours, &theirs);
        assert_eq!(kinds(&got), vec![ChunkKind::Conflict]);
        assert_eq!(
            serialized(&got, &base, &ours, &theirs),
            "<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs"
        );
    }

    #[test]
    fn a_deletion_on_one_side_applies() {
        let base = lines("a\nb\nc");
        let ours = lines("a\nc");
        let got = chunks(&base, &ours, &base);
        assert!(got.iter().any(|c| c.kind == ChunkKind::Ours));
        assert_eq!(serialized(&got, &base, &ours, &base), "a\nc");
        assert_tiles(&got, base.len());
    }

    #[test]
    fn a_deletion_against_an_edit_conflicts() {
        let base = lines("a\nb\nc");
        let ours = lines("a\nc");
        let theirs = lines("a\nB\nc");
        let got = chunks(&base, &ours, &theirs);
        assert!(got.iter().any(|c| c.kind == ChunkKind::Conflict));
        let text = serialized(&got, &base, &ours, &theirs);
        // Our side of that conflict is empty — "delete these lines" is a real
        // resolution, and the marker block has to be able to say it.
        assert!(text.contains("<<<<<<< ours\n=======\nB\n"), "{text}");
    }

    #[test]
    fn no_trailing_newline_round_trips() {
        // split_lines' convention: a trailing newline is a final empty line, so
        // its absence has to survive the rebuild untouched.
        let base = lines("a\nb");
        let ours = lines("a\nB");
        let got = chunks(&base, &ours, &base);
        let text = serialized(&got, &base, &ours, &base);
        assert_eq!(text, "a\nB");
        assert!(!text.ends_with('\n'));
    }

    #[test]
    fn a_trailing_newline_round_trips() {
        let base = lines("a\nb\n");
        let ours = lines("a\nB\n");
        let got = chunks(&base, &ours, &base);
        assert_eq!(serialized(&got, &base, &ours, &base), "a\nB\n");
    }

    /// The contract the whole write path rests on: the number of `Conflict`
    /// chunks is exactly the number of markers `parse_conflicts` finds, so "zero
    /// markers left" really does mean "every chunk decided".
    #[test]
    fn serialised_conflicts_reparse_one_for_one() {
        let base = lines("a\nb\nc\nd\ne\nf\ng");
        let ours = lines("a\nMINE1\nc\nd\nMINE2\nf\ng");
        let theirs = lines("a\nYOURS1\nc\nd\nYOURS2\nf\ng");
        let got = chunks(&base, &ours, &theirs);
        let conflicts = got.iter().filter(|c| c.kind.is_conflict()).count();
        assert_eq!(conflicts, 2);
        let text = serialized(&got, &base, &ours, &theirs);
        assert_eq!(parse_conflicts(&text).len(), conflicts);
    }

    /// The arrows' whole basis: each chunk's span in the buffer as first written.
    /// A non-conflicting chunk has no markers to be found by, so a wrong span here
    /// puts its arrow on somebody else's lines.
    #[test]
    fn every_chunk_records_where_it_landed_in_the_buffer() {
        let base = lines("a\nb\nc\nd");
        let ours = lines("a\nMINE\nc\nd");
        let theirs = lines("a\nb\nc\nTHEIRS");
        let got = chunks(&base, &ours, &theirs);
        let (text, placed) = serialize_result(&got, &base, &ours, &theirs, labels());

        assert_eq!(placed.len(), got.len(), "one placement per chunk");
        // Contiguous, in order, and covering the whole buffer: the same tiling
        // property the base ranges have, in the result's coordinates.
        let mut at = 0;
        for chunk in &placed {
            assert_eq!(chunk.result.start, at, "gap or overlap at {chunk:?}");
            at = chunk.result.end;
        }
        assert_eq!(at, text.split('\n').count(), "{text}");

        // And the recorded span really is that chunk's text.
        let buffer: Vec<&str> = text.split('\n').collect();
        let ours_chunk = placed
            .iter()
            .find(|c| c.kind == ChunkKind::Ours)
            .expect("ours-only chunk");
        assert_eq!(
            &buffer[ours_chunk.result.start..ours_chunk.result.end],
            ["MINE"]
        );
    }

    #[test]
    fn a_conflict_span_includes_its_marker_lines() {
        // The span has to cover the markers, or accepting a side would leave a
        // `<<<<<<<` behind and the file could never reach zero conflicts.
        let base = lines("a\nb\nc");
        let ours = lines("a\nMINE\nc");
        let theirs = lines("a\nYOURS\nc");
        let got = chunks(&base, &ours, &theirs);
        let (text, placed) = serialize_result(&got, &base, &ours, &theirs, labels());
        let conflict = placed
            .iter()
            .find(|c| c.kind == ChunkKind::Conflict)
            .expect("conflict chunk");
        let buffer: Vec<&str> = text.split('\n').collect();
        let span = &buffer[conflict.result.start..conflict.result.end];
        assert_eq!(
            span,
            ["<<<<<<< ours", "MINE", "=======", "YOURS", ">>>>>>> theirs"]
        );
    }

    #[test]
    fn empty_labels_leave_no_trailing_space() {
        let base: Vec<String> = Vec::new();
        let ours = lines("mine");
        let theirs = lines("theirs");
        let got = chunks(&base, &ours, &theirs);
        let (text, _) = serialize_result(
            &got,
            &base,
            &ours,
            &theirs,
            Labels {
                ours: "",
                theirs: "",
            },
        );
        assert!(text.starts_with("<<<<<<<\n"), "{text}");
        assert!(text.ends_with("\n>>>>>>>"), "{text}");
        // Still a marker git and our own parser both recognise.
        assert_eq!(parse_conflicts(&text).len(), 1);
    }

    #[test]
    fn marker_labels_do_not_count_as_divergence() {
        let git = "a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> feature\nb";
        let mine = "a\n<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\nb";
        assert!(equivalent_ignoring_marker_labels(git, mine));
    }

    #[test]
    fn crlf_does_not_count_as_divergence() {
        assert!(equivalent_ignoring_marker_labels("a\r\nb\r\n", "a\nb\n"));
    }

    #[test]
    fn different_content_is_divergence() {
        let left = "a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> feature\nb";
        let right = "a\n<<<<<<< HEAD\nEDITED\n=======\ntheirs\n>>>>>>> feature\nb";
        assert!(!equivalent_ignoring_marker_labels(left, right));
    }

    #[test]
    fn a_different_marker_character_is_divergence() {
        // A diff3 base section is a structural difference, not a label one: it
        // has content our two-way serialisation does not.
        assert!(!equivalent_ignoring_marker_labels("<<<<<<< a", "======="));
        assert!(!equivalent_ignoring_marker_labels(
            "||||||| base",
            ">>>>>>> x"
        ));
    }

    #[test]
    fn a_different_line_count_is_divergence() {
        assert!(!equivalent_ignoring_marker_labels("a\nb", "a\nb\nc"));
    }
}
