/**
 * Module Tạo giọng đọc tiếng Việt tự nhiên & Đồng bộ thời gian (Giai đoạn 5 - Bản nâng cấp)
 * - Chế độ 1 (Khuyên dùng): Gemini 2.5 Flash TTS miễn phí (dùng chung API Key từ Google AI Studio ở GĐ 4)
 *   + Có sẵn chế độ "Cô gái hoạt ngôn" (trẻ trung, năng lượng, tự nhiên như review TikTok/CapCut)
 *   + Tự xử lý giới hạn tần suất (đếm ngược chờ và tiếp tục tự động, không mất các câu đã tạo)
 * - Chế độ 2: AI Tiếng Việt Offline (Xenova/mms-tts-vie ~38MB, không cần API Key)
 * - Chế độ 3: Proxy TTS tùy chọn + Nhập file giọng đọc MP3/WAV có sẵn
 */

import { secondsToSrtTime } from './subtitle.js';

const VOICE_PREF_KEY = 'kaito_review_ai_voice_pref_v2';
const TRANSLATE_PRO_KEY = 'kaito_review_ai_translate_pro_v1';

const GEMINI_VOICE_PRESETS = {
  hoat_ngon: {
    label: 'Cô gái hoạt ngôn (Giống CapCut — Trẻ trung, nhanh nhẹn, review cuốn hút)',
    voiceName: 'Aoede',
    stylePrompt:
      'Speak in Vietnamese with a lively, bright, energetic, expressive young female voice like a popular Vietnamese TikTok movie review narrator. Natural pacing, crisp pronunciation, engaging intonation'
  },
  nu_linh_hoat: {
    label: 'Nữ trẻ trung năng động (Giọng Zephyr — Sáng, rõ chữ, tự nhiên)',
    voiceName: 'Zephyr',
    stylePrompt:
      'Speak in Vietnamese with a cheerful, clear, natural, fast-paced young Vietnamese female voice like an energetic video storyteller'
  },
  nu_truyen_cam: {
    label: 'Nữ kể chuyện truyền cảm (Giọng Kore — Ngôn tình, cảm xúc)',
    voiceName: 'Kore',
    stylePrompt:
      'Speak in Vietnamese with a warm, expressive, emotional young Vietnamese female storytelling voice, natural and smooth'
  },
  nam_review: {
    label: 'Nam review phim trầm ấm (Giọng Charon — Kịch tính, cuốn hút)',
    voiceName: 'Charon',
    stylePrompt:
      'Speak in Vietnamese with a confident, deep, engaging Vietnamese male movie review narrator voice'
  }
};

function getSharedGeminiKey() {
  try {
    const tr = JSON.parse(localStorage.getItem(TRANSLATE_PRO_KEY) || '{}');
    return tr.geminiKey || '';
  } catch {
    return '';
  }
}

function syncSharedGeminiKey(key) {
  if (!key) return;
  try {
    const tr = JSON.parse(localStorage.getItem(TRANSLATE_PRO_KEY) || '{}');
    if (!tr.geminiKey) {
      tr.geminiKey = key;
      localStorage.setItem(TRANSLATE_PRO_KEY, JSON.stringify(tr));
    }
  } catch {
    // ignore
  }
}

function loadVoicePrefs() {
  const sharedKey = getSharedGeminiKey();
  const defaults = {
    engine: 'gemini_tts',
    geminiPreset: 'hoat_ngon',
    geminiModel: 'gemini-2.5-flash-preview-tts',
    geminiKey: sharedKey,
    voiceName: 'vi-VN-HoaiMyNeural',
    proxyUrl: '',
    speed: 1.08,
    volume: 1.0,
    syncMode: 'autofit'
  };

  try {
    const saved = JSON.parse(localStorage.getItem(VOICE_PREF_KEY) || '{}');
    const merged = { ...defaults, ...saved };
    if (!merged.geminiKey && sharedKey) merged.geminiKey = sharedKey;
    return merged;
  } catch {
    return defaults;
  }
}

