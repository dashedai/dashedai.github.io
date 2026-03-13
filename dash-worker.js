/* DashAI — dash-worker.js
   Runs WebLLM engine in a dedicated Web Worker.
   The main thread sends messages and we stream tokens back.
   This keeps the main thread (and browser compositor) completely free. */

let engine = null;
let currentModel = null;

self.onmessage = async (e) => {
  const { type, id, payload } = e.data;

  if (type === 'LOAD') {
    try {
      // Import WebLLM inside the worker
      const { CreateMLCEngine } = await import('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm');

      engine = await CreateMLCEngine(payload.modelId, {
        initProgressCallback: (r) => {
          self.postMessage({
            type: 'LOAD_PROGRESS',
            progress: r.progress || 0,
            text: r.text || ''
          });
        }
      });

      currentModel = payload.modelId;
      self.postMessage({ type: 'LOAD_DONE' });
    } catch (err) {
      self.postMessage({ type: 'LOAD_ERROR', message: err.message });
    }
    return;
  }

  if (type === 'CHAT') {
    if (!engine) {
      self.postMessage({ type: 'CHAT_ERROR', id, message: 'Engine not loaded' });
      return;
    }
    try {
      const stream = await engine.chat.completions.create({
        messages: payload.messages,
        stream: true,
        max_tokens: payload.maxTokens || 900,
        temperature: payload.temperature || 0.7,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || '';
        if (delta) {
          self.postMessage({ type: 'CHAT_TOKEN', id, delta });
        }
      }

      self.postMessage({ type: 'CHAT_DONE', id });
    } catch (err) {
      self.postMessage({ type: 'CHAT_ERROR', id, message: err.message });
    }
    return;
  }

  if (type === 'ABORT') {
    try { if (engine) await engine.interruptGenerate(); } catch(e) {}
    self.postMessage({ type: 'ABORTED', id });
    return;
  }

  if (type === 'UNLOAD') {
    try { if (engine) await engine.unload(); } catch(e) {}
    engine = null;
    currentModel = null;
    self.postMessage({ type: 'UNLOADED' });
    return;
  }
};
