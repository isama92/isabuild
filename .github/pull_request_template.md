## What changed and why

<!-- Briefly describe the change and the reason for it. -->

## Release note

The **PR title** must be a Conventional Commit: on squash-merge it becomes the
commit message that release-plz reads to compute the next version.

- `feat: ...` bumps the minor version
- `fix: ...` bumps the patch version
- `feat!: ...` or a `BREAKING CHANGE:` footer bumps the major version
- `chore: `, `docs: `, `refactor: `, `test: `, `ci: `, etc. do not cut a release
  on their own

`conventions.yml` also labels this PR from that same prefix, but the label is
cosmetic — it is never read when computing the version.

## Checklist

- [ ] `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`,
      `npm run lint` and `npm test` all pass
- [ ] New behaviour has tests, covering the negative path too
- [ ] Any path, shell or PTY logic has an explicit Windows story, and paths are
      built with `PathBuf` rather than string concatenation
- [ ] No PTY is killed by a component unmount (including dev HMR) or by a
      secondary `diff-*` / `merge-*` window closing
- [ ] Git is read only from machine-readable output (`--porcelain=v2 -z`,
      `for-each-ref --format`, plumbing), never localized human-readable text
- [ ] Repo changes arrive through the `notify` watcher, not a new polling timer
- [ ] A new window label pattern has its own file in `src-tauri/capabilities/`
- [ ] No secrets, credentials or real hostnames in code, tests or fixtures
- [ ] No version numbers edited by hand — release-plz owns them

Verified on: <!-- Linux / macOS / Windows — delete any you could not test -->
