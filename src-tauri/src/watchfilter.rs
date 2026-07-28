//! Which filesystem events under the repo root are worth a `repo://changed`.
//!
//! The watcher covers the root recursively, which means it covers everything the
//! user's build tools write. In this very checkout that is 12 GB of
//! `src-tauri/target/` and 324 MB of `node_modules/`, so `npm run tauri dev`
//! produced a permanent event stream, each event costing three git reads and
//! around thirteen subprocesses, all to be told the tree was still clean. Every
//! one of those paths is gitignored, which is what makes filtering possible at
//! all: if `git status` will never report it, a refresh cannot show it.
//!
//! Five passes, cheapest first, and nothing spawns a process before the last one:
//!
//! 1. path to slug, then the pure `.git` and save-temp rules;
//! 2. a `.gitignore` write, which invalidates what we think we know;
//! 3. apply that invalidation, then return early if anything already said yes;
//! 4. the cache, as hash lookups;
//! 5. one batched `git check-ignore` for whatever is left.
//!
//! Pass 3 preceding pass 5 is what makes the common cases free: any batch
//! carrying `.git/index` (staging, a commit, a checkout, any git operation)
//! refreshes without asking git anything.
//!
//! **Ancestors, not just leaves.** Every verdict is cached for the whole prefix
//! chain, because churn never repeats a leaf: asking about
//! `target/debug/build/foo-abc/out/x` teaches nothing reusable, while learning
//! that `src-tauri/target` is ignored settles all 2,915 directories beneath it for
//! good. Sound because git guarantees a file cannot be re-included once a parent
//! directory is excluded — and because git will not call a directory ignored in
//! the first place while it holds tracked content, so a `git add -f` inside one
//! keeps working. Two things follow from that second half, both worth knowing:
//! a `dir/` pattern only matches a path git can see *is* a directory, so a path
//! that does not exist comes back "not ignored"; and a file force-added into a
//! directory whose verdict is already cached is missed until the next flush.
//!
//! **A read is not a change.** Paths are checked against a remembered [`Stamp`]
//! rather than taken at face value, because our own git commands reach us as
//! events: `notify`'s inotify mask includes `OPEN`, so every file `git status`
//! reads is reported. Without this, answering a refresh caused the next one, at
//! about seven a second on an idle clean repository — a worse storm than the one
//! this module exists to stop, and one that predates it (a plain `git status` was
//! always enough). See [`WatchFilter::changed_on_disk`].
//!
//! **Not knowing means refreshing.** A path we cannot map, a question git failed
//! to answer: all of it falls through to a refresh. A missed refresh is a silently
//! wrong sidebar that the user has no way to force to update, since the whole
//! design is events rather than polling; a surplus refresh costs subprocesses and,
//! with `phase` settled (Part 9a), no visible flicker.
//!
//! Deliberately takes `&Path` rather than the debouncer's event type, so this
//! module has no `notify` and no Tauri dependency (the same property `watcher`
//! itself keeps) and every rule can be unit-tested against a path literal.
//!
//! One thing this does *not* fix: the number of directories the OS is asked to
//! watch. See the README's known limitations, and the roadmap's "Watch only what
//! matters".

use std::collections::hash_map::Entry;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use crate::git::{self, basename};
use crate::SAVE_TEMP_PREFIX;

/// Ceiling on remembered verdicts, past which the lot is discarded.
///
/// A wholesale flush rather than an LRU: the worst case is one extra round of
/// questions, and it needs no eviction bookkeeping to get wrong. Generous enough
/// that a normal repo never reaches it, since the ancestor chains of a build
/// directory collapse to a handful of entries.
const MAX_VERDICTS: usize = 8192;

/// Files git writes at most **once per user-initiated operation**, each of which
/// changes something the UI renders.
///
/// That "once per operation" is the rule for adding to this list. `merge_state`
/// reads `MERGE_HEAD`, `CHERRY_PICK_HEAD` and `REVERT_HEAD`; `branch_state` reads
/// refs; `run_status` reads the index.
const GIT_STATE_FILES: &[&str] = &[
    "index",
    "HEAD",
    "ORIG_HEAD",
    "MERGE_HEAD",
    "MERGE_MSG",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "packed-refs",
    "shallow",
    // The only source of the branch panel's "fetched N minutes ago"
    // (`branch::branch_state` stats it), and a fetch that brings nothing new writes
    // nothing else. Affordable now that a rule verdict is gated on the file having
    // actually moved: a re-read of it is no longer an event we act on.
    "FETCH_HEAD",
];

/// Directories under `.git` whose contents mean an operation moved.
///
/// `reftable` is the newer ref backend (`git init --ref-format=reftable`), where
/// `refs/` stays empty and a branch or tag update rewrites `reftable/*` instead. A
/// commit would still be caught through the index, but `git branch` and a fetch
/// would not.
const GIT_STATE_DIRS: &[&str] = &[
    "refs",
    "reftable",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
];

/// "The same file as last time we looked", for telling a write apart from a read.
///
/// mtime and length are the portable part. On Unix the inode change time and mode
/// come too, because they move on a write or a `chmod` and never on a read, and
/// mtime alone misses two cases: `chmod +x file` shows up in `git status` while
/// touching neither mtime nor length, and a filesystem with second-granularity
/// timestamps collapses two same-length writes in the same second.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    modified: Option<SystemTime>,
    len: u64,
    /// Unix `st_ctime` and `st_ctime_nsec`; `(0, 0)` elsewhere.
    changed: (i64, i64),
    /// Unix `st_mode`; `0` elsewhere.
    mode: u32,
}

