/**
 * Module Dịch phụ đề Trung -> Việt nâng cao (Giai đoạn 4 - Bản nâng cấp ngữ cảnh & AI)
 * - Chế độ Gemini AI miễn phí: Dịch theo cụm 20 dòng theo văn phong (Tiên hiệp / Review / Ngôn tình)
 * - Chế độ Google Dịch theo cụm 8 dòng: Giữ mạch câu, tự dự phòng dịch lẻ nếu lệch dòng
 * - Tự gắn giao diện chọn phong cách & API Key ngay trong Tab 03 (không cần sửa HTML)
 */

import {
  secondsToSrtTime,
  srtTimeToSeconds,
  parseSrtContent
} from './subtitle.js';

const PRO_PREF_KEY = 'kaito_review_ai_translate_pro_v1';

const STYLE_PROMPTS = {
  review:
    'Văn phong review phim / kể chuyện YouTube & TikTok Việt Nam: tự nhiên, cuốn hút, dễ nghe khi đọc thành tiếng, câu gọn gàng nhưng giữ đủ ý, không cắt bỏ chi tiết.',
  xianxia:
    'Văn phong tiên hiệp / huyền huyễn / cổ trang chuẩn Hán-Việt: dùng đúng thuật ngữ (linh khí, thời mạt pháp, tu vi, tông môn, cảnh giới, pháp bảo...), xưng hô chuẩn cổ trang (ta, ngươi, hắn, nàng, lão phu, tiền bối, vãn bối).',
  romance:
    'Văn phong ngôn tình / đô thị / gia đình hiện đại: lời thoại tự nhiên, giàu cảm xúc, xưng hô phù hợp hoàn cảnh (anh, em, cô ấy, anh ta, tổng tài, phu nhân...).',
  standard:
    'Văn phong tiếng Việt tự nhiên, dịch sát nghĩa và chính xác, rõ ràng, dễ hiểu.'
};

function loadProPrefs() {
  try {
    return {
      style: 'xianxia',
      geminiKey: '',
      geminiModel: 'gemini-2.5-flash',
      ...JSON.parse(localStorage.getItem(PRO_PREF_KEY) || '{}')
    };
  } catch {
    return { style: 'xianxia', geminiKey: '', geminiModel: 'gemini-2.5-flash' };
  }
}

function saveProPrefs(prefs) {
  try {
    localStorage.setItem(PRO_PREF_KEY, JSON.stringify(prefs));
  } catch {
    // Bỏ qua nếu trình duyệt chặn storage
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

async function translateViaGoogleGtx(text, signal) {
  const url =
    'https://translate.googleapis.com/translate_a/single' +
    `?client=gtx&sl=zh-CN&tl=vi&dt=t&q=${encodeURIComponent(text)}`;

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Google Dịch trả về lỗi ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data?.[0])) throw new Error('Dữ liệu Google Dịch không hợp lệ.');

  return data[0]
    .map((part) => (Array.isArray(part) ? part[0] : ''))
    .join('')
    .trim();
}

async function translateBatchViaGoogleGtx(lines, signal) {
  const cleanLines = lines.map((l) => String(l || '').replace(/\s*\n+\s*/g, ' ').trim());
  if (cleanLines.length === 1) {
    return [await translateViaGoogleGtx(cleanLines[0], signal)];
  }

  const joined = cleanLines.join('\n');
  const translatedJoined = await translateViaGoogleGtx(joined, signal);
  const parts = translatedJoined.split('\n').map((s) => s.trim());

  // Nếu giữ nguyên đúng số dòng thì dùng bản dịch theo ngữ cảnh
  if (parts.length === cleanLines.length && parts.every((p) => p.length > 0)) {
    return parts;
  }

  // Dự phòng: nếu Google tự gộp/tách dòng thì dịch từng câu để đảm bảo đủ 100% số dòng
  const fallbackResults = [];
  for (const line of cleanLines) {
    if (signal?.aborted) throw new DOMException('Đã hủy', 'AbortError');
    fallbackResults.push(await translateViaGoogleGtx(line, signal));
    await delay(100, signal);
  }
  return fallbackResults;
}

