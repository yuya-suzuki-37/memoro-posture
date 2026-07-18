// ===================================================================
// POSTURE ANALYZER (evidence-based v2)
// MediaPipe Pose Landmarker の33ランドマークから臨床アングル/逸脱を計算
// 基準値の根拠は posture-tool/_knowledge/ を参照。
//
// 🔴 重要な前提（_knowledge/00-実装サマリ.md より）:
//   - 本ツールは「診断」ではなく「スクリーニング」。
//   - C7・大転子・ASIS/PSIS はMediaPipeに無いため近似（CALIB定数で調整）。
//   - 写真2枚で妥当に測れるのは CVA・HKA(膝)・左右差・スウェイバック代理のみ。
//     骨盤前後傾は相対判定、足首背屈は写真不可（問診/セルフチェックへ）。
// ===================================================================

// MediaPipe Pose のランドマーク index (33点)
const LM = {
  NOSE:0, LEFT_EYE_INNER:1, LEFT_EYE:2, LEFT_EYE_OUTER:3,
  RIGHT_EYE_INNER:4, RIGHT_EYE:5, RIGHT_EYE_OUTER:6,
  LEFT_EAR:7, RIGHT_EAR:8,
  MOUTH_LEFT:9, MOUTH_RIGHT:10,
  LEFT_SHOULDER:11, RIGHT_SHOULDER:12,
  LEFT_ELBOW:13, RIGHT_ELBOW:14,
  LEFT_WRIST:15, RIGHT_WRIST:16,
  LEFT_PINKY:17, RIGHT_PINKY:18,
  LEFT_INDEX:19, RIGHT_INDEX:20,
  LEFT_THUMB:21, RIGHT_THUMB:22,
  LEFT_HIP:23, RIGHT_HIP:24,
  LEFT_KNEE:25, RIGHT_KNEE:26,
  LEFT_ANKLE:27, RIGHT_ANKLE:28,
  LEFT_HEEL:29, RIGHT_HEEL:30,
  LEFT_FOOT_INDEX:31, RIGHT_FOOT_INDEX:32,
};

// ===== キャリブレーション定数（実データで要調整）=====
// C7はMediaPipeに無いため肩(acromion)から推定する。POSTERIORを上げると
// 「正常」のCVAが下がる。初期値は正常立位でCVA≈58-60°になるよう設定。
const CALIB = {
  C7_POSTERIOR: 0.60,  // C7を肩より後方へ neckH×この値 ずらす
  KNEE_GREY_DEG: 6,    // 膝のフロンタル偏位 これ未満は正常（HKA ±誤差吸収）
};

const SCREENING_DISCLAIMER =
  'この結果は写真からの姿勢スクリーニングであり、医学的診断ではありません。' +
  '気になる症状や強い左右差がある場合は専門家（整形外科等）にご相談ください。';

// ========== UTILS ==========
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function mid(a,b){ return { x:(a.x+b.x)/2, y:(a.y+b.y)/2, visibility:Math.min(a.visibility||1,b.visibility||1) }; }
function tilt(a,b){
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.atan2(dx, -dy) * 180 / Math.PI; // 真上方向を0度に
}
function angle3(a,b,c){
  const ab = { x:a.x-b.x, y:a.y-b.y };
  const cb = { x:c.x-b.x, y:c.y-b.y };
  const dot = ab.x*cb.x + ab.y*cb.y;
  const mag = Math.hypot(ab.x,ab.y) * Math.hypot(cb.x,cb.y);
  return Math.acos(Math.min(1,Math.max(-1, dot/mag))) * 180 / Math.PI;
}
function horizAngleDeg(a,b){
  return Math.atan2(b.y-a.y, b.x-a.x) * 180 / Math.PI; // 水平からの傾き
}

// ========== SIDE VIEW (横向き写真) ==========
function detectSideFacing(lms){
  const lEar = lms[LM.LEFT_EAR], rEar = lms[LM.RIGHT_EAR];
  if ((lEar?.visibility||0) > (rEar?.visibility||0)) return 'left';
  return 'right';
}

