import json, sys, io, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw
L = json.load(open(sys.argv[1]))
UA = {"User-Agent": "app-lego-verifica/1.0"}

def head(s):
    url = f"https://images.brickset.com/sets/small/{s}.jpg"
    for _ in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA, method="HEAD"), timeout=20) as r:
                return s, r.status, r.headers.get("Content-Length")
        except urllib.error.HTTPError as e:
            return s, e.code, None
        except Exception as e:
            err = str(e)
    return s, "err " + err, None

with ThreadPoolExecutor(8) as ex:
    res = list(ex.map(head, L["head"]))
bad = [r for r in res if r[1] != 200]
with open("campione/mancanti.txt", "w") as f:
    f.write(f"controllati {len(res)}, non 200: {len(bad)}\n")
    for r in bad:
        f.write(f"{r[0]} {r[1]}\n")

def get(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
            return Image.open(io.BytesIO(r.read())).convert("RGB")
    except Exception:
        return None

T = 170
def tile(label, url):
    im = Image.new("RGB", (T, T + 18), "white")
    p = get(url)
    if p:
        p.thumbnail((T, T)); im.paste(p, ((T - p.width) // 2, (T - p.height) // 2))
    else:
        ImageDraw.Draw(im).text((10, T // 2), "MANCA", fill="red")
    ImageDraw.Draw(im).text((4, T + 3), label, fill="black")
    return im

for name, items in L["sheets"].items():
    cols = 6; rows = (len(items) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (T + 4), rows * (T + 22)), "#ccc")
    for k, (lab, url) in enumerate(items):
        sheet.paste(tile(lab, url), ((k % cols) * (T + 4), (k // cols) * (T + 22)))
    sheet.save(f"campione/{name}.jpg", quality=80)

for name, rows in L["rows"].items():
    for part in range(0, len(rows), 12):
        chunk = rows[part:part + 12]
        sheet = Image.new("RGB", (8 * (T + 4), len(chunk) * (T + 22)), "#ccc")
        for r, (s, urls) in enumerate(chunk):
            for c, u in enumerate(urls):
                sheet.paste(tile(s if c == 0 else f"{s} #{c}", u), (c * (T + 4), r * (T + 22)))
        sheet.save(f"campione/{name}-{part // 12}.jpg", quality=80)
