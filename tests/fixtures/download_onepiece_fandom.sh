#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${PONEGLYPH_FIXTURE_DIR:-$ROOT/tests/fixtures/cache}"
STATS_URL="${PONEGLYPH_ONEPIECE_STATS_URL:-https://onepiece.fandom.com/wiki/Special:Statistics}"
mkdir -p "$OUT_DIR"

stats_html="$OUT_DIR/onepiece-special-statistics.html"
echo "Fetching $STATS_URL" >&2
curl -L --fail --retry 3 --retry-delay 2 \
  -A 'poneglyph-fixture-fetcher/0.1 (+https://github.com/leostera/poneglyph)' \
  -o "$stats_html" "$STATS_URL"

archive_url="$(python3 - "$stats_html" <<'PY'
import html, re, sys
text = open(sys.argv[1], encoding='utf-8', errors='ignore').read()
links = [html.unescape(m) for m in re.findall(r'href=["\']([^"\']+)["\']', text)]
ranked = []
for link in links:
    low = link.lower()
    if any(n in low for n in ('.xml.gz', '.xml.bz2', '.xml')) and any(w in low for w in ('pages', 'articles', 'current', 'dump')):
        ranked.append(link)
if not ranked:
    sys.exit(2)
url = ranked[0]
if url.startswith('//'):
    url = 'https:' + url
elif url.startswith('/'):
    url = 'https://onepiece.fandom.com' + url
print(url)
PY
)" || {
  echo "Could not find an XML dump link on $STATS_URL" >&2
  echo "Set PONEGLYPH_ONEPIECE_DUMP_URL to a latest pages XML dump URL if Fandom changes the page." >&2
  exit 2
}

archive_name="$(basename "${archive_url%%\?*}")"
archive_path="$OUT_DIR/$archive_name"
echo "Downloading $archive_url" >&2
curl -L --fail --retry 3 --retry-delay 2 \
  -A 'poneglyph-fixture-fetcher/0.1 (+https://github.com/leostera/poneglyph)' \
  -o "$archive_path" "$archive_url"

case "$archive_path" in
  *.gz) xml_path="${archive_path%.gz}"; gzip -cd "$archive_path" > "$xml_path" ;;
  *.bz2) xml_path="${archive_path%.bz2}"; bzip2 -cd "$archive_path" > "$xml_path" ;;
  *) xml_path="$archive_path" ;;
esac

ln -sf "$xml_path" "$OUT_DIR/onepiece-pages-current.xml"
echo "$xml_path"
