const FRONTEND_VERSION="web-1.1.35-clean-ui";
let tempChart=null,phChart=null,clChart=null,orpChart=null;
const BACKEND_API="/api";
let currentRange="day";
const LIMITS={ph:{okLow:7.0,okHigh:7.8,critLow:6.8,critHigh:8.2},cl:{okLow:1.0,okHigh:3.0,critLow:.3,critHigh:5.0},orp:{okLow:650,okHigh:800,critLow:600,critHigh:900}};
const ESP_ONLINE_SECONDS=90;       // heartbeat every 30s, so 90s is a fair timeout
const MEASUREMENT_OLD_SECONDS=180; // old water values if no real sensor measurement for 3 min

document.getElementById("refreshBtn")?.addEventListener("click",loadData);
document.querySelectorAll(".range-btn").forEach(btn=>btn.addEventListener("click",()=>{document.querySelectorAll(".range-btn").forEach(b=>b.classList.remove("active"));btn.classList.add("active");currentRange=btn.dataset.range||"day";loadData()}));
document.getElementById("pairBtn")?.addEventListener("click",async()=>{try{const r=await fetch("/pair",{method:"POST"});alert(r.ok?"PAIR startad på ESP32.":"PAIR misslyckades. Kör PAIR i Serial Monitor.")}catch(e){alert("PAIR fungerar bara om /pair-routen nås direkt på ESP32. Annars kör PAIR i Serial Monitor.")}});
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
  txt("phSpread",phS?`min ${fmtStat(phS.min,3)} · max ${fmtStat(phS.max,3)} · Δ ${fmtStat(phS.span,3)}`:"--");
  txt("clSpread",clS?`min ${fmtStat(clS.min,3)} · max ${fmtStat(clS.max,3)} · Δ ${fmtStat(clS.span,3)}`:"--");
  txt("orpSpread",orpS?`min ${fmtStat(orpS.min,0," mV")} · max ${fmtStat(orpS.max,0," mV")} · Δ ${fmtStat(orpS.span,0," mV")}`:"--");
  const verdict=document.getElementById("stabilityVerdict");
  if(verdict){
    let msg="Normal stabilitet";
    if(phS&&phS.n>=10&&phS.span<0.015) msg="pH stabilt";
    if(clS&&clS.n>=10&&clS.span<0.030) msg += (msg==="Normal stabilitet"?"":" · ") + "Klor stabilt";
    verdict.textContent=msg;
  }
}
// Om firmware/backend skickar raw_cl_mg_l visas rå-klor som svag referenslinje.
function clRawValue(o){
  const x=Number(o?.raw_cl_mg_l);
  return Number.isFinite(x) && x>=0 && x<=10 ? x : null;
}
function ensureClInfo(){let e=document.getElementById("clInfo");if(e)return e;const card=document.getElementById("clCard");if(!card)return null;e=document.createElement("small");e.id="clInfo";e.className="metric-note";e.textContent="Klor stabiliserat";card.appendChild(e);return e}
function setClInfo(latest,history){
  const e=ensureClInfo();if(!e)return;
  const sigma=sdNums((Array.isArray(history)?history:[]).slice(-60).map(x=>x?.cl_mg_l));
  const hasRaw=(Array.isArray(history)?history:[]).some(x=>clRawValue(x)!=null) || clRawValue(latest)!=null;
  const parts=["Klor stabiliserat"];
  if(hasRaw)parts.push("rådata finns");
  if(sigma!=null)parts.push(`σ60 ${sigma.toFixed(4)}`);
  e.textContent=parts.join(" · ");
}
function first(...a){for(const v of a){const x=Number(v);if(v!=null&&Number.isFinite(x)&&x>=0)return x}return null}
function firstSigned(...a){for(const v of a){const x=Number(v);if(v!=null&&Number.isFinite(x))return x}return null}
function txt(id,t){const e=document.getElementById(id);if(e)e.textContent=t}
function fmt(ts){if(!ts)return"--";const o=currentRange==="day"?{hour:"2-digit",minute:"2-digit"}:{month:"2-digit",day:"2-digit",hour:"2-digit"};return new Date(ts*1000).toLocaleString("sv-SE",o)}
async function get(u){const r=await fetch(u,{cache:"no-store"});if(!r.ok)throw Error(`${u} HTTP ${r.status}`);return await r.json()}
function hist(h){return h&&Array.isArray(h.data)?h.data:Array.isArray(h)?h:[]}
function ds(a,m=550){if(!Array.isArray(a)||a.length<=m)return a;const s=Math.ceil(a.length/m);return a.filter((_,i)=>i%s===0)}
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
function clsTemp(v){if(v==null||Number.isNaN(Number(v)))return{state:"unknown",text:"saknar data",score:50,cls:""};v=Number(v);if(v<15)return{state:"low",text:"kallt",score:70,cls:"temp-cold"};if(v<30)return{state:"ok",text:"OK pool",score:100,cls:"temp-normal"};if(v<=38)return{state:"ok",text:"OK spa",score:100,cls:"temp-normal"};if(v<=40)return{state:"high",text:"varmt",score:75,cls:"temp-warm"};return{state:"critical",text:"hett",score:35,cls:"temp-hot"}}
function clsBat(v){if(v==null||Number.isNaN(Number(v)))return{state:"unknown",text:"saknar data",score:60};v=Number(v);if(v>=35)return{state:"ok",text:"OK",score:100};if(v>=15)return{state:"high",text:"lågt",score:65};return{state:"critical",text:"kritiskt",score:25}}
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

