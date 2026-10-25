"""Prova temporanea: controlla quali campi Brickset sono davvero disponibili."""
import json, os, urllib.parse, urllib.request
KEY = os.environ["BRICKSET_API_KEY"]
B = "https://brickset.com/api/v3.asmx/"

def get(method, **params):
    q = urllib.parse.urlencode({"apiKey": KEY, **params})
    with urllib.request.urlopen(urllib.request.Request(f"{B}{method}?{q}", headers={"User-Agent": "app-lego-catalog/1.0"}), timeout=60) as r:
        return json.loads(r.read().decode())

def sets(p):
    return get("getSets", userHash="", params=json.dumps(p))

def short(s):
    ext = s.get("extendedData") or {}
    return {k: s.get(k) for k in ["setID", "number", "numberVariant", "name", "year", "theme", "subtheme", "launchDate", "exitDate", "availability", "additionalImageCount", "image", "LEGOCom", "packagingType", "released"]} | {
        "tags": ext.get("tags"), "description": (ext.get("description") or "")[:400], "notes": (ext.get("notes") or "")[:200]}

print("== Build Together (tag) ==")
d = sets({"tag": "Build Together", "extendedData": 1, "pageSize": 200})
print("matches", d.get("matches"), d.get("status"), d.get("message"))
for s in (d.get("sets") or [])[:3]:
    print(json.dumps(short(s), ensure_ascii=False, indent=1))
print("numeri:", [f"{s['number']}-{s['numberVariant']}" for s in d.get("sets") or []])

print("== Anno 2026, ordinati per uscita ==")
d = sets({"year": "2026", "extendedData": 1, "pageSize": 500, "orderBy": "LaunchDateDESC"})
print("matches", d.get("matches"), d.get("status"), d.get("message"))
all_s = d.get("sets") or []
with_desc = sum(1 for s in all_s if (s.get("extendedData") or {}).get("description"))
with_launch = sum(1 for s in all_s if s.get("launchDate"))
print(f"set: {len(all_s)}, con descrizione: {with_desc}, con launchDate: {with_launch}")
from collections import Counter
print("availability:", Counter(s.get("availability") for s in all_s).most_common())
tags = Counter(t for s in all_s for t in ((s.get("extendedData") or {}).get("tags") or []))
print("tag piu' comuni:", tags.most_common(40))
for s in all_s[:2]:
    print(json.dumps(short(s), ensure_ascii=False, indent=1))
    imgs = get("getAdditionalImages", setID=s["setID"])
    print("immagini aggiuntive:", json.dumps(imgs, indent=1)[:1500])

print("== Uso chiave ==")
print(json.dumps(get("getKeyUsageStats"), indent=1)[:800])
