mod config;
pub mod connectors;
pub mod error;
mod runtime;
mod store;

#[cfg(test)]
use std::sync::{Mutex, OnceLock};

pub use config::{PoneglyphCtlConfig, PoneglyphCtlConfigBuilder};
pub use connectors::gcal::{GcalConfig, GcalConnector, GoogleCalendarResource};
pub use connectors::plex::{PlexConfig, PlexConnector};
pub use error::{CtlError, CtlResult};
pub use runtime::{ConnectorRuntime, ConnectorRuntimeBuilder};
pub use store::{
    CtlStore, GoogleCalendarSyncState, GoogleOAuthConnection, PlexLibrarySyncState,
    SaveGoogleOAuthConnection,
};

#[cfg(test)]
pub(crate) fn test_env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}
