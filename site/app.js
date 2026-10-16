(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const yen = n => new Intl.NumberFormat('ja-JP',{style:'currency',currency:'JPY',maximumFractionDigits:0}).format(Number(n)||0);
  const pad = n => String(n).padStart(2,'0');
  const todayISO = () => { const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
  const DB_NAME='kakeibo_local_v1', STORE='expenses';
  const APP_VERSION='1.11.0';
  let db, pendingPhotos=[], photoPreviewURLs=[], ocrRaw='', parsedItems=[], deferredPrompt=null;
  let calCursor = new Date(); calCursor.setDate(1);
  let selectedDate = todayISO();
  let graphMode='monthly', graphCursor=new Date(); graphCursor.setDate(1);
  let graphYearBlockEnd=new Date().getFullYear();
  let editingExpenseId=null;
  // v1.4: state of the current (unsaved) OCR result
  let ocrMeta=null, ocrTotalSource='', ocrBusy=false, ocrAbort=null, hasUnsavedResult=false, savingReceipt=false, editDraft=null, ocrPhotoCount=0;
  const MAX_AMOUNT=100000000; // 1億円: larger values are typing mistakes

  function openDB(){return new Promise((resolve,reject)=>{let req;try{req=indexedDB.open(DB_NAME,1);}catch(e){reject(e);return;}req.onupgradeneeded=()=>{const d=req.result;if(!d.objectStoreNames.contains(STORE)){const s=d.createObjectStore(STORE,{keyPath:'id'});s.createIndex('date','date');}};req.onsuccess=()=>{db=req.result;db.onversionchange=()=>{try{db.close();}catch(_){}db=null;};db.onclose=()=>{db=null;};resolve(db)};req.onerror=()=>reject(req.error);});}
  // v1.4: every read/write runs in one transaction and resolves only when the transaction has completed.
  // If iOS dropped the connection (InvalidStateError / UnknownError), the DB is reopened and the call is retried once.
  async function withStore(mode,fn){
    for(let attempt=0;attempt<2;attempt++){
      try{
        if(!db) await openDB();
        return await new Promise((resolve,reject)=>{
          const tx=db.transaction(STORE,mode); const req=fn(tx.objectStore(STORE));
          tx.oncomplete=()=>resolve(req&&typeof req==='object'&&'readyState' in req?req.result:undefined);
          tx.onerror=()=>reject(tx.error||new Error('transaction error'));
          tx.onabort=()=>reject(tx.error||new Error('transaction aborted'));
        });
      }catch(e){
        const name=e&&e.name||'', msg=String(e&&e.message||'');
        if(attempt>0||!(name==='InvalidStateError'||name==='UnknownError'||/connection|closing|closed/i.test(msg))) throw e;
        try{ if(db) db.close(); }catch(_){}
        db=null;
      }
    }
  }
  function allExpenses(){return withStore('readonly',s=>s.getAll()).then(r=>r||[]);}
  function putExpense(x){return withStore('readwrite',s=>{s.put(x);}).then(r=>{dataChanged();return r;});}
  function deleteExpense(id){return withStore('readwrite',s=>{s.delete(id);}).then(r=>{dataChanged();return r;});}
  // v1.10.3: tell other open tabs that saved data changed (they read it again)
  let dataBc=null; function dataChanged(){ try{ if(!dataBc&&'BroadcastChannel' in window) dataBc=new BroadcastChannel('kakeibo-data'); if(dataBc) dataBc.postMessage('changed'); }catch(_){ } }
  function putExpenses(list){return withStore('readwrite',s=>{list.forEach(x=>s.put(x));}).then(r=>{dataChanged();return r;});}   // v1.10.5: a restore is announced too (after the transaction completed)
  function uid(){return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`;}
  // v1.4: errors stay longer; opt = {error:true} or a duration in ms
  function toast(msg,opt){const t=$('#toast'),o=typeof opt==='number'?{ms:opt}:(opt||{});t.textContent=msg;t.classList.toggle('error',!!o.error);t.classList.add('show');clearTimeout(toast._t);toast._t=setTimeout(()=>t.classList.remove('show'),o.ms||(o.error?4500:2200));}
  // v1.4: in-app confirmation. Native confirm() is silently ignored in sandboxed/embedded views (e.g. the preview page).
  let confirmDone=null;
  function askConfirm(message,opt){
    const o=opt||{};
    return new Promise(resolve=>{
      const box=$('#confirmDialog'), ok=$('#confirmOk'), cancel=$('#confirmCancel'), msg=$('#confirmMessage');
      if(!box||!ok||!cancel||!msg){ resolve(window.confirm(message)); return; }
      if(confirmDone) confirmDone(false);
      msg.textContent=message; ok.textContent=o.ok||'OK'; ok.classList.toggle('danger',!!o.danger); cancel.textContent=o.cancel||'キャンセル';
      const prev=document.activeElement;
      const yes=()=>done(true), no=()=>done(false), bg=e=>{ if(e.target===box) done(false); }, key=e=>{ if(e.key==='Escape') done(false); };
      function done(v){ confirmDone=null; box.classList.add('hidden'); document.body.classList.remove('dialog-open'); ok.removeEventListener('click',yes); cancel.removeEventListener('click',no); box.removeEventListener('click',bg); document.removeEventListener('keydown',key); try{ if(prev&&prev.focus&&document.contains(prev)) prev.focus(); }catch(_){ } resolve(v); }
      confirmDone=done;
      ok.addEventListener('click',yes); cancel.addEventListener('click',no); box.addEventListener('click',bg); document.addEventListener('keydown',key);
      box.classList.remove('hidden'); document.body.classList.add('dialog-open'); setTimeout(()=>{ try{ ok.focus(); }catch(_){ } },30);
    });
  }
  function showView(id){try{followToday();}catch(_){ }$$('.view').forEach(v=>v.classList.toggle('active',v.id===id));$$('.bottom-nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===id));window.scrollTo({top:0,behavior:'smooth'});const warn=e=>{console.warn(e);toast('データを読み込めませんでした。アプリを開き直してください',{error:true});};if(id==='homeView') renderHome().catch(warn); if(id==='calendarView') renderCalendar().catch(warn); if(id==='graphView') renderGraph().catch(warn); if(id==='scanView'){ renderLearningPanel(); updateResumeButton(); }}

  const CATEGORY_LEARNING_KEY='kakeibo_category_learning_v1';
  const CATEGORY_LEARNING_LABEL_KEY='kakeibo_category_learning_labels_v1';
  const CATEGORIES=['食費','日用品','外食','交通','娯楽','医療','美容','衣類','ペット','OG','未分類'];   // v1.10.4: OG (no keywords; learned from the person's choices)
  const productDictionary = new Map([
    ['牛乳','食費'],['卵','食費'],['たまご','食費'],['玉子','食費'],['食パン','食費'],['豆腐','食費'],['納豆','食費'],
    ['ティッシュ','日用品'],['トイレットペーパー','日用品'],['キッチンペーパー','日用品'],['アタックzero','日用品'],['nanox','日用品'],
    ['猫砂','ペット'],['ねこ砂','ペット'],['ちゅーる','ペット']
  ]);
  // v1.4: order and categories unchanged; only clearly food/daily words were added.
  // v1.10.16: everyday products that were left 未分類 were added (コーラ, 白菜, 寿司, ジーンズ, バンドエイド, 電球, 通行料金 …), with the same care:
  // ガム is not ガムテープ, ランチパック is bread, ペットボトル is not for pets, ノートパソコン is not a notebook
  // v1.10.14: a word inside another word does not decide the category (トップバリュ is a brand, not the detergent トップ; マスクメロン, バスタオル, マックスコーヒー, ハムスター)
  const categoryRules = [
    ['日用品',/(洗剤|タオル|マジックリン|バスクリン|入浴剤|アタック|ナノックス|NANOX|トップ(?!バリュ)|ボールド|漂白|ハイター|柔軟剤|ティッシュ|トイレット|キッチンペーパー|ペーパータオル|ラップ|アルミホイル|ゴミ袋|ごみ袋|スポンジ|石鹸|せっけん|歯磨|歯ブラシ|シャンプー|リンス|コンディショナー|ボディソープ|ハンドソープ|掃除|クイックル|消臭|芳香|電池|マスク(?!メロン)|キレイキレイ|ジップロック|保存袋|フリーザーバッグ|食器用|排水口|綿棒|ウェットティッシュ|生理用|おむつ|オムツ|レジ袋|ガムテープ|電球|蛍光灯|ハンガー|洗濯|収納|ボールペン|シャープペン|蛍光ペン|消しゴム|文具|文房具|ノート(?!パソコン|PC|ブック)|乾電池|ゴム手袋|ポリ袋|紙コップ|紙皿|割り?箸)/i],
    ['医療',/(医薬|薬|かぜ薬|風邪薬|鎮痛|解熱|胃腸薬|目薬|湿布|絆創膏|ばんそうこう|消毒|処方|病院|クリニック|ロキソニン|バファリン|パブロン|葛根湯|正露丸|ビオフェルミン|太田胃散|ガスター|ムヒ|オロナイン|サロンパス|キズパワーパッド|バンドエイド|ケアリーヴ|マキロン|診察|診療|初診|再診|調剤|処方箋)/i],
    ['美容',/(化粧水|乳液|美容液|ファンデ|口紅|リップ|マスカラ|アイライナー|クレンジング|メイク|化粧品|ヘアカラー|ワックス|整髪|香水|日焼け止め|ネイル)/i],
    ['衣類',/(シャツ|パンツ|ズボン|靴下|ソックス|下着|肌着|ジャケット|コート(?![ァ-ヶー])|衣料|服|靴|スニーカー|ジーンズ|デニム|スカート|ワンピース|セーター|カーディガン|パーカー|ブラウス|レギンス|タイツ|ストッキング|帽子|手袋(?<!ゴム手袋)|マフラー)/i],
    ['ペット',/(キャットフード|ドッグフード|猫砂|ねこ砂|ペットシーツ|ペットフード|ちゅーる|チャオ|CIAO|ジャーキー|猫用|犬用|猫缶|ねこ缶|ペット用)/i],
    ['娯楽',/(ゲーム|映画|カラオケ|書籍|コミック|漫画|雑誌|玩具|おもちゃ|チケット)/i],
    ['交通',/(ガソリン|軽油|駐車|電車|バス(?![ァ-ヶー])|タクシー|高速|ETC|Suica|PASMO|通行料|運賃|乗車券|きっぷ|切符|定期券|回数券)/i],
    ['食費',/(カップ麺|冷凍(?!庫)|ラーメン.{0,4}[0-9０-９]+食|[0-9０-９]+食入|カップラーメン|カップヌードル|カップN|袋麺|即席|インスタント|生ラーメン|冷し.{0,3}ラーメン|ラーメン(スープ|ナベ|鍋|つゆ|たれ|の素|用)|ネスカフェ|ボスカフェ|ボス|BOSS|カフェオレ|カフェラテ|カフェ・?オ・?レ|ブレンディ|カフェインレス|炎メシ|ハイボール|シードル|ビール|発泡酒|チューハイ|酎ハイ|サワー|ワイン|日本酒|焼酎|ウイスキー|梅酒|清酒)/i],
    ['外食',/(レストラン|ラーメン|食堂|居酒屋|マクドナルド|マック(?!ス)|モスバーガー|モス(?![ァ-ヶー])|吉野家|すき家|松屋|ドトール|スターバックス|スタバ|カフェ|喫茶|定食|サービス料|お通し|席料)/i],
    ['食費',/(牛乳|乳飲料|ヨーグルト|チーズ|バター|マーガリン|生クリーム|卵|たまご|玉子|食パン|パン|米|コメ|ごはん|弁当|惣菜|おにぎり|サンド|肉|豚|牛肉|鶏|ハム(?!スター)|ベーコン|ソーセージ|ウインナー|魚|鮮魚|刺身|鮭|さけ|キムチ|ビビンバ|ユッケ|梅干|カリカリ梅|サケ|さば|サバ|鯖|まぐろ|マグロ|いわし|さんま|えび|エビ|しらす|野菜|果物|バナナ|メロン|りんご|みかん|いちご|イチゴ|ぶどう|キャベツ|レタス|トマト|きゅうり|キュウリ|胡瓜|ピーマン|にんじん|ニンジン|人参|たまねぎ|タマネギ|玉ねぎ|玉葱|じゃがいも|ジャガイモ|ほうれん草|ほうれんそう|ホウレンソウ|大根|だいこん|ダイコン|ねぎ|ネギ|もやし|モヤシ|なす|ブロッコリー|かぼちゃ|ごぼう|ゴボウ|しめじ|シメジ|えのき|エノキ|しいたけ|シイタケ|きのこ|キノコ|タマゴ|豆腐|納豆|油揚|厚揚|こんにゃく|味噌|みそ|醤油|しょうゆ|砂糖|塩|酢|みりん|ケチャップ|マヨネーズ|ドレッシング|ソース|だしの素|白だし|カレー|食用油|サラダ油|ごま油|オリーブオイル|調味|ジュース|コーヒー|紅茶|お茶|緑茶|麦茶|ウーロン茶|烏龍茶|天然水|ミネラルウォーター|菓子|チョコ|クッキー|ビスケット|ポテトチップ|スナック|せんべい|キャンディ|グミ|プリン|ゼリー|アイス|冷凍食品|冷凍|パスタ|スパゲティ|うどん|そば|ビール|発泡酒|チューハイ|酎ハイ|ワイン|日本酒|焼酎|豆乳|からあげ|唐揚|コロッケ|ギュウニュウ|コーラ(?!ル)|サイダー|炭酸水|ラムネ|スポーツドリンク|ポカリ|アクエリアス|エナジードリンク|レッドブル|ほうじ茶|ガム(?!テープ)|飴|あめ玉|のど飴|白菜|はくさい|小松菜|水菜|しょうが|生姜|にんにく|れんこん|さつまいも|里芋|さといも|オクラ|アボカド|レモン|キウイ|梨|桃|柿|寿司|すし|鮨|手巻|サラダ|こしょう|胡椒|中華まん|肉まん|あんまん|おでん|ファミチキ|ナゲット|丼|ハンバーガー|ピザ|ランチパック|餃子|ぎょうざ|シュウマイ|焼売|春巻|ちくわ|かまぼこ|はんぺん|海苔|のり巻|わかめ|昆布|ふりかけ|お茶漬|カップスープ|スープ|シリアル|グラノーラ|ジャム|はちみつ|蜂蜜|小麦粉|片栗粉|パン粉|ホットケーキ)/i]
  ];
  const storeRules = [
    ['外食',/(マクドナルド|モスバーガー|吉野家|すき家|松屋|スターバックス|ドトール|レストラン|食堂|居酒屋|カフェ)/i],
    ['交通',/(ENEOS|エネオス|出光|コスモ石油|タクシー|JR東日本|JR東海|JR西日本)/i],
    ['娯楽',/(TOHOシネマ|イオンシネマ|ユナイテッド・シネマ|カラオケ)/i]
  ];
  function normalizeProductName(s=''){
    return String(s).normalize('NFKC').toLowerCase().replace(/[\s\-_・･*※#＃()（）\[\]【】「」『』:：/\\.,，。]/g,'').trim();
  }
  function hiraToKata(s){ return String(s).replace(/[\u3041-\u3096]/g,c=>String.fromCharCode(c.charCodeAt(0)+0x60)); }
  // name variants used only for keyword matching: as written, spaces removed, hiragana folded to katakana
  function nameVariants(name){
    const t=String(name||'').normalize('NFKC'); const compact=t.replace(/\s+/g,'');
    const out=[t]; [compact,hiraToKata(compact)].forEach(v=>{ if(out.indexOf(v)<0) out.push(v); });
    if(/^[ァ-ヺー・\d\s.]+$/.test(compact)&&/[ァ-ヺ]/.test(compact)){ const h=compact.replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-0x60)); if(out.indexOf(h)<0) out.push(h); }   // v1.10.16: ｵﾆｷﾞﾘ ｼｬｹ (a name in katakana only, as older registers print it) is matched with おにぎり
    return out;
  }
  function loadCategoryLearning(){
    try{const v=JSON.parse(localStorage.getItem(CATEGORY_LEARNING_KEY)||'{}');return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch(_){return {};}
  }
  function loadCategoryLearningLabels(){
    try{const v=JSON.parse(localStorage.getItem(CATEGORY_LEARNING_LABEL_KEY)||'{}');return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch(_){return {};}
  }
  function learnedCount(){return Object.keys(loadCategoryLearning()).length;}
  function rememberCategory(name,category){
    const cleanName=String(name||'').trim(), key=normalizeProductName(cleanName); if(!key || !CATEGORIES.includes(category)) return false;
    const map=loadCategoryLearning(), labels=loadCategoryLearningLabels(); map[key]=category; labels[key]=cleanName;
    try{ localStorage.setItem(CATEGORY_LEARNING_KEY,JSON.stringify(map)); localStorage.setItem(CATEGORY_LEARNING_LABEL_KEY,JSON.stringify(labels)); return true; }catch(_){ return false; }
  }
  function clearCategoryLearning(){localStorage.removeItem(CATEGORY_LEARNING_KEY);localStorage.removeItem(CATEGORY_LEARNING_LABEL_KEY);clearNameFixes();}
  // v1.4: item names corrected on the confirm screen, remembered per store. The same misreading next time is replaced by
  // the corrected name: an exact match, or a close match (70%+ alike) at the same price. Kept on this device only.
  const NAME_FIX_KEY='kakeibo-name-fixes-v1';
  function loadNameFixes(){ try{ const a=JSON.parse(localStorage.getItem(NAME_FIX_KEY)||'[]'); return Array.isArray(a)?a.filter(e=>e&&typeof e.s==='string'&&typeof e.o==='string'&&typeof e.n==='string'&&e.n.length<=100):[]; }catch(_){ return []; } }
  function clearNameFixes(){ try{ localStorage.removeItem(NAME_FIX_KEY); }catch(_){ } }
  function nameKey(s){ return normalizeProductName(String(s||'')).replace(/\s+/g,''); }
  // Pure: 0..1 likeness of two strings (1 - edit distance / longer length)
  function similarity(a,b){
    a=String(a||''); b=String(b||''); if(a===b) return 1; if(!a||!b) return 0;
    let prev=new Array(b.length+1); for(let j=0;j<=b.length;j++) prev[j]=j;
    for(let i=1;i<=a.length;i++){ const cur=[i]; for(let j=1;j<=b.length;j++) cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1)); prev=cur; }
    return 1-prev[b.length]/Math.max(a.length,b.length);
  }
  function rememberNameFix(store,ocrName,name,amount){
    const s=nameKey(store), o=nameKey(ocrName), n=String(name||'').trim().slice(0,100); if(!s||!o||!n||o===nameKey(n)) return false;
    const list=loadNameFixes(), i=list.findIndex(e=>e.s===s&&e.o===o), c=i>=0?(Number(list[i].c)||1)+1:1; if(i>=0) list.splice(i,1);
    list.push({s,o,n,a:Math.round(Number(amount)||0),c,t:Date.now()});
    try{ localStorage.setItem(NAME_FIX_KEY,JSON.stringify(list.slice(-400))); return true; }catch(_){ return false; }
  }
  function findNameFix(store,name,amount,list){
    const s=nameKey(store), o=nameKey(name); if(!s||!o) return null;
    const amt=Math.round(Number(amount)||0); let best=null, bs=0;
    for(const e of (list||loadNameFixes())){ if(e.s!==s) continue; if(e.o===o) return e; if(e.a&&e.a===amt){ const sim=similarity(e.o,o); if(sim>=0.7&&sim>bs){ bs=sim; best=e; } } }
    return best;
  }
  function renderLearningPanel(){
    const list=$('#learningList'), count=$('#learnedCount'); if(!list||!count)return; const map=loadCategoryLearning(), labels=loadCategoryLearningLabels(), entries=Object.entries(map); const nameCount=loadNameFixes().length; count.textContent=`${entries.length}件を記憶中${nameCount?`（商品名の修正 ${nameCount}件）`:''}`; list.innerHTML='';
    const nameHtml=nameCount?`<div class="learning-names"><div class="learning-names-title">商品名の修正（店・読み取り → 修正）</div>${loadNameFixes().slice(-200).reverse().map(e=>`<div class="learning-name-row"><span>${esc(e.s||'店名なし')}・${esc(e.o)}</span><b>→ ${esc(e.n)}</b></div>`).join('')}</div>`:'';
    if(!entries.length){ if(nameCount){ list.innerHTML=`<div class="empty learning-empty">分類の学習はまだありません</div>${nameHtml}`; return; }list.innerHTML='<div class="empty learning-empty">まだ学習した商品はありません</div>';return;}
    // v1.4: no 60-item cap (the list scrolls inside its box)
    list.innerHTML=entries.sort((a,b)=>String(labels[a[0]]||a[0]).localeCompare(String(labels[b[0]]||b[0]),'ja')).map(([key,category])=>`<div class="learning-row"><span>${esc(labels[key]||key)}</span><b>${esc(category)}</b></div>`).join('');
    if(nameHtml) list.insertAdjacentHTML('beforeend',nameHtml);
  }
  function classifyItem(name,store=''){
    const key=normalizeProductName(name), learned=loadCategoryLearning();
    if(key && Object.prototype.hasOwnProperty.call(learned,key) && CATEGORIES.includes(learned[key])) return {category:learned[key],source:'learned'};
    if(key && productDictionary.has(key)) return {category:productDictionary.get(key),source:'dictionary'};
    const variants=nameVariants(name);
    // food and drink bought at a restaurant or cafe is eating out (ブレンドコーヒー at a cafe), elsewhere it is groceries
    const atRestaurant=storeRules.some(([cat,re])=>cat==='外食'&&re.test(String(store||'')));
    for(const [cat,re] of categoryRules){if(variants.some(v=>re.test(v))) return {category:(atRestaurant&&cat==='食費')?'外食':cat,source:'rule'};}
    for(const [cat,re] of storeRules){if(re.test(String(store||''))) return {category:cat,source:'store'};}
    return {category:'未分類',source:'unknown'};
  }
  function guessCategory(name,store=''){return classifyItem(name,store).category;}
  function categorySourceLabel(source){return source==='learned'?'学習済み':source==='manual'?'保存すると次回から記憶':source==='dictionary'?'商品辞書':source==='rule'?'自動分類':source==='store'?'店舗から推定':'未分類';}

  /* PARSER-START */
  const JP_CHAR = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3005-\\u3007\\u30fc';
  const RE_JP_SPACE = new RegExp('([' + JP_CHAR + '])\\s+(?=[' + JP_CHAR + '])', 'g');
  const RE_JP_ALL = new RegExp('[' + JP_CHAR + ']', 'g');
  const UNIT_CHARS = '点個枚本袋箱コヶケ年月日錠包粒杯缶組足玉尾切房束台円件回';
  const RE_NUM_UNIT_SPACE = new RegExp('(\\d)\\s+(?=[' + UNIT_CHARS + '])', 'g');
  const TAX_MARK_TOKEN = /^(?:[※*＊☆★◆◇○●◎]|軽|軽減|内|外|非|税|込|8%|10%|\(軽\)|\(8%\)|\(10%\)|[※*][軽8]|8%軽)$/;
  const SC_JP = {费:'費',决:'決',济:'済',对:'対',减:'減',轻:'軽',计:'計',额:'額',价:'価',单:'単',现:'現',预:'預',钱:'銭',买:'買',卖:'売',发:'発',间:'間',营:'営',业:'業',领:'領',证:'証',门:'門',东:'東',鸡:'鶏',鱼:'魚',乐:'楽',农:'農',产:'産',无:'無',叶:'葉'};
  // OCR often returns a kanji that looks like a kana (大きなエ -> 大きな工, ロース -> 口ース, コーヒー -> コ一ヒ一).
  // Change it back only next to kana and never next to another kanji (工具, 一つ stay as they are).
  const LOOKALIKE = {工:'エ',口:'ロ',力:'カ',夕:'タ',二:'ニ',八:'ハ',卜:'ト'};
  const RE_KANA = /[ぁ-ゖァ-ヺー]/, RE_KANJI = /[一-龯々]/;
  function fixKanaLookalikes(t){
    let out = '';
    for (let i = 0; i < t.length; i++) {
      const ch = t[i], p = t[i - 1] || '', n = t[i + 1] || '';
      if (LOOKALIKE[ch] && (RE_KANA.test(p) || RE_KANA.test(n)) && !RE_KANJI.test(p) && !RE_KANJI.test(n)) out += LOOKALIKE[ch];
      else if (ch === '一' && /[ァ-ヺ]/.test(p) && !RE_KANJI.test(n)) out += 'ー';
      else out += ch;
    }
    return out;
  }
  function normalizeLine(s){
    let t = String(s == null ? '' : s).normalize('NFKC');
    t = t.replace(/[\u3000\t\u00a0]/g, ' ').replace(/\s+/g, ' ').trim();
    // PaddleOCR habits: a split character (計 -> 言十, 額 -> 客真) and simplified-Chinese forms of receipt words
    t = fixKanaLookalikes(t);
    // voiced marks read as separate symbols (サンプ°ル, コート”)
    t = t.replace(/([はひふへほハヒフヘホ])[°゜]/g, (m, c) => String.fromCharCode(c.charCodeAt(0) + 2)).replace(/([ぱぴぷぺぽパピプペポ])[°゜]/g, '$1')
         .replace(/([かきくけこさしすせそたちつてとはひふへほカキクケコサシスセソタチツテトハヒフヘホ])[゛”"]/g, (m, c) => String.fromCharCode(c.charCodeAt(0) + 1));
    // a date printed right before the time without a space (26/09/2412:30)
    t = t.replace(/(\d{2,4}[\/.-]\d{1,2}[\/.-]\d{2})(\d{1,2}:\d{2})/g, '$1 $2');
    t = t.replace(/[计對对额费钓领证买减单变]/g, ch => ({'计':'計','對':'対','对':'対','额':'額','费':'費','钓':'釣','领':'領','证':'証','买':'買','减':'減','单':'単','变':'変'})[ch]).replace(/バーコート/g, 'バーコード').replace(/^夕(?=\s?(?:8|10)\b)/, '外');
    t = t.replace(/^小\s?(?:言\s?)?十(?=[\s\/\d¥￥]|$)/, '小計').replace(/[夕タ外]\s?卜\s?税/g, '外税').replace(/税\s?客\s?[真頁額]?/g, '税額').replace(/対象\s?客\s?額?/g, '対象額').replace(/タイ\s?シ?ョ?ウ(?=\s*[¥￥\\]?\d)/g, '対象').replace(/(\S)特(?=\s*[¥￥\\]?\d[\d,]*\s*$)/, '$1 ').replace(/割\s?弓\s?[1lI|｜]?/g, '割引').replace(/(\d%)\s?(-\d)/g, '$1 $2').replace(/\s特\s*(?=[¥￥\\]?\d)/g, ' ').replace(/^合\s?十(?=\s|\d|¥|$)/, '合計').replace(/^小\s?(?:十|言十|言|計)?\s?(?=\d{1,3}\s?点)/, '小計 ').replace(/合\s?[司言]\s?十/g, '合計').replace(/消\s?[賣卖]\s?税/g, '消費税').replace(/^小\s?十(?=\s|$)/, '小計').replace(/言\s?十/g, '計').replace(/客\s?[真頁員]/g, '額').replace(/([^\s\d\-−△▲¥￥\\])([¥￥]\d)/g, '$1 $2').replace(/([外内]|消費)\s?[兌兑]/g, '$1税').replace(/[费决济对减轻计额价单现预钱买卖发间营业领证门东鸡鱼乐农产无叶]/g, ch => SC_JP[ch] || ch);
    t = t.replace(/[−‐‑‒–—―ｰ]/g, m => (m === 'ｰ' ? 'ー' : '-'));
    t = t.replace(RE_JP_SPACE, '$1');
    t = t.replace(RE_NUM_UNIT_SPACE, '$1');
    t = t.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
    t = t.replace(/(\d)\s*([,.])\s*(\d{3})(?!\d)/g, '$1$2$3');
    return t.trim();
  }
  // amount token -> {value, neg} or null.  Accepts ¥ \ Y y 円, thousands separators "," or ".", OCR O/o/〇->0, I/l/|->1
  function parseAmountToken(tok, opts){
    const o = opts || {};
    let t = String(tok || '').trim().replace(/^[^\d¥￥\\\s\-−△▲](?=[¥￥\\])/, '');
    const letterMark = /^[JK]\d{1,5}$/.test(t); if (letterMark) t = t.slice(1);
    const starMark = /^[*＊※]\d{1,6}$/.test(t); if (starMark) t = t.slice(1);   // *191: the reduced-rate mark before a price   // J5: a tax letter glued to a small price
    if (!t || !/\d/.test(t)) return null;
    if (/\d[\-−]$/.test(t)) t = t.replace(/[\-−]+$/, '');   // ¥105- / ¥467-: the sign comes from the line's label (割引), not from the dash
    t = t.replace(/^[(\[（【「]+/, '').replace(/[)\]）】」.,、。:：]+$/, '');
    t = t.replace(/[OoＯ〇]/g, '0').replace(/[Il|｜!]/g, '1');
    const beforeMarks = t; t = stripTaxMarks(t); const hadMark = /(?:[※*＊☆★↓除]|軽減?)$/.test(beforeMarks) || letterMark || starMark;   // a price mark, not a percent sign
    let neg = false;
    if (/^[-△▲]/.test(t)) { neg = true; t = t.slice(1); }
    let hadYen = false;
    const m1 = t.match(/^[¥\\Yy]{1,2}/);
    if (m1) { hadYen = true; t = t.slice(m1[0].length); }
    if (/^[-△▲]/.test(t)) { neg = true; t = t.slice(1); }
    if (/円$/.test(t)) { hadYen = true; t = t.slice(0, -1); }
    if (/^[-△▲]/.test(t)) { neg = true; t = t.slice(1); }
    if (!/^\d/.test(t)) return null;
    let digits;
    if (/^\d{1,3}(?:[,.]\d{3})+$/.test(t)) digits = t.replace(/[,.]/g, '');
    else if (/^\d+$/.test(t)) digits = t;
    else return null;
    if (digits.length > 1 && digits[0] === '0') return null;       // "0003" is not a price
    if (!hadYen && digits.length < 2 && !o.allowShort && !(neg && Number(digits) >= 2) && !hadMark) return null; // bare single digit is not a price (but -4 or 5除 is; -1 is not)
    if (digits.length > 7) return null;
    const value = Number(digits);
    if (!isFinite(value)) return null;
    return { value, neg, hadYen };
  }
  function stripTaxMarks(t){
    let s = t, prev;
    do {
      prev = s;
      s = s.replace(/(?:[※*＊☆★↓]|軽減?|\(軽\)|内|外|非|込|除)$/, '');
      if (/%%+$/.test(s)) s = s.replace(/%+$/, '');                    // "¥138%%": a misread mark, not "8%"
      else if (/\d(?:8|10)%$/.test(s)) s = s.replace(/(?:8|10)%$/, ''); // "¥1388%" = ¥138 + 8%
      else s = s.replace(/%$/, '');
    } while (s !== prev && s.length);
    return s;
  }
  function isTaxMarkToken(tok){ return TAX_MARK_TOKEN.test(tok) || /^[※*＊]+$/.test(tok); }
  // split a normalized line into {namePart, amount} where amount is the last amount token (tax marks after it are skipped)
  function splitAmount(line){
    const toks = line.split(' ').filter(Boolean);
    let i = toks.length - 1;
    while (i >= 0 && isTaxMarkToken(toks[i])) i--;
    // a stray mark read from the photo edge after the price ("¥398 |")
    if (i > 0 && /^[|｜!lIi1」』\])。.、,:;'"`]$/.test(toks[i]) && /\d/.test(toks[i - 1])) { i--; while (i >= 0 && isTaxMarkToken(toks[i])) i--; }
    if (i < 0) return { name: line, amount: null, tokens: toks };
    let a = parseAmountToken(toks[i]);
    let used = 1;
    // "¥ 1,234" (yen sign separated)
    if (a && i > 0 && /^[¥\\Yy]$/.test(toks[i - 1])) { a.hadYen = true; used = 2; }
    // "- 30" / "△ 30"
    if (a && i > 0 && /^[-△▲]$/.test(toks[i - used])) { a.neg = true; used += 1; }
    if (!a) return { name: line, amount: null, tokens: toks };
    const name = toks.slice(0, i - used + 1).join(' ');
    return { name, amount: a, tokens: toks };
  }
  function meaningfulCount(s){
    const jp = (String(s).match(RE_JP_ALL) || []).length;
    const lat = (String(s).match(/[A-Za-z]/g) || []).length;
    return { jp, lat };
  }
  const RE_TAX_SUM = /(?:消費)?税(?:額)?等?(?:額)?合計/;
  const RE_TAX_BASE = /課税(?:対象)?(?:額|金額|売上額?)/;
  const RE_DISC_SUM = /(?:値引|値下げ?|割引|ネビキ|ワリビキ)(?:額|金額)?(?:合計|計)/;   // v1.10.5: 値引合計 / 割引計 = the sum of the discounts, not the receipt total
  // staff lines: a label then a number (担当 12345 / 社員番号 54321 / 係員 123456 佐藤 / レジ担当 78901)
  const RE_STAFF = /^(?:レジ)?(?:担当者?|係員|社員(?:番号|No\.?|ID|コード)?|責任者|オペレーター|operator|staff|cashier)[:：#№No.]*\d{3,}/i;
  // a clerk code with a surname (019048小原 / 123456 佐藤): 5-7 digits then 1-3 kanji that are not a unit (12345限定セット / 10000円 stay)
  function clerkLike(s){ const t = String(s || '').trim(); return /^\d{5,7}\s*[\u4e00-\u9fff々]{1,3}(?:\s*[(（][\u3040-\u30ff\u4e00-\u9fff]{1,2}[)）]?)?$/.test(t) && !/^\d+\s*[円個枚本入袋缶包錠粒回日年月号点台足組箱冊巻]/.test(t); }
  const RE_TAX_RATE_SUM = /税率別.{0,6}合計|税率\d{1,2}[%％]?対象.{0,6}合計/;
  const RE_CODE_HEAD = /^([^\s\d]{0,2})(\s?)(\d{3,8})(?!\d)(\s*)(?=[^\d\s,.:\/\-])/;
  const RE_UNIT_HEAD = /^(?:ml|mL|ML|g|kg|L|l|個|枚|本|入|cm|mm|m|号|P|p|円|%|％|年|月|日|時|ｍ|ｇ|W|w|V|mAh|cc|CC|粒|袋|缶|包|錠|回分|日分)/;
  const RE_JP_HEAD = /^[\u3040-\u30ff\u4e00-\u9fff々ｦ-ﾟ]/;
  // GS1 check digit (EAN-13 / EAN-8 = JAN)
  function eanValid(d){ if (!/^(\d{8}|\d{13})$/.test(d)) return false; const n = d.split('').map(Number), chk = n.pop(); let sum = 0; n.forEach((v, i) => { sum += v * (d.length === 13 ? (i % 2 ? 3 : 1) : (i % 2 ? 1 : 3)); }); return (10 - sum % 10) % 10 === chk; }
  function cleanItemName(s){
    let t = String(s || '');
    if (/^\s*\d{8,13}\s*(?:JAN|ＪＡＮ)?\s*$/i.test(t)) return '';   // a JAN code line is not a name
    t = t.replace(/^[\s※*＊・\-|!#>»«〉〈:;'"`_.,、。~^=+$＄]+/, '').replace(/^[a-zA-Z][*＊]\s?/, '').replace(/^[ソｿ]\s?8\s?(?=[^\d\s])/, '').replace(/^[$＄]/, '');
    t = t.replace(/[\s※*＊|]+$/, '').replace(/\s[A-Z]$/, '');
    // a closing bracket left over from the price column (りんご」)
    if (/[」』]$/.test(t) && !/[「『]/.test(t)) t = t.slice(0, -1);
    // department / item codes printed before the name (0656 みょうが, #ソ 000261 クィーンシュー); units are kept (1000ml)
    // a JAN/EAN before the name: removed when its check digit is right, or when a 13-digit number stands apart from the name
    const jm = t.match(/^(\d{13}|\d{8})(?!\d)(\s*)/);
    if (jm) { const rest = t.slice(jm[0].length); if (rest && /^[^\d\s]/.test(rest) && (eanValid(jm[1]) || (jm[1].length === 13 && (jm[2].length > 0 || RE_JP_HEAD.test(rest))))) t = rest; }
    // an item code before the name: only when the receipt has a column of them, or a 5-8 digit number set apart from a Japanese name
    // (keeps 1234限定セット, 1500W ドライヤー, 2024年産 新米, 500ml コーラ)
    const cm = t.match(RE_CODE_HEAD);
    if (cm) { const rest = t.slice(cm[0].length), spaced = cm[4].length > 0, jp = RE_JP_HEAD.test(rest);
      if (rest && !RE_UNIT_HEAD.test(rest) && ((codePrefixLen === cm[3].length && (jp || spaced)) || (spaced && cm[3].length >= 5 && jp))) t = rest; }
    // tax-class marks printed before the name: 外8 / 内8 / 外10 / 内10 / 軽
    t = t.replace(/^(?:(?:外|内)\s?(?:8|10)\s?%?|軽)\s+/, '').replace(/^(?:外|内)\s?(?:8|10)(?![\d%％])\s*/, '');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }
  const RE_QTY_LINE = /^\(?\s*(\d{1,3})\s*(?:コ|個|点|本|袋|枚|パック|P|ヶ|ケ|入)?\s*[xX×*＊]\s*(?:単価?|@)?\s*[¥\\]?\s*(\d[\d,]*)/;
  const RE_QTY_LINE2 = /^\(?\s*(?:単価?|@)\s*[¥\\]?\s*(\d[\d,]*)\s*[xX×*＊]\s*(\d{1,3})/;
  const RE_QTY_LINE3 = /^\(?\s*(\d{1,3})\s*(?:コ|個|点|本|袋|枚|パック|P)\s*(?:単価?|@)\s*[¥\\]?\s*(\d[\d,]*)/;
  const RE_QTY_INLINE = /\s*\(?\s*(\d{1,3})\s*(?:コ|個|点|本|袋|枚|パック|P|ヶ)?\s*[xX×*＊]\s*(?:単価?|@)?\s*[¥\\]?\s*(\d[\d,]*)\s*\)?\s*$/;
  function parseQty(line){
    let m = line.match(RE_QTY_LINE); if (m) return { qty: Number(m[1]), unit: Number(m[2].replace(/,/g, '')) };
    m = line.match(RE_QTY_LINE2); if (m) return { qty: Number(m[2]), unit: Number(m[1].replace(/,/g, '')) };
    m = line.match(RE_QTY_LINE3); if (m) return { qty: Number(m[1]), unit: Number(m[2].replace(/,/g, '')) };
    return null;
  }
  // keyword classes (tested on the compact form: all spaces removed)
  const KW = {
    taxBase: /対象/,
    subtotal: /(小計|小合計|ショウケイ|ｼｮｳｹｲ|^SUBTOTAL)/i,
    total: /(総?合計|今回お支払い?額|お支払い?金額|お支払い?額|お買上げ?計|お買い?上げ?計|お買上げ?金額|お買い?上げ?金額|お支払合計|お支払い合計|ご請求額|ご請求金額|税込合計|ゴウケイ)/i,
    exTax: /(外税|外消費税|税抜|消費税等?\(外\)|\(外\))/,
    inTax: /(内税|内消費税|\(内|税込|内\))/,
    tax: /(消費税|税額|税等|[0-9]{1,2}%税|税\s?合計)/,
    discount: /(値引|値下|割引|%引|円引|クーポン|まとめ買|セット割|ネビキ|ワリビキ|ディスカウント)/,
    noise: /(TEL|FAX|電話|☎|〒|登録番号|事業者番号|T\d{13}|レジ(番号|No|#|:)?\d|担当|責任者|責:|取引|伝票|領収|領.?証|領正|レシート|明細書|会員|お客様|ありがとう|またの|お越し|ご来店|いらっしゃいませ|営業時間|返品|交換|お問い?合わせ|www\.|http|カード番号|\*{3,}|X{4,}|\d{4}-?\*{2,}|買上点数|点数|^\d+点$|^No\.?\d|^#\d|令和|平成)/i,
    points: /(ボーナスポイント|プラスポイント|限定.{0,4}ポイント|(今回|付与|利用|獲得|累計|保有|ご利用|加算|使用|有効)ポイント|ポイント(残高|数|付与|利用|合計|カード|対象|倍)|^[TＶVdR]?ポイント(?![ァ-ヶ]))/,   // v1.10.14: ポイントメイク… (a product name) is not a point line
    date: /(20\d{2}\s*[年\/.\-]\s*\d{1,2}\s*[月\/.\-]\s*\d{1,2}|\d{1,2}:\d{2})/,
    phone: /\d{2,4}-\d{2,4}-\d{3,4}/,
    address: /(丁目|番地|[都道府県].{1,6}[市区町村郡])/
  };
  const RE_PAY_NAME = /^(お?預り|お?預かり|預り金|お預|お?釣り?|おつり|釣銭|お返し|現金|現金支払|現金払い|クレジット(カード)?(支払|払い|決済|一括|売上)?|カード(支払|払い|決済|売上)?|(交通系)?電子マネー(支払|払い|決済)?|交通系(IC)?|QUICPay|クイックペイ|iD|ID|PayPay|楽天ペイ|楽天Edy|Edy|d払い|au ?PAY|WAON|nanaco|Suica|PASMO|ICOCA|バーコード決済|QR決済|残高|お?支払(い)?(金額|額)?|ご?請求(金額|額)?|オアズカリ|アズカリ|オツリ|ゲンキン|ツリセン)$/i;
  function payKind(name){
    const n = String(name || '').replace(/[\s()（）:：]/g, '');
    if (!n) return '';
    if (!RE_PAY_NAME.test(n)) return /残高$/.test(n) ? 'balance' : '';
    if (/預|アズカリ/.test(n)) return 'cash';
    if (/釣|おつり|お返し|オツリ|ツリセン/.test(n)) return 'change';
    if (/^現金|^ゲンキン/.test(n)) return 'cashpay';
    if (/残高/.test(n)) return 'balance';
    return 'card';
  }
  // v1.10.11: a 小計 that covers only part of the receipt: one tax rate (8%小計 / 10%小計 / 軽減税率小計 / 標準税率小計) or one department (食品部門小計).
  // Recognised by what the line says it covers - not by the word 対象 alone (8%対象小計 was already a tax base line). null = the receipt's 小計.
  function partialSubOf(c){
    const t = String(c || '').replace(/[\d¥￥,.\s円]+$/, '');
    const rm = t.match(/(?:^|[^\d])(8|10)\s?[%％]/); if (rm) return { scope: 'rate', rate: Number(rm[1]) };
    if (/軽減/.test(t)) return { scope: 'rate', rate: 8 }; if (/標準税率|標準/.test(t)) return { scope: 'rate', rate: 10 };
    if (/部門|売場|コーナー|カテゴリ/.test(t)) return { scope: 'dept', rate: 0 };
    return null;
  }
  const RE_TOTAL_LABEL = /^(?:[おご]?会計(?:金額|額)?|総計|現計|税込計|計|TOTAL)[:：]?$/i;   // v1.10.14
  const RE_POINT_USE = /ポイント(?:利用|使用|値引|割引|充当|支払い?|払い?)|(?:利用|使用)ポイント/, RE_POINT_INFO = /(残高|可能|累計|獲得|付与|対象|有効|期限|予定|倍)/;   // v1.10.14
  // v1.10.15: the number of the sale, slip or order (会計番号 1234 / 伝票No.5678 / 取引番号 000123 / 受付番号 12) is not an item, a price or a total.
  // Only these words directly followed by 番号 / No / # / ID and a number: 番号札ケース, 背番号Tシャツ, 会計ソフト are products.
  const RE_ID_LINE = /^(?:[おご]?会計|伝票|取引|レシート|受付|整理|注文|オーダー|精算|お?買上げ?|お?買い上げ|売上|承認|処理|端末|管理|発行|呼出し?)(?:番号|No\.?|NO\.?|№|#|ID)[:：#№.\-]*\d/i;
  // v1.10.16: a minus line that takes back an item rung up before it (取消 パン -158 / 返品 Tシャツ -1,990 / 訂正 -398): the item is taken out of the
  // list. Before, 返品 lines were dropped as notices (a difference was reported) and 取消 lines were counted as a discount with the item left in the list.
  const RE_CANCEL = /^(?:返品|取消し?|取り消し|訂正|返金|戻し)/;
  // v1.10.16: charges printed after the 小計 of a restaurant (サービス料 10% ¥270 / 席料 / お通し): part of what was paid, kept as an item. Before,
  // every item-like line after 小計 was skipped and the receipt showed a difference of the charge.
  const RE_SERVICE = /^(?:サービス料|サービスチャージ|サ-ビス料|席料|お通し代?|チャージ料|テーブルチャージ|カバーチャージ|深夜料金?)/;
  // v1.10.16: the lines of a fuel receipt that say how much and at what price (単価 ¥168 / 数量 30.00L / 30.00L × @168): not items. 金額 ¥5,040 is the
  // price of the fuel named above it (before, 単価 and 金額 were two items).
  const RE_UNIT_INFO = /^(?:単価|数量|給油量|油量)$/, RE_FUEL_QTY = /^\d+(?:\.\d+)?(?:L|l|リットル)[xX×*][@]?[¥\\]?\d/;
  // v1.10.17: the same lines when the number on them is not an amount of money: 数量 30.00L / 給油量 30.00L / 単価 168円/L / 単価 @185, and a line that is only the
  // amount of fuel (30.00L). Before, 数量 30.00L was taken as the name of the item and the fuel named above it (レギュラー) was lost. Only the whole line:
  // 数量限定セット ¥500 is a product.
  const RE_UNIT_LINE = /^(?:単価|数量|給油量|油量|給油数量)[:：]?(?:[@]?[¥\\]?\d[\d,]*(?:\.\d+)?円?(?:\/(?:L|l|リットル))?|\d+(?:\.\d+)?(?:L|l|リットル))$/, RE_FUEL_ONLY = /^\d+(?:\.\d+)?(?:L|l|リットル)$/;
  const RE_QTY_AT = /(?<=\D)\s*(\d{1,2})\s*(?:コ|個|点|本|袋|枚|パック|P|ヶ|ケ)\s*@\s*[¥\\]?\s*(\d[\d,]*)\s*$/;   // v1.10.16: 牛乳 2個 @198 / ヨーグルト3点@128 (the count and unit price left in the name)
  const RE_SOFT_NOISE = /返品|交換|会員|お客様/g, RE_NOTICE = /(番号|No\.?|ID|カード|ポイント|様|ください|下さい|期限|受付|以内|申し?出|できません|不可|際|場合|お持ち|の上)/i;   // v1.10.14
  function classifyLine(line){
    const compact = line.replace(/\s+/g, '');
    const sp = splitAmount(line);
    const nameCompact = sp.name.replace(/\s+/g, '');
    const info = { line, compact, name: sp.name, amount: sp.amount, kind: 'other' };
    if (!compact) { info.kind = 'blank'; return info; }
    if (RE_ID_LINE.test(compact) && !/[¥￥円]/.test(compact)) { info.kind = 'noise'; info.idLine = true; return info; }   // v1.10.15: 会計番号 1234 (before, read as an item of ¥1,234)
    // 外消費税10% (対象額 ¥3,480) ¥348 : a tax line that also shows its base amount
    const beforeBase = compact.replace(/[（(]?対象.*/, '');
    if (/[（(]\s*(?:税率\s*\d*%?\s*)?対象/.test(compact) && beforeBase && (KW.exTax.test(beforeBase) || KW.inTax.test(beforeBase) || KW.tax.test(beforeBase))) {
      info.kind = 'tax'; info.taxType = KW.inTax.test(beforeBase) ? 'in' : KW.exTax.test(beforeBase) ? 'ex' : 'unknown';
      if (/[)）]$/.test(compact)) { info.amount = null; info.awaitAmount = true; }
      return info;
    }
    if (KW.taxBase.test(compact) && !KW.total.test(compact.replace(/対象.*/, ''))) { info.kind = 'taxbase'; return info; }
    if (KW.subtotal.test(compact)) { info.kind = 'subtotal'; const ps = partialSubOf(nameCompact || compact); if (ps) info.partial = ps; return info; }   // v1.10.11: 8%小計 / 食品部門小計 is a part of the receipt, not its whole 小計
    // tax lines that end in 合計 are tax, never the receipt total: 税合計 / 税額合計 / 消費税(額)等合計 / 外税合計 / 課税額合計 (税込合計 is a total, 税抜合計 a subtotal)
    if (/^[(（]/.test(compact) && /\d+\s*[PＰ][)）]?$/.test(compact)) { info.kind = 'noise'; return info; }   // (ボーナスポイント 120P)
    if (/売\s*変|売価変更/.test(compact) && /→/.test(compact)) { info.kind = 'noise'; return info; }   // 売変 @399 → @199
    if (RE_STAFF.test(compact)) { info.kind = 'noise'; return info; }
    if (RE_TAX_BASE.test(nameCompact)) { info.kind = 'taxbase'; return info; }   // 課税額合計 ¥100 is the amount taxed, not tax
    if (RE_TAX_SUM.test(nameCompact) && !/税[込抜]/.test(nameCompact)) { info.kind = 'tax'; info.taxType = 'sum'; return info; }
    if (RE_TAX_RATE_SUM.test(nameCompact)) { info.kind = 'taxbase'; return info; }
    if (/税抜.{0,2}合計/.test(nameCompact)) { info.kind = 'subtotal'; return info; }
    if (!info.amount && KW.total.test(compact) && /[%％]\s*(引|OFF|ＯＦＦ|0FF|オフ)/i.test(compact)) { info.kind = 'noise'; return info; }   // お買い上げ金額5%引き！ (a promotion, not the total)
    if (RE_DISC_SUM.test(nameCompact)) { info.kind = 'discount'; info.discSum = true; return info; }   // v1.10.5: before this, 値引合計 -100 was read as a receipt total of ¥100
    // v1.10.14: お会計 / ご会計 / 会計 / 総計 / 計 / 現計 / 税込計 / TOTAL as the whole label of the line are the total (as part of a longer line -
    // 会計番号, TOTALケア歯みがき - they are not)
    if (RE_TOTAL_LABEL.test(nameCompact || compact)) { info.kind = 'total'; info.totalRank = 2; return info; }
    if (KW.total.test(compact) && !/(対象|点数)/.test(compact)) { info.kind = 'total'; info.totalRank = /(商品|品目|明細|お買上点|部門)合計/.test(nameCompact) ? 1 : 2; return info; }
    // v1.10.5: 税抜金額 ¥926 / (税抜 ¥926) is the amount before tax, not a tax amount (when 税抜 is the only tax word on the line)
    if (/税抜/.test(compact)) { const rest = compact.replace(/税抜/g, ''); if (!KW.tax.test(rest) && !/(外税|外消費税|内税|内消費税|\(外\)|\(内)/.test(rest)) { info.kind = 'taxbase'; return info; } }
    if (KW.exTax.test(compact) || KW.inTax.test(compact) || KW.tax.test(compact)) {
      info.kind = 'tax'; info.taxType = KW.inTax.test(compact) ? 'in' : KW.exTax.test(compact) ? 'ex' : 'unknown'; return info;
    }
    const pk = payKind(nameCompact);
    if (pk) { info.kind = 'pay'; info.payKind = pk; return info; }
    if (sp.amount && sp.amount.neg && RE_CANCEL.test(nameCompact)) { info.kind = 'discount'; info.cancel = true; return info; }   // v1.10.16
    if ((sp.amount && RE_UNIT_INFO.test(nameCompact)) || RE_FUEL_QTY.test(compact) || RE_UNIT_LINE.test(compact) || RE_FUEL_ONLY.test(compact)) { info.kind = 'unitinfo'; return info; }   // v1.10.16 / v1.10.17: also 数量 30.00L, 単価 168円/L, 30.00L
    if (sp.amount && !sp.amount.neg && /^金額[:：]?$/.test(nameCompact)) { info.kind = 'amountonly'; return info; }   // v1.10.16
    // v1.10.14: points used to pay part of the bill (ポイント利用 -48 / dポイント利用 48) lower the total like a discount. Before, every line
    // with ポイント was dropped, and the receipt looked as if an item had been read twice. Balances, points earned and counts stay noise.
    if (sp.amount && RE_POINT_USE.test(nameCompact) && !RE_POINT_INFO.test(nameCompact)) { info.kind = 'discount'; info.pointUse = true; return info; }
    if (KW.points.test(compact) || (/ポイント(?![ァ-ヶ])|ﾎﾟｲﾝﾄ/.test(compact) && RE_POINT_INFO.test(compact) && !(sp.amount && sp.amount.hadYen))) { info.kind = 'noise'; return info; }   // v1.10.15: 利用可能ポイント 500 / ポイント5倍 / ポイント有効期限 are information (利用可能ポイント was read as an item)
    // v1.10.11: a discount whose name carries a word of the noise list (会員クーポン -100 / お客様割引 -50) is a discount - before, 会員 made it noise
    // and the coupon was lost. Only with a minus amount, or with a discount word and no number-like noise (会員番号 / カード番号 are not discounts).
    // v1.10.14: まとめ買いパック ¥498 (a product with a price) is an item; まとめ買い -100 / まとめ買い値引 100 stay discounts
    const matomeItem = !!(sp.amount && !sp.amount.neg && /まとめ買い?[^\d]/.test(nameCompact) && !KW.discount.test(nameCompact.replace(/まとめ買い?/g, '')) && !/(引|割|OFF|オフ|特価)/i.test(nameCompact));
    if (!matomeItem && KW.discount.test(compact) && sp.amount && (sp.amount.neg || !/(番号|No\.?\d|ID|TEL|電話|登録|ポイント)/i.test(compact))) { info.kind = 'discount'; return info; }
    // v1.10.14: 交換 / 返品 / 会員 / お客様 make a line noise only when it reads like a notice (返品・交換はレシートを… / 会員番号 / お客様各位).
    // A product with a price (交換用ブラシ ¥498 / 会員限定ビール ¥1,200) is an item.
    const softOnly = KW.noise.test(compact) && sp.amount && !sp.amount.neg && !KW.noise.test(compact.replace(RE_SOFT_NOISE, '')) && !RE_NOTICE.test(compact) && !!cleanItemName(sp.name);
    if ((KW.noise.test(compact) && !softOnly) || KW.date.test(compact) || KW.phone.test(compact) || KW.address.test(compact)) { info.kind = 'noise'; return info; }
    if (!matomeItem && KW.discount.test(compact)) { info.kind = 'discount'; return info; }
    if (parseQty(line)) { info.kind = 'qty'; info.qty = parseQty(line); return info; }
    if (sp.amount) {
      if (sp.amount.neg) { info.kind = 'discount'; return info; }
      const nm = cleanItemName(sp.name);
      if (!nm) { info.kind = 'amountonly'; return info; }
      info.kind = 'item'; return info;
    }
    info.kind = 'nameonly';
    return info;
  }
  function nameQualityOk(name){
    if (clerkLike(name)) return false;   // staff / register code such as 019048小原 (12345限定セット is a product)
    if (/^\d{4,}\s*(精算機?|ｾｲｻﾝ|レジ|ﾚｼﾞ|担当|POS|セルフ)/.test(String(name || '').trim())) return false;   // 940616精算機16
    const q = meaningfulCount(name);
    return q.jp >= 1 || q.lat >= 2;
  }
  function validDateParts(y, m, d){
    if (!(y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }
  function isoOf(y, m, d){ return `${y}-${pad(m)}-${pad(d)}`; }
  function extractDate(text, today){
    const now = today ? new Date(today + 'T00:00:00') : new Date();
    const todayStr = isoOf(now.getFullYear(), now.getMonth() + 1, now.getDate());
    const lines = String(text || '').split(/\r?\n/).map(normalizeLine).filter(Boolean);
    const ok = (y, m, d) => validDateParts(y, m, d) && isoOf(y, m, d) <= todayStr;
    // 1) 4-digit year
    for (const ln of lines) {
      if (KW.phone.test(ln) && !/\d{1,2}:\d{2}/.test(ln)) continue;
      const re = /(20\d{2})\s*[年\/.\-]\s*(\d{1,2})\s*[月\/.\-]\s*(\d{1,2})/g; let m;
      while ((m = re.exec(ln))) { const y = +m[1], mo = +m[2], d = +m[3]; if (ok(y, mo, d)) return { date: isoOf(y, mo, d), found: true, how: 'ymd' }; }
    }
    // 2) Reiwa
    for (const ln of lines) {
      const re = /(?:令和|R)\s*(元|\d{1,2})\s*[年\/.\-]\s*(\d{1,2})\s*[月\/.\-]\s*(\d{1,2})/g; let m;
      while ((m = re.exec(ln))) { const y = 2018 + (m[1] === '元' ? 1 : +m[1]), mo = +m[2], d = +m[3]; if (ok(y, mo, d)) return { date: isoOf(y, mo, d), found: true, how: 'reiwa' }; }
    }
    // 3) 2-digit year (only at line start or on a line with a time; not on phone/address lines)
    for (const ln of lines) {
      if (KW.phone.test(ln) || KW.address.test(ln) || /TEL|電話/i.test(ln)) continue;
      const hasTime = /\d{1,2}:\d{2}/.test(ln);
      const re = /(^|[^\d])(\d{2})\s*[\/.\-年]\s*(\d{1,2})\s*[\/.\-月]\s*(\d{1,2})(?=[^\d]|$)/g; let m;
      while ((m = re.exec(ln))) {
        const atStart = m.index === 0 && m[1] === '';
        if (!hasTime && !atStart) continue;
        const y = 2000 + (+m[2]), mo = +m[3], d = +m[4];
        if (ok(y, mo, d)) return { date: isoOf(y, mo, d), found: true, how: 'yy' };
      }
    }
    // 4) M月D日 / M/D only on a line with a time
    for (const ln of lines) {
      if (!/\d{1,2}:\d{2}/.test(ln)) continue;
      const m = ln.match(/(^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})\s*日/) || ln.match(/(^|[^\d:])(\d{1,2})\/(\d{1,2})(?=[^\d]|$)/);
      if (!m) continue;
      const mo = +m[2], d = +m[3];
      let y = now.getFullYear();
      if (validDateParts(y, mo, d) && isoOf(y, mo, d) > todayStr) y -= 1;
      if (ok(y, mo, d)) return { date: isoOf(y, mo, d), found: true, how: 'md' };
    }
    return { date: todayStr, found: false, how: '' };
  }
  function extractStore(lines){
    if (typeof lines === 'string') lines = lines.split(/\r?\n/);
    const first = extractStoreMain(lines);
    // a heading, slogan or misread company line is not a store name: use the branch line (…店) instead
    if (first && !/([デテ][ィイ]?ス[カ力]ウン[トド]|一般のお客様|大歓迎|お客様控え|毎度|領収|收|機式会社|より良い品|ご来店|お買上|^株式(?!会社)|\s株式$)/.test(first)) {
      if (/店/.test(first)) return first;
      const br = extractBranch(lines, true); if (!br || first.includes(br)) return first;
      if (/[ァ-ヶー][A-Z0-9]{2,}|[A-Z0-9]{2,}[ァ-ヶ]/.test(first)) return br;   // a garbled logo (ドラTX7EY)
      return `${first} ${br}`.slice(0, 60);
    }
    return extractBranch(lines) || first;
  }
  function extractBranch(lines, noJoin){
    // a branch line ending in 店 (業務スーパー名取増田店 / 仙台南店 TEL… / 亘理店 0223-…); a short one gets the brand above it
    const GENERIC = /([デテ][ィイ]?ス[カ力]ウン[トド]|一般のお客様|大歓迎|お客様控え|毎度|ありがとう|親切なお店|より良い品|本社|株式会社|有限会社|\(株\)|機式会社|営業時間|領収|登録番号|お会計券)/;
    for (let k = 0; k < Math.min(lines.length, 14); k++) {
      const ln = normalizeLine(lines[k]).replace(/\s*(TEL|ＴＥＬ|☎|電話|FAX).*$/i, '').replace(/\s*[\d()\-]{9,}.*$/, '').replace(/\s*\(?\d{2,4}\)?-?\d{2,4}-\d{3,4}.*$/, '').trim();
      const shop = ln.replace(/^[※*・\-|]+/, '').replace(/^親切なお店\s*/, '');
      if (!/店$/.test(shop) || shop.length < 2 || shop.length > 24 || GENERIC.test(shop) || KW.address.test(shop) || KW.date.test(shop) || /[都道府県].{1,6}[市区町村郡]|\d丁目/.test(shop)) continue;   // an address (利府店 is a store)
      if (noJoin || shop.replace(/\s/g, '').length > 6) return shop.slice(0, 60);
      for (let u = k - 1; u >= Math.max(0, k - 5); u--) {
        const b = normalizeLine(lines[u]).replace(/^[※*・\-|]+/, '').trim(), q = meaningfulCount(b.replace(/\s/g, ''));
        if (b && shop.replace(/\s/g, '').indexOf(b.replace(/\s/g, '')) >= 0) return shop;   // やまや + やまや築館店
        if (!b || GENERIC.test(b) || KW.phone.test(b) || KW.date.test(b) || KW.address.test(b) || /\d{4,}|T\d{10,}/.test(b) || !(q.jp >= 2 || q.lat >= 3) || b.length > 16) continue;
        return `${b.replace(/^(株式)?会社/, '')} ${shop}`.slice(0, 60);
      }
      return shop;
    }
    return '';
  }
  function extractStoreMain(lines){
    const anchor = lines.slice(0, 16).findIndex(raw => { const ln = normalizeLine(raw); return /登録番号|TEL|電話|〒/i.test(ln) || KW.phone.test(ln); });
    if (anchor > 0) { const near = extractStoreFrom(lines.slice(Math.max(0, anchor - 4), anchor), true); if (near) return near; }
    return extractStoreFrom(lines);
  }
  function extractStoreFrom(lines, nearPhone){
    const greet = /(いらっしゃいませ|ようこそ|毎度|ありがとう|ご来店|領収|レシート|明細|お客様|登録番号|TEL|FAX|電話|No\.|レジ|担当|〒)/i;
    const cands = [];
    for (const raw of lines.slice(0, 12)) {
      const ln = normalizeLine(raw);
      if (!ln) continue;
      const c = classifyLine(ln);
      if (c.kind === 'item' || c.kind === 'total' || c.kind === 'subtotal' || c.kind === 'qty' || c.kind === 'pay') break;
      if (c.amount) continue;
      if (greet.test(ln) || KW.date.test(ln) || KW.phone.test(ln) || KW.address.test(ln)) continue;
      const nonSpace = ln.replace(/\s/g, '');
      const q = meaningfulCount(nonSpace);
      const digits = (nonSpace.match(/\d/g) || []).length;
      if ((q.jp + q.lat + digits) / Math.max(1, nonSpace.length) < 0.6) continue;
      if (!(q.jp >= 2 || q.lat >= 3)) continue;
      cands.push(ln.replace(/^[※*・\-|]+/, '').trim());
      if (cands.length >= 2) break;
    }
    if (!cands.length) return '';
    let store = cands[0];
    if (cands[1] && cands[1].replace(/\s/g, '').indexOf(store.replace(/\s/g, '')) === 0 && /店$/.test(cands[1])) store = cands[1];   // logo やまや + やまや築館店
    else if (cands[1] && /店$/.test(cands[1]) && cands[1].length <= 12 && !/店$/.test(store)) store = `${store} ${cands[1]}`;
    // a logo printed in two Latin lines (FOOD DEPO / COSPA)
    else if (cands[1] && /^[A-Za-z][A-Za-z0-9 &'.-]*$/.test(store) && /^[A-Za-z][A-Za-z0-9&'.-]{1,15}$/.test(cands[1])) store = `${store} ${cands[1]}`;
    else if (nearPhone && cands[1] && cands[1].replace(/\s/g, '').length <= 8 && !/\d/.test(cands[1]) && store.length <= 24) store = `${store} ${cands[1]}`;
    return store.slice(0, 60);
  }
  // Text copied with iPhone Live Text can list the names and the prices in two separate blocks.
  // When names are followed directly by the same number of price-only lines (2 or more), pair them in order;
  // the closest labels are paired; earlier lines (store name, address, date) are left as they are.
  function pairColumnLines(text){
    const lines = String(text || '').split(/\r?\n/).filter(l => normalizeLine(l));
    const kinds = lines.map(l => {
      const n = normalizeLine(l), c = classifyLine(n);
      if (c.kind === 'amountonly' || /^\d{1,3}点$/.test(n.replace(/\s/g, ''))) return 'value';
      if (!c.amount && c.kind !== 'blank' && c.kind !== 'qty') return 'label';
      return 'other';
    });
    const out = [];
    let i = 0;
    while (i < lines.length) {
      if (kinds[i] !== 'label') { out.push(lines[i++]); continue; }
      let j = i; while (j < lines.length && kinds[j] === 'label') j++;
      let k = j; while (k < lines.length && kinds[k] === 'value') k++;
      const n = j - i, m = k - j;
      const lastLabels = lines.slice(j - m, j).map(normalizeLine);
      if (m >= 2 && n >= m && !lastLabels.some(l => KW.date.test(l) || KW.phone.test(l))) {
        while (i < j - m) out.push(lines[i++]);
        for (let t = 0; t < m; t++) out.push(lines[j - m + t] + ' ' + lines[j + t]);
        i = k; continue;
      }
      while (i < j) out.push(lines[i++]);
    }
    return out.join('\n');
  }
  // v1.10.17: the item a 取消 / 返品 / 訂正 line takes back (items above it on the same photo, not discounted). The evidence, in this order:
  //   a printed name: the items of that name (normalized: 牛乳 = ｷﾞｭｳﾆｭｳ is not done, ﾊﾟﾝ = パン is) and amount. A name that only contains or resembles the
  //     printed one is not the same item: 取消 牛乳 never takes 牛乳石鹸 (before, the nearest item whose name contained 牛乳 was taken out). One item of the
  //     name with a larger amount that the line takes part of (2個 @198 → 1個) is reduced.
  //   no printed name: the only item of that amount.
  // Several items that fit and differ (another name, another tax mark or rate) are not chosen between: nothing is taken out and the line stays open
  // (open: 'amb' the same evidence fits more than one item, 'rel' only items with a similar name have the amount, 'other' only items of another name
  // have it). Items that are all the same (name, amount, tax mark and rate) are one choice: the nearest one goes (one line takes back one item).
  // No item of the amount at all: k is null and open is empty - the line counts as a discount on the receipt as before, and is noted as open ('none').
  // v1.10.18: an item of the printed name with another amount is looked at before items of other names with the amount: a part of its count (cancelPart:
  // 牛乳 3個 @198 ¥594 → 取消 牛乳 −396 takes 2 of the 3), or - when the count and unit price do not give the amount of the line - nothing is taken out and
  // the line stays open ('qty'). Before, only an item whose amount the line divided evenly was reduced (594 is not a multiple of 396: the line became a
  // discount on the receipt and 牛乳 stayed 3個 ¥594).
  function cancelTarget(items, d, cn){
    const ck = nameKey(cn), sig = it => [nameKey(it.name), it.amount, it._taxMode || '', it._taxRate || '', it._reduced ? 1 : 0].join('|');
    const alike = js => js.length > 0 && js.every(j => sig(items[j]) === sig(items[js[0]]));
    const cand = []; items.forEach((it, j) => { if (!it._discount && it.amount === d) cand.push(j); });
    if (ck) {
      const exact = cand.filter(j => nameKey(items[j].name) === ck);
      if (exact.length) return alike(exact) ? { k: exact[exact.length - 1] } : { open: 'amb', cands: exact };
      const part = [], odd = []; items.forEach((it, j) => { if (it._discount || nameKey(it.name) !== ck || it.amount === d) return; (cancelPart(it, d) ? part : odd).push(j); });
      if (part.length) return alike(part) ? { k: part[part.length - 1], part: true } : { open: 'amb', cands: part };
      if (odd.length) return { open: 'qty', cands: odd };
      if (!cand.length) return {};
      const near = cand.filter(j => { const ik = nameKey(items[j].name); return ik.includes(ck) || ck.includes(ik) || similarity(ik, ck) >= 0.6; });
      return { open: near.length ? 'rel' : 'other', cands: near.length ? near : cand };
    }
    if (!cand.length) return {};
    return alike(cand) ? { k: cand[cand.length - 1] } : { open: 'amb', cands: cand };
  }
  // v1.10.18: the count and unit price printed with an item (数量 3 × ¥198 from 牛乳 3個 @198 ¥594, or the count set on the item). ok = they give its amount.
  function qtyOf(it){ const q = itemQty(it), a = Math.round(Number(it && it.amount) || 0); if (q <= 1) return { q: 1, u: 0, ok: false };
    const m = String(it && it._hint || '').match(/数量\s*(\d{1,3})\s*×\s*[¥￥]?\s*([\d,]+)/), hu = m && Number(m[1]) === q ? Number(m[2].replace(/,/g, '')) : 0, u = hu || (a % q === 0 ? a / q : 0);
    return { q, u, ok: u > 0 && u * q === a }; }
  // v1.10.18: the part of one item a 取消 line of d yen takes back. With a count: d ÷ the unit price units, fewer than the count (k). Without a count: an
  // amount that the line divides into equal parts (¥396 → 取消 −198: ¥198 left, as before; k 0 = the count is not known). null when it does not fit:
  // another unit price (594 = 3 × 198, 取消 −300), as many units as the count or more, or a count that does not give the amount with its unit price.
  function cancelPart(it, d){ const a = Math.round(Number(it && it.amount) || 0); if (!(d > 0) || !(a > d)) return null; const e = qtyOf(it);
    if (e.q > 1) return e.ok && d % e.u === 0 && d / e.u < e.q ? { k: d / e.u, q: e.q, u: e.u } : null;
    return a % d === 0 ? { k: 0, q: 1, u: 0 } : null; }
  // take that part off the item: the amount, and the count when it is known (the stepper, the unit price shown and the saved count follow it)
  function applyCancelPart(it, d, word){ const p = cancelPart(it, d) || { k: 0 }, from = it.amount, q0 = itemQty(it); it.amount -= d; if (p.k > 0) it.qty = p.q - p.k; delete it._base;
    it._hint = addHint(it._hint, `${word || '取消'} ${yenPlain(d)} を反映（元 ${yenPlain(from)}${p.k > 0 ? `・${q0}個 → ${p.q - p.k}個` : ''}）`); return { q0: p.k > 0 ? q0 : 0, q1: p.k > 0 ? p.q - p.k : 0 }; }
  function parseReceipt(text){
    const rawLines = String(text || '').split(/\r?\n/);
    const lines = rawLines.map(normalizeLine);
    const nonEmpty = lines.filter(Boolean);
    // receipts that print 外8 / 内10 before every item: OCR often turns the mark into 18, タ18, 918 ...
    const clearMarks = nonEmpty.filter(l => /^(?:外|内)\s?(?:8|10)(?=\s|[^\d%％])/.test(l)).length, looseMarks = nonEmpty.filter(l => /^[^\s]{0,2}?[外内]?\s?\d{0,2}(?:8|10)\s+\S/.test(l) && splitAmount(l).amount).length;
    looseTaxClass = clearMarks >= 2 || looseMarks >= 2 || nonEmpty.some(l => /外\s?8\s?内\s?8|[外内]\s?8.{0,10}軽減/.test(l));
    // a column of item codes before the names (0656 みょうが / 0890 さといも, #ソ 000261 …): codes of that length are removed
    // ... and only when most item lines carry one (two products like 12345限定セット / 20250限定商品 are not a column)
    // (half of the item lines or more, and three or more codes or zero-padded ones like 0656 / 000261)
    const codeLens = {}, codeZero = {}; let itemLines = 0;
    for (const l of nonEmpty) { if (classifyLine(l).kind !== 'item') continue; itemLines++; const m = l.match(RE_CODE_HEAD); if (m && !RE_UNIT_HEAD.test(l.slice(m[0].length))) { const k = m[3].length; codeLens[k] = (codeLens[k] || 0) + 1; codeZero[k] = (codeZero[k] !== false) && m[3][0] === '0'; } }
    codePrefixLen = 0; for (const [len, n] of Object.entries(codeLens)) if (n >= 2 && n >= itemLines * 0.5 && (Number(len) > 3 ? (n >= 3 || codeZero[len]) : codeZero[len]) && (!codePrefixLen || n > codeLens[codePrefixLen])) codePrefixLen = Number(len);
    const dateInfo = extractDate(text);
    const yenPrinted = lines.filter(l => { const a = l ? splitAmount(l).amount : null; return a && a.hadYen; }).length >= 2;
    const store = extractStore(nonEmpty);
    const items = [];
    const meta = { total: 0, totalLine: '', subtotal: 0, exTax: 0, inTax: 0, unknownTax: 0, cash: 0, change: 0, changeFound: false, card: 0, receiptDiscount: 0, discounts: [], discLines: [], subtotals: [], baseSum: 0, baseCount: 0, taxSum: 0 };
    let footer = false, afterSubtotal = false, pendingPrice = 0, pendingTotalRank = 0, pendingName = null, pendingTotal = false, pendingTax = '', prevKind = '', lastItem = null, pendingDiscountLabel = false;
    for (let li = 0; li < nonEmpty.length; li++) {
      const ln = nonEmpty[li]; parseLine = ln;
      const c = classifyLine(ln);
      if (/売\s*変|売価変更/.test(c.compact || '') && /→/.test(c.compact || '')) {
        const pm = String(c.compact).match(/→\s*[@＠0]?(\d{1,6})\D*$/), b = pm ? Number(pm[1]) : 0;
        if (b && lastItem && !afterSubtotal && lastItem.amount !== b && lastItem.amount % b !== 0) { lastItem._hint = addHint(lastItem._hint, `売変後の単価 ${yenPlain(b)} を採用（読み取りは ${yenPlain(lastItem.amount)}）`); lastItem.amount = b; }
        if (lastItem && prevKind === 'item') { pendingName = null; continue; }
      }
      if (c.kind === 'blank' || c.kind === 'unitinfo') continue;   // v1.10.16: 単価 ¥168 keeps the fuel named above it for the 金額 line
      const amt = c.amount ? c.amount.value : 0;
      if (pendingTotal && c.kind === 'amountonly' && amt && !meta.total) { meta.total = amt; meta.totalRank = pendingTotalRank || 2; pendingTotal = false; footer = true; prevKind = 'total'; continue; }
      pendingTotal = false;
      // the tax amount printed on the line after its label (外消費税10% (対象額 ¥3,480) / ¥348)
      if (pendingTax && c.kind === 'amountonly' && amt && !c.amount.neg) { taxLine(meta, pendingTax, meta._pendRate, amt, afterSubtotal, li); if (pendingTax === 'sum') meta.taxSum = amt; else if (pendingTax === 'ex') meta.exTax += amt; else if (pendingTax === 'in') { meta.inTax += amt; meta.inTaxMax = Math.max(meta.inTaxMax || 0, amt); } else meta.unknownTax += amt; pendingTax = ''; prevKind = 'tax'; continue; }
      if (c.kind !== 'taxbase') pendingTax = '';
      if (c.kind === 'total') {
        const rank = c.totalRank || 2;
        if (amt && !c.amount.neg) (meta.totLines = meta.totLines || []).push({ a: amt, li });   // v1.10.15: every total-like line (合計 / お支払額 …), also the ones not taken as the total
        if (amt && (!meta.total || rank > (meta.totalRank || 0))) { meta.total = amt; meta.totalLine = ln; meta.totalRank = rank; }
        else if (!amt && (!meta.total || rank > (meta.totalRank || 0))) { pendingTotal = true; pendingTotalRank = rank; }
        footer = true; prevKind = 'total'; pendingName = null; continue;
      }
      if (c.kind === 'subtotal' && c.partial) { if (amt) (meta.partSubs = meta.partSubs || []).push({ a: amt, scope: c.partial.scope, rate: c.partial.rate, basis: /税込/.test(c.compact || '') ? 'in' : /税抜|税別/.test(c.compact || '') ? 'ex' : '', label: String(c.compact || '').replace(/[\d¥￥,.\s]+$/, '').slice(0, 12), li }); prevKind = 'subtotal'; pendingName = null; continue; }   // v1.10.11: kept apart - never used as the whole 小計
      // v1.10.12: a 小計 of one rate or department closes that section only, not the receipt: the item lines after it are read (before, it set afterSubtotal
      // like the receipt's 小計, and 外10 洗剤 ¥1000 after 8%小計 was skipped). The receipt still ends at its own 小計, 合計 or a payment line.
      if (c.kind === 'subtotal') { if (amt) { const sb = /税込/.test(c.compact || '') ? 'in' : /税抜|税別/.test(c.compact || '') ? 'ex' : '', sl = String(c.compact || '').replace(/[\d¥￥,.\s]+$/, '').slice(0, 12); meta.subtotals.push({ a: amt, basis: sb, label: sl, li }); /* v1.10.10: every 小計 line is kept, with what it says and where it is */ if (!meta.subtotal) { meta.subtotal = amt; meta.subBasis = sb; meta.subLabel = sl; } } afterSubtotal = true; /* v1.10.9: 税込小計 / 税抜小計 is noted with the amount */ prevKind = 'subtotal'; pendingName = null; continue; }
      if (c.kind === 'taxbase') { if (amt && /税率/.test(c.compact)) { meta.baseSum += amt; meta.baseCount++; } prevKind = 'tax'; pendingName = null; continue; }
      if (c.kind === 'tax') {
        if (amt && !c.amount.neg && c.taxType !== 'in' && c.taxType !== 'sum') { const rm = String(c.compact || '').match(/(8|10)\s?[%％]/); if (rm) { meta.taxBy = meta.taxBy || {}; meta.taxBy[rm[1]] = (meta.taxBy[rm[1]] || 0) + amt; } }
        if (amt && !c.amount.neg) { taxLine(meta, c.taxType, taxRateIn(c.compact), amt, afterSubtotal, li); if (c.taxType === 'sum') meta.taxSum = amt; else if (c.taxType === 'ex') meta.exTax += amt; else if (c.taxType === 'in') { meta.inTax += amt; meta.inTaxMax = Math.max(meta.inTaxMax || 0, amt); } else meta.unknownTax += amt; }
        else if (!amt || c.awaitAmount) { pendingTax = c.taxType || 'unknown'; meta._pendRate = taxRateIn(c.compact); }
        prevKind = 'tax'; pendingName = null; continue;
      }
      if (c.kind === 'pay') {
        if (amt && !c.amount.neg) {
          if (c.payKind === 'cash' || c.payKind === 'cashpay') { if (!meta.cash) meta.cash = amt; if (c.payKind === 'cashpay' && !meta.cashPay) meta.cashPay = amt; }
          else if (c.payKind === 'change') { if (!meta.changeFound) { meta.change = amt; meta.changeFound = true; } }
          else if (c.payKind === 'card') { if (!meta.card) meta.card = amt; }
        }
        if (c.payKind !== 'balance') footer = true;
        prevKind = 'pay'; pendingName = null; continue;
      }
      // v1.10.15: points printed after the total line. ポイント値引 / ポイント割引 is a discount on the bill (whether the total already has it taken off
      // is decided with the items and the amount paid - mergeReceiptPages). ポイント利用 / 使用 / 充当 / 払い after the total pays part of the total: a way of
      // paying, not a discount (postPoints). Balances, points earned and counts are noise as before (classifyLine).
      if (footer && c.kind === 'discount' && c.pointUse && amt) {
        const d = Math.abs(amt), isDisc = /値引|割引/.test(c.compact || '');
        (meta.postPoints = meta.postPoints || []).push({ a: d, li, disc: isDisc ? 1 : 0, label: String(c.compact || '').replace(/[-−ー―▲△¥￥\d,.\s円]+/g, '').slice(0, 12) });
        if (isDisc) { meta.receiptDiscount += d; meta.discounts.push(d); meta.discLines.push({ a: d, li, after: afterSubtotal ? 1 : 0, post: 1, label: String(c.compact || ln || '').replace(/[-−ー―▲△¥￥\d,.\s円]+/g, '').slice(0, 12), name: discName(c.name || c.compact) }); }
        prevKind = 'discount'; pendingName = null; continue;
      }
      if (footer) { prevKind = 'footer'; continue; }
      if (c.kind === 'noise') { if (prevKind !== 'item' || !/ポイント|\d\s*P\b|P\)/.test(c.compact)) prevKind = 'noise'; pendingName = null; continue; }
      if (c.kind === 'discount') {
        let amt2 = amt;
        if (!amt2) { const lm = c.compact.match(/[.,·･]([0-9]{1,5})$/); if (lm) amt2 = Number(lm[1]); }
        if (!amt2) { pendingDiscountLabel = prevKind === 'item'; prevKind = pendingDiscountLabel ? 'item' : 'discount'; continue; }
        const d = Math.abs(amt2);
        // v1.10.16: 取消 / 返品 / 訂正: the item it takes back (same amount; the same name when one is printed - the nearest one above) leaves the list.
        // Without such an item it stays a discount on the receipt as before (never on the item above it).
        // v1.10.17: the item is chosen by cancelTarget (the same name before a similar one; nothing taken out when the line does not single out one item).
        // v1.10.18: also after the 小計 (小計 ¥396 / 取消 牛乳 −198 / 合計 ¥198): a line with a name or an amount that takes back an item above it is the same
        // line wherever it stands before the 合計. Before, every 取消 line after 小計 became a discount on the whole receipt: 牛乳 stayed in the list, the
        // sums agreed, and the ¥198 was taken off 食費 and 日用品 alike. Notices (返品・交換はレシートを…) have no minus amount and are not 取消 lines; lines
        // after the 合計 are not read as items or discounts (footer).
        if (c.cancel) { const cn = cleanItemName(String(c.name || '').replace(/\s+/g, '').replace(RE_CANCEL, '')), word = (String(c.compact || '').match(RE_CANCEL) || [''])[0] || '取消', ct = cancelTarget(items, d, cn), after = afterSubtotal ? 1 : 0;
          if (ct.k != null) { const it = items[ct.k];
            if (ct.part) { const pq = applyCancelPart(it, d, word); (meta.cancelled = meta.cancelled || []).push(Object.assign({ name: it.name, n: cn.slice(0, 40), a: d, part: 1, li }, pq.q0 ? { q0: pq.q0, q1: pq.q1 } : {}, after ? { after } : {})); }
            else { const first = ct.k === 0 ? 1 : 0, rm = items.splice(ct.k, 1)[0]; (meta.cancelled = meta.cancelled || []).push(Object.assign({ name: rm.name, n: cn.slice(0, 40), a: d, li }, first ? { first } : {}, after ? { after } : {})); }
            if (after) meta.cancelAfterSub = (meta.cancelAfterSub || 0) + d;   // the 小計 above it still has the item in it: 小計 − 取消 is what is left
            lastItem = items.length ? items[items.length - 1] : null; pendingDiscountLabel = false; prevKind = 'discount'; pendingName = null; continue; }
          (meta.cancelOpen = meta.cancelOpen || []).push({ n: cn.slice(0, 40), a: d, w: ct.open || 'none', c: (ct.cands || []).map(j => items[j].name).slice(0, 4), word, li, head: items.length ? 0 : 1 });
          if (ct.open) { pendingDiscountLabel = false; prevKind = 'discount'; pendingName = null; continue; } }   // the items stay as read and nothing is subtracted: the person removes the item
        // v1.10.5: 値引合計 / 割引計 that repeats the discounts already taken above is not one more discount (it would be subtracted twice)
        if (c.discSum) { const seen = items.reduce((s2, it) => s2 + (it._discount || 0), 0) + meta.receiptDiscount; if (seen > 0 && d === seen) { meta.discRecap = d; pendingDiscountLabel = false; prevKind = 'discount'; pendingName = null; continue; } }
        if (!c.discSum && !c.pointUse && !c.cancel && !afterSubtotal && prevKind === 'item' && lastItem && d < lastItem.amount && !lastItem._discount) {   // v1.10.14: points pay part of the bill, not one item
          lastItem._origAmount = lastItem.amount; lastItem._discount = d; lastItem.amount = lastItem.amount - d;
          lastItem._hint = addHint(lastItem._hint, `値引 ${yenPlain(d)} を反映（元 ${yenPlain(lastItem._origAmount)}）`);
        } else { meta.receiptDiscount += d; meta.discounts.push(d); if (afterSubtotal) meta.discAfterSub = (meta.discAfterSub || 0) + d;
          meta.discLines.push(Object.assign({ a: d, li, after: afterSubtotal ? 1 : 0, label: String(c.compact || ln || '').replace(/[-−ー―▲△¥￥\d,.\s円]+/g, '').slice(0, 12), name: discName(c.name || c.compact) }, c.cancel ? { cancel: 1 } : {})); }   // v1.10.10: the line itself is kept (amount, place, wording)   // v1.10.17: cancel = a 取消 line with no item of its amount above it on this photo (v1.10.18: also after the 小計)
        pendingDiscountLabel = false; prevKind = 'discount'; pendingName = null; continue;
      }
      if (afterSubtotal && c.kind === 'item' && amt && !c.amount.neg && RE_SERVICE.test(c.compact || '')) {   // v1.10.16: サービス料 / 席料 after 小計
        const it = makeItem(String(c.name || '').replace(/\s*\d{1,2}\s*[%％]\s*$/, ''), amt, store); if (it) { items.push(it); lastItem = it; prevKind = 'aftersub'; pendingName = null; continue; } }
      if (afterSubtotal) { prevKind = 'aftersub'; pendingName = null; continue; }
      if (c.kind === 'qty') {
        const q = c.qty; let total = amt || 0;
        if (total && q.qty > 1 && total === q.unit) total = q.qty * q.unit;
        if (pendingName && total) {
          const it = makeItem(pendingName, total, store);
          if (it) { it._hint = addHint(it._hint, `数量 ${q.qty} × ${yenPlain(q.unit)}`); items.push(it); lastItem = it; prevKind = 'item'; pendingName = null; continue; }
        }
        if (lastItem && prevKind === 'item') lastItem._hint = addHint(lastItem._hint, `数量 ${q.qty} × ${yenPlain(q.unit)}`);
        pendingName = null; continue;
      }
      if (c.kind === 'amountonly') {
        if (amt && c.amount.neg && !afterSubtotal && prevKind === 'item' && lastItem && Math.abs(amt) >= 2 && Math.abs(amt) <= lastItem.amount * 0.5 && !lastItem._discount) {
          const d = Math.abs(amt); lastItem._origAmount = lastItem.amount; lastItem._discount = d; lastItem.amount -= d; lastItem._hint = addHint(lastItem._hint, `値引 ${yenPlain(d)} を反映`); prevKind = 'item'; pendingDiscountLabel = true; continue;
        }
        if (pendingName && amt && !c.amount.neg && (c.amount.hadYen || !yenPrinted)) {
          const it = makeItem(pendingName, amt, store);
          if (it) { items.push(it); lastItem = it; prevKind = 'item'; pendingName = null; continue; }
        }
        pendingPrice = (amt && !c.amount.neg && c.amount.hadYen && !afterSubtotal) ? amt : 0;
        prevKind = 'amountonly'; pendingName = null; continue;
      }
      if (c.kind === 'item') {
        if (yenPrinted && c.amount && !c.amount.hadYen && clerkLike(c.name)) { prevKind = 'noise'; pendingName = null; continue; }   // clerk / register line
        const qv = String(c.name || '').trim().match(/^(\d{1,2})\s*[点個コ]\s*[@＠0OＯ]?\s*(\d{1,6})$/);
        if (qv && pendingName && Number(qv[1]) * Number(qv[2]) === amt) { const it = makeItem(pendingName, amt, store); if (it) { it._hint = addHint(it._hint, `数量 ${qv[1]} × ${yenPlain(Number(qv[2]))}`); items.push(it); lastItem = it; prevKind = 'item'; pendingName = null; continue; } }
        let name = c.name; let hint = '';
        const qi = name.match(RE_QTY_INLINE);
        if (qi && qi.index > 0) { hint = `数量 ${qi[1]} × ${yenPlain(Number(qi[2].replace(/,/g, '')))}`; name = name.slice(0, qi.index); }
        else { const qa = name.match(RE_QTY_AT); if (qa && qa.index > 0 && Number(qa[1]) > 1 && Number(qa[1]) * Number(qa[2].replace(/,/g, '')) === amt) { hint = `数量 ${qa[1]} × ${yenPlain(Number(qa[2].replace(/,/g, '')))}`; name = name.slice(0, qa.index); } }   // v1.10.16: only when count × unit price is the amount
        const it = makeItem(name, amt, store);
        if (it) { if (hint) it._hint = addHint(it._hint, hint); items.push(it); lastItem = it; prevKind = 'item'; pendingName = null; continue; }
        prevKind = 'junk'; pendingName = null; continue;
      }
      if (c.kind === 'nameonly') {
        const nm = cleanItemName(c.name);
        const nextC = li + 1 < nonEmpty.length ? classifyLine(nonEmpty[li + 1]) : null, ownPriceBelow = !!(nextC && nextC.kind === 'amountonly' && nextC.amount && !nextC.amount.neg);
        if (pendingPrice && prevKind === 'amountonly' && !ownPriceBelow && nm && nameQualityOk(nm) && !/^\d{4,}/.test(nm)) {
          const it = makeItem(c.name, pendingPrice, store); pendingPrice = 0;
          if (it) { it._hint = addHint(it._hint, '金額は1行上から読み取り'); items.push(it); lastItem = it; prevKind = 'item'; pendingName = null; continue; }
        }
        pendingPrice = 0;
        pendingName = nm && nameQualityOk(nm) && !clerkLike(nm) && !/^\d{8,}/.test(nm) ? nm : null; prevKind = 'nameonly'; continue;
      }
      prevKind = c.kind; pendingName = null; pendingPrice = 0;
    }
    // v1.10.10: what stands next to each receipt-level discount (the digits of the nearest lines with digits before and after it): the evidence used
    // to tell a line that was read again on another photo from a second discount. And for every 小計: the discounts that come after it.
    { const dg=j=>String(nonEmpty[j]||'').replace(/[^0-9]/g,''), near=(from,step)=>{ for(let j=from+step;j>=0&&j<nonEmpty.length;j+=step){ const v=dg(j); if(v) return v; } return ''; };
      meta.discLines.forEach(d=>{ d.prev=near(d.li,-1); d.next=near(d.li,1); });
      meta.subtotals.forEach(sb=>{ sb.dA=meta.discLines.filter(d=>d.li>sb.li).reduce((t,d)=>t+d.a,0); sb.cA=(meta.cancelled||[]).filter(cx=>cx.li>sb.li).reduce((t,cx)=>t+cx.a,0); }); }   // v1.10.18: cA = the 取消 lines after it that took an item back
    // v1.10.11: what each line of the photo is (its kind, amount and name): used to find the part that two photos share, line by line
    meta.lineSig = nonEmpty.map(l => { const c = classifyLine(l); return { k: c.kind, a: c.amount ? Math.abs(c.amount.value) : 0, n: String(c.name || '').replace(/\s+/g, '').slice(0, 24) }; });
    // v1.10.17: a 取消 line with no item line after it before the 小計 / 合計 (the end of the items on this photo): the next photo may show it again at its top
    (meta.cancelled || []).forEach(cx => { let tail = 1; for (let j = cx.li + 1; j < meta.lineSig.length; j++) { const k = meta.lineSig[j].k; if (k === 'total' || k === 'subtotal') break; if (k === 'item' || k === 'amountonly') { tail = 0; break; } } cx.tail = tail; });
    delete meta._pendRate; resolveTaxLines(meta);   // v1.10.7: rates add up, restated lines count once, 税合計 never adds (was: 内税 = its largest line only)
    // reduced-rate marks mean 8% only when the receipt explains them (※印は軽減税率対象…); the other items are then 10%
    if (items.some(it => it._reduced) && nonEmpty.some(l => /[※*＊軽].{0,10}(軽減|8\s?[%％])|軽減税率.{0,8}[※*＊]/.test(l))) items.forEach(it => { if (!it._taxRate) it._taxRate = it._reduced ? 8 : 10; });   // 税合計 is the sum of the tax lines, not one more
    const itemSum = items.reduce((s, x) => s + x.amount, 0);
    let total = 0, totalSource = '';
    if (meta.total) { total = meta.total; totalSource = 'total'; }
    else if (meta.cash && meta.changeFound && meta.cash - meta.change > 0) { total = meta.cash - meta.change; totalSource = 'cash'; }
    else if (meta.card) { total = meta.card; totalSource = 'card'; }
    return { date: dateInfo.date, dateFound: dateInfo.found, store, total, totalSource, explicitTotal: meta.total, itemSum, meta, items };
  }
  function addHint(h, s){ return h ? `${h}／${s}` : s; }
  function yenPlain(n){ return '¥' + Math.round(Number(n) || 0).toLocaleString('ja-JP'); }
  let looseTaxClass = false, codePrefixLen = 0;
  // v1.10.3: the tax class printed on an item line (外8 / 内10 prefixes; ※ * 軽 reduced-rate marks, read with the receipt's legend)
  let parseLine = '';
  function tagTaxMarks(it, line){ const l = String(line || '');
    const pm = l.match(/^\s*(外|内)\s?(8|10)(?!\d)/); if (pm) { it._taxMode = pm[1] === '外' ? 'ex' : 'in'; it._taxRate = Number(pm[2]); return it; }
    const sm = l.match(/\d\s?(外|内)\s*$/); if (sm) it._taxMode = sm[1] === '外' ? 'ex' : 'in';   // v1.10.6: ¥330外 / ¥1,080内 - the item is priced without / with tax (the rate is not printed there)
    if (/^\s*[※*＊](?!\d)|[※*＊]\s*(?:↓|$)|\s[※*＊](?=\d+\s*$)|\s[※*＊]\s|\s軽(?:\s|$)/.test(l)) it._reduced = true; return it; }
  function makeItem(rawName, amount, store){ const it = makeItemCore(rawName, amount, store); return it ? tagTaxMarks(it, parseLine) : it; }
  function makeItemCore(rawName, amount, store){
    // clerk and register lines, checked before the code prefix is removed (019048小原 9563 / 940616精算機16 9404)
    const rawTrim = String(rawName || '').trim();
    if (/^\d{4,}\s*(精算機?|ｾｲｻﾝ|レジ|ﾚｼﾞ|担当|POS|セルフ)/.test(rawTrim)) return null;
    let name = cleanItemName(rawName);
    if (looseTaxClass) name = name.replace(/^[^\s]{0,2}?[外内]?\s?\d{0,2}(?:8|10)\s+(?=\S)/, '').replace(/^\d\s?(?=[ァ-ヶ])/, '').trim();
    if (!name || !amount || amount < 1 || amount > 999999) return null;
    if (!nameQualityOk(name)) return null;
    if (/^(20\d{2}\s*[年\/.\-]\s*\d{1,2}|\d{1,2}[\/:.\-]\d{1,2})/.test(name)) return null;
    const cls = classifyItem(name, store);
    return { name, amount, category: cls.category, _source: cls.source, _manual: false };
  }
/* PARSER-END */

  /* PREPROCESS-START */
  // Reads JPEG EXIF orientation and SOF (stored) size from the first bytes of the file. Pure.
  function readJpegInfo(buf){
    const u8=buf instanceof Uint8Array?buf:new Uint8Array(buf);
    if(u8.length<4||u8[0]!==0xFF||u8[1]!==0xD8) return null;
    const dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength);
    let off=2, orientation=1, width=0, height=0;
    while(off+4<=u8.length){
      if(u8[off]!==0xFF){ off++; continue; }
      const mk=u8[off+1];
      if(mk===0xFF){ off++; continue; }
      if(mk===0xD8||mk===0x01||(mk>=0xD0&&mk<=0xD7)){ off+=2; continue; }
      if(mk===0xD9||mk===0xDA) break;
      const len=dv.getUint16(off+2);
      if(len<2) break;
      if(mk===0xE1&&off+10<=u8.length&&u8[off+4]===0x45&&u8[off+5]===0x78&&u8[off+6]===0x69&&u8[off+7]===0x66){
        const t=off+10;
        if(t+8<=u8.length){
          const le=u8[t]===0x49&&u8[t+1]===0x49;
          const g16=p=>dv.getUint16(p,le), g32=p=>dv.getUint32(p,le);
          if(g16(t+2)===42){
            const ifd=t+g32(t+4);
            if(ifd+2<=u8.length){
              const cnt=g16(ifd);
              for(let i=0;i<cnt;i++){
                const e=ifd+2+i*12; if(e+12>u8.length) break;
                if(g16(e)===0x0112){ const v=g16(e+8); if(v>=1&&v<=8) orientation=v; break; }
              }
            }
          }
        }
      }
      if((mk>=0xC0&&mk<=0xC3)||(mk>=0xC5&&mk<=0xC7)||(mk>=0xC9&&mk<=0xCB)||(mk>=0xCD&&mk<=0xCF)){
        if(off+9<=u8.length){ height=dv.getUint16(off+5); width=dv.getUint16(off+7); }
        break;
      }
      off+=2+len;
    }
    return {orientation,width,height};
  }
  // Canvas transform that draws a (dw x dh) image with EXIF orientation 5-8 applied. Pure.
  function orientMatrix(o,dw,dh){
    if(o===6) return [0,1,-1,0,dh,0];
    if(o===8) return [0,-1,1,0,0,dw];
    if(o===5) return [0,1,1,0,0,0];
    if(o===7) return [0,-1,-1,0,dh,dw];
    return [1,0,0,1,0,0];
  }
  // Decide whether the browser already applied a 90-degree EXIF rotation (it swaps width/height). Pure.
  function manualOrientation(info,decW,decH){
    if(!info||info.orientation<5||info.orientation>8||!info.width||!info.height||info.width===info.height) return 1;
    return (decW===info.width&&decH===info.height)?info.orientation:1;
  }
  // Target size: long side about 2400px and at most 4.2MP; small photos are enlarged a little (max 1.6x). Pure.
  function ocrScale(w,h){
    let s=Math.min(2400/Math.max(w,h),Math.sqrt(4200000/Math.max(1,w*h)));
    if(s>1) s=Math.min(s,1.6);
    return s;
  }
  function gridFilter(src,gw,gh,op){
    const out=new Float32Array(src.length);
    for(let y=0;y<gh;y++) for(let x=0;x<gw;x++){
      let acc=op==='max'?0:0, n=0;
      for(let dy=-1;dy<=1;dy++){ const yy=y+dy; if(yy<0||yy>=gh) continue;
        for(let dx=-1;dx<=1;dx++){ const xx=x+dx; if(xx<0||xx>=gw) continue;
          const v=src[yy*gw+xx]; if(op==='max'){ if(v>acc) acc=v; } else { acc+=v; n++; } } }
      out[y*gw+x]=op==='max'?acc:acc/Math.max(1,n);
    }
    return out;
  }
  // Grayscale + optional illumination correction (divide by a smooth paper-brightness estimate, gain capped)
  // + percentile contrast stretch + optional weak sharpening. No hard binarization. Works in place on RGBA. Pure.
  function enhanceGray(d,w,h,opt){
    const o=opt||{}, mode=o.mode||'illum', n=w*h;
    let g=new Uint8ClampedArray(n);
    for(let i=0,j=0;i<n;i++,j+=4) g[i]=(d[j]*77+d[j+1]*150+d[j+2]*29)>>8;
    if(mode==='illum'||mode==='illum-sharp'){
      const cell=Math.max(16,Math.round(Math.min(w,h)/24)), gw=Math.ceil(w/cell), gh=Math.ceil(h/cell);
      const bg=new Float32Array(gw*gh), hist=new Uint32Array(256);
      for(let gy=0;gy<gh;gy++) for(let gx=0;gx<gw;gx++){
        hist.fill(0); let cnt=0;
        const x0=gx*cell, y0=gy*cell, x1=Math.min(w,x0+cell), y1=Math.min(h,y0+cell);
        for(let y=y0;y<y1;y+=2){ for(let x=x0,p=y*w+x0;x<x1;x+=2,p+=2){ hist[g[p]]++; cnt++; } }
        const target=cnt*0.9; let acc=0, v=0;
        for(;v<255;v++){ acc+=hist[v]; if(acc>=target) break; }
        bg[gy*gw+gx]=v;
      }
      const bgs=gridFilter(gridFilter(bg,gw,gh,'max'),gw,gh,'mean');
      const cap=o.gainCap||4;
      const xi0=new Int32Array(w), xi1=new Int32Array(w), xt=new Float32Array(w);
      for(let x=0;x<w;x++){ const fx=Math.min(gw-1,Math.max(0,(x+0.5)/cell-0.5)); xi0[x]=Math.floor(fx); xi1[x]=Math.min(gw-1,xi0[x]+1); xt[x]=fx-xi0[x]; }
      const out=new Uint8ClampedArray(n);
      for(let y=0;y<h;y++){
        const fy=Math.min(gh-1,Math.max(0,(y+0.5)/cell-0.5)), y0=Math.floor(fy), y1=Math.min(gh-1,y0+1), ty=fy-y0, r0=y0*gw, r1=y1*gw, row=y*w;
        for(let x=0;x<w;x++){
          const a=xi0[x], b=xi1[x], t=xt[x];
          const bgv=(bgs[r0+a]*(1-t)+bgs[r0+b]*t)*(1-ty)+(bgs[r1+a]*(1-t)+bgs[r1+b]*t)*ty;
          out[row+x]=g[row+x]*Math.min(cap,255/Math.max(1,bgv));
        }
      }
      g=out;
    }
    // percentile stretch (1% -> 0, 95% -> 255); skipped for nearly flat images
    const hist=new Uint32Array(256); for(let i=0;i<n;i++) hist[g[i]]++;
    const pct=q=>{ const t=n*q; let acc=0; for(let v=0;v<256;v++){ acc+=hist[v]; if(acc>=t) return v; } return 255; };
    const lo=pct(0.01), hi=pct(0.95);
    if(hi-lo>=24){ const k=255/(hi-lo); for(let i=0;i<n;i++) g[i]=(g[i]-lo)*k; }
    if(mode==='illum-sharp'){
      const s=new Uint8ClampedArray(n), amt=o.sharpen||0.5;
      for(let y=0;y<h;y++) for(let x=0;x<w;x++){
        const i=y*w+x;
        if(x===0||y===0||x===w-1||y===h-1){ s[i]=g[i]; continue; }
        const m=(g[i-w-1]+g[i-w]+g[i-w+1]+g[i-1]+g[i]+g[i+1]+g[i+w-1]+g[i+w]+g[i+w+1])/9;
        s[i]=g[i]+amt*(g[i]-m);
      }
      g=s;
    }
    for(let i=0,j=0;i<n;i++,j+=4){ const v=g[i]; d[j]=v; d[j+1]=v; d[j+2]=v; d[j+3]=255; }
    return d;
  }
  function readBlobHead(blob,n){
    return new Promise((resolve,reject)=>{ const r=new FileReader(); r.onload=()=>resolve(new Uint8Array(r.result)); r.onerror=()=>reject(r.error); r.readAsArrayBuffer(blob.slice(0,n)); });
  }
  function ocrError(code,cause){ const e=new Error(code); e.code=code; if(cause) e.cause=cause; return e; }
  // createImageBitmap first (iOS 15+), <img> fallback for older iOS. Returns {src,w,h,close}.
  async function decodeImage(file,o){
    const opt=o||{};
    if(window.createImageBitmap&&!opt.forceImg){
      try{
        const bmp=opt.noOrientation?await createImageBitmap(file,{imageOrientation:'none'}):await createImageBitmap(file);
        return {src:bmp,w:bmp.width,h:bmp.height,close:()=>{ try{ bmp.close&&bmp.close(); }catch(_){ } }};
      }catch(_){ /* fall back to <img> */ }
    }
    const url=URL.createObjectURL(file);
    try{
      const img=await new Promise((resolve,reject)=>{ const im=new Image(); im.onload=()=>resolve(im); im.onerror=()=>reject(new Error('decode')); im.src=url; });
      return {src:img,w:img.naturalWidth,h:img.naturalHeight,close:()=>{ try{ URL.revokeObjectURL(url); img.removeAttribute('src'); }catch(_){ } }};
    }catch(e){ try{ URL.revokeObjectURL(url); }catch(_){ } throw e; }
  }
  function releaseCanvas(c){ if(c){ try{ c.width=0; c.height=0; }catch(_){ } } }
  function canvasToBlob(c){ return new Promise((resolve,reject)=>{ try{ c.toBlob(b=>b?resolve(b):reject(new Error('toBlob')),'image/png'); }catch(e){ reject(e); } }); }
  // Pure: left/right range of the receipt paper on a small gray image. Only plain background at the sides
  // (columns with almost no bright pixels) is cut; null when there is nothing clear to cut.
  function paperColumnRange(g,w,h){
    const n=w*h, hist=new Uint32Array(256); for(let i=0;i<n;i++) hist[g[i]]++;
    let sum=0; for(let v=0;v<256;v++) sum+=v*hist[v];
    let sumB=0, wB=0, best=-1, t=128;
    for(let v=0;v<256;v++){ wB+=hist[v]; if(!wB) continue; const wF=n-wB; if(!wF) break; sumB+=v*hist[v]; const mB=sumB/wB, mF=(sum-sumB)/wF, bt=wB*wF*(mB-mF)*(mB-mF); if(bt>best){ best=bt; t=v; } }
    const col=new Float32Array(w);
    for(let x=0;x<w;x++){ let c=0; for(let y=0,p=x;y<h;y++,p+=w) if(g[p]>t) c++; col[x]=c/h; }
    let a=0; while(a<w&&col[a]<0.15) a++;
    let b=w-1; while(b>a&&col[b]<0.15) b--;
    const keep=b-a+1; if(keep<0.25*w||keep>0.9*w) return null;
    let mean=0; for(let x=a;x<=b;x++) mean+=col[x]; if(mean/keep<0.45) return null;
    const m=Math.round(0.04*keep)+2;
    return {x0:Math.max(0,a-m),x1:Math.min(w,b+1+m)};
  }
  // Receipt width about 1100px after cropping (text about 30px high), at most 2x enlargement and 6MP. Pure.
  function cropScale(w,h){ return Math.min(1100/w,2,Math.sqrt(6000000/Math.max(1,w*h))); }
  function paperColumns(dec){
    try{
      const k=Math.min(1,400/Math.max(dec.w,dec.h)), w=Math.max(1,Math.round(dec.w*k)), h=Math.max(1,Math.round(dec.h*k));
      const c=document.createElement('canvas'); c.width=w; c.height=h; const x=c.getContext('2d',{willReadFrequently:true}); if(!x) return null;
      x.drawImage(dec.src,0,0,w,h); const d=x.getImageData(0,0,w,h).data; releaseCanvas(c);
      const g=new Uint8Array(w*h); for(let i=0,j=0;i<g.length;i++,j+=4) g[i]=(d[j]*77+d[j+1]*150+d[j+2]*29)>>8;
      const r=paperColumnRange(g,w,h); if(!r) return null;
      const sx=Math.max(0,Math.floor(r.x0/k)), ex=Math.min(dec.w,Math.ceil(r.x1/k)); return ex-sx>16?{x:sx,w:ex-sx}:null;
    }catch(_){ return null; }
  }
  const PRE_MODE='gray';
  // Photo -> canvas ready for OCR. The photo is only held in memory while this runs.
  async function preprocess(file,opts){
    const o=opts||{};
    let dec=null, c=null;
    try{
      let info=null;
      if(/jpe?g/i.test(file.type||'')||/\.jpe?g$/i.test(file.name||'')){ try{ info=readJpegInfo(await readBlobHead(file,262144)); }catch(_){ info=null; } }
      try{ dec=await decodeImage(file,o); }catch(e){ throw ocrError('image',e); }
      if(!dec||!dec.w||!dec.h) throw ocrError('image');
      const orient=manualOrientation(info,dec.w,dec.h), swap=orient>=5;
      const mode=o.mode||PRE_MODE;
      // v1.4: cut the background at the sides of the receipt, then size the paper for OCR
      const crop=(orient===1&&!o.noCrop)?paperColumns(dec):null, sx=crop?crop.x:0, sw=crop?crop.w:dec.w;
      const s=crop?cropScale(sw,dec.h):ocrScale(dec.w,dec.h);
      const dw=Math.max(1,Math.round(sw*s)), dh=Math.max(1,Math.round(dec.h*s));
      c=document.createElement('canvas'); c.width=swap?dh:dw; c.height=swap?dw:dh;
      const x=c.getContext('2d',{willReadFrequently:true});
      if(!x) throw ocrError('image');
      if(orient!==1){ const m=orientMatrix(orient,dw,dh); x.setTransform(m[0],m[1],m[2],m[3],m[4],m[5]); }
      x.imageSmoothingEnabled=true; if('imageSmoothingQuality' in x) x.imageSmoothingQuality='high';
      if(crop) x.drawImage(dec.src,sx,0,sw,dec.h,0,0,dw,dh); else x.drawImage(dec.src,0,0,dw,dh);
      x.setTransform(1,0,0,1,0,0);
      dec.close(); dec=null;
      const data=x.getImageData(0,0,c.width,c.height), d=data.data;
      enhanceGray(d,c.width,c.height,{mode});
      x.putImageData(data,0,0);
      return c;
    }catch(e){ releaseCanvas(c); throw e&&e.code?e:ocrError('image',e); }
    finally{ if(dec) dec.close(); }
  }
/* PREPROCESS-END */
/* PADDLE-START */
  // v1.4: PaddleOCR (PP-OCRv5 mobile text detection + recognition, Apache-2.0) through ONNX Runtime Web (MIT).
  // Runs on the device. The engine files (about 33MB) are downloaded once from jsDelivr, checked against fixed
  // SHA-384 hashes, and kept by the service worker. If the engine cannot start, the app falls back to Tesseract.
  const PADDLE={
    ort:'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/',
    ortSri:'sha384-epp8GDQUoLKx5qHa6SoDHKv7fSHILsEYk4uEsHdPRBztXEIVWCe/lhhrQJUBMZcf',
    files:[
      {key:'det',url:'https://cdn.jsdelivr.net/npm/pdfmarkdown-ppocrv5-models@1.0.0/detection/PP-OCRv5_mobile_det_infer.ort',size:4896928,sri:'sha384-plclZzfzgeYxAEuwMgxKV9MaBZ6pKGrXwU07VFdM7WoTB7iWggomNK7XvOTe+6Do'},
      {key:'dict',url:'https://cdn.jsdelivr.net/npm/pdfmarkdown-ppocrv5-models@1.0.0/recognition/ppocrv5_dict.txt',size:74014,sri:'sha384-OXx4+NS3wDVIc6CemgiwYnPkA9jHxS6fHwNdye6bG5QjPrRmLv9syy7RF6BDeJLN'},
      {key:'wasm',url:'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.wasm',size:11210254,sri:'sha384-Eu/XUdOA62yl+TueG792KtrQlAGAMW3g10sY4G3LBYyYZUtM126Z4Gr3ljTlXUGG'},
      {key:'rec',url:'https://cdn.jsdelivr.net/npm/pdfmarkdown-ppocrv5-models@1.0.0/recognition/PP-OCRv5_mobile_rec_infer.onnx',size:16559278,sri:'sha384-Qb0qkBLrDYPysE8fURNPM7nphf0DLBe+h+40V/p4WAYViX62XUZ5HW9TzkcXkSdB'}
    ]
  };
  let paddleEngine=null, paddleLoading=null;
  let ocrDiag=[];   // per-page reading details for the 診断情報 panel (cleared for every reading)
  function loadScriptOnce(src,integrity){
    return new Promise((resolve,reject)=>{ const s=document.createElement('script'); s.src=src; if(integrity){ s.integrity=integrity; s.crossOrigin='anonymous'; } s.onload=()=>resolve(); s.onerror=()=>reject(ocrError('lib')); document.head.appendChild(s); });
  }
  async function sha384b64(bytes){ const d=new Uint8Array(await crypto.subtle.digest('SHA-384',bytes)); let s=''; for(let i=0;i<d.length;i++) s+=String.fromCharCode(d[i]); return 'sha384-'+btoa(s); }
  async function fetchBytes(f,onBytes){
    let res; try{ res=await fetch(f.url,{mode:'cors',credentials:'omit'}); }catch(e){ throw ocrError('init',e); }
    if(!res.ok) throw ocrError('init');
    if(!res.body||!res.body.getReader){ const b=new Uint8Array(await res.arrayBuffer()); onBytes(b.length); return b; }
    const reader=res.body.getReader(), chunks=[]; let n=0;
    for(;;){ const r=await reader.read(); if(r.done) break; chunks.push(r.value); n+=r.value.length; onBytes(r.value.length); }
    const out=new Uint8Array(n); let o=0; for(const c of chunks){ out.set(c,o); o+=c.length; } return out;
  }
  function loadPaddle(onProgress){
    if(paddleEngine) return Promise.resolve(paddleEngine);
    if(paddleLoading) return paddleLoading;
    paddleLoading=(async()=>{
      if(typeof WebAssembly!=='object'||!window.crypto||!crypto.subtle) throw ocrError('engine');
      if(!window.ort) await loadScriptOnce(PADDLE.ort+'ort.wasm.min.js',PADDLE.ortSri);
      if(!window.ort||!window.ort.InferenceSession) throw ocrError('lib');
      const total=PADDLE.files.reduce((s,f)=>s+f.size,0), bytes={}; let got=0;
      for(const f of PADDLE.files){
        const b=await fetchBytes(f,n=>{ got+=n; if(onProgress) onProgress(Math.min(1,got/total)); });
        if((await sha384b64(b))!==f.sri) throw ocrError('integrity');
        bytes[f.key]=b;
      }
      const ort=window.ort; ort.env.wasm.numThreads=1; ort.env.wasm.wasmPaths=PADDLE.ort; ort.env.wasm.wasmBinary=bytes.wasm;
      const opt={executionProviders:['wasm'],graphOptimizationLevel:'all'};
      const det=await ort.InferenceSession.create(bytes.det,opt), rec=await ort.InferenceSession.create(bytes.rec,opt);
      const chars=new TextDecoder().decode(bytes.dict).split('\n'); chars[0]='';
      paddleEngine={det,rec,chars}; return paddleEngine;
    })();
    paddleLoading.catch(()=>{ paddleLoading=null; });
    return paddleLoading;
  }
  // Pure: smallest rotated rectangle around a set of points (convex hull + rotating calipers), long side first
  function minAreaRect(pts){
    pts.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]), lo=[], up=[];
    for(const q of pts){ while(lo.length>=2&&cross(lo[lo.length-2],lo[lo.length-1],q)<=0) lo.pop(); lo.push(q); }
    for(let k=pts.length-1;k>=0;k--){ const q=pts[k]; while(up.length>=2&&cross(up[up.length-2],up[up.length-1],q)<=0) up.pop(); up.push(q); }
    const hull=lo.slice(0,-1).concat(up.slice(0,-1)); let best=null;
    for(let k=0;k<hull.length;k++){
      const a=hull[k], b=hull[(k+1)%hull.length], ex=b[0]-a[0], ey=b[1]-a[1], len=Math.hypot(ex,ey); if(!len) continue;
      const ux=ex/len, uy=ey/len; let u0=Infinity, u1=-Infinity, v0=Infinity, v1=-Infinity;
      for(const q of hull){ const u=q[0]*ux+q[1]*uy, v=-q[0]*uy+q[1]*ux; if(u<u0) u0=u; if(u>u1) u1=u; if(v<v0) v0=v; if(v>v1) v1=v; }
      const area=(u1-u0)*(v1-v0); if(!best||area<best.area) best={area,ux,uy,u0,u1,v0,v1};
    }
    if(!best) return null;
    let {ux,uy}=best, w=best.u1-best.u0, h=best.v1-best.v0; const cu=(best.u0+best.u1)/2, cv=(best.v0+best.v1)/2, cx=cu*ux-cv*uy, cy=cu*uy+cv*ux;
    if(h>w){ const t=w; w=h; h=t; const nx=-uy, ny=ux; ux=nx; uy=ny; }
    let ang=Math.atan2(uy,ux); if(ang>Math.PI/2) ang-=Math.PI; if(ang<=-Math.PI/2) ang+=Math.PI;
    return {cx,cy,w,h,angle:ang};
  }
  // Pure: text boxes from the detection probability map (PaddleOCR DB post-processing): each connected region gets
  // its smallest rotated rectangle, enlarged by the same "unclip" ratio as PaddleOCR (1.5)
  function dbBoxes(prob,w,h,opt){
    const o=opt||{}, thr=o.thresh||0.3, boxThr=o.boxThresh||0.6, ratio=o.unclip||1.5;
    const n=w*h, seen=new Uint8Array(n), stack=new Int32Array(n), out=[];
    for(let s0=0;s0<n;s0++){
      if(seen[s0]||!(prob[s0]>thr)) continue;
      let top=0; stack[top++]=s0; seen[s0]=1;
      let cnt=0, sp=0, x0=w, x1=0, y0=h, y1=0; const rowMin=new Map(), rowMax=new Map();
      while(top){
        const p=stack[--top], x=p%w, y=(p-x)/w; cnt++; sp+=prob[p];
        if(x<x0) x0=x; if(x>x1) x1=x; if(y<y0) y0=y; if(y>y1) y1=y;
        const a=rowMin.get(y); if(a===undefined||x<a) rowMin.set(y,x); const b=rowMax.get(y); if(b===undefined||x>b) rowMax.set(y,x);
        if(x>0&&!seen[p-1]&&prob[p-1]>thr){ seen[p-1]=1; stack[top++]=p-1; }
        if(x<w-1&&!seen[p+1]&&prob[p+1]>thr){ seen[p+1]=1; stack[top++]=p+1; }
        if(y>0&&!seen[p-w]&&prob[p-w]>thr){ seen[p-w]=1; stack[top++]=p-w; }
        if(y<h-1&&!seen[p+w]&&prob[p+w]>thr){ seen[p+w]=1; stack[top++]=p+w; }
      }
      if(cnt<6||sp/cnt<boxThr) continue;
      const pts=[]; rowMin.forEach((mn,y)=>{ const mx=rowMax.get(y); pts.push([mn,y],[mn,y+1],[mx+1,y],[mx+1,y+1]); });
      let r=minAreaRect(pts);
      if(!r||Math.abs(r.angle)>0.5) r={cx:(x0+x1+1)/2,cy:(y0+y1+1)/2,w:x1-x0+1,h:y1-y0+1,angle:0};
      if(Math.min(r.w,r.h)<2) continue;
      const d=r.w*r.h*ratio/(2*(r.w+r.h)); out.push({cx:r.cx,cy:r.cy,w:r.w+2*d,h:r.h+2*d,th:r.h,angle:r.angle,score:sp/cnt});
    }
    return out;
  }
  // Pure: one text box -> normalized 3x48xW input for the recognizer (bilinear sampling along the box tilt)
  function cropLine(img,W,H,b,outH){
    const sc=outH/b.h, ow=Math.max(16,Math.min(2400,Math.round(b.w*sc)));
    const ux=Math.cos(b.angle), uy=Math.sin(b.angle), vx=-uy, vy=ux;
    const ox=b.cx-ux*b.w/2-vx*b.h/2, oy=b.cy-uy*b.w/2-vy*b.h/2, plane=outH*ow, t=new Float32Array(3*plane);
    for(let j=0;j<outH;j++){
      const fv=(j+0.5)/sc;
      for(let i=0;i<ow;i++){
        const fu=(i+0.5)/sc; let sx=ox+ux*fu+vx*fv-0.5, sy=oy+uy*fu+vy*fv-0.5;
        if(sx<0) sx=0; if(sy<0) sy=0; if(sx>W-1.001) sx=W-1.001; if(sy>H-1.001) sy=H-1.001;
        const xi=sx|0, yi=sy|0, ax=sx-xi, ay=sy-yi, p00=(yi*W+xi)*4, p01=p00+4, p10=p00+W*4, p11=p10+4, q=j*ow+i;
        for(let c=0;c<3;c++){
          const v=(img[p00+c]*(1-ax)+img[p01+c]*ax)*(1-ay)+(img[p10+c]*(1-ax)+img[p11+c]*ax)*ay;
          t[c*plane+q]=v/127.5-1;
        }
      }
    }
    return {data:t,width:ow};
  }
  // Pure: greedy CTC decoding of the recognizer output (T x C probabilities); index 0 is the blank
  function ctcDecode(data,T,C,chars){
    let last=-1, text='', ps=0, pn=0;
    for(let t=0;t<T;t++){
      const base=t*C; let bi=0, bv=-Infinity;
      for(let c=0;c<C;c++){ const v=data[base+c]; if(v>bv){ bv=v; bi=c; } }
      if(bi!==last&&bi!==0){ text+=chars[bi]||''; ps+=bv; pn++; }
      last=bi;
    }
    return {text,conf:pn?ps/pn:0};
  }
  // The receipt paper's area in a canvas: bright columns (paperColumnRange), then the bright rows inside them, widened by
  // a safety margin (cutting text off is worse than keeping some background). null when the paper is not clear.
  // Pure: paper area (in W x H coordinates) from a small RGBA picture w x h - Otsu threshold, rows that hold bright
  // colourless paper, then the columns that are mostly bright within those rows, widened by a safety margin
  function paperRange(d,w,h,W,H){
    const n=w*h, g=new Uint8Array(n), plain=new Uint8Array(n), hist=new Array(256).fill(0);
    for(let i=0,j=0;i<n;i++,j+=4){ const r=d[j], gg=d[j+1], b=d[j+2], mx=Math.max(r,gg,b), mn=Math.min(r,gg,b); g[i]=(r*77+gg*150+b*29)>>8; plain[i]=mx-mn<=mx*0.4?1:0; hist[g[i]]++; }
    let sum=0; for(let t=0;t<256;t++) sum+=t*hist[t];
    let sb=0, wb=0, best=0, thr=128; for(let t=0;t<256;t++){ wb+=hist[t]; if(!wb) continue; const wf=n-wb; if(!wf) break; sb+=t*hist[t]; const mb=sb/wb, mf=(sum-sb)/wf, v=wb*wf*(mb-mf)*(mb-mf); if(v>best){ best=v; thr=t; } }
    if(thr<70) return null;
    const lim=Math.max(95,thr*0.85), on=i=>g[i]>lim&&plain[i];
    let y0=-1, y1=-1; for(let y=0;y<h;y++){ let c=0; for(let x=0;x<w;x++) if(on(y*w+x)) c++; if(c>=w*0.08){ if(y0<0) y0=y; y1=y; } }
    if(y0<0) return null;
    let x0=-1, x1=-1; const span=y1-y0+1; for(let x=0;x<w;x++){ let b=0; for(let y=y0;y<=y1;y++) if(on(y*w+x)) b++; if(b>=span*0.35){ if(x0<0) x0=x; x1=x; } }
    if(x0<0) return null;
    const cw=x1-x0+1; if(cw<w*0.08||span<h*0.12) return null;
    const k=W/w, mx=cw*0.06+3, my=span*0.05+3, ax=Math.max(0,x0-mx), ay=Math.max(0,y0-my), bx=Math.min(w,x1+1+mx), by=Math.min(h,y1+1+my);
    const area={x:Math.floor(ax*k),y:Math.floor(ay*k),w:Math.min(W,Math.ceil(bx*k))-Math.floor(ax*k),h:Math.min(H,Math.ceil(by*(H/h)))-Math.floor(ay*k)};
    return area.w*area.h<=W*H*0.85&&area.w>16&&area.h>16?area:null;
  }
  // the receipt area from the original photo, as large as the memory limits allow (up to 2400px / 4.2MP, never enlarged)
  async function paperFromOriginal(file,area,s){
    let dec=null;
    try{
      dec=await decodeImage(file); const sx=area.x/s, sy=area.y/s, sw=Math.min(dec.w-sx,area.w/s), sh=Math.min(dec.h-sy,area.h/s);
      if(!(sw>16&&sh>16)) return null;
      const k=Math.min(1,2400/Math.max(sw,sh),Math.sqrt(4.2e6/(sw*sh))), cw=Math.max(16,Math.round(sw*k)), ch=Math.max(16,Math.round(sh*k));
      const c=document.createElement('canvas'); c.width=cw; c.height=ch; const x=c.getContext('2d'); x.imageSmoothingEnabled=true; if('imageSmoothingQuality' in x) x.imageSmoothingQuality='high';
      x.drawImage(dec.src,sx,sy,sw,sh,0,0,cw,ch); return c;
    }catch(_){ return null; }
    finally{ if(dec) dec.close(); }
  }
  // How a reading stands, from its content: parsed items, a total printed on the receipt, whether the items add up to it,
  // average confidence and amount of text. A short receipt that adds up (コーヒー 150 / 合計 150) is a good reading.
  function assessReading(items){
    const t=items.filter(x=>x&&x.text&&String(x.text).trim()&&x.conf>=0.3), avg=t.length?t.reduce((a,x)=>a+x.conf,0)/t.length:0, chars=t.reduce((a,x)=>a+String(x.text).trim().length,0);
    let m=null; try{ m=mergeReceiptPages([parseReceipt(assembleRows(items))]); }catch(_){ m=null; }
    const n=m?m.items.length:0, sum=m?m.items.reduce((a,x)=>a+(Number(x.amount)||0),0):0, total=m?Number(m.total)||0:0, src=m?m.totalSource:'';
    const hasTotal=!!m&&total>0&&!!src&&src!=='items', lv=m&&n?sumCheckInfo(sum,total,m.meta,src).level:'none', consistent=n>0&&hasTotal&&(lv==='ok'||lv==='explained');
    // difference shown in 診断情報: none when the reading adds up; an unknown tax line counts when it closes the gap
    const expect=m?sum+((m.meta&&m.meta.exTax)||0)-((m.meta&&m.meta.receiptDiscount)||0):0, withTax=expect+((m&&m.meta&&m.meta.unknownTax)||0);
    const gap=consistent?0:hasTotal?Math.min(Math.abs(expect-total),Math.abs(withTax-total))/Math.max(1,total):1;
    const weak=!consistent&&(t.length<=2||n===0||(!hasTotal&&n<3)||(hasTotal&&gap>0.1)||avg<0.8||chars<12);   // a middle photo of a long receipt has no total
    return {m,weak,consistent,lines:t.length,items:n,hasTotal,gap,avg,chars,summary:`${consistent?'整合':'不整合'}・行${t.length}・商品${n}・合計${hasTotal?'あり':'なし'}・差${Math.round(gap*100)}%・確からしさ${Math.round(avg*100)/100}`};
  }
  function readConsistent(items){ return assessReading(items).consistent; }
  // Score for choosing between two readings of the same receipt (higher is better). The total adding up dominates;
  // more lines alone do not win; impossible amounts and letters left in prices count against.
  function readQuality(items){
    const a=assessReading(items), m=a.m; if(!m) return 0;
    const total=Number(m.total)||0, odd=m.items.filter(x=>Number(x.amount)>Math.max(total*3,100000)).length;
    const letters=items.filter(x=>x&&x.text&&/^[¥￥]?[\d,.]*[A-Za-z][\d,.A-Za-z]*$/.test(String(x.text).replace(/\s/g,''))&&/\d/.test(x.text)).length;
    return (a.consistent?20:0)+(a.hasTotal?4:0)+(m.dateFound?2:0)+(m.store?1:0)+0.5*Math.min(a.items,20)+3*a.avg-3*odd-letters-(a.chars<12?5:0);
  }
  // paper area from pixels already in memory (sampled down to ~400px; no canvas is created)
  function paperRangeFromPixels(img,W,H){
    if(!img||!W||!H) return null;
    const k=Math.min(1,400/Math.max(W,H)), w=Math.max(1,Math.round(W*k)), h=Math.max(1,Math.round(H*k)), d=new Uint8ClampedArray(w*h*4);
    for(let y=0;y<h;y++){ const sy=Math.min(H-1,Math.floor(y/k)); for(let x=0;x<w;x++){ const sx=Math.min(W-1,Math.floor(x/k)), si=(sy*W+sx)*4, di=(y*w+x)*4; d[di]=img[si]; d[di+1]=img[si+1]; d[di+2]=img[si+2]; d[di+3]=255; } }
    return paperRange(d,w,h,W,H);
  }
  // a canvas of one area of the pixels in memory (used only when the photo's own orientation had to be applied by hand)
  function canvasFromPixels(img,W,H,a){
    const out=new ImageData(a.w,a.h); for(let y=0;y<a.h;y++){ const si=((a.y+y)*W+a.x)*4; out.data.set(img.subarray(si,si+a.w*4),y*a.w*4); }
    const c=document.createElement('canvas'); c.width=a.w; c.height=a.h; c.getContext('2d').putImageData(out,0,0); return c;
  }
  // Pure: the boxes that form the price column - short boxes at the right edge of the receipt text
  function priceColumn(items){
    const its=items.filter(t=>t&&t.text&&String(t.text).trim()); const out=new Set(); if(its.length<3) return out;
    const x0=Math.min(...its.map(t=>t.cx-t.w/2)), x1=Math.max(...its.map(t=>t.cx+t.w/2)), span=Math.max(1,x1-x0);
    items.forEach((t,i)=>{ if(t&&t.text&&String(t.text).trim()&&t.cx+t.w/2>=x1-span*0.22&&t.cx>x0+span*0.62&&t.w<span*0.45) out.add(i); });
    return out;
  }
  // Pure: a price-column reading with letters that OCR mixes up with digits (1,5O9 -> 1,509, 25B -> 258).
  // Only for text that is already mostly a price; a capital letter after 3+ digits is kept as a tax mark (278J).
  const PRICE_LOOK={O:'0',o:'0',D:'0',Q:'0','〇':'0',I:'1',l:'1','|':'1','!':'1',i:'1',Z:'2',z:'2',S:'5',s:'5',B:'8',b:'6',G:'6',g:'9',q:'9'};
  const RE_PRICE=/^[¥￥\\]?\(?-?\d[\d,.]*\)?(?:軽|※|[*＊]|外|内|非|[A-Z])?$/;
  function fixPriceText(t){
    const core=String(t||'').replace(/\s+/g,''); if(!core||core.length>12) return null;
    const tail=core.match(/^(.*?)([A-Z])$/), markOk=!!tail&&/\d{3,}$/.test(tail[1].replace(/[,.]/g,''));
    if(RE_PRICE.test(core)&&(!tail||markOk)) return null;
    const good=(core.match(/[0-9¥￥\\,.]/g)||[]).length; if(good<Math.ceil(core.length*0.6)||!/\d/.test(core)) return null;
    let body=core, mark=''; const m=core.match(/^(.*\d{3,})([A-Z])$/); if(m){ body=m[1]; mark=m[2]; }
    const out=body.replace(/[OoDQ〇Il|!iZzSsBbGgq]/g,ch=>PRICE_LOOK[ch])+mark;
    return out!==core&&RE_PRICE.test(out)?out:null;
  }
  function priceLike(t){ const c=String(t||'').replace(/\s+/g,''); return RE_PRICE.test(c)||!!fixPriceText(c); }
  // Pure: rebuild the printed rows from recognized boxes. The page tilt is undone first; then prices at the right edge
  // are matched to their label rows using the typical vertical drop between a label and its price (photos taken at an
  // angle print the right column lower), so "合計 ... ¥1,509" stays on one row.
  function assembleRows(items,opt){
    const o=opt||{}, minConf=o.minConf==null?0.3:o.minConf, tol=o.tol||0.6;
    const its=items.filter(t=>t&&t.text&&String(t.text).trim()&&t.conf>=minConf);
    if(!its.length) return '';
    const angs=its.filter(t=>t.w>=t.h*2.5).map(t=>t.angle).sort((a,b)=>a-b), med=angs.length?angs[Math.floor(angs.length/2)]:0, phi=med, c=Math.cos(phi), s=Math.sin(phi);
    const pts=its.map(t=>({t,x:c*t.cx+s*t.cy,y:-s*t.cx+c*t.cy,h:t.h}));
    const x0=Math.min(...pts.map(p=>p.x-p.t.w/2)), x1=Math.max(...pts.map(p=>p.x+p.t.w/2)), span=Math.max(1,x1-x0);
    // a price sits at the right edge of the receipt ("8%" in the middle of a row is not one)
    const isAmt=p=>(RE_PRICE.test(String(p.t.text).replace(/\s/g,''))||/^\d{1,3}点$/.test(String(p.t.text).replace(/\s/g,'')))&&p.x>x0+span*0.62&&p.x+p.t.w/2>=x1-span*0.22;
    const left=pts.filter(p=>!isAmt(p)).sort((a,b)=>a.y-b.y), right=pts.filter(isAmt), rows=[];
    for(const p of left){
      const r=rows.length?rows[rows.length-1]:null;
      if(r&&Math.abs(p.y-r.y)<=Math.max(r.h,p.h)*tol){ r.items.push(p); r.y=r.items.reduce((a,q)=>a+q.y,0)/r.items.length; if(p.h>r.h) r.h=p.h; }
      else rows.push({y:p.y,h:p.h,items:[p]});
    }
    // prices belong to label rows, which start on the left (centred headings such as 領収証 do not take prices)
    const labelRows=rows.filter(r=>Math.min(...r.items.map(q=>q.x))<=x0+span*0.42);
    // Match prices (top to bottom) to label rows in order, one price per row. The gap between a price and its label may
    // grow or shrink slowly down the page (tilt, curled paper) but should not jump; a price that fits nowhere keeps its own row.
    const hm=(()=>{ const hs=labelRows.map(r=>r.h).sort((a,b)=>a-b); return hs.length?hs[Math.floor(hs.length/2)]:30; })();
    const A=right.slice().sort((a,b)=>a.y-b.y), Rw=labelRows.slice().sort((a,b)=>a.y-b.y), n=A.length, m=Rw.length, SKIP=1.5, PRIOR=0.3, SMOOTH=1.0;
    const res=(i,j)=>A[i].y-Rw[j].y, ok=(i,j)=>Math.abs(res(i,j))<=hm*2.5;
    const cost=[], from=[];
    for(let i=0;i<n;i++){ cost.push(new Array(m).fill(Infinity)); from.push(new Array(m).fill(null)); }
    for(let i=0;i<n;i++) for(let j=0;j<m;j++){
      if(!ok(i,j)) continue;
      const base=PRIOR*Math.abs(res(i,j))/hm; let best=i*SKIP, arg=null;
      for(let k=0;k<i;k++) for(let jj=0;jj<j;jj++){ if(cost[k][jj]===Infinity) continue; const c=cost[k][jj]+(i-k-1)*SKIP+SMOOTH*Math.abs(res(i,j)-res(k,jj))/hm; if(c<best){ best=c; arg=[k,jj]; } }
      cost[i][j]=best+base; from[i][j]=arg;
    }
    let bestEnd=n*SKIP, end=null;
    for(let i=0;i<n;i++) for(let j=0;j<m;j++){ if(cost[i][j]===Infinity) continue; const c=cost[i][j]+(n-i-1)*SKIP; if(c<bestEnd){ bestEnd=c; end=[i,j]; } }
    const assigned=new Array(n).fill(-1);
    for(let cur=end;cur;cur=from[cur[0]][cur[1]]) assigned[cur[0]]=cur[1];
    A.forEach((a,i)=>{ if(assigned[i]>=0) Rw[assigned[i]].items.push(a); else rows.push({y:a.y,h:a.h,items:[a]}); });
    rows.sort((a,b)=>a.y-b.y);
    return rows.map(r=>r.items.sort((a,b)=>a.x-b.x).map(q=>String(q.t.text).trim()).join(' ')).join('\n');
  }
  // detection on a canvas -> boxes in canvas coordinates plus the RGBA pixels used for the line crops
  async function paddleDetect(engine,canvas){
    const ort=window.ort, W=canvas.width, H=canvas.height, img=canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,W,H).data;
    const r=Math.min(1,960/Math.max(W,H)), tw=Math.max(32,Math.round(W*r/32)*32), th=Math.max(32,Math.round(H*r/32)*32);
    let detc=document.createElement('canvas'); detc.width=tw; detc.height=th; const dx=detc.getContext('2d',{willReadFrequently:true});
    dx.imageSmoothingEnabled=true; if('imageSmoothingQuality' in dx) dx.imageSmoothingQuality='high'; dx.drawImage(canvas,0,0,tw,th);
    const dd=dx.getImageData(0,0,tw,th).data; releaseCanvas(detc); detc=null;
    const plane=tw*th, x=new Float32Array(3*plane), mean=[0.485,0.456,0.406], std=[0.229,0.224,0.225];
    for(let i=0,j=0;i<plane;i++,j+=4){ for(let c=0;c<3;c++) x[c*plane+i]=(dd[j+c]/255-mean[c])/std[c]; }
    await new Promise(res=>setTimeout(res,0));
    const dout=await engine.det.run({[engine.det.inputNames[0]]:new ort.Tensor('float32',x,[1,3,th,tw])});
    const dt=dout[engine.det.outputNames[0]], prob=dt.data, kx=W/tw, ky=H/th;
    const boxes0=dbBoxes(prob,tw,th); try{ if(dt.dispose) dt.dispose(); }catch(_){ }
    const boxes=boxes0.map(b=>({cx:b.cx*kx,cy:b.cy*ky,w:b.w*(b.angle?(kx+ky)/2:kx),h:b.h*(b.angle?(kx+ky)/2:ky),th:b.th*ky,angle:b.angle,score:b.score})).sort((a,b)=>a.cy-b.cy);
    return {img,W,H,boxes,scale:r};
  }
  async function recBox(engine,d,b){
    const ort=window.ort, crop=cropLine(d.img,d.W,d.H,b,48);
    const o=(await engine.rec.run({[engine.rec.inputNames[0]]:new ort.Tensor('float32',crop.data,[1,3,48,crop.width])}))[engine.rec.outputNames[0]];
    const res=ctcDecode(o.data,o.dims[1],o.dims[2],engine.chars); try{ if(o.dispose) o.dispose(); }catch(_){ }
    return res;
  }
  // Which way is up? Text lines standing upright mean the photo is sideways; a few test reads in both directions decide.
  // Returns the clockwise turn (0 / 90 / 180 / 270) that makes the text upright.
  async function pageTurn(engine,d){
    const tall=d.boxes.filter(b=>b.h>b.w*1.6&&b.h>40), wide=d.boxes.filter(b=>b.w>b.h*1.6&&b.w>40);
    if(tall.length>=3&&tall.length>wide.length*1.5){
      let down=0, up=0;
      for(const b of tall.slice().sort((a,c)=>c.h-a.h).slice(0,4)){ const r={cx:b.cx,cy:b.cy,w:b.h,h:b.w}; down+=(await recBox(engine,d,Object.assign({},r,{angle:Math.PI/2}))).conf; up+=(await recBox(engine,d,Object.assign({},r,{angle:-Math.PI/2}))).conf; }
      return down>=up?270:90;
    }
    const s=wide.slice().sort((a,c)=>c.w-a.w).slice(0,4); if(!s.length) return 0;
    let c0=0; for(const b of s) c0+=(await recBox(engine,d,b)).conf; c0/=s.length;
    if(c0>=0.75) return 0;
    let c180=0; for(const b of s) c180+=(await recBox(engine,d,Object.assign({},b,{angle:b.angle+Math.PI}))).conf; c180/=s.length;
    return c180>c0+0.1?180:0;
  }
  function rotateCanvas(src,turn){
    const c=document.createElement('canvas'), side=turn%180!==0; c.width=side?src.height:src.width; c.height=side?src.width:src.height;
    const x=c.getContext('2d'); x.translate(c.width/2,c.height/2); x.rotate(turn*Math.PI/180); x.drawImage(src,-src.width/2,-src.height/2); return c;
  }
  // photo -> text rows with PaddleOCR. onStep(kind, k, n) reports progress; isCancelled() stops between lines.
  async function paddleRecognize(engine,file,onStep,isCancelled,debug){
    let dec=null, work=null;
    try{
      let info=null;
      if(/jpe?g/i.test(file.type||'')||/\.jpe?g$/i.test(file.name||'')){ try{ info=readJpegInfo(await readBlobHead(file,262144)); }catch(_){ info=null; } }
      try{ dec=await decodeImage(file); }catch(e){ throw ocrError('image',e); }
      if(!dec||!dec.w||!dec.h) throw ocrError('image');
      const dec0w=dec.w, dec0h=dec.h;
      const orient=manualOrientation(info,dec.w,dec.h), swap=orient>=5, s=ocrScale(dec.w,dec.h);
      const dw=Math.max(1,Math.round(dec.w*s)), dh=Math.max(1,Math.round(dec.h*s));
      work=document.createElement('canvas'); work.width=swap?dh:dw; work.height=swap?dw:dh;
      const wx=work.getContext('2d',{willReadFrequently:true}); if(!wx) throw ocrError('image');
      if(orient!==1){ const m=orientMatrix(orient,dw,dh); wx.setTransform(m[0],m[1],m[2],m[3],m[4],m[5]); }
      wx.imageSmoothingEnabled=true; if('imageSmoothingQuality' in wx) wx.imageSmoothingQuality='high';
      wx.drawImage(dec.src,0,0,dw,dh); wx.setTransform(1,0,0,1,0,0); dec.close(); dec=null;
      if(onStep) onStep('det',0,1);
      const t0=performance.now(), diag={size:{photo:[dec0w,dec0h],work:[work.width,work.height]}};
      let d0=await paddleDetect(engine,work);
      diag.firstLines=d0.boxes.length;
      // one picture -> recognized boxes (page direction, small-print re-detection, reading, price column repair)
      const readCanvas=async(cv,dd)=>{
        let work=cv, d=dd;
        const turn=await pageTurn(engine,d);
        if(turn){ const rc=rotateCanvas(work,turn); releaseCanvas(work); work=rc; d=await paddleDetect(engine,work); }
        diag.turn=turn; diag.det=[Math.round(d.W*d.scale),Math.round(d.H*d.scale)];
        // small print (a long receipt taken whole, or far away): detect again on the text area only, so the lines are
        // found at a larger size. Used only when it finds at least as many lines; the lines are still read from the full picture.
        const hs=d.boxes.map(b=>b.th||b.h).sort((a,b)=>a-b), medH=hs.length?hs[Math.floor(hs.length/2)]:0;
        diag.textPx=Math.round(medH*d.scale*10)/10;
        if(d.boxes.length>=3&&medH*d.scale<9){
          let bx0=Infinity, by0=Infinity, bx1=-Infinity, by1=-Infinity;
          for(const b of d.boxes){ const ex=b.w/2+Math.abs(Math.sin(b.angle||0))*b.h/2, ey=b.h/2+Math.abs(Math.sin(b.angle||0))*b.w/2; bx0=Math.min(bx0,b.cx-ex); bx1=Math.max(bx1,b.cx+ex); by0=Math.min(by0,b.cy-ey); by1=Math.max(by1,b.cy+ey); }
          const mx=(bx1-bx0)*0.04+8, my=(by1-by0)*0.03+8; bx0=Math.max(0,Math.floor(bx0-mx)); by0=Math.max(0,Math.floor(by0-my)); bx1=Math.min(d.W,Math.ceil(bx1+mx)); by1=Math.min(d.H,Math.ceil(by1+my));
          const cw=bx1-bx0, ch=by1-by0;
          if(cw>32&&ch>32&&(cw*ch<=d.W*d.H*0.7||ch/cw>1.6)){
            // a tall text area (long receipt) is cut into overlapping 3:4 tiles so each tile is detected at a useful size
            const tileH=ch/cw>1.6?Math.round(cw*1.33):ch, step=Math.max(1,Math.round(tileH*0.85)), found=[];
            for(let y=0;y<ch;y+=step){
              const th0=Math.min(tileH,ch-y); if(th0<32&&y>0) break;
              let cc=document.createElement('canvas'); cc.width=cw; cc.height=th0; cc.getContext('2d').drawImage(work,bx0,by0+y,cw,th0,0,0,cw,th0);
              const dt=await paddleDetect(engine,cc); releaseCanvas(cc); cc=null;
              for(const b of dt.boxes){ const nb=Object.assign({},b,{cx:b.cx+bx0,cy:b.cy+by0+y});
                // boxes seen twice in the overlap: keep the wider one
                const dup=found.findIndex(o=>Math.abs(o.cy-nb.cy)<Math.min(o.h,nb.h)*0.5&&Math.abs(o.cx-nb.cx)<Math.max(o.w,nb.w)*0.5);
                if(dup<0) found.push(nb); else if(nb.w>found[dup].w) found[dup]=nb; }
              if(y+tileH>=ch) break;
            }
            found.sort((a,b)=>a.cy-b.cy);
            if(found.length>=d.boxes.length*0.9){ d={img:d.img,W:d.W,H:d.H,scale:d.scale,boxes:found}; diag.redetect=[cw,ch,Math.ceil(ch/step)]; }
            else diag.redetect='kept first';
          }
        }
        releaseCanvas(work); work=null;
        const {boxes}=d; diag.lines=boxes.length; diag.msDet=Math.round(performance.now()-t0);
        const items=[];
        for(let k=0;k<boxes.length;k++){
          if(isCancelled&&isCancelled()) throw ocrError('cancel');
          if(onStep) onStep('rec',k,boxes.length);
          const b=boxes[k], res=await recBox(engine,d,b);
          items.push({cx:b.cx,cy:b.cy,w:b.w,h:b.th||b.h,boxH:b.h,angle:b.angle,text:res.text,conf:res.conf});
          if(k%3===2) await new Promise(rs=>setTimeout(rs,0));
        }
        // price column: unsure or non-price readings are read once more from a slightly wider (not taller) crop,
        // then letters that look like digits are repaired. Names are never touched.
        const col=priceColumn(items); diag.priceBoxes=col.size; diag.reread=[]; diag.priceFix=[];
        let rereads=0; const settled=readConsistent(items); diag.rereadSkipped=settled;
        for(const k of col){
          const it=items[k]; if(rereads>=8) break;
          if(settled||(it.conf>=0.75&&priceLike(it.text))) continue;
          rereads++; let best=null;
          for(const v of [{w:it.w*1.12},{h:it.boxH*0.9}]){
            const r=await recBox(engine,d,{cx:it.cx,cy:it.cy,w:v.w||it.w,h:v.h||it.boxH,angle:it.angle});
            if(priceLike(r.text)&&r.conf>(priceLike(it.text)?it.conf+0.05:0.3)&&(!best||r.conf>best.conf)) best=r;
          }
          if(best){ diag.reread.push(`${it.text}→${best.text}`); it.text=best.text; it.conf=best.conf; }
          diag.rereadTried=(diag.rereadTried||0)+1;
        }
        for(const k of col){ const it=items[k], f=fixPriceText(it.text); if(f){ diag.priceFix.push(`${it.text}→${f}`); it.text=f; } }
        return {items,W:d.W,H:d.H,turn,info:{turn,det:diag.det,textPx:diag.textPx,redetect:diag.redetect,lines:diag.lines,priceBoxes:diag.priceBoxes,reread:diag.reread,priceFix:diag.priceFix,rereadTried:diag.rereadTried||0,rereadSkipped:diag.rereadSkipped}};
      };
      const firstWork=work; work=null;
      const tr1=performance.now(); let res=await readCanvas(firstWork,d0); diag.msRead1=Math.round(performance.now()-tr1);
      // Judge the first reading by its content (items, total, consistency, confidence) - not by how many lines it has.
      // Only a weak reading looks for the paper (from the pixels already in memory) and reads that area again.
      const a1=assessReading(res.items); diag.first=a1.summary; diag.firstOk=!a1.weak;
      if(a1.weak){
        const tp=performance.now(), area=paperRangeFromPixels(d0.img,d0.W,d0.H); diag.msPaper=Math.round(performance.now()-tp);
        const smallPaper=!!area&&area.w*area.h<=d0.W*d0.H*0.6;
        if(area) diag.paper=[area.x,area.y,area.w,area.h];
        if(smallPaper){
          const tr=performance.now();
          let spare=orient===1?await paperFromOriginal(file,area,s):canvasFromPixels(d0.img,d0.W,d0.H,area);
          if(spare){
            diag.rescue=[spare.width,spare.height];
            const d2=await paddleDetect(engine,spare); diag.cropLines=d2.boxes.length;
            if(d2.boxes.length>=1){
              const res2=await readCanvas(spare,d2); spare=null;
              const q1=readQuality(res.items), q2=readQuality(res2.items); diag.cropQuality=[Math.round(q1*10)/10,Math.round(q2*10)/10];
              if(q2>q1){ res=res2; diag.crop='used'; } else diag.crop='kept';
            } else diag.crop='no lines';
            if(spare){ releaseCanvas(spare); spare=null; }
          }
          diag.msRescue=Math.round(performance.now()-tr);
        } else diag.crop=area?'paper fills the photo':'no paper';
      }
      d0=null;
      Object.assign(diag,res.info);
      const items=res.items, W=res.W, H=res.H, turn=res.turn;
      const confs=items.map(t=>t.conf).filter(c=>c>0); diag.avgConf=confs.length?Math.round(confs.reduce((a,c)=>a+c,0)/confs.length*100)/100:0;
      diag.lowConf=items.filter(t=>t.conf<0.6).length; diag.msTotal=Math.round(performance.now()-t0);
      ocrDiag.push(diag);
      return debug?{items,text:assembleRows(items),W,H,turn,diag}:assembleRows(items);
    }finally{ if(dec) dec.close(); releaseCanvas(work); }
  }
/* PADDLE-END */
/* LIVE-START */
  // v1.4: hold the receipt up to the camera. The app watches the camera picture and takes the photo by itself when a
  // white receipt fills the frame, is held still and is sharp; then the camera closes and the photo is read.
  // Mode 'add' takes the next part of a long receipt and reads it together with the photos already taken.
  // Nothing is recorded; the frames stay on the device.
  const LIVE={tick:220,stableTicks:4,motionMax:6,minPaper:0.15,closePaper:0.33,sharpMin:30};
  let live=null;
  function setLiveStatus(t,ready){ const s=$('#liveStatus'); if(s&&s.textContent!==t){ s.textContent=t; if(live) layoutLive(); } const b=$('#liveScan'); if(b) b.classList.toggle('ready',!!ready); }   // v1.10.5: a longer message moves the panel, so the guide is placed again
  function liveFrame(v,w){
    const h=Math.max(1,Math.round(w*v.videoHeight/v.videoWidth)), c=live.small||(live.small=document.createElement('canvas'));
    if(c.width!==w||c.height!==h){ c.width=w; c.height=h; }
    const x=c.getContext('2d',{willReadFrequently:true}); x.drawImage(v,0,0,w,h);
    const d=x.getImageData(0,0,w,h).data, g=new Uint8Array(w*h), white=new Uint8Array(w*h);
    for(let i=0,j=0;i<g.length;i++,j+=4){ const r=d[j], gg=d[j+1], b=d[j+2], mx=Math.max(r,gg,b), mn=Math.min(r,gg,b); g[i]=(r*299+gg*587+b*114)/1000|0; white[i]=mx-mn<=mx*0.4?1:0; }
    return {g,white,w,h};
  }
  // Pure: share of the picture width covered by receipt paper. A column counts as paper when at least a third of it
  // (within the rows that hold paper) is bright (text-dense parts of a receipt are greyer when scaled down) and nearly all of that bright part is
  // colourless (white or slightly warm paper counts, a blue or brown table does not).
  function paperShare(g,w,h,white){
    const hist=new Array(256).fill(0); for(let i=0;i<g.length;i++) hist[g[i]]++;
    const n=g.length; let sum=0; for(let t=0;t<256;t++) sum+=t*hist[t];
    let sb=0, wb=0, best=0, thr=128; for(let t=0;t<256;t++){ wb+=hist[t]; if(!wb) continue; const wf=n-wb; if(!wf) break; sb+=t*hist[t]; const mb=sb/wb, mf=(sum-sb)/wf, v=wb*wf*(mb-mf)*(mb-mf); if(v>best){ best=v; thr=t; } }
    if(thr<70) return 0;
    const lim=Math.max(95,thr*0.85);
    // rows that hold paper (so a small receipt far from the camera still counts, just with a small share)
    let y0=-1, y1=-1; for(let y=0;y<h;y++){ let c=0; for(let x=0;x<w;x++){ const i=y*w+x; if(g[i]>lim&&(!white||white[i])) c++; } if(c>=w*0.12){ if(y0<0) y0=y; y1=y; } }
    if(y0<0||y1-y0+1<h*0.15) return 0;
    const span=y1-y0+1; let cols=0;
    for(let x=0;x<w;x++){ let b=0, bw=0; for(let y=y0;y<=y1;y++){ const i=y*w+x; if(g[i]>lim){ b++; if(!white||white[i]) bw++; } } if(b>=span*0.35&&bw>=b*0.7) cols++; }
    return cols/w;
  }
  // Pure: sharpness = variance of the Laplacian (higher = crisper text)
  function sharpnessOf(g,w,h){ let s=0, s2=0, n=0; for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){ const i=y*w+x, l=4*g[i]-g[i-1]-g[i+1]-g[i-w]-g[i+w]; s+=l; s2+=l*l; n++; } if(!n) return 0; const m=s/n; return s2/n-m*m; }
  // Place the guide frame (3:4, receipt-shaped) in the free area between the buttons, in portrait and landscape
  function layoutLive(){
    const box=$('#liveScan'), g=$('#liveGuide'); if(!box||!g||box.classList.contains('hidden')) return;
    const W=box.clientWidth, H=box.clientHeight, land=W>H*1.05; box.classList.toggle('landscape',land);
    const b0=box.getBoundingClientRect(), close=$('#liveCloseBtn').getBoundingClientRect(), panel=box.querySelector('.live-bottom').getBoundingClientRect();
    let L=12, T=close.bottom-b0.top+10, R=W-12, B=panel.top-b0.top-10;
    // v1.10.4 landscape: the close button sits above the shutter on the right, and the guide takes the whole area left of them (no portrait 3:4 box)
    const cs=getComputedStyle(document.documentElement), sa=k=>parseFloat(cs.getPropertyValue(k))||0;
    if(land){ L=12+sa('--sal'); T=12+sa('--sat'); R=Math.min(panel.left,close.left)-b0.left-12; B=H-12-sa('--sab'); }
    const aw=Math.max(60,R-L), ah=Math.max(60,B-T); let gw, gh;
    if(land){ gw=aw; gh=ah; } else { gw=Math.min(aw,ah*0.75); gh=gw/0.75; if(gh>ah){ gh=ah; gw=gh*0.75; } }
    g.style.left=Math.round(L+(aw-gw)/2)+'px'; g.style.top=Math.round(T+(ah-gh)/2)+'px'; g.style.width=Math.round(gw)+'px'; g.style.height=Math.round(gh)+'px';
  }  // turning the phone (or the browser bar changing size) lays the camera screen out again
  if(!window.__liveLayoutBound){ window.__liveLayoutBound=true; const relayout=()=>requestAnimationFrame(()=>layoutLive()); window.addEventListener('resize',relayout); window.addEventListener('orientationchange',()=>setTimeout(relayout,250)); if(window.visualViewport) window.visualViewport.addEventListener('resize',relayout); }

  // Why the camera could not start, in words the person can act on
  function liveCameraMessage(e){
    let framed=false; try{ framed=window.self!==window.top; }catch(_){ framed=true; }
    const name=e&&e.name;
    if(framed) return 'この画面（プレビューなどの埋め込み表示）ではカメラを使えません。公開したアプリで開いてください。ここでは「読み取り」から撮影できます';
    if(name==='NotAllowedError'||name==='SecurityError') return 'カメラの使用が許可されていません。iPhoneの「設定」→「アプリ」→「Safari」→「カメラ」を「確認」か「許可」にしてください（iOS 17以前は「設定」→「Safari」→「カメラ」）。それまでは「読み取り」から撮影できます';
    if(name==='NotReadableError') return 'ほかのアプリがカメラを使っています。そのアプリを閉じてから、もう一度お試しください';
    if(name==='NotFoundError'||name==='OverconstrainedError') return '使えるカメラが見つかりませんでした。「読み取り」から撮影してください';
    if(name==='NoCamera') return 'この端末・ブラウザではアプリ内のカメラを使えません。「読み取り」から撮影してください';
    return 'カメラを起動できませんでした。「読み取り」から撮影してください';
  }
  async function openLiveScan(mode){
    if(ocrBusy||live) return;
    const add=mode==='add', box=$('#liveScan');
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){ toast(liveCameraMessage({name:'NoCamera'}),{error:true}); if(add) showView('scanView'); return; }
    // a new receipt: the photos (and result) of the previous one are not mixed in
    if(!add&&pendingPhotos.length){
      if(!(await askConfirm(`いまの写真（${pendingPhotos.length}枚）${hasUnsavedResult?'と読み取り結果':''}は使わずに、新しいレシートを撮影しますか？`,{ok:'新しく撮影する'}))) return;
      if(ocrBusy||live) return; resetScan();
    }
    // v1.10.5: every opening is its own session. A camera that starts after the screen was closed (or closed and opened again) is stopped at once,
    // so no stream or timer is left running behind the screen.
    const session=live={mode:add?'add':'new',stream:null,timer:null,prev:null,stable:0,sharpMax:0,busy:false,small:null};
    box.classList.remove('hidden'); document.body.classList.add('dialog-open'); layoutLive(); setLiveStatus('カメラを起動しています…');
    // try the sharpest rear camera first, then simpler requests (some devices reject the size hints)
    const asks=[{audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:3840},height:{ideal:2160}}},{audio:false,video:{facingMode:'environment'}},{audio:false,video:true}];
    let stream=null, err=null;
    for(const a of asks){ if(live!==session) break; try{ stream=await navigator.mediaDevices.getUserMedia(a); break; }catch(e){ err=e; if(e&&(e.name==='NotAllowedError'||e.name==='SecurityError')) break; } }
    if(live!==session){ if(stream) stream.getTracks().forEach(t=>{ try{ t.stop(); }catch(_){ } }); return; }
    if(!stream){ closeLiveScan(); toast(liveCameraMessage(err),{error:true}); if(add) showView('scanView'); return; }
    session.stream=stream;
    const v=$('#liveVideo'); v.srcObject=stream; v.onloadedmetadata=layoutLive; try{ await v.play(); }catch(_){ }
    if(live!==session) return;   // closed while the video was starting: closeLiveScan has already stopped this stream
    layoutLive(); setLiveStatus(add?'続きの部分を枠に入れてください':'レシートを枠に入れてください');
    session.timer=setInterval(liveTick,LIVE.tick);
  }
  function closeLiveScan(){
    if(live){ clearInterval(live.timer); live.timer=null; if(live.stream) live.stream.getTracks().forEach(t=>{ try{ t.stop(); }catch(_){ } }); live.stream=null; releaseCanvas(live.small); }
    live=null; const v=$('#liveVideo'); if(v){ v.onloadedmetadata=null; try{ v.pause(); }catch(_){ } v.srcObject=null; }
    const box=$('#liveScan'); if(box){ box.classList.add('hidden'); box.classList.remove('ready','flash','landscape'); } document.body.classList.remove('dialog-open');
  }
  function liveTick(){
    if(!live||live.busy) return; const v=$('#liveVideo'); if(!v||!v.videoWidth) return;
    const f=liveFrame(v,160);
    let motion=255; if(live.prev&&live.prev.length===f.g.length){ let s=0; for(let i=0;i<f.g.length;i+=2) s+=Math.abs(f.g[i]-live.prev[i]); motion=s/(f.g.length/2); }
    live.prev=f.g;
    const share=paperShare(f.g,f.w,f.h,f.white);
    if(share<LIVE.minPaper){ live.stable=0; setLiveStatus(live.mode==='add'?'続きの部分を枠に入れてください':'レシートを枠に入れてください'); return; }
    // small print reads poorly: ask to come closer (a long receipt is then taken in parts with 続きを撮って追加)
    if(share<LIVE.closePaper){ live.stable=0; setLiveStatus('もう少し近づけてください（入りきらない分は、あとで続きを撮れます）'); return; }
    if(motion>LIVE.motionMax){ live.stable=0; setLiveStatus('そのまま動かさないでください'); return; }
    live.stable++;
    const m=liveFrame(v,360), sh=sharpnessOf(m.g,m.w,m.h); live.sharpMax=Math.max(sh,live.sharpMax*0.97);
    if(live.stable>=LIVE.stableTicks&&sh>=LIVE.sharpMin&&sh>=live.sharpMax*0.8){ captureLive(); return; }
    setLiveStatus('ピントを合わせています…',true);
  }
  // take the photo, close the camera, read it (with the earlier photos in 'add' mode) and show the confirm screen
  async function captureLive(){
    if(!live||live.busy) return; live.busy=true;
    const session=live, mode=live.mode, v=$('#liveVideo'), box=$('#liveScan');
    try{
      // look at a few frames in a row and keep the sharpest one (less blur from hand shake and focus hunting)
      let c=null, bestSharp=-1;
      for(let k=0;k<5;k++){
        if(k) await new Promise(r=>setTimeout(r,110));
        if(live!==session) return;
        const m=liveFrame(v,480), sh=sharpnessOf(m.g,m.w,m.h);
        if(sh>bestSharp){ bestSharp=sh; if(!c){ c=document.createElement('canvas'); c.width=v.videoWidth; c.height=v.videoHeight; } c.getContext('2d').drawImage(v,0,0,c.width,c.height); }
      }
      const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.93)); releaseCanvas(c);
      if(live!==session) return;
      if(!blob) throw new Error('no camera frame');
      setLiveStatus('撮影しました',true); box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash');
      await new Promise(r=>setTimeout(r,200));
      if(live!==session) return;
      closeLiveScan();
      addReceiptPhotos([new File([blob],`camera-${Date.now()}.jpg`,{type:'image/jpeg'})]);
      runOCR({append:mode==='add'});
    }catch(e){ console.warn(e); toast('撮影できませんでした。もう一度お試しください',{error:true}); if(live===session) live.busy=false; }
  }
  function liveShutter(){ const v=$('#liveVideo'); if(live&&!live.busy&&v&&v.videoWidth) captureLive(); }   // not before the camera picture is there
/* LIVE-END */

  function clearPhotoPreviewURLs(){photoPreviewURLs.forEach(u=>{try{URL.revokeObjectURL(u);}catch(_){}});photoPreviewURLs=[];}
  function renderPhotoQueue(){
    const panel=$('#photoQueuePanel'), box=$('#photoQueue'), count=$('#photoCount'); if(!panel||!box||!count)return;
    clearPhotoPreviewURLs(); box.innerHTML=''; count.textContent=`${pendingPhotos.length}枚`; panel.classList.toggle('hidden',pendingPhotos.length===0);
    const cameraButtonText=$('#cameraButtonText'); if(cameraButtonText) cameraButtonText.textContent=pendingPhotos.length===0?'読み取り':'読み取りを追加';
    pendingPhotos.forEach((file,i)=>{const url=URL.createObjectURL(file);photoPreviewURLs.push(url);const card=document.createElement('div');card.className='photo-card';card.innerHTML=`<img src="${url}" alt="レシート写真 ${i+1}"><span class="photo-index">${i+1}枚目</span><button type="button" data-remove-photo="${i}" aria-label="${i+1}枚目を外す">×</button>`;box.appendChild(card);});
    box.querySelectorAll('[data-remove-photo]').forEach(b=>b.addEventListener('click',()=>{pendingPhotos.splice(Number(b.dataset.removePhoto),1);renderPhotoQueue();}));
  }
  function addReceiptPhotos(files){
    if(ocrBusy) return;
    const list=[...(files||[])], incoming=list.filter(f=>f&&(String(f.type||'').startsWith('image/')||(!f.type&&/\.(jpe?g|png|heic|heif|webp|gif|bmp)$/i.test(f.name||''))));
    if(!incoming.length){ if(list.length) toast('画像ファイルを選んでください',{error:true}); return; }
    const room=Math.max(0,6-pendingPhotos.length), accepted=incoming.slice(0,room); pendingPhotos.push(...accepted);
    if(incoming.length>accepted.length) toast('1レシートにつき最大6枚まで追加できます');
    renderPhotoQueue();
  }
  // confirm screen: take the next part of a long receipt with the camera and read it together with the earlier photos
  function updateAddPageBtn(){ const b=$('#addPageBtn'); if(b) b.disabled=pendingPhotos.length>=6; }
  async function addReceiptPage(){
    if(ocrBusy||live) return;
    if(pendingPhotos.length>=6){ toast('1レシートにつき最大6枚までです'); return; }
    if(confirmEdited&&!(await askConfirm('ここで直した内容は、続きの写真と合わせて読み直すと元に戻ります。続きを撮りますか？',{ok:'続きを撮る'}))) return;
    openLiveScan('add');
  }
  function clearReceiptPhotos(){pendingPhotos=[];clearPhotoPreviewURLs();renderPhotoQueue();$('#cameraInput').value='';$('#galleryInput').value='';}
/* MERGE-START */
  function editDistance(a,b){
    const x=String(a||''),y=String(b||''); if(x===y)return 0; if(!x.length)return y.length; if(!y.length)return x.length;
    let prev=Array.from({length:y.length+1},(_,i)=>i),cur=new Array(y.length+1);
    for(let i=1;i<=x.length;i++){cur[0]=i;for(let j=1;j<=y.length;j++)cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(x[i-1]===y[j-1]?0:1));[prev,cur]=[cur,prev];}
    return prev[y.length];
  }
  function boundaryItemMatch(a,b){
    const ax=normalizeProductName(a&&a.name||''), bx=normalizeProductName(b&&b.name||'');
    if(!ax||!bx||Number(a&&a.amount||0)!==Number(b&&b.amount||0)) return false;
    if(ax===bx) return true;
    if(Math.min(ax.length,bx.length)>=4&&(ax.includes(bx)||bx.includes(ax))) return true;
    const longest=Math.max(ax.length,bx.length); return longest>=4&&editDistance(ax,bx)<=Math.max(1,Math.floor(longest*.18));
  }
  function matchRun(base,bStart,next,nStart,n){
    if(bStart<0||nStart<0||bStart+n>base.length||nStart+n>next.length) return false;
    for(let i=0;i<n;i++){ if(!boundaryItemMatch(base[bStart+i],next[nStart+i])) return false; }
    return true;
  }
  // Detailed analysis of one photo boundary. base = items merged so far, next = items of the next photo.
  // Only the tail of base and the head of next are compared (never the whole receipt).
  // mode 'run'   : 2+ consecutive lines match (removed by default, as in v1.3)
  // mode 'single': only the last/first line matches (kept by default; removed only if the printed total agrees)
  // weak         : same amounts in the same order and at least one name matches (kept unless the total agrees)
  function boundaryAnalysis(base,next){
    const none={mode:'none',remove:0,start:0,cutBase:false,cutNext:false,single:false,weak:[]};
    if(!base.length||!next.length) return none;
    const L=10;
    for(let n=Math.min(L,base.length,next.length);n>=2;n--){ if(matchRun(base,base.length-n,next,0,n)) return Object.assign({},none,{mode:'run',remove:n}); }
    for(let n=Math.min(L,base.length-1,next.length);n>=2;n--){ if(matchRun(base,base.length-1-n,next,0,n)) return Object.assign({},none,{mode:'run',remove:n,cutBase:true}); }
    for(let n=Math.min(L,base.length,next.length-1);n>=2;n--){ if(matchRun(base,base.length-n,next,1,n)) return Object.assign({},none,{mode:'run',remove:n,start:1,cutNext:true}); }
    for(let n=Math.min(L,base.length-1,next.length-1);n>=2;n--){ if(matchRun(base,base.length-1-n,next,1,n)) return Object.assign({},none,{mode:'run',remove:n,start:1,cutBase:true,cutNext:true}); }
    const weak=[];
    for(let n=Math.min(L,base.length,next.length);n>=2;n--){
      let ok=true,hits=0;
      for(let i=0;i<n;i++){ const a=base[base.length-n+i],b=next[i]; if(Number(a.amount)!==Number(b.amount)){ok=false;break;} if(boundaryItemMatch(a,b)) hits++; }
      // a long run of the same amounts in the same order with a third of the names matching is the overlap (names read differently on each photo)
      if(ok&&n>=3&&hits>=Math.ceil(n/3)) return Object.assign({},none,{mode:'run',remove:n});
      if(ok&&hits>=1) weak.push({start:0,remove:n});
    }
    if(boundaryItemMatch(base[base.length-1],next[0])) return Object.assign({},none,{mode:'single',single:true,weak});
    return Object.assign({},none,{weak});
  }
  // v1.3-compatible: number of leading lines of `next` removed by default (2+ consecutive matches only)
  function boundaryOverlap(base,next){ const a=boundaryAnalysis(base,next); return a.mode==='run'&&a.start===0?a.remove:0; }
  function sumTargets(total,meta){
    const m=meta||{}, T=Number(total)||0, out=[]; if(!T) return out;
    const add=(v,why)=>{ if(v>0&&!out.some(o=>o.value===v)) out.push({value:v,why}); };
    add(T,'');
    const ex=Number(m.exTax)||0, unk=Number(m.unknownTax)||0, disc=Number(m.receiptDiscount)||0, sub=Math.max(0,(Number(m.subtotal)||0)-(Number(m.cancelAfterSub)||0));   // v1.10.18: 小計 less the items taken back after it
    if(ex) add(T-ex,'ex');
    if(unk){ if(!ex) add(T-unk,'unk'); else add(T-ex-unk,'ex+unk'); }   // v1.10.10: an unknown-class tax is a possible part of the total also next to a 外税
    if(disc){ add(T+disc,'disc'); if(ex) add(T-ex+disc,'ex+disc'); if(unk){ if(!ex) add(T-unk+disc,'unk+disc'); else add(T-ex-unk+disc,'ex+unk+disc'); } }
    if(sub) add(sub,'sub');
    return out;
  }
  function matchesTargets(sum,targets){ return targets.some(t=>Math.abs(sum-t.value)<=1); }
  function pickMergeMeta(results){
    const keys=['subtotal','exTax','inTax','inTaxMax','unknownTax','cash','change','card','baseSum','discAfterSub','cancelAfterSub','taxBy'];   // v1.10.18: cancelAfterSub
    const meta={subtotal:0,exTax:0,inTax:0,inTaxMax:0,unknownTax:0,cash:0,change:0,card:0,receiptDiscount:0,changeFound:false,baseSum:0};
    for(let i=results.length-1;i>=0;i--){ const m=results[i].meta||{}; keys.forEach(k=>{ if(!meta[k]&&m[k]) meta[k]=m[k]; }); if(m.changeFound&&!meta.changeFound){meta.changeFound=true;} }
    // v1.10.7: the tax lines of all photos are resolved together. A rate's line that is on two photos counts once (the later photo wins when the
    // amounts differ, and that is flagged); rates printed on different photos add up. Lines without a rate come from the last photo that has any, as before.
    { const sp=results.slice().reverse().find(r=>r.meta&&r.meta.subtotal===meta.subtotal&&meta.subtotal); if(sp){ meta.subBasis=sp.meta.subBasis||''; meta.subLabel=sp.meta.subLabel||''; } }
    { const pages=results.map(r=>(r.meta&&Array.isArray(r.meta.taxLines))?r.meta.taxLines:[]);
      if(pages.some(p=>p.length)){ const all=[]; ['ex','in','unknown'].forEach(cls=>{ let loose=[]; for(let i=pages.length-1;i>=0;i--){ const ls=pages[i].filter(l=>l&&l.t===cls); ls.filter(l=>l.r).forEach(l=>all.push(l)); if(!loose.length) loose=ls.filter(l=>!l.r); } loose.forEach(l=>all.push(l)); });
        let ts=0; for(let i=results.length-1;i>=0&&!ts;i--) ts=Number(results[i].meta&&results[i].meta.taxSum)||0;
        meta.taxLines=all; meta.taxSum=ts; resolveTaxLines(meta); } }
    // v1.10.10: the receipt-level discounts of all photos are put together line by line - not added up page by page (a coupon in the part that two
    // photos share was counted twice). A line on a later photo is the same line read again when it has the same amount and stands next to the same
    // lines (the digits of the nearest lines before / after it). The same amount alone is not enough: with different or missing neighbours it cannot
    // be told apart - it is then counted once and flagged (taxUnsure.disc), so that nothing is offered as a settled total. Discounts on one photo
    // are never merged with each other (two coupons of ¥100 stay ¥200).
    // v1.10.11: the discounts of all photos are put together by where they stand. First the part that two neighbouring photos share is found line by
    // line (alignPages: 2 or more lines in a row with the same kind, amount and a name that does not differ, at the end of the earlier photo and the start
    // of the later one). A discount inside that part is the same line read again when the line it faces on the earlier photo is that discount - same
    // amount, a name that does not differ. A discount after that part is another discount, also with the same amount and the same neighbours (before,
    // the same amount next to the same digits was taken as the same line: 会員クーポン −100 and アプリクーポン −100 on two photos became one).
    // Discounts whose names differ (会員クーポン / アプリクーポン) are never the same line. When no shared part can be found, a discount with the same
    // amount and a name that does not differ on an earlier photo cannot be told apart: it is counted once and flagged (taxUnsure.disc), and the amount
    // if it is another discount is kept (discAlt). Discounts on one photo are never merged with each other. Every line read is kept (discRaw).
    const al=results.map((r,p)=>p?alignPages((results[p-1].meta||{}).lineSig,(r.meta||{}).lineSig):null); meta.pageAlign=al.map(x=>x?{i:x.i,j:x.j,len:x.len}:null);
    { const kept=[], raw=[]; let unsure=false;
      results.forEach((r,p)=>{ const rm=r.meta||{}, ls=Array.isArray(rm.discLines)?rm.discLines:null;
        if(!ls){ const v=Number(rm.receiptDiscount)||0; if(v) kept.push({a:v,p,li:-1,after:rm.discAfterSub?1:0,label:'',name:'',prev:'',next:''}); return; }
        const used=new Set(), A=al[p];
        ls.forEach(d=>{ raw.push(Object.assign({},d,{p}));
          const off=A?d.li-A.j:-1, inside=!!A&&off>=0&&off<A.len, after=!!A&&off>=A.len;
          if(inside){ const ci=A.i+off, k=kept.findIndex((e,i)=>!used.has(i)&&e.p===p-1&&e.li===ci);
            if(k>=0){ used.add(k); const e=kept[k], same=e.a===d.a&&discRel(e,d)!=='diff'; kept[k]=Object.assign({},d,{p,unsure:!!e.unsure||!same,alt:e.alt}); if(!same) unsure=true; return; }   // the same line, read again on this photo
            kept.push(Object.assign({},d,{p})); return; }                                                                                       // the shared part has no discount there: another line
          if(after){ kept.push(Object.assign({},d,{p})); return; }                                                                               // below the shared part: another discount
          const k=kept.findIndex((e,i)=>!used.has(i)&&e.p<p&&e.a===d.a&&discRel(e,d)!=='diff');
          if(k>=0){ used.add(k); kept[k]=Object.assign({},d,{p,unsure:true,alt:(Number(kept[k].alt)||0)+d.a}); unsure=true; return; }      // the same amount on two photos, not clearly the same line
          kept.push(Object.assign({},d,{p})); }); });
      meta.receiptDiscount=kept.reduce((t,d)=>t+d.a,0); meta.discAfterSub=kept.filter(d=>d.after).reduce((t,d)=>t+d.a,0); meta.discLines=kept; meta.discounts=kept.map(d=>d.a); meta.discRaw=raw;
      meta.discAlt=unsure?meta.receiptDiscount+kept.reduce((t,d)=>t+(Number(d.alt)||0),0):0;
      if(unsure) meta.taxUnsure=Object.assign({},taxUnsureOf(meta),{disc:'overlap'}); }
    // v1.10.11: every whole 小計 line of every photo. The copy on a later photo is the same line only inside the part the two photos share (before:
    // any 小計 with the same amount and basis). Without a shared part nothing is merged; the same 小計 wording on two photos outside a shared part
    // means that each photo has its own section 小計 (subSections) - none of them is the 小計 of the whole receipt.
    { const subs=[]; let sections=false; results.forEach((r,p)=>{ const A=al[p]; ((r.meta&&r.meta.subtotals)||[]).forEach(sb=>{ const o=Object.assign({},sb,{p}), off=A?sb.li-A.j:-1;
        let k=-1; if(A&&off>=0&&off<A.len){ const ci=A.i+off; k=subs.findIndex(e=>e.p===p-1&&e.li===ci&&e.a===sb.a); }
        if(k>=0) subs[k]=o; else { if(subs.some(e=>e.p<p&&e.basis===sb.basis&&e.label===sb.label)) sections=true; subs.push(o); } }); });
      const cxs=[]; results.forEach((r,p)=>((r.meta&&r.meta.cancelled)||[]).forEach(cx=>cxs.push({a:cx.a,li:cx.li,p})));   // v1.10.18: the 取消 lines that took an item back, on every photo
      subs.forEach(sb=>{ sb.dA=meta.discLines.filter(d=>(d.p===sb.p&&d.li>sb.li)||d.p>sb.p).reduce((t,d)=>t+d.a,0); sb.cA=cxs.filter(cx=>(cx.p===sb.p&&cx.li>sb.li)||cx.p>sb.p).reduce((t,cx)=>t+cx.a,0); sb.exAfter=(meta.taxLines||[]).some(l=>l&&l.t==='ex'&&l.a>0&&l.s); }); meta.subtotals=subs; meta.subSections=sections;
      const parts=[]; results.forEach((r,p)=>{ ((r.meta&&r.meta.partSubs)||[]).forEach(ps=>{ const A=al[p], off=A?ps.li-A.j:-1; let k=-1; if(A&&off>=0&&off<A.len){ const ci=A.i+off; k=parts.findIndex(e=>e.p===p-1&&e.li===ci&&e.a===ps.a); } const o=Object.assign({},ps,{p}); if(k>=0) parts[k]=o; else parts.push(o); }); }); meta.partSubs=parts; }
    return meta;
  }
  function mergeReceiptPages(results){
    const today=todayISO();
    const firstDated=results.find(x=>x.dateFound);
    const date=firstDated?firstDated.date:(results.map(x=>x.date).find(Boolean)||today);
    const dateFound=!!firstDated;
    const store=results.map(x=>x.store).find(Boolean)||'';
    const meta=pickMergeMeta(results);
    // total: printed total line (last photo that has one) > cash-change > card/e-money > subtotal(+tax) > item sum
    let total=0,totalSource='',subEst=false;   // subEst: no 合計 line (and no payment line) - the amount is estimated from 小計
    for(let i=results.length-1;i>=0&&!total;i--){ const t=Number(results[i].explicitTotal)||0; if(t){total=t;totalSource='total';} }
    if(!total&&meta.cash&&meta.changeFound&&meta.cash-meta.change>0){ total=meta.cash-meta.change; totalSource='cash'; }
    if(!total&&meta.card){ total=meta.card; totalSource='card'; }
    if(!total&&meta.subtotal&&!meta.subSections){ total=meta.subtotal-(meta.discAfterSub||0)-(meta.cancelAfterSub||0)+(meta.exTax||0); totalSource='subtotal'; subEst=true; }   // v1.10.11: not from section 小計 lines of separate photos   // 小計 − 値引（小計の後）＋ 外税: an estimate
    // Boundary plan: compare only the tail of the merged list with the head of the next photo
    const pages=results.map((r,pg)=>(r.items||[]).map(it=>Object.assign({},it,{_pg:pg})));   // v1.10.17: _pg = the photo of the item (a 取消 line on a later photo looks back at the earlier ones)
    const plan=[null]; let acc=pages.length?pages[0].slice():[];
    for(let k=1;k<pages.length;k++){
      const a=boundaryAnalysis(acc,pages[k]); plan.push(a);
      if(a.mode==='run'){
        if(a.cutBase&&acc.length){ const c=acc[acc.length-1]; c._flag='cut'; c._hint=addHint(c._hint,'写真の端で切れた行かもしれません'); }
        if(a.cutNext){ const c=pages[k][0]; c._flag='cut'; c._hint=addHint(c._hint,'写真の端で切れた行かもしれません'); }
        acc=acc.concat(pages[k].filter((_,i)=>i<a.start||i>=a.start+a.remove));
      }else acc=acc.concat(pages[k]);
    }
    // options per boundary; option 0 is the default (v1.3 behaviour: 2+ line runs removed, everything else kept)
    const opts=plan.map((a,k)=>{
      if(!a) return null;
      if(a.mode==='run') return [{kind:'run',start:a.start,remove:a.remove},{kind:'keep'}];
      const o=[{kind:'keep'}];
      if(a.mode==='single') o.push({kind:'single',start:0,remove:1});
      (a.weak||[]).forEach(w=>o.push({kind:'weak',start:w.start,remove:w.remove}));
      return o;
    });
    // a line priced exactly like the whole receipt may be a garbled 合計 line; it is removed only when the total then agrees
    const totalLike=it=>!!total&&totalSource!=='subtotal'&&it.amount===total;
    const build=(choice,dropTL)=>{
      let out=pages.length?pages[0].slice():[];
      for(let k=1;k<pages.length;k++){
        const o=opts[k][choice?choice[k]:0];
        out=o.kind==='keep'?out.concat(pages[k]):out.concat(pages[k].filter((_,i)=>i<o.start||i>=o.start+o.remove));
      }
      if(dropTL&&out.length>=3) out=out.filter(it=>!totalLike(it));
      return out;
    };
    let items=build(null,false), choice=null, reconciled='', dropTL=false;
    const targets=(totalSource==='total'||totalSource==='cash'||totalSource==='card')?sumTargets(total,meta):[];
    const sumOf=list=>list.reduce((s,x)=>s+x.amount,0);
    let combos=1; opts.forEach(o=>{ if(o) combos*=o.length; });
    const hasTL=items.length>=3&&items.some(totalLike);
    if(targets.length&&combos<=1024&&(combos>1||hasTL)&&!matchesTargets(sumOf(items),targets)){
      let best=null,bestTL=false,bestFlips=99,tie=false;
      const cur=opts.map(()=>0);
      const rec=(k)=>{
        if(k>=opts.length){
          [false,true].forEach(tl=>{
            if(tl&&!hasTL) return;
            const flips=cur.filter(v=>v!==0).length+(tl?1:0); if(!flips) return;
            if(matchesTargets(sumOf(build(cur,tl)),targets)){ if(flips<bestFlips){best=cur.slice();bestTL=tl;bestFlips=flips;tie=false;} else if(flips===bestFlips) tie=true; }
          });
          return;
        }
        if(!opts[k]){ rec(k+1); return; }
        for(let v=0;v<opts[k].length;v++){ cur[k]=v; rec(k+1); } cur[k]=0;
      };
      rec(0);
      if(best&&!tie){ choice=best; dropTL=bestTL; items=build(best,bestTL); reconciled='ok'; }
    }
    // A line equal to the sum of all lines above it is a garbled 小計; removed only when the printed total then agrees
    let droppedSubtotalLike=0;
    if(targets.length&&!matchesTargets(sumOf(items),targets)){
      let run=0; const cand=[];
      items.forEach((it,i)=>{ if(i>=2&&it.amount===run&&!it._manual) cand.push(i); run+=it.amount; });
      if(cand.length){ const trial=items.filter((_,i)=>cand.indexOf(i)<0); if(matchesTargets(sumOf(trial),targets)){ items=trial; droppedSubtotalLike=cand.length; } }
    }
    const sumOk=targets.length?matchesTargets(sumOf(items),targets):false;
    let removed=0,singleRemoved=0,restored=0,weakRemoved=0;
    opts.forEach((o,k)=>{
      if(!o) return; const sel=o[choice?choice[k]:0], page=pages[k], a=plan[k];
      if(a.mode==='run'){
        if(sel.kind==='run') removed+=sel.remove;
        else { restored+=a.remove; page.slice(a.start,a.start+a.remove).forEach(r=>{r._flag='restored';r._hint=addHint(r._hint,'合計に合わせて、境目の重複扱いを取り消しました');}); }
      }else if(sel.kind==='single'){ removed+=1; singleRemoved+=1; }
      else if(sel.kind==='weak'){ removed+=sel.remove; weakRemoved+=sel.remove; }
      else if(a.mode==='single'){ const it=page[0];
        if(sumOk) it._hint=addHint(it._hint,'前の写真の最後と同じ商品ですが、合計と一致するため残しています');
        else { it._flag=it._flag||'boundary'; it._hint=addHint(it._hint,'前の写真の最後と同じ商品です。重複なら×で外してください'); } }
    });
    // v1.10.9: a total that was read from a 合計 line is kept, however far it is from the items, 小計 or the tax. Until v1.10.8 it was replaced here
    // by a calculated amount in three cases (another printed figure agrees with the items / 合計 below half of 小計 / 合計 below 小計), the source
    // became 'subtotal', and the screen said that no total line had been read. A difference is now reported on the confirm screen, and the
    // calculated amount is offered there as a candidate the person can apply. Estimating a total is only done when no 合計 line was read.
    // a total taken from a payment line (card / cash) that disagrees with the items gives way to 小計 + 外税 when that
    // agrees with them (points or coupons paid part of the bill: dポイント ¥14 + PayPay ¥3,814 = 合計 ¥3,828)
    if((totalSource==='card'||totalSource==='cash')&&items.length&&meta.subtotal>0){
      const st=meta.subtotal-(meta.cancelAfterSub||0)+(meta.exTax||0), expect=sumOf(items)+(meta.exTax||0)-(meta.receiptDiscount||0);   // v1.10.18: less the items taken back after 小計
      // v1.10.14: not when the payment is 小計 + the tax that was read (class unknown): that payment is the total (クレジット ¥1,408 = 小計 ¥1,280 + 消費税 ¥128)
      if(Math.abs(st-expect)<=1&&Math.abs(total-st)>1&&!(meta.unknownTax>0&&Math.abs(total-st-meta.unknownTax)<=1)){ total=st; totalSource='subtotal'; targets.length=0; sumTargets(total,meta).forEach(v=>targets.push(v)); }
    }
    // v1.10.5: a tax amount that was read from the receipt is never replaced by 合計 − 小計 (before, 外税 ¥80 with 合計 ¥1,081 became ¥81 and
    // the screen said 一致). A difference is now reported on the confirm screen instead.
    // Only when no tax amount of any kind was read: if 小計 matches the items, what 合計 adds to 小計 (at most ~10%) is taken as the 外税.
    // That is an estimate; it is marked (meta.exTaxFromTotal) and shown as 推定, never as a plain 一致.
    const subNet=meta.subtotal-(meta.cancelAfterSub||0);   // v1.10.18: 小計 less the items taken back by 取消 lines after it
    if(totalSource==='total'&&subNet>0&&Math.abs(sumOf(items)-subNet)<=1&&total>subNet&&!(meta.receiptDiscount>0)&&!(meta.exTax>0)&&!(meta.unknownTax>0)&&!(meta.inTax>0)){
      const t=total-subNet;
      if(t<=subNet*0.11+2){ meta.exTax=t; meta.exTaxFromTotal=true; targets.length=0; sumTargets(total,meta).forEach(v=>targets.push(v)); }
    }
    // OCR sometimes reads the yen sign as a digit (¥699 -> 4699 / 8699). Undo it only when exactly one such item makes the receipt total agree.
    let yenFixed=0;
    if(targets.length&&!matchesTargets(sumOf(items),targets)){
      const fixes=[];
      items.forEach((it,k)=>{ const str=String(it.amount); if(str.length>=4&&/[1-9]/.test(str[0])){ const v=Number(str.slice(1)); if(v>0&&!/^0/.test(str.slice(1))&&matchesTargets(sumOf(items)-it.amount+v,targets)) fixes.push([k,v]); } });
      if(fixes.length===1){ const [k,v]=fixes[0], it=items[k]; it._hint=addHint(it._hint,`「¥」を数字の「${String(it.amount)[0]}」と読み違えたとみて ${yenPlain(it.amount)} を ${yenPlain(v)} にしました。違う場合は直してください`); it.amount=v; it._flag=it._flag||'boundary'; yenFixed=1; }
    }
    // Still not matching the receipt total: point at the one amount that a single misread digit would explain
    // (8,084 vs a total of 1,084). Nothing is changed; the row is only marked for the person to check.
    if(targets.length&&items.length&&!matchesTargets(sumOf(items),targets)){
      const sum=sumOf(items), found=[];
      items.forEach((it,k)=>{ const s=String(Math.round(Number(it.amount)||0)), vals=new Set();
        for(let i=0;i<s.length;i++){ for(let dg=0;dg<10;dg++){ if(String(dg)===s[i]) continue; const v=s.slice(0,i)+dg+s.slice(i+1); if(!/^0/.test(v)) vals.add(Number(v)); } const del=s.slice(0,i)+s.slice(i+1); if(del&&!/^0/.test(del)) vals.add(Number(del)); }
        const ok=[...vals].filter(v=>v>0&&matchesTargets(sum-it.amount+v,targets)); if(ok.length) found.push([k,ok]); });
      if(found.length===1){ const [k,vals]=found[0], it=items[k]; it._suspect=true; it._hint=addHint(it._hint,vals.length===1?`この金額を確認してください（${yenPlain(vals[0])} ならレシートの合計と一致します）`:'この金額を確認してください（数字を1文字読み違えている可能性があります）'); }
    }
    let droppedTotalLike=0;
    if(dropTL) droppedTotalLike=build(choice,false).length-items.length;
    else if(items.length>=3) items.forEach(it=>{ if(totalLike(it)){ it._flag=it._flag||'total'; it._hint=addHint(it._hint,'レシート合計と同じ金額です。合計行の読み違いなら×で外してください'); } });
    // v1.10.17: 取消 / 返品 lines that had no item of their amount above them on their own photo (parseReceipt counted them as a discount on the receipt,
    // cancelOpen 'none'). On a later photo, the item may be on an earlier one: the items of the earlier photos are looked at with the same rule
    // (cancelTarget). Found → the item is taken out (or reduced) and the discount is dropped. Several that fit → nothing is taken out, the discount is
    // dropped and the line stays open for the person. The same 取消 line read again at the top of the next photo (the earlier photo already took its
    // item out) is dropped. Before, such a line stayed a discount and the item it took back stayed in the list (and the sums agreed).
    const crossCancelled=[], opens=[], took=[];
    results.forEach((r,pg)=>{ ((r.meta&&r.meta.cancelOpen)||[]).forEach(o=>opens.push(Object.assign({},o,{p:pg}))); ((r.meta&&r.meta.cancelled)||[]).forEach(cx=>took.push(Object.assign({},cx,{p:pg}))); });
    { let dropped=false; const keepOpen=[];
      opens.forEach(o=>{ const di=o.w==='none'&&o.p>0?(meta.discLines||[]).findIndex(x=>x&&x.cancel&&x.p===o.p&&x.li===o.li&&x.a===o.a):-1;
        // v1.10.18: a named line that found only items of a similar or another name on its own photo ('rel' / 'other': nothing was subtracted) takes
        // the item of its own name from an earlier photo (取消 牛乳 on the 2nd photo, 牛乳 on the 1st, 牛乳石鹸 on both where they overlap)
        if(di<0&&o.p>0&&o.n&&(o.w==='rel'||o.w==='other')){ const idx=[]; items.forEach((it,j)=>{ if(it._pg<o.p) idx.push(j); });
          const ct=cancelTarget(idx.map(j=>items[j]),o.a,o.n);
          if(ct.k!=null){ const j=idx[ct.k], it=items[j];
            if(ct.part){ const pq=applyCancelPart(it,o.a,o.word); crossCancelled.push(Object.assign({name:it.name,a:o.a,part:1,other:1,p:o.p,li:o.li},pq.q0?{q0:pq.q0,q1:pq.q1}:{})); }
            else { const rm=items.splice(j,1)[0]; crossCancelled.push({name:rm.name,a:o.a,other:1,p:o.p,li:o.li}); }
            return; } }
        if(di<0){ keepOpen.push(o); return; }
        const again=!!o.head&&took.some(cx=>cx.p===o.p-1&&cx.tail&&cx.a===o.a&&nameKey(cx.n||'')===nameKey(o.n||''));
        const idx=[]; items.forEach((it,j)=>{ if(it._pg<o.p) idx.push(j); });
        const ct=again?{}:cancelTarget(idx.map(j=>items[j]),o.a,o.n||'');
        if(!again&&ct.k==null&&!ct.open){ keepOpen.push(o); return; }
        meta.discLines.splice(di,1); dropped=true;
        if(again) return;
        if(ct.k!=null){ const j=idx[ct.k], it=items[j];
          if(ct.part){ const pq=applyCancelPart(it,o.a,o.word); crossCancelled.push(Object.assign({name:it.name,a:o.a,part:1,other:1,p:o.p,li:o.li},pq.q0?{q0:pq.q0,q1:pq.q1}:{})); }   // v1.10.18: the count follows (applyCancelPart)
          else { const rm=items.splice(j,1)[0]; crossCancelled.push({name:rm.name,a:o.a,other:1,p:o.p,li:o.li}); }
          return; }
        keepOpen.push(Object.assign({},o,{w:ct.open,c:(ct.cands||[]).map(k=>idx[k]!=null?items[idx[k]].name:'').filter(Boolean).slice(0,4)})); });
      if(dropped){ meta.receiptDiscount=meta.discLines.reduce((t,x)=>t+x.a,0); meta.discounts=meta.discLines.map(x=>x.a); meta.discAfterSub=meta.discLines.filter(x=>x.after).reduce((t,x)=>t+x.a,0); if(meta.discAlt) meta.discAlt=meta.receiptDiscount+meta.discLines.reduce((t,x)=>t+(Number(x.alt)||0),0); }
      meta.cancelOpen=keepOpen.map(o=>({n:o.n||'',a:o.a,w:o.w,c:o.c||[],word:o.word||'取消'}));
      // v1.10.18: what follows each 小計 line again: the discounts left (a 取消 line taken here is no discount any more) and the 取消 lines that took an
      // item back (the 小計 still has that item in it). Before, the discount of such a line stayed counted after the 小計.
      if(dropped||crossCancelled.length){ (meta.subtotals||[]).forEach(sb=>{ sb.dA=meta.discLines.filter(d=>(d.p===sb.p&&d.li>sb.li)||d.p>sb.p).reduce((t,d)=>t+d.a,0); sb.cA=(Number(sb.cA)||0)+crossCancelled.filter(cx=>(cx.p===sb.p&&cx.li>sb.li)||cx.p>sb.p).reduce((t,cx)=>t+cx.a,0); });
        const sb0=(meta.subtotals||[]).find(sb=>sb.a===meta.subtotal); if(sb0) meta.cancelAfterSub=Number(sb0.cA)||0; } }
    // v1.10.17: the item a 取消 line took back was the first item on its photo, and the earlier photo ends with the same item (the photos overlap on that
    // line): the copy on the earlier photo is the same line, taken out only when the receipt total then agrees (as for other single-line overlaps)
    { const tg=targets.length?sumTargets(total,meta):[];
      took.forEach(cx=>{ if(!cx.first||cx.part||!(cx.p>0)||!tg.length||matchesTargets(sumOf(items),tg)) return;
        let j=-1; items.forEach((it,i)=>{ if(it._pg===cx.p-1) j=i; });
        if(j<0||items[j].amount!==cx.a||nameKey(items[j].name)!==nameKey(cx.name)||!matchesTargets(sumOf(items)-cx.a,tg)) return;
        items.splice(j,1); removed+=1; singleRemoved+=1; }); }
    const flagged=items.filter(it=>it._flag==='cut'||it._flag==='boundary'||it._flag==='total').length;
    items.forEach(it=>{if(!it._manual){const cls=classifyItem(it.name,store);it.category=cls.category;it._source=cls.source;}});
    const itemSum=sumOf(items);
    normalizeTaxMeta(meta,items);
    // v1.10.15: points printed after the total line (parseReceipt: postPoints / discLines.post). What the receipt says decides, never a sum made to agree:
    //   ポイント値引 / ポイント割引 (a discount):
    //     - the total already has it taken off (items ＋ 外税 − the other discounts − the points ＝ the total): the discount is kept, the total stays (not twice)
    //     - an amount paid after it (お支払額 / ご請求額, the card or cash payment) is the total − the points: the total is that amount (値引後の支払額)
    //     - neither: the total stays as printed and the discount is an open point (taxUnsure.disc 'point'): the screen asks, no candidate is settled
    //   ポイント利用 / 使用 / 充当 / 払い (a way of paying part of the total): the total stays as printed, the screen says so (pointPay)
    let pointAfter=null;
    { const post=(meta.discLines||[]).filter(d=>d&&d.post), pts=post.reduce((t,d)=>t+d.a,0), near=(a,b)=>Math.abs(a-b)<=1;
      if(pts>0&&totalSource==='total'){
        const X=Number(meta.exTax)||0, U=Number(meta.unknownTax)||0, pre=itemSum+X-((Number(meta.receiptDiscount)||0)-pts), paid=new Set();
        results.forEach(r=>{ const rm=r.meta||{}; (rm.totLines||[]).forEach(t=>{ if(t.a!==total) paid.add(t.a); }); if(rm.card) paid.add(rm.card); if(rm.cashPay) paid.add(rm.cashPay); if(rm.cash&&rm.changeFound&&rm.cash-rm.change>0) paid.add(rm.cash-rm.change); });
        if(near(pre-pts,total)||(U>0&&near(pre+U-pts,total))) pointAfter={kind:'included',T:total,pts};
        else if([...paid].some(v=>near(v,total-pts))){ pointAfter={kind:'applied',T:total,pts,paid:total-pts}; total=total-pts; }
        else { pointAfter={kind:'open',T:total,pts}; meta.taxUnsure=Object.assign({},taxUnsureOf(meta),{disc:'point'}); } }
      const pay=[]; results.forEach(r=>((r.meta&&r.meta.postPoints)||[]).forEach(x=>{ if(!x.disc&&!pay.some(y=>y.a===x.a&&y.label===x.label)) pay.push(x); }));   // the same line on two photos is one line
      if(pay.length&&!pointAfter) pointAfter={kind:'pay',T:total,pts:pay.reduce((t,x)=>t+x.a,0)};
      if(pointAfter) meta.pointAfter=pointAfter; }
    // v1.10.10: the total estimated from 小計 is made here, after the class of the tax is settled, from every 小計 line that was read - not from
    // the first one (before, 税抜小計 followed by 税込小計 gave another estimate than the same two lines the other way round).
    //   what a 小計 is, in this order: its own label (税込小計 / 税抜小計); how it stands to the items (小計 = the items → on the items' basis, before the
    //   外税; 小計 = the items + the 外税 → it already contains it); a 外税 line printed after 小計.
    //   税抜 by its label → 小計 − 値引 ＋ every tax of the receipt.  税抜 by the items / the 外税 line → 小計 − 値引 ＋ 外税.  税込 → 小計 − 値引.
    //   unknown → 小計 − 値引, and the screen says the basis is missing.  値引 = only the discounts printed after that 小計.
    // When the 小計 lines agree, their amount is used. When they do not, nothing is forced to agree: the labelled 税込小計 is used and the screen asks.
    // v1.10.12: estimating the total from 小計 and checking the 小計 lines against each other are two things. The check runs whenever two or more whole
    // 小計 lines were read - also when the total came from a 合計 line or a payment line (before, it only ran when no total had been read, so 税抜小計 ¥900
    // ＋ 外税 ¥80 against 税込小計 ¥1,080 passed as 一致 next to 合計 ¥1,080 / クレジット ¥1,080). The total that was read is never changed by the check.
    // 小計 lines of one rate or department (partSubs) and section 小計 lines of separate photos (subSections) are not compared with the whole 小計.
    const estFromSub=totalSource==='subtotal'&&subEst&&meta.subtotal>0, subLines=Array.isArray(meta.subtotals)?meta.subtotals:[];
    if(estFromSub||(subLines.length>=2&&!meta.subSections)){
      const X=Number(meta.exTax)||0, N=Number(meta.inTaxMax)||Number(meta.inTax)||0, U=Number(meta.unknownTax)||0, RD=Number(meta.receiptDiscount)||0, S=sumOf(items);
      const cands=(subLines.length?subLines:[{a:meta.subtotal,basis:meta.subBasis||'',label:meta.subLabel||'',dA:Number(meta.discAfterSub)||0,cA:Number(meta.cancelAfterSub)||0,exAfter:!!meta.exAfterSub}]).map(c=>{
        const dA=Number(c.dA)||0, cA=Number(c.cA)||0, pre=S+cA-Math.max(0,RD-dA); let basis=c.basis||'', by=basis?'label':'', add=0;   // v1.10.18: cA = items taken back by 取消 lines after the 小計 (still in it)
        if(basis==='ex') add=X+N+U;
        else if(!basis&&X>0){ if(pre===c.a){ basis='ex'; by='items'; add=X; } else if(pre+X===c.a){ basis='in'; by='items'; } else if(meta.taxWhy&&String(meta.taxWhy.ex||'').indexOf('label')===0&&c.exAfter){ basis='ex'; by='taxline'; add=X; } }
        else if(!basis){ basis='ex'; by='notax'; }   // no 外税 to place: the amount is 小計 − 値引 either way
        return {a:c.a,dA,cA,label:c.label||'',basis:basis||'unknown',by,add,est:Math.max(0,c.a-dA-cA+add),rank:by==='label'?(basis==='in'?0:1):by==='items'?2:by==='taxline'?3:by==='notax'?4:5};
      }).sort((a,b)=>a.rank-b.rank);
      const known=cands.filter(c=>c.basis!=='unknown'), pick=cands[0], conflict=known.length>1&&known.some(c=>c.est!==known[0].est);
      if(estFromSub){ total=pick.est;
        meta.subShown={a:pick.a,dA:pick.dA,cA:pick.cA,add:pick.add,basis:pick.basis,by:pick.by,label:pick.label};
        meta.subBasisUsed=pick.basis; meta.subBasisBy=pick.by; meta.subBasisUnknown=pick.basis==='unknown'&&X>0; }
      meta.subConflict=conflict?[...new Set(known.map(c=>`${c.label||'小計'} ${c.a}`))].join(' / ').slice(0,80):'';   // v1.10.13: a line printed again is named once (10 lines of 税込小計 ¥1,080 pushed 税抜小計 ¥900 out of the 80 characters)
      // v1.10.11: the 小計 lines that were compared are kept with how each one counts (frozen at reading), so the contradiction can be judged again
      // when the person corrects a tax amount - and it is an open point of the reading (taxUnsure.sub), not a note that a redraw can lose.
      meta.subCands=known.map(c=>({a:c.a,dA:c.dA+c.cA,basis:c.basis,by:c.by,label:c.label}));   // v1.10.18: kept with a record, what is taken off after the line (discounts and 取消 lines) counts as one amount
      if(conflict) meta.taxUnsure=Object.assign({},taxUnsureOf(meta),{sub:'conflict'});
    }
    // v1.10.7: no total line and no 小計: the amount is estimated from the items together with the 外税 and receipt-level discount that were read
    if(!total){ total=itemSum?Math.max(0,itemSum+(Number(meta.exTax)||0)-(Number(meta.receiptDiscount)||0)):0; totalSource='items'; }
    //   // v1.10.6: the class of each tax amount is settled here, from the receipt's own words and marks
    return {date,dateFound,store,total,totalSource,items,meta,photoCount:results.length,
      merge:{yenFixed,removed,singleRemoved,weakRemoved,restored,flagged,droppedTotalLike,droppedSubtotalLike,reconciled,pointAfter,cancelled:results.reduce((a,r)=>a.concat((r.meta&&r.meta.cancelled)||[]),[]).concat(crossCancelled)}};   // v1.10.16: cancelled = items taken back by 取消 / 返品 lines (v1.10.17: also on an earlier photo)
  }
  // v1.10.7: one tax line of a receipt: its class (外税 / 内税 / unknown / 税合計), the rate it names (8 / 10, or 0 when none) and its amount
  // v1.10.11: do the 小計 lines of a reading still contradict each other with the tax amounts as they are now? null = nothing to judge (no 小計
  // lines kept: a saved record, or a single 小計). Each line keeps what it was taken to be when it was read; only the tax added to it follows the panel.
  // v1.10.13: what one 小計 line comes to with the given tax amounts (the same rule as at reading: 税抜 by its label adds every tax, 税抜 by the items or the
  // 外税 line adds the 外税, 税込 adds nothing; the discounts printed after it are taken off)
  function subEst(c,X,N,U){ return Math.max(0,c.a-(Number(c.dA)||0)+(c.basis==='ex'?(c.by==='label'?X+N+U:(c.by==='items'||c.by==='taxline')?X:0):0)); }
  // v1.10.11: do the 小計 lines of a reading still contradict each other with the tax amounts as they are now? null = nothing to judge (no 小計
  // lines kept: a saved record, or a single 小計). Each line keeps what it was taken to be when it was read; only the tax added to it follows the panel.
  // v1.10.13: the 小計 lines belong to the receipt as it was read, so they are judged with the tax amounts of the receipt - as read, confirmed or corrected
  // by the person - never with a tax that was calculated for changed counts or amounts (taxSrc 'calc': 外税 ¥160 for 2 × ¥1,000 against 税抜小計 ¥1,000
  // ＋ 外税 ＝ 税込小計 ¥1,080 made a sound receipt look contradictory). For such an amount the baseline's amount (base: the snapshot the calculation
  // started from) is used; without it nothing is judged. When the kept lines are not all the lines that were read (subFull false: a record saved
  // with a cut list), agreement among them proves nothing: only a contradiction is reported, never its absence.
  function subConflictNow(m,base){ const cs=m&&Array.isArray(m.subCands)?m.subCands:null; if(!cs||cs.length<2) return null;
    const tv=k=>{ if(!(m.taxSrc&&m.taxSrc[k]==='calc')) return taxVal(m,k)||0; if(!base||(base.taxSrc&&base.taxSrc[k])==='calc') return null; return taxVal(base,k)||0; };
    const X=tv('ex'), N=tv('in'), U=tv('unk'); if(X==null||N==null||U==null) return null;
    const v=cs.map(c=>subEst(c,X,N,U)), c=v.some(x=>x!==v[0]); if(!c&&subComp(m)!=='full') return null; return c; }   // v1.10.15: also when it is not known whether they are all the lines
  // v1.10.15: what is known about the 小計 lines kept with a reading or a record: 'full' (all of them), 'part' (some were left out) or 'unknown' (an older
  // version wrote the list without saying - v1.10.13 / v1.10.14 left subFull out for a list that was not full, and after taking out the lines printed
  // again it could look like a short, complete list). A reading on the confirm screen has every line (subFull not set).
  function subComp(m){ const f=m&&m.subFull; return f===false?'part':f==='unknown'?'unknown':'full'; }
  // the person changed the tax: the contradiction between the 小計 lines is judged again (it stays open unless the amounts now agree, or the person
  // confirmed the 小計 lines). Changing anything that does not enter the 小計 lines (a discount, a category, the total) leaves it as it is.
  function syncSubUnsure(m,base){ if(!m) return; const c=subConflictNow(m,base); if(c==null) return; const u=Object.assign({},taxUnsureOf(m)); if(c&&!m.subChecked) u.sub='conflict'; else delete u.sub; m.taxUnsure=u; }
  // v1.10.11: the name of a discount line without its amount (会員クーポン / アプリクーポン / クーポン)
  function discName(s){ return String(s||'').replace(/\s+/g,'').replace(/[-−▲△¥￥\d,.円]+$/,'').replace(/^[-−▲△]+/,'').slice(0,16); }
  // what two discount names say about the lines: 'diff' = they name different discounts (会員クーポン / アプリクーポン), 'same' = the same words,
  // 'maybe' = one of them is missing or they are close (a misread). The general words (クーポン / 値引 / 割引 …) are set aside before comparing.
  function discRel(x,y){ const q=n=>String(n||'').replace(/(クーポン|ク一ポン|値引き?|値下げ?|割引き?|引き|引|券|額|金額|ディスカウント|ネビキ|ワリビキ|[%％]|OFF)/gi,''), a=String(x&&x.name!=null?x.name:x&&x.label||''), b=String(y&&y.name!=null?y.name:y&&y.label||'');
    if(a===b) return 'same'; const qa=q(a), qb=q(b); if(qa===qb) return 'same'; if(!qa||!qb) return 'maybe'; return similarity(qa,qb)>=0.6?'maybe':'diff'; }
  // v1.10.11: the part two neighbouring photos share: the end of the earlier photo (prev) read again at the start of the later one (cur).
  // Lines match when kind and amount are the same and the names do not differ. Returns {i,j,len}: prev[i..i+len) = cur[j..j+len), or null when no run of
  // 2 or more lines reaches the end of prev (its last line may be cut) from one of the first 3 lines of cur.
  function alignPages(prev,cur){ if(!Array.isArray(prev)||!Array.isArray(cur)||!prev.length||!cur.length) return null;
    const nm=(x,y)=>{ if(x.k!==y.k||x.a!==y.a) return false; if(x.k==='discount') return discRel({name:x.n},{name:y.n})!=='diff'; if(x.k==='noise'||x.k==='blank') return true; return x.n===y.n||(!!x.n&&!!y.n&&similarity(x.n,y.n)>=0.7); };
    let best=null;
    // lines skipped at the start of cur are lines cut by the edge of the photo: a complete item line (name and amount) is not skipped
    for(let j=0;j<Math.min(3,cur.length);j++){ if(j&&cur[j-1].k==='item'&&cur[j-1].a>0) break; for(let i=0;i<prev.length;i++){ let n=0; while(i+n<prev.length&&j+n<cur.length&&nm(prev[i+n],cur[j+n])) n++;
      if(n>=2&&i+n>=prev.length-1&&(!best||n>best.len)) best={i,j,len:n}; } }
    return best; }
  function taxRateIn(s){ const m=String(s||'').match(/(8|10)\s?[%％]/); return m?Number(m[1]):0; }
  function taxLine(meta,t,r,a,afterSub,li){ (meta.taxLines=meta.taxLines||[]).push({t:t==='sum'?'sum':(t==='ex'||t==='in')?t:'unknown',r:r||0,a:Math.round(Number(a)||0),s:afterSub?1:0,i:li==null?-1:li}); }   // s: printed after 小計
  // v1.10.7: the tax amounts of a receipt, from its tax lines (before, 内税 kept only its largest line, so 内税8% ¥80 + 内税10% ¥100 became ¥100).
  //   A line that names a rate is that rate's tax: different rates add up, also when their amounts are equal.
  //   The same rate printed again with the same amount is a restatement and counts once.
  //   A line without a rate that repeats the sum of the rated lines (or one of them) is their total or a restatement, not one more tax.
  //   税合計 lines never add (they only tell how much tax of unknown class is left). What cannot be told apart is flagged (taxUnsure), not guessed.
  // v1.10.11: a tax line that says neither 外 nor 内 (消費税8% ¥80) is first compared with the lines that do (外税8% ¥80), before any class is settled:
  //   it names a rate that a 外税 / 内税 line also names → the same amount is that line said again (counted once, taxRep); another amount is a
  //     contradiction that cannot be settled (kept as unknown and flagged: taxUnsure.unk = 'clash').
  //   it names a rate that no 外税 / 内税 line names → its own tax (unkParts.indep: a later step may give it the class the items show).
  //   it names no rate → the same amount as all the 外税 (or 内税) lines together is their total said again; the same amount as one rated line is
  //     most likely that line said again, but its rate is not printed - counted once and flagged ('restate'); any other amount stays unknown (loose).
  // Before, the amount left after the classes were added up was compared with nothing (外税 ¥80 + 消費税8% ¥80 became 外税 ¥160), and an unknown
  // amount equal to the 内税 amount was taken as a restatement whatever its rate (内税8% ¥80 + 消費税10% ¥80 became 内税 ¥80).
  function resolveTaxLines(meta){
    const lines=Array.isArray(meta.taxLines)?meta.taxLines:[], out={ex:0,in:0,unknown:0}, by={ex:{},in:{},unknown:{}}, uns={}, rep=[], parts={indep:0,clash:0,loose:0};
    // v1.10.7: within one class - a line that names a rate is that rate's tax (different rates add up, also when their amounts are equal); the same
    // rate printed again with the same amount is a restatement; a line without a rate that repeats the sum of the rated lines (or one of them) is not one more tax
    const classTotal=(cls,ls,flag)=>{ const rated={}, loose=[]; ls.forEach(l=>{ if(l.r){ if(rated[l.r]==null) rated[l.r]=l.a; else if(rated[l.r]!==l.a) flag('rate'); } else loose.push(l.a); });
      const rs=Object.keys(rated), sumRated=rs.reduce((s2,r)=>s2+rated[r],0); let total=sumRated, extra=0;
      if(rs.length) loose.forEach(a=>{ if(a===sumRated||rs.some(r=>rated[r]===a)) return; total+=a; extra+=a; flag('loose'); });
      else if(loose.length){ if(cls==='in'){ total=Math.max.apply(null,loose); if(loose.some(a=>a!==loose[0])) flag('loose'); } else total=loose.reduce((s2,a)=>s2+a,0); extra=total; }
      return {total,rated,extra}; };
    ['ex','in'].forEach(cls=>{ const key=cls, flag=w=>{ if(!uns[key]) uns[key]=w; }, r=classTotal(cls,lines.filter(l=>l&&l.t===cls&&l.a>0),flag); out[cls]=r.total; by[cls]=r.rated; });
    const lab=lines.filter(l=>l&&(l.t==='ex'||l.t==='in')&&l.a>0), keep=[], flagU=w=>{ if(!uns.unk) uns.unk=w; };
    lines.filter(l=>l&&l.t==='unknown'&&l.a>0).forEach(u=>{
      if(u.r){ const same=lab.filter(l=>l.r===u.r);
        if(!same.length){ keep.push(Object.assign({},u,{part:'indep'})); return; }
        const hit=same.find(l=>l.a===u.a); if(hit){ rep.push({a:u.a,r:u.r,as:hit.t,of:hit.r}); return; }
        keep.push(Object.assign({},u,{part:'clash'})); flagU('clash'); return; }
      if(!lab.length){ keep.push(Object.assign({},u,{part:'loose'})); return; }
      const tot=[['ex',out.ex],['in',out.in],['ex',out.ex+out.in]].find(x=>x[1]>0&&x[1]===u.a);
      if(tot){ const ls=lab.filter(l=>tot[1]===out.ex+out.in||l.t===tot[0]), rates=new Set(ls.map(l=>l.r||0)); rep.push({a:u.a,r:0,as:tot[0],of:0,sum:ls.length>1});
        if(rates.size===1&&!rates.has(0)&&ls.length===1&&!uns[tot[0]]) uns[tot[0]]='restate'; return; }   // one rated line said again without its rate: most likely, not certain
      keep.push(Object.assign({},u,{part:'loose'})); });
    { const ru=classTotal('unknown',keep,flagU); out.unknown=ru.total; by.unknown={};
      Object.keys(ru.rated).forEach(r=>{ const l=keep.find(x=>x.r===Number(r)), c=l&&l.part==='clash'; parts[c?'clash':'indep']+=ru.rated[r]; if(!c) by.unknown[r]=ru.rated[r]; }); parts.loose=ru.total-parts.indep-parts.clash; }   // a contradicting line gives no rate's tax
    meta.exTax=out.ex; meta.inTax=out.in; meta.inTaxMax=out.in;
    meta.unknownTax=meta.taxSum?Math.max(0,Number(meta.taxSum)-out.ex-out.in):out.unknown;
    if(meta.taxSum) { parts.indep=0; parts.clash=0; parts.loose=meta.unknownTax; }
    const tb={}; [by.ex,by.unknown].forEach(o=>Object.keys(o).forEach(r=>{ tb[r]=(tb[r]||0)+o[r]; })); if(Object.keys(tb).length) meta.taxBy=tb; else delete meta.taxBy;
    meta.inBy=by.in; meta.taxUnsure=uns; meta.exAfterSub=lines.some(l=>l&&l.t==='ex'&&l.s&&l.a>0); meta.taxRep=rep; meta.unkParts=parts;
    return meta;
  }
  // v1.10.9: which tax amounts are still unsure, as {ex|in|unk: reason}. An older value without that detail (a string, or unsure:1 in a record saved by
  // v1.10.7 / v1.10.8) stands for every tax amount there is - it is not turned into "confirmed" for want of detail.
  function taxUnsureOf(m){ const u=m&&m.taxUnsure; if(!u) return {}; if(typeof u==='object') return u; const o={}; ['ex','in','unk'].forEach(k=>{ if(taxVal(m,k)!=null) o[k]=String(u); }); return o; }
  function taxUnsureKeys(m){ const u=taxUnsureOf(m); return ['ex','in','unk','disc','sub'].filter(k=>u[k]); }   // v1.10.11: sub = the 小計 lines of the reading contradict each other   // v1.10.10: disc = a receipt-level discount seen on more than one photo that could not be told apart
  // v1.10.7: how the items are priced, from the marks printed on the item lines (外8 / 内10 / ¥330外) - counting the items without a mark too:
  //   'in' / 'ex' = every item is marked that way, 'mixed' = both marks occur, 'partIn' / 'partEx' = some items are marked and the rest are not,
  //   'none' = no item is marked. Works on items of the confirm screen (_taxMode) and of saved records (tax).
  function itemBasisOf(items){ let ex=0, inn=0, none=0; (items||[]).forEach(it=>{ if(!it) return; const md=it._taxMode||it.tax; if(md==='ex') ex++; else if(md==='in') inn++; else if(Math.round(Number(it.amount)||0)>0||String(it.name||'').trim()) none++; });
    return ex&&inn?'mixed':ex?(none?'partEx':'ex'):inn?(none?'partIn':'in'):'none'; }
  // Which way each tax amount counts is settled once, from what the receipt says - never from which sum happens to agree (v1.10.6).
  //   外税 line → added to the item prices. 内税 line → already inside the prices. A tax line that says neither → unknown.
  //   The marks on the item lines outrank the label of the tax line, but only when EVERY item carries the mark (v1.10.7): with all items priced
  //   without tax (外) and no 外税 line, a line such as 内消費税 is the tax contained in the total and is added; with all items priced with tax (内),
  //   an unlabeled tax line is the tax inside the prices. A mark on only some of the items says nothing about the others.
  function normalizeTaxMeta(meta,items){
    if(!meta) return meta;
    const basis=itemBasisOf(items), est=!!meta.exTaxFromTotal, src={}, why={}, uns=Object.assign({},taxUnsureOf(meta)), mv=(a,b)=>{ if(uns[a]){ if(!uns[b]) uns[b]=uns[a]; delete uns[a]; } };
    let ex=Math.round(Number(meta.exTax)||0), inn=Math.round(Number(meta.inTaxMax)||Number(meta.inTax)||0), unk=Math.round(Number(meta.unknownTax)||0);
    // v1.10.11: which part of the unknown amount may take the class the items show. A line that contradicts a 外税 / 内税 line of its rate (clash)
    // never does. A line of a rate no 外税 / 内税 line names is its own tax (indep). A line without a rate that is no restatement (loose) is added
    // too, but flagged - nothing tells what it is. (Before, the whole unknown amount was added: 外税 ¥80 + 消費税8% ¥80 became 外税 ¥160.)
    const P=meta.unkParts&&typeof meta.unkParts==='object'?meta.unkParts:{indep:0,clash:0,loose:unk}, clash=Math.min(unk,Math.round(Number(P.clash)||0)), movable=Math.max(0,unk-clash), loose=Math.min(movable,Math.round(Number(P.loose)||0));
    if(ex>0){ src.ex=est?'est':'read'; why.ex=est?'total':'label';
      // v1.10.10: with every item priced without tax (外), a tax line that says neither 外 nor 内 is added as well - by the items' marks (label+items)
      if(basis==='ex'&&movable>0){ ex+=movable; unk-=movable; if(!unk) mv('unk','ex'); if(loose>0&&!uns.ex) uns.ex='loose'; if(why.ex==='label') why.ex='label+items'; } }
    else if(basis==='ex'&&(inn>0||unk>0)){ if(inn>0){ ex=inn; inn=0; meta.inTax=0; mv('in','ex'); if(meta.inBy&&Object.keys(meta.inBy).length) meta.taxBy=Object.assign({},meta.inBy); } else if(movable>0){ ex=movable; unk-=movable; if(!unk) mv('unk','ex'); } if(ex>0){ src.ex='read'; why.ex='items'; } }
    // every item priced with tax (内): an unlabeled tax line is the tax inside the prices. A line of its own rate is added (内税8% ¥80 + 消費税10% ¥80
    // = ¥160; v1.10.11 - before, the same amount was taken as a restatement whatever the rate). A line without a rate next to a 内税 amount is
    // added and flagged as unsure. A restatement was already set aside (taxRep).
    if(basis==='in'&&movable>0){ const had=inn>0; inn+=movable; meta.inTax=inn; if(had&&loose>0&&!uns.in) uns.in='loose'; unk-=movable; if(!unk) mv('unk','in'); why.in='items'; }
    if(inn>0) src.in='read'; if(unk>0) src.unk='read'; if(Number(meta.receiptDiscount)>0) src.disc='read';
    meta.exTax=ex; meta.inTaxMax=inn; meta.unknownTax=unk; meta.itemBasis=basis; meta.taxSrc=src; meta.taxWhy=why; meta.taxUnsure=uns;   // the unsure note goes with its amount
    return meta;
  }
  // Pure evaluation of the item-sum vs receipt-total check. Never modifies amounts.
  // Every figure takes part in the class it has (v1.10.5), and the class is never chosen by which sum agrees (v1.10.6):
  //   外税 is always added; a receipt-level discount is always subtracted; 内税 is inside the prices and is never added
  //   (when adding it would give the total, that is only reported: inWouldFit);
  //   a tax amount whose class is unknown is tried both ways - a sum that agrees is reported with classUnknown, so the screen can say
  //   that the amounts agree while the class is still open. conflict: 外税 on a receipt whose items are all marked as priced with tax.
  // Agreement is exact (no ±1). When nothing agrees, the reading nearest to the total is reported with what is left over (resid).
  function sumCheckInfo(itemSum,total,meta,totalSource){
    const m=meta||{}; itemSum=Math.round(Number(itemSum)||0); total=Math.round(Number(total)||0);
    if(!itemSum&&!total) return {level:'empty'};
    if(!total) return {level:'noTotal',itemSum};
    if(totalSource==='items') return {level:'noTotal',itemSum,total};
    const diff=itemSum-total;
    const ex=Number(m.exTax)||0, unk=Number(m.unknownTax)||0, disc=Number(m.receiptDiscount)||0, inT=Number(m.inTaxMax)||Number(m.inTax)||0;
    const est=!!(ex&&(m.taxSrc?m.taxSrc.ex==='est':m.exTaxFromTotal)), extra={};
    const D=disc?[['−','値引',disc]]:[], cands=[];
    // v1.10.10: a tax amount whose class is unknown always takes part - also when a 外税 amount exists. (Before, it was left out whenever a 外税
    // amount existed: a total that ignored it was called 一致 and offered as the amount to apply.) Both readings are tried - the amount is inside
    // the prices, or it is added on top - and neither settles the class: a hit is reported as not settled (classUnknown), a miss offers no candidate.
    const E=ex?[['＋',est?'外税（推定）':'外税',ex]]:[];
    if(unk){ cands.push({v:itemSum+ex-disc,parts:E.concat(D),unkAs:'in'}); cands.push({v:itemSum+ex+unk-disc,parts:E.concat([['＋','消費税',unk]],D),unkAs:'ex'}); }
    else cands.push({v:itemSum+ex-disc,parts:E.concat(D)});
    if(est) extra.estimated=true;
    if(ex&&m.itemBasis==='in') extra.conflict='exOnInItems';   // only when every item is marked as priced with tax (v1.10.7)
    if(taxUnsureKeys(m).length||cancelOpenOf(m).length) extra.unsure=true;   // v1.10.17: an open 取消 / 返品 line too
    const hit=cands.find(c=>c.v===total);
    if(hit){ if(hit.unkAs) extra.classUnknown=hit.unkAs; return Object.assign(hit.parts.length?{level:'explained',itemSum,total,diff,parts:hit.parts}:{level:'ok',itemSum,total,diff},extra); }
    const near=cands.reduce((a,c)=>Math.abs(total-c.v)<Math.abs(total-a.v)?c:a), resid=total-near.v;
    if(!ex&&!unk&&inT&&itemSum+inT-disc===total) extra.inWouldFit=inT;
    return Object.assign({level:Math.abs(resid)<=10?'small':'large',itemSum,total,diff,expect:near.v,resid,parts:near.parts,ambiguous:cands.length>1,direction:resid<0?'more':'less'},extra);
  }
  // ---- v1.10.6: tax and discount kept with a record, and the panel 「税・値引きを確認／修正」 (confirm screen and saved-record editor) ----
  const TAX_SRCS=['read','est','manual','confirmed','calc'];
  const TAX_SRC_LABEL={read:'読み取り',est:'推定（合計と小計の差）',manual:'手動で修正',confirmed:'確認済み（手動で確定）',calc:'明細の変更に合わせて計算','':'取得方法の記録なし'};
  const TAX_KEYS={ex:'exTax',in:'inTaxMax',unk:'unknownTax',disc:'receiptDiscount'};
  const taxByHand=s=>s==='manual'||s==='confirmed';
  // the amount of one field: null = nothing there (blank); 0 only when the person entered an explicit 0
  function taxVal(m,k){ const v=m?m[TAX_KEYS[k]]:null; if(v==null||v==='') return null; const r=Math.round(Number(v)); if(!isFinite(r)||r<0||r>100000000) return null; return (r>0||taxByHand(m.taxSrc&&m.taxSrc[k]))?r:null; }
  // a saved record → the same shape the confirm screen works with. A record without taxMeta (saved before v1.10.6) has no source information.
  function taxMetaOfRecord(x){
    const tm=x&&x.taxMeta&&typeof x.taxMeta==='object'&&!Array.isArray(x.taxMeta)?x.taxMeta:null, S=k=>tm&&TAX_SRCS.includes(tm[k])?tm[k]:'';
    const m={exTax:x?x.exTax:null,inTaxMax:x?x.inTax:null,unknownTax:x?x.unkTax:null,receiptDiscount:x?x.discount:null,taxSrc:{ex:S('ex'),in:S('in'),unk:S('unk'),disc:S('disc')}};
    const ex=taxVal(m,'ex'), inn=taxVal(m,'in'), unk=taxVal(m,'unk'), dc=taxVal(m,'disc');
    // v1.10.7: fmt 2 = saved with the marks of each item (items[].tax), so the scope of the evidence is known exactly and follows the items.
    // fmt 1 (v1.10.6) only kept one word for the whole record, counted over the marked items alone: 'in' / 'ex' there mean "at least some items".
    // fmt 0 = no taxMeta. No per-item information is made up for fmt 0 / 1.
    const fmt=!tm?0:Number(tm.v)>=2?2:1, itemsV1=fmt===1&&['ex','in','mixed'].includes(tm.items)?tm.items:'';
    return {exTax:ex,inTaxMax:inn,inTax:inn||0,unknownTax:unk>0?unk:null,receiptDiscount:dc,taxSrc:{ex:ex!=null?S('ex'):'',in:inn!=null?S('in'):'',unk:unk>0?S('unk'):'',disc:dc!=null?S('disc'):''},
      taxWhy:{ex:tm&&['label','items','label+items','total','manual'].includes(tm.exWhy)?tm.exWhy:'',in:tm&&['items','manual'].includes(tm.inWhy)?tm.inWhy:''},
      fmt,itemsV1,itemBasis:fmt===2?itemBasisOf(x.items):({in:'partIn',ex:'partEx',mixed:'mixed'}[itemsV1]||'none'),taxUnsure:(()=>{ const o={}, has={ex:ex!=null,in:inn!=null,unk:unk>0,disc:dc!=null}, un=tm?tm.unsure:null; (Array.isArray(un)?un.filter(k=>['ex','in','unk','disc','sub'].includes(k)):un?['ex','in','unk']:[]).forEach(k=>{ if(has[k]||k==='sub') o[k]=k==='disc'&&tm&&tm.discOpen==='point'?'point':'saved'; }); return o; })(),exTaxFromTotal:S('ex')==='est',legacy:!tm,   // v1.10.15: discOpen 'point' = a point discount after the total that the amount paid did not confirm
      subConflict:tm&&typeof tm.subConflict==='string'?tm.subConflict.slice(0,80):'',...(()=>{ const sc=subCandsRead(tm); return {subCands:sc?sc.list:null,subFull:!sc?false:sc.comp==='full'?true:sc.comp==='part'?false:'unknown'}; })(),
      taxFor:tm&&Number.isInteger(tm.taxFor)&&tm.taxFor>0&&tm.taxFor<=100000000?tm.taxFor:null,taxForMix:tm&&Number.isInteger(tm.taxFor)&&validTaxMix(tm.taxForMix)?tm.taxForMix:null,
      taxForRows:taxRowsRead(tm&&tm.taxForRows),taxRowsUnknown:taxRowsUnknownOf(tm,x&&x.items,ex,unk),
      rate1:tm&&(tm.rate1===8||tm.rate1===10)?tm.rate1:null,cancelOpen:tm?cancelOpenOf(tm):[],addMark:!!(tm&&tm.addMark===1)};   // v1.10.19: addMark = saved by a version that keeps the mark of items added by hand (items[].added)   // v1.10.17: rate1 = the only tax rate printed on the receipt (the rate of items without a mark); cancelOpen = 取消 / 返品 lines not settled   // v1.10.15: taxForMix = the items the tax was read for, by tax mark and rate   // v1.10.13: subFull = the kept 小計 lines are all of them; taxFor = the item sum the tax amounts were read for (only when the record's items were changed from it)   // v1.10.11: sub is only there when it was saved - never made up for older records   // unsure: per tax (v1.10.9); 1 from v1.10.7 / v1.10.8 = every tax amount of the record
  }
  // v1.10.12: the 小計 lines compared at reading, kept with a record whose contradiction is still open (taxMeta.subCands), so that correcting the tax of
  // the record can settle it as on the confirm screen. Only well-formed entries are taken; a record without them (older versions) gets none.
  // v1.10.13: whether the kept lines are all the lines that were read (full). v1.10.12 kept the first 4 lines only (税抜小計 ¥900 then 税込小計 ¥1,080 ×4
  // kept the four 税込 lines, and the record looked consistent): a list written without taxMeta.subFull that has 4 entries may have been cut and is
  // not full. An entry that is not well-formed, or one past the limit, also makes the list not full. A list that is not full can still show a
  // contradiction, but it is never taken as proof that the lines agree (subConflictNow).
  const SUB_MAX=8;
  function subCandOk(c){ return !!c&&typeof c==='object'&&Number.isInteger(c.a)&&c.a>0&&c.a<=100000000&&Number.isInteger(c.dA||0)&&(c.dA||0)>=0&&(c.dA||0)<=100000000&&['ex','in'].includes(c.basis)&&['label','items','taxline','notax'].includes(c.by); }
  function subCandsRead(tm){ const cs=tm&&Array.isArray(tm.unsure)&&tm.unsure.includes('sub')&&Array.isArray(tm.subCands)?tm.subCands:null; if(!cs) return null;
    const list=cs.slice(0,SUB_MAX).filter(subCandOk).map(c=>Object.assign({a:c.a,dA:c.dA||0,basis:c.basis,by:c.by},typeof c.label==='string'&&c.label?{label:c.label.slice(0,16)}:{}));
    if(list.length<2) return null;
    // v1.10.15: three states, written as subFull 1 / 0 / -1 from this version on. Without subFull: 4 or more lines (v1.10.12 kept the first 4) → some may be
    // missing; fewer lines with a line printed twice (only v1.10.12 kept repeats, and its list was cut at 4) → all of them; otherwise it is not known:
    // v1.10.13 / v1.10.14 wrote a list that was not full without subFull, and the backup of the request (4 lines) became 2 lines of that kind on restore.
    const whole=list.length===cs.length, dup=new Set(cs.map(c=>c&&[c.a,c.dA||0,c.basis,c.by,c.label||''].join('|'))).size<cs.length;
    const comp=!whole?'part':tm.subFull===1?'full':tm.subFull===0?'part':tm.subFull===-1?'unknown':list.length>=4?'part':(dup&&cs.every(c=>!c.label))?'full':'unknown';
    return {list,comp}; }
  // v1.10.13: the 小計 lines written to a record. The same line printed again (the same amount, discounts after it, 税込/税抜, reason and label) is kept
  // once - it says nothing new. Lines that differ in anything that decides how they count (a 税込 and a 税抜 line of the same amount, other
  // discounts after them) are never merged. Only when more than SUB_MAX different lines remain is the list cut, and then every amount the lines come
  // to with the tax of the record is kept first, so the contradiction stays visible; such a list is written as not full.
  function subCandsForSave(cs,comp,m){
    const norm=(cs||[]).map(c=>c&&({a:Math.round(Number(c.a)||0),dA:Math.round(Number(c.dA)||0),basis:c.basis,by:c.by,label:typeof c.label==='string'?c.label.slice(0,16):''})).filter(subCandOk);
    let ok=comp==='full'&&norm.length===(cs||[]).length; const seen=new Set(), uniq=[];   // v1.10.15: taking out the lines printed again never makes a list full
    norm.forEach(c=>{ const k=[c.a,c.dA,c.basis,c.by,c.label].join('|'); if(!seen.has(k)){ seen.add(k); uniq.push(c); } });
    let out=uniq;
    if(uniq.length>SUB_MAX){ const X=taxVal(m,'ex')||0, N=taxVal(m,'in')||0, U=taxVal(m,'unk')||0, jk=c=>[c.a,c.dA,c.basis,c.by==='label'?'label':(c.by==='items'||c.by==='taxline')?'ex':'0'].join('|');
      const pick=[], has=new Set(), byEst=new Set(), byKey=new Set(), add=c=>{ if(pick.length<SUB_MAX&&!has.has(c)){ has.add(c); pick.push(c); } };
      uniq.forEach(c=>{ const e=subEst(c,X,N,U); if(!byEst.has(e)){ byEst.add(e); add(c); } });   // every amount the lines come to
      uniq.forEach(c=>{ const k=jk(c); if(!byKey.has(k)){ byKey.add(k); add(c); } });   // every way of counting
      const keys=new Set(uniq.map(jk)); if(pick.length>=SUB_MAX&&[...keys].some(k=>!pick.some(c=>jk(c)===k))) ok=false;
      uniq.forEach(add); out=uniq.filter(c=>has.has(c)); }
    return {list:out.map(c=>Object.assign({a:c.a,dA:c.dA,basis:c.basis,by:c.by},c.label?{label:c.label}:{})),comp:ok?'full':comp==='unknown'&&uniq.length<=SUB_MAX?'unknown':'part'}; }   // a list that was cut here is missing lines
  // the fields written to a record: each amount in the class it has, how it was obtained, and what the class rests on
  function taxFieldsForSave(m){
    const S=(m&&m.taxSrc)||{}, W=(m&&m.taxWhy)||{}, fields={}, fmt=m&&m.fmt===1?1:2, tm={v:fmt};
    const ex=taxVal(m,'ex'), inn=taxVal(m,'in'), unk=taxVal(m,'unk'), dc=taxVal(m,'disc');
    if(ex!=null){ fields.exTax=ex; if(TAX_SRCS.includes(S.ex)) tm.ex=S.ex; if(W.ex) tm.exWhy=W.ex; }
    if(inn!=null){ fields.inTax=inn; if(TAX_SRCS.includes(S.in)) tm.in=S.in; if(W.in) tm.inWhy=W.in; }
    if(unk>0){ fields.unkTax=unk; if(TAX_SRCS.includes(S.unk)) tm.unk=S.unk; }
    if(dc!=null){ fields.discount=dc; if(TAX_SRCS.includes(S.disc)) tm.disc=S.disc; }
    if(fmt===1){ if(m.itemsV1) tm.items=m.itemsV1; } else if(m&&['ex','in','mixed','partIn','partEx'].includes(m.itemBasis)) tm.items=m.itemBasis;
    { const uk=taxUnsureKeys(m||{}).filter(k=>({ex:ex!=null,in:inn!=null,unk:unk>0,disc:dc!=null,sub:true})[k]); if(uk.length) tm.unsure=uk; if(uk.includes('sub')&&m.subConflict) tm.subConflict=String(m.subConflict).slice(0,80);
      if(uk.includes('sub')&&Array.isArray(m.subCands)&&m.subCands.length>=2){ const sc=subCandsForSave(m.subCands,subComp(m),m); if(sc.list.length>=2){ tm.subCands=sc.list; tm.subFull=sc.comp==='full'?1:sc.comp==='part'?0:-1; } }   // v1.10.15: always written (1 all / 0 some missing / -1 not known) - leaving it out lost the difference
      if(uk.includes('disc')&&taxUnsureOf(m).disc==='point') tm.discOpen='point'; }   // v1.10.13: every different 小計 line (not the first 4), and whether they are all of them   // v1.10.12   // v1.10.11: an open contradiction of the 小計 lines is kept with the record (and what it was)   // v1.10.9: which tax amounts are still unsure
    if(Number.isInteger(m&&m.taxFor)&&m.taxFor>0&&(ex>0||unk>0)){ tm.taxFor=m.taxFor; if(validTaxMix(m.taxForMix)) tm.taxForMix=m.taxForMix; }
    if(ex!=null||unk>0){ const rows=taxRowsRead(m&&m.taxForRows); if(rows) tm.taxForRows=rows; if(m&&m.taxRowsUnknown||(m&&m.taxForRows!=null&&!rows)) tm.taxRowsUnknown=1; }
    // v1.10.17: the only rate printed on the receipt (the tax of items without a mark can then be calculated in the editor, as on the confirm screen),
    // and the 取消 / 返品 lines whose item is not settled (they stay open after saving, reloading and restoring a backup)
    { const r1=m&&(m.rate1===8||m.rate1===10)?m.rate1:oneRateOf(m); if(r1&&ex>0) tm.rate1=r1; const co=cancelOpenOf(m); if(co.length) tm.cancelOpen=co; }
    // v1.10.19: the items added by hand carry their mark (items[].added) in this record. Not written for a record of an earlier version whose 外税 still
    // belongs to the items it was saved with there (taxFor): which of those items were added by hand was not kept, so it stays unknown (addMark false).
    if(!m||m.addMark!==false) tm.addMark=1;   // v1.10.15: and the items by tax mark and rate   // v1.10.13: the tax amounts belong to items of this sum, not to the items saved with them
    return {fields,taxMeta:tm};
  }
  // the mark of one item as it is saved with a record (v1.10.7): tax = 'in' / 'ex', rate = 8 / 10 - only what the receipt printed
  // v1.10.15: the items a tax amount belongs to, by what decides the tax - the tax mark and rate of each item: 'ex8:1000,ex10:2000'. The item sum alone
  // does not say it: after 1 × ¥1,000 (8%) and 2 × ¥1,000 (10%) became 2 × ¥1,000 (8%) and 1 × ¥1,000 (10%), the sum was still ¥3,000 and the 外税 ¥280
  // of the reading was taken as the tax of the new items (the record showed 一致 instead of the ¥20 difference).
  // v1.10.19: an item added by hand is 'add' - not '-'. Before, it went with the items of the receipt that had no mark ('-'), so 牛乳 ¥500 ＋ 洗剤 ¥500 (added)
  // came to the same '-:1000' as the 牛乳 ¥1,000 that was read: the 外税 of the reading was taken as the tax of these items (一致), and a record saved with
  // 洗剤 had its tax calculated at the receipt's only rate (8%) as if 洗剤 had been read from the receipt.
  function taxMixOf(its){ const o={}; (its||[]).forEach(it=>{ const a=Math.round(Number(it&&it.amount)||0); if(!(a>0)) return; const f=itemTaxFields(it), k=f.added?'add':(((f.tax||'')+(f.rate||''))||'-'); o[k]=(o[k]||0)+a; }); return Object.keys(o).sort().map(k=>`${k}:${o[k]}`).join(','); }
  // v1.10.15: the tax kept with a record belongs to other items than the ones saved with it (another item sum, or the same sum with other amounts per rate)
  // v1.10.17: the only tax rate printed on the receipt (外税8% ¥80 and no other rate): the confirm screen uses it for items without a mark (single)
  function oneRateOf(m){ const by=(m&&m.taxBy)||{}, r=Object.keys(by).filter(k=>Number(by[k])>0).map(Number); return r.length===1&&(r[0]===8||r[0]===10)?r[0]:0; }
  // v1.10.17: 取消 / 返品 lines whose item is not settled (parseReceipt / mergeReceiptPages: cancelTarget). w = 'amb' several items fit, 'rel' only a
  // similar name fits, 'other' only items of another name have the amount, 'none' no item of the amount was found (the line is counted as a discount).
  // They stay with the record (taxMeta.cancelOpen) until the person removes the item or confirms the line: the sums agreeing never settles them.
  const CANCEL_W=['amb','rel','other','none','qty'];   // v1.10.18: 'qty' = an item of the name whose count and unit price do not give the line (a part of it, but how much is not known)
  function cancelOpenOf(m){ const a=m&&Array.isArray(m.cancelOpen)?m.cancelOpen:[]; return a.slice(0,8).filter(o=>o&&typeof o==='object'&&Number.isInteger(o.a)&&o.a>0&&o.a<=100000000&&CANCEL_W.includes(o.w))
    .map(o=>({n:typeof o.n==='string'?o.n.slice(0,40):'',a:o.a,w:o.w,c:Array.isArray(o.c)?o.c.filter(x=>typeof x==='string'&&x).map(x=>x.slice(0,40)).slice(0,4):[],word:typeof o.word==='string'&&RE_CANCEL.test(o.word)?o.word.slice(0,6):'取消'})); }
  function cancelOpenNote(m){ const co=cancelOpenOf(m); if(!co.length) return '';
    return co.map(o=>{ const L=`「${o.word}${o.n?' '+o.n:''} −${yen(o.a)}」`, cs=o.c.length?`（${o.c.join('・')}）`:'';
      if(o.w==='none') return `${L}の対象の商品が明細に見つからないため、値引として ${yen(o.a)} を引いています。取り消された商品が明細に残っていないか、レシートで確かめてください。`;
      if(o.w==='amb') return `${L}の対象を、候補の商品${cs}から1つに決められないため、どれも明細から外していません。取り消された商品を×で外してください（数量の一部の取消なら、その商品の金額を直してください）。`;
      if(o.w==='qty') return `${L}は、同じ名前の商品${cs}の一部の取消とみられますが、数量・単価と取消の金額が合わない（または数量・単価が読み取れていない）ため、明細を変えていません。レシートで数量と金額を確かめて、その商品の金額を直してください。`;   // v1.10.18
      if(o.w==='rel') return `${L}と同じ名前の商品がなく、名前の似た商品${cs}を取り消してよいか判断できないため、明細から外していません。取り消された商品なら×で外してください。`;
      return `${L}と同じ名前の商品がありません。同じ金額の商品${cs}は名前が違うため、明細から外していません。取り消された商品なら×で外してください。`; }).join('')+'外す商品がないことを確かめたら「取消を確認済みにする」を押してください。'; }
  // the person removed an item: an open 取消 line of its amount that it fits is settled (an 'none' line is a discount and stays)
  function cancelResolveDel(m,it){ if(!m||!it) return false; const co=cancelOpenOf(m), a=Math.round(Number(it.amount)||0), k=nameKey(it.name||'');
    const i=co.findIndex(o=>o.w!=='none'&&o.a===a&&(!o.c.length||o.c.some(n=>nameKey(n)===k)||(o.n&&nameKey(o.n)===k))); if(i<0) return false; co.splice(i,1); m.cancelOpen=co; return true; }
  function recordTaxStale(m,items){ if(taxBindingStale(m,items)) return true; const tf=Number(m&&m.taxFor)||0, taxAmt=(Number(m&&m.exTax)||0)+(Number(m&&m.unknownTax)||0); if(!(tf>0&&taxAmt>0)) return false;
    const sum=(items||[]).reduce((t,x)=>t+(Number(x.amount)||0),0); return tf!==sum||(validTaxMix(m.taxForMix)&&m.taxForMix!==taxMixOf(items)); }
  function validTaxMix(v){ return typeof v==='string'&&v.length<=200&&/^(?:-|add|(?:ex|in)(?:8|10)?|8|10):\d{1,9}(?:,(?:-|add|(?:ex|in)(?:8|10)?|8|10):\d{1,9}){0,9}$/.test(v); }   // v1.10.19: 'add'
  function taxMixText(v){ return String(v||'').split(',').filter(Boolean).map(p=>{ const [k,a]=p.split(':'); if(k==='add') return `追加した商品（税率不明） ${yen(Number(a))}`; const r=k==='-'?'':k.replace(/^(ex|in)/,''), md=/^ex/.test(k)?'外':/^in/.test(k)?'内':''; return `${md}${r?r+'%':k==='-'?'税率の表示なし':''} ${yen(Number(a))}`; }).join('・'); }   // v1.10.17: an item without a mark was shown as 「-%」
  // v1.10.19: an item added by hand is saved with added: 1 (it has no tax mark or rate from the receipt, and the receipt's rate is not taken for it).
  // Before, the mark was only kept on the screen (_added) and was lost on saving: after reloading, the item looked like one read from the receipt.
  function isAdded(it){ return !!it&&(it._added===true||it.added===1||it.added===true); }
  function itemTaxFields(it){ const md=it&&(it._taxMode||it.tax), r=Number(it&&(it._taxRate||it.rate)), o={}; if(validRowId(it&&it.rowId)) o.rowId=it.rowId; if(isAdded(it)) return Object.assign(o,{added:1}); if(md==='in'||md==='ex') o.tax=md; if(r===8||r===10) o.rate=r; return o; }
  // v1.10.20: tax amounts keep the identity and amount of each row they belong to. Names, categories and order do not decide this identity.
  // Never reconstruct an old allocation from names, row positions or an aggregate added-item sum. Malformed/incomplete evidence stays unknown.
  function validRowId(id){ return typeof id==='string'&&/^[A-Za-z0-9_.:-]{1,80}$/.test(id); }
  function ensureRowIds(items){ const seen=new Set(); (items||[]).forEach(it=>{ if(!validRowId(it.rowId)||seen.has(it.rowId)) it.rowId=uid(); seen.add(it.rowId); }); }
  function taxRowKind(it){ const f=itemTaxFields(it); return f.added?'add':((f.tax||'')+(f.rate||''))||'-'; }
  function taxRowsRead(rows){ if(!Array.isArray(rows)||rows.length>2000) return null; const seen=new Set(), out=[];
    for(const r of rows){ if(!r||typeof r!=='object'||!validRowId(r.id)||seen.has(r.id)||!Number.isInteger(r.a)||r.a<=0||r.a>100000000||!['-','add','ex','in','8','10','ex8','ex10','in8','in10'].includes(r.k)) return null; seen.add(r.id); out.push({id:r.id,a:r.a,k:r.k}); }
    return out.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0); }
  function taxRowsOf(items){ return taxRowsRead((items||[]).filter(it=>Number(it.amount)>0).map(it=>({id:it.rowId,a:Math.round(Number(it.amount)),k:taxRowKind(it)}))); }
  function sameTaxRows(a,b){ const x=taxRowsRead(a), y=taxRowsRead(b); return !!x&&!!y&&JSON.stringify(x)===JSON.stringify(y); }
  function rowsHaveAdded(rows){ return !!rows&&rows.some(r=>r.k==='add'); }
  function taxRowsUnknownOf(tm,items,ex,unk){ if(ex==null&&!(unk>0)) return false; const rows=taxRowsRead(tm&&tm.taxForRows);
    return !!(tm&&tm.taxRowsUnknown)||(tm&&tm.taxForRows!=null&&(!rows||!taxRowsOf(items)))||(!rows&&(items||[]).some(isAdded)); }
  function bindTaxRows(m,items){ ensureRowIds(items); m.taxForRows=taxRowsOf(items); delete m.taxRowsUnknown; }
  function taxBindingStale(m,items){ if(!m||(taxVal(m,'ex')==null&&!(taxVal(m,'unk')>0))) return false; if(m.taxRowsUnknown) return true;
    const rows=taxRowsRead(m.taxForRows); return !!rows&&!sameTaxRows(rows,taxRowsOf(items))&&(taxVal(m,'ex')>0||taxVal(m,'unk')>0||rowsHaveAdded(rows)||(items||[]).some(isAdded)); }
  // an amount typed into the panel: blank = no amount (null), 0 = an explicit zero. Negative, non-numeric and too-large input is refused.
  function parseAmountField(str,max,label){
    const s=String(str==null?'':str).replace(/[０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-65248)).replace(/[\s,，¥￥円]/g,'');
    if(s==='') return {ok:true,value:null};
    if(!/^\d{1,9}$/.test(s)) return {ok:false,msg:`${label}は0以上の整数で入力してください（マイナス・小数・記号は使えません）。`};
    const v=Number(s); if(isFinite(max)&&max>0&&v>max) return {ok:false,msg:`${label} ${yen(v)} は明細合計（${yen(max)}）を超えています。入力を確認してください。`};
    return {ok:true,value:v};
  }
  // v1.10.8: the whole tax state is taken and put back together - the amounts, how each was obtained, why it counts the way it does, what is an
  // estimate, and what is still unsure (taxUnsure). Before, only the amounts and part of this came back, so 「読み取った値に戻す」 turned a reading
  // that still had to be confirmed into a plain 一致.
  const TAX_STATE_KEYS=['exTax','inTax','inTaxMax','unknownTax','receiptDiscount'];
  function taxSnapshot(m){ const s={}; TAX_STATE_KEYS.forEach(k=>{ s[k]=m[k]; }); s.exTaxFromTotal=!!m.exTaxFromTotal; s.taxUnsure=Object.assign({},taxUnsureOf(m)); s.subBasisUnknown=!!m.subBasisUnknown; s.subChecked=!!m.subChecked;
    s.taxSrc=Object.assign({},m.taxSrc); s.taxWhy=Object.assign({},m.taxWhy); s.taxBy=m.taxBy?Object.assign({},m.taxBy):null; s.inBy=m.inBy?Object.assign({},m.inBy):null; s.taxFor=m.taxFor||null; s.taxForMix=m.taxForMix||null; s.taxForRows=taxRowsRead(m.taxForRows); s.taxRowsUnknown=!!m.taxRowsUnknown; return s; }
  function taxRestore(m,s){ TAX_STATE_KEYS.forEach(k=>{ m[k]=s[k]; }); m.exTaxFromTotal=!!s.exTaxFromTotal; m.taxUnsure=Object.assign({},taxUnsureOf(s)); m.subBasisUnknown=!!s.subBasisUnknown; m.subChecked=!!s.subChecked;
    m.taxSrc=Object.assign({},s.taxSrc); m.taxWhy=Object.assign({},s.taxWhy); if(s.taxBy) m.taxBy=Object.assign({},s.taxBy); else delete m.taxBy; if(s.inBy) m.inBy=Object.assign({},s.inBy); else delete m.inBy; if(s.taxFor) m.taxFor=s.taxFor; else delete m.taxFor; if(s.taxForMix) m.taxForMix=s.taxForMix; else delete m.taxForMix; m.taxForRows=taxRowsRead(s.taxForRows); m.taxRowsUnknown=!!s.taxRowsUnknown; }
  // the same or not: amounts, sources, the reason for the class, estimate and unsure state (so a confirmation alone can also be taken back)
  function taxDiffers(m,s){ const n=o=>JSON.stringify([['ex','in','unk','disc'].map(k=>[taxVal(o,k),(o.taxSrc||{})[k]||'']),(o.taxWhy||{}).ex||'',(o.taxWhy||{}).in||'',taxUnsureKeys(o),o.exTaxFromTotal?1:0,taxRowsRead(o.taxForRows),!!o.taxRowsUnknown]); return n(m)!==n(s); }
  function taxSetAmount(m,k,value){ m.taxSrc=Object.assign({},m.taxSrc); m.taxWhy=Object.assign({},m.taxWhy); m[TAX_KEYS[k]]=value; m.taxSrc[k]='manual'; { const u=Object.assign({},taxUnsureOf(m)); delete u[k]; m.taxUnsure=u; }   // v1.10.9: only the unsure note of this tax is settled by changing it
    if(k==='in') m.inTax=value||0; if(k==='ex'){ m.exTaxFromTotal=false; m.taxWhy.ex='manual'; } }
  // the person says which way an unknown tax amount counts: the amount stays as read, the class is theirs. An unsure note goes along with the amount.
  function taxSetUnkKind(m,kind){ const u=taxVal(m,'unk'); if(!(u>0)) return; m.taxSrc=Object.assign({},m.taxSrc); m.taxWhy=Object.assign({},m.taxWhy); const s=m.taxSrc.unk||'', un=Object.assign({},taxUnsureOf(m)), to=kind==='ex'?'ex':'in';
    if(kind==='ex'){ m.exTax=(taxVal(m,'ex')||0)+u; m.taxSrc.ex=s; m.taxWhy.ex='manual'; m.exTaxFromTotal=false; }
    else { m.inTaxMax=(taxVal(m,'in')||0)+u; m.inTax=m.inTaxMax; m.taxSrc.in=s; m.taxWhy.in='manual'; }
    if(un.unk){ if(!un[to]) un[to]=un.unk; delete un.unk; } m.taxUnsure=un; m.unknownTax=null; m.taxSrc.unk=''; }
  // the person checked the receipt: an estimated 外税 becomes confirmed, and every tax amount that was still unsure is taken as it stands
  function taxConfirmEst(m){ m.taxSrc=Object.assign({},m.taxSrc); m.taxWhy=Object.assign({},m.taxWhy);
    if(m.taxSrc.ex==='est'){ m.taxSrc.ex='confirmed'; m.taxWhy.ex='manual'; m.exTaxFromTotal=false; }
    taxUnsureKeys(m).forEach(k=>{ if(k==='sub') m.subChecked=true; else if(taxVal(m,k)!=null) m.taxSrc[k]='confirmed'; }); m.taxUnsure={}; }   // v1.10.11: the 小計 lines are confirmed as checked
  function taxSrcText(m,k){ const S=m.taxSrc||{}, W=m.taxWhy||{}; let t=TAX_SRC_LABEL[S[k]||'']||TAX_SRC_LABEL[''];
    if(k==='ex'&&W.ex==='items') t+='・商品に「外」（税抜）の表示があるため加算'; else if(k==='ex'&&W.ex==='label+items') t+='・外税の行と、区分の書かれていない消費税の行の合計（商品に「外」（税抜）の表示があるため加算）'; else if(k==='ex'&&W.ex==='manual'&&!taxByHand(S.ex)) t+='・外税として扱うと手動で指定';
    if(k==='in'&&W.in==='items') t+='・商品に「内」（税込）の表示があるため含む'; else if(k==='in'&&W.in==='manual'&&!taxByHand(S.in)) t+='・内税として扱うと手動で指定';
    // v1.10.11: a tax line that said the same tax again was counted once - which line, so the person can check it against the receipt
    if((k==='ex'||k==='in')&&S[k]==='read'&&Array.isArray(m.taxRep)){ const rs=m.taxRep.filter(r=>r&&r.as===k); if(rs.length) t+='・'+rs.map(r=>`消費税${r.r?r.r+'%':''} ${yen(r.a)} は${r.sum?'税額の合計':'同じ税'}の再掲として1回だけ数えています`).join('・'); }
    return t; }
  function taxSummaryText(m){ const S=m.taxSrc||{}, out=[], ex=taxVal(m,'ex'), inn=taxVal(m,'in'), unk=taxVal(m,'unk'), dc=taxVal(m,'disc');
    if(ex!=null) out.push(`外税${S.ex==='est'?'（推定）':''} ${yen(ex)}`); if(inn!=null) out.push(`内税 ${yen(inn)}`); if(unk>0) out.push(`消費税 ${yen(unk)}（区分不明）`); if(dc!=null) out.push(`値引 ${yen(dc)}`);
    return out.length?out.join('・'):'税・値引なし'; }
  function taxPanelHtml(p){
    const inp=(k,id)=>`<input id="${p}Tax${id}" type="text" inputmode="numeric" autocomplete="off" maxlength="12" placeholder="なし" data-tax="${k}">`;
    return `<summary><span class="tax-title">税・値引きを確認／修正</span><span class="tax-sum"></span></summary><div class="tax-body">`
      +`<label class="tax-row"><span class="tax-name">外税<span class="tax-kind">商品金額に加算</span></span>${inp('ex','Ex')}<span class="tax-src" data-tax-src="ex"></span></label>`
      +`<label class="tax-row"><span class="tax-name">内税<span class="tax-kind">商品金額に含む（計算では足しません）</span></span>${inp('in','In')}<span class="tax-src" data-tax-src="in"></span></label>`
      +`<div class="tax-row tax-unk" data-tax-unkrow hidden><label class="tax-name" for="${p}TaxUnk">消費税<span class="tax-kind">外税か内税か不明</span></label>${inp('unk','Unk')}<select id="${p}TaxUnkKind" data-tax-kind aria-label="この消費税の扱い"><option value="">不明のまま</option><option value="ex">外税として扱う（商品金額に加算）</option><option value="in">内税として扱う（商品金額に含む）</option></select><span class="tax-src" data-tax-src="unk"></span></div>`
      +`<label class="tax-row"><span class="tax-name">レシート全体の値引<span class="tax-kind">100円引きなら「100」と入力（計算では引きます）</span></span>${inp('disc','Disc')}<span class="tax-src" data-tax-src="disc"></span></label>`
      +`<p class="tax-note" data-tax-itemdisc hidden></p><p class="tax-msg" data-tax-msg aria-live="polite"></p>`
      +`<div class="tax-actions"><button type="button" class="text-btn" data-tax-undo hidden>入力を取り消す（元の値に戻す）</button><button type="button" class="text-btn" data-tax-confirm hidden></button><button type="button" class="text-btn" data-tax-reset hidden></button></div></div>`;
  }
  // api: meta(), itemSum(), itemDisc(), setAmount(k,v), setUnkKind(kind), confirmEst(), canReset(), reset(), resetLabel, ui()
  // What the person typed and what is used for the calculation are two things (v1.10.8). ui() is kept by the owner of the panel, not in the DOM:
  // raw = the typed text of a field that is not valid, bad = why. A redraw puts both back.
  // v1.10.9: an unresolved input error belongs to the data being edited, not to what happens to be visible. It blocks every action that would
  // use the amount - saving and changing the class of the tax - until the amount is corrected or the input is taken back; hiding the row,
  // closing the panel or redrawing it does not make the error go away.
  function mountTaxPanel(root,api){
    root._taxApi=api; const q=s=>root.querySelector(s), LAB={ex:'外税',in:'内税',unk:'消費税',disc:'値引',sub:'小計'};
    const ui=()=>{ const A=root._taxApi, u=(A.ui&&A.ui())||(root._ui=root._ui||{}); u.raw=u.raw||{}; u.bad=u.bad||{}; return u; };
    const clearUi=()=>{ const u=ui(); Object.keys(u.raw).forEach(k=>{ delete u.raw[k]; }); Object.keys(u.bad).forEach(k=>{ delete u.bad[k]; }); };
    const maxOf=()=>Math.round(Number(root._taxApi.itemSum())||0);
    const show=()=>{ const A=root._taxApi, m=A.meta()||{}, S=m.taxSrc||{}, msg=q('[data-tax-msg]'), u=ui(); if(!msg) return;
      const hasUnk=taxVal(m,'unk')>0||u.bad.unk!=null; q('[data-tax-unkrow]').hidden=!hasUnk; q('[data-tax-kind]').value='';   // a row with an unresolved input stays on the screen
      root.querySelectorAll('input[data-tax]').forEach(el=>{ const k=el.dataset.tax;
        if(u.bad[k]!=null){ if(document.activeElement!==el&&el.value!==u.raw[k]) el.value=u.raw[k]; el.setAttribute('aria-invalid','true'); return; }
        el.removeAttribute('aria-invalid'); const v=taxVal(m,k); if(document.activeElement!==el||el.closest('[hidden]')) el.value=v==null?'':String(v); });   // a field that is not on the screen never keeps old text
      const unsure=taxUnsureOf(m);
      root.querySelectorAll('[data-tax-src]').forEach(el=>{ const k=el.dataset.taxSrc; el.textContent=taxVal(m,k)!=null?taxSrcText(m,k)+(unsure[k]?(unsure[k]==='clash'?'・未確認（同じ税率の税の行と金額が合いません）':unsure[k]==='restate'?'・未確認（税率の書かれていない行を再掲とみて1回だけ数えています）':k==='disc'&&Number(m.discAlt)>0?`・未確認（同じ値引の読み直しか別の値引かを判断できていません。別の値引なら ${yen(Number(m.discAlt))}）`:'・未確認（行の重なりを判断できていません）'):''):''; });
      const idv=Math.round(Number(A.itemDisc())||0), idn=q('[data-tax-itemdisc]'); idn.hidden=!(idv>0); idn.textContent=idv>0?`商品ごとの値引 ${yen(idv)} は、すでに商品の金額から引いてあります。ここには入れないでください（二重に引かれます）。`:'';
      const est=S.ex==='est'&&taxVal(m,'ex')>0, uns=taxUnsureKeys(m), cb=q('[data-tax-confirm]'); cb.hidden=!(est||uns.length);
      cb.textContent=est&&!uns.length?`推定の外税 ${yen(taxVal(m,'ex'))} を、レシートで確かめた金額として確定する`:(uns.length===1&&uns[0]==='sub'&&!est)?'小計の表示をレシートで確かめた（確認済みにする）':(est||uns.length)?`${uns.filter(k=>k!=='sub').map(k=>LAB[k]).concat(est&&!uns.includes('ex')?['推定の外税']:[]).join('・')}の金額${uns.includes('sub')?'と小計の表示を、レシートで確かめたものとして':'を、レシートで確かめた金額として'}確定する`:'';
      const rb=q('[data-tax-reset]'); rb.hidden=!A.canReset(); rb.textContent=A.resetLabel||'読み取った値に戻す';
      const sum=q('.tax-sum'); if(sum) sum.textContent=taxSummaryText(m);
      const badKeys=Object.keys(u.bad); q('[data-tax-undo]').hidden=!badKeys.length;
      if(badKeys.length){ msg.classList.remove('caution'); msg.textContent=u.bad[badKeys[0]]+(u.note||''); }
      else { u.note=''; const ex=taxVal(m,'ex'), base=maxOf(), hi=!!(ex>0&&base>0&&ex>Math.floor(base*0.1)+1); msg.classList.toggle('caution',hi); msg.textContent=hi?`外税 ${yen(ex)} は明細合計の10%を超えています。金額を確認してください。`:''; }
    };
    if(!root._taxBound){ root._taxBound=true;
      const onAmt=(el,entered)=>{ if(el.closest('[hidden]')) return;   // a field that is not shown takes no input (its amount has been moved to another class)
        const A=root._taxApi, k=el.dataset.tax, r=parseAmountField(el.value,maxOf(),LAB[k]), u=ui(); u.note='';
        if(!r.ok){ u.raw[k]=el.value; u.bad[k]=r.msg; root._taxShow(); return; }   // not valid: the typed text and the reason are kept; the amount in use stays as it is
        delete u.raw[k]; delete u.bad[k];
        if(r.value===taxVal(A.meta()||{},k)&&!(entered&&(k==='ex'||k==='unk'))){ root._taxShow(); return; }   // an actual same-value tax entry confirms its current rows; blur/save alone never does
        A.setAmount(k,r.value); root._taxShow(); };
      // changing the class of the unknown tax uses its amount: the text in the field is checked first, and an earlier valid amount is never taken in its place
      const onKind=sel=>{ const A=root._taxApi, kind=sel.value, u=ui(), inp=q('input[data-tax="unk"]'), r=parseAmountField(inp?inp.value:'',maxOf(),LAB.unk);
        if(!r.ok||u.bad.unk!=null){ if(!r.ok){ u.raw.unk=inp.value; u.bad.unk=r.msg; } u.note=' 金額を直すか「入力を取り消す」を押してから、扱いを選んでください。'; sel.value=''; root._taxShow(); try{ inp.focus({preventScroll:true}); }catch(_){ } return; }
        if(r.value!==taxVal(A.meta()||{},'unk')) A.setAmount('unk',r.value);
        if(!(taxVal(A.meta()||{},'unk')>0)){ sel.value=''; root._taxShow(); return; }   // nothing to move
        A.setUnkKind(kind); if(inp) inp.value=''; root._taxShow(); if(inp&&document.activeElement===inp){ try{ inp.blur(); }catch(_){ } } };   // the amount now lives in the other field: the text left in this one must not be applied again when it loses focus
      root.addEventListener('input',e=>{ const el=e.target.closest('input[data-tax]'); if(el) onAmt(el,true); });
      root.addEventListener('change',e=>{ const el=e.target.closest('input[data-tax]'); if(el){ onAmt(el); return; } const sel=e.target.closest('[data-tax-kind]'); if(sel&&sel.value) onKind(sel); });
      root.addEventListener('click',e=>{ const A=root._taxApi; if(e.target.closest('[data-tax-confirm]')){ if(Object.keys(ui().bad).length){ ui().note=' 先に、この入力を直すか取り消してください。'; root._taxShow(); return; } A.confirmEst(); root._taxShow(); }
        else if(e.target.closest('[data-tax-reset]')){ clearUi(); A.reset(); root._taxShow(); }
        else if(e.target.closest('[data-tax-undo]')){ clearUi(); root._taxShow(); } });
    }
    // checked again right before saving. Judged from the data of the panel (ui) and from every field that is on the screen - never only from what
    // is visible: a field with an unresolved input is put back on the screen first. An invalid input stops the save; a valid input that is not in
    // use yet is taken over, so what is saved is what the screen shows.
    root._taxCheck=()=>{ root._taxShow(); const A=root._taxApi, u=ui(); let bad=null;
      root.querySelectorAll('input[data-tax]').forEach(el=>{ const k=el.dataset.tax; if(el.closest('[hidden]')) return; const r=parseAmountField(el.value,maxOf(),LAB[k]);
        if(!r.ok){ u.raw[k]=el.value; u.bad[k]=r.msg; if(!bad) bad=el; return; }
        delete u.raw[k]; delete u.bad[k]; if(r.value!==taxVal(A.meta()||{},k)) A.setAmount(k,r.value); });
      root._taxShow(); if(!bad&&Object.keys(u.bad).length) bad=q(`input[data-tax="${Object.keys(u.bad)[0]}"]`)||root;
      if(bad){ root.open=true; try{ bad.scrollIntoView({block:'center'}); if(bad.focus) bad.focus({preventScroll:true}); }catch(_){ } return false; }
      return true; };
    root._taxShow=show; show();
  }
/* MERGE-END */
  // v1.4: the check only reports; it never changes any amount
  function currentTotalSource(){ const f=$('#totalField'); return f&&f.dataset.edited==='1'?'user':(ocrTotalSource||'user'); }
  // v1.10.1: when counts or amounts change, the receipt total follows (only for receipts whose numbers added up when read)
  let totalAuto=null;
  function itemsSumNow(){ return parsedItems.reduce((s,x)=>s+(Number(x.amount)||0),0); }
  // v1.10.4: the total depends on each item's amount, printed tax class and whether the person added the row - not only on the item sum
  function itemsSig(its){ ensureRowIds(its); return JSON.stringify(taxRowsOf(its)); }
  const TAX_RND={floor:n=>Math.floor(n/100),round:n=>Math.floor((n+50)/100),ceil:n=>Math.floor((n+99)/100)};   // n = base × rate(%) in whole yen
  function taxBases(a,its){ const b={}; for(const it of its){ const amt=Math.round(Number(it.amount)||0); if(!amt) continue; const r=isAdded(it)?0:(Number(it._taxRate)||a.single); if(!r) return null; if((it._taxMode||'ex')!=='ex') continue; b[r]=(b[r]||0)+amt; } return b; }
  const ADD_WHY='追加した商品の税率が分からない（外税か内税か、8%か10%か）ため';
  // tax for the current items: every item's rate known, no receipt-level discount, and the same answer from every rounding that reproduced the printed tax
  function taxNow(a,its){
    if(a.unkOpen) return {ok:false,why:'消費税が外税か内税か決まっていないため'};   // v1.10.10: an unsettled class is not treated as settled by recalculating
    if(!a.tax0) return a.taxKey==='exTax'&&(its.some(it=>isAdded(it)&&Number(it.amount)>0)||rowsHaveAdded(a.rows0))?{ok:false,why:ADD_WHY}:{ok:true,tax:0};
    if(a.disc) return {ok:false,why:'値引が税率ごとにどう配分されたか分からないため'};
    const b=taxBases(a,its); if(!b) return {ok:false,why:its.some(it=>isAdded(it)&&Number(it.amount)>0)?ADD_WHY:'商品ごとの税率が分からないため'};   // v1.10.19: said as in the editor
    if(!a.methods.length) return {ok:false,why:'税の計算方法（税率と端数処理）を確かめられないため'};
    const vals=a.methods.map(m=>Object.keys(b).reduce((s,r)=>s+TAX_RND[m](b[r]*Number(r)),0));
    return vals.every(v=>v===vals[0])?{ok:true,tax:vals[0]}:{ok:false,why:'端数処理の方法によって税額が変わるため'};
  }
  // v1.10.7: one calculation for every kind of total. Three things are kept apart:
  //   ocrTotalSource  - whether the receipt printed a total ('total', or a payment line) or the amount is an estimate ('subtotal' / 'items')
  //   ocrMeta         - the tax and discount in use now (read, estimated or entered by hand)
  //   the total field - untouched (as read / as estimated), typed by the person (dataset.edited) or calculated here (totalAuto.changed)
  // What is offered or applied is always items + tax − discount as they are now. A total that was not read never switches tax and discount off.
  function totalPrinted(){ return !!ocrTotalSource&&ocrTotalSource!=='items'&&ocrTotalSource!=='subtotal'; }
  let totalAutoRead=null;   // v1.10.13: the baseline made when the receipt was read (items and tax of the reading), for 「読み取った値に戻す」
  function initTotalAuto(read){
    totalAuto=null; if(read) totalAutoRead=null; const f=$('#totalField'), T0=Number(f?.value)||0, S0=itemsSumNow(); if(!T0||!S0) return;
    const m=ocrMeta||{}, info=sumCheckInfo(S0,T0,m,'total');
    const by=m.taxBy||{}, printed=Object.keys(by).filter(r=>by[r]>0).map(Number), single=printed.length===1?printed[0]:0;
    // the tax and discount that go with the items as they are now: from the reading that agreed, or (when nothing agreed) from the figures in use
    const ok=info.level==='ok'||info.level==='explained', parts=info.parts||[], discPart=parts.find(p=>p[0]==='−');
    const tax0=parts.filter(p=>p[0]==='＋').reduce((s2,p)=>s2+(Number(p[2])||0),0), disc=discPart?Number(discPart[2])||0:0;   // v1.10.10: every tax amount that is added (外税 and, in that reading, the unknown-class tax)
    const unkOpen=Number(m.unknownTax)>0;   // a tax amount whose class is not settled: nothing is recalculated from it and no amount is offered as settled
    const taxKey=unkOpen?'':taxVal(m,'ex')!=null?'exTax':tax0?'inTaxMax':'';
    // base = the total that belongs to the starting items: the amount in the field when the sums agree, otherwise items + tax − discount.
    // An amount estimated from the items follows them from the start (it has no printed figure to hold on to).
    totalAuto={T0,S0,printed:totalPrinted(),sig0:itemsSig(parsedItems),rows0:taxRowsOf(parsedItems),meta0:Object.assign({},m),snap0:taxSnapshot(m),changed:false,single,methods:[],estimated:ocrTotalSource==='subtotal',taxSig:itemsSig(parsedItems),taxS:S0,mix0:taxMixOf(parsedItems),taxMix:taxMixOf(parsedItems),
      tax0,disc,taxKey,unkOpen,follow:ok&&ocrTotalSource==='items'&&f.dataset.edited!=='1',suggestOnly:!ok,okAtRead:ok,noCand:!ok&&(!!info.ambiguous||!!info.conflict||!!info.unsure),offer:!ok&&totalPrinted(),base:ok?T0:Math.max(0,S0+tax0-disc)};
    // the roundings that reproduce the tax (and each printed rate's tax) from the starting items. After the person corrected the tax, the per-rate
    // amounts read by OCR no longer add up to it and are not compared (the printed rate still counts)
    if(tax0&&!disc){ const b=taxBases(totalAuto,parsedItems), hand=taxByHand(m.taxSrc&&m.taxSrc[taxKey==='exTax'?'ex':taxKey==='unknownTax'?'unk':'in']), chk=hand&&printed.reduce((s2,r)=>s2+by[r],0)!==tax0?[]:printed;
      if(b) totalAuto.methods=Object.keys(TAX_RND).filter(k=>Object.keys(b).reduce((s2,r)=>s2+TAX_RND[k](b[r]*Number(r)),0)===tax0&&chk.every(r=>TAX_RND[k]((b[r]||0)*r)===by[r])); }
    if(read) totalAutoRead=cloneAuto(totalAuto);
  }
  function cloneAuto(a){ return Object.assign({},a,{meta0:Object.assign({},a.meta0),methods:a.methods.slice()}); }
  // v1.10.13: the added tax in use (外税) was read or entered for other items than the ones on the screen - the counts or amounts changed and the tax was
  // not calculated for them (it is still unsure, it cannot be calculated, or the calculation is only offered). S = the item sum it belongs to,
  // cur = the amount in the field, calc = the tax for the items as they are now (null while something it rests on is open: it can be calculated once that
  // is settled). v1.10.17: also when the tax cannot be calculated at all (no rate, no rounding, a receipt-level discount): the kept tax is still the tax of
  // the earlier items. Before, it was then taken as the tax of the new items: with a typed total of ¥2,080 the check said 一致 for 牛乳 ¥2,000 ＋ 外税 ¥80,
  // and the record was saved without saying that the tax belongs to ¥1,000 (taxFor). Now the check says why the tax is not calculated, and saving keeps it.
  function staleTax(){ const a=totalAuto; if(!a||!ocrMeta||!a.taxKey||a.taxSig==null||itemsSig(parsedItems)===a.taxSig) return null;
    const cur=Number(ocrMeta[a.taxKey])||0, ck=a.taxKey==='exTax'?'ex':a.taxKey==='unknownTax'?'unk':'in'; if(taxVal(ocrMeta,ck)==null&&(ocrMeta.taxSrc||{})[ck]!=='calc') return null; const c=taxNow(a,parsedItems), mixNow=taxMixOf(parsedItems);   // a calculated zero keeps its binding; an explicit zero with unknown added rows also needs reconfirmation after changes
    if(cur===0&&taxByHand((ocrMeta.taxSrc||{})[ck])&&!parsedItems.some(isAdded)&&!rowsHaveAdded(ocrMeta.taxForRows)) return null;
    if(mixNow===a.taxMix&&/^(?:(?:ex|in)?(?:8|10):\d+)(?:,(?:ex|in)?(?:8|10):\d+)*$/.test(mixNow)) return null;   // the same amounts by tax mark and rate, every item with its rate: the tax still belongs to them
    const blocked=candBlocked(ocrMeta); return {S:a.taxS,mix:a.taxMix||'',rows:taxRowsRead(ocrMeta.taxForRows),cur,calc:blocked||!c.ok?null:c.tax,why:blocked?blockedWhy(ocrMeta):c.ok?'':c.why}; }
  // v1.10.11: no calculated total is offered as settled while something it rests on is open: a tax of unknown class, a tax / discount / 小計 point that
  // is still unsure, or 外税 on items that are all marked as priced with tax. The same rule for the confirm screen and the saved-record editor.
  function candBlocked(m){ return taxVal(m,'unk')>0||taxUnsureKeys(m).length>0||(Number(m.exTax)>0&&m.itemBasis==='in')||cancelOpenOf(m).length>0; }   // v1.10.17: an open 取消 / 返品 line too
  // v1.10.12: why a total cannot be calculated now (the same states as candBlocked), in words for the note under the total field
  function blockedWhy(m){ if(taxVal(m,'unk')>0) return '消費税が外税か内税か決まっていないため'; const uk=taxUnsureKeys(m);
    if(uk.length) return uk.map(k=>({ex:'外税',in:'内税',unk:'消費税',disc:'値引',sub:'小計の表示'})[k]).join('・')+'が未確認のため';
    if(cancelOpenOf(m).length&&!(Number(m.exTax)>0&&m.itemBasis==='in')) return '取消・返品の対象の商品が確認できていないため';
    return '商品はすべて税込（内税）の表示なのに外税があり、税の扱いが決まっていないため'; }
  function totalAutoNote(){
    let n=$('#totalAutoNote'); if(n) return n; const f=$('#totalField'); if(!f) return null;
    n=document.createElement('p'); n.id='totalAutoNote'; n.className='total-auto-note'; n.hidden=true; (f.closest('label')||f).insertAdjacentElement('afterend',n);
    n.addEventListener('click',e=>{ const b=e.target.closest('button[data-total]'); if(!b||!totalAuto) return; const f2=$('#totalField');
      // two separate actions (v1.10.5): 「レシートの合計に戻す」 puts back the printed total and the taxes as read;
      // 「合計を ¥X にする」 applies exactly the amount shown on the button (before, an unchanged receipt went back to the printed total instead)
      if(b.dataset.total==='receipt'){ taxRestore(ocrMeta,totalAuto.snap0); totalAuto.taxSig=totalAuto.sig0; totalAuto.taxS=totalAuto.S0; totalAuto.taxMix=totalAuto.mix0; f2.value=String(totalAuto.T0); f2.dataset.edited='1'; f2.dataset.origin='read'; }   // v1.10.13: the tax is the baseline's again - the tax of the baseline's items   // back to the amount of the reading (the tax and discount as they were at the last baseline - a manual tax edit is a baseline and stays)
      else { const v=Math.round(Number(b.dataset.value)); if(isFinite(v)&&v>0) f2.value=String(v); f2.dataset.edited=''; f2.dataset.origin='calc'; totalAuto.follow=true; totalAuto.suggestOnly=false; }
      updateSumCheck(); });
    return n;
  }
  // v1.10.6: the panel on the confirm screen works on ocrMeta. A change made here is the person's: it becomes the new starting point of the
  // total calculation (so a later count change does not bring the OCR value back), and the total field itself is never changed by it.
  // v1.10.13: what a change in the panel does to the baseline of the calculation (the items and the tax the calculation starts from - totalAuto):
  //   'tax'     the person changed an added tax amount (外税, the unknown-class tax) or its class: their amount is the tax of the items as they are now,
  //             so the baseline is made again from the items on the screen (as before).
  //   'reset'   back to the amounts of the reading: those belong to the items of the reading, so the baseline of the reading comes back with them.
  //   'confirm' / 'other' (内税, 値引): the added tax is not changed, so the baseline stays - with its items, its tax and the roundings found for it.
  // Before, every change made the baseline again from the items on the screen. After 2 × ¥1,000, entering 内税 0 or 値引 0 took 外税 ¥80 - the tax of
  // the 1 × ¥1,000 that was read - as the tax of ¥2,000: the candidate became ¥2,080 instead of ¥2,160, and applying it showed 一致.
  // A change in the panel never changes the total field by itself: when it lifts what kept the calculation closed (an unsure tax confirmed), the
  // calculation is offered as a candidate; a change of the discount is offered too (the field keeps its amount).
  function afterConfirmTaxEdit(how,wasBlocked){ confirmEdited=true; const a=totalAuto, sig=itemsSig(parsedItems);
    syncSubUnsure(ocrMeta,a&&a.snap0);
    const keep=how==='reset'?!!(totalAutoRead&&sig!==totalAutoRead.sig0):!!(a&&a.sig0&&sig!==a.sig0&&how!=='tax');   // the items differ from the ones the (kept / read) tax belongs to
    if(keep){
      const b=how==='reset'?Object.assign(cloneAuto(totalAutoRead),{T0:a?a.T0:totalAutoRead.T0}):a, d=Math.round(Number(taxVal(ocrMeta,'disc'))||0);
      if(d!==b.disc){ b.base=Math.max(0,b.base+b.disc-d); b.disc=d; b.follow=false; }
      // the starting point for 「レシートの合計に戻す」: the tax as it is now, but a tax that was calculated for the changed items goes back to the baseline's amount
      const sn=taxSnapshot(ocrMeta), k=b.taxKey==='exTax'?'ex':b.taxKey==='unknownTax'?'unk':b.taxKey?'in':'';
      if(k&&(ocrMeta.taxSrc||{})[k]==='calc'&&b.snap0){ sn[b.taxKey]=b.snap0[b.taxKey]; if(b.taxKey==='inTaxMax') sn.inTax=b.snap0.inTax; sn.taxSrc[k]=(b.snap0.taxSrc||{})[k]||''; }
      b.snap0=sn;
      if(how==='confirm'||how==='reset'||(wasBlocked&&!candBlocked(ocrMeta))){ b.follow=false; b.noCand=false; }
      b.offer=true; totalAuto=b; updateSumCheck(); return; }
    const T0=a?a.T0:null; initTotalAuto(); if(totalAuto){ if(T0!=null) totalAuto.T0=T0; totalAuto.offer=true; } updateSumCheck(); }
  const confirmTaxApi={ meta:()=>ocrMeta||{}, itemSum:()=>Math.max(itemsSumNow(),Number($('#totalField')?.value)||0), itemDisc:()=>parsedItems.reduce((s,it)=>s+(Number(it._discount)||0),0),
    setAmount:(k,v)=>{ if(!ocrMeta) return; const was=candBlocked(ocrMeta); taxSetAmount(ocrMeta,k,v); if(k==='ex'||k==='unk') bindTaxRows(ocrMeta,parsedItems); afterConfirmTaxEdit(k==='ex'||k==='unk'?'tax':'other',was); },
    setUnkKind:kind=>{ if(!ocrMeta) return; const was=candBlocked(ocrMeta); taxSetUnkKind(ocrMeta,kind); bindTaxRows(ocrMeta,parsedItems); afterConfirmTaxEdit('tax',was); },
    // v1.10.12: counts or amounts changed while the tax was unsure, and the person now confirms the amounts as read: the reading stays the starting point,
    // so the calculation for the changed items is offered as a candidate (外税 ¥160・合計 ¥2,160 for 2 × ¥1,000) - not applied by itself, and not made from
    // the changed items as if they had been read with that tax
    confirmEst:()=>{ if(!ocrMeta) return; const was=candBlocked(ocrMeta); taxConfirmEst(ocrMeta); afterConfirmTaxEdit('confirm',was); },
    canReset:()=>!!(ocrMeta&&ocrMeta.read0&&taxDiffers(ocrMeta,ocrMeta.read0)),
    reset:()=>{ if(!ocrMeta||!ocrMeta.read0) return; const was=candBlocked(ocrMeta); taxRestore(ocrMeta,ocrMeta.read0); afterConfirmTaxEdit('reset',was); }, resetLabel:'読み取った値に戻す', ui:()=>confirmTaxUi };
  document.addEventListener('input',e=>{ if(e.target&&e.target.id==='totalField') e.target.dataset.origin='typed'; },true);   // typing in the total field: it is a typed amount from now on (runs before the field's own handlers)
  let confirmTaxUi={raw:{},bad:{}};   // v1.10.8: typed text and error of the panel on the confirm screen (new with every reading)
  function loadConfirmTaxPanel(){ const tp=$('#taxPanel'); if(!tp) return; if(!ocrMeta){ tp.classList.add('hidden'); return; }
    if(!ocrMeta.taxSrc) normalizeTaxMeta(ocrMeta,parsedItems);
    bindTaxRows(ocrMeta,parsedItems); ocrMeta.read0=taxSnapshot(ocrMeta); confirmTaxUi={raw:{},bad:{}}; { const tf=$('#totalField'); if(tf) tf.dataset.origin='read'; /* v1.10.10: a new reading - the amount in the field is the one that was read (or estimated) */ } tp.innerHTML=taxPanelHtml('c'); tp.open=false; tp.classList.remove('hidden'); mountTaxPanel(tp,confirmTaxApi); }
  function refreshConfirmTaxPanel(){ const tp=$('#taxPanel'); if(tp&&tp._taxShow&&ocrMeta&&!tp.classList.contains('hidden')) tp._taxShow(); }
  function setTaxMeta(a,tax){ if(!a.taxKey||!ocrMeta) return; const k=a.taxKey==='exTax'?'ex':a.taxKey==='unknownTax'?'unk':'in'; ocrMeta[a.taxKey]=tax; if(a.taxKey==='inTaxMax') ocrMeta.inTax=tax;
    ocrMeta.taxSrc=Object.assign({},ocrMeta.taxSrc); ocrMeta.taxSrc[k]=tax===a.tax0?((a.snap0&&a.snap0.taxSrc[k])||''):'calc'; }   // v1.10.6: a recalculated tax is marked as calculated; back at the starting items it is the starting amount again (read or entered by hand)
  function applyTotalAuto(){
    const n=totalAutoNote(), f=$('#totalField'); if(!n||!f) return; const a=totalAuto; if(!a){ n.hidden=true; return; }
    const S=itemsSumNow(), same=itemsSig(parsedItems)===a.sig0, calc=same?{ok:true,tax:a.tax0}:taxNow(a,parsedItems), T=calc.ok?Math.max(0,S+calc.tax-a.disc):null;
    // the amount the field started with is called what it is: the receipt's total, or the estimate made when no total line was read (v1.10.7)
    const T0name=a.printed?'レシートの合計':'元の推定合計', back=`<button type="button" class="text-btn" data-total="receipt">${T0name} ${esc(yen(a.T0))} に戻す</button>`, own=a.base!==a.T0;
    const quiet=!a.printed&&ocrTotalSource==='items'&&!a.tax0&&!a.disc&&!own;   // an estimate from the items alone simply follows them, as before
    // v1.10.10: where the amount in the field comes from is kept on the field itself (data-origin: read = as read / as estimated, calc = put there by a
    // calculation, typed = typed by the person). It survives a new baseline (a tax edit re-initialises totalAuto), so a calculated amount is never
    // called the receipt's total afterwards. T0 always stays the amount of the reading.
    const put=(v,origin)=>{ if(Number(f.value)!==v) f.value=String(v); f.dataset.origin=origin; };
    // v1.10.18: an amount being entered (a blank row with a name) or no amount at all: nothing is calculated or written - the tax, its items and the total
    // field stay as they are until the amount is there (before, the 外税 of the items was calculated as ¥0 for a moment and written to the field)
    { const nb=parsedItems.filter(amtBlank).length; if(nb||!parsedItems.some(it=>Number(it.amount)>0)){ if(!nb||same){ n.hidden=true; return; } n.hidden=false; n.innerHTML=`金額が空欄の商品があるため、合計と税は計算していません（合計欄は ${esc(yen(Number(f.value)||0))} のままです）。金額を入れると計算します。`; return; } }
    // v1.10.12: while what the total rests on is open (a tax of unknown class, an unsure tax / discount / 小計, 外税 on items priced with tax), nothing is
    // calculated: the total field, the tax amounts and their sources stay as they are, whatever changed (count, amount, a row added or removed, a tax
    // edit, going back). The same rule as the candidate (candBlocked), judged before anything is written - before, a count change following the items
    // recalculated 外税 ¥80 → ¥160 and the total ¥1,080 → ¥2,160 from a tax amount that was still unsure. Once the point is settled, the usual calculation applies.
    if(candBlocked(ocrMeta||{})){
      const canBack=f.dataset.origin==='calc'&&Number(f.value)!==a.T0;
      if(same&&!canBack){ n.hidden=true; return; }
      n.hidden=false; n.innerHTML=(same?'':`${esc(blockedWhy(ocrMeta||{}))}、合計と税は自動で計算していません（合計欄は ${esc(yen(Number(f.value)||0))} のままです）。${blockedWhy(ocrMeta||{}).startsWith('取消')?'取消・返品の対象を確かめると':'「税・値引きを確認／修正」で確認・確定すると'}、明細に合わせて計算できます。`)+(canBack?`${same?'':' '}いまの合計欄は計算して入れた金額です（${T0name}は ${esc(yen(a.T0))} です）。${back}`:'');
      return; }
    if(!f.dataset.edited&&a.follow&&!a.suggestOnly){
      if(same||!calc.ok){ setTaxMeta(a,a.tax0); ocrMeta.taxForRows=taxRowsRead(a.rows0); a.taxSig=a.sig0; a.taxS=a.S0; a.taxMix=a.mix0; put(a.base,own?'calc':'read'); a.changed=own;
        if(same){ n.hidden=!own; if(own) n.innerHTML=`明細と、いまの税・値引から計算した合計 ${esc(yen(a.base))} にしています（${T0name}は ${esc(yen(a.T0))} です）。${back}`; }
        else { n.hidden=false; n.innerHTML=`${esc(calc.why)}、合計は自動で計算していません（${own?'変更する前の合計':T0name} ${esc(yen(a.base))} のままです）。変更した分の税を含めて、合計を確認してください。${own?back:''}`; }
        return; }
      setTaxMeta(a,calc.tax); bindTaxRows(ocrMeta,parsedItems); a.taxSig=itemsSig(parsedItems); a.taxS=S; a.taxMix=taxMixOf(parsedItems); put(T,'calc'); a.changed=true; n.hidden=quiet;   // v1.10.13: the tax in use now belongs to these items
      if(!quiet) n.innerHTML=`数量・金額の変更に合わせて合計を計算しました${a.tax0?'（税も計算し直しています）':''}。${back}`; return;
    }
    // not following (a typed total, sums that did not agree, or no count change yet): only a checked candidate is offered - always items + tax − discount
    // as they are now (an unread total does not leave the tax out). The button carries the amount it shows, and pressing it applies exactly that amount.
    // v1.10.11: whether an amount may be offered is judged from the state as it is now - not from the reading the baseline was made with (with the
    // items unchanged, the baseline's tax was used as it was, so a typed total brought back 2,000＋80＝2,080 while the class of a ¥100 tax was still open).
    const cand=!(a.noCand||candBlocked(ocrMeta||{})||(same&&!f.dataset.edited&&!a.offer)||!calc.ok||T===Number(f.value));
    const canBack=f.dataset.origin==='calc'&&Number(f.value)!==a.T0;   // a calculated amount is in the field: the amount of the reading can always be brought back
    if(!cand&&!canBack){ n.hidden=true; return; }
    // v1.10.13: when the candidate carries a tax calculated for the changed items, the tax it applies is named next to the one in the field now
    const cur=a.taxKey?Number((ocrMeta||{})[a.taxKey])||0:0, retax=cand&&!same&&a.taxKey&&calc.tax!==cur?`（${a.taxKey==='exTax'?'外税':'税'}を、いまの ${esc(yen(cur))} から明細に合わせて ${esc(yen(calc.tax))} に計算し直した額です）`:'';
    n.hidden=false; n.innerHTML=(cand?`明細から計算した合計は ${esc(yen(T))} です${retax}。<button type="button" class="text-btn" data-total="auto" data-value="${T}">合計を ${esc(yen(T))} にする</button>`:'')+(canBack?`${cand?' ':''}いまの合計欄は計算して入れた金額です（${T0name}は ${esc(yen(a.T0))} です）。${back}`:'');
  }
  function updateSumCheck(){ updateSumCheckCore(); cancelOkButton($('#sumCheck'),ocrMeta,updateSumCheck); refreshConfirmTaxPanel(); }
  // v1.10.17: 「取消を確認済みにする」 under the check while a 取消 / 返品 line is open: the person checked the receipt and keeps the items as they are
  function cancelOkButton(box,m,redo){ if(!box||box.classList.contains('hidden')||!m||!cancelOpenOf(m).length) return;
    const b=document.createElement('button'); b.type='button'; b.className='text-btn'; b.dataset.cancelOk='1'; b.textContent='取消を確認済みにする';
    b.addEventListener('click',()=>{ m.cancelOpen=[]; if(editDraft&&m===editDraft.meta) editDraft.taxTouched=true; redo(); }); box.appendChild(b); }
  function updateSumCheckCore(){
    applyTotalAuto();
    const box=$('#sumCheck'); if(!box)return; const f=$('#totalField'), total=Number(f?.value)||0, itemSum=itemsSumNow(), a=totalAuto;
    box.classList.remove('hidden','warning','ok','notice');
    if(ocrMeta) ocrMeta.itemBasis=itemBasisOf(parsedItems);   // v1.10.7: which items carry a 内 / 外 mark is taken from the items as they are now
    // v1.10.13: a tax in use that belongs to other items (staleTax) is never added to the items on the screen as if it were theirs - before, 2 × ¥1,000
    // with the 外税 ¥80 of 1 × ¥1,000 was shown as 明細合計 ¥2,000 ＋ 外税 ¥80 ＝ ¥2,080. When the tax can be calculated for these items, the check uses
    // that amount and says so; when it cannot (still unsure, no rounding found), the check says why and adds nothing.
    const m=ocrMeta||{}, stale=staleTax(), mCalc=stale&&stale.calc!=null?Object.assign({},m,{[a.taxKey]:stale.calc},a.taxKey==='inTaxMax'?{inTax:stale.calc}:{}):null;
    const info=sumCheckInfo(itemSum,total,mCalc||ocrMeta,'total');   // v1.10.7: the same calculation whether or not a total line was read
    if(mCalc&&info.parts) info.parts=info.parts.map(p=>p[1]==='外税'?[p[0],'外税（いまの明細で計算）',p[2]]:p);
    { const nb=parsedItems.filter(amtBlank).length; if(nb){ box.classList.add('notice'); box.textContent=`金額が空欄の商品が ${nb} 件あります。金額を入れると照合します（空欄の間は、合計と税を計算し直していません）。空欄のまま保存すると、その商品は保存されません。`; return; } }   // v1.10.18: not checked as ¥0, never 一致
    if(info.level==='empty'){box.classList.add('hidden');box.textContent='';return;}
    if(!itemSum){box.classList.add('warning');box.textContent='読み取り漏れや重複の可能性があります。商品明細が読み取れていません。商品を追加するか、合計金額だけで保存できます。';return;}
    if(info.level==='noTotal'){box.classList.add('notice');box.textContent=`商品明細の合計は ${yen(itemSum)} です。合計金額を確認してください。`;return;}
    // where the amount in the total field comes from decides what it is called (v1.10.7): a printed total, an estimate, a typed amount, a calculated amount
    const origin=f.dataset.origin||'read', printed=totalPrinted(), computed=origin==='calc', typed=origin==='typed', untouched=origin==='read';   // v1.10.10: from the field's own origin, not from flags that a new baseline resets
    const taxEdited=!!(m.read0&&taxDiffers(m,m.read0)), T0word=printed?'レシート合計':'推定の合計', RL=computed?'合計':typed?'入力した合計':T0word;   // v1.10.8: a typed amount is called typed even when it equals the original; only 「…に戻す」 brings the original name back
    const partsText=ps=>ps.map(p=>` ${p[0]} ${p[1]} ${yen(p[2])}`).join(''), TP='「税・値引きを確認／修正」';
    const ex=Number(m.exTax)||0, unk=Number(m.unknownTax)||0, sub=Math.max(0,(Number(m.subtotal)||0)-(Number(m.cancelAfterSub)||0)), dsc=Number(m.discAfterSub)||0, isOk=info.level==='ok'||info.level==='explained';   // v1.10.18: 小計 less the items taken back after it
    const estimate=!printed&&!typed;   // the amount in the field is an estimate or a calculation - not a printed and not a typed total
    // v1.10.8: what is not settled about the tax is judged and said in the same way for every kind of total (printed, estimated from 小計 or from the
    // items, typed, calculated). The notice about an estimated total never stands in for these - they are added to it.
    const caveats=[];
    if(info.conflict) caveats.push(`商品はすべて税込（内税）の表示です。外税 ${yen(ex)} を足すと二重になるおそれがあります${estimate&&isOk?`（足さない場合は ${yen(Math.max(0,total-ex))} です）`:''}。${TP}で税を確認してください。`);
    { const uk=taxUnsureKeys(m), tk=uk.filter(k=>k!=='disc'&&k!=='sub');   // v1.10.9: says which tax it is about; v1.10.10: a discount can be unsure too
      if(tk.length) caveats.push(`${tk.map(k=>({ex:'外税',in:'内税',unk:'消費税'})[k]).join('・')}の行の重なり（税率別の行・再掲の行）を判断できませんでした。${TP}で税額を確かめて確定してください。`);
      if(uk.includes('disc')&&taxUnsureOf(m).disc==='point') caveats.push(pointOpenNote(m));
      else if(uk.includes('disc')) caveats.push(`値引 ${yen(Number(m.receiptDiscount)||0)} と同じ金額の値引が複数の写真にあり、同じ行の読み直しか別の値引かを判断できませんでした（1回分として数えています${Number(m.discAlt)>0?`。別の値引なら ${yen(Number(m.discAlt))}`:''}）。${TP}で値引額を確かめて確定してください。`); }
    { const cn=cancelOpenNote(m); if(cn) caveats.push(cn); }   // v1.10.17: a 取消 / 返品 line whose item is not settled (never a plain 一致)
    if(info.estimated) caveats.push(`外税の行を読み取れなかったため、合計と小計の差を外税と推定しています。レシートと照らし合わせてください（合っていれば${TP}で確定できます）。`);
    if(info.classUnknown) caveats.push(`消費税 ${yen(unk)} が外税か内税かは読み取れていません${info.classUnknown==='in'?'（内税なら、このままで合っています）':''}。${TP}で指定できます。`);
    if(!isOk&&info.ambiguous) caveats.push(`消費税 ${yen(unk)} が外税か内税か決まっていないため、計算額を確定できません（合計の候補は出していません）。${TP}で指定できます。`);   // v1.10.10
    // v1.10.11: the contradiction of the 小計 lines is an open point of the reading (taxUnsure.sub). It stays until the person confirms the 小計 lines or
    // corrects the tax so that they agree - typing a total, applying a candidate or changing an unrelated field does not settle it (before, it was only
    // shown while the field and the tax were untouched, and it was lost on saving).
    if(taxUnsureOf(m).sub) caveats.push(`小計の表示どうしが合いません${m.subConflict?`（${m.subConflict}）`:''}。${ocrTotalSource==='subtotal'&&untouched?'税込の小計を使って推定しています。':''}レシートで小計を確認してください（確かめたら${TP}で確認済みにできます）。`);
    if(m.subBasisUnknown&&ex&&untouched&&!taxEdited) caveats.push(`小計 ${yen(sub)} が税込か税抜かを判断できないため、外税 ${yen(ex)} は推定の合計に足していません（足す場合は ${yen(total+ex)} です）。`);
    // how a total that was not printed was estimated from 小計 - said only while the field still holds that estimate and the equation really holds.
    // v1.10.10: the 小計 line that was used (subShown: its amount, the discounts after it, the tax added to it, what it is) is the one that is reported.
    const sh=m.subShown||null, subA=sh?sh.a:sub, subD=sh?sh.dA:dsc, subC=sh?Number(sh.cA)||0:0, subUsed=sh?sh.basis:(m.subBasisUsed||''), subAdd=sh?sh.add:((subUsed===''||subUsed==='ex')?ex:0);
    const subOk=ocrTotalSource==='subtotal'&&untouched&&!taxEdited&&subA>0&&Math.max(0,subA-subD-subC+subAdd)===total, dscText=(subC?` − 取消 ${yen(subC)}`:'')+(subD?` − 値引 ${yen(subD)}`:'');   // v1.10.18: 取消 lines after the 小計
    const subSentence=!subOk?'':(subUsed==='in')?`合計の行が読み取れなかったため、税込の小計 ${yen(subA)}${dscText} ＝ ${yen(total)} を合計と推定しました（推定の合計です${ex?`。小計に税が含まれているため、外税 ${yen(ex)} は足していません`:''}）。`
      :(subUsed==='unknown')?`合計の行が読み取れなかったため、小計 ${yen(subA)}${dscText} ＝ ${yen(total)} を合計金額に入れています（推定の合計です）。`
      :`合計の行が読み取れなかったため、${sh&&sh.by==='label'&&subAdd!==ex?'税抜の':''}小計 ${yen(subA)}${dscText}${subAdd?` ＋ ${subAdd===ex?'外税':'税'} ${yen(subAdd)}`:''} ＝ ${yen(total)} を合計と推定しました（推定の合計です）。`;
    // v1.10.10: a calculated amount in the field is said to be one, with the amount of the reading next to it - it is never called the receipt's total
    // v1.10.11: 小計 lines of one rate or department that were read are named, with the reason they are not the receipt's 小計
    const partNote=(!printed&&untouched&&Array.isArray(m.partSubs)&&m.partSubs.length)?`${m.partSubs.map(ps=>`${ps.label||'小計'} ${yen(ps.a)}`).join('・')} は${m.partSubs.every(ps=>ps.scope==='rate')?'税率ごと':'税率・部門ごと'}の小計のため、レシート全体の小計としては使っていません。`:'';
    const originNote=(computed&&a&&a.T0!==total)?`いまの合計欄 ${yen(total)} は計算して入れた金額です（${printed?'レシートの合計':'元の推定合計'}は ${yen(a.T0)}）。`:'';
    if(stale&&mCalc) caveats.push(`外税欄の ${yen(stale.cur)} は、数量・金額を変える前の明細（${yen(stale.S)}）に対する額です（いまの明細では ${yen(stale.calc)}）。`);
    if(stale&&!mCalc){ const Tl=(!printed&&untouched)?`現在の合計 ${yen(total)}（元の推定合計）`:`${RL} ${yen(total)}`, tn=a.taxKey==='exTax'?'外税':'税';
      box.classList.add('warning'); box.textContent=`明細合計 ${yen(itemSum)} と${Tl} に差があります。商品・数量・金額を変更したために出た差です${a.okAtRead?'（読み取った時点では一致していました）':''}。${tn} ${yen(stale.cur)} は数量・金額を変える前の明細（${yen(stale.S)}）に対する額で、${stale.why?stale.why+'、':''}いまの明細に合わせた税額はまだ計算していません。合計を確認してください。`+caveats.join('')+originNote; return; }
    if(isOk){
      const parts=info.parts||[];
      // an amount that was neither printed nor typed is an estimate or a calculation: it is reported as one, not as a match with the receipt
      if(estimate){ box.classList.add('notice'); box.textContent=(subSentence||`${ocrTotalSource==='subtotal'?'合計の行が読み取れなかったため':'レシートの合計を読み取れなかったため'}、明細合計 ${yen(itemSum)}${partsText(parts)}${parts.length?` ＝ ${yen(total)}`:''} を合計金額に入れています${parts.length?'（推定の合計です）':''}。`)+partNote+caveats.join('')+'レシートの合計と同じか確認してください。'; return; }
      const head=parts.length?`明細合計 ${yen(itemSum)}${partsText(parts)} ＝ ${RL} ${yen(total)}。`:`明細合計 ${yen(itemSum)} ／ ${RL} ${yen(total)}。`;
      // the sums can agree while the tax itself is not settled (contradicting marks, unclear tax lines, an estimate, an unknown class). That is said, and not shown as a plain 一致.
      if(caveats.length){ box.classList.add('notice'); box.textContent=head+(info.conflict?'金額は合いますが、':'金額は合っていますが、')+caveats.join(''); return; }
      box.classList.add('ok'); box.textContent=head+'一致しています。'; return;
    }
    // the difference shown is always the one left after the tax and discount in use (the same calculation as the check and the candidate);
    // a 1-yen gap is called a possible rounding difference only after they have been taken into account
    { const parts=info.parts||[], resid=Math.abs(Number(info.resid)||0), cav=caveats.join('')+originNote, pre=subSentence?subSentence+'ただし、':'';   // v1.10.8: an estimate that does not agree with the items says both
      const changed=!!(a&&a.sig0&&itemsSig(parsedItems)!==a.sig0), mine=changed&&(a.okAtRead||!a.suggestOnly);
      const Tlabel=(!printed&&untouched)?`現在の合計 ${yen(total)}（元の推定合計）`:`${RL} ${yen(total)}`, calcTag=taxEdited?'（修正後の計算額）':'';
      const head=parts.length?`明細合計 ${yen(itemSum)}${partsText(parts)} ＝ ${yen(info.expect)}${calcTag} と${Tlabel} に ${yen(resid)} の差があります。`:`明細合計 ${yen(itemSum)}${calcTag} と${Tlabel} に ${yen(resid)} の差があります。`;
      box.classList.add('warning');
      // v1.10.17: the items are more than the total by exactly the 取消 / 返品 lines whose item could not be singled out: that is the reason, not a missed line
      { const coA=cancelOpenOf(m).filter(o=>o.w!=='none').reduce((t,o)=>t+o.a,0);
        if(coA>0&&!parts.length&&info.direction==='more'&&resid===coA){ box.textContent=pre+`明細合計 ${yen(itemSum)} は${Tlabel} より ${yen(resid)} 多く、この差は対象を決められなかった取消・返品の行の金額です。`+cav; return; } }
      if(mine){ box.textContent=pre+head+`商品・数量・金額を変更したために出た差です${a.okAtRead?'（読み取った時点では一致していました）':''}。合計を確認してください。`+cav; return; }
      // v1.10.7: a difference that comes from correcting the tax or discount is said to be that. The total is not changed by itself; the amount to apply is offered below
      if(taxEdited&&!changed){ box.textContent=pre+head+`税・値引を修正したために出た差です。合計金額は自動では変えていません${a&&!a.noCand?`（合計へ反映するときは「合計を ${yen(info.expect)} にする」を押してください）`:''}。`+cav; return; }
      // 内税 is never added. When adding it would give the total, the reason it is not added is said - by the marks on the items when every item has one
      if(info.inWouldFit){ const t=yen(Number(info.inWouldFit)); box.textContent=pre+head+(m.itemBasis==='in'?`内税 ${t} は商品金額に含まれているため、足していません（商品に「内」の表示があります）。合計と明細を確認してください。`:`内税 ${t} は商品金額に含む税として読み取ったため、足していません。足すと合計と合いますが、商品が税抜の金額かどうかをレシートから確認できません。税抜なら${TP}で外税（商品金額に加算）に入れてください。`)+cav; return; }
      if(parts.length){
        // a tax amount that may have been misread is pointed out, never replaced: 小計 matches the items and 合計 − 小計 could be the tax
        const gap=total-sub, byHand=taxByHand(m.taxSrc&&m.taxSrc.ex);
        const hint=(printed&&resid>1&&ex&&!byHand&&!m.exTaxFromTotal&&!(Number(m.receiptDiscount)>0)&&sub>0&&itemSum===sub&&gap>0&&gap<=sub*0.11+2&&gap!==ex)?`合計と小計の差は ${yen(gap)} です。外税 ${yen(ex)} が読み違いでないかも確認してください。`:'';
        // v1.10.9: a printed total that was read is kept as it is, however far it is from the items. When it is below 小計, a misread total is named as one possibility
        const low=(printed&&untouched&&sub>0&&total<sub)?`レシート合計 ${yen(total)} は小計 ${yen(sub)} より小さい金額です。合計の読み違いでないかも確認してください。`:'';
        box.textContent=pre+head+(resid<=1?'端数処理による差の可能性があります。':'読み取り漏れや重複、または税・値引の読み違いの可能性があります。')+hint+low+`レシートと照らし合わせてください。税・値引の金額は${TP}で直せます。`+cav; return; }
      if(resid===1){ box.textContent=pre+`明細合計 ${yen(itemSum)} と${Tlabel} に ${yen(1)} の差があります（端数処理による差の可能性があります）。金額を確認してください。`+cav; return; }
      if(info.level==='small'){ box.textContent=pre+`読み取り漏れや重複の可能性があります。${head}金額の読み違いがないか確認してください。`+cav; return; }
      box.textContent=pre+`読み取り漏れや重複の可能性があります。明細合計 ${yen(itemSum)} は${Tlabel} より ${yen(resid)} ${info.direction==='more'?'多い':'少ない'}です。${info.direction==='more'?'写真の境目で同じ商品が重なっていないか':'読み取れていない商品がないか'}確認してください。`+cav; }
  }
  // v1.4: OCR runs with its own timeouts because tesseract.js can wait forever when language data cannot be loaded
  const OCR_PARAMS={tessedit_pageseg_mode:'6',user_defined_dpi:'300'};
  const OCR_MSG={
    offline:'初回の読み取りにはインターネット接続が必要です（文字認識データ 約33MB をダウンロードします）。接続してからもう一度お試しください',
    lib:'文字認識エンジンを読み込めませんでした。通信状態を確認して、アプリを開き直してからお試しください',
    init:'文字認識の準備に失敗しました。通信状態を確認してもう一度お試しください（初回は約33MB のダウンロードが必要です）',
    timeout:'読み取りに時間がかかりすぎています。通信状態を確認して、もう一度お試しください',
    image:'写真を開けませんでした。別の写真で試すか、撮り直してください',
    allfailed:'写真を読み取れませんでした。写真を確認してもう一度お試しください',
    page:'読み取りに失敗しました。写真を確認してもう一度お試しください',
    cancel:'読み取りを中止しました'
  };
  function ocrMessage(e){ const c=e&&e.code; if(navigator.onLine===false&&c!=='image'&&c!=='cancel') return OCR_MSG.offline; return OCR_MSG[c]||OCR_MSG.page; }
  function withTimeout(p,ms,code){ let t; return Promise.race([p,new Promise((_,rej)=>{t=setTimeout(()=>rej(ocrError(code)),ms);})]).finally(()=>clearTimeout(t)); }
  function setOcrProgress(p,status){ const v=Math.max(0,Math.min(100,Math.round(p))); $('#ocrPercent').textContent=`${v}%`; $('#ocrProgress').style.width=`${v}%`; if(status) $('#ocrStatus').textContent=status; }
  function setOcrBusy(b){
    ocrBusy=b;
    ['#readAllBtn','#clearPhotosBtn','#cameraInput','#galleryInput'].forEach(s=>{const el=$(s); if(el) el.disabled=b;});
    $$('#photoQueue button').forEach(el=>{el.disabled=b;});
    $$('.scan-card .upload-btn').forEach(el=>el.classList.toggle('disabled',b));
    const c=$('#cancelOcrBtn'); if(c){ c.hidden=!b; c.disabled=!b; }
  }
  // v1.4: text already read from a photo is kept, so adding the next part of a long receipt reads only the new photo
  const ocrTextCache=new WeakMap();
  let confirmEdited=false;
  async function runOCR(opt){
    const append=!!(opt&&opt.append);
    if(ocrBusy) return;
    if(!pendingPhotos.length){toast('レシート写真を追加してください');return;}
    if(!append&&hasUnsavedResult&&!(await askConfirm('確認中の読み取り結果は破棄されます。もう一度読み取りますか？',{ok:'読み取る'}))) return;
    const photos=pendingPhotos.slice(), totalPages=photos.length, previews=photoPreviewURLs.slice();
    showView('scanView'); setOcrBusy(true);
    const panel=$('#ocrPanel'); panel.classList.remove('hidden'); setOcrProgress(0,'準備中…');
    setTimeout(()=>{ try{ panel.scrollIntoView({behavior:'smooth',block:'center'}); }catch(_){ } },60);
    let worker=null, paddle=null, pageIndex=0, initFail=null, abandoned=false;
    const pages=[], raws=[], failedPages=[]; ocrDiag=[]; const runStart=performance.now();
    const abort={cancelled:false,reject:null}; ocrAbort=abort;
    const cancelable=p=>Promise.race([p,new Promise((_,rej)=>{abort.reject=rej; if(abort.cancelled) rej(ocrError('cancel'));})]);
    try{
      // 1) PaddleOCR (high accuracy, runs on the device)  2) Tesseract only when PaddleOCR cannot start
      try{
        paddle=await cancelable(withTimeout(loadPaddle(f=>{ if(!abort.cancelled&&!paddleEngine) $('#ocrStatus').textContent=f>=1?'読み取りエンジンを起動しています…':`読み取りエンジンを準備中（初回のみ約33MB）… ${Math.round(f*100)}%`; }),300000,'timeout'));
      }catch(e){
        if(abort.cancelled||(e&&e.code==='cancel')) throw ocrError('cancel');
        console.warn('PaddleOCR unavailable',e); paddle=null;
      }
      if(!paddle){
      if(!window.Tesseract||typeof Tesseract.createWorker!=='function') throw ocrError(navigator.onLine===false?'offline':'lib');
      toast('高精度エンジンを使えないため、従来のエンジンで読み取ります',{error:true});
      const failed=new Promise((_,rej)=>{initFail=rej;});
      const created=Tesseract.createWorker(['jpn','eng'],1,{
        logger:m=>{
          if(abort.cancelled||!m) return;
          const st=`${Math.min(pageIndex+1,totalPages)}/${totalPages}枚目：${statusJa(m.status)}`;
          if(m.status==='recognizing text') setOcrProgress((pageIndex+(Number(m.progress)||0))/totalPages*100,st);
          else $('#ocrStatus').textContent=st;
        },
        errorHandler:e=>{ console.warn('OCR worker error',e); if(initFail) initFail(ocrError('init',e)); }
      });
      created.then(w=>{ if(abandoned){ try{ w.terminate(); }catch(_){ } } },()=>{});
      try{ worker=await cancelable(withTimeout(Promise.race([created,failed]),120000,'timeout')); }
      catch(e){ abandoned=true; throw e; }
      initFail=null;
      if(OCR_PARAMS) await cancelable(worker.setParameters(OCR_PARAMS));
      }
      for(pageIndex=0;pageIndex<totalPages;pageIndex++){
        if(abort.cancelled) break;
        setOcrProgress(pageIndex/totalPages*100,`${pageIndex+1}/${totalPages}枚目を準備中…`);
        if(previews[pageIndex]) $('#receiptPreview').src=previews[pageIndex];
        let canvas=null;
        try{
          let raw='';
          const cachedText=ocrTextCache.get(photos[pageIndex]);
          if(typeof cachedText==='string'){ raw=cachedText; }
          else if(paddle){
            const pi=pageIndex;
            raw=await cancelable(withTimeout(paddleRecognize(paddle,photos[pi],(kind,k,n)=>{ if(abort.cancelled) return; if(kind==='det') $('#ocrStatus').textContent=`${pi+1}/${totalPages}枚目：文字の場所を探しています…`; else { $('#ocrStatus').textContent=`${pi+1}/${totalPages}枚目：文字を読み取り中（${k+1}/${n}）`; setOcrProgress((pi+(k+1)/Math.max(1,n))/totalPages*100); } },()=>abort.cancelled),180000,'timeout'));
          }else{
            canvas=await cancelable(preprocess(photos[pageIndex]));
            let blob=await cancelable(canvasToBlob(canvas)); releaseCanvas(canvas); canvas=null;
            $('#ocrStatus').textContent=`${pageIndex+1}/${totalPages}枚目を読み取り中…`;
            const ret=await cancelable(withTimeout(worker.recognize(blob),90000,'timeout')); blob=null;
            raw=(ret&&ret.data&&ret.data.text)||'';
          }
          if(typeof cachedText!=='string') ocrTextCache.set(photos[pageIndex],raw);
          raws.push(raw); pages.push(parseReceipt(raw));
        }catch(e){
          if(abort.cancelled||(e&&e.code==='cancel')) throw ocrError('cancel');
          if(e&&e.code==='timeout') throw e;
          console.warn(e); failedPages.push(pageIndex+1); raws.push(`（${pageIndex+1}枚目は読み取れませんでした）`);
          if(totalPages>1) toast(`${pageIndex+1}枚目を読み取れませんでした。ほかの写真は続けて読み取ります`,{error:true});
          if(e&&e.code==='image'&&totalPages===1) throw e;
        }finally{ releaseCanvas(canvas); }
        setOcrProgress((pageIndex+1)/totalPages*100);
      }
      if(abort.cancelled) throw ocrError('cancel');
      if(!pages.length) throw ocrError('allfailed');
      ocrRaw=raws.map((x,i)=>`===== ${i+1}枚目 =====\n${x}`).join('\n\n'); const p=mergeReceiptPages(pages);
      // names corrected before at this store replace the same misreading; every item remembers what was read
      const fixes=loadNameFixes();
      p.items.forEach(it=>{ const f=fixes.length?findNameFix(p.store,it.name,it.amount,fixes):null; if(f&&f.n!==it.name){ it._ocrName=it.name; it.name=f.n; if(!it._manual){ const cls=classifyItem(f.n,p.store); it.category=cls.category; it._source=cls.source; } it._hint=addHint(it._hint,`前に直した名前にしました（読み取り：${it._ocrName}）`); } if(it._ocrName==null) it._ocrName=it.name; });
      parsedItems=p.items; ocrMeta=p.meta; ocrTotalSource=p.totalSource; hasUnsavedResult=true; ocrPhotoCount=totalPages;
      $('#dateField').value=p.date; $('#storeField').value=p.store; totalAuto=null; confirmEdited=false; $('#totalField').value=p.total||''; $('#totalField').dataset.edited=''; setTimeout(()=>{ loadConfirmTaxPanel(); initTotalAuto(true); updateSumCheck(); },0); $('#rawText').textContent=ocrRaw; $('#confirmPhotoCount').textContent=`${totalPages}枚を1件として読み取り${paddle?'':'（従来エンジン）'}`;
      renderConfirmNotes(p,failedPages); renderItemEditor(); updateSumCheck(); confirmEdited=false; updateAddPageBtn(); renderOcrDiag(p,paddle?'PaddleOCR':'Tesseract',Math.round(performance.now()-runStart)); showView('confirmView'); if(!p.items.length) toast('商品明細を確認・修正してください');
    }catch(e){
      if(e&&e.code==='cancel') toast(OCR_MSG.cancel);
      else { console.warn(e); toast(ocrMessage(e),{error:true}); }
    }finally{
      ocrAbort=null; abandoned=true;
      if(worker){ try{ await worker.terminate(); }catch(_){ } }
      setOcrBusy(false); $('#ocrPanel').classList.add('hidden'); $('#receiptPreview').removeAttribute('src');
    }
  }
  function statusJa(s){const t=String(s||'');const map=[['loading tesseract core','OCRエンジン読込中'],['initializing tesseract','OCR初期化中'],['loading language traineddata','日本語データ読込中'],['initializing api','認識準備中'],['recognizing text','文字を読み取り中']];for(const [k,v] of map){if(t.indexOf(k)===0)return v;}return t||'処理中';}
  function renderConfirmNotes(p,failedPages){
    const notes=[], m=p.merge||{};
    if(!p.dateFound) notes.push(['warning','日付を読み取れなかったため、今日の日付を入れています。レシートの日付を確認してください。']);
    if(p.totalSource==='cash') notes.push(['notice','合計の行が読めなかったため「お預り − お釣り」から合計金額を入れています。']);
    else if(p.totalSource==='card') notes.push(['notice','合計の行が読めなかったため、カード・電子マネーの支払額を合計金額に入れています。']);
    else if(p.totalSource==='subtotal') notes.push(['notice','合計の行が読めなかったため、小計（＋外税）を合計金額に入れています。']);
    if(p.photoCount>1){
      const parts=[];
      if(m.removed) parts.push(`写真の境目で重なった ${m.removed} 行は1回分として扱いました`);
      if(m.restored) parts.push(`合計と合うよう、境目の ${m.restored} 行は重複扱いにせず残しました`);
      if(m.flagged) parts.push('黄色の行は、境目で重なった・欠けた可能性がある行です');
      if(parts.length) notes.push(['notice',parts.join('。')+'。']);
    }
    if(m.droppedTotalLike) notes.push(['notice','合計と同じ金額の行は、合計行の読み違いとして明細から外しました。']);
    { const pa=m.pointAfter; if(pa){ const Y=n=>`¥${Math.round(n).toLocaleString('ja-JP')}`;   // v1.10.15: what was done with points printed after the total line
      if(pa.kind==='applied') notes.push(['notice',`合計 ${Y(pa.T)} の後にポイント値引 ${Y(pa.pts)} があり、支払額 ${Y(pa.paid)} と合うため、値引後の ${Y(pa.paid)} を合計金額にしました（値引 ${Y(pa.pts)} として記録します）。`]);
      else if(pa.kind==='included') notes.push(['notice',`合計 ${Y(pa.T)} は、ポイント値引 ${Y(pa.pts)} を引いた後の金額です（明細から値引を引くと合計と合います）。値引は二重には引いていません。`]);
      else if(pa.kind==='open') notes.push(['warning',`合計 ${Y(pa.T)} の後にポイント値引 ${Y(pa.pts)} がありますが、支払額の行が読み取れず、合計から引かれたかを確かめられません。合計金額は印字のまま ${Y(pa.T)} にしています。レシートで支払額を確認してください（値引後の金額を払った場合は、「税・値引きを確認／修正」で確認済みにすると合計の候補が出ます。値引でない場合は値引を0にしてください）。`]);
      else if(pa.kind==='pay') notes.push(['notice',`合計 ${Y(pa.T)} のうち ${Y(pa.pts)} はポイントで支払っています（ポイント利用は支払方法として扱い、支出は合計 ${Y(pa.T)} で記録します）。ポイントで払った分を支出に含めない場合は、「税・値引きを確認／修正」の値引に ${Math.round(pa.pts)} と入力してください。`]); } }
    if(m.droppedSubtotalLike) notes.push(['notice','小計の読み違いと思われる行を明細から外しました。']);
    { const cx=(m.cancelled||[]).filter(c=>!c.part), px=(m.cancelled||[]).filter(c=>c.part), Y=n=>`¥${Math.round(n).toLocaleString('ja-JP')}`;   // v1.10.16   // v1.10.17: part of a quantity, another photo
      if(cx.length) notes.push(['notice',`取消・返品の行があったため、${cx.map(c=>`${c.name} ${Y(c.a)}${c.other?'（前の写真の商品）':''}`).join('、')} を明細から外しました（レシートで確認してください）。`]);
      if(px.length) notes.push(['notice',`取消・返品の行があったため、${px.map(c=>`${c.name} から ${Y(c.a)}${c.q0?`（${c.q0}個 → ${c.q1}個）`:''}`).join('、')} を差し引きました（数量の一部の取消とみています。レシートで確認してください）。`]); }   // v1.10.18: and the count
    if(failedPages&&failedPages.length) notes.push(['warning',`${failedPages.join('・')}枚目は読み取れませんでした。必要なら撮り直して追加してください。`]);
    const box=$('#confirmNotes'); if(!box) return;
    box.innerHTML=notes.map(([k,t])=>`<p class="note ${k}">${esc(t)}</p>`).join(''); box.classList.toggle('hidden',!notes.length);
  }
  // 診断情報: reading details for checking problems (inside 「OCR原文を確認」, closed by default).
  // With localStorage 'kakeibo-debug' = '1' the same details are also written to the console.
  function renderOcrDiag(p,engineName,ms){
    const box=$('#ocrDiag'); if(!box) return;
    const pages=ocrDiag.map((d,i)=>[`${i+1}枚目: 写真 ${d.size.photo.join('×')} → 処理 ${d.size.work.join('×')} → 文字検出 ${d.det.join('×')}${d.redetect&&typeof d.redetect==='object'?`（文字が小さいため文字範囲 ${d.redetect[0]}×${d.redetect[1]} を${d.redetect[2]>1?`${d.redetect[2]}分割して`:''}検出し直し）`:''}`,
      `  向きの補正 ${d.turn||0}° / 文字の高さ ${d.textPx}px / 初回の検出行 ${d.firstLines} / 検出行 ${d.lines} / 平均の確からしさ ${d.avgConf} / 低い行 ${d.lowConf} / 金額列 ${d.priceBoxes}`,
      d.rescue?`  紙の範囲から読み直し: ${d.rescue.join('×')}（${d.crop==='used'?'こちらを採用':d.crop==='kept'?'元の読み取りを採用':'行が見つからず元の読み取り'}${d.cropQuality?`、品質 ${d.cropQuality.join(' → ')}`:''}）`:'',
      d.first?`  1回目の読み取り: ${d.first}${d.firstOk?'（そのまま採用）':''}`:'', !d.firstOk&&!d.rescue&&d.crop?`  救済なし（${d.crop==='no paper'?'紙の範囲が分からない':'紙が写真の大部分を占める'}）`:'',
      `  金額の読み直し ${d.rereadTried||0}回${d.rereadSkipped?'（明細と合計が合うため省略）':''}${d.reread.length?`: ${d.reread.join('、')}`:''}`, d.priceFix.length?`  金額の文字補正: ${d.priceFix.join('、')}`:'',
      `  時間: 1回目の検出と読み取り ${d.msRead1||0}ms${d.msPaper!=null?` / 紙の範囲 ${d.msPaper}ms`:''}${d.msRescue!=null?` / 救済 ${d.msRescue}ms`:''} / この写真 ${d.msTotal}ms`].filter(Boolean).join('\n'));
    const sum=p.items.reduce((s,x)=>s+(Number(x.amount)||0),0), info=sumCheckInfo(sum,Number(p.total)||0,p.meta,p.totalSource);
    const text=[`エンジン: ${engineName} / 合計時間 ${ms}ms`,...pages,`商品 ${p.items.length}件 / 明細合計 ${sum} / レシート合計 ${p.total||0}（${({total:'合計の行',subtotal:'小計の行',cash:'お預り−お釣り',card:'支払額',items:'明細の合計'})[p.totalSource]||'なし'}）/ 外税 ${p.meta&&p.meta.exTax||0} / 明細と合計: ${info.estimated?'外税を推定して一致':(({ok:'一致',explained:'税・値引を含めて一致',small:'少し違う',large:'大きく違う',noTotal:'合計なし',empty:'明細なし'})[info.level]||info.level)}`].join('\n');
    box.textContent=text;
    try{ if(localStorage.getItem('kakeibo-debug')==='1') console.info('[kakeibo OCR]\n'+text); }catch(_){ }
  }
  // v1.10.18: a row with a name whose amount field is blank (being typed: 全選択→Backspace→2000, or a row added and not filled in yet). It is not an item of
  // ¥0: nothing is calculated from it (the confirm screen and the editor wait for the amount). 0 typed on purpose is an amount (_zero).
  function amtBlank(it){ return !!it&&!!String(it.name||'').trim()&&!(Number(it.amount)>0)&&!it._zero; }
  function itemQty(it){ const q=Math.round(Number(it&&it.qty)||0); if(q>=1) return Math.min(99,q); const m=String(it&&it._hint||'').match(/数量\s*(\d{1,2})\s*×/); return m&&Number(m[1])>1?Math.min(99,Number(m[1])):1; }
  function renderItemEditor(){
    const el=$('#itemsEditor');el.innerHTML=''; if(!parsedItems.length) parsedItems.push({name:'',amount:0,category:'未分類',_source:'unknown',_manual:false});
    ensureRowIds(parsedItems);
    const store=$('#storeField')?.value||'';
    parsedItems.forEach((it,i)=>{
      if(!it.category){const cls=classifyItem(it.name,store);it.category=cls.category;it._source=cls.source;}
      const options=CATEGORIES.map(cat=>`<option value="${esc(cat)}"${cat===it.category?' selected':''}>${esc(cat)}</option>`).join('');
      const q=itemQty(it); if(q>1) it.qty=q;
      // the count is shown by the stepper, so the parser's 数量 note is left out of the hint (it would go stale after ＋/−)
      const hintText=String(it._hint||'').replace(/数量\s*\d+\s*×\s*[¥￥]?[\d,]+/,'').replace(/^\s*[／/]\s*|\s*[／/]\s*$/g,'').replace(/\s*[／/]\s*[／/]\s*/g,'／').trim();
      const row=document.createElement('div');row.className='item-row'+(it._flag?` flag-${it._flag}`:'')+(it._suspect?' suspect':'');
      row.innerHTML=`<label class="item-name"><span class="lbl">商品名</span><input data-k="name" placeholder="商品名" data-i="${i}" value="${esc(it.name)}" maxlength="100" autocomplete="off"></label><label class="item-amount"><span class="lbl">金額</span><input data-k="amount" placeholder="金額" data-i="${i}" type="number" inputmode="numeric" min="0" value="${it._zero?'0':(it.amount||'')}"></label><button type="button" data-del="${i}" aria-label="商品を削除">×</button><label class="item-category"><span class="lbl">分類</span><select data-k="category" data-i="${i}">${options}</select><small data-source="${i}">${esc(categorySourceLabel(it._source))}</small></label><div class="item-qty" role="group" aria-label="数量"><button type="button" data-qminus="${i}" aria-label="数量を1つ減らす"${q<=1?' disabled':''}>−</button><span class="qty-val" data-qv="${i}" aria-live="polite">${q}</span><button type="button" data-qplus="${i}" aria-label="数量を1つ増やす">＋</button><small class="qty-unit" data-qu="${i}">${q>1?`@${esc(yen(Math.round((Number(it.amount)||0)/q)))}`:''}</small></div>${hintText?`<p class="item-hint">${esc(hintText)}</p>`:''}`;
      el.appendChild(row);
    });
    // one listener per field, registered once per render (v1.6: the amount listener used to be added inside the input handler)
    el.querySelectorAll('input[data-k="amount"]').forEach(inp=>inp.addEventListener('input',()=>{ const i=Number(inp.dataset.i), it=parsedItems[i]; if(it&&it._suspect){ it._suspect=false; const row=inp.closest('.item-row'); if(row) row.classList.remove('suspect'); } }));
    el.querySelectorAll('input[data-k]').forEach(inp=>inp.addEventListener('input',()=>{
      const i=Number(inp.dataset.i),it=parsedItems[i];
      if(inp.dataset.k==='amount'){const t=String(inp.value).trim();it.amount=t===''?0:Number(t);if(t!==''&&it.amount===0)it._zero=true;else delete it._zero;it._base={amount:Number(it.amount)||0,qty:itemQty(it)};   /* v1.10.18: blank (being typed) and an entered 0 are kept apart */const q=itemQty(it),u=inp.closest('.item-row').querySelector(`[data-qu="${i}"]`);if(u)u.textContent=q>1?`@${yen(Math.round((Number(it.amount)||0)/q))}`:'';updateSumCheck();return;}
      it.name=inp.value;
      if(!it._manual){const cls=classifyItem(it.name,$('#storeField')?.value||'');it.category=cls.category;it._source=cls.source;const row=inp.closest('.item-row');const sel=row.querySelector('select[data-k="category"]');if(sel)sel.value=it.category;const hint=row.querySelector(`[data-source="${i}"]`);if(hint)hint.textContent=categorySourceLabel(it._source);}
    }));
    el.querySelectorAll('select[data-k="category"]').forEach(sel=>sel.addEventListener('change',()=>{
      const i=Number(sel.dataset.i),it=parsedItems[i];it.category=sel.value;it._manual=true;it._source='manual';const hint=sel.closest('.item-row').querySelector(`[data-source="${i}"]`);if(hint)hint.textContent=categorySourceLabel('manual');
    }));
    el.querySelectorAll('[data-qminus],[data-qplus]').forEach(b=>b.addEventListener('click',()=>{
      const i=Number(b.dataset.qminus!=null?b.dataset.qminus:b.dataset.qplus), it=parsedItems[i]; if(!it) return;
      const q0=itemQty(it), q1=Math.max(1,Math.min(99,q0+(b.dataset.qplus!=null?1:-1))); if(q1===q0) return;
      if(!it._base) it._base={amount:Number(it.amount)||0,qty:q0}; const unit=Math.round(it._base.amount/it._base.qty); it.qty=q1; it.amount=Math.round(it._base.amount*q1/it._base.qty); if(it._suspect) it._suspect=false; if(totalAuto) totalAuto.follow=true;
      const row=b.closest('.item-row'), amt=row.querySelector('input[data-k="amount"]'); if(amt) amt.value=String(it.amount);
      row.querySelector(`[data-qv="${i}"]`).textContent=String(q1); row.querySelector(`[data-qu="${i}"]`).textContent=q1>1?`@${yen(unit)}`:'';
      row.querySelector(`[data-qminus="${i}"]`).disabled=q1<=1; row.classList.remove('suspect'); updateSumCheck();
    }));
    el.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click',()=>{const rm=parsedItems.splice(Number(b.dataset.del),1)[0];if(rm&&ocrMeta)cancelResolveDel(ocrMeta,rm);renderItemEditor();updateSumCheck();}));   // v1.10.17: removing the item an open 取消 line took back settles it
    const learned=$('#learnedCount'); if(learned) learned.textContent=`${learnedCount()}件を記憶中`; if($('#scanView')?.classList.contains('active'))renderLearningPanel();
    updateSumCheck();
  }
  function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}

  async function saveReceipt(){
    if(savingReceipt) return;
    // v1.10.7: the panel is checked again right before saving. An invalid input stops the save (the earlier amount is not saved in its place)
    { const tp=$('#taxPanel'), shown=!!(tp&&tp._taxCheck&&!tp.classList.contains('hidden')), okPanel=!shown||tp._taxCheck();   // v1.10.9: also judged from the data of the panel, not only from the fields that are visible
      if(!okPanel||Object.keys((confirmTaxUi&&confirmTaxUi.bad)||{}).length){ toast('税・値引きの入力に誤りがあります。直すか、入力を取り消してから保存してください',{error:true}); return; } }
    // v1.10.16: an empty date field is not saved as today without asking (before, a cleared date was quietly saved as today)
    if(!$('#dateField').value){ const t=todayISO(); if(!(await askConfirm(`日付が空欄です。今日（${Number(t.slice(5,7))}月${Number(t.slice(8,10))}日）の日付で保存しますか？\n\n別の日のレシートなら「キャンセル」を押して日付を選んでください。`,{ok:`${Number(t.slice(5,7))}月${Number(t.slice(8,10))}日で保存`}))) { $('#dateField').focus(); return; } if(!$('#dateField').value) $('#dateField').value=t; }
    const date=$('#dateField').value||todayISO(), store=$('#storeField').value.trim()||'レシート';
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!validDateParts(Number(date.slice(0,4)),Number(date.slice(5,7)),Number(date.slice(8,10)))){toast('日付を確認してください（2000年〜2099年）',{error:true});$('#dateField').focus();return;}   // v1.10.14: the same range as 手入力・編集 and the backup (a 1999 date could be saved here and was then left out of a restore)
    const filled=x=>String(x.name||'').trim()&&Number(x.amount)>0;
    const named=parsedItems.filter(filled), partial=parsedItems.filter(x=>!filled(x)&&(String(x.name||'').trim()||Number(x.amount)>0));
    if(partial.length&&!(await askConfirm(`商品名か金額が空の行が ${partial.length} 行あります。この行は保存されません。保存しますか？`,{ok:'保存する'}))) return;
    const clean=named.map(x=>{const category=CATEGORIES.includes(x.category)?x.category:guessCategory(x.name,store);const q=itemQty(x);return Object.assign({name:String(x.name).trim(),amount:Math.round(Number(x.amount)),category},q>1?{qty:q}:{},itemTaxFields(x));});   // v1.10.7: the 内 / 外 mark and rate printed on the item line are kept with the item
    const rawTotal=String($('#totalField')?.value??'').trim(), amount=Math.round(Number(rawTotal));
    if(!rawTotal||!isFinite(amount)||amount<=0){toast('合計金額を確認してください（空欄・0円・マイナスでは保存できません）',{error:true});$('#totalField')?.focus();return;}
    if(amount>MAX_AMOUNT||clean.some(x=>x.amount>MAX_AMOUNT)){toast('金額が大きすぎます。入力を確認してください',{error:true});return;}
    const learn=named.filter(x=>x._manual).map(x=>[String(x.name).trim(),x.category]);
    savingReceipt=true; const btn=$('#saveReceiptBtn'); btn.disabled=true;
    try{
      const om=(typeof ocrMeta==='object'&&ocrMeta)||{};
      const rec={id:uid(),date,store,amount,category:'レシート',items:clean,source:'receipt',photoCount:Math.max(1,ocrPhotoCount||pendingPhotos.length),createdAt:Date.now()};
      // v1.10.6: tax and discount are saved in the class they have on the screen (外税 = added, 内税 = inside the prices, unknown = unknown),
      // together with how each amount was obtained. Nothing is moved into 外税 because a sum happens to agree (before, 内税 that closed the gap was saved as 外税).
      om.itemBasis=itemBasisOf(clean);
      // v1.10.15: also when the item sum is the same but the items by tax mark and rate are not (8% ¥2,000 ＋ 10% ¥1,000 instead of 8% ¥1,000 ＋ 10% ¥2,000):
      // the item sum alone made the tax look like the tax of these items. The items the tax belongs to are kept with it (taxForMix).
      { const sx=staleTax(), sum=clean.reduce((t,x)=>t+x.amount,0), mix=taxMixOf(clean); let S=sx?sx.S:0, X=sx?sx.mix:'';
        // v1.10.18: a 外税 calculated as ¥0 for other items (the 外 items were ¥0 for a while) is not saved as "no tax": the tax that was read goes back
        // with the items it was read for, so the record stays unconfirmed (before, nothing was saved and the record agreed without its 外税)
        { const a=totalAuto; if(sx&&!(sx.cur>0)&&a&&a.taxKey==='exTax'&&a.tax0>0&&a.S0>0){ om.exTax=a.tax0; om.taxSrc=Object.assign({},om.taxSrc,{ex:((a.snap0&&a.snap0.taxSrc)||{}).ex||''}); om.taxForRows=taxRowsRead(a.rows0); S=a.S0; X=a.mix0; } }
        if(sx&&S>0){ om.taxFor=S; if(validTaxMix(X)) om.taxForMix=X; else delete om.taxForMix; } else { delete om.taxFor; delete om.taxForMix; } }   // v1.10.20: a stale row binding is retained even when both sums and aggregate tax mixes agree
      const tf=taxFieldsForSave(om); Object.assign(rec,tf.fields); rec.taxMeta=tf.taxMeta;
      await putExpense(rec);
    }catch(e){ console.warn(e); toast('保存できませんでした。入力内容はそのまま残っています。もう一度「保存」を押してください',{error:true}); return; }
    finally{ savingReceipt=false; btn.disabled=false; }
    // learning is written only after the receipt was saved
    learn.forEach(([n,c])=>rememberCategory(n,c));
    named.forEach(x=>{ if(x._ocrName&&nameKey(x._ocrName)!==nameKey(x.name)) rememberNameFix(store,x._ocrName,x.name,x.amount); });
    renderLearningPanel(); requestPersist(); resetScan(); await refreshAggregates().catch(()=>{}); toast('保存しました'); showView('homeView');
  }
  function resetScan(){ocrRaw='';parsedItems=[];ocrMeta=null;ocrTotalSource='';hasUnsavedResult=false;ocrPhotoCount=0;$('#ocrPanel').classList.add('hidden');$('#sumCheck').classList.add('hidden');$('#confirmPhotoCount').textContent='';$('#receiptPreview').removeAttribute('src');const n=$('#confirmNotes');if(n){n.innerHTML='';n.classList.add('hidden');}$('#totalField').dataset.edited='';totalAuto=null;{const tp=$('#taxPanel');if(tp){tp.classList.add('hidden');tp.open=false;tp.innerHTML='';}}const pt=$('#pasteText');if(pt)pt.value='';clearReceiptPhotos();updateResumeButton();}
  // v1.4: text recognized by the iPhone itself (Live Text / "テキストをスキャン") instead of the in-app OCR
  async function readPastedText(){
    if(ocrBusy) return;
    const text=String($('#pasteText').value||'').trim();
    if(!text){ toast('レシートの文字を入れてください',{error:true}); return; }
    if(hasUnsavedResult&&!(await askConfirm('確認中の読み取り結果は破棄されます。この文字で読み取りますか？',{ok:'読み取る'}))) return;
    // v1.10.10: a line such as 「----- 区切り -----」 (or 「----- 2枚目 -----」) splits the text into parts that are read like separate photos of one receipt:
    // lines that are in both parts count once, as with photos. Plain rules of dashes, which receipts print themselves, do not split.
    const parts=text.split(/\n[ \t　]*[-=－＝]{3,}[ \t　]*(?:区切り|[0-9０-９]+枚目)[ \t　]*[-=－＝]{3,}[ \t　]*(?=\n|$)/).map(t=>t.trim()).filter(Boolean);
    const p=mergeReceiptPages((parts.length?parts:[text]).map(t=>parseReceipt(pairColumnLines(t))));
    ocrRaw=`===== 貼り付けた文字 =====\n${text}`; parsedItems=p.items; ocrMeta=p.meta; ocrTotalSource=p.totalSource; hasUnsavedResult=true; ocrPhotoCount=0;
    $('#dateField').value=p.date; $('#storeField').value=p.store; totalAuto=null; confirmEdited=false; $('#totalField').value=p.total||''; $('#totalField').dataset.edited=''; setTimeout(()=>{ loadConfirmTaxPanel(); initTotalAuto(true); updateSumCheck(); },0); $('#rawText').textContent=ocrRaw; $('#confirmPhotoCount').textContent='iPhoneの文字認識から読み取り';
    renderConfirmNotes(p,[]); renderItemEditor(); updateSumCheck(); showView('confirmView'); if(!p.items.length) toast('商品明細を確認・修正してください');
  }
  function updateResumeButton(){const b=$('#resumeConfirmBtn');if(b)b.classList.toggle('hidden',!hasUnsavedResult);}
  let persistAsked=false;
  function requestPersist(){ if(persistAsked) return; persistAsked=true; try{ if(navigator.storage&&navigator.storage.persist) navigator.storage.persisted().then(p=>p||navigator.storage.persist()).catch(()=>{}); }catch(_){ } }

  async function refreshAggregates(){
    await Promise.all([renderHome(),renderCalendar(),renderGraph()]);
  }

  let homeCache=null;
  async function renderHome(){
    const all=await allExpenses(), now=new Date(), ym=`${now.getFullYear()}-${pad(now.getMonth()+1)}`; homeCache=all.slice(); const month=all.filter(x=>x.date.startsWith(ym));
    const total=month.reduce((s,x)=>s+x.amount,0), today=month.filter(x=>x.date===todayISO()).reduce((s,x)=>s+x.amount,0);
    $('#monthLabel').textContent=`${now.getFullYear()}年${now.getMonth()+1}月の支出`;$('#categoryMonthLabel').textContent=`${now.getMonth()+1}月`;
    $('#monthTotal').textContent=yen(total);$('#todayTotal').textContent=yen(today);$('#monthCount').textContent=`${month.length}件`;$('#dailyAvg').textContent=yen(total/Math.max(1,now.getDate()));
    const cats={}; month.forEach(x=>addExpenseCategories(cats,x));
    const ce=$('#categoryBars');ce.innerHTML=''; const max=Math.max(1,...Object.values(cats)); const entries=Object.entries(cats).sort((a,b)=>b[1]-a[1]);
    if(!entries.length) ce.innerHTML='<div class="empty">まだ支出がありません</div>'; else entries.forEach(([k,v])=>{ce.insertAdjacentHTML('beforeend',`<div class="bar-row"><span>${esc(k)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round(v/max*100)}%;background:${catColor(k)}"></div></div><strong>${yen(v)}</strong></div>`)});
    fbMonthRows=month; fbToday=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`; try{ renderFoodBudget(); }catch(e){ console.warn(e); }   // v1.11.0: the same records and day as the bars above
    renderExpenseList($('#recentList'),all.sort((a,b)=>b.date.localeCompare(a.date)||b.createdAt-a.createdAt).slice(0,6),true,true);
    renderBackupInfo();
  }
  // ---- v1.11.0: 今月の食費 (a budget for 食費 and what is left of it this month) ----
  // The amount used is the 食費 of this month as the カテゴリ別 bars count it (addExpenseCategories: tax and receipt-level discounts spread over the
  // items in proportion), never a calculation of its own; 外食 is another category. Records dated later this month count, as they do in the bars.
  // The budget is kept in localStorage only: it is not part of the backup (format 1 is unchanged) and no expense is ever written for it.
  const FOOD_BUDGET_KEY='kakeibo_food_budget_v1', FOOD_BUDGET_CATEGORY='食費', FOOD_BUDGET_MAX=10000000;
  let fbMonthRows=null, fbToday='', fbEditing=false;
  function validFoodBudgetAmount(n){ return typeof n==='number'&&Number.isInteger(n)&&n>=1&&n<=FOOD_BUDGET_MAX; }
  // the stored text → {amount,updatedAt}, or null (unset) when it is missing, broken or out of range
  function parseFoodBudget(raw){
    if(raw==null||raw==='') return null;
    try{ const v=JSON.parse(raw); if(!v||typeof v!=='object'||Array.isArray(v)||!validFoodBudgetAmount(v.amount)) return null; const t=Number(v.updatedAt); return {amount:v.amount,updatedAt:Number.isFinite(t)&&t>0?t:0}; }catch(_){ return null; }
  }
  function loadFoodBudget(){ try{ return parseFoodBudget(localStorage.getItem(FOOD_BUDGET_KEY)); }catch(_){ return null; } }
  function saveFoodBudget(amount){ if(!validFoodBudgetAmount(amount)) return false; try{ localStorage.setItem(FOOD_BUDGET_KEY,JSON.stringify({amount,updatedAt:Date.now()})); return true; }catch(_){ return false; } }
  function clearFoodBudget(){ try{ localStorage.removeItem(FOOD_BUDGET_KEY); return true; }catch(_){ return false; } }
  // the text of the budget field → {ok:true,amount} or {ok:false,error}. A whole number of yen from 1 to 10,000,000
  function parseFoodBudgetInput(s){
    const t=String(s==null?'':s).normalize('NFKC').trim();
    if(!t) return {ok:false,error:'予算の金額を入力してください'};
    if(!/^[+-]?\d+(?:\.\d+)?$/.test(t)) return {ok:false,error:'予算は数字で入力してください'};
    const n=Number(t);
    if(!Number.isInteger(n)||n<1||n>FOOD_BUDGET_MAX) return {ok:false,error:'予算は1〜10,000,000円の整数で入力してください'};
    return {ok:true,amount:n};
  }
  // budget: an amount or {amount} (anything else is unset), expenses: saved records, today: 'YYYY-MM-DD' (local day). used + remaining = budget always
  function foodBudgetStatus(budget,expenses,today){
    const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(today||'')); if(!m) return null;
    const y=Number(m[1]), mo=Number(m[2]), d=Number(m[3]), ym=`${m[1]}-${m[2]}`, daysInMonth=new Date(y,mo,0).getDate();
    const month=(Array.isArray(expenses)?expenses:[]).filter(x=>x&&typeof x.date==='string'&&x.date.startsWith(ym));
    const food=categoryTotals(month)[FOOD_BUDGET_CATEGORY]||0, used=Math.round(food), daysLeft=Math.max(1,daysInMonth-d+1);
    const amount=budget&&typeof budget==='object'?budget.amount:budget;
    if(!validFoodBudgetAmount(amount)) return {set:false,ym,food,used,budget:null,remaining:null,over:false,overBy:0,percent:0,level:'',daysLeft,perDay:null};
    const remaining=amount-used, over=remaining<0, ratio=used/amount;
    return {set:true,ym,food,used,budget:amount,remaining,over,overBy:over?-remaining:0,percent:Math.min(100,Math.max(0,ratio*100)),level:over?'over':ratio>=0.8?'warm':'ok',daysLeft,perDay:over?null:Math.floor(remaining/daysLeft)};
  }
  function foodBudgetHtml(st){
    if(!st||!st.set) return `<p class="fb-empty">食費の予算を決めると、今月あといくら使えるかを表示します</p><button type="button" class="secondary full fb-edit" data-fb-edit>予算を設定</button>`;
    const pct=Math.round(st.percent*10)/10;
    return `<div class="fb-top"><span class="fb-label">${st.over?'今月の食費':'今月の食費 残り'}</span> <strong class="fb-amount"><span class="fb-num">${esc(yen(st.over?st.overBy:st.remaining))}</span>${st.over?' <span class="fb-over">オーバー</span>':''}</strong><button type="button" class="text-btn fb-edit" data-fb-edit aria-label="食費の予算を変更">変更</button></div>`
      +`<div class="fb-bar" role="progressbar" aria-label="食費の予算を使った割合" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.floor(st.percent)}"><div class="fb-fill" style="width:${pct}%"></div></div>`
      +`<p class="fb-line"><span class="fb-nw">使った ${esc(yen(st.used))}</span> ／ <span class="fb-nw">予算 ${esc(yen(st.budget))}</span></p>`
      +`<p class="fb-line">${st.over?`<span class="fb-nw">あと${st.daysLeft}日</span>`:`<span class="fb-nw">あと${st.daysLeft}日</span>・<span class="fb-nw">1日あたり ${esc(yen(st.perDay))}</span>`}</p>`;
  }
  // draws the card from the records and day of the last renderHome (the editor, while open, is left as it is)
  function renderFoodBudget(){
    const card=$('#foodBudgetCard'), view=$('#foodBudgetView'); if(!card||!view||!fbMonthRows) return;
    const st=foodBudgetStatus(loadFoodBudget(),fbMonthRows,fbToday||todayISO());
    card.classList.toggle('is-set',!!(st&&st.set)); card.classList.toggle('is-warm',!!(st&&st.level==='warm')); card.classList.toggle('is-over',!!(st&&st.level==='over'));
    view.innerHTML=foodBudgetHtml(st); view.classList.toggle('hidden',fbEditing);
  }
  function showFoodBudgetError(msg){ const e=$('#foodBudgetError'), i=$('#foodBudgetInput'); if(e){ e.textContent=msg||''; e.classList.toggle('hidden',!msg); } if(i){ if(msg) i.setAttribute('aria-invalid','true'); else i.removeAttribute('aria-invalid'); } }
  function openFoodBudgetEditor(){
    const b=loadFoodBudget(), f=$('#foodBudgetForm'), i=$('#foodBudgetInput'); if(!f||!i) return;
    fbEditing=true; i.value=b?String(b.amount):''; showFoodBudgetError('');
    $('#foodBudgetClearBtn').classList.toggle('hidden',!b); f.classList.remove('hidden'); $('#foodBudgetView').classList.add('hidden');
    try{ i.focus(); }catch(_){ }
  }
  function closeFoodBudgetEditor(){
    fbEditing=false; const f=$('#foodBudgetForm'); if(f) f.classList.add('hidden'); showFoodBudgetError(''); renderFoodBudget();
    try{ const b=$('#foodBudgetView [data-fb-edit]'); if(b) b.focus({preventScroll:true}); }catch(_){ }
  }
  function submitFoodBudget(){
    const r=parseFoodBudgetInput($('#foodBudgetInput').value);
    if(!r.ok){ const i=$('#foodBudgetInput'); showFoodBudgetError(i&&i.validity&&i.validity.badInput?'予算は数字で入力してください':r.error); try{ i.focus(); }catch(_){ } return; }
    if(saveFoodBudget(r.amount)){ closeFoodBudgetEditor(); toast('食費の予算を保存しました'); }
    else { closeFoodBudgetEditor(); toast('予算を保存できませんでした。端末の空き容量やプライベートブラウズの設定を確かめてください',{error:true}); }
  }
  async function removeFoodBudget(){
    if(!(await askConfirm('食費の予算を解除しますか？\n\n記録した支出はそのまま残ります。',{ok:'解除する',danger:true}))) return;
    if(clearFoodBudget()){ closeFoodBudgetEditor(); toast('食費の予算を解除しました'); }
    else { closeFoodBudgetEditor(); toast('予算を解除できませんでした。もう一度お試しください',{error:true}); }
  }
  // items of one saved record, shown under the row (built when first opened)
  function expenseDetailHtml(x){
    const items=Array.isArray(x.items)?x.items.filter(it=>it&&(it.name||it.amount)):[];
    if(!items.length) return x.source==='receipt'?'<div class="detail-empty">商品の明細はありません</div>':`<div class="detail-empty">手入力 ・ カテゴリ：${esc(x.category||'その他')}</div>`;
    const rows=items.map(it=>`<li><span class="d-name">${esc(it.name||'（名前なし）')}${Number(it.qty)>1?` <span class="d-qty">×${Math.round(Number(it.qty))}</span>`:''}</span><span class="d-cat">${esc(it.category||'')}</span><span class="d-amt">${yen(Number(it.amount)||0)}</span></li>`).join('');
    // v1.10.6: each tax / discount line says which way it counts and how the amount was obtained (an estimate stays visible as one)
    const tv=taxMetaOfRecord(x), line=(k,label,sign)=>{ const v=taxVal(tv,k); return v==null?'':`<div class="detail-extra"><span>${label}<small class="d-src">${esc(taxSrcText(tv,k))}</small></span><b>${sign}${yen(v)}</b></div>`; };
    return `<ul class="detail-items">${rows}</ul>${line('ex',tv.taxSrc.ex==='est'?'外税（推定）':'外税','')}${line('in','内税（商品金額に含む）','')}${line('unk','消費税（外税か内税か不明）','')}${line('disc','値引','−')}`;
  }
  function toggleExpenseDetail(row,x){
    const det=row.querySelector('.expense-detail'), btn=row.querySelector('.row-toggle'); if(!det) return;
    if(!det.dataset.ready){ det.innerHTML=expenseDetailHtml(x); det.dataset.ready='1'; }
    const open=det.hidden; det.hidden=!open; row.classList.toggle('open',open); if(btn) btn.setAttribute('aria-expanded',String(open));
  }
  function renderExpenseList(el,arr,withDelete=true,withEdit=false){
    el.innerHTML=''; if(!arr.length){el.innerHTML=`<div class="empty">${el.id==='recentList'?'まだ支出がありません':'この日の支出はありません'}</div>`;return;}
    arr.forEach(x=>{const row=document.createElement('div');row.className='expense-row';const did=`det-${el.id}-${String(x.id).replace(/[^\w-]/g,'')}`;row.classList.add('has-detail');row.innerHTML=`<div><button type="button" class="row-toggle" aria-expanded="false" aria-controls="${did}"><b>${esc(x.store||'支出')}</b><span class="chev" aria-hidden="true">▾</span><small>${esc(x.date)} · ${x.source==='receipt'?`${(x.items&&x.items.length)||0}商品`:esc(x.category||'その他')}</small></button></div><strong>${yen(x.amount)}</strong><div class="expense-detail" id="${did}" hidden></div><div class="row-actions">${withEdit?`<button type="button" class="edit-btn" data-edit-id="${esc(x.id)}">編集</button>`:''}${withDelete?`<button type="button" class="delete-btn" data-id="${esc(x.id)}" aria-label="${x.source==='receipt'?'このレシートを削除':'この支出を削除'}">削除</button>`:''}</div>`;
      // tapping the record (store name, date or amount) opens its items; the 編集 / 削除 buttons keep their own actions
      row.addEventListener('click',e=>{ if(e.target.closest('.row-actions')||e.target.closest('.expense-detail')) return; toggleExpenseDetail(row,x); });
      el.appendChild(row);});
    if(withEdit) el.querySelectorAll('.edit-btn').forEach(b=>b.addEventListener('click',()=>el.id==='recentList'?jumpToEdit(b.dataset.editId):openExpenseEditor(b.dataset.editId)));
    if(withDelete) el.querySelectorAll('.delete-btn').forEach(b=>b.addEventListener('click',async()=>{const target=arr.find(x=>x.id===b.dataset.id),label=target?.source==='receipt'?'本当にこのレシートを削除しますか？':'本当にこの支出を削除しますか？';if(await askConfirm(label,{ok:'削除する',danger:true})){try{b.disabled=true;const rowEl=b.closest('.expense-row');if(rowEl){rowEl.classList.add('removing');await new Promise(r=>setTimeout(r,180));}if(editingExpenseId===b.dataset.id)closeExpenseEditor();await deleteExpense(b.dataset.id);await refreshAggregates();toast('削除しました');}catch(e){console.warn(e);toast('削除できませんでした。もう一度お試しください',{error:true});}}}));
  }

  // v1.4: friendly colour per category (bars)
  const CATEGORY_COLORS={食費:'#f29b4b',日用品:'#4aaed4',外食:'#ec7063',交通:'#5b8def',医療:'#3db3a4',美容:'#e57fb3',衣類:'#9b83d6',ペット:'#c49a52',娯楽:'#f0bd3e',未分類:'#a9a39a',その他:'#c2bbb0'};
  function catColor(k){return CATEGORY_COLORS[k]||'#2f9e87';}
  function closeExpenseEditor(){editingExpenseId=null;editDraft=null;$('#expenseEditPanel').classList.add('hidden');$('#expenseEditItems').innerHTML='';document.body.classList.remove('sheet-open');}
  function catOptions(sel){return CATEGORIES.map(cat=>`<option value="${esc(cat)}"${cat===sel?' selected':''}>${esc(cat)}</option>`).join('');}
  // ---- v1.10.17: the 外税 of a saved record when its items change (the saved-record editor) ----
  // The 外税 kept with a record belongs to certain items (taxOwn: their sum and their amounts by tax mark and rate). Before, when the items changed, the
  // total followed them with that same tax (牛乳 ¥1,000 → ¥2,000: 外税 ¥80, 合計 ¥2,080, 一致), and the record was saved like that - after reloading,
  // nothing was left to show that the tax belonged to ¥1,000. Now the tax for the items as they are is calculated as on the confirm screen: from the tax
  // mark and rate of each item, with the roundings that give the kept tax for the items it belongs to (recTaxBase). The tax and the total change together.
  // When that is not possible (an item without a rate, a receipt-level discount whose split by rate is unknown, roundings that give different amounts,
  // something still open), nothing is calculated: the total stays, the check says why, and saving keeps the items the tax belongs to (taxFor /
  // taxForMix), so the record stays unconfirmed after reloading and restoring. Nothing is changed when a record is only opened.
  function mixBases(mix,one){ const b={}; for(const part of String(mix||'').split(',').filter(Boolean)){ const [k,a]=part.split(':'); if(k==='add') return null;   // v1.10.19: an item added by hand has no rate (never the receipt's one)
      const md=/^ex/.test(k)?'ex':/^in/.test(k)?'in':'', r=Number(k.replace(/^(?:ex|in)/,''))||one||0;
      if(md==='in') continue; if(r!==8&&r!==10) return null; b[r]=(b[r]||0)+Number(a); } return b; }   // the 外 (and unmarked) amounts by rate; null when one of them has no rate
  function mixTax(b,k){ return Object.keys(b).reduce((t,r)=>t+TAX_RND[k](b[r]*Number(r)),0); }
  function recTaxBase(m,items){ const ex=taxVal(m,'ex')||0, tf=Number(m.taxFor)||0, mix=tf>0?(validTaxMix(m.taxForMix)?m.taxForMix:null):taxMixOf(items), S=tf>0?tf:Math.round(items.reduce((t,x)=>t+(Number(x.amount)||0),0));
    const rows=taxRowsRead(m.taxForRows)||(!tf&&!m.taxRowsUnknown?taxRowsOf(items):null), b=ex>0&&mix?mixBases(mix,m.rate1):null; return {S,mix,rows,unknown:!!m.taxRowsUnknown,tax:ex,src:(m.taxSrc||{}).ex||'',methods:b?Object.keys(TAX_RND).filter(k=>mixTax(b,k)===ex):[]}; }
  // the 外税 in use and the items: stale = it belongs to other items; then ok + tax = the 外税 for these items, or why it cannot be calculated
  // v1.10.18: a 外税 calculated here (taxAuto) stays the calculated tax of the items also when it came to ¥0 for a moment. Before, a tax of ¥0 ended the
  // calculation: the amount of 牛乳 cleared (全選択→Backspace) gave 外税 ¥0, the 2,000 typed next was taken with no tax (合計 ¥2,000, 一致) and the record
  // was saved without its 外税. A ¥0 the person enters in the tax panel is theirs (taxAuto off) and is never recalculated.
  // An item the person added has no tax mark or rate from the receipt (_added): the tax is not calculated for it, as on the confirm screen. An item
  // without a mark is taken at the only rate printed on the receipt (rate1) only when the items the tax belongs to had no mark either.
  // v1.10.19: the items added by hand (isAdded, kept with the record as added: 1) are told apart from the items of the receipt in every comparison (taxMixOf
  // 'add'). Before, 牛乳 ¥500 ＋ 洗剤 ¥500 (added) was "the same items" as the 牛乳 ¥1,000 of the reading (same(own) / same(b) by the amounts per mark),
  // so the check said 一致 before the rate of 洗剤 was looked at. Items compared by their sum only (a record of v1.10.13 / v1.10.14 without taxForMix)
  // are never the same while an added item is there.
  // A record of an earlier version (no addMark) whose 外税 still belongs to the items it was saved with there (taxFor, items without a mark): which of
  // those items were added by hand was not kept, so neither the receipt's rate nor "back at the same amounts" is taken for them (legacyAdd).
  function recTaxNow(d,items){ const m=d.meta||{}, its=items||d.items, ex=taxVal(m,'ex')||0, own=d.taxOwn, b=d.tbase; if(!own||!(taxVal(m,'ex')!=null||d.taxAuto)) return {stale:false};
    const mixNow=taxMixOf(its), sumNow=Math.round(its.reduce((t,x)=>t+(Number(x.amount)||0),0)), added=its.some(it=>isAdded(it)&&Number(it.amount)>0), rowsNow=taxRowsOf(its), same=o=>!o.unknown&&(o.rows?sameTaxRows(o.rows,rowsNow):(o.mix?o.mix===mixNow&&!added:(o.S===sumNow&&!added)));
    const old=!!d.ownOld&&/(?:^|,)-:/.test(String(own.mix||''));
    const no=(why,k)=>({stale:true,ok:false,why,mixNow,sumNow,kind:k||''});
    if(own.unknown||m.taxRowsUnknown) return no('税額を確認した当時の商品ごとの金額・行の対応が記録されていないため','history');
    if(same(own)&&!old) return {stale:false};
    if(ex===0&&!d.taxAuto&&!added&&!rowsHaveAdded(own.rows)) return {stale:false};   // preserve an explicit zero for changes to original items
    if(candBlocked(m)) return no(blockedWhy(m));
    if(old) return no(`以前の版（v1.10.18 まで）で保存された記録で、税率の表示がない商品のうち、どれが手動で追加した商品かが記録されていないため（レシートの${m.rate1?`税率 ${m.rate1}%`:'税率'}を当てはめられません）`,'old');
    if(b&&same(b)&&(b.tax>0||taxByHand(b.src))) return {stale:true,ok:true,tax:b.tax,back:true,mixNow,sumNow};   // back at exactly the rows and amounts the kept tax belongs to
    if(added) return no(ADD_WHY,'add');   // v1.10.18
    if(ex===0&&!d.taxAuto&&rowsHaveAdded(own.rows)) return no('外税0円を確認した明細から商品が削除・変更されているため');
    if(taxVal(m,'disc')>0) return no('値引が税率ごとにどう配分されたか分からないため');
    if(!b||!b.mix) return no('変更前の明細の税率ごとの金額が記録されていないため');
    const one=/(?:^|,)-:/.test(b.mix)?m.rate1:0, bn=mixBases(mixNow,one), addB=/(?:^|,)add:/.test(b.mix); if(!bn||(!addB&&!mixBases(b.mix,m.rate1))) return no('商品ごとの税率が分からないため');   // v1.10.18: one
    // v1.10.19: the 外税 was entered for items with one added by hand, and that item is gone now: the rounding cannot be checked against that amount (the
    // added item has no rate), so the tax of the items left is taken only when every rounding gives the same amount
    const ms=addB?Object.keys(TAX_RND):b.methods;
    if(!ms.length) return no('保存されている外税を税率から計算した額と合わず、計算方法（端数処理）を確かめられないため');
    const vals=ms.map(k=>mixTax(bn,k)); return vals.every(v=>v===vals[0])?{stale:true,ok:true,tax:vals[0],mixNow,sumNow}:no('端数処理の方法によって税額が変わるため'); }
  // a record edited by an earlier version (updatedAt) whose 外税 differs from the tax of its items by more than rounding: the tax was most likely kept
  // when the items changed (up to v1.10.16). Only pointed out with the calculated amount to apply; the record is not changed by opening it.
  function legacyTaxGap(x,m,items){ if(!x||!(Number(x.updatedAt)>0)||m.fmt!==2||Number(m.taxFor)>0) return null; const ex=taxVal(m,'ex')||0;
    if(!(ex>0)||taxByHand(m.taxSrc&&m.taxSrc.ex)||taxVal(m,'disc')>0||candBlocked(m)) return null;
    const b=mixBases(taxMixOf(items),m.rate1); if(!b||!Object.keys(b).length) return null; const vals=Object.keys(TAX_RND).map(k=>mixTax(b,k)); if(!vals.every(v=>v===vals[0])) return null;
    const n=items.filter(it=>it.tax!=='in'&&Number(it.amount)>0).length; return Math.abs(vals[0]-ex)>n?{tax:vals[0]}:null; }   // each item can make at most ¥1 of rounding difference
  // v1.10.18: a record edited by an earlier version (updatedAt) that has items marked 外 (外8 / 外10) and no 外税 at all - neither an amount nor how it was
  // obtained. v1.10.17 saved records like that when an amount was cleared and typed again in the editor (the 外税 went to ¥0 and was dropped). Such a
  // record is not changed by opening it and nothing is rewritten in bulk: the editor says so, with the 外税 calculated from the marked rates as a
  // candidate when every rounding gives the same amount. A 外税 of ¥0 entered by hand is kept with the record (taxMeta.ex 'manual') and is not pointed out.
  function lostTaxOf(m,items){ if(taxVal(m,'ex')!=null||taxVal(m,'unk')!=null||taxVal(m,'disc')>0||candBlocked(m)) return null;
    if(!items.some(it=>itemTaxFields(it).tax==='ex'&&Number(it.amount)>0)) return null;
    const b=mixBases(taxMixOf(items),0); if(!b||!Object.keys(b).length) return {tax:0}; const vals=Object.keys(TAX_RND).map(k=>mixTax(b,k)); return {tax:vals.every(v=>v===vals[0])?vals[0]:0}; }
  function legacyTaxLost(x,m,items){ return x&&Number(x.updatedAt)>0&&m.fmt===2&&!m.legacy?lostTaxOf(m,items):null; }
  // put the 外税 for the items as they are now (calculated, or the kept amount when they are back) - the tax and the total together
  function setEditTax(d,tax,back){ const m=d.meta, old=taxVal(m,'ex')||0; m.exTax=tax; m.taxSrc=Object.assign({},m.taxSrc); m.taxSrc.ex=back?d.tbase.src:'calc';
    bindTaxRows(m,d.items); d.taxOwn={S:Math.round(editItemSum()),mix:taxMixOf(d.items),rows:taxRowsRead(m.taxForRows),unknown:false}; delete m.taxFor; delete m.taxForMix; d.offset=(Number(d.offset)||0)+tax-old; d.taxTouched=taxDiffers(m,d.meta0); d.taxAuto=true; d.ownOld=!!back&&d.ownOld; }   // v1.10.18: taxAuto   // v1.10.19: ownOld
  // v1.4: a saved record can be edited in full (date, store, total, and each item: name / amount / category, delete, add).
  // Only this record changes; category learning is never written from here.
  async function openExpenseEditor(id){
    let all; try{all=await allExpenses();}catch(e){toast('記録を読み込めませんでした',{error:true});return;}
    const x=all.find(e=>e.id===id); if(!x){toast('記録が見つかりません');return;}
    editingExpenseId=id;
    const items=(x.items||[]).map(it=>Object.assign({name:String(it.name||''),amount:Number(it.amount)||0,category:CATEGORIES.includes(it.category)?it.category:'未分類'},Number(it.qty)>1?{qty:Math.round(Number(it.qty))}:{},itemTaxFields(it)));
    ensureRowIds(items);
    const itemSum0=items.reduce((s,i)=>s+i.amount,0), total0=Number(x.amount)||0;
    // sync: when items and total agreed, deleting/changing items also changes the total (no switch to set).
    // When they differed (tax, OCR), the total stays until the person types it or presses the button.
    // v1.10.6: the tax and discount kept with the record, in the shape the check and the panel work with; agreement is judged by the same check as on the confirm screen
    const meta=taxMetaOfRecord(x), lv=sumCheckInfo(itemSum0,total0,meta,'total').level, gap=x.source==='receipt'?legacyTaxGap(x,meta,items):null, lost=x.source==='receipt'?legacyTaxLost(x,meta,items):null, explained=(lv==='ok'||lv==='explained')&&!recordTaxStale(meta,items)&&!gap&&!lost;   // v1.10.18: lost   // v1.10.15: a tax of other items does not make the record agree (the total does not follow the items)
    const tbase=recTaxBase(meta,items), own={S:tbase.S,mix:tbase.mix,rows:taxRowsRead(tbase.rows),unknown:tbase.unknown};   // v1.10.20: keep the complete row binding even while it agrees
    editDraft={id:x.id,source:x.source==='receipt'?'receipt':'manual',date:x.date,store:x.store||'',amount:total0,category:CATEGORIES.includes(x.category)?x.category:'未分類',items,meta,meta0:taxSnapshot(meta),legacy:!!meta.legacy,taxTouched:false,taxOpen:false,taxUi:{raw:{},bad:{}},itemSum0,sync:x.source==='receipt'&&items.length>0&&explained,offset:total0-itemSum0,
      tbase,tbase0:tbase,taxOwn:own,own0:Object.assign({},own),legacyGap:gap,legacyGap0:gap,lostTax:!!lost,lostTax0:!!lost,taxAuto:false,cancel0:cancelOpenOf(meta),
      ownOld:x.source==='receipt'&&!meta.legacy&&!meta.addMark&&Number(meta.taxFor)>0,ownOld0:x.source==='receipt'&&!meta.legacy&&!meta.addMark&&Number(meta.taxFor)>0};   // v1.10.19: the 外税 belongs to items saved by an earlier version (which of them were added by hand is not known)
    $('#expenseEditTitle').textContent=editDraft.source==='receipt'?'レシートを編集':'支出を編集';
    renderEditDraft();
    const panel=$('#expenseEditPanel'); panel.classList.remove('hidden'); panel.scrollTop=0; document.body.classList.add('sheet-open');
  }
  let editRevealLast=false;
  // bring the last row into view and put the cursor in its name (after ＋ 追加)
  function revealLastRow(container,rowSel,inputSel){ const rows=container?container.querySelectorAll(rowSel):[]; const last=rows[rows.length-1]; if(!last) return; try{ last.scrollIntoView({block:'center',behavior:'smooth'}); }catch(_){ last.scrollIntoView(); } const n=last.querySelector(inputSel); if(n) setTimeout(()=>{ try{ n.focus({preventScroll:true}); }catch(_){ n.focus(); } },260); }
  function renderEditDraft(){
    const d=editDraft, box=$('#expenseEditItems'); if(!d||!box) return;
    ensureRowIds(d.items);
    const receipt=d.source==='receipt';
    let html=`<div class="edit-fields"><label>日付<input type="date" min="2000-01-01" max="2099-12-31" data-edit-field="date" value="${esc(d.date)}"></label><label>${receipt?'店舗名':'商品名・メモ'}<input type="text" data-edit-field="store" value="${esc(d.store)}" maxlength="100" autocomplete="off"></label>`;
    if(!receipt) html+=`<label>カテゴリ<select data-edit-field="category">${catOptions(d.category)}</select></label>`;
    html+=`<label>${receipt?'合計金額':'金額'}<input type="number" inputmode="numeric" min="1" data-edit-field="amount" value="${d.amount||''}"></label>`;
    html+=`</div>`;
    if(receipt){
      html+=`<div class="edit-sub-row"><h3 class="edit-sub">商品明細（${d.items.length}件）</h3><button type="button" class="text-btn" data-edit-add-top="1">＋ 追加</button></div><div class="items-head" aria-hidden="true"><span>商品名</span><span>金額</span></div><div class="edit-item-list">`+d.items.map((it,i)=>`<div class="item-row edit-item"><label class="item-name"><span class="lbl">商品名</span><input placeholder="商品名" data-edit-name="${i}" value="${esc(it.name)}" maxlength="100" autocomplete="off"></label><label class="item-amount"><span class="lbl">金額</span><input placeholder="金額" type="number" inputmode="numeric" min="0" data-edit-amount="${i}" value="${it._zero?'0':(it.amount||'')}"></label><button type="button" data-edit-del="${i}" aria-label="この商品を削除">×</button><label class="item-category"><span class="lbl">分類</span><select data-edit-item="${i}">${catOptions(it.category)}</select></label></div>`).join('')+`</div><button type="button" class="secondary full edit-add" data-edit-add="1">＋ 商品を追加</button><div id="editSumCheck" class="sum-check hidden" aria-live="polite"></div><details id="editTaxPanel" class="tax-panel"${d.taxOpen||(d.taxUi&&Object.keys(d.taxUi.bad||{}).length)?' open':''}>${taxPanelHtml('e')}</details>`;
    }
    box.innerHTML=html;
    // v1.10.6: 税・値引きを確認／修正 for a saved record. A change here never moves the total; the check below offers the amount to apply.
    const etp=box.querySelector('#editTaxPanel'); if(etp){ etp.addEventListener('toggle',()=>{ d.taxOpen=etp.open; });
      const touch=()=>{ syncSubUnsure(d.meta); d.taxTouched=taxDiffers(d.meta,d.meta0); updateEditSumCheck(); };
      const rebase=()=>{ bindTaxRows(d.meta,d.items); d.tbase=recTaxBase(d.meta,d.items); d.taxOwn={S:d.tbase.S,mix:d.tbase.mix,rows:taxRowsRead(d.tbase.rows),unknown:false}; d.legacyGap=null; d.lostTax=false; d.taxAuto=false; d.ownOld=false; };   // a tax entry, including the same value, confirms precisely the current rows
      mountTaxPanel(etp,{ meta:()=>d.meta, itemSum:()=>Math.max(editItemSum(),Math.round(Number(d.amount)||0)), itemDisc:()=>0,
        setAmount:(k,v)=>{ taxSetAmount(d.meta,k,v); if(k==='ex'||k==='unk'){ delete d.meta.taxFor; delete d.meta.taxForMix; rebase(); } touch(); }, setUnkKind:kind=>{ taxSetUnkKind(d.meta,kind); delete d.meta.taxFor; delete d.meta.taxForMix; rebase(); touch(); }, confirmEst:()=>{ taxConfirmEst(d.meta); touch(); },   // v1.10.13: a tax the person enters is the tax of the items as they are now
        canReset:()=>taxDiffers(d.meta,d.meta0), reset:()=>{ taxRestore(d.meta,d.meta0); d.tbase=d.tbase0; d.taxOwn=Object.assign({},d.own0); d.legacyGap=d.legacyGap0; d.lostTax=d.lostTax0; d.taxAuto=false; d.ownOld=d.ownOld0; touch(); }, resetLabel:'保存されている値に戻す', ui:()=>d.taxUi }); }   // v1.10.8: ui = the typed text and error, kept with the draft so a redraw (row added / removed) does not lose them
    if(!box._addHook){ box._addHook=true; box.addEventListener('click',e=>{ const top=e.target.closest('[data-edit-add-top]'); if(top){ const add=box.querySelector('[data-edit-add]'); if(add) add.click(); return; } if(e.target.closest('[data-edit-add]')) editRevealLast=true; },true); }
    const on=(el,fn)=>{el.addEventListener('input',fn);el.addEventListener('change',fn);};
    // v1.10.5: leaving a field without changing it (the change event on blur) must not redraw the check - the redraw replaced the
    // 「合計を…にする」 button in the middle of a tap, and the tap was lost
    box.querySelectorAll('[data-edit-field]').forEach(el=>on(el,()=>{const k=el.dataset.editField;if(k==='amount'){const v=Number(el.value);if(v===d.amount)return;d.sync=false;d.amount=v;updateEditSumCheck();}else d[k]=el.value;}));
    box.querySelectorAll('[data-edit-name]').forEach(el=>on(el,()=>{const it=d.items[Number(el.dataset.editName)];if(!it)return;const was=amtBlank(it);it.name=el.value;if(amtBlank(it)!==was){followItems();updateEditSumCheck();}}));   // v1.10.18: a row with a name and no amount yet holds the calculation
    // v1.10.18: a blank field (全選択→Backspace, or a row added and not filled in yet) is an amount not entered yet - not ¥0: the tax and the total stay as
    // they are until it is entered (amtBlank). 0 typed in the field is an amount of ¥0 (_zero) and is calculated as one.
    box.querySelectorAll('[data-edit-amount]').forEach(el=>on(el,()=>{const it=d.items[Number(el.dataset.editAmount)],t=String(el.value).trim(),v=t===''?0:Number(t),z=t!==''&&v===0;if(!it||(v===it.amount&&z===!!it._zero))return;it.amount=v;if(z)it._zero=true;else delete it._zero;followItems();updateEditSumCheck();}));
    box.querySelectorAll('[data-edit-item]').forEach(el=>el.addEventListener('change',()=>{d.items[Number(el.dataset.editItem)].category=el.value;}));
    box.querySelectorAll('[data-edit-del]').forEach(el=>el.addEventListener('click',()=>{const rm=d.items.splice(Number(el.dataset.editDel),1)[0];if(rm&&cancelResolveDel(d.meta,rm))d.taxTouched=true;followItems();renderEditDraft();}));   // v1.10.17: removing the item an open 取消 line took back settles it
    const add=box.querySelector('[data-edit-add]'); if(add) add.addEventListener('click',()=>{d.items.push({name:'',amount:0,category:'未分類',_added:true});renderEditDraft();const ins=box.querySelectorAll('[data-edit-name]');if(ins.length)ins[ins.length-1].focus();});   // v1.10.18: _added = no tax mark or rate from the receipt
    updateEditSumCheck();
    if(editRevealLast){ editRevealLast=false; revealLastRow(box,'.edit-item','[data-edit-name]'); }
  }
  function editItemSum(){ return editDraft?editDraft.items.reduce((s,x)=>s+(Number(x.amount)||0),0):0; }
  // with the switch on, the total moves by the same amount as the items (a tax difference stays as it was)
  function followItems(){ const d=editDraft; if(!d||!d.sync||candBlocked(d.meta||{})) return; /* v1.10.12: not while a tax / discount / 小計 point of the record is open */
    if(d.items.some(amtBlank)||!d.items.some(it=>Number(it.amount)>0)) return;   // v1.10.18: an amount still being entered, or no amount at all: nothing is calculated yet (the tax and its evidence stay)
    { const st=recTaxNow(d); if(st.stale){ if(!st.ok) return; setEditTax(d,st.tax,!!st.back); } }   // v1.10.17: the 外税 changes with the items, or the total does not move at all
    d.amount=Math.max(0,editItemSum()+(Number(d.offset)||0)); const f=$('#expenseEditItems [data-edit-field="amount"]'); if(f) f.value=d.amount?String(d.amount):''; }
  // the total never changes by itself unless the switch is on; otherwise only by typing or the button
  // v1.10.3: when the items of a record with 外税 change, the tax shown is the amount kept from the receipt (no rate is guessed)
  // v1.10.17: the note 「外税は読み取り時の金額のままです（商品ごとの税率が分からないため、再計算していません）」 is gone: it was shown whatever the record
  // said about the rates, and the check above it still said 一致. What the 外税 belongs to is now part of the check itself (recTaxNow).
  function updateEditSumCheck(){ updateEditSumCheckCore(); const box=$('#editSumCheck'), d=editDraft; if(!box||!d) return; cancelOkButton(box,d.meta,updateEditSumCheck);
    const tp=$('#editTaxPanel'); if(tp&&tp._taxShow) tp._taxShow(); }
  function updateEditSumCheckCore(){
    const box=$('#editSumCheck'), d=editDraft; if(!box||!d) return;
    const itemSum=editItemSum(), total=Math.round(Number(d.amount)||0);
    box.classList.remove('hidden','warning','ok','notice');
    // v1.10.18: a row whose amount is being entered (blank) is said to be one - never checked as ¥0 and never 一致 (the tax and the total wait for it)
    { const nb=d.items.filter(amtBlank).length; if(nb){ box.classList.add('notice'); box.textContent=`金額が空欄の商品が ${nb} 件あります。金額を入れると${d.sync?'、外税と合計を明細に合わせて計算し直します（空欄の間は外税と合計を変えていません）':'照合します'}。空欄のまま保存すると、その商品は保存されません。`; return; } }
    if(!d.items.length||!total||!itemSum){box.classList.add('hidden');box.innerHTML='';return;}
    // v1.10.6: the same check as on the confirm screen (sumCheckInfo), fed with the tax and discount kept with the record
    const m=d.meta||{}; if(m.fmt===2) m.itemBasis=itemBasisOf(d.items);   // v1.10.7: a record saved with per-item marks follows its items
    const info=sumCheckInfo(itemSum,total,m,'total'), pt=ps=>(ps||[]).map(p=>` ${p[0]} ${p[1]} ${yen(p[2])}`).join(''), TP='「税・値引きを確認／修正」';
    // v1.10.13: the record was saved with a tax that belongs to items of another sum (taxFor: counts changed on the confirm screen while the tax was not
    // calculated for them). That tax is not added to these items as if it were theirs: no 一致, no candidate made from it - the person corrects the tax.
    const setTotal=to=>{ d.amount=to; d.offset=to-itemSum; d.sync=true; const f=$('#expenseEditItems [data-edit-field="amount"]'); if(f) f.value=String(to); updateEditSumCheck(); };
    // v1.10.17: the 外税 in use belongs to other items (changed here, or saved like that): never added to these items as if it were theirs. When the tax for
    // these items can be calculated, the tax and the total are offered together; otherwise the check says why nothing is calculated.
    { const st=recTaxNow(d), cur=taxVal(m,'ex')||0, dc=taxVal(m,'disc')||0, own=d.taxOwn||{}, ownTxt=own.mix?taxMixText(own.mix):`明細合計 ${yen(own.S)}`, sx=(m.taxSrc||{}).ex, kept=taxByHand(sx)?'手動で入れた金額のまま':sx==='calc'?'計算した金額のまま':'読み取り時の金額のまま';
      const offer=(tax,lead)=>{ const T=Math.max(0,itemSum+tax-dc); box.classList.add('notice');
        box.innerHTML=`${esc(lead)}${esc(`外税を ${yen(tax)} にすると、合計は ${yen(T)} です。`)}<button type="button" class="text-btn" data-tax-apply="1">外税 ${esc(yen(tax))}・合計 ${esc(yen(T))} にする</button>`;
        box.querySelector('[data-tax-apply]').addEventListener('click',()=>{ const gap=!!d.legacyGap||!!d.lostTax; setEditTax(d,tax,false); if(gap){ d.tbase=recTaxBase(m,d.items); d.taxOwn={S:d.tbase.S,mix:d.tbase.mix,rows:taxRowsRead(d.tbase.rows),unknown:d.tbase.unknown}; d.legacyGap=null; d.lostTax=false; } setTotal(T); }); };   // v1.10.18: also a 外税 that was lost (lostTax): the applied tax is the evidence from now on
      if(st.stale&&st.ok){ offer(st.tax,`明細合計 ${yen(itemSum)} と合計 ${yen(total)} を、いまの外税では照合できません。外税 ${yen(cur)} は${kept}で、${st.back?'保存されていた':'変更する前の'}明細（${ownTxt}）に対する額です。${st.back?'いまの明細は保存されていた明細と同じです。':`いまの明細（${taxMixText(st.mixNow)}）の外税は、商品ごとの税率から計算すると ${yen(st.tax)} です。`}`); return; }
      // v1.10.19: the items as they are now are named (with the same item sum, what changed is in the amounts by mark: an item added by hand), and what settles it
      if(st.stale){ box.classList.add('notice'); const nowTxt=st.mixNow?`いまの明細（${taxMixText(st.mixNow)}）の外税`:'いまの明細の外税';
        const how=st.kind==='old'||st.kind==='history'?`レシートで税額を確かめて${TP}で外税を入れると照合できます（いまの外税 ${yen(cur)} で正しければ、同じ金額を入れ直してください）。確認当時の対応がないため、以前の明細を推測して照合することはできません。`
          :st.kind==='add'?`レシートで税額を確かめて${TP}で外税を入れる（いまの外税 ${yen(cur)} で正しければ、同じ金額を入れ直す）か、税額を確認した同じ商品の行と金額に戻すと照合できます。同名・同額でも新しく追加した行は別の商品として扱います。`
          :`レシートで税額を確かめて${TP}で外税を直すか、明細を元に戻すと照合できます。`;
        box.textContent=`明細合計 ${yen(itemSum)} と合計 ${yen(total)} を照合できません。外税 ${yen(cur)} は${kept}で、変更する前の明細（${ownTxt}）に対する額です。${st.why}、${nowTxt}は計算していません（合計も変えていません）。${how}`+(candBlocked(m)?unsureNote(m):''); return; }
      // v1.10.18: items marked 外 and no 外税 at all, in a record edited by an earlier version (legacyTaxLost)
      if(d.lostTax){ const lt=lostTaxOf(m,d.items); if(lt){ const lead=`明細合計 ${yen(itemSum)} と合計 ${yen(total)} を照合できません。外税の表示（外8・外10）がある商品があるのに、この記録には外税が保存されていません。以前の版（v1.10.17 まで）で商品の金額を空欄にしてから入れ直したときに、外税が消えたまま保存された可能性があります。レシートで確かめてください（外税がないレシートなら、${TP}で外税に 0 を入れると確定できます）。`;
        if(lt.tax>0){ offer(lt.tax,lead+`商品ごとの税率から計算すると外税は ${yen(lt.tax)} です。`); return; } box.classList.add('notice'); box.textContent=lead+`商品ごとの税率が分からない、または端数処理によって額が変わるため、外税は計算していません。`; return; } }
      if(d.legacyGap&&cur>0&&taxMixOf(d.items)===own.mix){ offer(d.legacyGap.tax,`明細合計 ${yen(itemSum)} と合計 ${yen(total)} を、いまの外税では照合できません。外税 ${yen(cur)} は、明細（${ownTxt}）から商品ごとの税率で計算した外税 ${yen(d.legacyGap.tax)} と合いません。以前の版で明細を変えたときに、外税が計算し直されないまま保存された可能性があります。レシートで確かめてください。`); return; } }
    const tf=Number(m.taxFor)||0, taxAmt=(Number(m.exTax)||0)+(Number(m.unknownTax)||0), mixNow=taxMixOf(d.items), mixOff=validTaxMix(m.taxForMix)&&m.taxForMix!==mixNow;   // v1.10.15: the items by tax mark and rate too, not only their sum
    if(tf>0&&taxAmt>0&&(tf!==itemSum||mixOff)){ box.classList.add('notice'); box.textContent=`明細合計 ${yen(itemSum)} と合計 ${yen(total)} を照合できません。`+(tf!==itemSum?`税 ${yen(taxAmt)} は明細合計 ${yen(tf)} のときの税額で（数量・金額を変えたまま保存されています）、いまの明細に対する税額ではないため、合計の候補は出していません。`:`税 ${yen(taxAmt)} は読み取ったときの明細（${taxMixText(m.taxForMix)}）に対する税額です。いまの明細（${taxMixText(mixNow)}）は明細合計が同じでも税率ごとの金額が違うため（数量・金額を変えたまま保存されています）、この税額をいまの明細の税額としては扱わず、合計の候補も出していません。`)+`${TP}で税額を直すか、明細を読み取ったときの数量・金額に戻すと照合できます。`+(candBlocked(m)?unsureNote(m):''); return; }
    if(info.level==='ok'||info.level==='explained'){
      const parts=info.parts||[], head=parts.length?`明細合計 ${yen(itemSum)}${pt(parts)} ＝ 合計 ${yen(total)}。`:`明細合計 ${yen(itemSum)} ／ 合計 ${yen(total)}。`;
      if(info.conflict){ box.classList.add('notice'); box.textContent=head+`金額は合いますが、商品はすべて税込（内税）の表示でした。外税 ${yen(Number(m.exTax)||0)} を足すと二重になるおそれがあります。${TP}で税を確認してください。`; }
      else if(info.unsure){ box.classList.add('notice'); box.textContent=head+'金額は合っていますが、'+unsureNote(m); }
      else if(info.estimated){ box.classList.add('notice'); box.textContent=head+`外税は合計と小計の差からの推定です（レシートで確かめた金額ではありません）。確かめたら${TP}で確定できます。`; }
      else if(info.classUnknown){ box.classList.add('notice'); box.textContent=head+`金額は合っていますが、消費税 ${yen(Number(m.unknownTax)||0)} が外税か内税かは分かっていません${info.classUnknown==='in'?'（内税なら、このままで合っています）':''}。${TP}で指定できます。`; }
      else { box.classList.add('ok'); box.textContent=head+'一致しています。'+((m.taxSrc||{}).ex==='calc'&&taxVal(m,'ex')>0?'（外税は、明細の商品ごとの税率から計算した額です）':''); }   // v1.10.17
      return;
    }
    box.classList.add('notice');
    const ex=Number(m.exTax)||0, unk=Number(m.unknownTax)||0, inT=Number(m.inTaxMax)||0, dc=Number(m.receiptDiscount)||0;
    // a difference the size of consumption tax (8% / 10% of the items, ±1) is most likely tax on tax-exclusive prices (only for a record with no tax or discount kept)
    const gap=total-itemSum, taxLike=!candBlocked(m)&&!ex&&!unk&&!inT&&!dc&&gap>0&&[0.08,0.1].some(r=>Math.abs(gap-Math.floor(itemSum*r))<=1||Math.abs(gap-Math.round(itemSum*r))<=1);
    if(taxLike){ box.innerHTML=`明細合計 ${esc(yen(itemSum))} と合計 ${esc(yen(total))} の差 ${esc(yen(gap))} は、消費税とほぼ同じ額です。税抜きの値段で印字されたレシートなら、このままで合っています。<button type="button" class="text-btn sum-fix">合計を明細合計（${esc(yen(itemSum))}）にする</button>`;
      box.querySelector('.sum-fix').addEventListener('click',()=>setTotal(itemSum)); return; }
    const parts=info.parts||[], resid=Math.abs(Number(info.resid)||0);
    const diff=parts.length?`明細合計 ${esc(yen(itemSum))}${esc(pt(parts))} ＝ ${esc(yen(info.expect))} と合計 ${esc(yen(total))} に ${esc(yen(resid))} の差があります。`:`明細合計 ${esc(yen(itemSum))} と合計 ${esc(yen(total))} に ${esc(yen(resid))} の差があります。`;
    if(info.ambiguous){ box.innerHTML=`${diff}消費税 ${esc(yen(unk))} が外税か内税か分からないため、合計の候補は出していません。${TP}で指定できます。`; return; }
    if(candBlocked(m)){ box.innerHTML=`${diff}${esc(unsureNote(m))}確認が済むまで、合計の候補は出していません。`; return; }   // v1.10.11: the same rule as the confirm screen
    const note=info.inWouldFit?(m.itemBasis==='in'?`内税 ${esc(yen(Number(info.inWouldFit)))} は商品金額に含まれているため、足していません（商品に「内」の表示がありました）。`:`内税 ${esc(yen(Number(info.inWouldFit)))} は商品金額に含む税のため、足していません。商品が税抜の金額なら、${TP}で外税（商品金額に加算）に入れてください。`):'';
    const fixTo=info.expect, label=parts.length?'明細合計'+parts.map(p=>p[0]+String(p[1]).replace(/（.*?）/,'')).join(''):'明細合計';
    box.innerHTML=`${diff}${note}合計金額は自動では変わりません。<button type="button" class="text-btn sum-fix">合計を${esc(label)}（${esc(yen(fixTo))}）にする</button>`;
    box.querySelector('.sum-fix').addEventListener('click',()=>setTotal(fixTo));
  }
  // v1.10.11: what is still open in a saved record, in words (tax and discount lines that could not be told apart, contradicting 小計 lines)
  // v1.10.15: a point discount printed after the total that the amount paid could not confirm (taxUnsure.disc 'point')
  function pointOpenNote(m){ const TP='「税・値引きを確認／修正」'; return `合計の後に印字されたポイント値引 ${yen(Number(m.receiptDiscount)||0)} が合計から引かれたかを、支払額で確かめられていません。レシートで支払額を確かめて、値引後の金額を払っていれば${TP}で確認済みに、値引でなければ値引を0にしてください。`; }
  // v1.10.15: what the 小計 lines kept with a record say about themselves - all of them, some of them, or unknown (an older version may have left some out)
  function subCompNote(m){ const c=subComp(m); return c==='part'?'この記録には読み取ったときの小計の一部しか残っていないため、税額を直しても自動では解除しません。':c==='unknown'?'この記録の小計の情報は、すべてそろっているか分からないため（以前の版で整理された可能性があります）、税額を直しても自動では解除しません。':''; }
  function unsureNote(m){ const uk=taxUnsureKeys(m), tk=uk.filter(k=>k!=='sub'&&!(k==='disc'&&taxUnsureOf(m).disc==='point')), TP='「税・値引きを確認／修正」', out=[];
    if(uk.includes('disc')&&taxUnsureOf(m).disc==='point') out.push(pointOpenNote(m));
    if(tk.length) out.push(`${tk.map(k=>({ex:'外税',in:'内税',unk:'消費税',disc:'値引'})[k]).join('・')}の行の重なり（税率別の行・再掲の行、写真の重なり）を判断できないまま保存されています。${TP}で税額を確かめて確定してください。`);
    if(uk.includes('sub')) out.push(`読み取ったときの小計の表示どうしが合わないまま保存されています${m.subConflict?`（${m.subConflict}）`:''}。${Array.isArray(m.subCands)&&m.subCands.length>=2?subCompNote(m):''}レシートで小計を確かめたら、${TP}で確認済みにしてください。`);
    if(!uk.length&&taxVal(m,'unk')>0) out.push(`消費税 ${yen(taxVal(m,'unk'))} が外税か内税か分かっていません。${TP}で指定できます。`);
    { const cn=cancelOpenNote(m); if(cn) out.push(cn); }   // v1.10.17
    return out.join(''); }
  function syncDraftFromScreen(){
    const d=editDraft, box=$('#expenseEditItems'); if(!d||!box) return;
    box.querySelectorAll('[data-edit-field]').forEach(el=>{const k=el.dataset.editField;d[k]=k==='amount'?Number(el.value):el.value;});
    box.querySelectorAll('[data-edit-name]').forEach(el=>{const it=d.items[Number(el.dataset.editName)];if(it)it.name=el.value;});
    box.querySelectorAll('[data-edit-amount]').forEach(el=>{const it=d.items[Number(el.dataset.editAmount)];if(it)it.amount=Number(el.value);});
    box.querySelectorAll('[data-edit-item]').forEach(el=>{const it=d.items[Number(el.dataset.editItem)];if(it)it.category=el.value;});
  }
  async function saveExpenseEdit(){
    const d=editDraft; if(!editingExpenseId||!d) return;
    { const tp=$('#editTaxPanel'), okPanel=!(tp&&tp._taxCheck)||tp._taxCheck();
      if(!okPanel||Object.keys((d.taxUi&&d.taxUi.bad)||{}).length){ toast('税・値引きの入力に誤りがあります。直すか、入力を取り消してから保存してください',{error:true}); return; } }   // v1.10.7
    syncDraftFromScreen();
    const date=String(d.date||''); if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!validDateParts(Number(date.slice(0,4)),Number(date.slice(5,7)),Number(date.slice(8,10)))){toast('日付を確認してください',{error:true});return;}
    const amount=Math.round(Number(d.amount)||0); if(!(amount>0)){toast('金額を入力してください',{error:true});return;}
    if(amount>MAX_AMOUNT||d.items.some(x=>Number(x.amount)>MAX_AMOUNT)){toast('金額が大きすぎます。入力を確認してください',{error:true});return;}
    let items=[];
    if(d.source==='receipt'){
      const filled=x=>String(x.name||'').trim()&&Number(x.amount)>0;
      const partial=d.items.filter(x=>!filled(x)&&(String(x.name||'').trim()||Number(x.amount)>0));
      if(partial.length&&!(await askConfirm(`商品名か金額が空の行が ${partial.length} 行あります。この行は保存されません。保存しますか？`,{ok:'保存する'}))) return;
      items=d.items.filter(filled).map(x=>Object.assign({name:String(x.name).trim(),amount:Math.round(Number(x.amount)),category:CATEGORIES.includes(x.category)?x.category:'未分類'},Number(x.qty)>1?{qty:Math.round(Number(x.qty))}:{},itemTaxFields(x)));   // the count and the tax mark from the receipt are kept
    }
    let all; try{all=await allExpenses();}catch(e){toast('記録を読み込めませんでした',{error:true});return;}
    const x=all.find(e=>e.id===editingExpenseId); if(!x){closeExpenseEditor();toast('記録が見つかりません');return;}
    const store=String(d.store||'').trim();
    x.date=date; x.amount=amount; x.updatedAt=Date.now();
    // v1.10.6: tax and discount are written from the panel. A record saved before v1.10.6 keeps its fields as they are (and stays without source information) unless they were changed here.
    // v1.10.17: an 外税 that belongs to other items is saved with those items (taxFor / taxForMix): the record stays unconfirmed after reloading and
    // restoring. A tax that belongs to the saved items is saved without them.
    // v1.10.19: a 外税 calculated as ¥0 for other items (the 外 items were removed, then an item was added by hand) is not saved as "no tax": the tax kept with
    // the record goes back with the items it belongs to, as on the confirm screen (before, the record was saved without 外税 and without anything open,
    // and opening it again offered the item sum as the total - the added item taken as tax-free). An explicit ¥0 entered in the panel is not taxAuto.
    let staleSave=false; if(d.source==='receipt'&&d.meta){ const st=recTaxNow(d,items); if(st.stale&&d.taxOwn){ staleSave=true; let own=d.taxOwn;
        if(!(taxVal(d.meta,'ex')>0)&&d.taxAuto&&d.tbase0&&d.tbase0.tax>0&&d.meta0){ d.meta.exTax=d.meta0.exTax; d.meta.taxSrc=Object.assign({},d.meta.taxSrc,{ex:(d.meta0.taxSrc||{}).ex||''}); own={S:d.tbase0.S,mix:d.tbase0.mix,rows:taxRowsRead(d.tbase0.rows),unknown:d.tbase0.unknown}; d.ownOld=d.ownOld0; d.taxOwn=own; }
        d.meta.taxForRows=taxRowsRead(own.rows); d.meta.taxRowsUnknown=!!own.unknown;
        d.meta.taxFor=own.S; if(validTaxMix(own.mix)) d.meta.taxForMix=own.mix; else delete d.meta.taxForMix; } else if(taxVal(d.meta,'ex')>0){ delete d.meta.taxFor; delete d.meta.taxForMix; } }
    if(d.source==='receipt'&&d.meta&&d.taxOwn&&!staleSave){ d.meta.taxForRows=taxRowsRead(d.taxOwn.rows); d.meta.taxRowsUnknown=!!d.taxOwn.unknown; }
    // v1.10.19: the record keeps the mark of the items added by hand from now on (addMark), unless its 外税 still belongs to items saved by an earlier version
    if(d.meta) d.meta.addMark=!(staleSave&&d.ownOld);
    if(d.source==='receipt'&&d.meta&&(!d.legacy||d.taxTouched||staleSave)){ if(d.meta.fmt!==1) d.meta.itemBasis=itemBasisOf(items); const tf=taxFieldsForSave(d.meta); ['exTax','inTax','unkTax','discount'].forEach(k=>{ delete x[k]; }); Object.assign(x,tf.fields); x.taxMeta=tf.taxMeta; }
    if(x.source==='receipt'){ x.store=store||'レシート'; x.items=items; }
    else { x.category=CATEGORIES.includes(d.category)?d.category:'未分類'; x.store=store||x.category; }
    const btn=$('#saveExpenseEditBtn'); btn.disabled=true;
    try{await putExpense(x);}catch(e){console.warn(e);toast('変更を保存できませんでした。もう一度お試しください',{error:true});return;}
    finally{btn.disabled=false;}
    const moved=date!==selectedDate;
    closeExpenseEditor();
    if(moved){ selectedDate=date; calCursor=new Date(Number(date.slice(0,4)),Number(date.slice(5,7))-1,1); }
    await refreshAggregates().catch(()=>{});
    toast(moved?`変更を保存しました（${Number(date.slice(5,7))}月${Number(date.slice(8,10))}日に移動）`:'変更を保存しました');
  }
  // from the home list: open the calendar on that day with the editor
  async function jumpToEdit(id){
    let x=(homeCache||[]).find(e=>e.id===id); if(!x){ try{ x=(await allExpenses()).find(e=>e.id===id); }catch(_){ } }
    if(!x){toast('記録が見つかりません');return;}
    selectedDate=x.date; calCursor=new Date(Number(x.date.slice(0,4)),Number(x.date.slice(5,7))-1,1);
    showView('calendarView'); await renderCalendar().catch(()=>{}); await openExpenseEditor(id);
  }

  // v1.4: amounts without the yen sign; 100,000 and over as 「万」 so they fit a 320px-wide calendar
  function calendarAmount(n){ n=Math.round(Number(n)||0); if(n>=100000){ const v=n/10000; return `${v>=100?Math.round(v):Math.round(v*10)/10}万`; } return n.toLocaleString('ja-JP'); }
  async function renderCalendar(){
    const all=await allExpenses(), y=calCursor.getFullYear(), m=calCursor.getMonth(), ym=`${y}-${pad(m+1)}`, todayS=todayISO(); $('#calendarTitle').textContent=`${y}年${m+1}月`;
    if(!selectedDate.startsWith(ym)){selectedDate=ym===todayS.slice(0,7)?todayS:`${ym}-01`;closeExpenseEditor();}
    const sums={}; all.forEach(x=>{if(x.date&&x.date.startsWith(ym))sums[x.date]=(sums[x.date]||0)+Number(x.amount||0);});
    const grid=$('#calendarGrid');grid.innerHTML='';const first=new Date(y,m,1).getDay(), days=new Date(y,m+1,0).getDate();for(let i=0;i<first;i++){const d=document.createElement('div');d.className='calendar-day empty-day';grid.appendChild(d);}
    for(let day=1;day<=days;day++){const ds=`${y}-${pad(m+1)}-${pad(day)}`, sum=sums[ds]||0;const b=document.createElement('button');b.type='button';b.className='calendar-day'+(selectedDate===ds?' selected':'')+(ds===todayS?' today':'');b.setAttribute('aria-label',`${m+1}月${day}日${ds===todayS?'（今日）':''}${sum?` ${yen(sum)}`:''}`);b.innerHTML=`<span class="day-num">${day}</span>${sum?`<span class="day-amt">${calendarAmount(sum)}</span>`:''}`;b.addEventListener('click',()=>{selectedDate=ds;closeExpenseEditor();renderCalendar();});grid.appendChild(b);}
    const dayRows=all.filter(x=>x.date===selectedDate).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)), sum=dayRows.reduce((s,x)=>s+Number(x.amount||0),0);const [,sm,sd]=selectedDate.split('-');$('#selectedDateTitle').textContent=`${Number(sm)}月${Number(sd)}日`;$('#selectedDateTotal').textContent=yen(sum);renderExpenseList($('#dayList'),dayRows,true,true);
  }


  function addExpenseCategories(cats,x){
    // v1.4: tax and receipt-level discounts are spread over the item categories in proportion (no separate その他 bar)
    const amount=Number(x.amount||0), items=(x.items||[]).filter(i=>Number(i.amount)>0), itemSum=items.reduce((s,i)=>s+Number(i.amount),0);
    if(itemSum>0&&amount>0){ const scale=amount/itemSum; items.forEach(i=>{const cat=i.category||'未分類';cats[cat]=(cats[cat]||0)+Number(i.amount)*scale;}); }
    else { const cat=x.category||'未分類'; cats[cat]=(cats[cat]||0)+amount; }
  }

  function categoryTotals(rows){
    const cats={}; rows.forEach(x=>addExpenseCategories(cats,x)); return cats;
  }

  function renderCategoryBars(el,cats){
    el.innerHTML='';
    const entries=Object.entries(cats).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]), max=Math.max(1,...entries.map(([,v])=>v));
    if(!entries.length){el.innerHTML='<div class="empty">この期間の支出はありません</div>';return;}
    entries.forEach(([k,v])=>el.insertAdjacentHTML('beforeend',`<div class="bar-row"><span>${esc(k)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round(v/max*100)}%;background:${catColor(k)}"></div></div><strong>${yen(v)}</strong></div>`));
  }

  function niceMax(v){
    if(v<=0) return 1000;
    const pow=Math.pow(10,Math.floor(Math.log10(v))), n=v/pow;
    const step=n<=1?1:n<=2?2:n<=5?5:10;
    return step*pow;
  }

  function svgEl(name,attrs={},text=''){
    const el=document.createElementNS('http://www.w3.org/2000/svg',name);
    Object.entries(attrs).forEach(([k,v])=>el.setAttribute(k,String(v)));
    if(text) el.textContent=text;
    return el;
  }

  // amounts on the chart in Japanese units: 9,800 / 1.2万 / 124万 / 1.5億
  function yenShort(v){ v=Math.round(Number(v)||0); if(v>=100000000) return (Math.round(v/10000000)/10)+'億'; if(v>=100000) return Math.round(v/10000).toLocaleString('ja-JP')+'万'; if(v>=10000) return (Math.round(v/1000)/10)+'万'; return v.toLocaleString('ja-JP'); }
  function drawChart(points,type,selectedKey,onSelect){
    const svg=$('#expenseChart'); svg.innerHTML='';
    // v1.4: keep axis text about 11px on screen whatever the chart width (the SVG is scaled to the screen)
    const W=720,H=320, shown=svg.getBoundingClientRect().width||Math.max(280,Math.min(window.innerWidth,760)-40), fs=Math.max(1,Math.min(2.6,W/shown));
    svg.style.setProperty('--axis-fs',`${(11*fs).toFixed(1)}px`); svg.style.setProperty('--value-fs',`${(10.5*fs).toFixed(1)}px`);
    const vals=points.map(p=>Number(p.value)||0), rawMax=Math.max(0,...vals), ymax=niceMax(rawMax), steps=4;
    // room on the left for the longest axis label (digits are narrow, 万 / 億 are full width)
    const labW=Math.max(...Array.from({length:steps+1},(_,i)=>[...yenShort(Math.round(ymax*i/steps))].reduce((a,ch)=>a+(/[0-9.,]/.test(ch)?0.62:1.05),0)));
    const L=Math.round(Math.max(30+14*fs,14+labW*11*fs)),R=14,T=22,B=Math.round(26+15*fs), plotW=W-L-R, plotH=H-T-B;
    $('#chartEmpty').classList.toggle('hidden',rawMax>0);
    for(let i=0;i<=steps;i++){
      const y=T+plotH*i/steps, val=Math.round(ymax*(steps-i)/steps);
      svg.appendChild(svgEl('line',{x1:L,y1:y,x2:W-R,y2:y,class:'chart-grid-line'}));
      const txt=yenShort(val);
      svg.appendChild(svgEl('text',{x:L-6,y:y+4*fs,'text-anchor':'end',class:'chart-axis-text'},txt));
    }
    svg.appendChild(svgEl('line',{x1:L,y1:T+plotH,x2:W-R,y2:T+plotH,class:'chart-zero'}));
    if(!points.length) return;
    const mark=(p,node)=>{
      svg.querySelectorAll('.active').forEach(x=>x.classList.remove('active')); if(node) node.classList.add('active');
      $('#chartSelection').textContent=`${p.fullLabel}　${yen(p.value)}`;
    };
    const select=(p,node)=>{ mark(p,node); if(onSelect) onSelect(p); };
    const nodes=[];
    const labelY=T+plotH+8+11*fs;
    if(type==='line'){
      const x=(i)=>points.length===1?L+plotW/2:L+plotW*i/(points.length-1), y=(v)=>T+plotH-(v/ymax)*plotH;
      let d='', area='';
      points.forEach((p,i)=>{const px=x(i),py=y(p.value);d+=`${i?'L':'M'}${px.toFixed(1)},${py.toFixed(1)} `;});
      if(points.length){area=`${d}L${x(points.length-1)},${T+plotH} L${x(0)},${T+plotH} Z`;svg.appendChild(svgEl('path',{d:area,class:'chart-area'}));svg.appendChild(svgEl('path',{d,class:'chart-line'}));}
      const labelEvery=points.length>16?5:Math.max(1,Math.floor(points.length/8));
      points.forEach((p,i)=>{
        const px=x(i),py=y(p.value), c=svgEl('circle',{cx:px,cy:py,r:p.value>0?6:4,class:'chart-point',tabindex:'0','aria-label':`${p.fullLabel} ${yen(p.value)}`});
        c.addEventListener('click',()=>select(p,c)); c.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(p,c);}}); svg.appendChild(c); nodes[i]=c;
        if(i%labelEvery===0 || i===points.length-1) svg.appendChild(svgEl('text',{x:px,y:labelY,'text-anchor':'middle',class:'chart-axis-text'},p.label));
      });
    }else{
      const compactYear=type==='yearbar';
      const gap=compactYear?18:(points.length>8?8:14);
      const barW=compactYear?Math.min(64,(plotW-gap*(points.length+1))/Math.max(1,points.length)):Math.max(12,(plotW-gap*(points.length+1))/Math.max(1,points.length));
      const groupW=compactYear?(barW*points.length+gap*Math.max(0,points.length-1)):0;
      const startX=compactYear?L+(plotW-groupW)/2:L+gap;
      points.forEach((p,i)=>{
        const x=compactYear?startX+i*(barW+gap):L+gap+i*(barW+gap), h=(p.value/ymax)*plotH, y=T+plotH-h;
        const r=svgEl('rect',{x,y,width:barW,height:Math.max(1,h),rx:6,class:'chart-bar','aria-hidden':'true'});
        svg.appendChild(r); nodes[i]=r;
        if(compactYear && p.value>0){const short=yenShort(p.value);svg.appendChild(svgEl('text',{x:x+barW/2,y:Math.max(T+12,y-8),'text-anchor':'middle',class:'chart-value-text'},short));}
        svg.appendChild(svgEl('text',{x:x+barW/2,y:labelY,'text-anchor':'middle',class:'chart-axis-text'},p.label));
        // v1.4: a transparent full-height target per bar so small (or zero) bars are easy to tap
        const hit=svgEl('rect',{x:x-gap/2,y:T,width:barW+gap,height:H-T,class:'chart-hit',tabindex:'0',role:'button','aria-label':`${p.fullLabel} ${yen(p.value)}`});
        hit.addEventListener('click',()=>select(p,r)); hit.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(p,r);}}); svg.appendChild(hit);
      });
    }
    // keep the chosen month / year highlighted after every redraw
    const si=selectedKey?points.findIndex(p=>p.key===selectedKey):-1; if(si>=0) mark(points[si],nodes[si]);
  }

  // v1.4: the category breakdown shows the tapped month (月別) or the tapped year (年別)
  let graphSelectedKey='';
  function renderGraphBreakdown(all,p){
    if(!p) return;
    const prefix=`${p.key}-`, rows=all.filter(x=>x.date&&x.date.startsWith(prefix));
    $('#graphCategoryLabel').textContent=p.fullLabel;
    const hint=$('#graphCategoryHint'); if(hint) hint.textContent=graphMode==='yearly'?'グラフの棒をタップすると、その年の内訳に切り替わります':'グラフの棒をタップすると、その月の内訳に切り替わります';
    renderCategoryBars($('#graphCategoryBars'),categoryTotals(rows));
  }
  async function renderGraph(){
    const all=await allExpenses();
    $$('.graph-tabs button').forEach(b=>b.classList.toggle('active',b.dataset.graphMode===graphMode));
    let points=[], scopeRows=[], periodLabel='', divisor=1, chartType='bar';
    const now=new Date();
    if(graphMode==='monthly'){
      const y=graphCursor.getFullYear(),prefix=`${y}-`; scopeRows=all.filter(x=>x.date.startsWith(prefix)); periodLabel=`${y}年`; divisor=y===now.getFullYear()?now.getMonth()+1:12;
      const sums={}; scopeRows.forEach(x=>{const mo=Number(x.date.slice(5,7));sums[mo]=(sums[mo]||0)+Number(x.amount||0)});
      points=Array.from({length:12},(_,i)=>({key:`${y}-${pad(i+1)}`,label:`${i+1}`,fullLabel:`${y}年${i+1}月`,value:sums[i+1]||0}));
      chartType='bar';
    }else{
      const end=graphYearBlockEnd,start=end-4; periodLabel=`${start}〜${end}年`;
      const years=Array.from({length:5},(_,i)=>start+i); scopeRows=all.filter(x=>{const y=Number(x.date.slice(0,4));return y>=start&&y<=end});
      // v1.4: 年平均 = total ÷ years of the window up to this year (future years are not counted)
      divisor=Math.max(1,years.filter(y=>y<=now.getFullYear()).length);
      const sums={}; scopeRows.forEach(x=>{const y=Number(x.date.slice(0,4));sums[y]=(sums[y]||0)+Number(x.amount||0)});
      points=years.map(y=>({key:String(y),label:String(y),fullLabel:`${y}年`,value:sums[y]||0}));
      chartType='yearbar';
    }
    // default: this month / this year when shown, otherwise the latest one with spending
    const curKey=graphMode==='monthly'?`${now.getFullYear()}-${pad(now.getMonth()+1)}`:String(now.getFullYear()), lastWithValue=points.slice().reverse().find(p=>p.value>0);
    if(!points.some(p=>p.key===graphSelectedKey)) graphSelectedKey=points.some(p=>p.key===curKey)?curKey:(lastWithValue?lastWithValue.key:points[points.length-1].key);
    drawChart(points,chartType,graphSelectedKey,p=>{graphSelectedKey=p.key;renderGraphBreakdown(all,p);});
    const total=scopeRows.reduce((s,x)=>s+Number(x.amount||0),0), max=Math.max(0,...points.map(p=>p.value));
    $('#graphPeriodLabel').textContent=periodLabel;
    $('#graphAverageLabel').textContent=graphMode==='yearly'?'年平均':'月平均';
    $('#graphTotal').textContent=yen(total); $('#graphAverage').textContent=yen(total/Math.max(1,divisor)); $('#graphMax').textContent=yen(max);
    renderGraphBreakdown(all,points.find(p=>p.key===graphSelectedKey));
  }

  // v1.4: backup / restore (JSON file). Restore only adds records whose id is not on this device.
  const BACKUP_KEY='kakeibo_last_backup_v1', BACKUP_MAX_BYTES=20*1024*1024, ID_RE=/^[A-Za-z0-9_.:-]{1,80}$/;
  function fmtDateTime(v){ const d=new Date(v); if(isNaN(d.getTime())) return '不明'; return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function backupHelpText(){ const standalone=(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||navigator.standalone===true, ios=/iP(hone|ad|od)/.test(navigator.userAgent||'')||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
    if(standalone) return 'ホーム画面から使っているので、しばらく開かないとデータが消えるといった制限はありません。機種変更やアプリの削除に備えたいときだけ保存してください。';
    if(ios) return 'Safariのタブで使っていると、7日ほど開かない間にデータが消えることがあります。ホーム画面に追加して使うと、この制限はありません。';
    return 'データはこの端末の中だけに保存されています。機種変更などに備えたいときだけ保存してください。'; }
  function renderBackupInfo(){ const h=$('#backupHelp'); if(h&&!h.dataset.set){ h.textContent=backupHelpText(); h.dataset.set='1'; } const el=$('#lastBackup'); if(!el) return; let t=0; try{ t=Number(localStorage.getItem(BACKUP_KEY)||0); }catch(_){ } el.textContent=t?`前回：${fmtDateTime(t)}`:'未保存'; }
  function cleanStr(s,max){ return typeof s==='string'?s.slice(0,max):''; }
  function cleanExpense(x){
    if(!x||typeof x!=='object'||Array.isArray(x)) return null;
    const id=typeof x.id==='string'&&ID_RE.test(x.id)?x.id:null; if(!id) return null;
    const ds=typeof x.date==='string'?x.date:''; if(!/^\d{4}-\d{2}-\d{2}$/.test(ds)||!validDateParts(Number(ds.slice(0,4)),Number(ds.slice(5,7)),Number(ds.slice(8,10)))) return null;
    const amount=Math.round(Number(x.amount)); if(!isFinite(amount)||amount<=0||amount>100000000) return null;
    const source=x.source==='receipt'?'receipt':'manual';
    const items=Array.isArray(x.items)?x.items.slice(0,2000).map(i=>{ if(!i||typeof i!=='object') return null; const name=cleanStr(i.name,200).trim(), a=Math.round(Number(i.amount)); if(!name||!isFinite(a)||a<=0||a>100000000) return null; const q=Math.round(Number(i.qty)); return Object.assign({name,amount:a,category:CATEGORIES.includes(i.category)?i.category:'未分類'},q>1&&q<=999?{qty:q}:{},itemTaxFields({tax:i.tax,rate:i.rate,added:i.added,rowId:i.rowId})); }).filter(Boolean):[];   // stable identity and the added-item mark both survive restoration
    const out={id,date:ds,store:cleanStr(x.store,200),amount,category:source==='receipt'?'レシート':(CATEGORIES.includes(x.category)?x.category:'未分類'),items:source==='receipt'?items:[],source,createdAt:Number(x.createdAt)>0&&isFinite(Number(x.createdAt))?Number(x.createdAt):Date.now()};
    // v1.10.6: 外税 / 内税 / 区分不明の税 / 値引 and how each was obtained (taxMeta) are kept. A record without taxMeta stays without it (no source is made up).
    if(source==='receipt'){ const tv=taxMetaOfRecord(Object.assign({},x,{items:out.items})), tf=taxFieldsForSave(tv); Object.assign(out,tf.fields); if(!tv.legacy) out.taxMeta=tf.taxMeta; }
    if(source==='receipt'){ out.photoCount=Math.max(1,Math.min(6,Math.round(Number(x.photoCount))||1)); }
    if(Number(x.updatedAt)>0&&isFinite(Number(x.updatedAt))) out.updatedAt=Number(x.updatedAt);
    return out;
  }
  function validateBackup(obj){
    if(!obj||typeof obj!=='object'||Array.isArray(obj)||obj.app!=='kakeibo'||!Array.isArray(obj.expenses)) return {ok:false,error:'かんたん家計簿のバックアップファイルではありません'};
    if(Number(obj.format)!==1) return {ok:false,error:'このバックアップの形式には対応していません'};
    if(obj.expenses.length>50000) return {ok:false,error:'記録が多すぎるため読み込めません'};
    const seen={}, expenses=[]; let skipped=0;
    obj.expenses.forEach(x=>{ const c=cleanExpense(x); if(!c||seen[c.id]){ skipped++; return; } seen[c.id]=1; expenses.push(c); });
    const learning={}, labels={}, L=obj.learning&&typeof obj.learning==='object'&&!Array.isArray(obj.learning)?obj.learning:{}, LL=obj.learningLabels&&typeof obj.learningLabels==='object'&&!Array.isArray(obj.learningLabels)?obj.learningLabels:{};
    Object.keys(L).slice(0,20000).forEach(k=>{
      const key=normalizeProductName(k).slice(0,120);
      if(!key||key==='__proto__'||key==='constructor'||key==='prototype'||!CATEGORIES.includes(L[k])) return;
      learning[key]=L[k]; const lb=Object.prototype.hasOwnProperty.call(LL,k)?LL[k]:''; labels[key]=typeof lb==='string'&&lb.trim()?lb.trim().slice(0,120):k.slice(0,120);
    });
    return {ok:true,expenses,skipped,learning,labels,exportedAt:typeof obj.exportedAt==='string'?obj.exportedAt:''};
  }
  function readFileText(file){ return new Promise((resolve,reject)=>{ const r=new FileReader(); r.onload=()=>resolve(String(r.result||'')); r.onerror=()=>reject(r.error); r.readAsText(file); }); }
  async function exportBackup(){
    let all; try{ all=await allExpenses(); }catch(e){ toast('データを読み込めませんでした。バックアップは作成していません',{error:true}); return; }   // never from the screen's cache (another tab may have saved since)
    const d=new Date(), name=`kakeibo-backup-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    const json=JSON.stringify({app:'kakeibo',format:1,version:APP_VERSION,exportedAt:d.toISOString(),expenses:all.map(x=>{ const c=Object.assign({},x); delete c.rawText; return c; }),learning:loadCategoryLearning(),learningLabels:loadCategoryLearningLabels(),nameLearning:loadNameFixes()});
    const blob=new Blob([json],{type:'application/json'});
    let shared=false;
    try{
      if(window.File&&navigator.canShare&&navigator.share){ const file=new File([blob],name,{type:'application/json'}); if(navigator.canShare({files:[file]})){ await navigator.share({files:[file],title:'かんたん家計簿のバックアップ'}); shared=true; } }
    }catch(e){ if(e&&e.name==='AbortError') return; }
    if(!shared){ const url=URL.createObjectURL(blob), a=document.createElement('a'); a.href=url; a.download=name; a.rel='noopener'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),20000); }
    try{ localStorage.setItem(BACKUP_KEY,String(Date.now())); }catch(_){ }
    renderBackupInfo(); toast(`バックアップを作成しました（${all.length}件）`);
  }
  // name-fix entries from a backup: {s: store, o: read name, n: corrected name, a: amount}; anything else is dropped
  function sanitizeNameLearning(a){ if(!Array.isArray(a)) return []; return a.slice(0,400).filter(e=>e&&typeof e==='object'&&typeof e.s==='string'&&typeof e.o==='string'&&typeof e.n==='string'&&e.s.length<=100&&e.o.length>0&&e.o.length<=100&&e.n.trim().length>0&&e.n.length<=100&&(e.a==null||(Number.isInteger(e.a)&&e.a>=0&&e.a<=100000000))).map(e=>Object.assign({s:e.s,o:e.o,n:e.n.trim()},e.a!=null?{a:e.a}:{})); }
  async function importBackupFile(file){
    if(!file) return;
    if(file.size>BACKUP_MAX_BYTES){ toast('ファイルが大きすぎます（20MBまで）',{error:true}); return; }
    let obj; try{ obj=JSON.parse(await readFileText(file)); }catch(_){ toast('バックアップファイルを読み込めませんでした',{error:true}); return; }
    const v=validateBackup(obj); if(!v.ok){ toast(v.error,{error:true}); return; }
    let existing; try{ existing=await allExpenses(); }catch(_){ toast('端末のデータを読み込めませんでした',{error:true}); return; }
    const ids={}; existing.forEach(x=>{ids[x.id]=1;});
    const add=v.expenses.filter(x=>!ids[x.id]), cur=loadCategoryLearning(), newLearn=Object.keys(v.learning).filter(k=>!Object.prototype.hasOwnProperty.call(cur,k));
    // name fixes: entries for the same store and read name already on this device are kept (this device wins)
    const curNames=loadNameFixes(), nk=e=>`${e.s}\u0001${nameKey(e.o)}`, haveN=new Set(curNames.map(nk)), newNames=sanitizeNameLearning(obj.nameLearning).filter(e=>!haveN.has(nk(e)));
    if(!add.length&&!newLearn.length&&!newNames.length){ toast('追加できる新しいデータはありませんでした'); return; }
    const msg=`バックアップ（作成日時：${fmtDateTime(v.exportedAt)}）を読み込みます。\n\n支出：${add.length}件を追加（端末にある同じ記録 ${v.expenses.length-add.length}件はそのまま${v.skipped?`、読めない記録 ${v.skipped}件は除外`:''}）\n分類学習：${newLearn.length}件を追加（端末の学習内容が優先）${newNames.length?`\n商品名の学習：${newNames.length}件を追加（同じ店・同じ読み取りの学習が端末にある場合は端末の内容を残します）`:''}\n\n今のデータは消えません。読み込みますか？`;
    if(!(await askConfirm(msg,{ok:'読み込む'}))) return;
    try{ if(add.length) await putExpenses(add); }catch(e){ console.warn(e); toast('読み込みに失敗しました。データは変更されていません',{error:true}); return; }
    if(newNames.length){ try{ localStorage.setItem(NAME_FIX_KEY,JSON.stringify(curNames.concat(newNames).slice(-400))); }catch(_){ } }
    if(newLearn.length){ const map=loadCategoryLearning(), labels=loadCategoryLearningLabels(); newLearn.forEach(k=>{ map[k]=v.learning[k]; labels[k]=v.labels[k]||k; }); try{ localStorage.setItem(CATEGORY_LEARNING_KEY,JSON.stringify(map)); localStorage.setItem(CATEGORY_LEARNING_LABEL_KEY,JSON.stringify(labels)); }catch(_){ toast('分類学習の一部を保存できませんでした',{error:true}); } }
    renderLearningPanel(); await refreshAggregates().catch(()=>{}); toast(`バックアップから 支出${add.length}件・分類学習${newLearn.length}件・商品名学習${newNames.length}件を復元しました`); renderGraph().catch(()=>{});
  }

  $$('.graph-tabs button').forEach(b=>b.addEventListener('click',()=>{graphMode=b.dataset.graphMode;renderGraph()}));
  $('#graphPrev').addEventListener('click',()=>{if(graphMode==='monthly')graphCursor.setFullYear(graphCursor.getFullYear()-1);else graphYearBlockEnd-=5;renderGraph()});
  $('#graphNext').addEventListener('click',()=>{if(graphMode==='monthly')graphCursor.setFullYear(graphCursor.getFullYear()+1);else graphYearBlockEnd+=5;renderGraph()});
  let resizeTimer=0; window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if($('#graphView').classList.contains('active'))renderGraph().catch(()=>{});},200);});

  $$('.bottom-nav button').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
  $('#goCalendarBtn').addEventListener('click',()=>showView('calendarView'));
  // v1.11.0: 今月の食費. Each element is looked up first: a page of an older version (before the reload of checkVersions) has no card
  { const v=$('#foodBudgetView'), f=$('#foodBudgetForm'), c=$('#foodBudgetCancelBtn'), r=$('#foodBudgetClearBtn'), i=$('#foodBudgetInput');
    if(v) v.addEventListener('click',e=>{ if(e.target.closest('[data-fb-edit]')) openFoodBudgetEditor(); });
    if(f) f.addEventListener('submit',e=>{ e.preventDefault(); submitFoodBudget(); });
    if(c) c.addEventListener('click',closeFoodBudgetEditor);
    if(r) r.addEventListener('click',removeFoodBudget);
    if(i) i.addEventListener('input',()=>showFoodBudgetError(''));
    window.addEventListener('storage',e=>{ if((!e.key||e.key===FOOD_BUDGET_KEY)&&!fbEditing){ try{ renderFoodBudget(); }catch(_){ } } }); }   // set or cleared in another tab
  $('#cameraInput').addEventListener('change',e=>{addReceiptPhotos(e.target.files);e.target.value='';});
  $('#galleryInput').addEventListener('change',e=>{addReceiptPhotos(e.target.files);e.target.value='';});
  $('#liveScanBtn').addEventListener('click',()=>openLiveScan('new')); $('#liveCloseBtn').addEventListener('click',closeLiveScan); $('#liveShutterBtn').addEventListener('click',liveShutter);
  $('#addPageBtn').addEventListener('click',addReceiptPage); $('#confirmView').addEventListener('input',()=>{ confirmEdited=true; });
  $('#confirmView').addEventListener('change',()=>{ confirmEdited=true; });
  // another tab saved, edited or deleted: show the latest saved data
  const dataChannel=('BroadcastChannel' in window)?new BroadcastChannel('kakeibo-data'):null;
  const refreshFromDb=()=>{ homeCache=null; renderHome().catch(()=>{}); renderCalendar().catch(()=>{}); renderGraph().catch(()=>{}); try{ renderLearningPanel(); }catch(_){ } };   // v1.10.5: the learning list too (a restore in another tab)
  if(dataChannel) dataChannel.onmessage=()=>refreshFromDb();
  // v1.10.5: learning is kept in localStorage. When another tab saves, resets or restores it, this tab hears it through the storage event
  // (it fires once the change is visible here; the message above can arrive before that)
  window.addEventListener('storage',e=>{ if(!e.key||e.key===CATEGORY_LEARNING_KEY||e.key===CATEGORY_LEARNING_LABEL_KEY||e.key===NAME_FIX_KEY){ try{ renderLearningPanel(); }catch(_){ } } });
  document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') refreshFromDb(); });
  $('#confirmView').addEventListener('click',e=>{ if(e.target.closest('[data-qplus],[data-qminus],[data-del],#addItemBtn,#totalAutoNote button,.sum-fix')) confirmEdited=true; });
  window.addEventListener('resize',()=>{ if(live) layoutLive(); }); window.addEventListener('orientationchange',()=>setTimeout(()=>{ if(live) layoutLive(); },300));
  document.addEventListener('visibilitychange',()=>{ if(document.hidden&&live) closeLiveScan(); });
  $('#readAllBtn').addEventListener('click',runOCR);
  $('#pasteReadBtn').addEventListener('click',readPastedText);
  $('#cancelOcrBtn').addEventListener('click',()=>{const a=ocrAbort;if(!a||a.cancelled)return;a.cancelled=true;$('#ocrStatus').textContent='中止しています…';if(a.reject)a.reject(ocrError('cancel'));});
  $('#resumeConfirmBtn').addEventListener('click',()=>{if(hasUnsavedResult)showView('confirmView');});
  $('#clearPhotosBtn').addEventListener('click',async()=>{if(pendingPhotos.length&&await askConfirm('追加した写真をすべて外しますか？',{ok:'外す'}))clearReceiptPhotos();});
  $('#rescanBtn').addEventListener('click',async()=>{if(hasUnsavedResult&&!(await askConfirm('読み取り結果を破棄して撮り直しますか？',{ok:'撮り直す'})))return;resetScan();showView('scanView')});
  $('#addItemBtn').addEventListener('click',()=>{parsedItems.push({name:'',amount:0,category:'未分類',_source:'unknown',_manual:false,_added:true});renderItemEditor();revealLastRow($('#itemsEditor'),'.item-row','[data-k="name"]');});
  $('#storeField').addEventListener('input',()=>{parsedItems.forEach(it=>{if(!it._manual){const cls=classifyItem(it.name,$('#storeField').value);it.category=cls.category;it._source=cls.source;}});renderItemEditor();});
  $('#saveReceiptBtn').addEventListener('click',saveReceipt);
  $('#totalField').addEventListener('input',()=>{$('#totalField').dataset.edited='1';updateSumCheck();});
  $('#saveExpenseEditBtn').addEventListener('click',saveExpenseEdit);
  $('#cancelExpenseEditBtn').addEventListener('click',closeExpenseEditor);
  $('#resetCategoryLearningBtn').addEventListener('click',async()=>{if(!learnedCount()&&!loadNameFixes().length){toast('記憶している学習はありません');return;}if(await askConfirm('学習した商品分類と商品名の修正をすべてリセットしますか？（保存済みの支出は変わりません）',{ok:'リセットする',danger:true})){clearCategoryLearning();clearNameFixes();renderLearningPanel();parsedItems.forEach(it=>{it._manual=false;const cls=classifyItem(it.name,$('#storeField')?.value||'');it.category=cls.category;it._source=cls.source;});renderItemEditor();toast('分類の学習履歴をリセットしました');}});
  $('#prevMonth').addEventListener('click',()=>{calCursor.setMonth(calCursor.getMonth()-1);renderCalendar()});
  $('#nextMonth').addEventListener('click',()=>{calCursor.setMonth(calCursor.getMonth()+1);renderCalendar()});
  // v1.10.15: the date of 手入力 is either set by the app (data-auto="1": it is today, and it moves with the day) or chosen by the person (any date they
  // picked - also today - stays as it is). Before, a date was taken as the app's when it equalled the day the app had set, so a date chosen to be today was
  // moved, and nothing moved it while the screen stayed in front over midnight (only showing the app again or switching screens did).
  function setManualAuto(){ const md=$('#manualDate'); if(!md) return; md.value=todayISO(); md.dataset.auto='1'; }
  setManualAuto();
  { const md=$('#manualDate'); if(md){ const mine=()=>{ md.dataset.auto='0'; }; md.addEventListener('input',mine); md.addEventListener('change',mine); } }
  // v1.10.14: the app can stay open over midnight (an iPhone keeps it in the background for days). The date of 手入力 and the day shown in the
  // calendar move to the new day when they still show the day the app set (a date the person chose stays as it is).
  let shownToday=todayISO();
  function followToday(){ const t=todayISO(); if(t===shownToday) return; const prev=shownToday; shownToday=t;
    const md=$('#manualDate'); if(md&&(md.dataset.auto==='1'||!md.value)) setManualAuto();   // v1.10.15: only a date the app set (not one the person chose, even if it is the same day)
    if(selectedDate===prev&&!editingExpenseId){ selectedDate=t; calCursor=new Date(Number(t.slice(0,4)),Number(t.slice(5,7))-1,1); }
    // v1.10.16: the screen in front shows the new day too. Before, ホーム kept 今日 / 今月 of the day before (and of the month before on the 1st) until
    // another screen was opened, the calendar kept its 今日 mark, and the graph kept the year before after New Year.
    if(graphMode==='monthly'&&graphCursor.getFullYear()===Number(prev.slice(0,4))&&prev.slice(0,4)!==t.slice(0,4)){ graphCursor=new Date(Number(t.slice(0,4)),0,1); graphSelectedKey=''; }
    if(graphMode==='yearly'&&graphYearBlockEnd===Number(prev.slice(0,4))&&prev.slice(0,4)!==t.slice(0,4)){ graphYearBlockEnd=Number(t.slice(0,4)); graphSelectedKey=''; }
    if(graphSelectedKey===prev.slice(0,7)&&prev.slice(0,7)!==t.slice(0,7)) graphSelectedKey='';
    const v=$('.view.active'), id=v?v.id:''; if(id==='homeView') renderHome().catch(()=>{}); else if(id==='calendarView') renderCalendar().catch(()=>{}); else if(id==='graphView') renderGraph().catch(()=>{}); }
  document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') followToday(); });
  window.addEventListener('focus',followToday); window.addEventListener('pageshow',followToday);
  // v1.10.15: also while the app stays in front: a timer at the next local midnight (set again every day) and a check every minute in case a timer was
  // held back. The local date of the device is used (todayISO), never the UTC date.
  (function armMidnight(){ const n=new Date(), next=new Date(n.getFullYear(),n.getMonth(),n.getDate()+1,0,0,1); setTimeout(()=>{ try{ followToday(); }catch(_){ } armMidnight(); },Math.max(1000,Math.min(next-n,24*3600*1000))); })();
  setInterval(()=>{ try{ followToday(); }catch(_){ } },60000);
  let savingManual=false;
  $('#manualForm').addEventListener('submit',async e=>{e.preventDefault();if(savingManual)return;savingManual=true;const mbtn=$('#manualForm button[type="submit"]');if(mbtn)mbtn.disabled=true;try{const amount=Math.round(Number($('#manualAmount').value));if(!(amount>0)){toast('金額を入力してください',{error:true});return;}if(amount>MAX_AMOUNT){toast('金額が大きすぎます。入力を確認してください',{error:true});return;}if($('#manualDate').dataset.auto==='1'&&$('#manualDate').value!==todayISO()){ const was=$('#manualDate').value; followToday(); setManualAuto(); const t=todayISO(); if(!(await askConfirm(`日付が変わりました（${Number(was.slice(5,7))}月${Number(was.slice(8,10))}日 → 今日 ${Number(t.slice(5,7))}月${Number(t.slice(8,10))}日）。今日の日付で保存しますか？\n\n別の日の支出なら「キャンセル」を押して日付を選んでください。`,{ok:`${Number(t.slice(5,7))}月${Number(t.slice(8,10))}日で保存`}))) return; }   /* v1.10.15: the app's date is checked right before saving; the date shown is the date saved */const date=$('#manualDate').value||todayISO();if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!validDateParts(Number(date.slice(0,4)),Number(date.slice(5,7)),Number(date.slice(8,10)))){toast('日付を確認してください',{error:true});return;}try{await putExpense({id:uid(),date,store:$('#manualStore').value.trim()||$('#manualCategory').value,amount,category:$('#manualCategory').value,items:[],source:'manual',createdAt:Date.now()});}catch(err){console.warn(err);toast('保存できませんでした。入力内容はそのまま残っています',{error:true});return;}e.target.reset();setManualAuto();shownToday=todayISO();requestPersist();await refreshAggregates().catch(()=>{});toast('保存しました');showView('homeView');}finally{savingManual=false;if(mbtn)mbtn.disabled=false;}});
  $('#exportBackupBtn').addEventListener('click',exportBackup);
  $('#importBackupInput').addEventListener('change',e=>{const f=e.target.files&&e.target.files[0];e.target.value='';importBackupFile(f);});

  // v1.4: hide the bottom menu while the software keyboard is open (iPhone)
  let fullVH=window.visualViewport?window.visualViewport.height:window.innerHeight, lastVW=window.innerWidth;
  function isTextInput(el){return !!el&&((el.tagName==='INPUT'&&!/^(button|submit|reset|checkbox|radio|file|range|color|image)$/i.test(el.type||''))||el.tagName==='TEXTAREA');}
  // the software keyboard never changes the width: a width change (rotation, window resize) starts the measurement over
  function updateKeyboardNav(){const vv=window.visualViewport, focused=isTextInput(document.activeElement);if(vv&&window.innerWidth!==lastVW){lastVW=window.innerWidth;fullVH=vv.height;}if(vv&&!focused)fullVH=Math.max(fullVH,vv.height);const kb=vv?(fullVH-vv.height>120):focused;document.body.classList.toggle('keyboard-open',focused&&kb);}
  document.addEventListener('focusin',()=>setTimeout(updateKeyboardNav,50));
  document.addEventListener('focusout',()=>setTimeout(updateKeyboardNav,150));
  if(window.visualViewport) window.visualViewport.addEventListener('resize',updateKeyboardNav);
  window.addEventListener('resize',updateKeyboardNav);
  window.addEventListener('orientationchange',()=>{setTimeout(()=>{fullVH=window.visualViewport?window.visualViewport.height:window.innerHeight;updateKeyboardNav();},400);});

  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;$('#installBtn').hidden=false;});
  $('#installBtn').addEventListener('click',async()=>{if(!deferredPrompt)return;deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;$('#installBtn').hidden=true;});
  // v1.4: when a new version takes over, ask before reloading (never reload automatically)
  // v1.10.15: the page, app.js and styles.css must be of one version. Right after an update the old page can still be on screen while the new service
  // worker answers its requests (a new app.js under an old page). The page and the style sheet say which version they are; when they differ from this
  // app.js, the page is loaded again once (everything then comes from the new version), and if that does not help, the update banner is shown.
  (function checkVersions(){ let hv='', cv=''; try{ hv=((document.querySelector('meta[name="kakeibo-version"]')||{}).content||'').trim(); cv=(getComputedStyle(document.documentElement).getPropertyValue('--kakeibo-version')||'').trim().replace(/^["']|["']$/g,''); }catch(_){ }
    let css=false; try{ css=[...document.styleSheets].some(x=>/styles\.css/.test(x.href||'')); }catch(_){ }   // no style sheet at all (it could not be loaded): only the page is compared
    const K='kakeibo-version-reload'; if(hv===APP_VERSION&&(cv===APP_VERSION||!css)){ try{ sessionStorage.removeItem(K); }catch(_){ } return; }
    let tried=true; try{ tried=sessionStorage.getItem(K)===APP_VERSION; sessionStorage.setItem(K,APP_VERSION); }catch(_){ }
    console.info(`[kakeibo] version mismatch: page ${hv||'-'} / style ${cv||'-'} / app ${APP_VERSION}`);
    if(!tried){ location.reload(); return; } const b=$('#updateBanner'); if(b) b.classList.remove('hidden'); })();
  if('serviceWorker' in navigator){
    const hadController=!!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange',()=>{if(hadController)$('#updateBanner').classList.remove('hidden');});
    navigator.serviceWorker.register('./sw.js').then(reg=>{if(!reg)return;document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')reg.update().catch(()=>{});});}).catch(()=>{});
  }
  $('#reloadAppBtn').addEventListener('click',()=>location.reload());

  // pure helpers for automated tests (no data access)
  window.__KAKEIBO_TEST__=Object.freeze({foodBudgetStatus,parseFoodBudget,parseFoodBudgetInput,loadFoodBudget,saveFoodBudget,clearFoodBudget,foodBudgetKey:FOOD_BUDGET_KEY,taxMetaOfRecord,taxFieldsForSave,taxMixOf,parseAmountField,itemBasisOf,version:APP_VERSION,normalizeLine,parseAmountToken,splitAmount,classifyLine,extractDate,extractStore,parseReceipt,mergeReceiptPages,boundaryAnalysis,boundaryOverlap,sumCheckInfo,classifyItem,normalizeProductName,addExpenseCategories,categoryTotals,validateBackup,cleanExpense,calendarAmount,pairColumnLines,dbBoxes,minAreaRect,cropLine,assessReading,paperRangeFromPixels,eanValid,paperRange,readQuality,priceColumn,fixPriceText,priceLike,yenShort,similarity,rememberNameFix,findNameFix,loadNameFixes,clearCategoryLearning,paperShare,sharpnessOf,liveCameraMessage,putExpense,refreshAggregates,allExpenses,ctcDecode,assembleRows,loadPaddle,paddleRecognize,paperColumnRange,cropScale,readJpegInfo,orientMatrix,manualOrientation,ocrScale,enhanceGray,preprocess});

  openDB().then(()=>renderHome()).catch(()=>toast('端末保存を初期化できませんでした',{error:true}));
})();
