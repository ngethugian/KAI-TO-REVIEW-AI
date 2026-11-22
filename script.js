import { VideoManager } from './modules/video.js';
import { SubtitleManager } from './modules/subtitle.js';
import { TranslateManager } from './modules/translate.js';
import { VoiceManager } from './modules/voice.js';

const STORAGE_KEYS = {
  HISTORY: 'kaito_review_ai_history_v1',
  SETTINGS: 'kaito_review_ai_settings_v1',
  SRT_DRAFT: 'kaito_review_ai_srt_draft_v1'
};

const TAB_META = {
  home: ['Trang chủ', 'Tải video tiếng Trung đầu vào và theo dõi quy trình Việt hóa tự động'],
  subtitle: ['Trích xuất phụ đề', 'Nhận diện giọng nói tiếng Trung bằng Whisper AI và tạo file SRT chuẩn thời gian'],
  translate: ['Dịch phụ đề', 'Dịch toàn bộ phụ đề Trung → Việt miễn phí và chỉnh sửa song ngữ trực tiếp'],
  voice: ['Tạo giọng đọc', 'Chuyển phụ đề thành giọng đọc tiếng Việt và đồng bộ âm thanh khớp thời gian'],
  mask: ['Che chữ video', 'Nhận diện chữ Trung Quốc và tạo vùng làm mờ/che tùy chỉnh (Giai đoạn 6)'],
  logo: ['Thêm logo', 'Tải logo cá nhân, chỉnh vị trí, kích thước và độ trong suốt (Giai đoạn 6)'],
  export: ['Xuất video', 'Ghép âm thanh, phụ đề, logo và xuất file MP4 giữ độ phân giải gốc (Giai đoạn 7)'],
  history: ['Lịch sử dự án', 'Danh sách các video đã nạp và bản nháp SRT lưu trên trình duyệt này'],
  settings: ['Cài đặt', 'Tùy chỉnh chất lượng xuất, mô hình AI và nguồn dịch miễn phí']
};

export const AppState = {
  videoFile: null,
  videoMeta: null,
  subtitles: [],
  voiceAudioBlob: null,
  voiceAudioUrl: null,
  voiceMeta: null,
  settings: loadSettings()
};

function loadSettings() {
  const defaults = {
    quality: 'source',
    bitrate: 'balanced',
    whisperModel: 'onnx-community/whisper-small',
    translateProvider: 'google_gtx',
    translateEndpoint: ''
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS) || '{}');
    const merged = { ...defaults, ...saved };
    if (!['google_gtx', 'mymemory', 'apps_script'].includes(merged.translateProvider)) {
      merged.translateProvider = 'google_gtx';
    }
    return merged;
  } catch {
    return defaults;
  }
}

function saveSettings(settings) {
  AppState.settings = settings;
  localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
}

function saveSrtDraft() {
  if (!AppState.subtitles.length) return;
  try {
    localStorage.setItem(
      STORAGE_KEYS.SRT_DRAFT,
      JSON.stringify({
        videoName: AppState.videoMeta?.name || 'Dự án SRT',
        savedAt: new Date().toLocaleString('vi-VN'),
        subtitles: AppState.subtitles
      })
    );
    updateDraftButtons();
  } catch {
    // ignore
  }
}

function loadSrtDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SRT_DRAFT);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.subtitles) && parsed.subtitles.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function updateDraftButtons() {
  const draft = loadSrtDraft();
  const trBtn = document.getElementById('trRestoreDraftBtn');
  const histBtn = document.getElementById('historyRestoreDraftBtn');
  const hasDraft = Boolean(draft);
  trBtn.classList.toggle('hidden', !hasDraft);
  histBtn.classList.toggle('hidden', !hasDraft);
  if (hasDraft) {
    trBtn.textContent = `Khôi phục bản lưu (${draft.subtitles.length} dòng)`;
  }
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.HISTORY) || '[]');
  } catch {
    return [];
  }
}

