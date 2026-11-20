/*
 * claim.js — content-based eye identification (认领) for incoming clips.
 * The maintainer's spherical-window pass is reproduced by three cues read
 * straight from a clip's frames:
 *   1. near-field parallax sign: the claim sphere's apparent longitude is
 *      matched against the per-eye expectation computed from the scene;
 *   2. monocular marker: a sweep of view headings across the +/-180 seam
 *      finds the marker that only exists in one eye;
 *   3. polar direction: the red/blue pole caps confirm the clip is not
 *      flipped before its eye label is trusted.
 * buildConfirmedManifest() then combines legacy labels with content claims
 * into the confirmed manifest that drives packaging.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('../projection');
const png = require('./png');
const sceneMod = require('./scene');
const DEG = P.DEG;

function loadClipFrame(clipDir, frame) {
  const file = path.join(clipDir, 'f' + String(frame).padStart(4, '0') + '.png');
  return png.decodePNG(fs.readFileSync(file));
}

function pixelAtDir(img, dir) {
  const uv = P.lonlatToFaceUV(...P.dirToLonlat(dir), 1, 1);
  const x = Math.min(img.width - 1, Math.floor(uv[0] * img.width));
  const y = Math.min(img.height - 1, Math.floor(uv[1] * img.height));
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

function colorEq(a, b) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]; }

// Rotate the sampling window across the seam: headings walk from +150 deg
// through 180 to -150 deg, so finding a marker proves the seam wrap is
// handled. Returns one hit cluster per marker colour found.
function sweepSeam(scene, img) {
  const lats = [scene.monoMarkers.L.latDeg, scene.monoMarkers.R.latDeg];
  const hits = { L: [], R: [] };
  for (const latDeg of lats) {
    for (let lon = 150; lon <= 210; lon++) {
      const wrapped = sceneMod.wrapDeg(lon);
      const c = pixelAtDir(img, P.lonlatToDir(wrapped * DEG, latDeg * DEG));
      for (const eye of ['L', 'R']) {
        if (colorEq(c, scene.monoMarkers[eye].color)) hits[eye].push({ lonDeg: wrapped, latDeg });
      }
    }
  }
  return hits;
}

function monoMarkerCue(scene, img) {
  const hits = sweepSeam(scene, img);
  const found = ['L', 'R'].filter((eye) => hits[eye].length > 0);
  return { eye: found.length === 1 ? found[0] : null, hits };
}

// Apparent lon/lat of the claim sphere centre seen from a given eye.
function expectedApparent(scene, eye) {
  const c = sceneMod.claimSphere(scene).c;
  const ox = sceneMod.eyeOriginX(scene, eye);
  const d = [c[0] - ox, c[1], c[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  const ll = P.dirToLonlat([d[0] / len, d[1] / len, d[2] / len]);
  return { lonDeg: ll[0] / DEG, latDeg: ll[1] / DEG };
}

function measureColorCentroid(img, color) {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i] === color[0] && img.data[i + 1] === color[1] && img.data[i + 2] === color[2]) {
        sx += x; sy += y; n++;
      }
    }
  }
  if (!n) return null;
  const u = (sx / n + 0.5) / img.width, v = (sy / n + 0.5) / img.height;
  const ll = P.dirToLonlat(P.erpUVToDir(u, v, 1, 1));
  return { lonDeg: ll[0] / DEG, latDeg: ll[1] / DEG, count: n };
}

function parallaxCue(scene, img) {
  const measured = measureColorCentroid(img, sceneMod.claimSphere(scene).color);
  if (!measured) return { eye: null, measured: null };
  const expL = expectedApparent(scene, 'L');
  const expR = expectedApparent(scene, 'R');
  const dL = Math.abs(sceneMod.wrapDeg(measured.lonDeg - expL.lonDeg));
  const dR = Math.abs(sceneMod.wrapDeg(measured.lonDeg - expR.lonDeg));
  return { eye: dL < dR ? 'L' : 'R', measured, expected: { L: expL, R: expR }, dL, dR };
}

function polarCue(scene, img) {
  const north = pixelAtDir(img, [0, 1, 0]);
  const south = pixelAtDir(img, [0, -1, 0]);
  return {
    ok: colorEq(north, scene.background.poleN) && colorEq(south, scene.background.poleS),
    north, south
  };
}

// Claims the eye of one clip from its first frame. Returns the claimed eye,
// the individual cues and whether every cue agrees.
function claimClip(scene, clipDir) {
  const img = loadClipFrame(clipDir, 0);
  const mono = monoMarkerCue(scene, img);
  const parallax = parallaxCue(scene, img);
  const polar = polarCue(scene, img);
  const votes = [mono.eye, parallax.eye].filter(Boolean);
  const eye = votes.length && votes.every((v) => v === votes[0]) ? votes[0] : null;
  return {
    eye,
    confident: !!eye && polar.ok,
    cues: { monoMarker: mono, parallax, polar }
  };
}

// Combines legacy entries with content claims into the confirmed manifest.
// A segment is 'confirmed' when every cue agrees and it contributes exactly
// one L and one R clip; otherwise it is 'conflict' and packaging must choose
// a resolution path for it.
function buildConfirmedManifest(entries, claimsByClip) {
  const segments = new Map();
  for (const e of entries) {
    if (!segments.has(e.segment)) segments.set(e.segment, { segment: e.segment, clips: [], conflicts: [] });
    const seg = segments.get(e.segment);
    const claim = claimsByClip[e.clip];
    seg.clips.push({
      clip: e.clip, dir: e.dir,
      filenameEye: e.filenameEye, slateEye: e.slateEye, legacyEye: e.eye, eyeSource: e.eyeSource,
      claimedEye: claim.eye, confident: claim.confident
    });
    if (e.conflict) seg.conflicts.push({ clip: e.clip, reason: e.conflict });
    if (e.eye !== claim.eye) {
      seg.conflicts.push({ clip: e.clip, reason: `legacy label ${e.eye} but content claims ${claim.eye}` });
    }
  }
  const out = { format: 1, segments: [] };
  for (const seg of [...segments.values()].sort((a, b) => a.segment.localeCompare(b.segment))) {
    const eyes = { L: [], R: [] };
    for (const c of seg.clips) if (c.claimedEye) eyes[c.claimedEye].push(c.clip);
    const complete = eyes.L.length === 1 && eyes.R.length === 1;
    const entry = {
      segment: seg.segment,
      status: seg.conflicts.length === 0 && complete ? 'confirmed' : 'conflict',
      eyes: { L: eyes.L, R: eyes.R },
      clips: seg.clips,
      conflicts: seg.conflicts
    };
    out.segments.push(entry);
  }
  return out;
}

module.exports = {
  loadClipFrame, sweepSeam, monoMarkerCue, parallaxCue, polarCue,
  expectedApparent, claimClip, buildConfirmedManifest
};
