/*
 * verify.js — replay a finished package from its own files and decide, per
 * binocular pair, whether it may be published. Checks per published clip:
 *   frame-count:  playlist, scene and on-disk files agree;
 *   eye-order:    every frame's left half carries the L monocular marker and
 *                 the right half the R marker (a swapped atlas fails here);
 *   content-time: the frame stamps of both eyes are equal AND the rotating
 *                 meridian marker sits at the same longitude in both eyes —
 *                 the check a static thumbnail cannot perform;
 *   frame-integrity: every eye half hashes to the expected fingerprint for
 *                 its (scene, eye, index); a hash matching a DIFFERENT index
 *                 is reported as a temporal swap with the actual frame no.;
 *   packaged-fingerprints: decoded content matches the package's own
 *                 fingerprint sheet (an unrecorded frame replacement fails).
 * A clip failing any check is revoked; clips that do not reference the bad
 * frame stay publishable. thumbnailOnly restricts the replay to frame 0,
 * emulating the static-thumbnail view.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const png = require('./png');
const sceneMod = require('./scene');
const fp = require('./fingerprints');
const pack = require('./pack');

function markerPresent(img, mk) {
  const P = require('../projection');
  const DEG = P.DEG;
  const uv = P.lonlatToFaceUV(mk.lonDeg * DEG, mk.latDeg * DEG, 1, 1);
  const x = Math.min(img.width - 1, Math.floor(uv[0] * img.width));
  const y = Math.min(img.height - 1, Math.floor(uv[1] * img.height));
  const i = (y * img.width + x) * 4;
  return img.data[i] === mk.color[0] && img.data[i + 1] === mk.color[1] && img.data[i + 2] === mk.color[2];
}

function verifyPackage(packageDir, opts) {
  const { scenesDir, expectedFp, thumbnailOnly } = opts;
  const playlist = JSON.parse(fs.readFileSync(path.join(packageDir, 'playlist.json'), 'utf8'));
  const packagedFp = JSON.parse(fs.readFileSync(path.join(packageDir, 'fingerprints.json'), 'utf8'));
  const report = { version: playlist.version, thumbnailOnly: !!thumbnailOnly, clips: {}, revoked: [], publishable: [] };

  for (const clip of playlist.clips) {
    if (clip.status !== 'published') {
      report.clips[clip.id] = { status: clip.status, checks: [] };
      continue;
    }
    const scene = sceneMod.loadScene(path.join(scenesDir, clip.scene + '.json'));
    const checks = [];
    const badFrames = [];

    const onDisk = fs.existsSync(path.join(packageDir, 'clips', clip.id))
      ? fs.readdirSync(path.join(packageDir, 'clips', clip.id)).filter((f) => /^f\d{4}\.png$/.test(f)).length
      : 0;
    const countOk = clip.frames === scene.frames && clip.files.length === scene.frames && onDisk === scene.frames;
    checks.push({ name: 'frame-count', pass: countOk, detail: `playlist=${clip.files.length} scene=${scene.frames} disk=${onDisk}` });

    const frameIdx = thumbnailOnly ? [0] : [...Array(scene.frames).keys()];
    let eyeOrderOk = true, contentTimeOk = true, integrityOk = true, packagedOk = true;
    for (const f of frameIdx) {
      const atlas = png.decodePNG(fs.readFileSync(path.join(packageDir, 'clips', clip.id, pack.frameName(f))));
      const halves = sceneMod.splitAtlas(scene, atlas);

      if (!markerPresent(halves.L, scene.monoMarkers.L) || !markerPresent(halves.R, scene.monoMarkers.R)) {
        eyeOrderOk = false;
        badFrames.push({ frame: f, problem: 'eye-order' });
      }

      const sL = sceneMod.readFrameStamp(halves.L);
      const sR = sceneMod.readFrameStamp(halves.R);
      const mL = sceneMod.measureMeridianLon(scene, halves.L);
      const mR = sceneMod.measureMeridianLon(scene, halves.R);
      const mDiff = mL === null || mR === null ? Infinity : Math.abs(sceneMod.wrapDeg(mL - mR));
      if (sL !== sR || mDiff > 1.5) {
        contentTimeOk = false;
        badFrames.push({
          frame: f, problem: 'content-time',
          stampL: sL, stampR: sR,
          meridianL: mL === null ? null : +mL.toFixed(2),
          meridianR: mR === null ? null : +mR.toFixed(2)
        });
      }

      for (const eye of ['L', 'R']) {
        const expected = expectedFp.scenes[scene.id].eyes[eye];
        const hash = fp.frameHash(scene.id, eye, f, halves[eye]);
        if (hash !== expected[f]) {
          integrityOk = false;
          // The hash binds (scene, eye, index), so the donor frame is found
          // by re-hashing the same pixels under each candidate index.
          let actual = 'foreign';
          for (let j = 0; j < expected.length; j++) {
            if (fp.frameHash(scene.id, eye, j, halves[eye]) === expected[j]) { actual = j; break; }
          }
          badFrames.push({ frame: f, problem: 'frame-integrity', eye, actualFrame: actual });
        }
        if (packagedFp.clips[clip.id] && packagedFp.clips[clip.id][eye][f] !== hash) {
          packagedOk = false;
        }
      }
    }
    checks.push({ name: 'eye-order', pass: eyeOrderOk });
    checks.push({ name: 'content-time', pass: contentTimeOk });
    checks.push({ name: 'frame-integrity', pass: integrityOk });
    checks.push({ name: 'packaged-fingerprints', pass: packagedOk });

    const revoked = !checks.every((c) => c.pass);
    report.clips[clip.id] = { status: revoked ? 'revoked' : 'publishable', checks, badFrames };
    (revoked ? report.revoked : report.publishable).push(clip.id);
  }
  return report;
}

module.exports = { verifyPackage, markerPresent };
