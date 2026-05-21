mod common;
use poneglyph::{Fact, PoneResult, Poneglyph, Value, Workspace, fact, uri};
use tempfile::{TempDir, tempdir};

fn schema_facts() -> Vec<Fact> {
    vec![
        fact!(
            uri!("spotify:namespace"),
            uri!("schema:type"),
            Value::reference(uri!("schema:namespace"))
        ),
        fact!(
            uri!("spotify:namespace"),
            uri!("schema:name"),
            Value::text("Spotify")
        ),
        fact!(
            uri!("spotify:namespace"),
            uri!("schema:doc"),
            Value::text("Spotify schema.")
        ),
        fact!(
            uri!("spotify:artist"),
            uri!("schema:type"),
            Value::reference(uri!("schema:kind"))
        ),
        fact!(
            uri!("spotify:artist"),
            uri!("schema:name"),
            Value::text("Artist")
        ),
        fact!(
            uri!("spotify:artist"),
            uri!("schema:doc"),
            Value::text("A musical artist.")
        ),
        fact!(
            uri!("spotify:field:displayName"),
            uri!("schema:type"),
            Value::reference(uri!("schema:field"))
        ),
        fact!(
            uri!("spotify:field:displayName"),
            uri!("schema:name"),
            Value::text("Display Name")
        ),
        fact!(
            uri!("spotify:field:displayName"),
            uri!("schema:doc"),
            Value::text("The display name for an entity.")
        ),
        fact!(
            uri!("spotify:field:displayName"),
            uri!("schema:field:domain"),
            Value::reference(uri!("spotify:artist"))
        ),
        fact!(
            uri!("spotify:field:displayName"),
            uri!("schema:field:valueType"),
            Value::text("text")
        ),
    ]
}

async fn build_sqlite_runtime() -> PoneResult<(TempDir, Poneglyph)> {
    let tempdir = tempdir().expect("tempdir");
    let workspace = Workspace::at(tempdir.path());
    let poneglyph = poneglyph_local::open_workspace(workspace).await?;
    Ok((tempdir, poneglyph))
}

#[tokio::test]
async fn sqlite_get_schema_reflects_new_schema_facts_immediately() -> PoneResult<()> {
    let (_tempdir, poneglyph) = build_sqlite_runtime().await?;

    poneglyph.state_facts(schema_facts()).await?;

    let schema = poneglyph.get_schema().await?;
    assert!(
        schema
            .namespaces
            .iter()
            .any(|namespace| namespace.uri.as_str() == "spotify:namespace")
    );
    assert!(
        schema
            .kinds
            .iter()
            .any(|kind| kind.uri.as_str() == "spotify:artist")
    );
    assert!(schema.fields.iter().any(|field| {
        field.uri.as_str() == "spotify:field:displayName"
            && field.value_type.as_deref() == Some("text")
    }));

    Ok(())
}

#[tokio::test]
async fn sqlite_get_schema_is_invariant_under_batch_shapes() -> PoneResult<()> {
    let (_tempdir_one_batch, poneglyph_one_batch) = build_sqlite_runtime().await?;
    poneglyph_one_batch.state_facts(schema_facts()).await?;
    let schema_one_batch = poneglyph_one_batch.get_schema().await?;

    let (_tempdir_many_batches, poneglyph_many_batches) = build_sqlite_runtime().await?;
    for fact in schema_facts() {
        poneglyph_many_batches.state_facts(vec![fact]).await?;
    }
    let schema_many_batches = poneglyph_many_batches.get_schema().await?;

    assert_eq!(schema_many_batches, schema_one_batch);
    Ok(())
}

#[tokio::test]
async fn sqlite_retracting_data_does_not_remove_schema_entries() -> PoneResult<()> {
    let (_tempdir, poneglyph) = build_sqlite_runtime().await?;
    poneglyph.state_facts(schema_facts()).await?;

    let assertion = fact!(
        uri!("agent:test:writer"),
        uri!("spotify:artist:rush"),
        uri!("spotify:field:displayName"),
        Value::text("Rush")
    );
    poneglyph.state_facts(vec![assertion.clone()]).await?;
    let schema_after_assertion = poneglyph.get_schema().await?;

    let retraction = poneglyph::Fact::builder()
        .source(assertion.source.clone())
        .entity(assertion.entity.clone())
        .field(assertion.field.clone())
        .value(assertion.value.clone())
        .retract()
        .build()?;

    poneglyph.state_facts(vec![retraction]).await?;

    let schema_after = poneglyph.get_schema().await?;
    assert_eq!(schema_after, schema_after_assertion);
    Ok(())
}
