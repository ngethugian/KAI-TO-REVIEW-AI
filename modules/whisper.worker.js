import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1';

env.allowLocalModels = false;
env.useBrowserCache = true;

const SAMPLE_RATE = 16000;

// Các câu ảo giác Whisper hay tự bịa khi gặp nhạc nền hoặc khoảng lặng
const HALLUCINATION_PATTERNS = [
  /请不吝点赞|订阅|转发|打赏|支持明镜|点点栏目/i,
  /字幕由|字幕制作|字幕提供|字幕组|校对|翻译[:：]/i,
  /谢谢观看|感谢观看|感谢收看|谢谢收看|谢谢大家|下期再见/i,
  /amara\.org|优优独播剧场|中文字幕|倾情奉献/i
];

let cachedKey = null;
let cachedTranscriber = null;

/**
 * Lọc âm trầm dưới ~85Hz để giảm nhạc nền (BGM) và chuẩn hóa biên độ giọng nói
 */
function preprocessAudio(rawAudio) {
  const len = rawAudio.length;
  const out = new Float32Array(len);
  const rc = 1 / (2 * Math.PI * 85);
  const dt = 1 / SAMPLE_RATE;
  const alpha = rc / (rc + dt);

  let prevIn = 0;
  let prevOut = 0;
  let peak = 0;

  for (let i = 0; i < len; i++) {
    const x = rawAudio[i];
    const y = alpha * (prevOut + x - prevIn);
    prevIn = x;
    prevOut = y;
    out[i] = y;
    const abs = Math.abs(y);
    if (abs > peak) peak = abs;
  }

  if (peak > 0.005) {
    const gain = Math.min(4.0, 0.92 / peak);
    for (let i = 0; i < len; i++) {
      out[i] = Math.max(-1, Math.min(1, out[i] * gain));
    }
  }
  return out;
}

/**
 * Cắt âm thanh thông minh theo khoảng lặng (VAD) để không chặt đứt giữa câu
 * - Bỏ qua các đoạn hoàn toàn im lặng (chống ảo giác)
 * - Tự tìm điểm năng lượng thấp nhất nếu đoạn thoại liên tục dài > 24 giây
 */
function buildSmartChunks(audio, useSmartVad = true) {
  const totalSamples = audio.length;
  const maxChunkSamples = 24 * SAMPLE_RATE;

  if (!useSmartVad) {
    const chunks = [];
    const step = 28 * SAMPLE_RATE;
    for (let s = 0; s < totalSamples; s += step) {
      const e = Math.min(totalSamples, s + step);
      if (e - s >= SAMPLE_RATE * 0.4) chunks.push({ start: s, end: e });
    }
    return chunks;
  }

  const frameSize = Math.round(SAMPLE_RATE * 0.03); // 30ms
  const numFrames = Math.floor(totalSamples / frameSize);
  if (numFrames < 10) return [{ start: 0, end: totalSamples }];

  const rmsList = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    const base = f * frameSize;
    let sum = 0;
    for (let i = 0; i < frameSize; i++) {
      const v = audio[base + i];
      sum += v * v;
    }
    rmsList[f] = Math.sqrt(sum / frameSize);
  }

  // Tính ngưỡng nền tiếng ồn thích ứng (phân vị 15%)
  const sorted = Float32Array.from(rmsList).sort();
  const noiseFloor = sorted[Math.floor(numFrames * 0.15)] || 0.004;
  const speechThreshold = Math.max(0.009, Math.min(0.045, noiseFloor * 2.4));

  // Gom các đoạn có tiếng nói, nối các khoảng ngừng ngắn < 0.45s (15 frame)
  const rawRegions = [];
  let inSpeech = false;
  let segStart = 0;
  let silenceCount = 0;
  const maxBridgeFrames = 15; // 0.45s
  const padFrames = 7;        // 0.21s đệm đầu/cuối câu

  for (let f = 0; f < numFrames; f++) {
    const isVoice = rmsList[f] >= speechThreshold;
    if (isVoice) {
      if (!inSpeech) {
        inSpeech = true;
        segStart = Math.max(0, f - padFrames);
      }
      silenceCount = 0;
    } else if (inSpeech) {
      silenceCount++;
      if (silenceCount >= maxBridgeFrames) {
        const segEnd = Math.min(numFrames, f - silenceCount + padFrames);
        rawRegions.push({ start: segStart * frameSize, end: segEnd * frameSize });
        inSpeech = false;
        silenceCount = 0;
      }
    }
  }

  if (inSpeech) {
    rawRegions.push({ start: segStart * frameSize, end: totalSamples });
  }

  if (!rawRegions.length) {
    // Dự phòng nếu video tiếng quá nhỏ
    return buildSmartChunks(audio, false);
  }

  // Ghép các câu gần nhau vào cùng 1 cụm <= 24 giây để Whisper có đủ ngữ cảnh
  const packed = [];
  for (const reg of rawRegions) {
    // Nếu một vùng liên tục (nhạc nền to) dài > 25 giây -> tìm điểm êm nhất giữa giây 16..24 để cắt
    if (reg.end - reg.start > maxChunkSamples) {
      let cur = reg.start;
      while (cur < reg.end) {
        if (reg.end - cur <= maxChunkSamples) {
          packed.push({ start: cur, end: reg.end });
          break;
        }
        const searchStartFrame = Math.floor((cur + 16 * SAMPLE_RATE) / frameSize);
        const searchEndFrame = Math.min(
          numFrames - 1,
          Math.floor((cur + 24 * SAMPLE_RATE) / frameSize)
        );
        let bestFrame = searchEndFrame;
        let minEnergy = Infinity;
        for (let f = searchStartFrame; f <= searchEndFrame; f++) {
          if (rmsList[f] < minEnergy) {
            minEnergy = rmsList[f];
            bestFrame = f;
          }
        }
        const cutPoint = bestFrame * frameSize;
        packed.push({ start: cur, end: cutPoint });
        cur = cutPoint;
      }
      continue;
    }

    const prev = packed[packed.length - 1];
    if (prev && reg.end - prev.start <= maxChunkSamples && reg.start - prev.end <= 2.5 * SAMPLE_RATE) {
      prev.end = reg.end;
    } else {
      packed.push({ start: reg.start, end: reg.end });
    }
  }

  return packed.filter((c) => c.end - c.start >= SAMPLE_RATE * 0.35);
}

