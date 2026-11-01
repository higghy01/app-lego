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
BRICKSET_FRONTS = DATA_SRC / "brickset-fronti.json"
NO_MAIN_PHOTO = DATA_SRC / "brickset-senza-foto-principale.txt"
# 1/11 (sasha: "trovare le altre foto"): fronte scelto guardando le foto, set per set, dove il nome non basta
CHOSEN_FRONTS = DATA_SRC / "brickset-fronti-scelti.json"
BRICKSET_IMG = "https://images.brickset.com/sets/"
DETAIL_FILES = 64  # descrizioni e foto divise in tanti file piccoli: l'app apre solo quello del set


# Copertine delle categorie (sasha 31/10: "un'immagine che rappresenta il brand del set o una cosa chiave,
# tipo Marvel metti gli Avengers"): i personaggi simbolo di ogni tema, con le foto delle minifigure di Rebrickable.
# Scelti a mano (numero della minifigure su Rebrickable), solo quelli con la foto su sfondo bianco (guardate 31/10;
# verifica 1/11: misurato il bordo di ogni foto, cambiati quelli su grigio che facevano un riquadro: Iron Man, Batman, Superman,
# Joker, Nya, Jay, Spaceman, 2 Minions, Rufy, Zoro, Tails). I temi senza personaggi (Technic, Botanicals, Art...)
# mostrano il loro set simbolo montato (in app.js, THEME_COVERS), mai la foto della scatola degli elenchi.
THEME_FIGS = {
    "Super Heroes Marvel": ["fig-015921", "fig-011410", "fig-012329", "fig-010827"],  # Iron Man, Captain America, Thor, Spider-Man
    "Star Wars": ["fig-013445", "fig-002086", "fig-002687"],  # Darth Vader, Yoda, R2-D2
    "Super Heroes DC": ["fig-014213", "fig-016514", "fig-005231", "fig-004978"],  # Batman, Superman, Wonder Woman, Joker
    "Harry Potter": ["fig-006052", "fig-006059", "fig-006051", "fig-006056"],  # Harry, Hermione, Ron, Silente
    "Ninjago": ["fig-013771", "fig-013769", "fig-014587", "fig-016193"],  # Lloyd, Kai, Nya, Jay
    "Friends": ["fig-015747", "fig-015783", "fig-013293", "fig-013286"],  # Aliya, Liann, Autumn, Leo
    "Disney": ["fig-005753", "fig-002093", "fig-013377", "fig-010624"],  # Topolino, Elsa, Vaiana, Ariel
    "Minecraft": ["fig-002118", "fig-001683", "fig-006478", "fig-006477"],  # Steve, Alex, Creeper, Zombie
    "Jurassic World": ["fig-001846", "fig-002553", "fig-012503"],  # Owen, Claire, Ellie
    "Dreamzzz": ["fig-014147", "fig-014169", "fig-015802", "fig-014139"],  # Mateo, Izzie, Cooper, Z-Blob
    "Monkie Kid": ["fig-011144", "fig-011137"],  # Re Scimmia, Mei
    "Collectible Minifigures": ["fig-017907", "fig-001350", "fig-001271"],  # Spaceman, Hot Dog, Banana
    "Seasonal": ["fig-001479"],  # Babbo Natale
    "Despicable Me 4": ["fig-014979", "fig-011252", "fig-011250", "fig-014985"],  # Gru e i Minions (Kevin, Bob, Tim)
    "Bluey": ["fig-016276", "fig-016277", "fig-016279", "fig-016278"],  # Bluey, Bingo, Bandit, Chilli
    "Fortnite": ["fig-015563", "fig-015565", "fig-015567"],  # Raven, Cuddle Team Leader, Brite Bomber
    "One Piece": ["fig-016647", "fig-016651", "fig-016625", "fig-016631"],  # Rufy, Zoro, Nami, Usopp
    "Sonic The Hedgehog": ["fig-014177"],  # Sonic (Tails e gli altri hanno la foto su sfondo grigio)
    "Wednesday": ["fig-015534", "fig-015535"],  # Mercoledi', Enid
    "Gabby's Dollhouse": ["fig-014172", "fig-014170", "fig-014171"],  # Gabby, Pandy Paws, MerCat
    "The Legend of Zelda": ["fig-015499", "fig-015500", "fig-017467"],  # Link, Zelda, Ganondorf
    "Animal Crossing": ["fig-014745", "fig-014744"],  # Tom Nook, Fuffi
    "City": ["fig-002153", "fig-009057", "fig-008094"],  # Duke DeTain, Harl Hubbs, Freya McCloud
}


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


