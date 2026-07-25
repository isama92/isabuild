//! PTY session manager. Parts 2+ build on this API unchanged.
//!
//! Sessions live in a `HashMap<String, PtySession>` behind a mutex; the
//! frontend only ever refers to a session by its string id and attaches or
//! re-attaches listeners — it never owns a PTY (survives HMR remounts).
//!
//! API surface (mirrored 1:1 by the Tauri commands in `commands.rs`):
//! - [`PtyManager::spawn`] — open a PTY, spawn the command, start the reader
//!   and wait threads described below.
//! - [`PtyManager::write`] / [`PtyManager::resize`] / [`PtyManager::kill`] /
//!   [`PtyManager::exists`] / [`PtyManager::kill_all`].
//!
//! The event sink is a plain `Fn(PtyEvent)` closure so this module has no
//! Tauri dependency: production wraps an `AppHandle`, tests use an mpsc
//! channel.
//!
//! # Threads and exit protocol
//!
//! Each session runs two threads:
//! - a **wait thread** that owns the `Child`, blocks in `child.wait()`, and
//!   sends the exit code over a channel. On Windows it also removes the
//!   session from the map: dropping the master calls `ClosePseudoConsole`,
//!   which flushes conhost's remaining output and finally EOFs the reader
//!   (a ConPTY reader never sees EOF while the pseudoconsole is open). On
//!   Unix it must NOT do that — dropping the master early would discard
//!   output the reader has not drained yet; there the reader gets EOF from
//!   the kernel when the child exits.
//! - a **reader thread** that drains output to EOF in 8 KB base64 batches,
//!   then receives the exit code from the wait thread, so the exit event is
//!   always emitted after the last output event.
//!
//! Exit suppression: `kill`/`kill_all` set the session's `killed` flag before
//! killing, and the reader thread emits [`PtyEvent::Exit`] only when the flag
//! is unset. Intentional teardown (e.g. window close) therefore never flashes
//! the exit overlay, while a natural child exit always reports its code.
//!
//! Kill semantics note: the cloned killer sends SIGHUP on Unix (no SIGKILL
//! escalation). The child is a login shell with a controlling tty, so its
//! death HUPs the foreground process group — sufficient for our use; revisit
//! if a later part spawns something that traps SIGHUP.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::spawn::SpawnSpec;

/// Events produced by a PTY session, forwarded to the frontend as Tauri
/// events by the production sink.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    /// A chunk of PTY output, base64-encoded so it survives JSON transport.
    Output { id: String, data_b64: String },
    /// The child exited on its own (never emitted after `kill`/`kill_all`).
    Exit { id: String, exit_code: u32 },
}

#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    #[error("pty session '{0}' already exists")]
    AlreadyExists(String),
    #[error("pty session '{0}' not found")]
    NotFound(String),
    #[error("failed to open pty: {0}")]
    Open(String),
    #[error("failed to spawn '{0}': {1}")]
    Spawn(String, String),
    #[error("invalid base64 payload: {0}")]
    BadData(String),
    #[error("io error on pty session '{id}': {msg}")]
    Io { id: String, msg: String },
}

/// Parameters for [`PtyManager::spawn`].
#[derive(Debug, Clone)]
pub struct SpawnParams {
    pub id: String,
    pub spec: SpawnSpec,
    pub cwd: Option<PathBuf>,
    pub cols: u16,
    pub rows: u16,
}

/// A live session. The `Child` itself is `Send` but not `Sync`, so it moves
/// into the wait thread; `clone_killer()` provides the handle we keep here.
/// The writer has its own mutex so a blocked PTY write (full input buffer)
/// can never stall the session map — `kill_all` on window close must always
/// be able to acquire the map lock.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    killed: Arc<AtomicBool>,
}

type SessionMap = Arc<Mutex<HashMap<String, PtySession>>>;

#[derive(Default, Clone)]
pub struct PtyManager {
    sessions: SessionMap,
}

impl PtyManager {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, PtySession>> {
        self.sessions.lock().expect("pty session mutex poisoned")
    }

