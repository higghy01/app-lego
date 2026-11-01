import json, io, sys, concurrent.futures as cf, urllib.request
sys.path.insert(0,"scripts")
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import fronti_scatola as fs
BASE="https://images.brickset.com/sets/"
L=json.load(open("tmp-fogli/crop.json"))
def get(p):
    for _ in range(3):
        try:
            req=urllib.request.Request(BASE+p,headers={"User-Agent":"Mozilla/5.0"})
            return Image.open(io.BytesIO(urllib.request.urlopen(req,timeout=30).read())).convert("RGB")
        except Exception: pass
with cf.ThreadPoolExecutor(16) as ex: ims=list(ex.map(get,[p for s,p in L]))
font=ImageFont.load_default(size=20)
S=480; C=4; R=4; info={}
import os; os.makedirs("tmp-fogli/out",exist_ok=True)
for sh in range(0,len(L),C*R):
    W=Image.new("RGB",(C*S,R*(S+24)),"white"); dr=ImageDraw.Draw(W)
    for n,((s,p),im) in enumerate(zip(L[sh:sh+C*R],ims[sh:sh+C*R])):
        x0,y0=(n%C)*S,(n//C)*(S+24)
        dr.text((x0+4,y0+2),s,fill="black",font=font)
        if im is None: continue
        a=np.asarray(im); rect=None
        for ms in (0.9,0.8,0.7,0.6):
            try: rect=fs.box_rect(a,None,ms)
            except Exception: rect=None
            if rect: break
        info[s]={"p":p,"wh":im.size,"auto":rect}
        t=im.copy(); t.thumbnail((S-10,S-10)); ox,oy=x0+5,y0+24
        W.paste(t,(ox,oy)); tw,th=t.size
        for k in range(1,10):
            dr.line([(ox+tw*k/10,oy),(ox+tw*k/10,oy+th)],fill=(0,160,255),width=1)
            dr.line([(ox,oy+th*k/10),(ox+tw,oy+th*k/10)],fill=(0,160,255),width=1)
        if rect:
            x,y,w,h=rect; dr.rectangle([ox+x*tw,oy+y*th,ox+(x+w)*tw,oy+(y+h)*th],outline="red",width=3)
    W.save(f"tmp-fogli/out/c{sh//(C*R):02d}.jpg",quality=85)
json.dump(info,open("tmp-fogli/out/crop-info.json","w"))
