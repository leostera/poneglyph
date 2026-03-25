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
use poneglyph_ctl::{GmailConnector, SaveGoogleOAuthConnection};
use serde::{Deserialize, Serialize};
use tracing::debug;
use url::Url;

use crate::{context::AppContext, views};

#[derive(Debug, Deserialize)]
pub(crate) struct GoogleLoginQuery {
    pub handoff_uri: Option<String>,
    pub connector: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GoogleCallbackQuery {
    pub code: String,
    pub state: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct GoogleCallbackError {
    pub error: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct GoogleAuthGrantPayload {
    pub grant_id: String,
    pub connection_id: i64,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_type: String,
    pub scopes: Vec<String>,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GoogleRedeemGrantQuery {
    pub grant: String,
}

#[derive(Debug, Deserialize, Default)]
pub(crate) struct GoogleMaybeCallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
}

pub(crate) async fn login(
    State(context): State<AppContext>,
    Query(query): Query<GoogleLoginQuery>,
) -> Redirect {
    debug!(
        component = "poneglyph_api",
        provider = "google",
        has_handoff_uri = query.handoff_uri.is_some(),
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
    let connector = query.connector.as_deref().unwrap_or("gcal");
    let scopes = context
        .google_oauth
        .scopes_for_connector(connector)
        .into_iter()
        .collect::<Vec<_>>();
    let mut auth_request = client
        .authorize_url(CsrfToken::new_random)
        .add_extra_param("access_type", "offline")
        .add_extra_param("prompt", "consent")
        .set_pkce_challenge(challenge);
    for scope in scopes {
        auth_request = auth_request.add_scope(scope);
    }
    let (auth_url, state) = auth_request.url();

    context
        .insert_google_auth_state(
            &state,
            verifier,
            query.handoff_uri,
            context
                .google_oauth
                .scopes_for_connector(connector)
                .into_iter()
                .map(|scope| scope.to_string())
                .collect(),
        )
        .await;
    debug!(
        component = "poneglyph_api",
        provider = "google",
        "generated google oauth redirect"
    );
    let auth_url = auth_url.to_string();
    Redirect::temporary(&auth_url)
}

async fn callback_with_code_and_state(context: AppContext, query: GoogleCallbackQuery) -> Response {
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
            .unwrap_or_else(|| pending.requested_scopes.clone());
        let saved = match context
            .ctl
            .save_google_oauth_connection(SaveGoogleOAuthConnection {
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
        if has_gmail_read_scope(&saved.scopes) {
            bootstrap_gmail_metadata_sync(&context, saved.id).await;
        }
        if let Some(handoff_uri) = pending.handoff_uri {
            let grant = context.issue_google_auth_grant(saved).await;
            match build_handoff_redirect(&handoff_uri, &grant.grant_id) {
                Ok(redirect_uri) => {
                    debug!(
                        component = "poneglyph_api",
                        provider = "google",
                        grant_id = %grant.grant_id,
                        handoff_uri = %redirect_uri,
                        "redirecting completed google oauth flow to handoff uri"
                    );
                    Redirect::temporary(&redirect_uri).into_response()
                }
                Err(error) => (
                    StatusCode::BAD_REQUEST,
                    Json(GoogleCallbackError {
                        error: format!("invalid google auth handoff uri: {error}"),
                    }),
                )
                    .into_response(),
            }
        } else {
            (StatusCode::OK, views::auth::login_successful("Google")).into_response()
        }
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

pub(crate) async fn grant(
    State(context): State<AppContext>,
    Query(query): Query<GoogleRedeemGrantQuery>,
) -> Response {
    callback_with_grant(context, query.grant).await
}

async fn callback_with_grant(context: AppContext, grant_id: String) -> Response {
    let Some(base_url) = context.api.google_auth_base_url.clone() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(GoogleCallbackError {
                error: "google auth handoff is not configured for this api instance".to_string(),
            }),
        )
            .into_response();
    };

    let redeem_url = match build_handoff_redeem_url(&base_url, &grant_id) {
        Ok(url) => url,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(GoogleCallbackError {
                    error: format!("invalid google auth base url: {error}"),
                }),
            )
                .into_response();
        }
    };

    debug!(
        component = "poneglyph_api",
        provider = "google",
        grant_id = %grant_id,
        redeem_url = %redeem_url,
        "redeeming google oauth handoff grant from remote api"
    );

    let response = match reqwest::Client::new().get(&redeem_url).send().await {
        Ok(response) => response,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(GoogleCallbackError {
                    error: format!("failed to reach remote google auth api: {error}"),
                }),
            )
                .into_response();
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_else(|_| String::new());
        return (
            StatusCode::BAD_GATEWAY,
            Json(GoogleCallbackError {
                error: format!(
                    "remote google auth grant redemption failed with status {status}: {body}"
                ),
            }),
        )
            .into_response();
    }

    let grant = match response.json::<GoogleAuthGrantPayload>().await {
        Ok(grant) => grant,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(GoogleCallbackError {
                    error: format!("failed to decode remote google auth grant: {error}"),
                }),
            )
                .into_response();
        }
    };

