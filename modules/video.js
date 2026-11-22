/**
 * Module quản lý video đầu vào (Giai đoạn 2)
 * - Xác thực định dạng, dung lượng, khả năng giải mã của trình duyệt
 * - Đọc metadata thật (độ phân giải, thời lượng, tỷ lệ khung hình)
 * - Hỗ trợ chụp khung hình ra Canvas (phục vụ OCR & Che chữ ở Giai đoạn 6)
 */

const ALLOWED_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm'];
const RAM_WARNING_BYTES = 500 * 1024 * 1024; // 500 MB

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, idx)).toFixed(idx >= 2 ? 2 : 1)} ${units[idx]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return hrs > 0 ? `${pad(hrs)}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

function getAspectRatio(width, height) {
  if (!width || !height) return '—';
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(width, height);
  return `${width / d}:${height / d}`;
}

export class VideoManager {
  constructor(elements, callbacks = {}) {
    this.el = elements;
    this.callbacks = callbacks;
    this.currentFile = null;
    this.currentObjectUrl = null;
    this.metadata = null;

    this.bindEvents();
  }

  bindEvents() {
    const { dropZone, videoInput, selectVideoBtn, removeVideoBtn, captureFrameBtn } = this.el;

    selectVideoBtn.addEventListener('click', () => videoInput.click());
    dropZone.addEventListener('click', () => videoInput.click());
    dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        videoInput.click();
      }
    });

    videoInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) this.loadFile(file);
    });

    ['dragenter', 'dragover'].forEach((evt) => {
      dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach((evt) => {
      dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
      });
    });

    dropZone.addEventListener('drop', (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file) this.loadFile(file);
    });

    removeVideoBtn.addEventListener('click', () => this.clearVideo());
    captureFrameBtn.addEventListener('click', () => this.captureCurrentFrame());
  }

  showError(message) {
    this.el.errorBox.textContent = message;
    this.el.errorBox.classList.remove('hidden');
  }

  clearMessages() {
    this.el.errorBox.classList.add('hidden');
    this.el.warningBox.classList.add('hidden');
  }

  validateFile(file) {
    const lowerName = file.name.toLowerCase();
    const hasValidExt = ALLOWED_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
    const hasValidMime = file.type.startsWith('video/') || file.type === '';

    if (!hasValidExt && !hasValidMime) {
      return {
        ok: false,
        message: 'Tệp không hợp lệ. Vui lòng chọn video định dạng MP4, MOV, MKV hoặc WebM.'
      };
    }

    if (file.size === 0) {
      return { ok: false, message: 'Tệp video bị rỗng (0 byte), không thể xử lý.' };
    }

    return { ok: true };
  }

  loadFile(file) {
    this.clearMessages();
    const check = this.validateFile(file);
    if (!check.ok) {
      this.showError(check.message);
      return;
    }

    // Cảnh báo bộ nhớ trình duyệt cho FFmpeg.wasm
    if (file.size >= RAM_WARNING_BYTES) {
      this.el.warningBox.textContent =
        `Cảnh báo bộ nhớ: Video nặng ${formatBytes(file.size)}. ` +
        `Xử lý trực tiếp trên trình duyệt (WebAssembly) có giới hạn RAM khoảng 2GB/tab; ` +
        `nếu xuất gặp lỗi thiếu bộ nhớ, hãy cắt nhỏ video hoặc chọn giảm độ phân giải 720p ở Cài đặt.`;
      this.el.warningBox.classList.remove('hidden');
    }

    // Giải phóng URL cũ tránh rò rỉ RAM
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
    }

    const url = URL.createObjectURL(file);
    const player = this.el.player;

    const onLoadedMetadata = () => {
      cleanupListeners();

      if (!player.videoWidth || !player.videoHeight) {
        URL.revokeObjectURL(url);
        this.showError(
          'Trình duyệt không giải mã được hình ảnh của video này (thường gặp với MKV/MOV dùng codec HEVC/H.265). ' +
          'Hãy chuyển sang MP4 (H.264) hoặc mở bằng Chrome/Edge mới nhất.'
        );
        return;
      }

      this.currentFile = file;
      this.currentObjectUrl = url;
      this.metadata = {
        name: file.name,
        size: file.size,
        sizeFormatted: formatBytes(file.size),
        type: file.type || file.name.split('.').pop().toUpperCase(),
        width: player.videoWidth,
        height: player.videoHeight,
        resolution: `${player.videoWidth} × ${player.videoHeight}`,
        duration: player.duration,
        durationFormatted: formatDuration(player.duration),
        aspectRatio: getAspectRatio(player.videoWidth, player.videoHeight),
        loadedAt: new Date().toISOString()
      };

      this.renderMetadata();
      this.el.workspace.classList.remove('hidden');
      this.el.framePreviewContainer.classList.add('hidden');

      if (typeof this.callbacks.onVideoLoaded === 'function') {
        this.callbacks.onVideoLoaded(this.currentFile, this.metadata);
      }
    };

    const onError = () => {
      cleanupListeners();
      URL.revokeObjectURL(url);
      this.showError(
        'Không thể mở tệp video này trên trình duyệt hiện tại. Tệp có thể bị hỏng hoặc dùng codec không hỗ trợ.'
      );
    };

    const cleanupListeners = () => {
      player.removeEventListener('loadedmetadata', onLoadedMetadata);
      player.removeEventListener('error', onError);
    };

    player.addEventListener('loadedmetadata', onLoadedMetadata);
    player.addEventListener('error', onError);
    player.src = url;
    player.load();
  }

  renderMetadata() {
    const m = this.metadata;
    this.el.fileName.textContent = m.name;
    this.el.fileName.title = m.name;
    this.el.resolution.textContent = m.resolution;
    this.el.duration.textContent = m.durationFormatted;
    this.el.size.textContent = m.sizeFormatted;
    this.el.format.textContent = m.type;
    this.el.aspect.textContent = m.aspectRatio;
  }

  captureCurrentFrame() {
    const player = this.el.player;
    if (!this.metadata || player.readyState < 2) {
      this.showError('Video chưa sẵn sàng khung hình để chụp.');
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = player.videoWidth;
    canvas.height = player.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(player, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/png');
    this.el.capturedFrameImg.src = dataUrl;
    this.el.downloadFrameLink.href = dataUrl;
    this.el.frameTimestampLabel.textContent =
      `Khung hình tại ${formatDuration(player.currentTime)} (${canvas.width}×${canvas.height})`;
    this.el.framePreviewContainer.classList.remove('hidden');

    return canvas;
  }

  clearVideo() {
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }
    this.currentFile = null;
    this.metadata = null;
    this.el.player.removeAttribute('src');
    this.el.player.load();
    this.el.videoInput.value = '';
    this.el.workspace.classList.add('hidden');
    this.el.framePreviewContainer.classList.add('hidden');
    this.clearMessages();

    if (typeof this.callbacks.onVideoCleared === 'function') {
      this.callbacks.onVideoCleared();
    }
  }
}
