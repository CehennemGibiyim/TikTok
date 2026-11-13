"""mitmproxy eklentisi: TikTok uygulamasındaki kutu mesajlarını NDJSON'a yazar.

Kullanım (emülatör trafiği mitmproxy üzerinden geçerken):

    pip install mitmproxy
    mitmdump -s tools/ingest/mitm_boxes.py --set boxes_out=/tmp/capture.ndjson

Sonra kayıtları uca gönder:

    INGEST_TOKEN="..." node tools/ingest/send.mjs --file=/tmp/capture.ndjson

İki ayrıştırma yolu vardır:

1) **JSON yolu (güvenilir, varsayılan açık).** Bazı uçlar ve araya giren
   vekiller `envelopeInfo` / `treasureBoxData` alanlarını JSON olarak taşır.
   Bu yol alan adlarına dayanır, tahmin yürütmez.
2) **Protobuf yolu (deneysel, varsayılan KAPALI).** Gerçek uygulama akışı
   protobuf'tur ve alan numaraları şemaya bağlıdır. Şema elimizde olmadığı için
   burada yalnızca "kutu anahtar kelimesi geçen alt mesaj" aranır; üretilen
   kayıtlar `confidence: "low"` ile işaretlenir ve açıkça
   `--set accept_heuristic=true` verilmedikçe yazılmaz. Gerçek bir yakalama
   görüldüğünde alan numaraları buradaki eşlemeye sabitlenmelidir.

Yazılan satır biçimi `send.mjs`'in beklediğiyle aynıdır: yalnızca kutu
alanlarını taşır, token/çerez gibi hassas veriler hiç yazılmaz.
"""
from __future__ import annotations

import json
import os
import re
import time

try:  # mitmproxy olmadan da (testlerde) içe aktarılabilsin
    from mitmproxy import ctx, http  # type: ignore
except Exception:  # pragma: no cover
    ctx = None
    http = None


# Kutu türleri: 9 portal · 19 süper fan kutusu · 20 sandık · 21 zarf
KNOWN_BUSINESS_TYPES = {9: "portal", 19: "chest", 20: "chest", 21: "letter"}
BOX_NAMES = {9: "Portal", 19: "Süper Fan Kutusu", 20: "Sandık", 21: "Zarf"}
BOX_WORDS = re.compile(
    r"sand[ıi]k|chest|cofre|ba[uú]l?|caixa|coffre|truhe|сундук|"
    r"portal|zarf|envelope|mektup|letter|red\s*packet|hongbao|红包|宝箱",
    re.IGNORECASE,
)
USERNAME_RE = re.compile(r"^[A-Za-z0-9._]{2,24}$")
MAX_COINS = 50000000

# JSON'da kutu nesnesi sayılan alan adları.
BOX_KEYS = ("envelopeInfo", "treasureBoxData", "envelopeId", "businessType",
            "diamondCount", "boxType", "peopleCount", "secondsUntilOpen")
USERNAME_KEYS = ("username", "uniqueId", "userName", "nickname", "sendUserName",
                 "senderName", "anchorName", "displayId")


def _clean_username(value) -> str:
    text = str(value or "").strip().lstrip("@")
    text = re.sub(r"^https?://(www\.)?tiktok\.com/@?", "", text, flags=re.IGNORECASE)
    text = re.split(r"[/?#]", text)[0]
    return text.lower()


def _to_ms(value) -> int:
    num = int(value or 0)
    if num > 10 ** 12:
        return num
    if num > 10 ** 9:
        return num * 1000
    return 0


def _kind(business_type: int, text: str) -> str:
    if business_type in KNOWN_BUSINESS_TYPES:
        return KNOWN_BUSINESS_TYPES[business_type]
    if re.search(r"portal", text, re.IGNORECASE):
        return "portal"
    if re.search(r"treasure|sand[ıi]k|chest", text, re.IGNORECASE):
        return "chest"
    return "letter"


def _coins(*sources):
    """diamondCount → coinCount → coins; hiçbiri yoksa 0 (uydurma yok)."""
    for source in sources:
        if not isinstance(source, dict):
            continue
        for field in ("diamondCount", "coinCount", "coins"):
            value = source.get(field)
            try:
                number = int(value)
            except (TypeError, ValueError):
                continue
            if 0 < number <= MAX_COINS:
                return number
    return 0


