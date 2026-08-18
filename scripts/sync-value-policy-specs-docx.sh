#!/usr/bin/env bash
set -euo pipefail

# Generate the two Phase 1 Spec DOCX files from their Markdown sources.
# Pandoc is the authoritative conversion. Do not hand-edit the DOCX copies.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v pandoc >/dev/null 2>&1; then
  echo "[ERROR] pandoc is required to sync ValuePolicy spec DOCX files." >&2
  exit 1
fi

sync_one() {
  local md="$1"
  local docx="$2"
  local marker="$3"
  test -f "$md"
  pandoc "$md" -f markdown -t docx -o "$docx"
  local text
  text="$(pandoc "$docx" -f docx -t plain)"
  if ! grep -Fq "$marker" <<<"$text"; then
    echo "[ERROR] $docx is missing required marker: $marker" >&2
    exit 1
  fi
  echo "[OK] $docx"
}

sync_one \
  docs/specs/points-value-policy-phase-1.md \
  docs/specs/points-value-policy-phase-1.docx \
  "Implemented — Production Activation Blocked by D-02/D-03"

sync_one \
  docs/specs/points-real-value-alignment.md \
  docs/specs/points-real-value-alignment.docx \
  "两个“Phase 1”不要混用"
