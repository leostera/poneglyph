use std::collections::HashMap;
use std::sync::Arc;

use oauth2::{
    AuthUrl, ClientId, ClientSecret, CsrfToken, PkceCodeVerifier, RedirectUrl, Scope, TokenUrl,
};
use poneglyph::Poneglyph;
use poneglyph_ctl::{CtlStore, GoogleOAuthConnection, PoneglyphCtlConfig};
use poneglyph_mcp::PoneglyphMcpServer;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::config::PoneglyphApiConfig;
use crate::services::agent::AgentService;

#[derive(Debug, Clone)]
pub(crate) struct GooglePendingAuth {
    pub verifier: String,
    pub handoff_uri: Option<String>,
    pub requested_scopes: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct GoogleAuthGrant {
    pub grant_id: String,
    pub connection: GoogleOAuthConnection,
}

#[derive(Debug, Clone)]
pub(crate) struct GoogleOAuthConfig {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub auth_url: String,
    pub token_url: String,
    pub redirect_uri: String,
    pub gcal_scopes: Vec<String>,
    pub gmail_scopes: Vec<String>,
}

impl Default for GoogleOAuthConfig {
    fn default() -> Self {
        Self {
            client_id: "218820469100-9i3j96lb0ltn3g1sfppuipp3als48o9d.apps.googleusercontent.com"
                .to_string(),
            client_secret: std::env::var("PONEGLYPH_GOOGLE_SECRET").ok(),
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth".to_string(),
            token_url: "https://oauth2.googleapis.com/token".to_string(),
            redirect_uri: "http://127.0.0.1:8787".to_string(),
            gcal_scopes: vec!["https://www.googleapis.com/auth/calendar.readonly".to_string()],
            gmail_scopes: vec!["https://www.googleapis.com/auth/gmail.readonly".to_string()],
        }
    }
}

impl GoogleOAuthConfig {
    pub fn client_id(&self) -> ClientId {
        ClientId::new(self.client_id.clone())
    }

    pub fn client_secret(&self) -> Option<ClientSecret> {
        self.client_secret.clone().map(ClientSecret::new)
    }

    pub fn auth_url(&self) -> AuthUrl {
        AuthUrl::new(self.auth_url.clone()).expect("google auth url")
    }

    pub fn token_url(&self) -> TokenUrl {
        TokenUrl::new(self.token_url.clone()).expect("google token url")
    }

    pub fn redirect_url(&self) -> RedirectUrl {
        RedirectUrl::new(self.redirect_uri.clone()).expect("google redirect url")
    }

    pub fn scopes_for_connector(&self, connector: &str) -> Vec<Scope> {
        match connector {
            "gmail" => self.gmail_scopes.iter().cloned().map(Scope::new).collect(),
            "gcal" => self.gcal_scopes.iter().cloned().map(Scope::new).collect(),
            _ => self
                .gcal_scopes
                .iter()
                .chain(self.gmail_scopes.iter())
                .cloned()
                .map(Scope::new)
                .collect(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct AppContext {
    pub api: PoneglyphApiConfig,
    pub ctl_config: PoneglyphCtlConfig,
    pub poneglyph: Arc<Poneglyph>,
    pub ctl: CtlStore,
    pub agent: AgentService,
    pub mcp: PoneglyphMcpServer,
    pub google_oauth: GoogleOAuthConfig,
    pub google_auth: Arc<Mutex<HashMap<String, GooglePendingAuth>>>,
    pub google_grants: Arc<Mutex<HashMap<String, GoogleAuthGrant>>>,
}

impl AppContext {
    #[allow(dead_code)]
    pub fn new(poneglyph: Arc<Poneglyph>, ctl: CtlStore) -> Self {
        Self::new_with_google_oauth(
            PoneglyphApiConfig::default(),
            PoneglyphCtlConfig::default(),
            poneglyph,
            ctl,
            GoogleOAuthConfig::default(),
        )
    }

    pub fn new_with_google_oauth(
        api: PoneglyphApiConfig,
        ctl_config: PoneglyphCtlConfig,
        poneglyph: Arc<Poneglyph>,
        ctl: CtlStore,
        google_oauth: GoogleOAuthConfig,
    ) -> Self {
        let agent = AgentService::new(poneglyph.clone(), ctl.clone());
        let mcp = PoneglyphMcpServer::builder()
            .with_poneglyph_arc(poneglyph.clone())
            .with_agent_handler(Arc::new(agent.clone()))
            .build()
            .expect("mcp server");
        Self {
            api,
            ctl_config,
            poneglyph,
            ctl,
            agent,
            mcp,
            google_oauth,
            google_auth: Arc::new(Mutex::new(HashMap::new())),
            google_grants: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn insert_google_auth_state(
        &self,
        state: &CsrfToken,
        verifier: PkceCodeVerifier,
        handoff_uri: Option<String>,
        requested_scopes: Vec<String>,
    ) {
        self.google_auth.lock().await.insert(
            state.secret().to_string(),
            GooglePendingAuth {
                verifier: verifier.secret().to_string(),
                handoff_uri,
                requested_scopes,
            },
        );
    }

    pub async fn take_google_auth_state(&self, state: &str) -> Option<GooglePendingAuth> {
        self.google_auth.lock().await.remove(state)
    }

    pub async fn issue_google_auth_grant(
        &self,
        connection: GoogleOAuthConnection,
    ) -> GoogleAuthGrant {
        let grant = GoogleAuthGrant {
            grant_id: Uuid::now_v7().to_string(),
            connection,
        };
        self.google_grants
            .lock()
            .await
            .insert(grant.grant_id.clone(), grant.clone());
        grant
    }

    pub async fn take_google_auth_grant(&self, grant_id: &str) -> Option<GoogleAuthGrant> {
        self.google_grants.lock().await.remove(grant_id)
    }
}
