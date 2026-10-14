//! A tiny binary container for the desktop shell's IPC: one JSON document plus any number of
//! raw byte blobs in a single message, so DDS files, PNG frames and `.ypt` binaries never have to
//! be turned into JSON number arrays.
//!
//! ```text
//! "VFXW" | version u8 (=1) | json length u32 LE | json | blob count u32 LE | { length u32 LE | bytes }*
//! ```
//!
//! `unpack` treats its input as hostile: every length is checked against the remaining bytes
//! and against hard limits before anything is allocated or sliced.

use crate::error::{Error, Result};
use serde_json::Value;

const MAGIC: &[u8; 4] = b"VFXW";
const VERSION: u8 = 1;
pub const MAX_JSON_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_BLOBS: usize = 4096;

pub fn pack(json: &Value, blobs: &[&[u8]]) -> Result<Vec<u8>> {
    let j = serde_json::to_vec(json).map_err(|e| Error::Data(format!("cannot encode the message: {e}")))?;
    if j.len() > MAX_JSON_BYTES || blobs.len() > MAX_BLOBS {
        return Err(Error::InvalidParam("message is too large".into()));
    }
    let total: usize = blobs.iter().map(|b| b.len() + 4).sum::<usize>() + j.len() + 4 + 1 + 4 + 4;
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&(j.len() as u32).to_le_bytes());
    out.extend_from_slice(&j);
    out.extend_from_slice(&(blobs.len() as u32).to_le_bytes());
    for b in blobs {
        let len = u32::try_from(b.len()).map_err(|_| Error::InvalidParam("a blob is larger than 4 GiB".into()))?;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(b);
    }
    Ok(out)
}

fn take<'a>(bytes: &'a [u8], at: &mut usize, n: usize) -> Result<&'a [u8]> {
    let end = at.checked_add(n).filter(|e| *e <= bytes.len()).ok_or_else(|| Error::Data("truncated message".into()))?;
    let s = &bytes[*at..end];
    *at = end;
    Ok(s)
}

fn take_u32(bytes: &[u8], at: &mut usize) -> Result<usize> {
    let b = take(bytes, at, 4)?;
    Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
}

pub fn unpack(bytes: &[u8]) -> Result<(Value, Vec<&[u8]>)> {
    let mut at = 0usize;
    if take(bytes, &mut at, 4)? != MAGIC {
        return Err(Error::Data("not a VFXForge message".into()));
    }
    if take(bytes, &mut at, 1)?[0] != VERSION {
        return Err(Error::Data("unsupported message version".into()));
    }
    let jl = take_u32(bytes, &mut at)?;
    if jl > MAX_JSON_BYTES {
        return Err(Error::Data("message header is too large".into()));
    }
    let json: Value = serde_json::from_slice(take(bytes, &mut at, jl)?).map_err(|e| Error::Data(format!("message JSON is invalid: {e}")))?;
    let count = take_u32(bytes, &mut at)?;
    if count > MAX_BLOBS {
        return Err(Error::Data("too many attachments".into()));
    }
    let mut blobs = Vec::with_capacity(count);
    for _ in 0..count {
        let l = take_u32(bytes, &mut at)?;
        blobs.push(take(bytes, &mut at, l)?);
    }
    if at != bytes.len() {
        return Err(Error::Data("unexpected trailing bytes in message".into()));
    }
    Ok((json, blobs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_json_and_blobs() {
        let a = vec![1u8, 2, 3];
        let b: Vec<u8> = vec![];
        let c = vec![9u8; 100_000];
        let msg = pack(&json!({ "name": "x", "n": 3 }), &[&a, &b, &c]).unwrap();
        let (j, blobs) = unpack(&msg).unwrap();
        assert_eq!(j["name"], "x");
        assert_eq!(blobs.len(), 3);
        assert_eq!(blobs[0], &a[..]);
        assert!(blobs[1].is_empty());
        assert_eq!(blobs[2].len(), 100_000);
    }

    /// The same bytes are asserted by `apps/desktop/test/wire.test.ts`: the two implementations must agree.
    #[test]
    fn matches_the_typescript_reference_bytes() {
        let msg = pack(&json!({ "a": 1 }), &[&[1u8, 2, 3][..], &[][..]]).unwrap();
        let hex: String = msg.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, "5646585701070000007b2261223a317d020000000300000001020300000000");
    }

    #[test]
    fn rejects_garbage_without_panicking() {
        assert!(unpack(b"").is_err());
        assert!(unpack(b"VFXW").is_err());
        assert!(unpack(b"NOPE\x01\0\0\0\0\0\0\0\0").is_err());
        let good = pack(&json!({}), &[&[1, 2, 3][..]]).unwrap();
        for cut in 0..good.len() {
            assert!(unpack(&good[..cut]).is_err(), "truncation at {cut} must fail");
        }
        let mut trailing = good.clone();
        trailing.push(0);
        assert!(unpack(&trailing).is_err());
        let mut bad_version = good.clone();
        bad_version[4] = 9;
        assert!(unpack(&bad_version).is_err());
    }

    #[test]
    fn hostile_lengths_do_not_allocate_or_overflow() {
        // json length claims 4 GiB - 1 in a 13 byte message
        let mut m = b"VFXW\x01".to_vec();
        m.extend_from_slice(&u32::MAX.to_le_bytes());
        assert!(unpack(&m).is_err());
        // blob count claims millions
        let mut m = pack(&json!({}), &[]).unwrap();
        let n = m.len();
        m[n - 4..].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(unpack(&m).is_err());
        // blob length claims more than remains
        let mut m = pack(&json!({}), &[&[1u8][..]]).unwrap();
        let n = m.len();
        m[n - 5..n - 1].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(unpack(&m).is_err());
    }
}
