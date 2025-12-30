// Mobile-first AR tracing app using camera + canvas overlay.
// Focuses on correctness, distortion-free overlay, and stable gestures.

(function () {
  const video = document.getElementById('cam');
  const canvas = document.getElementById('overlay');
  const ctx = canvas.getContext('2d');

  const cameraContainer = document.getElementById('cameraContainer');
  const landingScreen = document.getElementById('landingScreen');
  const landingSubtitle = document.getElementById('landingSubtitle');
  const landingPrimaryBtn = document.getElementById('landingPrimaryBtn');
  const fileInput = document.getElementById('fileInput');

  const controls = document.getElementById('controls');
  const zoomInBtn = document.getElementById('zoomInBtn');
  const zoomOutBtn = document.getElementById('zoomOutBtn');
  const lockBtn = document.getElementById('lockBtn');
  const resetBtn = document.getElementById('resetBtn');
  const changeImageBtn = document.getElementById('changeImageBtn');
  const hideUiBtn = document.getElementById('hideUiBtn');

  const brightnessSlider = document.getElementById('brightnessSlider');
  const contrastSlider = document.getElementById('contrastSlider');
  const opacitySlider = document.getElementById('opacitySlider');

  const uiHint = document.getElementById('uiHint');
  const messageEl = document.getElementById('message');
  const installHint = document.getElementById('installHint');
  const dismissInstallHint = document.getElementById('dismissInstallHint');

  // High-level state flags
  const appState = {
    hasImage: false,
    cameraActive: false,
    uiHidden: false,
  };

  // Single overlay transform state
  const overlayState = {
    scale: 1,
    x: 0,
    y: 0,
    rotation: 0, // kept at 0 for now (no rotation support)
    locked: false,
  };

  const filterState = {
    brightness: 1,
    contrast: 1,
    opacity: 0.7,
  };

  const fxState = {
    grayscale: false,
    invert: false,
  };

  // Canvas/rendering
  let dpr = window.devicePixelRatio || 1;
  let viewportWidth = 0;
  let viewportHeight = 0;
  let overlayImage = null;
  let overlayReady = false;
  let animationFrameId = null;
  const supportsFilter = 'filter' in ctx;

  // Gesture state
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  let panStartX = 0;
  let panStartY = 0;
  let overlayStartX = 0;
  let overlayStartY = 0;

  let pinchStartDistance = 0;
  let pinchStartScale = 1;
  let pinchStartCenterX = 0;
  let pinchStartCenterY = 0;
  let overlayStartXForPinch = 0;
  let overlayStartYForPinch = 0;

  // --- Utility ---

  function showMessage(text, duration = 1600) {
    if (!messageEl) return;
    messageEl.textContent = text;
    messageEl.classList.add('visible');
    if (duration > 0) {
      setTimeout(() => {
        messageEl.classList.remove('visible');
      }, duration);
    }
  }

  function vibrateShort() {
    if (navigator.vibrate) {
      navigator.vibrate(10);
    }
  }

  function setBodyState(stateName) {
    const body = document.body;
    body.classList.remove('landing', 'starting-camera', 'drawing-mode');
    body.classList.add(stateName);
  }

  // --- Canvas sizing & rendering ---

  function updateViewportSize() {
    viewportWidth = window.innerWidth;
    viewportHeight = window.innerHeight;
    dpr = window.devicePixelRatio || 1;
  }

  function resizeCanvas() {
    updateViewportSize();
    canvas.width = viewportWidth * dpr;
    canvas.height = viewportHeight * dpr;
    canvas.style.width = `${viewportWidth}px`;
    canvas.style.height = `${viewportHeight}px`;

    // Map logical canvas units (CSS pixels) to device pixels.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function getFilterString() {
    const parts = [
      `brightness(${filterState.brightness})`,
      `contrast(${filterState.contrast})`,
    ];
    if (fxState.grayscale) parts.push('grayscale(1)');
    if (fxState.invert) parts.push('invert(1)');
    return parts.join(' ');
  }

  function drawOverlay() {
    // Clear full canvas
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    if (!overlayReady || !overlayImage || !appState.hasImage) return;

    const imgW = overlayImage.naturalWidth;
    const imgH = overlayImage.naturalHeight;

    const drawW = imgW * overlayState.scale;
    const drawH = imgH * overlayState.scale;

    // overlayState.x / y are the center point in canvas logical coords
    const dx = overlayState.x - drawW / 2;
    const dy = overlayState.y - drawH / 2;

    ctx.save();

    if (supportsFilter) {
      ctx.filter = getFilterString();
    }
    ctx.globalAlpha = filterState.opacity;

    // NOTE: rotation left at 0 for now (align with spec, but keep field ready)
    if (overlayState.rotation !== 0) {
      ctx.translate(overlayState.x, overlayState.y);
      ctx.rotate((overlayState.rotation * Math.PI) / 180);
      ctx.drawImage(overlayImage, -drawW / 2, -drawH / 2, drawW, drawH);
    } else {
      ctx.drawImage(overlayImage, dx, dy, drawW, drawH);
    }

    ctx.restore();
  }

  function renderLoop() {
    drawOverlay();
    animationFrameId = window.requestAnimationFrame(renderLoop);
  }

  function startRenderLoop() {
    if (animationFrameId != null) return;
    animationFrameId = window.requestAnimationFrame(renderLoop);
  }

  function stopRenderLoop() {
    if (animationFrameId == null) return;
    window.cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  // --- Camera ---

  async function startCamera() {
    if (!appState.hasImage) {
      showMessage('Upload an image first.');
      return;
    }
    if (appState.cameraActive) return;

    setBodyState('starting-camera');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showMessage('Camera not supported in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
        },
        audio: false,
      });

      video.srcObject = stream;
      await video.play();

      appState.cameraActive = true;
      cameraContainer.hidden = false;

      // Sync canvas to viewport when camera is active
      resizeCanvas();
      enterDrawingMode();
    } catch (err) {
      console.error('Error accessing camera', err);
      showMessage('Unable to access camera. Check permissions.');
      setBodyState('starting-camera');
    }
  }

  function stopCamera() {
    const stream = video.srcObject;
    if (stream && typeof stream.getTracks === 'function') {
      stream.getTracks().forEach((track) => track.stop());
    }
    video.srcObject = null;
    appState.cameraActive = false;
    cameraContainer.hidden = true;
  }

  // --- App / UI states ---

  function resetOverlayTransform() {
    overlayState.scale = 1;
    overlayState.x = viewportWidth / 2;
    overlayState.y = viewportHeight / 2;
  }

  function resetFilters() {
    filterState.brightness = 1;
    filterState.contrast = 1;
    filterState.opacity = 0.7;
    fxState.grayscale = false;
    fxState.invert = false;

    brightnessSlider.value = '1';
    contrastSlider.value = '1';
    opacitySlider.value = '0.7';
  }

  function enterLandingMode() {
    stopCamera();
    overlayImage = null;
    overlayReady = false;
    appState.hasImage = false;
    appState.uiHidden = false;
    overlayState.locked = false;

    document.body.classList.remove('controls-hidden');
    setBodyState('landing');

    landingScreen.hidden = false;
    controls.hidden = true;

    // Reset UI elements
    landingSubtitle.textContent = 'Step 1: Upload a reference image to begin tracing.';
    landingPrimaryBtn.textContent = 'Upload Image';
    landingPrimaryBtn.disabled = false;
    uiHint.hidden = true;

    resetOverlayTransform();
    resetFilters();
  }

  function enterStartCameraMode() {
    setBodyState('starting-camera');
    landingSubtitle.textContent = 'Step 2: Start camera to begin tracing.';
    landingPrimaryBtn.textContent = 'Start Camera';
    landingPrimaryBtn.disabled = false;
  }

  function enterDrawingMode() {
    setBodyState('drawing-mode');
    landingScreen.hidden = true;
    controls.hidden = false;
    uiHint.hidden = true;
  }

  function toggleLock() {
    overlayState.locked = !overlayState.locked;
    lockBtn.setAttribute('aria-pressed', String(overlayState.locked));
    lockBtn.textContent = overlayState.locked ? 'Locked' : 'Lock';
    showMessage(overlayState.locked ? 'Overlay locked' : 'Overlay unlocked');
    vibrateShort();
  }

  function setUiHidden(hidden) {
    appState.uiHidden = hidden;
    if (hidden) {
      document.body.classList.add('controls-hidden');
      hideUiBtn.textContent = 'Show UI';
      hideUiBtn.setAttribute('aria-label', 'Show UI');
      uiHint.hidden = false;
    } else {
      document.body.classList.remove('controls-hidden');
      hideUiBtn.textContent = 'Hide UI';
      hideUiBtn.setAttribute('aria-label', 'Hide UI');
      uiHint.hidden = true;
    }
  }

  // --- Image loading & downscaling ---

  function createDownscaledImageIfNeeded(img) {
    const maxDim = 4096;
    const { naturalWidth: w, naturalHeight: h } = img;
    const largest = Math.max(w, h);

    if (largest <= maxDim) {
      return img;
    }

    const scale = maxDim / largest;
    const targetW = Math.round(w * scale);
    const targetH = Math.round(h * scale);

    const offscreen = document.createElement('canvas');
    offscreen.width = targetW;
    offscreen.height = targetH;
    const offCtx = offscreen.getContext('2d');
    offCtx.drawImage(img, 0, 0, targetW, targetH);

    const scaledImg = new Image();
    scaledImg.src = offscreen.toDataURL('image/jpeg', 0.9);
    return scaledImg;
  }

  function handleImageFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let finalImg = img;
        // Downscale very large images for mobile stability
        if (Math.max(img.naturalWidth, img.naturalHeight) > 4096) {
          finalImg = createDownscaledImageIfNeeded(img);
          // If we created a new image, ensure it's loaded
          if (finalImg !== img && !finalImg.complete) {
            finalImg.onload = () => {
              overlayImage = finalImg;
              overlayReady = true;
              appState.hasImage = true;
              resizeCanvas();
              resetOverlayTransform();
              resetFilters();
              drawOverlay();
              showMessage('Image loaded');
              enterStartCameraMode();
            };
            return;
          }
        }

        overlayImage = finalImg;
        overlayReady = true;
        appState.hasImage = true;
        resizeCanvas();
        resetOverlayTransform();
        resetFilters();
        drawOverlay();
        showMessage('Image loaded');
        enterStartCameraMode();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // --- Touch gestures (pinch, pan, double-tap) ---

  function handleTouchStart(e) {
    if (!overlayReady) return;

    if (appState.uiHidden) {
      // Any tap when hidden restores UI
      setUiHidden(false);
      return;
    }

    const touches = e.touches;
    if (touches.length === 1) {
      const t = touches[0];
      const x = t.clientX;
      const y = t.clientY;

      // Double-tap detection
      const now = Date.now();
      const dt = now - lastTapTime;
      const dx = x - lastTapX;
      const dy = y - lastTapY;
      const dist2 = dx * dx + dy * dy;
      if (dt < 300 && dist2 < 30 * 30) {
        // Double tap: reset transform
        resetOverlayTransform();
        showMessage('Reset view');
        lastTapTime = 0;
      } else {
        lastTapTime = now;
        lastTapX = x;
        lastTapY = y;
      }

      if (overlayState.locked) return;

      panStartX = x;
      panStartY = y;
      overlayStartX = overlayState.x;
      overlayStartY = overlayState.y;
    } else if (touches.length === 2) {
      if (overlayState.locked) return;

      const t0 = touches[0];
      const t1 = touches[1];
      const dx = t1.clientX - t0.clientX;
      const dy = t1.clientY - t0.clientY;
      pinchStartDistance = Math.hypot(dx, dy) || 1;

      pinchStartScale = overlayState.scale;

      pinchStartCenterX = (t0.clientX + t1.clientX) / 2;
      pinchStartCenterY = (t0.clientY + t1.clientY) / 2;

      overlayStartXForPinch = overlayState.x;
      overlayStartYForPinch = overlayState.y;
    }
  }

  function handleTouchMove(e) {
    if (!overlayReady || overlayState.locked) return;

    const touches = e.touches;
    if (touches.length === 1) {
      const t = touches[0];
      const x = t.clientX;
      const y = t.clientY;
      const dx = x - panStartX;
      const dy = y - panStartY;

      overlayState.x = overlayStartX + dx;
      overlayState.y = overlayStartY + dy;
      e.preventDefault();
    } else if (touches.length === 2) {
      const t0 = touches[0];
      const t1 = touches[1];
      const dx = t1.clientX - t0.clientX;
      const dy = t1.clientY - t0.clientY;
      const dist = Math.hypot(dx, dy) || 1;

      let newScale = (dist / pinchStartDistance) * pinchStartScale;
      newScale = Math.max(0.1, Math.min(8, newScale));

      const centerX = (t0.clientX + t1.clientX) / 2;
      const centerY = (t0.clientY + t1.clientY) / 2;

      // Keep pinch midpoint stable in image space
      const worldX = (centerX - overlayStartXForPinch) / pinchStartScale;
      const worldY = (centerY - overlayStartYForPinch) / pinchStartScale;

      overlayState.scale = newScale;
      overlayState.x = centerX - worldX * newScale;
      overlayState.y = centerY - worldY * newScale;

      e.preventDefault();
    }
  }

  function handleTouchEnd(e) {
    if (e.touches.length === 0) {
      pinchStartDistance = 0;
    }
  }

  // --- UI event wiring ---

  function initControls() {
    landingPrimaryBtn.addEventListener('click', () => {
      if (!appState.hasImage) {
        // Landing: upload
        fileInput.click();
      } else {
        // Start camera
        startCamera();
      }
    });

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      handleImageFile(file);
      // Hide upload UI (no more file picker on screen)
      fileInput.value = '';
    });

    zoomInBtn.addEventListener('click', () => {
      if (!overlayReady || overlayState.locked) return;
      const factor = 1.1;
      const newScale = overlayState.scale * factor;
      overlayState.scale = Math.min(8, newScale);
    });

    zoomOutBtn.addEventListener('click', () => {
      if (!overlayReady || overlayState.locked) return;
      const factor = 1 / 1.1;
      const newScale = overlayState.scale * factor;
      overlayState.scale = Math.max(0.1, newScale);
    });

    lockBtn.addEventListener('click', toggleLock);

    resetBtn.addEventListener('click', () => {
      resetOverlayTransform();
      showMessage('Reset view');
    });

    changeImageBtn.addEventListener('click', () => {
      stopCamera();
      enterLandingMode();
    });

    hideUiBtn.addEventListener('click', () => {
      setUiHidden(!appState.uiHidden);
    });

    brightnessSlider.addEventListener('input', () => {
      filterState.brightness = parseFloat(brightnessSlider.value);
    });

    contrastSlider.addEventListener('input', () => {
      filterState.contrast = parseFloat(contrastSlider.value);
    });

    opacitySlider.addEventListener('input', () => {
      filterState.opacity = parseFloat(opacitySlider.value);
    });

    // Canvas touch gestures
    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', handleTouchEnd, { passive: false });

    // Also allow tap anywhere to restore UI if hidden (safety net)
    canvas.addEventListener(
      'click',
      () => {
        if (appState.uiHidden) {
          setUiHidden(false);
        }
      },
      false,
    );

    window.addEventListener('resize', () => {
      if (!appState.cameraActive) return;
      resizeCanvas();
      resetOverlayTransform();
    });
    window.addEventListener('orientationchange', () => {
      if (!appState.cameraActive) return;
      resizeCanvas();
      resetOverlayTransform();
    });
  }

  // --- PWA / install hint ---

  function isStandaloneDisplayMode() {
    const mq = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    const iosStandalone = window.navigator.standalone === true;
    return mq || iosStandalone;
  }

  function initInstallHint() {
    if (!installHint || !dismissInstallHint) return;
    if (isStandaloneDisplayMode()) {
      installHint.hidden = true;
      return;
    }
    const dismissed = window.localStorage.getItem('a2hsHintDismissed') === 'true';
    if (!dismissed) {
      installHint.hidden = false;
    }
    dismissInstallHint.addEventListener('click', () => {
      installHint.hidden = true;
      window.localStorage.setItem('a2hsHintDismissed', 'true');
    });

    window.addEventListener('appinstalled', () => {
      window.localStorage.setItem('a2hsHintDismissed', 'true');
      installHint.hidden = true;
    });
  }

  function initServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('service-worker.js')
        .catch(() => {
          // Silent failure: app still works without offline support.
        });
    }
  }

  // --- Boot ---

  window.addEventListener('load', () => {
    enterLandingMode();
    initControls();
    initInstallHint();
    initServiceWorker();
    startRenderLoop();
  });
})();