use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDate, Utc};
use proptest::prelude::*;
use serde::{Deserialize, Serialize};

use crate::Uri;

/// Typed payload carried by a [`crate::Fact`].
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum Value {
    Null,
    Text(String),
    Number(String),
    Boolean(bool),
    Bytes(Vec<u8>),
    Reference(Uri),
    Date(NaiveDate),
    DateTime(DateTime<Utc>),
    List(Vec<Value>),
    Map(BTreeMap<String, Value>),
}

impl Value {
    pub fn null() -> Self {
        Self::Null
    }

    pub fn text(value: impl Into<String>) -> Self {
        Self::Text(value.into())
    }

    pub fn number(value: impl Into<String>) -> Self {
        Self::Number(value.into())
    }

    pub fn integer(value: i64) -> Self {
        Self::Number(value.to_string())
    }

    pub fn float(value: f64) -> Self {
        Self::Number(value.to_string())
    }

    pub fn boolean(value: bool) -> Self {
        Self::Boolean(value)
    }

    pub fn bytes(value: impl Into<Vec<u8>>) -> Self {
        Self::Bytes(value.into())
    }

    pub fn reference(value: Uri) -> Self {
        Self::Reference(value)
    }

    pub fn date(value: NaiveDate) -> Self {
        Self::Date(value)
    }

    pub fn date_time(value: DateTime<Utc>) -> Self {
        Self::DateTime(value)
    }

    pub fn list(values: Vec<Value>) -> Self {
        Self::List(values)
    }

    pub fn map(values: BTreeMap<String, Value>) -> Self {
        Self::Map(values)
    }
}

impl Arbitrary for Value {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        let leaf = prop_oneof![
            Just(Self::Null),
            any::<String>().prop_map(Self::Text),
            prop_oneof![
                any::<i64>().prop_map(|value| value.to_string()),
                any::<f64>()
                    .prop_filter("finite floats only", |value| value.is_finite())
                    .prop_map(|value| value.to_string()),
            ]
            .prop_map(Self::Number),
            any::<bool>().prop_map(Self::Boolean),
            prop::collection::vec(any::<u8>(), 0..32).prop_map(Self::Bytes),
            any::<Uri>().prop_map(Self::Reference),
            (1970i32..2100, 1u32..13, 1u32..29)
                .prop_filter_map("valid date", |(year, month, day)| {
                    NaiveDate::from_ymd_opt(year, month, day)
                })
                .prop_map(Self::Date),
            (0i64..4_102_444_800, 0u32..1_000_000_000)
                .prop_map(|(secs, nanos)| {
                    DateTime::<Utc>::from_timestamp(secs, nanos).expect("valid timestamp")
                })
                .prop_map(Self::DateTime),
        ];

        leaf.prop_recursive(3, 32, 4, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..4).prop_map(Self::List),
                prop::collection::btree_map("[a-z]{1,8}", inner, 0..4).prop_map(Self::Map),
            ]
        })
        .boxed()
    }
}
