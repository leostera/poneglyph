#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${PONEGLYPH_FIXTURE_DIR:-$ROOT/tests/fixtures/cache}"
DUMP_URL="${PONEGLYPH_ONEPIECE_DUMP_URL:-https://s3.amazonaws.com/wikia_xml_dumps/o/on/onepiece_pages_current.xml.7z}"
mkdir -p "$OUT_DIR"

archive_name="$(basename "${DUMP_URL%%\?*}")"
archive_path="$OUT_DIR/$archive_name"
xml_path="$OUT_DIR/${archive_name%.7z}"

if [[ ! -s "$archive_path" ]]; then
  echo "Downloading $DUMP_URL" >&2
  curl -L --fail --retry 3 --retry-delay 2 \
    -A 'Mozilla/5.0 poneglyph-fixture-fetcher/0.1' \
    -o "$archive_path" "$DUMP_URL"
fi

case "$archive_path" in
  *.gz) xml_path="${archive_path%.gz}"; [[ -s "$xml_path" ]] || gzip -cd "$archive_path" > "$xml_path" ;;
  *.bz2) xml_path="${archive_path%.bz2}"; [[ -s "$xml_path" ]] || bzip2 -cd "$archive_path" > "$xml_path" ;;
  *.7z)
    xml_path="${archive_path%.7z}"
    if [[ ! -s "$xml_path" ]]; then
      if command -v 7z >/dev/null 2>&1; then
        7z x -so "$archive_path" > "$xml_path"
      elif command -v 7zz >/dev/null 2>&1; then
        7zz x -so "$archive_path" > "$xml_path"
      else
        bsdtar -xOf "$archive_path" > "$xml_path"
      fi
    fi
    ;;
  *) xml_path="$archive_path" ;;
esac

ln -sf "$xml_path" "$OUT_DIR/onepiece-pages-current.xml"
echo "$xml_path"
