//! Shared domain types for the Poneglyph backend.
//!
//! Public API:
//! - [`Fact`]: the append-only statement type passed into and out of stores.
//! - [`Builder`]: ergonomic constructor for pending [`Fact`] values.
//! - [`Filter`]: read filters for store implementations.
//! - [`Uri`]: validated URI identifier used across the model.
//! - [`Value`]: typed fact payload values, including nested lists and maps.
//! - [`Error`] and [`Result`]: structured core errors for parsing and building values.

mod error;
mod fact;
#[cfg(test)]
mod tests;
mod uri;
mod value;

/// Structured core errors for URI parsing and fact construction.
pub use error::{Error, Result};
/// Fact types and read filters shared by store implementations.
pub use fact::{Builder, Fact, Filter};
/// Validated URI identifiers and the [`uri!`] helper macro.
pub use uri::Uri;
/// Typed values carried by facts.
pub use value::Value;
