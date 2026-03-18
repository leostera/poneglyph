use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
};
use oauth2::{
    AuthType, AuthorizationCode, CsrfToken, PkceCodeChallenge, PkceCodeVerifier, TokenResponse,
    basic::{BasicClient, BasicTokenResponse},
};
use serde::{Deserialize, Serialize};
use tracing::debug;

use crate::{context::AppContext, views};

#[derive(Debug, Deserialize)]
pub(crate) struct GoogleCallbackQuery {
    pub code: String,
    pub state: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct GoogleCallbackError {
    pub error: String,
}

#[derive(Debug, Deserialize, Default)]
pub(crate) struct GoogleMaybeCallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
}

pub(crate) async fn login(State(context): State<AppContext>) -> Redirect {
    debug!(
        component = "poneglyph_api",
        provider = "google",
        "starting google oauth login"
    );
    let client = if let Some(secret) = context.google_oauth.client_secret() {
        BasicClient::new(context.google_oauth.client_id())
            .set_client_secret(secret)
            .set_auth_type(AuthType::RequestBody)
            .set_auth_uri(context.google_oauth.auth_url())
            .set_token_uri(context.google_oauth.token_url())
            .set_redirect_uri(context.google_oauth.redirect_url())
    } else {
        BasicClient::new(context.google_oauth.client_id())
            .set_auth_type(AuthType::RequestBody)
            .set_auth_uri(context.google_oauth.auth_url())
            .set_token_uri(context.google_oauth.token_url())
            .set_redirect_uri(context.google_oauth.redirect_url())
    };
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let (auth_url, state) = client
        .authorize_url(CsrfToken::new_random)
        .add_scope(context.google_oauth.scope())
        .add_extra_param("access_type", "offline")
        .add_extra_param("prompt", "consent")
        .set_pkce_challenge(challenge)
        .url();

    context.insert_google_auth_state(&state, verifier).await;
    debug!(
        component = "poneglyph_api",
        provider = "google",
        "generated google oauth redirect"
    );
    let auth_url = auth_url.to_string();
    Redirect::temporary(&auth_url)
}

pub(crate) async fn callback(
    State(context): State<AppContext>,
    Query(query): Query<GoogleCallbackQuery>,
) -> Response {
    if let Some(pending) = context.take_google_auth_state(&query.state).await {
        let client = if let Some(secret) = context.google_oauth.client_secret() {
            BasicClient::new(context.google_oauth.client_id())
                .set_client_secret(secret)
                .set_auth_type(AuthType::RequestBody)
                .set_auth_uri(context.google_oauth.auth_url())
                .set_token_uri(context.google_oauth.token_url())
                .set_redirect_uri(context.google_oauth.redirect_url())
        } else {
            BasicClient::new(context.google_oauth.client_id())
                .set_auth_type(AuthType::RequestBody)
                .set_auth_uri(context.google_oauth.auth_url())
                .set_token_uri(context.google_oauth.token_url())
                .set_redirect_uri(context.google_oauth.redirect_url())
        };
        let http_client = reqwest::Client::new();
        let token: BasicTokenResponse = match client
            .exchange_code(AuthorizationCode::new(query.code.clone()))
            .set_pkce_verifier(PkceCodeVerifier::new(pending.verifier))
            .request_async(&http_client)
            .await
        {
            Ok(token) => token,
            Err(error) => {
                debug!(
                    component = "poneglyph_api",
                    provider = "google",
                    error = %error,
                    "google oauth code exchange failed"
                );
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(GoogleCallbackError {
                        error: format!("google oauth code exchange failed: {error}"),
                    }),
                )
                    .into_response();
            }
        };
        let expires_at = token
            .expires_in()
            .and_then(|duration| chrono::Duration::from_std(duration).ok())
            .map(|duration| chrono::Utc::now() + duration);
        let scopes = token
            .scopes()
            .map(|scopes| scopes.iter().map(|scope| scope.to_string()).collect())
            .unwrap_or_else(|| vec![context.google_oauth.scope.to_string()]);
        let saved = match context
            .ctl
            .save_google_oauth_connection(poneglyph_ctl::SaveGoogleOAuthConnection {
                access_token: token.access_token().secret().to_string(),
                refresh_token: token
                    .refresh_token()
                    .map(|token| token.secret().to_string()),
                token_type: token.token_type().as_ref().to_string(),
                scopes,
                expires_at,
            })
            .await
        {
            Ok(saved) => saved,
            Err(error) => {
                debug!(
                    component = "poneglyph_api",
                    provider = "google",
                    error = %error,
                    "failed to persist google oauth connection"
                );
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(GoogleCallbackError {
                        error: format!("failed to persist google oauth connection: {error}"),
                    }),
                )
                    .into_response();
            }
        };
        debug!(
            component = "poneglyph_api",
            provider = "google",
            connection_id = saved.id,
            "validated and persisted google oauth callback"
        );
        (StatusCode::OK, views::auth::login_successful("Google")).into_response()
    } else {
        debug!(
            component = "poneglyph_api",
            provider = "google",
            "rejected google oauth callback with unknown state"
        );
        (
            StatusCode::BAD_REQUEST,
            Json(GoogleCallbackError {
                error: "invalid google oauth state".to_string(),
            }),
        )
            .into_response()
    }
}

pub(crate) async fn root(
    State(context): State<AppContext>,
    Query(query): Query<GoogleMaybeCallbackQuery>,
) -> Response {
    match (query.code, query.state) {
        (Some(code), Some(state)) => {
            callback(State(context), Query(GoogleCallbackQuery { code, state })).await
        }
        _ => (StatusCode::OK, views::auth::landing()).into_response(),
    }
}
