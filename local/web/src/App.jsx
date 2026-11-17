import { useEffect, useMemo, useRef, useState } from 'react';

const API = '/api';
const WS_URL = (() => {
  if (typeof window === 'undefined') return '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
})();
const HUNG_WINDOW_MS = 15 * 60 * 1000;
const NUMBER_FORMAT = new Intl.NumberFormat('tr-TR');
const TIME_FORMAT = new Intl.DateTimeFormat('tr-TR', {
  hour: '2-digit', minute: '2-digit', second: '2-digit'
});

function fmt(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return NUMBER_FORMAT.format(number);
}

function clock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function dateTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return TIME_FORMAT.format(new Date(ms));
}

function exampleEvents() {
  const now = Date.now();
  return [
    {
      id: `chest:demo:${now}`,
      kind: 'chest',
      room_id: '7000000000000000001',
      creator: 'demo_creator',
      total_coins: 240,
      winner_count: 120,
      participant_count: null,
      viewer_count: 860,
      opens_at_ms: now + 45000,
      chest_type: 'gold',
      chest_status: 'active',
      event_label: 'Gold Chest'
    },
    {
      id: `bag:demo:${now}`,
      kind: 'bag',
      room_id: '7000000000000000002',
      creator: 'demo_goody',
      total_coins: 90,
      winner_count: 30,
      participant_count: 45,
      viewer_count: 310,
      opens_at_ms: now + 90000,
      bag_level: 3,
      bag_method: 1,
      bag_comment: 'gel',
      event_label: 'Goody Bag'
    }
  ];
}

function derive(event, now) {
  if (event.kind === 'chest' && event.chest_status !== 'hung' &&
      Number(event.opens_at_ms) > 0 && now >= Number(event.opens_at_ms)) {
    const expires = Number(event.expires_at_ms) <= Number(event.opens_at_ms)
      ? Number(event.opens_at_ms) + HUNG_WINDOW_MS
      : Number(event.expires_at_ms);
    return { ...event, chest_status: 'hung', expires_at_ms: expires };
  }
  return event;
}

function matches(event, filters, now) {
  if (Number(event.expires_at_ms) > 0 && Number(event.expires_at_ms) < now - HUNG_WINDOW_MS) return false;
  if (filters.kind !== 'all' && event.kind !== filters.kind) return false;
  if (filters.minCoins && Number(event.total_coins) < Number(filters.minCoins)) return false;
  if (filters.minRatio && (event.ratio == null || Number(event.ratio) < Number(filters.minRatio))) return false;
  if (filters.minRemaining) {
    const remaining = Number(event.expires_at_ms) - now;
    if (!(remaining >= Number(filters.minRemaining) * 1000)) return false;
  }
  if (filters.q && !String(event.creator).toLowerCase().includes(filters.q.trim().toLowerCase())) return false;
  return true;
}