    let saved = match context
        .ctl
        .save_google_oauth_connection(SaveGoogleOAuthConnection {
            access_token: grant.access_token,
            refresh_token: grant.refresh_token,
            token_type: grant.token_type,
            scopes: grant.scopes,
            expires_at: grant.expires_at,
        })
        .await
    {
        Ok(saved) => saved,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(GoogleCallbackError {
                    error: format!("failed to persist google oauth handoff locally: {error}"),
                }),
            )
                .into_response();
        }
    };

    debug!(
        component = "poneglyph_api",
        provider = "google",
        grant_id = %grant_id,
        connection_id = saved.id,
        "redeemed and persisted google oauth handoff locally"
    );
    if has_gmail_read_scope(&saved.scopes) {
        bootstrap_gmail_metadata_sync(&context, saved.id).await;
    }

    (StatusCode::OK, views::auth::login_successful("Google")).into_response()
}

pub(crate) async fn redeem(
    State(context): State<AppContext>,
    Query(query): Query<GoogleRedeemGrantQuery>,
) -> Response {
    match context.take_google_auth_grant(&query.grant).await {
        Some(grant) => {
            debug!(
                component = "poneglyph_api",
                provider = "google",
                grant_id = %grant.grant_id,
                connection_id = grant.connection.id,
                "redeemed google oauth handoff grant"
            );
            (
                StatusCode::OK,
                Json(GoogleAuthGrantPayload {
                    grant_id: grant.grant_id,
                    connection_id: grant.connection.id,
                    access_token: grant.connection.access_token,
                    refresh_token: grant.connection.refresh_token,
                    token_type: grant.connection.token_type,
                    scopes: grant.connection.scopes,
                    expires_at: grant.connection.expires_at,
                }),
            )
                .into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(GoogleCallbackError {
                error: "unknown or already redeemed google auth grant".to_string(),
            }),
        )
            .into_response(),
    }
}

pub(crate) async fn root(
    State(context): State<AppContext>,
    Query(query): Query<GoogleMaybeCallbackQuery>,
) -> Response {
    match (query.code, query.state) {
        (Some(code), Some(state)) => {
            callback_with_code_and_state(context, GoogleCallbackQuery { code, state }).await
        }
        _ => (StatusCode::OK, views::auth::landing()).into_response(),
    }
}

fn build_handoff_redirect(handoff_uri: &str, grant_id: &str) -> Result<String, url::ParseError> {
    let mut url = Url::parse(handoff_uri)?;
    url.query_pairs_mut().append_pair("grant", grant_id);
    Ok(url.to_string())
}

async fn bootstrap_gmail_metadata_sync(context: &AppContext, connection_id: i64) {
    let config = context.ctl_config.gmail.clone().unwrap_or_default();
    let connector = match GmailConnector::init(config) {
        Ok(connector) => connector,
        Err(error) => {
            debug!(
                component = "poneglyph_api",
                provider = "google",
                connection_id,
                %error,
                "skipping immediate gmail metadata sync: failed to initialize connector"
            );
            return;
        }
    };

    match connector
        .sync_connection_once(&context.ctl, context.poneglyph.clone(), connection_id)
        .await
    {
        Ok(fact_count) => {
            debug!(
                component = "poneglyph_api",
                provider = "google",
                connection_id,
                fact_count,
                "completed immediate gmail metadata sync after oauth callback"
            );
        }
        Err(error) => {
            debug!(
                component = "poneglyph_api",
                provider = "google",
                connection_id,
                %error,
                "gmail metadata sync after oauth callback failed"
            );
        }
    }
}

fn has_gmail_read_scope(scopes: &[String]) -> bool {
    scopes
        .iter()
        .any(|scope| scope == "https://www.googleapis.com/auth/gmail.readonly")
}

fn build_handoff_redeem_url(base_url: &str, grant_id: &str) -> Result<String, url::ParseError> {
    let mut url = Url::parse(base_url)?;
    url.set_path("/auth/google/redeem");
    url.query_pairs_mut().append_pair("grant", grant_id);
    Ok(url.to_string())
}
