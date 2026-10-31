# Temporaneo: mette in un foglio tutte le foto delle copertine.
import glob
from PIL import Image
for pre in ["375-chiaro-", "320-scuro-", "375-chiaro-col-", "320-scuro-col-"]:
    fs = sorted(f for f in glob.glob(f"campione/cop/{pre}*.png") if ("col" in pre) == ("-col-" in f))
    if not fs:
        continue
    ims = [Image.open(f).convert("RGB") for f in fs]
    ims = [i.resize((i.width // 2, i.height // 2)) for i in ims]
    w = max(i.width for i in ims); h = max(i.height for i in ims); cols = 6
    S = Image.new("RGB", (cols * (w + 4), ((len(ims) + cols - 1) // cols) * (h + 4)), (255, 0, 200))
    for k, i in enumerate(ims):
        S.paste(i, ((k % cols) * (w + 4), (k // cols) * (h + 4)))
    S.save(f"campione/copertine-{pre.strip('-')}.png")
