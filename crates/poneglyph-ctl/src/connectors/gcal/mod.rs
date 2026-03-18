mod client;
mod connector;
mod ingestor;
mod schema;
mod types;

pub use connector::{GcalConfig, GcalConnector};
pub use types::GoogleCalendarResource;
