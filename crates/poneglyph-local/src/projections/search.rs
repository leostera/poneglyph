use std::path::Path;
use std::sync::Mutex;

use async_trait::async_trait;
use tantivy::collector::TopDocs;
use tantivy::directory::MmapDirectory;
use tantivy::query::QueryParser;
use tantivy::schema::{STORED, STRING, Schema, TEXT, TantivyDocument, Value as _};
use tantivy::{Index, IndexReader, IndexWriter, Term, doc};
use tracing::debug;

use poneglyph::{
    Entity, Error, IndexedEntity, PoneResult, Projection, ProjectionBatch, SearchHit,
    SearchProjection as CoreSearchProjection, Uri, Value,
};

#[derive(Clone, Copy)]
struct SearchFields {
    entity_uri: tantivy::schema::Field,
    namespace: tantivy::schema::Field,
    kind: tantivy::schema::Field,
    content: tantivy::schema::Field,
}

pub struct TantivySearchProjection {
    index: Index,
    reader: IndexReader,
    writer: Mutex<IndexWriter>,
    fields: SearchFields,
}

impl TantivySearchProjection {
    pub fn create_in_memory() -> PoneResult<Self> {
        let (schema, fields) = schema();
        let index = Index::create_in_ram(schema);
        Self::open_index(index, fields)
    }

    pub fn open(path: impl AsRef<Path>) -> PoneResult<Self> {
        std::fs::create_dir_all(path.as_ref())
            .map_err(|source| Error::SearchProjectionIo { source })?;
        let (schema, fields) = schema();
        let directory = MmapDirectory::open(path).map_err(|error| Error::Tantivy(error.into()))?;
        let index = Index::open_or_create(directory, schema)?;
        Self::open_index(index, fields)
    }

    pub fn search(&self, query: &str, limit: usize) -> PoneResult<Vec<SearchHit>> {
        let searcher = self.reader.searcher();
        let parser = QueryParser::for_index(
            &self.index,
            vec![self.fields.namespace, self.fields.kind, self.fields.content],
        );
        let query = parser.parse_query(query)?;
        let hits = searcher.search(&query, &TopDocs::with_limit(limit).order_by_score())?;

        let hits = hits
            .into_iter()
            .map(|(score, address)| {
                let retrieved = searcher.doc::<TantivyDocument>(address)?;
                let uri = retrieved
                    .get_first(self.fields.entity_uri)
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| Error::MissingSearchProjectionEntityUri)?;
                Ok(SearchHit {
                    entity_uri: Uri::parse(uri)?,
                    score,
                })
            })
            .collect::<PoneResult<Vec<_>>>()?;
        debug!(hit_count = hits.len(), "search query evaluated");
        Ok(hits)
    }

    pub fn list_entities(&self, limit: usize, offset: usize) -> PoneResult<Vec<IndexedEntity>> {
        let searcher = self.reader.searcher();
        let query = tantivy::query::AllQuery;
        let hits = searcher.search(
            &query,
            &TopDocs::with_limit(limit)
                .and_offset(offset)
                .order_by_score(),
        )?;

        let entities = hits
            .into_iter()
            .map(|(_, address)| {
                let retrieved = searcher.doc::<TantivyDocument>(address)?;
                let uri = retrieved
                    .get_first(self.fields.entity_uri)
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| Error::MissingSearchProjectionEntityUri)?;
                let namespace = retrieved
                    .get_first(self.fields.namespace)
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string();
                let kind = retrieved
                    .get_first(self.fields.kind)
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string();
                Ok(IndexedEntity {
                    entity_uri: Uri::parse(uri)?,
                    namespace,
                    kind,
                })
            })
            .collect::<PoneResult<Vec<_>>>()?;

        debug!(entity_count = entities.len(), "listed indexed entities");
        Ok(entities)
    }

    fn open_index(index: Index, fields: SearchFields) -> PoneResult<Self> {
        let reader = index.reader()?;
        let writer = index.writer(50_000_000)?;
        Ok(Self {
            index,
            reader,
            writer: Mutex::new(writer),
            fields,
        })
    }
}

