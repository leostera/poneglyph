use std::collections::HashMap;
use std::sync::Arc;

use oauth2::{CsrfToken, PkceCodeVerifier};
use poneglyph::Poneglyph;
use poneglyph_mcp::PoneglyphMcpServer;
use tokio::sync::Mutex;

#[derive(Debug, Clone)]
pub(crate) struct GooglePendingAuth {
    pub verifier: String,
}

#[derive(Clone)]
pub(crate) struct AppContext {
    pub poneglyph: Arc<Poneglyph>,
    pub mcp: PoneglyphMcpServer,
    pub google_auth: Arc<Mutex<HashMap<String, GooglePendingAuth>>>,
}

impl AppContext {
    pub fn new(poneglyph: Arc<Poneglyph>) -> Self {
        let mcp = PoneglyphMcpServer::builder()
            .with_poneglyph_arc(poneglyph.clone())
            .build()
            .expect("mcp server");
        Self {
            poneglyph,
            mcp,
            google_auth: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn insert_google_auth_state(&self, state: &CsrfToken, verifier: PkceCodeVerifier) {
        self.google_auth.lock().await.insert(
            state.secret().to_string(),
            GooglePendingAuth {
                verifier: verifier.secret().to_string(),
            },
        );
    }

    pub async fn take_google_auth_state(&self, state: &str) -> Option<GooglePendingAuth> {
        self.google_auth.lock().await.remove(state)
    }
}
