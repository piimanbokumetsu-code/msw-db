'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const enc=new TextEncoder(), dec=new TextDecoder();
const DB_NAME='mswdb_secure_v1', STORE='kv';
let db=null,key=null,state=null,meta=null,screen='patients',selectedPatient=null,activeTab='basic',lockTimer=null;
const APP_VERSION='1.0.11-photo-candidate';

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
    if(f==='ベッド番号')continue; // Official 67 beds are independent of imported values.
    state.masters[f]=uniq([...(state.masters[f]||[]),...fromPatients]);
  }
}
function uniq(a){return [...new Set(a.map(x=>String(x).trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ja',{numeric:true}));}
function officialBeds(){return [...BED_LAYOUT,...ICU_LAYOUT].flatMap(r=>r.beds.map(n=>bedKey(r.room,n)))}
function masterValues(f,current=''){
  if(f==='ベッド番号')return officialBeds();
  ensureStateSchema();return uniq([...(state.masters?.[f]||[]),...(current?[current]:[])]);
}
function masterSelectHtml(f,v='',attrs='data-field="'+f+'"'){
  if(f==='ベッド番号'){
    const current=String(v||'').trim(),valid=officialBeds().some(b=>normalizeBed(b)===normalizeBed(current));
    const opts=officialBeds().map(b=>`<option value="${esc(b)}" ${normalizeBed(current)===normalizeBed(b)?'selected':''}>${esc(b)}</option>`).join('');
    // Preserve legacy/invalid value until user explicitly chooses a valid bed.
    const legacy=current&&!valid?`<option value="${esc(current)}" selected>その他・未配置（現在：${esc(current)}）</option>`:'';
    return `<select ${attrs} data-master-field="ベッド番号"><option value="" ${!current?'selected':''}>その他・未配置（ベッド未選択）</option>${legacy}${opts}</select>`;
  }
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
function idbSet(k,v){return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||new Error('保存処理が中止されました'));tx.onerror=()=>reject(tx.error||new Error('保存できませんでした'));tx.objectStore(STORE).put(v,k)})}
function idbDeletePair(){return new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,'readwrite');
  tx.oncomplete=()=>resolve();
  tx.onabort=()=>reject(tx.error||new Error('全消去が中止されました'));
  tx.onerror=()=>reject(tx.error||new Error('全消去に失敗しました'));
  const store=tx.objectStore(STORE);
  store.delete('data');store.delete('meta');
})}
// Both encrypted data and its PIN metadata must commit together.
function idbRestorePair(newMeta,newData){return new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,'readwrite');
  tx.oncomplete=()=>resolve();
  tx.onabort=()=>reject(tx.error||new Error('復元トランザクションが中止されました'));
  tx.onerror=()=>reject(tx.error||new Error('復元データを書き込めませんでした'));
  const store=tx.objectStore(STORE);
  store.put(newMeta,'meta');
  store.put(newData,'data');
})}
function validEncryptedBlob(v){return !!v&&typeof v==='object'&&!Array.isArray(v)&&typeof v.iv==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(v.iv)&&typeof v.ct==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(v.ct)&&v.ct.length>0}
function validateBackupEnvelope(pack){
  if(!pack||pack.format!=='MSWDB-BACKUP'||pack.version!==1||!pack.meta||typeof pack.meta!=='object'||typeof pack.meta.salt!=='string'||!validEncryptedBlob(pack.meta.check)||!validEncryptedBlob(pack.data))throw new Error('バックアップ形式が不正です');
  const salt=unb64(pack.meta.salt),iv=unb64(pack.data.iv),checkIv=unb64(pack.meta.check.iv);
  if(salt.length!==16||iv.length!==12||checkIv.length!==12)throw new Error('暗号化データの長さが不正です');
  return pack;
}

