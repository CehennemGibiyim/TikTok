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
| **Av** | Yayıncı ekle (tek tek veya 500 satıra kadar toplu), **Canlı** ile süreyi başlat/durdur, sütun başlığına tıklayarak sırala, + Sandık / + Zarf / + Portal ile jeton, süre ve paylaşım sayısını gir, QR aç |
| **Fırsatlar** | Yalnızca jeton paylaşan yayınlar; jetona veya yaklaşan süreye göre sırala, canlı geri sayım, Topladım / Kaçtı |
| **Envanter** | Hesap listesi (kullanıcı adı, ajans, durum, jeton), CSV dışa/içe aktarma |
| **Ajanslar** | Ajans tanımı, komisyon, bağlı hesap ve jeton toplamları |
| **Gelir** | Jeton → TikTok kesintisi → ajans kesintisi → USD/TRY hesabı |
| **Ayarlar** | Zarf süresi, 7 gün kuralı, bildirim, JSON yedek, tüm veriyi silme |

## Akış

1. **Av** sekmesinde yayıncı adını (ör. `@kullanici` veya tam link) gir, ülkesini seç, **Yayıncı ekle**. Tek eklemede hesap TikTok oEmbed ile doğrulanır; `@tiktok` gibi gerçek hesaplar için "✓ doğrulandı" yazar.
2. 200+ adresi tek seferde eklemek için **Toplu ekle**'yi aç, satır satır yapıştır (link veya `@ad`), ülke seç, **Hepsini ekle**.
3. Yayın başlayınca satırdaki **Canlı yap** ile süreyi çalıştır; durdurmak için tekrar bas.
4. Yayında sandık düştüğünde **+ Sandık**: jeton miktarı, açılış süresi ve kaç kişiye paylaşıldığını gir.
5. Zarf/mektup düştüğünde **+ Zarf**: jeton ve geçerlilik süresini gir.
6. **Fırsatlar** sekmesinde geri sayımları gör; yetişince **Topladım**, kaçırınca **Kaçtı**. Sıralamayı jeton / yaklaşan süre / yeni / yayıncı olarak değiştir.
7. Telefonla okutmak için **QR** düğmesi yayının canlı adresini gösterir.

### 7 gün kuralı

Bir yayıncı **Ayarlar**'daki gün sayısı (varsayılan 7) boyunca canlı görülmezse panel onu ve olaylarını listeden düşürür.
Her `+ Sandık`/`+ Zarf`/`+ Portal` girdisi ve Canlı düğmesi "son görülme" zamanını günceller.

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
