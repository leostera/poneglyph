use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
};
use oauth2::{
    AuthUrl, ClientId, CsrfToken, PkceCodeChallenge, RedirectUrl, Scope, TokenUrl,
    basic::BasicClient,
};
use serde::{Deserialize, Serialize};
use tracing::debug;

use crate::context::AppContext;

const GOOGLE_CLIENT_ID: &str =
    "218820469100-9i3j96lb0ltn3g1sfppuipp3als48o9d.apps.googleusercontent.com";
const GOOGLE_REDIRECT_URI: &str = "http://127.0.0.1:8787/auth/google/callback";
const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar.readonly";

#[derive(Debug, Deserialize)]
pub(crate) struct GoogleCallbackQuery {
    pub code: String,
    pub state: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct GoogleCallbackResponse {
    pub status: &'static str,
    pub message: &'static str,
    pub code: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct GoogleCallbackError {
    pub error: &'static str,
}

pub(crate) async fn login(State(context): State<AppContext>) -> Redirect {
    debug!(
        component = "poneglyph_api",
        provider = "google",
        "starting google oauth login"
    );
    let client = BasicClient::new(ClientId::new(GOOGLE_CLIENT_ID.to_string()))
        .set_auth_uri(AuthUrl::new(GOOGLE_AUTH_URL.to_string()).expect("google auth url"))
        .set_token_uri(TokenUrl::new(GOOGLE_TOKEN_URL.to_string()).expect("google token url"))
        .set_redirect_uri(
            RedirectUrl::new(GOOGLE_REDIRECT_URI.to_string()).expect("google redirect url"),
        );
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let (auth_url, state) = client
        .authorize_url(CsrfToken::new_random)
        .add_scope(Scope::new(GOOGLE_CALENDAR_SCOPE.to_string()))
        .set_pkce_challenge(challenge)
        .url();

    context.insert_google_auth_state(&state, verifier).await;
    debug!(
        component = "poneglyph_api",
        provider = "google",
        "generated google oauth redirect"
    );
    Redirect::temporary(auth_url.as_str())
}

pub(crate) async fn callback(
    State(context): State<AppContext>,
    Query(query): Query<GoogleCallbackQuery>,
) -> Response {
    if let Some(pending) = context.take_google_auth_state(&query.state).await {
        debug!(
            component = "poneglyph_api",
            provider = "google",
            verifier_len = pending.verifier.len(),
            "validated google oauth callback state"
        );
        (
            StatusCode::OK,
            Json(GoogleCallbackResponse {
                status: "ok",
                message: "google oauth callback received",
                code: query.code,
            }),
        )
            .into_response()
    } else {
        debug!(
            component = "poneglyph_api",
            provider = "google",
            "rejected google oauth callback with unknown state"
        );
        (
            StatusCode::BAD_REQUEST,
            Json(GoogleCallbackError {
                error: "invalid google oauth state",
            }),
        )
            .into_response()
    }
}
