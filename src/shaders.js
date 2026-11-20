/*
 * shaders.js — GLSL ES 1.00 sources for the equirectangular stereo viewer.
 *
 * The vertex stage emits a full-screen triangle; all projection work happens
 * per fragment so that the longitude seam and the polar regions are handled
 * analytically rather than by a tessellated sphere mesh (no "plain video
 * wrapped on a ball" approximation).
 */
(function (root) {
  const VERT = `
attribute vec2 aPos;
varying vec2 vNdc;
void main() {
  vNdc = aPos;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  const FRAG_COMMON = `
precision highp float;
varying vec2 vNdc;

uniform sampler2D uTex;
uniform vec2  uViewport;        // px size of THIS eye's viewport
uniform vec4  uEyeRect;         // xy = atlas offset, zw = atlas size of this eye
uniform float uVfov;            // full vertical fov, radians
uniform float uAspect;          // viewport width / height
uniform vec3  uRight;           // camera basis in world frame
uniform vec3  uUp;
uniform vec3  uFwd;
uniform float uLongitudeDir;    // +1 or -1
uniform float uLatitudeDir;     // +1 or -1
uniform int   uStereoMode;      // 0 parallel-erp, 1 ods, 2 mono
uniform int   uEyeSign;         // +1 left, -1 right, 0 mono
uniform float uIpd;             // interpupillary distance in world units
uniform float uYaw;
uniform float uRingHalfFov;     // ODS per-camera horizontal half fov
uniform vec3  uClipColor;

vec2 wrapPole(vec2 uv) {
  // u wraps at the longitude seam; v clamps at the poles.
  float u = fract(uv.x);
  if (u < 0.0) u += 1.0;
  float v = clamp(uv.y, 0.0, 1.0);
  return vec2(u, v);
}

vec2 faceToAtlas(vec2 faceUV) {
  vec2 f = wrapPole(faceUV);
  return uEyeRect.xy + f * uEyeRect.zw;
}

vec3 viewRayDir() {
  float t = tan(uVfov * 0.5);
  vec3 d = normalize(vec3(vNdc.x * t * uAspect, vNdc.y * t, 1.0));
  return normalize(d.x * uRight + d.y * uUp + d.z * uFwd);
}

// Parallel ERP: the eye offset is baked into each face, so sampling only
// needs the viewer direction expressed in ERP coordinates. Textures are
// uploaded with UNPACK_FLIP_Y_WEBGL, so texture v matches the source-image
// (and CPU reference) convention: v=0 top row / north pole, v = 0.5+lat/pi.
vec2 parallelErpUV(vec3 dir) {
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  // GLSL atan(y,x) and JS Math.atan2(y,x) share the same argument order.
  // Longitude is atan2(X, Z) in both. (Verified headlessly.)
  float lon = atan(dir.x, dir.z);
  float u = (uLongitudeDir < 0.0 ? -lon : lon) / 6.28318530718 + 0.5;
  float v = 0.5 + (uLatitudeDir < 0.0 ? -lat : lat) / 3.14159265359;
  return vec2(u, v);
}

// ODS inverse capture model, mirroring PV.odsRemap in projection.js and the
// per-pixel tangent-camera renderer in generator.js. Column thetaP stores the
// tangent-origin ray whose world azimuth is thetaP - s*pi/2, so a requested
// ray of azimuth phi is fetched from column thetaP = phi + s*pi/2. Only the
// degenerate vertical poles clip.
vec4 odsFaceUV(vec3 dir) {
  float s = float(uEyeSign);
  float horiz = length(dir.xz);
  float phi = atan(dir.x, dir.z);
  float thetaP = phi + s * 1.57079632679;
  float gamma = atan(dir.y, horiz);
  float clip = (horiz < 1e-4) ? 1.0 : 0.0;
  float lon = atan(sin(thetaP), cos(thetaP));
  float u = (uLongitudeDir < 0.0 ? -lon : lon) / 6.28318530718 + 0.5;
  float v = 0.5 + (uLatitudeDir < 0.0 ? -gamma : gamma) / 3.14159265359;
  return vec4(u, v, clip, 0.0);
}
`;

  const FRAG = FRAG_COMMON + `
void main() {
  vec3 dir = viewRayDir();
  vec2 faceUV;
  float clip = 0.0;
  if (uStereoMode == 1) {
    vec4 r = odsFaceUV(dir);
    faceUV = r.xy;
    clip = r.z;
  } else {
    faceUV = parallelErpUV(dir);
  }
  if (clip > 0.5) {
    gl_FragColor = vec4(uClipColor, 1.0);
    return;
  }
  vec2 atlasUV = faceToAtlas(faceUV);
  gl_FragColor = texture2D(uTex, atlasUV);
}`;

  // Difference view renders |left - right| of the SAME view direction using
  // both sub-rectangles of the atlas. It is a verification aid: identical
  // backgrounds cancel to black while real stereo content stays bright.
  const FRAG_DIFF = FRAG_COMMON + `
uniform vec4 uEyeRectOther;
void main() {
  vec3 dir = viewRayDir();
  vec2 faceUV;
  if (uStereoMode == 1) {
    vec4 r = odsFaceUV(dir);
    if (r.z > 0.5) { gl_FragColor = vec4(uClipColor, 1.0); return; }
    faceUV = r.xy;
  } else {
    faceUV = parallelErpUV(dir);
  }
  vec2 f = wrapPole(faceUV);
  vec3 a = texture2D(uTex, uEyeRect.xy + f * uEyeRect.zw).rgb;
  vec3 b = texture2D(uTex, uEyeRectOther.xy + f * uEyeRectOther.zw).rgb;
  float d = length(abs(a - b));
  gl_FragColor = vec4(vec3(d), 1.0);
}`;

  if (typeof module === 'object' && module.exports) module.exports = { VERT, FRAG, FRAG_DIFF };
  if (root) root.PVShaders = { VERT, FRAG, FRAG_DIFF };
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : null));
