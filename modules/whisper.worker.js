import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1';

env.allowLocalModels = false;
env.useBrowserCache = true;

const SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 30;

let cachedKey = null;
let cachedTranscriber = null;

async function getTranscriber(modelId, preferredDevice) {
  const tryLoad = async (device) => {
    const key = `${modelId}|${device}`;
    if (cachedKey === key && cachedTranscriber) {
      return { transcriber: cachedTranscriber, device };
    }

    const dtype =
      device === 'webgpu'
        ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
        : 'q8';

    self.postMessage({
      type: 'status',
      message: `Đang tải mô hình ${modelId} (${device.toUpperCase()})... Lần đầu sẽ mất 1–2 phút.`
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

  if (preferredDevice === 'webgpu') {
    try {
      return await tryLoad('webgpu');
    } catch (err) {
      self.postMessage({
        type: 'status',
        message: `WebGPU không tương thích mô hình này (${err.message}). Tự động chuyển sang CPU (WASM)...`
      });
      return await tryLoad('wasm');
    }
  }

  return await tryLoad('wasm');
}

self.addEventListener('message', async (event) => {
  const { type, audio, modelId, device, language } = event.data || {};
  if (type !== 'transcribe') return;

  try {
    const { transcriber, device: activeDevice } = await getTranscriber(modelId, device);

    const totalSamples = audio.length;
    const totalDuration = totalSamples / SAMPLE_RATE;
    const chunkSamples = CHUNK_SECONDS * SAMPLE_RATE;
    const totalChunks = Math.max(1, Math.ceil(totalSamples / chunkSamples));

    self.postMessage({
      type: 'status',
      message: `Đã sẵn sàng (${activeDevice.toUpperCase()}). Bắt đầu nhận diện ${totalChunks} đoạn...`
    });

    const allSegments = [];

    for (let i = 0; i < totalChunks; i++) {
      const startSample = i * chunkSamples;
      const endSample = Math.min(totalSamples, startSample + chunkSamples);
      const slice = audio.subarray(startSample, endSample);
      const offsetSec = startSample / SAMPLE_RATE;
      const sliceDuration = slice.length / SAMPLE_RATE;

      // Bỏ qua đoạn quá ngắn ở cuối (< 0.3s)
      if (sliceDuration < 0.3) continue;

      self.postMessage({
        type: 'chunk-start',
        chunkIndex: i + 1,
        totalChunks,
        offsetSec,
        totalDuration
      });

      const output = await transcriber(slice, {
        language: language || 'chinese',
        task: 'transcribe',
        return_timestamps: true
      });

      const newSegments = [];
      const rawChunks = Array.isArray(output?.chunks) && output.chunks.length > 0
        ? output.chunks
        : output?.text?.trim()
          ? [{ text: output.text, timestamp: [0, sliceDuration] }]
          : [];

      for (const item of rawChunks) {
        const cleanText = (item.text || '').trim();
        if (!cleanText) continue;

        const rawStart = typeof item.timestamp?.[0] === 'number' ? item.timestamp[0] : 0;
        const rawEnd = typeof item.timestamp?.[1] === 'number' ? item.timestamp[1] : sliceDuration;

        const start = Math.max(0, offsetSec + rawStart);
        const end = Math.min(totalDuration, Math.max(start + 0.3, offsetSec + rawEnd));

        const seg = { start, end, text: cleanText };
        allSegments.push(seg);
        newSegments.push(seg);
      }

      self.postMessage({
        type: 'chunk-done',
        chunkIndex: i + 1,
        totalChunks,
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
