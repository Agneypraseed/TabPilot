import { env, pipeline, TextStreamer } from '@huggingface/transformers';
import { resolveLocalCommand } from './local-command.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

const models = {
  'wasm:onnx-community/Qwen2.5-0.5B-Instruct': { repo: 'onnx-community/Qwen2.5-0.5B-Instruct', dtype: 'q8' },
  // The newer optimized embedding uses GatherBlockQuantized, unavailable on WASM.
  'wasm:onnx-community/gemma-3-270m-it-ONNX': { repo: 'onnx-community/gemma-3-270m-it-ONNX', dtype: 'q4f16', revision: 'cfd5c04f84a64766d63efc5bb1d2cf31f34a4a90' }
};
let generator;
let loadedId;

self.onmessage = async ({ data }) => {
  const { id, modelId, messages, actionCandidates, allowCompletion, runtimeUrl } = data;
  const progress = (text) => self.postMessage({ id, progress: { text } });
  try {
    const definition = models[modelId];
    if (!definition) throw new Error('Unknown CPU model.');
    env.backends.onnx.wasm.wasmPaths = runtimeUrl;
    if (loadedId !== modelId) {
      await generator?.dispose();
      generator = null;
      loadedId = null;
      progress('Downloading or opening cached model files. CPU inference; no API key needed…');
      generator = await pipeline('text-generation', definition.repo, {
        device: 'wasm', dtype: definition.dtype, revision: definition.revision || 'main',
        progress_callback: (event) => {
          if (event.status === 'progress') progress(`${event.file}: ${Math.round(event.progress || 0)}% loaded`);
          else if (event.status === 'done') progress(`${event.file} ready. Preparing CPU model…`);
        }
      });
      loadedId = modelId;
    }
    let proposedAction = await propose(messages, progress);
    let nextAction = resolveLocalCommand(proposedAction, actionCandidates);
    let evaluationCount = 1;
    if (nextAction === 'done' && !allowCompletion) {
      proposedAction = await propose([...messages,
        { role: 'assistant', content: proposedAction },
        { role: 'user', content: 'That completion is premature. The pending workflow instruction has not been performed. Choose the next visible control required for this instruction. Return one command with its exact name in double quotes. Do not return Done.' }
      ], progress);
      evaluationCount++;
      nextAction = resolveLocalCommand(proposedAction, actionCandidates);
      if (nextAction === 'done') nextAction = 'ask_user';
    }
    self.postMessage({ id, result: JSON.stringify({
      nextAction, pageType: 'other', confidence: 0,
      consequential: false, textToType: '', proposedAction, evaluationCount,
      choiceScoreSource: 'exact model command parsing; no calibrated task confidence'
    }) });
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};

async function propose(messages, progress) {
  const inputs = generator.tokenizer.apply_chat_template(messages, {
    tokenize: true, return_dict: true, add_generation_prompt: true
  });
  let count = 0;
  progress('CPU model identifying the next action…');
  const result = await generator.model.generate({ ...inputs, do_sample: false, max_new_tokens: 48,
    streamer: new TextStreamer(generator.tokenizer, { skip_prompt: true,
      callback_function: () => {}, token_callback_function: () => progress(`CPU model identifying action (${++count} tokens)…`) })
  });
  return generator.tokenizer.decode(Array.from(result.data).slice(inputs.input_ids.dims.at(-1)), { skip_special_tokens: true }).trim();
}