fn stamp_of(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    #[cfg(unix)]
    let (changed, mode) = {
        use std::os::unix::fs::MetadataExt as _;
        ((meta.ctime(), meta.ctime_nsec()), meta.mode())
    };
    #[cfg(not(unix))]
    let (changed, mode) = ((0, 0), 0);
    Some(Stamp {
        modified: meta.modified().ok(),
        len: meta.len(),
        changed,
        mode,
    })
}

/// Where an event's path sits relative to the watched root.
enum Mapped {
    /// The root directory itself, which every `opendir` of it reports.
    Root,
    /// A `/`-separated path below the root.
    Inside(String),
    /// Outside the root, or holding a component we cannot key a cache on.
    Unmappable,
}

/// What a single path is worth, before the cache or git is consulted.
enum Verdict {
    /// Nothing we render could have changed.
    Drop,
    /// Refresh, no question needed.
    Refresh,
    /// Refresh, and what we think is ignored may no longer be true.
    RefreshAndInvalidate,
    /// A working-tree path: only git can say.
    Ask,
}

pub struct WatchFilter {
    root: PathBuf,
    /// The canonical root, when it differs. FSEvents reports canonical paths, so
    /// a root at `/var/folders/…` (what `tempfile` hands out) receives events at
    /// `/private/var/folders/…`, and without this the filter silently strips
    /// nothing and becomes a no-op on any symlinked checkout.
    root_alt: Option<PathBuf>,
    /// Slug to "git ignores this", for files and directories alike.
    verdicts: HashMap<String, bool>,
    /// Last seen [`Stamp`] per slug, `None` for "was not there". See
    /// [`WatchFilter::changed_on_disk`]: without this, our own git reads feed the
    /// watcher that made us read.
    stamps: HashMap<String, Option<Stamp>>,
    /// Slugs `check-ignore` refuses to answer for. A submodule path is the real
    /// case: git exits 128 rather than classifying it, and re-asking every batch
    /// would be its own storm. See [`WatchFilter::query`].
    refused: HashSet<String>,
    /// How many `check-ignore` processes have been spent. The point of the cache
    /// is that this stops growing, which is a thing tests can assert with no
    /// timing at all.
    queries: u64,
}

impl WatchFilter {
    pub fn new(root: &Path) -> Self {
        let root = root.to_path_buf();
        let root_alt = root
            .canonicalize()
            .ok()
            .map(strip_verbatim)
            .filter(|canonical| *canonical != root);
        Self {
            root,
            root_alt,
            verdicts: HashMap::new(),
            stamps: HashMap::new(),
            refused: HashSet::new(),
            queries: 0,
        }
    }

    /// True when at least one of `paths` could change what the UI shows.
    pub fn should_refresh<'a, I>(&mut self, paths: I) -> bool
    where
        I: IntoIterator<Item = &'a Path>,
    {
        let mut refresh = false;
        let mut invalidate = false;
        let mut ask: Vec<String> = Vec::new();

        for path in paths {
            match self.mapped(path) {
                // The root's own event, which arrives on every `opendir` of it and
                // so on every `git status`. Gated like the rule paths: opening a
                // directory moves none of its stamp, while creating, deleting or
                // renaming an entry directly inside it moves its mtime, and
                // anything deeper arrives as its own event.
                Mapped::Root => refresh |= self.changed_on_disk(""),
                // Outside the root, or holding something a cache cannot be keyed
                // on. Not knowing means refreshing.
                Mapped::Unmappable => refresh = true,
                Mapped::Inside(slug) => match classify(&slug) {
                    Verdict::Drop => {}
                    // Both rule verdicts are gated on the file having actually
                    // moved, because our own reads reach us as events. See
                    // `changed_on_disk`.
                    Verdict::Refresh => refresh |= self.changed_on_disk(&slug),
                    Verdict::RefreshAndInvalidate => {
                        if self.changed_on_disk(&slug) {
                            refresh = true;
                            invalidate = true;
                        }
                    }
                    Verdict::Ask => ask.push(slug),
                },
            }
        }

        // `.gitignore` is answered here rather than by asking git, and answered
        // *completely*: it is a tracked file, so the ordinary path would refresh for
        // it whether or not it moved, and our own reads of it would then be a loop
        // (see `changed_on_disk`).
        let mut rest: Vec<String> = Vec::with_capacity(ask.len());
        for slug in ask {
            if basename(&slug) != ".gitignore" {
                rest.push(slug);
                continue;
            }
            // A `.gitignore` that is itself ignored does not change our rules, and
            // skipping it is load-bearing rather than a micro-optimisation: `npm
            // install` writes one into a great many packages under `node_modules/`,
            // and flushing the cache for each would be a fresh storm in the shape of
            // the one this module exists to stop. Resolved rather than merely looked
            // up, because a *cold* cache has no ancestor verdict to find, and the
            // invalidate-and-return below would then leave it cold for the next
            // batch too, forever.
            if self.resolve_ignored(&slug) {
                continue;
            }
            if self.changed_on_disk(&slug) {
                refresh = true;
                invalidate = true;
            }
        }
        let ask = rest;

        // Invalidate before the early return, so a batch holding both a real
        // change and a `.gitignore` edit cannot leave stale verdicts behind.
        if invalidate {
            self.verdicts.clear();
        }
        if refresh {
            return true;
        }

        self.any_unignored(&ask)
    }

