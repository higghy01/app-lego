# Temporaneo: perche' tanti set recenti non hanno il fronte della scatola.
import io, json, random, sys, re, collections, urllib.request
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw
sys.path.insert(0, "scripts")
from build_catalog import front_kind
random.seed(7)
cat = json.load(open("_site/data/catalog.json")); ex = json.load(open("_site/data/extra.json"))["sets"]
ph = json.load(open("data-src/brickset-foto.json"))["sets"]; fr = json.load(open("data-src/brickset-fronti.json"))["imgs"]
B = "https://images.brickset.com/sets/"
real = {r[0]: r for r in cat["sets"] if (r[4] or r[6])}
def categ(s):
    info = ph.get(s)
    if not info: return "senza foto brickset" + (" (main)" if ex.get(s, {}).get("box") == 1 else "")
    if ex.get(s, {}).get("box"): return "ok"
    ks = [front_kind(i) for i in info["imgs"]]
    if not info["imgs"]: return "0 foto"
    if "prod" in ks: return "prod-nocrop"
    if "num" in ks: return "num-f1" if any(fr.get(i[0], {}).get("f") for i, k in zip(info["imgs"], ks) if k == "num") else "num"
    if "alt1" in ks: return "alt1-no"
    return "altro"
by = collections.defaultdict(list); stats = collections.Counter()
for s, r in real.items():
    y = r[2] or 0
    c = categ(s); by[c].append(s)
    stats[(">=2023" if y >= 2023 else ">=2010" if y >= 2010 else "<2010") + " " + c] += 1
json.dump(dict(sorted(stats.items())), open("campione/conti2.json", "w"), indent=1)
names = {c: {s: [i[0].split("/")[-1] for i in ph[s]["imgs"]] for s in random.sample([x for x in v if (real[x][2] or 0) >= 2010], min(25, len([x for x in v if (real[x][2] or 0) >= 2010])))} for c, v in by.items() if c not in ("ok",) and c in ("altro", "alt1-no", "num", "num-f1", "prod-nocrop")}
json.dump(names, open("campione/nomi2.json", "w"), indent=1)
def get(p):
    try:
        req = urllib.request.Request(B + p, headers={"User-Agent": "Mozilla/5.0"})
        im = Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=30).read()))
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA"); bg = Image.new("RGBA", im.size, "white"); im = Image.alpha_composite(bg, im)
        return im.convert("RGB")
    except Exception:
        return None
def tile(arg):
    p, lab = arg
    T = Image.new("RGB", (190, 210), "white"); im = get(p)
    if im: im.thumbnail((186, 186)); T.paste(im, ((190 - im.width) // 2, 2 + (186 - im.height) // 2))
    ImageDraw.Draw(T).rectangle([0, 190, 190, 210], fill=(230, 230, 230)); ImageDraw.Draw(T).text((3, 193), lab[:30], fill="black")
    return T
def sheet(items, name, cols=8):
    with ThreadPoolExecutor(16) as pool: tiles = list(pool.map(tile, items))
    if not tiles: return
    S = Image.new("RGB", (cols * 194, ((len(tiles) + cols - 1) // cols) * 214), (255, 0, 200))
    for i, t in enumerate(tiles): S.paste(t, ((i % cols) * 194 + 2, (i // cols) * 214 + 2))
    S.save(f"campione/{name}.jpg", quality=80)
rec = lambda c, n: random.sample([x for x in by[c] if (real[x][2] or 0) >= 2016], min(n, len([x for x in by[c] if (real[x][2] or 0) >= 2016])))
sheet([(i[0], s + " prod") for s in rec("prod-nocrop", 32) for i in ph[s]["imgs"] if front_kind(i) == "prod"][:32], "g2-prod")
sheet([(i[0], s + " " + str(fr[i[0]]["why"])) for s in rec("num-f1", 40) for i in ph[s]["imgs"] if fr.get(i[0], {}).get("f") and front_kind(i) == "num"][:48], "g2-numf1")
sheet([(i[0], s + " " + str(fr.get(i[0], {}).get("why"))) for s in rec("alt1-no", 40) for i in ph[s]["imgs"] if front_kind(i) == "alt1"][:40], "g2-alt1no")
alt = rec("altro", 16)
sheet([(i[0], s + " " + i[0].split("/")[-1][-20:]) for s in alt for i in ph[s]["imgs"][:4]][:64], "g2-altro")
