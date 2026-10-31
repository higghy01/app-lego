import json,io,urllib.request
from PIL import Image, ImageDraw
from concurrent.futures import ThreadPoolExecutor
L=json.load(open("campione/figs.json")); S=150
def get(u):
    try:
        with urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"x"}),timeout=30) as r: return Image.open(io.BytesIO(r.read())).convert("RGB")
    except Exception: return None
ims=list(ThreadPoolExecutor(8).map(lambda x:get(x[1]),L))
cols=8; rows=(len(L)+cols-1)//cols
sh=Image.new("RGB",(cols*(S+4),rows*(S+20)),"#f0c")
for n,((lab,u),im) in enumerate(zip(L,ims)):
    t=Image.new("RGB",(S,S+16),"#ddd")
    if im: im.thumbnail((S,S)); t.paste(im,((S-im.width)//2,(S-im.height)//2))
    ImageDraw.Draw(t).text((2,S+2),lab,fill="black")
    sh.paste(t,((n%cols)*(S+4),(n//cols)*(S+20)))
sh.save("campione/figs.jpg",quality=85)
