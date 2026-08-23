use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

const JOURNAL_PROTOCOL_VERSION: u64 = 1;
const SESSION_SCHEMA_VERSION: u64 = 2;
const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Error)]
pub enum SourceError {
    #[error("cannot read {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("invalid JSON in {path}: {source}")]
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("unsupported {kind} version {found} in {path}")]
    UnsupportedVersion {
        path: PathBuf,
        kind: &'static str,
        found: u64,
    },
    #[error("invalid journal chain at sequence {sequence} in {path}")]
    InvalidChain { path: PathBuf, sequence: u64 },
    #[error("journal integrity check failed at sequence {sequence} in {path}")]
    Integrity { path: PathBuf, sequence: u64 },
    #[error("session integrity check failed in {path}")]
    SessionIntegrity { path: PathBuf },
    #[error("invalid {kind} record in {path}: {message}")]
    InvalidRecord {
        path: PathBuf,
        kind: &'static str,
        message: String,
    },
}

#[derive(Debug, Clone)]
pub struct SourceDocument {
    pub source: &'static str,
    pub position: i64,
    pub timestamp: String,
    pub role: Option<String>,
    pub kind: String,
    pub turn_id: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct JournalRecord {
    pub session_id: String,
    pub events: Vec<Value>,
    pub documents: Vec<SourceDocument>,
    pub first_at: Option<String>,
    pub last_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SessionRecord {
    pub session_id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub revision: i64,
    pub documents: Vec<SourceDocument>,
}

fn read(path: &Path) -> Result<String, SourceError> {
    fs::read_to_string(path).map_err(|source| SourceError::Io {
        path: path.to_owned(),
        source,
    })
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn as_object<'a>(
    value: &'a Value,
    path: &Path,
    kind: &'static str,
) -> Result<&'a Map<String, Value>, SourceError> {
    value.as_object().ok_or_else(|| SourceError::InvalidRecord {
        path: path.to_owned(),
        kind,
        message: "expected an object".into(),
    })
}

fn string_field<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    path: &Path,
    kind: &'static str,
) -> Result<&'a str, SourceError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| SourceError::InvalidRecord {
            path: path.to_owned(),
            kind,
            message: format!("missing string field {key}"),
        })
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonicalize).collect()),
        Value::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_by_key(|(left, _)| *left);
            let mut canonical = Map::new();
            for (key, value) in entries {
                canonical.insert(key.clone(), canonicalize(value));
            }
            Value::Object(canonical)
        }
        other => other.clone(),
    }
}

fn json_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return (!text.trim().is_empty()).then(|| text.trim().to_owned());
    }
    if value.is_null() {
        return None;
    }
    serde_json::to_string(value)
        .ok()
        .filter(|text| text != "{}" && text != "[]")
}

