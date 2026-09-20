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
  },
  worker: { format: 'es' },
  optimizeDeps: {
    // vad-web is CJS and requires 'onnxruntime-web/wasm'; prebundle them together so dev works.
    include: ['@ricky0123/vad-web', 'onnxruntime-web/wasm'],
    exclude: ['@sqlite.org/sqlite-wasm', '@firecrawl/anydoc-wasm', '@huggingface/transformers', 'kokoro-js'],
  },
  server: { port: 5173 },
});
