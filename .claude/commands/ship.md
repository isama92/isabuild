---
description: Implement a step (with tests), gate it through a read-only review subagent, fix real findings, then commit
argument-hint: [step description; omit to review the current uncommitted work]
---

Ship one completed step through the review gate, following the Workflow section
of CLAUDE.md. Do NOT skip the review or the tests.

**Step to ship:** $ARGUMENTS

If the line above is empty, treat the current uncommitted changes as the step to
ship and go straight to the review gate (step 3).

Do this in order:

1. **Implement** (skip if already written): make the change in small steps and
   ship its tests in the same step — `cargo test` cases for backend logic,
   `vitest` for frontend components and hooks — covering the negative paths, per
   CLAUDE.md. Remember that jsdom cannot measure: anything positional needs its
   arithmetic outside the component so it can be tested at all.
2. **Green suites and clean gates:** run whichever of these the step touched, and
   get them green before going further:
   ```bash
   npm test                                                         # vitest
   npm run lint                                                     # eslint + tsc --noEmit
   cargo test --manifest-path src-tauri/Cargo.toml
   cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
   ```
3. **Review gate:** spawn a read-only review subagent (Agent tool —
   `pr-review-toolkit:code-reviewer` if available, otherwise `general-purpose`)
   over the uncommitted changes. Brief it explicitly, since it has none of this
   conversation's context, telling it to:
   - inspect the working tree with `git status`, `git diff`, and
     `git diff --staged`;
   - review against what this step should do, its acceptance criteria, and the
     conventions in CLAUDE.md;
   - name the specific things you are unsure about, so it spends its effort
     there rather than re-reading everything evenly;
   - report findings only, ordered by severity, and NOT edit any files.
   Its report comes back to you, not the user, so relay what matters.
4. **Triage and fix:** go through the findings yourself. Fix the real issues,
   skip the false positives, and state briefly what you decided for each. Do not
   apply a suggestion you cannot justify. A finding about a *comment* that no
   longer describes the code counts as a real issue here.
5. **Re-verify:** if any fix touched code, re-run the affected suite(s) and
   gate(s) and get them green again.
6. **Commit:** commit the completed step per CLAUDE.md (descriptive message; the
   pre-commit hook must pass). Never hand-edit a version — release-please owns
   those.

If this step **completes a roadmap part**, two extra things before you finish:
its acceptance criteria have to hold on macOS, Linux and Windows, so ask the user
to confirm the platforms you cannot test yourself; and a finished part is
*removed* from the README roadmap with the rest renumbered, not ticked.

Then report back: what you shipped, the review findings with your triage
decisions, the test results, and the commit.
