import { defineConfig } from 'vite';
export default defineConfig({
  worker: { format: 'es' },
  server: { host: '127.0.0.1' },
});