function saveVoicePrefs(prefs) {
  try {
    localStorage.setItem(VOICE_PREF_KEY, JSON.stringify(prefs));
    syncSharedGeminiKey(prefs.geminiKey);
  } catch {
    // ignore
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Đã hủy', 'AbortError'));
        },
        { once: true }
      );
    }
  });
}

function formatSec(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function trimSilence(samples, threshold = 0.005, padSamples = 800) {
  let start = 0;
  let end = samples.length - 1;
  while (start < end && Math.abs(samples[start]) < threshold) start++;
  while (end > start && Math.abs(samples[end]) < threshold) end--;
  if (start >= end) return samples;
  const s = Math.max(0, start - padSamples);
  const e = Math.min(samples.length, end + padSamples);
  return samples.slice(s, e);
}

/**
 * Giải mã âm thanh PCM 16-bit Little-Endian (audio/L16) từ Gemini TTS thành Float32Array
 */
function decodeBase64Pcm16(base64Str, mimeType = '') {
  const rateMatch = String(mimeType).match(/rate=(\d+)/i);
  const samplingRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;

  const binary = atob(base64Str);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);

  const sampleCount = Math.floor(len / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  const floatData = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    floatData[i] = view.getInt16(i * 2, true) / 32768;
  }

  return { audio: trimSilence(floatData), samplingRate };
}

