"""PROVA temporanea (non va su main): per i set senza fronte della scatola, guarda tutte le foto Brickset
e misura quanto somigliano alla foto del set di Rebrickable (il modello sul fronte della scatola e' lo stesso disegno).
Scrive prova/out/risultati.json e fogli prova/out/foglio-N.jpg."""
import csv
import gzip
import io
import json
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from build_catalog import front_kind, pick_front, unique_photos, photo_order, alt1_is_box  # noqa: E402
import fronti_scatola as fs  # noqa: E402

OUT = ROOT / "prova" / "out"
OUT.mkdir(parents=True, exist_ok=True)
BS = "https://images.brickset.com/sets/"
SKIP = re.compile(r"lifestyle|web_?sec|nobg|nogb|mugshot|1to1|detail|-xx-1[34]-|-xx-33-|(^|_)(front|back)_?\d|box[56]|back|hinten|_prod|prod\.|instructions|_inst")


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "app-lego-catalog/1.0"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read()


def to_rgb(data, size=640):
    im = Image.open(io.BytesIO(data))
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im)
    im = im.convert("RGB")
    im.thumbnail((size, size))
    return im


def feats(im):
    g = cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2GRAY)
    return cv2.SIFT_create(nfeatures=1500).detectAndCompute(g, None)


def match(ref, cand_im):
    kr, dr = ref
    kc, dc = feats(cand_im)
    if dr is None or dc is None or len(kc) < 10:
        return 0, 0.0, 0
    bf = cv2.BFMatcher()
    ms = bf.knnMatch(dr, dc, k=2)
    good = [m[0] for m in ms if len(m) == 2 and m[0].distance < 0.75 * m[1].distance]
    if len(good) < 8:
        return 0, 0.0, len(good)
    src = np.float32([kr[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([kc[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    if H is None:
        return 0, 0.0, len(good)
    inl = int(mask.sum())
    # area coperta dai punti giusti (inviluppo convesso) rispetto alla foto
    pts = dst[mask.ravel() == 1].reshape(-1, 2)
    area = cv2.contourArea(cv2.convexHull(pts)) if len(pts) >= 3 else 0
    w, h = cand_im.size
    return inl, round(area / (w * h), 3), len(good)


def main():
    rb = {}
    data = gzip.decompress(get("https://cdn.rebrickable.com/media/downloads/sets.csv.gz")).decode("utf-8")
    for r in csv.DictReader(io.StringIO(data)):
        rb[r["set_num"]] = (r["name"], int(r["year"] or 0), r["img_url"], int(r["num_parts"] or 0))
    photos = json.loads((ROOT / "data-src/brickset-foto.json").read_text())["sets"]
    checked = json.loads((ROOT / "data-src/brickset-fronti.json").read_text())["imgs"]
    targets = []
    for s, info in photos.items():
        if s not in rb or not info["imgs"]:
            continue
        name, year, img, pcs = rb[s]
        alt1_box = alt1_is_box(info["imgs"])
        imgs = unique_photos(sorted(info["imgs"], key=lambda i: photo_order(i, alt1_box)))
        if pick_front(imgs, year, checked):
            continue
        cands = [i for i in imgs if not SKIP.search(i[0].rsplit("/", 1)[-1].lower())]
        cands.append([f"images/{s}.jpg", f"small/{s}.jpg"])
        targets.append((s, name, year, img, pcs, cands))
    real = [t for t in targets if re.fullmatch(r"\d{4,5}-1", t[0]) and t[4] > 1]
    print(f"set senza fronte: {len(targets)}, set veri: {len(real)}")
    real.sort(key=lambda t: -t[2])

    def work(t):
        s, name, year, img, pcs, cands = t
        res = {"set": s, "name": name, "year": year, "c": []}
        try:
            ref_im = to_rgb(get(img)) if img else None
        except Exception:
            ref_im = None
        ref = feats(ref_im) if ref_im else None
        thumbs = []
        for full, tn in cands:
            try:
                im = to_rgb(get(BS + full))
            except Exception as e:
                res["c"].append({"p": full, "err": str(e)[:40]})
                continue
            a = np.asarray(im.copy().resize((480, int(480 * im.size[1] / im.size[0])))).astype(int)
            edge, fill = fs.shape(a)
            logo = fs.find_logo(a)
            h, w, _ = a.shape
            has_logo = bool(logo) and logo[0] < w * 0.45 and logo[1] < h * 0.45
            inl, area, good = match(ref, im) if ref else (0, 0.0, 0)
            res["c"].append({"p": full, "logo": int(has_logo), "edge": round(edge, 2), "fill": round(fill, 2),
                             "inl": inl, "area": area, "good": good, "ar": round(im.size[1] / im.size[0], 2)})
            thumbs.append(im)
        return res, ref_im, thumbs

    results = []
    sheet_rows = []
    with ThreadPoolExecutor(8) as ex:
        for res, ref_im, thumbs in ex.map(work, real):
            results.append(res)
            if len(sheet_rows) < 240:
                sheet_rows.append((res, ref_im, thumbs))
    (OUT / "risultati.json").write_text(json.dumps(results, ensure_ascii=False, indent=0))
    # fogli: 30 set per foglio, una riga per set
    T = 150
    for n in range(0, len(sheet_rows), 30):
        rows = sheet_rows[n:n + 30]
        sheet = Image.new("RGB", (T * 9, (T + 30) * len(rows)), "white")
        d = ImageDraw.Draw(sheet)
        for r, (res, ref_im, thumbs) in enumerate(rows):
            y = r * (T + 30)
            d.text((2, y + T + 2), f"{res['set']} {res['year']}", fill="black")
            if ref_im:
                t = ref_im.copy()
                t.thumbnail((T, T))
                sheet.paste(t, (0, y))
            ok = [c for c in res["c"] if "err" not in c]
            for k, (c, im) in enumerate(zip(ok[:8], thumbs[:8])):
                t = im.copy()
                t.thumbnail((T - 4, T))
                sheet.paste(t, (T * (k + 1) + 2, y))
                d.text((T * (k + 1) + 2, y + T + 2), f"{k} L{c['logo']} e{c['edge']} f{c['fill']}", fill="blue")
                d.text((T * (k + 1) + 2, y + T + 14), f"i{c['inl']} a{c['area']} g{c['good']}", fill="red")
        sheet.save(OUT / f"foglio-{n // 30}.jpg", quality=80)
    print("fatto", len(results))


if __name__ == "__main__":
    main()
