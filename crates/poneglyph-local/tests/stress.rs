use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::time::Instant;

use poneglyph::{
    ActiveFact, ActiveFilter, Fact, Filter, PoneResult, Store, Value, Workspace, fact, uri,
};
use proptest::prelude::*;
use tempfile::tempdir;
use tokio::sync::mpsc;

fn fact_channel(facts: Vec<Fact>) -> mpsc::Receiver<Fact> {
    let (tx, rx) = mpsc::channel(facts.len().max(1));
    tokio::spawn(async move {
        for fact in facts {
            if tx.send(fact).await.is_err() {
                break;
            }
        }
    });
    rx
}

async fn collect_facts(mut receiver: mpsc::Receiver<PoneResult<Fact>>) -> PoneResult<Vec<Fact>> {
    let mut facts = Vec::new();
    while let Some(fact) = receiver.recv().await {
        facts.push(fact?);
    }
    Ok(facts)
}

async fn collect_active_facts(
    mut receiver: mpsc::Receiver<PoneResult<ActiveFact>>,
) -> PoneResult<Vec<ActiveFact>> {
    let mut facts = Vec::new();
    while let Some(fact) = receiver.recv().await {
        facts.push(fact?);
    }
    Ok(facts)
}

fn generated_fact(index: usize) -> Fact {
    let entity = uri!(format!("stress:item:{:05}", index % 1_000));
    let field = uri!(format!("stress:field:{:03}", index % 32));
    let value = Value::text(format!("value-{index}"));
    fact!(uri!("agent:stress:writer"), entity, field, value)
}

async fn state_batches(store: &dyn Store, total: usize, batch_size: usize) -> PoneResult<()> {
    let facts = (0..total).map(generated_fact).collect::<Vec<_>>();
    state_prebuilt_batches(store, &facts, batch_size).await
}

async fn state_prebuilt_batches(
    store: &dyn Store,
    facts: &[Fact],
    batch_size: usize,
) -> PoneResult<()> {
    for chunk in facts.chunks(batch_size) {
        store.state_facts_vec(chunk.to_vec()).await?;
    }
    Ok(())
}

#[derive(Debug)]
struct WikiPage {
    title: String,
    namespace: String,
    text: String,
}

fn load_onepiece_pages(path: &Path, max_pages: Option<usize>) -> std::io::Result<Vec<WikiPage>> {
    let xml = fs::read_to_string(path)?;
    Ok(parse_mediawiki_pages(&xml, max_pages))
}

fn parse_mediawiki_pages(xml: &str, max_pages: Option<usize>) -> Vec<WikiPage> {
    let mut pages = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<page>") {
        rest = &rest[start + "<page>".len()..];
        let Some(end) = rest.find("</page>") else {
            break;
        };
        let page_xml = &rest[..end];
        rest = &rest[end + "</page>".len()..];

        let title = xml_text(page_xml, "title").unwrap_or_default();
        if title.is_empty() {
            continue;
        }
        let namespace = xml_text(page_xml, "ns").unwrap_or_else(|| "0".to_string());
        let text = xml_text(page_xml, "text").unwrap_or_default();
        pages.push(WikiPage {
            title,
            namespace,
            text,
        });
        if max_pages.is_some_and(|limit| pages.len() >= limit) {
            break;
        }
    }
    pages
}

fn xml_text(xml: &str, tag: &str) -> Option<String> {
    let open_start = xml.find(&format!("<{tag}"))?;
    let after_open = &xml[open_start..];
    let content_start = after_open.find('>')? + 1;
    let content_and_rest = &after_open[content_start..];
    let close = content_and_rest.find(&format!("</{tag}>"))?;
    Some(unescape_xml(&content_and_rest[..close]))
}

fn unescape_xml(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn synthetic_onepiece_pages(count: usize) -> Vec<WikiPage> {
    (0..count)
        .map(|index| WikiPage {
            title: format!("Character {index}"),
            namespace: "0".to_string(),
            text: format!(
                "{{{{Infobox character|name=Character {index}|affiliation=Straw Hat Pirates}}}}\n[[Category:Characters]]\n[[Monkey D. Luffy]] appears in chapter {}.",
                index % 1_100
            ),
        })
        .collect()
}

fn onepiece_pages_to_facts(pages: &[WikiPage]) -> Vec<Fact> {
    let source = uri!("fixture:onepiece-fandom");
    let mut facts = Vec::with_capacity(pages.len() * 5);
    for (index, page) in pages.iter().enumerate() {
        let entity = uri!(format!(
            "wiki:onepiece:page:{}",
            slug_uri_component(&page.title)
        ));
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("wiki:page:title"),
            Value::text(page.title.clone())
        ));
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("wiki:page:namespace"),
            Value::number(page.namespace.clone())
        ));
        facts.push(fact!(
            source.clone(),
            entity.clone(),
            uri!("wiki:page:text_bytes"),
            Value::integer(page.text.len() as i64)
        ));
        for category in extract_wiki_links(&page.text, "Category:").take(8) {
            facts.push(fact!(
                source.clone(),
                entity.clone(),
                uri!("wiki:page:category"),
                Value::text(category)
            ));
        }
        for link in extract_wiki_links(&page.text, "").take(16) {
            if !link.starts_with("Category:") {
                facts.push(fact!(
                    source.clone(),
                    entity.clone(),
                    uri!("wiki:page:link"),
                    Value::text(link)
                ));
            }
        }
        if index % 10 == 0 {
            facts.push(fact!(
                source.clone(),
                entity,
                uri!("wiki:page:sampled"),
                Value::boolean(true)
            ));
        }
    }
    facts
}

