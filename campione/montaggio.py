# Temporaneo: scarica le miniature Brickset del campione e fa fogli di controllo con il nome di ogni foto.
import json, io, sys, urllib.request
from PIL import Image, ImageDraw
BASE = "https://images.brickset.com/sets/"
lista = json.load(open(sys.argv[1]))
def get(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "app-lego-check"})
        return Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=20).read())).convert("RGB")
    except Exception as e:
        print("ERR", url, e); return None
C, H, PER = 150, 175, 12
for start in range(0, len(lista), PER):
    rows = lista[start:start + PER]
    sheet = Image.new("RGB", (C * 10, H * len(rows)), "white")
    dr = ImageDraw.Draw(sheet)
    for r, row in enumerate(rows):
        cells = [("MAIN " + row["set"], BASE + "small/" + row["set"] + ".jpg")] + [(p.rsplit("/", 1)[-1][:24], BASE + p) for p in row["imgs"]]
        for c, (label, url) in enumerate(cells[:10]):
            im = get(url)
            if im:
                im.thumbnail((C - 6, C - 6)); sheet.paste(im, (c * C + 3, r * H + 3))
            dr.text((c * C + 3, r * H + C), (row["g"] + " " if c == 0 else "") + label, fill="black")
        dr.line([(0, r * H + H - 1), (C * 10, r * H + H - 1)], fill="gray")
    sheet.save(f"campione/foglio-{start // PER:02d}.jpg", quality=80)
