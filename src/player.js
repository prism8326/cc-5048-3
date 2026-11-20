/*
 * player.js — frame delivery for generated and user-supplied sources.
 *
 * Video rule: the two eye faces always come from the SAME video element and
 * therefore the same decoded frame. There is one texImage2D per rAF tick;
 * the renderer samples that single texture twice, so the eyes can never
 * disagree on content time.
 */
(function (root) {
  function Player(generator, renderer) {
    this.generator = generator;
    this.renderer = renderer;
    this.mode = 'generated';      // 'generated' | 'image' | 'video'
    this.video = null;
    this.image = null;
    this.frame = 0;
    this.playing = true;
    this.lastTick = 0;
    this.fps = generator.fps;
    this.onWarning = null;
    this._stream = null;
  }

  Player.prototype.useGenerated = function () {
    this.mode = 'generated';
    this.video = null;
    this.image = null;
    this.frame = 0;
    this.playing = true;
  };

  Player.prototype.useImage = function (img) {
    this.mode = 'image';
    this.image = img;
    this.video = null;
    this.playing = false;
    this.renderer.upload(img);
  };

  Player.prototype.useVideo = function (video) {
    this.mode = 'video';
    this.video = video;
    this.image = null;
    this.playing = true;
  };

  Player.prototype.makeGeneratedFrame = function (frame) {
    return this.generator.renderFrame(frame);
  };

  // Called once per animation frame. Returns the source actually uploaded
  // (canvas/image/video) so callers can read dimensions.
  Player.prototype.tick = function (now) {
    if (this.mode === 'image') return this.image;
    if (this.mode === 'video') {
      if (this.video && this.video.readyState >= 2 && this.video.videoWidth) {
        this.renderer.upload(this.video);
        return this.video;
      }
      return null;
    }
    // generated
    if (!this.playing) {
      if (!this._lastUploaded) {
        const c = this.generator.renderFrame(this.frame);
        this.renderer.upload(c);
        this._lastUploaded = c;
      }
      return this._lastUploaded;
    }
    const interval = 1000 / this.fps;
    if (!this.lastTick || now - this.lastTick >= interval) {
      this.frame++;
      const c = this.generator.renderFrame(this.frame);
      this.renderer.upload(c);
      this._lastUploaded = c;
      this.lastTick = now;
    }
    return this._lastUploaded;
  };

  Player.prototype.play = function () {
    this.playing = true;
    if (this.video && this.video.paused) this.video.play().catch(() => {});
  };
  Player.prototype.pause = function () {
    this.playing = false;
    if (this.video && !this.video.paused) this.video.pause();
  };
  Player.prototype.seek = function (frameOrTime) {
    if (this.mode === 'video') {
      this.video.currentTime = Math.min(frameOrTime, this.video.duration || 0);
    } else {
      this.frame = Math.max(0, Math.round(frameOrTime));
      const c = this.generator.renderFrame(this.frame);
      this.renderer.upload(c);
      this._lastUploaded = c;
    }
  };

  root.PVPlayer = Player;
})(typeof self !== 'undefined' ? self : globalThis);
