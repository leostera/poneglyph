use anyhow::Result;
use poneglyph_core::{PoneResult, Uri};

pub async fn collect_results<T>(
    mut stream: tokio::sync::mpsc::Receiver<PoneResult<T>>,
) -> Result<Vec<T>> {
    let mut items = Vec::new();
    while let Some(item) = stream.recv().await {
        items.push(item?);
    }
    Ok(items)
}

pub fn parse_uri(value: &str) -> Result<Uri> {
    Uri::parse(value.to_string()).map_err(Into::into)
}

pub fn usize_to_u64(value: usize) -> Result<u64> {
    u64::try_from(value).map_err(Into::into)
}