def make_record(username, business_type, coins, envelope_id, captured_at,
                box_name="", people=0, duration=0, seconds_until_open=0,
                unpack_at=0, box_type="", source="mitm", confidence="high",
                event="envelope"):
    """NDJSON satırı: sunucunun normalize() beklediği alanlar."""
    username = _clean_username(username)
    if not username:
        return None
    business_type = int(business_type or 0)
    kind = _kind(business_type, " ".join([str(event), str(box_type), str(box_name)]))
    end_ms = _to_ms(unpack_at)
    if not end_ms and seconds_until_open:
        end_ms = int(captured_at) + int(seconds_until_open) * 1000
    name = BOX_NAMES.get(business_type) or box_name or {"chest": "Sandık", "portal": "Portal", "letter": "Zarf"}[kind]
    return {
        "username": username,
        "event": event,
        "businessType": business_type,
        "coins": int(coins or 0),
        "envelopeId": str(envelope_id or ""),
        "secondsUntilOpen": int(seconds_until_open or 0),
        "peopleCount": int(people or 0),
        "durationSec": int(duration or 0),
        "unpackAt": end_ms,
        "boxType": str(box_type or ""),
        "boxName": name,
        "capturedAt": int(captured_at),
        "source": source,
        "confidence": confidence,
    }


# ---------------------------------------------------------------- JSON yolu

def _usernames_in(node, out):
    if isinstance(node, list):
        for item in node:
            _usernames_in(item, out)
    elif isinstance(node, dict):
        for key, value in node.items():
            if key in USERNAME_KEYS and isinstance(value, str):
                name = _clean_username(value)
                if name:
                    out.add(name)
            else:
                _usernames_in(value, out)


def boxes_from_json(payload, captured_at=None, source="mitm"):
    """JSON yükünde kutu nesnelerini bulur. Alan adlarına dayanır."""
    captured_at = captured_at or int(time.time() * 1000)
    found = []
    # Kullanıcı adı kutu nesnesinin kardeşinde durabiliyor; tüm yükte tek ad
    # varsa onu kullan, birden fazlaysa yalnızca üst nesneden geleni kullan.
    names = set()
    _usernames_in(payload, names)
    only_name = next(iter(names)) if len(names) == 1 else ""

    def walk(node, inherited_username=only_name):
        if isinstance(node, list):
            for item in node:
                walk(item, inherited_username)
            return
        if not isinstance(node, dict):
            return
        username = ""
        for key in USERNAME_KEYS:
            if node.get(key):
                username = _clean_username(node.get(key))
                break
        username = username or inherited_username or only_name

        is_box = any(key in node for key in BOX_KEYS) and (
            "businessType" in node or "envelopeId" in node or "diamondCount" in node
        )
        if is_box:
            info = node.get("envelopeInfo") if isinstance(node.get("envelopeInfo"), dict) else node
            box = node.get("treasureBoxData") if isinstance(node.get("treasureBoxData"), dict) else {}
            record = make_record(
                username=username,
                business_type=info.get("businessType", node.get("businessType")),
                coins=_coins(info, box, node),
                envelope_id=info.get("envelopeId") or box.get("envelopeId") or "",
                captured_at=_to_ms(info.get("createAt") or box.get("createAt")) or captured_at,
                box_name=str(info.get("boxType") or info.get("displayKey") or ""),
                people=info.get("peopleCount") or info.get("recipientCount") or 0,
                duration=info.get("durationSec") or 0,
                seconds_until_open=info.get("secondsUntilOpen") or 0,
                unpack_at=info.get("unpackAt") or box.get("unpackAt") or 0,
                box_type=str(info.get("boxType") or ""),
                source=source,
            )
            if record:
                found.append(record)
            return  # alt nesneleri tekrar taramaya gerek yok

        for value in node.values():
            walk(value, username)

    walk(payload)
    return found


# ------------------------------------------------------- protobuf (deneysel)

def iter_protobuf(data: bytes, depth=0):
    """Şemasız protobuf okuyucu: (alan_no, değer) çiftleri üretir.

    Değer: int, bytes ya da iç içe liste. Amaç alan adlarını değil, yapıyı
    görmek; eşleme yukarıdaki anahtar kelime kuralıyla yapılır.
    """
    if depth > 6 or not isinstance(data, (bytes, bytearray)):
        return
    pos = 0
    size = len(data)

    def read_varint(index):
        result = 0
        shift = 0
        while index < size:
            byte = data[index]
            index += 1
            result |= (byte & 0x7F) << shift
            if not byte & 0x80:
                return result, index
            shift += 7
            if shift > 63:
                raise ValueError("varint")
        raise ValueError("varint")

    while pos < size:
        try:
            key, pos = read_varint(pos)
        except ValueError:
            return
        field, wire = key >> 3, key & 0x07
        if field == 0:
            return
        if wire == 0:
            try:
                value, pos = read_varint(pos)
            except ValueError:
                return
            yield field, value
        elif wire == 2:
            try:
                length, pos = read_varint(pos)
            except ValueError:
                return
            if length < 0 or pos + length > size:
                return
            chunk = bytes(data[pos:pos + length])
            pos += length
            nested = list(iter_protobuf(chunk, depth + 1))
            yield field, (nested if nested else chunk)
        elif wire == 5:
            pos += 4
        elif wire == 1:
            pos += 8
        else:
            return


