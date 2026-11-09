# 🎯 TikTok Sandık Radarı PRO

Panel: **https://cehennemgibiyim.github.io/TikTok/**
Fırsatlar (sunucusuz av aracı): **https://cehennemgibiyim.github.io/TikTok/firsat/**

Sunucu, Docker, API anahtarı gerekmez. GitHub Pages üzerinde statik çalışır.

## Panel sekmeleri

| Sekme | Ne yapar |
|---|---|
| **Radar** | Dinlenecek yayıncı listesi, canlı olay akışı (sunucu bağlanırsa) |
| **Gelir** | Jeton → TikTok kesintisi → ajans komisyonu → yayıncı net kazancı, TL karşılığı ve pasta dağılımı |
| **AI** | Yayın metni/sohbet analizi (sağlayıcı anahtarı verilirse) |
| **Araçlar** | Yardımcı araçlar |
| **Hesaplar** | Hesap envanteri (kullanıcı adı, şifre, ajans, jeton), arama ve dışa aktarma. **Envanteri sıfırla** düğmesi cihazdaki tüm kayıtları temizler |
| **Ajanslar** | Ajans tanımı, komisyon, bağlı hesaplar ve liderlik tablosu |
| **Jeton Avı** | Yayınlardaki sandık/zarf/portal olayları, fırsatlar, ülke özeti, QR |

Panel verisi tarayıcıda (localStorage) tutulur; şifreler cihazdan dışarı çıkmaz.

## Fırsatlar sayfası (sunucusuz av)

`/firsat/` altındaki ayrı araç, sunucu olmadan çalışan jeton takibi:

- Yayıncı ekle (tek tek veya 500 satıra kadar **toplu**), tek eklemede TikTok oEmbed doğrulaması
- **Canlı** düğmesiyle gerçek süre sayacı, sütun başlığına tıklayarak sıralama
- **+ Sandık / + Zarf / + Portal**: jeton, gerçek süre ve kaç kişiye paylaşıldığı
- **Fırsatlar** sekmesi: jetona veya yaklaşan süreye göre sıralı, canlı geri sayım, QR, Topladım/Kaçtı
- Sandık süresi dolsa da bekler; zarf süresi dolunca jeton yayıncıya döner
- 7 gün canlı görülmeyen yayıncı otomatik düşer (Ayarlar'dan değiştirilir)
- JSON yedek / geri yükleme

Verisi IndexedDB'de tutulur.

## Arka plan tarayıcısı (gerçek süre + otomatik dinleme)

Tarayıcı sayfası TikTok canlı soketine bağlanamaz (imza + CORS). Bu yüzden dinleme işini
`scanner/` klasöründeki Node aracı yapar ve GitHub Actions'ta **3 saatte bir, ~2,5 saat boyunca** çalışır:

1. **Keşif** — `site/firsat/data/targets.json` havuzundaki her adresi TikTok'a sorar:
   canlı mı, yayın **ne zaman başladı**, başlık, izleyici sayısı.
2. **Dinleme** — canlı odalara bağlanır, jeton olaylarını (hediye, zarf) zamana damgalar.
3. **Yayın** — sonucu `site/firsat/data/live.json`'a yazar, commit eder; panel bu dosyayı
   30 saniyede bir okur.

Sonuç: yayıncı canlıysa panel kendiliğinden **Canlı · tarama** yazar, süreyi TikTok'un gerçek
başlangıç saatinden sayar (sen sıfırlamazsın) ve yayında paylaşılan jetonlar **(CANLI)** etiketiyle
Fırsatlar'a düşer.

### Havuzu doldurmak

Panelde **Tarama listesi indir** → inen `targets.json` dosyasını depoya
`site/firsat/data/targets.json` olarak yükle. Panelin listesi havuzun kaynağıdır.
**Havuzu içe al** ise tersini yapar: repodaki havuzu panele ekler.

### Yerelde dinleme

```bash
cd scanner && npm install
node index.js --minutes=120      # 2 saat tara + dinle
node index.js --once             # tek tur (deneme)
```

### Sınırlar

- TikTok serbest bir "tüm canlı yayınlar" dizini vermiyor; keşif senin havuzunla sınırlı.
- GitHub cron 3 saatte bir tur açar; iki tur arası ≈15 dakika boşluk olabilir. O arada başlayan
  yayın, bir sonraki turda (en geç 3 saat sonra) yakalanır; süresi yine gerçek başlangıçtan sayılır.
- GitHub'ın 6 saatlik iş sınırı nedeniyle tur 165 dakika tutulur.

## Yerelde çalıştırma

```bash
cd site
python3 -m http.server 8080
# http://localhost:8080  (panel)
# http://localhost:8080/firsat/  (av aracı)
```

## Yayınlama

`main` dalına push yeterli; `.github/workflows/pages.yml` paneli ve `/firsat/` sayfasını yayınlar.
