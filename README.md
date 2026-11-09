# 🎯 TikTok Sandık Radarı

TikTok canlı yayınlarındaki **sandık / zarf (mektup) / portal** jetonlarını çoklu
yayında izleyen, süreleri ve ülke dağılımını çıkaran panel.

## Nasıl çalışır

```
Tarayıcı (panel)  ──HTTPS/WSS──►  Node servisi  ──►  TikTok LIVE
      │                                │
      │                                └── data/store.json (kalıcı)
      └── QR kod ile telefonda yayına git
```

Tek Node süreci hem arayüzü hem REST API'yi hem WebSocket'i sunar; bu yüzden
panel ile arka uç **aynı origin** üzerinde çalışır.

## Özellikler

- **Çoklu yayın dinleme** — aynı anda 40 yayıncıya kadar
- **Tür ayrımı** — 📦 sandık, ✉️ zarf/mektup, 🌀 portal
- **Fırsatlar** — içeride 1 jeton bile beklemedeyse listelenir
  - sandık: süresi dolsa da listede kalır (kim tıklarsa alır)
  - zarf: süresi dolunca jeton yayıncıya döner, listeden düşer
- **Gerçek süreler** — açılma geri sayımı, zarfın son geçerlilik anı, dinleme süresi
- **QR kod** — `tiktok.com/@kullanici/live` adresini telefonda aç
- **Ülke özeti** — tüm ülkeler, sandık/zarf/jeton toplamları
- **Kalıcı depo** — hesaplar, ajanslar, hedefler ve jeton geçmişi sunucuda
- **Erişim anahtarı** — `PANEL_PASSWORD` ile API ve WebSocket korunur
- **CSV dışa aktarma**

## Çalıştırma

### Docker (önerilen)

```bash
cp .env.example .env      # PANEL_PASSWORD ve PANEL_ORIGINS
docker compose up -d --build
# http://SUNUCU_IP:3000
```

Alan adı varsa otomatik HTTPS:

```bash
DOMAIN=panel.ornek.com docker compose --profile https up -d
```

### Node ile

```bash
cd Tiktok
npm ci --omit=dev
PANEL_PASSWORD=anahtar node server.js
```

### GitHub Pages

Panel statik olarak `https://cehennemgibiyim.github.io/TikTok/` adresinde
yayınlanır (`.github/workflows/pages.yml`). Sayfa açılınca arka uç adresi ve
panel anahtarı sorulur; veriler oradaki sunucuda tutulur.

## Ortam değişkenleri

| Değişken | Açıklama |
|---|---|
| `PORT` | Sunucu portu (varsayılan 3000) |
| `PANEL_PASSWORD` | Panel anahtarı. Doluysa API ve WebSocket anahtar ister |
| `PANEL_ORIGINS` | API'ye erişebilecek origin listesi (virgülle) |
| `RADAR_MAX_TARGETS` | Aynı anda dinlenecek yayın sayısı (varsayılan 40) |
| `RADAR_LETTER_TTL` | Zarf/mektup jetonunun geçerlilik süresi, saniye (varsayılan 180) |
| `RADAR_ALLOW_SIMULATION` | `1` ise test için sahte jeton olayı üretilebilir |

## Veri

Tüm kalıcı veri `Tiktok/data/store.json` içinde; `data/` repoya **girmez**.
Hesap şifreleri düz metin tutulur — sunucuyu yalnızca güvendiğiniz yerde
çalıştırın ve `PANEL_PASSWORD` kullanın.

## API

| Uç | Açıklama |
|---|---|
| `GET /api/health` | Servis durumu (anahtarsız) |
| `GET /api/state` | Hesaplar, ajanslar, hedefler, oturumlar, olaylar, fırsatlar |
| `PUT /api/accounts` · `/api/agencies` · `/api/users` | Listeyi kaydet |
| `POST /api/hunt/targets` · `DELETE ?username=` | Yayın ekle / çıkar |
| `GET /api/hunt/pending` | Bekleyen jetonlar |
| `POST /api/hunt/collect` | Fırsatı "toplandı/kaçtı" işaretle |
| `DELETE /api/hunt/events` | Geçmişi temizle |

Anahtar gerektiğinde `x-panel-key` başlığı, WebSocket'te `?key=` parametresi kullanılır.

## Sınırlar

- TikTok'un resmî canlı olay API'si yok; veriler `tiktok-live-connector` ile okunur.
- "Tüm ülkelerdeki yayınları keşfetme" bir keşif kaynağı (TikAPI, tik.tools vb.)
  gerektirir; panel şu an elle eklenen ve QR ile eklenen yayıncıları izler.
- Zarf/sandık ayrımı gelen olayın alanlarına göre yapılır; TikTok tarafı tür
  bilgisini göndermezse olay sandık kabul edilir.
