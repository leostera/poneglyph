use chrono::{DateTime, Utc};
use proptest::prelude::*;
use serde::{Deserialize, Serialize};

use crate::{Error, PoneResult, Uri, Value, uri};

/// One append-only statement in the fact log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fact {
    pub fact_id: Uri,
    pub source: Uri,
    pub entity: Uri,
    pub field: Uri,
    pub value: Value,
    pub retraction: bool,
    pub stated_at: DateTime<Utc>,
    pub tx_id: Option<Uri>,
}

impl Fact {
    pub fn builder() -> Builder {
        Builder::default()
    }
}

#[macro_export]
macro_rules! fact {
    ($source:expr, $entity:expr, $field:expr, $value:expr) => {{
        $crate::Fact::builder()
            .source($source)
            .entity($entity)
            .field($field)
            .value($value)
            .build()
            .expect("invalid fact")
    }};
    ($entity:expr, $field:expr, $value:expr) => {{ $crate::fact!($crate::uri!("poneglyph:internal"), $entity, $field, $value) }};
}

#[macro_export]
macro_rules! retraction {
    ($source:expr, $entity:expr, $field:expr, $value:expr) => {{
        $crate::Fact::builder()
            .source($source)
            .entity($entity)
            .field($field)
            .value($value)
            .retract()
            .build()
            .expect("invalid retraction")
    }};
    ($entity:expr, $field:expr, $value:expr) => {{ $crate::retraction!($crate::uri!("poneglyph:internal"), $entity, $field, $value) }};
}

/// Supported read filters for fact stores.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Filter {
    All,
    ById(Uri),
    ByTx(Uri),
    ByEntityUri(Uri),
}

/// Builder for creating pending [`Fact`] values before they are assigned to a transaction.
#[derive(Debug, Default, Clone)]
pub struct Builder {
    source: Option<Uri>,
    entity: Option<Uri>,
    field: Option<Uri>,
    value: Option<Value>,
    retraction: bool,
}

impl Builder {
    pub fn source(mut self, source: Uri) -> Self {
        self.source = Some(source);
        self
    }

    pub fn entity(mut self, entity: Uri) -> Self {
        self.entity = Some(entity);
        self
    }

    pub fn field(mut self, field: Uri) -> Self {
        self.field = Some(field);
        self
    }

    pub fn value(mut self, value: Value) -> Self {
        self.value = Some(value);
        self
    }

    pub fn retract(mut self) -> Self {
        self.retraction = true;
        self
    }

    pub fn assert(mut self) -> Self {
        self.retraction = false;
        self
    }

    pub fn build(self) -> PoneResult<Fact> {
        Ok(Fact {
            fact_id: uri!("poneglyph", "fact"),
            source: self.source.ok_or(Error::MissingFactSource)?,
            entity: self.entity.ok_or(Error::MissingFactEntity)?,
            field: self.field.ok_or(Error::MissingFactField)?,
            value: self.value.ok_or(Error::MissingFactValue)?,
            retraction: self.retraction,
            stated_at: Utc::now(),
            tx_id: None,
        })
    }
}

impl Arbitrary for Fact {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (
            any::<Uri>(),
            any::<Uri>(),
            any::<Uri>(),
            any::<Value>(),
            any::<bool>(),
        )
            .prop_map(|(source, entity, field, value, retraction)| {
                let builder = Fact::builder()
                    .source(source)
                    .entity(entity)
                    .field(field)
                    .value(value);
                let builder = if retraction {
                    builder.retract()
                } else {
                    builder.assert()
                };
                builder.build().expect("arbitrary fact")
            })
            .boxed()
    }
}
