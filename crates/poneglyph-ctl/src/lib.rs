mod config;
pub mod connectors;
pub mod error;
mod runtime;
mod store;

#[cfg(test)]
use std::sync::{Mutex, OnceLock};

pub use config::{PoneglyphCtlConfig, PoneglyphCtlConfigBuilder};
pub use connectors::gcal::{GcalConfig, GcalConnector, GoogleCalendarResource};
pub use connectors::gmail::{GmailConfig, GmailConnector};
pub use connectors::plex::{PlexConfig, PlexConnector};
pub use error::{CtlError, CtlResult};
pub use runtime::{ConnectorRuntime, ConnectorRuntimeBuilder};
pub use store::{
    CtlStore, GmailSyncState, GoogleCalendarSyncState, GoogleOAuthConnection, PlexConnection,
    PlexLibrarySyncState, SaveGoogleOAuthConnection, SavePlexConnection,
};

#[cfg(test)]
pub(crate) fn test_env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}