function analyzeSide(lms){
  const facing = detectSideFacing(lms);
  const earKey = facing==='left' ? LM.LEFT_EAR : LM.RIGHT_EAR;
  const shKey  = facing==='left' ? LM.LEFT_SHOULDER : LM.RIGHT_SHOULDER;
  const hipKey = facing==='left' ? LM.LEFT_HIP : LM.RIGHT_HIP;
  const kneeKey= facing==='left' ? LM.LEFT_KNEE : LM.RIGHT_KNEE;
  const ankKey = facing==='left' ? LM.LEFT_ANKLE : LM.RIGHT_ANKLE;
  const elbowKey = facing==='left' ? LM.LEFT_ELBOW : LM.RIGHT_ELBOW;

  const ear   = lms[earKey];
  const sh    = lms[shKey];
  const hip   = lms[hipKey];
  const knee  = lms[kneeKey];
  const ankle = lms[ankKey];

  const trunkLen = dist(sh, hip) || 1e-6;
  // 前方(顔の向き)を正とするx方向の符号
  const forwardDir = facing==='left' ? -1 : 1;

  // === 1. 推定CVA（頭頸角）— _knowledge/01 ===
  // 真のCVAは C7頂点・水平基準・C7→耳珠。C7を肩から後方推定して近似。
  // 値が小さいほど頭部前方位（<50°=FHP）。
  const neckH = Math.abs(ear.y - sh.y) || 1e-6;
  const earFwd = forwardDir * (ear.x - sh.x);        // 耳が前方なら正
  const cvaRun = Math.abs(earFwd + CALIB.C7_POSTERIOR * neckH); // C7→耳の水平距離
  const cva = Math.atan2(neckH, cvaRun) * 180 / Math.PI;
  // 旧指標も互換のため残す（耳-肩の垂直からの傾き）
  const fhAngle = Math.atan2(Math.abs(earFwd), neckH) * 180 / Math.PI;

  // === 2. 巻き肩（肩-骨盤の前方シフト比）— _knowledge/02 ===
  // ※FSA(52°)はC7必須で写真不可。肩が体幹に対しどれだけ前方かの比率を代理に。
  const shOffset = forwardDir * (sh.x - hip.x);      // 肩が骨盤より前なら正
  const rsRatio = shOffset / trunkLen;
  const rsAngle = Math.atan2(Math.abs(shOffset), Math.abs(sh.y - hip.y)) * 180 / Math.PI;

  // === 3. 骨盤前後傾（相対推定）— _knowledge/04 ===
  // ASIS/PSIS不可のため相対推定。絶対角は断定しない。
  const thighTilt = horizAngleDeg(hip, knee);
  const pelvicTilt = Math.abs(90 - Math.abs(thighTilt));
  const pelvicHorizDiff = forwardDir * (hip.x - knee.x);
  const pelvicForward = pelvicHorizDiff > 0;

  // === 4. 膝（立位）
  const kneeAngle = angle3(hip, knee, ankle);
  const kneeFlex = 180 - kneeAngle;

  // === 5. スウェイバック代理 — _knowledge/05 ===
  // hipがankleより前方 AND 肩がhipより後方。
  const hipFwdOfAnkle = forwardDir * (hip.x - ankle.x) / trunkLen; // 正=骨盤前方
  const shoulderBehindHip = forwardDir * (hip.x - sh.x) / trunkLen; // 正=肩が骨盤より後方

  // === 6. Plumb Line 逸脱
  const refX = ankle.x;
  const plumbDev = {
    ear:   Math.abs(ear.x - refX) / trunkLen,
    shoulder: Math.abs(sh.x - refX) / trunkLen,
    hip:   Math.abs(hip.x - refX) / trunkLen,
    knee:  Math.abs(knee.x - refX) / trunkLen,
  };

  return {
    facing,
    landmarks: { ear, shoulder:sh, hip, knee, ankle, elbow: lms[elbowKey] },
    metrics: {
      cva,
      forwardHeadAngle: fhAngle,
      roundedShoulderRatio: rsRatio,
      roundedShoulderAngle: rsAngle,
      pelvicTiltAngle: pelvicTilt,
      pelvicForward,
      kneeFlex,
      hipFwdOfAnkle,
      shoulderBehindHip,
      plumbDev,
    }
  };
}

