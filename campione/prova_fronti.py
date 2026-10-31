import json,sys
sys.path.insert(0,'scripts')
import numpy as np
from PIL import Image, ImageDraw
from concurrent.futures import ThreadPoolExecutor
import fronti_scatola as F
T=json.load(open('campione/prova.json'))
S=200
for name,items in T.items():
    kind="crop" if name.startswith("crop") else "logo"
    def one(it):
        k,p=it
        try: a=F.load(p)
        except Exception as e: return k,None,None,None
        _,res,_=F.analyze_array(a,kind)
        return k,a,res,F.find_logo(a)
    with ThreadPoolExecutor(8) as ex: out=list(ex.map(one,items))
    cols=6; rows=(len(out)+cols-1)//cols
    sheet=Image.new("RGB",(cols*(S+4),rows*(S+22)),"#bbb")
    for n,(k,a,res,logo) in enumerate(out):
        tile=Image.new("RGB",(S,S+18),"white"); d=ImageDraw.Draw(tile)
        if a is not None:
            im=Image.fromarray(a.astype('uint8')); h,w=a.shape[:2]
            dr=ImageDraw.Draw(im)
            if logo: dr.rectangle([logo[0],logo[1],logo[0]+logo[2],logo[1]+logo[2]],outline=(0,200,255),width=3)
            if res and res.get("crop"):
                x,y,cw,ch=res["crop"]; dr.rectangle([x*w,y*h,(x+cw)*w,(y+ch)*h],outline=(0,220,0),width=4)
            im.thumbnail((S,S)); tile.paste(im,((S-im.width)//2,(S-im.height)//2))
            d.text((4,S+3),f"{k} {'SI' if res and res['f'] else 'no'}",fill="green" if res and res['f'] else "red")
        else: d.text((4,S+3),f"{k} MANCA",fill="red")
        sheet.paste(tile,((n%cols)*(S+4),(n//cols)*(S+22)))
    sheet.save(f"campione/{name}.jpg",quality=80)