    /// Spawn `params.spec` on a fresh PTY and stream its output to `sink`.
    ///
    /// Errors if `params.id` is already in use — callers own idempotency
    /// (the frontend session manager checks `exists` first); failing loud
    /// here means an id collision can never silently leak a PTY.
    pub fn spawn<F>(&self, params: SpawnParams, sink: F) -> Result<(), PtyError>
    where
        F: Fn(PtyEvent) + Send + 'static,
    {
        // Hold the lock across the whole spawn so two concurrent spawns with
        // the same id cannot both pass the existence check.
        let mut sessions = self.lock();
        if sessions.contains_key(&params.id) {
            return Err(PtyError::AlreadyExists(params.id));
        }

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: params.rows,
                cols: params.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::Open(e.to_string()))?;

        let mut cmd = CommandBuilder::new(&params.spec.program);
        cmd.args(&params.spec.args);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        if let Some(cwd) = &params.cwd {
            cmd.cwd(cwd);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::Spawn(params.spec.program.clone(), e.to_string()))?;
        // Drop our copy of the slave end so the Unix reader sees EOF when the
        // child exits (otherwise the PTY stays open and the reader blocks).
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PtyError::Open(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PtyError::Open(e.to_string()))?;
        let killer = child.clone_killer();
        let killed = Arc::new(AtomicBool::new(false));

        let id = params.id.clone();
        sessions.insert(
            id.clone(),
            PtySession {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                killer,
                killed: Arc::clone(&killed),
            },
        );
        drop(sessions);

        let (verdict_tx, verdict_rx) = mpsc::channel::<u32>();

        // Wait thread first: it owns the child, so every failure path below
        // still has a thread reaping the process (no zombies).
        let wait_sessions = Arc::clone(&self.sessions);
        let wait_id = id.clone();
        let wait_thread = std::thread::Builder::new()
            .name(format!("pty-wait-{id}"))
            .spawn(move || {
                let exit_code = child.wait().map(|s| s.exit_code()).unwrap_or(0);
                let _ = verdict_tx.send(exit_code);
                // Windows: EOF only arrives after ClosePseudoConsole, i.e.
                // after the master (held in the map) is dropped. conhost
                // flushes pending output first, so nothing is lost. On Unix
                // the reader gets EOF from the kernel and removes the session
                // itself once fully drained.
                #[cfg(windows)]
                {
                    let _ = wait_sessions
                        .lock()
                        .expect("pty session mutex poisoned")
                        .remove(&wait_id);
                }
                #[cfg(not(windows))]
                {
                    let _ = (&wait_sessions, &wait_id);
                }
            });
        if wait_thread.is_err() {
            // OS refused a thread; child reaping is lost, but this only
            // happens under resource exhaustion. Clean up the session.
            if let Some(mut session) = self.lock().remove(&params.id) {
                session.killed.store(true, Ordering::SeqCst);
                let _ = session.killer.kill();
            }
            return Err(PtyError::Spawn(
                params.spec.program.clone(),
                "failed to start pty wait thread".to_string(),
            ));
        }