function isHallucination(text) {
  const clean = text.trim();
  if (!clean) return true;
  if (HALLUCINATION_PATTERNS.some((re) => re.test(clean))) return true;
  // Lọc lỗi lặp cùng 1 cụm chữ liên tiếp từ 4 lần trở lên
  if (/(.{1,6})\1{3,}/.test(clean)) return true;
  return false;
}

/**
 * Tách câu tiếng Trung quá dài theo dấu câu để phụ đề gọn và mốc thời gian sát hơn
 */
function splitLongSegment(seg, maxChars = 26) {
  const text = seg.text.trim();
  if (text.length <= maxChars) return [seg];

  const parts = text
    .split(/([。！？；，、]+)/)
    .reduce((acc, token) => {
      if (/^[。！？；，、]+$/.test(token) && acc.length) {
        acc[acc.length - 1] += token;
      } else if (token.trim()) {
        acc.push(token.trim());
      }
      return acc;
    }, []);

  if (parts.length <= 1) return [seg];

  const grouped = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length <= maxChars) {
      buf += p;
    } else {
      if (buf) grouped.push(buf);
      buf = p;
    }
  }
  if (buf) grouped.push(buf);
  if (grouped.length <= 1) return [seg];

  const totalChars = grouped.reduce((s, g) => s + g.length, 0) || 1;
  const totalDur = Math.max(0.4, seg.end - seg.start);
  let cursor = seg.start;

  return grouped.map((g, i) => {
    const dur = (g.length / totalChars) * totalDur;
    const start = cursor;
    const end = i === grouped.length - 1 ? seg.end : Math.min(seg.end, start + dur);
    cursor = end;
    return {
      start,
      end: Math.max(start + 0.35, end),
      text: g.replace(/[，、]+$/, '').trim()
    };
  });
}