async function translateViaMyMemory(text, signal) {
  const url =
    'https://api.mymemory.translated.net/get' +
    `?q=${encodeURIComponent(text)}&langpair=zh-CN|vi`;

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`MyMemory trả về lỗi ${res.status}`);
  const data = await res.json();
  if (data?.responseStatus && Number(data.responseStatus) !== 200) {
    throw new Error(data.responseDetails || 'MyMemory đạt giới hạn miễn phí tạm thời.');
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
  if (!res.ok) throw new Error(`Apps Script Proxy trả về lỗi ${res.status}`);
  const raw = await res.text();
  try {
    const json = JSON.parse(raw);
    return String(json.translatedText || json.text || raw).trim();
  } catch {
    return raw.trim();
  }
}

async function translateBatchViaGemini(lines, { apiKey, model, style, contextBefore = [] }, signal) {
  if (!apiKey) {
    throw new Error(
      'Bạn chưa nhập Gemini API Key miễn phí. Hãy lấy key miễn phí tại aistudio.google.com/apikey và dán vào ô bên trên, hoặc chuyển sang "Google Dịch theo cụm ngữ cảnh".'
    );
  }

  const styleGuide = STYLE_PROMPTS[style] || STYLE_PROMPTS.review;
  const payloadItems = lines.map((text, idx) => ({ id: idx, zh: String(text || '').trim() }));

  const contextBlock = contextBefore.length
    ? `Ngữ cảnh ${contextBefore.length} câu liền trước (chỉ để hiểu mạch chuyện và giữ xưng hô, KHÔNG dịch lại phần này):\n${contextBefore
        .map((c) => `- ${c}`)
        .join('\n')}\n\n`
    : '';

  const prompt =
    `Bạn là biên dịch viên chuyên Việt hóa phụ đề video Trung Quốc sang tiếng Việt.\n` +
    `Yêu cầu phong cách: ${styleGuide}\n\n` +
    `Quy tắc BẮT BUỘC:\n` +
    `1. Dịch ĐẦY ĐỦ tất cả ${payloadItems.length} dòng trong mảng đầu vào, KHÔNG được gộp dòng, KHÔNG bỏ sót, KHÔNG tự ý rút gọn.\n` +
    `2. Các dòng liên tiếp thường thuộc cùng một câu tiếng Trung bị tách mốc thời gian — hãy đọc liền mạch cả cụm để chia vế dịch sang tiếng Việt cho thật trôi chảy, mượt mà, khớp nhịp đọc.\n` +
    `3. Trả về DUY NHẤT một mảng JSON gồm đúng ${payloadItems.length} chuỗi tiếng Việt theo đúng thứ tự id từ 0 đến ${payloadItems.length - 1}, không kèm giải thích hay markdown.\n\n` +
    contextBlock +
    `Dữ liệu cần dịch:\n${JSON.stringify(payloadItems)}`;

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;

  const doRequest = async () => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.35,
          responseMimeType: 'application/json'
        }
      })
    });

    if (res.status === 429) {
      throw new Error('RATE_LIMIT');
    }
    if (res.status === 400 || res.status === 403) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(
        `Gemini API Key không hợp lệ hoặc bị từ chối (${errData?.error?.message || res.status}).`
      );
    }
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(`Gemini API lỗi ${res.status}: ${errData?.error?.message || 'Không xác định'}`);
    }

    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error('Gemini trả về định dạng không phải JSON hợp lệ.');
    }

    // Chấp nhận dạng ["...", "..."] hoặc [{"vi": "..."}]
    if (Array.isArray(parsed) && parsed.length === lines.length) {
      return parsed.map((item) =>
        typeof item === 'string' ? item.trim() : String(item?.vi || item?.text || '').trim()
      );
    }

    throw new Error(`Số dòng Gemini trả về (${parsed?.length || 0}) không khớp đầu vào (${lines.length}).`);
  };

  try {
    return await doRequest();
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (err.message === 'RATE_LIMIT') {
      await delay(4500, signal);
      return await doRequest();
    }
    // Nếu cụm lớn bị lệch số dòng, tự tách đôi để thử lại chính xác 100%
    if (lines.length > 4 && err.message.includes('không khớp')) {
      const mid = Math.ceil(lines.length / 2);
      const firstHalf = await translateBatchViaGemini(
        lines.slice(0, mid),
        { apiKey, model, style, contextBefore },
        signal
      );
      const secondHalf = await translateBatchViaGemini(
        lines.slice(mid),
        { apiKey, model, style, contextBefore: firstHalf.slice(-2) },
        signal
      );
      return [...firstHalf, ...secondHalf];
    }
    throw err;
  }
}