async function decodeAudioBlobToMono(blob, targetRate = 24000) {
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
    return { audio: trimSilence(mono), samplingRate: decoded.sampleRate };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * Thay đổi tốc độ đọc GIỮ NGUYÊN CAO ĐỘ GIỌNG (WSOLA)
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
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
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

export class VoiceManager {
  constructor(elements, appState, callbacks = {}) {
    this.el = elements;
    this.appState = appState;
    this.callbacks = callbacks;

    this.prefs = loadVoicePrefs();
    this.worker = null;
    this.isRunning = false;
    this.abortController = null;

    this.lineClips = new Map();
    this.masterAudioUrl = null;
    this.previewAudioEl = new Audio();
    this.previewBlobUrl = null;

    this.enhanceVoiceControlsUI();
    this.applyPrefsToUI();
    this.bindEvents();
    this.refresh();
  }

  enhanceVoiceControlsUI() {
    this.el.engineSelect.innerHTML = `
      <option value="gemini_tts">Gemini AI Voice miễn phí (Giọng nữ hoạt ngôn tự nhiên như CapCut — Khuyên dùng)</option>
      <option value="mms_offline">AI Offline trên trình duyệt (Xenova/mms-tts-vie — Không cần API Key, giọng cơ bản)</option>
      <option value="custom_proxy">Proxy Edge-TTS tùy chỉnh (Nhập URL Worker cá nhân)</option>
    `;

    // Tạo khối cài đặt Gemini TTS chèn ngay dưới chọn engine
    const parentCard = this.el.engineSelect.closest('.card');
    if (parentCard && !parentCard.querySelector('#voiceGeminiSettings')) {
      const geminiBox = document.createElement('div');
      geminiBox.id = 'voiceGeminiSettings';
      geminiBox.className = 'settings-grid';
      geminiBox.style.marginTop = '12px';

      const presetOptions = Object.entries(GEMINI_VOICE_PRESETS)
        .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
        .join('');

      geminiBox.innerHTML = `
        <div class="form-group">
          <label for="voiceGeminiPresetSelect">Chọn phong cách giọng nói tiếng Việt</label>
          <select id="voiceGeminiPresetSelect">${presetOptions}</select>
        </div>
        <div class="form-group">
          <label for="voiceGeminiModelSelect">Mô hình giọng đọc Gemini</label>
          <select id="voiceGeminiModelSelect">
            <option value="gemini-2.5-flash-preview-tts">Gemini 2.5 Flash TTS (Nhanh, tự nhiên, miễn phí)</option>
            <option value="gemini-2.5-pro-preview-tts">Gemini 2.5 Pro TTS (Biểu cảm cao hơn)</option>
          </select>
        </div>
        <div class="form-group full-width">
          <label for="voiceGeminiKeyInput">
            Gemini API Key miễn phí (Tự lấy chung từ GĐ 4 •
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" class="text-link">Lấy Key miễn phí tại Google AI Studio ↗</a>)
          </label>
          <input
            type="password"
            id="voiceGeminiKeyInput"
            placeholder="Dán API Key bắt đầu bằng AIza... (nếu đã nhập ở tab 03 Dịch phụ đề thì tự điền sẵn)"
            autocomplete="off"
          />
        </div>
      `;

      this.el.proxySettings.parentNode.insertBefore(geminiBox, this.el.proxySettings);
      this.el.geminiSettings = geminiBox;
      this.el.geminiPresetSelect = geminiBox.querySelector('#voiceGeminiPresetSelect');
      this.el.geminiModelSelect = geminiBox.querySelector('#voiceGeminiModelSelect');
      this.el.geminiKeyInput = geminiBox.querySelector('#voiceGeminiKeyInput');
    }

    // Thêm nút "Tạo nốt câu chưa có" kế bên nút tạo toàn bộ
    if (!document.getElementById('voiceMissingBtn')) {
      const missingBtn = document.createElement('button');
      missingBtn.id = 'voiceMissingBtn';
      missingBtn.className = 'btn btn-secondary';
      missingBtn.textContent = 'Chỉ tạo câu còn thiếu';
      missingBtn.disabled = true;
      this.el.generateBtn.insertAdjacentElement('afterend', missingBtn);
      this.el.missingBtn = missingBtn;
    }
  }

  applyPrefsToUI() {
    this.el.engineSelect.value = this.prefs.engine;
    if (this.el.geminiPresetSelect) this.el.geminiPresetSelect.value = this.prefs.geminiPreset;
    if (this.el.geminiModelSelect) this.el.geminiModelSelect.value = this.prefs.geminiModel;
    if (this.el.geminiKeyInput) this.el.geminiKeyInput.value = this.prefs.geminiKey || getSharedGeminiKey();

    this.el.voiceNameSelect.value = this.prefs.voiceName;
    this.el.proxyUrlInput.value = this.prefs.proxyUrl;
    this.el.speedRange.value = String(this.prefs.speed);
    this.el.speedValue.textContent = `${Number(this.prefs.speed).toFixed(2)}x`;
    this.el.volumeRange.value = String(Math.round(this.prefs.volume * 100));
    this.el.volumeValue.textContent = `${Math.round(this.prefs.volume * 100)}%`;
    this.el.syncModeSelect.value = this.prefs.syncMode;
    this.toggleEnginePanels();
  }

  toggleEnginePanels() {
    const eng = this.el.engineSelect.value;
    if (this.el.geminiSettings) {
      this.el.geminiSettings.classList.toggle('hidden', eng !== 'gemini_tts');
    }
    this.el.proxySettings.classList.toggle('hidden', eng !== 'custom_proxy');
  }

  bindEvents() {
    this.el.engineSelect.addEventListener('change', (e) => {
      this.prefs.engine = e.target.value;
      saveVoicePrefs(this.prefs);
      this.toggleEnginePanels();
      this.clearError();
    });

    this.el.geminiPresetSelect?.addEventListener('change', (e) => {
      this.prefs.geminiPreset = e.target.value;
      saveVoicePrefs(this.prefs);
    });

    this.el.geminiModelSelect?.addEventListener('change', (e) => {
      this.prefs.geminiModel = e.target.value;
      saveVoicePrefs(this.prefs);
    });

    this.el.geminiKeyInput?.addEventListener('input', (e) => {
      this.prefs.geminiKey = e.target.value.trim();
      saveVoicePrefs(this.prefs);
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

    this.el.generateBtn.addEventListener('click', () => this.generateAllVoices(false));
    this.el.missingBtn?.addEventListener('click', () => this.generateAllVoices(true));
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
    if (this.el.missingBtn) this.el.missingBtn.disabled = running || !hasLines;
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

  async fetchGeminiTtsLine(text, signal, onWaitStatus) {
    const apiKey = (this.prefs.geminiKey || getSharedGeminiKey()).trim();
    if (!apiKey) {
      throw new Error(
        'Chưa có Gemini API Key miễn phí. Hãy dán key từ Google AI Studio vào ô bên trên (hoặc chọn AI Offline).'
      );
    }

    const preset = GEMINI_VOICE_PRESETS[this.prefs.geminiPreset] || GEMINI_VOICE_PRESETS.hoat_ngon;
    const model = this.prefs.geminiModel || 'gemini-2.5-flash-preview-tts';
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent` +
      `?key=${encodeURIComponent(apiKey)}`;

    const promptText = `${preset.stylePrompt}: ${text}`;

    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: preset.voiceName
                }
              }
            }
          }
        })
      });

      if (res.status === 429) {
        if (attempt === maxAttempts) {
          throw new Error(
            'Gemini miễn phí đang chạm giới hạn số câu/phút. Hãy đợi 30 giây rồi bấm "Chỉ tạo câu còn thiếu" để chạy tiếp.'
          );
        }
        const waitSec = 8 * attempt;
        if (typeof onWaitStatus === 'function') {
          onWaitStatus(`Chạm nhịp miễn phí Gemini — tự động chờ ${waitSec} giây rồi đọc tiếp...`);
        }
        await delay(waitSec * 1000, signal);
        continue;
      }

      if (res.status === 400 || res.status === 403) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(
          `Gemini API Key không hợp lệ hoặc bị từ chối (${errData?.error?.message || res.status}).`
        );
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(`Gemini TTS lỗi ${res.status}: ${errData?.error?.message || 'Không xác định'}`);
      }

      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const audioPart = parts.find((p) => p.inlineData?.data);
      if (!audioPart) {
        throw new Error('Gemini không trả về dữ liệu âm thanh cho câu này.');
      }

      const { data: b64, mimeType = 'audio/L16;codec=pcm;rate=24000' } = audioPart.inlineData;
      if (/pcm|l16/i.test(mimeType)) {
        return decodeBase64Pcm16(b64, mimeType);
      }

      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return decodeAudioBlobToMono(new Blob([arr], { type: mimeType }), 24000);
    }
  }

  async fetchProxyLine(text, signal) {
    if (!this.prefs.proxyUrl) {
      throw new Error('Chưa nhập URL Proxy Edge-TTS. Hãy nhập URL hoặc chọn Gemini AI Voice.');
    }
    const res = await fetch(this.prefs.proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        text,
        voice: this.prefs.voiceName,
        rate: '+10%',
        pitch: '+6Hz'
      })
    });
    if (!res.ok) throw new Error(`Proxy TTS trả về lỗi ${res.status}`);
    const blob = await res.blob();
    return decodeAudioBlobToMono(blob, 24000);
  }

  async generateAllVoices(onlyMissing = false) {
    // Đồng bộ lại key nếu người dùng vừa nhập ở tab 03
    if (!this.prefs.geminiKey) {
      this.prefs.geminiKey = getSharedGeminiKey();
      if (this.el.geminiKeyInput) this.el.geminiKeyInput.value = this.prefs.geminiKey;
    }

    const allLines = this.getSubtitlesForVoice();
    if (!allLines.length) {
      this.showError('Chưa có phụ đề tiếng Việt. Hãy hoàn thành mục 03 Dịch phụ đề trước.');
      return;
    }

    if (!onlyMissing) {
      this.lineClips.clear();
    }

    const lines = onlyMissing
      ? allLines.filter((l) => !this.lineClips.has(l.index))
      : allLines;

    if (!lines.length) {
      this.rebuildMasterTrack();
      this.setProgress(100, 'Tất cả các câu đã có giọng đọc và vừa được ghép lại.');
      return;
    }

    this.clearError();
    this.setRunningUI(true);

    if (this.prefs.engine === 'gemini_tts') {
      await this.generateAllViaGemini(lines);
      return;
    }

    if (this.prefs.engine === 'custom_proxy') {
      await this.generateAllViaProxy(lines);
      return;
    }

    // Chạy AI Offline Xenova/mms-tts-vie trong Web Worker
    const worker = this.ensureWorker();
    const total = lines.length;
    this.setProgress(2, `Đang khởi tạo AI Offline cho ${total} câu thoại...`);

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
        this.setProgress(100, `Hoàn tất! Đã tạo và đồng bộ ${this.lineClips.size} câu thoại.`);
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

  async generateAllViaGemini(lines) {
    this.abortController = new AbortController();
    const total = lines.length;
    const presetLabel = GEMINI_VOICE_PRESETS[this.prefs.geminiPreset]?.label.split('(')[0].trim() || 'Gemini AI';
    let failCount = 0;

    this.setProgress(2, `Đang tạo giọng "${presetLabel}" cho ${total} câu thoại...`);

    try {
      for (let i = 0; i < total; i++) {
        if (this.abortController.signal.aborted) break;
        const line = lines[i];
        const basePct = 4 + (i / total) * 90;
        this.setProgress(basePct, `Đang đọc câu ${i + 1}/${total} (${presetLabel})...`);

        try {
          const clip = await this.fetchGeminiTtsLine(
            line.text,
            this.abortController.signal,
            (waitText) => this.setProgress(basePct, waitText)
          );
          this.lineClips.set(line.index, clip);
          this.markLineReady(line.index);
        } catch (err) {
          if (err.name === 'AbortError') break;
          failCount++;
          this.showError(err.message);
          if (err.message.includes('API Key') || err.message.includes('giới hạn')) {
            break;
          }
        }

        const donePct = 4 + ((i + 1) / total) * 90;
        this.setProgress(
          donePct,
          `Đã tạo xong ${i + 1}/${total} câu${failCount ? ` (chưa xong ${failCount} câu)` : ''}...`
        );

        // Giãn nhẹ 600ms giữa các câu để giảm khả năng dính giới hạn miễn phí
        if (i + 1 < total && !this.abortController.signal.aborted) {
          await delay(600, this.abortController.signal);
        }
      }

      if (this.lineClips.size > 0) {
        this.rebuildMasterTrack();
        if (!this.abortController.signal.aborted && failCount === 0) {
          this.setProgress(100, `Hoàn tất! Đã tạo & đồng bộ ${this.lineClips.size} câu giọng "${presetLabel}".`);
        }
      }
    } finally {
      this.abortController = null;
      this.setRunningUI(false);
    }
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
        this.setProgress(100, `Hoàn tất đồng bộ ${this.lineClips.size}/${total} câu thoại.`);
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
      this.setProgress(
        0,
        `Đã dừng. Đang giữ ${this.lineClips.size} câu đã tạo — bạn có thể bấm "Chỉ tạo câu còn thiếu" để chạy tiếp.`
      );
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

    const masterRate = entries[0].samplingRate || 24000;
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
      sourceLabel: `Giọng Việt đồng bộ (${placements.length} câu • ${baseSpeed.toFixed(2)}x)`
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

    if (this.lineClips.has(index)) {
      const clip = this.lineClips.get(index);
      const stretched = timeStretchWSOLA(clip.audio, this.prefs.speed, clip.samplingRate);
      this.playPreviewBlob(encodeWavBlob(stretched, clip.samplingRate));
      return;
    }

    if (this.isRunning) return;

    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Đang tạo...';

    try {
      let clip;
      if (this.prefs.engine === 'gemini_tts') {
        clip = await this.fetchGeminiTtsLine(text, undefined, (w) => this.setProgress(50, w));
      } else if (this.prefs.engine === 'custom_proxy') {
        clip = await this.fetchProxyLine(text);
      } else {
        const worker = this.ensureWorker();
        const reqId = `${Date.now()}-${index}`;
        clip = await new Promise((resolve, reject) => {
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
      }

      this.lineClips.set(index, clip);
      this.markLineReady(index);
      this.setProgress(100, `Đã tạo thử xong câu #${index + 1}.`);
      const stretched = timeStretchWSOLA(clip.audio, this.prefs.speed, clip.samplingRate);
      this.playPreviewBlob(encodeWavBlob(stretched, clip.samplingRate));
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
    if (!this.prefs.geminiKey) {
      this.prefs.geminiKey = getSharedGeminiKey();
      if (this.el.geminiKeyInput && this.prefs.geminiKey) {
        this.el.geminiKeyInput.value = this.prefs.geminiKey;
      }
    }

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
            <button type="button" class="btn-mini-secondary" data-speech-play="${line.index}" title="Nghe nhanh bằng loa trình duyệt">
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
