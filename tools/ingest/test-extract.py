#!/usr/bin/env python3
"""mitmproxy eklentisinin ayıklama fonksiyonlarını mitmproxy olmadan dener.

Gerçek uygulama trafiği protobuf olduğu için JSON yolu burada gerçek bir
yakalama olmadan doğrulanamaz; burada sentetik yüklerle mantık sınanır.
"""
import importlib.util
import json
import os
import sys
import tempfile

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mitm_boxes.py")
spec = importlib.util.spec_from_file_location("mitm_boxes", PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

failures = []


def check(name, condition, detail=""):
    if condition:
        print("OK  ", name)
    else:
        print("FAIL", name, detail)
        failures.append(name)


# 1) JSON yolu: kutu bilgisi kardeş nesnelerde (user + envelopeInfo)
payload = {
    "data": {
        "user": {"uniqueId": "ornek_yayinci"},
        "envelopeInfo": {
            "businessType": 20,
            "diamondCount": 51,
            "envelopeId": "abc123",
            "secondsUntilOpen": 60,
            "peopleCount": 36,
        },
    }
}
records = module.boxes_from_json(payload, captured_at=1700000000000)
check("JSON: tek kayıt çıktı", len(records) == 1, records)
if records:
    record = records[0]
    check("JSON: kullanıcı adı bulundu", record["username"] == "ornek_yayinci", record["username"])
    check("JSON: tür sandık", record["businessType"] == 20 and record["businessType"] != 0, record)
    check("JSON: jeton 51", record["coins"] == 51, record["coins"])
    check("JSON: envelopeId korundu", record["envelopeId"] == "abc123", record["envelopeId"])
    check("JSON: açılış penceresi", record["secondsUntilOpen"] == 60, record["secondsUntilOpen"])
    check("JSON: güven yüksek", record["confidence"] == "high", record["confidence"])

# 2) JSON yolu: kutu olmayan yük kayıt üretmemeli
check("JSON: kutusuz yük boş döner",
      module.boxes_from_json({"data": {"user": {"uniqueId": "biri"}, "chat": {"text": "selam"}}}) == [])

# 3) Jeton yoksa 0 yazılır, uydurulmaz
no_coins = module.boxes_from_json({
    "envelopeInfo": {"businessType": 19, "envelopeId": "sf1", "peopleCount": 2},
    "username": "superfan",
})
check("JSON: jetonsuz kayıt 0 ile yazıldı",
      len(no_coins) == 1 and no_coins[0]["coins"] == 0, no_coins)

# 4) Protobuf yolu (deneysel): alan numaraları bilinmiyor, anahtar kelime aranır
def varint(value):
    out = b""
    while True:
        byte = value & 0x7F
        value >>= 7
        out += bytes([byte | (0x80 if value else 0)])
        if not value:
            return out


def field_varint(number, value):
    return bytes([(number << 3) | 0]) + varint(value)


def field_bytes(number, raw):
    return bytes([(number << 3) | 2]) + varint(len(raw)) + raw


proto = (
    field_varint(1, 20)
    + field_bytes(2, b"Sandik")
    + field_bytes(3, b"ornek_yayinci")
    + field_varint(4, 51)
)
proto_records = module.boxes_from_protobuf(proto, captured_at=1700000000000)
check("protobuf: tek aday kayıt", len(proto_records) == 1, proto_records)
if proto_records:
    record = proto_records[0]
    check("protobuf: kullanıcı adı", record["username"] == "ornek_yayinci", record["username"])
    check("protobuf: tür 20", record["businessType"] == 20, record["businessType"])
    check("protobuf: jeton 51", record["coins"] == 51, record["coins"])
    check("protobuf: düşük güven işaretli", record["confidence"] == "low", record["confidence"])

# 5) Eklenti: tahmin yolu varsayılan kapalı
class FakeMessage:
    def __init__(self, content):
        self.content = content
        self.from_client = False


capture = module.BoxCapture()
capture.out_path = os.path.join(tempfile.mkdtemp(), "capture.ndjson")
check("eklenti: protobuf varsayılan kapalı", capture.extract(proto) == [])

capture.accept_heuristic = True
found = capture.extract(proto)
check("eklenti: tahmin açıkken kayıt çıktı", len(found) == 1, found)
capture._write(found)
capture._write(found)  # aynı kayıt ikinci kez yazılmamalı
with open(capture.out_path, encoding="utf-8") as handle:
    lines = [line for line in handle.read().splitlines() if line.strip()]
check("eklenti: NDJSON'a tek satır yazıldı (yinelenen atıldı)", len(lines) == 1, lines)
if lines:
    check("eklenti: NDJSON satırı JSON", json.loads(lines[0])["username"] == "ornek_yayinci")

check("eklenti: JSON yükü tahmin kapalıyken de çıkar",
      len(capture.extract(json.dumps(payload).encode("utf-8"))) == 1)

print()
if failures:
    print(str(len(failures)) + " kontrol başarısız")
    sys.exit(1)
print("tüm kontroller geçti")
