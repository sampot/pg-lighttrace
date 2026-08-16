import { createGame, applyAction, getLegalActions, summarize, getOutcome } from "./game.js";
import { GameAudio } from "./audio.js";
import { loadProgress, saveProgress } from "./persist.js";

const META={"id":"pg-lighttrace","title":"光跡圍城","tips":["每次移動都會留下永久光牆。","不能回頭或碰觸任何既有軌跡。","用小圈壓縮 AI 的可走空間。"]};
const LABELS={"room1":"客廳","room2":"暗房","room3":"鐘塔","inspect":"仔細搜查","code1947":"輸入 1947","code7491":"輸入 7491","find1":"黃銅物件","find2":"木質物件","find3":"紙上物件","find4":"紅色物件","placeA":"放置藍門","placeB":"放置橘門","fall":"墜落蓄力","launch":"穿門發射","reset":"重設雙門","next":"換下一人","dig":"分派挖掘","build":"分派搭橋","block":"分派阻擋","march":"人潮前進","up":"↑","right":"→","down":"↓","left":"←","target1":"鎖定 1","target2":"鎖定 2","target3":"鎖定 3","target4":"鎖定 4","target5":"鎖定 5","type":"輸入擊破","tick":"時間前進","lane1":"E","lane2":"A","lane3":"D","lane4":"G","wait":"空拍 +0.5s","prev":"上一詞","guess":"送出猜測","nextMatch":"下一場聯賽","suspect":"換嫌疑人","weapon":"換物證","room":"換房間","suggest":"提出建議","accuse":"正式指控","hunter":"獵人模式","hider":"匿者模式","scan":"掃描附近","answer1":"A","answer2":"B","answer3":"C","answer4":"D"};
const $=(s)=>document.querySelector(s);
const audio=new GameAudio();
let state=META.id==="pg-worddawn"?createGame():createGame({seed:Date.now()%9973});
let progress={};
let recorded=false;

const esc=(v)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const meter=(v)=>Math.max(0,Math.min(100,Number(v.meter??v.progress??0)));
const usefulEntries=(v)=>Object.entries(v).filter(([k,val])=>!["msg","outcome","log","guesses","meter","score"].includes(k)&&["string","number"].includes(typeof val)).slice(0,4);
const HOG_ITEMS=[["黃銅鑰匙","木雕小貓","紙扇","老照片"],["茶罐","郵票","收音機","收據"],["紅傘","車票","紅鐵盒","未寄出的信"]];
const actionLabel=(action)=>META.id==="pg-worddawn"&&action==="next"?"下一詞":META.id==="pg-atticfind"&&action.startsWith("find")?HOG_ITEMS[state.scene][Number(action.at(-1))-1]:LABELS[action]||action;

