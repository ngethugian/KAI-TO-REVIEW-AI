/**
 * Module Trích xuất phụ đề tiếng Trung nâng cao (Giai đoạn 3 - Bản nâng cấp VAD & Large-v3-Turbo)
 * - Hỗ trợ Whisper Large-v3-Turbo (siêu chuẩn tiếng Trung với WebGPU)
 * - Lọc tạp âm nền, cắt theo khoảng lặng thông minh (VAD), chống ảo giác và tự tách câu dài
 * - Bấm trực tiếp vào nút ▶ ở từng dòng để tua video đến đúng giây đó kiểm tra
 */

export function secondsToSrtTime(totalSeconds) {
  const safe = Math.max(0, Number(totalSeconds) || 0);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms === 1000 ? 999 : ms, 3)}`;
}

export function srtTimeToSeconds(srtStr) {
  const match = String(srtStr || '')
    .trim()
    .match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) return null;
  const [, h, m, s, ms] = match;
  return (
    parseInt(h, 10) * 3600 +
    parseInt(m, 10) * 60 +
    parseInt(s, 10) +
    parseInt(ms.padEnd(3, '0'), 10) / 1000
  );
}

export function buildSrtContent(subtitles, useTranslated = false) {
  return subtitles
    .map((item, idx) => {
      const content = useTranslated && item.translatedText ? item.translatedText : item.text;
      return `${idx + 1}\n${secondsToSrtTime(item.start)} --> ${secondsToSrtTime(item.end)}\n${content.trim()}\n`;
    })
    .join('\n');
}

export function parseSrtContent(srtText) {
  const blocks = String(srtText || '')
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/);

  const items = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const timeLineIndex = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIndex === -1) continue;

    const [startStr, endStr] = lines[timeLineIndex].split('-->').map((s) => s.trim());
    const start = srtTimeToSeconds(startStr);
    const end = srtTimeToSeconds(endStr);
    const text = lines.slice(timeLineIndex + 1).join('\n').trim();

    if (start !== null && end !== null && text) {
      items.push({
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${items.length}`,
        start,
        end,
        text,
        translatedText: ''
      });
    }
  }
  return items;
}

async function decodeTo16kMono(file) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    throw new Error('Trình duyệt không hỗ trợ Web Audio API để tách âm thanh.');
  }

  let arrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch {
    throw new Error(
      'Không đủ bộ nhớ trình duyệt để đọc toàn bộ tệp video này. ' +
      'Hãy tách riêng file âm thanh MP3/WAV rồi dùng nút "Chọn file âm thanh rời".'
    );
  }

  const audioCtx = new AudioCtx({ sampleRate: 16000 });
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    arrayBuffer = null;

    const length = audioBuffer.length;
    const mono = new Float32Array(length);

    if (audioBuffer.numberOfChannels === 1) {
      mono.set(audioBuffer.getChannelData(0));
    } else {
      const ch0 = audioBuffer.getChannelData(0);
      const ch1 = audioBuffer.getChannelData(1);
      for (let i = 0; i < length; i++) {
        mono[i] = (ch0[i] + ch1[i]) * 0.5;
      }
    }
    return mono;
  } catch {
    throw new Error(
      'Trình duyệt không thể giải mã luồng âm thanh từ tệp này (có thể video không có tiếng, lỗi codec, hoặc quá dung lượng RAM). ' +
      'Hãy thử nạp file MP3/WAV rời hoặc video MP4 ngắn hơn.'
    );
  } finally {
    await audioCtx.close().catch(() => {});
  }
}

export class SubtitleManager {
  constructor(elements, appState, callbacks = {}) {
    this.el = elements;
    this.appState = appState;
    this.callbacks = callbacks;

    this.worker = null;
    this.isRunning = false;
    this.externalAudioFile = null;
    this.subtitles = [];

    this.enhanceSubtitleControlsUI();
    this.bindEvents();
    this.syncModelFromSettings();
    this.renderSubtitles();
  }