    /// Forget every verdict. Used when the watcher reports an error, where we do
    /// not know what we missed and one of the lost events may have been a
    /// `.gitignore` write.
    pub fn invalidate(&mut self) {
        self.verdicts.clear();
    }

    /// Whether `slug` looks different on disk from the last time we looked here.
    ///
    /// This exists because **our own git reads reach us as events**, which without
    /// it makes this module a refresh loop rather than a fix for one. `notify`'s
    /// inotify mask includes `OPEN` and `ATTRIB`, so *opening* a file or directory
    /// is reported, on every Linux filesystem and regardless of `relatime`. So
    /// answering one refresh by reading `.git/index`, `.gitignore` and the working
    /// tree produced an event asking for another refresh, whose reads produced
    /// another, without end — and because `.git/config` and `.gitignore` are read
    /// too, each turn also discarded the cache that would have stopped the next.
    /// Measured at roughly seven refreshes a second on an idle three-file
    /// repository, on both tmpfs and ext4.
    ///
    /// A [`Stamp`] does not move when a file is merely opened or read, which is
    /// exactly the distinction needed. A path we have never looked at counts as
    /// changed: not knowing has to mean refresh.
    ///
    /// macOS and Windows do not report opens (FSEvents has no such event, and
    /// `notify` omits `FILE_NOTIFY_CHANGE_LAST_ACCESS`), so this is Linux-shaped in
    /// origin. It is not `cfg`-gated, because "did this file actually move" is the
    /// question worth asking everywhere, and it costs one `stat`.
    fn changed_on_disk(&mut self, slug: &str) -> bool {
        let stamp = stamp_of(&self.root.join(slug));
        if self.stamps.len() > MAX_VERDICTS {
            self.stamps.clear();
        }
        match self.stamps.entry(slug.to_string()) {
            Entry::Occupied(mut seen) => seen.insert(stamp) != stamp,
            Entry::Vacant(unseen) => {
                unseen.insert(stamp);
                true
            }
        }
    }

    /// Cache-or-ask: whether git ignores `slug`, warming the cache on the way.
    fn resolve_ignored(&mut self, slug: &str) -> bool {
        if self.has_ignored_ancestor(slug) {
            return true;
        }
        if let Some(&known) = self.verdicts.get(slug) {
            return known;
        }
        let pending: BTreeSet<String> = ancestors_and_self(slug)
            .into_iter()
            .filter(|prefix| !self.verdicts.contains_key(prefix))
            .collect();
        if !pending.is_empty() {
            self.query(pending);
        }
        self.is_ignored(slug)
    }

    /// Whether any of `slugs` is a path git would report, asking git about the
    /// ones we have no verdict for.
    fn any_unignored(&mut self, slugs: &[String]) -> bool {
        let mut leaves: Vec<&str> = Vec::new();
        let mut pending: BTreeSet<String> = BTreeSet::new();

        for slug in slugs {
            // A path git will not classify (a submodule) is a change we have to
            // assume is real, and asking again every batch would be its own storm.
            if self.refused.contains(slug.as_str()) || self.has_refused_ancestor(slug) {
                return true;
            }
            // An ancestor known to be ignored settles it. An ancestor known *not*
            // to be ignored settles nothing: `src` not being ignored says nothing
            // about `src/debug.log`.
            if self.has_ignored_ancestor(slug) {
                continue;
            }
            match self.verdicts.get(slug.as_str()) {
                Some(true) => continue,
                Some(false) => leaves.push(slug),
                None => {
                    leaves.push(slug);
                    for prefix in ancestors_and_self(slug) {
                        if !self.verdicts.contains_key(&prefix) {
                            pending.insert(prefix);
                        }
                    }
                }
            }
        }

        if leaves.is_empty() {
            return false;
        }
        if !pending.is_empty() {
            self.query(pending);
        }
        // From the leaves only. `pending` also holds ancestors like `src`, which
        // are legitimately not ignored and would force a refresh for an ignored
        // `src/debug.log`.
        //
        // A surviving leaf is stamped rather than trusted, and this is the other
        // half of the loop `changed_on_disk` closes: `git status` *opens* every
        // tracked file and directory it walks, and every one of those opens is an
        // event for a path that is, correctly, not ignored.
        let unignored: Vec<String> = leaves
            .into_iter()
            .filter(|leaf| !self.is_ignored(leaf))
            .map(str::to_string)
            .collect();
        // Every survivor is stamped, not just enough of them to answer, so a later
        // batch mentioning one of the others is not told it changed.
        let mut changed = false;
        for leaf in &unignored {
            if self.changed_on_disk(leaf) {
                changed = true;
            }
        }
        changed
    }

    /// One `check-ignore` over `pending`, recording a verdict for each.
    fn query(&mut self, pending: BTreeSet<String>) {
        // A BTreeSet, so the batch git receives is in a deterministic order and a
        // failing test reproduces.
        let slugs: Vec<String> = pending.into_iter().collect();
        match self.ask_git(&slugs) {
            Some(ignored) => self.record(&slugs, &ignored),
            // One unanswerable path must not void the verdicts of everything that
            // shared its batch: `check-ignore` exits 128 for a submodule path and
            // prints nothing useful, so a single one would otherwise send a whole
            // build directory back to refreshing. Ask again one at a time, and
            // remember the refusals so this happens once rather than every batch.
            None => {
                for slug in &slugs {
                    match self.ask_git(std::slice::from_ref(slug)) {
                        Some(ignored) => self.record(std::slice::from_ref(slug), &ignored),
                        None => {
                            self.refused.insert(slug.clone());
                        }
                    }
                }
            }
        }
    }

