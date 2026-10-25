"""Scarica da Brickset codici a barre, eta', prezzi e valutazioni dei set.

Brickset limita le chiamate giornaliere, quindi lo script lavora un po' alla
volta: ogni volta aggiorna gli anni piu' recenti e quelli non ancora scaricati
(o scaricati da piu' tempo), e salva tutto in data-src/brickset.json.

Uso: BRICKSET_API_KEY=... python scripts/fetch_brickset.py [--max-calls 60]
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

API = "https://brickset.com/api/v3.asmx/getSets"
OUT = Path(__file__).resolve().parent.parent / "data-src" / "brickset.json"
FIRST_YEAR = 1949
PAGE_SIZE = 500


def call(key, params):
    query = urllib.parse.urlencode({"apiKey": key, "userHash": "", "params": json.dumps(params)})
    req = urllib.request.Request(f"{API}?{query}", headers={"User-Agent": "app-lego-catalog/1.0"})
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
    return out


def fetch_year(key, year, budget):
    sets, page, calls = {}, 1, 0
    while True:
        if calls >= budget:
            return None, calls  # anno non completato: si riprova la prossima volta
        data = call(key, {"year": str(year), "pageSize": PAGE_SIZE, "pageNumber": page})
        calls += 1
        for s in data.get("sets") or []:
            set_num = f"{s['number']}-{s.get('numberVariant') or 1}"
            info = compact(s)
            if info:
                sets[set_num] = info
        if len(data.get("sets") or []) < PAGE_SIZE:
            return sets, calls
        page += 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-calls", type=int, default=60)
    args = parser.parse_args()
    key = os.environ.get("BRICKSET_API_KEY", "").strip()
    if not key:
        print("Nessuna chiave Brickset: salto l'aggiornamento.")
        return

    state = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"years": {}}
    years = state["years"]
    this_year = date.today().year
    all_years = [str(y) for y in range(FIRST_YEAR, this_year + 2)]
    recent = [str(this_year + 1), str(this_year), str(this_year - 1)]
    missing = [y for y in all_years if y not in years and y not in recent]
    oldest = sorted((y for y in all_years if y in years and y not in recent),
                    key=lambda y: years[y]["fetched"])
    todo = recent + missing + oldest

    budget, done = args.max_calls, []
    try:
        for year in todo:
            if budget <= 0:
                break
            sets, calls = fetch_year(key, year, budget)
            budget -= calls
            if sets is None:
                break
            years[year] = {"fetched": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "sets": sets}
            done.append(year)
    finally:
        save(years, done)  # anche se Brickset si ferma a meta', quanto scaricato resta


def save(years, done):
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # Una riga per anno: le modifiche restano piccole e leggibili.
    lines = ",\n".join(f"{json.dumps(y)}:{json.dumps(years[y], ensure_ascii=False, sort_keys=True, separators=(',', ':'))}"
                       for y in sorted(years))
    OUT.write_text('{"years":{\n' + lines + "\n}}\n", encoding="utf-8")
    total = sum(len(v["sets"]) for v in years.values())
    print(f"Anni aggiornati: {', '.join(done) or 'nessuno'}. Anni salvati: {len(years)}. Set con dati Brickset: {total}.")
    if os.environ.get("GITHUB_ACTIONS"):
        print(f"::notice title=Brickset::Anni aggiornati: {len(done)}, anni salvati: {len(years)}, set con dati: {total}")


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # noqa: BLE001 - un errore di Brickset non deve bloccare il sito
        print(f"::warning title=Brickset::{err}" if os.environ.get("GITHUB_ACTIONS") else f"Errore: {err}")
        sys.exit(1)
