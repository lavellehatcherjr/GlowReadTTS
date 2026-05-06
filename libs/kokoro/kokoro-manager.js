/**
 * Manages the AI voice inference Web Worker and audio playback.
 *
 * Responsibilities:
 *   - lazily spawn the worker
 *   - relay download / generation messages
 *   - own the <Audio> element so pause/resume/stop work without coordination
 *   - free RAM on demand by tearing down the worker entirely
 */

const MODEL_CACHE_KEYS = [
  // transformers.js stores weights here
  'transformers-cache',
  // kokoro-js stores voice embeddings here
  'kokoro-voices'
];

class KokoroManager {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.audio = null;
    this._initPromise = null;
  }

  async isModelCached() {
    try {
      for (const key of MODEL_CACHE_KEYS) {
        const cache = await caches.open(key);
        const keys = await cache.keys();
        if (keys.length === 0) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Trigger model download. onProgress is called with (loadedBytes, totalBytes)
   * for each chunk that streams in.
   */
  async downloadModel(onProgress) {
    this._ensureWorker();
    return new Promise((resolve, reject) => {
      const handler = (e) => {
        const data = e.data || {};
        if (data.event === 'DOWNLOAD_PROGRESS' && onProgress) {
          onProgress(data.loaded, data.total, data.file);
        } else if (data.event === 'READY') {
          this.worker.removeEventListener('message', handler);
          this.ready = true;
          resolve();
        } else if (data.event === 'ERROR') {
          this.worker.removeEventListener('message', handler);
          reject(new Error(data.message));
        }
      };
      this.worker.addEventListener('message', handler);
      this.worker.postMessage({ action: 'INIT' });
    });
  }

  /**
   * Generate speech and start playback. Resolves to the playing Audio element
   * so the caller can attach timeupdate / ended listeners for highlight sync.
   */
  async generate(text, voice, speed) {
    if (!this.ready) {
      await this._init();
    }
    return new Promise((resolve, reject) => {
      const handler = (e) => {
        const data = e.data || {};
        if (data.event === 'AUDIO_READY') {
          this.worker.removeEventListener('message', handler);
          const blob = new Blob([data.audioBuffer], { type: 'audio/wav' });
          const url = URL.createObjectURL(blob);
          this.stop();
          this.audio = new Audio(url);
          // playback rate is 1.0 because speed is baked into the generated samples
          this.audio.playbackRate = 1.0;
          this.audio.play().catch(err => reject(err));
          resolve(this.audio);
        } else if (data.event === 'ERROR') {
          this.worker.removeEventListener('message', handler);
          reject(new Error(data.message));
        }
      };
      this.worker.addEventListener('message', handler);
      this.worker.postMessage({ action: 'GENERATE', text: text, voice: voice, speed: speed });
    });
  }

  pause() { if (this.audio && !this.audio.paused) this.audio.pause(); }

  resume() { if (this.audio && this.audio.paused) this.audio.play(); }

  stop() {
    if (this.audio) {
      try { this.audio.pause(); } catch (e) { /* ignore */ }
      try { this.audio.currentTime = 0; } catch (e) { /* ignore */ }
      if (this.audio.src && this.audio.src.startsWith('blob:')) {
        URL.revokeObjectURL(this.audio.src);
      }
      this.audio = null;
    }
  }

  /** Release the ONNX session inside the worker but keep the worker alive. */
  dispose() {
    this.stop();
    if (this.worker) {
      this.worker.postMessage({ action: 'DISPOSE' });
    }
    this.ready = false;
    this._initPromise = null;
  }

  /** Tear down the worker entirely — frees the WASM heap back to the OS. */
  terminate() {
    this.stop();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
    this._initPromise = null;
  }

  async clearCache() {
    for (const key of MODEL_CACHE_KEYS) {
      try { await caches.delete(key); } catch (e) { /* ignore */ }
    }
    this.terminate();
  }

  _ensureWorker() {
    if (!this.worker) {
      const url = chrome.runtime.getURL('libs/kokoro/kokoro-worker.js');
      this.worker = new Worker(url, { type: 'module' });
    }
  }

  async _init() {
    this._ensureWorker();
    if (!this._initPromise) {
      this._initPromise = new Promise((resolve, reject) => {
        const handler = (e) => {
          const data = e.data || {};
          if (data.event === 'READY') {
            this.worker.removeEventListener('message', handler);
            this.ready = true;
            resolve();
          } else if (data.event === 'ERROR') {
            this.worker.removeEventListener('message', handler);
            reject(new Error(data.message));
          }
        };
        this.worker.addEventListener('message', handler);
        this.worker.postMessage({ action: 'INIT' });
      });
    }
    return this._initPromise;
  }
}

export default KokoroManager;