fn extract_wiki_links<'a>(text: &'a str, prefix: &'a str) -> impl Iterator<Item = String> + 'a {
    text.match_indices("[[").filter_map(move |(start, _)| {
        let after = &text[start + 2..];
        let end = after.find("]] ").or_else(|| after.find("]]"))?;
        let target = after[..end].split('|').next()?.trim();
        if target.is_empty() || !target.starts_with(prefix) {
            return None;
        }
        Some(target.to_string())
    })
}

fn slug_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if matches!(ch, ' ' | '_' | '-' | ':' | '/') {
            out.push('-');
        }
    }
    if out.is_empty() {
        "untitled".to_string()
    } else {
        out
    }
}

#[tokio::test]
async fn local_backend_write_heavy_smoke() {
    let tempdir = tempdir().expect("tempdir");
    let workspace = Workspace::at(tempdir.path());
    let store = poneglyph_local::open_fact_store(&workspace)
        .await
        .expect("fact store");

    state_batches(store.as_ref(), 5_000, 250)
        .await
        .expect("write batches");

    let log = collect_facts(store.get_facts(Filter::All).await.expect("log"))
        .await
        .expect("collect log");
    let active = collect_active_facts(
        store
            .get_active_facts(ActiveFilter::All)
            .await
            .expect("active"),
    )
    .await
    .expect("collect active");

    assert_eq!(log.len(), 5_000);
    assert_eq!(active.len(), 5_000);
}