fn sanitize_search_text(text: &str) -> String {
    let sanitized = text
        .lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            let assignment = lower.contains('=') || lower.contains(':');
            let secret_assignment = assignment
                && [
                    "api_key",
                    "api-key",
                    "apikey",
                    "authorization",
                    "cookie",
                    "credential",
                    "password",
                    "private_key",
                    "private-key",
                    "secret",
                    "token",
                ]
                .iter()
                .any(|marker| lower.contains(marker));
            let credential_material = lower.contains("-----begin ")
                && lower.contains("private key-----")
                || lower.contains("authorization: bearer ");
            if secret_assignment || credential_material {
                "[REDACTED]"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    const MAX_SEARCH_CHARS: usize = 8_000;
    let characters = sanitized.chars().count();
    if characters <= MAX_SEARCH_CHARS {
        sanitized
    } else {
        format!(
            "{}\n…[{} chars omitted]",
            sanitized.chars().take(MAX_SEARCH_CHARS).collect::<String>(),
            characters - MAX_SEARCH_CHARS
        )
    }
}

fn journal_document(event: &Value) -> Option<SourceDocument> {
    let object = event.as_object()?;
    let position = object.get("sequence")?.as_i64()?;
    let timestamp = object.get("timestamp")?.as_str()?.to_owned();
    let payload = object.get("payload")?.as_object()?;
    let turn_id = payload
        .get("turnId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    match payload.get("type")?.as_str()? {
        "approval_requested" => {
            let request = payload.get("request")?.as_object()?;
            let summary = request.get("summary").and_then(Value::as_str)?;
            Some(SourceDocument {
                source: "journal",
                position,
                timestamp,
                role: None,
                kind: "approval".into(),
                turn_id,
                text: sanitize_search_text(summary),
            })
        }
        "runtime" => {
            let runtime = payload.get("event")?.as_object()?;
            let event_type = runtime.get("type")?.as_str()?;
            let (role, kind, text) = match event_type {
                "tool_call" => {
                    let name = runtime
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or("tool");
                    let arguments = runtime
                        .get("arguments")
                        .and_then(json_text)
                        .unwrap_or_default();
                    (None, "tool_call", format!("{name} {arguments}"))
                }
                "tool_result" => (
                    Some("tool".into()),
                    "tool_result",
                    runtime.get("content").and_then(json_text)?,
                ),
                "runtime_stop" => (
                    Some("assistant".into()),
                    "summary",
                    runtime.get("summary").and_then(json_text)?,
                ),
                _ => return None,
            };
            Some(SourceDocument {
                source: "journal",
                position,
                timestamp,
                role,
                kind: kind.into(),
                turn_id,
                text: sanitize_search_text(&text),
            })
        }
        _ => None,
    }
}

/// Reads complete JSONL records and verifies the exact JS-compatible hash chain.
pub fn read_journal(path: &Path, expected_session_id: &str) -> Result<JournalRecord, SourceError> {
    let contents = read(path)?;
    let complete = if contents.ends_with('\n') {
        contents.as_str()
    } else {
        contents
            .rsplit_once('\n')
            .map(|(prefix, _)| prefix)
            .unwrap_or("")
    };
    let mut events = Vec::new();
    let mut documents = Vec::new();
    let mut previous_hash = GENESIS_HASH.to_owned();
    let mut first_at = None;
    let mut last_at = None;

    for (index, line) in complete.lines().filter(|line| !line.is_empty()).enumerate() {
        let mut event: Value = serde_json::from_str(line).map_err(|source| SourceError::Json {
            path: path.to_owned(),
            source,
        })?;
        let object = as_object(&event, path, "journal")?;
        let sequence = object.get("sequence").and_then(Value::as_u64).unwrap_or(0);
        let protocol_version = object
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if protocol_version != JOURNAL_PROTOCOL_VERSION {
            return Err(SourceError::UnsupportedVersion {
                path: path.to_owned(),
                kind: "journal",
                found: protocol_version,
            });
        }
        if sequence != index as u64 + 1
            || string_field(object, "sessionId", path, "journal")? != expected_session_id
            || string_field(object, "previousHash", path, "journal")? != previous_hash
        {
            return Err(SourceError::InvalidChain {
                path: path.to_owned(),
                sequence,
            });
        }
        let expected_hash = string_field(object, "hash", path, "journal")?.to_owned();
        let object = event
            .as_object_mut()
            .ok_or_else(|| SourceError::InvalidRecord {
                path: path.to_owned(),
                kind: "journal",
                message: "event must be an object".into(),
            })?;
        // The chain is verified over the event without its own digest, but the indexed record still
        // carries it. Lifting it out and putting it back at the same position keeps the verified
        // value byte-identical to the line on disk without parsing that line a second time.
        let digest_position = object
            .keys()
            .position(|key| key == "hash")
            .unwrap_or(object.len());
        object.shift_remove("hash");
        let encoded = serde_json::to_vec(&event).map_err(|source| SourceError::Json {
            path: path.to_owned(),
            source,
        })?;
        if sha256(&encoded) != expected_hash {
            return Err(SourceError::Integrity {
                path: path.to_owned(),
                sequence,
            });
        }
        if let Some(object) = event.as_object_mut() {
            object.shift_insert(
                digest_position,
                "hash".into(),
                Value::String(expected_hash.clone()),
            );
        }
        previous_hash = expected_hash;

        let timestamp = event
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        first_at.get_or_insert_with(|| timestamp.clone());
        last_at = Some(timestamp);
        if let Some(document) = journal_document(&event) {
            documents.push(document);
        }
        events.push(event);
    }

    Ok(JournalRecord {
        session_id: expected_session_id.into(),
        events,
        documents,
        first_at,
        last_at,
    })
}

fn session_message_document(
    message: &Value,
    index: usize,
    updated_at: i64,
) -> Option<SourceDocument> {
    let object = message.as_object()?;
    if object
        .get("internal")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let role = object.get("role")?.as_str()?.to_owned();
    let content = object.get("content").and_then(json_text)?;
    Some(SourceDocument {
        source: "snapshot",
        position: index as i64 + 1,
        timestamp: updated_at.to_string(),
        role: Some(role.clone()),
        kind: "message".into(),
        turn_id: None,
        text: sanitize_search_text(&content),
    })
}

/// Reads an integrity-checked resumable snapshot. Unknown additive fields remain forward-compatible.
pub fn read_session(path: &Path, expected_session_id: &str) -> Result<SessionRecord, SourceError> {
    let contents = read(path)?;
    let mut value: Value = serde_json::from_str(&contents).map_err(|source| SourceError::Json {
        path: path.to_owned(),
        source,
    })?;
    let object = as_object(&value, path, "session")?;
    let session_id = string_field(object, "id", path, "session")?;
    if session_id != expected_session_id {
        return Err(SourceError::InvalidRecord {
            path: path.to_owned(),
            kind: "session",
            message: "id does not match filename".into(),
        });
    }
    let version = object
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    if version > SESSION_SCHEMA_VERSION {
        return Err(SourceError::UnsupportedVersion {
            path: path.to_owned(),
            kind: "session",
            found: version,
        });
    }
    let integrity = object
        .get("integrity")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let Some(expected) = integrity {
        value
            .as_object_mut()
            .ok_or_else(|| SourceError::InvalidRecord {
                path: path.to_owned(),
                kind: "session",
                message: "session must be an object".into(),
            })?
            .shift_remove("integrity");
        let canonical = canonicalize(&value);
        let encoded = serde_json::to_vec(&canonical).map_err(|source| SourceError::Json {
            path: path.to_owned(),
            source,
        })?;
        if sha256(&encoded) != expected {
            return Err(SourceError::SessionIntegrity {
                path: path.to_owned(),
            });
        }
    }

    let object = as_object(&value, path, "session")?;
    let title = sanitize_search_text(
        object
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Untitled session"),
    );
    let created_at = object.get("createdAt").and_then(Value::as_i64).unwrap_or(0);
    let updated_at = object
        .get("updatedAt")
        .and_then(Value::as_i64)
        .unwrap_or(created_at);
    let revision = object.get("revision").and_then(Value::as_i64).unwrap_or(0);
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| SourceError::InvalidRecord {
            path: path.to_owned(),
            kind: "session",
            message: "messages must be an array".into(),
        })?;
    let documents = messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| session_message_document(message, index, updated_at))
        .collect();
    Ok(SessionRecord {
        session_id: expected_session_id.into(),
        title,
        created_at,
        updated_at,
        revision,
        documents,
    })
}

