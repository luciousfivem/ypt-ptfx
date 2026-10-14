//! Cancellation tokens and a registry of running jobs, so the UI can cancel by id.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default, Debug)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Default)]
pub struct JobRegistry {
    next: AtomicU64,
    jobs: Mutex<HashMap<String, CancelToken>>,
}

impl JobRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a new job and returns its id + token.
    pub fn start(&self, prefix: &str) -> (String, CancelToken) {
        let id = format!("{prefix}-{}", self.next.fetch_add(1, Ordering::SeqCst) + 1);
        let token = CancelToken::new();
        self.jobs
            .lock()
            .expect("job registry poisoned")
            .insert(id.clone(), token.clone());
        (id, token)
    }

    /// Requests cancellation. Returns false when the id is unknown (already finished).
    pub fn cancel(&self, id: &str) -> bool {
        match self.jobs.lock().expect("job registry poisoned").get(id) {
            Some(t) => {
                t.cancel();
                true
            }
            None => false,
        }
    }

    pub fn finish(&self, id: &str) {
        self.jobs.lock().expect("job registry poisoned").remove(id);
    }

    pub fn running(&self) -> usize {
        self.jobs.lock().expect("job registry poisoned").len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_by_id() {
        let reg = JobRegistry::new();
        let (a, ta) = reg.start("extract");
        let (b, tb) = reg.start("extract");
        assert_ne!(a, b);
        assert_eq!(reg.running(), 2);
        assert!(reg.cancel(&a));
        assert!(ta.is_cancelled());
        assert!(!tb.is_cancelled());
        reg.finish(&a);
        assert!(!reg.cancel(&a));
        assert_eq!(reg.running(), 1);
    }
}
