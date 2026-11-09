# PROMPT — 3 Modül: Keşif · Sessiz Dinleme · Sıralama

Aşağıdaki metni olduğu gibi bir yapay zekâ ajanına / geliştiriciye verebilirsin. Projenin kendi
yapısına (panel + `scanner/` + GitHub Actions + `site/firsat/data/*.json`) göre yazıldı.

---

## ROL

Sen, TikTok canlı yayın ekosisteminde çalışan bir **fırsat avcısı otomasyonu** geliştiricisisin.
Elindeki proje: `site/` altında statik panel (GitHub Pages), `site/firsat/` altında Fırsatlar
sayfası, `scanner/` altında Node tabanlı canlı dinleyici, `.github/workflows/scan.yml` ile 3 saatte
bir çalışan tarama turu.

Görevin: aşağıdaki **3 modülü** uçtan uca, birbirine bağlı ve **hiçbir manuel adım gerektirmeden**
çalıştırmak. Kullanıcıdan liste, dosya yükleme, "şu adresi gir" gibi işler istemeyeceksin; sistem
kendi kendine bulacak, kendi kendine dinleyecek, kendi kendine sıralayacak.

## DEĞİŞMEZ KURALLAR

1. **Yalan veri yok.** Canlı olmadığı doğrulanmamış bir yayıncı panelde "Canlı" görünmeyecek. Süre
   yalnızca TikTok'un gerçek başlangıç saatinden (`startTime`) hesaplanacak; elle sıfırlama, tahmini
   süre, uydurma jeton olmayacak.
2. **Manuel iş yok.** Havuz kendiliğinden dolacak; kullanıcı yalnızca filtre/eşik ayarlarını
   değiştirebilecek.
3. **Tek doğru kaynak tarama.** Panel (`site/firsat/app.js`) canlılık, süre, jeton ve olay bilgisini
   yalnızca `site/firsat/data/live.json`'dan alacak; tarama "canlı değil" dediyse satır kapanacak.
4. **Sessizlik.** Dinleme hiçbir yayına görünür katılım, yorum, beğeni, takip üretmeyecek; sadece
   okuma amaçlı WebSocket bağlantısı kurulacak.
5. **Hız.** Yeni açılan bir yayın en geç 60 saniye içinde sistemde görünmeli.
6. **Dayanıklılık.** Ağ hatası, oda kapanması, imza hatası turu düşürmeyecek; hata kaydı
   `scanner.lastError` alanına yazılacak, tur devam edecek.
7. **Maliyet/limit.** GitHub Actions iş limiti 6 saat; tur en fazla 165 dakika sürecek, veri 10
   dakikada bir commit edilecek, iki tur arası boşlukta son bilinen durum korunacak.

---

## MODÜL 1 — Küresel Canlı Yayın Keşfi

**Amaç:** Dünyadaki aktif canlı yayınları ve yeni açılan yayınları kendiliğinden bulup havuza eklemek.

**Gereksinimler**
- Keşif kaynakları sırayla denenecek, ilk çalışan kaynak kullanılacak:
  1. **Oturumlu canlı akış** — ortam değişkeninde (`TIKTOK_SESSIONID`) geçerli oturum varsa TikTok'un
     imzalı canlı akışı / canlı araması bu oturumla çağrılacak. Oturum yoksa bu adım sessizce atlanacak,
     kullanıcıya "cookie ver" denmeyecek; panelde tek satır durum notu görünecek.
  2. **Ülke bazlı canlı arama** — `region` filtresiyle (TR, US, DE, … veya "tümü") canlı odalar.
  3. **Doğrulanmış tohum havuz** — daha önce görülen yayıncılar + canlı yayında görülenler; her turda
     yeniden yoklanacak ve yeni canlılar havuza kalıcı eklenecek.
- Her yeni aday için TikTok'a "bu kullanıcı gerçek mi" sorgusu yapılacak; `user_not_found` dönen ad
  havuza **alınmayacak** (yanlış adresler listeyi kirletmeyecek).
- Havuz üst sınırı ayarlanabilir olacak (varsayılan 500). Süresi dolan/silinmiş hesaplar otomatik
  düşecek; 7 gündür canlı görülmeyen hesap pasife alınacak.
- Havuz `site/firsat/data/targets.json`'a yazılacak; panel bu dosyayı **okuyacak**, yazmayacak.

**Çıktı**
```json
{ "updatedAt": "ISO", "source": "feed|search|seed",
  "targets": [{ "username": "ornek", "country": "TR", "addedAt": 1762700000, "lastSeenLiveAt": 0 }] }
```

**Kabul testi:** Oturum tanımlıyken panelde ülke filtresine göre canlı yayınlar listelenir; oturum
yokken sistem çökmeden tohum havuzla çalışır ve panelde eksik olan tek şey "küresel akış" olur.

---

## MODÜL 2 — Sessiz Dinleme ve Etkinlik Çözümleme

**Amaç:** Havuzdaki tüm canlı yayınları arka planda dinleyip sandık / zarf / portal olaylarını
parametreleriyle çözmek.

