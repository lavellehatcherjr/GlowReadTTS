#!/usr/bin/env bash
# fetch-kokoro-model.sh
#
# Downloads the Kokoro-82M-v1.0-ONNX model + 15 voice embeddings into
# libs/kokoro-model/ so the extension can ship them bundled (no runtime
# fetch from huggingface.co).
#
# Source: https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX
# License: Apache 2.0 (model and voices are derivative works of hexgrad/Kokoro-82M,
#          also Apache 2.0). Bundling and redistribution are explicitly permitted.
#
# Run this once after cloning the repo (or after Clear AI Voice Cache).
# Requires: curl, ~70 MB free disk, network access to huggingface.co.
#
# Usage:
#   bash scripts/fetch-kokoro-model.sh           # download everything
#   bash scripts/fetch-kokoro-model.sh --verify  # check existing files only

set -e
set -u

cd "$(dirname "$0")/.."

OUT_DIR="libs/kokoro-model"
BASE="https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main"

VOICES=(
  af_heart af_bella af_nicole af_aoede af_kore af_sarah af_alloy af_nova
  am_fenrir am_michael am_puck
  bf_emma bf_isabella bm_fable bm_george
)

VERIFY_ONLY=0
if [ "${1:-}" = "--verify" ]; then
  VERIFY_ONLY=1
fi

# ── helpers ──────────────────────────────────────────────────────────────────

fetch() {
  # $1 = url, $2 = output path
  local url="$1" out="$2"
  if [ "$VERIFY_ONLY" -eq 1 ]; then
    if [ ! -s "$out" ]; then
      echo "  ✗ MISSING: $out"
      return 1
    fi
    echo "  ✓ exists:  $out ($(du -h "$out" | cut -f1))"
    return 0
  fi
  if [ -s "$out" ]; then
    echo "  ✓ already have: $out ($(du -h "$out" | cut -f1))"
    return 0
  fi
  mkdir -p "$(dirname "$out")"
  echo "  ⇣ fetching: $out"
  if ! curl -sLfo "$out" "$url"; then
    echo "  ✗ FAILED to download $url"
    rm -f "$out"
    return 1
  fi
  echo "    saved $(du -h "$out" | cut -f1)"
}

# ── pre-flight ──────────────────────────────────────────────────────────────

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required but not installed."
  exit 1
fi

if [ "$VERIFY_ONLY" -eq 1 ]; then
  echo "=== Verify-only mode (no downloads) ==="
else
  echo "=== Fetching Kokoro-82M-v1.0-ONNX (q4) into $OUT_DIR/ ==="
  echo "Source: $BASE"
fi
echo ""

# ── metadata files (~few KB each) ───────────────────────────────────────────

echo "Tokenizer + config..."
fetch "$BASE/config.json"            "$OUT_DIR/config.json"
fetch "$BASE/tokenizer.json"         "$OUT_DIR/tokenizer.json"
fetch "$BASE/tokenizer_config.json"  "$OUT_DIR/tokenizer_config.json"
echo ""

# ── model weights (~50 MB at q4) ────────────────────────────────────────────

# Use the q8-quantized variant (model_quantized.onnx, ~92 MB). transformers.js
# resolves dtype:'q8' to this filename. q4 was tested first and turned out to
# be larger (~290 MB) due to outlier-weight handling, plus over GitHub's
# 100 MB per-file limit.
echo "Model weights (q8 ~92 MB)..."
fetch "$BASE/onnx/model_quantized.onnx"   "$OUT_DIR/onnx/model_quantized.onnx"

# Clean up any stale q4 file from earlier runs (it's much larger than q8 and
# won't be loaded since MODEL_DTYPE is now 'q8').
if [ -f "$OUT_DIR/onnx/model_q4.onnx" ]; then
  echo "  ✗ removing stale q4 file (no longer used): $OUT_DIR/onnx/model_q4.onnx"
  rm -f "$OUT_DIR/onnx/model_q4.onnx"
fi
echo ""

# ── voice embeddings (~1 MB each, 15 total) ─────────────────────────────────

echo "Voice embeddings (15 files, ~1 MB each)..."
for v in "${VOICES[@]}"; do
  fetch "$BASE/voices/$v.bin"        "$OUT_DIR/voices/$v.bin"
done
echo ""

# ── summary ─────────────────────────────────────────────────────────────────

if [ "$VERIFY_ONLY" -eq 0 ]; then
  echo "=== Done ==="
  echo "Total size:"
  du -sh "$OUT_DIR"
  echo ""
  if [ -f "$OUT_DIR/onnx/model_quantized.onnx" ]; then
    SIZE_BYTES=$(stat -c%s "$OUT_DIR/onnx/model_quantized.onnx" 2>/dev/null || stat -f%z "$OUT_DIR/onnx/model_quantized.onnx")
    SIZE_MB=$((SIZE_BYTES / 1024 / 1024))
    echo "model_quantized.onnx is ${SIZE_MB} MB."
    if [ "$SIZE_MB" -gt 100 ]; then
      echo ""
      echo "WARNING: model_quantized.onnx exceeds GitHub's 100 MB per-file limit."
      echo "         Unexpected — this file is normally ~92 MB. Verify the download."
    else
      echo ""
      echo "✓ Under GitHub's 100 MB limit. Safe to commit directly to git."
    fi
  fi
fi
