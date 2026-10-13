import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = `http://127.0.0.1:${process.env.WTS_PORT ?? 4317}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5317,
    proxy: {
      '/api': api,
      '/ws': { target: api.replace('http', 'ws'), ws: true },
    },
  },
});
