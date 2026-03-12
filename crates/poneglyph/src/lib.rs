//! Poneglyph backend library.
//!
//! Public API:
//! - [`Fact`], [`Builder`], [`fact!`] and [`Filter`] for the append-only fact model.
//! - [`Uri`] and [`Value`] for shared identifiers and payloads.
//! - [`Entity`] for consolidated materialized views.
//! - [`FactService`] and the fact stores for durable fact access.
//! - [`Consolidator`] and entity stores for materialized entity views.
//! - [`Projection`] and [`ProjectionRunner`] for replayable derived workers.
//! - [`Workspace`] and [`Config`] for filesystem layout and runtime configuration.
//! - [`Error`] and [`PoneResult`] for typed backend errors.

mod config;
mod consolidation;
mod entities;
mod entity;
pub mod error;
mod fact;
mod facts;
mod projections;
#[cfg(test)]
mod tests;
mod uri;
mod value;
mod workspace;

pub use config::Config;
pub use consolidation::{Consolidation, Consolidator, ConsolidatorBuilder};
pub use entities::{EntityStore, InMemoryEntityStore, SqliteEntityStore};
pub use entity::Entity;
pub use error::{Error, PoneResult};
pub use fact::{Builder, Fact, Filter};
pub use facts::{FactService, FactServiceBuilder, InMemoryFactStore, SqliteFactStore, Store};
pub use projections::{
    Projection, ProjectionBatch, ProjectionRunner, ProjectionRunnerBuilder, SearchHit,
    SearchProjection,
};
pub use uri::Uri;
pub use value::Value;
pub use workspace::Workspace;
