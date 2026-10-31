# Temporaneo: prove per ritagliare piu' scatole, riconoscere il fronte nelle foto con numeri, sfondo personaggi.
import io, json, random, sys, re, collections, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
sys.path.insert(0, "scripts")
from build_catalog import front_kind, THEME_FIGS, read_csv
import fronti_scatola as F
random.seed(3)
cat = json.load(open("_site/data/catalog.json")); ex = json.load(open("_site/data/extra.json"))["sets"]
ph = json.load(open("data-src/brickset-foto.json"))["sets"]; fr = json.load(open("data-src/brickset-fronti.json"))["imgs"]
years = {r[0]: r[2] or 0 for r in cat["sets"]}
real = {r[0] for r in cat["sets"] if (r[4] or r[6])}
out = {}

def L(p):
    try: return F.load(p)
    except Exception: return None

def bbox_ratio(a):
    ink = a.min(axis=2) < 232
    ys, xs = np.where(ink)
    if not len(ys): return None
    return (ys.max() - ys.min() + 1) / (xs.max() - xs.min() + 1)

def box_rect2(a, ratio=None):
    h, w, _ = a.shape
    ink = a.min(axis=2) < 232
    rows = np.where(ink[:, : int(w * 0.7)].sum(axis=1) > w * 0.08)[0]
    cols = np.where(ink[: int(h * 0.7), :].sum(axis=0) > h * 0.08)[0]
    if not len(rows) or not len(cols): return None, "vuota"
    top, left = int(rows[0]), int(cols[0])
    def run(line, start):
        gap = 0
        for k in range(start, len(line)):
            if line[k]: gap = 0
            else:
                gap += 1
                if gap >= 4: return k - gap + 1
        return len(line)
    rights = sorted(run(ink[min(h - 1, top + int(h * f))], left + 3) for f in (0.03, 0.08, 0.15))
    right = rights[1]
    if right - left < w * 0.2: return None, "stretta"
    xs = [left + int((right - left) * f) for f in (0.04, 0.25, 0.5, 0.75, 0.96)]
    bottoms = sorted(run(ink[:, x], top + 3) for x in xs)
    bottom = None
    if ratio:
        est = top + (right - left) * ratio
        near = [b for b in bottoms if abs(b - est) <= h * 0.04]
        bottom = int(min(near, key=lambda b: abs(b - est))) if near else int(round(est))
        how = "box5+bordo" if near else "box5"
    else:
        for i in range(len(bottoms) - 1):
            if bottoms[i] - top > h * 0.2 and bottoms[i + 1] - bottoms[i] <= h * 0.02:
                bottom = bottoms[i]; break
        how = "bordi"
    if bottom is None: return None, "fondo?"
    bottom = min(bottom, h)
    bw, bh = right - left, bottom - top
    if bw < w * 0.25 or bh < h * 0.25 or bw > w * 0.85 or bh > h * 0.85 or not 0.5 <= bw / bh <= 2.4: return None, "misure"
    solid = float(ndimage.binary_fill_holes(ink[top:bottom, left:right]).mean())
    if solid < 0.9: return None, f"non piena {solid:.2f}"
    return [round(left / w, 4), round(top / h, 4), round(bw / w, 4), round(bh / h, 4), round(bw / bh, 3)], how

def box5_of(s):
    for i in ph[s]["imgs"]:
        n = i[0].split("/")[-1].lower()
        if re.search(r"box5", n): return i[0]
    return None

def try_crop(arg):
    s, p, kind = arg
    a = L(p)
    if a is None: return s, p, None, "errore", kind
    ratio = None
    b5 = box5_of(s)
    if b5 is not None:
        a5 = L(b5)
        if a5 is not None: ratio = bbox_ratio(a5)
    rect, how = box_rect2(a, ratio)
    if rect: rect[4] = round(rect[2] * a.shape[1] / (rect[3] * a.shape[0]), 3)
    return s, p, rect, how, kind

def nobox(s): return not ex.get(s, {}).get("box")
todo = []
for s, info in ph.items():
    if s not in real or not nobox(s) or years.get(s, 0) < 2010: continue
    for i in info["imgs"]:
        k = front_kind(i, years.get(s))
        if k == "prod": todo.append((s, i[0], "prod"))
        elif k == "alt1": todo.append((s, i[0], "alt1"))
with ThreadPoolExecutor(16) as pool:
    res = list(pool.map(try_crop, todo))
out["crop"] = {p: {"s": s, "crop": r, "how": how, "kind": k} for s, p, r, how, k in res}
c = collections.Counter((k, how if r else "no:" + how.split(" ")[0]) for s, p, r, how, k in res)
out["crop_conti"] = {f"{a} {b}": n for (a, b), n in c.items()}
print(out["crop_conti"])

