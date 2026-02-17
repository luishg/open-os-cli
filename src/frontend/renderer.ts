// ============================================================
// RENDERER — runs in the Electron browser context
//
// This file does four things:
//   1. Sets up xterm.js and connects it to the PTY (via IPC)
//   2. Manages INLINE AI mode (Ctrl+Space — AI right in the terminal)
//   3. Manages the open-os PANEL overlay (click hint bar)
//   4. Routes AI responses to whichever mode initiated the query
//
// The renderer NEVER talks to Ollama directly.
// It sends queries via electronAPI → main process → Ollama.
// ============================================================

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

declare global {
  interface Window {
    electronAPI: {
      ptyWrite: (data: string) => void;
      ptyResize: (cols: number, rows: number) => void;
      onPtyData: (callback: (data: string) => void) => void;
      onPtyExit: (callback: (code: number) => void) => void;
      aiQuery: (prompt: string, context: string) => void;
      onAiChunk: (callback: (chunk: string) => void) => void;
      onAiDone: (callback: () => void) => void;
      onAiError: (callback: (error: string) => void) => void;
      getVersion: () => Promise<string>;
      configGet: () => Promise<{ model?: string }>;
      configSaveModel: (model: string) => Promise<{ model?: string }>;
      ollamaListModels: () => Promise<
        { ok: true; models: string[] } | { ok: false; error: string }
      >;
      onToggleAIPanel: (callback: () => void) => void;
      onTermCopy: (callback: () => void) => void;
      onTermPaste: (callback: (text: string) => void) => void;
    };
  }
}

// ============================================================
// ANSI styles for inline mode
// ============================================================

const S = {
  reset: '\x1b[0m',
  prompt: '\x1b[96m',         // bright cyan — prompt marker
  input: '\x1b[38;5;117m',    // sky blue — user typing
  dim: '\x1b[2;3m',           // dim italic — thinking indicator
  response: '\x1b[36m',       // cyan — response text
  approval: '\x1b[93m',       // bright yellow — action options
  error: '\x1b[31m',          // red — errors
  brand: '\x1b[38;5;39m',     // dodger blue — branding
  white: '\x1b[1;97m',        // bold bright white
  gray: '\x1b[38;5;245m',     // dim gray
};

// ============================================================
// 1. TERMINAL SETUP
// ============================================================