async function getTranscriber(modelId, preferredDevice) {
  const loadAttempt = async (device, dtype) => {
    const key = `${modelId}|${device}|${JSON.stringify(dtype)}`;
    if (cachedKey === key && cachedTranscriber) {
      return { transcriber: cachedTranscriber, device };
    }

    self.postMessage({
      type: 'status',
      message: `Đang tải mô hình ${modelId} (${device.toUpperCase()})... Lần đầu sẽ mất 1–2 phút và tự lưu cache.`
    });

    const instance = await pipeline('automatic-speech-recognition', modelId, {
      device,
      dtype,
      progress_callback: (progress) => {
        self.postMessage({ type: 'model-progress', progress });
      }
    });

    cachedKey = key;
    cachedTranscriber = instance;
    return { transcriber: instance, device };
  };

  const isTurbo = modelId.includes('turbo');

  if (preferredDevice === 'webgpu') {
    const gpuDtypes = isTurbo
      ? [
          { encoder_model: 'fp16', decoder_model_merged: 'q4' },
          { encoder_model: 'fp32', decoder_model_merged: 'q4' }
        ]
      : [{ encoder_model: 'fp32', decoder_model_merged: 'q4' }];

    for (const dt of gpuDtypes) {
      try {
        return await loadAttempt('webgpu', dt);
      } catch (err) {
        self.postMessage({
          type: 'status',
          message: `Đang thử cấu hình WebGPU dự phòng (${err.message})...`
        });
      }
    }

    self.postMessage({
      type: 'status',
      message: 'WebGPU không hỗ trợ cấu hình mô hình này. Tự động chuyển sang CPU (WASM)...'
    });
  }

  return await loadAttempt('wasm', 'q8');
}

self.addEventListener('message', async (event) => {
  const {
    type,
    audio,
    modelId,
    device,
    language,
    useSmartVad = true,
    splitLongLines = true,
    filterHallucinations = true
  } = event.data || {};

  if (type !== 'transcribe') return;

  try {
    self.postMessage({
      type: 'status',
      message: 'Đang lọc tạp âm nhạc nền & phân tích khoảng lặng (VAD)...'
    });

    const cleanedAudio = preprocessAudio(audio);
    const totalDuration = cleanedAudio.length / SAMPLE_RATE;
    const chunks = buildSmartChunks(cleanedAudio, useSmartVad);

    const { transcriber, device: activeDevice } = await getTranscriber(modelId, device);

    self.postMessage({
      type: 'status',
      message: `Sẵn sàng (${activeDevice.toUpperCase()}). Bắt đầu nhận diện ${chunks.length} đoạn thoại thông minh...`
    });

    const allSegments = [];

    for (let i = 0; i < chunks.length; i++) {
      const { start: startSample, end: endSample } = chunks[i];
      const slice = cleanedAudio.subarray(startSample, endSample);
      const offsetSec = startSample / SAMPLE_RATE;
      const sliceDuration = slice.length / SAMPLE_RATE;

      self.postMessage({
        type: 'chunk-start',
        chunkIndex: i + 1,
        totalChunks: chunks.length,
        offsetSec,
        totalDuration
      });

      const output = await transcriber(slice, {
        language: language || 'chinese',
        task: 'transcribe',
        return_timestamps: true,
        condition_on_previous_text: false,
        no_repeat_ngram_size: 3
      });

      const rawChunks =
        Array.isArray(output?.chunks) && output.chunks.length > 0
          ? output.chunks
          : output?.text?.trim()
            ? [{ text: output.text, timestamp: [0, sliceDuration] }]
            : [];

      const newSegments = [];

      for (const item of rawChunks) {
        const cleanText = (item.text || '').trim();
        if (!cleanText) continue;
        if (filterHallucinations && isHallucination(cleanText)) continue;

        const rawStart = typeof item.timestamp?.[0] === 'number' ? item.timestamp[0] : 0;
        const rawEnd = typeof item.timestamp?.[1] === 'number' ? item.timestamp[1] : sliceDuration;

        let start = Math.max(0, offsetSec + rawStart);
        let end = Math.min(totalDuration, Math.max(start + 0.4, offsetSec + rawEnd));

        // Đảm bảo mốc thời gian không đè ngược lên câu trước
        const prev = allSegments[allSegments.length - 1];
        if (prev && start < prev.end) {
          start = prev.end;
          if (end <= start + 0.3) end = Math.min(totalDuration, start + 0.45);
        }

        // Tránh lặp y hệt câu liền kề
        if (prev && prev.text === cleanText && start - prev.end < 1.0) continue;

        const baseSeg = { start, end, text: cleanText };
        const finalParts = splitLongLines ? splitLongSegment(baseSeg, 26) : [baseSeg];

        for (const p of finalParts) {
          if (!p.text) continue;
          allSegments.push(p);
          newSegments.push(p);
        }
      }

      self.postMessage({
        type: 'chunk-done',
        chunkIndex: i + 1,
        totalChunks: chunks.length,
        segments: newSegments
      });
    }

    self.postMessage({
      type: 'complete',
      segments: allSegments,
      device: activeDevice
    });
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err?.message || 'Lỗi không xác định khi chạy Whisper AI.'
    });
  }
});