// ========== FRONT VIEW ==========
function analyzeFront(lms){
  const lSh = lms[LM.LEFT_SHOULDER], rSh = lms[LM.RIGHT_SHOULDER];
  const lHip = lms[LM.LEFT_HIP], rHip = lms[LM.RIGHT_HIP];
  const lKnee = lms[LM.LEFT_KNEE], rKnee = lms[LM.RIGHT_KNEE];
  const lAnk = lms[LM.LEFT_ANKLE], rAnk = lms[LM.RIGHT_ANKLE];
  const lEar = lms[LM.LEFT_EAR], rEar = lms[LM.RIGHT_EAR];

  const shoulderWidth = dist(lSh, rSh) || 1e-6;
  const trunkH = dist(mid(lSh,rSh), mid(lHip,rHip));

  // 左右差（度）— _knowledge/09
  const shoulderTilt = horizAngleDeg(lSh, rSh);
  const pelvicTilt = horizAngleDeg(lHip, rHip);
  const headTilt = horizAngleDeg(lEar, rEar);

  // 膝のフロンタル偏位（HKA近似）— _knowledge/07
  // dev = 180 - angle3(hip,knee,ankle)。方向は膝が hip-ankle 線の内/外どちらか。
  function kneeFrontal(hip,knee,ankle){
    const dev = 180 - angle3(hip, knee, ankle);
    const t = (knee.y - hip.y) / ((ankle.y - hip.y) || 1e-6);
    const lineX = hip.x + t * (ankle.x - hip.x); // hip-ankle線上の、膝の高さでのx
    return { dev, kneeOffLine: knee.x - lineX };
  }
  const lk = kneeFrontal(lHip, lKnee, lAnk);
  const rk = kneeFrontal(rHip, rKnee, rAnk);
  const midHipX = (lHip.x + rHip.x) / 2;
  // 内側(midline向き)に入っていれば valgus(X)、外側なら varus(O)
  const lKneeMedial = (midHipX - lKnee.x);   // 左膝: 正=内側へ
  const rKneeMedial = (rKnee.x - midHipX);   // 右膝: 正=内側へ

  const lateralScore =
    Math.abs(shoulderTilt) * 0.4 +
    Math.abs(pelvicTilt) * 0.4 +
    Math.abs(headTilt) * 0.2;

  return {
    landmarks: { lSh, rSh, lHip, rHip, lKnee, rKnee, lAnk, rAnk, lEar, rEar },
    metrics: {
      shoulderTilt, pelvicTilt, headTilt,
      lKneeDev: lk.dev, rKneeDev: rk.dev,
      lKneeMedial, rKneeMedial,
      lateralScore,
      shoulderWidth, trunkH,
    }
  };
}