async function loadData(){try{const [latest,hr,state]=await Promise.all([get(`${BACKEND_API}/pool/latest`),get(`${BACKEND_API}/pool/history?range=${currentRange}`),get(`${BACKEND_API}/pool/state`)]);const all=hist(hr),h=ds(all),last=all.length?all[all.length-1]:null,sl=state&&state.latest?state.latest:null;
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

    if(!latest||latest.ok===false){setCardState("wifiCard",espOnline?"ok":"bad");setCardState("bleCard",bleOffline?"bad":"stale");setCardState("packetCard",espOnline?(measurementOld?"warn":"ok"):"bad");setCardState("waterCard","stale");txt("packetAge", friendlyHeartbeatText(espAge));txt("packetHint", friendlyPacketHint(espAge, espOnline));txt("healthScore","--%");txt("healthText","Inga mätvärden");setStabilitySummary([]);drawCharts([],[],[],[],[]);return}

    const wifiRssi=firstSigned(hb?.wifi_rssi_dbm,latest?.wifi_rssi_dbm,sl?.wifi_rssi_dbm,last?.wifi_rssi_dbm);
    const bleRssi=firstSigned(hb?.ble_rssi_dbm,latest?.ble_rssi_dbm,sl?.ble_rssi_dbm,last?.ble_rssi_dbm);
    const bat=first(hb?.battery_pct,latest?.battery_pct,sl?.battery_pct,last?.battery_pct);
    txt("temp",`${n(latest.temp_c,1)} °C`);txt("ph",n(latest.ph,3));txt("orp",`${n(latest.orp_mv,0)} mV`);txt("cl",`${n(latest.cl_mg_l,3)} mg/L`);txt("battery",bat==null?"-- %":`${bat.toFixed(1)} %`);txt("rawHex",latest.raw_hex||"--");setClInfo(latest,all);setStabilitySummary(all);

    setSig("wifi",wifiRssi,espOnline?null:"ingen heartbeat",espOnline?null:"bad");
    setSig("ble",bleRssi,bleConnected?"ansluten":bleStatusText(hb?.ble_status),bleConnected?"good":"warn");
    txt("packetAge", friendlyHeartbeatText(espAge));
    txt("packetHint", friendlyPacketHint(espAge, espOnline));
    setCardState("wifiCard",espOnline?(rssi(wifiRssi).cls==="bad"?"bad":rssi(wifiRssi).cls==="warn"?"warn":"ok"):"bad");
    setCardState("packetCard",espOnline?(measurementOld?"warn":"ok"):"bad");
    setCardState("bleCard",bleConnected?"ok":espOnline?"warn":"stale");
    setCardState("waterCard",measurementOld?"stale":bleOffline?"warn":"ok");

    const R={temp:clsTemp(latest.temp_c),ph:clsRange(latest.ph,LIMITS.ph,"lågt","högt"),cl:clsRange(latest.cl_mg_l,LIMITS.cl,"lågt","högt"),orp:clsRange(latest.orp_mv,LIMITS.orp,"lågt","högt"),battery:clsBat(bat)};setTemp(latest.temp_c,R.temp);setM("phDot","phHint",R.ph);setM("clDot","clHint",R.cl);setM("orpDot","orpHint",R.orp);dot("batteryDot",R.battery.state);txt("tempTrend",trend(all,"temp_c"));txt("phTrend",trend(all,"ph"));txt("clTrend",trend(all,"cl_mg_l"));txt("orpTrend",trend(all,"orp_mv"));
    const H=waterStatus(R,measurementOld,bleOffline,bleRssi);txt("healthScore",H.text);txt("healthText",H.detail || `${H.score}%`);const hs=document.getElementById("healthScore");if(hs)hs.style.color=H.color;
    drawCharts(h.map(x=>fmt(x.ts_unix)),h.map(x=>x.temp_c),h.map(x=>x.ph),h.map(x=>x.cl_mg_l),h.map(x=>x.orp_mv),h.map(x=>clRawValue(x)))
  }catch(e){setPageState("backend-offline",e.message);setCardState("wifiCard","bad");setCardState("bleCard","bad");setCardState("packetCard","bad");setCardState("waterCard","bad");txt("packetAge","--");txt("packetHint","API fel");txt("healthScore","--%");txt("healthText","Backend saknas");setStabilitySummary([]);console.error(e)}}

