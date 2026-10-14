use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// Every failure the native layer can report. Variants carry enough detail that the UI
/// can show the *exact* reason for a failure instead of a generic "something went wrong".
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{tool} was not found. {hint}")]
    ToolMissing { tool: String, hint: String },

    #[error("File not found: {0}")]
    NotFound(String),

    #[error("Unsupported or unrecognised file type: {0}")]
    UnsupportedFormat(String),

    #[error("The file does not look like valid media: {0}")]
    NotMedia(String),

    #[error("Invalid parameter: {0}")]
    InvalidParam(String),

    #[error("Unsafe path rejected: {0}")]
    UnsafePath(String),

    #[error("Operation cancelled")]
    Cancelled,

    #[error("{tool} failed (exit code {code:?}): {detail}")]
    ToolFailed {
        tool: String,
        code: Option<i32>,
        detail: String,
    },

    #[error("{tool} did not finish within {secs}s and was stopped")]
    Timeout { tool: String, secs: u64 },

    #[error("I/O error while {context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },

    #[error("Invalid data: {0}")]
    Data(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// Stable machine-readable code for the frontend.
    pub fn code(&self) -> &'static str {
        match self {
            Error::ToolMissing { .. } => "tool_missing",
            Error::NotFound(_) => "not_found",
            Error::UnsupportedFormat(_) => "unsupported_format",
            Error::NotMedia(_) => "not_media",
            Error::InvalidParam(_) => "invalid_param",
            Error::UnsafePath(_) => "unsafe_path",
            Error::Cancelled => "cancelled",
            Error::ToolFailed { .. } => "tool_failed",
            Error::Timeout { .. } => "timeout",
            Error::Io { .. } => "io",
            Error::Data(_) => "data",
        }
    }

    pub fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        Error::Io {
            context: context.into(),
            source,
        }
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("Error", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

/// Adds context to `std::io::Result`.
pub trait IoContext<T> {
    fn ctx(self, what: &str) -> Result<T>;
}

impl<T> IoContext<T> for std::io::Result<T> {
    fn ctx(self, what: &str) -> Result<T> {
        self.map_err(|e| Error::io(what, e))
    }
}
