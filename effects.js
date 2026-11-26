// PC 받는 화면에서 영상 효과를 처리한다 (아이폰에는 부담 없음).
// 효과가 모두 꺼져 있으면 원본 <video>를 그대로 보여 주고, 하나라도 켜지면 <canvas>에 그린다.
//
// 효과 설정(fx) 형식: { bg: 'none'|'blur'|'studio'|'dark'|'photo', light: 0|1|2, smooth: 0|1|2, rot: 0|90|180|270, flip: bool }

const PHONECAM_FX = (() => {
  const DEFAULT = { bg: 'none', light: 0, smooth: 0, rot: 0, flip: false, fit: 'contain' };
  const MP = 'vendor/mediapipe/';

  let video = null;
  let canvas = null;
  let ctx = null;
  let fx = { ...DEFAULT };
  let photo = null;          // 사용자가 보낸 배경 사진 (ImageBitmap)
  let segmenter = null;      // MediaPipe 사람 분리기
  let segLoading = null;
  let segFailed = false;
  let maskCanvas = null;     // 사람 영역(흰색) 마스크
  let maskCtx = null;
  let maskImage = null;
  let personCanvas = null;   // 사람만 오려 낸 층
  let personCtx = null;
  let smallCanvas = null;    // 분리용·흐림용 축소 화면 (큰 화면을 그대로 쓰면 느리다)
  let smallCtx = null;
  let softCanvas = null;     // 피부 보정용 흐린 사본 (절반 크기)
  let softCtx = null;
  let lastSegAt = 0;
  let frameCanvas = null;    // 회전·좌우 반전을 적용한 한 장면
  let frameCtx = null;
  let src = null;            // 이번 장면의 원본 (video 또는 frameCanvas)
  let haveMaskOnce = false;
  let running = false;
  let gen = 0;               // 그리기 반복의 세대 번호 (중복 실행 방지)
  let lastDrawAt = 0;
  let lastTs = -1;
  let fpsCount = 0;
  let fpsStart = 0;
  const stats = { fps: 0, segMs: 0, mode: 'off' };

  const oriented = () => fx.rot !== 0 || fx.flip;
  const active = () => fx.bg !== 'none' || fx.light > 0 || fx.smooth > 0 || oriented();
  const needsMask = () => fx.bg !== 'none' || fx.smooth > 0;

  function init(videoEl, canvasEl) {
    video = videoEl;
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    maskCanvas = document.createElement('canvas');
    maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
    personCanvas = document.createElement('canvas');
    personCtx = personCanvas.getContext('2d');
    smallCanvas = document.createElement('canvas');
    smallCtx = smallCanvas.getContext('2d');
    softCanvas = document.createElement('canvas');
    softCtx = softCanvas.getContext('2d');
    frameCanvas = document.createElement('canvas');
    frameCtx = frameCanvas.getContext('2d');
  }

  // 아이폰을 뒤집거나 눕혀 놓았을 때: 장면을 돌리고 필요하면 좌우를 뒤집는다
  function orient(vw, vh) {
    if (!oriented()) return { el: video, w: vw, h: vh };
    const side = fx.rot === 90 || fx.rot === 270;
    const w = side ? vh : vw, h = side ? vw : vh;
    sizeTo(frameCanvas, w, h);
    frameCtx.save();
    frameCtx.setTransform(1, 0, 0, 1, 0, 0);
    frameCtx.translate(w / 2, h / 2);
    if (fx.flip) frameCtx.scale(-1, 1);
    frameCtx.rotate((fx.rot * Math.PI) / 180);
    frameCtx.drawImage(video, -vw / 2, -vh / 2, vw, vh);
    frameCtx.restore();
    return { el: frameCanvas, w, h };
  }

  // 화면을 작게 줄인 사본 (분리 모델 입력과 배경 흐림에 같이 쓴다)
  function small(w, h) {
    const sw = 384, sh = Math.round((384 * h) / w);
    sizeTo(smallCanvas, sw, sh);
    smallCtx.drawImage(src, 0, 0, sw, sh);
    return smallCanvas;
  }

  async function loadSegmenter() {
    if (segmenter || segFailed) return segmenter;
    if (segLoading) return segLoading;
    segLoading = (async () => {
      try {
        const vision = await import('./' + MP + 'vision_bundle.mjs');
        const files = await vision.FilesetResolver.forVisionTasks(new URL(MP + 'wasm', location.href).toString());
        const make = (delegate) => vision.ImageSegmenter.createFromOptions(files, {
          baseOptions: { modelAssetPath: new URL(MP + 'selfie_segmenter.tflite', location.href).toString(), delegate },
          runningMode: 'VIDEO',
          outputCategoryMask: false,
          outputConfidenceMasks: true,
        });
        try { segmenter = await make('GPU'); } catch (e) { segmenter = await make('CPU'); }
      } catch (e) {
        console.warn('PhoneCam: 사람 분리 기능을 불러오지 못했습니다', e);
        segFailed = true;
      }
      return segmenter;
    })();
    return segLoading;
  }

  function set(newFx) {
    fx = { ...DEFAULT, ...(newFx || {}) };
    if (needsMask()) loadSegmenter();
    update();
  }

  async function setPhoto(blob) {
    try {
      const old = photo;
      photo = await createImageBitmap(blob);
      if (old && old.close) old.close();
      try { localStorage.setItem('phonecam.fxphoto', await blobToDataUrl(blob)); } catch (e) {}
    } catch (e) { photo = null; }
  }

  function blobToDataUrl(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  }

  async function restorePhoto() {
    try {
      const d = localStorage.getItem('phonecam.fxphoto');
      if (d) photo = await createImageBitmap(await (await fetch(d)).blob());
    } catch (e) {}
  }

  function update() {
    const on = active();
    document.body.classList.toggle('fx-on', on);
    stats.mode = on ? 'canvas' : 'off';
    if (on && !running) start();
  }

  function start() {
    running = true;
    const my = ++gen;
    lastDrawAt = performance.now();
    loop(my);
  }

  function loop(my) {
    if (my !== gen) return;
    if (!active()) { running = false; return; }
    try { drawFrame(); } catch (e) { console.warn(e); }
    lastDrawAt = performance.now();
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => loop(my));
    else requestAnimationFrame(() => loop(my));
  }

  // 영상이 끊겼다가 다시 들어오면 프레임 알림이 멈춰 있을 수 있어, 1초 넘게 멈추면 다시 시작한다
  setInterval(() => {
    if (running && active() && performance.now() - lastDrawAt > 1000) start();
  }, 1000);

  function sizeTo(c, w, h) { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } }

  function updateMask(w, h, input) {
    if (!segmenter) return false;
    // 분리가 느린 PC에서는 매 장면마다 하지 않고 직전 결과를 잠깐 다시 쓴다
    if (haveMaskOnce && stats.segMs > 12 && performance.now() - lastSegAt < stats.segMs * 1.5) return true;
    lastSegAt = performance.now();
    let ts = performance.now();
    if (ts <= lastTs) ts = lastTs + 1;
    lastTs = ts;
    const t0 = performance.now();
    const res = segmenter.segmentForVideo(input, ts);
    const m = res && res.confidenceMasks && res.confidenceMasks[0];
    if (!m) { res && res.close && res.close(); return false; }
    const mw = m.width, mh = m.height;
    const data = m.getAsFloat32Array();
    if (!maskImage || maskImage.width !== mw || maskImage.height !== mh) maskImage = new ImageData(mw, mh);
    const px = maskImage.data;
    for (let i = 0; i < data.length; i++) {
      const a = data[i] * 255;
      const j = i * 4;
      px[j] = 255; px[j + 1] = 255; px[j + 2] = 255; px[j + 3] = a;
    }
    res.close();
    sizeTo(maskCanvas, mw, mh);
    maskCtx.putImageData(maskImage, 0, 0);
    stats.segMs = Math.round((performance.now() - t0) * 10) / 10;
    haveMaskOnce = true;
    return true;
  }

  function drawCover(img, w, h) {
    const iw = img.width, ih = img.height;
    const s = Math.max(w / iw, h / ih);
    const dw = iw * s, dh = ih * s;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  function drawBackground(w, h) {
    ctx.save();
    if (fx.bg === 'blur' || (fx.bg === 'photo' && !photo)) { // 사진이 아직 없으면 흐림으로 대신
      // 축소 사본을 흐리게 해서 키운다: 전체 크기로 흐리는 것보다 훨씬 가볍고 결과는 비슷하다
      ctx.filter = 'blur(' + Math.round(smallCanvas.width / 90) + 'px)';
      ctx.drawImage(smallCanvas, 0, 0, w, h);
    } else if (fx.bg === 'studio') {
      const g = ctx.createRadialGradient(w * 0.5, h * 0.4, h * 0.1, w * 0.5, h * 0.5, w * 0.7);
      g.addColorStop(0, '#9aa3ad'); g.addColorStop(1, '#3b4148');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    } else if (fx.bg === 'dark') {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#1d2533'); g.addColorStop(1, '#0b0e14');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    } else if (fx.bg === 'photo' && photo) {
      drawCover(photo, w, h);
    } else {
      ctx.drawImage(src, 0, 0, w, h);
    }
    ctx.restore();
  }

  function lightFilter() {
    // 조명: 밝기·대비를 살짝 올리고 따뜻하게
    if (fx.light === 1) return 'brightness(1.15) contrast(1.05) saturate(1.05)';
    if (fx.light === 2) return 'brightness(1.32) contrast(1.08) saturate(1.08)';
    return 'none';
  }

  function drawPerson(w, h, haveMask) {
    sizeTo(personCanvas, w, h);
    personCtx.save();
    personCtx.clearRect(0, 0, w, h);
    personCtx.globalCompositeOperation = 'source-over';
    personCtx.filter = lightFilter();
    personCtx.drawImage(src, 0, 0, w, h);
    if (fx.smooth > 0) {
      // 피부 보정: 살짝 흐린 사본(절반 크기)을 겹쳐 잔주름·잡티를 부드럽게 (사람 영역에만)
      const hw = Math.round(w / 2), hh = Math.round(h / 2);
      sizeTo(softCanvas, hw, hh);
      softCtx.filter = 'blur(' + Math.max(1, Math.round(hw / 640)) + 'px)';
      softCtx.drawImage(src, 0, 0, hw, hh);
      personCtx.globalAlpha = fx.smooth === 1 ? 0.35 : 0.55;
      personCtx.filter = lightFilter();
      personCtx.drawImage(softCanvas, 0, 0, w, h);
      personCtx.globalAlpha = 1;
    }
    if (haveMask) {
      // 사람 영역만 남긴다. 가장자리를 약간 흐려 경계를 자연스럽게
      personCtx.filter = 'blur(' + Math.max(1, Math.round(w / 480)) + 'px)';
      personCtx.globalCompositeOperation = 'destination-in';
      personCtx.drawImage(maskCanvas, 0, 0, w, h);
    }
    personCtx.restore();
    ctx.drawImage(personCanvas, 0, 0, w, h);
  }

  function drawFrame() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const o = orient(vw, vh);
    src = o.el;
    const w = o.w, h = o.h;
    sizeTo(canvas, w, h);
    const segInput = needsMask() ? small(w, h) : null;
    const haveMask = needsMask() && updateMask(w, h, segInput);

    if (!haveMask) {
      // 마스크가 없으면(불러오는 중·실패) 화면 전체에 조명만 적용
      ctx.save();
      ctx.filter = lightFilter();
      ctx.drawImage(src, 0, 0, w, h);
      ctx.restore();
    } else {
      if (fx.bg === 'none') {
        // 배경은 원본 그대로, 사람에게만 조명·보정
        ctx.drawImage(src, 0, 0, w, h);
      } else {
        drawBackground(w, h);
      }
      drawPerson(w, h, true);
    }

    fpsCount++;
    const now = performance.now();
    if (now - fpsStart >= 1000) { stats.fps = Math.round((fpsCount * 1000) / (now - fpsStart)); fpsCount = 0; fpsStart = now; }
  }

  restorePhoto();
  return { init, set, setPhoto, stats, get fx() { return fx; }, get ready() { return !!segmenter; }, get failed() { return segFailed; } };
})();