function b64(a){return btoa(String.fromCharCode(...new Uint8Array(a)))} function unb64(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}
async function derive(pin,salt){const km=await crypto.subtle.importKey('raw',enc.encode(pin),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:250000,hash:'SHA-256'},km,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}
async function encryptObj(obj,k=key){const iv=crypto.getRandomValues(new Uint8Array(12));const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},k,enc.encode(JSON.stringify(obj)));return {iv:b64(iv),ct:b64(ct)}}
async function decryptObj(blob,k=key){const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(blob.iv)},k,unb64(blob.ct));return JSON.parse(dec.decode(pt))}
async function save(){if(!key||!state)throw new Error('ロック中は保存できません');const previous=state.updatedAt;state.updatedAt=nowISO();try{await idbSet('data',await encryptObj(state));resetAutoLock()}catch(e){state.updatedAt=previous;throw e}}
function blankState(){return{version:APP_VERSION,patients:[],drugs:[],masters:{},settings:{retentionDays:30,autoLockMin:5,lastBackupAt:null},createdAt:nowISO(),updatedAt:nowISO()}}
async function init(){await openDB();meta=await idbGet('meta');if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});try{if(navigator.storage?.persist)await navigator.storage.persist()}catch(e){}renderLock()}
function renderLock(msg=''){document.getElementById('morningPrint')?.remove();const fresh=!meta;$('#app').innerHTML=`<div class="lockwrap"><div class="lockcard"><h1>MSW患者管理</h1><p>${fresh?'初回設定：この端末用の暗証を作成します。':'暗証を入力してロック解除してください。'}</p>${msg?`<div class="alert">${esc(msg)}</div>`:''}<input id="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="6文字以上" /><button class="btn" id="unlock" style="width:100%">${fresh?'暗証を設定':'ロック解除'}</button><p class="notice">患者情報は端末内で暗号化して保存します。暗証を忘れると復旧できません。端末自体のパスコード・紛失対策も必ず有効にしてください。</p></div></div>`;$('#unlock').onclick=fresh?setup:unlock;$('#pin').onkeydown=e=>{if(e.key==='Enter')$('#unlock').click()};setTimeout(()=>$('#pin').focus(),80)}
async function setup(){const pin=$('#pin').value;if(pin.length<6)return renderLock('暗証は6文字以上にしてください。');try{const salt=crypto.getRandomValues(new Uint8Array(16));key=await derive(pin,salt);const check=await encryptObj({ok:true});const newMeta={version:1,salt:b64(salt),check,createdAt:nowISO()};state=blankState();ensureStateSchema();await idbRestorePair(newMeta,await encryptObj(state));meta=newMeta;await purgeExpired();render()}catch(e){key=null;state=null;meta=await idbGet('meta');renderLock('初期設定を保存できませんでした。再度お試しください。')}}
async function unlock(){try{const pin=$('#pin').value;key=await derive(pin,unb64(meta.salt));await decryptObj(meta.check)}catch(e){key=null;return renderLock('暗証が違います。')}try{const blob=await idbGet('data');if(!blob)throw new Error('暗号化患者データが見つかりません');state=await decryptObj(blob);ensureStateSchema();await purgeExpired();render()}catch(e){key=null;state=null;renderLock('保存データを読み込めません。上書きせず、バックアップを確認してください。')}}
function lock(){key=null;state=null;selectedPatient=null;clearTimeout(lockTimer);renderLock()}
function resetAutoLock(){clearTimeout(lockTimer);if(!state)return;lockTimer=setTimeout(lock,(state.settings.autoLockMin||5)*60000)}
['click','touchstart','keydown'].forEach(ev=>document.addEventListener(ev,()=>{if(key)resetAutoLock()},{passive:true}));
// Only the time of *processing* discharge starts the 30-day retention period.
// Legacy records without a processing timestamp must never be silently purged.
function expiredDischarge(p,now=Date.now()){
  if(!p.dischargeDate||!p.dischargeProcessedAt)return false;
  const at=Date.parse(p.dischargeProcessedAt);
  return Number.isFinite(at)&&at<=now-30*86400000;
}
async function purgeExpired(){
  if(!state)return 0;
  const patients=state.patients.filter(p=>!expiredDischarge(p));
  const removed=state.patients.length-patients.length;
  if(!removed)return 0;
  // Persist first: failed writes must not remove patient records from memory.
  const next={...state,patients,updatedAt:nowISO()};
  await idbSet('data',await encryptObj(next));
  state=next;
  return removed;
}
function backupDue(){const t=state?.settings?.lastBackupAt;if(!t)return true;return Date.now()-new Date(t).getTime()>7*86400000}
function render(){resetAutoLock();const net=navigator.onLine?'通信あり':'オフライン可';$('#app').innerHTML=`<div class="shell"><header class="topbar"><div class="brand">MSW患者管理</div><span class="pill">検証版 Ver.${APP_VERSION}</span><span class="pill">${net}</span>${backupDue()?'<span class="pill backupwarn">要バックアップ</span>':''}<div class="spacer"></div><button class="pill" id="lockBtn">🔒</button></header><main class="content" id="main"></main><nav class="bottomnav"><button class="navbtn ${screen==='patients'?'active':''}" data-screen="patients"><span class="ico">🏥</span>患者</button><button class="navbtn ${screen==='tasks'?'active':''}" data-screen="tasks"><span class="ico">✅</span>要対応</button><button class="navbtn ${screen==='drugs'?'active':''}" data-screen="drugs"><span class="ico">💊</span>薬情</button><button class="navbtn ${screen==='masters'?'active':''}" data-screen="masters"><span class="ico">📋</span>マスター</button><button class="navbtn ${screen==='settings'?'active':''}" data-screen="settings"><span class="ico">⚙️</span>設定</button></nav></div>`;$('#lockBtn').onclick=lock;$$('.navbtn').forEach(b=>b.onclick=()=>{screen=b.dataset.screen;render()});({patients:renderPatients,tasks:renderTasks,drugs:renderDrugs,masters:renderMasters,settings:renderSettings}[screen])()}
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
function printExtraTableHtml(patients){
  const headers=['部屋','ID','氏名','入院日','主治医','住所','病名','介護度','ケアマネ・施設','メモ','家族','日数'];
  const rows=patients.map(p=>{
    const d=p.data||{},days=daysSince(d['入院日'])||d['入院日数']||'';
    const cells=[d['ベッド番号']||'未配置',d['ＩＤ'],d['氏名'],shortAdmissionDate(d['入院日']),String(d['主治医']||'').slice(0,3),String(d['住所']||'').slice(0,3),d['病名'],shortCareLevel(d['介護度']),String(d['ケアマネ・施設']||'').slice(0,12),'',d['家構'],days];
    return `<tr>${cells.map(x=>`<td>${printText(x)}</td>`).join('')}</tr>`;
  }).join('');
  return `<table class="morning-table"><colgroup><col class="c-bed"><col class="c-id"><col class="c-name"><col class="c-admit"><col class="c-doc"><col class="c-address"><col class="c-disease"><col class="c-care"><col class="c-facility"><col class="c-memo"><col class="c-family"><col class="c-days"></colgroup><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
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
  const unplaced=patients.filter(p=>!isMappedBed(p.data['ベッド番号']));
  // A second patient on the same official bed must never disappear from print.
  const duplicates=officialBeds().flatMap(b=>patientsForBed(b,patients).slice(1));
  const extra=[...unplaced,...duplicates];
  if(extra.length)pages.push({ward:'その他・未配置／重複',extra});
  const d=new Date(),date=`${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
  $('#morningPrint')?.remove();
  const root=document.createElement('div');root.id='morningPrint';root.className='morning-print';
  root.innerHTML=pages.map((pg,i)=>`<section class="morning-page"><div class="morning-head"><h1>入院患者一覧</h1><div>${date}　朝　　${pg.ward}　${i+1}/${pages.length}</div></div>${pg.extra?printExtraTableHtml(pg.extra):printTableHtml(pg.beds,patients)}</section>`).join('');
  document.body.appendChild(root);
  // iPadOS may dispatch afterprint while the printer is being selected.
  // Keep the print DOM until the next print or app lock, so the preview
  // remains intact during AirPrint's printer-selection re-pagination.
  setTimeout(()=>window.print(),50);
}
function drawPatientList(){const q=($('#q')?.value||'').trim().toLowerCase(),w=$('#ward')?.value||'',all=activePatients();const filtered=all.filter(p=>patientMatches(p,q)&&(!w||wardForBed(p.data['ベッド番号'])===w));const root=$('#patientList');if(q&&!filtered.length){root.innerHTML='<div class="empty">該当する患者がいません</div>';return}
  const general=layoutBedNumbers(BED_LAYOUT,all),icu=layoutBedNumbers(ICU_LAYOUT,all);let html='';
  if(!w||w==='一般病棟'){html+=`<section class="map-section"><div class="map-section-title"><div><strong>一般病棟</strong><span>病室・ベッドマップ</span></div><span class="count">${general.reduce((n,r)=>n+r.beds.length,0)}床</span></div><div class="room-map">${general.filter(room=>!['208','210','211','212','213'].includes(room.room)).map(room=>roomMapHtml(room,filtered,q)).join('')}<div class="compact-room-row">${general.filter(room=>['208','210','211','212','213'].includes(room.room)).map(room=>roomMapHtml(room,filtered,q)).join('')}</div></div></section>`}
  if(!w||w==='ICU'){html+=`<section class="map-section"><div class="map-section-title"><div><strong>ICU</strong><span>集中治療室</span></div><span class="count">${icu.reduce((n,r)=>n+r.beds.length,0)}床</span></div><div class="room-map icu-map">${icu.map(room=>roomMapHtml(room,filtered,q,true)).join('')}</div></section>`}
  const other=filtered.filter(p=>!isMappedBed(p.data['ベッド番号']));if((!w||w==='その他')&&other.length)html+=`<section class="map-section"><div class="map-section-title"><div><strong>その他・未配置</strong><span>標準マップ外の患者</span></div><span class="count">${other.length}人</span></div><div class="room-map">${[...new Map(other.map(p=>[normalizeBed(p.data['ベッド番号']),p.data['ベッド番号']||'未配置'])).values()].map(bed=>patientBedHtml(bed,patientsForBed(bed,filtered))).join('')}</div></section>`;
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
  {room:'211',beds:['']},
  {room:'212',beds:['']},
  {room:'213',beds:['']}
];

const ICU_LAYOUT=[
  {room:'ICU1',beds:[1,2,3,4,5,6,7]},
  {room:'ICU2',beds:[1,2,3,4,5,6,7]},
  {room:'ICU3',beds:[1,2,3,4,5,6,7,8,9]}
];

function normalizeBed(v){return String(v||'').trim().replace(/\s+/g,'').replace(/[‐-‒–—―ー－]/g,'-').toUpperCase()}
function bedKey(room,n){return n===''?room:`${room}-${n}`}
function isMappedBed(v){const b=normalizeBed(v);return [...BED_LAYOUT,...ICU_LAYOUT].some(room=>room.beds.some(n=>normalizeBed(bedKey(room.room,n))===b))}
function wardForBed(v){const b=normalizeBed(v);if(!isMappedBed(b))return'その他';return b.startsWith('ICU')?'ICU':'一般病棟'}
function patientMatches(p,q){if(!q)return true;return[p.data['氏名'],p.data['病名'],p.data['ベッド番号'],p.data['主治医']].join(' ').toLowerCase().includes(q)}
function patientsForBed(bed,patients=activePatients()){const key=normalizeBed(bed);return patients.filter(p=>normalizeBed(p.data['ベッド番号'])===key)}
function layoutBedNumbers(layout,patients){
  // Fixed bed map: imported patient bed numbers never create new bed slots.
  return layout.map(room=>({room:room.room,beds:room.beds.map(n=>bedKey(room.room,n))}));
}
function shortAdmissionDate(v){if(!v)return'';const d=new Date(v);if(Number.isNaN(d.getTime()))return esc(v);return`${d.getMonth()+1}/${d.getDate()}`}
function patientBedHtml(bed,patients=[]){
  if(!patients.length)return`<button class="bed-slot empty-bed" data-new-bed="${esc(bed)}"><b>${esc(bed)}</b><span>空床</span><small>タップして登録</small></button>`;
  if(patients.length>1)return`<button class="bed-slot occupied-bed duplicate-bed" data-bed="${esc(bed)}"><div class="bed-line"><b>${esc(bed)}</b></div><strong>${patients.length}名重複あり</strong><span>タップして全員を表示</span></button>`;
  const p=patients[0],days=daysSince(p.data['入院日'])||p.data['入院日数']||'',date=shortAdmissionDate(p.data['入院日']),tasks=p.tasks?.filter(t=>!t.done).length||0;
  return`<button class="bed-slot occupied-bed" data-id="${esc(p.id)}"><div class="bed-line"><b>${esc(bed)}</b></div><strong>${esc(p.data['氏名']||'氏名未入力')}</strong><span class="bed-meta-line">${esc([date?`${date}入院`:'',String(p.data['主治医']||'').replace(/医師\s*$/,'').trim(),days?`${days}日目`:''].filter(Boolean).join('　'))}</span><div class="tags">${statusTag(getStatus(p))}${tasks?`<span class="tag red">要対応 ${tasks}</span>`:''}</div></button>`;
}
function roomMapHtml(room,patients,q){
  return`<div class="room-block"><div class="room-title">${esc(room.room)}</div><div class="bed-grid">${room.beds.map(bed=>{const ps=patientsForBed(bed,patients);if(q&&!ps.length)return'';return patientBedHtml(bed,ps)}).join('')}</div></div>`;
}
function openDuplicateBed(bed){
  $('#duplicateModal')?.remove();
  const ps=patientsForBed(bed);
  if(ps.length<2){drawPatientList();return}
  const beds=officialBeds();
  document.body.insertAdjacentHTML('beforeend',`<div class="modal" id="duplicateModal"><div class="sheet"><div class="sheethead"><button class="btn secondary" id="closeDuplicate">← 戻る</button><div><h2>${esc(bed)}</h2><div class="notice duplicate-warning">${ps.length}名重複あり・下へスクロールして全員確認できます</div></div></div><div class="duplicate-list">${ps.map((p,i)=>`<article class="panel duplicate-patient"><h3>患者 ${i+1}／${ps.length}</h3><div class="duplicate-patient-row"><div class="duplicate-patient-info">${patientCard(p)}</div><div class="duplicate-move"><label for="move-${i}">ベッド変更</label><select id="move-${i}" class="duplicate-bed-select" data-id="${esc(p.id)}"><option value="${esc(p.data['ベッド番号']||'')}">${esc(p.data['ベッド番号']||'未配置')}（現在）</option>${beds.filter(b=>normalizeBed(b)!==normalizeBed(p.data['ベッド番号'])).map(b=>`<option value="${esc(b)}">${esc(b)}</option>`).join('')}</select><button class="btn duplicate-move-save" data-id="${esc(p.id)}">変更を保存</button></div></div><button class="btn secondary duplicate-open" data-id="${esc(p.id)}">この患者の詳細・編集を開く</button></article>`).join('')}</div></div></div>`);
  $('#closeDuplicate').onclick=()=>$('#duplicateModal')?.remove();
  $$('.duplicate-open').forEach(btn=>btn.onclick=()=>{const p=state.patients.find(p=>p.id===btn.dataset.id);$('#duplicateModal')?.remove();if(p)openPatient(p)});
  $$('.duplicate-move-save').forEach(btn=>btn.onclick=async()=>{
    const p=state.patients.find(p=>p.id===btn.dataset.id);
    const sel=[...$$('.duplicate-bed-select')].find(x=>x.dataset.id===btn.dataset.id);
    if(!p||!sel)return;
    const target=sel.value,old=p.data['ベッド番号'];
    if(normalizeBed(target)===normalizeBed(old)){alert('変更先のベッドを選んでください。');return}
    const occupied=patientsForBed(target).filter(x=>x.id!==p.id).length;
    const message=`${p.data['氏名']||'この患者'}のベッドを ${old||'未配置'} → ${target} に変更します。${occupied?`\n※変更先にはすでに${occupied}名います。重複になります。`:''}\nよろしいですか？`;
    if(!confirm(message))return;
    p.data['ベッド番号']=target;p.updatedAt=nowISO();
    try{await save();drawPatientList();openDuplicateBed(bed)}catch(e){p.data['ベッド番号']=old;alert('保存できませんでした。再度お試しください。')}
  });
}
function bindPatientMapEvents(){
  $$('.duplicate-bed').forEach(x=>x.onclick=()=>openDuplicateBed(x.dataset.bed));
  $$('.occupied-bed:not(.duplicate-bed)').forEach(x=>x.onclick=()=>{const p=state.patients.find(p=>p.id===x.dataset.id);if(p)openPatient(p)});
  $$('.empty-bed').forEach(x=>x.onclick=()=>openPatient(newPatient(x.dataset.newBed)));
}function patientCard(p){const days=daysSince(p.data['入院日'])||p.data['入院日数']||'';const tasks=p.tasks?.filter(t=>!t.done).length||0;return `<article class="patient-card" data-id="${p.id}"><div class="pc-head"><span class="bed">${esc(p.data['ベッド番号']||'未配置')}</span><span class="name">${esc(p.data['氏名']||'氏名未入力')}</span></div><div class="pc-meta"><span>主治医 ${esc(p.data['主治医']||'-')}</span><span>入院 ${esc(days)}日</span><span>${esc(p.data['病名']||'')}</span></div><div class="tags">${statusTag(getStatus(p))}${tasks?`<span class="tag red">要対応 ${tasks}</span>`:''}</div></article>`}
function newPatient(bed=''){const data={};legacyFields.forEach(k=>data[k]='');data['ベッド番号']=bed;return{id:uid(),data,status:'未設定',tasks:[],notes:[],dischargeDate:null,createdAt:nowISO(),updatedAt:nowISO(),_new:true}}
function openPatient(p){selectedPatient=p;activeTab='basic';renderPatientModal()}
function renderPatientModal(){const p=selectedPatient;document.body.insertAdjacentHTML('beforeend',`<div class="modal" id="modal"><div class="sheet"><div class="sheethead"><button class="btn secondary" id="closeM">←</button><div><h2>${esc(p.data['氏名']||'新規患者')}</h2><div class="notice">${esc(p.data['ベッド番号']||'病床未設定')}　${esc(p.data['病名']||'')}</div></div><div class="spacer"></div><button class="btn" id="saveP">保存</button></div><div class="tabs">${[['basic','基本'],['care','家族・介護'],['adl','ADL'],['support','退院支援'],['notes','経過記録'],['genogram','ジェノグラム'],['admissionDoc','入院時情報提供書']].map(([k,n])=>`<button class="tab ${activeTab===k?'active':''}" data-tab="${k}">${n}</button>`).join('')}</div><div class="sheetbody" id="tabbody"></div></div></div>`);$('#closeM').onclick=closePatient;$('#saveP').onclick=savePatientFromForm;$$('.tab').forEach(t=>t.onclick=()=>{saveFieldsOnly();activeTab=t.dataset.tab;$('#modal').remove();renderPatientModal()});renderTab()}
function closePatient(){if(selectedPatient?._new)selectedPatient=null;$('#modal')?.remove()}
function renderTab(){const root=$('#tabbody'),p=selectedPatient;if(activeTab==='genogram'){renderGenogramTab();return}if(activeTab==='admissionDoc'){renderAdmissionDocTab();return}if(groups[activeTab]){root.innerHTML=`<div class="panel"><div class="form-grid">${groups[activeTab].map(fieldHtml).join('')}</div></div>`;bindMasterSelects(root);return}if(activeTab==='support'){root.innerHTML=`<div class="panel"><h3>退院支援</h3><div class="form-grid"><div class="field"><label>進捗ステータス</label>${masterSelectHtml('進捗ステータス',getStatus(p),'id="status"')}</div><div class="field"><label>退院日</label><input type="date" id="dischargeDate" value="${esc(p.dischargeDate||'')}"></div><div class="field span2"><label>退院支援メモ</label><textarea data-field="退院支援">${esc(p.data['退院支援']||'')}</textarea></div></div></div><div class="panel"><h3>要対応タスク</h3><div id="taskList">${taskListHtml(p)}</div><div class="toolbar"><input id="newTask" placeholder="例：長女へ電話、施設へ空床確認"><button class="btn" id="addTask">追加</button></div></div><div class="panel"><button class="btn danger" id="dischargeNow">退院として登録</button><p class="notice">退院後は設定した保持日数を過ぎると自動削除されます。</p></div>`;$('#addTask').onclick=addTask;$('#dischargeNow').onclick=()=>{if(!$('#dischargeDate').value)$('#dischargeDate').value=new Date().toISOString().slice(0,10);$('#status').value='退院先決定';};bindTaskChecks();bindMasterSelects(root);return}if(activeTab==='notes'){root.innerHTML=`<div class="panel"><h3>経過記録を追加</h3><div class="form-grid"><div class="field"><label>種別</label>${masterSelectHtml('経過記録種別','面談','id="noteType"')}</div><div class="field"><label>日時</label><input id="noteAt" type="datetime-local" value="${new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16)}"></div><div class="field span2"><label>内容</label><textarea id="noteText" placeholder="対応内容・決定事項・次にやること"></textarea></div></div><button class="btn" id="addNote">記録追加</button></div><div class="panel"><h3>時系列</h3><div class="timeline">${notesHtml(p)}</div></div>`;$('#addNote').onclick=addNote;bindMasterSelects(root);return}}
// Preview implementation: one encrypted genogram image per patient.
function renderGenogramTab(){
  const p=selectedPatient, root=$('#tabbody');
  const has=!!p.genogramImage;
  root.innerHTML=`<div class="panel"><h3>ジェノグラム</h3><p class="notice">この端末内に暗号化して保存します。撮影後に確認してください。</p>
    ${has?`<img id="genogramPreview" alt="ジェノグラム" src="${p.genogramImage}" style="display:block;max-width:100%;max-height:320px;object-fit:contain;margin:12px 0;cursor:zoom-in">`: '<div class="empty">まだ登録されていません</div>'}
    <input id="genogramInput" type="file" accept="image/*" capture="environment" style="display:none">
    <button class="btn" id="genogramTake">${has?'撮り直す':'撮影・写真を選ぶ'}</button>
    ${has?'<button class="btn secondary" id="genogramDelete">写真を削除</button>':''}</div>`;
  $('#genogramTake').onclick=()=>$('#genogramInput').click();
  $('#genogramInput').onchange=async e=>{
    const file=e.target.files?.[0];if(!file)return;
    if(!file.type.startsWith('image/'))return alert('画像ファイルを選んでください。');
    try{
      const url=await genogramResize(file);
      const viewer=document.createElement('div');viewer.className='modal';viewer.id='genogramConfirm';
      viewer.innerHTML=`<div class="sheet" style="padding:16px"><h2>写真を確認</h2><img alt="保存前の写真" style="max-width:100%;max-height:65vh;object-fit:contain"><div class="toolbar"><button class="btn secondary" id="genogramCancel">撮り直す・キャンセル</button><button class="btn" id="genogramSave">この写真を保存</button></div></div>`;
      document.body.appendChild(viewer);viewer.querySelector('img').src=url;
      $('#genogramCancel').onclick=()=>viewer.remove();
      $('#genogramSave').onclick=async()=>{
        const saveButton=$('#genogramSave');
        if(saveButton.disabled)return;
        saveButton.disabled=true;
        if(p._new){alert('先に患者情報を保存してから写真を登録してください。');viewer.remove();return}
        const previous=p.genogramImage;p.genogramImage=url;
        try{await save();viewer.remove();renderGenogramTab()}catch(err){p.genogramImage=previous;saveButton.disabled=false;alert('写真を保存できませんでした。空き容量をご確認ください。')}
      };
    }catch(err){alert('画像を読み込めませんでした。別の写真でお試しください。')}
  };
  if(has){
    $('#genogramPreview').onclick=()=>{const w=window.open('','_blank');if(w){w.document.title='ジェノグラム';const img=w.document.createElement('img');img.src=p.genogramImage;img.style.cssText='max-width:100%;height:auto';w.document.body.appendChild(img)}};
    $('#genogramDelete').onclick=async()=>{if(!confirm('ジェノグラムの写真を削除しますか？'))return;const old=p.genogramImage;delete p.genogramImage;try{await save();renderGenogramTab()}catch(err){p.genogramImage=old;alert('削除を保存できませんでした。')}};
  }
}
// Safari/iPad may not expose createImageBitmap for camera/HEIC images.
// Fall back to the browser image decoder without uploading the original file.
async function decodeLocalPhoto(file){
  if(typeof createImageBitmap==='function'){
    try{return await createImageBitmap(file)}catch(e){/* use local Image decoder */}
  }
  const objectURL=URL.createObjectURL(file);
  try{
    return await new Promise((resolve,reject)=>{
      const image=new Image();
      image.onload=()=>resolve(image);
      image.onerror=()=>reject(Error('画像を読み込めません'));
      image.src=objectURL;
    });
  }finally{URL.revokeObjectURL(objectURL)}
}
async function genogramResize(file){
  const bitmap=await decodeLocalPhoto(file);
  try{
    const width=bitmap.width||bitmap.naturalWidth,height=bitmap.height||bitmap.naturalHeight;
    if(!width||!height)throw Error('invalid image dimensions');
    const scale=Math.min(1,1800/Math.max(width,height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    const result=canvas.toDataURL('image/jpeg',0.78);
    if(!result.startsWith('data:image/jpeg;base64,')||result.length>2500000)throw Error('image too large');return result;
  }finally{if(typeof bitmap.close==='function')bitmap.close()}
}
// Local-only manual photo adjustment. Original capture remains untouched until Save.
async function adjustDocumentImage(source, rotation=0, margin=0){
  const img=await new Promise((resolve,reject)=>{const el=new Image();el.onload=()=>resolve(el);el.onerror=reject;el.src=source});
  const w=img.naturalWidth,h=img.naturalHeight;
  const inset=Math.floor(Math.min(w,h)*margin/100);
  const cw=w-2*inset,ch=h-2*inset;
  if(cw<20||ch<20)throw Error('crop too small');
  const turn=((rotation%360)+360)%360;
  const swap=turn===90||turn===270;
  const canvas=document.createElement('canvas');canvas.width=swap?ch:cw;canvas.height=swap?cw:ch;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.translate(canvas.width/2,canvas.height/2);ctx.rotate(turn*Math.PI/180);
  ctx.drawImage(img,inset,inset,cw,ch,-cw/2,-ch/2,cw,ch);
  return canvas.toDataURL('image/jpeg',0.78);
}
// Development preview: encrypted multi-page document images, assembled into a PDF for viewing.
function renderAdmissionDocTab(){
  const p=selectedPatient,root=$('#tabbody'),pages=p.admissionDocPages||[];
  root.innerHTML=`<div class="panel"><h3>入院時情報提供書</h3><p class="notice">各ページは暗号化した患者データに保存します。撮影後に確認してから登録してください。PDF表示は端末内で一時生成します。</p>
  <div id="docPages">${pages.length?pages.map((pg,i)=>`<div class="panel" style="margin:10px 0"><div><b>${i+1}ページ目</b></div><img data-page="${i}" alt="${i+1}ページ目" src="${pg.image}" style="max-width:100%;max-height:210px;object-fit:contain;display:block;margin:8px 0"><div class="toolbar"><button class="btn secondary" data-move="up" data-index="${i}" ${i===0?'disabled':''}>↑前へ</button><button class="btn secondary" data-move="down" data-index="${i}" ${i===pages.length-1?'disabled':''}>↓次へ</button><button class="btn secondary" data-retake="${i}">撮り直し</button><button class="btn danger" data-delete="${i}">削除</button></div></div>`).join(''):'<div class="empty">まだ書類は登録されていません</div>'}</div>
  <input id="docInput" type="file" accept="image/*" capture="environment" style="display:none"><button class="btn" id="docAdd">＋ ページを撮影・追加</button> ${pages.length?'<button class="btn secondary" id="docView">PDFで確認</button>':''}<p class="notice">撮影後に90°回転・周囲の余白カットができます。台形・細かな傾き補正は未実装です。ページ順は矢印で変更できます。</p></div>`;
  let replaceIndex=null;
  $('#docAdd').onclick=()=>{replaceIndex=null;$('#docInput').click()};
  root.querySelectorAll('[data-retake]').forEach(b=>b.onclick=()=>{replaceIndex=Number(b.dataset.retake);$('#docInput').click()});
  root.querySelectorAll('[data-move]').forEach(b=>b.onclick=async()=>{const i=Number(b.dataset.index),j=i+(b.dataset.move==='up'?-1:1);if(j<0||j>=pages.length)return;[pages[i],pages[j]]=[pages[j],pages[i]];try{await save();renderAdmissionDocTab()}catch(e){[pages[i],pages[j]]=[pages[j],pages[i]];alert('並び替えを保存できませんでした。')}});
  root.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{const i=Number(b.dataset.delete);if(!confirm(`${i+1}ページ目を削除しますか？`))return;const removed=pages.splice(i,1)[0];try{await save();renderAdmissionDocTab()}catch(e){pages.splice(i,0,removed);alert('削除を保存できませんでした。')}});
  $('#docInput').onchange=async e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;if(!f.type.startsWith('image/'))return alert('画像を選んでください。');
    try{const image=await genogramResize(f);const viewer=document.createElement('div');viewer.className='modal';viewer.innerHTML=`<div class="sheet" style="padding:16px"><h2>ページを確認・補正</h2><p class="notice">回転と周囲の余白カットを調整できます。台形・斜め撮影の自動補正は未対応です。</p><img alt="保存前のページ" style="max-width:100%;max-height:45vh;object-fit:contain"><div class="toolbar"><button class="btn secondary" id="docRotate">90°回転</button><label>余白カット <input id="docCrop" type="range" min="0" max="20" value="0" step="1"></label><span id="docCropValue">0%</span></div><div class="toolbar"><button class="btn secondary" id="docCancel">キャンセル</button><button class="btn" id="docSave">このページを保存</button></div></div>`;document.body.appendChild(viewer);
    let adjusted=image,rotation=0,margin=0,updateSequence=0;
    const preview=viewer.querySelector('img'),saveButton=viewer.querySelector('#docSave');preview.src=image;
    const refresh=async()=>{const seq=++updateSequence;saveButton.disabled=true;try{const result=await adjustDocumentImage(image,rotation,margin);if(seq!==updateSequence)return;adjusted=result;preview.src=result;saveButton.disabled=false;}catch(err){if(seq===updateSequence)alert('画像の補正に失敗しました。')}};
    viewer.querySelector('#docRotate').onclick=()=>{rotation=(rotation+90)%360;refresh()};
    viewer.querySelector('#docCrop').oninput=e=>{margin=Number(e.target.value);viewer.querySelector('#docCropValue').textContent=margin+'%';refresh()};
    viewer.querySelector('#docCancel').onclick=()=>viewer.remove();viewer.querySelector('#docSave').onclick=async()=>{if(saveButton.disabled)return;saveButton.disabled=true;if(p._new){alert('先に患者情報を保存してください。');viewer.remove();return}const pg={image:adjusted,createdAt:nowISO()},old=replaceIndex===null?null:pages[replaceIndex];if(replaceIndex===null)pages.push(pg);else pages[replaceIndex]=pg;try{p.admissionDocPages=pages;await save();viewer.remove();renderAdmissionDocTab()}catch(err){if(replaceIndex===null)pages.pop();else pages[replaceIndex]=old;saveButton.disabled=false;alert('ページを保存できませんでした。容量をご確認ください。')}};
    }catch(err){alert('画像を読み込めませんでした。')}};
  if(pages.length)$('#docView').onclick=async()=>{try{const pdf=await buildAdmissionPdf(pages);const url=URL.createObjectURL(pdf);const w=window.open(url,'_blank');if(!w){URL.revokeObjectURL(url);alert('PDFを開けませんでした。ポップアップ設定をご確認ください。')}else setTimeout(()=>URL.revokeObjectURL(url),120000)}catch(err){alert('PDFの生成に失敗しました。')}};
}
// Minimal offline PDF generator: one JPEG image per A4 page, no external server or library.
async function buildAdmissionPdf(pages){
  const te=new TextEncoder(),parts=[],offsets=[0];let length=0;
  const add=b=>{const v=typeof b==='string'?te.encode(b):b;parts.push(v);length+=v.length};
  const obj=(id,body)=>{offsets[id]=length;add(`${id} 0 obj\n`);add(body);add('\nendobj\n')};
  const n=pages.length;add('%PDF-1.4\n');
  obj(1,'<< /Type /Catalog /Pages 2 0 R >>');
  obj(2,`<< /Type /Pages /Kids [${pages.map((_,i)=>`${3+i*3} 0 R`).join(' ')}] /Count ${n} >>`);
  for(let i=0;i<n;i++){
    const base=3+i*3,src=pages[i].image;
    if(!src.startsWith('data:image/jpeg;base64,'))throw Error('JPEG required');
    const bytes=unb64(src.slice(src.indexOf(',')+1));
    const img=await new Promise((resolve,reject)=>{const el=new Image();el.onload=()=>resolve({w:el.naturalWidth,h:el.naturalHeight});el.onerror=reject;el.src=src});
    const scale=Math.min(555/img.w,802/img.h),w=img.w*scale,h=img.h*scale,x=(595-w)/2,y=(842-h)/2;
    obj(base,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im${i} ${base+1} 0 R >> >> /Contents ${base+2} 0 R >>`);
    offsets[base+1]=length;add(`${base+1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);add(bytes);add('\nendstream\nendobj\n');
    const cmd=`q\n${w.toFixed(3)} 0 0 ${h.toFixed(3)} ${x.toFixed(3)} ${y.toFixed(3)} cm\n/Im${i} Do\nQ\n`;
    obj(base+2,`<< /Length ${te.encode(cmd).length} >>\nstream\n${cmd}endstream`);
  }
  const xref=length,total=2+n*3;add(`xref\n0 ${total+1}\n0000000000 65535 f \n`);
  for(let i=1;i<=total;i++)add(`${String(offsets[i]).padStart(10,'0')} 00000 n \n`);
  add(`trailer\n<< /Size ${total+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(parts,{type:'application/pdf'});
}
function fieldHtml(f){
  const v=selectedPatient.data[f]??'';
  const long=['備考'].includes(f);
  const type=['入院日','調査日','ADL調査日'].includes(f)?'date':'text';
  const span=['病名','かかりつけ','ケアマネ・施設','リハ状況','問題行動','備考'].includes(f)?'span2':'';
  if(masterFields.includes(f))return `<div class="field ${span}"><label>${esc(f)}</label>${masterSelectHtml(f,v)}</div>`;
  return `<div class="field ${span}"><label>${esc(f)}</label>${long?`<textarea data-field="${esc(f)}">${esc(v)}</textarea>`:`<input data-field="${esc(f)}" type="${type}" value="${esc(v)}">`}</div>`;
}
function saveFieldsOnly(){
  if(!selectedPatient)return;
  $$('[data-field]').forEach(el=>selectedPatient.data[el.dataset.field]=el.value);
  if($('#status'))selectedPatient.status=$('#status').value;
  if($('#dischargeDate')){
    const wasDischarged=!!selectedPatient.dischargeDate;
    const date=$('#dischargeDate').value||null;
    selectedPatient.dischargeDate=date;
    if(!date)selectedPatient.dischargeProcessedAt=null;
    else if(!wasDischarged)selectedPatient.dischargeProcessedAt=nowISO();
  }
}
async function savePatientFromForm(){
  if(!selectedPatient)return;
  const patient=selectedPatient;
  const snapshot=JSON.parse(JSON.stringify(patient));
  const wasNew=!!patient._new;
  try{
    saveFieldsOnly();
    if(!patient.data['氏名']&&!patient.data['ＩＤ']){Object.keys(patient).forEach(k=>delete patient[k]);Object.assign(patient,snapshot);return alert('氏名または患者IDを入力してください。')}
    patient.updatedAt=nowISO();
    if(wasNew){delete patient._new;state.patients.push(patient)}
    await save();
    $('#modal').remove();selectedPatient=null;render();
  }catch(e){
    if(wasNew)state.patients=state.patients.filter(p=>p!==patient);
    Object.keys(patient).forEach(k=>delete patient[k]);Object.assign(patient,snapshot);
    alert('患者情報を保存できませんでした。入力内容を確認し、もう一度お試しください。');
  }
}
function taskListHtml(p){if(!p.tasks?.length)return'<div class="empty">タスクなし</div>';return p.tasks.map((t,i)=>`<label class="settings-row"><span><input type="checkbox" data-task="${i}" ${t.done?'checked':''}> ${esc(t.text)}</span><small>${fmtDate(t.createdAt)}</small></label>`).join('')}
function bindTaskChecks(){$$('[data-task]').forEach(c=>c.onchange=async()=>{
  const task=selectedPatient?.tasks?.[+c.dataset.task];if(!task)return;
  const before=task.done;task.done=c.checked;
  try{await save()}catch(e){task.done=before;c.checked=before;alert('タスクの変更を保存できませんでした。')}
})}
async function addTask(){const el=$('#newTask'),v=el.value.trim();if(!v||!selectedPatient)return;
  const patient=selectedPatient;patient.tasks??=[];
  const task={id:uid(),text:v,done:false,createdAt:nowISO()};patient.tasks.push(task);
  try{await save();if(selectedPatient!==patient)return;$('#taskList').innerHTML=taskListHtml(patient);el.value='';bindTaskChecks()}
  catch(e){patient.tasks=patient.tasks.filter(t=>t!==task);alert('タスクを保存できませんでした。')}
}
function notesHtml(p){const a=[...(p.notes||[])].sort((a,b)=>String(b.at).localeCompare(String(a.at)));if(!a.length)return'<div class="empty">経過記録はまだありません</div>';return a.map(n=>`<div class="note"><div class="time">${fmtDate(n.at)} ${new Date(n.at).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}</div><div class="type">${esc(n.type)}</div><div>${esc(n.text).replace(/\n/g,'<br>')}</div></div>`).join('')}
async function addNote(){const txt=$('#noteText').value.trim();if(!txt||!selectedPatient)return;
  const patient=selectedPatient;patient.notes??=[];
  const date=new Date($('#noteAt').value);if(Number.isNaN(date.getTime()))return alert('記録日時を確認してください。');
  const note={id:uid(),type:$('#noteType').value,at:date.toISOString(),text:txt};patient.notes.push(note);
  try{await save();activeTab='notes';$('#modal').remove();renderPatientModal()}
  catch(e){patient.notes=patient.notes.filter(n=>n!==note);alert('経過記録を保存できませんでした。入力内容は残っています。')}
}
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
  <div class="panel"><h3>FileMaker最新データで入れ替え（試験用）</h3><div class="settings-row"><div><b>患者CSVで全件入れ替え</b><small>患者データのみを全件置換します。薬剤・マスター・設定は保持します。患者ID（番号）必須。実行前に件数を確認します。</small></div><button class="btn danger" id="replaceP">全件入れ替え</button></div></div>
  <div class="panel"><h3>退院患者の自動削除</h3><div class="settings-row"><div><b>保持日数</b><small>退院処理から30日後に自動削除。旧データで処理日時が不明な患者は自動削除しません。</small></div><span>30日固定</span></div><div class="settings-row"><div><b>退院済み</b><small>${state.patients.filter(p=>p.dischargeDate).length}人</small></div><button class="btn danger" id="purge">期限超過を削除</button></div></div>
  <div class="panel"><h3>セキュリティ</h3><div class="settings-row"><div><b>自動ロック</b><small>無操作時に暗証画面へ戻ります。</small></div><select id="autolock"><option value="1">1分</option><option value="5">5分</option><option value="10">10分</option><option value="30">30分</option></select></div><div class="settings-row"><div><b>暗証を変更</b><small>現在の暗証を確認後、新しい暗証でDBを再暗号化します。</small></div><button class="btn secondary" id="changePin">変更</button></div></div>
  <div class="panel"><h3>バックアップ</h3><div class="settings-row"><div><b>暗号化バックアップ</b><small>患者・薬剤・経過記録・マスターを暗号化したまま書き出します。<br>最終：${esc(last)}</small></div><button class="btn secondary" id="backup">書出</button></div><div class="settings-row"><div><b>バックアップ復元</b><small>.mswdb ファイルを読み込みます。</small></div><button class="btn secondary" id="restore">復元</button></div></div>
  <div class="panel"><h3>端末保存</h3><div class="settings-row"><div><b>保存領域</b><small>${esc(persisted)} / 使用量 ${humanBytes(usage)}${quota?' / 上限目安 '+humanBytes(quota):''}</small></div><button class="btn secondary" id="persist">保持を要求</button></div><div class="storagebar"><div style="width:${pct}%"></div></div><p class="notice">iPadではホーム画面から起動してください。写真は患者データとともに端末内で暗号化保存されます。容量不足に備え、定期的に暗号化バックアップを保存してください。</p></div>
  <div class="panel"><h3>初期化</h3><div class="settings-row"><div><b>この端末のMSW-DBを全消去</b><small>患者・薬剤・マスター・暗証をすべて削除します。復元にはバックアップが必要です。</small></div><button class="btn danger" id="resetAll">全消去</button></div></div>
  <div class="panel"><div class="notice">MSW-DB 検証版 Ver.${APP_VERSION} / 在院 ${activePatients().length}人 / 薬剤 ${state.drugs.length}件</div></div>`;
  $('#autolock').value=String(state.settings.autoLockMin??5);
  $('#autolock').onchange=async e=>{state.settings.autoLockMin=+e.target.value;await save();resetAutoLock()};
  $('#purge').onclick=async()=>{if(!confirm('保持期限を超えた退院患者を完全削除します。よろしいですか？'))return;try{await purgeExpired();renderSettings()}catch(e){alert('削除結果を保存できませんでした。患者情報は保持されています。')}};
  $('#replaceP').onclick=()=>pickFile('.csv',replacePatientsFromFileMaker);
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
  const previousUpdatedAt=state.updatedAt;
  try{
    state.updatedAt=nowISO();
    const encrypted=await encryptObj(state,newKey);
    await idbRestorePair(newMeta,encrypted);
    meta=newMeta;key=newKey;
    alert('暗証を変更しました。新しい暗証は忘れないでください。');
  }catch(e){
    state.updatedAt=previousUpdatedAt;
    alert('暗証を変更できませんでした。以前の暗証とデータを維持しています。');
  }
}
async function resetAll(){
  if(!confirm('この端末のMSW-DBデータをすべて削除します。\nバックアップが無い場合は復元できません。'))return;
  const word=prompt('実行する場合は「全消去」と入力してください');if(word!=='全消去')return;
  try{await idbDeletePair()}catch(e){alert('全消去できませんでした。保存データは変更されていません。');return}
  meta=null;key=null;state=null;selectedPatient=null;alert('全消去しました。');renderLock();
}
function pickFile(accept,cb){const f=$('#fileInput');f.accept=accept;f.value='';f.onchange=()=>{if(f.files[0])cb(f.files[0])};f.click()}
function parseCSV(text){text=text.replace(/^\uFEFF/,'');const rows=[];let row=[],cell='',q=false;for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];if(q){if(c==='"'&&n==='"'){cell+='"';i++}else if(c==='"')q=false;else cell+=c}else{if(c==='"')q=true;else if(c===','){row.push(cell);cell=''}else if(c==='\n'){row.push(cell);rows.push(row);row=[];cell=''}else if(c!=='\r')cell+=c}}if(cell.length||row.length){row.push(cell);rows.push(row)}return rows}
function rowsToObjects(rows){const h=rows[0]||[];return rows.slice(1).filter(r=>r.some(x=>String(x).trim())).map(r=>Object.fromEntries(h.map((k,i)=>[k,r[i]??''])))}
function fileMakerBed(bed){
  const value=String(bed??'').trim(),m=normalizeBed(value).match(/^ICU3-(\d+)$/);
  // This mapping applies ONLY to CSV imported from FileMaker.
  if(m&&Number(m[1])>=7&&Number(m[1])<=15)return `ICU3-${Number(m[1])-6}`;
  return value;
}
async function importPatients(file){
  const objs=rowsToObjects(parseCSV(await file.text()));
  const candidates=objs.filter(o=>o['氏名']||o['ＩＤ']);
  const converted=candidates.filter(o=>o['ベッド番号']!==undefined&&fileMakerBed(o['ベッド番号'])!==String(o['ベッド番号']).trim());
  const detail=converted.length?`\nICU3番号変換：${converted.length}件（旧7～15 → 新1～9）`:'';
  if(!confirm(`患者CSVを取り込みますか？\n対象 ${candidates.length}件${detail}\n\n同じ患者IDは既存の情報が更新されます。取り込み前のバックアップを推奨します。`))return;
  let added=0,updated=0;
  for(const o of candidates){
    const idKey=String(o['ＩＤ']||'').trim();
    let p=idKey?state.patients.find(x=>String(x.data['ＩＤ']||'').trim()===idKey):null;
    if(!p){p=newPatient();delete p._new;state.patients.push(p);added++}else updated++;
    legacyFields.forEach(k=>{if(o[k]!==undefined)p.data[k]=k==='ベッド番号'?fileMakerBed(o[k]):o[k]});
    p.updatedAt=nowISO();
  }
  ensureStateSchema();await save();
  alert(`患者CSV読込完了\n追加 ${added}人 / 更新 ${updated}人${detail}`);render();
}
// Ver.1.0.7: explicitly requested full replacement of TEST patient records only.
// The original merge import remains available separately and unchanged.
function prepareFileMakerReplacement(csvText){
  const rows=parseCSV(csvText), headers=(rows[0]||[]).map(h=>String(h).replace(/^\uFEFF/,'').trim());
  const idCol=headers.includes('番号')?'番号':headers.includes('ＩＤ')?'ＩＤ':headers.includes('ID')?'ID':null;
  if(!idCol||!headers.includes('氏名')||!headers.includes('ベッド番号'))throw new Error('必要な列（番号またはID・氏名・ベッド番号）がありません。');
  const raw=rowsToObjects([headers,...rows.slice(1)]);
  if(!raw.length)throw new Error('患者データがありません。');
  const seen=new Set(), errors=[], patients=[], changed=[];
  for(let i=0;i<raw.length;i++){
    const o=raw[i],id=String(o[idCol]??'').trim(),name=String(o['氏名']??'').trim();
    if(!id){errors.push(`${i+2}行目：患者IDが空欄`);continue;}
    if(!name){errors.push(`${i+2}行目：氏名が空欄`);continue;}
    if(seen.has(id)){errors.push(`${i+2}行目：患者IDの重複`);continue;}
    seen.add(id);
    const p=newPatient();delete p._new;
    for(const k of legacyFields)if(o[k]!==undefined)p.data[k]=String(o[k]??'').trim();
    p.data['ＩＤ']=id;
    const oldBed=String(o['ベッド番号']??'').trim(),newBed=fileMakerBed(oldBed);
    p.data['ベッド番号']=newBed;
    if(oldBed!==newBed)changed.push({oldBed,newBed});
    patients.push(p);
  }
  if(errors.length)throw new Error(`CSVを取り込めません。\n${errors.slice(0,8).join('\n')}${errors.length>8?'\nほかにもエラーがあります':''}`);
  const invalid=patients.filter(p=>p.data['ベッド番号']&&!isMappedBed(p.data['ベッド番号']));
  return {patients,changed,invalid};
}
async function replacePatientsFromFileMaker(file){
  try{
    const {patients,changed,invalid}=prepareFileMakerReplacement(await file.text());
    const preview=`FileMaker患者データ：${patients.length}人\n現在のアプリ患者データ：${state.patients.length}人\nICU3番号変換：${changed.length}人\nその他・未配置：${invalid.length}人\n\n現在の患者データ（メモ・経過記録・タスクを含む）をすべて削除し、CSVの患者データに入れ替えます。\n薬剤・マスター・設定・暗証は保持されます。\n\n続行しますか？`;
    if(!confirm(preview))return;
    const word=prompt('最終確認：患者データを全件入れ替える場合は「入れ替え」と入力してください。');
    if(word!=='入れ替え')return;
    // Single encrypted state save: do not mutate the in-memory state until persistence succeeds.
    const next={...state,patients,version:APP_VERSION,updatedAt:nowISO()};
    await idbSet('data',await encryptObj(next));
    state=next;ensureStateSchema();
    alert(`全件入れ替えが完了しました。\n患者 ${patients.length}人\nICU3番号変換 ${changed.length}人\nその他・未配置 ${invalid.length}人`);
    render();
  }catch(e){alert(`患者CSVの入れ替えを中止しました。\n${e.message||'ファイルの読み込みに失敗しました。'}`)}
}
async function importDrugs(file){
  try{
    const objs=rowsToObjects(parseCSV(await file.text()));
    const incoming=objs.filter(x=>x['薬名']);
    const previous=state.drugs;
    state.drugs=incoming;
    try{await save()}catch(e){state.drugs=previous;throw e}
    alert(`薬剤 ${incoming.length}件を読み込みました。`);render();
  }catch(e){alert('薬剤CSVを読み込めませんでした。元のデータは変更されていません。')}
}
async function backup(){
  // Export only a committed encrypted snapshot; never announce success after a failed read/write.
  const previous=state.settings.lastBackupAt;
  try{
    state.settings.lastBackupAt=nowISO();
    try{await save()}catch(e){state.settings.lastBackupAt=previous;throw e}
    const [storedMeta,storedData]=await Promise.all([idbGet('meta'),idbGet('data')]);
    if(!storedMeta||!storedData)throw Error('保存済みの暗号化データがありません');
    const pack={format:'MSWDB-BACKUP',version:1,appVersion:APP_VERSION,exportedAt:nowISO(),meta:storedMeta,data:storedData};
    validateBackupEnvelope(pack);
    const blob=new Blob([JSON.stringify(pack)],{type:'application/json'});
    download(blob,`MSWDB_backup_${new Date().toISOString().slice(0,10)}.mswdb`);
    // iOS download completion cannot be verified here. Remind the user to confirm the file exists.
    alert('バックアップの書き出しを開始しました。「ファイル」アプリで保存されたことを確認してください。');
    setTimeout(()=>{if(screen==='settings')renderSettings();else render()},300);
  }catch(e){alert('バックアップを書き出せませんでした。保存容量とデータの状態を確認してください。')}
}
async function verifyBackupWithPin(pack,pin){
  const backupKey=await derive(pin,unb64(pack.meta.salt));
  const check=await decryptObj(pack.meta.check,backupKey);
  if(!check||check.ok!==true)throw Error('暗証確認データが不正です');
  const recovered=await decryptObj(pack.data,backupKey);
  if(!recovered||!Array.isArray(recovered.patients)||!Array.isArray(recovered.drugs)||!recovered.settings||typeof recovered.settings!=='object')throw Error('患者データの形式が不正です');
  return recovered;
}
async function restore(file){
  let pack;
  try{pack=validateBackupEnvelope(JSON.parse(await file.text()))}catch(e){alert('バックアップ形式を読み込めませんでした。現在のデータは変更されていません。');return}
  const pin=prompt('バックアップ作成時の暗証を入力してください。復元前に暗号化データの整合性を検証します。');
  if(pin===null)return;
  try{await verifyBackupWithPin(pack,pin)}catch(e){alert('暗証が違うか、バックアップが破損しています。現在のデータは変更されていません。');return}
  if(!confirm('バックアップの暗号化データを検証しました。現在のデータを置き換えます。よろしいですか？'))return;
  try{await idbRestorePair(pack.meta,pack.data);meta=pack.meta;key=null;state=null;alert('復元しました。バックアップ作成時の暗証で再度ロック解除してください。');renderLock()}
  catch(e){alert('復元できませんでした。現在の保存データは変更されていません。')}
}
function download(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
init().catch(e=>{document.getElementById('app').innerHTML=`<div class="lockwrap"><div class="lockcard"><h1>起動できません</h1><p>${esc(e.message)}</p><p class="notice">HTTPSで開いているか確認してください。iPadではSafariからホーム画面へ追加して使用します。</p></div></div>`});
