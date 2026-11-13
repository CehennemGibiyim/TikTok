#!/usr/bin/env python3
"""mitmproxy kancalarını gerçek mitmproxy nesneleriyle dener.

mitmproxy kurulu değilse test atlanır (çıkış 0). Gerçek ağ yoktur: sahte bir
`tflow` üretilip `response()` kancası doğrudan çağrılır.
"""
import importlib.util
import json
import os
import sys
import tempfile

try:
    from mitmproxy.test import tflow
except Exception:
    print("ATLANDI: mitmproxy kurulu değil (python3 -m pip install mitmproxy)")
    sys.exit(0)

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mitm_boxes.py")
spec = importlib.util.spec_from_file_location("mitm_boxes", PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

payload = {
    "data": {
        "user": {"uniqueId": "ornek_yayinci"},
        "envelopeInfo": {
            "businessType": 20,
            "diamondCount": 51,
            "envelopeId": "hook-1",
            "secondsUntilOpen": 60,
            "peopleCount": 36,
        },
    }
}

failures = []


def check(name, condition, detail=""):
    if condition:
        print("OK  ", name)
    else:
        print("FAIL", name, detail)
        failures.append(name)


capture = module.BoxCapture()
capture.out_path = os.path.join(tempfile.mkdtemp(), "capture.ndjson")

# 1) TikTok konağından gelen JSON yanıtı NDJSON'a yazılmalı
flow = tflow.tflow(resp=True)
flow.request.host = "webcast.tiktok.com"
flow.request.path = "/webcast/im/fetch/"
flow.response.headers["content-type"] = "application/json"
flow.response.set_content(json.dumps(payload).encode("utf-8"))
capture.response(flow)

lines = []
if os.path.exists(capture.out_path):
    with open(capture.out_path, encoding="utf-8") as handle:
        lines = [line for line in handle.read().splitlines() if line.strip()]
check("response kancası TikTok yanıtını yakaladı", len(lines) == 1, lines)
if lines:
    record = json.loads(lines[0])
    check("kayıt kullanıcı adı taşıyor", record["username"] == "ornek_yayinci", record)
    check("kayıt jetonu taşıyor", record["coins"] == 51, record)

# 2) Yabancı konak yok sayılmalı
other = tflow.tflow(resp=True)
other.request.host = "example.com"
other.response.headers["content-type"] = "application/json"
other.response.set_content(json.dumps(payload).encode("utf-8"))
capture.response(other)
if os.path.exists(capture.out_path):
    with open(capture.out_path, encoding="utf-8") as handle:
        after = [line for line in handle.read().splitlines() if line.strip()]
else:
    after = []
check("TikTok dışı konak yazılmadı", len(after) == 1, after)

# 3) Aynı kayıt ikinci kez yazılmamalı
capture.response(flow)
with open(capture.out_path, encoding="utf-8") as handle:
    deduped = [line for line in handle.read().splitlines() if line.strip()]
check("aynı kutu iki kez yazılmadı", len(deduped) == 1, deduped)

# 4) Protobuf yanıtı varsayılan ayarda yazılmamalı
proto = b"\x08\x14\x12\x06Sandik\x1a\x0dornek_yayinci\x20\x33"
proto_flow = tflow.tflow(resp=True)
proto_flow.request.host = "webcast.tiktok.com"
proto_flow.response.headers["content-type"] = "application/octet-stream"
proto_flow.response.set_content(proto)
capture.response(proto_flow)
with open(capture.out_path, encoding="utf-8") as handle:
    still = [line for line in handle.read().splitlines() if line.strip()]
check("protobuf yanıtı varsayılan kapalı (kayıt eklenmedi)", len(still) == 1, still)

print()
if failures:
    print(str(len(failures)) + " kontrol başarısız")
    sys.exit(1)
print("tüm kancalar beklendiği gibi çalıştı")
