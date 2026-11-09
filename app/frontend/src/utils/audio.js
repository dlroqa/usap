// Microphone recording shared by Transcribe and the Voice screen's dictation.
// Whisper wants 16 kHz mono PCM16 WAV, so recordings are converted to that on stop.

export function flattenFloat32(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.length;
  });
  return merged;
}

export function resampleLinear(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(newLength);
  for (let i = 0; i < newLength; i += 1) {
    const src = i * ratio;
    const left = Math.floor(src);
    const right = Math.min(input.length - 1, left + 1);
    const weight = src - left;
    output[i] = input[left] * (1 - weight) + input[right] * weight;
  }
  return output;
}

export function encodeWavPcm16(samples, sampleRate = 16000) {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

// Starts recording from the default microphone. stop() releases the mic and resolves
// to a 16 kHz WAV blob; cancel() releases it and throws the audio away.
export async function createMicRecorder() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  processor.onaudioprocess = (event) => {
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(audioContext.destination);

  const release = async () => {
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    await audioContext.close();
  };

  return {
    async stop() {
      await release();
      const merged = flattenFloat32(chunks);
      return encodeWavPcm16(resampleLinear(merged, audioContext.sampleRate, 16000), 16000);
    },
    cancel: release,
  };
}