function board(view){
  const id=META.id;
  if(id==="pg-lockroom")return `<div class="room-map">${["客廳","暗房","鐘塔"].map((n,i)=>`<div class="room ${state.room===i?"active":""}"><b>${["🕰","📷","⚙"][i]}</b><span>${n}</span></div>`).join("")}<span class="clue">${state.seen.length?"🔎":"?"}</span></div>`;
  if(id==="pg-atticfind"){const icons=[["🔑","🐈","🪭","📷"],["🍵","✉️","📻","🧾"],["☂️","🎫","🧰","💌"]][state.scene];return `<div class="hog-scene">${icons.map((x,i)=>`<span class="object ${state.found.includes(state.scene+":"+i)?"found":""}">${x}</span>`).join("")}</div>`}
  if(id==="pg-gatepair")return `<div class="lab" style="--speed:${state.momentum}"><i class="portal a"></i><i class="portal b"></i><i class="orb"></i><span class="lab-label">動量 ×${state.momentum} · ${esc(view.level)}</span></div>`;
  if(id==="pg-festcrowd")return `<div class="route"><span class="temple">⛩️</span><i class="hazard"></i><div class="crowd">${state.crowd.map((p,i)=>`<span class="walker ${state.selected===i?"selected":""}" style="--x:${Math.max(0,p.x)}">${p.safe?"✨":p.job==="build"?"👷":p.job==="dig"?"⛏️":p.job==="block"?"🚧":"🚶"}</span>`).join("")}</div></div>`;
  if(id==="pg-lighttrace"||id==="pg-huntshade"){const size=state.size||8,cells=[];for(let y=0;y<size;y++)for(let x=0;x<size;x++){let cl="cell",text="";if(id==="pg-lighttrace"){if(state.trail.includes(x+","+y))cl+=" trail";if(state.p.x===x&&state.p.y===y)cl+=" player";if(state.ai.x===x&&state.ai.y===y)cl+=" ai"}else{if(state.hunter.x===x&&state.hunter.y===y){cl+=" ai";text="◉"}for(const h of state.hiders)if(!h.caught&&h.x===x&&h.y===y&&(state.role==="hider"||Math.abs(state.hunter.x-x)+Math.abs(state.hunter.y-y)<=3)){cl+=" player";text="◐"}}cells.push(`<i class="${cl}">${text}</i>`)}return `<div class="grid" style="--size:${size}">${cells.join("")}</div>`}
  if(id==="pg-typestorm")return `<div class="storm"><div class="city"></div>${state.words.map((w,i)=>`<span class="word-drop ${state.target===i?"target":""}" style="--i:${i};--y:${w.y}">${esc(w.w)}</span>`).join("")}</div>`;
  if(id==="pg-stringbeat"){const next=state.index;return `<div class="lanes">${["E","A","D","G"].map((n,l)=>`<div class="lane" data-name="${n}">${Array.from({length:7},(_,j)=>{const note=state.index+j;const chartLane=(note*3+(note%7===0?1:0))%4;return chartLane===l?`<i class="note" style="--top:${Math.min(88,j*14)}%"></i>`:""}).join("")}</div>`).join("")}<i class="hitline"></i></div>`}
  if(id==="pg-worddawn"){const rows=state.guesses.map(g=>{const [w,...marks]=g.split(" ");const m=marks.join("");return `<div class="guess-row">${[...w].map((x,i)=>`<i class="tile ${m.includes("🟩")&&[...m].filter(z=>z==="🟩"||z==="🟨"||z==="⬛")[i]==="🟩"?"green":[...m].filter(z=>z==="🟩"||z==="🟨"||z==="⬛")[i]==="🟨"?"yellow":"black"}">${x}</i>`).join("")}</div>`}).join("");return `<div class="word-board">${rows}${Array.from({length:6-state.guesses.length},()=>'<div class="guess-row">'+Array.from({length:5},()=>'<i class="tile"></i>').join("")+'</div>').join("")}<div class="candidate">${esc(view.guess)}</div><div class="keyboard">${"QWERTYUIOPASDFGHJKLZXCVBNM".split("").map(x=>`<span class="key">${x}</span>`).join("")}</div></div>`}
  if(id==="pg-whodunit")return `<div class="caseboard"><div class="evidence"><span>嫌疑人 <b class="pin">●</b></span><strong>${esc(view.suspect)}</strong></div><div class="evidence"><span>物證</span><strong>${esc(view.weapon)}</strong></div><div class="evidence"><span>地點</span><strong>${esc(view.room)}</strong></div><div class="evidence"><span>我的手牌</span><strong>${state.hand.map(esc).join(" · ")}</strong></div></div>`;
  if(id==="pg-quizleague"){const q=state.questions[Math.min(state.index,9)];return `<div class="quiz-stage"><div class="scoreboard"><div><span>YOU</span><strong>${state.score}</strong></div><div><span>AI</span><strong>${state.aiScore}</strong></div><div><span>ELO</span><strong>${state.rating}</strong></div></div><div class="question-card">${esc(q?.text||view.msg)}</div></div>`}
  return `<div class="quiz-stage"><div class="question-card">${esc(view.msg)}</div></div>`;
}