**Gereksinimler**
- Aynı anda en az 15 oda dinlenecek (`--max-rooms`), havuz 60 saniyede bir yoklanacak (`--poll 60`).
- Bağlanılan her oda için kaydedilecek alanlar: `live`, `startTime` (TikTok'un gerçek başlangıcı),
  `title`, `viewers`, `country`, `checkedAt`.
- Yakalanan her olayda çözülecek alanlar:
  - `kind`: `chest` (sandık/hediye), `letter` (zarf), `portal`
  - `coins`: toplam jeton (hediye elmas değeri × adet; zarf/portalda etkinlik jetonu)
  - `expiresAt` / `durationSec`: canlı geri sayım için bitiş zamanı ve süre
  - `shared` / `participants`: kaç kişiye paylaşıldığı (bilinmiyorsa `0` — uydurulmayacak)
  - `sender`: gönderen kullanıcı (varsa), `t`: olay zamanı (ms)
  - `giftName`: hediye/etkinlik adı
- Olaylar tekilleştirilecek (aynı olay iki kez yazılmayacak), son 400 olay tutulacak, `min-coins`
  eşiğinin altı yazılmayacak.
- Yayın bittiğinde (`streamEnd`) süre kapatılacak, oturum kapatılacak, olaylar geçmişte kalacak.

**Çıktı** (`site/firsat/data/live.json`)
```json
{
  "scannedAt": "ISO",
  "scanner": { "targetCount": 200, "liveCount": 34, "watching": 15, "polls": 12,
               "minutesLeft": 150, "lastError": null, "version": 1 },
  "streamers": [{ "username": "ornek", "country": "TR", "live": true, "startTime": 1762700000,
                  "title": "…", "viewers": 812, "coins": 350, "gifts": 4,
                  "lastGiftName": "Rose", "lastSeenLiveAt": 1762701800,
                  "reason": "", "checkedAt": 1762701810 }],
  "events": [{ "id": "ornek-1762701500-a1b2c", "t": 1762701500123, "username": "ornek",
               "kind": "chest", "coins": 100, "giftName": "Rose", "sender": "izleyici",
               "shared": 0, "source": "scan" }]
}
```

**Kabul testi:** Canlı bir odada hediye/zarf düştüğünde olay 5 saniye içinde `live.json`'da görünür;
olayın jetonu, adı ve türü doğru; panelde "(CANLI)" etiketiyle Fırsatlar'a düşer.

---

## MODÜL 3 — Akıllı Sıralama ve Karlılık Puanı

**Amaç:** Fırsatları ve yayıncıları en kârlı/en acil en üstte olacak şekilde dinamik sıralamak.

**Puanlama (0–100)**
- `aciliyet = 40 × (1 − kalanSüre / toplamSüre)` — süresi az kalan öne.
- `jeton = 30 × min(1, jeton / 1000)` — yüksek jetonlu öne.
- `verim = 20 × min(1, (jeton / max(1, kişi)) / 100)` — jeton/kişi oranı en yüksek olan öne.
- `tazelik = 10 × min(1, canlıSüre / 3600)` — yeni açılan yayınların potansiyeli; 1 saatten sonra tam puan.
- Eşitlikte: önce kalan süre, sonra jeton, sonra `t` (yeni olay) esas alınacak.
- Süresi geçmiş olaylar listeden düşecek; "Topladım / Kaçtı" işaretlenen olay puanlamaya girmeyecek.

**Sıralama tipleri (panelde seçilebilir)**
1. **Acil + kârlı** (varsayılan) — yukarıdaki toplam puan.
2. **Sadece jeton** — en yüksek jeton önce.
3. **Sadece süre** — en az kalan süre önce.
4. **Jeton/kişi** — en yüksek oran önce.
5. **Yeni yayınlar** — en yeni `startTime` önce, potansiyel puanıyla.

**Arayüz**
- Fırsatlar sekmesinde her kartta: yayıncı, olay türü, jeton, kalan süre (canlı geri sayım), kaç
  kişiye paylaşıldığı, puan ve sıralama nedeni tek satırda.
- Yayınlar tablosunda aynı sıralama mantığı sütun başlıklarından uygulanabilir olacak.
- Sıralama 30 saniyede bir, panel açıkken kendiliğinden tazelenecek; sayfa yenileme gerekmeyecek.

**Kabul testi:** 3 fırsat verisiyle (biri 2 dk kala 500 jeton, biri 40 dk kala 2000 jeton, biri yeni
yayın 100 jeton) varsayılan sıralama "acil olan → yüksek jetonlu → yeni yayın" olarak çıkar; süre
azaldıkça sıralama kendiliğinden değişir.

---

## TESLİM BİÇİMİ

- Kod: `scanner/index.js` (keşif + dinleme), `site/firsat/app.js` (okuma + sıralama + arayüz),
  `site/firsat/data/*.json` (veri), `.github/workflows/scan.yml` (3 saatte bir tur).
- Her modül için: ne yaptığı, hangi dosyada olduğu, nasıl test edildiği tek paragraf.
- Test: en az bir gerçek canlı yayında uçtan uca kanıt (ekran görüntüsü veya `live.json` kesiti).
  Test edilemeyen kısım varsa "test edilmedi" diye açıkça yazılacak — "çalışıyor" denmeyecek.

## YASAKLAR

- Kullanıcıdan manuel liste, dosya yükleme, "şu hesabı ekle" istemek.
- Canlı olmayan satırı canlı göstermek; süreyi tahminle doldurmak; jeton/kişi sayısını uydurmak.
- Var olmayan uç noktaları varmış gibi anlatmak; engellendiğinde sessizce sahte veri üretmek.
- Kullanıcının verisini (hesap envanteri, `Tiktok/data/store.json`) silmek veya yerini değiştirmek.
