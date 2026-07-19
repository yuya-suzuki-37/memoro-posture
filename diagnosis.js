// ===================================================================
// DIAGNOSIS ENGINE
//   画像読み込み(HEIC対応) → MediaPipe Pose検出 → analyzer.js で判定
//   問診・シニアフィルタは無し。写真だけで完結。
// ===================================================================

import {
  analyzeSide, analyzeFront, detectProblems,
  determinePostureType, calcScore, gradeFromScore, buildMetricsList,
  SCREENING_DISCLAIMER,
} from './analyzer.js?v=2';

// ---------- MediaPipe (動く構成を踏襲: tasks-vision@0.10.9 / IMAGE mode) ----------
let _landmarker = null;
async function loadLandmarker(onStatus){
  if (_landmarker) return _landmarker;
  onStatus && onStatus('姿勢解析エンジンを読み込んでいます…');
  const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9/vision_bundle.mjs');
  const fileset = await vision.FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9/wasm'
  );
  onStatus && onStatus('モデルを初期化中…');
  try {
    _landmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath:'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
        delegate:'GPU',
      },
      runningMode:'IMAGE', numPoses:1,
      minPoseDetectionConfidence:0.5, minPosePresenceConfidence:0.5, minTrackingConfidence:0.5,
    });
  } catch(e){
    // GPUが使えない端末向けにCPUで再試行
    _landmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath:'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
        delegate:'CPU',
      },
      runningMode:'IMAGE', numPoses:1,
    });
  }
  return _landmarker;
}

async function detectPose(image, onStatus){
  const lm = await loadLandmarker(onStatus);
  const result = lm.detect(image);
  if (!result.landmarks || result.landmarks.length === 0) return null;
  return result.landmarks[0]; // 33点
}

// ---------- 画像読み込み(File/Blob → HTMLImageElement) ----------
// HEIC(iPhone)は heic-to で JPEG に変換してから読み込む。
async function fileToImage(file, onStatus){
  let blob = file;
  const isHeic = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name || '');
  if (isHeic){
    onStatus && onStatus('iPhoneの写真(HEIC)を変換中…');
    try {
      const { heicTo } = await import('https://cdn.jsdelivr.net/npm/heic-to/+esm');
      blob = await heicTo({ blob:file, type:'image/jpeg', quality:0.92 });
    } catch(e){
      throw new Error('HEIC変換に失敗しました。写真アプリで「JPEG書き出し」してからお試しください。');
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImageEl(url);
    return img;
  } finally {
    // 描画に使うので即revokeしない。呼び出し側は img.src を保持。
  }
}

function loadImageEl(src){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした。'));
    img.src = src;
  });
}

// ---------- 診断メイン ----------
// imgs: { front:HTMLImageElement, side:HTMLImageElement }
// 戻り値: 結果オブジェクト(app.js の renderResult が消費)
async function runDiagnosis(imgs, onStatus){
  onStatus && onStatus('横向きの写真を解析中…');
  const lmsSide = await detectPose(imgs.side, onStatus);
  if (!lmsSide){
    return { error:'side', message:'横向きの写真から全身を検出できませんでした。頭から足先まで写った写真でお試しください。' };
  }
  const resultSide = analyzeSide(lmsSide);
  resultSide.image = imgs.side;
  resultSide.landmarksRaw = lmsSide;

  onStatus && onStatus('正面の写真を解析中…');
  const lmsFront = await detectPose(imgs.front, onStatus);
  if (!lmsFront){
    return { error:'front', message:'正面の写真から全身を検出できませんでした。頭から足先まで写った写真でお試しください。' };
  }
  const resultFront = analyzeFront(lmsFront);
  resultFront.image = imgs.front;
  resultFront.landmarksRaw = lmsFront;

  onStatus && onStatus('姿勢のタイプを判定中…');
  const problems = detectProblems(resultSide, resultFront);
  const type = determinePostureType(problems);
  const score = calcScore(resultSide, resultFront, problems);
  const grade = gradeFromScore(score);
  const metrics = buildMetricsList(resultSide, resultFront);

  return {
    ok:true,
    resultSide, resultFront,
    problems, type, score, grade, metrics,
    disclaimer: SCREENING_DISCLAIMER,
  };
}

export { runDiagnosis, fileToImage, loadImageEl };
