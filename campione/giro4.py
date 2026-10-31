# Temporaneo: controllo dei ritagli nuovi (fronti_scatola v2) e personaggi alternativi con sfondo bianco.
import io, json, random, sys, re, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from PIL import Image, ImageDraw
sys.path.insert(0, "scripts")
from build_catalog import read_csv
random.seed(4)
fr = json.load(open("data-src/brickset-fronti.json"))["imgs"]
old = json.load(open("campione/fronti-prima.json"))["imgs"]
ex = json.load(open("_site/data/extra.json"))["sets"]
B = "https://images.brickset.com/sets/"
def get(url):
    try:
        return Image.open(io.BytesIO(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30).read())).convert("RGB")
    except Exception:
        return None
new = {p: v for p, v in fr.items() if v.get("f") and not old.get(p, {}).get("f")}
used = {x["box"][0]: s for s, x in ex.items() if isinstance(x.get("box"), list)}
kinds = {"prod": [], "alt1crop": [], "alt1": []}
for p, v in new.items():
    if p not in used: continue
    k = "prod" if "boxprod" in p.lower() or p.lower().endswith(".png") or ".png." in p.lower() else ("alt1crop" if v.get("crop") else "alt1")
    kinds[k].append(p)
json.dump({k: len(v) for k, v in kinds.items()} | {"nuovi f=1": len(new), "usati": sum(len(v) for v in kinds.values())}, open("campione/conti4.json", "w"))
def ctile(p):
    im = get(B + p); v = fr[p]
    T = Image.new("RGB", (380, 210), "white")
    if im:
        W, H = im.size
        A = im.copy()
        if v.get("crop"):
            x, y, w, h, _ = v["crop"]
            ImageDraw.Draw(A).rectangle([x * W, y * H, (x + w) * W, (y + h) * H], outline=(255, 0, 0), width=max(3, W // 150))
            Bm = im.crop((int(x * W), int(y * H), int((x + w) * W), int((y + h) * H)))
        else:
            Bm = im.copy()
        A.thumbnail((186, 186)); T.paste(A, (2, 2)); Bm.thumbnail((186, 186)); T.paste(Bm, (192, 2))
    ImageDraw.Draw(T).text((3, 195), used.get(p, "") + " " + str(v.get("why", "")), fill="black")
    return T
def csheet(items, name):
    with ThreadPoolExecutor(16) as pool: tiles = list(pool.map(ctile, items))
    if not tiles: return
    S = Image.new("RGB", (4 * 384, ((len(tiles) + 3) // 4) * 214), (255, 0, 200))
    for i, t in enumerate(tiles): S.paste(t, ((i % 4) * 384 + 2, (i // 4) * 214 + 2))
    S.save(f"campione/{name}.jpg", quality=80)
for k, v in kinds.items():
    csheet(random.sample(v, min(44, len(v))), f"g4-{k}")
# Personaggi con sfondo bianco
figs = read_csv("minifigs", None)
pats = {"ironman": r"^Iron Man", "batman": r"^Batman", "superman": r"^Superman", "joker": r"^(The )?Joker", "nya": r"^Nya", "minion": r"^Minion", "spaceman": r"Classic Spaceman", "tails": r"Tails", "luffy": r"Luffy", "zoro": r"Zoro", "jay": r"^Jay\b"}
def border(url):
    im = get(url)
    if im is None: return None
    a = np.asarray(im).astype(int)
    e = np.concatenate([a[:3].reshape(-1, 3), a[-3:].reshape(-1, 3), a[:, :3].reshape(-1, 3), a[:, -3:].reshape(-1, 3)])
    return float((e.min(axis=1) < 245).mean()), im
res = {}
for key, pat in pats.items():
    cands = [m for m in figs if re.search(pat, m["name"]) and m["img_url"]]
    cands = sorted(cands, key=lambda m: m["fig_num"], reverse=True)[:30]
    with ThreadPoolExecutor(16) as pool: bs = list(pool.map(lambda m: border(m["img_url"]), cands))
    good = [(m, b) for m, b in zip(cands, bs) if b and b[0] < 0.005][:16]
    res[key] = [(m["fig_num"], m["name"]) for m, b in good]
    S = Image.new("RGB", (8 * 194, ((len(good) + 7) // 8 or 1) * 214), (255, 0, 200))
    for i, (m, b) in enumerate(good):
        T = Image.new("RGB", (190, 210), "white"); im = b[1]; im.thumbnail((186, 186)); T.paste(im, (2, 2))
        ImageDraw.Draw(T).text((3, 195), m["fig_num"] + " " + m["name"][:18], fill="black")
        S.paste(T, ((i % 8) * 194 + 2, (i // 8) * 214 + 2))
    S.save(f"campione/g4-fig-{key}.jpg", quality=80)
json.dump(res, open("campione/g4-figs.json", "w"), indent=0)
