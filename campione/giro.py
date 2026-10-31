# Temporaneo: lancia fronti_scatola su tutto e fa fogli di controllo a caso.
import json,random,subprocess,sys
from PIL import Image, ImageDraw
from concurrent.futures import ThreadPoolExecutor
import urllib.request,io
subprocess.run([sys.executable,"scripts/fronti_scatola.py","--max","20000"],check=True)
d=json.load(open("data-src/brickset-fronti.json"))["imgs"]
random.seed(5)
groups={"alt1-si":[],"alt1-no":[],"num-si":[],"num-no":[],"crop":[],"crop-no":[]}
for p,v in d.items():
    n=p.rsplit("/",1)[-1].lower()
    k="crop" if ("prod" in n or n.endswith(".png") or n.endswith(".png.jpg")) and "alt1" not in n else ("alt1" if "alt1" in n else "num")
    if k=="crop": groups["crop" if v["f"] else "crop-no"].append((p,v))
    else: groups[f"{k}-{'si' if v['f'] else 'no'}"].append((p,v))
with open("campione/conti.txt","w") as f:
    for g,l in groups.items(): f.write(f"{g} {len(l)}\n")
S=200
def get(p):
    try:
        with urllib.request.urlopen(urllib.request.Request("https://images.brickset.com/sets/"+p,headers={"User-Agent":"x"}),timeout=30) as r:
            return Image.open(io.BytesIO(r.read())).convert("RGB")
    except Exception: return None
for g,l in groups.items():
    pick=random.sample(l,min(42,len(l)))
    ims=list(ThreadPoolExecutor(8).map(lambda x:get(x[0]),pick))
    cols=6; rows=(len(pick)+cols-1)//cols
    sheet=Image.new("RGB",(cols*(S+4),max(1,rows)*(S+22)),"#bbb")
    for n,((p,v),im) in enumerate(zip(pick,ims)):
        tile=Image.new("RGB",(S,S+18),"white"); dr=ImageDraw.Draw(tile)
        if im:
            if v.get("crop"):
                x,y,cw,ch,_=v["crop"]; W,H=im.size; ImageDraw.Draw(im).rectangle([x*W,y*H,(x+cw)*W,(y+ch)*H],outline=(0,220,0),width=max(3,W//100))
            im.thumbnail((S,S)); tile.paste(im,((S-im.width)//2,(S-im.height)//2))
        dr.text((3,S+3),p.split("/")[1]+" "+str(v.get("why","")),fill="black")
        sheet.paste(tile,((n%cols)*(S+4),(n//cols)*(S+22)))
    sheet.save(f"campione/{g}.jpg",quality=80)
