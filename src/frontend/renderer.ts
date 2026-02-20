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

// --- Config types (mirror main process ResolvedConfig / ThemeColors) ---

interface AppConfigResolved {
  model: string | null;
  theme: string | null;
  font: { family: string; size: number };
  cursor: { blink: boolean; style: 'block' | 'underline' | 'bar' };
  window: {
    padding: { top: number; right: number; bottom: number; left: number };
    scrollback: number;
  };
  keybindings: { aiTrigger: string };
}

interface ThemeColors {
  terminal: {
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
    [key: string]: string | undefined;
  };
  ui: {
    background: string;
    panelBackground: string;
    panelBorder: string;
    panelHeaderBackground: string;
    hintBarBackground: string;
    hintBarColor: string;
    accent: string;
  };
}

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
      fsComplete: (partial: string) => Promise<string[]>;
      getVersion: () => Promise<string>;
      getPlatform: () => string;
      configGet: () => Promise<AppConfigResolved>;
      configGetTheme: () => Promise<ThemeColors>;
      configOpen: () => Promise<void>;
      configSaveModel: (model: string) => Promise<{ model?: string }>;
      ollamaListModels: () => Promise<
        { ok: true; models: string[] } | { ok: false; error: string }
      >;
      onToggleAIPanel: (callback: () => void) => void;
      onTermCopy: (callback: () => void) => void;
      onTermPaste: (callback: (text: string) => void) => void;
      onTermClear: (callback: () => void) => void;
    };
  }
}

// Module-level resolved config (populated during startup)
let appConfig: AppConfigResolved | null = null;

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
  sep: '\x1b[38;5;39m',       // separator lines (dodger blue — matches logo)
  cmd: '\x1b[1;97m',          // bold bright white — command text
};

// ============================================================
// INLINE SEPARATORS
// ============================================================

function inlineSeparatorOpen(): void {
  const label = ' open-os ';
  const totalWidth = term.cols;
  const sideLen = Math.max(1, Math.floor((totalWidth - label.length) / 2));
  const rightLen = Math.max(1, totalWidth - sideLen - label.length);
  const left = '─'.repeat(sideLen);
  const right = '─'.repeat(rightLen);
  term.write(`\r\n\r\n${S.sep}${left}${S.brand}${label}${S.sep}${right}${S.reset}\r\n\r\n`);
}

function inlineSeparatorClose(): void {
  const line = '─'.repeat(term.cols);
  term.write(`\r\n${S.sep}${line}${S.reset}\r\n`);
}

// ============================================================
// COMMAND EXTRACTION & AI RESPONSE PARSING
// Primary: JSON {"text","commands"} from Ollama format: "json".
// Fallback: code-fence extraction, then $ prefix detection.
// ============================================================

