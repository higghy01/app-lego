# Temporaneo (verifica 1/11): fogli con la PRIMA foto che l'app mostra (elenchi e scheda) per i set 2000-2022 con galleria.
import json, io, os, sys, concurrent.futures as cf, urllib.request
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, "scripts")
import build_catalog as bc
D = "_site/data"
cat = json.load(open(f"{D}/catalog.json")); ex = json.load(open(f"{D}/extra.json"))
base = ex["imgBase"]; xs = ex["sets"]
det = {}
for i in range(ex["detailFiles"]):
    det.update(json.load(open(f"{D}/dettagli/{i}.json"))["sets"])
chosen = json.load(open("data-src/brickset-fronti-scelti.json"))
cfg = json.load(open("tmp-fogli/cfg.json"))
Y0, Y1 = cfg["years"]
only = set(cfg.get("only") or [])
rows = []; none = []
for s in cat["sets"]:
    sn, name, y = s[0], s[1], s[2] or 0
    if only and sn not in only: continue
    if not only and not (Y0 <= y <= Y1): continue
    if not det.get(sn, {}).get("imgs"): continue
    x = xs.get(sn, {}); box = x.get("box")
    if cfg.get("gallery"):
        first = "images/" + sn + ".jpg" if box == 1 else (box[0] if box else None)
        rows.append([sn, y, "M*" if box == 1 else "M", "images/" + sn + ".jpg", None, name])
        for j, im in enumerate(det[sn]["imgs"]):
            rows.append([sn, y, f"{j}" + ("*" if im[0] == first else ""), im[0], x.get("crop") if im[0] == first else None, im[0].rsplit("/", 1)[-1][:22]])
        continue
    if not box: none.append(sn); continue
    if box == 1: url, k = "images/" + sn + ".jpg", "M"
    else:
        url = box[0]
        k = "S" if chosen["sets"].get(sn) == url else {"front": "F", "alt1": "A", "prod": "P", "num": "N"}.get(bc.front_kind([url], y), "?")
    if x.get("crop"): k += "x"
    rows.append([sn, y, k, url, x.get("crop"), name])
def get(p):
    for _ in range(3):
        try:
            req = urllib.request.Request(base + p, headers={"User-Agent": "Mozilla/5.0"})
            return Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=30).read())).convert("RGB")
        except Exception:
            pass
    return None
S = cfg.get("size", 200); C, R = cfg.get("cols", 6), cfg.get("rows", 5)
def prep(r):
    im = get(r[3])
    if im is None: return None
    if r[4]:
        cx, cy, cw, ch = r[4][:4]; W, H = im.size
        im = im.crop((int(cx * W), int(cy * H), int((cx + cw) * W), int((cy + ch) * H)))
    im.thumbnail((S, S)); return im
with cf.ThreadPoolExecutor(24) as e: ims = list(e.map(prep, rows))
font = ImageFont.load_default(size=16)
out = cfg.get("out", "tmp-fogli/out"); os.makedirs(out, exist_ok=True)
idx = {}; missing = []
for n0 in range(0, len(rows), C * R):
    name = f"{cfg.get('prefix','p')}{n0 // (C * R):03d}"
    Wd = Image.new("RGB", (C * S, R * (S + 20)), "white"); dr = ImageDraw.Draw(Wd)
    idx[name] = []
    for j, (r, im) in enumerate(zip(rows[n0:n0 + C * R], ims[n0:n0 + C * R])):
        x0, y0 = (j % C) * S, (j // C) * (S + 20)
        dr.rectangle([x0, y0, x0 + S - 1, y0 + 19], fill=["#ffd0d0", "#d0e0ff"][j % 2])
        dr.text((x0 + 3, y0 + 1), f"{r[0]} {r[2]} {r[5][:22] if cfg.get('gallery') else r[1]}" if cfg.get("gallery") else f"{j} {r[0]} {r[1]} {r[2]}", fill="black", font=font)
        if im: Wd.paste(im, (x0 + (S - im.width) // 2, y0 + 20 + (S - im.height) // 2))
        else: dr.text((x0 + 40, y0 + 100), "MANCA", fill="red", font=font); missing.append(r[0])
        dr.rectangle([x0, y0, x0 + S - 1, y0 + S + 19], outline="#888")
        idx[name].append(r[:5])
    Wd.save(f"{out}/{name}.jpg", quality=82)
json.dump({"idx": idx, "missing": missing, "none": none, "n": len(rows)}, open(f"{out}/indice.json", "w"))
print(len(rows), "set", len(none), "senza scatola", len(missing), "mancanti")
