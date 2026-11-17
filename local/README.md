# TikTok Radar · Local Phase 1

Bu klasör, mevcut statik panelden bağımsız, tamamen yerel çalışan çekirdektir:

- PostgreSQL: olaylar
- Redis: yalnızca `radar:events` pub/sub kanalı (WebSocket fan-out); kalıcı veri tutmaz
- Node/Express API + `ws` WebSocket
- React/Vite paneli
- Scanner köprüsü: `site/firsat/data/boxes.json` içindeki yeni sandık/zarf olaylarını API'ye aktarır
- Manuel JSON olay ekleme, filtreler, canlı sayaç, LIVE açma düğmesi

Bu klasörde TikTok'a doğrudan bağlanan bir collector yoktur; mevcut scanner'ın `boxes.json` çıktısını tüketen bir köprü vardır. Doğrudan TikTok adaptörü Aşama 3'te eklenir; buradaki API, adaptörün yazacağı hedef sözleşmedir.

## Çalıştırma

```bash
cd local
cp .env.example .env   # isteğe bağlı; varsayılanlar yerel geliştirme içindir
docker compose up --build
```

Panel: http://localhost:5173
API: http://localhost:3001/api/health

Compose yalnızca loopback'e (`127.0.0.1`) port açar. İlk açılışta API, Postgres/Redis hazır olana kadar bekler; web ancak API sağlıklı olduğunda başlar.

`.env` içindeki `POSTGRES_PASSWORD` paylaşılan bir makinede değiştirilmelidir. API'de kimlik doğrulama yoktur; bu yığın yalnızca yerel kullanım içindir, dışarı açılmamalıdır.

## Geliştirme (Docker olmadan)

Postgres ve Redis'i Docker ile aç:

```bash
cd local
docker compose up -d db redis
```

API:

```bash
cd local/api
npm ci
DATABASE_URL=postgres://radar:radar@127.0.0.1:5432/radar \
REDIS_URL=redis://127.0.0.1:6379 \
npm start
```

Panel:

```bash
cd local/web
npm ci
npm run dev
```

Vite `/api` ve `/ws` isteklerini `127.0.0.1:3001`'e yönlendirir. API varsayılan olarak yalnızca `127.0.0.1` dinler; Docker içinde `HOST=0.0.0.0` kullanılır.

## Scanner köprüsü

`scanner/index.js`, canlı odalardan gelen kutuları `site/firsat/data/boxes.json` içine yazar. Yerel collector bu dosyayı izler ve yalnızca son 15 dakikadaki **yeni** kutuları API'ye gönderir.

Docker ile birlikte collector da otomatik çalışır; scanner verisi salt-okunur mount edilir, collector durumu `collector-state` volume'ünde tutulur. Konteyner, host scanner dizini `700`/`600` izinlerinde veya volume sahibi farklı olduğunda da okuyup yazabilsin diye root çalışır; port açmaz ve girdi mount'u salt-okunurdur. Daha sıkı izolasyon gerekiyorsa collector'ı hostta çalıştırın.

Host üzerinde ayrı çalıştırmak için:

```bash
cd local/collector
SCANNER_DATA_DIR=../../site/firsat/data \
RADAR_API_URL=http://127.0.0.1:3001 \
node index.js
```

Tek tur denemek için `node index.js --once` kullanılabilir. `SCANNER_DATA_DIR`, `BOX_FILE`, `STATE_FILE`, `POLL_MS` (varsayılan 5000), `MAX_AGE_MS` (varsayılan 900000) ve `BATCH_SIZE` (varsayılan 50, en fazla 200) ortam değişkenleriyle davranış ayarlanır. Varsayılan state dosyası hostta `local/collector/state.json`, Docker'da `/state/state.json`'dır.

State dosyası watermark ve en fazla 2000 görülen kutu kimliği tutar; iki saatten eski ve sınırı aşan kayıtlar budanır. API `400` yanıtında yalnızca kutu bazlı doğrulama hataları varsa batch görülmüş sayılır ve aynı geçersiz kutu tekrar denenmez. `event_rejected` (sunucu/DB hatası), `errors` içermeyen request-level `400` ve geçersiz yanıtlar state'i ilerletmez; sonraki turda yeniden denenir.

Eşleme: `kind=letter` → `bag`, `kind=chest` → `chest`; `shared` → `winner_count`; `unpackAt`, yoksa `availableAt`, yoksa `t` → `opens_at_ms`. Collector artık `source: "boxes"` gönderir; aynı kutu ntfy veya `/ingest` yolundan da gelirse API tek kayıtta birleştirir.

## Hızlı giriş ve ntfy SSE

Yerel API iki hızlı kaynak kabul eder; `boxes.json` collector'ı yedek yol olarak kalır.

### Anahtarlı `POST /ingest`

`INGEST_TOKEN` en az 16 karakter olmalıdır. Boşsa uç `503 ingest_disabled` döner.

```bash
curl -X POST http://127.0.0.1:3001/ingest \
  -H 'Content-Type: application/json' \
  -H 'x-ingest-key: <INGEST_TOKEN>' \
  -d '{"username":"ornek","businessType":20,"diamondCount":51,"envelopeId":"abc","secondsUntilOpen":60,"peopleCount":36}'
```