    fn ask_git(&mut self, slugs: &[String]) -> Option<HashSet<String>> {
        self.queries += 1;
        git::check_ignored(&self.root, slugs).ok()
    }

    fn record(&mut self, slugs: &[String], ignored: &HashSet<String>) {
        if self.verdicts.len() + slugs.len() > MAX_VERDICTS {
            self.verdicts.clear();
        }
        for slug in slugs {
            self.verdicts.insert(slug.clone(), ignored.contains(slug));
        }
    }

    fn has_refused_ancestor(&self, slug: &str) -> bool {
        if self.refused.is_empty() {
            return false;
        }
        let mut cut = slug.len();
        while let Some(separator) = slug[..cut].rfind('/') {
            if self.refused.contains(&slug[..separator]) {
                return true;
            }
            cut = separator;
        }
        false
    }

    /// A slug's own verdict wins where we have one; ancestors decide only in its
    /// absence. That ordering is what lets a force-added tracked file inside an
    /// ignored directory (`git add -f node_modules/keep.js`) refresh correctly,
    /// since `check-ignore` consults the index and answers "not ignored" for the
    /// file while still calling the directory ignored.
    fn is_ignored(&self, slug: &str) -> bool {
        match self.verdicts.get(slug) {
            Some(&ignored) => ignored,
            None => self.has_ignored_ancestor(slug),
        }
    }

    fn has_ignored_ancestor(&self, slug: &str) -> bool {
        let mut cut = slug.len();
        while let Some(separator) = slug[..cut].rfind('/') {
            if self.verdicts.get(&slug[..separator]) == Some(&true) {
                return true;
            }
            cut = separator;
        }
        false
    }

    /// `path` as a `/`-separated path relative to the root.
    fn mapped(&self, path: &Path) -> Mapped {
        let Some(relative) = self.strip(path) else {
            return Mapped::Unmappable;
        };
        let mut parts: Vec<&str> = Vec::new();
        for component in relative.components() {
            match component {
                Component::Normal(part) => match part.to_str() {
                    Some(text) => parts.push(text),
                    // Not UTF-8, so not a cache key. Safe direction: refresh.
                    None => return Mapped::Unmappable,
                },
                // A `..`, a root, a drive prefix: nothing we can reason about.
                _ => return Mapped::Unmappable,
            }
        }
        if parts.is_empty() {
            return Mapped::Root;
        }
        Mapped::Inside(parts.join("/"))
    }

    fn strip(&self, path: &Path) -> Option<PathBuf> {
        // Component-wise, never a string prefix. On Windows the root arrives from
        // `rev-parse --show-toplevel` as `C:/Users/x/repo` while notify reports
        // `C:\Users\x\repo\src\main.tsx`; `strip_prefix` compares components and
        // the Windows path parser accepts either separator, so the mismatch costs
        // nothing. A string comparison would fail on every Windows install and
        // quietly turn this whole module into a no-op.
        if let Ok(rest) = path.strip_prefix(&self.root) {
            return Some(rest.to_path_buf());
        }
        if let Some(alt) = &self.root_alt {
            if let Ok(rest) = path.strip_prefix(alt) {
                return Some(rest.to_path_buf());
            }
        }
        // Last resort, case-insensitively. APFS and NTFS are case-insensitive by
        // default and report the on-disk case, which need not match the case the
        // user typed when they opened the folder. Safe to try on every platform
        // even so: the watch is scoped to this root, so a path from some
        // differently-cased sibling directory cannot arrive here in the first
        // place. Slug case then goes to git, which handles it via
        // `core.ignoreCase`.
        strip_ignoring_case(path, &self.root)
    }

    #[cfg(test)]
    pub fn queries(&self) -> u64 {
        self.queries
    }

    #[cfg(test)]
    pub fn remembered(&self) -> usize {
        self.verdicts.len()
    }
}

/// What a slug is worth before the cache or git is consulted.
fn classify(slug: &str) -> Verdict {
    if let Some(rest) = git_dir_relative(slug) {
        return classify_git_dir(rest);
    }
    // Our own atomic-save temp file. It has to be a rule here rather than left to
    // `check-ignore`, which would correctly answer "not ignored" and hand us four
    // events per keystroke burst in the diff window. The rename *onto* the target
    // is a real change and survives, being a different path.
    if basename(slug).starts_with(SAVE_TEMP_PREFIX) {
        return Verdict::Drop;
    }
    Verdict::Ask
}

/// `Some(rest)` when `slug` is `.git` or inside it. `rest` is empty for the
/// gitdir itself.
fn git_dir_relative(slug: &str) -> Option<&str> {
    if slug == ".git" {
        return Some("");
    }
    slug.strip_prefix(".git/")
}

