import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// GitHub Pages: built into /docs with relative asset paths.
export default defineConfig({
  base: './',
  plugins: [
    preact(),
    viteStaticCopy({
      targets: [
        { src: 'node_modules/@ricky0123/vad-web/dist/{vad.worklet.bundle.min.js,silero_vad_v5.onnx}', dest: 'vad', rename: { stripBase: true } },
        { src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.{wasm,mjs}', dest: 'ort', rename: { stripBase: true } },
      ],
    }),
  ],
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    target: 'esnext',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      // kitten-tts-js (src/workers/tts.worker.ts, Kitten TTS engines) tries `import('onnxruntime-node')`
      // first and falls back to onnxruntime-web when that throws - it's a Node-only native addon that
      // can't be bundled for the browser, so leave the bare specifier as a real (always-failing) import()
      // at runtime instead of asking Rollup to resolve it.
      external: ['onnxruntime-node'],
    },
  },
  worker: { format: 'es' },
  optimizeDeps: {
    // vad-web is CJS and requires 'onnxruntime-web/wasm'; prebundle them together so dev works.
    // kitten-tts-js pulls in jszip (CJS/UMD) - it must go through esbuild's prebundle step too so
    // dev gets the same default-export interop the production build's bundler does; only
    // onnxruntime-node (Node-only native addon, never actually resolvable in a browser) is kept out.
    include: ['@ricky0123/vad-web', 'onnxruntime-web/wasm', 'kitten-tts-js'],
    exclude: ['@sqlite.org/sqlite-wasm', '@firecrawl/anydoc-wasm', '@huggingface/transformers', 'kokoro-js', 'onnxruntime-node'],
    rolldownOptions: { external: ['onnxruntime-node'] },
  },
  server: { port: 5173 },
});
