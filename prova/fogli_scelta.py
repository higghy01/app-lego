"""PROVA temporanea: fogli per scegliere a occhio il fronte (righe = set, colonne = foto; in prova/lista2.json)."""
import io, json, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "prova" / "scelta2"
OUT.mkdir(parents=True, exist_ok=True)
BS = "https://images.brickset.com/sets/"
rows = json.loads((ROOT / "prova/lista2.json").read_text())
T = 170
try:
    FONT = ImageFont.truetype("DejaVuSans-Bold.ttf", 16)
except Exception:
    FONT = ImageFont.load_default()


def thumb(p):
    try:
        req = urllib.request.Request(BS + p, headers={"User-Agent": "app-lego-catalog/1.0"})
        im = Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=40).read()))
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
            im = Image.alpha_composite(bg, im)
        im = im.convert("RGB")
        im.thumbnail((T - 6, T - 6))
        return im
    except Exception:
        return None


with ThreadPoolExecutor(12) as ex:
    ims = list(ex.map(lambda r: [thumb(p) for p in r["c"]], rows))
PER = 12
for n in range(0, len(rows), PER):
    part = rows[n:n + PER]
    sheet = Image.new("RGB", (T * 9, (T + 22) * len(part)), "white")
    d = ImageDraw.Draw(sheet)
    for i, (r, row_ims) in enumerate(zip(part, ims[n:n + PER])):
        y = i * (T + 22)
        d.rectangle((0, y, T - 4, y + T + 18), fill=(235, 235, 235))
        d.text((4, y + 40), f"{n + i}", fill="black", font=FONT)
        d.text((4, y + 70), r["set"], fill="black", font=FONT)
        for j, im in enumerate(row_ims):
            if im:
                sheet.paste(im, (T * (j + 1) + 3, y + 3))
            d.text((T * (j + 1) + 4, y + T), f"{chr(97 + j)}", fill="red", font=FONT)
    sheet.save(OUT / f"s{n // PER:02d}.jpg", quality=82)
