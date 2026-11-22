/**
 * Module Dịch phụ đề Trung -> Việt & Chỉnh sửa song ngữ (Giai đoạn 4)
 * - Dịch từng dòng đảm bảo đủ 100% nội dung, không cắt xén hay lệch mốc thời gian
 * - Hỗ trợ 3 phương án miễn phí: Google Dịch trực tiếp, MyMemory, Google Apps Script Proxy
 * - Hỗ trợ chỉnh sửa song ngữ, dịch lại từng dòng và xuất SRT tiếng Việt / song ngữ
 */

import {
  secondsToSrtTime,
  srtTimeToSeconds,
  parseSrtContent
} from './subtitle.js';

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

async function translateViaGoogleGtx(text, signal) {
  const url =
    'https://translate.googleapis.com/translate_a/single' +
    `?client=gtx&sl=zh-CN&tl=vi&dt=t&q=${encodeURIComponent(text)}`;

  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Google Dịch trả về mã lỗi ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data?.[0])) {
    throw new Error('Dữ liệu trả về từ Google Dịch không hợp lệ.');
  }
  return data[0]
    .map((part) => (Array.isArray(part) ? part[0] : ''))
    .join('')
    .trim();
}

async function translateViaMyMemory(text, signal) {
  const url =
    'https://api.mymemory.translated.net/get' +
    `?q=${encodeURIComponent(text)}&langpair=zh-CN|vi`;

  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`MyMemory trả về mã lỗi ${res.status}`);
  }
  const data = await res.json();
  if (data?.responseStatus && Number(data.responseStatus) !== 200) {
    throw new Error(data.responseDetails || 'MyMemory đã đạt giới hạn miễn phí tạm thời.');
  }
  return String(data?.responseData?.translatedText || '').trim();
}

async function translateViaAppsScript(text, endpoint, signal) {
  if (!endpoint) {
    throw new Error('Chưa nhập URL Google Apps Script trong mục 09 Cài đặt.');
  }
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `${endpoint}${sep}sl=zh-CN&tl=vi&text=${encodeURIComponent(text)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Apps Script Proxy trả về lỗi ${res.status}`);
  }
  const raw = await res.text();
  try {
    const json = JSON.parse(raw);
    return String(json.translatedText || json.text || raw).trim();
  } catch {
    return raw.trim();
  }
}

async function translateSingleLine(text, provider, endpoint, signal) {
  const clean = String(text || '').trim();
  if (!clean) return '';

  if (provider === 'apps_script') {
    return translateViaAppsScript(clean, endpoint, signal);
  }

  if (provider === 'mymemory') {
    return translateViaMyMemory(clean, signal);
  }

  // Mặc định: google_gtx, tự dự phòng sang MyMemory nếu bị chặn tạm thời
  try {
    return await translateViaGoogleGtx(clean, signal);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return await translateViaMyMemory(clean, signal);
  }
}

function buildVietnameseSrt(subtitles, bilingual = false) {
  return subtitles
    .map((item, idx) => {
      const vi = (item.translatedText || '').trim() || (item.text || '').trim();
      const body = bilingual
        ? `${vi}\n${(item.text || '').trim()}`
        : vi;
      return `${idx + 1}\n${secondsToSrtTime(item.start)} --> ${secondsToSrtTime(item.end)}\n${body}\n`;
    })
    .join('\n');
}

export class TranslateManager {
  constructor(elements, appState, callbacks = {}) {
    this.el = elements;
    this.appState = appState;
    this.callbacks = callbacks;

    this.isRunning = false;
    this.abortController = null;

    this.bindEvents();
    this.syncProviderFromSettings();
    this.refresh();
  }