export default function App() {
  const [events, setEvents] = useState([]);
  const [filters, setFilters] = useState({
    kind: 'all', minCoins: '', minRatio: '', minRemaining: '', q: ''
  });
  const [connected, setConnected] = useState(false);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [stats, setStats] = useState(null);
  const [manual, setManual] = useState(() => JSON.stringify(exampleEvents(), null, 2));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const reconnectRef = useRef(null);
  const socketRef = useRef(null);
  const statsTimerRef = useRef(null);
  const wsHasSnapshotRef = useRef(false);

  function upsert(next) {
    setEvents((prev) => {
      const map = new Map(prev.map((event) => [event.id, event]));
      for (const event of next) map.set(event.id, event);
      return [...map.values()].sort((a, b) => (a.opens_at_ms || 0) - (b.opens_at_ms || 0));
    });
  }

  function remove(ids) {
    const set = new Set(ids);
    setEvents((prev) => prev.filter((event) => !set.has(event.id)));
  }

  async function loadEvents() {
    const response = await fetch(`${API}/events?limit=2000`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const serverMs = Number(data.server_ms);
    if (Number.isFinite(serverMs)) setOffset(serverMs - Date.now());
    // WebSocket snapshot'ı daha yeniyse geç gelen REST yanıtı onu ezmesin.
    if (!wsHasSnapshotRef.current) setEvents(Array.isArray(data.events) ? data.events : []);
    return data;
  }

  async function loadStats() {
    const response = await fetch(`${API}/stats`, { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    setStats(data.stats);
  }

  function scheduleStats() {
    clearTimeout(statsTimerRef.current);
    statsTimerRef.current = setTimeout(() => {
      loadStats().catch(() => {});
    }, 300);
  }

  // WebSocket bağlıyken tam liste yenilemeye gerek yok; snapshot ve deltalar
  // yeterli. Kopunca hem ilk yükleme hem periyodik yedek devreye girer.
  useEffect(() => {
    if (connected) return undefined;
    let cancelled = false;
    function refresh() {
      if (cancelled) return;
      loadEvents().catch((error) => {
        if (!cancelled) setMessage(error.message);
      });
      loadStats().catch(() => {});
    }
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connected]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + offset), 1000);
    return () => clearInterval(timer);
  }, [offset]);

  // Aktif/bekleyen sayaçları zamanla değişir; tam liste yenilemeden tazele.
  useEffect(() => {
    const timer = setInterval(() => loadStats().catch(() => {}), 15000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let closed = false;

    function connect() {
      if (closed) return;
      const socket = new WebSocket(WS_URL);
      socketRef.current = socket;
      socket.onopen = () => setConnected(true);
      socket.onclose = () => {
        setConnected(false);
        wsHasSnapshotRef.current = false;
        if (!closed) reconnectRef.current = setTimeout(connect, 2000);
      };
      socket.onerror = () => {
        setConnected(false);
        wsHasSnapshotRef.current = false;
        socket.close();
      };
      socket.onmessage = (raw) => {
        try {
          const data = JSON.parse(raw.data);
          if (Number.isFinite(Number(data.server_ms))) setOffset(Number(data.server_ms) - Date.now());
          if (data.type === 'snapshot') {
            wsHasSnapshotRef.current = true;
            setEvents(Array.isArray(data.events) ? data.events : []);
            loadStats().catch(() => {});
          } else if (data.type === 'event' && data.event) {
            upsert([data.event]);
            scheduleStats();
          } else if (data.type === 'removed') {
            remove(Array.isArray(data.ids) ? data.ids : []);
            scheduleStats();
          } else if (data.type === 'error') {
            setMessage(data.message || 'WebSocket snapshot alınamadı');
            socket.close();
          }
        } catch (error) {
          setMessage(error.message);
        }
      };
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(reconnectRef.current);
      if (socketRef.current) socketRef.current.close();
    };
  }, []);

  useEffect(() => () => clearTimeout(statsTimerRef.current), []);

  const filtered = useMemo(
    () => events
      .map((event) => derive(event, now))
      .filter((event) => matches(event, filters, now)),
    [events, filters, now]
  );

  async function importJson() {
    setBusy(true);
    setMessage('');
    try {
      const parsed = JSON.parse(manual);
      const response = await fetch(`${API}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed)
      });
      const data = await response.json();
      if (!response.ok && !data.saved) throw new Error(data.error || 'Olay eklenemedi');
      if (Array.isArray(data.saved) && data.saved.length) {
        upsert(data.saved);
        setMessage(`${data.saved.length} olay kaydedildi${data.errors && data.errors.length ? ` · ${data.errors.length} hata` : ''}`);
        scheduleStats();
      } else {
        setMessage(data.errors && data.errors[0] ? data.errors[0].error : 'Kayıt yok');
      }
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  function updateFilter(name, value) {
    setFilters((prev) => ({ ...prev, [name]: value }));
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">LOCAL PHASE 1</p>
          <h1>TikTok Radar</h1>
          <p className="muted">Sandık ve Goody Bag olaylarını kendi veritabanında tut, filtrele ve canlı izle.</p>
        </div>
        <div className={`connection ${connected ? 'ok' : 'bad'}`}>
          <span className="dot" />
          {connected ? 'WebSocket bağlı' : 'WebSocket kapalı'}
        </div>
      </header>

      <section className="stats">
        <div><span>Toplam olay</span><b>{fmt(stats?.total ?? events.length)}</b></div>
        <div><span>Aktif sandık</span><b>{fmt(stats?.active_chests ?? 0)}</b></div>
        <div><span>Bekleyen</span><b>{fmt(stats?.hung_chests ?? 0)}</b></div>
        <div><span>Zarf</span><b>{fmt(stats?.bags ?? 0)}</b></div>
        <div><span>Yayıncı</span><b>{fmt(stats?.creators ?? 0)}</b></div>
      </section>

      <section className="filters">
        <label>Olay
          <select value={filters.kind} onChange={(event) => updateFilter('kind', event.target.value)}>
            <option value="all">Tümü</option>
            <option value="chest">Sandık</option>
            <option value="bag">Zarf</option>
          </select>
        </label>
        <label>Min. jeton
          <input type="number" min="0" value={filters.minCoins}
            onChange={(event) => updateFilter('minCoins', event.target.value)} placeholder="0" />
        </label>
        <label>Min. oran
          <input type="number" min="0" step="0.1" value={filters.minRatio}
            onChange={(event) => updateFilter('minRatio', event.target.value)} placeholder="örn. 2" />
        </label>
        <label>Min. kalan sn
          <input type="number" min="0" value={filters.minRemaining}
            onChange={(event) => updateFilter('minRemaining', event.target.value)} placeholder="0" />
        </label>
        <label className="grow">Yayıncı ara
          <input value={filters.q} onChange={(event) => updateFilter('q', event.target.value)} placeholder="@creator" />
        </label>
        <button type="button" className="ghost" onClick={() => setFilters({ kind: 'all', minCoins: '', minRatio: '', minRemaining: '', q: '' })}>
          Temizle
        </button>
      </section>

      <main className="layout">
        <section className="list">
          <div className="list-head">
            <h2>Olaylar <small>{filtered.length}</small></h2>
            <span className="muted">{offset === 0 ? 'saat eşit' : `saat farkı ${offset > 0 ? '+' : ''}${Math.round(offset / 1000)} sn`} · sunucu saati düzeltmeli</span>
          </div>

          {filtered.length === 0 ? (
            <div className="empty">
              <b>Eşleşen olay yok.</b>
              <span>Manuel JSON ekle veya filtreleri gevşet.</span>
            </div>
          ) : (
            <div className="cards">
              {filtered.map((event) => {
                const remaining = Number(event.expires_at_ms) - now;
                const opening = Number(event.opens_at_ms) - now;
                const hung = event.chest_status === 'hung';
                return (
                  <article className={`card ${event.kind} ${hung ? 'hung' : ''}`} key={event.id}>
                    <div className="card-time">
                      <b>{hung ? `+${clock(now - Number(event.opens_at_ms))}` : clock(opening)}</b>
                      <small>{hung ? 'bekleyen' : 'açılışa'}</small>
                    </div>
                    <div className="card-body">
                      <div className="card-title">
                        <a href={`https://www.tiktok.com/@${encodeURIComponent(event.creator)}/live`} target="_blank" rel="noreferrer">
                          @{event.creator}
                        </a>
                        <span className={`badge ${event.kind}`}>{event.kind === 'chest' ? 'SANDIK' : 'ZARF'}</span>
                        {event.chest_type === 'gold' && <span className="badge gold">ALTIN</span>}
                        {hung && <span className="badge hung">BEKLEYEN</span>}
                      </div>
                      <div className="metrics">
                        <span>🪙 <b>{fmt(event.total_coins)}</b> jeton</span>
                        <span>📊 <b>{event.ratio == null ? '…' : Number(event.ratio).toFixed(2)}</b> oran</span>
                        <span>🎯 <b>{fmt(event.winner_count)}</b> kontenjan</span>
                        <span>🙋 <b>{event.participant_count == null ? '—' : fmt(event.participant_count)}</b> katılımcı</span>
                        <span>👥 <b>{event.viewer_count == null ? '—' : fmt(event.viewer_count)}</b> izleyici</span>
                        {event.bag_level !== null && event.bag_level !== undefined && <span>🏷️ LV <b>{event.bag_level}</b></span>}
                      </div>
                      <div className="card-meta">
                        <span>🕒 {dateTime(Number(event.opens_at_ms))}</span>
                        <span>⏳ kalan {clock(remaining)}</span>
                        {event.bag_comment && <span>💬 “{event.bag_comment}”</span>}
                      </div>
                    </div>
                    <div className="card-actions">
                      <a className="live" href={`https://www.tiktok.com/@${encodeURIComponent(event.creator)}/live`} target="_blank" rel="noreferrer">
                        LIVE AÇ
                      </a>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="manual">
          <h2>Manuel JSON</h2>
          <p className="muted">Aşama 1’de olaylar buradan veya <code>POST /api/events</code> ile eklenir. Aynı <code>id</code> güncelleme sayılır.</p>
          <textarea value={manual} onChange={(event) => setManual(event.target.value)} spellCheck="false" />
          <div className="manual-actions">
            <button type="button" onClick={importJson} disabled={busy}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</button>
            <button type="button" className="ghost" onClick={() => setManual(JSON.stringify(exampleEvents(), null, 2))}>Örnek</button>
          </div>
          {message && <p className="message">{message}</p>}
          <div className="api-note">
            <b>API</b>
            <code>GET /api/events</code>
            <code>POST /api/events</code>
            <code>GET /api/stats</code>
            <code>WS /ws</code>
          </div>
        </aside>
      </main>
    </div>
  );
}
