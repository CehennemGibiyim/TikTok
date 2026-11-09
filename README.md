# 🎯 TikTok Sandık Radarı PRO

| Ne | Adres |
|---|---|
| Panel | https://cehennemgibiyim.github.io/TikTok/ |
| Fırsatlar (av aracı) | https://cehennemgibiyim.github.io/TikTok/firsat/ |

Sunucu, Docker, API anahtarı gerekmez: her şey GitHub Pages üzerinde statik çalışır, veri tarayıcıda
(IndexedDB / localStorage) durur. Canlı dinleme işini tarayıcı yapamadığı için (TikTok imza + CORS)
`scanner/` altındaki Node aracı GitHub Actions'ta çalışır ve sonucu depoya yazar.

## İçindekiler

- [Panel sekmeleri](#panel-sekmeleri)
- [Fırsatlar sayfası](#fırsatlar-sayfası)
- [Arka plan tarayıcısı](#arka-plan-tarayıcısı-gerçek-süre--otomatik-dinleme)
- [Veri dosyaları](#veri-dosyaları)
- [Yerelde çalıştırma](#yerelde-çalıştırma)
- [Dosya düzeni](#dosya-düzeni)
- [Sık sorunlar](#sık-sorunlar)

## Panel sekmeleri

| Sekme | Ne yapar |
|---|---|
| **Radar** | Dinlenecek yayıncı listesi, canlı olay akışı (sunucu bağlanırsa) |
| **Gelir** | Jeton → TikTok kesintisi → ajans komisyonu → yayıncı net kazancı, TL karşılığı ve pasta dağılımı |
| **AI** | Yayın metni/sohbet analizi (sağlayıcı anahtarı verilirse) |
| **Araçlar** | Yardımcı araçlar |
| **Hesaplar** | Hesap envanteri (kullanıcı adı, şifre, ajans, jeton), arama, dışa aktarma. **Envanteri sıfırla** cihazdaki tüm kayıtları temizler |
| **Ajanslar** | Ajans tanımı, komisyon, bağlı hesaplar ve liderlik tablosu |
| **Jeton Avı** | Yayınlardaki sandık/zarf/portal olayları, fırsatlar, ülke özeti, QR |

## Fırsatlar sayfası

`/firsat/` altındaki araç, sunucu olmadan çalışan jeton takibi:

- Yayıncı ekle (tek tek veya 500 satıra kadar **toplu**), tek eklemede TikTok oEmbed doğrulaması
- **Canlı** düğmesiyle gerçek süre sayacı, sütun başlığına tıklayarak sıralama
- **+ Sandık / + Zarf / + Portal**: jeton, gerçek süre ve kaç kişiye paylaşıldığı
- **Fırsatlar** sekmesi: jetona veya yaklaşan süreye göre sıralı, canlı geri sayım, QR, Topladım / Kaçtı
- Sandık süresi dolsa da bekler; zarf süresi dolunca jeton yayıncıya döner
- 7 gün canlı görülmeyen yayıncı otomatik düşer (Ayarlar'dan değiştirilir)
- JSON yedek / geri yükleme, tarama havuzunu indirme ve içe alma

## Arka plan tarayıcısı (gerçek süre + otomatik dinleme)

`scanner/` altındaki Node aracı GitHub Actions'ta **3 saatte bir, ~2,5 saat boyunca** çalışır:

1. **Keşif** — `site/firsat/data/targets.json` havuzundaki her adresi TikTok'a sorar:
   canlı mı, yayın **ne zaman başladı** (`liveRoom.startTime`), başlık, izleyici sayısı.
2. **Dinleme** — canlı odalara WebSocket ile bağlanır, jeton olaylarını (hediye, zarf) zamana damgalar.
3. **Yayın** — sonucu `site/firsat/data/live.json`'a yazar, 10 dakikada bir commit eder;
   Pages yayınlar, panel dosyayı 30 saniyede bir okur.

Yayıncı canlıysa panel kendiliğinden **Canlı · tarama** yazar, süreyi sen sıfırlamadan TikTok'un gerçek
başlangıç saatinden sayar ve yayında paylaşılan jetonlar **(CANLI)** etiketiyle Fırsatlar'a düşer.

### Havuzu doldurmak

Panelde **Tarama listesi indir** → inen `targets.json` dosyasını depoya `site/firsat/data/targets.json`
olarak yükle. Panelin listesi havuzun kaynağıdır; **Havuzu içe al** tersini yapar (repodaki havuzu panele ekler).

### Yerelde dinleme

```bash
cd scanner && npm install
node index.js --minutes=120      # 2 saat tara + dinle
node index.js --once             # tek tur (deneme)
```

| Argüman | Varsayılan | Ne yapar |
|---|---|---|
| `--minutes` | 0 | Turun toplam süresi (`0` = süresiz) |
| `--poll` | 60 | Havuzun kaç saniyede bir yoklanacağı |
| `--max-rooms` | 15 | Aynı anda dinlenecek oda sayısı |
| `--concurrency` | 4 | Aynı anda sorgulanacak adres sayısı |
| `--min-coins` | 1 | Bu jeton değerinin altındaki olaylar yazılmaz |
| `--commit` | 0 | Veri commit aralığı, saniye (`0` = commit yok; Actions 600 kullanır) |
| `--once` | — | Tek tur çalış ve çık |

### Sınırlar

- TikTok serbest bir "tüm canlı yayınlar" dizini vermiyor (anonim arama `2483` ile giriş istiyor, canlı akış
  imza istiyor); keşif senin havuzunla sınırlı.
- GitHub cron 3 saatte bir tur açar; iki tur arası ≈15 dakika boşluk olabilir. O arada başlayan yayın bir
  sonraki turda yakalanır, süresi yine gerçek başlangıçtan sayılır.
- GitHub'ın 6 saatlik iş sınırı nedeniyle tur 165 dakika tutulur.

## Veri dosyaları

`site/firsat/data/targets.json` — tarama havuzu:

```json
{ "updatedAt": "2026-11-09T17:00:00.000Z", "targets": ["kullanici1", "kullanici2"] }
```

`site/firsat/data/live.json` — tarayıcının çıktısı:

```json
{
  "scannedAt": "2026-11-09T17:42:51.179Z",
  "scanner": { "targetCount": 12, "liveCount": 1, "watching": 1, "polls": 3, "minutesLeft": 160, "lastError": null, "version": 1 },
  "streamers": [{
    "username": "ornek", "country": "TR", "live": true, "startTime": 1762700000,
    "title": "Akşam yayını", "viewers": 812, "coins": 350, "gifts": 4,
    "lastGiftAt": 1762701500, "lastGiftName": "Rose", "lastSeenLiveAt": 1762701800,
    "checkedAt": 1762701810
  }],
  "events": [{
    "id": "ornek-1762701500-a1b2c", "t": 1762701500123, "username": "ornek",
    "kind": "chest", "coins": 100, "giftName": "Rose", "sender": "izleyici", "source": "scan"
  }]
}
```

`startTime` saniye cinsinden Unix saatidir; panel bunu `startedAt` olarak kullanır, süre gerçek
başlangıçtan işler. `t` milisaniyedir. `kind` değerleri: `chest` (hediye), `letter` (zarf), `portal`.

## Yerelde çalıştırma

```bash
cd site
python3 -m http.server 8080
# http://localhost:8080        panel
# http://localhost:8080/firsat/ av aracı
```

## Dosya düzeni

```
site/                    panel (GitHub Pages kökü)
  index.html main.js     Radar / Gelir / Hesaplar / Ajanslar / Jeton Avı
  hunt.js                Jeton Avı sekmesi ve sandık-zarf-portal mantığı
  store-client.js        IndexedDB + localStorage köprüsü
  web-shim.js            Electron için yazılmış main.js'i tarayıcıda çalıştıran katman
  config.js              İsteğe bağlı arka uç adresi (boş = sunucusuz)
  firsat/                Fırsatlar sayfası ve tarama verisi
    data/targets.json    tarama havuzu
    data/live.json       tarayıcı çıktısı (otomatik commit edilir)
scanner/                 Node tarayıcı (TikTok canlı dinleme)
.github/workflows/       pages.yml (yayın), scan.yml (3 saatlik tarama turu)
```

## Sık sorunlar

| Belirti | Sebep / çözüm |
|---|---|
| Panelde "Tarama: … · 0 canlı" | Havuzdaki hesaplar o an yayında değil; havuzu doldur veya farklı saatte bak |
| Süre 00:00'da kalıyor | Satır tarayıcıdan değil elle eklendi; yayıncı canlı değilse süre başlamaz |
| Fırsatlar'da CANLI kart yok | Tur arası boşluk olabilir (≈15 dk) ya da o odada henüz jeton paylaşılmadı |
| Yeni yayıncı kendiliğinden gelmiyor | Keşif havuzla sınırlı; adresi `targets.json`'a ekle |
| Actions taraması uzun sürüyor | Normal: tur 165 dakika açık kalır, veri 10 dakikada bir commit edilir |

## Yayınlama

`main` dalına push yeterli; `.github/workflows/pages.yml` paneli ve `/firsat/` sayfasını yayınlar.
Tarama turunu elle başlatmak için: **Actions → 📡 Canlı Tarayıcı → Run workflow**.
