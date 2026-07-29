//! Which directories the OS is asked to watch, and the bookkeeping that keeps
//! that set right as the tree changes.
//!
//! [`crate::watchfilter`] decides which *events* are worth a refresh. This decides
//! which events are ever produced, and the two use the same verdicts: a recursive
//! watch spends one inotify watch per directory (`notify`'s inotify backend walks
//! the tree with `WalkDir` to arm it), so in this checkout 4,419 watches were held
//! to observe the 32 directories whose events survive the filter. That is
//! invisible against the usual 524,288 limit and fatal against the old 8,192
//! default, where a large monorepo exhausts the budget and the sidebar freezes
//! with no way for the user to notice or force an update.
//!
//! So the watch is assembled a directory at a time: walk the tree, ask the filter
//! which directories survive, arm those, and add or drop watches as directories
//! appear and disappear. Three properties are worth stating because they are the
//! whole design:
//!
//! **One question per level, not per directory.** A level's directories go to
//! `watchable_dirs` in one batch, which is one `check-ignore`. The verdicts it
//! caches are the same ones `should_refresh` would have paid for later, which is
//! why this also retires the arming replay: a recursive watch reports every path
//! it discovers as a synthetic event, so opening a project used to spend a burst
//! of batches learning what the walk now records as it goes.
//!
//! **A directory nobody watches costs nothing, including its children.** Pruning
//! `node_modules` prunes everything under it in the same breath — no walk, no
//! watch, no events, ever. The same goes for `.git/objects` and `.git/logs`,
//! which are 255 of the 264 directories under `.git` here.
//!
//! **What is not watched cannot be seen.** Two consequences are handled rather
//! than accepted. A directory created inside a watched one arrives as an event,
//! but its own contents may be created before we can arm it — hence [`sweep`],
//! which re-reads a subtree *after* it is armed rather than trusting the read
//! that planned it. And a `git add -f` puts a path git reports inside a directory
//! git ignores, so [`WatchTree::forced_changed`] asks for those by name and the
//! walk keeps a watch on the way to each one.
//!
//! Deliberately free of `notify`: this module decides and the caller arms, which
//! is what lets every rule here be tested against a real repository with no
//! watcher, no threads and no timing.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::git;
use crate::watchfilter::WatchFilter;

/// What the watch set should become.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    /// Directories to arm, parents before children.
    pub add: Vec<PathBuf>,
    /// Directories to release: gone from disk, or newly ignored.
    pub remove: Vec<PathBuf>,
}

/// What a re-read of a freshly armed subtree turned up.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Sweep {
    /// Whether any of it is worth telling the UI about.
    pub refresh: bool,
    /// Directories that appeared in the arm gap and hold no watch of their own,
    /// so nothing inside them can be reported until they get one.
    pub unwatched: Vec<PathBuf>,
}

/// What one pass of the walk saw.
#[derive(Debug, Default)]
struct Walked {
    /// Directories worth watching, parents before children.
    found: Vec<PathBuf>,
    /// Directories the walk could not read, whose contents are therefore unknown
    /// rather than absent. See the filter on `remove` in [`WatchTree::plan`].
    unreadable: Vec<PathBuf>,
}

/// The directories currently watched, and the walk that decides them.
pub struct WatchTree {
    root: PathBuf,
    watched: HashSet<PathBuf>,
    /// Tracked files the ignore rules would otherwise hide, as of the last ask.
    /// See [`WatchTree::forced_changed`].
    forced: Vec<String>,
}

