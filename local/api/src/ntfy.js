/*
 * ntfy.sh SSE tüketicisi.
 *
 * EventSource Node 22'de yerleşik değil; fetch'in stream gövdesini SSE
 * bloklarına ayırıyoruz. Bağlantı koparsa geri çekilmeli olarak yeniden
 * bağlanır. Abort sinyali kapatma için kullanılır.
 */

export function parseSseBlock(block) {
  const data = String(block || '')
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal) signal.addEventListener('abort', finish, { once: true });
  });
}

export async function consumeNtfy({
  baseUrl = 'https://ntfy.sh',
  topic,
  key = '',
  signal,
  onEvent,
  onStatus,
  reconnectMs = 5000,
  fetchImpl = fetch
}) {
  const cleanBase = String(baseUrl || '').replace(/\/+$/, '');
  const url = cleanBase + '/' + encodeURIComponent(topic) + '/sse';
  let connected = false;

  function status(next) {
    if (typeof onStatus === 'function') onStatus(next);
  }

  while (!signal || !signal.aborted) {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'text/event-stream' },
        signal
      });
      if (!response.ok) throw new Error('ntfy HTTP ' + response.status);
      if (!response.body) throw new Error('ntfy SSE gövdesi yok');

      if (!connected) {
        connected = true;
        status({ connected: true, lastError: null, lastConnectedAt: Date.now() });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!signal || !signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const payload = parseSseBlock(block);
          if (!payload) continue;

          // ntfy yükü: {event:"message", message:"{...}"} veya doğrudan kutu.
          let box = payload;
          if (typeof payload.message === 'string') {
            try {
              box = JSON.parse(payload.message);
            } catch {
              status({ rejected: true, lastError: 'ntfy message JSON değil' });
              continue;
            }
          } else if (payload.message && typeof payload.message === 'object') {
            box = payload.message;
          }

          if (key && box.key !== key) {
            status({ rejected: true, lastError: 'ntfy anahtarı eşleşmedi' });
            continue;
          }

          try {
            await onEvent(box, payload);
          } catch (error) {
            status({ lastError: error.message });
          }
        }
      }
    } catch (error) {
      if (signal && signal.aborted) break;
      status({ connected: false, lastError: error.message, lastErrorAt: Date.now() });
    } finally {
      if (connected) {
        connected = false;
        status({ connected: false });
      }
    }

    if (signal && signal.aborted) break;
    await sleep(Math.max(500, Number(reconnectMs) || 5000), signal);
  }

  status({ connected: false });
}
