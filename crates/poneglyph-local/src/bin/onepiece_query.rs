use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use poneglyph::{Fact, PoneResult, Value, Workspace, fact, uri};

#[tokio::main]
async fn main() -> PoneResult<()> {
    let args = Args::parse();
    let pages = load_pages(&args.fixture, args.max_pages)?;
    let facts = onepiece_pages_to_facts(&pages);
    let runtime = poneglyph_local::open_workspace(Workspace::at(&args.workspace)).await?;

    if args.ingest {
        for chunk in facts.chunks(args.batch_size) {
            runtime.state_facts(chunk.to_vec()).await?;
        }
        eprintln!(
            "ingested {} facts from {} pages into {}",
            facts.len(),
            pages.len(),
            args.workspace.display()
        );
    }

    let queries = if args.query.is_empty() {
        preset_queries(args.preset.as_deref())
    } else {
        vec![("custom".to_string(), args.query.join(" "))]
    };

    for (name, query) in queries {
        println!("\n-- {name}\n{query}");
        let rows = runtime.query_str(&query).await?;
        println!("{} rows", rows.len());
        for row in rows.substitutions().iter().take(args.limit) {
            println!("{row:?}");
        }
        if rows.len() > args.limit {
            println!("... {} more", rows.len() - args.limit);
        }
    }
    Ok(())
}

#[derive(Debug)]
struct Args {
    workspace: PathBuf,
    fixture: PathBuf,
    max_pages: Option<usize>,
    batch_size: usize,
    limit: usize,
    ingest: bool,
    preset: Option<String>,
    query: Vec<String>,
}

impl Args {
    fn parse() -> Self {
        let mut args = std::env::args().skip(1);
        let mut parsed = Self {
            workspace: PathBuf::from(".onepiece-query.poneglyph"),
            fixture: repo_root().join("tests/fixtures/cache/onepiece-pages-current.xml"),
            max_pages: Some(5_000),
            batch_size: 10_000,
            limit: 50,
            ingest: true,
            preset: None,
            query: Vec::new(),
        };
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--workspace" => {
                    parsed.workspace = PathBuf::from(args.next().expect("--workspace PATH"));
                }
                "--fixture" => parsed.fixture = PathBuf::from(args.next().expect("--fixture PATH")),
                "--max-pages" => {
                    parsed.max_pages = Some(args.next().expect("--max-pages N").parse().unwrap());
                }
                "--all-pages" => parsed.max_pages = None,
                "--batch-size" => {
                    parsed.batch_size = args.next().expect("--batch-size N").parse().unwrap();
                }
                "--limit" => parsed.limit = args.next().expect("--limit N").parse().unwrap(),
                "--no-ingest" => parsed.ingest = false,
                "--preset" => parsed.preset = Some(args.next().expect("--preset NAME")),
                "--query" => parsed.query.push(args.next().expect("--query DATAFOX")),
                "--help" | "-h" => {
                    print_help();
                    std::process::exit(0);
                }
                other => parsed.query.push(other.to_string()),
            }
        }
        parsed
    }
}

fn print_help() {
    println!(
        r#"One Piece query playground

Usage:
  cargo run -p poneglyph-local --bin onepiece_query --release -- [options]

Options:
  --workspace PATH    Workspace dir [default: .onepiece-query.poneglyph]
  --fixture PATH      XML fixture [default: tests/fixtures/cache/onepiece-pages-current.xml]
  --max-pages N       Cap parsed pages [default: 5000]
  --all-pages         Parse the full dump
  --batch-size N      Ingest batch size [default: 10000]
  --limit N           Max rows printed per query [default: 50]
  --no-ingest         Reuse existing workspace without ingesting
  --preset NAME       captains | islands | joyboy | d-names | all [default: all]
  --query DATAFOX     Run custom Datafox query instead of presets

Examples:
  tests/fixtures/download_onepiece_fandom.sh
  cargo run -p poneglyph-local --bin onepiece_query --release -- --preset all
  cargo run -p poneglyph-local --bin onepiece_query --release -- --no-ingest --query 'wiki:page:title(Person, Name), contains(Name, " D. ")'
"#
    );
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[derive(Debug)]
struct WikiPage {
    title: String,
    namespace: String,
    text: String,
}

fn load_pages(path: &Path, max_pages: Option<usize>) -> PoneResult<Vec<WikiPage>> {
    let xml =
        fs::read_to_string(path).map_err(|source| poneglyph::Error::FactStoreIo { source })?;
    let mut pages = Vec::new();
    let mut rest = xml.as_str();
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
        pages.push(WikiPage {
            title,
            namespace: xml_text(page_xml, "ns").unwrap_or_else(|| "0".to_string()),
            text: xml_text(page_xml, "text").unwrap_or_default(),
        });
        if max_pages.is_some_and(|limit| pages.len() >= limit) {
            break;
        }
    }
    Ok(pages)
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

fn onepiece_page_entity(title: &str) -> poneglyph::Uri {
    uri!(format!("wiki:onepiece:page:{}", slug_uri_component(title)))
}

fn onepiece_pages_to_facts(pages: &[WikiPage]) -> Vec<Fact> {
    let source = uri!("fixture:onepiece-fandom");
    let mut facts = Vec::with_capacity(pages.len() * 5 + 64);
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
        facts.push(fact!(
            source.clone(),
            onepiece_page_entity(crew),
            uri!("wiki:crew:captain"),
            Value::reference(onepiece_page_entity(captain))
        ));
        facts.push(fact!(
            source.clone(),
            onepiece_page_entity(crew),
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

fn preset_queries(name: Option<&str>) -> Vec<(String, String)> {
    let all = vec![
        (
            "captains".to_string(),
            r#"wiki:crew:captain(Crew, Captain), wiki:crew:second(Crew, Second), wiki:page:title(Crew, CrewName), wiki:page:title(Captain, CaptainName), wiki:page:title(Second, SecondName)"#.to_string(),
        ),
        (
            "islands".to_string(),
            r#"wiki:island:leader(Island, Leader), wiki:page:title(Island, IslandName), wiki:page:title(Leader, LeaderName)"#.to_string(),
        ),
        (
            "joyboy".to_string(),
            r#"wiki:lore:directConnection(A, B), wiki:lore:directConnection(B, C), wiki:lore:directConnection(C, D), wiki:lore:directConnection(D, E), wiki:page:title(A, "Joy Boy"), wiki:page:title(E, "Monkey D. Luffy")"#.to_string(),
        ),
        (
            "d-names".to_string(),
            r#"wiki:page:title(Person, Name), contains(Name, " D. ")"#.to_string(),
        ),
    ];
    match name.unwrap_or("all") {
        "all" => all,
        selected => all
            .into_iter()
            .filter(|(name, _)| name == selected)
            .collect(),
    }
}
