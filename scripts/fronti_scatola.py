"""Guarda le foto Brickset per capire quali mostrano SOLO il fronte della scatola.

Il nome della foto non basta sempre (sasha 31/10: "solo il fronte della scatola"):
- "alt1" di solito e' la scatola, ma a volte e' il set montato o una foto d'ambiente;
- le foto con un numero a caso (es. 75645_98067.jpg) a volte sono la scatola, a volte no;
- "boxprod" (e "<set>.png") e' la scatola con davanti il set montato: si ritaglia solo la scatola.
Regole (controllate guardando le foto):
- fronte = c'e' il logo LEGO (quadrato rosso con le lettere bianche) in alto a sinistra;
- ritaglio di boxprod = il rettangolo della scatola, che sta in alto a sinistra su sfondo bianco.
Il risultato va in data-src/brickset-fronti.json ({"imgs": {foto: {"f": 0|1, "crop": [x, y, l, a]}}},
misure in frazioni della foto), che build_catalog.py usa per scegliere la foto degli elenchi.

Uso: python scripts/fronti_scatola.py [--max 3000]   (solo le foto non ancora guardate)
"""
import argparse
import io
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

IMG = "https://images.brickset.com/sets/"
DATA = Path(__file__).resolve().parent.parent / "data-src"
OUT = DATA / "brickset-fronti.json"
W = 480  # le foto si guardano rimpicciolite a questa larghezza


def load(path):
    req = urllib.request.Request(IMG + path, headers={"User-Agent": "app-lego-catalog/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        im = Image.open(io.BytesIO(r.read()))
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
            im = Image.alpha_composite(bg, im)
        im = im.convert("RGB")
    im.thumbnail((W, W * 2))
    return np.asarray(im).astype(int)


def find_logo(a):
    """Il logo LEGO: una macchia rossa quasi quadrata con dentro le lettere bianche. Ritorna (x, y, lato) o None."""
    h, w, _ = a.shape
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    red = (r > 160) & (g < 80) & (b < 80) & (r - g > 110)
    lab, n = ndimage.label(red)
    best = None
    for i, sl in enumerate(ndimage.find_objects(lab), 1):
        ys, xs = sl
        bh, bw = ys.stop - ys.start, xs.stop - xs.start
        side = max(bh, bw)
        if side < max(8, w * 0.03) or side > w * 0.3 or not 0.75 <= bw / bh <= 1.33:
            continue
        box = a[ys, xs]
        inside = lab[ys, xs] == i
        white = (box.min(axis=2) > 200) & ~inside
        # quadrato pieno di rosso, con un po' di bianco (le lettere), non un pezzo rosso qualsiasi
        if inside.mean() < 0.45 or white.mean() < 0.05 or white.mean() > 0.45:
            continue
        cand = (xs.start, ys.start, side)
        if best is None or side > best[2]:
            best = cand
    return best


def box_rect(a):
    """Rettangolo della scatola in una foto "boxprod": sfondo bianco, scatola in alto a sinistra, set montato davanti."""
    h, w, _ = a.shape
    ink = a.min(axis=2) < 232
    rows = np.where(ink[:, : int(w * 0.7)].sum(axis=1) > w * 0.08)[0]
    cols = np.where(ink[: int(h * 0.7), :].sum(axis=0) > h * 0.08)[0]
    if not len(rows) or not len(cols):
        return None
    top, left = rows[0], cols[0]

    def run(line, start):
        gap = 0
        for k in range(start, len(line)):
            if line[k]:
                gap = 0
            else:
                gap += 1
                if gap >= 4:
                    return k - gap + 1
        return len(line)

    y = min(h - 1, top + max(3, int(h * 0.03)))
    x = min(w - 1, left + max(3, int(w * 0.03)))
    right = run(ink[y], x)
    bottom = run(ink[:, x], y)
    bw, bh = right - left, bottom - top
    if bw < w * 0.25 or bh < h * 0.25 or not 0.5 <= bw / bh <= 2.2:
        return None
    return [round(left / w, 4), round(top / h, 4), round(bw / w, 4), round(bh / h, 4)]


def analyze(path, kind):
    try:
        a = load(path)
    except Exception as e:  # foto che non si scarica: si riprova la prossima volta
        return path, None, str(e)
    return analyze_array(a, kind, path)


def analyze_array(a, kind, path=None):
    h, w, _ = a.shape
    logo = find_logo(a)
    if kind == "crop":
        rect = box_rect(a)
        if not rect:
            return path, {"f": 0}, None
        x, y, bw, bh = rect
        ok = bool(logo) and x * w - 2 <= logo[0] <= (x + bw * 0.5) * w and y * h - 2 <= logo[1] <= (y + bh * 0.4) * h
        return path, ({"f": 1, "crop": rect} if ok else {"f": 0}), None
    ok = bool(logo) and logo[0] < w * 0.45 and logo[1] < h * 0.45
    return path, {"f": int(ok)}, None


def candidates(photos, done):
    """Le foto da guardare: per ogni set solo se non ha gia' un fronte sicuro dal nome."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_catalog import front_candidates
    out = []
    for set_num, info in photos["sets"].items():
        for img, kind in front_candidates(set_num, info["imgs"]):
            if img[0] not in done:
                out.append((img[0], kind))
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--max", type=int, default=3000)
    args = p.parse_args()
    data = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"imgs": {}}
    photos = json.loads((DATA / "brickset-foto.json").read_text(encoding="utf-8"))
    todo = candidates(photos, data["imgs"])[: args.max]
    errors = 0
    with ThreadPoolExecutor(8) as ex:
        for path, res, err in ex.map(lambda t: analyze(*t), todo):
            if res is None:
                errors += 1
            else:
                data["imgs"][path] = res
    data["imgs"] = dict(sorted(data["imgs"].items()))
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    n = sum(1 for v in data["imgs"].values() if v["f"])
    print(f"guardate {len(todo) - errors} foto ({errors} non scaricate); in tutto {len(data['imgs'])}, {n} col fronte della scatola")


if __name__ == "__main__":
    main()