// ========== PROBLEM DETECTION（エビデンス基準）==========
function detectProblems(sideRes, frontRes){
  const problems = [];
  const m = sideRes?.metrics || {};
  const fm = frontRes?.metrics || null;

  // 1. 頭部前方位（CVA < 50° = FHP / 小さいほど悪い）— _knowledge/01
  if (m.cva != null) {
    const cva = m.cva;
    if (cva < 50) {
      const severity = cva >= 45.5 ? 'low' : cva >= 40 ? 'mid' : 'high';
      problems.push(buildProblem('forwardHead', '頭部前方位（前方頭位）', severity, cva.toFixed(1)+'°', cva));
    }
  }

  // 2. 巻き肩（肩前方シフト比）— _knowledge/02（FSA直接は写真不可のため代理）
  if (m.roundedShoulderRatio != null && m.roundedShoulderRatio > 0.05) {
    const r = m.roundedShoulderRatio;
    const severity = r < 0.08 ? 'low' : r < 0.15 ? 'mid' : 'high';
    problems.push(buildProblem('roundedShoulders', '巻き肩（肩甲骨前方位）', severity, (r*100).toFixed(1)+'%', r));
  }

  // 3. 猫背（胸椎後弯）= CVA代理 — _knowledge/03（真の後弯は写真不可）
  //    強い頭部前方位に併発する猫背"傾向"として推定。
  if (m.cva != null && m.cva < 47) {
    const cva = m.cva;
    const severity = cva >= 43 ? 'low' : cva >= 38 ? 'mid' : 'high';
    problems.push(buildProblem('thoracicKyphosis', '猫背傾向（胸椎後弯・推定）', severity, '推定', cva));
  }

  // 4. 骨盤前後傾（相対推定）— _knowledge/04（絶対角は断定しない）
  if (m.pelvicForward && m.pelvicTiltAngle > 8){
    const severity = m.pelvicTiltAngle < 12 ? 'low' : m.pelvicTiltAngle < 18 ? 'mid' : 'high';
    problems.push(buildProblem('anteriorPelvicTilt', '骨盤前傾傾向（反り腰・相対推定）', severity, '前傾傾向', m.pelvicTiltAngle));
  } else if (!m.pelvicForward && m.pelvicTiltAngle > 8){
    const severity = m.pelvicTiltAngle < 12 ? 'low' : m.pelvicTiltAngle < 18 ? 'mid' : 'high';
    problems.push(buildProblem('posteriorPelvicTilt', '骨盤後傾傾向（相対推定）', severity, '後傾傾向', m.pelvicTiltAngle));
  }

  // 5. スウェイバック代理 — _knowledge/05
  if (m.hipFwdOfAnkle != null && m.hipFwdOfAnkle > 0.12 && m.shoulderBehindHip > 0.04) {
    const v = m.hipFwdOfAnkle;
    const severity = v < 0.2 ? 'low' : v < 0.3 ? 'mid' : 'high';
    problems.push(buildProblem('swayBack', 'スウェイバック姿勢（推定）', severity, '骨盤前方＋上体後方', v));
  }

  // 6. 左右非対称（正面）— _knowledge/09（健常者でも差はある→広めの正常域）
  if (fm) {
    const sh = Math.abs(fm.shoulderTilt);
    const pv = Math.abs(fm.pelvicTilt);
    const hd = Math.abs(fm.headTilt);
    // 肩 正常<3° / 骨盤(obliquity) 正常<5.6° / 頭部<5°
    if (sh > 3 || pv > 5.6 || hd > 5) {
      const ratio = Math.max(sh/3, pv/5.6, hd/5); // 正常上限に対する超過率
      const severity = ratio < 1.7 ? 'low' : ratio < 2.6 ? 'mid' : 'high';
      const worst = Math.max(sh, pv, hd);
      problems.push(buildProblem('lateralAsymmetry', '左右非対称', severity, worst.toFixed(1)+'°', worst));
    }

    // 7. 膝アライメント（HKA近似）— _knowledge/07（±グレーゾーンで誤検出減）
    const grey = CALIB.KNEE_GREY_DEG;
    const lVal = fm.lKneeDev > grey && fm.lKneeMedial > 0;
    const rVal = fm.rKneeDev > grey && fm.rKneeMedial > 0;
    const lVar = fm.lKneeDev > grey && fm.lKneeMedial < 0;
    const rVar = fm.rKneeDev > grey && fm.rKneeMedial < 0;
    if (lVal || rVal) {
      const v = Math.max(fm.lKneeDev, fm.rKneeDev);
      const severity = v < 10 ? 'low' : v < 15 ? 'mid' : 'high';
      problems.push(buildProblem('kneeValgus', 'X脚傾向（膝の内向き）', severity, v.toFixed(1)+'°', v));
    } else if (lVar || rVar) {
      const v = Math.max(fm.lKneeDev, fm.rKneeDev);
      const severity = v < 10 ? 'low' : v < 15 ? 'mid' : 'high';
      problems.push(buildProblem('kneeVarus', 'O脚傾向（膝の外向き）', severity, v.toFixed(1)+'°', v));
    }

    // 8. 側弯傾向（スクリーニングのみ）— _knowledge/06
    // 肩と骨盤の傾きが逆方向（Cカーブ代償）かつ一定以上。受診勧奨に留める。
    if (Math.abs(fm.shoulderTilt) > 3 && Math.abs(fm.pelvicTilt) > 5.6
        && Math.sign(fm.shoulderTilt) !== Math.sign(fm.pelvicTilt)) {
      const v = (Math.abs(fm.shoulderTilt) + Math.abs(fm.pelvicTilt)) / 2;
      problems.push(buildProblem('scoliosis', '左右差（側弯傾向・要受診確認）', 'mid', v.toFixed(1)+'°', v));
    }
  }

  // ※ 足首背屈制限(ankleStiffness)は静止写真では測定不可のため自動検出しない。
  //   → 問診/セルフチェック（膝-壁テスト）で扱う（_knowledge/08）。

  if (problems.length === 0) {
    problems.push({
      key:'general', severity:'low', title:'全体的に良好な姿勢',
      description:'明確な逸脱は検出されませんでした。さらに磨きをかける軽い維持メニューを提案します。',
      metric:'OK', tissues:{ tight:[], weak:[] },
    });
  }

  return problems;
}

