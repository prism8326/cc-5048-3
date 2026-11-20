/*
 * legacy.js — reader for the old cross-version manifests.
 *   v1 convention: the eye is encoded in the clip directory name
 *     (alley_L, take07-right, ...).
 *   v2 convention: clip names are neutral; the eye exists only as the mark
 *     on the slate image (打板图) inside each clip directory.
 * The reader surfaces BOTH signals per clip when both exist and flags a
 * conflict instead of silently picking one.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const png = require('./png');
const slate = require('./slate');

function parseFilenameEye(name) {
  const m = name.match(/(?:^|[_\-.])(L|R|left|right)(?=$|[_\-.])/i);
  if (!m) return null;
  return /^l/i.test(m[1]) ? 'L' : 'R';
}

function readSlateFile(clipDir) {
  const file = path.join(clipDir, 'slate.png');
  if (!fs.existsSync(file)) return null;
  return slate.readSlateEye(png.decodePNG(fs.readFileSync(file)));
}

function readManifestV1(incomingDir, manifest) {
  const entries = [];
  for (const seg of manifest.segments) {
    for (const clip of seg.clips) {
      const eye = parseFilenameEye(clip);
      if (!eye) throw new Error(`v1 clip name carries no eye mark: ${clip}`);
      entries.push({
        segment: seg.segment, clip, dir: path.join(incomingDir, clip),
        filenameEye: eye, slateEye: null, eye, eyeSource: 'filename', conflict: null
      });
    }
  }
  return entries;
}

function readManifestV2(incomingDir, manifest) {
  const entries = [];
  for (const seg of manifest.segments) {
    for (const clip of seg.clips) {
      const dir = path.join(incomingDir, clip);
      const slateEye = readSlateFile(dir);
      if (!slateEye) throw new Error(`v2 clip has no readable slate: ${clip}`);
      const filenameEye = parseFilenameEye(clip);
      const conflict = filenameEye && filenameEye !== slateEye
        ? `filename says ${filenameEye}, slate says ${slateEye}` : null;
      entries.push({
        segment: seg.segment, clip, dir,
        filenameEye, slateEye, eye: slateEye, eyeSource: 'slate', conflict
      });
    }
  }
  return entries;
}

// Reads every legacy manifest under <incomingDir>/legacy and returns the
// merged entry list (each entry still records where its eye label came from).
function readBatch(incomingDir) {
  const legacyDir = path.join(incomingDir, 'legacy');
  const entries = [];
  for (const file of fs.readdirSync(legacyDir).sort()) {
    const manifest = JSON.parse(fs.readFileSync(path.join(legacyDir, file), 'utf8'));
    if (manifest.version === 1) entries.push(...readManifestV1(incomingDir, manifest));
    else if (manifest.version === 2) entries.push(...readManifestV2(incomingDir, manifest));
    else throw new Error(`unsupported legacy manifest version in ${file}`);
  }
  return entries;
}

module.exports = { parseFilenameEye, readManifestV1, readManifestV2, readBatch };
