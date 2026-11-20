/*
 * update.js — incremental package update that replaces ONLY the right-eye
 * half of one middle frame with the right eye of a different frame of the
 * same clip. The donor content is a valid right-eye frame, so the still
 * thumbnail (frame 0, untouched) and every static check keep passing; only
 * the rotating meridian marker (and the frame stamp) reveals that the two
 * eyes of that frame carry different content times. The packaged
 * fingerprints are deliberately NOT refreshed, which is exactly the kind of
 * inconsistency the verifier is meant to catch.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const png = require('./png');
const sceneMod = require('./scene');
const pack = require('./pack');

function replaceRightEyeFrame(packageDir, scene, clipId, frameIndex, donorIndex) {
  const clipDir = path.join(packageDir, 'clips', clipId);
  const targetFile = path.join(clipDir, pack.frameName(frameIndex));
  const donorFile = path.join(clipDir, pack.frameName(donorIndex));

  const target = sceneMod.splitAtlas(scene, png.decodePNG(fs.readFileSync(targetFile)));
  const donor = sceneMod.splitAtlas(scene, png.decodePNG(fs.readFileSync(donorFile)));
  const merged = sceneMod.composeAtlas(scene, target.L, donor.R);
  fs.writeFileSync(targetFile, png.encodePNG(merged.width, merged.height, merged.data));

  const playlistFile = path.join(packageDir, 'playlist.json');
  const playlist = JSON.parse(fs.readFileSync(playlistFile, 'utf8'));
  playlist.version = playlist.version.replace(/v(\d+)/, (m, n) => 'v' + (Number(n) + 1));
  playlist.updates = (playlist.updates || []).concat([
    { clip: clipId, frame: frameIndex, eye: 'R', note: 'single-frame refresh' }
  ]);
  fs.writeFileSync(playlistFile, JSON.stringify(playlist, null, 2) + '\n');
  return playlist.version;
}

module.exports = { replaceRightEyeFrame };
