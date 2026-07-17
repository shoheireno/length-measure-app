(() => {
  'use strict';

  const canvas = document.getElementById('photoCanvas');
  const ctx = canvas.getContext('2d');

  const emptyState = document.getElementById('emptyState');
  const measureView = document.getElementById('measureView');
  const statusBar = document.getElementById('statusBar');
  const measurementListEl = document.getElementById('measurementList');
  const undoBtn = document.getElementById('undoBtn');
  const resetBtn = document.getElementById('resetBtn');
  const changePhotoFab = document.getElementById('changePhotoFab');

  const cameraBtn = document.getElementById('cameraBtn');
  const galleryBtn = document.getElementById('galleryBtn');
  const cameraInput = document.getElementById('cameraInput');
  const galleryInput = document.getElementById('galleryInput');
  const changePhotoInput = document.getElementById('changePhotoInput');

  const calibDialog = document.getElementById('calibDialog');
  const calibValue = document.getElementById('calibValue');
  const calibUnit = document.getElementById('calibUnit');
  const calibCancel = document.getElementById('calibCancel');
  const calibOk = document.getElementById('calibOk');

  /** @type {HTMLImageElement|null} */
  let currentImage = null;
  let currentObjectUrl = null;

  // 校正・測定のすべての座標は「画像本来のピクセル座標系」で保持する
  let currentPoints = []; // 進行中のタップ（0〜1点）
  let calibP1 = null;
  let calibP2 = null;
  let calibRealValue = null;
  let pxPerUnit = null; // 1単位あたりのピクセル数
  let unit = 'cm';
  let measurements = []; // { p1, p2, pixelDistance, realDistance }

  let pendingCalibPoints = null; // ダイアログ表示中に保持する2点

  function isCalibrated() {
    return pxPerUnit !== null;
  }

  function resetMeasurementState() {
    currentPoints = [];
    calibP1 = null;
    calibP2 = null;
    calibRealValue = null;
    pxPerUnit = null;
    measurements = [];
    pendingCalibPoints = null;
  }

  function loadImageFile(file) {
    if (!file) return;
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);

    const url = URL.createObjectURL(file);
    currentObjectUrl = url;

    const img = new Image();
    img.onload = () => {
      currentImage = img;
      resetMeasurementState();

      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;

      emptyState.hidden = true;
      measureView.hidden = false;
      undoBtn.hidden = false;
      resetBtn.hidden = false;
      changePhotoFab.hidden = false;

      redraw();
      renderStatusBar();
      renderMeasurementList();
    };
    img.src = url;
  }

  [cameraInput, galleryInput, changePhotoInput].forEach((input) => {
    input.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      loadImageFile(file);
      input.value = '';
    });
  });

  // iOSのSafariでは <label> 経由での隠しinputクリックが伝わらないことがあるため、
  // ボタンのタップから明示的に input.click() を呼ぶ
  cameraBtn.addEventListener('click', () => cameraInput.click());
  galleryBtn.addEventListener('click', () => galleryInput.click());
  changePhotoFab.addEventListener('click', () => changePhotoInput.click());

  // ---- 描画 ----

  function redraw() {
    if (!currentImage) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(currentImage, 0, 0);

    if (calibP1 && calibP2) {
      const label = calibRealValue !== null
        ? `基準: ${formatNumber(calibRealValue)}${unit}`
        : '基準';
      drawLine(calibP1, calibP2, '#ffa000', label);
    }

    for (const m of measurements) {
      drawLine(m.p1, m.p2, '#e53935', `${formatNumber(m.realDistance)}${unit}`);
    }

    if (currentPoints.length > 0) {
      ctx.fillStyle = isCalibrated() ? '#e53935' : '#ffa000';
      for (const p of currentPoints) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, dotRadius(), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function dotRadius() {
    // 画像解像度に対して見やすい大きさになるよう、キャンバス実寸に応じてスケール
    return Math.max(6, canvas.width * 0.006);
  }

  function lineWidth() {
    return Math.max(2, canvas.width * 0.0025);
  }

  function fontSize() {
    return Math.max(14, canvas.width * 0.018);
  }

  function drawLine(p1, p2, color, label) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth();
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    ctx.fillStyle = color;
    const r = dotRadius();
    for (const p of [p1, p2]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.8, 0, Math.PI * 2);
      ctx.fill();
    }

    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;

    const fs = fontSize();
    ctx.font = `bold ${fs}px -apple-system, sans-serif`;
    const textWidth = ctx.measureText(label).width;
    const padX = fs * 0.4;
    const padY = fs * 0.3;

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(
      midX - textWidth / 2 - padX,
      midY - fs / 2 - padY,
      textWidth + padX * 2,
      fs + padY * 2
    );
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(label, midX, midY + fs * 0.05);
  }

  function formatNumber(value) {
    return value < 10 ? value.toFixed(2) : value.toFixed(1);
  }

  // ---- タップ処理 ----

  function getCanvasPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  canvas.addEventListener('click', (e) => {
    if (!currentImage) return;
    const p = getCanvasPoint(e.clientX, e.clientY);
    handleTap(p);
  });

  function handleTap(point) {
    currentPoints.push(point);
    redraw();

    if (currentPoints.length < 2) {
      renderStatusBar();
      return;
    }

    const p1 = currentPoints[0];
    const p2 = currentPoints[1];
    const pixelDistance = Math.hypot(p2.x - p1.x, p2.y - p1.y);

    if (pixelDistance < 1) {
      currentPoints = [];
      redraw();
      renderStatusBar();
      return;
    }

    if (!isCalibrated()) {
      pendingCalibPoints = { p1, p2, pixelDistance };
      openCalibDialog();
    } else {
      const realDistance = pixelDistance / pxPerUnit;
      measurements.push({ p1, p2, pixelDistance, realDistance });
      currentPoints = [];
      redraw();
      renderStatusBar();
      renderMeasurementList();
    }
  }

  // ---- 校正ダイアログ ----

  function openCalibDialog() {
    calibValue.value = '';
    calibUnit.value = unit;
    calibDialog.hidden = false;
    setTimeout(() => calibValue.focus(), 50);
  }

  function closeCalibDialog() {
    calibDialog.hidden = true;
  }

  calibCancel.addEventListener('click', () => {
    pendingCalibPoints = null;
    currentPoints = [];
    closeCalibDialog();
    redraw();
    renderStatusBar();
  });

  calibOk.addEventListener('click', () => {
    const value = parseFloat(calibValue.value);
    if (!value || value <= 0 || !pendingCalibPoints) return;

    unit = calibUnit.value;
    calibP1 = pendingCalibPoints.p1;
    calibP2 = pendingCalibPoints.p2;
    calibRealValue = value;
    pxPerUnit = pendingCalibPoints.pixelDistance / value;

    pendingCalibPoints = null;
    currentPoints = [];

    closeCalibDialog();
    redraw();
    renderStatusBar();
    renderMeasurementList();
  });

  // ---- ステータスバー ----

  function renderStatusBar() {
    let message;
    if (!isCalibrated()) {
      message = currentPoints.length === 0
        ? 'ステップ1: 実寸がわかる2点をタップ（例: 定規の0cmと10cm）'
        : '2点目をタップしてください';
      statusBar.classList.remove('calibrated');
    } else {
      message = currentPoints.length === 0
        ? `測定したい2点をタップ（基準: 1${unit} = ${pxPerUnit.toFixed(1)}px）`
        : '2点目をタップしてください';
      statusBar.classList.add('calibrated');
    }
    statusBar.textContent = message;
  }

  // ---- 測定リスト ----

  function renderMeasurementList() {
    measurementListEl.innerHTML = '';

    if (measurements.length === 0) {
      measurementListEl.hidden = true;
      return;
    }
    measurementListEl.hidden = false;

    measurements.forEach((m, index) => {
      const row = document.createElement('div');
      row.className = 'measurement-row';

      const badge = document.createElement('div');
      badge.className = 'measurement-badge';
      badge.textContent = String(index + 1);

      const value = document.createElement('div');
      value.className = 'measurement-value';
      value.textContent = `${m.realDistance.toFixed(2)} ${unit}`;

      const del = document.createElement('button');
      del.className = 'measurement-delete';
      del.textContent = '✕';
      del.addEventListener('click', () => {
        measurements.splice(index, 1);
        redraw();
        renderMeasurementList();
      });

      row.append(badge, value, del);
      measurementListEl.appendChild(row);
    });
  }

  // ---- 戻す / リセット ----

  undoBtn.addEventListener('click', () => {
    if (currentPoints.length > 0) {
      currentPoints = [];
    } else if (measurements.length > 0) {
      measurements.pop();
    } else if (isCalibrated()) {
      calibP1 = null;
      calibP2 = null;
      calibRealValue = null;
      pxPerUnit = null;
    }
    redraw();
    renderStatusBar();
    renderMeasurementList();
  });

  resetBtn.addEventListener('click', () => {
    resetMeasurementState();
    redraw();
    renderStatusBar();
    renderMeasurementList();
  });

  // 画面回転・リサイズ時にキャンバスの表示サイズが変わるので再描画（タップ座標変換に影響）
  window.addEventListener('resize', () => redraw());

  // ---- Service Worker（HTTPS/localhostのみ有効。オフラインキャッシュ用） ----
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {
        // 登録に失敗しても機能には影響しない
      });
    });
  }
})();
