# CLAUDE.md

Desktop app: Claude Code embedded in a terminal, wrapped with live git tooling (status panel, diffs, branch/remote ops, graphical merge editor). Tauri 2 + Rust backend, React 18 + TypeScript frontend. Must work on macOS, Linux and Windows.

## Commands

```bash
npm run tauri dev                                  # run app in dev mode
npm run tauri build                                # release bundles
cargo test --manifest-path src-tauri/Cargo.toml    # backend tests
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
npm test                                           # frontend tests (vitest)
npm run lint                                       # eslint + tsc --noEmit
```

## Architecture rules

- **PTY lifecycle**: PTY sessions live in Rust managed state, keyed by string id. The frontend attaches/detaches listeners; it never owns a PTY. Component unmount (including dev HMR) must NOT kill a PTY — re-attach on remount via `pty_exists`. Kill all sessions when the **main** window closes (and on `RunEvent::Exit`), never when a secondary window such as a `diff-*` window closes.
- **Multiple windows**: the workspace is the `main` window; a diff opens as its own `diff-<hash>` window (one per file, `diff.html` is a second Vite entry so it never mounts the workspace Layout). Any window-scoped behaviour must key off `window.label()`, and a new window label pattern needs its own file in `src-tauri/capabilities/` — `core:window:default` grants getters only, so `close`/`destroy`/`set-focus` must be listed explicitly.
- **Spawning Claude Code**: always through the user's login shell (`$SHELL -ilc claude` on Unix, Git Bash on Windows) so PATH and shims resolve. Never spawn the `claude` binary directly.
- **Git**: all operations shell out to the system `git` binary with `cwd` set to the repo root. Only machine-readable formats are parsed (`--porcelain=v2 -z`, `for-each-ref --format`, plumbing commands). Never parse localized human-readable output. Network ops (fetch/pull/push) stream stderr progress as Tauri events and surface full stderr on non-zero exit.
- **Events over polling**: repo changes come from the `notify` watcher (debounced ~300 ms) emitting `repo://changed`; the frontend re-requests state. No timers polling git.
- **State**: Zustand stores on the frontend; no Redux, no context soup. Backend state in Tauri managed state behind mutexes.
- **Cross-platform is a requirement, not a stretch goal**: any path, shell, or PTY logic needs an explicit Windows story. Use `PathBuf`, never string-concatenated paths.

## Code style

- Rust: rustfmt defaults, clippy clean with `-D warnings`. Errors via `thiserror` in library code; Tauri commands return `Result<T, String>` with actionable messages.
- TypeScript: strict mode, no `any` without a justifying comment. Components are function components; hooks for logic, components for rendering.
- No secrets, credentials or real hostnames anywhere in code, tests or fixtures.

## Workflow

