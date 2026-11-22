/**
 * Module Tạo giọng đọc tiếng Việt & Đồng bộ mốc thời gian (Giai đoạn 5)
 * - Chế độ 1: AI TTS Tiếng Việt Offline (Xenova/mms-tts-vie ~38MB qua Web Worker)
 * - Chế độ 2: Proxy Edge-TTS miễn phí (Giọng Hoài My / Nam Minh nếu tự cấu hình URL)
 * - Chế độ 3: Nhập file âm thanh lồng tiếng sẵn (MP3/WAV)
 * - Điều chỉnh tốc độ giữ nguyên cao độ giọng (WSOLA), âm lượng và đồng bộ khớp SRT
 */

import { secondsToSrtTime } from './subtitle.js';

const VOICE_PREF_KEY = 'kaito_review_ai_voice_pref_v1';

function loadVoicePrefs() {
  try {
    return {
      engine: 'mms_offline',
      voiceName: 'vi-VN-HoaiMyNeural',
      proxyUrl: '',
      speed: 1.05,
      volume: 1.0,
      syncMode: 'autofit',
      ...JSON.parse(localStorage.getItem(VOICE_PREF_KEY) || '{}')
    };
  } catch {
    return {
      engine: 'mms_offline',
      voiceName: 'vi-VN-HoaiMyNeural',
      proxyUrl: '',
      speed: 1.05,
      volume: 1.0,
      syncMode: 'autofit'
    };
  }
}

function saveVoicePrefs(prefs) {
  try {
    localStorage.setItem(VOICE_PREF_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

function formatSec(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/**
 * Thay đổi tốc độ đọc GIỮ NGUYÊN CAO ĐỘ GIỌNG (WSOLA gọn nhẹ thuần JS)
 */
function timeStretchWSOLA(input, rate, sampleRate) {
  if (!input || input.length === 0) return new Float32Array(0);
  if (Math.abs(rate - 1.0) < 0.02) return input;

  const clampedRate = Math.max(0.65, Math.min(1.65, rate));
  const win = Math.max(256, Math.round(sampleRate * 0.032) & ~1);
  if (input.length <= win * 2) return input;

  const hs = win >> 1;
  const delta = Math.round(sampleRate * 0.008);
  const outLen = Math.max(win, Math.round(input.length / clampedRate));

  const hann = new Float32Array(win);
  for (let i = 0; i < win; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (win - 1)));
  }

  const out = new Float32Array(outLen + win);
  const norm = new Float32Array(outLen + win);

  let prevInPos = 0;

  for (let outPos = 0; outPos < outLen; outPos += hs) {
    const nominalPos = Math.round(outPos * clampedRate);
    let bestPos = nominalPos;

    if (outPos > 0) {
      const naturalPos = prevInPos + hs;
      const minPos = Math.max(0, nominalPos - delta);
      const maxPos = Math.min(input.length - win, nominalPos + delta);

      if (naturalPos + hs < input.length && maxPos > minPos) {
        let bestCorr = -Infinity;
        for (let cand = minPos; cand <= maxPos; cand += 2) {
          let corr = 0;
          for (let k = 0; k < hs; k += 2) {
            corr += input[naturalPos + k] * input[cand + k];
          }
          if (corr > bestCorr) {
            bestCorr = corr;
            bestPos = cand;
          }
        }
      }
    }

    bestPos = Math.max(0, Math.min(input.length - win, bestPos));
    prevInPos = bestPos;

    for (let i = 0; i < win; i++) {
      const w = hann[i];
      out[outPos + i] += input[bestPos + i] * w;
      norm[outPos + i] += w;
    }
  }

  const result = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    result[i] = norm[i] > 1e-4 ? out[i] / norm[i] : out[i];
  }
  return result;
}

function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = input[idx] || 0;
    const s1 = input[Math.min(idx + 1, input.length - 1)] || 0;
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

export function encodeWavBlob(samples, sampleRate) {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

async function decodeAudioBlobToMono(blob, targetRate = 16000) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate: targetRate });
  try {
    const buf = await blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(buf);
    const mono = new Float32Array(decoded.length);
    if (decoded.numberOfChannels === 1) {
      mono.set(decoded.getChannelData(0));
    } else {
      const c0 = decoded.getChannelData(0);
      const c1 = decoded.getChannelData(1);
      for (let i = 0; i < decoded.length; i++) mono[i] = (c0[i] + c1[i]) * 0.5;
    }
    return { audio: mono, samplingRate: decoded.sampleRate };
  } finally {
    await ctx.close().catch(() => {});
  }
}