#[async_trait]
impl Projection for TantivySearchProjection {
    fn name(&self) -> &'static str {
        "search"
    }

    async fn handle_events(&self, batch: ProjectionBatch) -> PoneResult<()> {
        let entity_count = batch.entities.len();
        debug!(
            component = "search_projection",
            entity_count, "applying search projection batch"
        );
        let mut writer = self.writer.lock().expect("search writer");

        for entity in batch.entities {
            debug!(entity_uri = %entity.uri, field_count = entity.fields.len(), "indexing entity");
            writer.delete_term(Term::from_field_text(
                self.fields.entity_uri,
                entity.uri.as_str(),
            ));

            if entity.fields.is_empty() {
                continue;
            }

            let content = flatten_entity_content(&entity);
            let document = doc!(
                self.fields.entity_uri => entity.uri.as_str(),
                self.fields.namespace => entity.namespace.clone(),
                self.fields.kind => entity.kind.clone(),
                self.fields.content => content,
            );
            writer.add_document(document)?;
        }

        writer.commit()?;
        drop(writer);
        self.reader.reload()?;
        Ok(())
    }
}

impl CoreSearchProjection for TantivySearchProjection {
    fn search(&self, query: &str, limit: usize) -> PoneResult<Vec<SearchHit>> {
        TantivySearchProjection::search(self, query, limit)
    }
}

fn schema() -> (Schema, SearchFields) {
    let mut builder = Schema::builder();
    let entity_uri = builder.add_text_field("entity_uri", STRING | STORED);
    let namespace = builder.add_text_field("namespace", STRING | STORED);
    let kind = builder.add_text_field("kind", STRING | STORED);
    let content = builder.add_text_field("content", TEXT);
    let schema = builder.build();

    (
        schema,
        SearchFields {
            entity_uri,
            namespace,
            kind,
            content,
        },
    )
}

fn flatten_entity_content(entity: &Entity) -> String {
    let mut parts = vec![
        entity.uri.to_string(),
        entity.namespace.clone(),
        entity.kind.clone(),
    ];
    for (field_uri, value) in &entity.fields {
        parts.push(field_uri.to_string());
        collect_value_text(value, &mut parts);
    }
    parts.join(" ")
}