function extractCommands(response: string): string[] {
  // Try fenced code blocks first
  const fenced: string[] = [];
  const regex = /```\w*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(response)) !== null) {
    const cmd = match[1].trim();
    if (cmd) fenced.push(cmd);
  }
  if (fenced.length > 0) return fenced;

  // Fallback: $ prefix
  return response
    .split('\n')
    .filter((l) => l.trimStart().startsWith('$ '))
    .map((l) => l.trimStart().slice(2).trim())
    .filter((cmd) => cmd.length > 0);
}

interface AiResponse { text: string; commands: string[]; }

function parseAiResponse(raw: string): AiResponse {
  try {
    const parsed = JSON.parse(raw);
    const text = typeof parsed.text === 'string' ? parsed.text
      : typeof parsed.explanation === 'string' ? parsed.explanation
      : typeof parsed.response === 'string' ? parsed.response : '';
    const cmds = Array.isArray(parsed.commands) ? parsed.commands
      : Array.isArray(parsed.command) ? parsed.command : [];
    return {
      text,
      commands: cmds.filter((c: unknown): c is string =>
        typeof c === 'string' && c.trim().length > 0),
    };
  } catch {
    // Fallback for non-JSON responses (model didn't honour format)
    return { text: raw, commands: extractCommands(raw) };
  }
}

function formatCommandPreview(cmd: string): string {
  const lines = cmd.split('\n');
  if (lines.length <= 4) return lines.join('\r\n  ');
  const truncated = lines.slice(0, 3);
  truncated.push(`${S.gray}… +${lines.length - 3} more lines${S.reset}${S.cmd}`);
  return truncated.join('\r\n  ');
}

// ============================================================
// 1. TERMINAL SETUP
// Created with safe defaults — reconfigured after config loads via applyConfig()
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
// CONFIG APPLICATION
// Fetches resolved config + theme from main process and applies
// to xterm.js options, terminal padding, and UI CSS variables.
// ============================================================

async function applyConfig(): Promise<void> {
  const config = await window.electronAPI.configGet();
  const theme = await window.electronAPI.configGetTheme();
  appConfig = config;

  // Font
  term.options.fontFamily = config.font.family;
  term.options.fontSize = config.font.size;

  // Cursor
  term.options.cursorBlink = config.cursor.blink;
  term.options.cursorStyle = config.cursor.style;

  // Scrollback
  term.options.scrollback = config.window.scrollback;

  // Terminal theme colors
  const termTheme: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.terminal)) {
    if (typeof value === 'string') termTheme[key] = value;
  }
  term.options.theme = termTheme;

  // Terminal padding — inline style overrides CSS default
  const el = document.getElementById('terminal')!;
  const p = config.window.padding;
  el.style.padding = `${p.top}px ${p.right}px ${p.bottom}px ${p.left}px`;

  // UI theme — CSS custom properties on :root
  const root = document.documentElement;
  root.style.setProperty('--body-bg', theme.ui.background);
  root.style.setProperty('--panel-bg', theme.ui.panelBackground);
  root.style.setProperty('--panel-border', theme.ui.panelBorder);
  root.style.setProperty('--panel-header-bg', theme.ui.panelHeaderBackground);
  root.style.setProperty('--hint-bar-bg', theme.ui.hintBarBackground);
  root.style.setProperty('--hint-bar-color', theme.ui.hintBarColor);
  root.style.setProperty('--accent', theme.ui.accent);
  document.body.style.background = theme.ui.background;

  // Re-fit after font/padding changes
  fitTerminal();
}

function getAiTriggerLabel(): string {
  return appConfig?.keybindings.aiTrigger ?? 'Ctrl+Space';
}

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
      ` ${d}${getAiTriggerLabel()} — open-os assistant${r}`,
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

// Onboarding intro — shown when Ollama is not running or no model is configured
async function showOnboarding(): Promise<void> {
  const b = S.brand;
  const d = S.gray;
  const w = S.white;
  const r = S.reset;

  const config = await window.electronAPI.configGet();
  const ollamaResult = await window.electronAPI.ollamaListModels();
  const ollamaRunning = ollamaResult.ok;
  const hasModels = ollamaResult.ok && ollamaResult.models.length > 0;

  // If already configured and Ollama is reachable, skip onboarding
  if (config.model && ollamaRunning) return;

  const lines: string[] = [];

  if (config.model && !ollamaRunning) {
    // Model configured from a previous session but Ollama isn't running
    lines.push(`${b}  Ollama not reachable${r}`);
    lines.push('');
    lines.push(`  ${d}The Ollama server does not appear to be running.${r}`);
    lines.push(`  ${d}Start it with:${r}`);
    lines.push('');
    lines.push(`    ${w}ollama serve${r}`);
    lines.push('');
  } else {
    lines.push(`${b}  Getting started${r}`);
    lines.push('');

    if (!ollamaRunning) {
      lines.push(`  ${d}This terminal uses ${w}Ollama${r}${d} for local AI assistance.${r}`);
      lines.push(`  ${d}Install it from ${b}https://ollama.com${r}${d} and pull a model:${r}`);
      lines.push('');
      lines.push(`    ${w}ollama pull llama3${r}`);
      lines.push('');
      lines.push(`  ${d}Make sure the Ollama server is running (${w}ollama serve${r}${d}).${r}`);
      lines.push('');
    } else if (!hasModels) {
      lines.push(`  ${d}Ollama is running but no models are installed. Pull one:${r}`);
      lines.push('');
      lines.push(`    ${w}ollama pull llama3${r}`);
      lines.push('');
    } else {
      lines.push(`  ${d}Ollama is ready. Select a model in the panel below to begin.${r}`);
      lines.push('');
    }

    lines.push(`  ${d}${w}${getAiTriggerLabel()}${r}${d}  invoke the AI inline assistant${r}`);
    lines.push(`  ${d}${w}Click${r}${d} the bar below to open the AI panel and select a model${r}`);
    lines.push('');
  }

  term.write(lines.join('\r\n') + '\r\n');
}