        let reader_sessions = Arc::clone(&self.sessions);
        let reader_thread = std::thread::Builder::new()
            .name(format!("pty-reader-{id}"))
            .spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        // The kill check is per read, not just before the exit
                        // event: a killed child's buffered output is still
                        // readable until EOF, and session ids are reused (Part
                        // 8 switches projects without changing them). Emitting
                        // it would paint the old project's last lines into the
                        // terminal the new project has already attached to the
                        // same `pty://output/<id>` channel.
                        Ok(n) if n > 0 && !killed.load(Ordering::SeqCst) => {
                            sink(PtyEvent::Output {
                                id: id.clone(),
                                data_b64: BASE64.encode(&buf[..n]),
                            });
                        }
                        Ok(n) if n > 0 => continue, // killed: drain, do not emit
                        // EOF, or read error once the master is dropped.
                        _ => break,
                    }
                }
                // Blocks until the wait thread has reaped the child, so the
                // exit event always carries the real code and always follows
                // the last output event.
                let Ok(exit_code) = verdict_rx.recv() else {
                    return; // wait thread gone: spawn() already rolled back
                };
                if killed.load(Ordering::SeqCst) {
                    return; // intentional kill: suppress the exit event
                }
                // Unix natural exit: the reader is the one who cleans the map
                // (on Windows the wait thread already did). Removal happens
                // before the emit so a restart triggered by the exit event
                // can never race an insert against this remove.
                let _ = reader_sessions
                    .lock()
                    .expect("pty session mutex poisoned")
                    .remove(&id);
                sink(PtyEvent::Exit { id, exit_code });
            });
        if reader_thread.is_err() {
            // The wait thread is alive and will reap the child after kill.
            if let Some(mut session) = self.lock().remove(&params.id) {
                session.killed.store(true, Ordering::SeqCst);
                let _ = session.killer.kill();
            }
            return Err(PtyError::Spawn(
                params.spec.program.clone(),
                "failed to start pty reader thread".to_string(),
            ));
        }
        Ok(())
    }

    /// Decode `data_b64` and write it to the session's PTY. The map lock is
    /// released before the (potentially blocking) write.
    pub fn write(&self, id: &str, data_b64: &str) -> Result<(), PtyError> {
        let bytes = BASE64
            .decode(data_b64)
            .map_err(|e| PtyError::BadData(e.to_string()))?;
        let writer = {
            let sessions = self.lock();
            let session = sessions
                .get(id)
                .ok_or_else(|| PtyError::NotFound(id.to_string()))?;
            Arc::clone(&session.writer)
        };
        let mut writer = writer.lock().expect("pty writer mutex poisoned");
        writer
            .write_all(&bytes)
            .and_then(|()| writer.flush())
            .map_err(|e| PtyError::Io {
                id: id.to_string(),
                msg: e.to_string(),
            })
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), PtyError> {
        let sessions = self.lock();
        let session = sessions
            .get(id)
            .ok_or_else(|| PtyError::NotFound(id.to_string()))?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::Io {
                id: id.to_string(),
                msg: e.to_string(),
            })
    }

    /// Kill the child and drop the session. Sets the `killed` flag first so
    /// the reader thread suppresses the exit event (see module docs).
    pub fn kill(&self, id: &str) -> Result<(), PtyError> {
        let removed = self.lock().remove(id);
        match removed {
            Some(mut session) => {
                session.killed.store(true, Ordering::SeqCst);
                // The child may already be dead; that's fine.
                let _ = session.killer.kill();
                Ok(())
            }
            None => Err(PtyError::NotFound(id.to_string())),
        }
    }

    /// Kill every session (window close / app exit). Idempotent.
    pub fn kill_all(&self) {
        let drained: Vec<PtySession> = {
            let mut sessions = self.lock();
            sessions.drain().map(|(_, s)| s).collect()
        };
        for mut session in drained {
            session.killed.store(true, Ordering::SeqCst);
            let _ = session.killer.kill();
        }
    }

    pub fn exists(&self, id: &str) -> bool {
        self.lock().contains_key(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn manager() -> PtyManager {
        PtyManager::default()
    }

    fn channel_sink() -> (impl Fn(PtyEvent) + Send + 'static, mpsc::Receiver<PtyEvent>) {
        let (tx, rx) = mpsc::channel();
        (move |ev| drop(tx.send(ev)), rx)
    }

    fn params(id: &str, program: &str, args: &[&str]) -> SpawnParams {
        SpawnParams {
            id: id.to_string(),
            spec: SpawnSpec {
                program: program.to_string(),
                args: args.iter().map(|a| a.to_string()).collect(),
            },
            cwd: None,
            cols: 80,
            rows: 24,
        }
    }

    /// Drain events until the sender is dropped (reader thread finished).
    fn drain(rx: mpsc::Receiver<PtyEvent>) -> Vec<PtyEvent> {
        let mut events = Vec::new();
        while let Ok(ev) = rx.recv_timeout(Duration::from_secs(10)) {
            events.push(ev);
        }
        events
    }

    fn decoded_output(events: &[PtyEvent]) -> String {
        let mut bytes = Vec::new();
        for ev in events {
            if let PtyEvent::Output { data_b64, .. } = ev {
                bytes.extend(BASE64.decode(data_b64).expect("valid base64"));
            }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }

    #[test]
    fn write_unknown_id_is_not_found() {
        let err = manager().write("nope", "aGk=").unwrap_err();
        assert!(matches!(err, PtyError::NotFound(_)));
    }

    #[test]
    fn write_invalid_base64_is_bad_data() {
        // Decode-first: payload validation happens before session lookup.
        let err = manager().write("nope", "!!!not-base64!!!").unwrap_err();
        assert!(matches!(err, PtyError::BadData(_)));
    }

    #[test]
    fn resize_unknown_id_is_not_found() {
        let err = manager().resize("nope", 80, 24).unwrap_err();
        assert!(matches!(err, PtyError::NotFound(_)));
    }

    #[test]
    fn kill_unknown_id_is_not_found() {
        let err = manager().kill("nope").unwrap_err();
        assert!(matches!(err, PtyError::NotFound(_)));
    }

    #[test]
    fn exists_false_for_unknown_id() {
        assert!(!manager().exists("nope"));
    }

    #[test]
    fn kill_all_on_empty_manager_is_noop() {
        manager().kill_all();
    }

    #[cfg(unix)]
    mod unix_integration {
        use super::*;

        const SH: &str = "/bin/sh";

        #[test]
        fn output_then_exit_code() {
            let m = manager();
            let (sink, rx) = channel_sink();
            m.spawn(params("t1", SH, &["-c", "printf hello; exit 3"]), sink)
                .unwrap();
            let events = drain(rx);
            assert!(decoded_output(&events).contains("hello"));
            assert_eq!(
                events.last(),
                Some(&PtyEvent::Exit {
                    id: "t1".to_string(),
                    exit_code: 3
                })
            );
            assert!(!m.exists("t1"), "natural exit must remove the session");
        }

        #[test]
        fn spawn_honours_requested_cwd() {
            let m = manager();
            let (sink, rx) = channel_sink();
            // Canonicalise and print the physical path (`pwd -P`): macOS's
            // $TMPDIR has a trailing slash and sits behind the /var symlink,
            // which would break a naive substring comparison.
            let dir = std::fs::canonicalize(std::env::temp_dir()).expect("canonical temp dir");
            let mut p = params("tcwd", SH, &["-c", "pwd -P"]);
            p.cwd = Some(dir.clone());
            m.spawn(p, sink).unwrap();
            let events = drain(rx);
            assert!(
                decoded_output(&events).contains(dir.to_str().expect("utf-8 temp dir")),
                "child must start in the requested cwd"
            );
        }

        #[test]
        fn missing_command_exits_127() {
            let m = manager();
            let (sink, rx) = channel_sink();
            m.spawn(
                params("t2", SH, &["-c", "definitely-not-a-command-xyz"]),
                sink,
            )
            .unwrap();
            let events = drain(rx);
            assert_eq!(
                events.last(),
                Some(&PtyEvent::Exit {
                    id: "t2".to_string(),
                    exit_code: 127
                })
            );
        }

        #[test]
        fn duplicate_id_errors() {
            let m = manager();
            let (sink, _rx) = channel_sink();
            m.spawn(params("t3", SH, &["-c", "sleep 30"]), sink)
                .unwrap();
            let (sink2, _rx2) = channel_sink();
            let err = m
                .spawn(params("t3", SH, &["-c", "sleep 30"]), sink2)
                .unwrap_err();
            assert!(matches!(err, PtyError::AlreadyExists(_)));
            m.kill("t3").unwrap();
        }

        #[test]
        fn kill_suppresses_exit_event() {
            let m = manager();
            let (sink, rx) = channel_sink();
            m.spawn(params("t4", SH, &["-c", "sleep 30"]), sink)
                .unwrap();
            assert!(m.exists("t4"));
            m.kill("t4").unwrap();
            assert!(!m.exists("t4"));
            let events = drain(rx);
            assert!(
                !events.iter().any(|e| matches!(e, PtyEvent::Exit { .. })),
                "kill must suppress the exit event, got {events:?}"
            );
        }

        #[test]
        fn kill_all_drops_every_session_silently() {
            let m = manager();
            let (sink_a, rx_a) = channel_sink();
            let (sink_b, rx_b) = channel_sink();
            m.spawn(params("a", SH, &["-c", "sleep 30"]), sink_a)
                .unwrap();
            m.spawn(params("b", SH, &["-c", "sleep 30"]), sink_b)
                .unwrap();
            m.kill_all();
            assert!(!m.exists("a") && !m.exists("b"));
            for rx in [rx_a, rx_b] {
                let events = drain(rx);
                assert!(!events.iter().any(|e| matches!(e, PtyEvent::Exit { .. })));
            }
            // Second call must be a harmless no-op.
            m.kill_all();
        }

        #[test]
        fn write_reaches_child_and_bad_data_leaves_session_alive() {
            let m = manager();
            let (sink, rx) = channel_sink();
            m.spawn(
                params("t5", SH, &["-c", "read line; printf \"got:%s\" \"$line\""]),
                sink,
            )
            .unwrap();
            let err = m.write("t5", "!!!not-base64!!!").unwrap_err();
            assert!(matches!(err, PtyError::BadData(_)));
            assert!(m.exists("t5"), "bad payload must not tear down the session");
            m.write("t5", &BASE64.encode("ping\n")).unwrap();
            let events = drain(rx);
            assert!(decoded_output(&events).contains("got:ping"));
        }

        #[test]
        fn resize_succeeds_on_live_session() {
            let m = manager();
            let (sink, _rx) = channel_sink();
            m.spawn(params("t6", SH, &["-c", "sleep 30"]), sink)
                .unwrap();
            m.resize("t6", 120, 40).unwrap();
            m.kill("t6").unwrap();
        }

        #[test]
        fn respawn_after_natural_exit_works() {
            let m = manager();
            let (sink, rx) = channel_sink();
            m.spawn(params("t7", SH, &["-c", "exit 0"]), sink).unwrap();
            drain(rx); // reader thread done -> session removed
            let (sink2, rx2) = channel_sink();
            m.spawn(params("t7", SH, &["-c", "exit 5"]), sink2).unwrap();
            let events = drain(rx2);
            assert_eq!(
                events.last(),
                Some(&PtyEvent::Exit {
                    id: "t7".to_string(),
                    exit_code: 5
                })
            );
        }
    }

    // Windows equivalents of the integration tests above. NOT yet verified on
    // a real Windows host — they are part of the Windows acceptance pass.
    #[cfg(windows)]
    mod windows_integration {
        use super::*;

        #[test]
        fn output_then_exit_code() {
            let m = manager();
            let (sink, rx) = channel_sink();
            // conhost issues a cursor-position report query (ESC[6n) at startup
            // and withholds the child's rendered output until the terminal
            // answers it. In the real app xterm.js answers automatically; this
            // backend test must do the same, or "hello" is only flushed racily
            // on teardown (the source of this test's old flakiness on the
            // Server 2022 runner). The ping keeps the child alive long enough
            // for conhost to render "hello" once the handshake completes; it
            // reads no stdin, so our reply can't be mistaken for its input.
            m.spawn(
                params(
                    "t1",
                    "cmd.exe",
                    &["/C", "echo hello& ping -n 3 127.0.0.1 >NUL& exit 3"],
                ),
                sink,
            )
            .unwrap();

            // Drain to EOF (reader thread ends when the child exits), replying
            // to the DSR query the first time we see it. recv_timeout bounds a
            // genuinely stuck run.
            let mut events = Vec::new();
            let mut answered = false;
            loop {
                match rx.recv_timeout(Duration::from_secs(15)) {
                    Ok(ev) => {
                        events.push(ev);
                        if !answered && decoded_output(&events).contains("\x1b[6n") {
                            let _ = m.write("t1", &BASE64.encode("\x1b[1;1R"));
                            answered = true;
                        }
                    }
                    Err(_) => break,
                }
            }

            assert!(
                decoded_output(&events).contains("hello"),
                "child output was not delivered: {events:?}"
            );
            assert!(
                matches!(events.last(), Some(PtyEvent::Exit { exit_code: 3, .. })),
                "expected natural exit with code 3, got {events:?}"
            );
        }

        #[test]
        fn kill_suppresses_exit_event() {
            let m = manager();
            let (sink, rx) = channel_sink();
            m.spawn(
                params("t4", "cmd.exe", &["/C", "ping -n 60 127.0.0.1 >NUL"]),
                sink,
            )
            .unwrap();
            m.kill("t4").unwrap();
            let events = drain(rx);
            assert!(!events.iter().any(|e| matches!(e, PtyEvent::Exit { .. })));
        }
    }
}
