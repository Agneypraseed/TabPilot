import { CreateWebWorkerMLCEngine } from '@mlc-ai/web-llm';

let engine = null;
let worker = null;
let activeModelId = '';
let pendingLoad = null;
let cpuWorker = null;
let cpuRequest = null;
let requestId = 0;

export function isCpuModel(modelId) { return String(modelId).startsWith('wasm:'); }

export async function checkLocalRuntime(modelId) {
  if (!isCpuModel(modelId)) return checkWebGpu();
  return typeof WebAssembly === 'object' && typeof Worker === 'function'
    ? { available: true, reason: '' }
    : { available: false, reason: 'This browser does not support the CPU WebAssembly runtime.' };
}

export function cancelLocalInference(reason = 'Local inference stopped.') {
  cpuWorker?.terminate();
  cpuWorker = null;
  clearTimeout(cpuRequest?.timer);
  cpuRequest?.reject(new Error(reason));
  cpuRequest = null;
  worker?.terminate();
  worker = null;
  engine = null;
  activeModelId = '';
}

function completeOnCpu({ modelId, messages, actionCandidates, allowCompletion, onProgress }) {
  if (cpuRequest) throw new Error('A local inference is already running.');
  if (!cpuWorker) {
    cpuWorker = new Worker(new URL('./local-cpu-worker.js', import.meta.url), { type: 'module' });
    cpuWorker.onmessage = ({ data }) => {
      if (!cpuRequest || data.id !== cpuRequest.id) return;
      clearTimeout(cpuRequest.timer);
      cpuRequest.timer = setTimeout(() => cancelLocalInference('The local model made no progress for three minutes. Try again to resume loading cached files.'), 180_000);
      if (data.progress) { cpuRequest.onProgress?.(data.progress); return; }
      const pending = cpuRequest;
      clearTimeout(pending.timer);
      cpuRequest = null;
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.result);
    };
    cpuWorker.onerror = (event) => {
      clearTimeout(cpuRequest?.timer);
      cpuRequest?.reject(new Error(event.message || 'CPU model worker failed.'));
      cpuRequest = null;
      cpuWorker?.terminate();
      cpuWorker = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    cpuRequest = { id, resolve, reject, onProgress, timer: setTimeout(() => cancelLocalInference('The local model made no progress for three minutes. Try again to resume loading cached files.'), 180_000) };
    cpuWorker.postMessage({ id, modelId, messages, actionCandidates, allowCompletion,
      runtimeUrl: new URL('./vendor/', import.meta.url).href });
  });
}

export async function checkWebGpu() {
  if (!navigator.gpu) return { available: false, reason: 'This Chrome build does not expose WebGPU.' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter
      ? { available: true, reason: '' }
      : { available: false, reason: 'Chrome could not find a WebGPU adapter for this device.' };
  } catch (error) {
    return { available: false, reason: error?.message || 'WebGPU could not start.' };
  }
}

export async function completeLocally({ modelId, messages, actionCandidates, allowCompletion, responseSchema, onProgress }) {
  try {
    if (isCpuModel(modelId)) return await completeOnCpu({ modelId, messages, actionCandidates, allowCompletion, onProgress });
    await loadModel(modelId, onProgress);
    onProgress?.({ text: 'Generating the next browser action…' });
    const response = await engine.chat.completions.create({
      messages,
      temperature: 0,
      max_tokens: 220,
      response_format: { type: 'json_object', schema: responseSchema }
    });
    return response.choices?.[0]?.message?.content || '';
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`On-device model failed: ${detail || 'unknown worker error'}`, { cause: error });
  }
}

async function loadModel(modelId, onProgress) {
  if (engine && activeModelId === modelId) return;
  if (pendingLoad) {
    await pendingLoad;
    if (engine && activeModelId === modelId) return;
  }

  pendingLoad = (async () => {
    worker?.terminate();
    worker = new Worker(new URL('./local-model-worker.js', import.meta.url), { type: 'module' });
    engine = null;
    activeModelId = '';
    try {
      engine = await CreateWebWorkerMLCEngine(worker, modelId, {
        initProgressCallback: (progress) => onProgress?.(progress)
      });
      activeModelId = modelId;
    } catch (error) {
      worker?.terminate();
      worker = null;
      engine = null;
      activeModelId = '';
      throw error;
    }
  })();

  try {
    await pendingLoad;
  } finally {
    pendingLoad = null;
  }
}
