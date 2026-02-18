// ============================================================
// ELECTRON PRELOAD
//
// This is the bridge between the main process (Node.js) and
// the renderer (browser/xterm.js). It exposes a safe, typed
// API via contextBridge — the renderer never gets direct
// access to Node.js or Electron internals.
// ============================================================

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // --- PTY (terminal shell) ---
  ptyWrite: (data: string) => ipcRenderer.send('pty:write', data),
  ptyResize: (cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', { cols, rows }),
  onPtyData: (callback: (data: string) => void) => {
    ipcRenderer.on('pty:data', (_event, data) => callback(data));
  },
  onPtyExit: (callback: (code: number) => void) => {
    ipcRenderer.on('pty:exit', (_event, code) => callback(code));
  },

  // --- AI (Ollama streaming) ---
  aiQuery: (prompt: string, context: string) =>
    ipcRenderer.send('ai:query', { prompt, context }),
  onAiChunk: (callback: (chunk: string) => void) => {
    ipcRenderer.on('ai:chunk', (_event, chunk) => callback(chunk));
  },
  onAiDone: (callback: () => void) => {
    ipcRenderer.on('ai:done', () => callback());
  },
  onAiError: (callback: (error: string) => void) => {
    ipcRenderer.on('ai:error', (_event, error) => callback(error));
  },

  // --- Filesystem tab-completion ---
  fsComplete: (partial: string) =>
    ipcRenderer.invoke('fs:complete', partial) as Promise<string[]>,

  // --- App info ---
  getVersion: () => ipcRenderer.invoke('app:get-version') as Promise<string>,

  // --- Config & Ollama model selection ---
  configGet: () => ipcRenderer.invoke('config:get') as Promise<{ model?: string }>,
  configSaveModel: (model: string) =>
    ipcRenderer.invoke('config:save-model', model) as Promise<{ model?: string }>,
  ollamaListModels: () =>
    ipcRenderer.invoke('ollama:list-models') as Promise<
      { ok: true; models: string[] } | { ok: false; error: string }
    >,

  // --- Hotkey (Ctrl+Space, intercepted at Electron level) ---
  onToggleAIPanel: (callback: () => void) => {
    ipcRenderer.on('toggle-ai-panel', () => callback());
  },

  // --- Context menu: Copy / Paste / Clear ---
  onTermCopy: (callback: () => void) => {
    ipcRenderer.on('term:copy', () => callback());
  },
  onTermPaste: (callback: (text: string) => void) => {
    ipcRenderer.on('term:paste', (_event, text) => callback(text));
  },
  onTermClear: (callback: () => void) => {
    ipcRenderer.on('term:clear', () => callback());
  },
});