  enhanceSubtitleControlsUI() {
    // Nâng cấp danh sách mô hình Whisper (thêm Large-v3-Turbo cho độ chính xác tiếng Trung cao nhất)
    this.el.modelSelect.innerHTML = `
      <option value="onnx-community/whisper-large-v3-turbo" selected>Whisper Large-v3-Turbo (~800MB — Chuẩn tiếng Trung nhất, khuyên dùng với WebGPU)</option>
      <option value="onnx-community/whisper-small">Whisper Small (~480MB — Cân bằng, ổn định)</option>
      <option value="onnx-community/whisper-base">Whisper Base (~150MB — Nhanh)</option>
      <option value="onnx-community/whisper-tiny">Whisper Tiny (~75MB — Rất nhanh để test)</option>
    `;

    const grid = this.el.modelSelect.closest('.settings-grid');
    if (!grid || grid.querySelector('#subVadModeSelect')) return;

    const vadGroup = document.createElement('div');
    vadGroup.className = 'form-group';
    vadGroup.innerHTML = `
      <label for="subVadModeSelect">Chế độ cắt đoạn & Lọc nhạc nền</label>
      <select id="subVadModeSelect">
        <option value="smart" selected>Cắt thông minh theo khoảng lặng VAD + Lọc BGM (Khuyên dùng)</option>
        <option value="fixed">Cắt đều mỗi 28 giây (Dùng khi nhạc nền quá to át tiếng nói)</option>
      </select>
    `;

    const splitGroup = document.createElement('div');
    splitGroup.className = 'form-group';
    splitGroup.innerHTML = `
      <label for="subSplitModeSelect">Xử lý câu dài & Chống lặp ảo giác</label>
      <select id="subSplitModeSelect">
        <option value="on" selected>Bật lọc ảo giác + Tự tách câu dài gọn đẹp (Khuyên dùng)</option>
        <option value="off">Giữ nguyên đầu ra thô của Whisper</option>
      </select>
    `;

    grid.appendChild(vadGroup);
    grid.appendChild(splitGroup);

    this.el.vadModeSelect = vadGroup.querySelector('#subVadModeSelect');
    this.el.splitModeSelect = splitGroup.querySelector('#subSplitModeSelect');
  }

