/**
 * plan.md: `src/server/index.ts` is "http (serves client build) + ws upgrade",
 * and REQUIREMENTS.md wants an invite link of the form `/?room=ID` to open the
 * app. These tests drive the http half over a real socket.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startGameServer, type GameServer } from '../src/server/index.ts';
import { TestClient } from './helpers/client.ts';

const INDEX_HTML = '<!doctype html><title>tic tac toe</title><div id="root"></div>';
const APP_JS = 'console.log("client bundle");';

/** A fake client build: index.html plus one hashed asset. */
async function staticDir(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'axon-static-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), INDEX_HTML);
  await mkdir(path.join(dir, 'assets'));
  await writeFile(path.join(dir, 'assets', 'app.js'), APP_JS);
  await writeFile(path.join(path.dirname(dir), 'outside-the-root.txt'), 'secret');
  return dir;
}

/**
 * Sends a path verbatim. `fetch` collapses `..` in the URL before the request
 * leaves the process, which would make a traversal test pass by accident.
 */
function rawGet(port: number, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: 'localhost', port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function serve(t: test.TestContext): Promise<GameServer> {
  const server = await startGameServer({ staticDir: await staticDir(t) });
  t.after(() => server.close());
  return server;
}

test('the client build is served at the root', async (t) => {
  const { port } = await serve(t);
  const response = await fetch(`http://localhost:${port}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(await response.text(), INDEX_HTML);
});

test('REQUIREMENT: an invite link with a room id opens the app', async (t) => {
  const { port } = await serve(t);
  const response = await fetch(`http://localhost:${port}/?room=ABC123`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), INDEX_HTML, 'the query string must not change what is served');
});

test('assets from the build are served with their own content', async (t) => {
  const { port } = await serve(t);
  const response = await fetch(`http://localhost:${port}/assets/app.js`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), APP_JS);
});

test('a path that escapes the static root cannot read a file', async (t) => {
  const { port } = await serve(t);
  for (const target of [
    '/../outside-the-root.txt',
    '/assets/../../outside-the-root.txt',
    '/%2e%2e/outside-the-root.txt',
    '/..%2foutside-the-root.txt',
  ]) {
    const { status, body } = await rawGet(port, target);
    assert.ok(!body.includes('secret'), `${target} leaked a file outside the root`);
    assert.ok(status === 200 || status >= 400, `unexpected status ${status} for ${target}`);
  }
});

test('a missing asset is a 404 rather than the index page', async (t) => {
  // AMBIGUOUS: plan.md only says the server "serves client build" and uses a
  // query-string invite link (/?room=ID), so nothing requires an SPA fallback
  // for unknown paths; a missing script answering 200 text/html is read here as
  // wrong.
  const { port } = await serve(t);
  const response = await fetch(`http://localhost:${port}/assets/nope.js`);
  assert.equal(response.status, 404);
  assert.notEqual(await response.text(), INDEX_HTML);
});

test('http and websockets share one port', async (t) => {
  const { port } = await serve(t);
  assert.equal((await fetch(`http://localhost:${port}/`)).status, 200);

  const client = await TestClient.connect(port);
  t.after(() => client.close());
  client.send({ type: 'join', roomId: 'HTTP-WS', playerId: 'p' });
  assert.equal((await client.next('joined')).state.roomId, 'HTTP-WS');
});