const PROBLEM_TEMPLATES = {
  forwardHead: {
    description:'頭が肩より前方に位置する状態。長時間のスマホ・PC使用が主原因で、首の負担が大きく、眼精疲労・頭痛・肩こりの根本原因になりやすい。',
    tissues:{ tight:['上部僧帽筋','肩甲挙筋','胸鎖乳突筋','後頭下筋群','頸半棘筋'], weak:['深部頸屈筋(頸長筋/頭長筋)','下部僧帽筋','前鋸筋'] },
  },
  roundedShoulders: {
    description:'肩が前方に巻き込まれた状態。胸郭の動きを制限し呼吸を浅くします。胸郭出口症候群・肩インピンジメントの一因にも。',
    tissues:{ tight:['大胸筋','小胸筋','烏口腕筋','広背筋上部','肩甲下筋'], weak:['菱形筋','下部僧帽筋','棘下筋','小円筋','前鋸筋'] },
  },
  thoracicKyphosis: {
    description:'胸椎が過度に後弯した猫背"傾向"。写真からは直接測れないため、頭部前方位から推定した参考所見です。',
    tissues:{ tight:['脊柱起立筋(下部胸椎)','大胸筋','小胸筋','腹直筋上部'], weak:['脊柱起立筋(上部胸椎)','下部僧帽筋','菱形筋','多裂筋'] },
  },
  anteriorPelvicTilt: {
    description:'骨盤が前に傾き腰椎が反った状態(反り腰)の傾向。腸腰筋短縮と臀筋弱化のコンビネーション。※写真からの相対推定です。',
    tissues:{ tight:['腸腰筋(腸骨筋/大腰筋)','大腿直筋','脊柱起立筋(腰部)','大腿筋膜張筋','腰方形筋'], weak:['大臀筋','腹直筋','腹横筋','ハムストリングス'] },
  },
  posteriorPelvicTilt: {
    description:'骨盤が後ろに傾き腰椎の生理的湾曲が失われた傾向。長時間座位で多発。※写真からの相対推定です。',
    tissues:{ tight:['ハムストリングス','腹直筋','大臀筋(上部繊維)'], weak:['腸腰筋','脊柱起立筋(腰部)','多裂筋'] },
  },
  swayBack: {
    description:'骨盤が前方にシフトし上半身が後ろに倒れる代償姿勢。関節包と靱帯に負担がかかりやすいパターン。',
    tissues:{ tight:['ハムストリングス','腹直筋上部','広背筋'], weak:['腸腰筋','腹斜筋','下部脊柱起立筋','多裂筋'] },
  },
  lateralAsymmetry: {
    description:'肩や骨盤の左右の高さに差がある状態。なお健常者でも軽度の左右差はよくあります。極端な差が続く場合は要注意。',
    tissues:{ tight:['腰方形筋(高い側)','広背筋(高い側)','中臀筋(低い側)'], weak:['腰方形筋(低い側)','中臀筋(高い側)','腹斜筋(反対側)'] },
  },
  kneeValgus: {
    description:'膝が内側に入る傾向(X脚)。中臀筋・深層外旋六筋の機能不全が一因。膝痛・偏平足への連鎖に注意。',
    tissues:{ tight:['内転筋群','大腿筋膜張筋','腓腹筋(内側頭)'], weak:['中臀筋','深層外旋六筋','大臀筋(下部繊維)','後脛骨筋'] },
  },
  kneeVarus: {
    description:'O脚(膝が外側に開く)傾向。中臀筋・内側広筋・内転筋下部の機能不全、外側組織の過緊張が一因。',
    tissues:{ tight:['大腿筋膜張筋','腸脛靱帯','外側ハムストリングス','腓骨筋','梨状筋'], weak:['内転筋群下部','内側広筋','中臀筋後部繊維','内側ハムストリングス','後脛骨筋'] },
  },
  scoliosis: {
    description:'脊柱の左右への弯曲傾向（機能性側弯の可能性）。写真では確定できません。気になる場合は整形外科での評価を推奨します。',
    tissues:{ tight:['凸側 腰方形筋','凸側 広背筋','凸側 腹斜筋','凸側 腸腰筋'], weak:['凹側 腰方形筋','凹側 腹斜筋','凹側 中臀筋','凹側 多裂筋'] },
  },
  ankleStiffness: {
    description:'足首の背屈可動域制限。※静止写真では測定できないため、セルフチェック（膝-壁テスト）で確認します。',
    tissues:{ tight:['腓腹筋','ヒラメ筋','後脛骨筋','足底筋膜'], weak:['前脛骨筋','長腓骨筋'] },
  },
};

