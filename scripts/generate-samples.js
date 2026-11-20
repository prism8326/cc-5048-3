/*
 * generate-samples.js — renders the incoming cross-version sample batch from
 * the checked-in source scenes and writes the segment fingerprint sheet.
 *
 *   samples/incoming/alley_L|alley_R/      v1 clips: eye from filename
 *   samples/incoming/harbor_01|02/         v2 clips: eye only on slate.png
 *   samples/incoming/roof_L|roof_R/        v2 clips; roof_L is MISLABELLED
 *                                          (filename says L, slate + content
 *                                          are R) to exercise conflict paths
 *   samples/incoming/legacy/manifest-v*.json
 *   samples/fingerprints.json              checked-in ground truth
 *
 * Usage: node scripts/generate-samples.js   (also require-able as a module)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const png = require('../src/pipeline/png');
const slate = require('../src/pipeline/slate');
const sceneMod = require('../src/pipeline/scene');
const fp = require('../src/pipeline/fingerprints');

const ROOT = path.join(__dirname, '..');
const SCENES_DIR = path.join(ROOT, 'samples', 'scenes');
const INCOMING = path.join(ROOT, 'samples', 'incoming');
const FINGERPRINTS = path.join(ROOT, 'samples', 'fingerprints.json');

// clip dir name -> { scene, contentEye, slateEye|null }
const BATCH = [
  { clip: 'alley_L', scene: 'alley', contentEye: 'L', slateEye: null },
  { clip: 'alley_R', scene: 'alley', contentEye: 'R', slateEye: null },
  { clip: 'harbor_01', scene: 'harbor', contentEye: 'L', slateEye: 'L' },
  { clip: 'harbor_02', scene: 'harbor', contentEye: 'R', slateEye: 'R' },
  { clip: 'roof_L', scene: 'roof', contentEye: 'R', slateEye: 'R' },
  { clip: 'roof_R', scene: 'roof', contentEye: 'R', slateEye: 'R' }
];

const MANIFEST_V1 = {
  version: 1,
  convention: 'filename-eye-suffix',
  segments: [{ segment: 'alley', clips: ['alley_L', 'alley_R'] }]
};
const MANIFEST_V2 = {
  version: 2,
  convention: 'slate-marked',
  segments: [
    { segment: 'harbor', clips: ['harbor_01', 'harbor_02'] },
    { segment: 'roof', clips: ['roof_L', 'roof_R'] }
  ]
};

function writeImg(file, img) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png.encodePNG(img.width, img.height, img.data));
}

function generate() {
  const scenes = {};
  for (const id of ['alley', 'harbor', 'roof']) {
    scenes[id] = sceneMod.loadScene(path.join(SCENES_DIR, id + '.json'));
  }

  fs.rmSync(INCOMING, { recursive: true, force: true });
  for (const item of BATCH) {
    const scene = scenes[item.scene];
    const dir = path.join(INCOMING, item.clip);
    for (let f = 0; f < scene.frames; f++) {
      writeImg(path.join(dir, 'f' + String(f).padStart(4, '0') + '.png'),
        sceneMod.renderEyeFrame(scene, item.contentEye, f));
    }
    if (item.slateEye) writeImg(path.join(dir, 'slate.png'), slate.writeSlate(item.slateEye));
  }

  fs.mkdirSync(path.join(INCOMING, 'legacy'), { recursive: true });
  fs.writeFileSync(path.join(INCOMING, 'legacy', 'manifest-v1.json'), JSON.stringify(MANIFEST_V1, null, 2) + '\n');
  fs.writeFileSync(path.join(INCOMING, 'legacy', 'manifest-v2.json'), JSON.stringify(MANIFEST_V2, null, 2) + '\n');

  const fingerprints = fp.computeAll(Object.values(scenes));
  fs.writeFileSync(FINGERPRINTS, JSON.stringify(fingerprints, null, 2) + '\n');
  return { fingerprints, incoming: INCOMING };
}

if (require.main === module) {
  const { fingerprints } = generate();
  const n = Object.keys(fingerprints.scenes).length;
  console.log(`generated incoming batch for ${n} scenes; fingerprints written to ${path.relative(ROOT, FINGERPRINTS)}`);
}

module.exports = { generate, BATCH, INCOMING, FINGERPRINTS, SCENES_DIR };
