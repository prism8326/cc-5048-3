/*
 * slate.js — the clapperboard image (打板图) carried by v2 sample clips.
 * The eye mark is a 5x7 bitmap glyph drawn at a fixed position; the reader
 * scores the sampled cells against both templates, so the eye convention
 * lives in the image itself, not in the filename.
 */
'use strict';

const GLYPHS = {
  L: [
    '#....',
    '#....',
    '#....',
    '#....',
    '#....',
    '#....',
    '#####'
  ],
  R: [
    '###..',
    '#..#.',
    '#..#.',
    '###..',
    '#.#..',
    '#..#.',
    '#..#.'
  ]
};

const SLATE_W = 64;
const SLATE_H = 32;
const SCALE = 2;
const ORIGIN_X = 6;
const ORIGIN_Y = 9;

function setPx(img, x, y, rgb) {
  const i = (y * img.width + x) * 4;
  img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = 255;
}

function writeSlate(eye) {
  if (!GLYPHS[eye]) throw new Error('slate eye must be L or R, got ' + eye);
  const img = { width: SLATE_W, height: SLATE_H, data: Buffer.alloc(SLATE_W * SLATE_H * 4) };
  for (let y = 0; y < SLATE_H; y++) {
    for (let x = 0; x < SLATE_W; x++) {
      const border = x === 0 || y === 0 || x === SLATE_W - 1 || y === SLATE_H - 1;
      setPx(img, x, y, border ? [220, 220, 220] : [16, 18, 28]);
    }
  }
  const glyph = GLYPHS[eye];
  for (let gy = 0; gy < 7; gy++) {
    for (let gx = 0; gx < 5; gx++) {
      if (glyph[gy][gx] !== '#') continue;
      for (let sy = 0; sy < SCALE; sy++) {
        for (let sx = 0; sx < SCALE; sx++) {
          setPx(img, ORIGIN_X + gx * SCALE + sx, ORIGIN_Y + gy * SCALE + sy, [240, 240, 240]);
        }
      }
    }
  }
  return img;
}

// Returns 'L' | 'R'. Throws when neither template matches convincingly.
function readSlateEye(img) {
  const scores = {};
  for (const eye of ['L', 'R']) {
    let match = 0;
    const glyph = GLYPHS[eye];
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        const x = ORIGIN_X + gx * SCALE + (SCALE >> 1);
        const y = ORIGIN_Y + gy * SCALE + (SCALE >> 1);
        const i = (y * img.width + x) * 4;
        const on = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3 > 128;
        if (on === (glyph[gy][gx] === '#')) match++;
      }
    }
    scores[eye] = match;
  }
  const total = 35;
  const best = scores.L >= scores.R ? 'L' : 'R';
  const margin = Math.abs(scores.L - scores.R);
  if (scores[best] < total - 2 || margin < 4) {
    throw new Error(`slate eye mark unreadable (L=${scores.L} R=${scores.R})`);
  }
  return best;
}

module.exports = { GLYPHS, SLATE_W, SLATE_H, writeSlate, readSlateEye };