export class VoiceManager {
  constructor(elements, appState, callbacks = {}) {
    this.el = elements;
    this.appState = appState;
    this.callbacks = callbacks;

    this.prefs = loadVoicePrefs();
    this.worker = null;
    this.isRunning = false;
    this.abortController = null;

    // Lưu clip gốc từng câu theo index: Map<number, { audio: Float32Array, samplingRate: number }>
    this.lineClips = new Map();
    this.masterAudioUrl = null;
    this.previewAudioEl = new Audio();
    this.previewBlobUrl = null;

    this.applyPrefsToUI();
    this.bindEvents();
    this.refresh();
  }

  applyPrefsToUI() {
    this.el.engineSelect.value = this.prefs.engine;
    this.el.voiceNameSelect.value = this.prefs.voiceName;
    this.el.proxyUrlInput.value = this.prefs.proxyUrl;
    this.el.speedRange.value = String(this.prefs.speed);
    this.el.speedValue.textContent = `${Number(this.prefs.speed).toFixed(2)}x`;
    this.el.volumeRange.value = String(Math.round(this.prefs.volume * 100));
    this.el.volumeValue.textContent = `${Math.round(this.prefs.volume * 100)}%`;
    this.el.syncModeSelect.value = this.prefs.syncMode;
    this.toggleProxySettings();
  }

  toggleProxySettings() {
    const isProxy = this.el.engineSelect.value === 'custom_proxy';
    this.el.proxySettings.classList.toggle('hidden', !isProxy);
  }

