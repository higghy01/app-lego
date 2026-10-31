// Temporaneo: l'app vera (con le immagini) a 320/375, chiaro/scuro, offline; foto di ogni copertina.
const http=require("http"),fs=require("fs"),path=require("path");
const {chromium}=require("playwright");
const dir=path.resolve("_site");
const T={".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".png":"image/png",".woff2":"font/woff2",".webmanifest":"application/manifest+json",".svg":"image/svg+xml"};
const srv=http.createServer((q,r)=>{let f=path.join(dir,decodeURIComponent(q.url.split("?")[0]));if(fs.existsSync(f)&&fs.statSync(f).isDirectory())f=path.join(f,"index.html");if(!fs.existsSync(f)){r.writeHead(404);r.end();return;}r.writeHead(200,{"Content-Type":T[path.extname(f)]||"application/octet-stream"});fs.createReadStream(f).pipe(r);});
fs.mkdirSync("campione/cop",{recursive:true});
const report={};
srv.listen(0,"127.0.0.1",async()=>{
  const base=`http://127.0.0.1:${srv.address().port}/`;
  const b=await chromium.launch();
  for(const [w,h,tema] of [[375,812,"chiaro"],[320,568,"scuro"]]){
    const ctx=await b.newContext({viewport:{width:w,height:h},deviceScaleFactor:2,isMobile:true,hasTouch:true,userAgent:"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"});
    const p=await ctx.newPage();
    const errs=[];p.on("pageerror",e=>errs.push(e.message));
    await p.goto(base);
    const now=new Date().toISOString();
    const col={};
    for(const s of ["75192-1","76269-1","10294-1","76419-1","42143-1","21265-1","60380-1","41748-1","71799-1","75313-1","43222-1","10328-1","31120-1","21061-1","10326-1","71411-1","76994-1","11203-1"]) col[s]={s:"built",u:now};
    for(const s of ["10316-1","42115-1"]) col[s]={s:"owned",u:now};
    await p.evaluate(([c,t])=>{localStorage.setItem("lego-collezione-v1",JSON.stringify(c));localStorage.setItem("lego-collezione-vista","cat");localStorage.setItem("lego-tema",t);},[col,tema]);
    await p.reload(); await p.waitForTimeout(2000);
    const tag=`${w}-${tema}`;
    const settle=async()=>{await p.waitForLoadState("networkidle").catch(()=>{});await p.waitForTimeout(2500);};
    const shot=async(hash,name,scroll=0)=>{await p.goto(base+hash);await p.waitForTimeout(1500);if(scroll){await p.evaluate((y)=>window.scrollTo(0,y),scroll);}await settle();await p.screenshot({path:`campione/${name}-${tag}.png`});};
    // Temi: ogni copertina da sola
    await p.goto(base+"#/temi");await settle();
    const tiles=await p.$$("a.tile:not(.mini)");
    const info=[];
    for(let i=0;i<tiles.length;i++){
      await tiles[i].scrollIntoViewIfNeeded();await p.waitForTimeout(400);
      const d=await tiles[i].evaluate(a=>{const imgs=[...a.querySelectorAll(".tile-cover img")];return {name:a.querySelector(".tile-name").textContent,figs:!!a.querySelector(".figs-cover"),imgs:imgs.map(i=>({src:i.currentSrc.split("/").pop(),ok:i.complete&&i.naturalWidth>0,nw:i.naturalWidth,nh:i.naturalHeight,cw:i.clientWidth,ch:i.clientHeight}))};});
      info.push(d);
      if(tema==="chiaro"||i<12) await tiles[i].screenshot({path:`campione/cop/${tag}-${String(i).padStart(2,"0")}.png`});
    }
    report[tag]={temi:info};
    await shot("#/temi",`temi-a`,0);
    await shot("#/temi",`temi-b`,900);
    await shot("#/catalogo",`catalogo`);
    await shot("#/catalogo",`catalogo-giu`,1200);
    await shot("#/collezione",`collezione`);
    await shot("#/collezione",`collezione-giu`,700);
    // Collezione per categoria: ogni copertina
    await p.goto(base+"#/collezione");await settle();
    const cats=await p.$$(".cat-pic");
    report[tag].collezione=[];
    for(let i=0;i<cats.length;i++){await cats[i].scrollIntoViewIfNeeded();await p.waitForTimeout(400);
      report[tag].collezione.push(await cats[i].evaluate(e=>({figs:!!e.querySelector(".figs-cover")||e.classList.contains("figs-cover"),imgs:[...e.querySelectorAll("img")].map(i=>i.complete&&i.naturalWidth>0)})));
      await cats[i].screenshot({path:`campione/cop/${tag}-col-${String(i).padStart(2,"0")}.png`});}
    // Pagina di un tema con personaggi e una senza
    for(const nm of ["Super Heroes Marvel","Technic"]){
      await p.goto(base+"#/temi");await p.waitForTimeout(1200);
      const href=await p.evaluate((n)=>[...document.querySelectorAll("a.tile")].find(a=>a.querySelector(".tile-name").textContent===n)?.getAttribute("href"),nm);
      if(href) await shot(href,`tema-${nm.split(" ").pop().toLowerCase()}`);
    }
    // Offline: service worker pronto, poi senza internet
    await p.goto(base+"#/temi");await p.evaluate(()=>navigator.serviceWorker&&navigator.serviceWorker.ready);await settle();
    await ctx.setOffline(true);
    await shot("#/temi",`offline-temi`);
    await shot("#/collezione",`offline-collezione`);
    await shot("#/catalogo",`offline-catalogo`);
    await ctx.setOffline(false);
    report[tag].errori=errs;
    await ctx.close();
  }
  fs.writeFileSync("campione/report.json",JSON.stringify(report,null,1));
  await b.close(); srv.close();
});