function buildVietnameseSrt(subtitles, bilingual = false) {
  return subtitles
    .map((item, idx) => {
      const vi = (item.translatedText || '').trim() || (item.text || '').trim();
      const body = bilingual ? `${vi}\n${(item.text || '').trim()}` : vi;
      return `${idx + 1}\n${secondsToSrtTime(item.start)} --> ${secondsToSrtTime(item.end)}\n${body}\n`;
    })
    .join('\n');
}

export class TranslateManager {
  constructor(elements, appState, callbacks = {}) {
    this.el = elements;
    this.appState = appState;
    this.callbacks = callbacks;

    this.prefs = loadProPrefs();
    this.isRunning = false;
    this.abortController = null;

    this.enhanceControlsUI();
    this.bindEvents();
    this.syncProviderFromSettings();
    this.refresh();
  }

  enhanceControlsUI() {
    const providerSelect = this.el.providerSelect;
    providerSelect.innerHTML = `
      <option value="gemini_free">Gemini AI miễn phí (Dịch mượt theo ngữ cảnh & văn phong — Khuyên dùng nhất)</option>
      <option value="google_gtx">Google Dịch theo cụm ngữ cảnh (Miễn phí, không cần API Key)</option>
      <option value="mymemory">MyMemory API (Miễn phí dự phòng)</option>
      <option value="apps_script">Google Apps Script Proxy (Dùng URL ở mục 09 Cài đặt)</option>
    `;

    const grid = providerSelect.closest('.settings-grid');
    if (!grid) return;

    // Nhóm chọn phong cách dịch
    const styleGroup = document.createElement('div');
    styleGroup.className = 'form-group';
    styleGroup.id = 'trStyleGroup';
    styleGroup.innerHTML = `
      <label for="trStyleSelect">Phong cách dịch (Áp dụng cho Gemini AI)</label>
      <select id="trStyleSelect">
        <option value="xianxia">Tiên hiệp / Cổ trang / Huyền huyễn (Chuẩn Hán-Việt)</option>
        <option value="review">Review phim / Kể chuyện cuốn hút (Tự nhiên, dễ đọc thoại)</option>
        <option value="romance">Ngôn tình / Đô thị / Gia đình</option>
        <option value="standard">Phổ thông sát nghĩa</option>
      </select>
    `;

    // Nhóm chọn model Gemini
    const modelGroup = document.createElement('div');
    modelGroup.className = 'form-group';
    modelGroup.id = 'trGeminiModelGroup';
    modelGroup.innerHTML = `
      <label for="trGeminiModelSelect">Mô hình Gemini miễn phí</label>
      <select id="trGeminiModelSelect">
        <option value="gemini-2.5-flash">Gemini 2.5 Flash (Mới nhất, dịch hay & nhanh)</option>
        <option value="gemini-2.0-flash">Gemini 2.0 Flash (Dự phòng ổn định)</option>
      </select>
    `;

    // Nhóm nhập API Key miễn phí
    const keyGroup = document.createElement('div');
    keyGroup.className = 'form-group full-width';
    keyGroup.id = 'trGeminiKeyGroup';
    keyGroup.innerHTML = `
      <label for="trGeminiKeyInput">
        Gemini API Key miễn phí (Lưu riêng trên máy bạn •
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" class="text-link">Lấy Key miễn phí tại Google AI Studio ↗</a>)
      </label>
      <input
        type="password"
        id="trGeminiKeyInput"
        placeholder="Dán API Key bắt đầu bằng AIza... (không bắt buộc nếu dùng Google Dịch theo cụm)"
        autocomplete="off"
      />
    `;

    grid.appendChild(styleGroup);
    grid.appendChild(modelGroup);
    grid.appendChild(keyGroup);

    this.el.styleSelect = styleGroup.querySelector('#trStyleSelect');
    this.el.geminiModelSelect = modelGroup.querySelector('#trGeminiModelSelect');
    this.el.geminiKeyInput = keyGroup.querySelector('#trGeminiKeyInput');
    this.el.geminiExtraGroups = [styleGroup, modelGroup, keyGroup];

    this.el.styleSelect.value = this.prefs.style;
    this.el.geminiModelSelect.value = this.prefs.geminiModel;
    this.el.geminiKeyInput.value = this.prefs.geminiKey;

    // Nếu người dùng đã có key thì ưu tiên mặc định Gemini, chưa có thì dùng Google Dịch theo cụm
    providerSelect.value = this.prefs.geminiKey ? 'gemini_free' : 'google_gtx';
    this.toggleGeminiFields();
  }

