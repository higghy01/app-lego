# Temporaneo: rifà i ritagli, ricalcola alt1 con is_front, fogli di controllo.
import json,random,subprocess,sys
sys.path.insert(0,"scripts")
from PIL import Image, ImageDraw
from concurrent.futures import ThreadPoolExecutor
import urllib.request,io
P="data-src/brickset-fronti.json"
d=json.load(open(P))
from fronti_scatola import is_front
for k in list(d["imgs"]):
    v=d["imgs"][k]
    if "why" in v: v["f"]=int(is_front(v["why"]))
    elif "alt1" not in k.lower(): del d["imgs"][k]   # ritagli e foto con nome a caso: si rifanno
json.dump(d,open(P,"w"),separators=(",",":"))
subprocess.run([sys.executable,"scripts/fronti_scatola.py","--max","20000"],check=True)
d=json.load(open(P))["imgs"]
random.seed(9)
groups={"crop":[],"crop-no":[]}
for p,v in d.items():
    if "why" in v: continue
    groups["crop" if v["f"] else "crop-no"].append((p,v))
with open("campione/conti.txt","w") as f:
    for g,l in groups.items(): f.write(f"{g} {len(l)}\n")
    f.write(f"alt1 si {sum(1 for v in d.values() if 'why' in v and v['f'])} no {sum(1 for v in d.values() if 'why' in v and not v['f'])}\n")
S=200
def get(p):
    try:
        with urllib.request.urlopen(urllib.request.Request("https://images.brickset.com/sets/"+p,headers={"User-Agent":"x"}),timeout=30) as r:
            return Image.open(io.BytesIO(r.read())).convert("RGB")
    except Exception: return None
for g,l in groups.items():
  for part in range(2 if g=="crop" else 1):
    pick=random.sample(l,min(42,len(l)))
    ims=list(ThreadPoolExecutor(8).map(lambda x:get(x[0]),pick))
    cols=6; rows=(len(pick)+cols-1)//cols
    sheet=Image.new("RGB",(cols*(S+4),max(1,rows)*(S+22)),"#bbb")
    for n,((p,v),im) in enumerate(zip(pick,ims)):
        tile=Image.new("RGB",(S,S+18),"white"); dr=ImageDraw.Draw(tile)
        if im:
            if v.get("crop"):
                x,y,cw,ch,_=v["crop"]; W,H=im.size; im=im.crop((int(x*W),int(y*H),int((x+cw)*W),int((y+ch)*H)))
            im.thumbnail((S,S)); tile.paste(im,((S-im.width)//2,(S-im.height)//2))
        dr.text((3,S+3),p.split("/")[1],fill="black")
        sheet.paste(tile,((n%cols)*(S+4),(n//cols)*(S+22)))
    sheet.save(f"campione/{g}-{part}.jpg",quality=80)
# giro 2