fn collect_value_text(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::Null => {}
        Value::Text(value) | Value::Number(value) => output.push(value.clone()),
        Value::Boolean(value) => output.push(value.to_string()),
        Value::Bytes(_) => {}
        Value::Reference(uri) => output.push(uri.to_string()),
        Value::Date(value) => output.push(value.to_string()),
        Value::DateTime(value) => output.push(value.to_rfc3339()),
        Value::List(values) => {
            for value in values {
                collect_value_text(value, output);
            }
        }
        Value::Map(values) => {
            for (key, value) in values {
                output.push(key.clone());
                collect_value_text(value, output);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::time::Duration;

    use proptest::prelude::*;
    use tokio::task::yield_now;
    use tokio::time::timeout;

    use poneglyph::projections::{Projection, ProjectionBatch};
    use poneglyph::{Entity, Uri, Value, uri};

    use super::TantivySearchProjection;

    fn entity(uri: Uri, fields: BTreeMap<Uri, Value>) -> Entity {
        Entity {
            namespace: uri.namespace().to_string(),
            kind: uri.kind().expect("kind").to_string(),
            uri,
            fields,
        }
    }

    async fn wait_for_hit(projection: &TantivySearchProjection, query: &str, expected_uri: &Uri) {
        timeout(Duration::from_secs(1), async {
            loop {
                let hits = projection.search(query, 10).expect("search");
                if hits.iter().any(|hit| &hit.entity_uri == expected_uri) {
                    return;
                }
                yield_now().await;
            }
        })
        .await
        .expect("search eventually returns expected hit");
    }

    #[tokio::test]
    async fn search_projection_indexes_entities_by_text_content() {
        let projection = TantivySearchProjection::create_in_memory().expect("projection");
        let entity_uri = uri!("spotify:album:signals");
        let entity = entity(
            entity_uri.clone(),
            BTreeMap::from([(uri!("spotify:displayName"), Value::text("Signals"))]),
        );

        projection
            .handle_events(ProjectionBatch {
                entities: vec![entity],
            })
            .await
            .expect("handle events");

        wait_for_hit(&projection, "Signals", &entity_uri).await;
    }

    #[tokio::test]
    async fn search_projection_indexes_entity_uri_terms() {
        let projection = TantivySearchProjection::create_in_memory().expect("projection");
        let entity_uri = uri!("spotify:album:uri-search-target");
        let entity = entity(
            entity_uri.clone(),
            BTreeMap::from([(uri!("spotify:displayName"), Value::text("Different Title"))]),
        );

        projection
            .handle_events(ProjectionBatch {
                entities: vec![entity],
            })
            .await
            .expect("handle events");

        wait_for_hit(&projection, "uri", &entity_uri).await;
        wait_for_hit(&projection, "search", &entity_uri).await;
        wait_for_hit(&projection, "target", &entity_uri).await;
    }

    #[tokio::test]
    async fn search_projection_indexes_field_uri_terms() {
        let projection = TantivySearchProjection::create_in_memory().expect("projection");
        let entity_uri = uri!("spotify:album:field-search-target");
        let entity = entity(
            entity_uri.clone(),
            BTreeMap::from([(
                uri!("spotify:field:releasecode"),
                Value::text("Different Title"),
            )]),
        );

        projection
            .handle_events(ProjectionBatch {
                entities: vec![entity],
            })
            .await
            .expect("handle events");

        wait_for_hit(&projection, "releasecode", &entity_uri).await;
    }

    #[tokio::test]
    async fn search_projection_rewrites_existing_entity_documents() {
        let projection = TantivySearchProjection::create_in_memory().expect("projection");
        let entity_uri = uri!("spotify:album:2112");

        projection
            .handle_events(ProjectionBatch {
                entities: vec![entity(
                    entity_uri.clone(),
                    BTreeMap::from([(uri!("spotify:displayName"), Value::text("Old"))]),
                )],
            })
            .await
            .expect("first");
        projection
            .handle_events(ProjectionBatch {
                entities: vec![entity(
                    entity_uri.clone(),
                    BTreeMap::from([(uri!("spotify:displayName"), Value::text("New"))]),
                )],
            })
            .await
            .expect("second");

        let old_hits = projection.search("Old", 10).expect("old search");
        let new_hits = projection.search("New", 10).expect("new search");

        assert!(!old_hits.iter().any(|hit| hit.entity_uri == entity_uri));
        assert!(new_hits.iter().any(|hit| hit.entity_uri == entity_uri));
    }

    #[tokio::test]
    async fn search_projection_removes_documents_for_empty_entities() {
        let projection = TantivySearchProjection::create_in_memory().expect("projection");
        let entity_uri = uri!("spotify:album:grace-under-pressure");

        projection
            .handle_events(ProjectionBatch {
                entities: vec![entity(
                    entity_uri.clone(),
                    BTreeMap::from([(
                        uri!("spotify:displayName"),
                        Value::text("Grace Under Pressure"),
                    )]),
                )],
            })
            .await
            .expect("index");
        projection
            .handle_events(ProjectionBatch {
                entities: vec![entity(entity_uri.clone(), BTreeMap::new())],
            })
            .await
            .expect("delete");

        let hits = projection.search("Grace", 10).expect("search");
        assert!(!hits.iter().any(|hit| hit.entity_uri == entity_uri));
    }

    proptest! {
        #[test]
        fn property_search_projection_finds_entities_by_indexed_text_long(
            query in "[a-z]{2,12}"
        ) {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");

            runtime.block_on(async move {
                let projection = TantivySearchProjection::create_in_memory().expect("projection");
                let entity_uri = uri!("spotify:album:property-search");
                projection
                    .handle_events(ProjectionBatch {
                        entities: vec![entity(
                            entity_uri.clone(),
                            BTreeMap::from([(uri!("spotify:displayName"), Value::text(query.clone()))]),
                        )],
                    })
                    .await
                    .expect("handle events");

                let hits = projection.search(&query, 10).expect("search");
                prop_assert!(hits.iter().any(|hit| hit.entity_uri == entity_uri));
                Ok::<(), proptest::test_runner::TestCaseError>(())
            })?;
        }

        #[test]
        fn property_search_projection_removes_deleted_entities_from_results_long(
            query in "[a-z]{2,12}"
        ) {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");

            runtime.block_on(async move {
                let projection = TantivySearchProjection::create_in_memory().expect("projection");
                let entity_uri = uri!("spotify:album:property-delete-search");
                projection
                    .handle_events(ProjectionBatch {
                        entities: vec![entity(
                            entity_uri.clone(),
                            BTreeMap::from([(uri!("spotify:displayName"), Value::text(query.clone()))]),
                        )],
                    })
                    .await
                    .expect("index");
                projection
                    .handle_events(ProjectionBatch {
                        entities: vec![entity(entity_uri.clone(), BTreeMap::new())],
                    })
                    .await
                    .expect("delete");

                let hits = projection.search(&query, 10).expect("search");
                prop_assert!(!hits.iter().any(|hit| hit.entity_uri == entity_uri));
                Ok::<(), proptest::test_runner::TestCaseError>(())
            })?;
        }
    }
}
