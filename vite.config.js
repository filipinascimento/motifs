import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  // The 0.10.9 npm bundle contains root-relative worker URLs. Building from
  // the published source lets Vite fingerprint and relocate those workers
  // correctly for this explorer's relative-base static deployment.
  resolve: {
    alias: {
      'helios-web': fileURLToPath(new URL('./node_modules/helios-web/src/index.js', import.meta.url)),
    },
  },
  // Do not publish source maps: they add substantial weight and expose the
  // readable application bundle without improving the public explorer.
  build: { sourcemap: false },
})
