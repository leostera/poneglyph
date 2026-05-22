//! Poneglyph semantic graph database library.
//!
//! This crate owns the append-only fact model, schema/entity/query semantics,
//! replayable projections, and runtime builder used by domain-specific daemons.
//! Use `poneglyph-local` for the default durable workspace-backed adapters, and use
//! this crate directly for in-memory tests or custom daemon assembly.
//!
//! Public API:
//! - [`Fact`], [`FactBuilder`], [`fact!`], [`retraction!`] and [`Filter`] for the append-only fact model.
//! - [`ActiveFact`] and [`ActiveFilter`] for the synchronous active graph view.
//! - [`Uri`] and [`Value`] for shared identifiers and payloads.
//! - [`Entity`] for consolidated materialized views.
//! - [`FactService`] and the fact stores for durable fact access.
//! - [`Consolidator`] and entity stores for materialized entity views.
//! - [`Projection`] and [`ProjectionRunner`] for replayable derived workers.
//! - [`Query`], [`QueryEngine`] and [`QueryResult`] for queries over the active graph.
//! - [`Workspace`], [`PoneglyphConfig`], [`Config`], and [`Poneglyph`] for runtime configuration and assembly.
//! - [`Error`] and [`PoneResult`] for typed backend errors.

mod active_graph;
mod config;
mod consolidation;
pub mod entities;
mod entity;
pub mod error;
mod fact;
pub mod facts;
pub mod projections;
mod query;
mod runtime;
pub mod schema;
mod storage;
#[cfg(test)]
mod tests;
mod uri;
mod value;
mod workspace;

pub use active_graph::{ActiveFact, ActiveFilter};
pub use config::{Config, PoneglyphConfig, PoneglyphConfigBuilder, default_workspace_path};
pub use consolidation::{Consolidation, Consolidator, ConsolidatorBuilder};
pub use entities::{EntityStore, InMemoryEntityStore};
pub use entity::Entity;
pub use error::{Error, PoneResult};
#[allow(deprecated)]
pub use fact::Builder;
pub use fact::{Fact, FactBuilder, Filter};
pub use facts::{FactService, FactServiceBuilder, InMemoryFactStore, Store};
pub use projections::{
    InMemorySearchProjection, IndexedEntity, Projection, ProjectionBatch, ProjectionRunner,
    ProjectionRunnerBuilder, SearchHit, SearchProjection,
};
pub use query::{Query, QueryEngine, QueryResult};
pub use runtime::{Poneglyph, PoneglyphBuilder};
pub use schema::{BaseSchema, FieldSchema, KindSchema, NamespaceSchema, SchemaDefinition};
pub use storage::RuntimeStorageFactory;
pub use uri::Uri;
pub use value::Value;
pub use workspace::Workspace;
