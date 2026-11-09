# 🎯 TikTok Jeton Paneli — Sunucusuz

Tarayıcıda çalışan, **sunucu ve API anahtarı gerektirmeyen** jeton takip paneli.
Canlı: **https://cehennemgibiyim.github.io/TikTok/**

Tüm veri (yayınlar, sandık/zarf olayları, hesap envanteri, ajanslar, ayarlar) yalnızca
kullandığın cihazın tarayıcısında tutulur. Hiçbir ağ isteği yapılmaz, hiçbir yere
veri gönderilmez.

## Neden manuel giriş?

TikTok canlı yayın olayları tarayıcıdan okunamaz: TikTok'un canlı WebSocket'i imza
ister ve tarayıcıya CORS izni vermez. Bunu otomatik yapmanın tek yolu bir sunucu ya da
ücretli bir API anahtarıdır. Bu panel ikisini de kullanmaz; bu yüzden olayları
(sandık/zarf düştüğünde) **tek dokunuşla sen girersin**, panel gerisini yapar:

- gerçek süre sayacı (yayın süresi, sandık açılışı, zarf geçerliliği)
- fırsat listesi ve bekleyen jeton toplamı
- zarf süresi dolunca otomatik düşme, sandık süresi dolsa da kalma
- QR ile telefonundan yayına gitme
- envanter, ajans ve gelir hesapları
- JSON yedek / geri yükleme

## Sekmeler

| Sekme | Ne yapar |
|---|---|
| **Av** | Yayıncı ekle, süreyi başlat/durdur, + Sandık / + Zarf / + Portal ile jeton ve süre gir, fırsatları topla, QR aç |
| **Envanter** | Hesap listesi (kullanıcı adı, ajans, durum, jeton), CSV dışa/içe aktarma |
| **Ajanslar** | Ajans tanımı, komisyon, bağlı hesap ve jeton toplamları |
| **Gelir** | Jeton → TikTok kesintisi → ajans kesintisi → USD/TRY hesabı |
| **Ayarlar** | Zarf süresi, bildirim, JSON yedek, tüm veriyi silme |

## Akış

1. **Av** sekmesinde yayıncı adını (ör. `@kullanici` veya tam link) gir, ülkesini seç, **Yayın ekle**.
2. Yayın başlayınca satırdaki **Başlat** ile süreyi çalıştır.
3. Yayında sandık düştüğünde **+ Sandık**: jeton miktarı ve açılış süresini gir.
4. Zarf/mektup düştüğünde **+ Zarf**: jeton ve geçerlilik süresini gir.
5. **Fırsatlar** bölümünde geri sayımları gör; yetişince **Topladım**, kaçırınca **Kaçtı**.
6. Telefonla okutmak için **QR** düğmesi yayının canlı adresini gösterir.

### Tür kuralları

- **Sandık:** süresi dolsa bile listede bekler; jeton kaybolmaz.
- **Zarf / mektup:** süresi dolunca jeton yayıncıya döner ve listeden düşer (süre dolmadan 60 sn kala bildirim).
- **Portal:** sandık gibi davranır, ayrı etiketle gösterilir.
- Tür belirtilmemişse sandık kabul edilir.

## Veri ve yedek

- Depo: tarayıcının IndexedDB'si, yedek olarak localStorage.
- Tarayıcı verisi/site verisi silinirse kayıtlar gider → **Ayarlar → JSON yedek indir** ile düzenli yedek al.
- Yedek dosyası cihazlar arasında taşınabilir (**Yedekten yükle**).
- Hiçbir şifre saklanmaz; envanter yalnızca kullanıcı adı, ajans, durum ve jeton tutar.

## Yayınlama

GitHub Pages, `site/` klasörünü yayınlar:

```
site/index.html
site/app.js
site/store.js
site/styles.css
```

Değişiklikten sonra `main` dalına push yeterlidir; `.github/workflows/pages.yml` siteyi yayınlar.
Yerelde denemek için:

```bash
cd site
python3 -m http.server 8080
# http://localhost:8080
```

## Teknik notlar

- Vanilla JS, derleme adımı yok. Tailwind CDN, lucide ikonları ve qrcodejs CDN'den gelir.
- `store.js`: IndexedDB + localStorage + JSON içe/dışa aktarma.
- `app.js`: av mantığı, sayaçlar, fırsat kuralları, envanter, ajans, gelir, bildirim.
- Tarayıcı bildirimi ve bip sesi yalnızca zarf süresi dolmak üzereyken çalışır; izin vermezsen sessiz kalır.