#[tokio::test]
async fn local_runtime_read_heavy_smoke() {
    let tempdir = tempdir().expect("tempdir");
    let workspace = Workspace::at(tempdir.path());
    let runtime = poneglyph_local::open_workspace(workspace)
        .await
        .expect("runtime");

    for start in (0..2_000).step_by(200) {
        runtime
            .state_facts((start..start + 200).map(generated_fact).collect())
            .await
            .expect("state facts");
    }

    for entity_index in 0..250 {
        let entity = uri!(format!("stress:item:{:05}", entity_index));
        let rows = runtime
            .query_str(&format!(r#"stress:field:000("{}", Value)"#, entity))
            .await
            .expect("query");
        assert!(rows.len() <= 1);
    }
}

#[tokio::test]
#[ignore = "set PONEGLYPH_STRESS_FACTS/PONEGLYPH_STRESS_BATCH and run with --ignored"]
async fn local_backend_write_heavy_stress() {
    let total = std::env::var("PONEGLYPH_STRESS_FACTS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(50_000);
    let batch_size = std::env::var("PONEGLYPH_STRESS_BATCH")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1_000);

    let tempdir = tempdir().expect("tempdir");
    let workspace = Workspace::at(tempdir.path());
    let store = poneglyph_local::open_fact_store(&workspace)
        .await
        .expect("fact store");

    let facts = (0..total).map(generated_fact).collect::<Vec<_>>();

    let started = Instant::now();
    state_prebuilt_batches(store.as_ref(), &facts, batch_size)
        .await
        .expect("write batches");
    let elapsed = started.elapsed();

    let log = collect_facts(store.get_facts(Filter::All).await.expect("log"))
        .await
        .expect("collect log");
    assert_eq!(log.len(), total);
    eprintln!("write-heavy stress wrote {total} facts in {elapsed:?}");
}

#[tokio::test]
#[ignore = "download tests/fixtures/onepiece-pages-current.xml or set PONEGLYPH_ONEPIECE_XML"]
async fn local_backend_onepiece_wiki_ingest_stress() {
    let fixture_path = std::env::var("PONEGLYPH_ONEPIECE_XML")
        .unwrap_or_else(|_| "tests/fixtures/cache/onepiece-pages-current.xml".to_string());
    let max_pages = std::env::var("PONEGLYPH_ONEPIECE_MAX_PAGES")
        .ok()
        .and_then(|value| value.parse().ok());
    let batch_size = std::env::var("PONEGLYPH_ONEPIECE_BATCH")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(10_000);

    let pages = load_onepiece_pages(Path::new(&fixture_path), max_pages).unwrap_or_else(|error| {
        eprintln!(
            "could not load {fixture_path}: {error}; using deterministic synthetic wiki fixture"
        );
        synthetic_onepiece_pages(max_pages.unwrap_or(5_000))
    });
    let facts = onepiece_pages_to_facts(&pages);

    let tempdir = tempdir().expect("tempdir");
    let workspace = Workspace::at(tempdir.path());
    let store = poneglyph_local::open_fact_store(&workspace)
        .await
        .expect("fact store");

    let started = Instant::now();
    state_prebuilt_batches(store.as_ref(), &facts, batch_size)
        .await
        .expect("write fixture facts");
    let elapsed = started.elapsed();

    let active = collect_active_facts(
        store
            .get_active_facts(ActiveFilter::ByField(uri!("wiki:page:title")))
            .await
            .expect("active title facts"),
    )
    .await
    .expect("collect active titles");
    assert_eq!(active.len(), pages.len());

    eprintln!(
        "onepiece wiki ingest wrote {} facts from {} pages in {:?}",
        facts.len(),
        pages.len(),
        elapsed
    );
}

#[tokio::test]
#[ignore = "set PONEGLYPH_STRESS_READS and run with --ignored"]
async fn local_backend_read_heavy_stress() {
    let reads = std::env::var("PONEGLYPH_STRESS_READS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(10_000);

    let tempdir = tempdir().expect("tempdir");
    let workspace = Workspace::at(tempdir.path());
    let store = poneglyph_local::open_fact_store(&workspace)
        .await
        .expect("fact store");
    state_batches(store.as_ref(), 20_000, 1_000)
        .await
        .expect("write setup");

    let started = Instant::now();
    for read in 0..reads {
        let entity = uri!(format!("stress:item:{:05}", read % 1_000));
        let facts = collect_facts(
            store
                .get_facts(Filter::ByEntityUri(entity))
                .await
                .expect("entity facts"),
        )
        .await
        .expect("collect entity facts");
        assert!(!facts.is_empty());
    }
    let elapsed = started.elapsed();
    eprintln!("read-heavy stress completed {reads} entity reads in {elapsed:?}");
}

#[derive(Debug, Clone)]
struct Operation {
    entity: u8,
    field: u8,
    value: u16,
    retract: bool,
}

fn operation_strategy() -> impl Strategy<Value = Operation> {
    (0u8..16, 0u8..8, 0u16..64, any::<bool>()).prop_map(|(entity, field, value, retract)| {
        Operation {
            entity,
            field,
            value,
            retract,
        }
    })
}

fn op_fact(op: &Operation) -> Fact {
    fact!(
        uri!("agent:fuzz:writer"),
        uri!(format!("fuzz:item:{}", op.entity)),
        uri!(format!("fuzz:field:{}", op.field)),
        Value::integer(i64::from(op.value))
    )
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 48,
        max_shrink_iters: 1024,
        ..ProptestConfig::default()
    })]

    #[test]
    fn sqlite_fact_store_operation_sequence_matches_active_model(
        operations in prop::collection::vec(operation_strategy(), 1..256)
    ) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");

        runtime.block_on(async move {
            let tempdir = tempdir().expect("tempdir");
            let workspace = Workspace::at(tempdir.path());
            let store = poneglyph_local::open_fact_store(&workspace)
                .await
                .expect("fact store");
            let mut model = BTreeMap::<(u8, u8, u16), Fact>::new();
            let mut touched_entities = BTreeSet::<u8>::new();

            for op in operations {
                touched_entities.insert(op.entity);
                let key = (op.entity, op.field, op.value);
                if op.retract {
                    if let Some(assertion) = model.remove(&key) {
                        let retraction = Fact::builder()
                            .source(assertion.source.clone())
                            .entity(assertion.entity.clone())
                            .field(assertion.field.clone())
                            .value(assertion.value.clone())
                            .retract()
                            .build()
                            .expect("retraction");
                        store.state_facts(fact_channel(vec![retraction])).await.expect("state retraction");
                    }
                } else {
                    let assertion = op_fact(&op);
                    store.state_facts(fact_channel(vec![assertion.clone()])).await.expect("state assertion");
                    model.insert(key, assertion);
                }
            }

            let active = collect_active_facts(
                store.get_active_facts(ActiveFilter::All).await.expect("active")
            ).await.expect("collect active");
            prop_assert_eq!(active.len(), model.len());

            for entity_index in touched_entities {
                let entity = uri!(format!("fuzz:item:{}", entity_index));
                let active_for_entity = collect_active_facts(
                    store.get_active_facts(ActiveFilter::ByEntity(entity)).await.expect("entity active")
                ).await.expect("collect entity active");
                let expected = model.keys().filter(|(entity, _, _)| *entity == entity_index).count();
                prop_assert_eq!(active_for_entity.len(), expected);
            }

            Ok(())
        })?;
    }
}
