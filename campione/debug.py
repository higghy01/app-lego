import json,sys
sys.path.insert(0,'scripts')
import numpy as np
from PIL import Image
from scipy import ndimage
import fronti_scatola as F
T=json.load(open('campione/prova.json'))
items=T['logo-alt1old'][:4]+T['crop-boxprod'][:4]
out=open('campione/debug.txt','w'); tiles=[]
for k,p in items:
    a=F.load(p); h,w,_=a.shape
    r,g,b=a[...,0],a[...,1],a[...,2]
    red=(r>160)&(g<80)&(b<80)&(r-g>110)
    lab,n=ndimage.label(red)
    out.write(f"{k} {p} size {w}x{h} red px {red.sum()} comps {n}\n")
    for i,sl in enumerate(ndimage.find_objects(lab),1):
        ys,xs=sl; bh,bw=ys.stop-ys.start,xs.stop-xs.start
        if max(bh,bw)<6: continue
        inside=lab[ys,xs]==i; box=a[ys,xs]; white=(box.min(axis=2)>200)&~inside
        out.write(f"  comp x{xs.start} y{ys.start} {bw}x{bh} fill {inside.mean():.2f} white {white.mean():.2f}\n")
    out.write(f"  rect {F.box_rect(a)}\n")
    ink=a.min(axis=2)<232
    out.write(f"  ink rows first {np.where(ink[:, :int(w*0.7)].sum(axis=1)>w*0.08)[0][:3]} cols first {np.where(ink[:int(h*0.7),:].sum(axis=0)>h*0.08)[0][:3]}\n")
    im=Image.fromarray(a[:int(h*0.35),:int(w*0.35)].astype('uint8')).resize((300,int(300*h/w)))
    tiles.append(im)
sheet=Image.new("RGB",(4*304,2*max(t.height for t in tiles)+8),"#888")
for n,t in enumerate(tiles): sheet.paste(t,((n%4)*304,(n//4)*(max(x.height for x in tiles)+4)))
sheet.save('campione/debug.jpg')