function pushHistory(videoMeta) {
  const list = getHistory();
  list.unshift({
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    name: videoMeta.name,
    resolution: videoMeta.resolution,
    duration: videoMeta.durationFormatted,
    size: videoMeta.sizeFormatted,
    date: new Date().toLocaleString('vi-VN')
  });
  localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(list.slice(0, 20)));
  renderHistory();
}

function renderHistory() {
  const container = document.getElementById('historyList');
  const list = getHistory();

  if (!list.length) {
    container.innerHTML = `<p class="card-desc">Chưa có dự án nào được lưu. Hãy tải một video ở Trang chủ để bắt đầu.</p>`;
    return;
  }

  container.innerHTML = list
    .map(
      (item) => `
      <div class="history-item">
        <div>
          <strong>${escapeHtml(item.name)}</strong>
          <div class="history-meta">${item.resolution} • ${item.duration} • ${item.size} • Nạp lúc ${item.date}</div>
        </div>
        <span class="step-state">Đã nạp video</span>
      </div>`
    )
    .join('');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

async function detectHardwareSupport() {
  const label = document.getElementById('gpuStatusText');
  if ('gpu' in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        label.textContent = 'WebGPU sẵn sàng (Tăng tốc AI)';
        return;
      }
    } catch {
      // fallback below
    }
  }
  label.textContent = 'Chế độ CPU (WebAssembly)';
}

let switchTabFn = () => {};

