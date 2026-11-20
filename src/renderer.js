/*
 * renderer.js — WebGL 1 renderer for the stereo equirectangular viewer.
 *
 * Invariant enforced here: each eye is drawn into its own GL viewport with a
 * matching scissor rectangle, and its sampler rectangles stay inside that
 * eye's atlas sub-region. Nothing in the sampling math can reach across the
 * atlas boundary into the other eye, and nothing can paint across the
 * on-screen eye divider.
 */
(function (root) {
  const P = root.PV;
  const S = root.PVShaders;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('shader compile failed: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function program(gl, vsSrc, fsSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('program link failed: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  function Renderer(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true })
          || canvas.getContext('experimental-webgl', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL is not available in this browser');
    this.gl = gl;
    this.prog = program(gl, S.VERT, S.FRAG);
    this.progDiff = program(gl, S.VERT, S.FRAG_DIFF);
    this.loc = this._locations(this.prog, false);
    this.locDiff = this._locations(this.progDiff, true);

    gl.enable(gl.SCISSOR_TEST);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  Renderer.prototype._locations = function (prog, diff) {
    const gl = this.gl;
    const L = { prog };
    L.aPos = gl.getAttribLocation(prog, 'aPos');
    for (const n of ['uTex','uViewport','uEyeRect','uVfov','uAspect','uRight','uUp','uFwd',
      'uLongitudeDir','uLatitudeDir','uStereoMode','uEyeSign','uIpd','uYaw','uRingHalfFov','uClipColor']) {
      L[n] = gl.getUniformLocation(prog, n);
    }
    if (diff) L.uEyeRectOther = gl.getUniformLocation(prog, 'uEyeRectOther');
    return L;
  };

  Renderer.prototype.upload = function (source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // Flip on upload so texture v=0 is the source image's top row, matching
    // the CPU reference convention (canvas row 0 = north pole) and keeping
    // the shader math identical to projection.js. Applies to canvas, image
    // and video sources alike.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.texW = source.videoWidth || source.width;
    this.texH = source.videoHeight || source.height;
  };

  Renderer.prototype._setCommon = function (L, cfg, viewport, eyeRect, eyeSign) {
    const gl = this.gl;
    const b = P.cameraBasis(cfg.yaw, cfg.pitch, cfg.roll);
    gl.uniform1i(L.uTex, 0);
    gl.uniform2f(L.uViewport, viewport.w, viewport.h);
    gl.uniform4f(L.uEyeRect, eyeRect.u0, eyeRect.v0, eyeRect.du, eyeRect.dv);
    gl.uniform1f(L.uVfov, cfg.vfov);
    gl.uniform1f(L.uAspect, viewport.w / viewport.h);
    gl.uniform3f(L.uRight, b.right[0], b.right[1], b.right[2]);
    gl.uniform3f(L.uUp, b.up[0], b.up[1], b.up[2]);
    gl.uniform3f(L.uFwd, b.fwd[0], b.fwd[1], b.fwd[2]);
    gl.uniform1f(L.uLongitudeDir, cfg.longitudeDir);
    gl.uniform1f(L.uLatitudeDir, cfg.latitudeDir);
    gl.uniform1i(L.uStereoMode, cfg.stereoMode === 'ods' ? 1 : (cfg.mono ? 2 : 0));
    gl.uniform1i(L.uEyeSign, eyeSign);
    gl.uniform1f(L.uIpd, cfg.ipd);
    gl.uniform1f(L.uYaw, cfg.yaw);
    gl.uniform1f(L.uRingHalfFov, Math.PI / cfg.odsCameras);
    gl.uniform3f(L.uClipColor, 0.55, 0.05, 0.05);
  };

  // cfg: {layout, eyeOrder, yaw,pitch,roll,vfov,longitudeDir,latitudeDir,
  //       stereoMode, ipd, odsCameras, viewMode ('stereo'|'left'|'right'|'diff'|'mono')}
  Renderer.prototype.draw = function (cfg) {
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.scissor(0, 0, W, H);
    gl.clearColor(0.02, 0.02, 0.03, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    const rectL = P.eyeSubRect(cfg.layout, cfg.eyeOrder, 'L');
    const rectR = P.eyeSubRect(cfg.layout, cfg.eyeOrder, 'R');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf());

    const drawEye = (which, vp, rect) => {
      const sign = which === 'L' ? 1 : -1;
      gl.viewport(vp.x, vp.y, vp.w, vp.h);
      gl.scissor(vp.x, vp.y, vp.w, vp.h);
      const L = this.loc;
      gl.useProgram(L.prog);
      gl.enableVertexAttribArray(L.aPos);
      gl.vertexAttribPointer(L.aPos, 2, gl.FLOAT, false, 0, 0);
      this._setCommon(L, cfg, vp, rect, sign);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    if (cfg.viewMode === 'stereo') {
      if (cfg.layout === 'sbs') {
        drawEye('L', { x: 0, y: 0, w: W / 2, h: H }, rectL);
        drawEye('R', { x: W / 2, y: 0, w: W - W / 2, h: H }, rectR);
      } else {
        drawEye('L', { x: 0, y: H / 2, w: W, h: H - H / 2 }, rectL);
        drawEye('R', { x: 0, y: 0, w: W, h: H / 2 }, rectR);
      }
    } else if (cfg.viewMode === 'left' || cfg.viewMode === 'right') {
      const rect = cfg.viewMode === 'left' ? rectL : rectR;
      drawEye(cfg.viewMode === 'left' ? 'L' : 'R', { x: 0, y: 0, w: W, h: H }, rect);
    } else if (cfg.viewMode === 'diff') {
      gl.viewport(0, 0, W, H);
      gl.scissor(0, 0, W, H);
      const L = this.locDiff;
      gl.useProgram(L.prog);
      gl.enableVertexAttribArray(L.aPos);
      gl.vertexAttribPointer(L.aPos, 2, gl.FLOAT, false, 0, 0);
      this._setCommon(L, cfg, { w: W, h: H }, rectL, 1);
      gl.uniform4f(L.uEyeRectOther, rectR.u0, rectR.v0, rectR.du, rectR.dv);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else { // mono degradation: full viewport, whole atlas treated as one ERP
      gl.viewport(0, 0, W, H);
      gl.scissor(0, 0, W, H);
      const L = this.loc;
      gl.useProgram(L.prog);
      gl.enableVertexAttribArray(L.aPos);
      gl.vertexAttribPointer(L.aPos, 2, gl.FLOAT, false, 0, 0);
      const monoCfg = Object.assign({}, cfg, { mono: true });
      this._setCommon(L, monoCfg, { w: W, h: H }, { u0: 0, v0: 0, du: 1, dv: 1 }, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  };

  Renderer.prototype._quadBuf = function () {
    if (!this._buf) {
      const gl = this.gl;
      this._buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    }
    return this._buf;
  };

  root.PVRenderer = Renderer;
})(typeof self !== 'undefined' ? self : globalThis);
