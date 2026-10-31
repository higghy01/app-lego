# Temporaneo: fogli con le miniature come le mostra l'app, per controllare a occhio fronte/retro/ritagli.
import io, json, random, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw
sys.path.insert(0, "scripts")
from build_catalog import front_kind

D = "_site/data/"
cat = json.load(open(D + "catalog.json"))
ex = json.load(open(D + "extra.json"))
base, bbase = cat["imgBase"], ex["imgBase"]
sets = {r[0]: r for r in cat["sets"]}
random.seed(31)

def full(p):
    return p if p.startswith("http") else bbase + p

def get(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        return Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=30).read())).convert("RGB")
    except Exception:
        return None

def shown(num):
    x = ex["sets"].get(num, {})
    b = x.get("box")
    if b == 1:
        return full(f"small/{num}.jpg"), None, "main"
    if b:
        if x.get("crop"):
            return full(b[0]), x["crop"], "crop"
        return full(b[1] or b[0]), None, front_kind(b, sets[num][2] if num in sets else None)
    r = sets.get(num)
    if r and r[5]:
        return (r[5] if r[5].startswith("http") else base + r[5]), None, "RB"
    return None, None, "none"

def tile(num):
    url, crop, kind = shown(num)
    im = get(url) if url else None
    T = Image.new("RGB", (190, 210), "white")
    if im and crop:
        x, y, w, h, _ = crop
        W, H = im.size
        im = im.crop((int(x * W), int(y * H), int((x + w) * W), int((y + h) * H)))
    if im:
        im.thumbnail((186, 186))
        T.paste(im, ((190 - im.width) // 2, 2 + (186 - im.height) // 2))
    d = ImageDraw.Draw(T)
    d.rectangle([0, 190, 190, 210], fill=(230, 230, 230))
    d.text((3, 193), f"{num} {kind} {sets.get(num, [0,0,''])[2]}", fill="black")
    return T

def sheet(nums, name, cols=8):
    with ThreadPoolExecutor(16) as pool:
        tiles = list(pool.map(tile, nums))
    rows = (len(tiles) + cols - 1) // cols
    S = Image.new("RGB", (cols * 194, rows * 214), (255, 0, 200))
    for i, t in enumerate(tiles):
        S.paste(t, ((i % cols) * 194 + 2, (i // cols) * 214 + 2))
    S.save(f"campione/{name}.jpg", quality=80)

def crop_tile(num):
    x = ex["sets"][num]
    im = get(full(x["box"][0]))
    T = Image.new("RGB", (380, 210), "white")
    if im:
        W, H = im.size
        cx, cy, cw, ch, _ = x["crop"]
        a = im.copy(); ImageDraw.Draw(a).rectangle([cx * W, cy * H, (cx + cw) * W, (cy + ch) * H], outline=(255, 0, 0), width=max(3, W // 150))
        a.thumbnail((186, 186)); T.paste(a, (2, 2))
        b = im.crop((int(cx * W), int(cy * H), int((cx + cw) * W), int((cy + ch) * H))); b.thumbnail((186, 186)); T.paste(b, (192, 2))
    ImageDraw.Draw(T).text((3, 195), num, fill="black")
    return T

by = {}
for num, x in ex["sets"].items():
    if num not in sets:
        continue
    by.setdefault(shown(num)[2] if x.get("box") else "nobox", []).append(num)
stats = {k: len(v) for k, v in by.items()}
real = [r for r in cat["sets"] if (r[4] or r[6])]
recent = [r[0] for r in real if (r[2] or 0) >= 2023]
stats["veri dal 2023"] = len(recent)
stats["veri dal 2023 senza scatola"] = sum(1 for n in recent if not ex["sets"].get(n, {}).get("box"))
stats["veri senza scatola"] = sum(1 for r in real if not ex["sets"].get(r[0], {}).get("box"))
stats["veri"] = len(real)
json.dump(stats, open("campione/conti.json", "w"), indent=1)
print(stats)

pick = lambda k, n: random.sample(by.get(k, []), min(n, len(by.get(k, []))))
sheet(pick("front", 48), "elenco-front")
sheet(pick("alt1", 48), "elenco-alt1")
sheet(pick("crop", 48), "elenco-crop")
mains = by.get("main", [])
sheet(random.sample([n for n in mains if (sets[n][2] or 0) < 2000], 24) + random.sample([n for n in mains if (sets[n][2] or 0) >= 2000], 24), "elenco-main")
sheet([r[0] for r in real if (r[2] or 0) in (2025, 2026)][:48], "elenco-recenti")
with ThreadPoolExecutor(16) as pool:
    tiles = list(pool.map(crop_tile, random.sample(by["crop"], 32)))
S = Image.new("RGB", (4 * 384, 8 * 214), (255, 0, 200))
for i, t in enumerate(tiles):
    S.paste(t, ((i % 4) * 384 + 2, (i // 4) * 214 + 2))
S.save("campione/ritagli.jpg", quality=80)