impl WatchTree {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            watched: HashSet::new(),
            forced: Vec::new(),
        }
    }

    /// Walk the whole tree and diff it against what is watched now.
    ///
    /// Used both to arm a project and to re-plan after the ignore rules move
    /// (`WatchFilter::generation`), which is not an optimisation: un-ignoring
    /// `build/` has to start watching it, and ignoring it has to stop.
    ///
    /// Files met on the way are primed rather than reported. The project is
    /// opening — or has just refreshed for the `.gitignore` write that brought us
    /// here — and the frontend reads on mount regardless, so the useful thing is
    /// for the first `git status` after this not to read its own `OPEN` events
    /// back as writes.
    pub fn plan(&mut self, filter: &mut WatchFilter) -> Plan {
        let walked = self.walk(&self.root.clone(), String::new(), filter, true);
        let mut found = walked.found;
        found.extend(self.paths_to_forced_files());

        let seen: HashSet<&PathBuf> = found.iter().collect();
        let remove: Vec<PathBuf> = self
            .watched
            .iter()
            .filter(|dir| !seen.contains(*dir))
            // A directory the walk could not read keeps everything under it. The
            // failure is usually transient — EMFILE or ENFILE, under exactly the
            // resource pressure this module exists to relieve — and "I could not
            // look" must not be read as "it is gone", which would tear down a live
            // subtree's watches with nothing scheduled to put them back.
            .filter(|dir| !walked.unreadable.iter().any(|bad| dir.starts_with(bad)))
            .cloned()
            .collect();
        let add: Vec<PathBuf> = found
            .into_iter()
            .filter(|dir| !self.watched.contains(dir))
            .collect();
        Plan { add, remove }
    }

    /// Plan for a subtree that has just appeared, adding only.
    ///
    /// A directory created inside a watched one is reported to us, but nothing
    /// below it is: `notify` only auto-arms a new subdirectory when its parent's
    /// watch is recursive, and ours are not. So `mkdir -p a/b/c` reaches us as one
    /// event for `a`, and `b` and `c` are ours to find.
    pub fn discover(&mut self, dir: &Path, filter: &mut WatchFilter) -> Plan {
        let Some(slug) = self.slug_of(dir) else {
            return Plan::default();
        };
        // The directory itself has to clear the filter too — `cargo build`
        // recreating `target/` arrives here exactly like a source directory does,
        // and costs the one question that then settles its whole subtree for good.
        if filter
            .watchable_dirs(std::slice::from_ref(&slug))
            .is_empty()
        {
            return Plan::default();
        }
        let mut add = vec![dir.to_path_buf()];
        add.extend(self.walk(dir, slug, filter, false).found);
        add.retain(|found| !self.watched.contains(found));
        Plan {
            add,
            remove: Vec::new(),
        }
    }

    /// Read `dirs` again, now that they are armed, and hand everything in them to
    /// the filter.
    ///
    /// This is the race the roadmap named, and the reason a second read is worth
    /// its syscalls: between the read that planned a directory and the watch
    /// landing on it, anything created inside is invisible to both — too late for
    /// the plan, too early for an event. Re-reading after arming closes that
    /// window, because from the moment the watch exists every further change is an
    /// event.
    ///
    /// Reported rather than primed: a subtree that has just appeared is new
    /// content by definition, and somebody is waiting to be told about it.
    ///
    /// A *directory* found in that window needs the same treatment recursively —
    /// it has no watch either, so nothing inside it will ever be reported — so it
    /// is handed back rather than merely counted. Closing the window for files and
    /// not for directories would leave whole subtrees invisible, which is the
    /// failure this is here to prevent.
    pub fn sweep(&self, dirs: &[PathBuf], filter: &mut WatchFilter) -> Sweep {
        let mut swept = Sweep::default();
        for dir in dirs {
            let Ok(entries) = std::fs::read_dir(dir) else {
                continue; // vanished again already, which is not our problem
            };
            let mut paths: Vec<PathBuf> = Vec::new();
            for entry in entries.flatten() {
                let path = entry.path();
                if entry.file_type().is_ok_and(|kind| kind.is_dir())
                    && !self.watched.contains(&path)
                {
                    swept.unwatched.push(path.clone());
                }
                paths.push(path);
            }
            if filter.should_refresh(paths.iter().map(PathBuf::as_path)) {
                swept.refresh = true;
            }
        }
        swept
    }

    /// Whether the set of tracked-but-ignored files has moved since the last ask.
    ///
    /// Called when an index write goes past, which is what a `git add -f` always
    /// produces. A `true` obliges the caller to invalidate the filter as well as
    /// re-plan: the cached "this directory is ignored" verdict that let us skip
    /// the directory is the same verdict that would now drop the events from the
    /// file inside it that git has started reporting.
    ///
    /// A repository we cannot ask reads as "no forced files", which is what an
    /// unreadable answer should mean here: it removes watches rather than
    /// inventing them, and the next successful ask puts them back.
    pub fn forced_changed(&mut self) -> bool {
        let current = git::tracked_ignored(&self.root).unwrap_or_default();
        if current == self.forced {
            return false;
        }
        self.forced = current;
        true
    }

    /// Record that `dir` is now watched. Only the caller knows whether arming
    /// actually succeeded, so only the caller can say.
    pub fn armed(&mut self, dir: &Path) {
        self.watched.insert(dir.to_path_buf());
    }

    /// Record that `dir` is no longer watched.
    ///
    /// Also the right response to a watched directory disappearing: `notify` has
    /// already released the kernel watch, but a stale entry here would stop us
    /// re-arming the directory if it were recreated under the same name.
    pub fn released(&mut self, dir: &Path) {
        self.watched.remove(dir);
    }

    pub fn is_watched(&self, dir: &Path) -> bool {
        self.watched.contains(dir)
    }

    pub fn watched(&self) -> usize {
        self.watched.len()
    }

    /// `path` as a `/`-separated slug below the root, or `None` when it is the
    /// root itself, outside it, or not something a verdict can be keyed on.
    pub fn slug_of(&self, path: &Path) -> Option<String> {
        let relative = path.strip_prefix(&self.root).ok()?;
        let mut parts: Vec<&str> = Vec::new();
        for component in relative.components() {
            match component {
                std::path::Component::Normal(part) => parts.push(part.to_str()?),
                _ => return None,
            }
        }
        if parts.is_empty() {
            return None;
        }
        Some(parts.join("/"))
    }

    /// Breadth-first from `from`, returning the directories worth watching below
    /// it, parents before children. `from` itself is included only when it is the
    /// root, which is always watched: it is how a new top-level directory, and any
    /// change to a file directly in it, is ever seen.
    fn walk(
        &self,
        from: &Path,
        from_slug: String,
        filter: &mut WatchFilter,
        prime: bool,
    ) -> Walked {
        let mut walked = Walked::default();
        if from_slug.is_empty() {
            walked.found.push(from.to_path_buf());
        }
        let mut level: Vec<(PathBuf, String)> = vec![(from.to_path_buf(), from_slug)];

        while !level.is_empty() {
            let mut candidates: Vec<(PathBuf, String)> = Vec::new();
            let mut files: Vec<PathBuf> = Vec::new();

            for (dir, slug) in level.drain(..) {
                // A directory that vanished mid-walk, or one we may not read, is
                // skipped rather than fatal: this runs against a tree the user's
                // build tools are writing to. Recorded, though, because "I could
                // not look" and "it is gone" have to be told apart by the caller.
                let Ok(entries) = std::fs::read_dir(&dir) else {
                    walked.unreadable.push(dir);
                    continue;
                };
                for entry in entries.flatten() {
                    // `file_type` does not follow symlinks, so a link to a
                    // directory is a file here. Deliberate, and it matches
                    // `notify`, which is configured not to follow either: a
                    // followed link is how a walk finds a cycle, or wanders into a
                    // tree that has nothing to do with this repository.
                    let Ok(kind) = entry.file_type() else {
                        continue;
                    };
                    let path = entry.path();
                    if !kind.is_dir() {
                        files.push(path);
                        continue;
                    }
                    match entry.file_name().to_str() {
                        Some(name) => {
                            let child = if slug.is_empty() {
                                name.to_string()
                            } else {
                                format!("{slug}/{name}")
                            };
                            candidates.push((path, child));
                        }
                        // Not UTF-8, so nothing a verdict can be keyed on. Watch
                        // it without asking: not knowing means watching, for the
                        // same reason it means refreshing. Its children cannot be
                        // keyed either, so this stops here.
                        None => walked.found.push(path),
                    }
                }
            }

            if prime {
                filter.prime(files.iter().map(PathBuf::as_path));
            }

            // One `check-ignore` for the level.
            let slugs: Vec<String> = candidates.iter().map(|(_, slug)| slug.clone()).collect();
            let kept: HashSet<String> = filter.watchable_dirs(&slugs).into_iter().collect();
            for (path, slug) in candidates {
                if kept.contains(&slug) {
                    if prime {
                        filter.prime([path.as_path()]);
                    }
                    walked.found.push(path.clone());
                    level.push((path, slug));
                }
            }
        }
        walked
    }

    /// Every directory on the way to a tracked-but-ignored file.
    ///
    /// The walk skipped these, correctly — they are ignored — but a `git add -f
    /// node_modules/keep.js` leaves one path inside that git does report, and an
    /// unwatched directory produces no events at all. Only the chain, never a
    /// sibling: watching `node_modules` itself costs the events of its direct
    /// children, which the filter then drops, and watching its three thousand
    /// subdirectories is exactly what this module exists to avoid.
    fn paths_to_forced_files(&self) -> Vec<PathBuf> {
        let mut chains: Vec<PathBuf> = Vec::new();
        let mut seen: HashSet<PathBuf> = HashSet::new();
        for slug in &self.forced {
            let mut prefix = self.root.clone();
            // The last component is the file itself, which needs no watch.
            let parts: Vec<&str> = slug.split('/').collect();
            for part in &parts[..parts.len().saturating_sub(1)] {
                prefix = prefix.join(part);
                if prefix.is_dir() && seen.insert(prefix.clone()) {
                    chains.push(prefix.clone());
                }
            }
        }
        chains
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrepo::{commit, git_in, repo_with_commit, write};

    /// A repo with the usual suspects ignored and present on disk, plus a couple
    /// of real source directories. A `dir/` pattern only matches something git can
    /// see *is* a directory, so creating them is load-bearing.
    fn repo() -> tempfile::TempDir {
        let dir = repo_with_commit("file.txt", "one\n");
        write(dir.path(), ".gitignore", "node_modules/\ntarget/\n*.log\n");
        git_in(dir.path(), &["add", ".gitignore"]);
        commit(dir.path(), "ignore rules");
        for path in [
            "src/lib",
            "src-tauri/src",
            "node_modules/pkg/deep",
            "target/debug/build",
        ] {
            std::fs::create_dir_all(dir.path().join(path)).expect("create dir");
        }
        dir
    }

    /// Plan, then accept every addition, as the watcher does when arming succeeds.
    fn arm(tree: &mut WatchTree, filter: &mut WatchFilter) -> Plan {
        let plan = tree.plan(filter);
        for dir in &plan.add {
            tree.armed(dir);
        }
        for dir in &plan.remove {
            tree.released(dir);
        }
        plan
    }

    /// Additions as slugs, sorted, so an assertion reads as the set it is.
    fn slugs(tree: &WatchTree, dirs: &[PathBuf]) -> Vec<String> {
        let mut out: Vec<String> = dirs
            .iter()
            .map(|dir| tree.slug_of(dir).unwrap_or_else(|| ".".to_string()))
            .collect();
        out.sort();
        out
    }

    #[test]
    fn the_walk_keeps_the_source_tree_and_prunes_what_git_ignores() {
        let dir = repo();
        let mut filter = WatchFilter::new(dir.path());
        let mut tree = WatchTree::new(dir.path());

        let plan = arm(&mut tree, &mut filter);

        assert_eq!(
            slugs(&tree, &plan.add),
            vec![
                ".",
                ".git",
                ".git/info",
                ".git/refs",
                ".git/refs/heads",
                ".git/refs/tags",
                "src",
                "src-tauri",
                "src-tauri/src",
                "src/lib",
            ]
        );
        // Not one watch spent below an ignored directory, and none spent walking
        // into it either.
        for pruned in ["node_modules", "target", ".git/objects", ".git/logs"] {
            assert!(
                !tree.is_watched(&dir.path().join(pruned)),
                "{pruned} must not be watched"
            );
        }
    }

    #[test]
    fn the_walk_costs_one_question_per_level() {
        // The arming replay, folded in and asserted with no timing at all. Four
        // levels hold a directory to ask about here: the root, `src` + `src-tauri`
        // + `.git`'s children, then `src/lib` + `src-tauri/src`'s level, then the
        // level below that, which is empty of anything git is asked about.
        let dir = repo();
        let mut filter = WatchFilter::new(dir.path());
        let mut tree = WatchTree::new(dir.path());

        arm(&mut tree, &mut filter);
        let asked = filter.queries();
        assert!(
            (1..=4).contains(&asked),
            "one check-ignore per level of the tree, not per directory; spent {asked}"
        );

        // And the second walk is free, because the first one warmed the cache the
        // filter would otherwise have paid for during the replay.
        let plan = arm(&mut tree, &mut filter);
        assert_eq!(plan, Plan::default(), "nothing moved, nothing to change");
        assert_eq!(filter.queries(), asked);
    }

    #[test]
    fn the_gitdir_keeps_only_what_the_filter_acts_on() {
        // Where the bulk of the saving is. `objects` alone is 256 fanout
        // directories plus `pack` in a repo of any age.
        let dir = repo();
        std::fs::create_dir_all(dir.path().join(".git/objects/ab")).expect("create dir");
        std::fs::create_dir_all(dir.path().join(".git/logs/refs/heads")).expect("create dir");
        std::fs::create_dir_all(dir.path().join(".git/refs/heads/feature")).expect("create dir");

        let mut filter = WatchFilter::new(dir.path());
        let mut tree = WatchTree::new(dir.path());
        arm(&mut tree, &mut filter);

        for kept in [".git", ".git/info", ".git/refs", ".git/refs/heads/feature"] {
            assert!(
                tree.is_watched(&dir.path().join(kept)),
                "{kept} must be watched"
            );
        }
        for pruned in [
            ".git/objects",
            ".git/objects/ab",
            ".git/logs",
            ".git/logs/refs/heads",
            ".git/hooks",
        ] {
            assert!(
                !tree.is_watched(&dir.path().join(pruned)),
                "{pruned} must not be watched"
            );
        }
    }

    #[test]
    fn a_nested_ignore_deep_in_the_tree_is_pruned() {
        let dir = repo();
        write(dir.path(), "src/lib/.gitignore", "cache/\n");
        std::fs::create_dir_all(dir.path().join("src/lib/cache/inner")).expect("create dir");
        std::fs::create_dir_all(dir.path().join("src/lib/real")).expect("create dir");

        let mut filter = WatchFilter::new(dir.path());
        let mut tree = WatchTree::new(dir.path());
        arm(&mut tree, &mut filter);

        assert!(tree.is_watched(&dir.path().join("src/lib/real")));
        assert!(!tree.is_watched(&dir.path().join("src/lib/cache")));
        assert!(!tree.is_watched(&dir.path().join("src/lib/cache/inner")));
    }

    #[test]
    fn a_symlinked_directory_is_not_followed() {
        // A followed link is how a walk finds a cycle, and `notify` would not
        // follow it either.
        let dir = repo();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path().join("src"), dir.path().join("link"))
            .expect("symlink");
        #[cfg(windows)]
        let _ = std::os::windows::fs::symlink_dir(dir.path().join("src"), dir.path().join("link"));

        let mut filter = WatchFilter::new(dir.path());
        let mut tree = WatchTree::new(dir.path());
        arm(&mut tree, &mut filter);

        assert!(!tree.is_watched(&dir.path().join("link")));
    }

    #[test]
    fn a_directory_that_disappears_mid_walk_is_not_fatal() {
        let dir = repo();
        let mut filter = WatchFilter::new(dir.path());
        let mut tree = WatchTree::new(dir.path());

        // Planned while it exists, gone before anything reads it again.
        let plan = tree.plan(&mut filter);
        assert!(plan.add.contains(&dir.path().join("src/lib")));
        std::fs::remove_dir_all(dir.path().join("src")).expect("remove");

        // Whether this refreshes is not the point and not worth pinning — a tree
        // that moved under the sweep is allowed to report either way. Not
        // panicking, and not failing the walk that follows, is.
        let _ = tree.sweep(&plan.add, &mut filter);
        // And the next plan releases what went with it.
        for added in &plan.add {
            tree.armed(added);
        }
        let plan = arm(&mut tree, &mut filter);
        assert!(plan.remove.contains(&dir.path().join("src")));
        assert!(plan.remove.contains(&dir.path().join("src/lib")));
    }

    #[test]
    fn a_new_directory_is_discovered_with_everything_under_it() {
        // `notify` does not auto-arm a subdirectory of a non-recursive watch, so
        // `mkdir -p a/b/c` reaches us as one event for `a` and the rest is ours.
        let dir = repo();
        let mut filter = WatchFilter::new(dir.path());
        let mut tree = WatchTree::new(dir.path());
        arm(&mut tree, &mut filter);

        std::fs::create_dir_all(dir.path().join("src/fresh/deep")).expect("create dir");
        let plan = tree.discover(&dir.path().join("src/fresh"), &mut filter);

        assert_eq!(slugs(&tree, &plan.add), vec!["src/fresh", "src/fresh/deep"]);
        assert!(plan.remove.is_empty());
    }

    #[test]
    fn a_new_ignored_directory_is_not_discovered() {
        // `cargo build` recreating `target/`: one question, and then it is invisible
        // for as long as the project stays open.
        let dir = repo();
        std::fs::remove_dir_all(dir.path().join("target")).expect("remove");
        let mut filter = WatchFilter::new(dir.path());
        let mut tree = WatchTree::new(dir.path());
        arm(&mut tree, &mut filter);

        std::fs::create_dir_all(dir.path().join("target/debug")).expect("create dir");
        let plan = tree.discover(&dir.path().join("target"), &mut filter);

        assert_eq!(plan, Plan::default());
    }

    #[test]
    fn sweeping_a_freshly_armed_subtree_reports_its_contents() {
        // The arm-gap: content that existed before the watch did produces no event,
        // so the second read is the only thing that can find it.
        let dir = repo();
        let mut filter = WatchFilter::new(dir.path());
        let mut tree = WatchTree::new(dir.path());
        arm(&mut tree, &mut filter);

        std::fs::create_dir_all(dir.path().join("src/fresh")).expect("create dir");
        write(dir.path(), "src/fresh/new.ts", "export const a = 1;\n");
        let plan = tree.discover(&dir.path().join("src/fresh"), &mut filter);
        for added in &plan.add {
            tree.armed(added);
        }

        let swept = tree.sweep(&plan.add, &mut filter);
        assert!(swept.refresh, "new content must refresh");
        assert!(swept.unwatched.is_empty(), "the walk already found it all");
        // And it is stamped now, so the same sweep twice does not refresh twice.
        assert!(!tree.sweep(&plan.add, &mut filter).refresh);
    }

    #[test]
    fn a_directory_that_appeared_in_the_arm_gap_is_handed_back() {
        // `sweep` closing the window for files but not directories would leave a
        // whole subtree invisible: it has no watch either, so nothing inside it
        // will ever be reported, and no later event names it.
        let dir = repo();
        let mut filter = WatchFilter::new(dir.path());
        let mut tree = WatchTree::new(dir.path());
        arm(&mut tree, &mut filter);

        std::fs::create_dir_all(dir.path().join("src/fresh")).expect("create dir");
        let plan = tree.discover(&dir.path().join("src/fresh"), &mut filter);
        for added in &plan.add {
            tree.armed(added);
        }
        // Created after the plan read the directory and after it was armed, which
        // is the window a real `mkdir -p` can land in.
        std::fs::create_dir_all(dir.path().join("src/fresh/late")).expect("create dir");

        let swept = tree.sweep(&plan.add, &mut filter);
        assert_eq!(swept.unwatched, vec![dir.path().join("src/fresh/late")]);

        // And a second pass over what that turned up settles, which is what lets
        // the caller loop until it converges.
        let plan = tree.discover(&dir.path().join("src/fresh/late"), &mut filter);
        for added in &plan.add {
            tree.armed(added);
        }
        assert!(tree.sweep(&plan.add, &mut filter).unwatched.is_empty());
    }

    #[test]
    fn an_unreadable_directory_does_not_release_its_subtree() {
        // "I could not look" must not be read as "it is gone". The failure is
        // usually transient — EMFILE, under exactly the pressure this module
        // relieves — and tearing down a live subtree's watches over it would be a
        // silent regression with nothing scheduled to undo it.
        let dir = repo();
        let mut filter = WatchFilter::new(dir.path());
        let mut tree = WatchTree::new(dir.path());
        arm(&mut tree, &mut filter);
        assert!(tree.is_watched(&dir.path().join("src/lib")));

        // Unreadable, but still very much present.
        let src = dir.path().join("src");
        let mode = std::fs::metadata(&src).expect("metadata").permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&src, std::fs::Permissions::from_mode(0o000)).expect("chmod");
        }

        let plan = tree.plan(&mut filter);
        let released = plan.remove.clone();
        std::fs::set_permissions(&src, mode).expect("restore");

        #[cfg(unix)]
        assert!(
            !released.contains(&dir.path().join("src/lib")),
            "an unreadable parent must not release what is under it"
        );
    }

    #[test]
    fn un_ignoring_a_directory_puts_it_back_in_the_plan() {
        let dir = repo();
        let mut filter = WatchFilter::new(dir.path());
        let mut tree = WatchTree::new(dir.path());
        arm(&mut tree, &mut filter);
        assert!(!tree.is_watched(&dir.path().join("target")));

        // The rules move, which is what `WatchFilter::generation` publishes.
        let before = filter.generation();
        write(dir.path(), ".gitignore", "node_modules/\n*.log\n");
        assert!(filter.should_refresh([dir.path().join(".gitignore").as_path()]));
        assert!(filter.generation() > before);

        let plan = arm(&mut tree, &mut filter);
        assert!(plan.add.contains(&dir.path().join("target")));
        assert!(plan.add.contains(&dir.path().join("target/debug")));
    }

    #[test]
    fn newly_ignoring_a_directory_releases_it() {
        let dir = repo();
        let mut filter = WatchFilter::new(dir.path());
        let mut tree = WatchTree::new(dir.path());
        arm(&mut tree, &mut filter);
        assert!(tree.is_watched(&dir.path().join("src/lib")));

        write(
            dir.path(),
            ".gitignore",
            "node_modules/\ntarget/\nsrc/lib/\n",
        );
        assert!(filter.should_refresh([dir.path().join(".gitignore").as_path()]));

        let plan = arm(&mut tree, &mut filter);
        assert!(plan.remove.contains(&dir.path().join("src/lib")));
        assert!(!tree.is_watched(&dir.path().join("src/lib")));
    }

    #[test]
    fn a_force_added_file_keeps_a_watch_on_the_way_to_it() {
        // Otherwise granular watching makes this case worse than it was: the file
        // is one git reports, and its directory produces no events at all.
        let dir = repo();
        write(dir.path(), "node_modules/pkg/deep/keep.js", "export {};\n");
        git_in(dir.path(), &["add", "-f", "node_modules/pkg/deep/keep.js"]);
        commit(dir.path(), "force add");

        let mut filter = WatchFilter::new(dir.path());
        let mut tree = WatchTree::new(dir.path());
        assert!(tree.forced_changed(), "the set went from empty to one");
        arm(&mut tree, &mut filter);

        for chain in ["node_modules", "node_modules/pkg", "node_modules/pkg/deep"] {
            assert!(
                tree.is_watched(&dir.path().join(chain)),
                "{chain} is on the way to a file git reports"
            );
        }
        // Only the chain. Its siblings are still ignored and still cost nothing.
        assert!(!tree.is_watched(&dir.path().join("target")));
    }

    #[test]
    fn the_forced_set_only_reports_a_real_change() {
        let dir = repo();
        let mut tree = WatchTree::new(dir.path());
        // Nothing forced: an empty answer must not read as a change, or every index
        // write would re-plan the tree.
        assert!(!tree.forced_changed());

        write(dir.path(), "node_modules/keep.js", "export {};\n");
        git_in(dir.path(), &["add", "-f", "node_modules/keep.js"]);
        assert!(tree.forced_changed());
        assert!(!tree.forced_changed(), "asked twice, unchanged");
    }

    #[test]
    fn a_directory_outside_the_root_has_no_slug() {
        let dir = repo();
        let tree = WatchTree::new(dir.path());
        assert_eq!(tree.slug_of(dir.path()), None, "the root itself");
        assert_eq!(tree.slug_of(Path::new("/somewhere/else")), None);
        assert_eq!(
            tree.slug_of(&dir.path().join("src/lib")),
            Some("src/lib".to_string())
        );
    }
}
