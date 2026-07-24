const FRONTEND_VERSION="web-1.1.43-centered-charts";
let tempChart=null,phChart=null,clChart=null,orpChart=null;
const BACKEND_API="/api";
let currentRange="day";
const LIMITS={ph:{okLow:7.0,okHigh:7.8,critLow:6.8,critHigh:8.2},cl:{okLow:1.0,okHigh:3.0,critLow:.3,critHigh:5.0},orp:{okLow:650,okHigh:800,critLow:600,critHigh:900}};
const ESP_ONLINE_SECONDS=90;       // heartbeat every 30s, so 90s is a fair timeout
const MEASUREMENT_OLD_SECONDS=2700; // old water values if no real sensor measurement for 45 min // old water values if no real sensor measurement for 3 min

document.getElementById("refreshBtn")?.addEventListener("click",loadData);
document.querySelectorAll(".range-btn").forEach(btn=>btn.addEventListener("click",()=>{document.querySelectorAll(".range-btn").forEach(b=>b.classList.remove("active"));btn.classList.add("active");currentRange=btn.dataset.range||"day";loadData()}));
document.getElementById("pairBtn")?.addEventListener("click",async()=>{try{const r=await fetch("/pair",{method:"POST"});alert(r.ok?"PAIR startad på ESP32.":"PAIR misslyckades. Kör PAIR i Serial Monitor.")}catch(e){alert("PAIR fungerar bara om /pair-routen nås direkt på ESP32. Annars kör PAIR i Serial Monitor.")}});
document.getElementById("manualReadBtn")?.addEventListener("click",async()=>{
  const btn=document.getElementById("manualReadBtn");
  const oldText=btn?btn.textContent:"";
  try{
    if(btn){btn.disabled=true;btn.textContent="Läser av...";}
    const r=await fetch("/mcu/api/trigger",{method:"GET",cache:"no-store"});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    txt("packetHint","Manuell avläsning skickad");
    setTimeout(loadData,3000);
    setTimeout(loadData,8000);
  }catch(e){
    alert("Kunde inte trigga manuell avläsning. Testa http://ESP-IP/api/trigger direkt och kontrollera nginx /mcu/api/ proxy.");
    console.error("manual read failed:",e);
  }finally{
    if(btn){setTimeout(()=>{btn.disabled=false;btn.textContent=oldText||"Läs av nu";},1200);}
  }
});
document.getElementById("resetWifiBtn")?.addEventListener("click",async()=>{if(!confirm("Rensa WiFi? ESP32 startar om om /clear nås direkt."))return;try{const r=await fetch("/clear",{method:"POST"});alert(r.ok?"WiFi reset skickad.":"Kunde inte resetta WiFi via web. Kör CLEARWIFI i Serial Monitor.")}catch(e){alert("Reset WiFi finns i ESP setup-portal eller via CLEARWIFI i Serial Monitor.")}});

