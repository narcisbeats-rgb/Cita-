import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMadridTieAvailability } from './src/icpplus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
let running = false;
let lastResult = null;

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') return json(res, 200, { ok: true, running, lastState: lastResult?.state || null });
  if (url.pathname === '/api/status') return json(res, 200, { running, lastResult });

  if (url.pathname === '/api/check/tie' && req.method === 'POST') {
    const expected = process.env.MONITOR_TEST_SECRET;
    if (expected && req.headers['x-monitor-secret'] !== expected) return json(res, 401, { error: 'unauthorized' });
    if (running) return json(res, 409, { error: 'check_already_running' });

    running = true;
    try {
      lastResult = await checkMadridTieAvailability({ safeMode: true });
      return json(res, 200, lastResult);
    } finally {
      running = false;
    }
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = await fs.readFile(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  return json(res, 404, { error: 'not_found' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`CitaNIE Madrid listening on :${port}`);
});
