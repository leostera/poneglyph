use axum::{Json, extract::State};
use serde::Serialize;

use crate::context::AppContext;

#[derive(Debug, Serialize)]
pub(crate) struct HealthResponse {
    pub status: &'static str,
}

pub(crate) async fn health(State(context): State<AppContext>) -> Json<HealthResponse> {
    let _ = &context.poneglyph;
    Json(HealthResponse { status: "ok" })
}
