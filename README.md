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
- [Windows uygulaması](#windows-uygulaması-kurulum--güncelleme)
- [Dosya düzeni](#dosya-düzeni)
- [Sürüm geçmişi](#sürüm-geçmişi)
- [Yeni sürüm çıkarma (kontrol listesi)](#yeni-sürüm-çıkarma-kontrol-listesi)
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

### Sandık / zarf / portal nasıl yakalanıyor

Dinleme, keşif ucunun (`api.tik.tools/api/live/top-channels`) verdiği **taze oda kimliğiyle** doğrudan
WebSocket açarak yapılır — TikTok'un oda kimliği arama ucu bulut IP'lerinde boş döndüğü için bu şart.

- Keşiften gelen kimlik 15 dakikadan tazeyse **doğrulama yapılmadan** bağlanılır (yayın zaten keşifte canlıydı).
- Kimlik yoksa/eskimişse canlı sayfası okunur; sayfa "yayın kapalı" diyorsa **bağlanılmaz** — böylece TikTok'un
  günlük bağlantı kotası (`rate_limit_account_day`) ölü odalara yanmaz.
- Bağlanılamayan oda ceza alır: 10 dk → 20 → 40 → 60 dk. Aynı ölü oda arka arkaya denenmez
  (panelde `backoffRooms` olarak görünür).
- Bağlanan odada `gift`, `envelope` ve `superFanBox` olayları dinlenir; gelen kutu jeton alanı boş gelse bile
  yazılır (panel "jeton bilinmiyor" der) ve türü `businessType` ile belirlenir.
- **Aday süzgeci (`--room-id-only=1`):** doğrulanamayan odaya yalnızca taze oda kimliği varsa bağlanılır.
  Keşif ucu yalnızca gerçekten yayında olan kanalları döndürdüğü için bu, boşa bağlantı ve kota harcamayı keser.
- **"Canlı" etiketi tazelik ister (`--live-stale-sec=900`):** api-live bulut IP'lerinde sürekli boş döndüğü için
  eski kayıtlar yayında sanılıyordu. Artık 15 dakikadır doğrulanmayan ve dinlenmeyen oda "canlı" sayılmaz;
  panel "○ Yayında değil" yazar. Panel tarafında da aynı 15 dakikalık kural uygulanır.
- **Kota koruması:** bir koşuda hız sınırı (`rateLimited`) 2'yi geçerse dakikalık başlatma yarıya iner,
  bağlantı aralığı iki katına çıkar (`scanner.tuningGuard` olarak panelde görünür).

**Hız:** Panel kutuları iki yoldan alır. `data/boxes.json` son 120 kutuyu tutar ve 45 saniyede bir
commit edilir; panel onu **15 saniyede bir** okur, yeni kutu gelince bildirim gösterir. `live.json`
5 dakikada bir commit edilir (yayıncı listesi, süreler, teşhis). Sandık penceresi kısa olduğu için
asıl yakalama bu hızlı dosyadan gelir.

Teşhis: `live.json → scanner.connectStats` (deneme/başarılı/hata/hız sınırı) ve `closeReasons`
(`süre doldu`, `bağlantı düştü`, `yayın bitti`, `bağlanamadı`).

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
| `--commit` | 0 | Veri commit aralığı, saniye (`0` = commit yok; Actions 300 kullanır) |
| `--commit-boxes` | 45 | Kutuların (`data/boxes.json`) commit aralığı: panel sandığı saniyeler içinde görsün |
| `--poll-batch` | 0 | Her turda yoklanacak havuz dilimi (`0` = hepsi); büyük havuzda taramayı hafifletir |
| `--once` | — | Tek tur çalış ve çık |
| `--discover-sec` | 300 | Keşif ucunun kaç saniyede bir yoklanacağı (her çağrı 10 canlı kanal + oda kimliği) |
| `--room-id-fresh-sec` | 900 | Oda kimliği bu yaştan sonra güvenilmez sayılır; bağlanmadan önce tazelenir |
| `--fail-backoff-sec` | 600 | Bağlanılamayan oda için ilk bekleme; her hatada ikiye katlanır (üst 60 dk) |
| `--probe-ratio` | 0.4 | Bütçenin ne kadarı hiç dinlenmemiş adaylara ayrılır |
| `--room-id-only` | 1 | Doğrulanamayan odaya yalnızca taze oda kimliği varsa bağlan |
| `--live-stale-sec` | 900 | Bu süredir doğrulanmayan oda "canlı" sayılmaz |
| `--starts-per-min` | 8 | Dakikada en fazla kaç yeni bağlantı başlatılır |
| `--hot-revisit-sec` | 720 | Kutu vermiş odaya en erken bu kadar sonra dönülür |

### Ayar karşılaştırması (kota birimi başına kutu)

`node scripts/quota-report.mjs` geçmiş `live.json` commit'lerini koşu bazında okur ve
"yakalanan kutu / 100 bağlantı denemesi" oranını ayar grubuna göre yazar.

13 Kasım 2026 ölçümü (8 koşu):

| Ayar | Koşu | Deneme | Başarı | Kutu | Kutu / 100 deneme | Ort. dinlenen oda |
|---|---|---|---|---|---|---|
| agresif (2 sn ara, 12/dk, oran 0.30) | 4 | 1418 | %16 | 134 | **9.45** | 10.3 |
| güvenli (4 sn ara, oran 0.15) | 4 | 3376 | %11 | 123 | 3.6 | ~11 |

Agresif ayar kota birimi başına **~2.6 kat** daha fazla kutu veriyor ve dinlenen oda sayısı
düşmüyor; bu yüzden korundu. Aşırıya kaçmayı `tuningGuard` engelliyor: hız sınırı 2'yi geçince
ayar koşu içinde kendiliğinden güvenli tarafa dönüyor.

### Çok odalı dinleme (chat reader sorusu)

`https://tiktok-chat-reader.zerody.one/` bizim kullandığımız kütüphanenin (**tiktok-live-connector**)
üstüne kurulmuş bir demo: tek soket = tek oda. Birden fazla oda dinlemek için **oda başına bir bağlantı**
açmak gerekir; bu tarayıcı da öyle yapıyor (bütçe 32 oda). Demo sunucusunun kendi sınırı var
(IP başına 10 bağlantı, dakikada 5 istek) ve README'si "çok bağlantı için kendi sunucunu kur" diyor.
O yüzden demo sunucusuna yüklenilmez; sınır bizim TikTok bağlantı kotamız ve keşif ucunun dakikada
verdiği 10 canlı kanaldır.

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

`site/firsat/data/boxes.json` — hızlı kutu kanalı (panel 15 sn'de bir okur):

```json
{
  "scannedAt": "2026-11-13T04:52:10.000Z",
  "runId": 1763000000000,
  "boxes": [{ "id": "ali-env-e12", "t": 1763000000000, "username": "ali", "kind": "chest",
    "coins": 120, "boxName": "Sandık", "businessType": 20, "shared": 25,
    "unpackAt": 1763000030000, "availableAt": 1763000180000, "hasWindow": true }]
}
```

`site/firsat/data/live.json` — tarayıcının çıktısı (5 dakikada bir):

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

## Windows uygulaması (kurulum + güncelleme)

`desktop/` altındaki Electron kabuğu paneli ve tarayıcıyı tek kurulumda toplar.

- **Kurulum:** GitHub **Releases** → `TikTok-Sandik-Radari-<sürüm>-x64.exe`. Kurulum imzasız olduğu için
  Windows SmartScreen "bilinmeyen yayıncı" uyarısı gösterebilir (Ek bilgi → Yine de çalıştır).
- **Tarama bu bilgisayarda:** uygulama açıkken tarayıcı sürekli çalışır, veriyi
  `%APPDATA%\TikTok Sandık Radarı\data` klasörüne yazar. GitHub Actions sırası ve paylaşılan IP sınırı yoktur.
- **Güncelleme:** **Ayarlar → Uygulama ve güncellemeler** kartı. "Güncellemeleri denetle" yeni sürümü
  indirir, uygulama kapanırken (veya "İndir ve kur" ile hemen) kurar. Açılışta denetim varsayılan olarak açıktır.
- **Yeni sürüm yayınlama:** adım adım kontrol listesi → [Yeni sürüm çıkarma](#yeni-sürüm-çıkarma-kontrol-listesi).
  Kısaca: iki yerde sürüm numarasını eşitle, `CHANGE_LOG`’a madde ekle, `main`’e push et, `vX.Y.Z` etiketi at;
  workflow kurulum paketini ve `latest.yml` dosyasını Releases’e yükler, kurulu uygulamalar oradan güncellenir.

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
desktop/                 Windows uygulaması (Electron + NSIS kurulum + otomatik güncelleme)
.github/workflows/       pages.yml (yayın), scan.yml (tarama turu), release.yml (kurulum paketi)
```

## Sürüm geçmişi

Panel sürümü `site/firsat/store.js` içindeki `APP_VERSION` değeridir; Ayarlar → Panel sürümü kartında
ve dışa aktarılan yedek dosyasında (`appVersion`) görünür.

| Sürüm | Tarih | Öne çıkanlar |
|---|---|---|
| **1.0.0** | 2026-11-12 | Süper fan kutusu (jeton alanı boş) ve mükerrer kutu kaydı düzeltildi; zarf/portal 15 dk “KONTROL ET” olarak kalıyor. Ülke tablosu keşfi (tik.tools anahtarı) ve günde bir otomatik ülke taraması + raporu. Av listesinde ülke rozeti filtresi, arama ve sıralama kalıcı; havuz 6000 adres. Görünüm tercihleri yedeğe dahil, yedek biçim sürümü ve uyumsuz yedek reddi. |
| **0.9.0** | 2026-11-11 | Sandık süresi dolsa da beklemede kalıyor, eski “kaçtı” kayıtları geri alınıyor. TikTok günlük bağlantı sınırında 3 saat bekleme ve panelde sebep gösterimi. |
| **0.8.0** | 2026-11-11 | Windows kurulum paketi (Electron + NSIS), GitHub Releases üzerinden otomatik güncelleme, Ayarlar’da uygulama/güncelleme ve yerel tarayıcı kartı. |

## Yeni sürüm çıkarma (kontrol listesi)

**Tek komut (önerilen):**

```bash
node scripts/release.mjs 1.0.1 "Kısa madde" "İkinci madde"        # sürümü yaz, kontrol et, commit + etiket
node scripts/release.mjs 1.0.1 "Kısa madde" --push               # dalı ve etiketi de gönder
node scripts/release.mjs 1.0.1 "Kısa madde" --push --watch       # + Windows paketinin bitmesini bekle
node scripts/release.mjs 1.0.1 "Kısa madde" --dry-run            # hiçbir şeyi değiştirmeden göster
node scripts/release.mjs 1.0.1 --bump-backup "Yedek biçimi değişti" --push
node scripts/release.mjs --notes 1.0.1                          # sadece GitHub sürüm notlarını CHANGE_LOG'dan yaz
node scripts/release.mjs --check                                # sürüm öncesi: değişiklikleri tara, madde öner
```

Betik sırasıyla: sürümü **iki yerde eşitler** (`desktop/package.json` + `store.js` `APP_VERSION`),
`CHANGE_LOG` listesinin başına bugünün tarihiyle madde ekler, `node --check` + tarayıcı selftest
(ağa çıkmaz) çalıştırır, commit’ler ve `vX.Y.Z` etiketini atar; `--push` verilirse dalı ve etiketi gönderir.
Sürüm düşükse, çalışma ağacı kirliyse, etiket zaten varsa ya da kontroller geçmezse hiçbir şeyi commit’lemez.

| Bayrak | Ne yapar |
|---|---|
| `--dry-run` | Dosyaya yazmaz, commit/etiket oluşturmaz; yapılacak değişiklikleri gösterir |
| `--push` | Dalı ve etiketi **tek atomik push** ile gönderir; ikisinden biri reddedilirse ikisi de gitmez. Etiket zaten uzaktaysa yeniden göndermez (yinelenen sürüm oluşmaz) |
| `--watch` | Push’tan sonra “🖥️ Windows Kurulum Paketi” çalışmasını izler; bitince `.exe` + `latest.yml` dosyalarını ve sürüm bağlantısını yazar (başarısızsa günlük bağlantısıyla çıkar). `GITHUB_TOKEN`/`GH_TOKEN` varsa **GitHub sürüm notlarını CHANGE_LOG maddeleriyle doldurur** |
| `--watch-timeout=1200` | İzleme üst sınırı, saniye (varsayılan 20 dk) |
| `--bump-backup` | `BACKUP_VERSION` değerini 1 artırır (yedek biçimi değiştiyse) |
| `--allow-dirty` | Çalışma ağacı temiz değilken de çalışır |
| `--item="Madde"` | Değişiklik maddesini argüman yerine bayrakla verir |
| `--check` | Hiçbir şeyi değiştirmeden son etiketten (yoksa ilk commit’ten) bu yana değişen dosyaları alanlara göre gruplar, commit başlıklarını CHANGE_LOG maddesi olarak önerir ve hazır `release.mjs` komutunu yazdırır |
| `--notes [X.Y.Z]` | Sürüm artırmadan/commit etmeden, `CHANGE_LOG`'daki o sürümün maddeleriyle GitHub sürüm notlarını yazar (sürüm verilmezse panel sürümü). `GITHUB_TOKEN`/`GH_TOKEN` gerekir |

> Not: bir sürümü yalnızca **bir** yol tetiklemeli. Etiket göndermek (`git push origin vX.Y.Z`) ya da GitHub’da
> etiket oluşturmak workflow’u zaten başlatır; aynı sürüm için ayrıca “Run workflow”a basmak **yinelenen**
> GitHub sürümü oluşturur (biri silinmeli).

**Yayından sonra kontrol:**

1. **Panel:** `main` push edilince Pages yayınlar (`pages.yml`); Ayarlar → Panel sürümü yeni numarayı göstermeli.
2. **Kurulum paketi:** Actions → 🖥️ Windows Kurulum Paketi yeşil mi, Releases’te `.exe` + `latest.yml` var mı.
3. **Güncelleme:** Kurulu uygulamada Ayarlar → Uygulama ve güncellemeler → “Güncellemeleri denetle”;
   yeni sürüm inince “İndir ve kur” ile kurulur (veya uygulama kapanırken otomatik).

`--watch` bu üç adımın ilkini kendisi yapar; tek başına da çalışır:

```bash
node scripts/watch-release.mjs --repo CehennemGibiyim/TikTok --tag v1.1.0
node scripts/watch-release.mjs --repo CehennemGibiyim/TikTok --tag v1.1.0 --sha <commit> --timeout 600
node scripts/watch-release.mjs --repo CehennemGibiyim/TikTok --tag v1.1.0 --notes-file surum-notlari.md
```

GitHub API anahtarsız saatte 60 istekle sınırlı; uzun beklemelerde `GITHUB_TOKEN` (ya da `GH_TOKEN`)
ortam değişkeni ver — sınır dolduğunda betik sıfırlanma saatini söyleyip durur.

Adımları elle yapmak istersen sırası: sürümü iki yerde eşitle → `CHANGE_LOG`’a madde ekle →
(yedek biçimi değiştiyse `BACKUP_VERSION` artır) → `node --check` + `SCANNER_SELFTEST=1 node scanner/index.js` →
commit → `git tag vX.Y.Z` → `git push && git push origin vX.Y.Z`.

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