function n(v,d=1){return v==null||Number.isNaN(Number(v))?"--":Number(v).toFixed(d)}
function pickNum(o,...names){for(const k of names){const x=Number(o?.[k]);if(o&&o[k]!=null&&Number.isFinite(x))return x}return null}
function avgNums(a){const v=(Array.isArray(a)?a:[]).map(Number).filter(Number.isFinite);return v.length?v.reduce((s,x)=>s+x,0)/v.length:null}
function sdNums(a){const v=(Array.isArray(a)?a:[]).map(Number).filter(Number.isFinite);if(v.length<2)return null;const m=avgNums(v);return Math.sqrt(v.reduce((s,x)=>s+(x-m)*(x-m),0)/(v.length-1))}
function statsNums(a){const v=(Array.isArray(a)?a:[]).map(Number).filter(Number.isFinite);if(!v.length)return null;const min=Math.min(...v),max=Math.max(...v),avg=v.reduce((s,x)=>s+x,0)/v.length;return{min,max,avg,span:max-min,sd:sdNums(v),n:v.length}}
function fmtStat(v,d=3,unit=""){return v==null||Number.isNaN(Number(v))?"--":`${Number(v).toFixed(d)}${unit}`}
function setStabilitySummary(history){
  const phS=statsNums((Array.isArray(history)?history:[]).map(x=>x?.ph));
  const clS=statsNums((Array.isArray(history)?history:[]).map(x=>x?.cl_mg_l));
  const orpS=statsNums((Array.isArray(history)?history:[]).map(x=>x?.orp_mv));

  txt("phSpread",phS?`${fmtStat(phS.min,2)}–${fmtStat(phS.max,2)} · Δ ${fmtStat(phS.span,2)}`:"--");
  txt("clSpread",clS?`${fmtStat(clS.min,2)}–${fmtStat(clS.max,2)} mg/L · Δ ${fmtStat(clS.span,2)}`:"--");
  txt("orpSpread",orpS?`${fmtStat(orpS.min,0)}–${fmtStat(orpS.max,0)} mV · Δ ${fmtStat(orpS.span,0)}`:"--");

  const verdict=document.getElementById("stabilityVerdict");
  if(verdict){
    const tags=[];
    if(phS&&phS.n>=8) tags.push(phS.span<0.04?"pH stabilt":"pH varierar");
    if(clS&&clS.n>=8) tags.push(clS.span<0.12?"klor stabilt":"klor varierar");
    if(orpS&&orpS.n>=8) tags.push(orpS.span<25?"ORP stabilt":"ORP varierar");
    verdict.textContent=tags.length?tags.slice(0,2).join(" · "):"Samlar data";
  }
}
// Om firmware/backend skickar raw_cl_mg_l visas rå-klor som svag referenslinje.
function clRawValue(o){
  // Accept several possible raw chlorine field names from backend/firmware.
  const names=["raw_cl_mg_l","cl_raw_mg_l","raw_cl","cl_raw","chlorine_raw_mg_l","cl_est_mg_l"];
  for(const k of names){
    const x=Number(o?.[k]);
    if(o && o[k]!=null && Number.isFinite(x) && x>=0 && x<=10) return x;
  }
  return null;
}
function ensureClInfo(){let e=document.getElementById("clInfo");if(e)return e;const card=document.getElementById("clCard");if(!card)return null;e=document.createElement("small");e.id="clInfo";e.className="metric-note";e.textContent="Klor stabiliserat";card.appendChild(e);return e}
function setClInfo(latest,history){
  const e=ensureClInfo();if(!e)return;
  const v=Number(latest?.cl_mg_l);
  const est=Number(latest?.cl_est_mg_l);
  const status=String(latest?.chlorine_status||"");
  if(latest?.chlorine_valid===false||status.includes("invalid")){
    e.textContent=Number.isFinite(est)?`Råklor ogiltigt · ORP-estimat ${est.toFixed(2)} mg/L`:"Råklor ogiltigt";
    return;
  }
  if(!Number.isFinite(v)){e.textContent="Klor saknar giltig data";return}
  if(v<1.0)e.textContent="Öka klorhalt";
  else if(v>3.0)e.textContent="Sänk/avvakta klor";
  else e.textContent="Rek. 1.0–3.0 mg/L";
}
function first(...a){for(const v of a){const x=Number(v);if(v!=null&&Number.isFinite(x)&&x>=0)return x}return null}
function firstSigned(...a){for(const v of a){const x=Number(v);if(v!=null&&Number.isFinite(x))return x}return null}
function txt(id,t){const e=document.getElementById(id);if(e)e.textContent=t}
function fmt(ts){
  if(!ts)return"--";
  const d=new Date(ts*1000);

  if(currentRange==="day"){
    return d.toLocaleTimeString("sv-SE",{hour:"2-digit",minute:"2-digit"});
  }

  if(currentRange==="week"){
    const wd=d.toLocaleDateString("sv-SE",{weekday:"short"}).replace(".","");
    const hm=d.toLocaleTimeString("sv-SE",{hour:"2-digit"});
    return `${wd} ${hm}`;
  }

  return d.toLocaleDateString("sv-SE",{day:"numeric",month:"short"}).replace(".","");
}
async function get(u){const r=await fetch(u,{cache:"no-store"});if(!r.ok)throw Error(`${u} HTTP ${r.status}`);return await r.json()}
function sortByTimeAscending(a){
  return (Array.isArray(a)?a:[])
    .slice()
    .sort((x,y)=>{
      const ax=Number(x?.ts_unix ?? x?.ts ?? x?.created_at ?? 0);
      const ay=Number(y?.ts_unix ?? y?.ts ?? y?.created_at ?? 0);
      return ax-ay;
    });
}
function hist(h){return h&&Array.isArray(h.data)?h.data:Array.isArray(h)?h:[]}
function ds(a,m=550){
  if(!Array.isArray(a)||a.length<=m)return a;
  const out=[];
  const step=(a.length-1)/(m-1);
  for(let i=0;i<m;i++){
    out.push(a[Math.round(i*step)]);
  }
  return out;
}
function secText(a){if(a==null||Number.isNaN(Number(a)))return"okänd tid";a=Number(a);if(a<90)return`${Math.round(a)} s sedan`;const m=Math.round(a/60);if(m<120)return`${m} min sedan`;const h=(a/3600).toFixed(1).replace(".0","");return`${h} tim sedan`}
function friendlyHeartbeatText(age){
  if(age==null || Number.isNaN(Number(age))) return "Väntar";
  age = Number(age);
  if(age <= ESP_ONLINE_SECONDS) return "Live";
  if(age <= 600) return "Ingen ny signal";
  return "Offline";
}
function friendlyPacketHint(age, espOnline){
  if(age==null || Number.isNaN(Number(age))) return "status okänd";
  return espOnline ? "ESP online" : "ESP saknas";
}
function rssi(r){if(r==null||Number.isNaN(Number(r))||Number(r)<=-999)return{level:0,text:"Ingen kontakt",cls:"bad"};r=Number(r);if(r>=-60)return{level:4,text:"Bra",cls:"good"};if(r>=-75)return{level:3,text:"Okej",cls:"good"};if(r>=-85)return{level:2,text:"Svag",cls:"warn"};return{level:1,text:"Mycket svag",cls:"bad"}}
function setSig(p,r,overrideText=null,overrideCls=null){const q=rssi(r);txt(`${p}Rssi`,r==null||Number(r)<=-999?"-- dBm":`${r} dBm`);const h=document.getElementById(`${p}Hint`);if(h){h.textContent=overrideText||q.text;h.className=overrideCls||q.cls}const b=document.getElementById(`${p}SignalBars`);if(b){b.className=`signal-bars level-${q.level} ${overrideCls||q.cls}`;b.innerHTML="<i></i><i></i><i></i><i></i>"}}
function clsRange(v,l,lo="lågt",hi="högt"){if(v==null||Number.isNaN(Number(v)))return{state:"unknown",text:"saknar data",score:50};v=Number(v);if(v>=l.okLow&&v<=l.okHigh)return{state:"ok",text:"OK",score:100};if(v<l.critLow)return{state:"critical",text:`akut ${lo}`,score:20};if(v>l.critHigh)return{state:"critical",text:`akut ${hi}`,score:20};return v<l.okLow?{state:"low",text:lo,score:65}:{state:"high",text:hi,score:65}}
function clsTemp(v){if(v==null||Number.isNaN(Number(v)))return{state:"unknown",text:"saknar data",score:50,cls:""};v=Number(v);if(v<15)return{state:"low",text:"Kallt",score:70,cls:"temp-cold"};if(v<30)return{state:"ok",text:"Normal pool",score:100,cls:"temp-normal"};if(v<=38)return{state:"ok",text:"Varmt pool/spa",score:100,cls:"temp-normal"};if(v<=40)return{state:"high",text:"Varmt",score:75,cls:"temp-warm"};return{state:"critical",text:"För varmt",score:35,cls:"temp-hot"}}
function liionHintFromPct(v){
  if(v==null||Number.isNaN(Number(v)))return "saknar data";
  v=Number(v);
  if(v>=85)return "nästan fullt";
  if(v>=65)return "bra nivå";
  if(v>=40)return "okej nivå";
  if(v>=25)return "planera laddning";
  return "ladda snart";
}
function clsBat(v){if(v==null||Number.isNaN(Number(v)))return{state:"unknown",text:"saknar data",score:60};v=Number(v);if(v>=65)return{state:"ok",text:liionHintFromPct(v),score:100};if(v>=40)return{state:"high",text:liionHintFromPct(v),score:70};if(v>=25)return{state:"high",text:liionHintFromPct(v),score:45};return{state:"critical",text:liionHintFromPct(v),score:20}}
function dot(id,s){const e=document.getElementById(id);if(e)e.className=`status-dot ${s}`}
function setTemp(v,r){const e=document.getElementById("tempCard");if(e){e.classList.remove("temp-cold","temp-normal","temp-warm","temp-hot");if(r.cls)e.classList.add(r.cls)}dot("tempDot",r.state);txt("tempHint",r.text)}
function setM(dotId,hintId,r){dot(dotId,r.state);txt(hintId,r.text)}
function trend(h,f){if(!Array.isArray(h)||h.length<4)return"→";const c=h.map(x=>Number(x[f])).filter(Number.isFinite);if(c.length<4)return"→";const recent=c.slice(-4).reduce((a,b)=>a+b,0)/4;const p=c.slice(-12,-8);const prior=p.length?p.reduce((a,b)=>a+b,0)/p.length:c[0];const d=recent-prior;const th={temp_c:.25,ph:.04,orp_mv:8,cl_mg_l:.08}[f]||.1;return d>th?"↗":d<-th?"↘":"→"}
function setCardState(id,state){const e=document.getElementById(id);if(e){e.classList.remove("state-ok","state-warn","state-bad","state-stale");e.classList.add(`state-${state}`)}}
function setPageState(state,ageText){const dash=document.querySelector(".dashboard");if(dash){dash.classList.remove("backend-offline","esp-offline","ble-offline","values-stale","all-ok");dash.classList.add(state)}const d=document.getElementById("onlineDot");if(d){d.classList.remove("online","offline","unknown","stale");d.classList.add(state==="all-ok"?"online":(state==="backend-offline"||state==="esp-offline")?"offline":"stale")}
  const map={"all-ok":"ESP online","values-stale":"ESP online","ble-offline":"ESP online","esp-offline":"ESP saknas","backend-offline":"Backend offline"};txt("onlineState",map[state]||"Okänd");txt("lastSeen",ageText||"--")}
