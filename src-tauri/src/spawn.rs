//! Platform-specific construction of the command line for a PTY session.
//!
//! Commands are always run through a shell (the user's login shell on Unix,
//! Git Bash or PowerShell on Windows) so that PATH, version-manager shims and
//! environment resolve exactly like in the user's own terminal. GUI apps get a
//! minimal environment, so spawning binaries like `claude` directly fails.
//!
//! Everything here is pure (no PTY, no Tauri) so it is unit-testable on every
//! platform.

use std::path::{Path, PathBuf};

/// A resolved program + argument list, ready to hand to the PTY.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
}

/// Join a command and its arguments into a single shell command string.
///
/// The result is passed to `sh -c` / `bash -c` unquoted; callers that need
/// arguments with spaces must quote them themselves.
pub fn joined_command(cmd: Option<&str>, args: &[String]) -> Option<String> {
    let cmd = cmd?;
    if args.is_empty() {
        Some(cmd.to_string())
    } else {
        Some(format!("{} {}", cmd, args.join(" ")))
    }
}

/// Unix spec: interactive login shell, optionally running `cmd`.
pub fn unix_spec(shell: &str, cmd: Option<&str>) -> SpawnSpec {
    let args = match cmd {
        Some(c) => vec!["-ilc".to_string(), c.to_string()],
        None => vec!["-il".to_string()],
    };
    SpawnSpec {
        program: shell.to_string(),
        args,
    }
}

/// Candidate installation paths for Git Bash, built from environment
/// variables. Deliberately excludes `System32\bash.exe`, which is WSL.
pub fn git_bash_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(pf) = std::env::var("ProgramFiles") {
        candidates.push(PathBuf::from(pf).join("Git").join("bin").join("bash.exe"));
    }
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(pf86).join("Git").join("bin").join("bash.exe"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local)
                .join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }
    candidates
}

/// First candidate for which `exists` returns true. `exists` is injected so
/// tests can run without a real filesystem layout.
pub fn find_git_bash<F: Fn(&Path) -> bool>(candidates: &[PathBuf], exists: F) -> Option<PathBuf> {
    candidates.iter().find(|p| exists(p)).cloned()
}

/// Windows spec: Git Bash if available (login shell semantics like Unix),
/// PowerShell otherwise.
pub fn windows_spec(git_bash: Option<PathBuf>, cmd: Option<&str>) -> SpawnSpec {
    match git_bash {
        Some(bash) => {
            let args = match cmd {
                Some(c) => vec!["-ilc".to_string(), c.to_string()],
                None => vec!["-il".to_string()],
            };
            SpawnSpec {
                program: bash.to_string_lossy().into_owned(),
                args,
            }
        }
        None => {
            // The profile is deliberately loaded (no -NoProfile): users may
            // configure PATH or a `claude` shim there, and resolving like the
            // user's own terminal is the whole point of this module.
            let mut args = vec!["-NoLogo".to_string()];
            if let Some(c) = cmd {
                args.push("-Command".to_string());
                args.push(c.to_string());
            }
            SpawnSpec {
                program: "powershell.exe".to_string(),
                args,
            }
        }
    }
}

/// Build the spec for the current platform. `cmd: None` yields a plain
/// interactive login shell (used by later parts for the bottom terminal).
pub fn shell_spec(cmd: Option<&str>) -> SpawnSpec {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        unix_spec(&shell, cmd)
    }
    #[cfg(windows)]
    {
        let bash = find_git_bash(&git_bash_candidates(), |p| p.is_file());
        windows_spec(bash, cmd)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joined_command_none_is_none() {
        assert_eq!(joined_command(None, &["--flag".into()]), None);
    }

    #[test]
    fn joined_command_without_args() {
        assert_eq!(joined_command(Some("claude"), &[]), Some("claude".into()));
    }

    #[test]
    fn joined_command_with_args() {
        assert_eq!(
            joined_command(Some("claude"), &["--resume".into(), "abc".into()]),
            Some("claude --resume abc".into())
        );
    }

    #[test]
    fn unix_spec_with_command_uses_interactive_login_shell() {
        let spec = unix_spec("/usr/bin/zsh", Some("claude"));
        assert_eq!(spec.program, "/usr/bin/zsh");
        assert_eq!(spec.args, vec!["-ilc", "claude"]);
    }

    #[test]
    fn unix_spec_without_command_is_plain_login_shell() {
        let spec = unix_spec("/bin/bash", None);
        assert_eq!(spec.program, "/bin/bash");
        assert_eq!(spec.args, vec!["-il"]);
    }

    #[test]
    fn find_git_bash_picks_first_existing() {
        let candidates = vec![
            PathBuf::from("C:\\Program Files\\Git\\bin\\bash.exe"),
            PathBuf::from("C:\\Users\\x\\AppData\\Local\\Programs\\Git\\bin\\bash.exe"),
        ];
        let found = find_git_bash(&candidates, |p| p == candidates[1].as_path());
        assert_eq!(found, Some(candidates[1].clone()));
    }

    #[test]
    fn find_git_bash_none_when_nothing_exists() {
        let candidates = vec![PathBuf::from("C:\\Program Files\\Git\\bin\\bash.exe")];
        assert_eq!(find_git_bash(&candidates, |_| false), None);
    }

    #[test]
    fn windows_spec_prefers_git_bash() {
        let bash = PathBuf::from("C:\\Program Files\\Git\\bin\\bash.exe");
        let spec = windows_spec(Some(bash.clone()), Some("claude"));
        assert_eq!(spec.program, bash.to_string_lossy());
        assert_eq!(spec.args, vec!["-ilc", "claude"]);
    }

    #[test]
    fn windows_spec_git_bash_without_command() {
        let bash = PathBuf::from("C:\\Program Files\\Git\\bin\\bash.exe");
        let spec = windows_spec(Some(bash), None);
        assert_eq!(spec.args, vec!["-il"]);
    }

    #[test]
    fn windows_spec_falls_back_to_powershell() {
        let spec = windows_spec(None, Some("claude"));
        assert_eq!(spec.program, "powershell.exe");
        // No -NoProfile: the user's profile must load so PATH resolves like
        // their own terminal.
        assert_eq!(spec.args, vec!["-NoLogo", "-Command", "claude"]);
    }

    #[test]
    fn windows_spec_powershell_without_command_is_interactive() {
        let spec = windows_spec(None, None);
        assert_eq!(spec.program, "powershell.exe");
        assert_eq!(spec.args, vec!["-NoLogo"]);
    }

    #[test]
    fn shell_spec_builds_for_current_platform() {
        let spec = shell_spec(Some("claude"));
        assert!(!spec.program.is_empty());
        assert!(spec
            .args
            .iter()
            .any(|a| a == "claude" || a.contains("claude")));
    }
}