const term = new Terminal({
  fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
  fontSize: 14,
  cursorBlink: true,
  theme: {
    background: '#1a1a2e',
    foreground: '#e0e0e0',
    cursor: '#00b4d8',
    selectionBackground: '#00b4d844',
  },
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal')!);
fitAddon.fit();

// ============================================================
// WELCOME MESSAGE
// ============================================================

let welcomeShown = false;
let ptyBuffer: string[] = [];

function showWelcome(version: string): void {
  const b = S.brand;
  const d = S.gray;
  const r = S.reset;

  term.write(
    [
      '',
      `${b} ░███████  ░████████   ░███████  ░████████           ░███████   ░███████${r}`,
      `${b}░██    ░██ ░██    ░██ ░██    ░██ ░██    ░██ ░██████ ░██    ░██ ░██${r}`,
      `${b}░██    ░██ ░██    ░██ ░█████████ ░██    ░██         ░██    ░██  ░███████${r}`,
      `${b}░██    ░██ ░███   ░██ ░██        ░██    ░██         ░██    ░██        ░██${r}`,
      `${b} ░███████  ░██░█████   ░███████  ░██    ░██          ░███████   ░███████${r}`,
      `${b}           ░██${r}`,
      `${b}           ░██${r}`,
      '',
      ` ${d}v${version} — Simple terminal. Smart assistance.${r}`,
      ` ${d}Ctrl+Space — open-os assistant${r}`,
      '',
    ].join('\r\n') + '\r\n',
  );
}

// Buffer PTY data until welcome is shown
window.electronAPI.onPtyData((data) => {
  if (!welcomeShown) {
    ptyBuffer.push(data);
  } else {
    term.write(data);
  }
});

// Show welcome, then flush buffered PTY data
window.electronAPI
  .getVersion()
  .catch(() => '0.0.0')
  .then((version) => {
    showWelcome(version);
    welcomeShown = true;
    for (const data of ptyBuffer) {
      term.write(data);
    }
    ptyBuffer = [];
  });

// Pipe: user keystrokes → PTY (or inline handler)
term.onData((data) => {
  if (inlineState !== 'idle') {
    handleInlineInput(data);
  } else {
    window.electronAPI.ptyWrite(data);
  }
});

// Handle PTY exit
window.electronAPI.onPtyExit(() => {
  term.write('\r\n[Process exited]\r\n');
});

// Keep terminal size in sync
function fitTerminal(): void {
  fitAddon.fit();
  window.electronAPI.ptyResize(term.cols, term.rows);
}
window.addEventListener('resize', fitTerminal);
setTimeout(fitTerminal, 100);

// ============================================================
// 2. INLINE AI MODE
//
// Ctrl+Space enters "AI mode" directly in the terminal.
// A colored prompt appears ( open-os > ), the user types their
// question, and the AI response streams inline with distinct
// styling. After the response, approval options appear if
// the AI suggested commands.
//
// States: idle → input → streaming → approval → idle
// ============================================================

type InlineState = 'idle' | 'input' | 'streaming' | 'approval';
let inlineState: InlineState = 'idle';
let inlineInputBuffer = '';
let inlineResponseBuffer = '';
let inlineSuggestedCommand = '';
let inlineFirstChunk = true;

// Which mode initiated the current AI query
let aiQuerySource: 'inline' | 'panel' | null = null;

function enterInlineMode(): void {
  if (inlineState !== 'idle') return;
  inlineState = 'input';
  inlineInputBuffer = '';
  inlineResponseBuffer = '';
  inlineSuggestedCommand = '';
  inlineFirstChunk = true;

  term.write(`\r\n${S.prompt} open-os > ${S.input}`);
}

function handleInlineInput(data: string): void {
  switch (inlineState) {
    case 'input':
      handleInlineTyping(data);
      break;
    case 'streaming':
      if (data === '\x1b') {
        term.write(`${S.reset}\r\n${S.error}[cancelled]${S.reset}`);
        exitInlineMode();
      }
      break;
    case 'approval':
      handleInlineApproval(data);
      break;
  }
}

function handleInlineTyping(data: string): void {
  if (data === '\r') {
    term.write(S.reset);
    submitInlineQuery();
  } else if (data === '\x7f' || data === '\b') {
    if (inlineInputBuffer.length > 0) {
      inlineInputBuffer = inlineInputBuffer.slice(0, -1);
      term.write('\b \b');
    }
  } else if (data === '\x1b' || data === '\x03') {
    term.write(S.reset);
    exitInlineMode();
  } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
    inlineInputBuffer += data;
    term.write(data);
  }
}

function submitInlineQuery(): void {
  const prompt = inlineInputBuffer.trim();
  if (!prompt) {
    exitInlineMode();
    return;
  }

  inlineState = 'streaming';
  aiQuerySource = 'inline';
  inlineFirstChunk = true;
  inlineResponseBuffer = '';

  term.write(`\r\n${S.dim}  ...${S.reset}`);

  const context = captureTerminalContext();
  window.electronAPI.aiQuery(prompt, context);
}

function handleInlineApproval(data: string): void {
  const key = data.toLowerCase();
  const cmd = inlineSuggestedCommand;

  if (key === 'i') {
    term.write(`${S.reset}\r\n`);
    resetInlineState();
    window.electronAPI.ptyWrite('\r');
    setTimeout(() => window.electronAPI.ptyWrite(cmd), 50);
  } else if (key === 'a') {
    term.write(`${S.reset}\r\n`);
    resetInlineState();
    window.electronAPI.ptyWrite('\r');
    setTimeout(() => window.electronAPI.ptyWrite(cmd + '\r'), 50);
  } else if (key === 'c' || data === '\x1b') {
    exitInlineMode();
  }
}

function exitInlineMode(): void {
  term.write(`${S.reset}\r\n`);
  window.electronAPI.ptyWrite('\r');
  resetInlineState();
}

function resetInlineState(): void {
  inlineState = 'idle';
  inlineInputBuffer = '';
  inlineResponseBuffer = '';
  inlineSuggestedCommand = '';
  aiQuerySource = null;
}

// ============================================================
// 3. PANEL (overlay)
//
// Alternative to inline mode. Opened by clicking the hint bar.
// ============================================================

const aiPanel = document.getElementById('ai-panel')!;
const aiSetup = document.getElementById('ai-setup')!;
const aiQuery = document.getElementById('ai-query')!;
const aiInput = document.getElementById('ai-input')! as HTMLInputElement;
const aiSend = document.getElementById('ai-send')!;
const aiOutput = document.getElementById('ai-output')!;
const aiActions = document.getElementById('ai-actions')!;
const aiStatus = document.getElementById('ai-status')!;
const aiModelLabel = document.getElementById('ai-model-label')!;
const aiClose = document.getElementById('ai-close')!;
const hintBar = document.getElementById('hint-bar')!;
const setupMessage = document.getElementById('setup-message')!;
const modelList = document.getElementById('model-list')!;

let aiPanelOpen = false;
let configuredModel: string | undefined;

function updateHintBar(): void {
  const model = configuredModel ? ` · ${configuredModel}` : '';
  hintBar.textContent = `Ctrl+Space — open-os inline  |  Click here — open-os panel${model}`;
}

// Load config on startup
window.electronAPI.configGet().then((config) => {
  configuredModel = config.model;
  updateHintBar();
});

async function openAIPanel(): Promise<void> {
  aiPanelOpen = true;
  aiPanel.classList.add('open');
  hintBar.classList.add('hidden');

  const config = await window.electronAPI.configGet();
  configuredModel = config.model;

  if (!configuredModel) {
    showSetup();
  } else {
    showQueryMode();
  }
}

function closeAIPanel(): void {
  aiPanelOpen = false;
  aiPanel.classList.remove('open');
  hintBar.classList.remove('hidden');
  aiActions.classList.add('hidden');
  aiStatus.textContent = '';
  term.focus();
}

// Setup wizard
async function showSetup(): Promise<void> {
  aiSetup.classList.remove('hidden');
  aiQuery.classList.add('hidden');
  aiModelLabel.textContent = '';
  setupMessage.textContent = 'Loading models from Ollama...';
  modelList.innerHTML = '';

  const result = await window.electronAPI.ollamaListModels();

  if (!result.ok) {
    setupMessage.textContent = result.error;
    return;
  }
  if (result.models.length === 0) {
    setupMessage.textContent =
      'No models found. Install one first:\n  ollama pull llama3\nThen reopen this panel.';
    return;
  }

  setupMessage.textContent = 'Select a model:';
  for (const name of result.models) {
    const btn = document.createElement('button');
    btn.className = 'model-btn';
    btn.textContent = name;
    btn.addEventListener('click', () => selectModel(name));
    modelList.appendChild(btn);
  }
}

async function selectModel(model: string): Promise<void> {
  await window.electronAPI.configSaveModel(model);
  configuredModel = model;
  updateHintBar();
  showQueryMode();
}

function showQueryMode(): void {
  aiSetup.classList.add('hidden');
  aiQuery.classList.remove('hidden');
  aiModelLabel.textContent = `[${configuredModel}]`;
  aiInput.focus();
}

aiClose.addEventListener('click', closeAIPanel);

// Click on model label → switch model
aiModelLabel.addEventListener('click', () => {
  showSetup();
});

// Hint bar click → open panel
hintBar.addEventListener('click', () => {
  if (!aiPanelOpen) openAIPanel();
});

// ============================================================
// 4. HOTKEY: Ctrl+Space
//
// Primary action: toggle inline AI mode in the terminal.
// If the panel is open, close it instead.
// ============================================================

window.electronAPI.onToggleAIPanel(async () => {
  if (aiPanelOpen) {
    closeAIPanel();
    return;
  }

  if (inlineState !== 'idle') {
    exitInlineMode();
    return;
  }

  const config = await window.electronAPI.configGet();
  configuredModel = config.model;

  if (!configuredModel) {
    openAIPanel();
    return;
  }

  enterInlineMode();
});

// ============================================================
// 5. TERMINAL CONTEXT CAPTURE
// ============================================================

function captureTerminalContext(lineCount = 30): string {
  const buffer = term.buffer.active;
  const totalLines = buffer.length;
  const start = Math.max(0, totalLines - lineCount);
  const lines: string[] = [];

  for (let i = start; i < totalLines; i++) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n').trim();
}

// ============================================================
// 6. PANEL QUERY
// ============================================================

let panelSuggestedCommand = '';
let isStreaming = false;

function sendPanelQuery(): void {
  const prompt = aiInput.value.trim();
  if (!prompt || isStreaming) return;

  isStreaming = true;
  panelSuggestedCommand = '';
  aiOutput.textContent = '';
  aiActions.classList.add('hidden');
  aiStatus.textContent = 'thinking...';
  aiQuerySource = 'panel';

  const context = captureTerminalContext();
  window.electronAPI.aiQuery(prompt, context);
}

aiSend.addEventListener('click', sendPanelQuery);
aiInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendPanelQuery();
  }
});