const rangeBandPlugin={id:"rangeBandPlugin",beforeDatasetsDraw(chart){const l=chart.options.plugins.rangeBand;if(!l)return;const{ctx,chartArea,scales}=chart,y=scales.y;if(!y||!chartArea)return;const y1=y.getPixelForValue(l.okLow??l.min),y2=y.getPixelForValue(l.okHigh??l.max),top=Math.min(y1,y2),bot=Math.max(y1,y2);ctx.save();ctx.fillStyle=l.fillColor||"rgba(103,255,159,.11)";ctx.fillRect(chartArea.left,top,chartArea.right-chartArea.left,bot-top);ctx.strokeStyle=l.strokeColor||"rgba(103,255,159,.36)";ctx.lineWidth=.5;ctx.setLineDash([4,5]);for(const yy of [y1,y2]){ctx.beginPath();ctx.moveTo(chartArea.left,yy);ctx.lineTo(chartArea.right,yy);ctx.stroke()}ctx.restore()}};
try{Chart.register(rangeBandPlugin)}catch(e){console.warn("Chart plugin register skipped",e)}

function opts(l,min,max,decimals=2){return{responsive:true,maintainAspectRatio:false,animation:false,plugins:{legend:{labels:{color:"#dbeafe",boxWidth:9,font:{size:10,weight:"normal"}}},title:{display:false},rangeBand:l},elements:{point:{radius:currentRange==="day"?.35:0},line:{borderWidth:currentRange==="day"?.75:1.05}},scales:{x:{ticks:{color:"#9fb1c9",maxTicksLimit:5,font:{size:10}},grid:{color:"rgba(80,120,170,.13)"}},y:{suggestedMin:min,suggestedMax:max,ticks:{color:"#9fb1c9",maxTicksLimit:5,font:{size:10},callback:(v)=>Number(v).toFixed(decimals)},grid:{color:"rgba(80,120,170,.14)"}}}}}

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
    const x=Number(v);
    if(!Number.isFinite(x))return null;
    if(lo!==null&&x<lo)return null;
    if(hi!==null&&x>hi)return null;
    return x;
  });
}
function bounds(values,fallbackMin,fallbackMax,pad=.10){
  const v=validNums(values);
  if(!v.length)return{min:fallbackMin,max:fallbackMax};
  let min=Math.min(...v),max=Math.max(...v);
  if(min===max){const p=Math.max(Math.abs(min)*.05,.5);min-=p;max+=p}
  const extra=(max-min)*pad;
  return{min:min-extra,max:max+extra};
}
function data(label,d,color,extra={}){
  return Object.assign({
    label,
    data:d,
    tension:.38,
    cubicInterpolationMode:"monotone",
    borderColor:color,
    backgroundColor:color,
    borderWidth:currentRange==="day"?1.05:1.25,
    pointRadius:currentRange==="day"?.25:0,
    pointHoverRadius:3,
    spanGaps:true
  }, extra);
}

let chartRenderBusy=false;
function makeChart(canvas,config){
  if(!canvas||!window.Chart)return null;
  try{const ch=Chart.getChart(canvas);if(ch)ch.destroy()}catch(e){}
  return new Chart(canvas,config);
}
function drawCharts(labels,temp,ph,cl,orp,clRaw=[]){
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

    const safeLabels=Array.isArray(labels)?labels:[];
    const tempData=visualSeries(temp,-5,60);
    const phData=validNums(ph,0,14);
    const clData=validNums(cl,0,10);
    const clRawData=visualSeries(clRaw,0,10);
    const hasClRaw=clRawData.some(v=>Number.isFinite(Number(v)));
    const orpData=validNums(orp,300,1000);

    const latestTemp=[...tempData].reverse().find(v=>Number.isFinite(Number(v)));
    const tb=Number(latestTemp)>=28?{min:28,max:40}:bounds(tempData,15,25,.12);
    const pb=bounds(phData,6.95,7.05,.35);
    const cb=bounds(clData,1.30,1.60,.35);
    const ob=bounds(orpData,620,840,.10);

    tempChart=makeChart(tempCanvas,{type:"line",data:{labels:safeLabels,datasets:[data("Temp °C",tempData,"#4bd4ff")]},options:opts({okLow:30,okHigh:38,fillColor:"rgba(103,255,159,.08)",strokeColor:"rgba(255,255,255,.20)"},tb.min,tb.max,1)});
    phChart=makeChart(phCanvas,{type:"line",data:{labels:safeLabels,datasets:[data("pH",phData,"#7cffc4")]},options:opts(LIMITS.ph,pb.min,pb.max,3)});
    const clSets=[data("Klor",clData,"#ffe08a")];
    if(hasClRaw)clSets.push(data("Rådata",clRawData,"rgba(255,224,138,.34)",{borderDash:[5,5],borderWidth:.9,pointRadius:0}));
    clChart=makeChart(clCanvas,{type:"line",data:{labels:safeLabels,datasets:clSets},options:opts(LIMITS.cl,cb.min,cb.max,3)});
    orpChart=makeChart(orpCanvas,{type:"line",data:{labels:safeLabels,datasets:[data("ORP mV",orpData,"#a875ff")]},options:opts(LIMITS.orp,ob.min,ob.max,0)});
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
