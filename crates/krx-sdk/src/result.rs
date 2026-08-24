use std::collections::BTreeMap;
use std::time::SystemTime;

use crate::KrxError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResultSource {
    Network,
    Cache,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Freshness {
    Fresh,
    Stale,
}

#[derive(Clone, Debug)]
pub struct ResultProvenance {
    pub source: ResultSource,
    pub fetched_at: SystemTime,
    pub freshness: Freshness,
    pub contract_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Row(BTreeMap<String, String>);

impl Row {
    pub(crate) fn new(fields: BTreeMap<String, String>) -> Self {
        Self(fields)
    }

    pub fn get(&self, field: &str) -> Option<&str> {
        self.0.get(field).map(String::as_str)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0
            .iter()
            .map(|(field, value)| (field.as_str(), value.as_str()))
    }
}

#[derive(Clone, Debug)]
pub struct QueryResult {
    pub rows: Vec<Row>,
    pub provenance: ResultProvenance,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompletenessState {
    Complete,
    Partial,
    Empty,
    Failed,
}

#[derive(Clone, Debug)]
pub struct CompositeFailure<Id> {
    pub id: Id,
    pub error: KrxError,
}

#[derive(Clone, Debug)]
pub struct Completeness<Id> {
    pub state: CompletenessState,
    pub requested: Vec<Id>,
    pub succeeded: Vec<Id>,
    pub failed: Vec<CompositeFailure<Id>>,
    pub skipped: Vec<Id>,
}

#[derive(Clone, Debug)]
pub struct CompositeResult<Data, Id> {
    pub success: bool,
    pub data: Data,
    pub completeness: Completeness<Id>,
    pub provenance: BTreeMap<Id, ResultProvenance>,
    pub error: Option<KrxError>,
}
