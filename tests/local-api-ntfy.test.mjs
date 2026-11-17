import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { consumeNtfy } from '../local/api/src/ntfy.js';

test('ntfy SSE yalnızca doğru anahtarlı kutuyu tüketir', { timeout: 5000 }, async () => {
  const received = [];
  const statuses = [];
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/radar-test/sse');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache'
    });
    res.write(': connected\n\n');
    res.write('event: message\ndata: ' + JSON.stringify({
      event: 'message',
      message: JSON.stringify({ key: 'wrong', id: 'ignored' })
    }) + '\n\n');
    res.write('event: message\ndata: ' + JSON.stringify({
      event: 'message',
      message: JSON.stringify({
        key: 'test-key',
        id: 'u-env-1',
        kind: 'chest',
        roomId: 'r',
        username: 'u',
        coins: 100,
        shared: 10,
        unpackAt: 1_700_000_000_000
      })
    }) + '\n\n');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const controller = new AbortController();

  const consumer = consumeNtfy({
    baseUrl: 'http://127.0.0.1:' + port,
    topic: 'radar-test',
    key: 'test-key',
    signal: controller.signal,
    reconnectMs: 10000,
    onEvent: (box) => {
      received.push(box);
      setTimeout(() => controller.abort(), 10);
    },
    onStatus: (status) => statuses.push(status)
  });

  await Promise.race([
    consumer,
    new Promise((resolve) => setTimeout(resolve, 2000))
  ]);
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));

  assert.equal(received.length, 1);
  assert.equal(received[0].id, 'u-env-1');
  assert.ok(statuses.some((status) => status.connected === true));
  assert.ok(statuses.some((status) => status.rejected === true));
});
