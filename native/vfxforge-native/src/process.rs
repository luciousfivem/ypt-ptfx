//! Running an external process with cancellation, a hard timeout and bounded output.

use crate::error::{Error, Result};
use crate::jobs::CancelToken;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MAX_STDOUT: usize = 1024 * 1024;
const MAX_STDERR_TAIL: usize = 16 * 1024;

pub type LineCallback = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Debug)]
pub struct RunOutput {
    pub code: Option<i32>,
    pub success: bool,
    pub stdout: String,
    pub stderr_tail: String,
}

/// Kills the child AND everything it spawned. On Unix the child leads its own process group
/// (set in [`run`]) so the whole group receives SIGKILL; on Windows `taskkill /T` walks the
/// process tree. Without this, a grandchild that inherited our pipes would keep them open
/// and make cancellation appear to hang.
fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        // SAFETY: plain syscall with a pid we own; a negative pid addresses the process group.
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Runs `cmd` to completion. Returns `Error::Cancelled` / `Error::Timeout` after killing the
/// child. `on_stdout_line` is invoked from a reader thread for every stdout line.
pub fn run(
    mut cmd: Command,
    tool: &str,
    cancel: &CancelToken,
    timeout: Duration,
    on_stdout_line: Option<LineCallback>,
) -> Result<RunOutput> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // own group => kill_tree can signal the whole tree
    }
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error::ToolMissing {
                tool: tool.to_string(),
                hint: "The executable could not be started.".into(),
            }
        } else {
            Error::io(format!("starting {tool}"), e)
        }
    })?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let out_thread = std::thread::spawn(move || {
        let mut acc = String::new();
        for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
            if let Some(cb) = &on_stdout_line {
                cb(&line);
            }
            if acc.len() < MAX_STDOUT {
                acc.push_str(&line);
                acc.push('\n');
            }
        }
        acc
    });
    let err_thread = std::thread::spawn(move || {
        let mut tail = String::new();
        for line in BufReader::new(stderr).lines().map_while(|l| l.ok()) {
            tail.push_str(&line);
            tail.push('\n');
            if tail.len() > MAX_STDERR_TAIL * 2 {
                let cut = tail.len() - MAX_STDERR_TAIL;
                // keep the tail on a char boundary
                let cut = (cut..tail.len()).find(|i| tail.is_char_boundary(*i)).unwrap_or(0);
                tail = tail[cut..].to_string();
            }
        }
        tail
    });

    let started = Instant::now();
    let status = loop {
        // After a kill the reader threads are intentionally NOT joined: they exit on their own
        // once every holder of the pipe is gone, and we must not block cancellation on that.
        if cancel.is_cancelled() {
            kill_tree(&mut child);
            return Err(Error::Cancelled);
        }
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {}
            Err(e) => {
                kill_tree(&mut child);
                return Err(Error::io(format!("waiting for {tool}"), e));
            }
        }
        if started.elapsed() > timeout {
            kill_tree(&mut child);
            return Err(Error::Timeout {
                tool: tool.to_string(),
                secs: timeout.as_secs(),
            });
        }
        std::thread::sleep(Duration::from_millis(15));
    };

    let stdout = out_thread.join().unwrap_or_default();
    let stderr_tail = err_thread.join().unwrap_or_default();
    Ok(RunOutput {
        code: status.code(),
        success: status.success(),
        stdout,
        stderr_tail: stderr_tail.trim().to_string(),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn sh(script: &str) -> Command {
        let mut c = Command::new("sh");
        c.arg("-c").arg(script);
        c
    }

    #[test]
    fn captures_output_and_exit_status() {
        let out = run(sh("echo hi; echo err 1>&2; exit 3"), "sh", &CancelToken::new(), Duration::from_secs(5), None).unwrap();
        assert_eq!(out.code, Some(3));
        assert!(!out.success);
        assert_eq!(out.stdout.trim(), "hi");
        assert_eq!(out.stderr_tail, "err");
    }

    #[test]
    fn streams_lines_to_callback() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let s2 = seen.clone();
        let cb: LineCallback = Arc::new(move |l| s2.lock().unwrap().push(l.to_string()));
        run(sh("echo a; echo b"), "sh", &CancelToken::new(), Duration::from_secs(5), Some(cb)).unwrap();
        assert_eq!(*seen.lock().unwrap(), vec!["a", "b"]);
    }

    #[test]
    fn cancel_kills_the_child_promptly() {
        let token = CancelToken::new();
        let t2 = token.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            t2.cancel();
        });
        let started = Instant::now();
        let err = run(sh("sleep 30"), "sh", &token, Duration::from_secs(60), None).unwrap_err();
        assert!(matches!(err, Error::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn cancel_kills_grandchildren_that_hold_the_pipes() {
        // sh spawns a background sleep that inherits stdout/stderr; killing only `sh` would
        // leave the pipe open for 30 s
        let token = CancelToken::new();
        let t2 = token.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            t2.cancel();
        });
        let started = Instant::now();
        let err = run(sh("sleep 30 & sleep 30; wait"), "sh", &token, Duration::from_secs(60), None).unwrap_err();
        assert!(matches!(err, Error::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(3), "took {:?}", started.elapsed());
    }

    #[test]
    fn timeout_kills_the_child() {
        let started = Instant::now();
        let err = run(sh("sleep 30"), "sh", &CancelToken::new(), Duration::from_millis(200), None).unwrap_err();
        assert!(matches!(err, Error::Timeout { .. }));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn missing_executable_is_tool_missing() {
        let err = run(Command::new("/definitely/not/here"), "ghost", &CancelToken::new(), Duration::from_secs(1), None).unwrap_err();
        assert!(matches!(err, Error::ToolMissing { .. }));
    }
}
