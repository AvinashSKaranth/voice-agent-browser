#!/bin/sh
# Builds phonon-2-c (https://github.com/eschmidbauer/phonon-2-c) to single-threaded WASM SIMD for browser.ts,
# and unpacks its weights into models/phonon-2-c/. Run from bench/asr: sh wasm/build.sh
set -e
[ -d .vendor/phonon-2-c ] || git clone --depth 1 https://github.com/eschmidbauer/phonon-2-c .vendor/phonon-2-c
if [ ! -f models/phonon-2-c/weights.bin ]; then
  mkdir -p models/phonon-2-c
  curl -L https://huggingface.co/eschmidbauer/phonon-2-c/resolve/main/phonon-2-c-weights-v1.tar.gz | tar xz -C models/phonon-2-c --strip-components=1
fi
S=.vendor/phonon-2-c/csrc
# No -pthread: GitHub Pages has no COOP/COEP; with one CPU the engine's pool starts no workers.
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W 2>/dev/null || pwd):/src" -w /src emscripten/emsdk:4.0.10 emcc -O3 -ffast-math -msimd128 -mrelaxed-simd -std=c11 -D_GNU_SOURCE \
  $S/blas.c $S/threadpool.c $S/tensor_ops.c $S/encoder.c $S/decoder.c $S/mel.c $S/weights.c $S/tokens.c $S/wav.c $S/resample.c $S/segment.c $S/engine.c $S/json.c wasm/p2w.c -I$S \
  -sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=web -sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB \
  -sEXPORTED_FUNCTIONS=_p2_engine_open_mem,_p2w_transcribe,_malloc,_free -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32,UTF8ToString \
  -o wasm/phonon2.mjs
ls -la wasm/phonon2.* models/phonon-2-c
