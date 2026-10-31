"""Guarda le foto Brickset per capire quali mostrano SOLO il fronte della scatola.

Il nome della foto non basta sempre (sasha 31/10: "solo il fronte della scatola"):
- "alt1" di solito e' la scatola, ma a volte e' il set montato o una foto d'ambiente;
- "boxprod" (e "<set>.png") e' la scatola con davanti il set montato: si ritaglia solo la scatola.
Regole (controllate guardando le foto):
- fronte = il logo LEGO in alto a sinistra, oppure una sagoma piena da scatola su sfondo bianco (is_front);
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
    """Rettangolo della scatola in una foto "boxprod": sfondo bianco, scatola in alto a sinistra, set montato davanti.
    Il bordo destro si misura su piu' righe in alto (li' il set montato non arriva quasi mai), quello in basso su piu'
    colonne: il set montato spesso tocca la scatola, quindi vale la misura su cui almeno due colonne sono d'accordo."""
    h, w, _ = a.shape
    ink = a.min(axis=2) < 232
    rows = np.where(ink[:, : int(w * 0.7)].sum(axis=1) > w * 0.08)[0]
    cols = np.where(ink[: int(h * 0.7), :].sum(axis=0) > h * 0.08)[0]
    if not len(rows) or not len(cols):
        return None
    top, left = int(rows[0]), int(cols[0])

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

    rights = sorted(run(ink[min(h - 1, top + int(h * f))], left + 3) for f in (0.03, 0.08, 0.15))
    right = rights[1]
    if right - left < w * 0.2:
        return None
    xs = [left + int((right - left) * f) for f in (0.04, 0.25, 0.5, 0.75, 0.96)]
    bottoms = sorted(run(ink[:, x], top + 3) for x in xs)
    bottom = None
    for i in range(len(bottoms) - 1):  # la prima misura confermata da un'altra colonna (entro il 2%)
        if bottoms[i] - top > h * 0.2 and bottoms[i + 1] - bottoms[i] <= h * 0.02:
            bottom = bottoms[i]
            break
    if bottom is None:
        return None
    bw, bh = right - left, bottom - top
    if bw < w * 0.25 or bh < h * 0.25 or bw > w * 0.85 or bh > h * 0.85 or not 0.5 <= bw / bh <= 2.4:
        return None
    return [round(left / w, 4), round(top / h, 4), round(bw / w, 4), round(bh / h, 4)]


def is_front(why):
    """why = [logo trovato, bordi bianchi, quanto la sagoma riempie il suo rettangolo] (vedi shape).
    Controllato guardando ~250 foto: il logo da solo non basta (fogli di istruzioni), il logo manca nelle scatole
    scure o rosse; una scatola riempie almeno il 75% del suo rettangolo, un set montato o un gadget no."""
    logo, edge, fill = why
    return bool((logo and fill >= 0.55) or (edge >= 0.7 and fill >= 0.75))


def analyze(path, kind):
    try:
        a = load(path)
    except Exception as e:  # foto che non si scarica: si riprova la prossima volta
        return path, None, str(e)
    return analyze_array(a, kind, path)


def shape(a):
    """Quanto la foto sembra una scatola: bordi bianchi intorno (non una foto d'ambiente) e la sagoma che
    riempie quasi tutto il suo rettangolo (un set montato lascia tanto bianco tra i pezzi)."""
    h, w, _ = a.shape
    ink = a.min(axis=2) < 232
    edge = np.concatenate([ink[:2].ravel(), ink[-2:].ravel(), ink[:, :2].ravel(), ink[:, -2:].ravel()])
    ys, xs = np.where(ink)
    if not len(ys):
        return 0.0, 0.0
    box = ink[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    # i buchi chiusi (es. riflessi bianchi sulla scatola) contano come pieni
    fill = ndimage.binary_fill_holes(box).mean()
    return 1 - edge.mean(), float(fill)


def analyze_array(a, kind, path=None):
    h, w, _ = a.shape
    logo = find_logo(a)
    if kind == "crop":
        rect = box_rect(a)
        if not rect:
            return path, {"f": 0}, None
        x, y, bw, bh = rect
        return path, {"f": 1, "crop": rect + [round(bw * w / (bh * h), 3)]}, None
    white_edge, fill = shape(a)
    has_logo = bool(logo) and logo[0] < w * 0.45 and logo[1] < h * 0.45
    why = [int(has_logo), round(white_edge, 2), round(fill, 2)]
    return path, {"f": int(is_front(why)), "why": why}, None


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