  toggleGeminiFields() {
    const isGemini = this.el.providerSelect.value === 'gemini_free';
    (this.el.geminiExtraGroups || []).forEach((g) => {
      g.classList.toggle('hidden', !isGemini);
    });
  }

  bindEvents() {
    this.el.providerSelect.addEventListener('change', () => {
      this.toggleGeminiFields();
      this.clearError();
    });

    this.el.styleSelect?.addEventListener('change', (e) => {
      this.prefs.style = e.target.value;
      saveProPrefs(this.prefs);
    });

    this.el.geminiModelSelect?.addEventListener('change', (e) => {
      this.prefs.geminiModel = e.target.value;
      saveProPrefs(this.prefs);
    });

    this.el.geminiKeyInput?.addEventListener('input', (e) => {
      this.prefs.geminiKey = e.target.value.trim();
      saveProPrefs(this.prefs);
    });

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
    if (this.prefs.geminiKey) {
      this.el.providerSelect.value = 'gemini_free';
    } else {
      const allowed = ['gemini_free', 'google_gtx', 'mymemory', 'apps_script'];
      const p = this.appState.settings?.translateProvider;
      this.el.providerSelect.value = allowed.includes(p) ? p : 'google_gtx';
    }
    this.toggleGeminiFields();
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
    if (this.el.styleSelect) this.el.styleSelect.disabled = running;
    if (this.el.geminiModelSelect) this.el.geminiModelSelect.disabled = running;
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

  applyBatchToDOM(batchTargets, translatedLines) {
    batchTargets.forEach(({ item, index }, i) => {
      const val = (translatedLines[i] || '').trim();
      item.translatedText = val;
      const viTextarea = this.el.listContainer.querySelector(`textarea[data-vi-index="${index}"]`);
      if (viTextarea) viTextarea.value = val;
    });
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

    const provider = this.el.providerSelect.value;
    const endpoint = this.appState.settings?.translateEndpoint || '';

    if (provider === 'gemini_free' && !this.prefs.geminiKey) {
      this.showError(
        'Vui lòng dán Gemini API Key miễn phí vào ô bên trên (lấy tại Google AI Studio), hoặc đổi sang "Google Dịch theo cụm ngữ cảnh".'
      );
      return;
    }

    this.clearError();
    this.abortController = new AbortController();
    this.setRunningUI(true);

    const total = targets.length;
    let doneCount = 0;
    let failCount = 0;
    let prevContext = [];

    const batchSize =
      provider === 'gemini_free' ? 20 : provider === 'google_gtx' ? 8 : 1;

    this.setProgress(
      2,
      `Đang dịch ${total} dòng theo cụm ${batchSize} câu để giữ ngữ cảnh...`
    );

    try {
      for (let offset = 0; offset < total; offset += batchSize) {
        if (this.abortController.signal.aborted) break;

        const batch = targets.slice(offset, offset + batchSize);
        const texts = batch.map((b) => b.item.text);

        try {
          let results = [];
          if (provider === 'gemini_free') {
            results = await translateBatchViaGemini(
              texts,
              {
                apiKey: this.prefs.geminiKey,
                model: this.prefs.geminiModel,
                style: this.prefs.style,
                contextBefore: prevContext
              },
              this.abortController.signal
            );
            prevContext = results.slice(-2);
          } else if (provider === 'google_gtx') {
            results = await translateBatchViaGoogleGtx(texts, this.abortController.signal);
          } else if (provider === 'apps_script') {
            results = [await translateViaAppsScript(texts[0], endpoint, this.abortController.signal)];
          } else {
            results = [await translateViaMyMemory(texts[0], this.abortController.signal)];
          }

          this.applyBatchToDOM(batch, results);
        } catch (err) {
          if (err.name === 'AbortError') break;
          // Lỗi key sai thì dừng luôn báo người dùng
          if (err.message.includes('API Key')) {
            this.showError(err.message);
            break;
          }
          failCount += batch.length;
          console.warn(`Lỗi dịch cụm từ dòng ${offset + 1}:`, err);
        }

        doneCount = Math.min(total, offset + batch.length);
        const pct = (doneCount / total) * 100;
        this.setProgress(
          pct,
          `Đã dịch ${doneCount}/${total} dòng${failCount ? ` (lỗi ${failCount} dòng)` : ''}...`
        );
        this.updateStats();
        this.notifyChanged();

        if (doneCount < total && !this.abortController.signal.aborted) {
          await delay(provider === 'gemini_free' ? 500 : 220, this.abortController.signal);
        }
      }

      if (this.abortController.signal.aborted) {
        this.setProgress(
          (doneCount / total) * 100,
          `Đã dừng ở câu ${doneCount}/${total}. Bấm "Chỉ dịch dòng còn trống" để chạy tiếp.`
        );
      } else if (failCount > 0) {
        this.showError(
          `Có ${failCount} dòng gặp lỗi mạng hoặc vượt giới hạn tạm thời. Hãy bấm "Chỉ dịch dòng còn trống" để dịch nốt.`
        );
        this.setProgress(100, `Hoàn tất ${total - failCount}/${total} dòng.`);
      } else if (this.el.errorBox.classList.contains('hidden')) {
        this.setProgress(100, `Hoàn tất! Đã dịch mượt ${total}/${total} dòng sang tiếng Việt.`);
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
    const subs = this.appState.subtitles;
    const item = subs[index];
    if (!item?.text?.trim()) return;

    this.clearError();
    const oldLabel = buttonEl.textContent;
    buttonEl.disabled = true;
    buttonEl.textContent = 'Đang dịch...';

    try {
      const provider = this.el.providerSelect.value;
      const endpoint = this.appState.settings?.translateEndpoint || '';
      let translated = '';

      if (provider === 'gemini_free') {
        const ctx = subs
          .slice(Math.max(0, index - 2), index)
          .map((s) => s.translatedText || s.text)
          .filter(Boolean);
        const [res] = await translateBatchViaGemini([item.text], {
          apiKey: this.prefs.geminiKey,
          model: this.prefs.geminiModel,
          style: this.prefs.style,
          contextBefore: ctx
        });
        translated = res;
      } else if (provider === 'apps_script') {
        translated = await translateViaAppsScript(item.text, endpoint);
      } else if (provider === 'mymemory') {
        translated = await translateViaMyMemory(item.text);
      } else {
        translated = await translateViaGoogleGtx(item.text);
      }

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
