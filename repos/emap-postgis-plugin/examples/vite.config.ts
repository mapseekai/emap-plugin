import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  worker: { format: 'es' },
  server: { host: '127.0.0.1' },
  build: { rollupOptions: { input: {
    gateway: fileURLToPath(new URL('./index.html', import.meta.url)),
    connector: fileURLToPath(new URL('./connector.html', import.meta.url)),
  } } },
});