def box_rank(img, alt1_box=True):
    """0 fronte della scatola (Box1, Box_front, "-xx-23-"), 1 scatola col set montato (boxprod, "<set>.png"), 2 altre foto
    della scatola (Box2, Box5...), 2.5 retro (Box_back), 2.8 "alt1", 3 tutto il resto. Brickset non le mette sempre in quest'ordine.
    Controllato guardando le foto (31/10): "NNNN-0000-xx-23-1" (set 2000-2012) e' sempre la scatola; "alt1" (set dal 2010)
    quasi sempre, tranne nei set con foto "1to1" (alt1_box=False), dove spesso e' il modello o una foto d'ambiente.
    Verifica 31/10: la foto che si chiama solo col numero del set e ".png" (es. 60432.png) e' la scatola col set montato (30 su 30)."""
    path = img[0].rsplit("/", 2)
    name = path[-1].lower()
    if len(path) == 3 and re.fullmatch(re.escape(path[-2].split("-")[0].lower()) + r"\.png(\.jpg)?", name):
        return 1
    m = re.search(r"(?:^|[_ -]|\d)(?:box(\d*|prod\d*|pod|front|back)|packaging)(?=[_. (-]|v\d|$)", name)
    # "Lifestyle_packaging" e' una foto d'ambiente, non la scatola
    if not m or "lifestyle" in name:
        if re.search(r"-xx-23-", name):
            return 0
        if alt1_box and re.search(r"(?:^|[_-])alt1(?=[._]|$)", name):
            return 2.8
        return 3
    if (m.group(1) or "") == "1" or "front" in name:
        return 0
    return 1 if (m.group(1) or "").startswith(("prod", "pod")) else 2.5 if "back" in name else 2


# Parole che vogliono dire "non e' il fronte": retro, interno, scatola aperta, di lato, piu' scatole insieme (anche in tedesco).
NOT_FRONT = re.compile(r"back|hinten|rear|innen|inside|open|deckel|seitl|schr|vergleich|boxen|lifestyle|packaging")
BOX_WORD = re.compile(r"(?:^|[_ -]|\d)box(\d*|prod\d*|pod|front|[ab]1)(?=[_. (-]|v\d|$)")


def front_kind(img, year=None):
    """Cosa mostra una foto Brickset, dal nome (sasha 31/10: negli elenchi SOLO il fronte della scatola).
    Guardate ~600 foto: Box1, Box3, Box4, "box", "Box-Front", "Box-vorne", "-xx-23-" = fronte; Box2 = fronte dal 2000
    (nei set vecchi e' il retro); Box5, Box6, "back", "hinten" = retro; "boxprod" e "<set>.png" = scatola con davanti
    il set montato; "alt1" = quasi sempre il fronte; foto con un numero a caso (75645_98067) = a volte il fronte.
    Ritorna "front" (sicuro), "alt1", "num", "prod" (da guardare con fronti_scatola.py) o None."""
    path = img[0].rsplit("/", 2)
    name = re.sub(r"(\.(jpe?g|png))+$", "", path[-1].lower())
    if len(path) == 3 and re.fullmatch(re.escape(path[-2].split("-")[0].lower()) + r"\.png(\.jpg)?", path[-1].lower()):
        return "prod"
    if NOT_FRONT.search(name):
        return None
    if "-xx-23-" in name:
        return "front"
    m = BOX_WORD.search(name)
    if m:
        kind = m.group(1)
        if kind.startswith(("prod", "pod")):
            return "prod"
        if kind in ("", "1", "3", "4", "front", "a1", "b1") or "vorne" in name:
            return "front"
        if kind == "2" and (year or 0) >= 2000:
            return "front"
        return None
    if re.search(r"(?:^|[_-])alt1(?=[._]|$)", name):
        return "alt1"
    if re.fullmatch(r"\d+[-_]\d{4,6}", name):
        return "num"
    return None