def ctile(item):
    s, p, r, how, k = item
    im = Image.open(io.BytesIO(urllib.request.urlopen(urllib.request.Request(F.IMG + p, headers={"User-Agent": "x"}), timeout=30).read())).convert("RGB")
    W, H = im.size
    T = Image.new("RGB", (380, 210), "white")
    x, y, w, h, _ = r
    A = im.copy(); ImageDraw.Draw(A).rectangle([x * W, y * H, (x + w) * W, (y + h) * H], outline=(255, 0, 0), width=max(3, W // 150))
    A.thumbnail((186, 186)); T.paste(A, (2, 2))
    B = im.crop((int(x * W), int(y * H), int((x + w) * W), int((y + h) * H))); B.thumbnail((186, 186)); T.paste(B, (192, 2))
    ImageDraw.Draw(T).text((3, 195), f"{s} {k} {how}", fill="black")
    return T
def csheet(items, name):
    with ThreadPoolExecutor(16) as pool: tiles = list(pool.map(ctile, items))
    if not tiles: return
    S = Image.new("RGB", (4 * 384, ((len(tiles) + 3) // 4) * 214), (255, 0, 200))
    for i, t in enumerate(tiles): S.paste(t, ((i % 4) * 384 + 2, (i // 4) * 214 + 2))
    S.save(f"campione/{name}.jpg", quality=80)
ok = [x for x in res if x[2]]
pr = [x for x in ok if x[4] == "prod"]; al = [x for x in ok if x[4] == "alt1"]
csheet(random.sample(pr, min(40, len(pr))), "g3-prod")
csheet(random.sample(al, min(40, len(al))), "g3-alt1")
# foto prod ancora senza ritaglio
miss = [x for x in res if not x[2] and x[4] == "prod"]
out["prod_senza"] = [(s, p, how) for s, p, r, how, k in miss]

# Logo: quanto e' grande rispetto alla scatola nel fronte (Box1) e nel retro (Box5), e nelle foto con numeri
def logo_ratio(p):
    a = L(p)
    if a is None: return p, None
    lg = F.find_logo(a)
    ink = a.min(axis=2) < 232; ys, xs = np.where(ink)
    if lg is None or not len(xs): return p, [0, 0, 0]
    bw = xs.max() - xs.min() + 1
    return p, [round(lg[2] / bw, 3), round((lg[0] - xs.min()) / bw, 3), round((lg[1] - ys.min()) / (ys.max() - ys.min() + 1), 3)]
b1, b5, nums = [], [], []
for s, info in ph.items():
    if years.get(s, 0) < 2018: continue
    for i in info["imgs"]:
        n = i[0].split("/")[-1].lower()
        if re.search(r"_box1_", n): b1.append(i[0])
        elif re.search(r"_box5_", n): b5.append(i[0])
        elif front_kind(i) == "num" and nobox(s) and fr.get(i[0], {}).get("f") is not None: nums.append((s, i[0]))
b1 = random.sample(b1, min(150, len(b1))); b5 = random.sample(b5, min(150, len(b5)))
with ThreadPoolExecutor(16) as pool:
    r1 = dict(pool.map(logo_ratio, b1)); r5 = dict(pool.map(logo_ratio, b5)); rn = dict(pool.map(logo_ratio, [p for s, p in nums]))
out["logo_box1"] = sorted(v[0] for v in r1.values() if v); out["logo_box5"] = sorted(v[0] for v in r5.values() if v)
out["logo_box1_full"] = r1; out["logo_box5_full"] = r5
out["logo_num"] = {p: [s, rn.get(p), fr[p]] for s, p in nums}
def ntile(item):
    p, lab = item
    a = L(p)
    T = Image.new("RGB", (190, 210), "white")
    if a is not None:
        im = Image.fromarray(a.astype("uint8")); im.thumbnail((186, 186)); T.paste(im, ((190 - im.width) // 2, 2))
    ImageDraw.Draw(T).text((3, 195), lab, fill="black")
    return T
def nsheet(items, name, cols=8):
    with ThreadPoolExecutor(16) as pool: tiles = list(pool.map(ntile, items))
    if not tiles: return
    S = Image.new("RGB", (cols * 194, ((len(tiles) + cols - 1) // cols) * 214), (255, 0, 200))
    for i, t in enumerate(tiles): S.paste(t, ((i % cols) * 194 + 2, (i // cols) * 214 + 2))
    S.save(f"campione/{name}.jpg", quality=80)
numsel = [(p, f"{s} {rn.get(p)}") for s, p in nums if rn.get(p) and rn[p][0] > 0 and years.get(s, 0) >= 2023]
nsheet(random.sample(numsel, min(64, len(numsel))), "g3-num")

# Personaggi: sfondo davvero bianco?
figs = {m["fig_num"]: (m["name"], m["img_url"]) for m in read_csv("minifigs", None)}
def border(url):
    try:
        im = Image.open(io.BytesIO(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30).read())).convert("RGB")
    except Exception:
        return None
    a = np.asarray(im).astype(int); h, w, _ = a.shape
    e = np.concatenate([a[:3].reshape(-1, 3), a[-3:].reshape(-1, 3), a[:, :3].reshape(-1, 3), a[:, -3:].reshape(-1, 3)])
    return [round(float(e.mean()), 1), int(e.min(axis=1).min()), round(float((e.min(axis=1) < 245).mean()), 3), w, h]
cur = [(t, f) for t, fs in THEME_FIGS.items() for f in fs]
with ThreadPoolExecutor(16) as pool:
    bs = list(pool.map(lambda tf: border(figs[tf[1]][1]) if tf[1] in figs else None, cur))
out["figs_bordo"] = {f"{t} {f} {figs.get(f, ('?',))[0]}": b for (t, f), b in zip(cur, bs)}
json.dump(out, open("campione/giro3.json", "w"), indent=0)