function buildProblem(key, title, severity, metricStr, rawValue){
  const tpl = PROBLEM_TEMPLATES[key] || {};
  return {
    key, severity, title,
    description: tpl.description || '',
    tissues: tpl.tissues || { tight:[], weak:[] },
    metric: metricStr,
    rawValue,
  };
}

// ========== POSTURE TYPE ==========
function determinePostureType(problems){
  const keys = problems.map(p=>p.key);
  const hasFH = keys.includes('forwardHead');
  const hasRS = keys.includes('roundedShoulders');
  const hasTK = keys.includes('thoracicKyphosis');
  const hasAPT = keys.includes('anteriorPelvicTilt');
  const hasSway = keys.includes('swayBack');
  const hasAsym = keys.includes('lateralAsymmetry');
  const hasKV = keys.includes('kneeValgus');

  if (hasFH && (hasRS || hasTK)) {
    if (hasAPT) {
      return { name:'上部交差＋下部交差症候群',
        desc:'頭部前方位・巻き肩と反り腰が併存。デスクワーカーに最も多い「複合タイプ」。胸椎モビリティと股関節屈筋の解放が鍵。',
        tags:['Upper Crossed Syndrome','Lower Crossed Syndrome','複合型'] };
    }
    return { name:'上部交差症候群（Upper Crossed Syndrome）',
      desc:'頭部前方位・胸椎後弯・肩甲骨前方位の典型パターン。Janda博士による分類。スマホ・PC作業で進行しやすい現代型。',
      tags:['Upper Crossed Syndrome','頭部前方位','巻き肩'] };
  }
  if (hasAPT) {
    return { name:'下部交差症候群（Lower Crossed Syndrome）',
      desc:'腸腰筋・脊柱起立筋の短縮と、腹筋・臀筋の弱化が交差したパターン。反り腰・腰痛の温床。',
      tags:['Lower Crossed Syndrome','反り腰','骨盤前傾'] };
  }
  if (hasSway) {
    return { name:'スウェイバック姿勢',
      desc:'骨盤を前に押し出し、上半身が後ろに倒れた「楽な立ち方」。靱帯と関節包に依存しやすい姿勢パターン。',
      tags:['Sway Back','骨盤前方シフト'] };
  }
  if (hasAsym || hasKV) {
    return { name:'機能的左右非対称型',
      desc:'肩・骨盤・膝のいずれかに左右差。生活習慣の偏り(片側荷重・足組み等)が関与するパターン。',
      tags:['Lateral Asymmetry','機能不全'] };
  }
  if (hasTK || hasRS){
    return { name:'軽度猫背・巻き肩タイプ',
      desc:'胸椎の柔軟性低下と肩甲骨周囲の弱化の傾向。早期介入で十分に改善が見込めます。',
      tags:['軽症','胸椎モビリティ要'] };
  }
  return { name:'良好な姿勢', desc:'明確な逸脱は見つかりません。維持メニューで現状をキープしましょう。', tags:['Good','維持期'] };
}

