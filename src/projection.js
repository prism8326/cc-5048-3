/*
 * projection.js — pure projection math, shared by the WebGL renderer (CPU
 * uniform preparation), the procedural asset generator and the Node tests.
 *
 * World coordinate convention (explicit, not assumed):
 *   X = right (east), Y = up, Z = backward.
 *   ERP (equirectangular) column u=0 starts at the longitude that points
 *   along +Z; increasing u rotates toward +X unless longitudeDir is -1.
 *   ERP row v=0 is the north pole (+Y) unless latitudeDir is -1.
 *   Yaw 0 looks toward +Z; positive yaw turns the view toward +X.
 *
 * All functions are dependency free so they run under Node as well.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PV = Object.assign(root.PV || {}, api);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  const DEG = Math.PI / 180;

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function wrapPi(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }
  function wrapUnit(u) {
    u = u - Math.floor(u);
    return u < 0 ? u + 1 : u;
  }

  // Longitude/latitude (radians) -> unit direction in the world frame.
  function lonlatToDir(lon, lat, out) {
    const cl = Math.cos(lat);
    out = out || [0, 0, 0];
    out[0] = cl * Math.sin(lon);
    out[1] = Math.sin(lat);
    out[2] = cl * Math.cos(lon);
    return out;
  }

  // Unit direction -> longitude in [-pi, pi], latitude in [-pi/2, pi/2].
  function dirToLonlat(d) {
    const lat = Math.asin(clamp(d[1], -1, 1));
    const lon = Math.atan2(d[0], d[2]);
    return [wrapPi(lon), lat];
  }

  // Rotate a world-space direction by yaw (Y), pitch (X), roll (Z), applied
  // as intrinsic YXZ to the camera frame and inverted for world rays.
  function rotateY(v, a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
  }
  // Right-handed rotations about the world axes. Positive pitch rotates the
  // forward (local +Z) axis upward toward +Y, so the X rotation sends
  // +Z -> (0, +sin a, cos a); the matrix below is the standard Rx with the
  // sign chosen so cameraBasis().fwd gains +Y for positive pitch.
  function rotateX(v, a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [v[0], c * v[1] + s * v[2], -s * v[1] + c * v[2]];
  }
  function rotateZ(v, a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
  }

  // Camera basis: columns are right / up / forward in world coordinates.
  function cameraBasis(yaw, pitch, roll) {
    const Ry = [
      [Math.cos(yaw), 0, Math.sin(yaw)],
      [0, 1, 0],
      [-Math.sin(yaw), 0, Math.cos(yaw)]
    ];
    // Rx shares the convention of rotateX(): positive pitch lifts +Z to +Y.
    const Rx = [
      [1, 0, 0],
      [0, Math.cos(pitch), Math.sin(pitch)],
      [0, -Math.sin(pitch), Math.cos(pitch)]
    ];
    const Rz = [
      [Math.cos(roll), -Math.sin(roll), 0],
      [Math.sin(roll), Math.cos(roll), 0],
      [0, 0, 1]
    ];
    const mul = (A, B) => [
      [A[0][0] * B[0][0] + A[0][1] * B[1][0] + A[0][2] * B[2][0],
       A[0][0] * B[0][1] + A[0][1] * B[1][1] + A[0][2] * B[2][1],
       A[0][0] * B[0][2] + A[0][1] * B[1][2] + A[0][2] * B[2][2]],
      [A[1][0] * B[0][0] + A[1][1] * B[1][0] + A[1][2] * B[2][0],
       A[1][0] * B[0][1] + A[1][1] * B[1][1] + A[1][2] * B[2][1],
       A[1][0] * B[0][2] + A[1][1] * B[1][2] + A[1][2] * B[2][2]],
      [A[2][0] * B[0][0] + A[2][1] * B[1][0] + A[2][2] * B[2][0],
       A[2][0] * B[0][1] + A[2][1] * B[1][1] + A[2][2] * B[2][1],
       A[2][0] * B[0][2] + A[2][1] * B[1][2] + A[2][2] * B[2][2]]
    ];
    const R = mul(mul(Ry, Rx), Rz);
    return { right: [R[0][0], R[1][0], R[2][0]], up: [R[0][1], R[1][1], R[2][1]], fwd: [R[0][2], R[1][2], R[2][2]] };
  }

  // ndc: [x,y] in [-1,1]. vfov is the full vertical field of view in radians.
  // aspect = viewport width / height. Returns a world-space unit ray.
  function rayForPixel(ndc, vfov, aspect, yaw, pitch, roll, eyeX, out) {
    const t = Math.tan(vfov / 2);
    const d = [ndc[0] * t * aspect, ndc[1] * t, 1];
    const len = Math.hypot(d[0], d[1], d[2]);
    d[0] /= len; d[1] /= len; d[2] /= len;
    const b = cameraBasis(yaw, pitch, roll);
    out = out || [0, 0, 0];
    out[0] = d[0] * b.right[0] + d[1] * b.up[0] + d[2] * b.fwd[0] + eyeX * 1;
    out[1] = d[0] * b.right[1] + d[1] * b.up[1] + d[2] * b.fwd[1];
    out[2] = d[0] * b.right[2] + d[1] * b.up[2] + d[2] * b.fwd[2];
    // eyeX shifts the ray ORIGIN along world X; direction itself stays as
    // the rotated local ray. Return the pair via out plus origin side field.
    const dir = [
      d[0] * b.right[0] + d[1] * b.up[0] + d[2] * b.fwd[0],
      d[0] * b.right[1] + d[1] * b.up[1] + d[2] * b.fwd[1],
      d[0] * b.right[2] + d[1] * b.up[2] + d[2] * b.fwd[2]
    ];
    out.origin = [eyeX, 0, 0];
    out.dir = dir;
    return out;
  }

  // Map a world-space ray direction to ERP texture coordinates with the
  // declared source coordinate convention. Wrapping (longitude seam) is
  // handled with wrapUnit; polar rows clamp naturally through asin.
  function dirToErpUV(dir, longitudeDir, latitudeDir) {
    const ll = dirToLonlat(dir);
    const lon = ll[0], lat = ll[1];
    let u = (longitudeDir === -1 ? (-lon) : lon) / (2 * Math.PI) + 0.5;
    let v = 0.5 - (latitudeDir === -1 ? (-lat) : lat) / Math.PI;
    return [wrapUnit(u), clamp(v, 0, 1)];
  }

  // Inverse: ERP texel centre -> world direction (used by the generator and
  // by the CPU reference tests).
  function erpUVToDir(u, v, longitudeDir, latitudeDir) {
    const lon = longitudeDir === -1 ? -(wrapUnit(u) - 0.5) * 2 * Math.PI : (wrapUnit(u) - 0.5) * 2 * Math.PI;
    const lat0 = (0.5 - clamp(v, 0, 1)) * Math.PI;
    const lat = latitudeDir === -1 ? -lat0 : lat0;
    return lonlatToDir(wrapPi(lon), clamp(lat, -Math.PI / 2, Math.PI / 2));
  }

  // Sub-rectangle of the source atlas occupied by one eye, in texture
  // coordinates plus a normalised width/height. Sampling is always clamped to
  // this rect, so a viewport can never reach into the other eye's region.
  function eyeSubRect(layout, eyeOrder, which) {
    // which is 'L' or 'R'; eyeOrder maps declared eye to atlas slot 0/1.
    const slot = eyeOrder === 'LR' ? (which === 'L' ? 0 : 1) : (which === 'L' ? 1 : 0);
    if (layout === 'sbs') {
      return slot === 0 ? { u0: 0, v0: 0, du: 0.5, dv: 1 } : { u0: 0.5, v0: 0, du: 0.5, dv: 1 };
    }
    // top-bottom: atlas slot 0 is the TOP half by convention.
    return slot === 0 ? { u0: 0, v0: 0, du: 1, dv: 0.5 } : { u0: 0, v0: 0.5, du: 1, dv: 0.5 };
  }

  // Given a normalised UV inside one eye's 2:1 ERP face, return the absolute
  // atlas UV. Values outside [0,1] in u wrap the seam; v clamps at the poles.
  function eyeUVToAtlas(faceUV, rect) {
    const u = rect.u0 + wrapUnit(faceUV[0]) * rect.du;
    const v = rect.v0 + clamp(faceUV[1], 0, 1) * rect.dv;
    return [u, v];
  }

  // Inverse of the ODS (omnidirectional stereo) dense-camera capture model.
  //
  // Capture model (explicit, mirrored exactly by renderOdsFace in
  // generator.js and by odsFaceUV() in the shader): N perspective cameras per
  // eye sit on a ring of radius r = ipd/2 in the XZ plane. Camera k has
  // azimuth thetaP (left: thetaP = 2*pi*k/N; right: +pi) and ring origin
  //     o(thetaP) = s * r * (-sin thetaP, 0, cos thetaP),   s = +1 left / -1 right
  // and looks tangentially outward along
  //     fwd(thetaP) = -s * (-sin thetaP, 0, cos thetaP),
  // with right = (fwd.z, 0, -fwd.x). It records the horizontal angle beta in
  // [-pi/N, +pi/N] into ERP column longitude thetaP + beta.
  //
  // Inverse: for a requested view ray d we find the tangent camera whose
  // recorded ray (origin o, direction d) exists, i.e. d is perpendicular to
  // that camera's radial vector. Solving d . radial(thetaP) = 0 yields the
  // column. Every non-polar direction has exactly one such camera, so in the
  // dense limit there is no horizontal clipping; the finite discrete capture
  // (N cameras) is represented by ringHalfFov = pi/N and only flags rays that
  // fall in the tiny gap between two discrete cameras. The pure vertical
  // poles have no horizontal tangent and are the true degenerate case.
  function odsRemap(worldDir, yaw, s, ringHalfFov) {
    const horiz = Math.hypot(worldDir[0], worldDir[2]);
    const gamma = Math.atan2(worldDir[1], horiz);
    const phi = Math.atan2(worldDir[0], worldDir[2]);
    // The generator stores, in column thetaP, the ray from the tangent ring
    // origin whose direction has azimuth thetaP - s*pi/2. Inverting for a
    // requested azimuth phi gives the source column directly.
    const thetaP = phi + s * Math.PI / 2;
    const lon = wrapPi(thetaP);
    // Dense tangent coverage represents every horizontal direction; the exact
    // vertical poles (no horizontal tangent) are the degenerate case.
    const clipped = horiz < 1e-4;
    return { lon, lat: clamp(gamma, -Math.PI / 2, Math.PI / 2), clipped, thetaP };
  }

  function lonlatToFaceUV(lon, lat, longitudeDir, latitudeDir) {
    let u = (longitudeDir === -1 ? (-lon) : lon) / (2 * Math.PI) + 0.5;
    // CPU/canvas row order: v=0 is the top row (north pole, +Y), matching
    // dirToErpUV(). erpUVToDir() inverts this same convention.
    let v = 0.5 - (latitudeDir === -1 ? (-lat) : lat) / Math.PI;
    return [wrapUnit(u), clamp(v, 0, 1)];
  }

  // Validate an uploaded atlas against its declared layout. The check only
  // judges geometry; semantic "missing eye" cases are reported separately by
  // the caller (e.g. a mono 2:1 texture declared as SBS).
  function validateAtlas(width, height, layout) {
    const problems = [];
    if (!width || !height) { problems.push('zero-size texture'); return { ok: false, problems }; }
    // A single ERP face is 2:1. SBS places two faces side by side (atlas
    // 4:1), TB stacks them (atlas 1:1). Tolerance is relative.
    const ratioErr = (w, h, target) => Math.abs(w / h - target) / target;
    if (layout === 'sbs') {
      if (ratioErr(width, height, 4) > 0.03) {
        problems.push(`SBS atlas ${width}x${height}: two 2:1 ERP faces side by side need a 4:1 atlas`);
      }
      if (width % 2 !== 0) problems.push('SBS atlas width is odd; the two eyes cannot be split pixel-exactly');
    } else if (layout === 'tb') {
      if (ratioErr(width, height, 1) > 0.03) {
        problems.push(`TB atlas ${width}x${height}: two 2:1 ERP faces stacked need a 1:1 atlas`);
      }
      if (height % 2 !== 0) problems.push('TB atlas height is odd; the two eyes cannot be split pixel-exactly');
    } else if (layout === 'mono') {
      if (ratioErr(width, height, 2) > 0.03) {
        problems.push(`mono texture ${width}x${height} is not a 2:1 ERP face`);
      }
    }
    return { ok: problems.length === 0, problems };
  }

  return {
    DEG, clamp, wrapPi, wrapUnit,
    lonlatToDir, dirToLonlat,
    rotateY, rotateX, rotateZ, cameraBasis,
    rayForPixel,
    dirToErpUV, erpUVToDir, lonlatToFaceUV,
    eyeSubRect, eyeUVToAtlas,
    odsRemap,
    validateAtlas
  };
});