pub(crate) fn session_id_from_file(path: &Path, suffix: &str) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let id = name.strip_suffix(suffix)?;
    let safe = !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        });
    safe.then(|| id.to_owned())
}

/// The digest the TypeScript writer stamps into every snapshot: SHA-256 over the canonical record
/// with `integrity` removed. Tests and the benchmark corpus both have to produce snapshots that are
/// indistinguishable from what `session.ts` writes, and a second copy of the rule in either of them
/// would be free to drift away from the one `read_session` verifies against.
#[cfg(any(test, feature = "benchmark"))]
pub fn integrity_for_session(mut value: Value) -> String {
    value
        .as_object_mut()
        .expect("session object")
        .shift_remove("integrity");
    sha256(&serde_json::to_vec(&canonicalize(&value)).expect("serializable"))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn session_integrity_matches_the_canonical_typescript_shape() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("verified.json");
        let mut session = json!({
            "updatedAt": 20,
            "title": "Verified",
            "totalRwf": 0,
            "schemaVersion": 2,
            "root": directory.path().to_string_lossy(),
            "revision": 3,
            "messages": [{"role":"user","content":"hello"}],
            "id": "verified",
            "createdAt": 10,
            "approvals": {},
            "nullable": null
        });
        let integrity = integrity_for_session(session.clone());
        session
            .as_object_mut()
            .unwrap()
            .insert("integrity".into(), Value::String(integrity));
        fs::write(&path, serde_json::to_vec_pretty(&session).unwrap()).unwrap();

        assert_eq!(read_session(&path, "verified").unwrap().revision, 3);
        session["title"] = json!("tampered");
        fs::write(&path, serde_json::to_vec_pretty(&session).unwrap()).unwrap();
        assert!(matches!(
            read_session(&path, "verified"),
            Err(SourceError::SessionIntegrity { .. })
        ));
    }

    #[test]
    fn credential_lines_never_enter_search_documents() {
        let document = session_message_document(
            &json!({"role":"user","content":"deploy staging\nAPI_KEY=super-secret-value\nthen verify health"}),
            0,
            1,
        ).unwrap();
        assert_eq!(
            document.text,
            "deploy staging\n[REDACTED]\nthen verify health"
        );
        assert!(!document.text.contains("super-secret-value"));
    }

    #[test]
    fn internal_runtime_prompts_never_enter_search_documents() {
        assert!(session_message_document(
            &json!({"role":"user","content":"automatic verification nudge","internal":true}),
            0,
            1,
        )
        .is_none());
    }
}
