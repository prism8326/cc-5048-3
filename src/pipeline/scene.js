/*
 * scene.js — Node renderer for the documented sample scenes. Each scene JSON
 * fully determines both eyes of every frame, so any packaged frame can be
 * rebuilt from its source scene and reviewed against the checked-in
 * fingerprints. Content cues baked into every frame:
 *   - graticule + seam band at the ERP cut (lon +/-180)
 *   - a rotating meridian marker whose longitude is a function of content
 *     time; both eyes draw it identically per frame, so a temporally
 *     mismatched eye is exposed as soon as the marker rotates into view
 *   - a flat-coloured near sphere ("claim sphere") whose apparent longitude
 *     carries the near-field parallax sign of the capturing eye
 *   - a monocular marker per eye near the seam (visible in one eye only)
 *   - red/blue polar caps (orientation cue)
 *   - a 12-bit frame-number stamp, identical in both eyes
 */
'use strict';
const fs = require('fs');
const P = require('../projection');
const DEG = P.DEG;

const STAMP_BITS = 12;

function loadScene(file) {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  s.faceH = s.faceW / 2;
  s.layout = s.layout || 'sbs';
  s.eyeOrder = s.eyeOrder || 'LR';
  if (s.layout !== 'sbs') throw new Error('pipeline composes sbs atlases only');
  return s;
}

function eyeOriginX(scene, eye) { return (eye === 'L' ? -1 : 1) * scene.ipd / 2; }

function claimSphere(scene) { return scene.spheres.find((s) => s.claim); }

function wrapDeg(d) { return ((d % 360) + 540) % 360 - 180; }

// Longitude of the rotating meridian marker at a given frame, in [-180, 180).
function meridianLonAt(scene, frame) {
  const m = scene.meridianMarker;
  return wrapDeg(m.baseLonDeg + (frame / scene.fps) * m.degPerSec);
}

function background(scene, dir, frame) {
  const bg = scene.background;
  const ll = P.dirToLonlat(dir);
  const lonDeg = ((ll[0] / DEG) % 360 + 360) % 360;
  const latDeg = ll[1] / DEG;
  const g = P.clamp((dir[1] + 1) / 2, 0, 1);
  let col = [
    bg.bottom[0] + (bg.top[0] - bg.bottom[0]) * g,
    bg.bottom[1] + (bg.top[1] - bg.bottom[1]) * g,
    bg.bottom[2] + (bg.top[2] - bg.bottom[2]) * g
  ];
  const lonLine = Math.abs(((lonDeg % 15) + 15) % 15);
  const latLine = Math.abs(((Math.abs(latDeg) % 15) + 15) % 15);
  const onMer = Math.min(lonLine, 15 - lonLine) * DEG * Math.cos(ll[1]);
  const onPar = Math.min(latLine, 15 - latLine) * DEG;
  if (onMer < 0.006 || onPar < 0.006) {
    const boldMer = Math.round(lonDeg / 45) * 45;
    const boldPar = Math.round(latDeg / 45) * 45;
    const bold = Math.abs(wrapDeg(lonDeg - boldMer)) * DEG * Math.cos(ll[1]) < 0.012 ||
                 Math.abs(latDeg - boldPar) * DEG < 0.012;
    col = bold ? bg.graticuleBold : bg.graticule;
  }
  // Seam band at the ERP cut: distance from lonDeg to +/-180.
  const x = (lonDeg + 180) % 360;
  if (Math.min(x, 360 - x) < 2.5) col = Math.floor((latDeg + 90) / 6) % 2 ? bg.seamA : bg.seamB;
  // Rotating meridian marker: gold/dark latitude stripes, identical per frame
  // in both eyes — the content-time landmark.
  const m = scene.meridianMarker;
  if (Math.abs(wrapDeg(lonDeg - meridianLonAt(scene, frame))) < m.halfWidthDeg) {
    col = Math.floor((latDeg + 90) / 8) % 2 ? m.colorA : m.colorB;
  }
  if (latDeg > 86) col = bg.poleN;
  if (latDeg < -86) col = bg.poleS;
  return col;
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

function shadeLit(sph, origin, dir, t) {
  const hit = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
  const nx = (hit[0] - sph.c[0]) / sph.r, ny = (hit[1] - sph.c[1]) / sph.r, nz = (hit[2] - sph.c[2]) / sph.r;
  const light = Math.max(0, nx * 0.4 + ny * 0.8 + nz * 0.45) * 0.75 + 0.25;
  return [sph.color[0] * light, sph.color[1] * light, sph.color[2] * light];
}

function shade(scene, eye, dir, frame) {
  const origin = [eyeOriginX(scene, eye), 0, 0];
  let col = background(scene, dir, frame);
  let bestT = Infinity;
  for (const sph of scene.spheres) {
    const t = raySphere(origin, dir, sph);
    if (t !== null && t < bestT) {
      bestT = t;
      col = sph.flat ? sph.color : shadeLit(sph, origin, dir, t);
    }
  }
  // Monocular marker: a directional disc rendered into this eye only.
  const mk = scene.monoMarkers[eye];
  const md = P.lonlatToDir(mk.lonDeg * DEG, mk.latDeg * DEG);
  if (dir[0] * md[0] + dir[1] * md[1] + dir[2] * md[2] > Math.cos(mk.radiusDeg * DEG)) col = mk.color;
  return [
    Math.round(P.clamp(col[0], 0, 255)),
    Math.round(P.clamp(col[1], 0, 255)),
    Math.round(P.clamp(col[2], 0, 255))
  ];
}

function fillRect(img, x0, y0, w, h, rgb) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = 255;
    }
  }
}

