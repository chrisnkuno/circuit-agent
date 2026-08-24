use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{BrainIndex, SearchOptions, StateIndex};

pub const STATE_PROTOCOL_VERSION: u64 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: Value,
    pub protocol_version: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub id: Value,
    pub protocol_version: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ProtocolError>,
}

#[derive(Debug, Serialize)]
pub struct ProtocolError {
    pub code: &'static str,
    pub message: String,
}

impl Response {
    fn success(id: Value, result: Value) -> Self {
        Self {
            id,
            protocol_version: STATE_PROTOCOL_VERSION,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    fn failure(id: Value, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            id,
            protocol_version: STATE_PROTOCOL_VERSION,
            ok: false,
            result: None,
            error: Some(ProtocolError {
                code,
                message: message.into(),
            }),
        }
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::failure(Value::Null, "invalid_request", message)
    }
    pub fn internal(id: Option<Value>, message: impl Into<String>) -> Self {
        Self::failure(id.unwrap_or(Value::Null), "internal", message)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootParams {
    root: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchParams {
    root: PathBuf,
    query: String,
    #[serde(flatten)]
    options: SearchOptions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    root: PathBuf,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextParams {
    root: PathBuf,
    session_id: String,
    source: String,
    position: i64,
    window: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrainParams {
    source_root: PathBuf,
    data_root: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrainSearchParams {
    source_root: PathBuf,
    data_root: PathBuf,
    query: String,
    limit: Option<usize>,
    now: String,
}

pub fn handle_request(request: Request) -> Response {
    let id = request.id;
    if request.protocol_version != STATE_PROTOCOL_VERSION {
        return Response::failure(
            id,
            "unsupported_protocol",
            format!(
                "expected protocol {}, received {}",
                STATE_PROTOCOL_VERSION, request.protocol_version
            ),
        );
    }
    let result = match request.method.as_str() {
        "ping" => Ok(json!({
            "name": "nova-state",
            "version": env!("CARGO_PKG_VERSION"),
            "readOnlyCanonicalSources": true,
            "capabilities": ["index.rebuild", "search", "session.list", "session.context", "brain.rebuild", "brain.search"]
        })),
        "index.rebuild" => parse::<RootParams>(request.params).and_then(|params| {
            let mut index = StateIndex::open(params.root)?;
            Ok(serde_json::to_value(index.rebuild_all()?)?)
        }),
        "search" => parse::<SearchParams>(request.params).and_then(|params| {
            anyhow::ensure!(
                params.query.chars().count() <= 1_024,
                "search query exceeds 1024 characters"
            );
            let index = StateIndex::open(params.root)?;
            Ok(serde_json::to_value(
                index.search(&params.query, params.options)?,
            )?)
        }),
        "session.list" => parse::<ListParams>(request.params).and_then(|params| {
            let index = StateIndex::open(params.root)?;
            Ok(serde_json::to_value(
                index.sessions(params.limit.unwrap_or(20))?,
            )?)
        }),
        "session.context" => parse::<ContextParams>(request.params).and_then(|params| {
            anyhow::ensure!(
                matches!(params.source.as_str(), "snapshot" | "journal"),
                "source must be snapshot or journal"
            );
            let index = StateIndex::open(params.root)?;
            Ok(serde_json::to_value(index.context(
                &params.session_id,
                &params.source,
                params.position,
                params.window.unwrap_or(5).clamp(1, 20),
                None,
            )?)?)
        }),
        "brain.rebuild" => parse::<BrainParams>(request.params).and_then(|params| {
            let mut brain = BrainIndex::open(params.source_root, params.data_root)?;
            Ok(serde_json::to_value(brain.rebuild()?)?)
        }),
        "brain.search" => parse::<BrainSearchParams>(request.params).and_then(|params| {
            let brain = BrainIndex::open(params.source_root, params.data_root)?;
            Ok(serde_json::to_value(brain.search(
                &params.query,
                params.limit.unwrap_or(4),
                &params.now,
            )?)?)
        }),
        other => {
            return Response::failure(id, "method_not_found", format!("unknown method {other}"))
        }
    };
    match result {
        Ok(value) => Response::success(id, value),
        Err(error) => Response::failure(id, "state_error", format!("{error:#}")),
    }
}

fn parse<T: for<'de> Deserialize<'de>>(value: Value) -> anyhow::Result<T> {
    serde_json::from_value(value).map_err(Into::into)
}