/// The `.git` rules. An allow-list, because a deny-list would let the next noisy
/// git internal storm us, which is the bug being fixed.
///
/// Deliberately dropped, since someone will ask:
/// - `FETCH_HEAD` is rewritten by every fetch, a no-op or `--dry-run` one
///   included; real ref movement arrives as `refs/remotes/**`.
/// - `COMMIT_EDITMSG` accompanies a commit, which also writes `index` and `HEAD`.
/// - `worktrees/**` is another worktree's state and changes nothing we render.
/// - `hooks/**`, `gc.pid`, `fsmonitor--daemon.ipc`, `index.stash`: bookkeeping.
fn classify_git_dir(rest: &str) -> Verdict {
    // The gitdir's own mtime; the child event that matters always accompanies it.
    if rest.is_empty() {
        return Verdict::Drop;
    }
    // Every lock git takes around a write whose real target is allow-listed
    // below: `index.lock`, `packed-refs.lock`, `refs/heads/main.lock`,
    // `MERGE_MSG.lock`. The last two matter most, since they would otherwise pass
    // the file and directory rules.
    if rest.ends_with(".lock") {
        return Verdict::Drop;
    }
    // Per-object and per-reflog churn: one event per blob `git add` writes,
    // thousands per fetch or gc. Matching any component also covers a submodule's
    // own gitdir at `modules/<name>/objects/…`.
    if rest
        .split('/')
        .any(|part| part == "objects" || part == "logs")
    {
        return Verdict::Drop;
    }
    // Both change what `git status` reports (`core.excludesFile` lives in
    // config), and both are written at most once per user action.
    if rest == "info/exclude" || rest == "config" {
        return Verdict::RefreshAndInvalidate;
    }
    if GIT_STATE_FILES.contains(&rest) {
        return Verdict::Refresh;
    }
    if GIT_STATE_DIRS.contains(&first_component(rest)) {
        return Verdict::Refresh;
    }
    Verdict::Drop
}

fn first_component(slug: &str) -> &str {
    slug.split('/').next().unwrap_or(slug)
}

/// Every prefix of `slug`, shortest first, then `slug` itself.
fn ancestors_and_self(slug: &str) -> Vec<String> {
    let mut out: Vec<String> = slug
        .char_indices()
        .filter(|(_, character)| *character == '/')
        .map(|(index, _)| slug[..index].to_string())
        .collect();
    out.push(slug.to_string());
    out
}

/// Component-wise strip, ignoring case. `None` when `root` is not a prefix.
fn strip_ignoring_case(path: &Path, root: &Path) -> Option<PathBuf> {
    let mut theirs = path.components();
    for ours in root.components() {
        let mine = theirs.next()?;
        if !ours
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&mine.as_os_str().to_string_lossy())
        {
            return None;
        }
    }
    Some(theirs.as_path().to_path_buf())
}

/// Windows' `canonicalize` returns a `\\?\C:\…` verbatim path, which no event
/// path will ever match. Trim it back to something comparable.
#[cfg(windows)]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|text| text.strip_prefix(r"\\?\")) {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

