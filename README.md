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

## Neden otomatik tarama yok?

TikTok canlı soketi imza ister ve tarayıcıya CORS izni vermez; ücretsiz aynalar (tikwm vb.)
Cloudflare ile kapatılmış, oEmbed yalnızca profil doğrulaması veriyor. Bu yüzden canlı olayı
panel kendisi okuyamaz; olayları tek dokunuşla sen işaretlersin, panel süre ve toplamları yönetir.

## Yerelde çalıştırma

```bash
cd site
python3 -m http.server 8080
# http://localhost:8080  (panel)
# http://localhost:8080/firsat/  (av aracı)
```

## Yayınlama

`main` dalına push yeterli; `.github/workflows/pages.yml` paneli ve `/firsat/` sayfasını yayınlar.
