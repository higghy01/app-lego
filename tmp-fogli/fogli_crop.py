import json, io, concurrent.futures as cf, urllib.request, os
from PIL import Image, ImageDraw, ImageFont
BASE="https://images.brickset.com/sets/"
L=json.load(open("tmp-fogli/crop.json"))
def get(p):
    for _ in range(3):
        try:
            return Image.open(io.BytesIO(urllib.request.urlopen(urllib.request.Request(BASE+p,headers={"User-Agent":"Mozilla/5.0"}),timeout=30).read())).convert("RGB")
        except Exception: pass
with cf.ThreadPoolExecutor(16) as ex: ims=list(ex.map(get,[x[1] for x in L]))
font=ImageFont.load_default(size=20); S=300; C=8; R=7
os.makedirs("tmp-fogli/out",exist_ok=True)
for sh in range(0,len(L),C*R):
    W=Image.new("RGB",(C*S,R*(S+24)),"#ddd"); dr=ImageDraw.Draw(W)
    for n,((s,p,c),im) in enumerate(zip(L[sh:sh+C*R],ims[sh:sh+C*R])):
        x0,y0=(n%C)*S,(n//C)*(S+24); dr.text((x0+4,y0+2),s,fill="black",font=font)
        if im is None: continue
        w,h=im.size; t=im.crop((int(c[0]*w),int(c[1]*h),int((c[0]+c[2])*w),int((c[1]+c[3])*h))); t.thumbnail((S-6,S-6))
        W.paste(t,(x0+3,y0+24))
    W.save(f"tmp-fogli/out/r{sh//(C*R):02d}.jpg",quality=85)