function waterStatus(r, measurementOld, bleOffline, ble){
  const reasons = [];

  if (measurementOld) reasons.push("Gamla mätvärden");
  if (bleOffline) reasons.push("BLE-sensor väntar");

  if (r.cl.state === "critical") reasons.push("Klor kritiskt");
  else if (r.cl.state === "low") reasons.push("Klor för låg");
  else if (r.cl.state === "high") reasons.push("Klor för hög");

  if (r.orp.state === "critical") reasons.push("ORP kritiskt");
  else if (r.orp.state === "low") reasons.push("ORP för låg");
  else if (r.orp.state === "high") reasons.push("ORP för hög");

  if (r.ph.state === "critical") reasons.push("pH kritiskt");
  else if (r.ph.state === "low") reasons.push("pH för låg");
  else if (r.ph.state === "high") reasons.push("pH för hög");

  if (r.temp.state === "critical") reasons.push("Temperatur kritisk");
  else if (r.temp.state === "low") reasons.push("Temperatur låg");
  else if (r.temp.state === "high") reasons.push("Temperatur hög");

  let score =
    r.temp.score * .14 +
    r.ph.score * .24 +
    r.cl.score * .30 +
    r.orp.score * .24 +
    r.battery.score * .04 +
    (rssi(ble).level / 4 * 100) * .04;

  if (measurementOld) score = Math.min(score, 55);
  if (bleOffline) score = Math.min(score, 60);

  score = Math.round(Math.max(0, Math.min(100, score)));

  let title = "Utmärkt";
  let color = "var(--green)";

  if (score < 30) {
    title = "Kritiskt";
    color = "var(--red)";
  } else if (score < 50) {
    title = "Behöver åtgärd";
    color = "var(--red)";
  } else if (score < 70) {
    title = "Kontrollera";
    color = "var(--orange)";
  } else if (score < 85) {
    title = "Bra";
    color = "var(--green)";
  }

  if ((r.cl.state === "critical" || r.cl.state === "low") &&
      (r.orp.state === "critical" || r.orp.state === "low")) {
    title = "Behöver åtgärd";
    reasons.unshift("Klor och ORP för låga");
    color = "var(--red)";
  }

  const detail = reasons.length
    ? [...new Set(reasons)].slice(0, 2).join(" · ")
    : "Alla värden OK";

  return {score, text:title, detail, color};
}
function bleStatusText(s){s=String(s||"unknown");if(s.includes("ok")||s.includes("ready"))return"BLE OK";if(s.includes("trigger_sent"))return"Väntar";if(s.includes("connect_failed"))return"Ej ansluten";if(s.includes("advertisement_not_found"))return"Hittas inte";if(s.includes("not_found"))return"Hittas inte";if(s.includes("booted"))return"Väntar";return s.replaceAll("_"," ")}
function getAges(state,latest){const hb=state?.heartbeat||{};const hbAge=Number(state?.heartbeat_age_seconds);const espAge=Number.isFinite(hbAge)?hbAge:null;const measAge=Number(state?.last_seen_seconds_ago ?? latest?.last_seen_seconds_ago);return{hb,espAge,measAge:Number.isFinite(measAge)?measAge:null}}