  bindEvents() {
    this.el.startBtn.addEventListener('click', () => this.translateAll(false));
    this.el.missingBtn.addEventListener('click', () => this.translateAll(true));
    this.el.stopBtn.addEventListener('click', () => this.stopTranslation());

    this.el.importSrtBtn.addEventListener('click', () => this.el.srtInput.click());
    this.el.srtInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const content = await file.text();
      const parsed = parseSrtContent(content);
      if (!parsed.length) {
        this.showError('File SRT không hợp lệ hoặc không có dòng phụ đề.');
        return;
      }
      this.clearError();
      this.appState.subtitles = parsed;
      this.notifyChanged();
      this.refresh();
      this.setProgress(0, `Đã nhập ${parsed.length} dòng từ ${file.name}. Sẵn sàng dịch.`);
      this.el.srtInput.value = '';
    });

    this.el.restoreDraftBtn.addEventListener('click', () => {
      if (typeof this.callbacks.onRestoreDraft === 'function') {
        this.callbacks.onRestoreDraft();
      }
    });

    this.el.downloadViBtn.addEventListener('click', () => this.downloadSrt(false));
    this.el.downloadBilingualBtn.addEventListener('click', () => this.downloadSrt(true));
  }

  syncProviderFromSettings() {
    const allowed = ['google_gtx', 'mymemory', 'apps_script'];
    const p = this.appState.settings?.translateProvider;
    this.el.providerSelect.value = allowed.includes(p) ? p : 'google_gtx';
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
    const hasSubs = this.appState.subtitles.length > 0;
    this.el.startBtn.disabled = running || !hasSubs;
    this.el.missingBtn.disabled = running || !hasSubs;
    this.el.stopBtn.disabled = !running;
    this.el.providerSelect.disabled = running;
  }

  updateStats() {
    const subs = this.appState.subtitles || [];
    const total = subs.length;
    const translated = subs.filter((s) => (s.translatedText || '').trim().length > 0).length;

    this.el.countBadge.textContent = `${translated}/${total} dòng đã dịch`;
    this.el.downloadViBtn.disabled = translated === 0;
    this.el.downloadBilingualBtn.disabled = translated === 0;

    if (total === 0) {
      this.el.sourceStatus.textContent = 'Chưa có phụ đề tiếng Trung';
      this.el.sourceStatus.className = 'status-chip';
    } else if (translated === total) {
      this.el.sourceStatus.textContent = `Đã dịch đủ ${total}/${total} dòng`;
      this.el.sourceStatus.className = 'status-chip ready';
    } else {
      this.el.sourceStatus.textContent = `Sẵn sàng dịch ${total} dòng (${translated} dòng đã có bản dịch)`;
      this.el.sourceStatus.className = 'status-chip ready';
    }

    this.setRunningUI(this.isRunning);
  }

  async translateAll(onlyMissing = false) {
    const subs = this.appState.subtitles || [];
    if (!subs.length) {
      this.showError('Chưa có phụ đề tiếng Trung. Hãy trích xuất ở mục 02 hoặc nhập file .SRT.');
      return;
    }

    const targets = subs
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => {
        if (!item.text?.trim()) return false;
        return onlyMissing ? !(item.translatedText || '').trim() : true;
      });

    if (!targets.length) {
      this.setProgress(100, 'Tất cả các dòng đều đã có bản dịch tiếng Việt.');
      return;
    }

    this.clearError();
    this.abortController = new AbortController();
    this.setRunningUI(true);

    const provider = this.el.providerSelect.value;
    const endpoint = this.appState.settings?.translateEndpoint || '';

    let doneCount = 0;
    let failCount = 0;
    const total = targets.length;

    this.setProgress(1, `Bắt đầu dịch ${total} dòng (0/${total})...`);

    try {
      for (const { item, index } of targets) {
        if (this.abortController.signal.aborted) break;

        try {
          const translated = await translateSingleLine(
            item.text,
            provider,
            endpoint,
            this.abortController.signal
          );
          item.translatedText = translated;

          // Cập nhật trực tiếp ô nhập tương ứng trên DOM để không mất vị trí cuộn
          const viTextarea = this.el.listContainer.querySelector(
            `textarea[data-vi-index="${index}"]`
          );
          if (viTextarea) viTextarea.value = translated;
        } catch (err) {
          if (err.name === 'AbortError') break;
          failCount++;
          console.warn(`Lỗi dịch dòng #${index + 1}:`, err);
        }

        doneCount++;
        const pct = (doneCount / total) * 100;
        this.setProgress(
          pct,
          `Đang dịch câu ${doneCount}/${total}${failCount ? ` (lỗi ${failCount} dòng)` : ''}...`
        );
        this.updateStats();
        this.notifyChanged();

        // Nghỉ nhẹ 140ms giữa các dòng để tránh bị giới hạn tần suất miễn phí
        if (doneCount < total && !this.abortController.signal.aborted) {
          await delay(140, this.abortController.signal);
        }
      }

      if (this.abortController.signal.aborted) {
        this.setProgress(
          (doneCount / total) * 100,
          `Đã dừng dịch ở câu ${doneCount}/${total}. Bạn có thể bấm "Chỉ dịch dòng còn trống" để chạy tiếp.`
        );
      } else if (failCount > 0) {
        this.showError(
          `Hoàn tất nhưng có ${failCount} dòng chưa dịch được do nghẽn mạng. Hãy bấm "Chỉ dịch dòng còn trống" để thử lại.`
        );
        this.setProgress(100, `Đã dịch xong ${total - failCount}/${total} dòng.`);
      } else {
        this.setProgress(100, `Hoàn tất! Đã dịch trọn vẹn ${total}/${total} dòng sang tiếng Việt.`);
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        this.showError(`Lỗi dịch thuật: ${err.message}`);
      }
    } finally {
      this.abortController = null;
      this.setRunningUI(false);
      this.updateStats();
      this.notifyChanged();
    }
  }

  stopTranslation() {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  async retranslateRow(index, buttonEl, viTextarea) {
    const item = this.appState.subtitles[index];
    if (!item?.text?.trim()) return;

    this.clearError();
    const oldLabel = buttonEl.textContent;
    buttonEl.disabled = true;
    buttonEl.textContent = 'Đang dịch...';

    try {
      const translated = await translateSingleLine(
        item.text,
        this.el.providerSelect.value,
        this.appState.settings?.translateEndpoint || ''
      );
      item.translatedText = translated;
      viTextarea.value = translated;
      this.updateStats();
      this.notifyChanged();
    } catch (err) {
      this.showError(`Không thể dịch lại dòng #${index + 1}: ${err.message}`);
    } finally {
      buttonEl.disabled = false;
      buttonEl.textContent = oldLabel;
    }
  }

  downloadSrt(bilingual = false) {
    const subs = this.appState.subtitles || [];
    if (!subs.length) return;
    const content = buildVietnameseSrt(subs, bilingual);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const baseName = (this.appState.videoMeta?.name || 'phu-de-viet').replace(/\.[^.]+$/, '');
    const a = document.createElement('a');
    a.href = url;
    a.download = bilingual ? `${baseName}_song_ngu.srt` : `${baseName}_vi.srt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  notifyChanged() {
    if (typeof this.callbacks.onTranslationsUpdated === 'function') {
      this.callbacks.onTranslationsUpdated(this.appState.subtitles);
    }
  }

  refresh() {
    this.updateStats();
    const subs = this.appState.subtitles || [];
    const container = this.el.listContainer;

    if (!subs.length) {
      container.innerHTML =
        `<p class="card-desc">Chưa có dữ liệu phụ đề. Hãy chạy <strong>02 Trích xuất phụ đề</strong> hoặc nhập file <code>.srt</code> tiếng Trung tại đây.</p>`;
      return;
    }

    container.innerHTML = '';
    subs.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'srt-row';

      row.innerHTML = `
        <div class="srt-row-head">
          <span class="srt-index">#${index + 1}</span>
          <div class="srt-times">
            <input type="text" class="srt-time-input" data-field="start" value="${secondsToSrtTime(item.start)}" aria-label="Bắt đầu" />
            <span>→</span>
            <input type="text" class="srt-time-input" data-field="end" value="${secondsToSrtTime(item.end)}" aria-label="Kết thúc" />
          </div>
          <div class="row-mini-actions">
            <button type="button" class="btn-mini-primary">Dịch lại</button>
            <button type="button" class="btn-mini-danger">Xóa</button>
          </div>
        </div>
        <div class="bilingual-grid">
          <div class="lang-box">
            <label>Gốc tiếng Trung</label>
            <textarea class="srt-textarea zh-input" rows="2" placeholder="Lời thoại tiếng Trung..."></textarea>
          </div>
          <div class="lang-box">
            <label>Bản dịch tiếng Việt (sửa trực tiếp)</label>
            <textarea class="srt-textarea vi-input" data-vi-index="${index}" rows="2" placeholder="Bản dịch tiếng Việt sẽ hiện ở đây..."></textarea>
          </div>
        </div>
      `;

      const zhInput = row.querySelector('.zh-input');
      const viInput = row.querySelector('.vi-input');
      const reBtn = row.querySelector('.btn-mini-primary');
      const delBtn = row.querySelector('.btn-mini-danger');

      zhInput.value = item.text || '';
      viInput.value = item.translatedText || '';

      zhInput.addEventListener('input', (e) => {
        item.text = e.target.value;
        this.notifyChanged();
      });

      viInput.addEventListener('input', (e) => {
        item.translatedText = e.target.value;
        this.updateStats();
        this.notifyChanged();
      });

      row.querySelectorAll('.srt-time-input').forEach((input) => {
        input.addEventListener('change', (e) => {
          const parsed = srtTimeToSeconds(e.target.value);
          if (parsed === null) {
            e.target.value = secondsToSrtTime(item[input.dataset.field]);
            return;
          }
          item[input.dataset.field] = parsed;
          this.notifyChanged();
        });
      });

      reBtn.addEventListener('click', () => this.retranslateRow(index, reBtn, viInput));

      delBtn.addEventListener('click', () => {
        this.appState.subtitles.splice(index, 1);
        this.refresh();
        this.notifyChanged();
      });

      container.appendChild(row);
    });
  }
}
