import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1';

env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL_ID = 'Xenova/mms-tts-vie';
let cachedSynthesizer = null;

// Chuyển số nguyên thành chữ tiếng Việt để MMS-TTS đọc tự nhiên
const DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];

function readThreeDigits(num, full) {
  const h = Math.floor(num / 100);
  const t = Math.floor((num % 100) / 10);
  const u = num % 10;
  let res = '';

  if (h > 0 || full) {
    res += `${DIGITS[h]} trăm`;
    if (t === 0 && u > 0) res += ' linh';
  }

  if (t > 1) {
    res += ` ${DIGITS[t]} mươi`;
    if (u === 1) res += ' mốt';
    else if (u === 5) res += ' lăm';
    else if (u > 0) res += ` ${DIGITS[u]}`;
  } else if (t === 1) {
    res += ' mười';
    if (u === 5) res += ' lăm';
    else if (u > 0) res += ` ${DIGITS[u]}`;
  } else if (u > 0) {
    res += ` ${DIGITS[u]}`;
  }

  return res.trim();
}

function numberToVietnamese(numStr) {
  const n = parseInt(numStr, 10);
  if (!Number.isFinite(n)) return numStr;
  if (n === 0) return 'không';
  if (n > 999999999999) return numStr.split('').map((c) => DIGITS[c] || c).join(' ');

  const scales = ['', 'nghìn', 'triệu', 'tỷ'];
  const groups = [];
  let temp = n;
  while (temp > 0) {
    groups.push(temp % 1000);
    temp = Math.floor(temp / 1000);
  }

  const parts = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i] === 0) continue;
    const isFull = i < groups.length - 1;
    const text = readThreeDigits(groups[i], isFull);
    parts.push(scales[i] ? `${text} ${scales[i]}` : text);
  }
  return parts.join(' ').trim();
}

function normalizeVietnameseText(rawText) {
  let text = String(rawText || '')
    .replace(/\r?\n+/g, ' ')
    .replace(/%/g, ' phần trăm ')
    .replace(/&/g, ' và ')
    .replace(/(\d+)[.,](\d+)/g, (_, a, b) => `${numberToVietnamese(a)} phẩy ${numberToVietnamese(b)}`)
    .replace(/\d+/g, (m) => numberToVietnamese(m))
    .toLowerCase()
    .replace(/[^a-zàáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ\s,.;!?-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

function splitLongClause(text, maxLen = 140) {
  if (text.length <= maxLen) return [text];
  const rawParts = text.split(/([,.;!?]+)/).reduce((acc, cur) => {
    if (/^[,.;!?]+$/.test(cur) && acc.length) {
      acc[acc.length - 1] += cur;
    } else if (cur.trim()) {
      acc.push(cur.trim());
    }
    return acc;
  }, []);

  const chunks = [];
  let current = '';
  for (const part of rawParts) {
    if ((current + ' ' + part).trim().length <= maxLen) {
      current = (current + ' ' + part).trim();
    } else {
      if (current) chunks.push(current);
      current = part;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text];
}

function trimSilence(samples, threshold = 0.004, padSamples = 640) {
  let start = 0;
  let end = samples.length - 1;
  while (start < end && Math.abs(samples[start]) < threshold) start++;
  while (end > start && Math.abs(samples[end]) < threshold) end--;
  if (start >= end) return samples;
  const s = Math.max(0, start - padSamples);
  const e = Math.min(samples.length, end + padSamples);
  return samples.slice(s, e);
}

async function getSynthesizer() {
  if (cachedSynthesizer) return cachedSynthesizer;

  self.postMessage({
    type: 'status',
    message: 'Đang tải mô hình giọng đọc tiếng Việt (Xenova/mms-tts-vie ~38MB)...'
  });

  try {
    cachedSynthesizer = await pipeline('text-to-speech', MODEL_ID, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: (progress) => {
        self.postMessage({ type: 'model-progress', progress });
      }
    });
  } catch {
    cachedSynthesizer = await pipeline('text-to-speech', MODEL_ID, {
      device: 'wasm',
      progress_callback: (progress) => {
        self.postMessage({ type: 'model-progress', progress });
      }
    });
  }

  return cachedSynthesizer;
}

async function synthesizeSentence(synthesizer, text) {
  const normalized = normalizeVietnameseText(text);
  if (!normalized) return { audio: new Float32Array(0), samplingRate: 16000 };

  const parts = splitLongClause(normalized);
  const buffers = [];
  let samplingRate = 16000;

  for (const part of parts) {
    const clean = part.replace(/[,.;!?-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const out = await synthesizer(clean);
    samplingRate = out.sampling_rate || 16000;
    buffers.push(trimSilence(new Float32Array(out.audio)));
  }

  if (!buffers.length) return { audio: new Float32Array(0), samplingRate };
  if (buffers.length === 1) return { audio: buffers[0], samplingRate };

  const gap = Math.round(samplingRate * 0.1);
  const totalLen = buffers.reduce((sum, b) => sum + b.length, 0) + gap * (buffers.length - 1);
  const merged = new Float32Array(totalLen);
  let offset = 0;
  buffers.forEach((b, i) => {
    merged.set(b, offset);
    offset += b.length + (i < buffers.length - 1 ? gap : 0);
  });
  return { audio: merged, samplingRate };
}

self.addEventListener('message', async (event) => {
  const { type, id, items } = event.data || {};

  if (type === 'synthesize-one') {
    try {
      const synth = await getSynthesizer();
      const { audio, samplingRate } = await synthesizeSentence(synth, event.data.text);
      self.postMessage({ type: 'one-done', id, audio, samplingRate }, [audio.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id, message: err?.message || 'Lỗi tạo giọng đọc.' });
    }
    return;
  }

  if (type === 'synthesize-batch') {
    try {
      const synth = await getSynthesizer();
      const total = items.length;

      for (let i = 0; i < total; i++) {
        const item = items[i];
        self.postMessage({
          type: 'line-start',
          current: i + 1,
          total,
          index: item.index
        });

        const { audio, samplingRate } = await synthesizeSentence(synth, item.text);
        self.postMessage(
          {
            type: 'line-done',
            current: i + 1,
            total,
            index: item.index,
            audio,
            samplingRate
          },
          [audio.buffer]
        );
      }

      self.postMessage({ type: 'batch-complete', total });
    } catch (err) {
      self.postMessage({ type: 'error', message: err?.message || 'Lỗi tạo giọng đọc hàng loạt.' });
    }
  }
});
