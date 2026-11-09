import { defineConfig } from "astro/config";
import { existsSync, readdirSync } from "node:fs";
import { unified } from "@astrojs/markdown-remark";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import { remarkReadingTime } from "./src/lib/remark-reading-time.mjs";

// Dev-only: the Astro dev server does not resolve a directory request like
// /games/fish/ or /products/tock/ to that folder's index.html the way Cloudflare Pages does in
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
          const section = ["/games/", "/products/"].find((s) => path.startsWith(s));
          if (section && path.endsWith("/") && path !== section) {
            req.url = path + "index.html" + query;
          }
        }
        next();
      });
    },
  };
}

// Pages that are plain HTML in public/ (product landing pages and games) are
// invisible to the sitemap integration, which only sees Astro routes. List
// every public/<section>/<slug>/index.html so search engines find them.
const staticPages = ["products", "games"].flatMap((section) => {
  const dir = new URL(`./public/${section}/`, import.meta.url);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(new URL(`${d.name}/index.html`, dir)))
    .map((d) => `https://davidnd.dev/${section}/${d.name}/`);
});

export default defineConfig({
  site: "https://davidnd.dev",
  integrations: [mdx(), sitemap({ customPages: staticPages })],
  markdown: {
    processor: unified({ remarkPlugins: [remarkReadingTime] }),
  },
  vite: {
    plugins: [serveGameIndexInDev()],
  },
});
