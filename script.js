import { VideoManager } from './modules/video.js';

const STORAGE_KEYS = {
  HISTORY: 'kaito_review_ai_history_v1',
  SETTINGS: 'kaito_review_ai_settings_v1'
};

const TAB_META = {
  home: ['Trang chủ', 'Tải video tiếng Trung đầu vào và theo dõi quy trình Việt hóa tự động'],
  subtitle: ['Trích xuất phụ đề', 'Nhận diện giọng nói tiếng Trung và tạo SRT chuẩn thời gian (Giai đoạn 3)'],
  translate: ['Dịch phụ đề', 'Dịch Trung → Việt đầy đủ nội dung và chỉnh sửa trực tiếp (Giai đoạn 4)'],
  voice: ['Tạo giọng đọc', 'Chuyển phụ đề thành giọng đọc tiếng Việt và đồng bộ thời gian (Giai đoạn 5)'],
  mask: ['Che chữ video', 'Nhận diện chữ Trung Quốc và tạo vùng làm mờ/che tùy chỉnh (Giai đoạn 6)'],
  logo: ['Thêm logo', 'Tải logo cá nhân, chỉnh vị trí, kích thước và độ trong suốt (Giai đoạn 6)'],
  export: ['Xuất video', 'Ghép âm thanh, phụ đề, logo và xuất file MP4 giữ độ phân giải gốc (Giai đoạn 7)'],
  history: ['Lịch sử dự án', 'Danh sách các video đã nạp và xử lý trên trình duyệt này'],
  settings: ['Cài đặt', 'Tùy chỉnh chất lượng xuất, mô hình AI và nguồn dịch miễn phí']
};

// Trạng thái dùng chung cho toàn bộ các module giai đoạn sau
export const AppState = {
  videoFile: null,
  videoMeta: null,
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

function initNavigation() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const menuToggle = document.getElementById('menuToggle');
  const navItems = document.querySelectorAll('.nav-item');

  const closeMobileMenu = () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('show');
  };

  menuToggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('show');
  });

  overlay.addEventListener('click', closeMobileMenu);

  navItems.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      navItems.forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-panel').forEach((p) => {
        p.classList.toggle('active', p.id === `tab-${tab}`);
      });

      const [title, subtitle] = TAB_META[tab] || ['KAI TỒ REVIEW AI', ''];
      document.getElementById('pageTitle').textContent = title;
      document.getElementById('pageSubtitle').textContent = subtitle;
      closeMobileMenu();
    });
  });
}

function initSettingsForm() {
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
    const msg = document.getElementById('settingsSaveMsg');
    msg.textContent = 'Đã lưu cài đặt vào trình duyệt.';
    setTimeout(() => { msg.textContent = ''; }, 3000);
  });
}

function updateStep1UI(loaded, meta = null) {
  const badge = document.getElementById('activeVideoBadge');
  const step1 = document.querySelector('[data-step="1"]');
  const step1Desc = document.getElementById('step1Desc');
  const step1State = document.getElementById('step1State');
  const progressBar = document.getElementById('pipelineProgressBar');
  const progressPercent = document.getElementById('pipelinePercent');
  const statusText = document.getElementById('pipelineStatusText');

  if (loaded && meta) {
    badge.textContent = `Đã nạp: ${meta.resolution} (${meta.durationFormatted})`;
    badge.classList.add('ready');
    step1.classList.add('done');
    step1Desc.textContent = `${meta.name} • ${meta.sizeFormatted}`;
    step1State.textContent = 'Xong';
    progressBar.style.width = '9%';
    progressPercent.textContent = '9%';
    statusText.textContent = 'Bước 1 hoàn tất — Video sẵn sàng cho nhận diện phụ đề (GĐ 3)';
  } else {
    badge.textContent = 'Chưa có video';
    badge.classList.remove('ready');
    step1.classList.remove('done');
    step1Desc.textContent = 'Chưa có tệp video';
    step1State.textContent = 'Chờ';
    progressBar.style.width = '0%';
    progressPercent.textContent = '0%';
    statusText.textContent = 'Chờ tải video đầu vào...';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initSettingsForm();
  renderHistory();
  detectHardwareSupport();

  document.getElementById('clearHistoryBtn').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEYS.HISTORY);
    renderHistory();
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
        pushHistory(meta);
      },
      onVideoCleared: () => {
        AppState.videoFile = null;
        AppState.videoMeta = null;
        updateStep1UI(false);
      }
    }
  );
});
