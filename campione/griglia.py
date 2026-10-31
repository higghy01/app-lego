import json, io, sys, urllib.request
from PIL import Image, ImageDraw
BASE = "https://images.brickset.com/sets/"
data = json.load(open(sys.argv[1]))
def get(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "app-lego-check"})
        return Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=20).read())).convert("RGB")
    except Exception as e:
        print("ERR", url, e); return None
C, H, COLS = 150, 170, 10
for name, items in data.items():
    for p in range(0, len(items), 60):
        part = items[p:p + 60]
        sheet = Image.new("RGB", (C * COLS, H * ((len(part) + COLS - 1) // COLS)), "white")
        dr = ImageDraw.Draw(sheet)
        for n, (k, path) in enumerate(part):
            x, y = (n % COLS) * C, (n // COLS) * H
            im = get(BASE + path)
            if im:
                im.thumbnail((C - 6, C - 6)); sheet.paste(im, (x + 3, y + 3))
            dr.text((x + 3, y + C), f"{p + n} {k}", fill="black")
        sheet.save(f"campione/griglia-{name}-{p // 60}.jpg", quality=80)
