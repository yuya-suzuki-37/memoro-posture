// ===================================================================
// Memoro 姿勢診断 — UI FLOW
//   アップロード(選択/ドラッグ/貼付・HEIC対応) → 解析 → 結果描画
// ===================================================================

import { runDiagnosis, fileToImage } from './diagnosis.js?v=4';
import { KNOWLEDGE, CAMPS } from './knowledge.js?v=4';

// フォトウェディングの個別相談/申込URL。'#' の間はCTAボタン非表示。
const BOOKING_URL = '#';

const state = { front:null, side:null, lastResult:null };

const $ = (id) => document.getElementById(id);
const els = {
  dropFront:$('drop-front'), dropSide:$('drop-side'),
  fileFront:$('file-front'), fileSide:$('file-side'),
  btn:$('btn-analyze'),
  loader:$('loader'), loaderText:$('loader-text'),
  result:$('result'),
};

// ---------- アップロードスロット ----------
function setupDrop(kind){
  const drop = kind==='front' ? els.dropFront : els.dropSide;
  const input = kind==='front' ? els.fileFront : els.fileSide;

  input.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleFile(kind, f);
  });

  ['dragenter','dragover'].forEach(ev =>
    drop.addEventListener(ev, (e)=>{ e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave','drop'].forEach(ev =>
    drop.addEventListener(ev, (e)=>{ e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e)=>{
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(kind, f);
  });
}

// ⌘V 貼り付け(直近に触れたスロット、無ければ空いてる方へ)
let lastTouched = 'front';
[els.dropFront, els.dropSide].forEach((d,i)=>
  d.addEventListener('mouseenter', ()=> lastTouched = i===0?'front':'side'));
window.addEventListener('paste', (e)=>{
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items){
    if (it.type.indexOf('image') === 0){
      const f = it.getAsFile();
      const target = !state[lastTouched] ? lastTouched : (!state.front ? 'front' : 'side');
      if (f) handleFile(target, f);
      break;
    }
  }
});

async function handleFile(kind, file){
  const drop = kind==='front' ? els.dropFront : els.dropSide;
  try {
    drop.classList.add('drag');
    const img = await fileToImage(file, (t)=> showLoader(t));
    hideLoader();
    state[kind] = img;
    renderPreview(kind, img);
    updateAnalyzeBtn();
  } catch(err){
    hideLoader();
    alert(err.message || '写真を読み込めませんでした。');
  } finally {
    drop.classList.remove('drag');
  }
}

function renderPreview(kind, img){
  const drop = kind==='front' ? els.dropFront : els.dropSide;
  const label = kind==='front' ? '正面 / FRONT' : '横向き / SIDE';
  drop.classList.add('filled');
  drop.innerHTML = `
    <span class="req">${label}</span>
    <button type="button" class="redo" data-kind="${kind}">撮り直す</button>
    <div class="preview"><img src="${img.src}" alt=""></div>`;
  drop.querySelector('.redo').addEventListener('click', (e)=>{
    e.preventDefault(); e.stopPropagation();
    resetSlot(kind);
  });
}

function resetSlot(kind){
  state[kind] = null;
  const drop = kind==='front' ? els.dropFront : els.dropSide;
  const isFront = kind==='front';
  drop.classList.remove('filled');
  drop.innerHTML = isFront ? FRONT_SLOT_HTML : SIDE_SLOT_HTML;
  // input を再バインド
  const input = drop.querySelector('input[type=file]');
  input.addEventListener('change', (e)=>{ const f=e.target.files[0]; if(f) handleFile(kind,f); });
  updateAnalyzeBtn();
}

const FRONT_SLOT_HTML = els.dropFront.innerHTML;
const SIDE_SLOT_HTML = els.dropSide.innerHTML;

function updateAnalyzeBtn(){
  els.btn.disabled = !(state.front && state.side);
}

// ---------- ローダー ----------
function showLoader(text){ els.loader.hidden=false; els.loaderText.textContent=text; els.btn.disabled=true; }
function hideLoader(){ els.loader.hidden=true; updateAnalyzeBtn(); }

// ---------- 解析実行 ----------
els.btn.addEventListener('click', async ()=>{
  showLoader('診断をはじめます…');
  try {
    const res = await runDiagnosis({ front:state.front, side:state.side }, showLoader);
    hideLoader();
    if (!res.ok){ alert(res.message || '解析に失敗しました。'); return; }
    renderResult(res);
  } catch(err){
    hideLoader();
    console.error(err);
    alert('解析中にエラーが発生しました。写真を変えてお試しください。');
  }
});

// ===================================================================
// 結果描画
// ===================================================================
function renderResult(res){
  state.lastResult = res;
  const { type, score, grade, problems, metrics, disclaimer } = res;

  // 気になる項目(general以外を優先、severity順)
  const sevRank = { high:0, mid:1, low:2 };
  const findings = [...problems].sort((a,b)=> (sevRank[a.severity]-sevRank[b.severity]));

  // マッチするブートキャンプを集計
  const campScore = {};
  problems.forEach(p=>{
    const k = KNOWLEDGE[p.key]; if (!k) return;
    const w = p.severity==='high'?3 : p.severity==='mid'?2 : 1;
    (k.camps||[]).forEach(c=> campScore[c] = (campScore[c]||0)+w);
  });
  const matched = Object.keys(campScore).sort((a,b)=> campScore[b]-campScore[a]);

  els.result.innerHTML = `
    <div class="reveal">
      ${resultHeroHTML(type, score, grade)}
      ${myframeHTML(res)}
      ${findingsHTML(findings)}
      ${metricsHTML(metrics)}
      ${debugHTML(res)}
      ${bridgeHTML(matched)}
      <div class="disclaimer">${disclaimer}</div>
      <div class="btn-row">
        <button class="btn" id="btn-save">結果を画像で保存</button>
        <button class="btn-ghost" id="btn-restart">もう一度診断する</button>
      </div>
    </div>`;

  els.result.hidden = false;
  drawOverlays(res);
  $('btn-save').addEventListener('click', ()=> saveResultCard(res));
  $('btn-restart').addEventListener('click', ()=>{
    els.result.hidden = true; els.result.innerHTML='';
    window.scrollTo({ top:0, behavior:'smooth' });
  });
  setTimeout(()=> els.result.scrollIntoView({ behavior:'smooth', block:'start' }), 200);
}

function resultHeroHTML(type, score, grade){
  const circ = 2*Math.PI*58;
  const off = circ * (1 - score/100);
  const tags = (type.tags||[]).map(t=>`<span class="tag">${t}</span>`).join('');
  return `
  <section class="result-hero">
    <p class="announce">YOUR POSTURE TYPE</p>
    <h2 class="type-name">${type.name}</h2>
    <p class="type-desc">${type.desc}</p>
    <div class="tags">${tags}</div>
    <div class="score-wrap">
      <div class="dial">
        <svg width="132" height="132">
          <circle cx="66" cy="66" r="58" fill="none" stroke="#E7DED2" stroke-width="9"/>
          <circle cx="66" cy="66" r="58" fill="none" stroke="#B4936A" stroke-width="9"
            stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${off}"/>
        </svg>
        <div class="val"><b>${score}</b><span>SCORE</span></div>
      </div>
      <div class="grade">
        <div class="g-label">${grade.grade}</div>
        <div class="g-desc">${grade.desc}</div>
      </div>
    </div>
  </section>`;
}

function myframeHTML(res){
  const hasFront = !!res.resultFront, hasSide = !!res.resultSide;
  if (!hasFront && !hasSide) return '';
  return `
  <div class="myframe">
    <h3>あなたの立ち姿</h3>
    <p class="note">AIが読み取った体のラインを重ねています（この処理はすべて端末内で行われます）</p>
    <div class="myframe-grid">
      ${hasFront?`<figure><canvas id="cv-front"></canvas><figcaption>正面：肩・骨盤・頭の水平ライン</figcaption></figure>`:''}
      ${hasSide?`<figure><canvas id="cv-side"></canvas><figcaption>横：耳・肩・骨盤・くるぶしの垂直ライン</figcaption></figure>`:''}
    </div>
  </div>`;
}

function findingsHTML(findings){
  const cards = findings.map(p=>{
    const k = KNOWLEDGE[p.key] || {};
    const sevLabel = p.severity==='high'?'しっかりケアを':p.severity==='mid'?'気になるポイント':'軽めの傾向';
    const isGood = p.key==='general';
    return `
    <div class="finding ${p.severity}">
      <div class="finding-head">
        <h4>${k.label || p.title}</h4>
        ${isGood?'':`<span class="sev-chip ${p.severity}">${sevLabel}</span>`}
        ${p.metric && p.metric!=='OK' && p.metric!=='推定' ? `<span class="tag">${p.metric}</span>`:''}
      </div>
      <p class="trivia">${k.trivia || p.description}</p>
      ${k.evidence?`<p class="evidence">${k.evidence}</p>`:''}
    </div>`;
  }).join('');
  return `
    <div class="section-head" style="margin-top:40px">
      <span class="num">FINDINGS</span>
      <h2>読み取れたこと</h2>
    </div>
    <div class="findings">${cards}</div>`;
}

function metricsHTML(metrics){
  if (!metrics || !metrics.length) return '';
  const sevText = { good:'良好', warn:'やや注意', bad:'要ケア' };
  const rows = metrics.map(m=>`
    <div class="metric">
      <div class="metric-top">
        <span class="metric-name">${m.name}</span>
        <span class="metric-right">
          <span class="metric-val ${m.sev}">${m.value}</span>
          <span class="lvl-chip ${m.sev}">${sevText[m.sev]||''}</span>
        </span>
      </div>
      <div class="metric-bar"><i class="${m.sev}" style="width:${Math.max(6,m.pct)}%"></i></div>
      <div class="metric-detail">${m.detail}</div>
    </div>`).join('');
  return `
    <div class="section-head" style="margin-top:40px">
      <span class="num">MEASUREMENTS</span>
      <h2>解析した数値</h2>
    </div>
    <div class="metrics">${rows}</div>`;
}

// 開発用・生の数値パネル（?debug=1 のときだけ表示。較正用）
function debugHTML(res){
  if (!/[?&]debug=1/.test(location.search)) return '';
  const s = res.resultSide?.metrics || {}, f = res.resultFront?.metrics || {};
  const row = (k,v)=>`<tr><td>${k}</td><td style="text-align:right;font-variant-numeric:tabular-nums">${typeof v==='number'?v.toFixed(3):v}</td></tr>`;
  return `
  <div style="margin-top:20px;background:#2E2A26;color:#EDE6DC;border-radius:14px;padding:18px;font-family:monospace;font-size:12px;overflow-x:auto">
    <div style="color:#B4936A;letter-spacing:.1em;margin-bottom:8px">DEBUG · 生の測定値（較正用・?debug=1）</div>
    <table style="width:100%;border-collapse:collapse">
      ${row('頭の前傾角 forwardHeadAngle(°)', s.forwardHeadAngle)}
      ${row('肩シフト・足首基準 rsRatio', s.roundedShoulderRatio)}
      ${row('肩シフト・骨盤基準 rsRatioHip(旧)', s.roundedShoulderRatioHip)}
      ${row('骨盤前後傾 pelvicTiltAngle(°)', s.pelvicTiltAngle)}
      ${row('骨盤前方 pelvicForward', String(s.pelvicForward))}
      ${row('骨盤vs足首 hipFwdOfAnkle', s.hipFwdOfAnkle)}
      ${row('肩vs骨盤(後方) shoulderBehindHip', s.shoulderBehindHip)}
      ${row('CVA(参考・非使用)', s.cva)}
      ${row('肩の左右差 shoulderTilt(°)', f.shoulderTilt)}
      ${row('骨盤の左右差 pelvicTilt(°)', f.pelvicTilt)}
      ${row('頭の左右傾き headTilt(°)', f.headTilt)}
      ${row('膝L kneeDev(°)', f.lKneeDev)}
      ${row('膝R kneeDev(°)', f.rKneeDev)}
    </table>
  </div>`;
}

function bridgeHTML(matched){
  const order = matched.length ? matched : ['posture','pilates'];
  const cards = ['posture','pilates','yoga','fatburn'].map(id=>{
    const c = CAMPS[id]; const isMatch = order.slice(0,2).includes(id);
    return `
    <div class="camp-card ${isMatch?'match':''}">
      ${isMatch?'<span class="badge">あなたに合いそう</span>':''}
      <h4>${c.name}</h4>
      <div class="tl">${c.tagline}</div>
      <p>${c.desc}</p>
    </div>`;
  }).join('');
  const cta = BOOKING_URL && BOOKING_URL !== '#'
    ? `<div class="cta-row"><a class="btn" href="${BOOKING_URL}" target="_blank" rel="noopener">オプションについて相談する</a></div>`
    : `<p class="bridge-soft">気になる方は、フォトウェディングのご相談のときにお気軽にお声かけください。</p>`;
  return `
  <div class="bridge">
    <p class="kicker">OPTION FOR YOUR BIG DAY</p>
    <h3>挙式までの、からだづくり</h3>
    <p class="sub">ご希望の方には、あなたの姿勢に合わせたケアもご用意しています。フォトウェディングのオプションとして、無理のない範囲でどうぞ。</p>
    <div class="camp-cards">${cards}</div>
    ${cta}
  </div>`;
}

// ---------- 写真にライン重ね ----------
function drawOverlays(res){
  if (res.resultFront) drawFront($('cv-front'), res.resultFront);
  if (res.resultSide)  drawSide($('cv-side'), res.resultSide);
}

function fitCanvas(cv, img){
  const maxW = 300;
  const ratio = img.naturalHeight / img.naturalWidth;
  cv.width = maxW; cv.height = Math.round(maxW * ratio);
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  return ctx;
}
const P = (lm, cv) => ({ x: lm.x*cv.width, y: lm.y*cv.height });

function line(ctx, a, b, color, w=3){
  ctx.strokeStyle=color; ctx.lineWidth=w; ctx.lineCap='round';
  ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
}
function dot(ctx, p, color, r=5){
  ctx.fillStyle=color; ctx.beginPath(); ctx.arc(p.x,p.y,r,0,7); ctx.fill();
  ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.stroke();
}
function dashV(ctx, x, color){
  ctx.save(); ctx.setLineDash([6,6]); ctx.strokeStyle=color; ctx.lineWidth=2;
  ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,ctx.canvas.height); ctx.stroke(); ctx.restore();
}