- `x-ingest-key` veya `Authorization: Bearer <token>` kabul edilir.
- Ham TikTok yakalaması (`envelopeInfo`/`businessType`) veya normalize kutu gövdesi kabul edilir.
- Portal bu API'de desteklenmez; `400` döner.
- Gövde en fazla 1 MB; tek istekte en fazla 50 olay.
- Aynı kutu daha önce geldiyse `duplicates` artar, yeni satır oluşmaz.

### ntfy SSE kaynağı

`NTFY_TOPIC` doluysa API `${NTFY_BASE_URL}/${NTFY_TOPIC}/sse` adresine bağlanır; `NTFY_KEY` doluysa yalnızca bu anahtarı taşıyan mesajları kabul eder. `NTFY_TOPIC` boşsa ntfy kapalıdır ve yalnızca `/ingest` + collector yolu çalışır.

`GET /api/events/stream` yerel istemciler için SSE'dir: bağlantıda `snapshot`, sonra `event`/`removed` olayları ve 15 saniyede bir keepalive gönderir.

### Dedupe

Üç kaynak aynı **kaynak kutu kimliğini** kullanır; collector'ın `scanner:` öneki normalize edilir. Kimlik varsa `box:<hash>` ID'si buradan üretilir; böylece:

- collector: `scanner:ornek-env-abc`
- ntfy: `ornek-env-abc`
- `/ingest`: ham yakalamadan `ornek-env-abc`

aynı satıra düşer. Kaynak kimliği yoksa `room_id | creator | kind | açılış (saniye) | total_coins | winner_count` içerik anahtarına düşülür.

Bu, değer güncellemelerini de tek kayıtta tutar: ntfy 0 jetonla gelip collector 210 jetonla gelirse satır bölünmez; `upsert` sıfır olmayan alanları korur. Farklı kimlikli iki kutu ise ayrı kalır.

`GET /api/health` içinde `ingest.enabled` ve `ntfy` sayaçları (`connected`, `messages`, `accepted`, `duplicates`, `rejected`, `lastError`) görünür.

## API sözleşmesi

### `GET /api/events`

Query: `kind=chest|bag`, `status=active|hung`, `minCoins`, `minRatio`, `minRemaining` (saniye), `q`, `limit` (en fazla 2000).

`status=hung`, veritabanında hâlâ `active` görünen ama açılış zamanı geçmiş sandıkları da kapsar.

Dönen:

```json
{ "type": "snapshot", "server_ms": 1794265258010, "events": [] }
```

### `POST /api/events`

Tek olay veya `{ "events": [...] }` / dizi kabul eder. En fazla 200 olay, gövde en fazla 1 MB.

```json
{
  "id": "chest:demo:1",
  "kind": "chest",
  "room_id": "7000000000000000001",
  "creator": "demo_creator",
  "total_coins": 240,
  "winner_count": 120,
  "participant_count": null,
  "viewer_count": 860,
  "opens_at_ms": 1794265318000,
  "chest_type": "gold",
  "chest_status": "active"
}
```

`kind` yalnızca `chest` veya `bag` olabilir; `chest_status` yalnızca `active` veya `hung`. Açılış zamanı geçmiş bir sandık otomatik olarak `hung` kaydedilir. Sunucu oranı `total_coins / winner_count` olarak hesaplar; `participant_count` ayrı bir alandır ve oranın paydası değildir.

`source` alanı `boxes`, `ntfy` veya `ingest` ise ID kaynak kutu kimliğinden (yoksa içerik anahtarından) üretilir; aynı kutu tekrar gelirse güncelleme yapılır ve `duplicates` sayılır. `source` yoksa (manuel ekleme) verilen `id` korunur. Yanıt artık `duplicates` alanını da içerir.

### `DELETE /api/events/:id`

Olayı siler ve WebSocket istemcilerine `removed` yayınlar.

### `GET /api/stats`

Toplam olay, aktif sandık, bekleyen sandık, zarf, yayıncı ve toplam jeton sayıları.

### `WS /ws`

Bağlantıda `snapshot` doğrudan Postgres'ten gelir; sonrasındaki `event` / `removed` mesajları Redis `radar:events` kanalından fan-out edilir. Her mesajda `server_ms` bulunur; panel saat farkını düzeltir.

Aynı Postgres ve Redis'e bağlı birden fazla API örneği çalıştırılabilir. HTTP yazımı önce yerel WebSocket istemcilerine, sonra Redis'e gider; Redis abonesi kendi kaynak kimliğini atladığı için aynı örnekte çift mesaj oluşmaz. Redis kısa süreliğine düşerse yazma yapan örnek kendi istemcilerini güncellemeye devam eder. Redis geri geldiğinde abonelik yeniden kurulur ve bağlı istemcilere güncel snapshot gönderilir.

WebSocket ve API, aynı kaynak dışından gelen tarayıcı isteklerini reddeder. `curl` ve collector gibi Origin göndermeyen istemciler etkilenmez.

## Testler

Postgres/Redis gerektirmeyen normalize, dedupe ve ntfy SSE testleri:

```bash
cd local/api
npm test
```

## Veri modeli notları

- `room_id` string tutulur; TikTok oda kimlikleri JavaScript sayı sınırını aşabilir.
- `expires_at_ms`: sayan sandık/zarf için `opens_at_ms`; bekleyen sandık için `opens_at_ms + 15 dk`.
- `ratio`: jeton / kazanan kontenjanı. Goody Bag'de de güncel API bu şekildedir; katılımcı sayısı ayrı gösterilir.
- Süresi geçmiş olaylar 15 dakika sonra temizlenir.