  bindEvents() {
    this.el.startBtn.addEventListener('click', () => this.startExtraction());
    this.el.stopBtn.addEventListener('click', () => this.stopExtraction());

    this.el.importAudioBtn.addEventListener('click', () => this.el.audioInput.click());
    this.el.audioInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      this.externalAudioFile = file;
      this.updateSourceInfo();
      this.clearError();
    });

    this.el.importSrtBtn.addEventListener('click', () => this.el.srtInput.click());
    this.el.srtInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      const parsed = parseSrtContent(text);
      if (!parsed.length) {
        this.showError('File SRT không hợp lệ hoặc không có dòng phụ đề nào.');
        return;
      }
      this.clearError();
      this.subtitles = parsed;
      this.notifySubtitlesChanged();
      this.renderSubtitles();
      this.setProgress(100, `Đã nhập ${parsed.length} dòng từ file ${file.name}`);
      this.el.srtInput.value = '';
    });

    this.el.downloadSrtBtn.addEventListener('click', () => this.downloadSrt());
    this.el.addLineBtn.addEventListener('click', () => this.addEmptyLine());
  }

  syncModelFromSettings() {
    // Ưu tiên Large-v3-Turbo nếu WebGPU sẵn sàng, trừ khi người dùng chọn khác
    const hasGpu = 'gpu' in navigator;
    if (hasGpu && this.el.modelSelect.querySelector('option[value="onnx-community/whisper-large-v3-turbo"]')) {
      this.el.modelSelect.value = 'onnx-community/whisper-large-v3-turbo';
    } else if (this.appState.settings?.whisperModel) {
      this.el.modelSelect.value = this.appState.settings.whisperModel;
    }
  }

  setVideo(file, meta) {
    this.externalAudioFile = null;
    this.el.audioInput.value = '';
    this.updateSourceInfo();
    this.clearError();
  }

  updateSourceInfo() {
    if (this.externalAudioFile) {
      this.el.sourceStatus.textContent = `Nguồn âm thanh rời: ${this.externalAudioFile.name}`;
      this.el.sourceStatus.className = 'status-chip ready';
      this.el.startBtn.disabled = this.isRunning;
      return;
    }

    if (this.appState.videoFile && this.appState.videoMeta) {
      this.el.sourceStatus.textContent =
        `Video hiện tại: ${this.appState.videoMeta.name} (${this.appState.videoMeta.durationFormatted})`;
      this.el.sourceStatus.className = 'status-chip ready';
      this.el.startBtn.disabled = this.isRunning;
    } else {
      this.el.sourceStatus.textContent = 'Chưa có video hoặc file âm thanh';
      this.el.sourceStatus.className = 'status-chip';
      this.el.startBtn.disabled = true;
    }
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

  setRunningUI(running) {
    this.isRunning = running;
    this.el.startBtn.disabled = running || (!this.appState.videoFile && !this.externalAudioFile);
    this.el.stopBtn.disabled = !running;
    this.el.modelSelect.disabled = running;
    this.el.deviceSelect.disabled = running;
    if (this.el.vadModeSelect) this.el.vadModeSelect.disabled = running;
    if (this.el.splitModeSelect) this.el.splitModeSelect.disabled = running;
  }

  async startExtraction() {
    const sourceFile = this.externalAudioFile || this.appState.videoFile;
    if (!sourceFile) {
      this.showError('Vui lòng tải video ở Trang chủ hoặc chọn file âm thanh rời trước.');
      return;
    }

    this.clearError();
    this.setRunningUI(true);
    this.subtitles = [];
    this.renderSubtitles();
    this.notifySubtitlesChanged();

    try {
      this.setProgress(3, 'Đang tách và giải mã luồng âm thanh 16kHz từ tệp...');
      const monoAudio = await decodeTo16kMono(sourceFile);

      if (!this.isRunning) return;

      const durationSec = monoAudio.length / 16000;
      this.setProgress(10, `Đã tách âm thanh (${Math.round(durationSec)} giây). Đang khởi chạy Whisper AI...`);

      const preferredDevice =
        this.el.deviceSelect.value === 'auto'
          ? ('gpu' in navigator ? 'webgpu' : 'wasm')
          : this.el.deviceSelect.value;

      const modelId = this.el.modelSelect.value;
      const useSmartVad = this.el.vadModeSelect?.value !== 'fixed';
      const smartClean = this.el.splitModeSelect?.value !== 'off';

      this.worker = new Worker(new URL('./whisper.worker.js?v=2', import.meta.url), {
        type: 'module'
      });

      this.worker.addEventListener('message', (e) => this.handleWorkerMessage(e.data));
      this.worker.addEventListener('error', (err) => {
        this.showError(`Lỗi Web Worker: ${err.message || 'Không thể chạy Whisper AI.'}`);
        this.cleanupWorker();
        this.setRunningUI(false);
      });

      this.worker.postMessage(
        {
          type: 'transcribe',
          audio: monoAudio,
          modelId,
          device: preferredDevice,
          language: 'chinese',
          useSmartVad,
          splitLongLines: smartClean,
          filterHallucinations: smartClean
        },
        [monoAudio.buffer]
      );
    } catch (err) {
      this.showError(err.message || 'Lỗi trong quá trình chuẩn bị âm thanh.');
      this.cleanupWorker();
      this.setRunningUI(false);
    }
  }

  handleWorkerMessage(msg) {
    if (!msg) return;

    switch (msg.type) {
      case 'status':
        this.setProgress(15, msg.message);
        break;

      case 'model-progress': {
        const p = msg.progress;
        if (p?.status === 'progress' && typeof p.progress === 'number') {
          const pct = 10 + p.progress * 0.2;
          this.setProgress(pct, `Đang tải mô hình AI (${p.file || ''}): ${Math.round(p.progress)}%`);
        }
        break;
      }

      case 'chunk-start': {
        const pct = 30 + ((msg.chunkIndex - 1) / msg.totalChunks) * 68;
        this.setProgress(
          pct,
          `Đang nhận diện đoạn ${msg.chunkIndex}/${msg.totalChunks} (mốc ${secondsToSrtTime(msg.offsetSec).slice(0, 8)})...`
        );
        break;
      }

      case 'chunk-done': {
        const added = (msg.segments || []).map((s) => ({
          id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
          start: s.start,
          end: s.end,
          text: s.text,
          translatedText: ''
        }));

        if (added.length) {
          this.subtitles.push(...added);
          this.renderSubtitles();
          this.notifySubtitlesChanged();
        }

        const pct = 30 + (msg.chunkIndex / msg.totalChunks) * 68;
        this.setProgress(
          pct,
          `Đã xong đoạn ${msg.chunkIndex}/${msg.totalChunks} — Trích xuất được ${this.subtitles.length} câu thoại`
        );
        break;
      }

      case 'complete':
        this.setProgress(
          100,
          `Hoàn tất (${(msg.device || '').toUpperCase()})! Trích xuất chuẩn ${this.subtitles.length} dòng phụ đề tiếng Trung.`
        );
        this.cleanupWorker();
        this.setRunningUI(false);
        this.notifySubtitlesChanged(true);
        break;

      case 'error':
        this.showError(`Whisper AI báo lỗi: ${msg.message}`);
        this.cleanupWorker();
        this.setRunningUI(false);
        break;
    }
  }

  stopExtraction() {
    if (!this.isRunning) return;
    this.cleanupWorker();
    this.setRunningUI(false);
    this.setProgress(0, `Đã hủy xử lý. Đang giữ ${this.subtitles.length} dòng đã nhận diện trước đó.`);
  }

  cleanupWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  addEmptyLine() {
    const last = this.subtitles[this.subtitles.length - 1];
    const start = last ? last.end : 0;
    const end = start + 2.5;
    this.subtitles.push({
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      start,
      end,
      text: '',
      translatedText: ''
    });
    this.renderSubtitles();
    this.notifySubtitlesChanged();
  }

  downloadSrt() {
    if (!this.subtitles.length) return;
    const srt = buildSrtContent(this.subtitles, false);
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const baseName = (this.appState.videoMeta?.name || 'phu-de-trung').replace(/\.[^.]+$/, '');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}_zh.srt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  notifySubtitlesChanged(isCompleted = false) {
    this.appState.subtitles = this.subtitles;
    this.el.countBadge.textContent = `${this.subtitles.length} dòng`;
    this.el.downloadSrtBtn.disabled = this.subtitles.length === 0;

    if (typeof this.callbacks.onSubtitlesUpdated === 'function') {
      this.callbacks.onSubtitlesUpdated(this.subtitles, isCompleted);
    }
  }

  renderSubtitles() {
    const container = this.el.listContainer;
    this.el.countBadge.textContent = `${this.subtitles.length} dòng`;
    this.el.downloadSrtBtn.disabled = this.subtitles.length === 0;

    if (!this.subtitles.length) {
      container.innerHTML =
        `<p class="card-desc">Chưa có phụ đề. Bấm <strong>Bắt đầu nhận diện tiếng Trung</strong> hoặc nhập file <code>.srt</code> có sẵn.</p>`;
      return;
    }

    container.innerHTML = '';
    this.subtitles.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'srt-row';

      row.innerHTML = `
        <div class="srt-row-head">
          <span class="srt-index">#${index + 1}</span>
          <div class="srt-times">
            <input type="text" class="srt-time-input" data-field="start" value="${secondsToSrtTime(item.start)}" aria-label="Thời gian bắt đầu" />
            <span>→</span>
            <input type="text" class="srt-time-input" data-field="end" value="${secondsToSrtTime(item.end)}" aria-label="Thời gian kết thúc" />
          </div>
          <div class="row-mini-actions">
            <button type="button" class="btn-mini-secondary" data-seek-btn title="Nghe đoạn này từ video gốc">▶ Nghe gốc</button>
            <button type="button" class="btn-mini-danger" title="Xóa dòng">Xóa</button>
          </div>
        </div>
        <textarea class="srt-textarea" rows="2" placeholder="Nhập lời thoại tiếng Trung..."></textarea>
      `;

      const textarea = row.querySelector('.srt-textarea');
      textarea.value = item.text;
      textarea.addEventListener('input', (e) => {
        item.text = e.target.value;
        this.notifySubtitlesChanged();
      });

      row.querySelector('[data-seek-btn]').addEventListener('click', () => {
        const player = document.getElementById('mainVideoPlayer');
        if (!player || !player.src) return;
        player.currentTime = item.start;
        player.play().catch(() => {});
        const stopAt = item.end;
        const onTime = () => {
          if (player.currentTime >= stopAt) {
            player.pause();
            player.removeEventListener('timeupdate', onTime);
          }
        };
        player.addEventListener('timeupdate', onTime);
      });

      row.querySelectorAll('.srt-time-input').forEach((input) => {
        input.addEventListener('change', (e) => {
          const parsed = srtTimeToSeconds(e.target.value);
          if (parsed === null) {
            e.target.value = secondsToSrtTime(item[input.dataset.field]);
            return;
          }
          item[input.dataset.field] = parsed;
          this.notifySubtitlesChanged();
        });
      });

      row.querySelector('.btn-mini-danger').addEventListener('click', () => {
        this.subtitles.splice(index, 1);
        this.renderSubtitles();
        this.notifySubtitlesChanged();
      });

      container.appendChild(row);
    });
  }
}