let loadingAnimTimer=null;
let loadingAnimStep=0;

function setLastUiRefresh(){
  const t=new Date().toLocaleTimeString("sv-SE",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
  const e=document.getElementById("uiRefreshHint");
  if(e)e.textContent=`UI uppdaterad ${t}`;
}

function setLoadingText(base="Laddar"){
  const dots=[".","..","...",".."];
  const text=`${base}${dots[loadingAnimStep%dots.length]}`;
  txt("onlineState",text);
  txt("lastSeen","hämtar data");
  loadingAnimStep++;
}

function startLoadingAnimation(base="Laddar"){
  stopLoadingAnimation();
  loadingAnimStep=0;
  setLoadingText(base);
  loadingAnimTimer=setInterval(()=>setLoadingText(base),380);
}

function stopLoadingAnimation(){
  if(loadingAnimTimer){
    clearInterval(loadingAnimTimer);
    loadingAnimTimer=null;
  }
}

async function loadData(){startLoadingAnimation("Laddar");try{const [latest,hr,state]=await Promise.all([get(`${BACKEND_API}/pool/latest`),get(`${BACKEND_API}/pool/history?range=${currentRange}`),get(`${BACKEND_API}/pool/state`)]);stopLoadingAnimation();setLastUiRefresh();const all=sortByTimeAscending(hist(hr)),h=ds(all),last=all.length?all[all.length-1]:null,sl=state&&state.latest?state.latest:null;
    const {hb,espAge,measAge}=getAges(state,latest);
    const espOnline=espAge!=null&&espAge<=ESP_ONLINE_SECONDS;
    const measurementOld=measAge==null||measAge>MEASUREMENT_OLD_SECONDS;
    const bleStatus = String(hb?.ble_status || "");
    const bleConnected =
      hb?.ble_connected === true ||
      bleStatus.includes("ok") ||
      bleStatus.includes("ready") ||
      bleStatus.includes("trigger_sent") ||
      bleStatus.includes("measurement_received");
    const bleOffline =
      espOnline &&
      !bleConnected &&
      !measurementOld;
    const pageState=!espOnline?"esp-offline":bleOffline?"ble-offline":measurementOld?"values-stale":"all-ok";
    setPageState(pageState, friendlyHeartbeatText(espAge));

    txt("backendVersion",`Backend: ${state?.backend_version||latest?.backend_version||"--"} · Web: ${FRONTEND_VERSION}`);
    txt("count",state?.measurement_count??"--");
    txt("historyInfo",`${currentRange==="day"?"Visar senaste dygnet":currentRange==="week"?"Visar senaste veckan":"Visar senaste månaden"} · ${all.length} mätpunkter`);
    txt("deviceId",hb?.device_id||latest?.device_id||"--");
    txt("firmwareVersion",`${espOnline?"FW":"Senast FW"}: ${hb?.firmware_version||latest?.firmware_version||"--"}`);
    txt("phInfo","Kontroll med sticka vid avvikelse");

    if(!latest||latest.ok===false){setCardState("wifiCard",espOnline?"ok":"bad");setCardState("bleCard",bleOffline?"bad":"stale");setCardState("packetCard",espOnline?(measurementOld?"warn":"ok"):"bad");setCardState("waterCard","stale");txt("packetAge", friendlyHeartbeatText(espAge));txt("packetHint", friendlyPacketHint(espAge, espOnline));txt("healthScore","--%");txt("healthText","Inga mätvärden");setStabilitySummary([]);drawCharts([],[],[],[],[]);return}

    const wifiRssi=firstSigned(hb?.wifi_rssi_dbm,latest?.wifi_rssi_dbm,sl?.wifi_rssi_dbm,last?.wifi_rssi_dbm);
    const bleRssi=firstSigned(hb?.ble_rssi_dbm,latest?.ble_rssi_dbm,sl?.ble_rssi_dbm,last?.ble_rssi_dbm);
    const bat=first(hb?.battery_pct,latest?.battery_pct,sl?.battery_pct,last?.battery_pct);
    const clValid=latest?.chlorine_valid!==false&&!String(latest?.chlorine_status||"").includes("invalid");
    txt("temp",`${n(latest.temp_c,1)} °C`);txt("ph",n(latest.ph,2));txt("orp",`${n(latest.orp_mv,0)} mV`);txt("cl",clValid?`${n(latest.cl_mg_l,2)} mg/L`:"-- mg/L");txt("battery",bat==null?"-- %":`${bat.toFixed(1)} %`);txt("rawHex",latest.raw_hex||"--");setClInfo(latest,all);setStabilitySummary(all);

    setSig("wifi",wifiRssi,espOnline?null:"ingen heartbeat",espOnline?null:"bad");
    setSig("ble",bleRssi,bleConnected?"ansluten":bleStatusText(hb?.ble_status),bleConnected?"good":"warn");
    txt("packetAge", friendlyHeartbeatText(espAge));
    txt("packetHint", friendlyPacketHint(espAge, espOnline));
    setCardState("wifiCard",espOnline?(rssi(wifiRssi).cls==="bad"?"bad":rssi(wifiRssi).cls==="warn"?"warn":"ok"):"bad");
    setCardState("packetCard",espOnline?(measurementOld?"warn":"ok"):"bad");
    setCardState("bleCard",bleConnected?"ok":espOnline?"warn":"stale");
    setCardState("waterCard",measurementOld?"stale":bleOffline?"warn":"ok");

    const R={temp:clsTemp(latest.temp_c),ph:clsRange(latest.ph,LIMITS.ph,"under mål","över mål"),cl:clsRange(latest.cl_mg_l,LIMITS.cl,"lågt","högt"),orp:clsRange(latest.orp_mv,LIMITS.orp,"under mål","över mål"),battery:clsBat(bat)};setTemp(latest.temp_c,R.temp);setM("phDot","phHint",R.ph);setM("clDot","clHint",R.cl);setM("orpDot","orpHint",R.orp);dot("batteryDot",R.battery.state);txt("batteryHint",R.battery.text);txt("tempTrend",trend(all,"temp_c"));txt("phTrend",trend(all,"ph"));txt("clTrend",trend(all,"cl_mg_l"));txt("orpTrend",trend(all,"orp_mv"));
    const H=waterStatus(R,measurementOld,bleOffline,bleRssi);txt("healthScore",H.text);txt("healthText",H.detail || `${H.score}%`);const hs=document.getElementById("healthScore");if(hs)hs.style.color=H.color;
    const labels=h.map(x=>fmt(x.ts_unix));
    const tempSeries=normalizeTempSeries(h.map(x=>x.temp_c),latest.temp_c);
    drawCharts(labels,tempSeries,h.map(x=>x.ph),h.map(x=>x.cl_mg_l),h.map(x=>x.orp_mv))
  }catch(e){stopLoadingAnimation();setPageState("backend-offline",`API fel: ${e.message}`);setCardState("wifiCard","bad");setCardState("bleCard","bad");setCardState("packetCard","bad");setCardState("waterCard","bad");txt("packetAge","--");txt("packetHint","API fel");txt("healthScore","--%");txt("healthText","Backend saknas");setStabilitySummary([]);console.error(e)}}

const rangeBandPlugin={
  id:"rangeBandPlugin",
  beforeDatasetsDraw(chart){
    const l=chart.options.plugins.rangeBand;
    if(!l)return;

    const {ctx,chartArea,scales}=chart;
    const y=scales.y;
    if(!y||!chartArea)return;

    const guideValues=[l.okLow,l.okHigh]
      .map(Number)
      .filter(v=>Number.isFinite(v)&&v>=y.min&&v<=y.max);

    if(!guideValues.length)return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(chartArea.left,chartArea.top,chartArea.right-chartArea.left,chartArea.bottom-chartArea.top);
    ctx.clip();

    ctx.setLineDash([5,7]);
    ctx.lineWidth=0.85;
    ctx.strokeStyle=l.strokeColor||"rgba(210,235,255,.18)";

    for(const v of guideValues){
      const py=y.getPixelForValue(v);
      ctx.beginPath();
      ctx.moveTo(chartArea.left,py);
      ctx.lineTo(chartArea.right,py);
      ctx.stroke();
    }

    ctx.restore();
  }
};
try{Chart.register(rangeBandPlugin)}catch(e){console.warn("Chart plugin register skipped",e)}

function opts(l,min,max,decimals=2){
  return {
    responsive:true,
    maintainAspectRatio:false,
    animation:false,
    normalized:true,
    interaction:{mode:"nearest",axis:"x",intersect:false},
    plugins:{
      legend:{
        labels:{
          color:"#dbeafe",
          boxWidth:9,
          boxHeight:6,
          padding:8,
          font:{size:10,weight:"700"}
        }
      },
      title:{display:false},
      tooltip:{
        backgroundColor:"rgba(3,10,22,.97)",
        titleColor:"#ffffff",
        bodyColor:"#e8f7ff",
        borderColor:"rgba(75,212,255,.38)",
        borderWidth:1,
        padding:9,
        displayColors:true,
        callbacks:{
          label:(ctx)=>{
            const label=ctx.dataset.label||"";
            const v=Number(ctx.parsed.y);
            if(!Number.isFinite(v))return label;
            if(label.includes("Temp"))return `${label}: ${v.toFixed(1)} °C`;
            if(label.includes("pH"))return `${label}: ${v.toFixed(2)}`;
            if(label.includes("Klor"))return `${label}: ${v.toFixed(2)} mg/L`;
            if(label.includes("ORP"))return `${label}: ${v.toFixed(0)} mV`;
            return `${label}: ${v}`;
          }
        }
      },
      rangeBand:l
    },
    elements:{
      point:{radius:0,hoverRadius:4,hitRadius:8},
      line:{borderWidth:1.05}
    },
    scales:{
      x:{
        grid:{color:"rgba(110,155,205,.10)",drawBorder:false,tickLength:0},
        ticks:{
          color:"#d7e8ff",
          maxTicksLimit:currentRange==="month"?5:5,
          maxRotation:0,
          font:{size:10.5,weight:"700"}
        }
      },
      y:{
        min:min,
        max:max,
        grid:{color:"rgba(110,155,205,.13)",drawBorder:false,tickLength:0},
        ticks:{
          color:"#d7e8ff",
          maxTicksLimit:currentRange==="month"?5:5,
          padding:6,
          font:{size:10.5,weight:"700"},
          callback:(v)=>Number(v).toFixed(decimals)
        }
      }
    }
  };
}

function destroyCharts(){
  const ids=["tempChart","phChart","clChart","orpChart"];
  for(const id of ids){
    try{
      const ch=window.Chart&&Chart.getChart?Chart.getChart(id):null;
      if(ch) ch.destroy();
    }catch(e){console.warn("Chart destroy ignored",id,e)}
  }
  for(const c of [tempChart,phChart,clChart,orpChart]){
    try{if(c&&typeof c.destroy==="function")c.destroy()}catch(e){}
  }
  tempChart=null;phChart=null;clChart=null;orpChart=null;
}

function resetCanvas(id){
  const old=document.getElementById(id);
  if(!old||!old.parentNode)return null;
  try{
    const ch=window.Chart&&Chart.getChart?Chart.getChart(old):null;
    if(ch)ch.destroy();
  }catch(e){}
  const fresh=old.cloneNode(false);
  old.parentNode.replaceChild(fresh,old);
  return fresh;
}

function validNums(a,lo=null,hi=null){
  return (Array.isArray(a)?a:[]).map(Number).filter(v=>Number.isFinite(v)&&(lo===null||v>=lo)&&(hi===null||v<=hi));
}
function visualSeries(a,lo=null,hi=null){
  return (Array.isArray(a)?a:[]).map(v=>{
    if(v === null || v === undefined || v === "") return null;
    const x=Number(v);
    if(!Number.isFinite(x))return null;
    if(lo!==null&&x<lo)return null;
    if(hi!==null&&x>hi)return null;
    return x;
  });
}
function normalizeTempSeries(values, liveTemp){
  const arr=(Array.isArray(values)?values:[]).map(v=>{
    if(v === null || v === undefined || v === "") return null;
    const x=Number(v);
    return Number.isFinite(x)&&x>=-5&&x<=60 ? x : null;
  });

  const live=Number(liveTemp);
  if(Number.isFinite(live)&&live>=-5&&live<=60 && arr.length){
    // Keep latest trusted value matching the top card.
    arr[arr.length-1]=live;
  }
  return arr;
}

function bounds(values,fallbackMin,fallbackMax,pad=.10){
  const v=validNums(values);
  if(!v.length)return{min:fallbackMin,max:fallbackMax};
  let min=Math.min(...v),max=Math.max(...v);
  if(min===max){const p=Math.max(Math.abs(min)*.05,.5);min-=p;max+=p}
  const extra=(max-min)*pad;
  return{min:min-extra,max:max+extra};
}

function centeredBounds(values,fallbackMin,fallbackMax,{minSpan=1,pad=.18,hardMin=null,hardMax=null}={}){
  const v=validNums(values,hardMin,hardMax);
  if(!v.length)return{min:fallbackMin,max:fallbackMax};

  const dataMin=Math.min(...v);
  const dataMax=Math.max(...v);
  const center=(dataMin+dataMax)/2;
  const dataSpan=Math.max(dataMax-dataMin,minSpan);
  const span=dataSpan*(1+pad);

  let min=center-span/2;
  let max=center+span/2;

  if(hardMin!==null && min<hardMin){
    max += hardMin-min;
    min = hardMin;
  }
  if(hardMax!==null && max>hardMax){
    min -= max-hardMax;
    max = hardMax;
  }
  if(hardMin!==null)min=Math.max(min,hardMin);
  if(hardMax!==null)max=Math.min(max,hardMax);

  return{min,max};
}
function data(label,d,color,extra={}){
  return Object.assign({
    label,
    data:d,
    tension:.24,
    cubicInterpolationMode:"monotone",
    borderColor:color,
    backgroundColor:color,
    borderWidth:1.0,
    pointRadius:0,
    pointHoverRadius:4,
    hitRadius:8,
    spanGaps:false
  }, extra);
}


function fixedAxisFor(metric){
  // Compact but clear axes per selected range.
  // Day = close-up, Week = balanced, Month = wider trend view.
  const r=currentRange;
  if(metric==="temp"){
    if(r==="day") return {min:10,max:35};
    if(r==="week") return {min:10,max:40};
    return {min:5,max:40};
  }
  if(metric==="ph"){
    if(r==="day") return {min:6.7,max:8.1};
    if(r==="week") return {min:6.6,max:8.3};
    return {min:6.5,max:8.5};
  }
  if(metric==="cl"){
    if(r==="day") return {min:0,max:2.5};
    if(r==="week") return {min:0,max:3.0};
    return {min:0,max:4.0};
  }
  if(metric==="orp"){
    if(r==="day") return {min:500,max:850};
    if(r==="week") return {min:500,max:900};
    return {min:450,max:950};
  }
  return {min:0,max:1};
}

let chartRenderBusy=false;
function makeChart(canvas,config){
  if(!canvas||!window.Chart)return null;
  try{const ch=Chart.getChart(canvas);if(ch)ch.destroy()}catch(e){}
  return new Chart(canvas,config);
}
function drawCharts(labels,temp,ph,cl,orp){
  if(!window.Chart)return;
  if(chartRenderBusy)return;
  chartRenderBusy=true;
  try{
    destroyCharts();
    const tempCanvas=resetCanvas("tempChart");
    const phCanvas=resetCanvas("phChart");
    const clCanvas=resetCanvas("clChart");
    const orpCanvas=resetCanvas("orpChart");
    if(!tempCanvas||!phCanvas||!clCanvas||!orpCanvas)return;

    const safeLabels=(Array.isArray(labels)?labels:[]).slice().reverse();
    temp=Array.isArray(temp)?temp.slice().reverse():temp;
    ph=Array.isArray(ph)?ph.slice().reverse():ph;
    cl=Array.isArray(cl)?cl.slice().reverse():cl;
    orp=Array.isArray(orp)?orp.slice().reverse():orp;
    const tempData=visualSeries(temp,-5,60);
    const phData=visualSeries(ph,0,14);
    const clData=visualSeries(cl,0,10);
    const orpData=visualSeries(orp,300,1000);

    const latestTemp=[...tempData].reverse().find(v=>Number.isFinite(Number(v)));
    const liveT=Number(latestTemp||20);

    // Data-centered axes: the measured spread gets equal visual room above and below.
    // This avoids lines being glued to the top/bottom of the chart.
    const tb=fixedAxisFor("temp");
    const pb=centeredBounds(phData,6.7,8.1,{minSpan:.60,pad:.18,hardMin:0,hardMax:14});
    const cb=centeredBounds(clData,0,2.5,{minSpan:1.20,pad:.18,hardMin:0,hardMax:10});
    const ob=centeredBounds(orpData,500,850,{minSpan:180,pad:.18,hardMin:300,hardMax:1000});

    tempChart=makeChart(tempCanvas,{
      type:"line",
      data:{labels:safeLabels,datasets:[
        data("Temp °C",tempData,"#43d8ff",{
          borderWidth:1.0,
          pointRadius:0,
          pointHoverRadius:4,
          spanGaps:false
        })
      ]},
      options:opts({
        okLow:15,
        okHigh:30,
        strokeColor:"rgba(67,216,255,.18)"
      },tb.min,tb.max,1)
    });

    phChart=makeChart(phCanvas,{
      type:"line",
      data:{labels:safeLabels,datasets:[
        data("pH",phData,"#6fffc2",{borderWidth:1.05})
      ]},
      options:opts({
        ...LIMITS.ph,
        strokeColor:"rgba(111,255,194,.18)"
      },pb.min,pb.max,2)
    });

    const clSets=[
      data("Klor",clData,"#ffe176",{borderWidth:1.05})
    ];

    clChart=makeChart(clCanvas,{
      type:"line",
      data:{labels:safeLabels,datasets:clSets},
      options:opts({
        ...LIMITS.cl,
        strokeColor:"rgba(255,225,118,.18)"
      },cb.min,cb.max,2)
    });

    orpChart=makeChart(orpCanvas,{
      type:"line",
      data:{labels:safeLabels,datasets:[
        data("ORP mV",orpData,"#a877ff",{borderWidth:1.05})
      ]},
      options:opts({
        ...LIMITS.orp,
        strokeColor:"rgba(168,119,255,.18)"
      },ob.min,ob.max,0)
    });
  }catch(e){
    console.error("Chart render failed:",e);
  }finally{
    chartRenderBusy=false;
  }
}
loadData();
setInterval(()=>{if(!document.hidden)loadData()},30000);

window.addEventListener("pagehide",()=>destroyCharts());
document.addEventListener("visibilitychange",()=>{if(document.hidden)destroyCharts();else setTimeout(loadData,800)});
