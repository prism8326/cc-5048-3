/*
 * app.js — UI wiring, explicit convention state, upload validation and the
 * render loop. All stereo/coordinate choices live in `state` and are shown
 * in the HUD; nothing is inferred by silently swapping eye textures.
 */
(function () {
  'use strict';
  const P = window.PV;
  const DEG = P.DEG;

  const canvas = document.getElementById('glcanvas');
  const renderer = new window.PVRenderer(canvas);
  const banner = document.getElementById('banner');
  const hud = document.getElementById('hud');
  const testOutput = document.getElementById('testOutput');

  const state = {
    source: 'generated',
    layout: 'sbs',
    eyeOrder: 'LR',
    longitudeDir: 1,
    latitudeDir: 1,
    stereoMode: 'parallel-erp',
    viewMode: 'stereo',
    vfov: 75 * DEG,
    yaw: 0, pitch: 0, roll: 0,
    ipd: 0.12,
    odsCameras: 180,
    degradedMono: false,
    warnings: []
  };

  let generator = new window.PVGenerator.Generator({
    layout: state.layout, eyeOrder: state.eyeOrder,
    stereoMode: state.stereoMode, longitudeDir: state.longitudeDir,
    latitudeDir: state.latitudeDir, ipd: state.ipd, odsCameras: state.odsCameras,
    faceW: 480, fps: 10
  });
  let player = new window.PVPlayer(generator, renderer);

  function showBanner(kind, text) {
    banner.className = 'banner show ' + kind;
    banner.textContent = text;
  }
  function clearBanner() { banner.className = 'banner'; banner.textContent = ''; }

  function regenerateGenerator() {
    generator = new window.PVGenerator.Generator({
      layout: state.layout, eyeOrder: state.eyeOrder,
      stereoMode: state.stereoMode, longitudeDir: state.longitudeDir,
      latitudeDir: state.latitudeDir, ipd: state.ipd, odsCameras: state.odsCameras,
      faceW: state.stereoMode === 'ods' ? 360 : 480, fps: 10
    });
    player.generator = generator;
    player.useGenerated();
    state.degradedMono = false;
    clearBanner();
  }

  function currentCfg() {
    return {
      layout: state.degradedMono ? 'mono' : state.layout,
      eyeOrder: state.eyeOrder,
      longitudeDir: state.longitudeDir,
      latitudeDir: state.latitudeDir,
      stereoMode: state.stereoMode,
      viewMode: state.degradedMono ? 'mono' : state.viewMode,
      vfov: state.vfov, yaw: state.yaw, pitch: state.pitch, roll: state.roll,
      ipd: state.ipd, odsCameras: state.odsCameras,
      mono: state.degradedMono
    };
  }

  function updateHud() {
    const deg = (r) => (r / DEG).toFixed(1) + '°';
    hud.textContent =
      `source=${state.source} layout=${state.layout} eyeOrder=${state.eyeOrder} ` +
      `lonDir=${state.longitudeDir > 0 ? '+X' : '-X'} latDir=${state.latitudeDir > 0 ? 'N@v0' : 'S@v0'} ` +
      `stereo=${state.stereoMode} view=${state.viewMode} | ` +
      `yaw=${deg(state.yaw)} pitch=${deg(state.pitch)} roll=${deg(state.roll)} fov=${deg(state.vfov)}` +
      (state.degradedMono ? '  [MONO DEGRADED]' : '');
  }

  // ------------------------------------------------------------- upload path
  function validateUpload(w, h) {
    const res = P.validateAtlas(w, h, state.layout);
    state.warnings = res.problems.slice();
    if (!res.ok && state.layout !== 'mono') {
      // Explicit, visible degradation: never guess the missing/wrong eye.
      state.degradedMono = true;
      showBanner('warn', '素材尺寸不符合声明的 ' + state.layout.toUpperCase() +
        ' 立体排列（' + res.problems.join('；') + '）。已明确降级为单眼模式，不会臆造另一只眼。');
    } else if (state.layout === 'mono') {
      state.degradedMono = true;
      showBanner('info', '单眼素材：仅渲染一个 ERP 面，不生成第二只眼。');
    } else {
      state.degradedMono = false;
      clearBanner();
    }
    return res;
  }

  function handleFile(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    if (file.type.startsWith('video/')) {
      const video = document.createElement('video');
      video.src = url; video.loop = true; video.muted = true; video.playsInline = true;
      video.crossOrigin = 'anonymous';
      video.addEventListener('loadedmetadata', () => {
        validateUpload(video.videoWidth, video.videoHeight);
        player.useVideo(video);
        state.source = 'video';
        video.play().catch(() => {});
      });
      video.addEventListener('error', () => showBanner('warn', '视频无法解码：缺眼/坏帧时保持上一帧并提示，而不会伪造内容。'));
    } else if (file.type.startsWith('image/')) {
      const img = new Image();
      img.onload = () => {
        validateUpload(img.naturalWidth, img.naturalHeight);
        player.useImage(img);
        state.source = 'image';
        URL.revokeObjectURL(url);
      };
      img.src = url;
    } else {
      showBanner('warn', '不支持的文件类型：' + file.type);
    }
  }

  // ------------------------------------------------------------------- events
  const $ = (id) => document.getElementById(id);
  $('layout').addEventListener('change', (e) => { state.layout = e.target.value; regenerateGenerator(); });
  $('eyeOrder').addEventListener('change', (e) => { state.eyeOrder = e.target.value; regenerateGenerator(); });
  $('longitudeDir').addEventListener('change', (e) => { state.longitudeDir = parseInt(e.target.value, 10); regenerateGenerator(); });
  $('latitudeDir').addEventListener('change', (e) => { state.latitudeDir = parseInt(e.target.value, 10); regenerateGenerator(); });
  $('stereoMode').addEventListener('change', (e) => { state.stereoMode = e.target.value; regenerateGenerator(); });

  document.querySelectorAll('button[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.viewMode = btn.dataset.view;
      document.querySelectorAll('button[data-view]').forEach(b => b.classList.toggle('active', b === btn));
      if (state.viewMode === 'mono') state.degradedMono = true;
      else if (state.source === 'generated' || state.warnings.length === 0) state.degradedMono = false;
    });
  });

  const bindSlider = (id, valId, key, degMode) => {
    $(id).addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      state[key] = degMode ? v * DEG : v;
      $(valId).textContent = v + (degMode ? '°' : '');
    });
  };
  bindSlider('vfov', 'vfovVal', 'vfov', true);
  bindSlider('yaw', 'yawVal', 'yaw', true);
  bindSlider('pitch', 'pitchVal', 'pitch', true);
  bindSlider('roll', 'rollVal', 'roll', true);

  // Drag to look around; Shift+drag adjusts roll; wheel changes FOV.
  let dragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (e.shiftKey) {
      state.roll = P.clamp(state.roll + dx * 0.4 * DEG, -45 * DEG, 45 * DEG);
      $('roll').value = (state.roll / DEG).toFixed(0); $('rollVal').textContent = $('roll').value + '°';
    } else {
      state.yaw = P.wrapPi(state.yaw + dx * 0.25 * DEG);
      state.pitch = P.clamp(state.pitch - dy * 0.25 * DEG, -89 * DEG, 89 * DEG);
      $('yaw').value = (state.yaw / DEG).toFixed(0); $('yawVal').textContent = $('yaw').value + '°';
      $('pitch').value = (state.pitch / DEG).toFixed(0); $('pitchVal').textContent = $('pitch').value + '°';
    }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.vfov = P.clamp(state.vfov + e.deltaY * 0.05 * DEG, 40 * DEG, 115 * DEG);
    $('vfov').value = (state.vfov / DEG).toFixed(0); $('vfovVal').textContent = $('vfov').value + '°';
  }, { passive: false });

  $('playBtn').addEventListener('click', () => {
    if (player.playing) { player.pause(); $('playBtn').textContent = '播放'; }
    else { player.play(); $('playBtn').textContent = '暂停'; }
  });
  $('stepFwd').addEventListener('click', () => { player.pause(); $('playBtn').textContent = '播放'; player.seek(player.frame + 1); });
  $('stepBack').addEventListener('click', () => { player.pause(); $('playBtn').textContent = '播放'; player.seek(player.frame - 1); });

  $('srcGen').addEventListener('click', () => { state.source = 'generated'; regenerateGenerator(); });
  $('srcImg').addEventListener('click', () => $('fileInput').click());
  $('srcVid').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => handleFile(e.target.files[0]));

  // --------------------------------------------------------------- self tests
  function renderResults(summaryObj) {
    testOutput.innerHTML = summaryObj.results.map(r =>
      `<div class="item ${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'} — ${r.name}${r.detail ? ' <span class="note">' + r.detail + '</span>' : ''}</div>`
    ).join('') + `<div class="item ${summaryObj.allPass ? 'pass' : 'fail'}">${summaryObj.pass}/${summaryObj.total} passed</div>`;
  }

  $('testCpu').addEventListener('click', () => {
    const st = window.PVSelftest;
    const list = st.cpuSuite();
    renderResults(st.summary(list));
  });

  $('testGpu').addEventListener('click', async () => {
    const st = window.PVSelftest;
    st.cpuSuite();
    const testGen = new window.PVGenerator.Generator({
      layout: 'sbs', eyeOrder: 'LR', stereoMode: state.stereoMode,
      longitudeDir: 1, latitudeDir: 1, ipd: state.ipd, odsCameras: state.odsCameras,
      faceW: state.stereoMode === 'ods' ? 360 : 480, fps: 10
    });
    const list = await st.gpuSuite({
      gl: renderer.gl, renderer, generator: testGen,
      W: canvas.width, H: canvas.height,
      makeFrame: (f) => testGen.renderFrame(f)
    });
    renderResults(st.summary(list));
  });

  // ---------------------------------------------------------------- render loop
  function frame(now) {
    const src = player.tick(now);
    if (src) {
      try { renderer.draw(currentCfg()); } catch (err) { showBanner('warn', '渲染错误: ' + err.message); }
    }
    $('frameVal').textContent = player.mode === 'video'
      ? (player.video ? player.video.currentTime.toFixed(2) + 's' : '—')
      : 'f=' + player.frame;
    updateHud();
    requestAnimationFrame(frame);
  }

  // Expose hooks for the headless GPU test runner.
  window.__PV = {
    get state() { return state; },
    renderer, get player() { return player; }, get generator() { return generator; },
    regenerate: regenerateGenerator,
    async runGpu(overrides) {
      const st = window.PVSelftest;
      st.cpuSuite();
      const g = new window.PVGenerator.Generator(Object.assign({
        layout: 'sbs', eyeOrder: 'LR', stereoMode: 'parallel-erp',
        longitudeDir: 1, latitudeDir: 1, ipd: 0.12, odsCameras: 180, faceW: 480, fps: 10
      }, overrides || {}));
      return st.summary(await st.gpuSuite({
        gl: renderer.gl, renderer,
        W: canvas.width, H: canvas.height,
        generator: g, makeFrame: (f) => g.renderFrame(f)
      }));
    },
    runCpu() { const st = window.PVSelftest; return st.summary(st.cpuSuite()); },
    // Switch the live application (state + UI control + regenerated asset) so
    // an on-screen capture actually shows the tested stereo convention.
    setStereoMode(mode) {
      state.stereoMode = mode;
      const sel = document.getElementById('stereoMode');
      sel.value = mode;
      regenerateGenerator();
    }
  };

  regenerateGenerator();
  requestAnimationFrame(frame);
})();