def front_candidates(set_num, imgs):
    """Foto che fronti_scatola.py deve guardare: alt1, foto con nome a caso, scatola+set (da ritagliare)."""
    return [(img, {"alt1": "logo", "prod": "crop"}[k]) for img in imgs
            for k in [front_kind(img)] if k in ("alt1", "prod")]


def pick_front(imgs, year, checked):
    """La foto per gli elenchi: solo il fronte della scatola. Ritorna (foto, ritaglio o None) oppure None.
    checked = risultati di fronti_scatola.py ({foto: {"f": 0|1, "crop": [...]}})."""
    # Le foto con un nome a caso non si usano: guardate 84, una su quattro e' il retro della scatola.
    order = {"front": 0, "alt1": 1, "prod": 2}
    best = None
    for img in imgs:
        k = front_kind(img, year)
        if k is None or k == "num":
            continue
        seen = checked.get(img[0])
        if k == "alt1" and not (seen["f"] if seen else alt1_is_box(imgs)):
            continue
        if k == "prod" and not (seen and seen.get("crop")):
            continue
        # alt1 ritagliata (verifica 1/11): era la scatola piccola + il set montato, come boxprod
        crop = seen.get("crop") if seen and k in ("prod", "alt1") else None
        cand = (order["prod"] if crop else order[k], photo_order(img), img, crop)
        if best is None or cand[:2] < best[:2]:
            best = cand
    return (best[2], best[3]) if best else None


def alt1_is_box(imgs):
    """Nei set con foto "1to1" (2019-2021) la foto alt1 spesso non e' la scatola."""
    return not any("1to1" in i[0].lower() for i in imgs)


