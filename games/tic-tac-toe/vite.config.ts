import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The game socket lives on a server, never on Vite. In dev that is either the
 * Node server (`npm run dev`) or `wrangler dev` (`npm run cf:dev`), so the
 * proxy target is a port rather than a hard-coded one.
 */
const SERVER_PORT = Number(process.env['PORT'] ?? 8787);

export default defineConfig({
  plugins: [react()],
  // Pages serves the built client from this folder of the blog, so every asset
  // URL has to be written relative to it rather than to the site root.
  base: '/games/tic-tac-toe/',
  build: {
    outDir: '../../public/games/tic-tac-toe',
    // The output lands outside this project, so Vite needs telling on purpose.
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // A regex key, because `base` puts the page (and so the socket) under
    // /games/tic-tac-toe/ while a bare `npm run dev` serves it from the root.
    proxy: { '^.*/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true } },
  },
});
