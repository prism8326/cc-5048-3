/*
 * End-to-end pipeline test: take over the cross-version sample batch, claim
 * each clip's eye from content cues, pack via both conflict-resolution
 * paths, apply a right-eye middle-frame update, replay the package and
 * assert revocation/publishability, then fix, repack and check eye order,
 * frame counts and idempotency.
 *
 *   node test/run-pipeline.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const gen = require('../scripts/generate-samples');
const png = require('../src/pipeline/png');
const sceneMod = require('../src/pipeline/scene');
const fp = require('../src/pipeline/fingerprints');
const legacy = require('../src/pipeline/legacy');
const claim = require('../src/pipeline/claim');
const { pack } = require('../src/pipeline/pack');
const { replaceRightEyeFrame } = require('../src/pipeline/update');
const { verifyPackage } = require('../src/pipeline/verify');

const ROOT = path.join(__dirname, '..');
const SCENES_DIR = path.join(ROOT, 'samples', 'scenes');
const INCOMING = path.join(ROOT, 'samples', 'incoming');
const PKG_ROOT = path.join(ROOT, 'samples', 'packages');
const CONFIRMED = path.join(ROOT, 'samples', 'confirmed-manifest.json');
const MID = 8, DONOR = 12;

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' (' + detail + ')' : ''));
  return !!cond;
}
function findCheck(report, clipId, name) {
  return report.clips[clipId].checks.find((c) => c.name === name);
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------- 1. generate
const checkedInFp = fs.readFileSync(gen.FINGERPRINTS, 'utf8');
gen.generate();
check('generate: incoming batch regenerated from source scenes',
  fs.existsSync(path.join(INCOMING, 'alley_L')) && fs.existsSync(path.join(INCOMING, 'roof_L', 'slate.png')));
check('generate: fingerprints are reproducible (checked-in sheet matches re-render)',
  fs.readFileSync(gen.FINGERPRINTS, 'utf8') === checkedInFp);
const expectedFp = JSON.parse(checkedInFp);

const scenes = {};
for (const id of ['alley', 'harbor', 'roof']) {
  scenes[id] = sceneMod.loadScene(path.join(SCENES_DIR, id + '.json'));
}

// ------------------------------------------------------------- 2. legacy read
const entries = legacy.readBatch(INCOMING);
const byClip = Object.fromEntries(entries.map((e) => [e.clip, e]));
check('legacy: six clips read from both manifest versions', entries.length === 6);
check('legacy: v1 eyes come from filenames',
  byClip.alley_L.eyeSource === 'filename' && byClip.alley_L.eye === 'L' &&
  byClip.alley_R.eyeSource === 'filename' && byClip.alley_R.eye === 'R' &&
  byClip.alley_L.slateEye === null);
check('legacy: v2 eyes come only from the slate images',
  byClip.harbor_01.eyeSource === 'slate' && byClip.harbor_01.eye === 'L' &&
  byClip.harbor_02.eyeSource === 'slate' && byClip.harbor_02.eye === 'R' &&
  byClip.harbor_01.filenameEye === null);
check('legacy: roof_L filename/slate mismatch is flagged, not silently resolved',
  byClip.roof_L.conflict !== null && byClip.roof_L.filenameEye === 'L' && byClip.roof_L.slateEye === 'R',
  byClip.roof_L.conflict);
check('legacy: roof_R is self-consistent', byClip.roof_R.conflict === null && byClip.roof_R.eye === 'R');

// -------------------------------------------------------------------- 3. claim
const claims = {};
for (const e of entries) claims[e.clip] = claim.claimClip(scenes[e.segment], e.dir);
const expectedEyes = { alley_L: 'L', alley_R: 'R', harbor_01: 'L', harbor_02: 'R', roof_L: 'R', roof_R: 'R' };
check('claim: every clip claimed confidently from content cues',
  entries.every((e) => claims[e.clip].eye === expectedEyes[e.clip] && claims[e.clip].confident),
  entries.map((e) => `${e.clip}=${claims[e.clip].eye}`).join(' '));

const sweepL = claims.alley_L.cues.monoMarker.hits;
const sweepR = claims.alley_R.cues.monoMarker.hits;
check('claim: seam-crossing sweep finds the L marker only in the left clip (lon ~= +175)',
  sweepL.L.length > 0 && sweepL.R.length === 0 &&
  sweepL.L.some((h) => Math.abs(sceneMod.wrapDeg(h.lonDeg - 175)) < 3));
check('claim: seam-crossing sweep finds the R marker only in the right clip (lon ~= -175)',
  sweepR.R.length > 0 && sweepR.L.length === 0 &&
  sweepR.R.some((h) => Math.abs(sceneMod.wrapDeg(h.lonDeg + 175)) < 3));
check('claim: near-field parallax sign separates the eyes with margin',
  entries.every((e) => {
    const p = claims[e.clip].cues.parallax;
    const [near, far] = p.eye === 'L' ? [p.dL, p.dR] : [p.dR, p.dL];
    return near < 2 && far - near > 3;
  }),
  'alley_L dL=' + claims.alley_L.cues.parallax.dL.toFixed(2) + ' dR=' + claims.alley_L.cues.parallax.dR.toFixed(2));
check('claim: polar direction cue confirms orientation on every clip',
  entries.every((e) => claims[e.clip].cues.polar.ok));

// ----------------------------------------------------------------- 4. confirm
const confirmed = claim.buildConfirmedManifest(entries, claims);
fs.writeFileSync(CONFIRMED, JSON.stringify(confirmed, null, 2) + '\n');
const segById = Object.fromEntries(confirmed.segments.map((s) => [s.segment, s]));
check('confirm: alley and harbor are confirmed pairs',
  segById.alley.status === 'confirmed' && segById.harbor.status === 'confirmed' &&
  segById.alley.eyes.L[0] === 'alley_L' && segById.alley.eyes.R[0] === 'alley_R');
check('confirm: roof is a conflict segment (duplicate R, no L, filename/slate mismatch)',
  segById.roof.status === 'conflict' && segById.roof.eyes.L.length === 0 &&
  segById.roof.eyes.R.length === 2 &&
  segById.roof.conflicts.some((c) => /filename says L, slate says R/.test(c.reason)));

// ----------------------------------------------------- 5. pack both resolutions
const pkgQ = path.join(PKG_ROOT, 'v1-quarantine');
const pkgR = path.join(PKG_ROOT, 'v1-rebuild');
const basePackOpts = { confirmed, incomingDir: INCOMING, scenesDir: SCENES_DIR, expectedFp };
const outQ = pack(Object.assign({}, basePackOpts, { outDir: pkgQ, resolution: 'quarantine', version: 'v1-quarantine' }));
const outR = pack(Object.assign({}, basePackOpts, { outDir: pkgR, resolution: 'rebuild', version: 'v1-rebuild' }));

const roofQ = outQ.playlist.clips.find((c) => c.id === 'roof');
const roofR = outR.playlist.clips.find((c) => c.id === 'roof');
check('pack/quarantine: conflicted segment isolated, rest of the package ships',
  roofQ.status === 'quarantined' && roofQ.files.length === 0 &&
  outQ.playlist.clips.filter((c) => c.status === 'published').map((c) => c.id).join(',') === 'alley,harbor');
check('pack/rebuild: missing eye rebuilt from source scene and released after review',
  roofR.status === 'published' && roofR.provenance.resolution === 'rebuilt-from-scene' &&
  roofR.provenance.rebuiltEyes.join(',') === 'L' && roofR.provenance.review === 'passed' &&
  roofR.sources.R === path.join('incoming', 'roof_R') && roofR.sources.L === 'rebuilt://roof');
check('pack: the two resolution paths produce visibly different playlists',
  roofQ.status !== roofR.status && !roofQ.provenance && !!roofR.provenance);
check('pack/rebuild: rebuilt frames match the checked-in fingerprints (review gate)',
  JSON.stringify(outR.fingerprints.clips.roof.L) === JSON.stringify(expectedFp.scenes.roof.eyes.L));
check('pack: packaged fingerprints of incoming-sourced clips match ground truth',
  JSON.stringify(outR.fingerprints.clips.alley.L) === JSON.stringify(expectedFp.scenes.alley.eyes.L) &&
  JSON.stringify(outR.fingerprints.clips.harbor.R) === JSON.stringify(expectedFp.scenes.harbor.eyes.R));

// ------------------------------------------------------- 6. right-eye mid-frame
const clipFile = (f) => path.join(pkgR, 'clips', 'alley', 'f' + String(f).padStart(4, '0') + '.png');
const thumbBefore = sha(fs.readFileSync(path.join(pkgR, 'clips', 'alley', 'thumb.png')));
const before = {};
for (const f of [0, 7, 8, 9, 12, 15]) before[f] = sha(fs.readFileSync(clipFile(f)));
const newVersion = replaceRightEyeFrame(pkgR, scenes.alley, 'alley', MID, DONOR);
const untouchedKept = [0, 7, 9, 12, 15].every((f) => sha(fs.readFileSync(clipFile(f))) === before[f]);
check('update: only the middle frame file changed; thumbnail and neighbours untouched',
  sha(fs.readFileSync(path.join(pkgR, 'clips', 'alley', 'thumb.png'))) === thumbBefore &&
  sha(fs.readFileSync(clipFile(8))) !== before[8] && untouchedKept);
check('update: package version bumped', newVersion === 'v2-rebuild', newVersion);

// -------------------------------------------------- 7. replay + revoke (v2)
const verifyOpts = { scenesDir: SCENES_DIR, expectedFp };
const thumbReport = verifyPackage(pkgR, Object.assign({}, verifyOpts, { thumbnailOnly: true }));
check('replay/v2: static thumbnail (frame 0) hides the defect — all clips pass',
  thumbReport.revoked.length === 0 && thumbReport.publishable.length === 3);
const report2 = verifyPackage(pkgR, verifyOpts);
check('replay/v2: the affected binocular pair is revoked',
  report2.revoked.join(',') === 'alley' && report2.clips.alley.status === 'revoked');
check('replay/v2: rotating meridian marker exposes the temporal misalignment',
  !findCheck(report2, 'alley', 'content-time').pass &&
  report2.clips.alley.badFrames.some((b) =>
    b.problem === 'content-time' && b.frame === MID && b.stampL === MID && b.stampR === DONOR &&
    Math.abs(b.meridianL - 59.2) < 1.5 && Math.abs(b.meridianR - 68.8) < 1.5),
  JSON.stringify(report2.clips.alley.badFrames.find((b) => b.problem === 'content-time')));
check('replay/v2: frame integrity pinpoints the donor frame (R half is actually frame 12)',
  report2.clips.alley.badFrames.some((b) => b.problem === 'frame-integrity' && b.frame === MID && b.eye === 'R' && b.actualFrame === DONOR));
check('replay/v2: packaged fingerprint sheet no longer matches content (unrecorded replacement)',
  !findCheck(report2, 'alley', 'packaged-fingerprints').pass);
check('replay/v2: clips not referencing the bad frame stay publishable',
  report2.publishable.indexOf('harbor') !== -1 && report2.publishable.indexOf('roof') !== -1 &&
  report2.clips.harbor.checks.every((c) => c.pass) && report2.clips.roof.checks.every((c) => c.pass));

// ---------------------------------------------------------- 8. fix + repack
const pkgV3 = path.join(PKG_ROOT, 'v3-rebuild');
pack(Object.assign({}, basePackOpts, { outDir: pkgV3, resolution: 'rebuild', version: 'v3-rebuild' }));
const report3 = verifyPackage(pkgV3, verifyOpts);
check('fix: repacked package replays clean — no pair revoked',
  report3.revoked.length === 0 && report3.publishable.join(',') === 'alley,harbor,roof');
check('fix: eye order verified on every published clip',
  ['alley', 'harbor', 'roof'].every((id) => findCheck(report3, id, 'eye-order').pass));
check('fix: frame counts verified on every published clip',
  ['alley', 'harbor', 'roof'].every((id) => findCheck(report3, id, 'frame-count').pass));
check('fix: content time consistent again across all frames',
  ['alley', 'harbor', 'roof'].every((id) => findCheck(report3, id, 'content-time').pass));

// ---------------------------------------------------------- 9. idempotency
const pkgV3b = path.join(PKG_ROOT, 'v3-repeat');
pack(Object.assign({}, basePackOpts, { outDir: pkgV3b, resolution: 'rebuild', version: 'v3-rebuild' }));
const filesEqual = (rel) => fs.readFileSync(path.join(pkgV3, rel)).equals(fs.readFileSync(path.join(pkgV3b, rel)));
let framesEqual = true;
for (const id of ['alley', 'harbor', 'roof']) {
  for (let f = 0; f < scenes[id].frames; f++) {
    const rel = path.join('clips', id, 'f' + String(f).padStart(4, '0') + '.png');
    if (!filesEqual(rel)) framesEqual = false;
  }
}
check('idempotency: repeated packaging is byte-identical (playlist, fingerprints, frames)',
  filesEqual('playlist.json') && filesEqual('fingerprints.json') && framesEqual);

// ---------------------------------------------------------------- summary
const pass = results.filter((r) => r.pass).length;
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