def photo_order(img, alt1_box=True):
    """La scatola per prima, poi le altre foto in ordine di nome, con i numeri contati come numeri
    (Brickset da' alt1, alt10, alt11, alt2: noi alt1, alt2 ... alt10)."""
    name = re.sub(r"(\.(jpe?g|png))+$", "", img[0].rsplit("/", 1)[-1].lower())
    return box_rank(img, alt1_box), [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", name)]


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
        # "1 pezzo" invece e' quasi sempre un gadget (CD, tappetino, sensore): resta senza numero, come prima.
        if not row[4] and (extra.get(s["set_num"], {}).get("pcs") or 0) > 1:
            row[4] = extra[s["set_num"]]["pcs"]
            row.append("Brickset")
            n_pcs += 1
            # Inventario vuoto: anche "0 minifigure" non e' un dato vero, meglio "non disponibile".
            if not n_figs:
                row[6] = None
        sets.append(row)
    sets.sort(key=lambda r: (-(r[2] or 0), r[0]))

    # Personaggi simbolo di ogni tema principale (copertine delle categorie), solo se Rebrickable ha la foto.
    all_figs = {m["fig_num"]: short_img(m["img_url"]) for m in data["minifigs"] if m["img_url"]}
    theme_figs = {}
    for tid, (name, parent) in themes.items():
        if parent is None and name in THEME_FIGS:
            imgs = [all_figs[f] for f in THEME_FIGS[name] if f in all_figs]
            if imgs:
                theme_figs[tid] = imgs

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    catalog = {"generated": generated, "source": "Rebrickable", "imgBase": IMG_PREFIX,
               "fields": ["set_num", "name", "year", "theme_id", "num_parts", "img", "num_minifigs", "parts_from"],
               "themes": themes, "sets": sets, "themeFigs": theme_figs}
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
    years = {r[0]: r[2] for r in sets}
    checked = json.loads(BRICKSET_FRONTS.read_text(encoding="utf-8"))["imgs"] if BRICKSET_FRONTS.exists() else {}
    n_front = [0, 0]
    # Fronte scelto a occhio: vince sulle regole del nome (foto con nomi a caso, dove una su quattro e' il retro).
    chosen_file = json.loads(CHOSEN_FRONTS.read_text(encoding="utf-8")) if CHOSEN_FRONTS.exists() else {}
    chosen = chosen_file.get("sets", {})
    # 1/11 sera: per le foto "scatola + set" scelte a mano che il programma non sapeva ritagliare, il ritaglio misurato a occhio
    chosen_crops = chosen_file.get("crops", {})
    chosen_main = set()
    if BRICKSET_PHOTOS.exists():
        for set_num, info in json.loads(BRICKSET_PHOTOS.read_text(encoding="utf-8"))["sets"].items():
            if not info["imgs"]:
                continue
            alt1_box = alt1_is_box(info["imgs"])
            # la scatola sempre per prima, senza doppioni
            imgs = unique_photos(sorted(info["imgs"], key=lambda i: photo_order(i, alt1_box)))
            pick = chosen.get(set_num)
            if pick == "-":
                front = None  # guardate a occhio: nessuna foto e' il fronte (es. alt1 col set montato), meglio niente che il modello
            elif pick and pick.startswith("images/"):
                chosen_main.add(set_num)  # la foto principale di Brickset e' il fronte: "box": 1 qui sotto
                front = None
            else:
                front = next(((i, chosen_crops.get(set_num) or (checked.get(i[0]) or {}).get("crop")) for i in imgs if i[0] == pick),
                             None) or pick_front(imgs, years.get(set_num), checked)
            if front:
                # il fronte della scatola per primo anche nella galleria, poi le altre foto
                imgs = [front[0]] + [i for i in imgs if i is not front[0]]
                if set_num in extra:
                    extra[set_num]["box"] = front[0]  # fronte della scatola, per gli elenchi
                    if front[1]:
                        extra[set_num]["crop"] = front[1]  # foto "scatola + set": si mostra solo la scatola
                    n_front[front[1] is not None] += 1
            details[set_num]["imgs"] = imgs
    # Set senza foto della scatola tra quelle in piu': si usa la foto principale di Brickset (images/<set>.jpg).
    # Verifica 31/10 (guardate ~1.700 foto): per i set vecchi e per quelli senza foto in piu' e' quasi sempre
    # la scatola o la bustina; anche per i set con foto in piu' ma senza scatola riconosciuta lo e' spesso
    # (giochi, set promozionali, set 2005-2012), e quando non lo e' mostra il set montato, come la foto di Rebrickable.
    # Non per i set dove Brickset non ha la foto principale (elenco controllato, o "nomain" dal download).
    # "box": 1 vuol dire "foto principale di Brickset", l'app ricostruisce l'indirizzo.
    no_main = set()
    if NO_MAIN_PHOTO.exists():
        no_main = {l.strip() for l in NO_MAIN_PHOTO.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")}
    n_main = 0
    has_photos = {k for k, d in details.items() if d.get("imgs")}
    for set_num, info in extra.items():
        missing = info.pop("nomain", False) or set_num in no_main
        if "box" in info or set_num not in years or missing:
            continue
        # 31/10 (guardate di nuovo ~150 foto principali): fino al 2009 sono il fronte della scatola o della bustina;
        # dal 2010, nei set con altre foto, sono quasi sempre il set montato: li' niente.
        if (years[set_num] or 0) >= 2010 and set_num in has_photos and set_num not in chosen_main:
            continue
        info["box"] = 1
        n_main += 1
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
               f"{n_desc} con descrizione, {n_photos} con foto in piu', {n_pcs} con pezzi da Brickset, "
               f"{n_front[0]} con il fronte della scatola, {n_front[1]} con la scatola ritagliata dalla foto scatola+set, {n_main} con la foto principale di Brickset")
    print(f"{summary} -> {out}")
    if os.environ.get("GITHUB_ACTIONS"):
        sample = {s[0]: s[1:] for s in sets if s[0] in ("10294-1", "75192-1")}
        print(f"::notice title=Catalogo::{summary}. Esempi: {json.dumps(sample, ensure_ascii=False)}")
        # 1/11 (Sagrada Familia): set recenti con foto in piu' ma senza fronte della scatola riconosciuto. Vanno guardati
        # a occhio e aggiunti a brickset-fronti-scelti.json (le foto col nome a caso, tipo 21065_15430, non si riconoscono).
        recent = sorted(k for k, v in extra.items() if "box" not in v and (years.get(k) or 0) >= max((y or 0 for y in years.values()), default=0) - 1
                        and k in has_photos and re.fullmatch(r"\d{4,5}-1", k))
        if recent:
            print(f"::warning title=Senza scatola::{len(recent)} set recenti con foto ma senza fronte della scatola: {' '.join(recent[:60])}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("out_dir")
    parser.add_argument("--src", help="cartella con i CSV gia' scaricati")
    args = parser.parse_args()
    build(args.out_dir, args.src)
