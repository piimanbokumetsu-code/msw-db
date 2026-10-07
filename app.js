'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const enc=new TextEncoder(), dec=new TextDecoder();
const DB_NAME='mswdb_secure_v1', STORE='kv';
let db=null,key=null,state=null,meta=null,screen='patients',selectedPatient=null,activeTab='basic',lockTimer=null;
const APP_VERSION='1.0.2';

const masterFields=['ベッド番号','主治医','病名','保険','本人職業','術式','入院元','かかりつけ','家構','KP職業','介護度','入院時介護度','介護連携','ケアマネ・施設','検討会','退院支援','食事','食事：介助量','水分：トロミ','排泄','排泄：介助量','排泄：尿便意','排泄：利用','移乗','移動器具','睡眠','睡眠：薬剤','高次脳','問題行動','スケール','リハ状況','DM注','コール'];
const defaultMasters={
  '進捗ステータス':['未設定','情報収集中','家族調整中','施設調整中','介護申請中','退院先決定','要対応'],
  '経過記録種別':['面談','家族連絡','施設連絡','院内連携','制度・申請','その他'],
  '介護度':['未申請','申請中','非該当','要支援1','要支援2','要介護1','要介護2','要介護3','要介護4','要介護5'],
  '入院時介護度':['未申請','申請中','非該当','要支援1','要支援2','要介護1','要介護2','要介護3','要介護4','要介護5'],
  '食事':['自立','見守り','一部介助','全介助'],
  '移乗':['自立','見守り','一部介助','全介助'],
  '移動器具':['独歩','杖','歩行器','車椅子','ストレッチャー'],
  '睡眠':['良好','不良','不明'],
  'コール':['自立','使用可','使用困難','不明']
};
function ensureStateSchema(){
  if(!state)return;
  state.version=APP_VERSION;
  state.masters??={};
  for(const [k,vals] of Object.entries(defaultMasters)) state.masters[k]=uniq([...(state.masters[k]||[]),...vals]);
  for(const f of masterFields){
    const fromPatients=(state.patients||[]).map(p=>String(p.data?.[f]??'').trim()).filter(Boolean);
    state.masters[f]=uniq([...(state.masters[f]||[]),...fromPatients]);
  }
}
function uniq(a){return [...new Set(a.map(x=>String(x).trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ja',{numeric:true}));}
function masterValues(f,current=''){ensureStateSchema();return uniq([...(state.masters?.[f]||[]),...(current?[current]:[])]);}
function masterSelectHtml(f,v='',attrs='data-field="'+f+'"'){
  const opts=masterValues(f,v).map(x=>`<option value="${esc(x)}" ${String(v)===String(x)?'selected':''}>${esc(x)}</option>`).join('');
  return `<select ${attrs} data-master-field="${esc(f)}"><option value="">未選択</option>${opts}<option value="__add__">＋ リストにない → 新規登録</option></select>`;
}
function bindMasterSelects(root=document){
  root.querySelectorAll?.('[data-master-field]').forEach(el=>el.onchange=async()=>{
    if(el.value!=='__add__')return;
    const f=el.dataset.masterField; const v=(prompt(`${f} の新しい候補を登録してください`)||'').trim();
    if(!v){el.value='';return;}
    state.masters[f]=uniq([...(state.masters[f]||[]),v]);
    await save();
    const addOpt=[...el.options].find(o=>o.value==='__add__');
    const o=document.createElement('option');o.value=v;o.textContent=v;el.insertBefore(o,addOpt);el.value=v;
  });
}

const legacyFields=['ADL調査日','DM注','ＩＤ','KP','KP職業','KP年齢','MMT右下','MMT右上','MMT左下','MMT左上','かかりつけ','ケアマネ・施設','コール','スケール','スケール：点数','ベッド番号','リハ状況','移乗','移動器具','家屋','家構','介護度','介護連携','検討会','高次脳','氏名','主治医','住所','術式','食事','食事：介助量','水分：トロミ','睡眠','睡眠：薬剤','退院支援','調査日','入院元','入院時介護度','入院日','入院日数','排泄','排泄：介助量','排泄：尿便意','排泄：利用','番号','備考','病名','保険','本人職業','問題行動'];
const groups={
  basic:['ベッド番号','ＩＤ','氏名','入院日','主治医','病名','住所','保険','本人職業','術式','入院元','かかりつけ','家構'],
  care:['KP','KP職業','KP年齢','介護度','入院時介護度','介護連携','ケアマネ・施設','検討会','退院支援'],
  adl:['ADL調査日','食事','食事：介助量','水分：トロミ','排泄','排泄：介助量','排泄：尿便意','排泄：利用','移乗','移動器具','睡眠','睡眠：薬剤','高次脳','問題行動','スケール','スケール：点数','MMT右上','MMT右下','MMT左上','MMT左下','リハ状況','DM注','コール'],
};
function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function uid(){return crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2)}
function nowISO(){return new Date().toISOString()}
function fmtDate(v){if(!v)return'';const d=new Date(v);if(isNaN(d))return v;return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`}
function daysSince(v){if(!v)return'';const d=new Date(v);if(isNaN(d))return'';return Math.max(0,Math.floor((Date.now()-d.getTime())/86400000)+1)}
function bedGroup(b){b=String(b||'未配置').toUpperCase();if(b.startsWith('ICU')){const m=b.match(/^ICU(\d)/);return m?`ICU${m[1]}`:'ICU'}const m=b.match(/^(\d{3})/);return m?m[1].slice(0,2)+'0':'その他'}
function humanBytes(n){if(!n)return'0 B';const u=['B','KB','MB','GB'];let i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return `${n.toFixed(i?1:0)} ${u[i]}`}
async function openDB(){return new Promise((res,rej)=>{const r=indexedDB.open(DB_NAME,1);r.onupgradeneeded=()=>r.result.createObjectStore(STORE);r.onsuccess=()=>{db=r.result;res(db)};r.onerror=()=>rej(r.error)})}
function idbGet(k){return new Promise((res,rej)=>{const t=db.transaction(STORE,'readonly').objectStore(STORE).get(k);t.onsuccess=()=>res(t.result);t.onerror=()=>rej(t.error)})}
function idbSet(k,v){return new Promise((res,rej)=>{const t=db.transaction(STORE,'readwrite').objectStore(STORE).put(v,k);t.onsuccess=()=>res();t.onerror=()=>rej(t.error)})}
function idbDel(k){return new Promise((res,rej)=>{const t=db.transaction(STORE,'readwrite').objectStore(STORE).delete(k);t.onsuccess=()=>res();t.onerror=()=>rej(t.error)})}
function b64(a){return btoa(String.fromCharCode(...new Uint8Array(a)))} function unb64(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}
async function derive(pin,salt){const km=await crypto.subtle.importKey('raw',enc.encode(pin),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:250000,hash:'SHA-256'},km,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}
async function encryptObj(obj,k=key){const iv=crypto.getRandomValues(new Uint8Array(12));const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},k,enc.encode(JSON.stringify(obj)));return {iv:b64(iv),ct:b64(ct)}}
async function decryptObj(blob,k=key){const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(blob.iv)},k,unb64(blob.ct));return JSON.parse(dec.decode(pt))}
async function save(){if(!key||!state)return;state.updatedAt=nowISO();await idbSet('data',await encryptObj(state));resetAutoLock()}
function blankState(){return{version:APP_VERSION,patients:[],drugs:[],masters:{},settings:{retentionDays:30,autoLockMin:5,lastBackupAt:null},createdAt:nowISO(),updatedAt:nowISO()}}
async function init(){await openDB();meta=await idbGet('meta');if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});try{if(navigator.storage?.persist)await navigator.storage.persist()}catch(e){}renderLock()}
function renderLock(msg=''){const fresh=!meta;$('#app').innerHTML=`<div class="lockwrap"><div class="lockcard"><h1>MSW患者管理</h1><p>${fresh?'初回設定：この端末用の暗証を作成します。':'暗証を入力してロック解除してください。'}</p>${msg?`<div class="alert">${esc(msg)}</div>`:''}<input id="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="6文字以上" /><button class="btn" id="unlock" style="width:100%">${fresh?'暗証を設定':'ロック解除'}</button><p class="notice">患者情報は端末内で暗号化して保存します。暗証を忘れると復旧できません。端末自体のパスコード・紛失対策も必ず有効にしてください。</p></div></div>`;$('#unlock').onclick=fresh?setup:unlock;$('#pin').onkeydown=e=>{if(e.key==='Enter')$('#unlock').click()};setTimeout(()=>$('#pin').focus(),80)}
async function setup(){const pin=$('#pin').value;if(pin.length<6)return renderLock('暗証は6文字以上にしてください。');const salt=crypto.getRandomValues(new Uint8Array(16));key=await derive(pin,salt);const check=await encryptObj({ok:true});meta={version:1,salt:b64(salt),check,createdAt:nowISO()};await idbSet('meta',meta);state=blankState();ensureStateSchema();await save();purgeExpired();render();}
async function unlock(){try{const pin=$('#pin').value;key=await derive(pin,unb64(meta.salt));await decryptObj(meta.check);const blob=await idbGet('data');state=blob?await decryptObj(blob):blankState();ensureStateSchema();await save();purgeExpired();render()}catch(e){key=null;renderLock('暗証が違います。')}}
function lock(){key=null;state=null;selectedPatient=null;clearTimeout(lockTimer);renderLock()}
function resetAutoLock(){clearTimeout(lockTimer);if(!state)return;lockTimer=setTimeout(lock,(state.settings.autoLockMin||5)*60000)}
['click','touchstart','keydown'].forEach(ev=>document.addEventListener(ev,()=>{if(key)resetAutoLock()},{passive:true}));
function purgeExpired(){if(!state)return;const d=state.settings.retentionDays??30,cut=Date.now()-d*86400000;const before=state.patients.length;state.patients=state.patients.filter(p=>!p.dischargeDate||new Date(p.dischargeDate).getTime()>cut);if(state.patients.length!==before)save()}
function backupDue(){const t=state?.settings?.lastBackupAt;if(!t)return true;return Date.now()-new Date(t).getTime()>7*86400000}
function render(){resetAutoLock();const net=navigator.onLine?'通信あり':'オフライン可';$('#app').innerHTML=`<div class="shell"><header class="topbar"><div class="brand">MSW患者管理</div><span class="pill">本番 Ver.${APP_VERSION}</span><span class="pill">${net}</span>${backupDue()?'<span class="pill backupwarn">要バックアップ</span>':''}<div class="spacer"></div><button class="pill" id="lockBtn">🔒</button></header><main class="content" id="main"></main><nav class="bottomnav"><button class="navbtn ${screen==='patients'?'active':''}" data-screen="patients"><span class="ico">🏥</span>患者</button><button class="navbtn ${screen==='tasks'?'active':''}" data-screen="tasks"><span class="ico">✅</span>要対応</button><button class="navbtn ${screen==='drugs'?'active':''}" data-screen="drugs"><span class="ico">💊</span>薬情</button><button class="navbtn ${screen==='masters'?'active':''}" data-screen="masters"><span class="ico">📋</span>マスター</button><button class="navbtn ${screen==='settings'?'active':''}" data-screen="settings"><span class="ico">⚙️</span>設定</button></nav></div>`;$('#lockBtn').onclick=lock;$$('.navbtn').forEach(b=>b.onclick=()=>{screen=b.dataset.screen;render()});({patients:renderPatients,tasks:renderTasks,drugs:renderDrugs,masters:renderMasters,settings:renderSettings}[screen])()}
function activePatients(){return state.patients.filter(p=>!p.dischargeDate)}
function getStatus(p){return p.status||'未設定'}
function statusTag(s){const c=s.includes('要')?'red':s.includes('決定')?'green':s.includes('施設')?'purple':s==='未設定'?'':'orange';return `<span class="tag ${c}">${esc(s)}</span>`}
function renderPatients(){const ps=activePatients();$('#main').innerHTML=`<div class="hero"><div><h1>入院患者</h1><p>在院患者のみを軽量に管理。退院患者は設定日数後に自動削除します。</p></div><div class="spacer"></div><button class="btn" id="newP">＋患者</button></div><div class="kpis"><div class="kpi"><b>${ps.length}</b><span>在院患者</span></div><div class="kpi"><b>${ps.filter(p=>p.tasks?.some(t=>!t.done)).length}</b><span>要対応あり</span></div><div class="kpi"><b>${ps.filter(p=>getStatus(p).includes('施設')).length}</b><span>施設調整中</span></div><div class="kpi"><b>${ps.filter(p=>getStatus(p).includes('決定')).length}</b><span>退院先決定</span></div></div><div class="toolbar"><input id="q" placeholder="氏名・病名・病床で検索"><select id="ward"><option value="">全病棟</option><option value="一般病棟">一般病棟</option><option value="ICU">ICU</option><option value="その他">その他・未配置</option></select><button class="btn secondary" id="print">朝一患者一覧を印刷</button></div><div id="patientList"></div>`;$('#newP').onclick=()=>openPatient(newPatient());$('#print').onclick=printMorningList;$('#q').oninput=drawPatientList;$('#ward').onchange=drawPatientList;drawPatientList()}
function printText(v,max=0){const a=Array.from(String(v??'').trim());return esc(max?a.slice(0,max).join(''):a.join(''))}
function shortCareLevel(v){const s=String(v||'').trim();return s.replace('要介護','要').replace('要支援','支')}
function printPatientForBed(bed,patients){return patientsForBed(bed,patients)[0]||null}
function printRowHtml(bed,patients){
  const p=printPatientForBed(bed,patients);
  if(!p)return`<tr><td>${esc(bed)}</td>${'<td></td>'.repeat(11)}</tr>`;
  const d=p.data||{},days=daysSince(d['入院日'])||d['入院日数']||'';
  return`<tr><td>${esc(bed)}</td><td>${printText(d['ＩＤ'])}</td><td>${printText(d['氏名'])}</td><td>${esc(shortAdmissionDate(d['入院日']))}</td><td>${printText(d['主治医'],3)}</td><td>${printText(d['住所'],3)}</td><td class="clip">${printText(d['病名'])}</td><td>${esc(shortCareLevel(d['介護度']))}</td><td class="clip">${printText(d['ケアマネ・施設'],12)}</td><td class="memo"></td><td>${printText(d['家構'])}</td><td>${esc(days)}</td></tr>`
}
function printTableHtml(beds,patients){
  return`<table class="morning-table"><colgroup><col class="c-bed"><col class="c-id"><col class="c-name"><col class="c-admit"><col class="c-doc"><col class="c-address"><col class="c-disease"><col class="c-care"><col class="c-facility"><col class="c-memo"><col class="c-family"><col class="c-days"></colgroup><thead><tr>${['部屋','ID','氏名','入院日','主治医','住所','病名','介護度','ケアマネ・施設','メモ','家族','日数'].map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${beds.map(b=>printRowHtml(b,patients)).join('')}</tbody></table>`
}
function printMorningList(){
  const patients=activePatients(),general=layoutBedNumbers(BED_LAYOUT,patients),icu=layoutBedNumbers(ICU_LAYOUT,patients);
  const bedsFor=rooms=>rooms.flatMap(name=>general.find(r=>r.room===name)?.beds||[]);
  const icuBeds=icu.flatMap(r=>r.beds);
  const pages=[
    {ward:'一般病棟',beds:bedsFor(['201','202','203'])},
    {ward:'一般病棟',beds:bedsFor(['205','206','207','208','210','211','212','213'])},
    {ward:'ICU',beds:icuBeds}
  ];
  const d=new Date(),date=`${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
  $('#morningPrint')?.remove();
  const root=document.createElement('div');root.id='morningPrint';root.className='morning-print';
  root.innerHTML=pages.map((pg,i)=>`<section class="morning-page"><div class="morning-head"><h1>入院患者一覧</h1><div>${date}　朝　　${pg.ward}　${i+1}/3</div></div>${printTableHtml(pg.beds,patients)}</section>`).join('');
  document.body.appendChild(root);
  const cleanup=()=>{root.remove();window.removeEventListener('afterprint',cleanup)};
  window.addEventListener('afterprint',cleanup,{once:true});
  setTimeout(()=>window.print(),50);
}
function drawPatientList(){const q=($('#q')?.value||'').trim().toLowerCase(),w=$('#ward')?.value||'',all=activePatients();const filtered=all.filter(p=>patientMatches(p,q)&&(!w||wardForBed(p.data['ベッド番号'])===w));const root=$('#patientList');if(q&&!filtered.length){root.innerHTML='<div class="empty">該当する患者がいません</div>';return}
  const general=layoutBedNumbers(BED_LAYOUT,all),icu=layoutBedNumbers(ICU_LAYOUT,all);let html='';
  if(!w||w==='一般病棟'){html+=`<section class="map-section"><div class="map-section-title"><div><strong>一般病棟</strong><span>病室・ベッドマップ</span></div><span class="count">${general.reduce((n,r)=>n+r.beds.length,0)}床</span></div><div class="room-map">${general.map(room=>roomMapHtml(room,filtered,q)).join('')}</div></section>`}
  if(!w||w==='ICU'){html+=`<section class="map-section"><div class="map-section-title"><div><strong>ICU</strong><span>集中治療室</span></div><span class="count">${icu.reduce((n,r)=>n+r.beds.length,0)}床</span></div><div class="room-map icu-map">${icu.map(room=>roomMapHtml(room,filtered,q,true)).join('')}</div></section>`}
  const other=filtered.filter(p=>wardForBed(p.data['ベッド番号'])==='その他');if((!w||w==='その他')&&other.length)html+=`<section class="map-section"><div class="map-section-title"><div><strong>その他・未配置</strong><span>標準マップ外の患者</span></div><span class="count">${other.length}人</span></div><div class="room-map">${other.map(p=>patientBedHtml(p.data['ベッド番号']||'未配置',p,patientsForBed(p.data['ベッド番号'],all).length>1)).join('')}</div></section>`;
  root.innerHTML=html||'<div class="empty">該当する患者がいません</div>';bindPatientMapEvents()}
const BED_LAYOUT=[
  {room:'201',beds:[1,2,3,4,5,6]},
  {room:'202',beds:[1,2,3,4,5,6]},
  {room:'203',beds:[1,2,3,4,5,6,7]},
  {room:'205',beds:[1,2,3,4,5,6]},
  {room:'206',beds:[1,2,3,4,5,6]},
  {room:'207',beds:[1,2,3,4,5,6]},
  {room:'208',beds:[1,2]},
  {room:'210',beds:[1,2]},
  {room:'211',beds:[1]},
  {room:'212',beds:[1]},
  {room:'213',beds:[1]}
];

const ICU_LAYOUT=[
  {room:'ICU1',beds:[1,2,3,4,5,6,7]},
  {room:'ICU2',beds:[1,2,3,4,5,6,7]},
  {room:'ICU3',beds:[1,2,3,4,5,6,7,8,9]}
];

function normalizeBed(v){return String(v||'').trim().replace(/\s+/g,'').replace(/[‐-‒–—―ー－]/g,'-').toUpperCase()}
function bedKey(room,n){return `${room}-${n}`}
function wardForBed(v){const b=normalizeBed(v);if(/^ICU[123]-\d+$/.test(b))return'ICU';if(/^(201|202|203|205|206|207|208|210|211|212|213)-\d+$/.test(b))return'一般病棟';return'その他'}
function patientMatches(p,q){if(!q)return true;return[p.data['氏名'],p.data['病名'],p.data['ベッド番号'],p.data['主治医']].join(' ').toLowerCase().includes(q)}
function patientsForBed(bed,patients=activePatients()){const key=normalizeBed(bed);return patients.filter(p=>normalizeBed(p.data['ベッド番号'])===key)}
function layoutBedNumbers(layout,patients){
  return layout.map(room=>{
    const nums=[...room.beds];
    patients.forEach(p=>{
      const b=normalizeBed(p.data['ベッド番号']),m=b.match(new RegExp(`^${room.room}-(\\d+)$`));
      if(m&&!nums.includes(+m[1]))nums.push(+m[1]);
    });
    nums.sort((a,b)=>a-b);
    return{room:room.room,beds:nums.map(n=>bedKey(room.room,n))}
  })
}
function shortAdmissionDate(v){if(!v)return'';const d=new Date(v);if(Number.isNaN(d.getTime()))return esc(v);return`${d.getMonth()+1}/${d.getDate()}`}
function patientBedHtml(bed,p,duplicate=false){
  if(!p)return`<button class="bed-slot empty-bed" data-new-bed="${esc(bed)}"><b>${esc(bed)}</b><span>空床</span><small>タップして登録</small></button>`;
  const days=daysSince(p.data['入院日'])||p.data['入院日数']||'',date=shortAdmissionDate(p.data['入院日']),tasks=p.tasks?.filter(t=>!t.done).length||0;
  return`<button class="bed-slot occupied-bed" data-id="${p.id}"><div class="bed-line"><b>${esc(bed)}</b>${duplicate?'<span class="tag red">重複</span>':''}</div><strong>${esc(p.data['氏名']||'氏名未入力')}</strong><span>${date?`${date}入院`:''}${days?`　${esc(days)}日目`:''}</span><span>${esc(p.data['主治医']||'')}</span><div class="tags">${statusTag(getStatus(p))}${tasks?`<span class="tag red">要対応 ${tasks}</span>`:''}</div></button>`
}
function roomMapHtml(room,patients,q){
  return`<div class="room-block"><div class="room-title">${esc(room.room)}</div><div class="bed-grid">${room.beds.map(bed=>{const ps=patientsForBed(bed,patients),p=ps[0]||null;if(q&&!p)return'';return patientBedHtml(bed,p,ps.length>1)}).join('')}</div></div>`
}
function bindPatientMapEvents(){
  $$('.occupied-bed').forEach(x=>x.onclick=()=>openPatient(state.patients.find(p=>p.id===x.dataset.id)));
  $$('.empty-bed').forEach(x=>x.onclick=()=>openPatient(newPatient(x.dataset.newBed)));
}function patientCard(p){const days=daysSince(p.data['入院日'])||p.data['入院日数']||'';const tasks=p.tasks?.filter(t=>!t.done).length||0;return `<article class="patient-card" data-id="${p.id}"><div class="pc-head"><span class="bed">${esc(p.data['ベッド番号']||'未配置')}</span><span class="name">${esc(p.data['氏名']||'氏名未入力')}</span></div><div class="pc-meta"><span>主治医 ${esc(p.data['主治医']||'-')}</span><span>入院 ${esc(days)}日</span><span>${esc(p.data['病名']||'')}</span></div><div class="tags">${statusTag(getStatus(p))}${tasks?`<span class="tag red">要対応 ${tasks}</span>`:''}</div></article>`}
function newPatient(bed=''){const data={};legacyFields.forEach(k=>data[k]='');data['ベッド番号']=bed;return{id:uid(),data,status:'未設定',tasks:[],notes:[],dischargeDate:null,createdAt:nowISO(),updatedAt:nowISO(),_new:true}}
function openPatient(p){selectedPatient=p;activeTab='basic';renderPatientModal()}
function renderPatientModal(){const p=selectedPatient;document.body.insertAdjacentHTML('beforeend',`<div class="modal" id="modal"><div class="sheet"><div class="sheethead"><button class="btn secondary" id="closeM">←</button><div><h2>${esc(p.data['氏名']||'新規患者')}</h2><div class="notice">${esc(p.data['ベッド番号']||'病床未設定')}　${esc(p.data['病名']||'')}</div></div><div class="spacer"></div><button class="btn" id="saveP">保存</button></div><div class="tabs">${[['basic','基本'],['care','家族・介護'],['adl','ADL'],['support','退院支援'],['notes','経過記録']].map(([k,n])=>`<button class="tab ${activeTab===k?'active':''}" data-tab="${k}">${n}</button>`).join('')}</div><div class="sheetbody" id="tabbody"></div></div></div>`);$('#closeM').onclick=closePatient;$('#saveP').onclick=savePatientFromForm;$$('.tab').forEach(t=>t.onclick=()=>{saveFieldsOnly();activeTab=t.dataset.tab;$('#modal').remove();renderPatientModal()});renderTab()}
function closePatient(){if(selectedPatient?._new)selectedPatient=null;$('#modal')?.remove()}
function renderTab(){const root=$('#tabbody'),p=selectedPatient;if(groups[activeTab]){root.innerHTML=`<div class="panel"><div class="form-grid">${groups[activeTab].map(fieldHtml).join('')}</div></div>`;bindMasterSelects(root);return}if(activeTab==='support'){root.innerHTML=`<div class="panel"><h3>退院支援</h3><div class="form-grid"><div class="field"><label>進捗ステータス</label>${masterSelectHtml('進捗ステータス',getStatus(p),'id="status"')}</div><div class="field"><label>退院日</label><input type="date" id="dischargeDate" value="${esc(p.dischargeDate||'')}"></div><div class="field span2"><label>退院支援メモ</label><textarea data-field="退院支援">${esc(p.data['退院支援']||'')}</textarea></div></div></div><div class="panel"><h3>要対応タスク</h3><div id="taskList">${taskListHtml(p)}</div><div class="toolbar"><input id="newTask" placeholder="例：長女へ電話、施設へ空床確認"><button class="btn" id="addTask">追加</button></div></div><div class="panel"><button class="btn danger" id="dischargeNow">退院として登録</button><p class="notice">退院後は設定した保持日数を過ぎると自動削除されます。</p></div>`;$('#addTask').onclick=addTask;$('#dischargeNow').onclick=()=>{if(!$('#dischargeDate').value)$('#dischargeDate').value=new Date().toISOString().slice(0,10);$('#status').value='退院先決定';};bindTaskChecks();bindMasterSelects(root);return}if(activeTab==='notes'){root.innerHTML=`<div class="panel"><h3>経過記録を追加</h3><div class="form-grid"><div class="field"><label>種別</label>${masterSelectHtml('経過記録種別','面談','id="noteType"')}</div><div class="field"><label>日時</label><input id="noteAt" type="datetime-local" value="${new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16)}"></div><div class="field span2"><label>内容</label><textarea id="noteText" placeholder="対応内容・決定事項・次にやること"></textarea></div></div><button class="btn" id="addNote">記録追加</button></div><div class="panel"><h3>時系列</h3><div class="timeline">${notesHtml(p)}</div></div>`;$('#addNote').onclick=addNote;bindMasterSelects(root);return}}
function fieldHtml(f){
  const v=selectedPatient.data[f]??'';
  const long=['備考'].includes(f);
  const type=['入院日','調査日','ADL調査日'].includes(f)?'date':'text';
  const span=['病名','かかりつけ','ケアマネ・施設','リハ状況','問題行動','備考'].includes(f)?'span2':'';
  if(masterFields.includes(f))return `<div class="field ${span}"><label>${esc(f)}</label>${masterSelectHtml(f,v)}</div>`;
  return `<div class="field ${span}"><label>${esc(f)}</label>${long?`<textarea data-field="${esc(f)}">${esc(v)}</textarea>`:`<input data-field="${esc(f)}" type="${type}" value="${esc(v)}">`}</div>`;
}
function saveFieldsOnly(){if(!selectedPatient)return;$$('[data-field]').forEach(el=>selectedPatient.data[el.dataset.field]=el.value);if($('#status'))selectedPatient.status=$('#status').value;if($('#dischargeDate'))selectedPatient.dischargeDate=$('#dischargeDate').value||null}
async function savePatientFromForm(){saveFieldsOnly();if(!selectedPatient.data['氏名']&&!selectedPatient.data['ＩＤ'])return alert('氏名または患者IDを入力してください。');selectedPatient.updatedAt=nowISO();if(selectedPatient._new){delete selectedPatient._new;state.patients.push(selectedPatient)}await save();$('#modal').remove();selectedPatient=null;render()}
function taskListHtml(p){if(!p.tasks?.length)return'<div class="empty">タスクなし</div>';return p.tasks.map((t,i)=>`<label class="settings-row"><span><input type="checkbox" data-task="${i}" ${t.done?'checked':''}> ${esc(t.text)}</span><small>${fmtDate(t.createdAt)}</small></label>`).join('')}
function bindTaskChecks(){$$('[data-task]').forEach(c=>c.onchange=()=>{selectedPatient.tasks[+c.dataset.task].done=c.checked;save()})}
function addTask(){const el=$('#newTask'),v=el.value.trim();if(!v)return;selectedPatient.tasks??=[];selectedPatient.tasks.push({id:uid(),text:v,done:false,createdAt:nowISO()});$('#taskList').innerHTML=taskListHtml(selectedPatient);el.value='';bindTaskChecks();save()}
function notesHtml(p){const a=[...(p.notes||[])].sort((a,b)=>String(b.at).localeCompare(String(a.at)));if(!a.length)return'<div class="empty">経過記録はまだありません</div>';return a.map(n=>`<div class="note"><div class="time">${fmtDate(n.at)} ${new Date(n.at).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}</div><div class="type">${esc(n.type)}</div><div>${esc(n.text).replace(/\n/g,'<br>')}</div></div>`).join('')}
function addNote(){const txt=$('#noteText').value.trim();if(!txt)return;selectedPatient.notes??=[];selectedPatient.notes.push({id:uid(),type:$('#noteType').value,at:new Date($('#noteAt').value).toISOString(),text:txt});save();activeTab='notes';$('#modal').remove();renderPatientModal()}
function renderTasks(){const rows=[];activePatients().forEach(p=>(p.tasks||[]).filter(t=>!t.done).forEach(t=>rows.push({p,t})));$('#main').innerHTML=`<div class="hero"><div><h1>要対応</h1><p>患者横断の未完了タスクです。</p></div></div>${rows.length?`<div class="panel">${rows.map(({p,t})=>`<div class="settings-row taskjump" data-id="${p.id}"><div><b>${esc(p.data['氏名'])}</b> <span class="tag">${esc(p.data['ベッド番号'])}</span><small>${esc(t.text)}</small></div><span>›</span></div>`).join('')}</div>`:'<div class="empty">未完了タスクはありません</div>'}`;$$('.taskjump').forEach(x=>x.onclick=()=>openPatient(state.patients.find(p=>p.id===x.dataset.id)))}
function renderDrugs(){const ds=state.drugs||[];$('#main').innerHTML=`<div class="hero"><div><h1>薬情</h1><p>端末内の簡易薬剤マスター。患者処方そのものは保存しません。</p></div></div><div class="toolbar"><input id="dq" placeholder="薬名・分類・薬効で検索"></div><div id="drugList"></div>`;$('#dq').oninput=drawDrugs;drawDrugs()}
function drawDrugs(){const q=($('#dq')?.value||'').toLowerCase().trim();const a=(state.drugs||[]).filter(d=>!q||[d['薬名'],d['医薬品分類'],d['薬効']].join(' ').toLowerCase().includes(q)).slice(0,100);$('#drugList').innerHTML=a.length?`<div class="drug-list">${a.map(d=>`<article class="drug"><b>${esc(d['薬名'])}</b><div class="small">${esc(d['医薬品分類'])}　${esc(d['薬価'])}</div><div class="effect">${esc(d['薬効'])}</div></article>`).join('')}</div>`:'<div class="empty">薬剤データがありません。設定から「薬剤CSV」を読み込んでください。</div>'}

function renderMasters(){
  ensureStateSchema();
  const fields=['進捗ステータス','経過記録種別',...masterFields];
  $('#main').innerHTML=`<div class="hero"><div><h1>マスター管理</h1><p>入力候補をここで管理します。患者入力中でも「＋ リストにない → 新規登録」から追加できます。</p></div></div>
  <div class="panel"><div class="form-grid"><div class="field span2"><label>編集する項目</label><select id="mf">${fields.map(f=>`<option>${esc(f)}</option>`).join('')}</select></div></div></div>
  <div class="panel"><h3 id="masterTitle"></h3><div class="toolbar"><input id="newMaster" placeholder="新しい候補を入力"><button class="btn" id="addMaster">＋追加</button></div><div id="masterList"></div></div>`;
  $('#mf').onchange=drawMasterList; $('#addMaster').onclick=addMasterFromScreen; $('#newMaster').onkeydown=e=>{if(e.key==='Enter')addMasterFromScreen()}; drawMasterList();
}
function drawMasterList(){
  const f=$('#mf').value, vals=masterValues(f); $('#masterTitle').textContent=`${f}　${vals.length}件`;
  $('#masterList').innerHTML=vals.length?vals.map((v,i)=>`<div class="settings-row"><div><b>${esc(v)}</b></div><button class="btn danger masterDel" data-i="${i}">削除</button></div>`).join(''):'<div class="empty">候補がありません</div>';
  $$('.masterDel').forEach(b=>b.onclick=async()=>{const val=vals[+b.dataset.i];if(!confirm(`「${val}」をマスターから削除しますか？\n既存患者に入力済みの値は消えません。`))return;state.masters[f]=(state.masters[f]||[]).filter(x=>x!==val);await save();drawMasterList()});
}
async function addMasterFromScreen(){
  const f=$('#mf').value,v=$('#newMaster').value.trim();if(!v)return;state.masters[f]=uniq([...(state.masters[f]||[]),v]);$('#newMaster').value='';await save();drawMasterList();
}

async function renderSettings(){
  const est=navigator.storage?.estimate?await navigator.storage.estimate():{};
  const usage=est.usage||0,quota=est.quota||0,pct=quota?Math.min(100,usage/quota*100):0;
  let persisted='未確認'; try{if(navigator.storage?.persisted)persisted=(await navigator.storage.persisted())?'保持を要求済み':'通常保存'}catch(e){}
  const last=state.settings.lastBackupAt?new Date(state.settings.lastBackupAt).toLocaleString('ja-JP'):'まだありません';
  $('#main').innerHTML=`<div class="hero"><div><h1>設定</h1><p>移行・バックアップ・容量・セキュリティを管理します。</p></div></div>
  <div class="panel"><h3>データ移行</h3><div class="settings-row"><div><b>患者CSVを読み込む</b><small>旧FileMakerから出した患者情報CSV。重複患者IDは更新します。</small></div><button class="btn secondary" id="impP">読込</button></div><div class="settings-row"><div><b>薬剤CSVを読み込む</b><small>医薬品分類・薬価・薬効・薬名の4列。</small></div><button class="btn secondary" id="impD">読込</button></div></div>
  <div class="panel"><h3>退院患者の自動削除</h3><div class="settings-row"><div><b>保持日数</b><small>退院日からこの日数を過ぎた患者を完全削除。</small></div><select id="retention"><option value="0">即時</option><option value="7">7日</option><option value="30">30日</option><option value="60">60日</option></select></div><div class="settings-row"><div><b>退院済み</b><small>${state.patients.filter(p=>p.dischargeDate).length}人</small></div><button class="btn danger" id="purge">期限超過を削除</button></div></div>
  <div class="panel"><h3>セキュリティ</h3><div class="settings-row"><div><b>自動ロック</b><small>無操作時に暗証画面へ戻ります。</small></div><select id="autolock"><option value="1">1分</option><option value="5">5分</option><option value="10">10分</option><option value="30">30分</option></select></div><div class="settings-row"><div><b>暗証を変更</b><small>現在の暗証を確認後、新しい暗証でDBを再暗号化します。</small></div><button class="btn secondary" id="changePin">変更</button></div></div>
  <div class="panel"><h3>バックアップ</h3><div class="settings-row"><div><b>暗号化バックアップ</b><small>患者・薬剤・経過記録・マスターを暗号化したまま書き出します。<br>最終：${esc(last)}</small></div><button class="btn secondary" id="backup">書出</button></div><div class="settings-row"><div><b>バックアップ復元</b><small>.mswdb ファイルを読み込みます。</small></div><button class="btn secondary" id="restore">復元</button></div></div>
  <div class="panel"><h3>端末保存</h3><div class="settings-row"><div><b>保存領域</b><small>${esc(persisted)} / 使用量 ${humanBytes(usage)}${quota?' / 上限目安 '+humanBytes(quota):''}</small></div><button class="btn secondary" id="persist">保持を要求</button></div><div class="storagebar"><div style="width:${pct}%"></div></div><p class="notice">iPadではホーム画面から起動してください。写真・PDFは保存しない設計なので、患者情報は非常に小容量です。</p></div>
  <div class="panel"><h3>初期化</h3><div class="settings-row"><div><b>この端末のMSW-DBを全消去</b><small>患者・薬剤・マスター・暗証をすべて削除します。復元にはバックアップが必要です。</small></div><button class="btn danger" id="resetAll">全消去</button></div></div>
  <div class="panel"><div class="notice">MSW-DB 本番 Ver.${APP_VERSION} / 在院 ${activePatients().length}人 / 薬剤 ${state.drugs.length}件</div></div>`;
  $('#retention').value=String(state.settings.retentionDays??30);$('#autolock').value=String(state.settings.autoLockMin??5);
  $('#retention').onchange=async e=>{state.settings.retentionDays=+e.target.value;purgeExpired();await save()};
  $('#autolock').onchange=async e=>{state.settings.autoLockMin=+e.target.value;await save();resetAutoLock()};
  $('#purge').onclick=async()=>{if(!confirm('保持期限を超えた退院患者を完全削除します。よろしいですか？'))return;purgeExpired();await save();renderSettings()};
  $('#impP').onclick=()=>pickFile('.csv',importPatients);$('#impD').onclick=()=>pickFile('.csv',importDrugs);
  $('#backup').onclick=backup;$('#restore').onclick=()=>pickFile('.mswdb,application/json',restore);
  $('#changePin').onclick=changePin;
  $('#persist').onclick=async()=>{try{const ok=navigator.storage?.persist?await navigator.storage.persist():false;alert(ok?'保存領域の保持を要求しました。':'このブラウザでは保持要求を利用できないか、許可されませんでした。');renderSettings()}catch(e){alert('保持要求を実行できませんでした。')}};
  $('#resetAll').onclick=resetAll;
}
async function changePin(){
  const oldPin=prompt('現在の暗証を入力してください'); if(oldPin===null)return;
  try{const oldKey=await derive(oldPin,unb64(meta.salt));await decryptObj(meta.check,oldKey)}catch(e){return alert('現在の暗証が違います。')}
  const np=prompt('新しい暗証（6文字以上）を入力してください');if(np===null)return;if(np.length<6)return alert('6文字以上にしてください。');
  const np2=prompt('確認のため新しい暗証をもう一度入力してください');if(np!==np2)return alert('新しい暗証が一致しません。');
  const salt=crypto.getRandomValues(new Uint8Array(16));const newKey=await derive(np,salt);const newMeta={version:1,salt:b64(salt),check:await encryptObj({ok:true},newKey),createdAt:meta.createdAt||nowISO(),changedAt:nowISO()};
  state.updatedAt=nowISO();await idbSet('data',await encryptObj(state,newKey));await idbSet('meta',newMeta);meta=newMeta;key=newKey;alert('暗証を変更しました。新しい暗証は忘れないでください。');
}
async function resetAll(){
  if(!confirm('この端末のMSW-DBデータをすべて削除します。\nバックアップが無い場合は復元できません。'))return;
  const word=prompt('実行する場合は「全消去」と入力してください');if(word!=='全消去')return;
  await idbDel('data');await idbDel('meta');meta=null;key=null;state=null;selectedPatient=null;alert('全消去しました。');renderLock();
}
function pickFile(accept,cb){const f=$('#fileInput');f.accept=accept;f.value='';f.onchange=()=>{if(f.files[0])cb(f.files[0])};f.click()}
function parseCSV(text){text=text.replace(/^\uFEFF/,'');const rows=[];let row=[],cell='',q=false;for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];if(q){if(c==='"'&&n==='"'){cell+='"';i++}else if(c==='"')q=false;else cell+=c}else{if(c==='"')q=true;else if(c===','){row.push(cell);cell=''}else if(c==='\n'){row.push(cell);rows.push(row);row=[];cell=''}else if(c!=='\r')cell+=c}}if(cell.length||row.length){row.push(cell);rows.push(row)}return rows}
function rowsToObjects(rows){const h=rows[0]||[];return rows.slice(1).filter(r=>r.some(x=>String(x).trim())).map(r=>Object.fromEntries(h.map((k,i)=>[k,r[i]??''])))}
async function importPatients(file){const objs=rowsToObjects(parseCSV(await file.text()));let added=0,updated=0;for(const o of objs){if(!o['氏名']&&!o['ＩＤ'])continue;const idKey=String(o['ＩＤ']||'').trim();let p=idKey?state.patients.find(x=>String(x.data['ＩＤ']||'').trim()===idKey):null;if(!p){p=newPatient();delete p._new;state.patients.push(p);added++}else updated++;legacyFields.forEach(k=>{if(o[k]!==undefined)p.data[k]=o[k]});p.updatedAt=nowISO()}ensureStateSchema();await save();alert(`患者CSV読込完了\n追加 ${added}人 / 更新 ${updated}人`);render()}
async function importDrugs(file){const objs=rowsToObjects(parseCSV(await file.text()));state.drugs=objs.filter(x=>x['薬名']);await save();alert(`薬剤 ${state.drugs.length}件を読み込みました。`);render()}
async function backup(){state.settings.lastBackupAt=nowISO();await save();const pack={format:'MSWDB-BACKUP',version:1,appVersion:APP_VERSION,exportedAt:nowISO(),meta:await idbGet('meta'),data:await idbGet('data')};const blob=new Blob([JSON.stringify(pack)],{type:'application/json'});download(blob,`MSWDB_backup_${new Date().toISOString().slice(0,10)}.mswdb`);setTimeout(()=>{if(screen==='settings')renderSettings();else render()},300)}
async function restore(file){try{const pack=JSON.parse(await file.text());if(pack.format!=='MSWDB-BACKUP')throw new Error();if(!confirm('現在のデータをバックアップ内容で置き換えます。よろしいですか？'))return;await idbSet('meta',pack.meta);await idbSet('data',pack.data);meta=pack.meta;key=null;state=null;alert('復元しました。バックアップ作成時の暗証で再度ロック解除してください。');renderLock()}catch(e){alert('バックアップファイルを読み込めませんでした。')}}
function download(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
init().catch(e=>{document.getElementById('app').innerHTML=`<div class="lockwrap"><div class="lockcard"><h1>起動できません</h1><p>${esc(e.message)}</p><p class="notice">HTTPSで開いているか確認してください。iPadではSafariからホーム画面へ追加して使用します。</p></div></div>`});
