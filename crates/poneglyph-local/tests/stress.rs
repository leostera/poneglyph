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

fn onepiece_fixture_path() -> std::path::PathBuf {
    if let Ok(path) = std::env::var("PONEGLYPH_ONEPIECE_XML") {
        return Path::new(&path).to_path_buf();
    }

    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("tests/fixtures/cache/onepiece-pages-current.xml")
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

fn onepiece_page_entity(title: &str) -> poneglyph::Uri {
    uri!(format!("wiki:onepiece:page:{}", slug_uri_component(title)))
}

fn onepiece_pages_to_facts(pages: &[WikiPage]) -> Vec<Fact> {
    let source = uri!("fixture:onepiece-fandom");
    let mut facts = Vec::with_capacity(pages.len() * 5 + 32);
    for (index, page) in pages.iter().enumerate() {
        let entity = onepiece_page_entity(&page.title);
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
    add_onepiece_domain_facts(&source, &mut facts);
    facts
}

fn add_onepiece_domain_facts(source: &poneglyph::Uri, facts: &mut Vec<Fact>) {
    let crews = [
        ("Straw Hat Pirates", "Monkey D. Luffy", "Roronoa Zoro"),
        ("Roger Pirates", "Gol D. Roger", "Silvers Rayleigh"),
        ("Red Hair Pirates", "Shanks", "Benn Beckman"),
        ("Whitebeard Pirates", "Edward Newgate", "Marco"),
        ("Kid Pirates", "Eustass Kid", "Killer"),
        ("Heart Pirates", "Trafalgar D. Water Law", "Bepo"),
    ];
    let islands = [
        ("Wano Country", "Kozuki Momonosuke"),
        ("Arabasta Kingdom", "Nefertari Cobra"),
        ("Dressrosa", "Riku Doldo III"),
        ("Fish-Man Island", "Neptune"),
        ("Drum Island", "Dalton"),
        ("Amazon Lily", "Boa Hancock"),
        ("Zou", "Inuarashi"),
    ];
    let chain = [
        ("Joy Boy", "Nika"),
        ("Nika", "Gol D. Roger"),
        ("Gol D. Roger", "Shanks"),
        ("Shanks", "Monkey D. Luffy"),
    ];

    let mut titles = BTreeSet::new();
    for (crew, captain, second) in crews {
        titles.extend([crew, captain, second]);
    }
    for (island, leader) in islands {
        titles.extend([island, leader]);
    }
    for (from, to) in chain {
        titles.extend([from, to]);
    }
    for title in titles {
        facts.push(fact!(
            source.clone(),
            onepiece_page_entity(title),
            uri!("wiki:page:title"),
            Value::text(title)
        ));
    }

    for (crew, captain, second) in crews {
        let crew = onepiece_page_entity(crew);
        facts.push(fact!(
            source.clone(),
            crew.clone(),
            uri!("wiki:crew:captain"),
            Value::reference(onepiece_page_entity(captain))
        ));
        facts.push(fact!(
            source.clone(),
            crew,
            uri!("wiki:crew:second"),
            Value::reference(onepiece_page_entity(second))
        ));
    }

    for (island, leader) in islands {
        facts.push(fact!(
            source.clone(),
            onepiece_page_entity(island),
            uri!("wiki:island:leader"),
            Value::reference(onepiece_page_entity(leader))
        ));
    }

    for (from, to) in chain {
        facts.push(fact!(
            source.clone(),
            onepiece_page_entity(from),
            uri!("wiki:lore:directConnection"),
            Value::reference(onepiece_page_entity(to))
        ));
    }
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

fn onepiece_datafox_queries() -> [(&'static str, &'static str); 4] {
    [
        (
            "captains_and_seconds",
            r#"wiki:crew:captain(Crew, Captain), wiki:crew:second(Crew, Second), wiki:page:title(Crew, CrewName), wiki:page:title(Captain, CaptainName), wiki:page:title(Second, SecondName)"#,
        ),
        (
            "islands_and_leaders",
            r#"wiki:island:leader(Island, Leader), wiki:page:title(Island, IslandName), wiki:page:title(Leader, LeaderName)"#,
        ),
        (
            "joyboy_to_luffy_chain",
            r#"wiki:lore:directConnection(A, B), wiki:lore:directConnection(B, C), wiki:lore:directConnection(C, D), wiki:lore:directConnection(D, E), wiki:page:title(A, "Joy Boy"), wiki:page:title(E, "Monkey D. Luffy")"#,
        ),
        (
            "people_with_d_name",
            r#"wiki:page:title(Person, Name), contains(Name, " D. ")"#,
        ),
    ]
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
#[ignore = "set PONEGLYPH_STRESS_FACTS/PONEGLYPH_STRESS_BATCH and run with --ignored"]
async fn local_lsm_backend_write_heavy_stress() {
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
    let store = poneglyph_local::open_lsm_fact_store(&workspace).expect("fact store");

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
    eprintln!("lsm write-heavy stress wrote {total} facts in {elapsed:?}");
}

#[tokio::test]
#[ignore = "download tests/fixtures/onepiece-pages-current.xml or set PONEGLYPH_ONEPIECE_XML"]
async fn local_backend_onepiece_wiki_ingest_stress() {
    let fixture_path = onepiece_fixture_path();
    let max_pages = std::env::var("PONEGLYPH_ONEPIECE_MAX_PAGES")
        .ok()
        .and_then(|value| value.parse().ok());
    let batch_size = std::env::var("PONEGLYPH_ONEPIECE_BATCH")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(10_000);

    let pages = load_onepiece_pages(&fixture_path, max_pages).unwrap_or_else(|error| {
        panic!(
            "could not load One Piece XML fixture at {}: {error}; run tests/fixtures/download_onepiece_fandom.sh or set PONEGLYPH_ONEPIECE_XML",
            fixture_path.display()
        )
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
#[ignore = "download tests/fixtures/onepiece-pages-current.xml or set PONEGLYPH_ONEPIECE_XML"]
async fn local_lsm_backend_onepiece_wiki_ingest_stress() {
    let fixture_path = onepiece_fixture_path();
    let max_pages = std::env::var("PONEGLYPH_ONEPIECE_MAX_PAGES")
        .ok()
        .and_then(|value| value.parse().ok());
    let batch_size = std::env::var("PONEGLYPH_ONEPIECE_BATCH")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(10_000);

    let pages = load_onepiece_pages(&fixture_path, max_pages).unwrap_or_else(|error| {
        panic!(
            "could not load One Piece XML fixture at {}: {error}; run tests/fixtures/download_onepiece_fandom.sh or set PONEGLYPH_ONEPIECE_XML",
            fixture_path.display()
        )
    });
    let facts = onepiece_pages_to_facts(&pages);

    let tempdir = tempdir().expect("tempdir");
    let workspace = Workspace::at(tempdir.path());
    let store = poneglyph_local::open_lsm_fact_store(&workspace).expect("fact store");

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
        "lsm onepiece wiki ingest wrote {} facts from {} pages in {:?}",
        facts.len(),
        pages.len(),
        elapsed
    );
}

#[tokio::test]
#[ignore = "download One Piece fixture and run with --ignored"]
async fn local_backend_onepiece_wiki_query_stress() {
    let max_pages = std::env::var("PONEGLYPH_ONEPIECE_MAX_PAGES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(5_000);
    let batch_size = std::env::var("PONEGLYPH_ONEPIECE_BATCH")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(10_000);
    let queries = std::env::var("PONEGLYPH_ONEPIECE_QUERIES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(200);

    let pages = load_onepiece_pages(&onepiece_fixture_path(), Some(max_pages))
        .expect("load One Piece XML fixture");
    let facts = onepiece_pages_to_facts(&pages);

    let tempdir = tempdir().expect("tempdir");
    let workspace = Workspace::at(tempdir.path());
    let runtime = poneglyph_local::open_workspace(workspace)
        .await
        .expect("runtime");
    for chunk in facts.chunks(batch_size) {
        runtime
            .state_facts(chunk.to_vec())
            .await
            .expect("write fixture facts");
    }

    let datafox_queries = [
        (
            "captains_and_seconds",
            r#"wiki:crew:captain(Crew, Captain), wiki:crew:second(Crew, Second), wiki:page:title(Crew, CrewName), wiki:page:title(Captain, CaptainName), wiki:page:title(Second, SecondName)"#,
        ),
        (
            "islands_and_leaders",
            r#"wiki:island:leader(Island, Leader), wiki:page:title(Island, IslandName), wiki:page:title(Leader, LeaderName)"#,
        ),
        (
            "joyboy_to_luffy_chain",
            r#"wiki:lore:directConnection(A, B), wiki:lore:directConnection(B, C), wiki:lore:directConnection(C, D), wiki:lore:directConnection(D, E), wiki:page:title(A, "Joy Boy"), wiki:page:title(E, "Monkey D. Luffy")"#,
        ),
        (
            "people_with_d_name",
            r#"wiki:page:title(Person, Name), contains(Name, " D. ")"#,
        ),
    ];

    for (name, query) in datafox_queries {
        let rows = runtime.query_str(query).await.expect("datafox query");
        assert!(!rows.is_empty(), "{name} should return rows");
        eprintln!("onepiece datafox {name}: {:?}", rows.substitutions());
    }

    let started = Instant::now();
    for query in 0..queries {
        let (_, source) = datafox_queries[query % datafox_queries.len()];
        let rows = runtime.query_str(source).await.expect("datafox query");
        assert!(!rows.is_empty());
    }
    let elapsed = started.elapsed();
    eprintln!(
        "onepiece wiki datafox query stress completed {queries} queries over {} facts from {} pages in {:?}",
        facts.len(),
        pages.len(),
        elapsed
    );
}

#[tokio::test]
#[ignore = "download One Piece fixture and run with --ignored"]
async fn local_lsm_backend_onepiece_wiki_query_stress() {
    let max_pages = std::env::var("PONEGLYPH_ONEPIECE_MAX_PAGES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(5_000);
    let batch_size = std::env::var("PONEGLYPH_ONEPIECE_BATCH")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(10_000);
    let queries = std::env::var("PONEGLYPH_ONEPIECE_QUERIES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(200);

    let pages = load_onepiece_pages(&onepiece_fixture_path(), Some(max_pages))
        .expect("load One Piece XML fixture");
    let facts = onepiece_pages_to_facts(&pages);

    let tempdir = tempdir().expect("tempdir");
    let workspace = Workspace::at(tempdir.path());
    let runtime = poneglyph_local::open_lsm_workspace(workspace)
        .await
        .expect("runtime");
    for chunk in facts.chunks(batch_size) {
        runtime
            .state_facts(chunk.to_vec())
            .await
            .expect("write fixture facts");
    }

    let datafox_queries = [
        (
            "captains_and_seconds",
            r#"wiki:crew:captain(Crew, Captain), wiki:crew:second(Crew, Second), wiki:page:title(Crew, CrewName), wiki:page:title(Captain, CaptainName), wiki:page:title(Second, SecondName)"#,
        ),
        (
            "islands_and_leaders",
            r#"wiki:island:leader(Island, Leader), wiki:page:title(Island, IslandName), wiki:page:title(Leader, LeaderName)"#,
        ),
        (
            "joyboy_to_luffy_chain",
            r#"wiki:lore:directConnection(A, B), wiki:lore:directConnection(B, C), wiki:lore:directConnection(C, D), wiki:lore:directConnection(D, E), wiki:page:title(A, "Joy Boy"), wiki:page:title(E, "Monkey D. Luffy")"#,
        ),
        (
            "people_with_d_name",
            r#"wiki:page:title(Person, Name), contains(Name, " D. ")"#,
        ),
    ];

    for (name, query) in datafox_queries {
        let rows = runtime.query_str(query).await.expect("datafox query");
        assert!(!rows.is_empty(), "{name} should return rows");
        eprintln!("lsm onepiece datafox {name}: {:?}", rows.substitutions());
    }

    let started = Instant::now();
    for query in 0..queries {
        let (_, source) = datafox_queries[query % datafox_queries.len()];
        let rows = runtime.query_str(source).await.expect("datafox query");
        assert!(!rows.is_empty());
    }
    let elapsed = started.elapsed();
    eprintln!(
        "lsm onepiece wiki datafox query stress completed {queries} queries over {} facts from {} pages in {:?}",
        facts.len(),
        pages.len(),
        elapsed
    );
}

#[tokio::test]
#[ignore = "download One Piece fixture and run with --ignored"]
async fn local_lsm_backend_onepiece_wiki_query_cold_warm_stress() {
    let max_pages = std::env::var("PONEGLYPH_ONEPIECE_MAX_PAGES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(5_000);
    let batch_size = std::env::var("PONEGLYPH_ONEPIECE_BATCH")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(10_000);
    let warm_queries = std::env::var("PONEGLYPH_ONEPIECE_QUERIES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(20);

    let pages = load_onepiece_pages(&onepiece_fixture_path(), Some(max_pages))
        .expect("load One Piece XML fixture");
    let facts = onepiece_pages_to_facts(&pages);

    let tempdir = tempdir().expect("tempdir");
    let workspace = Workspace::at(tempdir.path());
    let runtime = poneglyph_local::open_lsm_workspace(workspace)
        .await
        .expect("runtime");
    for chunk in facts.chunks(batch_size) {
        runtime
            .state_facts(chunk.to_vec())
            .await
            .expect("write fixture facts");
    }

    let datafox_queries = onepiece_datafox_queries();
    let cold_started = Instant::now();
    for (name, query) in datafox_queries {
        let rows = runtime.query_str(query).await.expect("cold datafox query");
        assert!(!rows.is_empty(), "{name} should return rows");
    }
    let cold_elapsed = cold_started.elapsed();

    let warm_started = Instant::now();
    for query in 0..warm_queries {
        let (_, source) = datafox_queries[query % datafox_queries.len()];
        let rows = runtime.query_str(source).await.expect("warm datafox query");
        assert!(!rows.is_empty());
    }
    let warm_elapsed = warm_started.elapsed();

    eprintln!(
        "lsm onepiece cold/warm query stress: cold {} queries in {:?}; warm {warm_queries} queries in {:?}; {} facts from {} pages",
        datafox_queries.len(),
        cold_elapsed,
        warm_elapsed,
        facts.len(),
        pages.len()
    );
}

#[tokio::test]
#[ignore = "download One Piece fixture and run with --ignored"]
async fn local_lsm_backend_onepiece_reopen_query_stress() {
    let max_pages = std::env::var("PONEGLYPH_ONEPIECE_MAX_PAGES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(5_000);
    let batch_size = std::env::var("PONEGLYPH_ONEPIECE_BATCH")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(10_000);

    let pages = load_onepiece_pages(&onepiece_fixture_path(), Some(max_pages))
        .expect("load One Piece XML fixture");
    let facts = onepiece_pages_to_facts(&pages);

    let tempdir = tempdir().expect("tempdir");
    let workspace = Workspace::at(tempdir.path());
    {
        let runtime = poneglyph_local::open_lsm_workspace(workspace.clone())
            .await
            .expect("runtime");
        for chunk in facts.chunks(batch_size) {
            runtime
                .state_facts(chunk.to_vec())
                .await
                .expect("write fixture facts");
        }
    }

    let open_started = Instant::now();
    let runtime = poneglyph_local::open_lsm_workspace(workspace)
        .await
        .expect("reopen runtime");
    let open_elapsed = open_started.elapsed();

    let datafox_queries = onepiece_datafox_queries();
    let query_started = Instant::now();
    for (name, query) in datafox_queries {
        let rows = runtime
            .query_str(query)
            .await
            .expect("reopened datafox query");
        assert!(!rows.is_empty(), "{name} should return rows");
    }
    let query_elapsed = query_started.elapsed();

    eprintln!(
        "lsm onepiece reopen query stress: reopen in {:?}; first {} queries in {:?}; {} facts from {} pages",
        open_elapsed,
        datafox_queries.len(),
        query_elapsed,
        facts.len(),
        pages.len()
    );
}

#[tokio::test]
#[ignore = "download One Piece fixture and run with --ignored"]
async fn local_lsm_backend_onepiece_compact_reopen_query_stress() {
    let max_pages = std::env::var("PONEGLYPH_ONEPIECE_MAX_PAGES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(5_000);
    let batch_size = std::env::var("PONEGLYPH_ONEPIECE_BATCH")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(10_000);

    let pages = load_onepiece_pages(&onepiece_fixture_path(), Some(max_pages))
        .expect("load One Piece XML fixture");
    let facts = onepiece_pages_to_facts(&pages);

    let tempdir = tempdir().expect("tempdir");
    let workspace = Workspace::at(tempdir.path());
    {
        let store = poneglyph_local::LsmFactStore::open(workspace.store_dir().join("facts.lsm"))
            .expect("fact store");
        state_prebuilt_batches(&store, &facts, batch_size)
            .await
            .expect("write fixture facts");
        let compact_started = Instant::now();
        store.compact().expect("compact lsm store");
        eprintln!(
            "lsm onepiece compact before reopen took {:?}",
            compact_started.elapsed()
        );
    }

    let open_started = Instant::now();
    let runtime = poneglyph_local::open_lsm_workspace(workspace)
        .await
        .expect("reopen runtime");
    let open_elapsed = open_started.elapsed();

    let datafox_queries = onepiece_datafox_queries();
    let query_started = Instant::now();
    for (name, query) in datafox_queries {
        let rows = runtime
            .query_str(query)
            .await
            .expect("compacted reopened datafox query");
        assert!(!rows.is_empty(), "{name} should return rows");
    }
    let query_elapsed = query_started.elapsed();

    eprintln!(
        "lsm onepiece compact+reopen query stress: reopen in {:?}; first {} queries in {:?}; {} facts from {} pages",
        open_elapsed,
        datafox_queries.len(),
        query_elapsed,
        facts.len(),
        pages.len()
    );
}

#[tokio::test]
#[ignore = "download One Piece fixture and run with --ignored"]
async fn local_lsm_backend_onepiece_fact_store_reopen_stress() {
    let max_pages = std::env::var("PONEGLYPH_ONEPIECE_MAX_PAGES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(5_000);
    let batch_size = std::env::var("PONEGLYPH_ONEPIECE_BATCH")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(10_000);

    let pages = load_onepiece_pages(&onepiece_fixture_path(), Some(max_pages))
        .expect("load One Piece XML fixture");
    let facts = onepiece_pages_to_facts(&pages);

    let tempdir = tempdir().expect("tempdir");
    let lsm_path = tempdir.path().join("facts.lsm");
    {
        let store = poneglyph_local::LsmFactStore::open(&lsm_path).expect("fact store");
        state_prebuilt_batches(&store, &facts, batch_size)
            .await
            .expect("write fixture facts");
    }

    let wal_open_started = Instant::now();
    let wal_store = poneglyph_local::LsmFactStore::open(&lsm_path).expect("reopen wal store");
    let wal_open_elapsed = wal_open_started.elapsed();
    let active_started = Instant::now();
    let active = collect_active_facts(
        wal_store
            .get_active_facts(ActiveFilter::ByField(uri!("wiki:page:title")))
            .await
            .expect("active title facts"),
    )
    .await
    .expect("collect active titles");
    assert!(active.len() >= pages.len());
    let wal_first_active_elapsed = active_started.elapsed();
    wal_store.compact().expect("compact");
    drop(wal_store);

    let compact_open_started = Instant::now();
    let compact_store =
        poneglyph_local::LsmFactStore::open(&lsm_path).expect("reopen compacted store");
    let compact_open_elapsed = compact_open_started.elapsed();
    let compact_active_started = Instant::now();
    let active = collect_active_facts(
        compact_store
            .get_active_facts(ActiveFilter::ByField(uri!("wiki:page:title")))
            .await
            .expect("active title facts"),
    )
    .await
    .expect("collect active titles");
    assert!(active.len() >= pages.len());
    let compact_first_active_elapsed = compact_active_started.elapsed();

    eprintln!(
        "lsm onepiece fact-store reopen stress: wal reopen {:?}, first active {:?}; compacted reopen {:?}, first active {:?}; {} facts from {} pages",
        wal_open_elapsed,
        wal_first_active_elapsed,
        compact_open_elapsed,
        compact_first_active_elapsed,
        facts.len(),
        pages.len()
    );
}

#[tokio::test]
#[ignore = "download One Piece fixture and run with --ignored"]
async fn local_lsm_backend_onepiece_planned_compaction_reopen_stress() {
    let max_pages = std::env::var("PONEGLYPH_ONEPIECE_MAX_PAGES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(5_000);
    let batch_size = std::env::var("PONEGLYPH_ONEPIECE_BATCH")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(2_000);

    let pages = load_onepiece_pages(&onepiece_fixture_path(), Some(max_pages))
        .expect("load One Piece XML fixture");
    let facts = onepiece_pages_to_facts(&pages);

    let tempdir = tempdir().expect("tempdir");
    let lsm_path = tempdir.path().join("facts.lsm");
    let mut planned_compactions = 0;
    let compact_elapsed;
    {
        let store = poneglyph_local::LsmFactStore::open(&lsm_path).expect("fact store");
        let compact_started = Instant::now();
        for chunk in facts.chunks(batch_size) {
            store
                .state_facts_vec(chunk.to_vec())
                .await
                .expect("write fixture chunk");
            store.flush().expect("flush chunk");
            if store.compact_if_needed().expect("planned compact check") {
                planned_compactions += 1;
            }
        }
        if store
            .compact_if_needed()
            .expect("final planned compact check")
        {
            planned_compactions += 1;
        }
        compact_elapsed = compact_started.elapsed();
    }

    let open_started = Instant::now();
    let store = poneglyph_local::LsmFactStore::open(&lsm_path).expect("reopen planned store");
    let open_elapsed = open_started.elapsed();
    let active_started = Instant::now();
    let active = collect_active_facts(
        store
            .get_active_facts(ActiveFilter::ByField(uri!("wiki:page:title")))
            .await
            .expect("active title facts"),
    )
    .await
    .expect("collect active titles");
    assert!(active.len() >= pages.len());
    let active_elapsed = active_started.elapsed();

    eprintln!(
        "lsm onepiece planned-compaction reopen stress: {} planned compactions in {:?}; reopen {:?}; first active {:?}; threshold {}; max_inputs {}; max_bytes {}; split_flush {}; {} facts from {} pages",
        planned_compactions,
        compact_elapsed,
        open_elapsed,
        active_elapsed,
        std::env::var("PONEGLYPH_LSM_L0_COMPACTION_SEGMENTS").unwrap_or_else(|_| "16".to_string()),
        std::env::var("PONEGLYPH_LSM_L0_COMPACTION_MAX_INPUTS").unwrap_or_else(|_| "4".to_string()),
        std::env::var("PONEGLYPH_LSM_L0_COMPACTION_MAX_BYTES")
            .unwrap_or_else(|_| (16 * 1024 * 1024).to_string()),
        std::env::var("PONEGLYPH_LSM_SPLIT_FLUSH_BY_KEYSPACE")
            .unwrap_or_else(|_| "false".to_string()),
        facts.len(),
        pages.len()
    );
}

#[tokio::test]
#[ignore = "download One Piece fixture and run with --ignored"]
async fn local_lsm_backend_onepiece_prewarm_reopen_query_stress() {
    let max_pages = std::env::var("PONEGLYPH_ONEPIECE_MAX_PAGES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(5_000);
    let batch_size = std::env::var("PONEGLYPH_ONEPIECE_BATCH")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(10_000);

    let pages = load_onepiece_pages(&onepiece_fixture_path(), Some(max_pages))
        .expect("load One Piece XML fixture");
    let facts = onepiece_pages_to_facts(&pages);

    let tempdir = tempdir().expect("tempdir");
    let workspace = Workspace::at(tempdir.path());
    {
        let store = poneglyph_local::LsmFactStore::open(workspace.store_dir().join("facts.lsm"))
            .expect("fact store");
        state_prebuilt_batches(&store, &facts, batch_size)
            .await
            .expect("write fixture facts");
        store.compact().expect("compact lsm store");
    }

    let open_started = Instant::now();
    let runtime = poneglyph_local::open_prewarmed_lsm_workspace(workspace)
        .await
        .expect("reopen prewarmed runtime");
    let open_elapsed = open_started.elapsed();
    let datafox_queries = onepiece_datafox_queries();
    let query_started = Instant::now();
    for (name, query) in datafox_queries {
        let rows = runtime
            .query_str(query)
            .await
            .expect("prewarmed reopened datafox query");
        assert!(!rows.is_empty(), "{name} should return rows");
    }
    let query_elapsed = query_started.elapsed();

    eprintln!(
        "lsm onepiece prewarm reopen query stress: reopen+prewarm in {:?}; first {} queries in {:?}; {} facts from {} pages",
        open_elapsed,
        datafox_queries.len(),
        query_elapsed,
        facts.len(),
        pages.len()
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