function initNavigation() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const menuToggle = document.getElementById('menuToggle');
  const navItems = document.querySelectorAll('.nav-item');

  const closeMobileMenu = () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('show');
  };

  switchTabFn = (tab) => {
    navItems.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${tab}`);
    });

    const [title, subtitle] = TAB_META[tab] || ['KAI TỒ REVIEW AI', ''];
    document.getElementById('pageTitle').textContent = title;
    document.getElementById('pageSubtitle').textContent = subtitle;
    closeMobileMenu();
  };

  menuToggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('show');
  });

  overlay.addEventListener('click', closeMobileMenu);

  navItems.forEach((btn) => {
    btn.addEventListener('click', () => switchTabFn(btn.dataset.tab));
  });
}

function initSettingsForm(onSettingsSaved) {
  const s = AppState.settings;
  document.getElementById('settingQuality').value = s.quality;
  document.getElementById('settingBitrate').value = s.bitrate;
  document.getElementById('settingWhisperModel').value = s.whisperModel;
  document.getElementById('settingTranslateProvider').value = s.translateProvider;
  document.getElementById('settingTranslateEndpoint').value = s.translateEndpoint;

  document.getElementById('settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettings({
      quality: document.getElementById('settingQuality').value,
      bitrate: document.getElementById('settingBitrate').value,
      whisperModel: document.getElementById('settingWhisperModel').value,
      translateProvider: document.getElementById('settingTranslateProvider').value,
      translateEndpoint: document.getElementById('settingTranslateEndpoint').value.trim()
    });
    if (typeof onSettingsSaved === 'function') onSettingsSaved();
    const msg = document.getElementById('settingsSaveMsg');
    msg.textContent = 'Đã lưu cài đặt vào trình duyệt.';
    setTimeout(() => { msg.textContent = ''; }, 3000);
  });
}

function updatePipelineProgress() {
  const progressBar = document.getElementById('pipelineProgressBar');
  const progressPercent = document.getElementById('pipelinePercent');
  const statusText = document.getElementById('pipelineStatusText');

  const hasVideo = Boolean(AppState.videoFile);
  const subs = AppState.subtitles;
  const hasSubs = subs.length > 0;
  const translatedCount = subs.filter((s) => (s.translatedText || '').trim().length > 0).length;
  const hasVoice = Boolean(AppState.voiceAudioBlob);

  let pct = 0;
  let text = 'Chờ tải video đầu vào...';

  if (hasVoice) {
    pct = 64;
    text = 'Hoàn tất Bước 1–7 (Đã có giọng đọc đồng bộ) — Sẵn sàng cho Che chữ & Logo (GĐ 6)';
  } else if (hasSubs && translatedCount > 0) {
    pct = 45;
    text = `Hoàn tất Bước 1–5 (${translatedCount}/${subs.length} dòng tiếng Việt) — Chuyển sang mục "04 Tạo giọng đọc"`;
  } else if (hasSubs) {
    pct = 27;
    text = `Hoàn tất Bước 1–3 (${subs.length} dòng SRT) — Chuyển sang mục "03 Dịch phụ đề"`;
  } else if (hasVideo) {
    pct = 9;
    text = 'Bước 1 hoàn tất — Chuyển sang mục "02 Trích xuất phụ đề" để chạy Whisper AI';
  }

  progressBar.style.width = `${pct}%`;
  progressPercent.textContent = `${pct}%`;
  statusText.textContent = text;
}

function updateStep1UI(loaded, meta = null) {
  const badge = document.getElementById('activeVideoBadge');
  const step1 = document.querySelector('[data-step="1"]');
  const step1Desc = document.getElementById('step1Desc');
  const step1State = document.getElementById('step1State');

  if (loaded && meta) {
    badge.textContent = `Đã nạp: ${meta.resolution} (${meta.durationFormatted})`;
    badge.classList.add('ready');
    step1.classList.add('done');
    step1Desc.textContent = `${meta.name} • ${meta.sizeFormatted}`;
    step1State.textContent = 'Xong';
  } else {
    badge.textContent = 'Chưa có video';
    badge.classList.remove('ready');
    step1.classList.remove('done');
    step1Desc.textContent = 'Chưa có tệp video';
    step1State.textContent = 'Chờ';
  }
  updatePipelineProgress();
}

function updateSteps2345UI(subtitles) {
  const step2 = document.querySelector('[data-step="2"]');
  const step3 = document.querySelector('[data-step="3"]');
  const step4 = document.querySelector('[data-step="4"]');
  const step5 = document.querySelector('[data-step="5"]');

  const total = subtitles.length;
  const translated = subtitles.filter((s) => (s.translatedText || '').trim().length > 0).length;

  if (total > 0) {
    step2.classList.add('done');
    document.getElementById('step2Desc').textContent = 'Đã nhận diện giọng nói tiếng Trung';
    document.getElementById('step2State').textContent = 'Xong';

    step3.classList.add('done');
    document.getElementById('step3Desc').textContent = `Đã tạo ${total} dòng phụ đề SRT`;
    document.getElementById('step3State').textContent = 'Xong';
  } else {
    step2.classList.remove('done');
    document.getElementById('step2Desc').textContent = 'Chuyển sang mục 02 để chạy Whisper AI';
    document.getElementById('step2State').textContent = 'Sẵn sàng';

    step3.classList.remove('done');
    document.getElementById('step3Desc').textContent = 'Chưa có dòng phụ đề';
    document.getElementById('step3State').textContent = 'Chờ';
  }

  if (translated > 0) {
    step4.classList.add('done');
    document.getElementById('step4Desc').textContent = `Đã dịch ${translated}/${total} dòng sang tiếng Việt`;
    document.getElementById('step4State').textContent = translated === total ? 'Xong' : 'Đang dịch';

    step5.classList.add('done');
    document.getElementById('step5Desc').textContent = 'Có thể chỉnh sửa và tải file SRT tiếng Việt';
    document.getElementById('step5State').textContent = 'Sẵn sàng';
  } else {
    step4.classList.remove('done');
    document.getElementById('step4Desc').textContent = 'Chuyển sang mục 03 để dịch miễn phí';
    document.getElementById('step4State').textContent = 'Sẵn sàng';

    step5.classList.remove('done');
    document.getElementById('step5Desc').textContent = 'Chưa có bản dịch tiếng Việt';
    document.getElementById('step5State').textContent = 'Chờ';
  }

  updatePipelineProgress();
}

function updateSteps67UI(info) {
  const step6 = document.querySelector('[data-step="6"]');
  const step7 = document.querySelector('[data-step="7"]');

  if (info) {
    step6.classList.add('done');
    document.getElementById('step6Desc').textContent = info.sourceLabel;
    document.getElementById('step6State').textContent = 'Xong';

    step7.classList.add('done');
    document.getElementById('step7Desc').textContent = 'Bản âm thanh WAV đã đồng bộ sẵn sàng ghép video';
    document.getElementById('step7State').textContent = 'Xong';
  } else {
    step6.classList.remove('done');
    document.getElementById('step6Desc').textContent = 'Chuyển sang mục 04 để tạo giọng đọc';
    document.getElementById('step6State').textContent = 'Sẵn sàng';

    step7.classList.remove('done');
    document.getElementById('step7Desc').textContent = 'Chưa có bản ghép âm thanh';
    document.getElementById('step7State').textContent = 'Chờ';
  }
  updatePipelineProgress();
}

document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  renderHistory();
  updateDraftButtons();
  detectHardwareSupport();

  document.getElementById('clearHistoryBtn').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEYS.HISTORY);
    renderHistory();
  });

  document.getElementById('goSubtitleBtn').addEventListener('click', () => switchTabFn('subtitle'));
  document.getElementById('goTranslateBtn').addEventListener('click', () => switchTabFn('translate'));
  document.getElementById('goVoiceBtn').addEventListener('click', () => switchTabFn('voice'));

  let subtitleManager;
  let translateManager;
  let voiceManager;

  const restoreDraft = () => {
    const draft = loadSrtDraft();
    if (!draft) return;
    AppState.subtitles = draft.subtitles;
    subtitleManager.subtitles = draft.subtitles;
    subtitleManager.renderSubtitles();
    translateManager.refresh();
    voiceManager.refresh();
    updateSteps2345UI(draft.subtitles);
    switchTabFn('translate');
  };

  document.getElementById('historyRestoreDraftBtn').addEventListener('click', restoreDraft);

  subtitleManager = new SubtitleManager(
    {
      sourceStatus: document.getElementById('subSourceStatus'),
      modelSelect: document.getElementById('subModelSelect'),
      deviceSelect: document.getElementById('subDeviceSelect'),
      startBtn: document.getElementById('subStartBtn'),
      stopBtn: document.getElementById('subStopBtn'),
      importAudioBtn: document.getElementById('subImportAudioBtn'),
      audioInput: document.getElementById('subAudioInput'),
      importSrtBtn: document.getElementById('subImportSrtBtn'),
      srtInput: document.getElementById('subSrtInput'),
      errorBox: document.getElementById('subErrorBox'),
      progressBox: document.getElementById('subProgressBox'),
      progressText: document.getElementById('subProgressText'),
      progressPercent: document.getElementById('subProgressPercent'),
      progressBar: document.getElementById('subProgressBar'),
      countBadge: document.getElementById('subCountBadge'),
      addLineBtn: document.getElementById('subAddLineBtn'),
      downloadSrtBtn: document.getElementById('subDownloadSrtBtn'),
      listContainer: document.getElementById('subListContainer')
    },
    AppState,
    {
      onSubtitlesUpdated: (subs) => {
        updateSteps2345UI(subs);
        translateManager.refresh();
        voiceManager.refresh();
        saveSrtDraft();
      }
    }
  );

  translateManager = new TranslateManager(
    {
      sourceStatus: document.getElementById('trSourceStatus'),
      providerSelect: document.getElementById('trProviderSelect'),
      startBtn: document.getElementById('trStartBtn'),
      missingBtn: document.getElementById('trMissingBtn'),
      stopBtn: document.getElementById('trStopBtn'),
      importSrtBtn: document.getElementById('trImportSrtBtn'),
      srtInput: document.getElementById('trSrtInput'),
      restoreDraftBtn: document.getElementById('trRestoreDraftBtn'),
      errorBox: document.getElementById('trErrorBox'),
      progressBox: document.getElementById('trProgressBox'),
      progressText: document.getElementById('trProgressText'),
      progressPercent: document.getElementById('trProgressPercent'),
      progressBar: document.getElementById('trProgressBar'),
      countBadge: document.getElementById('trCountBadge'),
      downloadViBtn: document.getElementById('trDownloadViBtn'),
      downloadBilingualBtn: document.getElementById('trDownloadBilingualBtn'),
      listContainer: document.getElementById('trListContainer')
    },
    AppState,
    {
      onTranslationsUpdated: (subs) => {
        subtitleManager.subtitles = subs;
        subtitleManager.renderSubtitles();
        voiceManager.refresh();
        updateSteps2345UI(subs);
        saveSrtDraft();
      },
      onRestoreDraft: restoreDraft
    }
  );

  voiceManager = new VoiceManager(
    {
      sourceStatus: document.getElementById('voiceSourceStatus'),
      engineSelect: document.getElementById('voiceEngineSelect'),
      proxySettings: document.getElementById('voiceProxySettings'),
      voiceNameSelect: document.getElementById('voiceNameSelect'),
      proxyUrlInput: document.getElementById('voiceProxyUrlInput'),
      speedRange: document.getElementById('voiceSpeedRange'),
      speedValue: document.getElementById('voiceSpeedValue'),
      volumeRange: document.getElementById('voiceVolumeRange'),
      volumeValue: document.getElementById('voiceVolumeValue'),
      syncModeSelect: document.getElementById('voiceSyncModeSelect'),
      generateBtn: document.getElementById('voiceGenerateBtn'),
      stopBtn: document.getElementById('voiceStopBtn'),
      remixBtn: document.getElementById('voiceRemixBtn'),
      importAudioBtn: document.getElementById('voiceImportAudioBtn'),
      audioInput: document.getElementById('voiceAudioInput'),
      errorBox: document.getElementById('voiceErrorBox'),
      progressBox: document.getElementById('voiceProgressBox'),
      progressText: document.getElementById('voiceProgressText'),
      progressPercent: document.getElementById('voiceProgressPercent'),
      progressBar: document.getElementById('voiceProgressBar'),
      masterCard: document.getElementById('voiceMasterCard'),
      masterInfo: document.getElementById('voiceMasterInfo'),
      masterPlayer: document.getElementById('voiceMasterPlayer'),
      downloadBtn: document.getElementById('voiceDownloadBtn'),
      countBadge: document.getElementById('voiceCountBadge'),
      listContainer: document.getElementById('voiceListContainer')
    },
    AppState,
    {
      onVoiceReady: (_blob, info) => updateSteps67UI(info)
    }
  );

  initSettingsForm(() => {
    subtitleManager.syncModelFromSettings();
    translateManager.syncProviderFromSettings();
  });

  new VideoManager(
    {
      dropZone: document.getElementById('dropZone'),
      videoInput: document.getElementById('videoInput'),
      selectVideoBtn: document.getElementById('selectVideoBtn'),
      removeVideoBtn: document.getElementById('removeVideoBtn'),
      captureFrameBtn: document.getElementById('captureFrameBtn'),
      errorBox: document.getElementById('videoErrorBox'),
      warningBox: document.getElementById('memoryWarningBox'),
      workspace: document.getElementById('videoWorkspace'),
      player: document.getElementById('mainVideoPlayer'),
      fileName: document.getElementById('videoFileName'),
      resolution: document.getElementById('videoResolution'),
      duration: document.getElementById('videoDuration'),
      size: document.getElementById('videoSize'),
      format: document.getElementById('videoFormat'),
      aspect: document.getElementById('videoAspect'),
      framePreviewContainer: document.getElementById('framePreviewContainer'),
      capturedFrameImg: document.getElementById('capturedFrameImg'),
      downloadFrameLink: document.getElementById('downloadFrameLink'),
      frameTimestampLabel: document.getElementById('frameTimestampLabel')
    },
    {
      onVideoLoaded: (file, meta) => {
        AppState.videoFile = file;
        AppState.videoMeta = meta;
        updateStep1UI(true, meta);
        subtitleManager.setVideo(file, meta);
        pushHistory(meta);
      },
      onVideoCleared: () => {
        AppState.videoFile = null;
        AppState.videoMeta = null;
        updateStep1UI(false);
        subtitleManager.setVideo(null, null);
      }
    }
  );
});