const ROSE='#C58274', SAGE='#8AA98C', GOLD='#B4936A';

function drawFront(cv, r){
  if (!cv || !r.image) return;
  const ctx = fitCanvas(cv, r.image);
  const L = r.landmarks;
  const lSh=P(L.lSh,cv), rSh=P(L.rSh,cv), lHip=P(L.lHip,cv), rHip=P(L.rHip,cv),
        lEar=P(L.lEar,cv), rEar=P(L.rEar,cv);
  // 中心の垂直基準
  dashV(ctx, (lHip.x+rHip.x)/2, 'rgba(180,147,106,.6)');
  line(ctx, lEar, rEar, GOLD, 2.5);   // 頭の傾き
  line(ctx, lSh, rSh, ROSE, 3.5);     // 肩ライン
  line(ctx, lHip, rHip, SAGE, 3.5);   // 骨盤ライン
  [lSh,rSh].forEach(p=>dot(ctx,p,ROSE)); [lHip,rHip].forEach(p=>dot(ctx,p,SAGE));
}

function drawSide(cv, r){
  if (!cv || !r.image) return;
  const ctx = fitCanvas(cv, r.image);
  const L = r.landmarks;
  const ear=P(L.ear,cv), sh=P(L.shoulder,cv), hip=P(L.hip,cv), knee=P(L.knee,cv), ank=P(L.ankle,cv);
  // 理想の垂直ライン(くるぶし基準)
  dashV(ctx, ank.x, 'rgba(180,147,106,.6)');
  // 体のライン 耳-肩-骨盤-膝-くるぶし
  line(ctx, ear, sh, ROSE, 3.5);
  line(ctx, sh, hip, SAGE, 3.5);
  line(ctx, hip, knee, SAGE, 3.5);
  line(ctx, knee, ank, SAGE, 3.5);
  [sh,hip,knee,ank].forEach(p=>dot(ctx,p,SAGE)); dot(ctx,ear,ROSE);
}

