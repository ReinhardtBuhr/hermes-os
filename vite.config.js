import { defineConfig } from 'vite';

// Hermes OS dedicated ports: UI 5210, backend 3210.
// (5173/3001 are used by the user's other project "Research Model",
// whose launcher kills whatever holds those ports.)
const BACKEND = `http://localhost:${process.env.HERMES_PORT || 3210}`;
const BACKEND_WS = BACKEND.replace('http', 'ws');

export default defineConfig({
  root: '.',
  server: {
    port: 5210,
    // Vite must NOT watch the backend or its SQLite database. The council
    // rewrites server/hermes.db on every brain call (hundreds/hour); with
    // the db in the watched root, chokidar thrashes the CPU and the /api +
    // /ws proxy below goes unresponsive — which freezes the browser tab
    // even though the backend is perfectly healthy. The frontend imports
    // nothing from server/, so there is no reason to watch it.
    watch: {
      ignored: [
        '**/server/**',
        '**/*.db', '**/*.db-wal', '**/*.db-shm', '**/*.sqlite*',
        '**/uploads/**', '**/dist/**',
      ],
    },
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: true,
      },
      '/ws': {
        target: BACKEND_WS,
        ws: true,
      },
      '/uploads': {
        target: BACKEND,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
