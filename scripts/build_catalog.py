"""Scarica i dati di Rebrickable e crea i file JSON usati dall'app.

Uso:
    python scripts/build_catalog.py OUT_DIR            # scarica da Rebrickable
    python scripts/build_catalog.py OUT_DIR --src DIR  # usa CSV gia' scaricati
"""
import argparse
import csv
import gzip
import html
import io
import json
import os
import re
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from fetch_brickset import plain_text

BASE_URL = "https://cdn.rebrickable.com/media/downloads/"
FILES = ["themes", "sets", "inventories", "inventory_minifigs", "inventory_sets", "minifigs"]
IMG_PREFIX = "https://cdn.rebrickable.com/media/"
DATA_SRC = Path(__file__).resolve().parent.parent / "data-src"
BRICKSET_FILE = DATA_SRC / "brickset.json"
BRICKSET_TEXTS = DATA_SRC / "brickset-testi.json"
BRICKSET_PHOTOS = DATA_SRC / "brickset-foto.json"
BRICKSET_IMG = "https://images.brickset.com/sets/"
DETAIL_FILES = 64  # descrizioni e foto divise in tanti file piccoli: l'app apre solo quello del set


def detail_file(set_num):
    """Numero del file con i dettagli del set; l'app fa lo stesso calcolo (detailFile in app.js)."""
    h = 0
    for ch in set_num:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return h % DETAIL_FILES

csv.field_size_limit(sys.maxsize)


def read_csv(name, src):
    if src:
        path = Path(src) / f"{name}.csv"
        if not path.exists():
            path = Path(src) / f"{name}.csv.gz"
        raw = path.read_bytes()
    else:
        req = urllib.request.Request(BASE_URL + f"{name}.csv.gz",
                                     headers={"User-Agent": "app-lego-catalog/1.0"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))


def short_img(url):
    # Le immagini stanno quasi tutte sotto lo stesso indirizzo: lo togliamo per
    # rendere il file piu' leggero, l'app lo rimette.
    url = (url or "").strip()
    return url[len(IMG_PREFIX):] if url.startswith(IMG_PREFIX) else url


def to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def box_rank(img):
    """0 fronte della scatola (Box1, Box_front), 1 scatola col set montato (boxprod), 2 altre foto
    della scatola (Box2, Box5...), 2.5 retro (Box_back), 3 tutto il resto. Brickset non le mette sempre in quest'ordine."""
    name = img[0].rsplit("/", 1)[-1].lower()
    m = re.search(r"(?:^|[_ -]|\d)(?:box(\d*|prod\d*|pod|front|back)|packaging)(?=[_. (-]|v\d|$)", name)
    # "Lifestyle_packaging" e' una foto d'ambiente, non la scatola
    if not m or "lifestyle" in name:
        return 3
    if (m.group(1) or "") == "1" or "front" in name:
        return 0
    return 1 if (m.group(1) or "").startswith(("prod", "pod")) else 2.5 if "back" in name else 2


def photo_order(img):
    """La scatola per prima, poi le altre foto in ordine di nome, con i numeri contati come numeri
    (Brickset da' alt1, alt10, alt11, alt2: noi alt1, alt2 ... alt10)."""
    name = re.sub(r"(\.(jpe?g|png))+$", "", img[0].rsplit("/", 1)[-1].lower())
    return box_rank(img), [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", name)]


def same_photo(img):
    """Brickset a volte ha la stessa foto due volte, in versioni o lingue diverse
    (10371_Box1_v29 e 10371_Box1_v39, 75402_box5_v39 e 75402_box5_v39_en-gb, x.jpeg.jpg e x.jpg)."""
    name = img[0].rsplit("/", 1)[-1].lower()
    name = re.sub(r"\.(jpe?g|png)", "", name)
    return re.sub(r"_(v\d{2,3}|[a-z]{2}-[a-z]{2})(?=_|$)", "", name)


def unique_photos(imgs):
    seen, out = set(), []
    for img in imgs:
        key = same_photo(img)
        if key not in seen:
            seen.add(key)
            out.append(img)
    return out


def clean_desc(desc):
    """Toglie i "\\u0026" letterali, l'HTML rimasto (<i>, &lt;p&gt;) e i segnaposto ("Description", "tbd-SW-1")."""
    desc = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), desc)
    if re.search(r"<[a-zA-Z/]|&[a-zA-Z#0-9]+;", desc):
        desc = plain_text(html.unescape(desc).replace("\n", "<br>"))
    return "" if desc.strip().lower() in ("description", "") or desc.lower().startswith("tbd") else desc


