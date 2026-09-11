/** Minimal static file serving for the built client. Dev goes through Vite instead. */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

async function fileAt(candidate: string): Promise<string | null> {
  try {
    const info = await stat(candidate);
    return info.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

export async function serveStatic(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requested = new URL(req.url ?? '/', 'http://localhost').pathname;
  const resolved = path.join(root, path.normalize(requested));

  // Refuse anything that escapes the root, whatever the URL claimed.
  const inRoot = resolved === root || resolved.startsWith(root + path.sep);
  const found = inRoot ? await fileAt(resolved) : null;
  // A route with no file extension falls back to index.html so client-side
  // routing works. A missing *asset* must 404 — answering HTML for a missing
  // script only turns it into a baffling MIME error in the browser.
  const fallback =
    inRoot && path.extname(resolved) === '' ? path.join(root, 'index.html') : null;
  const target = found ?? fallback;

  if (target === null || (await fileAt(target)) === null) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }

  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(target)] ?? 'application/octet-stream',
  });
  createReadStream(target).pipe(res);
}