// ============================================================
// 7. AI RESPONSE ROUTING
//
// Chunks, done, and errors are routed to whichever mode
// (inline or panel) initiated the query.
// ============================================================

window.electronAPI.onAiChunk((chunk) => {
  if (aiQuerySource === 'inline') {
    if (inlineFirstChunk) {
      term.write(`\r\n${S.response}`);
      inlineFirstChunk = false;
    }
    term.write(chunk.replace(/\n/g, '\r\n'));
    inlineResponseBuffer += chunk;
  } else if (aiQuerySource === 'panel') {
    aiOutput.textContent += chunk;
    aiStatus.textContent = 'streaming...';
    aiOutput.scrollTop = aiOutput.scrollHeight;
  }
});

window.electronAPI.onAiDone(() => {
  if (aiQuerySource === 'inline' && inlineState === 'streaming') {
    term.write(S.reset);

    const commands = inlineResponseBuffer
      .split('\n')
      .filter((l) => l.trimStart().startsWith('$ '))
      .map((l) => l.trimStart().slice(2).trim());

    if (commands.length > 0) {
      inlineSuggestedCommand = commands.join('; ');
      term.write(
        `\r\n\r\n${S.approval}  [I]nsert  [A]ccept & Run  [C]ancel${S.reset}`,
      );
      inlineState = 'approval';
    } else {
      term.write('\r\n');
      exitInlineMode();
    }
  } else if (aiQuerySource === 'panel') {
    isStreaming = false;
    aiStatus.textContent = '';

    const fullResponse = aiOutput.textContent || '';
    const commands = fullResponse
      .split('\n')
      .filter((l) => l.trimStart().startsWith('$ '))
      .map((l) => l.trimStart().slice(2).trim());

    if (commands.length > 0) {
      panelSuggestedCommand = commands.join('; ');
      aiActions.classList.remove('hidden');
    }
    aiQuerySource = null;
  }
});

