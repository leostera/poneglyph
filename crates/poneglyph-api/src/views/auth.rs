use axum::response::Html;

pub(crate) fn landing() -> Html<&'static str> {
    Html(
        r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Poneglyph API</title>
  </head>
  <body>
    <main>
      <h1>Poneglyph API</h1>
      <p>This endpoint handles local OAuth callbacks.</p>
    </main>
  </body>
</html>"#,
    )
}

pub(crate) fn login_successful(provider: &str) -> Html<String> {
    Html(format!(
        r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{provider} Connected</title>
    <style>
      :root {{
        color-scheme: light;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }}
      body {{
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f4f7fb;
        color: #172033;
      }}
      main {{
        width: min(32rem, calc(100vw - 2rem));
        padding: 2rem;
        border-radius: 1rem;
        background: white;
        box-shadow: 0 20px 60px rgba(23, 32, 51, 0.12);
      }}
      h1 {{
        margin: 0 0 0.75rem;
        font-size: 1.5rem;
      }}
      p {{
        margin: 0;
        line-height: 1.6;
      }}
    </style>
  </head>
  <body>
    <main>
      <h1>{provider} connected</h1>
      <p>You can close this tab now.</p>
    </main>
  </body>
</html>"#
    ))
}

#[cfg(test)]
mod tests {
    use super::{landing, login_successful};

    #[test]
    fn landing_view_mentions_oauth_callbacks() {
        let html = landing().0;

        assert!(html.contains("Poneglyph API"));
        assert!(html.contains("local OAuth callbacks"));
    }

    #[test]
    fn login_successful_view_includes_close_tab_message() {
        let html = login_successful("Google").0;

        assert!(html.contains("Google connected"));
        assert!(html.contains("You can close this tab now."));
    }
}