function stampPatch(faceW) { return Math.max(3, Math.round(faceW / 96)); }

// 12-bit frame number as bottom-left corner patches, identical in both eyes.
function drawFrameStamp(img, frame) {
  const patch = stampPatch(img.width);
  for (let b = 0; b < STAMP_BITS; b++) {
    const v = ((frame >> b) & 1) ? 255 : 34;
    fillRect(img, 4 + b * (patch + 2), img.height - patch - 4, patch, patch, [v, v, v]);
  }
}

function readFrameStamp(img) {
  const patch = stampPatch(img.width);
  let frame = 0;
  for (let b = 0; b < STAMP_BITS; b++) {
    const x = 4 + b * (patch + 2) + (patch >> 1);
    const y = img.height - patch - 4 + (patch >> 1);
    const i = (y * img.width + x) * 4;
    if ((img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3 > 128) frame |= 1 << b;
  }
  return frame;
}

function renderEyeFrame(scene, eye, frame) {
  const w = scene.faceW, h = scene.faceH;
  const img = { width: w, height: h, data: Buffer.alloc(w * h * 4) };
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const dir = P.erpUVToDir(u, v, 1, 1);
      const c = shade(scene, eye, dir, frame);
      const i = (y * w + x) * 4;
      img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
    }
  }
  drawFrameStamp(img, frame);
  return img;
}

function blit(dst, src, x0, y0) {
  for (let y = 0; y < src.height; y++) {
    Buffer.from(src.data.buffer, src.data.byteOffset + y * src.width * 4, src.width * 4)
      .copy(dst.data, ((y0 + y) * dst.width + x0) * 4);
  }
}

function crop(src, x0, y0, w, h) {
  const out = { width: w, height: h, data: Buffer.alloc(w * h * 4) };
  for (let y = 0; y < h; y++) {
    Buffer.from(src.data.buffer, src.data.byteOffset + ((y0 + y) * src.width + x0) * 4, w * 4)
      .copy(out.data, y * w * 4);
  }
  return out;
}

function composeAtlas(scene, frameL, frameR) {
  const atlas = { width: scene.faceW * 2, height: scene.faceH, data: Buffer.alloc(scene.faceW * 2 * scene.faceH * 4) };
  const first = scene.eyeOrder === 'LR' ? frameL : frameR;
  const second = scene.eyeOrder === 'LR' ? frameR : frameL;
  blit(atlas, first, 0, 0);
  blit(atlas, second, scene.faceW, 0);
  return atlas;
}

function splitAtlas(scene, atlas) {
  const left = crop(atlas, 0, 0, scene.faceW, scene.faceH);
  const right = crop(atlas, scene.faceW, 0, scene.faceW, scene.faceH);
  return scene.eyeOrder === 'LR' ? { L: left, R: right } : { L: right, R: left };
}

// Centroid longitude of the rotating meridian marker (colour A pixels).
function measureMeridianLon(scene, img) {
  const t = scene.meridianMarker.colorA;
  let sx = 0, n = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i] === t[0] && img.data[i + 1] === t[1] && img.data[i + 2] === t[2]) { sx += x; n++; }
    }
  }
  if (!n) return null;
  return ((sx / n + 0.5) / img.width - 0.5) * 360;
}

module.exports = {
  STAMP_BITS,
  loadScene, eyeOriginX, claimSphere, wrapDeg, meridianLonAt,
  renderEyeFrame, composeAtlas, splitAtlas,
  drawFrameStamp, readFrameStamp, measureMeridianLon
};
