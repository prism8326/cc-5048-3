/*
 * pack.js — confirmed-manifest-driven sample packaging.
 * For each confirmed segment the two eye clips are composed into per-frame
 * sbs atlases. Segments whose legacy labels conflict take one of two
 * distinguishable paths:
 *   quarantine: the segment is isolated; the playlist records it with
 *     status 'quarantined' and no files, and packaging continues;
 *   rebuild:    the missing eye is re-rendered from the source scene, every
 *     rebuilt frame is reviewed against the checked-in fingerprints, and the
 *     playlist records provenance.resolution = 'rebuilt-from-scene'.
 * Output is a pure function of (confirmed manifest, incoming clips, scenes),
 * so re-running with the same version reproduces byte-identical playlists
 * and fingerprints.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const png = require('./png');
const sceneMod = require('./scene');
const fp = require('./fingerprints');

function frameName(f) { return 'f' + String(f).padStart(4, '0') + '.png'; }

function readEyeFrame(clipDir, f) {
  return png.decodePNG(fs.readFileSync(path.join(clipDir, frameName(f))));
}

function writeImg(file, img) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png.encodePNG(img.width, img.height, img.data));
}

// Renders one eye of a whole segment from its source scene and reviews every
// frame against the expected fingerprints. Throws (blocking release) on any
// mismatch — this is the 复核 gate for the rebuild path.
function rebuildEye(scene, eye, expectedFp) {
  const frames = [];
  for (let f = 0; f < scene.frames; f++) {
    const img = sceneMod.renderEyeFrame(scene, eye, f);
    const hash = fp.frameHash(scene.id, eye, f, img);
    if (hash !== expectedFp.scenes[scene.id].eyes[eye][f]) {
      throw new Error(`review failed: rebuilt ${scene.id} ${eye} frame ${f} does not match fingerprints`);
    }
    frames.push(img);
  }
  return frames;
}

function pack(opts) {
  const { confirmed, incomingDir, scenesDir, outDir, resolution, version, expectedFp } = opts;
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const playlist = { package: 'samples', version, resolution, layout: 'sbs', eyeOrder: 'LR', clips: [] };
  const fingerprints = { version, clips: {} };

  for (const seg of confirmed.segments) {
    const scene = sceneMod.loadScene(path.join(scenesDir, seg.segment + '.json'));
    const clipDir = path.join(outDir, 'clips', seg.segment);

    if (seg.status === 'conflict' && resolution === 'quarantine') {
      playlist.clips.push({
        id: seg.segment, status: 'quarantined', scene: seg.segment,
        reason: seg.conflicts.map((c) => `${c.clip}: ${c.reason}`).join('; '),
        frames: 0, files: []
      });
      continue;
    }

    // Resolve the frame source of each eye: incoming clip, or rebuilt scene.
    const eyeFrames = { L: null, R: null };
    const sources = {};
    const rebuiltEyes = [];
    for (const eye of ['L', 'R']) {
      // Usable incoming clip: confirmed segment, or a clip that is not
      // itself part of the segment's conflicts.
      const usable = seg.eyes[eye].find((clipName) =>
        seg.status === 'confirmed' || seg.conflicts.every((c) => c.clip !== clipName));
      if (usable) {
        eyeFrames[eye] = [];
        for (let f = 0; f < scene.frames; f++) eyeFrames[eye].push(readEyeFrame(path.join(incomingDir, usable), f));
        sources[eye] = path.join('incoming', usable);
      } else {
        eyeFrames[eye] = rebuildEye(scene, eye, expectedFp);
        sources[eye] = 'rebuilt://' + seg.segment;
        rebuiltEyes.push(eye);
      }
    }

    const files = [];
    const hashes = { L: [], R: [] };
    for (let f = 0; f < scene.frames; f++) {
      const atlas = sceneMod.composeAtlas(scene, eyeFrames.L[f], eyeFrames.R[f]);
      const rel = path.join('clips', seg.segment, frameName(f));
      writeImg(path.join(outDir, rel), atlas);
      files.push(rel);
      hashes.L.push(fp.frameHash(scene.id, 'L', f, eyeFrames.L[f]));
      hashes.R.push(fp.frameHash(scene.id, 'R', f, eyeFrames.R[f]));
    }
    const thumbRel = path.join('clips', seg.segment, 'thumb.png');
    fs.copyFileSync(path.join(outDir, files[0]), path.join(outDir, thumbRel));

    const entry = {
      id: seg.segment, status: 'published', scene: seg.segment,
      frames: scene.frames, fps: scene.fps, sources, files, thumbnail: thumbRel
    };
    if (rebuiltEyes.length) {
      entry.provenance = {
        resolution: 'rebuilt-from-scene',
        rebuiltEyes,
        reviewedAgainst: 'samples/fingerprints.json',
        review: 'passed'
      };
    }
    playlist.clips.push(entry);
    fingerprints.clips[seg.segment] = hashes;
  }

  fs.writeFileSync(path.join(outDir, 'playlist.json'), JSON.stringify(playlist, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'fingerprints.json'), JSON.stringify(fingerprints, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(confirmed, null, 2) + '\n');
  return { playlist, fingerprints };
}

module.exports = { pack, rebuildEye, frameName };
