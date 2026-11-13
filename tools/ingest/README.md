# Telefondan gerçek kutu yakalama (`/ingest`)

Web istemcisi sandık/portal/zarf mesajlarını görmez; bu mesajlar TikTok'un
**uygulama** istemcisine gider. Emülatördeki gerçek uygulamadan yakaladığın kutu
mesajlarını bu uca gönderirsen kayıt, tarayıcının kullandığı **aynı yoldan**
işlenir: `ntfy` yayını (panel saniyeler içinde görür) + `site/firsat/data/boxes.json`.

## 1. Sunucuyu başlat

```bash
INGEST_TOKEN="$(openssl rand -hex 24)" node tools/ingest/server.mjs --port=8788
```

| Argüman | Varsayılan | Açıklama |
|---|---|---|
| `--port` | `8788` | Dinlenen port |
| `--host` | `0.0.0.0` | Arayüz (`127.0.0.1` verirsen yalnızca yerel) |
| `--token` | `INGEST_TOKEN` | Paylaşılan anahtar (en az 16 karakter, zorunlu) |
| `--data-dir` | `site/firsat/data` | `boxes.json` buraya yazılır |
| `--ntfy` | `1` | `--ntfy=0` yayını kapatır (yerel test) |
| `--ntfy-topic` | `cehennem-tiktok-firsat-7f3a91` | Panelin `BOX_TOPIC` değeriyle aynı olmalı |
| `--ntfy-key` | tarayıcının yayın anahtarı | Panelin `BOX_KEY` değeriyle aynı olmalı |

Anahtar zorunlu: boşsa ya da 16 karakterden kısaysa sunucu hiç açılmaz.
Anahtar loglanmaz; yükü olan isteklerde de geri döndürülmez.

## 2. Uçlar

| Uç | Yöntem | Anahtar | Döner |
|---|---|---|---|
| `/ingest` | `POST` | `x-ingest-key: <token>` veya `Authorization: Bearer <token>` | `200 {accepted:true,id,kind,coins}` · tekrar: `{duplicate:true}` · `400` bozuk gövde · `401` yanlış anahtar |
| `/health` | `GET` | gerekmez | `{ok,boxes,updatedAt,stats}` |

Gövde en fazla 64 KB. Kayıtlar `envelopeId` (yoksa `app:<kullanıcı>:<tür>:<zaman>`)
kimliğiyle tekilleştirilir; aynı yakalama iki kez gönderilirse ikinci kez yazılmaz.
`boxes.json` yeni kutu başta olacak şekilde 120 kayıtta tutulur.

## 3. Gönderici betiği

`send.mjs` NDJSON okur (her satır bir JSON) ve sırayla gönderir:

```bash
INGEST_TOKEN="..." node tools/ingest/send.mjs --file=capture.ndjson --url=http://127.0.0.1:8788/ingest
adb logcat -s TikTokBox | INGEST_TOKEN="..." node tools/ingest/send.mjs
```

- `--delay=500` iki kayıt arasında beklenecek milisaniye.
- Bozuk satırı atlar, sonunda `gönderilen / hatalı` yazar; hata varsa çıkış kodu `1`.
- Termux gibi Android tarafında çalıştıracaksan `pkg install nodejs` yeterli
  (Node 22+; `fetch` yerleşik).

Örnek satırlar:

```json
{"username":"ornek","event":"envelope","envelopeInfo":{"businessType":20,"diamondCount":51,"envelopeId":"abc123","secondsUntilOpen":60,"peopleCount":36}}
{"username":"ornek","businessType":9,"coins":200,"durationSec":15}
```

`businessType`: `9` portal · `19` süper fan kutusu · `20` sandık · `21` zarf.
Jeton alanı sırayla `diamondCount → coinCount → coins` olarak okunur; hiçbiri yoksa
kayıt `0` ile yazılır ve panelde "jeton bilinmiyor" görünür (değer uydurulmaz).

## 4. Emülatörden yakalama

1. Android emülatörde TikTok'u aç, bir yayına gir.
2. Trafiği yakala (mitmproxy/Charles ile HTTPS araya girme, ya da Frida ile
   `webcast` IM çerçevelerini okuma).
3. `envelope` / `superFanBox` mesajlarını NDJSON olarak yaz (yukarıdaki örnek
   biçim; ham `envelopeInfo` alanlarını olduğu gibi bırakabilirsin).
4. `send.mjs` ile uca gönder.

## 5. Sınırlar

- `boxes.json`'u tarayıcı her turda kendi kutularıyla yeniden yazar; yani dosya
  kalıcı depo değildir. **Kalıcı yol ntfy'dir**: panel açıkken kayıt anında düşer.
  Uzun süre saklamak istiyorsan kutu kaydını ayrıca kendin arşivlemelisin.
- Uç varsayılan olarak `0.0.0.0` dinler; internete açacaksan ters vekil (HTTPS)
  ve güçlü anahtar kullan, mümkünse yalnızca VPN içinde yayınla.
- Bu yaklaşım TikTok'un istemci imzasını taklit etmez; veriyi gerçek uygulamadan
  okur. Uygulamanın güncellemesiyle mesaj alanları değişirse `normalize()`
  içindeki alan adlarını güncellemek yeterli.
