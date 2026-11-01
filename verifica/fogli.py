"""VERIFICA temporanea: per ogni set scelto a mano, la foto scelta (grande) e la foto Rebrickable del set (piccola)."""
import io, json, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "verifica" / "out"
OUT.mkdir(parents=True, exist_ok=True)
BS = "https://images.brickset.com/sets/"
rows = json.loads((ROOT / "verifica/lista.json").read_text())
import csv, gzip
try:
    req = urllib.request.Request("https://cdn.rebrickable.com/media/downloads/sets.csv.gz", headers={"User-Agent": "app-lego-catalog/1.0"})
    RB = {r["set_num"]: r for r in csv.DictReader(io.TextIOWrapper(gzip.GzipFile(fileobj=io.BytesIO(urllib.request.urlopen(req, timeout=60).read())), encoding="utf-8"))}
except Exception:
    RB = {}
for r in rows:
    if r["set"] in RB:
        r["name"], r["year"], r["rb"] = RB[r["set"]]["name"], RB[r["set"]]["year"], RB[r["set"]]["img_url"] or r["rb"]
W, H, R = 300, 250, 110
try:
    FONT = ImageFont.truetype("DejaVuSans-Bold.ttf", 15)
    SMALL = ImageFont.truetype("DejaVuSans.ttf", 12)
except Exception:
    FONT = SMALL = ImageFont.load_default()


def get(url, size):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "app-lego-catalog/1.0"})
        im = Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=40).read()))
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
            im = Image.alpha_composite(bg, im)
        im = im.convert("RGB")
        im.thumbnail(size)
        return im
    except Exception:
        return None


def load(r):
    return get(BS + r["pick"], (W, H)), get(r["rb"], (R, R)) if r["rb"] else None


with ThreadPoolExecutor(12) as ex:
    ims = list(ex.map(load, rows))
COLS, PER = 5, 30
CW, CH = W + R + 12, H + 40
for n in range(0, len(rows), PER):
    part = rows[n:n + PER]
    nrows = (len(part) + COLS - 1) // COLS
    sheet = Image.new("RGB", (CW * COLS, CH * nrows), "white")
    d = ImageDraw.Draw(sheet)
    for i, r in enumerate(part):
        x, y = (i % COLS) * CW, (i // COLS) * CH
        big, rb = ims[n + i]
        d.rectangle((x, y, x + CW - 4, y + CH - 4), outline=(200, 200, 200))
        if big:
            sheet.paste(big, (x + 3, y + 3))
        else:
            d.text((x + 20, y + 100), "FOTO NON SCARICATA", fill="red", font=FONT)
        if rb:
            sheet.paste(rb, (x + W + 8, y + 3))
        d.text((x + W + 8, y + R + 10), r["prev"], fill="blue", font=SMALL)
        d.text((x + W + 8, y + R + 26), "main" if r["pick"].startswith("images/") else "", fill="blue", font=SMALL)
        d.text((x + 4, y + H + 4), f"{n + i} {r['set']} {r['year']}", fill="black", font=FONT)
        d.text((x + 4, y + H + 21), r["name"][:48], fill="black", font=SMALL)
    sheet.save(OUT / f"v{n // PER:02d}.jpg", quality=80)
print("ok", len(rows), sum(1 for b, _ in ims if b is None), "mancanti")