// ---------- 結果カード(PNG保存) ----------
function saveResultCard(res){
  const W=900, H=1200, cv=document.createElement('canvas');
  cv.width=W; cv.height=H;
  const ctx=cv.getContext('2d');
  const serif='"Shippori Mincho", serif', sans='"Zen Kaku Gothic New", sans-serif';
  // 背景
  const g=ctx.createLinearGradient(0,0,0,H); g.addColorStop(0,'#FFFDFA'); g.addColorStop(1,'#F3ECE3');
  ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
  ctx.fillStyle='#B4936A'; ctx.textAlign='center';
  // ブランド
  ctx.font=`600 40px ${serif}`; ctx.fillText('Memoro', W/2, 96);
  ctx.font=`400 16px ${sans}`; ctx.fillStyle='#9A794F';
  ctx.fillText('P O S T U R E   C H E C K', W/2, 128);
  // タイプ
  ctx.fillStyle='#9A794F'; ctx.font=`400 17px ${sans}`;
  ctx.fillText('YOUR POSTURE TYPE', W/2, 210);
  ctx.fillStyle='#33302B'; ctx.font=`600 46px ${serif}`;
  wrapText(ctx, res.type.name, W/2, 270, 760, 56);
  // スコアダイヤル
  const cx=W/2, cy=470, r=110;
  ctx.lineWidth=16; ctx.strokeStyle='#E7DED2';
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.stroke();
  ctx.strokeStyle='#B4936A'; ctx.lineCap='round';
  ctx.beginPath(); ctx.arc(cx,cy,r,-Math.PI/2, -Math.PI/2 + Math.PI*2*(res.score/100)); ctx.stroke();
  ctx.fillStyle='#33302B'; ctx.font=`600 70px ${serif}`;
  ctx.fillText(String(res.score), cx, cy+18);
  ctx.fillStyle='#6B645B'; ctx.font=`400 15px ${sans}`; ctx.fillText('SCORE', cx, cy+52);
  ctx.fillStyle='#B4936A'; ctx.font=`500 22px ${serif}`; ctx.fillText(res.grade.grade, cx, cy+120);
  // 気になる項目 上位3つ
  ctx.fillStyle='#9A794F'; ctx.font=`400 16px ${sans}`; ctx.textAlign='center';
  ctx.fillText('気になるポイント', W/2, 700);
  const sevRank={high:0,mid:1,low:2};
  const tops=[...res.problems].filter(p=>p.key!=='general')
    .sort((a,b)=>sevRank[a.severity]-sevRank[b.severity]).slice(0,3);
  ctx.textAlign='left';
  let y=750;
  (tops.length?tops:[{key:'general'}]).forEach(p=>{
    const k=KNOWLEDGE[p.key]||{};
    ctx.fillStyle='#B4936A'; ctx.beginPath(); ctx.arc(140, y-6, 5, 0, 7); ctx.fill();
    ctx.fillStyle='#33302B'; ctx.font=`500 26px ${serif}`;
    ctx.fillText(k.label||'とても良い姿勢です', 165, y);
    y+=64;
  });
  // フッター
  ctx.textAlign='center'; ctx.fillStyle='#9A794F'; ctx.font=`400 17px ${serif}`;
  ctx.fillText('Memoro Photo Wedding', W/2, H-70);
  ctx.fillStyle='#A79A88'; ctx.font=`400 13px ${sans}`;
  ctx.fillText('※ 写真からの姿勢セルフチェックです（医学的診断ではありません）', W/2, H-42);
  // DL
  const a=document.createElement('a');
  a.download='Memoro_姿勢診断結果.png';
  a.href=cv.toDataURL('image/png'); a.click();
}
function wrapText(ctx, text, x, y, maxW, lh){
  const chars=[...text]; let line='', yy=y;
  for(const ch of chars){
    if(ctx.measureText(line+ch).width>maxW && line){ ctx.fillText(line,x,yy); line=ch; yy+=lh; }
    else line+=ch;
  }
  if(line) ctx.fillText(line,x,yy);
}

// ---------- init ----------
setupDrop('front');
setupDrop('side');
updateAnalyzeBtn();
