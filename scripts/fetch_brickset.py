"""Scarica da Brickset codici a barre, eta', prezzi, date di uscita, descrizioni e foto dei set.

Brickset limita le chiamate giornaliere, quindi lo script lavora un po' alla
volta: ogni volta aggiorna gli anni piu' recenti e quelli non ancora scaricati
(o scaricati da piu' tempo). Salva in data-src/:
- brickset.json: dati brevi di ogni set (servono all'app subito);
- brickset-testi.json: descrizione e tag (l'app li carica solo aprendo la scheda);
- brickset-foto.json: le foto in piu' di ogni set, la scatola per prima.
Le foto si chiedono con getAdditionalImages, che non conta nel limite di getSets:
1500 set al giorno, partendo dai set piu' nuovi, solo dal 2000 in poi.

Uso: BRICKSET_API_KEY=... python scripts/fetch_brickset.py [--max-calls 60] [--max-images 1500]
"""
import argparse
import json
import os
import re
import sys
from html.parser import HTMLParser
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

API = "https://brickset.com/api/v3.asmx/"
DATA = Path(__file__).resolve().parent.parent / "data-src"
OUT = DATA / "brickset.json"
TEXTS = DATA / "brickset-testi.json"
PHOTOS = DATA / "brickset-foto.json"
FIRST_YEAR = 1949
PAGE_SIZE = 500
IMG_PREFIX = "https://images.brickset.com/sets/"
PHOTOS_REFRESH_DAYS = 30  # i set appena usciti ricevono foto nuove: si ricontrollano dopo un mese
PHOTOS_RETRY_DAYS = 7  # un set la cui richiesta di foto e' fallita si riprova dopo una settimana
PHOTOS_MAX_ERRORS = 3  # tanti errori di fila = limite o rete: ci si ferma fino a domani
PHOTOS_FIRST_YEAR = 0  # 31/10: finiti i set dal 2000, si chiedono anche quelli piu' vecchi (per la foto della scatola)