#[cfg(not(windows))]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrepo::{commit, git_in, repo_with_commit, write};

    /// One batch of one path under a root that is not a repository, for the rules
    /// that are decided before git is ever consulted. A rule that reaches git
    /// there gets a 128 and falls back to refreshing, so every `assert!(!…)` below
    /// is proof no question was asked.
    fn refreshes(slug: &str) -> bool {
        let path = Path::new("/repo").join(slug);
        WatchFilter::new(Path::new("/repo")).should_refresh([path.as_path()])
    }

    /// A repo whose `.gitignore` is committed, so nothing in the tree is dirty and
    /// the ignore rules are in force.
    ///
    /// `directories` are created on disk, which is load-bearing rather than
    /// tidiness: a `dir/` pattern only matches something git can see *is* a
    /// directory, so `check-ignore` answers "not ignored" for a path that does not
    /// exist. Real churn always comes from a directory that exists.
    fn repo_ignoring(patterns: &str, directories: &[&str]) -> tempfile::TempDir {
        let dir = repo_with_commit("file.txt", "one\n");
        write(dir.path(), ".gitignore", patterns);
        git_in(dir.path(), &["add", ".gitignore"]);
        commit(dir.path(), "ignore rules");
        for name in directories {
            std::fs::create_dir_all(dir.path().join(name)).expect("create dir");
        }
        dir
    }

    fn batch(dir: &Path, slugs: &[&str]) -> Vec<PathBuf> {
        slugs.iter().map(|slug| dir.join(slug)).collect()
    }

    fn sees(filter: &mut WatchFilter, dir: &Path, slugs: &[&str]) -> bool {
        let paths = batch(dir, slugs);
        filter.should_refresh(paths.iter().map(|path| path.as_path()))
    }

    #[test]
    fn a_git_index_write_refreshes() {
        // Staging, committing, checking out: the single most important event kind,
        // and it costs no subprocess because the pure rules settle it.
        assert!(refreshes(".git/index"));
    }

    #[test]
    fn the_git_state_files_refresh() {
        for state in [
            "index",
            "HEAD",
            "ORIG_HEAD",
            "MERGE_HEAD",
            "MERGE_MSG",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "BISECT_LOG",
            "packed-refs",
            "shallow",
            // Carries the branch panel's "fetched N minutes ago" and nothing else.
            "FETCH_HEAD",
            "refs/heads/main",
            "reftable/tables.list",
            "refs/remotes/origin/main",
            "rebase-merge/msgnum",
            "rebase-apply/next",
            "sequencer/todo",
        ] {
            assert!(
                refreshes(&format!(".git/{state}")),
                ".git/{state} must refresh"
            );
        }
    }

    #[test]
    fn git_lock_files_are_dropped() {
        // The last two would otherwise pass the state-file and state-directory
        // rules, which is why the lock rule comes first.
        for lock in [
            "index.lock",
            "packed-refs.lock",
            "refs/heads/main.lock",
            "MERGE_MSG.lock",
        ] {
            assert!(
                !refreshes(&format!(".git/{lock}")),
                ".git/{lock} must be dropped"
            );
        }
    }

    #[test]
    fn git_object_and_reflog_churn_is_dropped() {
        // One event per blob written, thousands per fetch.
        for churn in [
            "objects/ab/cdef0123",
            "objects/pack/tmp_pack_abc",
            "logs/HEAD",
            "logs/refs/heads/main",
            "modules/sub/objects/ab/cd",
        ] {
            assert!(
                !refreshes(&format!(".git/{churn}")),
                ".git/{churn} must be dropped"
            );
        }
    }

    #[test]
    fn unknown_git_internals_are_dropped() {
        // This test *is* the record of the allow-list decision. FETCH_HEAD is
        // rewritten by every fetch including a no-op one; COMMIT_EDITMSG comes
        // with an index and HEAD write anyway; the rest is bookkeeping.
        for internal in [
            "COMMIT_EDITMSG",
            "gc.pid",
            "fsmonitor--daemon.ipc",
            "worktrees/other/index",
            "hooks/pre-commit",
        ] {
            assert!(
                !refreshes(&format!(".git/{internal}")),
                ".git/{internal} must be dropped"
            );
        }
    }

    #[test]
    fn the_git_directory_itself_is_dropped() {
        assert!(!refreshes(".git"));
    }

    #[test]
    fn our_own_save_temp_files_are_dropped() {
        // Four events per keystroke burst in the diff window, on a path nobody
        // asked about. Nothing in a user's .gitignore would cover it.
        assert!(!refreshes(".isabuild-save-Ab12cd"));
        assert!(!refreshes("src/deep/.isabuild-save-Ab12cd"));
    }

    #[test]
    fn the_root_itself_refreshes() {
        // Not droppable: we cannot tell what inside it moved.
        assert!(WatchFilter::new(Path::new("/repo")).should_refresh([Path::new("/repo")]));
    }

    #[test]
    fn a_path_outside_the_root_refreshes() {
        assert!(WatchFilter::new(Path::new("/repo")).should_refresh([Path::new("/elsewhere/x")]));
    }

    #[test]
    fn a_root_reported_in_a_different_case_still_strips() {
        // What macOS and Windows can hand us. Failing to strip is safe (it
        // refreshes) but would make the filter a no-op, so it is worth pinning.
        let mut filter = WatchFilter::new(Path::new("/Repo"));
        assert!(!filter.should_refresh([Path::new("/repo/.git/objects/ab/cd")]));
    }

    #[cfg(unix)]
    #[test]
    fn a_non_utf8_path_refreshes() {
        // No slug means no cache key and no question to ask, so it has to refresh.
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt as _;
        let raw = OsStr::from_bytes(b"/repo/caf\xFF");
        assert!(WatchFilter::new(Path::new("/repo")).should_refresh([Path::new(raw)]));
    }

    #[test]
    fn an_ignored_directory_is_dropped() {
        let dir = repo_ignoring("ignored/\n", &["ignored/deep"]);
        let mut filter = WatchFilter::new(dir.path());
        assert!(!sees(&mut filter, dir.path(), &["ignored/deep/file.txt"]));
    }

    #[test]
    fn a_tracked_file_refreshes() {
        let dir = repo_ignoring("ignored/\n", &[]);
        let mut filter = WatchFilter::new(dir.path());
        assert!(sees(&mut filter, dir.path(), &["file.txt"]));
    }

    #[test]
    fn an_ignored_pattern_is_dropped_while_its_sibling_refreshes() {
        // Also proves an ancestor known *not* to be ignored decides nothing on its
        // own: `src` is fine, which says nothing about `src/debug.log`.
        let dir = repo_ignoring("*.log\n", &["src"]);
        let mut filter = WatchFilter::new(dir.path());
        assert!(!sees(&mut filter, dir.path(), &["src/debug.log"]));
        assert!(sees(&mut filter, dir.path(), &["src/notes.txt"]));
    }

    #[test]
    fn one_relevant_path_in_a_batch_is_enough() {
        let dir = repo_ignoring("ignored/\n", &["ignored"]);
        let mut filter = WatchFilter::new(dir.path());
        assert!(sees(
            &mut filter,
            dir.path(),
            &["ignored/a", "ignored/b", "file.txt"]
        ));
    }

    #[test]
    fn the_cache_answers_later_batches_without_asking_git() {
        // The regression test for the strobe, and it needs no timing at all: an
        // AnyContinuous re-emission every ~300 ms for a path under an ignored
        // directory has to cost nothing, forever.
        let dir = repo_ignoring("ignored/\n", &["ignored"]);
        let mut filter = WatchFilter::new(dir.path());

        assert!(!sees(&mut filter, dir.path(), &["ignored/a"]));
        assert_eq!(filter.queries(), 1);

        for _ in 0..20 {
            assert!(!sees(&mut filter, dir.path(), &["ignored/b/c/d"]));
        }
        assert_eq!(filter.queries(), 1, "the cache must serve these for free");
    }

    #[test]
    fn a_batch_carrying_git_index_costs_no_subprocess() {
        // Pass 3 returning before pass 5 is what buys this: staging a file in the
        // terminal refreshes without a single question, however much build churn
        // arrives in the same batch.
        let dir = repo_ignoring("ignored/\n", &["ignored"]);
        let mut filter = WatchFilter::new(dir.path());
        assert!(sees(&mut filter, dir.path(), &["ignored/a", ".git/index"]));
        assert_eq!(filter.queries(), 0);
    }

    #[test]
    fn editing_gitignore_invalidates_the_cache() {
        let dir = repo_ignoring("ignored/\n", &["ignored"]);
        let mut filter = WatchFilter::new(dir.path());
        assert!(!sees(&mut filter, dir.path(), &["ignored/a"]));
        let warm = filter.queries();

        // Stop ignoring it, and tell the filter the file changed.
        write(dir.path(), ".gitignore", "# nothing ignored now\n");
        assert!(sees(&mut filter, dir.path(), &[".gitignore"]));

        assert!(sees(&mut filter, dir.path(), &["ignored/a"]));
        assert!(filter.queries() > warm, "the verdict must be asked again");
    }

    #[test]
    fn a_gitignore_inside_an_ignored_directory_does_not_invalidate() {
        // npm install writes one of these into a great many packages. Flushing on
        // each would be a fresh storm in the shape of the one being fixed.
        let dir = repo_ignoring("node_modules/\n", &["node_modules/pkg"]);
        let mut filter = WatchFilter::new(dir.path());
        assert!(!sees(
            &mut filter,
            dir.path(),
            &["node_modules/pkg/index.js"]
        ));
        let warm = filter.queries();

        assert!(!sees(
            &mut filter,
            dir.path(),
            &["node_modules/pkg/.gitignore"]
        ));

        assert_eq!(filter.queries(), warm, "no question, and nothing discarded");
        assert!(!sees(
            &mut filter,
            dir.path(),
            &["node_modules/pkg/other.js"]
        ));
        assert_eq!(filter.queries(), warm);
    }

    #[test]
    fn the_info_exclude_file_refreshes_and_invalidates() {
        let dir = repo_ignoring("ignored/\n", &["ignored"]);
        let mut filter = WatchFilter::new(dir.path());
        assert!(!sees(&mut filter, dir.path(), &["ignored/a"]));

        assert!(sees(&mut filter, dir.path(), &[".git/info/exclude"]));

        assert_eq!(filter.remembered(), 0, "verdicts must have been discarded");
    }

    #[test]
    fn a_git_config_write_refreshes_and_invalidates() {
        // core.excludesFile lives in config, so it changes ignore answers.
        let dir = repo_ignoring("ignored/\n", &["ignored"]);
        let mut filter = WatchFilter::new(dir.path());
        assert!(!sees(&mut filter, dir.path(), &["ignored/a"]));

        assert!(sees(&mut filter, dir.path(), &[".git/config"]));

        assert_eq!(filter.remembered(), 0);
    }

    #[test]
    fn a_read_is_not_a_change() {
        // The feedback loop this filter would otherwise create: our own
        // `check-ignore` reads `.git/index`, `.git/config` and `.gitignore`, and
        // where atimes are strict (tmpfs without relatime, which is where these
        // tests run) that read is itself an event, asking for the refresh whose read
        // asks again. Comparing mtime and length is what tells the two apart.
        let dir = repo_ignoring("ignored/\n", &["ignored"]);
        let mut filter = WatchFilter::new(dir.path());

        // A first sighting always refreshes: there is nothing to compare against.
        assert!(sees(&mut filter, dir.path(), &[".git/MERGE_MSG"]));

        write(dir.path(), ".git/MERGE_MSG", "merging\n");
        assert!(sees(&mut filter, dir.path(), &[".git/MERGE_MSG"]));

        std::fs::read(dir.path().join(".git/MERGE_MSG")).expect("read");
        assert!(!sees(&mut filter, dir.path(), &[".git/MERGE_MSG"]));
    }

    #[test]
    fn reading_gitignore_does_not_discard_the_cache() {
        // The half of the loop that made it self-sustaining: each turn flushed the
        // verdicts that would have stopped the next one.
        let dir = repo_ignoring("ignored/\n", &["ignored"]);
        let mut filter = WatchFilter::new(dir.path());
        assert!(sees(&mut filter, dir.path(), &[".gitignore"])); // first sighting
        assert!(!sees(&mut filter, dir.path(), &["ignored/a"])); // warms the cache

        // Unchanged, so neither a refresh nor a flush.
        assert!(!sees(&mut filter, dir.path(), &[".gitignore"]));

        // Baseline taken after that, so this measures the one thing at issue:
        // whether the verdicts survived it.
        let warm = filter.queries();
        assert!(!sees(&mut filter, dir.path(), &["ignored/b"]));
        assert_eq!(filter.queries(), warm, "the cache must have survived");
    }

    #[test]
    fn nested_gitignores_do_not_storm_on_a_cold_cache() {
        // `npm install` writes a `.gitignore` into a great many packages. On a cold
        // cache the ancestor guard has nothing to find, and the invalidate-and-return
        // would leave it cold for the next batch too: one refresh per debounce window
        // for the whole install, never self-healing. Resolving the path instead means
        // one question, then silence.
        let dir = repo_ignoring(
            "node_modules/\n",
            &["node_modules/a", "node_modules/b", "node_modules/c"],
        );
        let mut filter = WatchFilter::new(dir.path());

        for package in ["a", "b", "c"] {
            let slug = format!("node_modules/{package}/.gitignore");
            assert!(
                !sees(&mut filter, dir.path(), &[&slug]),
                "{slug} must not refresh"
            );
        }
        assert_eq!(filter.queries(), 1, "one question for the whole install");
    }

    #[test]
    fn a_path_git_refuses_to_classify_is_asked_about_once() {
        // `check-ignore` exits 128 for a submodule path rather than classifying it.
        // Refreshing is right (`status` does report submodule changes); asking again
        // every batch is not, and it must not take the rest of the batch's verdicts
        // down with it.
        let dir = repo_ignoring("ignored/\n", &["ignored"]);
        let inner = repo_with_commit("inner.txt", "one\n");
        git_in(
            dir.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                &inner.path().to_string_lossy(),
                "sub",
            ],
        );
        commit(dir.path(), "add submodule");
        let mut filter = WatchFilter::new(dir.path());

        assert!(sees(&mut filter, dir.path(), &["sub/inner.txt"]));
        let asked = filter.queries();
        assert!(sees(&mut filter, dir.path(), &["sub/inner.txt"]));
        assert_eq!(filter.queries(), asked, "a refusal must be remembered");

        // And a batch that shared the refusal still gets its own verdicts.
        assert!(!sees(&mut filter, dir.path(), &["ignored/a"]));
    }

    #[test]
    fn a_question_git_cannot_answer_falls_back_to_refreshing() {
        // Not a repository, so check-ignore exits 128. Not knowing has to mean
        // refresh: a missed refresh is a silently wrong sidebar with no way for the
        // user to force an update.
        let dir = tempfile::tempdir().expect("temp dir");
        let mut filter = WatchFilter::new(dir.path());
        assert!(sees(&mut filter, dir.path(), &["anything.txt"]));
    }

    #[test]
    fn the_cache_is_discarded_once_it_grows_past_the_cap() {
        let dir = repo_ignoring("ignored/\n", &["ignored"]);
        let mut filter = WatchFilter::new(dir.path());
        assert!(!sees(&mut filter, dir.path(), &["ignored/a"]));
        let warm = filter.queries();

        // One batch bigger than the cap on its own. Flat names, so each contributes
        // exactly one slug.
        let names: Vec<String> = (0..=MAX_VERDICTS)
            .map(|index| format!("d{index}"))
            .collect();
        let paths: Vec<PathBuf> = names.iter().map(|name| dir.path().join(name)).collect();
        filter.should_refresh(paths.iter().map(|path| path.as_path()));

        // The earlier verdict went with the flush, so it has to be asked again.
        assert!(!sees(&mut filter, dir.path(), &["ignored/a"]));
        assert!(filter.queries() > warm + 1);
    }

    /// `repo_ignoring`, plus a tracked file forced in under the ignored directory.
    fn repo_with_force_added_file() -> tempfile::TempDir {
        let dir = repo_ignoring("ignored/\n", &["ignored"]);
        write(dir.path(), "ignored/keep.txt", "one\n");
        git_in(dir.path(), &["add", "-f", "ignored/keep.txt"]);
        commit(dir.path(), "force add");
        dir
    }

    #[test]
    fn a_force_added_file_under_an_ignored_directory_refreshes() {
        // `git add -f ignored/keep.txt`: `status` reports changes to it, so we must
        // too. This works for a better reason than the leaf-beats-ancestor rule:
        // git declines to call a directory ignored at all once it holds tracked
        // content, so the ancestor short-circuit never arms here. Its ignored
        // siblings are still reported individually, which is where the saving is.
        let dir = repo_with_force_added_file();
        let mut filter = WatchFilter::new(dir.path());

        write(dir.path(), "ignored/keep.txt", "two\n");
        assert!(sees(&mut filter, dir.path(), &["ignored/keep.txt"]));
        assert!(!sees(&mut filter, dir.path(), &["ignored/scratch.tmp"]));
    }

    #[test]
    fn a_directory_holding_tracked_content_is_not_cached_as_ignored() {
        // The mechanism behind the test above, pinned on its own so a future
        // "optimisation" that assumes a `dir/` pattern means the whole subtree is
        // droppable has something to fail against.
        let dir = repo_with_force_added_file();
        let ignored = git::check_ignored(
            dir.path(),
            &[
                "ignored".to_string(),
                "ignored/keep.txt".to_string(),
                "ignored/scratch.tmp".to_string(),
            ],
        )
        .expect("check-ignore answers");

        assert!(!ignored.contains("ignored"));
        assert!(!ignored.contains("ignored/keep.txt"));
        assert!(ignored.contains("ignored/scratch.tmp"));
    }

    #[test]
    fn a_file_force_added_after_its_directory_was_cached_is_missed_until_a_flush() {
        // The residual compromise, and the only one: the `git add -f` itself
        // refreshes, because it writes `.git/index`. But the cached "this directory
        // is ignored" verdict is now stale, so *later* edits to the new file are
        // dropped until something invalidates. Narrow, self-correcting at the next
        // .gitignore edit or project switch, and written down so nobody removes the
        // ancestor short-circuit the storm fix depends on without knowing the cost.
        let dir = repo_ignoring("ignored/\n", &["ignored"]);
        let mut filter = WatchFilter::new(dir.path());
        assert!(!sees(&mut filter, dir.path(), &["ignored/scratch.tmp"]));

        write(dir.path(), "ignored/keep.txt", "one\n");
        git_in(dir.path(), &["add", "-f", "ignored/keep.txt"]);
        // Seen, because staging writes the index.
        assert!(sees(&mut filter, dir.path(), &[".git/index"]));

        write(dir.path(), "ignored/keep.txt", "two\n");
        assert!(!sees(&mut filter, dir.path(), &["ignored/keep.txt"]));
        // Even though git does report it.
        assert!(!crate::testrepo::porcelain(dir.path()).is_empty());

        // A flush is all it takes to agree with git again.
        filter.invalidate();
        assert!(sees(&mut filter, dir.path(), &["ignored/keep.txt"]));
    }
}
