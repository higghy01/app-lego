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
import re
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


def bbox_ratio(a):
    """Altezza/larghezza della sagoma su sfondo bianco (per la foto del retro "Box5": la scatola da sola)."""
    ys, xs = np.where(a.min(axis=2) < 232)
    if not len(ys):
        return None
    return (ys.max() - ys.min() + 1) / (xs.max() - xs.min() + 1)


def box_rect(a, ratio=None, min_solid=0.9):
    """Rettangolo della scatola in una foto "boxprod": sfondo bianco, scatola in alto a sinistra, set montato davanti.
    Il bordo destro si misura su piu' righe in alto (li' il set montato non arriva quasi mai). Il bordo in basso:
    - se c'e' la foto del retro (Box5, stessa scatola da sola), dalla sua forma: altezza = larghezza x (alt./larg. del retro),
      aggiustata sul bordo vero se una colonna lo trova li' vicino (verifica 1/11: il set montato copre spesso il fondo
      della scatola e la misura sulle colonne non si trovava; con il retro 72 su 72 giuste);
    - altrimenti sulle colonne: vale la misura su cui almeno due colonne sono d'accordo.
    Alla fine il rettangolo deve essere quasi tutto pieno (una scatola), non mezzo bianco."""
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
    if ratio:
        est = top + (right - left) * ratio
        near = [b for b in bottoms if abs(b - est) <= h * 0.04]
        bottom = min(h, int(min(near, key=lambda b: abs(b - est))) if near else int(round(est)))
    else:
        for i in range(len(bottoms) - 1):  # la prima misura confermata da un'altra colonna (entro il 2%)
            if bottoms[i] - top > h * 0.2 and bottoms[i + 1] - bottoms[i] <= h * 0.02:
                bottom = bottoms[i]
                break
    if bottom is None:
        return None
    bw, bh = right - left, bottom - top
    if bw < w * 0.25 or bh < h * 0.25 or bw > w * 0.85 or bh > h * 0.85 or not 0.5 <= bw / bh <= 2.4:
        return None
    if ndimage.binary_fill_holes(ink[top:bottom, left:right]).mean() < min_solid:
        return None
    return [round(left / w, 4), round(top / h, 4), round(bw / w, 4), round(bh / h, 4)]


VERSION = 2  # 1/11: ritaglio con la misura del retro, alt1 ritagliate, scatole scure alte; le foto "no" di prima si riguardano


def is_front(why, real_set=False):
    """why = [logo trovato, bordi bianchi, quanto la sagoma riempie il suo rettangolo] (vedi shape).
    Controllato guardando ~250 foto: il logo da solo non basta (fogli di istruzioni), il logo manca nelle scatole
    scure o rosse; una scatola riempie almeno il 75% del suo rettangolo, un set montato o un gadget no."""
    logo, edge, fill = why
    # verifica 1/11: scatole alte e scure (Star Wars UCS, Disney) hanno meno bianco intorno ma sono piene: edge 0.69, fill 0.92
    # solo per i set veri: nei gadget, libri e poster una foto cosi' non e' una scatola
    return bool((logo and fill >= 0.55) or (edge >= 0.7 and fill >= 0.75) or (real_set and edge >= 0.6 and fill >= 0.9))


def analyze(path, kind, back=None):
    try:
        a = load(path)
        ratio = bbox_ratio(load(back)) if back else None
    except Exception as e:  # foto che non si scarica: si riprova la prossima volta
        return path, None, str(e)
    return analyze_array(a, kind, path, ratio)


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


def crop_result(a, rect, extra=None):
    h, w, _ = a.shape
    x, y, bw, bh = rect
    return {"f": 1, "crop": rect + [round(bw * w / (bh * h), 3)], "v": VERSION, **(extra or {})}


def analyze_array(a, kind, path=None, ratio=None):
    """kind "crop" = foto scatola + set (boxprod): si ritaglia la scatola. kind "logo" = alt1: e' il fronte? Se no, a volte
    e' anche lei scatola piccola in alto a sinistra + set montato (Creator 3 in 1, Technic...): si prova a ritagliarla,
    ma solo per i set veri ("alt1crop", codice fino a 5 cifre: non gadget e portachiavi) e su sfondo bianco."""
    h, w, _ = a.shape
    if kind == "crop":
        # il retro dice quanto e' alta la scatola; con lui la scatola in prospettiva riempie un po' meno il rettangolo
        rect = box_rect(a, ratio, 0.83 if ratio else 0.9)
        if not rect:
            return path, {"f": 0, "v": VERSION}, None
        return path, crop_result(a, rect), None
    logo = find_logo(a)
    white_edge, fill = shape(a)
    has_logo = bool(logo) and logo[0] < w * 0.45 and logo[1] < h * 0.45
    why = [int(has_logo), round(white_edge, 2), round(fill, 2)]
    if is_front(why, kind == "alt1crop"):
        return path, {"f": 1, "why": why, "v": VERSION}, None
    if kind == "alt1crop" and white_edge >= 0.7:
        rect = box_rect(a, ratio, 0.9)
        if rect:
            return path, crop_result(a, rect, {"why": why}), None
    return path, {"f": 0, "why": why, "v": VERSION}, None


def candidates(photos, done):
    """Le foto da guardare: per ogni set solo se non ha gia' un fronte sicuro dal nome."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_catalog import front_candidates
    out = []
    for set_num, info in photos["sets"].items():
        back = next((i[0] for i in info["imgs"] if re.search(r"box5", i[0].rsplit("/", 1)[-1].lower())), None)
        for img, kind in front_candidates(set_num, info["imgs"]):
            if kind == "logo" and re.fullmatch(r"\d{1,5}-\d+", set_num):
                kind = "alt1crop"
            seen = done.get(img[0])
            # le foto senza fronte guardate con le regole vecchie si riguardano con quelle nuove
            if seen is None or (not seen["f"] and seen.get("v", 1) < VERSION):
                out.append((img[0], kind, back if kind in ("crop", "alt1crop") else None))
    # prima quelle mai guardate (foto nuove della notte), poi quelle da riguardare
    out.sort(key=lambda t: t[0] in done)
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