window.electronAPI.onAiError((error) => {
  if (aiQuerySource === 'inline') {
    term.write(`\r\n${S.error}  [Error] ${error}${S.reset}\r\n`);
    exitInlineMode();
  } else if (aiQuerySource === 'panel') {
    isStreaming = false;
    aiStatus.textContent = '';
    aiOutput.textContent = `[Error] ${error}`;
    aiQuerySource = null;
  }
});

// ============================================================
// 8. PANEL ACTION HANDLERS
// ============================================================

aiActions.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const action = target.dataset.action;
  if (!action || !panelSuggestedCommand) return;

  switch (action) {
    case 'insert':
      window.electronAPI.ptyWrite(panelSuggestedCommand);
      closeAIPanel();
      break;
    case 'run':
      window.electronAPI.ptyWrite(panelSuggestedCommand + '\r');
      closeAIPanel();
      break;
    case 'cancel':
      closeAIPanel();
      break;
  }
});

// ============================================================
// 9. COPY / PASTE (right-click context menu)
// ============================================================

window.electronAPI.onTermCopy(() => {
  const selection = term.getSelection();
  if (selection) {
    navigator.clipboard.writeText(selection);
  }
});

window.electronAPI.onTermPaste((text) => {
  if (inlineState === 'input') {
    inlineInputBuffer += text;
    term.write(S.input + text);
  } else if (inlineState === 'idle') {
    window.electronAPI.ptyWrite(text);
  }
});
