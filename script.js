import { VideoManager } from './modules/video.js';
import { SubtitleManager } from './modules/subtitle.js';

const STORAGE_KEYS = {
  HISTORY: 'kaito_review_ai_history_v1',
  SETTINGS: 'kaito_review_ai_settings_v1'
};

const TAB_META = {
  home: ['Trang chủ', 'Tải video tiếng Trung đầu vào và theo dõi quy trình Việt hóa tự động'],
  subtitle: ['Trích xuất phụ đề', 'Nhận diện giọng nói tiếng Trung bằng Whisper AI và tạo file SRT chuẩn thời gian'],
  translate: ['Dịch phụ đề', 'Dịch Trung → Việt đầy đủ nội dung và chỉnh sửa trực tiếp (Giai đoạn 4)'],
  voice: ['Tạo giọng đọc', 'Chuyển phụ đề thành giọng đọc tiếng Việt và đồng bộ thời gian (Giai đoạn 5)'],
  mask: ['Che chữ video', 'Nhận diện chữ Trung Quốc và tạo vùng làm mờ/che tùy chỉnh (Giai đoạn 6)'],
  logo: ['Thêm logo', 'Tải logo cá nhân, chỉnh vị trí, kích thước và độ trong suốt (Giai đoạn 6)'],
  export: ['Xuất video', 'Ghép âm thanh, phụ đề, logo và xuất file MP4 giữ độ phân giải gốc (Giai đoạn 7)'],
  history: ['Lịch sử dự án', 'Danh sách các video đã nạp và xử lý trên trình duyệt này'],
  settings: ['Cài đặt', 'Tùy chỉnh chất lượng xuất, mô hình AI và nguồn dịch miễn phí']
};

export const AppState = {
  videoFile: null,
  videoMeta: null,
  subtitles: [],
  settings: loadSettings()
};

function loadSettings() {
  const defaults = {
    quality: 'source',
    bitrate: 'balanced',
    whisperModel: 'onnx-community/whisper-small',
    translateProvider: 'mymemory',
    translateEndpoint: ''
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS) || '{}');
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

function saveSettings(settings) {
  AppState.settings = settings;
  localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
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
  const hasSubs = AppState.subtitles.length > 0;

  let pct = 0;
  let text = 'Chờ tải video đầu vào...';

  if (hasVideo && !hasSubs) {
    pct = 9;
    text = 'Bước 1 hoàn tất — Chuyển sang mục "02 Trích xuất phụ đề" để chạy Whisper AI';
  } else if (hasSubs) {
    pct = 27;
    text = `Hoàn tất Bước 1–3 (${AppState.subtitles.length} dòng SRT) — Sẵn sàng cho Dịch thuật (GĐ 4)`;
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

function updateSteps23UI(subtitles) {
  const step2 = document.querySelector('[data-step="2"]');
  const step3 = document.querySelector('[data-step="3"]');
  const step2Desc = document.getElementById('step2Desc');
  const step2State = document.getElementById('step2State');
  const step3Desc = document.getElementById('step3Desc');
  const step3State = document.getElementById('step3State');

  if (subtitles.length > 0) {
    step2.classList.add('done');
    step2Desc.textContent = 'Đã nhận diện giọng nói tiếng Trung';
    step2State.textContent = 'Xong';

    step3.classList.add('done');
    step3Desc.textContent = `Đã tạo ${subtitles.length} dòng phụ đề SRT`;
    step3State.textContent = 'Xong';
  } else {
    step2.classList.remove('done');
    step2Desc.textContent = 'Chuyển sang mục 02 để chạy Whisper AI';
    step2State.textContent = 'Sẵn sàng';

    step3.classList.remove('done');
    step3Desc.textContent = 'Chưa có dòng phụ đề';
    step3State.textContent = 'Chờ';
  }
  updatePipelineProgress();
}

document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  renderHistory();
  detectHardwareSupport();

  document.getElementById('clearHistoryBtn').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEYS.HISTORY);
    renderHistory();
  });

  document.getElementById('goSubtitleBtn').addEventListener('click', () => {
    switchTabFn('subtitle');
  });

  const subtitleManager = new SubtitleManager(
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
      onSubtitlesUpdated: (subs) => updateSteps23UI(subs)
    }
  );

  initSettingsForm(() => subtitleManager.syncModelFromSettings());

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
