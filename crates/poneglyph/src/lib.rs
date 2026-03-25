//! Poneglyph backend library.
//!
//! Public API:
//! - [`Fact`], [`Builder`], [`fact!`], [`retraction!`] and [`Filter`] for the append-only fact model.
//! - [`ActiveFact`] and [`ActiveFilter`] for the synchronous active graph view.
//! - [`Uri`] and [`Value`] for shared identifiers and payloads.
//! - [`Entity`] for consolidated materialized views.
//! - [`FactService`] and the fact stores for durable fact access.
//! - [`Consolidator`] and entity stores for materialized entity views.
//! - [`Projection`] and [`ProjectionRunner`] for replayable derived workers.
//! - [`Query`], [`QueryEngine`] and [`QueryResult`] for queries over the active graph.
//! - [`Workspace`], [`PoneglyphConfig`], [`Config`], and [`Poneglyph`] for runtime configuration and assembly.
//! - [`Error`] and [`PoneResult`] for typed backend errors.

evals::setup!();

mod active_graph;
mod config;
mod consolidation;
mod entities;
mod entity;
pub mod error;
mod fact;
mod facts;
mod projections;
mod query;
mod runtime;
mod schema;
#[cfg(test)]
mod tests;
mod uri;
mod value;
mod workspace;

pub use active_graph::{ActiveFact, ActiveFilter};
pub use config::{Config, PoneglyphConfig, PoneglyphConfigBuilder, default_workspace_path};
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
pub use query::{Query, QueryEngine, QueryResult};
pub use runtime::{Poneglyph, PoneglyphBuilder};
pub use schema::{BaseSchema, FieldSchema, KindSchema, NamespaceSchema, SchemaDefinition};
pub use uri::Uri;
pub use value::Value;
pub use workspace::Workspace;
