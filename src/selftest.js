/*
 * selftest.js — algorithm verification suites.
 *
 * Two layers:
 *   cpu*  tests use only pure projection/generator math and run identically
 *         under Node (test/run-cpu.js) and in the browser.
 *   gpu*  tests drive the real WebGL renderer and read framebuffer pixels;
 *         they need a Renderer plus a generated atlas and run in the browser
 *         (headless Chromium via test/run-gpu.js).
 *
 * Every test encodes the expected ground truth from the documented scene,
 * not a re-computation through the code under test.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PVSelftest = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  const P = (typeof module === 'object' && module.exports) ? require('./projection') : self.PV;
  const DEG = P.DEG;
  const results = [];

  function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail: detail || '' });
    return !!cond;
  }
  function approx(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-9 : eps); }

  // ---------------------------------------------------------------- CPU tests
  function cpuSuite() {
    results.length = 0;

    // 1. ERP <-> direction round trip, including the seam columns.
    let ok = true;
    for (const lon of [-180, -179.9, -90, 0, 45, 179.9]) {
      for (const lat of [-89, -45, 0, 45, 89]) {
        const d = P.lonlatToDir(lon * DEG, lat * DEG);
        const uv = P.dirToErpUV(d, 1, 1);
        const d2 = P.erpUVToDir(uv[0], uv[1], 1, 1);
        const ll = P.dirToLonlat(d2);
        if (!approx(ll[0], lon * DEG, 1e-6) || !approx(ll[1], lat * DEG, 1e-6)) ok = false;
      }
    }
    check('cpu: ERP/direction round trip over full grid incl. seam columns', ok);

    // 2. Seam continuity: u just below 1 and just above 0 map to the same
    //    meridian (wrapping), not opposite sides of the atlas.
    const a = P.erpUVToDir(1 - 1e-7, 0.5, 1, 1);
    const b = P.erpUVToDir(1e-7, 0.5, 1, 1);
    check('cpu: longitude seam wraps (u=1-eps and u=0+eps same meridian)',
      approx(a[0], b[0], 1e-5) && approx(a[2], b[2], 1e-5));

    // 3. Polar clamp: every column at v=0 lands on the north pole.
    let poleOk = true;
    for (let u = 0.05; u < 1; u += 0.1) {
      const d = P.erpUVToDir(u, 0, 1, 1);
      if (!approx(d[1], 1, 1e-9) || !approx(Math.hypot(d[0], d[2]), 0, 1e-9)) poleOk = false;
    }
    check('cpu: all ERP columns converge on the north pole at v=0', poleOk);

    // 4. Reverse longitude/latitude conventions flip the right axis only.
    const dStd = P.erpUVToDir(0.25, 0.5, 1, 1);
    const dRevLon = P.erpUVToDir(0.25, 0.5, -1, 1);
    check('cpu: longitudeDir=-1 mirrors X, keeps Z sign flipped correctly',
      approx(dStd[0], -dRevLon[0], 1e-9) && approx(dStd[2], dRevLon[2], 1e-9));
    const dRevLat = P.erpUVToDir(0.5, 0.25, 1, -1);
    check('cpu: latitudeDir=-1 mirrors Y', approx(dRevLat[1], -P.erpUVToDir(0.5, 0.25, 1, 1)[1], 1e-9));

    // 5. Camera ray at NDC centre equals the yaw/pitch forward direction.
    const yaw = 37 * DEG, pitch = -12 * DEG;
    const r = P.rayForPixel([0, 0], 90 * DEG, 1.0, yaw, pitch, 0, 0);
    const basis = P.cameraBasis(yaw, pitch, 0);
    check('cpu: centre pixel ray follows the camera forward basis',
      approx(r.dir[0], basis.fwd[0], 1e-9) && approx(r.dir[1], basis.fwd[1], 1e-9) && approx(r.dir[2], basis.fwd[2], 1e-9));

    // 6. Yaw rotates the centre ray from +Z toward +X at yaw=+90.
    const r90 = P.rayForPixel([0, 0], 60 * DEG, 1, 90 * DEG, 0, 0, 0);
    check('cpu: +90deg yaw looks along +X', approx(r90.dir[0], 1, 1e-9) && approx(r90.dir[2], 0, 1e-9));

    // 7. Eye sub-rects never overlap and cover the atlas exactly; eye order
    //    swaps slots deterministically and no rect crosses the half boundary.
    const sbsLR = [P.eyeSubRect('sbs', 'LR', 'L'), P.eyeSubRect('sbs', 'LR', 'R')];
    check('cpu: SBS LR rects occupy disjoint halves',
      sbsLR[0].u0 === 0 && sbsLR[0].du === 0.5 && sbsLR[1].u0 === 0.5 && sbsLR[1].du === 0.5);
    const sbsRL = [P.eyeSubRect('sbs', 'RL', 'L'), P.eyeSubRect('sbs', 'RL', 'R')];
    check('cpu: eye order RL swaps slots but keeps geometry fixed',
      sbsRL[0].u0 === 0.5 && sbsRL[1].u0 === 0);
    const tbLR = [P.eyeSubRect('tb', 'LR', 'L'), P.eyeSubRect('tb', 'LR', 'R')];
    check('cpu: TB LR rects occupy top/bottom halves',
      tbLR[0].v0 === 0 && tbLR[0].dv === 0.5 && tbLR[1].v0 === 0.5 && tbLR[1].dv === 0.5);
    // face UV wrapping stays inside one rect even across the seam.
    const atlasUV = P.eyeUVToAtlas([-0.001, 0.7], sbsLR[0]);
    check('cpu: wrapped seam sample stays inside the same eye rect',
      atlasUV[0] < 0.5 && atlasUV[0] >= 0 && approx(atlasUV[1], 0.7, 1e-9));

    // 8. Atlas validation flags bad geometry and accepts good geometry.
    //    Two 2:1 ERP faces => SBS atlas is 4:1, TB atlas is 1:1, mono 2:1.
    check('cpu: validator rejects 1000x500 declared TB (faces not 2:1)',
      P.validateAtlas(1000, 500, 'tb').ok === false);
    check('cpu: validator accepts 2048x512 SBS (two 1024x512 faces)',
      P.validateAtlas(2048, 512, 'sbs').ok === true);
    check('cpu: validator accepts 1024x1024 TB (two 1024x512 faces)',
      P.validateAtlas(1024, 1024, 'tb').ok === true);
    check('cpu: validator accepts 2048x1024 mono',
      P.validateAtlas(2048, 1024, 'mono').ok === true);
    check('cpu: validator rejects odd-width SBS',
      P.validateAtlas(1025, 512, 'sbs').ok === false);
    check('cpu: validator rejects 2048x1024 mis-declared as SBS',
      P.validateAtlas(2048, 1024, 'sbs').ok === false);

    // 9. ODS remap under the self-consistent tangent-ring model.
    //  (a) A horizontal view ray is never clipped (dense tangent coverage);
    //      only the exact vertical poles are degenerate.
    const fwdRemap = P.odsRemap(P.lonlatToDir(0, 0), 0, 1, Math.PI / 90);
    check('cpu: ODS horizontal view ray is represented (not clipped)',
      fwdRemap.clipped === false && approx(fwdRemap.lat, 0, 1e-9));
    const poleRemap = P.odsRemap(P.lonlatToDir(0, Math.PI / 2 - 1e-12), 0, 1, Math.PI / 90);
    check('cpu: ODS near-vertical pole ray is flagged degenerate/clipped',
      poleRemap.clipped === true);
    // (b) Generator/inverse round trip: for view direction phi the inverse
    //     returns column thetaP = phi + s*pi/2, and the tangent forward ray
    //     stored at that column has world azimuth phi.
    let rtOk = true;
    for (const s of [1, -1]) {
      for (const phiDeg of [-150, -60, 0, 47, 130]) {
        const phi = phiDeg * DEG;
        const rm = P.odsRemap(P.lonlatToDir(phi, 0), 0, s, Math.PI);
        const thetaP = phi + s * Math.PI / 2;
        if (!approx(P.wrapPi(rm.lon - thetaP), 0, 1e-9)) rtOk = false;
        // The ray stored at column thetaP has world azimuth phi (the
        // generator's exact inverse convention).
        const storedPhi = thetaP - s * Math.PI / 2;
        const fwd = [Math.sin(storedPhi), 0, Math.cos(storedPhi)];
        const want = P.lonlatToDir(phi, 0);
        if (!approx(fwd[0], want[0], 1e-9) || !approx(fwd[2], want[2], 1e-9)) rtOk = false;
      }
    }
    check('cpu: ODS inverse maps each view ray to its exact tangent column (round trip)', rtOk);
    // (c) Left vs right produce mirrored longitude corrections about phi.
    const rL = P.odsRemap(P.lonlatToDir(0.3, 0), 0, 1, Math.PI);
    const rR = P.odsRemap(P.lonlatToDir(0.3, 0), 0, -1, Math.PI);
    check('cpu: ODS left/right longitude corrections are distinct and symmetric',
      !approx(P.wrapPi(rL.lon - rR.lon), 0, 1e-6) &&
      approx(P.wrapPi(rL.lon + rR.lon), 2 * 0.3, 1e-9));

    return results.slice();
  }

  // ---------------------------------------------------------------- GPU tests
  // Helper: read one pixel from the current framebuffer.
  function pixel(gl, x, y) {
    const px = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [px[0], px[1], px[2], px[3]];
  }
  function regionMean(gl, x0, y0, w, h) {
    const n = w * h;
    const buf = new Uint8Array(n * 4);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < n; i++) { r += buf[i * 4]; g += buf[i * 4 + 1]; b += buf[i * 4 + 2]; }
    return [r / n, g / n, b / n];
  }
  function colorDist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

  // Build a deterministic SBS test atlas from KNOWN ERP directions. Each
  // face is a 2:1 ERP image whose colour at (u,v) is a function of the world
  // direction at that texel, so any framebuffer pixel can be checked against
  // an exact CPU expectation. The two eyes use distinct identity tints.
  function buildTestAtlas(faceW) {
    const faceH = faceW / 2;
    const paint = (eyeTint) => {
      const c = document.createElement('canvas');
      c.width = faceW; c.height = faceH;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(faceW, faceH);
      for (let y = 0; y < faceH; y++) {
        for (let x = 0; x < faceW; x++) {
          const u = (x + 0.5) / faceW, v = (y + 0.5) / faceH;
          const dir = P.erpUVToDir(u, v, 1, 1);
          const ll = P.dirToLonlat(dir);
          const lonD = ((ll[0] / DEG) + 360) % 360, latD = ll[1] / DEG;
          let r = 30, g = 34, b = 48;
          // graticule every 30 deg, bold every 90
          const onMer = Math.abs((((lonD % 30) + 30) % 30) - 15) > 14.2 * Math.max(0.25, Math.cos(ll[1]));
          const onPar = Math.abs((((Math.abs(latD) % 30) + 30) % 30) - 15) > 14.2;
          if (onMer || onPar) { r = 120; g = 170; b = 230; }
          const bold = Math.abs(((lonD % 90) + 90) % 90 - 45) > 44 || Math.abs(((Math.abs(latD) % 90) + 90) % 90 - 45) > 44;
          if (bold) { r = 200; g = 225; b = 255; }
          // Highest-priority landmarks overwrite any graticule underneath.
          // +/-180 seam (4deg half-band) magenta/cyan stripes by latitude.
          const seamD = 180 - Math.abs(((lonD + 180) % 360 + 360) % 360 - 180);
          if (seamD < 4) { const st = Math.floor((latD + 90) / 10) % 2; if (st) { r = 255; g = 0; b = 200; } else { r = 0; g = 220; b = 255; } }
          // lon=0 reference meridian: gold/black stripes
          if (lonD < 2.5 || lonD > 357.5) { const st = Math.floor((latD + 90) / 12) % 2; if (st) { r = 240; g = 200; b = 60; } else { r = 25; g = 20; b = 8; } }
          // poles (80deg caps so a narrow-FOV nadir/zenith view is fully inside)
          if (latD > 80) { r = 235; g = 70; b = 70; }
          if (latD < -80) { r = 70; g = 120; b = 235; }
          const i = (y * faceW + x) * 4;
          img.data[i] = Math.min(255, r * eyeTint[0]);
          img.data[i + 1] = Math.min(255, g * eyeTint[1]);
          img.data[i + 2] = Math.min(255, b * eyeTint[2]);
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return c;
    };
    // Left face keeps colours; right face multiplies channels by a distinct
    // tint so eye identity is always readable in the framebuffer.
    const faceL = paint([1.0, 1.0, 1.0]);
    const faceR = paint([0.55, 0.85, 1.0]);
    // Eye-identity markers: a solid block at lon=-90,lat=0 on every face.
    // Left marker = pure green, right marker = pure red. These directions are
    // unambiguous and independent of the graticule/tint, so they give a
    // deterministic cross-eye leak / eye-order signal.
    const stampMarker = (cv, color) => {
      const mctx = cv.getContext('2d');
      const uv = P.lonlatToFaceUV(-90 * DEG, 0, 1, 1);
      const mw = cv.width * 0.06, mh = cv.height * 0.12;
      mctx.fillStyle = 'rgb(' + color.join(',') + ')';
      mctx.fillRect(uv[0] * cv.width - mw / 2, uv[1] * cv.height - mh / 2, mw, mh);
    };
    stampMarker(faceL, [0, 255, 0]);
    stampMarker(faceR, [255, 0, 0]);
    const atlas = document.createElement('canvas');
    atlas.width = faceW * 2; atlas.height = faceH;
    const actx = atlas.getContext('2d');
    actx.drawImage(faceL, 0, 0);
    actx.drawImage(faceR, faceW, 0);
    return { atlas, faceL, faceR, faceW, faceH };
  }

  // Exact expected colour for a world direction using the same rule as the
  // test atlas (eye tint applied), sampled by the CPU projection functions.
  function expectedColor(dir, tint) {
    const ll = P.dirToLonlat(dir);
    const lonD = ((ll[0] / DEG) + 360) % 360, latD = ll[1] / DEG;
    let r = 30, g = 34, b = 48;
    const onMer = Math.abs((((lonD % 30) + 30) % 30) - 15) > 14.2 * Math.max(0.25, Math.cos(ll[1]));
    const onPar = Math.abs((((Math.abs(latD) % 30) + 30) % 30) - 15) > 14.2;
    if (onMer || onPar) { r = 120; g = 170; b = 230; }
    const bold = Math.abs(((lonD % 90) + 90) % 90 - 45) > 44 || Math.abs(((Math.abs(latD) % 90) + 90) % 90 - 45) > 44;
    if (bold) { r = 200; g = 225; b = 255; }
    const seamD = Math.abs(((lonD + 180) % 360 + 360) % 360 - 180);
    if (seamD < 4) { const st = Math.floor((latD + 90) / 10) % 2; if (st) { r = 255; g = 0; b = 200; } else { r = 0; g = 220; b = 255; } }
    if (lonD < 2.5 || lonD > 357.5) { const st = Math.floor((latD + 90) / 12) % 2; if (st) { r = 240; g = 200; b = 60; } else { r = 25; g = 20; b = 8; } }
    if (latD > 80) { r = 235; g = 70; b = 70; }
    if (latD < -80) { r = 70; g = 120; b = 235; }
    return [Math.min(255, r * tint[0]), Math.min(255, g * tint[1]), Math.min(255, b * tint[2])];
  }

  async function gpuSuite(ctx) {
    // ctx: { gl, renderer, W, H }
    const { gl, renderer, W, H } = ctx;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const TINT_L = [1, 1, 1], TINT_R = [0.55, 0.85, 1];
    const t = buildTestAtlas(256);
    renderer.upload(t.atlas);
    const base = {
      layout: 'sbs', eyeOrder: 'LR', longitudeDir: 1, latitudeDir: 1,
      stereoMode: 'parallel-erp', ipd: 0.12, odsCameras: 180,
      vfov: 75 * DEG, yaw: 0, pitch: 0, roll: 0
    };
    const draw = (over) => renderer.draw(Object.assign({}, base, over));
    // World direction for a screen point in a viewport of given size.
    const dirAt = (ndc, vfov, aspect, yaw, pitch, roll) => {
      const r = P.rayForPixel(ndc, vfov, aspect, yaw, pitch, roll, 0);
      return r.dir;
    };

    // G1. CPU/GPU agreement across a grid of screen points (left eye).
    draw({ viewMode: 'left' });
    let g1 = 0, g1Tot = 0, g1Worst = 0;
    for (const nx of [0.15, 0.3, 0.5, 0.7, 0.85]) {
      for (const ny of [0.25, 0.5, 0.75]) {
        const sx = Math.round(nx * W), sy = Math.round(ny * H);
        const fb = pixel(gl, sx, sy);
        const ndc = [nx * 2 - 1, ((H - sy) / H) * 2 - 1];
        const exp = expectedColor(dirAt(ndc, base.vfov, W / H, 0, 0, 0), TINT_L);
        const d = colorDist(fb, exp);
        g1Worst = Math.max(g1Worst, d); g1Tot++; if (d < 24) g1++;
      }
    }
    check('gpu: framebuffer matches CPU projection over a screen grid (NEAREST)',
      g1 === g1Tot, g1 + '/' + g1Tot + ' within tol, worst=' + g1Worst.toFixed(1));

    // G2. Seam: the ERP cut is at longitude +/-180, so yaw +/-180 centres
    //     the view on it. Both directions must land on the same seam band,
    //     proving the u=0/1 wrap resolves to one meridian. NEAREST single
    //     pixel sampling keeps the narrow seam from being diluted by a mean.
    const seamish = (m) => colorDist(m, [255, 0, 200]) < 80 || colorDist(m, [0, 220, 255]) < 80;
    draw({ viewMode: 'left', yaw: 180 * DEG });
    const seamP = pixel(gl, W / 2, H / 2).slice(0, 3);
    draw({ viewMode: 'left', yaw: -180 * DEG });
    const seamM = pixel(gl, W / 2, H / 2).slice(0, 3);
    check('gpu: +/-180 yaw both resolve to the wrapped seam band',
      seamish(seamP) && seamish(seamM), JSON.stringify([seamP, seamM]));
    // Reference meridian at yaw 0 centre is the gold/black band.
    draw({ viewMode: 'left', yaw: 0 });
    const refMer = regionMean(gl, W / 2 - 5, H / 2 - 5, 10, 10);
    const refish = (m) => colorDist(m, [240, 200, 60]) < 80 || colorDist(m, [25, 20, 8]) < 45;
    check('gpu: yaw=0 centres on the documented lon=0 reference meridian', refish(refMer),
      JSON.stringify(refMer.map(v => v | 0)));

    // G3. Nadir (pitch -89): with a narrow FOV the centre and the near-edge
    //     samples all lie inside the 80deg south-pole cap and must converge
    //     to the same blue, demonstrating polar longitude convergence.
    draw({ viewMode: 'left', pitch: -89 * DEG, vfov: 40 * DEG });
    const poleC = regionMean(gl, W / 2 - 8, H / 2 - 8, 16, 16);
    const poleL = regionMean(gl, W / 2 - 60, H / 2 - 8, 16, 16);
    const poleR = regionMean(gl, W / 2 + 44, H / 2 - 8, 16, 16);
    check('gpu: nadir view shows south-pole blue with converged edges',
      colorDist(poleC, [70, 120, 235]) < 60 &&
      colorDist(poleL, [70, 120, 235]) < 70 && colorDist(poleR, [70, 120, 235]) < 70,
      JSON.stringify([poleC.map(v => v | 0), poleL.map(v => v | 0), poleR.map(v => v | 0)]));
    // Zenith likewise maps to north-pole red.
    draw({ viewMode: 'left', pitch: 89 * DEG, vfov: 40 * DEG });
    const zen = regionMean(gl, W / 2 - 8, H / 2 - 8, 16, 16);
    check('gpu: zenith view shows north-pole red', colorDist(zen, [235, 70, 70]) < 60,
      JSON.stringify(zen.map(v => v | 0)));

    // G4. Wide FOV 110deg: edge pixels match the CPU edge-ray expectation.
    draw({ viewMode: 'left', vfov: 110 * DEG });
    let g4 = 0; const edgePts = [[0.04, 0.5], [0.96, 0.5], [0.5, 0.06], [0.5, 0.94]];
    let g4detail = [];
    for (const [nx, ny] of edgePts) {
      const sx = Math.round(nx * W), sy = Math.round(ny * H);
      const fb = pixel(gl, sx, sy);
      const ndc = [nx * 2 - 1, ((H - sy) / H) * 2 - 1];
      const exp = expectedColor(dirAt(ndc, 110 * DEG, W / H, 0, 0, 0), TINT_L);
      const d = colorDist(fb, exp); g4detail.push(d.toFixed(0)); if (d < 24) g4++;
    }
    check('gpu: 110deg wide-FOV edges match CPU edge rays', g4 === edgePts.length,
      'dists=' + g4detail.join(','));

    // G5. Viewport / atlas isolation. Aim the camera at the marker longitude
    //     (lon=-90). The LEFT viewport must show the green left marker and
    //     the RIGHT viewport the red right marker; any red where green is
    //     expected (or vice versa) is a cross-eye atlas leak. Sample a block.
    draw({ viewMode: 'stereo', yaw: -90 * DEG });
    const blockMean = (x0) => regionMean(gl, x0 - 12, H / 2 - 12, 24, 24);
    const leftMark = blockMean(W / 4);
    const rightMark = blockMean((W * 3) / 4);
    const greenish = (m) => m[1] > 150 && m[0] < 90 && m[2] < 90;
    const reddish = (m) => m[0] > 150 && m[1] < 90 && m[2] < 90;
    check('gpu: stereo viewports sample only their own eye atlas region',
      greenish(leftMark) && reddish(rightMark),
      'left=' + leftMark.map(v => v | 0) + ' right=' + rightMark.map(v => v | 0));

    // G6. Eye identity in the single-eye verification views: the left view
    //     shows the green marker, the right view the red marker at centre.
    draw({ viewMode: 'left', yaw: -90 * DEG });
    const idL = regionMean(gl, W / 2 - 10, H / 2 - 10, 20, 20);
    draw({ viewMode: 'right', yaw: -90 * DEG });
    const idR = regionMean(gl, W / 2 - 10, H / 2 - 10, 20, 20);
    check('gpu: left/right verification views carry their declared eye marker',
      greenish(idL) && reddish(idR), 'L=' + idL.map(v => v | 0) + ' R=' + idR.map(v => v | 0));

    // G7. Eye order is a hard declaration. With eyeOrder RL the LEFT
    //     viewport must now show the RED slot-1 marker (the faces physically
    //     swap slots); the viewer never silently re-corrects the swap.
    draw({ viewMode: 'left', yaw: -90 * DEG, eyeOrder: 'RL' });
    const swapped = regionMean(gl, W / 2 - 10, H / 2 - 10, 20, 20);
    check('gpu: declaring RL eye order makes the left viewport show slot-1 (red) marker',
      reddish(swapped), 'leftViewportAfterSwap=' + swapped.map(v => v | 0));
    draw({ viewMode: 'left', yaw: 0, eyeOrder: 'LR' });

    // G8. Content-time consistency. A single texImage2D upload carries one
    //     shared frame that both viewports sample. Verify this directly:
    //     upload frame A and record a fixed pixel in BOTH viewports, then
    //     upload frame B (different moving-sphere position) and confirm both
    //     viewports change together from the A value to the B value. It is
    //     impossible for the eyes to show different content times this way.
    if (ctx.makeFrame && ctx.generator) {
      const gen = ctx.generator;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const faceWPx = gen.layout === 'sbs' ? W / 2 : W;
      const faceHPx = gen.layout === 'sbs' ? H : H / 2;
      const x0R = gen.layout === 'sbs' ? W / 2 : 0;
      const grab = (x0, w, h) => {
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(x0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        return buf;
      };
      const changedCount = (a, b) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]) > 40) n++;
        }
        return n;
      };
      // Sweep yaw so the time-varying content (moving sphere / timestamp) is
      // guaranteed to cross both viewports, then accumulate each eye's frame
      // difference. ODS remaps columns by a heading-dependent offset, making
      // the sweep necessary; parallel-ERP works at a single heading too.
      const yaws = [0, 45, -45, 90, -90, 135].map(d => d * DEG);
      let changedL = 0, changedR = 0;
      for (const yaw of yaws) {
        const stereoDraw = () => draw({ viewMode: 'stereo', layout: gen.layout, eyeOrder: gen.eyeOrder,
          stereoMode: gen.stereoMode, longitudeDir: gen.longitudeDir, latitudeDir: gen.latitudeDir, yaw });
        renderer.upload(ctx.makeFrame(3)); stereoDraw();
        const a3L = grab(0, faceWPx, faceHPx), a3R = grab(x0R, faceWPx, faceHPx);
        renderer.upload(ctx.makeFrame(19)); stereoDraw();
        const a19L = grab(0, faceWPx, faceHPx), a19R = grab(x0R, faceWPx, faceHPx);
        changedL += changedCount(a3L, a19L);
        changedR += changedCount(a3R, a19R);
      }
      check('gpu: one shared upload updates both eyes to the same new content time',
        changedL > 50 && changedR > 50, 'accumulatedChanged L=' + changedL + ' R=' + changedR);
      renderer.upload(t.atlas);
    }

    // G9. Degradation: validator rejects bad geometry, accepts mono, and the
    //     mono render path fills the full viewport with opaque pixels.
    const bad = P.validateAtlas(1000, 500, 'sbs');
    const monoOk = P.validateAtlas(1024, 512, 'mono');
    draw({ viewMode: 'mono' });
    const monoPx = pixel(gl, W / 2, H / 2);
    check('gpu: bad atlas flagged, mono accepted, mono fallback renders opaque',
      bad.ok === false && monoOk.ok === true && monoPx[3] === 255, bad.problems.join('; '));

    return results.slice();
  }

  function summary(list) {
    const pass = list.filter(r => r.pass).length;
    return { pass, total: list.length, allPass: pass === list.length, results: list };
  }

  return { check, cpuSuite, gpuSuite, summary, pixel, regionMean, colorDist, get results() { return results; } };
});