- Work in small steps; the roadmap in README.md is the backlog (tick items off when done) **and the only planning document**. A part's rationale, scope and acceptance criteria live in its own roadmap entry — write and refine them there. Do **not** create plan files or a `plans/` directory; detailed planning happens in conversation, and whatever is durable goes into the entry. When a requirement is ambiguous or a decision shapes UX or architecture, ask before building.
- Every feature ships with tests in the same step: Rust backend logic gets `cargo test` cases (unit-test the parsers — git status/branch output, chunk models — against fixture strings; PTY code gets integration tests where feasible), frontend components/pages get `vitest` cases, covering the negative paths too. Both suites must be green before you commit.
- Before committing a completed step, run a read-only review subagent over the uncommitted changes (`git status` / `git diff` / `git diff --staged`). Brief it explicitly (it has none of this conversation's context): what the feature does, its acceptance criteria, and to follow this CLAUDE.md. It reports only, never edits. Then triage: fix real issues, skip false positives, note your calls. Re-run the suites if a fix touched code, then commit. (The `ship` skill runs this flow.)
- Commit per completed step with a descriptive message; the pre-commit hook must pass.
- PR titles must be Conventional Commits (`feat:`, `fix:`, `feat!:`, `ci:`, `chore:`, …), enforced by `conventions.yml`. PRs are squash-merged, so the title becomes the commit on `main` that release-please reads to pick the next version. A roadmap part is titled like `feat: part 10 — <name>`.
- `conventions.yml` also applies one type label per PR automatically, from that same title prefix: `feat:` → `feature`, `fix:` → `bug`, `docs:` → `documentation`, anything else → `chore`. Exactly one of the four at a time — it removes the other three. The label is **cosmetic, for filtering PRs in the UI, and plays no part in versioning**: release-please reads the Conventional Commit prefix off the squashed commit message, never a GitHub label. So labelling is best-effort and never fails the check (a missing label only logs a warning), and hand-editing a label changes nothing about the release.
- The repo needs all four labels to exist for that to be more than a warning. `bug` and `documentation` ship with every GitHub repo; **`feature` and `chore` do not and were created by hand.** Recreate them on a fork or the labeller degrades to warnings.
- A roadmap part is only checked off when its acceptance criteria are verified on macOS, Linux and Windows (ask the user to confirm platforms you cannot test yourself).

## Versioning and releases

Versioning is automated by release-please. **Never hand-edit a version in a feature PR.**

- **Two steps.** Push to `main` → release-please opens a `chore: release X.Y.Z` PR bumping `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `CHANGELOG.md` and the npm pair. Merging *that* PR tags `vX.Y.Z` and publishes the GitHub release, which triggers `release.yml` to build and attach the Linux/Windows/macOS installers.
- **`src-tauri/Cargo.toml` is the single source of truth for the app version.** `src-tauri/tauri.conf.json` deliberately has no `version` key so Tauri falls back to the manifest; a test in `src-tauri/src/lib.rs` fails if anyone re-adds one. `package.json`/`package-lock.json` carry the same version only because npm wants one.
- **`.release-please-manifest.json` is where release-please records the last released version.** It resolves the last release from the GitHub Releases API and falls back to this file when no release is found, so it is load-bearing state — do not hand-edit it.
- **The release-please package is rooted at `.`, not `src-tauri`.** It has to be: release-please throws `illegal pathing characters` for any path containing `..`, so a package rooted at `src-tauri/` could not reach the root `CHANGELOG.md` or `package.json`. Hence `release-type: node` (which bumps the npm pair and the changelog natively) plus an `extra-files` TOML updater for `src-tauri/Cargo.toml`.
- **`release-please.yml` syncs `src-tauri/Cargo.lock` itself**, because release-please only knows about files it is told to update. A stale lock makes every `--locked` build fail with "cannot update the lock file". `cargo update --workspace` is the right tool: it re-resolves only workspace members, so no dependency drifts into a release PR.
- **`release-please.yml` must use `secrets.RELEASE_PLZ_TOKEN`, never `GITHUB_TOKEN`.** A release created by `GITHUB_TOKEN` fires no `release` event, so `release.yml` would never run and the release would ship with no installers. Because every call there uses the PAT, the workflow's `permissions:` block governs nothing in practice — the scopes that matter are the PAT's own.
- **While the app is pre-1.0, a breaking change bumps the minor**, not the major (`bump-minor-pre-major` in `release-please-config.json`). 1.0.0 has to be cut deliberately. `initial-version` is what pinned the first release to `0.1.0` instead of release-please's default `1.0.0`.
- **Do not reintroduce release-plz.** It cannot work here. `git_only` is mandatory (isabuild is not on crates.io, so there is no registry baseline and it never bumps at all), but `git_only` runs `cargo package` with verification — hardcoded, no `--no-verify` — which compiles the crate. That compile cannot succeed: `cargo package` only includes files under `src-tauri/`, so the gitignored root `../dist` is missing and `generate_context!()` panics. Cargo cannot include files above the package root, so committing `dist/` would not help either.
- Third-party actions are pinned by commit SHA with a version comment; keep the pinning when editing a workflow.