// Apply config, show welcome, then flush buffered PTY data
window.electronAPI
  .getVersion()
  .catch(() => '0.0.0')
  .then(async (version) => {
    await applyConfig().catch(() => {}); // continue even if config fails
    showWelcome(version);
    await showOnboarding();
    welcomeShown = true;

    const isWin = window.electronAPI.getPlatform() === 'win32';
    if (isWin) {
      // On Windows, PowerShell's initial prompt output contains escape
      // sequences that overwrite our welcome banner. Discard the buffer
      // and send Enter to regenerate a clean prompt below the welcome.
      ptyBuffer = [];
      window.electronAPI.ptyWrite('\r');
    } else {
      for (const data of ptyBuffer) {
        term.write(data);
      }
      ptyBuffer = [];
    }
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

// ResizeObserver: re-fit terminal whenever its container dimensions change
// (handles hint bar show/hide, panel open/close, font loading reflow)
const terminalContainer = document.getElementById('terminal')!;
const resizeObserver = new ResizeObserver(() => fitTerminal());
resizeObserver.observe(terminalContainer);

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
let inlineCommands: string[] = [];
let inlineCommandIndex = 0;
let inlineAcceptedCommands: string[] = [];

// Inline prompt history (arrow up/down to navigate)
const inlineHistory: string[] = [];
let inlineHistoryIndex = -1;
let inlineHistoryStash = '';

// Which mode initiated the current AI query
let aiQuerySource: 'inline' | 'panel' | null = null;

function enterInlineMode(): void {
  if (inlineState !== 'idle') return;
  inlineState = 'input';
  inlineInputBuffer = '';
  inlineResponseBuffer = '';
  inlineCommands = [];
  inlineCommandIndex = 0;
  inlineAcceptedCommands = [];
  inlineHistoryIndex = -1;
  inlineHistoryStash = '';

  inlineSeparatorOpen();
  term.write(`${S.prompt}open-os > ${S.input}`);
}

function handleInlineInput(data: string): void {
  switch (inlineState) {
    case 'input':
      handleInlineTyping(data);
      break;
    case 'streaming':
      if (data === '\x1b') {
        term.write(`${S.reset}\r\n${S.error}[cancelled]${S.reset}\r\n`);
        inlineSeparatorClose();
        window.electronAPI.ptyWrite('\r');
        resetInlineState();
      }
      break;
    case 'approval':
      handleInlineApproval(data);
      break;
  }
}

function inlineReplaceInput(text: string): void {
  // Erase current input on screen, then write new text
  const eraseLen = inlineInputBuffer.length;
  if (eraseLen > 0) term.write('\b \b'.repeat(eraseLen));
  inlineInputBuffer = text;
  if (text) term.write(text);
}

let tabCompletionBusy = false;

function handleTabCompletion(): void {
  if (tabCompletionBusy) return;

  // Extract the last whitespace-delimited word as the partial path
  const match = inlineInputBuffer.match(/(\S+)$/);
  if (!match) return;
  const partial = match[1];
  const prefix = (partial.endsWith('/') || partial.endsWith('\\'))
    ? ''
    : partial.split(/[/\\]/).pop() || '';

  tabCompletionBusy = true;
  window.electronAPI.fsComplete(partial).then((matches) => {
    tabCompletionBusy = false;
    if (inlineState !== 'input' || matches.length === 0) return;

    // Find the longest common prefix across all matches
    let common = matches[0];
    for (let i = 1; i < matches.length; i++) {
      while (common && !matches[i].startsWith(common)) {
        common = common.slice(0, -1);
      }
    }

    const toAdd = common.slice(prefix.length);
    if (toAdd) {
      inlineInputBuffer += toAdd;
      term.write(S.input + toAdd);
    }
  }).catch(() => { tabCompletionBusy = false; });
}

function handleInlineTyping(data: string): void {
  // Arrow up / arrow down — history navigation
  if (data === '\x1b[A') {
    if (inlineHistory.length === 0) return;
    if (inlineHistoryIndex === -1) {
      inlineHistoryStash = inlineInputBuffer;
      inlineHistoryIndex = inlineHistory.length - 1;
    } else if (inlineHistoryIndex > 0) {
      inlineHistoryIndex--;
    } else {
      return;
    }
    inlineReplaceInput(inlineHistory[inlineHistoryIndex]);
    return;
  }
  if (data === '\x1b[B') {
    if (inlineHistoryIndex === -1) return;
    if (inlineHistoryIndex < inlineHistory.length - 1) {
      inlineHistoryIndex++;
      inlineReplaceInput(inlineHistory[inlineHistoryIndex]);
    } else {
      inlineHistoryIndex = -1;
      inlineReplaceInput(inlineHistoryStash);
    }
    return;
  }

  if (data === '\t') {
    handleTabCompletion();
    return;
  }

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

  // Save to history (avoid consecutive duplicates)
  if (inlineHistory.length === 0 || inlineHistory[inlineHistory.length - 1] !== prompt) {
    inlineHistory.push(prompt);
  }
  inlineHistoryIndex = -1;
  inlineHistoryStash = '';

  inlineState = 'streaming';
  aiQuerySource = 'inline';
  inlineResponseBuffer = '';

  term.write(`\r\n${S.dim}...${S.reset}`);

  const context = captureTerminalContext();
  window.electronAPI.aiQuery(prompt, context);
}

// --- Multi-command: sequential review with immediate execution ---

let inlineReviewBusy = false; // true while waiting between commands

function showCommandReview(): void {
  const i = inlineCommandIndex;
  const total = inlineCommands.length;
  const cmd = inlineCommands[i];
  const preview = formatCommandPreview(cmd);
  term.write(
    `\r\n\r\n${S.gray}Command ${i + 1}/${total} ─${S.reset}\r\n  ${S.cmd}${preview}${S.reset}` +
    `\r\n${S.approval}  [R]un  [S]kip  [C]ancel${S.reset}`,
  );
}

// --- Single command: insert / run / cancel ---

function showCommandConfirm(): void {
  const cmd = inlineAcceptedCommands[0];
  const preview = formatCommandPreview(cmd);
  term.write(
    `\r\n\r\n${S.gray}►${S.reset}\r\n  ${S.cmd}${preview}${S.reset}` +
    `\r\n${S.approval}  [I]nsert  [R]un  [C]ancel${S.reset}`,
  );
}

function advanceOrExit(): void {
  inlineCommandIndex++;
  if (inlineCommandIndex < inlineCommands.length) {
    showCommandReview();
  } else {
    exitInlineMode();
  }
}

function handleInlineApproval(data: string): void {
  if (inlineReviewBusy) return; // ignore input during transition
  const key = data.toLowerCase();

  // Review phase (multi-command): run immediately or skip
  if (inlineCommandIndex < inlineCommands.length) {
    if (key === 'r') {
      const cmd = inlineCommands[inlineCommandIndex];
      term.write(`${S.reset}\r\n`);
      inlineSeparatorClose();
      window.electronAPI.ptyWrite('\r');
      setTimeout(() => {
        window.electronAPI.ptyWrite(cmd.replace(/\n/g, '\r') + '\r');
        inlineCommandIndex++;
        if (inlineCommandIndex < inlineCommands.length) {
          // Brief pause so command output can flush before next review
          inlineReviewBusy = true;
          setTimeout(() => {
            inlineReviewBusy = false;
            inlineSeparatorOpen();
            showCommandReview();
          }, 500);
        } else {
          resetInlineState();
        }
      }, 50);
    } else if (key === 's') {
      advanceOrExit();
    } else if (key === 'c' || data === '\x1b') {
      exitInlineMode();
    }
    return;
  }

  // Confirm phase (single command): insert, run, or cancel
  const cmd = inlineAcceptedCommands[0];

  if (key === 'i') {
    term.write(`${S.reset}\r\n`);
    inlineSeparatorClose();
    resetInlineState();
    window.electronAPI.ptyWrite('\r');
    setTimeout(() => window.electronAPI.ptyWrite(cmd.replace(/\n/g, '\r')), 50);
  } else if (key === 'r') {
    term.write(`${S.reset}\r\n`);
    inlineSeparatorClose();
    resetInlineState();
    window.electronAPI.ptyWrite('\r');
    setTimeout(() => window.electronAPI.ptyWrite(cmd.replace(/\n/g, '\r') + '\r'), 50);
  } else if (key === 'c' || data === '\x1b') {
    exitInlineMode();
  }
}

function exitInlineMode(): void {
  term.write(`${S.reset}\r\n`);
  inlineSeparatorClose();
  window.electronAPI.ptyWrite('\r');
  resetInlineState();
}

function resetInlineState(): void {
  inlineState = 'idle';
  inlineInputBuffer = '';
  inlineResponseBuffer = '';
  inlineCommands = [];
  inlineCommandIndex = 0;
  inlineAcceptedCommands = [];
  inlineReviewBusy = false;
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
  const trigger = getAiTriggerLabel();
  hintBar.textContent = `${trigger} — open-os inline  |  Click here — open-os panel${model}`;
}

// Load config on startup
window.electronAPI.configGet().then((config) => {
  configuredModel = config.model ?? undefined;
  updateHintBar();
});

async function openAIPanel(): Promise<void> {
  aiPanelOpen = true;
  aiPanel.classList.add('open');
  hintBar.classList.add('hidden');
  fitTerminal();

  const config = await window.electronAPI.configGet();
  configuredModel = config.model ?? undefined;

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
  fitTerminal();
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
// 4. HOTKEY (configurable, default: Ctrl+Space)
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
  configuredModel = config.model ?? undefined;

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
let panelResponseBuffer = '';
let isStreaming = false;

function sendPanelQuery(): void {
  const prompt = aiInput.value.trim();
  if (!prompt || isStreaming) return;

  isStreaming = true;
  panelSuggestedCommand = '';
  panelResponseBuffer = '';
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
    inlineResponseBuffer += chunk;
  } else if (aiQuerySource === 'panel') {
    panelResponseBuffer += chunk;
    aiStatus.textContent = 'generating...';
  }
});

window.electronAPI.onAiDone(() => {
  if (aiQuerySource === 'inline' && inlineState === 'streaming') {
    const { text, commands } = parseAiResponse(inlineResponseBuffer);

    if (text) {
      term.write(`\r\n${S.response}${text.replace(/\n/g, '\r\n')}${S.reset}`);
    }

    if (commands.length === 0) {
      exitInlineMode();
    } else if (commands.length === 1) {
      inlineCommands = commands;
      inlineCommandIndex = 1; // past review — go straight to confirm
      inlineAcceptedCommands = commands.slice();
      showCommandConfirm();
      inlineState = 'approval';
    } else {
      inlineCommands = commands;
      inlineCommandIndex = 0;
      inlineAcceptedCommands = [];
      showCommandReview();
      inlineState = 'approval';
    }
  } else if (aiQuerySource === 'panel') {
    isStreaming = false;
    aiStatus.textContent = '';

    const { text, commands } = parseAiResponse(panelResponseBuffer);

    let display = text;
    if (commands.length > 0) {
      display += '\n\n' + commands.map((c) => `$ ${c}`).join('\n\n');
    }
    aiOutput.textContent = display;

    if (commands.length > 0) {
      panelSuggestedCommand = commands.join('\n');
      aiActions.classList.remove('hidden');
    }
    aiQuerySource = null;
  }
});

window.electronAPI.onAiError((error) => {
  if (aiQuerySource === 'inline') {
    term.write(`\r\n${S.error}[Error] ${error}${S.reset}\r\n`);
    inlineSeparatorClose();
    window.electronAPI.ptyWrite('\r');
    resetInlineState();
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
      window.electronAPI.ptyWrite(panelSuggestedCommand.replace(/\n/g, '\r'));
      closeAIPanel();
      break;
    case 'run':
      window.electronAPI.ptyWrite(panelSuggestedCommand.replace(/\n/g, '\r') + '\r');
      closeAIPanel();
      break;
    case 'cancel':
      closeAIPanel();
      break;
  }
});

// ============================================================
// 9. COPY / PASTE / CLEAR (right-click context menu)
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

window.electronAPI.onTermClear(() => {
  term.clear();
  // Clear visible screen and move cursor home, then request a fresh prompt
  term.write('\x1b[2J\x1b[H');
  window.electronAPI.ptyWrite('\r');
});

// ============================================================
// 10. SETTINGS (open config file)
// ============================================================

document.getElementById('ai-settings')!.addEventListener('click', () => {
  window.electronAPI.configOpen();
});