def call(key, params, method="getSets"):
    if method == "getSets":
        params = {"userHash": "", "params": json.dumps(params)}
    query = urllib.parse.urlencode({"apiKey": key, **params})
    req = urllib.request.Request(f"{API}{method}?{query}", headers={"User-Agent": "app-lego-catalog/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if data.get("status") != "success":
        raise RuntimeError(f"Brickset: {data.get('message') or data}")
    return data


def compact(s):
    """Tiene solo i dati che servono all'app; i campi mancanti restano assenti."""
    out = {}
    barcode = s.get("barcode") or {}
    if barcode.get("EAN"):
        out["ean"] = str(barcode["EAN"]).strip()
    if barcode.get("UPC"):
        out["upc"] = str(barcode["UPC"]).strip()
    age = s.get("ageRange") or {}
    if age.get("min") or age.get("max"):
        out["age"] = [age.get("min"), age.get("max")]
    prices = {}
    for country, info in (s.get("LEGOCom") or {}).items():
        if isinstance(info, dict) and info.get("retailPrice"):
            prices[country] = info["retailPrice"]
    if prices:
        out["price"] = prices
    if s.get("rating"):
        out["rating"] = s["rating"]
    if s.get("instructionsCount"):
        out["instr"] = s["instructionsCount"]
    if s.get("bricksetURL"):
        out["url"] = s["bricksetURL"]
    if s.get("setID"):
        out["id"] = s["setID"]
    for field, name in (("launchDate", "launch"), ("exitDate", "exit")):
        if s.get(field):
            out[name] = str(s[field])[:10]  # solo AAAA-MM-GG
    if s.get("availability"):
        out["avail"] = s["availability"]
    if is_build_together(tags_of(s)):
        out["bt"] = True
    if s.get("additionalImageCount"):
        out["nimg"] = s["additionalImageCount"]
    # Numero di pezzi: serve quando Rebrickable non ce l'ha ancora (set appena annunciati, senza inventario).
    if s.get("pieces"):
        out["pcs"] = int(s["pieces"])
    return out


def tags_of(s):
    return [str(t).strip() for t in ((s.get("extendedData") or {}).get("tags") or []) if str(t).strip()]


def is_build_together(tags):
    # Il nome del tag su Brickset puo' cambiare un po' (spazi, trattini, maiuscole).
    return any(re.sub(r"[^a-z]", "", t.lower()) == "buildtogether" for t in tags)


class _Text(HTMLParser):
    BREAKS = {"p", "br", "li", "div", "h1", "h2", "h3", "h4", "ul", "ol"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in self.BREAKS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        self.handle_starttag(tag, [])

    def handle_data(self, data):
        self.parts.append(data)


def plain_text(html):
    """La descrizione arriva in HTML: teniamo solo il testo, a paragrafi."""
    # Brickset a volte lascia sequenze JSON letterali come "\\u0026" (&) nel testo.
    html = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), html)
    parser = _Text()
    parser.feed(html)
    parser.close()
    lines = (re.sub(r"\s+", " ", line).strip() for line in "".join(parser.parts).split("\n"))
    return "\n".join(line for line in lines if line)


def texts_of(s):
    out = {}
    description = plain_text((s.get("extendedData") or {}).get("description") or "")
    if description:
        out["desc"] = description
    tags = tags_of(s)
    if tags:
        out["tags"] = tags
    return out


def short_img(url):
    url = (url or "").strip()
    return url[len(IMG_PREFIX):] if url.startswith(IMG_PREFIX) else url


def order_photos(images):
    """Prima le foto della scatola (Box1 o Box_front, poi boxprod, poi Box2, Box5..., il retro per ultimo), poi le altre come le da' Brickset."""
    def box_rank(img):
        name = img[0].rsplit("/", 1)[-1].lower()
        m = re.search(r"(?:^|[_ -]|\d)(?:box(\d*|prod\d*|pod|front|back)|packaging)(?=[_. (-]|v\d|$)", name)
        # "Lifestyle_packaging" e' una foto d'ambiente, non la scatola
        if not m or "lifestyle" in name:
            return 3
        if (m.group(1) or "") == "1" or "front" in name:
            return 0
        return 1 if (m.group(1) or "").startswith(("prod", "pod")) else 2.5 if "back" in name else 2
    return sorted(images, key=box_rank)


def fetch_year(key, year, budget):
    sets, texts, page, calls = {}, {}, 1, 0
    while True:
        if calls >= budget:
            return None, None, calls  # anno non completato: si riprova la prossima volta
        # extendedData aggiunge descrizione e tag alle stesse chiamate di prima.
        data = call(key, {"year": str(year), "pageSize": PAGE_SIZE, "pageNumber": page, "extendedData": 1})
        calls += 1
        for s in data.get("sets") or []:
            set_num = f"{s['number']}-{s.get('numberVariant') or 1}"
            info = compact(s)
            if info:
                sets[set_num] = info
            text = texts_of(s)
            if text:
                texts[set_num] = text
        if len(data.get("sets") or []) < PAGE_SIZE:
            return sets, texts, calls
        page += 1


def photos_todo(years, photos, today):
    """Set con foto in piu' da chiedere: prima i mai chiesti, i piu' nuovi in testa."""
    never, stale = [], []
    for year, info in years.items():
        for set_num, s in info["sets"].items():
            if not s.get("id") or not s.get("nimg") or int(year) < PHOTOS_FIRST_YEAR:
                continue
            key = (s.get("launch") or year, set_num)
            done = photos.get(set_num)
            if done is None:
                never.append(key)
            elif done.get("nimg") != s["nimg"] or (
                    done.get("err") and (today - date.fromisoformat(done["fetched"])).days >= PHOTOS_RETRY_DAYS) or (
                    int(year) >= today.year - 1
                    and (today - date.fromisoformat(done["fetched"])).days >= PHOTOS_REFRESH_DAYS):
                stale.append((done["fetched"], set_num))
    never.sort(reverse=True)
    stale.sort()
    return [n for _, n in never] + [n for _, n in stale]


def fetch_photos(key, years, photos, budget, today):
    """Restituisce (foto chieste, set non riusciti). Un set che da' errore viene saltato
    e riprovato tra qualche giorno, cosi' non blocca la coda; dopo qualche errore di fila
    (probabile limite o rete) ci si ferma e quei set restano in coda per domani."""
    by_num = {n: s for info in years.values() for n, s in info["sets"].items()}
    done, failed, streak = 0, 0, []

    def skip(nums):
        for n in nums:  # le foto gia' salvate restano, si segna solo di riprovare piu' avanti
            photos[n] = {**photos.get(n, {"imgs": []}), "fetched": today.isoformat(), "nimg": by_num[n]["nimg"], "err": True}
        return len(nums)

    for set_num in photos_todo(years, photos, today)[:budget]:
        s = by_num[set_num]
        try:
            data = call(key, {"setID": s["id"]}, method="getAdditionalImages")
        except Exception as err:  # noqa: BLE001 - un set sbagliato non deve fermare gli altri
            print(f"Foto non riuscite per {set_num}: {err}")
            streak.append(set_num)
            if len(streak) >= PHOTOS_MAX_ERRORS:
                return done, failed
            continue
        failed += skip(streak)
        streak = []
        images = [[short_img(i.get("imageURL")), short_img(i.get("thumbnailURL"))]
                  for i in data.get("additionalImages") or [] if i.get("imageURL")]
        photos[set_num] = {"fetched": today.isoformat(), "nimg": s["nimg"], "imgs": order_photos(images)}
        done += 1
    return done, failed + skip(streak)


def load(path, field):
    return json.loads(path.read_text(encoding="utf-8"))[field] if path.exists() else {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-calls", type=int, default=60)
    parser.add_argument("--max-images", type=int, default=1500)
    args = parser.parse_args()
    key = os.environ.get("BRICKSET_API_KEY", "").strip()
    if not key:
        print("Nessuna chiave Brickset: salto l'aggiornamento.")
        return

    years = load(OUT, "years")
    texts = load(TEXTS, "years")
    photos = load(PHOTOS, "sets")
    this_year = date.today().year
    all_years = [str(y) for y in range(FIRST_YEAR, this_year + 2)]
    recent = [str(this_year + 1), str(this_year), str(this_year - 1)]
    missing = [y for y in all_years if y not in years and y not in recent]
    oldest = sorted((y for y in all_years if y in years and y not in recent),
                    key=lambda y: years[y]["fetched"])
    todo = recent + missing + oldest

    budget, done, n_photos, n_failed = args.max_calls, [], 0, 0
    today = datetime.now(timezone.utc).date()
    error = None
    try:
        for year in todo:
            if budget <= 0:
                break
            sets, year_texts, calls = fetch_year(key, year, budget)
            budget -= calls
            if sets is None:
                break
            years[year] = {"fetched": today.isoformat(), "sets": sets}
            texts[year] = {"fetched": today.isoformat(), "sets": year_texts}
            done.append(year)
    except Exception as err:  # noqa: BLE001 - se getSets e' finito, le foto si chiedono lo stesso
        error = err
    try:
        n_photos, n_failed = fetch_photos(key, years, photos, args.max_images, today)
    finally:
        save(years, texts, photos, done, n_photos, n_failed)  # anche se Brickset si ferma a meta', quanto scaricato resta
    if error:
        raise error


def write_lines(path, field, items):
    # Una riga per anno (o per set): le modifiche restano piccole e leggibili.
    lines = ",\n".join(f"{json.dumps(k)}:{json.dumps(items[k], ensure_ascii=False, sort_keys=True, separators=(',', ':'))}"
                       for k in sorted(items))
    path.write_text(f'{{"{field}":{{\n' + lines + "\n}}\n", encoding="utf-8")


def save(years, texts, photos, done, n_photos, n_failed=0):
    DATA.mkdir(parents=True, exist_ok=True)
    write_lines(OUT, "years", years)
    write_lines(TEXTS, "years", texts)
    write_lines(PHOTOS, "sets", photos)
    all_sets = [s for v in years.values() for s in v["sets"].values()]
    n_bt = sum(1 for s in all_sets if s.get("bt"))
    n_desc = sum(1 for v in texts.values() for t in v["sets"].values() if t.get("desc"))
    summary = (f"Anni aggiornati: {', '.join(done) or 'nessuno'}. Anni salvati: {len(years)}. "
               f"Set con dati Brickset: {len(all_sets)}. Con descrizione: {n_desc}. "
               f"Costruisci insieme: {n_bt}. Foto chieste oggi: {n_photos}, foto non riuscite: {n_failed}, "
               f"set con foto: {sum(1 for p in photos.values() if p.get('imgs'))}.")
    print(summary)
    if os.environ.get("GITHUB_ACTIONS"):
        print(f"::notice title=Brickset::{summary}")


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # noqa: BLE001 - un errore di Brickset non deve bloccare il sito
        print(f"::warning title=Brickset::{err}" if os.environ.get("GITHUB_ACTIONS") else f"Errore: {err}")
        sys.exit(1)
