/* SCNet inference stays in a dedicated worker; terminate it to cancel and free
 * the large WASM heap. Audio and predictions never leave this device. */
import { separateInBlocks } from './ai-stem-core.mjs';

self.onmessage = async (event) => {
  const { left, right, sampleRate } = event.data;
  try {
    const result = await separateInBlocks(left, right, sampleRate, {
      compact: true, device: 'wasm', output: 'int16', blockSec: 20,
      onStage: stage => self.postMessage({ type: 'stage', stage }),
      onProgress: (done, total) => self.postMessage({ type: 'progress', value: total ? done / total : 0 })
    });
    const transfer = [];
    for (const pair of Object.values(result.stems)) for (const channel of pair) transfer.push(channel.buffer);
    self.postMessage({ type: 'done', stems: result.stems, sampleRate: result.sampleRate }, transfer);
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error && error.message || error) });
  }
};