def build(out_dir, src=None):
    data = {name: read_csv(name, src) for name in FILES}

    themes = {int(t["id"]): [t["name"], to_int(t["parent_id"])] for t in data["themes"]}

    # Per ogni set teniamo solo l'inventario principale (versione piu' bassa).
    main_inv = {}
    for inv in data["inventories"]:
        version = to_int(inv["version"]) or 1
        current = main_inv.get(inv["set_num"])
        if current is None or version < current[1]:
            main_inv[inv["set_num"]] = (inv["id"], version)
    inv_to_set = {inv_id: set_num for set_num, (inv_id, _) in main_inv.items()}

    own_figs = defaultdict(list)
    for row in data["inventory_minifigs"]:
        set_num = inv_to_set.get(row["inventory_id"])
        if set_num:
            own_figs[set_num].append([row["fig_num"], to_int(row["quantity"]) or 1])

    # Alcuni set (confezioni, collezioni) contengono altri set: le loro minifigure
    # vanno contate insieme, moltiplicate per la quantita'.
    sub_sets = defaultdict(list)
    for row in data["inventory_sets"]:
        set_num = inv_to_set.get(row["inventory_id"])
        if set_num:
            sub_sets[set_num].append((row["set_num"], to_int(row["quantity"]) or 1))

    def all_figs(set_num, seen=()):
        totals = defaultdict(int)
        for fig, qty in own_figs.get(set_num, []):
            totals[fig] += qty
        for sub, qty in sub_sets.get(set_num, []):
            if sub in seen:
                continue
            for fig, sub_qty in all_figs(sub, seen + (set_num,)).items():
                totals[fig] += sub_qty * qty
        return totals

    set_figs = {}
    for set_num in main_inv:
        totals = all_figs(set_num)
        if totals:
            set_figs[set_num] = [[fig, qty] for fig, qty in totals.items()]

    used_figs = {fig for figs in set_figs.values() for fig, _ in figs}
    figs = {m["fig_num"]: [m["name"], to_int(m["num_parts"]), short_img(m["img_url"])]
            for m in data["minifigs"] if m["fig_num"] in used_figs}

    # Dati Brickset (codici a barre, eta', prezzi, date di uscita), se gia' scaricati.
    extra = {}
    if BRICKSET_FILE.exists():
        for year in json.loads(BRICKSET_FILE.read_text(encoding="utf-8"))["years"].values():
            extra.update(year["sets"])

    sets = []
    n_pcs = 0
    for s in data["sets"]:
        n_figs = sum(q for _, q in set_figs.get(s["set_num"], []))
        row = [s["set_num"], s["name"], to_int(s["year"]), to_int(s["theme_id"]),
               to_int(s["num_parts"]), short_img(s["img_url"]),
               n_figs if s["set_num"] in main_inv else None]
        # Rebrickable da' 0 pezzi ai set appena annunciati (inventario non ancora caricato): l'app li
        # nasconderebbe come gadget. Se Brickset conosce il numero di pezzi lo usiamo, segnando da dove viene.
        if not row[4] and extra.get(s["set_num"], {}).get("pcs"):
            row[4] = extra[s["set_num"]]["pcs"]
            row.append("Brickset")
            n_pcs += 1
        sets.append(row)
    sets.sort(key=lambda r: (-(r[2] or 0), r[0]))

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    catalog = {"generated": generated, "source": "Rebrickable", "imgBase": IMG_PREFIX,
               "fields": ["set_num", "name", "year", "theme_id", "num_parts", "img", "num_minifigs", "parts_from"],
               "themes": themes, "sets": sets}
    minifigs = {"generated": generated, "imgBase": IMG_PREFIX,
                "figs": figs, "sets": set_figs}
    # Descrizioni, tag e foto in piu': in file separati, letti solo aprendo la scheda del set.
    details = defaultdict(dict)
    if BRICKSET_TEXTS.exists():
        for year in json.loads(BRICKSET_TEXTS.read_text(encoding="utf-8"))["years"].values():
            for set_num, text in year["sets"].items():
                if text.get("desc"):
                    text["desc"] = clean_desc(text["desc"])
                    if not text["desc"]:
                        del text["desc"]
                details[set_num].update(text)
    if BRICKSET_PHOTOS.exists():
        for set_num, info in json.loads(BRICKSET_PHOTOS.read_text(encoding="utf-8"))["sets"].items():
            if not info["imgs"]:
                continue
            imgs = unique_photos(sorted(info["imgs"], key=photo_order))  # la scatola sempre per prima, senza doppioni
            details[set_num]["imgs"] = imgs
            if box_rank(imgs[0]) < 3 and set_num in extra:
                extra[set_num]["box"] = imgs[0]  # foto della scatola, per gli elenchi
    extra_file = {"generated": generated, "source": "Brickset", "imgBase": BRICKSET_IMG,
                  "detailFiles": DETAIL_FILES, "sets": extra}
    files = [("catalog.json", catalog), ("minifigs.json", minifigs), ("extra.json", extra_file)]
    buckets = defaultdict(dict)
    for set_num, info in details.items():
        buckets[detail_file(set_num)][set_num] = info
    for i in range(DETAIL_FILES):
        files.append((f"dettagli/{i}.json", {"generated": generated, "source": "Brickset",
                                             "imgBase": BRICKSET_IMG, "sets": buckets.get(i, {})}))
    (out / "dettagli").mkdir(exist_ok=True)
    for name, obj in files:
        (out / name).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")),
                                encoding="utf-8")
    n_photos = sum(1 for d in details.values() if d.get("imgs"))
    n_desc = sum(1 for d in details.values() if d.get("desc"))
    summary = (f"{len(sets)} set, {len(themes)} temi, {len(figs)} minifigure, {len(extra)} set con dati Brickset, "
               f"{n_desc} con descrizione, {n_photos} con foto in piu', {n_pcs} con pezzi da Brickset")
    print(f"{summary} -> {out}")
    if os.environ.get("GITHUB_ACTIONS"):
        sample = {s[0]: s[1:] for s in sets if s[0] in ("10294-1", "75192-1")}
        print(f"::notice title=Catalogo::{summary}. Esempi: {json.dumps(sample, ensure_ascii=False)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("out_dir")
    parser.add_argument("--src", help="cartella con i CSV gia' scaricati")
    args = parser.parse_args()
    build(args.out_dir, args.src)