// ========== SCORE ==========
function calcScore(sideRes, frontRes, problems){
  let score = 100;
  problems.forEach(p => {
    if (p.severity === 'low')  score -= 4;
    if (p.severity === 'mid')  score -= 9;
    if (p.severity === 'high') score -= 16;
  });
  return Math.max(35, Math.min(100, score));
}

function gradeFromScore(s){
  if (s >= 92) return { grade:'EXCELLENT', desc:'とても良好な姿勢。維持を心がけましょう。' };
  if (s >= 82) return { grade:'GOOD',      desc:'良好な姿勢。微調整でさらに伸びしろあり。' };
  if (s >= 70) return { grade:'FAIR',      desc:'いくつか改善ポイントあり。30日プログラムで改善が見込めます。' };
  if (s >= 58) return { grade:'NEEDS WORK',desc:'複数の逸脱傾向を検出。集中的なケアがおすすめです。' };
  return         { grade:'CHECK',          desc:'多面的な傾向を検出。気になる場合は専門家への相談も検討を。' };
}

// ========== METRICS DISPLAY ==========
function buildMetricsList(sideRes, frontRes){
  const list = [];
  const m = sideRes?.metrics;
  const fm = frontRes?.metrics;

  if (m && m.cva != null) {
    list.push({
      name:'頭頸角 CVA（推定）',
      value: m.cva.toFixed(1) + '°',
      detail:'臨床基準: 正常≥50° / 50°未満で頭部前方位（小さいほど前方位）',
      pct: Math.min(100, Math.max(0, (65 - m.cva) / 30 * 100)),
      sev: m.cva >= 50 ? 'good' : m.cva >= 45.5 ? 'warn' : 'bad',
    });
    list.push({
      name:'肩の前方シフト',
      value: (m.roundedShoulderRatio*100).toFixed(1) + '%',
      detail:'体幹長に対する肩の前方シフト率（巻き肩の代理指標）。正常<5%',
      pct: Math.min(100, m.roundedShoulderRatio * 400),
      sev: m.roundedShoulderRatio < 0.05 ? 'good' : m.roundedShoulderRatio < 0.08 ? 'warn' : 'bad',
    });
  }
  if (fm) {
    list.push({
      name:'肩の高さ左右差',
      value: Math.abs(fm.shoulderTilt).toFixed(1) + '°',
      detail:'正常<3°（健常者でも軽度差はよくあります）',
      pct: Math.min(100, Math.abs(fm.shoulderTilt) / 8 * 100),
      sev: Math.abs(fm.shoulderTilt) < 3 ? 'good' : Math.abs(fm.shoulderTilt) < 5 ? 'warn' : 'bad',
    });
    list.push({
      name:'骨盤の高さ左右差',
      value: Math.abs(fm.pelvicTilt).toFixed(1) + '°',
      detail:'正常<5.6°（健常者の95%が収まる範囲）',
      pct: Math.min(100, Math.abs(fm.pelvicTilt) / 10 * 100),
      sev: Math.abs(fm.pelvicTilt) < 5.6 ? 'good' : Math.abs(fm.pelvicTilt) < 8 ? 'warn' : 'bad',
    });
    const kneeDev = Math.max(fm.lKneeDev || 0, fm.rKneeDev || 0);
    list.push({
      name:'膝アライメント（HKA偏位）',
      value: kneeDev.toFixed(1) + '°',
      detail:'正常はほぼ直線。約6°以上でX脚/O脚傾向',
      pct: Math.min(100, kneeDev / 20 * 100),
      sev: kneeDev < CALIB.KNEE_GREY_DEG ? 'good' : kneeDev < 12 ? 'warn' : 'bad',
    });
  }

  return list;
}

export {
  LM,
  CALIB,
  SCREENING_DISCLAIMER,
  analyzeSide,
  analyzeFront,
  detectProblems,
  determinePostureType,
  calcScore,
  gradeFromScore,
  buildMetricsList,
};
