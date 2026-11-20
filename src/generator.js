/*
 * generator.js — procedural test assets with fully known ground truth.
 *
 * Every generated atlas is produced by real 3D ray casting (not by painting
 * a flat image and wrapping it on a sphere later), under the same explicit
 * stereo projection assumption the viewer will be configured with:
 *
 *   parallel-erp: two pinhole cameras offset by +/- ipd/2 on world X, each
 *                 rendering a full equirectangular face.
 *   ods:          N tangent cameras per eye on a ring of radius ipd/2, using
 *                 the exact origin/forward model mirrored by odsRemap() and
 *                 by the GLSL odsFaceUV() function.
 *
 * Ground-truth content:
 *   - graticule every 15 degrees (meridians/parallels), bold every 45
 *   - seam band at longitude +/-180 with alternating cyan/magenta stripes
 *   - north pole red square, south pole blue square (polar convergence test)
 *   - foreground spheres at documented 3D positions (stereo disparity test)
 *   - per-frame corner patches encoding the frame number + timestamp text,
 *     identical for both eyes (content-time consistency test)
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' ? module.exports : null);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PVGenerator = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  const P = (typeof module === 'object' && module.exports) ? require('./projection') : self.PV;
  const DEG = P.DEG;

  // Documented scene. All positions are world units; the head is at origin.
  const SCENE = {
    bgTop: [18, 26, 48],
    bgBottom: [6, 10, 22],
    graticuleColor: [90, 150, 220],
    graticuleBold: [180, 220, 255],
    seamA: [255, 0, 200],
    seamB: [0, 220, 255],
    poleN: [235, 70, 70],
    poleS: [70, 120, 235],
    spheres: [
      { name: 'near-front', c: [0.9, -0.1, 3.0], r: 0.32, color: [240, 190, 60] },
      { name: 'near-right', c: [2.6, 0.3, 1.2], r: 0.26, color: [120, 230, 130] },
      { name: 'near-left',  c: [-2.4, -0.4, -1.6], r: 0.24, color: [235, 120, 120] },
      { name: 'far-back',   c: [0.4, 0.2, -5.5], r: 0.55, color: [170, 130, 240] },
      { name: 'low-front',  c: [0.0, -1.6, 2.6], r: 0.22, color: [250, 150, 90] },
      { name: 'moving',     c: [0.0, 0.0, 3.4], r: 0.18, color: [255, 255, 255], moving: true }
    ],
    graticuleRadius: 40
  };

  function movingSphereAt(frame, fps) {
    const t = frame / fps;
    const R = 2.2;
    return { name: 'moving', c: [R * Math.sin(t * 0.6), 0.1, R * Math.cos(t * 0.6) + 1.2],
             r: 0.18, color: [255, 255, 255], moving: true };
  }

  function raySphere(origin, dir, sph) {
    const ox = origin[0] - sph.c[0], oy = origin[1] - sph.c[1], oz = origin[2] - sph.c[2];
    const b = ox * dir[0] + oy * dir[1] + oz * dir[2];
    const cc = ox * ox + oy * oy + oz * oz - sph.r * sph.r;
    const disc = b * b - cc;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    return t > 0 ? t : null;
  }

  // Lambert-shaded colour with a white rim ring so sphere edges are crisp.
  function shadeSphere(sph, hit, dir, depth) {
    const nx = (hit[0] - sph.c[0]) / sph.r;
    const ny = (hit[1] - sph.c[1]) / sph.r;
    const nz = (hit[2] - sph.c[2]) / sph.r;
    const light = Math.max(0, nx * 0.4 + ny * 0.8 + nz * 0.45) * 0.75 + 0.25;
    const rim = Math.max(0, 1 - Math.abs(nx * dir[0] + ny * dir[1] + nz * dir[2]));
    const k = rim > 0.92 ? 1.0 : light;
    const base = rim > 0.92 ? [255, 255, 255] : sph.color;
    return [base[0] * k, base[1] * k, base[2] * k, depth];
  }

  function graticuleShade(dir, sphereList, origin, frameSpheres) {
    // Distance-to-line test on the unit direction.
    const ll = P.dirToLonlat(dir);
    let col = null;
    const lonDeg = ((ll[0] / DEG) % 360 + 360) % 360;
    const latDeg = ll[1] / DEG;
    const lonLine = Math.abs(((lonDeg % 15) + 15) % 15);
    const latLine = Math.abs(((Math.abs(latDeg) % 15) + 15) % 15);
    const onMer = Math.min(lonLine, 15 - lonLine) * DEG * Math.cos(ll[1]);
    const onPar = Math.min(latLine, 15 - latLine) * DEG;
    const boldMer = Math.round(lonDeg / 45) * 45;
    const boldPar = Math.round(latDeg / 45) * 45;
    const isBoldMer = Math.abs(((lonDeg - boldMer + 540) % 360) - 180) * DEG * Math.cos(ll[1]) < 0.012;
    const isBoldPar = Math.abs(latDeg - boldPar) * DEG < 0.012;
    if (onMer < 0.006 || onPar < 0.006) col = isBoldMer || isBoldPar ? SCENE.graticuleBold : SCENE.graticuleColor;

    // Seam bands. The ERP longitude cut lives at +/-180 (u=0/1) and wraps;
    // it is painted with cyan/magenta stripes. A second, visually distinct
    // gold/black band marks the reference meridian lon=0 (u=0.5), which is
    // where yaw=0 looks, so turn-around tests have a known centre landmark.
    const seamDist = Math.abs(((lonDeg + 180) % 360 + 360) % 360 - 180);
    if (seamDist < 2.5) {
      const stripe = Math.floor((latDeg + 90) / 6) % 2;
      col = stripe ? SCENE.seamA : SCENE.seamB;
    }
    const refDist = Math.abs(((lonDeg + 360) % 360) - 0);
    if (refDist < 2.0) {
      const stripe = Math.floor((latDeg + 90) / 8) % 2;
      col = stripe ? [240, 200, 60] : [25, 20, 8];
    }
    // Pole markers: solid 4-degree caps.
    if (latDeg > 86) col = SCENE.poleN;
    if (latDeg < -86) col = SCENE.poleS;

    // Background vertical gradient.
    const g = P.clamp((dir[1] + 1) / 2, 0, 1);
    let out = [
      SCENE.bgBottom[0] + (SCENE.bgTop[0] - SCENE.bgBottom[0]) * g,
      SCENE.bgBottom[1] + (SCENE.bgTop[1] - SCENE.bgBottom[1]) * g,
      SCENE.bgBottom[2] + (SCENE.bgTop[2] - SCENE.bgBottom[2]) * g,
      SCENE.graticuleRadius
    ];
    if (col) out = [col[0], col[1], col[2], SCENE.graticuleRadius];

    let bestT = out[3];
    const all = frameSpheres ? sphereList.concat(frameSpheres) : sphereList;
    for (const sph of all) {
      const t = raySphere(origin, dir, sph);
      if (t !== null && t < bestT) {
        const hit = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
        const s = shadeSphere(sph, hit, dir, t);
        out = s;
        bestT = t;
      }
    }
    return [Math.round(P.clamp(out[0], 0, 255)), Math.round(P.clamp(out[1], 0, 255)), Math.round(P.clamp(out[2], 0, 255)), 255];
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  // Render one full ERP face (2:1) from a pinhole at `origin`, looking along
  // ERP azimuths. Used for both parallel-erp eyes and as the per-camera core
  // of the ODS mode.
  function renderErpFace(w, h, origin, spheres, frameSpheres, longitudeDir, latitudeDir) {
    const cv = makeCanvas(w, h);
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const v = (y + 0.5) / h;
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w;
        const dir = P.erpUVToDir(u, v, longitudeDir, latitudeDir);
        const px = graticuleShade(dir, spheres, origin, frameSpheres);
        const i = (y * w + x) * 4;
        img.data[i] = px[0]; img.data[i + 1] = px[1]; img.data[i + 2] = px[2]; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    drawErpLabels(ctx, w, h, longitudeDir, latitudeDir);
    return cv;
  }

  function drawErpLabels(ctx, w, h, longitudeDir, latitudeDir) {
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let lon = -180; lon < 180; lon += 45) {
      for (let lat = -60; lat <= 60; lat += 30) {
        const u = P.lonlatToFaceUV(lon * DEG, lat * DEG, longitudeDir, latitudeDir);
        const x = u[0] * w, y = u[1] * h;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(lon + ',' + lat, x, y);
      }
    }
  }

  // Render one ODS ERP face per pixel using the SAME tangent-camera model the
  // viewer inverts in PV.odsRemap / the GLSL odsFaceUV. For each output column
  // longitude thetaP we place the eye on its tangent ring origin and cast the
  // ray whose horizontal angle is beta within that tangent camera frame; the
  // stored world direction is reconstructed from (thetaP, beta, gamma) so the
  // inverse recovers exactly this texel. Foreground spheres use the real ring
  // origin (true per-eye parallax); the far-field background is shaded by
  // direction only, matching a direction-only ERP lookup.
  function renderOdsFace(w, h, eyeSign, ipd, cameraCount, spheres, frameSpheres, longitudeDir, latitudeDir) {
    const cv = makeCanvas(w, h);
    const ctx = cv.getContext('2d');
    const r = ipd / 2;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const gamma = (0.5 - (y + 0.5) / h) * Math.PI;
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w;
        const thetaP = (u - 0.5) * 2 * Math.PI;
        // Column thetaP stores the tangent-origin ray whose world azimuth is
        // phi = thetaP - s*pi/2 (the exact inverse of PV.odsRemap). The ring
        // origin provides the real per-eye parallax for foreground spheres.
        const origin = [eyeSign * r * (-Math.sin(thetaP)), 0, eyeSign * r * Math.cos(thetaP)];
        const phi = thetaP - eyeSign * Math.PI / 2;
        const dir = [Math.cos(gamma) * Math.sin(phi), Math.sin(gamma), Math.cos(gamma) * Math.cos(phi)];
        const px = graticuleShade(dir, spheres, origin, frameSpheres);
        const i = (y * w + x) * 4;
        img.data[i] = px[0]; img.data[i + 1] = px[1]; img.data[i + 2] = px[2]; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    drawErpLabels(ctx, w, h, longitudeDir, latitudeDir);
    return cv;
  }

  // Per-frame overlay: frame number encoded as binary corner patches plus a
  // readable timestamp. Drawn identically into both eye faces.
  function drawFrameStamp(faceCtx, w, h, frame, fps) {
    const bits = 12;
    const patch = Math.max(6, Math.round(w / 90));
    for (let b = 0; b < bits; b++) {
      const on = (frame >> b) & 1;
      faceCtx.fillStyle = on ? '#ffffff' : '#222222';
      faceCtx.fillRect(4 + b * (patch + 2), h - patch - 4, patch, patch);
    }
    faceCtx.fillStyle = '#ffe08a';
    faceCtx.font = 'bold ' + Math.round(h / 16) + 'px monospace';
    faceCtx.textAlign = 'left';
    faceCtx.textBaseline = 'top';
    const t = (frame / fps).toFixed(2);
    faceCtx.fillText('f=' + frame + ' t=' + t + 's', 6, 6);
    faceCtx.textAlign = 'right';
    faceCtx.fillText('LON +180/-180', w - 6, 6);
  }

  function composeAtlas(layout, faceL, faceR) {
    const fw = faceL.width, fh = faceL.height;
    const atlas = makeCanvas(layout === 'sbs' ? fw * 2 : fw, layout === 'sbs' ? fh : fh * 2);
    const ctx = atlas.getContext('2d');
    if (layout === 'sbs') {
      ctx.drawImage(faceL, 0, 0);
      ctx.drawImage(faceR, fw, 0);
      ctx.strokeStyle = '#ff00ff';
      ctx.beginPath(); ctx.moveTo(fw + 0.5, 0); ctx.lineTo(fw + 0.5, fh); ctx.stroke();
    } else {
      ctx.drawImage(faceL, 0, 0);
      ctx.drawImage(faceR, 0, fh);
      ctx.strokeStyle = '#ff00ff';
      ctx.beginPath(); ctx.moveTo(0, fh + 0.5); ctx.lineTo(fw, fh + 0.5); ctx.stroke();
    }
    return atlas;
  }

  function Generator(opts) {
    this.faceW = opts.faceW || 480;
    this.faceH = this.faceW / 2;
    this.layout = opts.layout || 'sbs';
    this.eyeOrder = opts.eyeOrder || 'LR';
    this.stereoMode = opts.stereoMode || 'parallel-erp';
    this.longitudeDir = opts.longitudeDir || 1;
    this.latitudeDir = opts.latitudeDir || 1;
    this.ipd = opts.ipd != null ? opts.ipd : 0.12;
    this.odsCameras = opts.odsCameras || 180;
    this.fps = opts.fps || 10;
    this._static = null;
  }

  Generator.prototype.scene = function () { return SCENE; };

  // Build the static (time-independent) faces once.
  Generator.prototype.buildStatic = function () {
    const w = this.faceW, h = this.faceH;
    const staticSpheres = SCENE.spheres.filter(s => !s.moving);
    let faceL, faceR;
    if (this.stereoMode === 'parallel-erp') {
      faceL = renderErpFace(w, h, [-this.ipd / 2, 0, 0], staticSpheres, null, this.longitudeDir, this.latitudeDir);
      faceR = renderErpFace(w, h, [this.ipd / 2, 0, 0], staticSpheres, null, this.longitudeDir, this.latitudeDir);
    } else {
      faceL = renderOdsFace(w, h, 1, this.ipd, this.odsCameras, staticSpheres, null, this.longitudeDir, this.latitudeDir);
      faceR = renderOdsFace(w, h, -1, this.ipd, this.odsCameras, staticSpheres, null, this.longitudeDir, this.latitudeDir);
    }
    this._static = { L: faceL, R: faceR };
    return this;
  };

  // Produce one synchronised frame: both eyes carry the identical frame
  // number and the same moving-sphere position, guaranteeing one content
  // time per frame across the two atlas halves.
  Generator.prototype.renderFrame = function (frame) {
    if (!this._static) this.buildStatic();
    const w = this.faceW, h = this.faceH;
    const moving = movingSphereAt(frame, this.fps);
    const stamp = (src) => {
      const c = makeCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.drawImage(src, 0, 0);
      // moving sphere overlay in ERP projection for this frame
      drawMovingErp(ctx, w, h, moving, this.longitudeDir, this.latitudeDir, this.stereoMode === 'parallel-erp' ? this.ipd / 2 : 0);
      drawFrameStamp(ctx, w, h, frame, this.fps);
      return c;
    };
    const faceL = stamp(this._static.L);
    const faceR = stamp(this._static.R);
    const ordered = this.eyeOrder === 'LR' ? [faceL, faceR] : [faceR, faceL];
    return composeAtlas(this.layout, ordered[0], ordered[1]);
  };

  // Cheap analytic overlay of the moving sphere onto an ERP face: project
  // the sphere centre, size its disc from angular radius (and parallax shift
  // in parallel-erp mode so the stereo geometry stays honest).
  function drawMovingErp(ctx, w, h, sph, longitudeDir, latitudeDir, eyeOffsetX) {
    const c = [sph.c[0] - eyeOffsetX, sph.c[1], sph.c[2]];
    const dist = Math.hypot(c[0], c[2]);
    const lon = Math.atan2(c[0], c[2]);
    const lat = Math.atan2(c[1], dist);
    const angR = Math.asin(P.clamp(sph.r / Math.hypot(c[0], c[1], c[2]), 0, 1));
    const uv = P.lonlatToFaceUV(lon, lat, longitudeDir, latitudeDir);
    const cx = uv[0] * w, cy = uv[1] * h;
    const rx = (angR / (2 * Math.PI)) * w;
    const ry = (angR / Math.PI) * h;
    // Handle seam crossing by drawing twice with wrapped x.
    for (const off of [0, -w, w]) {
      ctx.beginPath();
      ctx.ellipse(cx + off, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgb(255,255,255)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgb(20,20,20)';
      ctx.stroke();
    }
  }

  // Exposed for tests: exact static ray render of a single face.
  Generator.renderErpFace = renderErpFace;
  Generator.renderOdsFace = renderOdsFace;
  Generator.SCENE = SCENE;
  Generator.movingSphereAt = movingSphereAt;

  return { Generator, SCENE, movingSphereAt };
});
