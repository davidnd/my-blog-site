import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import { remarkReadingTime } from "./src/lib/remark-reading-time.mjs";

// Dev-only: the Astro dev server does not resolve a directory request like
// /games/fish/ to that folder's index.html the way Cloudflare Pages does in
// production, so those trailing-slash URLs 404 locally. Rewrite them to the
// index.html so local dev matches prod. `apply: "serve"` keeps this out of the
// production build entirely.
function serveGameIndexInDev() {
  return {
    name: "serve-game-index-in-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url) {
          const q = req.url.indexOf("?");
          const path = q === -1 ? req.url : req.url.slice(0, q);
          const query = q === -1 ? "" : req.url.slice(q);
          if (path.startsWith("/games/") && path.endsWith("/") && path !== "/games/") {
            req.url = path + "index.html" + query;
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  site: "https://davidnd.dev",
  integrations: [mdx(), sitemap()],
  markdown: {
    processor: unified({ remarkPlugins: [remarkReadingTime] }),
  },
  vite: {
    plugins: [serveGameIndexInDev()],
  },
});
