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
  // --- PTY (terminal shell) — tab-aware ---
  ptyWrite: (tabId: string, data: string) => ipcRenderer.send('pty:write', tabId, data),
  ptyResize: (tabId: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', { tabId, cols, rows }),
  onPtyData: (callback: (tabId: string, data: string) => void) => {
    ipcRenderer.on('pty:data', (_event, tabId, data) => callback(tabId, data));
  },
  onPtyExit: (callback: (tabId: string, code: number) => void) => {
    ipcRenderer.on('pty:exit', (_event, tabId, code) => callback(tabId, code));
  },

  // --- Tab lifecycle ---
  tabCreate: (tabId: string) => ipcRenderer.send('tab:create', tabId),
  tabClose: (tabId: string) => ipcRenderer.send('tab:close', tabId),
  onTabNewRequest: (callback: () => void) => {
    ipcRenderer.on('tab:new-request', () => callback());
  },

  // --- AI (Ollama streaming) — tab-aware ---
  aiQuery: (tabId: string, prompt: string, context: string) =>
    ipcRenderer.send('ai:query', { tabId, prompt, context }),
  onAiChunk: (callback: (tabId: string, chunk: string) => void) => {
    ipcRenderer.on('ai:chunk', (_event, tabId, chunk) => callback(tabId, chunk));
  },
  onAiDone: (callback: (tabId: string) => void) => {
    ipcRenderer.on('ai:done', (_event, tabId) => callback(tabId));
  },
  onAiError: (callback: (tabId: string, error: string) => void) => {
    ipcRenderer.on('ai:error', (_event, tabId, error) => callback(tabId, error));
  },

  // --- Filesystem tab-completion — tab-aware ---
  fsComplete: (tabId: string, partial: string) =>
    ipcRenderer.invoke('fs:complete', tabId, partial) as Promise<string[]>,

  // --- App info ---
  getVersion: () => ipcRenderer.invoke('app:get-version') as Promise<string>,
  getPlatform: () => process.platform,

  // --- Config & Ollama model selection ---
  configGet: () => ipcRenderer.invoke('config:get'),
  configGetTheme: () => ipcRenderer.invoke('config:get-theme'),
  configOpen: () => ipcRenderer.invoke('config:open'),
  configSaveModel: (model: string) =>
    ipcRenderer.invoke('config:save-model', model),
  ollamaListModels: () =>
    ipcRenderer.invoke('ollama:list-models') as Promise<
      { ok: true; models: string[] } | { ok: false; error: string }
    >,

  // --- Hotkey (intercepted at Electron level, configurable) ---
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
