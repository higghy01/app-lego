"""Scarica i dati di Rebrickable e crea i file JSON usati dall'app.

Uso:
    python scripts/build_catalog.py OUT_DIR            # scarica da Rebrickable
    python scripts/build_catalog.py OUT_DIR --src DIR  # usa CSV gia' scaricati
"""
import argparse
import csv
import gzip
import io
import json
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

BASE_URL = "https://cdn.rebrickable.com/media/downloads/"
FILES = ["themes", "sets", "inventories", "inventory_minifigs", "minifigs"]
IMG_PREFIX = "https://cdn.rebrickable.com/media/"

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

    set_figs = defaultdict(list)
    for row in data["inventory_minifigs"]:
        set_num = inv_to_set.get(row["inventory_id"])
        if set_num:
            set_figs[set_num].append([row["fig_num"], to_int(row["quantity"]) or 1])

    used_figs = {fig for figs in set_figs.values() for fig, _ in figs}
    figs = {m["fig_num"]: [m["name"], to_int(m["num_parts"]), short_img(m["img_url"])]
            for m in data["minifigs"] if m["fig_num"] in used_figs}

    sets = []
    for s in data["sets"]:
        n_figs = sum(q for _, q in set_figs.get(s["set_num"], []))
        sets.append([s["set_num"], s["name"], to_int(s["year"]), to_int(s["theme_id"]),
                     to_int(s["num_parts"]), short_img(s["img_url"]),
                     n_figs if s["set_num"] in main_inv else None])
    sets.sort(key=lambda r: (-(r[2] or 0), r[0]))

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    catalog = {"generated": generated, "source": "Rebrickable", "imgBase": IMG_PREFIX,
               "fields": ["set_num", "name", "year", "theme_id", "num_parts", "img", "num_minifigs"],
               "themes": themes, "sets": sets}
    minifigs = {"generated": generated, "imgBase": IMG_PREFIX,
                "figs": figs, "sets": dict(set_figs)}
    for name, obj in (("catalog.json", catalog), ("minifigs.json", minifigs)):
        (out / name).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")),
                                encoding="utf-8")
    print(f"{len(sets)} set, {len(themes)} temi, {len(figs)} minifigure -> {out}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("out_dir")
    parser.add_argument("--src", help="cartella con i CSV gia' scaricati")
    args = parser.parse_args()
    build(args.out_dir, args.src)