function detail(view){
  if(META.id==="pg-quizleague"&&state.outcome==="playing"&&!state.betweenMatches){const q=state.questions[state.index];return q.choices.map((x,i)=>`${"ABCD"[i]} · ${esc(x)}`).join("<br>")}
  const rows=[];
  if(view.log)rows.push(...view.log);
  if(view.guesses)rows.push(...view.guesses);
  if(state.seen)rows.push(...state.seen.map(x=>"線索 · "+x.text));
  if(state.inventory?.length)rows.push("物品欄 · "+state.inventory.join("、"));
  return rows.length?rows.slice(-6).map(x=>`<div>• ${esc(x)}</div>`).join(""):"";
}

function render(){
  const view=summarize(state),outcome=getOutcome(state);
  $("#message").textContent=view.msg||"";
  $("#progress").style.width=meter(view)+"%";
  $("#board").innerHTML=board(view);
  $("#details").innerHTML=detail(view);
  const stats=usefulEntries(view);
  if(!stats.some(([k])=>k==="score"))stats.push(["score",view.score||0]);
  $("#hud").innerHTML=stats.slice(0,4).map(([k,v])=>`<div><span>${esc(k)}</span><strong>${esc(typeof v==="object"?JSON.stringify(v):v)}</strong></div>`).join("");
  const actions=$("#actions");actions.innerHTML="";
  for(const action of getLegalActions(state)){
    const b=document.createElement("button");b.type="button";b.textContent=actionLabel(action);
    if(action==="accuse")b.className="danger";
    b.addEventListener("click",()=>move(action));actions.append(b);
  }
  if(outcome!=="playing"){
    const b=document.createElement("button");b.type="button";b.className="primary";b.textContent=outcome==="won"?"勝利 · 再玩一次":"重新挑戰";b.addEventListener("click",restart);actions.append(b);
    if(!recorded){recorded=true;void record(view,outcome)}
  }
}

function move(action){audio.play(["launch","type","lane1","lane2","lane3","lane4"].includes(action)?"hit":"click");state=applyAction(state,action);render()}
function restart(){state=createGame({seed:Date.now()%9973});recorded=false;audio.play("ok");render()}
async function record(view,outcome){progress={...progress,bestScore:Math.max(progress.bestScore||0,view.score||0),wins:(progress.wins||0)+(outcome==="won"?1:0),rating:state.rating||progress.rating,lastPlayed:new Date().toISOString()};$("#best").textContent=String(progress.bestScore);await saveProgress(progress)}

$("#start").addEventListener("click",async()=>{await audio.start();audio.play("ok");$("#lobby").hidden=true;$("#game").hidden=false;render()});
$("#sound").addEventListener("click",async()=>{const on=$("#sound").getAttribute("aria-pressed")!=="true";$("#sound").setAttribute("aria-pressed",String(on));$("#sound").textContent=on?"音樂：開":"音樂：關";audio.setEnabled(on);if(on)await audio.start()});
$("#help").addEventListener("click",()=>{$("#sheet-title").textContent="怎麼玩";$("#sheet-body").innerHTML="<ol>"+META.tips.map(x=>"<li>"+esc(x)+"</li>").join("")+"</ol>";$("#sheet").hidden=false;$("#sheet-close").focus()});
$("#sheet-close").addEventListener("click",()=>{$("#sheet").hidden=true;$("#help").focus()});
document.addEventListener("keydown",e=>{if($("#game").hidden||getOutcome(state)!=="playing")return;const map={ArrowUp:"up",ArrowRight:"right",ArrowDown:"down",ArrowLeft:"left",w:"up",d:"right",s:"down",a:"left","1":"answer1","2":"answer2","3":"answer3","4":"answer4"};if(map[e.key]&&getLegalActions(state).includes(map[e.key])){e.preventDefault();move(map[e.key])}});
progress=await loadProgress();if(META.id==="pg-quizleague"&&progress.rating)state.rating=progress.rating;$("#best").textContent=String(progress.bestScore||0);
