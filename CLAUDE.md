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

- Work in small steps; the roadmap in README.md is the backlog (tick items off when done). Each part has a detailed plan in `plans/`; follow its acceptance criteria. When a requirement is ambiguous or a decision shapes UX or architecture, ask before building.
- Every feature ships with tests in the same step: Rust backend logic gets `cargo test` cases (unit-test the parsers — git status/branch output, chunk models — against fixture strings; PTY code gets integration tests where feasible), frontend components/pages get `vitest` cases, covering the negative paths too. Both suites must be green before you commit.
- Before committing a completed step, run a read-only review subagent over the uncommitted changes (`git status` / `git diff` / `git diff --staged`). Brief it explicitly (it has none of this conversation's context): what the feature does, its acceptance criteria, and to follow this CLAUDE.md. It reports only, never edits. Then triage: fix real issues, skip false positives, note your calls. Re-run the suites if a fix touched code, then commit. (The `ship` skill runs this flow.)
- Commit per completed step with a descriptive message; the pre-commit hook must pass.
- PR titles must be Conventional Commits (`feat:`, `fix:`, `feat!:`, `ci:`, `chore:`, …), enforced by `conventions.yml`. PRs are squash-merged, so the title becomes the commit on `main` that release-plz reads to pick the next version. A roadmap part is titled like `feat: part 10 — <name>`.
- A roadmap part is only checked off when its acceptance criteria are verified on macOS, Linux and Windows (ask the user to confirm platforms you cannot test yourself).

## Versioning and releases

Versioning is automated by release-plz. **Never hand-edit a version in a feature PR.**

- **`src-tauri/Cargo.toml` is the single source of truth.** `src-tauri/tauri.conf.json` deliberately has no `version` key so Tauri falls back to the manifest; a test in `src-tauri/src/lib.rs` fails if anyone re-adds one. `package.json`/`package-lock.json` carry the same version only because npm wants one — `release-plz.yml` syncs them into the release PR.
- **Two steps.** Push to `main` → release-plz opens a `chore: release X.Y.Z` PR bumping `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `CHANGELOG.md` and the npm pair. Merging *that* PR tags `vX.Y.Z` and publishes the GitHub release, which triggers `release.yml` to build and attach the Linux/Windows/macOS installers.
- `release-plz.yml` must pass `manifest_path: src-tauri/Cargo.toml`. There is no root `Cargo.toml`; without it release-plz reads the repo root, finds no manifest and fails before doing anything.
- **`release-plz.yml` must use `secrets.RELEASE_PLZ_TOKEN`, never `GITHUB_TOKEN`.** A release created by `GITHUB_TOKEN` fires no `release` event, so `release.yml` would never run and the release would ship with no installers.
- Do not add `publish = false` to `src-tauri/Cargo.toml`. It marks the package non-publishable, which makes release-plz skip tagging entirely. The crates.io publish is blocked in `.github/release-plz.toml` instead.
- Third-party actions are pinned by commit SHA with a version comment; keep the pinning when editing a workflow.

