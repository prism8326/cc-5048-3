/*
 * fingerprints.js — content fingerprints for sample segments. A frame hash
 * binds (scene, eye, frame index) to the exact rendered pixels, so a frame
 * that carries valid content at the wrong time is still identified: its hash
 * matches a different index of the same eye. The checked-in
 * samples/fingerprints.json is the ground truth the packager reviews rebuilt
 * frames against and the verifier checks packaged content against.
 */
'use strict';
const crypto = require('crypto');
const sceneMod = require('./scene');

function frameHash(sceneId, eye, frameIndex, img) {
  const h = crypto.createHash('sha256');
  h.update(`${sceneId}:${eye}:${frameIndex}:`);
  h.update(img.data);
  return h.digest('hex');
}

function computeSceneFingerprints(scene) {
  const eyes = {};
  for (const eye of ['L', 'R']) {
    eyes[eye] = [];
    for (let f = 0; f < scene.frames; f++) {
      eyes[eye].push(frameHash(scene.id, eye, f, sceneMod.renderEyeFrame(scene, eye, f)));
    }
  }
  const digest = crypto.createHash('sha256').update(eyes.L.join('') + eyes.R.join('')).digest('hex');
  return { frames: scene.frames, fps: scene.fps, faceW: scene.faceW, eyes, digest };
}

// scenes: array of loaded scene objects, processed in sorted id order so the
// output is byte-stable across runs.
function computeAll(scenes) {
  const out = { format: 1, scenes: {} };
  for (const scene of scenes.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    out.scenes[scene.id] = computeSceneFingerprints(scene);
  }
  return out;
}

module.exports = { frameHash, computeSceneFingerprints, computeAll };