  bindEvents() {
    this.el.engineSelect.addEventListener('change', (e) => {
      this.prefs.engine = e.target.value;
      saveVoicePrefs(this.prefs);
      this.toggleProxySettings();
      this.clearError();
    });

    this.el.voiceNameSelect.addEventListener('change', (e) => {
      this.prefs.voiceName = e.target.value;
      saveVoicePrefs(this.prefs);
    });

    this.el.proxyUrlInput.addEventListener('input', (e) => {
      this.prefs.proxyUrl = e.target.value.trim();
      saveVoicePrefs(this.prefs);
    });

    this.el.speedRange.addEventListener('input', (e) => {
      this.prefs.speed = parseFloat(e.target.value);
      this.el.speedValue.textContent = `${this.prefs.speed.toFixed(2)}x`;
      saveVoicePrefs(this.prefs);
    });

    this.el.volumeRange.addEventListener('input', (e) => {
      this.prefs.volume = parseInt(e.target.value, 10) / 100;
      this.el.volumeValue.textContent = `${Math.round(this.prefs.volume * 100)}%`;
      saveVoicePrefs(this.prefs);
    });

    this.el.syncModeSelect.addEventListener('change', (e) => {
      this.prefs.syncMode = e.target.value;
      saveVoicePrefs(this.prefs);
    });

    this.el.generateBtn.addEventListener('click', () => this.generateAllVoices());
    this.el.stopBtn.addEventListener('click', () => this.stopGeneration());
    this.el.remixBtn.addEventListener('click', () => this.rebuildMasterTrack());

    this.el.importAudioBtn.addEventListener('click', () => this.el.audioInput.click());
    this.el.audioInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      this.importExternalVoiceFile(file);
      this.el.audioInput.value = '';
    });

    this.el.downloadBtn.addEventListener('click', () => this.downloadMasterAudio());
  }

  showError(msg) {
    this.el.errorBox.textContent = msg;
    this.el.errorBox.classList.remove('hidden');
  }

  clearError() {
    this.el.errorBox.classList.add('hidden');
  }

  setProgress(percent, text) {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    this.el.progressBox.classList.remove('hidden');
    this.el.progressBar.style.width = `${p}%`;
    this.el.progressPercent.textContent = `${p}%`;
    if (text) this.el.progressText.textContent = text;
  }

  getSubtitlesForVoice() {
    return (this.appState.subtitles || [])
      .map((item, index) => ({
        index,
        start: item.start,
        end: item.end,
        text: (item.translatedText || '').trim() || (item.text || '').trim()
      }))
      .filter((x) => x.text.length > 0);
  }

  setRunningUI(running) {
    this.isRunning = running;
    const hasLines = this.getSubtitlesForVoice().length > 0;
    this.el.generateBtn.disabled = running || !hasLines;
    this.el.stopBtn.disabled = !running;
    this.el.remixBtn.disabled = running || this.lineClips.size === 0;
    this.el.engineSelect.disabled = running;
  }

  ensureWorker() {
    if (!this.worker) {
      this.worker = new Worker(new URL('./tts.worker.js', import.meta.url), { type: 'module' });
    }
    return this.worker;
  }

  terminateWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  async fetchProxyLine(text, signal) {
    if (!this.prefs.proxyUrl) {
      throw new Error('Chưa nhập URL Proxy Edge-TTS. Hãy nhập URL hoặc chuyển về "AI Tiếng Việt Offline".');
    }
    const res = await fetch(this.prefs.proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        text,
        voice: this.prefs.voiceName,
        rate: '+0%'
      })
    });
    if (!res.ok) throw new Error(`Proxy TTS trả về lỗi ${res.status}`);
    const blob = await res.blob();
    return decodeAudioBlobToMono(blob, 24000);
  }

  async generateAllVoices() {
    const lines = this.getSubtitlesForVoice();
    if (!lines.length) {
      this.showError('Chưa có phụ đề tiếng Việt. Hãy hoàn thành mục 03 Dịch phụ đề trước.');
      return;
    }

    this.clearError();
    this.setRunningUI(true);
    this.lineClips.clear();

    if (this.prefs.engine === 'custom_proxy') {
      await this.generateAllViaProxy(lines);
      return;
    }

    // Chạy AI Offline Xenova/mms-tts-vie trong Web Worker
    const worker = this.ensureWorker();
    const total = lines.length;
    this.setProgress(2, `Đang khởi tạo AI giọng đọc cho ${total} câu thoại...`);

    const onMessage = (e) => {
      const msg = e.data;
      if (!msg) return;

      if (msg.type === 'status') {
        this.setProgress(8, msg.message);
      } else if (msg.type === 'model-progress') {
        const p = msg.progress;
        if (p?.status === 'progress' && typeof p.progress === 'number') {
          this.setProgress(5 + p.progress * 0.15, `Đang tải mô hình giọng đọc (${p.file || ''}): ${Math.round(p.progress)}%`);
        }
      } else if (msg.type === 'line-start') {
        const pct = 20 + ((msg.current - 1) / msg.total) * 75;
        this.setProgress(pct, `Đang tạo giọng câu ${msg.current}/${msg.total}...`);
      } else if (msg.type === 'line-done') {
        this.lineClips.set(msg.index, {
          audio: new Float32Array(msg.audio),
          samplingRate: msg.samplingRate || 16000
        });
        this.markLineReady(msg.index);
        const pct = 20 + (msg.current / msg.total) * 75;
        this.setProgress(pct, `Đã tạo xong câu ${msg.current}/${msg.total}`);
      } else if (msg.type === 'batch-complete') {
        cleanup();
        this.setProgress(97, 'Đang đồng bộ thời gian và ghép toàn bộ thành file âm thanh WAV...');
        this.rebuildMasterTrack();
        this.setProgress(100, `Hoàn tất! Đã tạo và đồng bộ ${this.lineClips.size}/${total} câu thoại tiếng Việt.`);
        this.setRunningUI(false);
      } else if (msg.type === 'error') {
        cleanup();
        this.showError(`AI Giọng đọc báo lỗi: ${msg.message}`);
        this.setRunningUI(false);
      }
    };

    const onError = (err) => {
      cleanup();
      this.showError(`Lỗi Web Worker TTS: ${err.message || 'Không thể chạy mô hình.'}`);
      this.terminateWorker();
      this.setRunningUI(false);
    };

    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ type: 'synthesize-batch', items: lines });
  }

  async generateAllViaProxy(lines) {
    this.abortController = new AbortController();
    const total = lines.length;
    let failCount = 0;

    this.setProgress(2, `Đang gọi Proxy tạo giọng đọc (${this.prefs.voiceName})...`);

    try {
      for (let i = 0; i < total; i++) {
        if (this.abortController.signal.aborted) break;
        const line = lines[i];
        try {
          const clip = await this.fetchProxyLine(line.text, this.abortController.signal);
          this.lineClips.set(line.index, clip);
          this.markLineReady(line.index);
        } catch (err) {
          if (err.name === 'AbortError') break;
          failCount++;
          if (err.message.includes('Chưa nhập URL')) {
            this.showError(err.message);
            break;
          }
        }
        const pct = 5 + ((i + 1) / total) * 90;
        this.setProgress(pct, `Đã tạo ${i + 1}/${total} câu${failCount ? ` (lỗi ${failCount})` : ''}...`);
      }

      if (this.lineClips.size > 0) {
        this.rebuildMasterTrack();
        this.setProgress(
          100,
          `Hoàn tất đồng bộ ${this.lineClips.size}/${total} câu thoại.`
        );
      }
    } finally {
      this.abortController = null;
      this.setRunningUI(false);
    }
  }

  stopGeneration() {
    if (!this.isRunning) return;
    if (this.abortController) this.abortController.abort();
    this.terminateWorker();
    this.setRunningUI(false);

    if (this.lineClips.size > 0) {
      this.rebuildMasterTrack();
      this.setProgress(0, `Đã dừng. Đã ghép tạm ${this.lineClips.size} câu vừa tạo xong.`);
    } else {
      this.setProgress(0, 'Đã hủy quá trình tạo giọng đọc.');
    }
  }

  rebuildMasterTrack() {
    if (this.lineClips.size === 0) return;

    const subs = this.appState.subtitles || [];
    const entries = [...this.lineClips.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, clip]) => ({
        index,
        start: subs[index]?.start ?? 0,
        end: subs[index]?.end ?? 0,
        audio: clip.audio,
        samplingRate: clip.samplingRate
      }));

    const masterRate = entries[0].samplingRate || 16000;
    const baseSpeed = this.prefs.speed || 1.0;
    const volume = this.prefs.volume || 1.0;
    const syncMode = this.prefs.syncMode || 'autofit';

    const placements = [];
    let cursorSec = 0;

    for (let i = 0; i < entries.length; i++) {
      const cur = entries[i];
      const next = entries[i + 1];
      const normalizedAudio = resampleLinear(cur.audio, cur.samplingRate, masterRate);
      const rawDur = normalizedAudio.length / masterRate;

      let effectiveRate = baseSpeed;
      const targetStart = Math.max(0, cur.start);

      if (syncMode === 'autofit' && next) {
        const slot = Math.max(0.35, next.start - targetStart - 0.05);
        const estDur = rawDur / baseSpeed;
        if (estDur > slot) {
          effectiveRate = Math.min(baseSpeed * 1.38, rawDur / slot);
        }
      }

      const stretched = timeStretchWSOLA(normalizedAudio, effectiveRate, masterRate);
      const placeSec = syncMode === 'strict' ? targetStart : Math.max(targetStart, cursorSec);
      const durSec = stretched.length / masterRate;

      placements.push({ startSec: placeSec, samples: stretched });
      cursorSec = placeSec + durSec + 0.04;
    }

    const lastEnd = placements.length
      ? placements[placements.length - 1].startSec +
        placements[placements.length - 1].samples.length / masterRate
      : 0;

    const videoDur = this.appState.videoMeta?.duration || 0;
    const totalSec = Math.max(videoDur, lastEnd + 0.3, 1);
    const totalSamples = Math.ceil(totalSec * masterRate);
    const master = new Float32Array(totalSamples);

    for (const p of placements) {
      const startIdx = Math.floor(p.startSec * masterRate);
      const len = p.samples.length;
      for (let i = 0; i < len && startIdx + i < totalSamples; i++) {
        const mixed = master[startIdx + i] + p.samples[i] * volume;
        master[startIdx + i] = Math.max(-1, Math.min(1, mixed));
      }
    }

    const wavBlob = encodeWavBlob(master, masterRate);
    this.setMasterAudio(wavBlob, {
      duration: totalSec,
      lineCount: placements.length,
      sourceLabel: `AI Đồng bộ (${placements.length} câu • ${baseSpeed.toFixed(2)}x)`
    });
  }

  importExternalVoiceFile(file) {
    this.clearError();
    this.setMasterAudio(file, {
      duration: 0,
      lineCount: 0,
      sourceLabel: `Tệp lồng tiếng rời: ${file.name}`
    });
    this.setProgress(100, `Đã nạp tệp âm thanh rời "${file.name}" cho bước ghép video.`);
  }

  setMasterAudio(blob, info) {
    if (this.masterAudioUrl) URL.revokeObjectURL(this.masterAudioUrl);
    this.masterAudioUrl = URL.createObjectURL(blob);

    this.appState.voiceAudioBlob = blob;
    this.appState.voiceAudioUrl = this.masterAudioUrl;
    this.appState.voiceMeta = info;

    this.el.masterPlayer.src = this.masterAudioUrl;
    this.el.masterPlayer.load();
    this.el.masterCard.classList.remove('hidden');

    const sizeMB = (blob.size / (1024 * 1024)).toFixed(2);
    const durText = info.duration ? ` • ${formatSec(info.duration)}` : '';
    this.el.masterInfo.textContent = `${info.sourceLabel}${durText} • ${sizeMB} MB`;
    this.el.remixBtn.disabled = this.isRunning || this.lineClips.size === 0;

    if (typeof this.callbacks.onVoiceReady === 'function') {
      this.callbacks.onVoiceReady(blob, info);
    }
  }

  downloadMasterAudio() {
    if (!this.appState.voiceAudioBlob) return;
    const baseName = (this.appState.videoMeta?.name || 'giong-doc-viet').replace(/\.[^.]+$/, '');
    const ext = this.appState.voiceAudioBlob.type.includes('mpeg') ? 'mp3' : 'wav';
    const a = document.createElement('a');
    a.href = this.masterAudioUrl;
    a.download = `${baseName}_voice_vi.${ext}`;
    a.click();
  }

  async previewLineWithAI(index, btn) {
    const subs = this.appState.subtitles || [];
    const text = (subs[index]?.translatedText || subs[index]?.text || '').trim();
    if (!text) return;

    this.clearError();

    // Nếu câu này đã tạo sẵn rồi thì phát ngay với tốc độ hiện tại
    if (this.lineClips.has(index)) {
      const clip = this.lineClips.get(index);
      const stretched = timeStretchWSOLA(clip.audio, this.prefs.speed, clip.samplingRate);
      const blob = encodeWavBlob(stretched, clip.samplingRate);
      this.playPreviewBlob(blob);
      return;
    }

    if (this.isRunning) return;

    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Đang tạo...';

    try {
      if (this.prefs.engine === 'custom_proxy') {
        const clip = await this.fetchProxyLine(text);
        this.lineClips.set(index, clip);
        this.markLineReady(index);
        const stretched = timeStretchWSOLA(clip.audio, this.prefs.speed, clip.samplingRate);
        this.playPreviewBlob(encodeWavBlob(stretched, clip.samplingRate));
      } else {
        const worker = this.ensureWorker();
        const reqId = `${Date.now()}-${index}`;
        const clip = await new Promise((resolve, reject) => {
          const handler = (e) => {
            const m = e.data;
            if (!m) return;
            if (m.type === 'status') {
              this.setProgress(15, m.message);
            } else if (m.type === 'model-progress' && m.progress?.status === 'progress') {
              this.setProgress(
                10 + m.progress.progress * 0.8,
                `Đang tải mô hình giọng đọc (${m.progress.file || ''}): ${Math.round(m.progress.progress)}%`
              );
            } else if (m.type === 'one-done' && m.id === reqId) {
              worker.removeEventListener('message', handler);
              resolve({ audio: new Float32Array(m.audio), samplingRate: m.samplingRate || 16000 });
            } else if (m.type === 'error' && (!m.id || m.id === reqId)) {
              worker.removeEventListener('message', handler);
              reject(new Error(m.message));
            }
          };
          worker.addEventListener('message', handler);
          worker.postMessage({ type: 'synthesize-one', id: reqId, text });
        });

        this.lineClips.set(index, clip);
        this.markLineReady(index);
        this.setProgress(100, `Đã tạo thử xong câu #${index + 1}.`);
        const stretched = timeStretchWSOLA(clip.audio, this.prefs.speed, clip.samplingRate);
        this.playPreviewBlob(encodeWavBlob(stretched, clip.samplingRate));
      }
    } catch (err) {
      this.showError(`Không thể tạo thử câu #${index + 1}: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = this.lineClips.has(index) ? '▶ Nghe câu này' : oldText;
      this.el.remixBtn.disabled = this.isRunning || this.lineClips.size === 0;
    }
  }

  playPreviewBlob(blob) {
    if (this.previewBlobUrl) URL.revokeObjectURL(this.previewBlobUrl);
    this.previewBlobUrl = URL.createObjectURL(blob);
    this.previewAudioEl.src = this.previewBlobUrl;
    this.previewAudioEl.volume = Math.min(1, this.prefs.volume);
    this.previewAudioEl.play().catch(() => {});
  }

  previewLineBrowserSpeech(text) {
    if (!('speechSynthesis' in window)) {
      this.showError('Trình duyệt không hỗ trợ đọc nhanh Web Speech API.');
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'vi-VN';
    utter.rate = Math.max(0.6, Math.min(1.6, this.prefs.speed));
    const voices = window.speechSynthesis.getVoices();
    const viVoice = voices.find((v) => v.lang.toLowerCase().includes('vi'));
    if (viVoice) utter.voice = viVoice;
    window.speechSynthesis.speak(utter);
  }

  markLineReady(index) {
    const btn = this.el.listContainer.querySelector(`button[data-ai-play="${index}"]`);
    if (btn) {
      btn.textContent = '▶ Nghe câu này';
      btn.classList.add('ready');
    }
  }

  refresh() {
    const lines = this.getSubtitlesForVoice();
    this.el.countBadge.textContent = `${lines.length} câu thoại`;

    if (lines.length === 0) {
      this.el.sourceStatus.textContent = 'Chưa có phụ đề tiếng Việt';
      this.el.sourceStatus.className = 'status-chip';
    } else {
      this.el.sourceStatus.textContent = `Sẵn sàng đọc ${lines.length} câu thoại`;
      this.el.sourceStatus.className = 'status-chip ready';
    }

    this.setRunningUI(this.isRunning);

    const container = this.el.listContainer;
    if (!lines.length) {
      container.innerHTML =
        `<p class="card-desc">Chưa có nội dung để tạo giọng đọc. Hãy dịch phụ đề ở mục <strong>03 Dịch phụ đề</strong> hoặc dùng nút <strong>Nhập file giọng đọc có sẵn</strong>.</p>`;
      return;
    }

    container.innerHTML = '';
    lines.forEach((line) => {
      const hasClip = this.lineClips.has(line.index);
      const row = document.createElement('div');
      row.className = 'srt-row';
      row.innerHTML = `
        <div class="srt-row-head">
          <span class="srt-index">#${line.index + 1}</span>
          <span class="voice-time-tag">${secondsToSrtTime(line.start)} → ${secondsToSrtTime(line.end)}</span>
          <div class="row-mini-actions">
            <button type="button" class="btn-mini-primary ${hasClip ? 'ready' : ''}" data-ai-play="${line.index}">
              ${hasClip ? '▶ Nghe câu này' : 'Tạo & nghe thử AI'}
            </button>
            <button type="button" class="btn-mini-secondary" data-speech-play="${line.index}" title="Nghe nhanh bằng loa trình duyệt (không xuất file)">
              Đọc nhanh
            </button>
          </div>
        </div>
        <p class="voice-line-text"></p>
      `;

      row.querySelector('.voice-line-text').textContent = line.text;

      const aiBtn = row.querySelector(`[data-ai-play="${line.index}"]`);
      aiBtn.addEventListener('click', () => this.previewLineWithAI(line.index, aiBtn));

      const speechBtn = row.querySelector(`[data-speech-play="${line.index}"]`);
      speechBtn.addEventListener('click', () => this.previewLineBrowserSpeech(line.text));

      container.appendChild(row);
    });
  }
}