def _scan_values(tree, strings, ints):
    """Ağaçtaki metinleri ve tam sayıları toplar (alan adları yok)."""
    for _, value in tree:
        if isinstance(value, list):
            _scan_values(value, strings, ints)
        elif isinstance(value, bytes):
            try:
                text = value.decode("utf-8")
            except UnicodeDecodeError:
                continue
            if text.isprintable():
                strings.append(text)
        else:
            ints.append(value)


def boxes_from_protobuf(data: bytes, captured_at=None, source="mitm"):
    """Deneysel: kutu anahtar kelimesi geçen alt mesajdan kayıt çıkarır.

    Alan numaraları bilinmediği için bu yol yalnızca `accept_heuristic` açıkken
    kullanılır ve kayıtlar `confidence: "low"` ile işaretlenir.
    """
    captured_at = captured_at or int(time.time() * 1000)
    strings, ints = [], []
    _scan_values(list(iter_protobuf(data)), strings, ints)

    box_name = next((text for text in strings if BOX_WORDS.search(text)), "")
    if not box_name:
        return []
    usernames = [text for text in strings if USERNAME_RE.match(text) and text != box_name]
    if not usernames:
        return []
    business_type = next((value for value in ints if value in KNOWN_BUSINESS_TYPES), 0)
    amount = next((value for value in ints if 0 < value <= MAX_COINS and value != business_type), 0)
    envelope_id = next((text for text in strings if len(text) >= 8 and text.isalnum()), "")
    record = make_record(
        username=usernames[0],
        business_type=business_type,
        coins=amount,
        envelope_id=envelope_id,
        captured_at=captured_at,
        box_name=box_name,
        source=source,
        confidence="low",
    )
    return [record] if record else []


# ------------------------------------------------------------------ eklenti

class BoxCapture:
    """mitmproxy eklentisi. Ayarlar: boxes_out, accept_heuristic."""

    def __init__(self):
        self.out_path = os.environ.get("BOXES_OUT", "capture.ndjson")
        self.accept_heuristic = os.environ.get("ACCEPT_HEURISTIC", "") in ("1", "true", "yes")
        self.seen = set()
        self.written = 0

    def load(self, loader):
        loader.add_option("boxes_out", str, self.out_path, "NDJSON çıktı dosyası")
        loader.add_option("accept_heuristic", bool, self.accept_heuristic,
                          "Protobuf tahmin yolunu aç (deneysel)")

    def configure(self, updated):
        options = getattr(ctx, "options", None) if ctx is not None else None
        if options is None:
            return
        if "boxes_out" in updated:
            self.out_path = options.boxes_out
        if "accept_heuristic" in updated:
            self.accept_heuristic = options.accept_heuristic

    # --- yazma ---
    def _write(self, records):
        if not records:
            return
        fresh = []
        for record in records:
            key = record.get("envelopeId") or f"{record['username']}|{record['capturedAt']}"
            if key in self.seen:
                continue
            self.seen.add(key)
            fresh.append(record)
        if not fresh:
            return
        directory = os.path.dirname(os.path.abspath(self.out_path))
        os.makedirs(directory, exist_ok=True)
        with open(self.out_path, "a", encoding="utf-8") as handle:
            for record in fresh:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        self.written += len(fresh)
        # ctx.log yalnızca mitmdump çalışırken vardır (testlerde yok).
        if ctx is not None and getattr(ctx, "log", None) is not None:
            ctx.log.info(f"{len(fresh)} kutu yazıldı → {self.out_path} (toplam {self.written})")

    # --- ayıklama ---
    def extract(self, body: bytes, captured_at=None, source="mitm"):
        records = []
        text = body.lstrip()[:1]
        if text in (b"{", b"["):
            try:
                records = boxes_from_json(json.loads(body), captured_at, source)
            except ValueError:
                records = []
        if not records and self.accept_heuristic:
            records = boxes_from_protobuf(body, captured_at, source)
        return records

    # --- mitmproxy kancaları ---
    def response(self, flow):
        if not http:
            return
        host = flow.request.pretty_host or ""
        if "tiktok" not in host:
            return
        content = flow.response.get_content(strict=False)
        if not content:
            return
        self._write(self.extract(content, source=host))

    def websocket_message(self, message):
        if not message.from_client:
            record_source = message.flow.request.pretty_host or "mitm"
            self._write(self.extract(message.content, source=record_source))


addons = [BoxCapture()]
