import json, io, sys, concurrent.futures as cf, urllib.request
from PIL import Image, ImageDraw, ImageFont
BASE="https://images.brickset.com/sets/"
d=json.load(open("tmp-fogli/lista.json"))
def get(p):
    for _ in range(3):
        try:
            req=urllib.request.Request(BASE+p,headers={"User-Agent":"Mozilla/5.0"})
            im=Image.open(io.BytesIO(urllib.request.urlopen(req,timeout=30).read())).convert("RGB")
            im.thumbnail((200,200)); return im
        except Exception as e: err=e
    return None
paths=sorted({p for v in d["A"].values() for p in v}|{x[1] for x in d["B"]})
with cf.ThreadPoolExecutor(16) as ex: ims=dict(zip(paths,ex.map(get,paths)))
font=ImageFont.load_default(size=22)
C,R,S=12,14,200
def sheet(cells,name):
    W=Image.new("RGB",(C*S,R*(S+26)),"white"); dr=ImageDraw.Draw(W)
    for n,(lab,p,bg) in enumerate(cells):
        x,y=(n%C)*S,(n//C)*(S+26)
        dr.rectangle([x,y,x+S-1,y+S+25],fill=bg)
        im=ims.get(p)
        if im: W.paste(im,(x+(S-im.width)//2,y+26+(S-im.height)//2))
        else: dr.text((x+40,y+100),"MANCA",fill="red",font=font)
        dr.text((x+4,y+2),lab,fill="black",font=font)
    W.save(f"tmp-fogli/out/{name}.jpg",quality=80)
import os; os.makedirs("tmp-fogli/out",exist_ok=True)
idx={}
cells=[];k=0;sh=0
cols=["#ffd0d0","#d0e0ff","#d0ffd0","#fff0b0"]
for i,(s,ps) in enumerate(d["A"].items()):
    for j,p in enumerate(ps):
        if len(cells)==C*R:
            sheet(cells,f"a{sh:02d}"); sh+=1; cells=[]
        cells.append((f"{s} {j}",p,cols[i%4]))
        idx.setdefault(f"a{sh:02d}",[]).append(s) if j==0 else None
sheet(cells,f"a{sh:02d}")
cells=[];sh=0
for s,p,c in d["B"]:
    if len(cells)==C*R: sheet(cells,f"b{sh:02d}"); sh+=1; cells=[]
    cells.append((s,p,"#ffd0d0" if c else "#eeeeee"))
sheet(cells,f"b{sh:02d}")
json.dump({"idx":idx,"missing":[p for p,v in ims.items() if v is None]},open("tmp-fogli/out/indice.json","w"))
