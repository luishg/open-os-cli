// ============================================================
// RENDERER — runs in the Electron browser context
//
// This file does five things:
//   1. Manages TABS (each with its own xterm.js + PTY)
//   2. Manages INLINE AI mode (Ctrl+Space — AI right in the terminal)
//   3. Manages the open-os PANEL overlay (click hint bar)
//   4. Routes AI responses to the correct tab
//   5. Applies config/theme across all tabs
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
      // PTY (tab-aware)
      ptyWrite: (tabId: string, data: string) => void;
      ptyResize: (tabId: string, cols: number, rows: number) => void;
      onPtyData: (callback: (tabId: string, data: string) => void) => void;
      onPtyExit: (callback: (tabId: string, code: number) => void) => void;
      // Tab lifecycle
      tabCreate: (tabId: string) => void;
      tabClose: (tabId: string) => void;
      onTabNewRequest: (callback: () => void) => void;
      // AI (tab-aware)
      aiQuery: (tabId: string, prompt: string, context: string) => void;
      onAiChunk: (callback: (tabId: string, chunk: string) => void) => void;
      onAiDone: (callback: (tabId: string) => void) => void;
      onAiError: (callback: (tabId: string, error: string) => void) => void;
      // Filesystem tab-completion (tab-aware)
      fsComplete: (tabId: string, partial: string) => Promise<string[]>;
      // App info
      getVersion: () => Promise<string>;
      getPlatform: () => string;
      // Config & Ollama
      configGet: () => Promise<AppConfigResolved>;
      configGetTheme: () => Promise<ThemeColors>;
      configOpen: () => Promise<void>;
      configSaveModel: (model: string) => Promise<{ model?: string }>;
      ollamaListModels: () => Promise<
        { ok: true; models: string[] } | { ok: false; error: string }
      >;
      // Hotkey & context menu
      onToggleAIPanel: (callback: () => void) => void;
      onTermCopy: (callback: () => void) => void;
      onTermPaste: (callback: (text: string) => void) => void;
      onTermClear: (callback: () => void) => void;
    };
  }
}

// Module-level resolved config (populated during startup)
let appConfig: AppConfigResolved | null = null;

// Cached config/theme for applying to new tabs
let cachedConfig: AppConfigResolved | null = null;
let cachedTheme: ThemeColors | null = null;

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
// INLINE SEPARATORS (per-tab)
// ============================================================

function inlineSeparatorOpen(tab: TabInstance): void {
  const label = ' open-os ';
  const totalWidth = tab.term.cols;
  const sideLen = Math.max(1, Math.floor((totalWidth - label.length) / 2));
  const rightLen = Math.max(1, totalWidth - sideLen - label.length);
  const left = '─'.repeat(sideLen);
  const right = '─'.repeat(rightLen);
  tab.term.write(`\r\n\r\n${S.sep}${left}${S.brand}${label}${S.sep}${right}${S.reset}\r\n\r\n`);
}

function inlineSeparatorClose(tab: TabInstance): void {
  const line = '─'.repeat(tab.term.cols);
  tab.term.write(`\r\n${S.sep}${line}${S.reset}\r\n`);
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
// 1. TAB SYSTEM
// ============================================================

type InlineState = 'idle' | 'input' | 'streaming' | 'approval';

interface TabInstance {
  id: string;
  term: Terminal;
  fitAddon: FitAddon;
  paneEl: HTMLDivElement;
  tabEl: HTMLDivElement;
  // Per-tab inline AI state
  inlineState: InlineState;
  inlineInputBuffer: string;
  inlineResponseBuffer: string;
  inlineCommands: string[];
  inlineCommandIndex: number;
  inlineAcceptedCommands: string[];
  inlineReviewBusy: boolean;
  inlineHistory: string[];
  inlineHistoryIndex: number;
  inlineHistoryStash: string;
  aiQuerySource: 'inline' | 'panel' | null;
  tabCompletionBusy: boolean;
  // Welcome/buffer
  welcomeShown: boolean;
  ptyBuffer: string[];
  // Panel state per tab
  panelSuggestedCommand: string;
  panelResponseBuffer: string;
  isStreaming: boolean;
}

const tabInstances = new Map<string, TabInstance>();
let activeTabId = '';
let nextTabId = 1;

function updateTabBarCount(): void {
  const bar = document.getElementById('tab-bar')!;
  bar.dataset.tabCount = String(tabInstances.size);
}

function createTabInstance(): TabInstance {
  const id = String(nextTabId++);

  // --- DOM: tab bar entry ---
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.tabId = id;

  const titleSpan = document.createElement('span');
  titleSpan.className = 'tab-title';
  titleSpan.textContent = `Terminal ${id}`;
  tabEl.appendChild(titleSpan);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(id);
  });
  tabEl.appendChild(closeBtn);

  tabEl.addEventListener('click', () => switchToTab(id));

  // Insert before the "+" button
  const addBtn = document.getElementById('tab-add')!;
  addBtn.parentElement!.insertBefore(tabEl, addBtn);

  // --- DOM: terminal pane ---
  const paneEl = document.createElement('div');
  paneEl.className = 'terminal-pane';
  paneEl.dataset.tabId = id;
  document.getElementById('terminal-container')!.appendChild(paneEl);

  // --- xterm.js instance ---
  const newTerm = new Terminal({
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

  const newFitAddon = new FitAddon();
  newTerm.loadAddon(newFitAddon);
  newTerm.open(paneEl);

  const tab: TabInstance = {
    id,
    term: newTerm,
    fitAddon: newFitAddon,
    paneEl,
    tabEl,
    inlineState: 'idle',
    inlineInputBuffer: '',
    inlineResponseBuffer: '',
    inlineCommands: [],
    inlineCommandIndex: 0,
    inlineAcceptedCommands: [],
    inlineReviewBusy: false,
    inlineHistory: [],
    inlineHistoryIndex: -1,
    inlineHistoryStash: '',
    aiQuerySource: null,
    tabCompletionBusy: false,
    welcomeShown: false,
    ptyBuffer: [],
    panelSuggestedCommand: '',
    panelResponseBuffer: '',
    isStreaming: false,
  };

  tabInstances.set(id, tab);

  // Wire keystrokes: inline handler or PTY
  newTerm.onData((data) => {
    if (tab.inlineState !== 'idle') {
      handleInlineInput(tab, data);
    } else {
      window.electronAPI.ptyWrite(id, data);
    }
  });

  // Tell main process to spawn PTY for this tab
  window.electronAPI.tabCreate(id);

  // Apply cached config to this terminal
  if (cachedConfig && cachedTheme) {
    applyConfigToTab(tab, cachedConfig, cachedTheme);
  }

  updateTabBarCount();
  return tab;
}

function switchToTab(tabId: string): void {
  if (tabId === activeTabId) return;
  const prev = tabInstances.get(activeTabId);
  const next = tabInstances.get(tabId);
  if (!next) return;

  // Deactivate previous
  if (prev) {
    prev.paneEl.classList.remove('active');
    prev.tabEl.classList.remove('active');
  }

  // Activate next
  next.paneEl.classList.add('active');
  next.tabEl.classList.add('active');
  activeTabId = tabId;

  // Re-fit and sync
  fitTab(next);
  next.term.focus();
}

function closeTab(tabId: string): void {
  // Prevent closing the last tab
  if (tabInstances.size <= 1) return;

  const tab = tabInstances.get(tabId);
  if (!tab) return;

  // Tell main process to kill the PTY
  window.electronAPI.tabClose(tabId);

  // Clean up DOM
  tab.tabEl.remove();
  tab.paneEl.remove();
  tab.term.dispose();
  tabInstances.delete(tabId);

  // If we closed the active tab, switch to an adjacent one
  if (activeTabId === tabId) {
    const remaining = [...tabInstances.keys()];
    switchToTab(remaining[remaining.length - 1]);
  }

  updateTabBarCount();
}

async function createAndSwitchNewTab(): Promise<void> {
  const tab = createTabInstance();
  switchToTab(tab.id);
  await initTab(tab);
}

// ============================================================
// CONFIG APPLICATION
// Fetches resolved config + theme from main process and applies
// to xterm.js options, terminal padding, and UI CSS variables.
// ============================================================

function applyConfigToTab(tab: TabInstance, config: AppConfigResolved, theme: ThemeColors): void {
  tab.term.options.fontFamily = config.font.family;
  tab.term.options.fontSize = config.font.size;
  tab.term.options.cursorBlink = config.cursor.blink;
  tab.term.options.cursorStyle = config.cursor.style;
  tab.term.options.scrollback = config.window.scrollback;

  const termTheme: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.terminal)) {
    if (typeof value === 'string') termTheme[key] = value;
  }
  tab.term.options.theme = termTheme;

  const p = config.window.padding;
  tab.paneEl.style.padding = `${p.top}px ${p.right}px ${p.bottom}px ${p.left}px`;
}

async function applyConfig(): Promise<void> {
  const config = await window.electronAPI.configGet();
  const theme = await window.electronAPI.configGetTheme();
  appConfig = config;
  cachedConfig = config;
  cachedTheme = theme;

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

  // Apply to all existing tabs
  for (const tab of tabInstances.values()) {
    applyConfigToTab(tab, config, theme);
  }

  // Re-fit active tab
  fitTerminal();
}

function getAiTriggerLabel(): string {
  return appConfig?.keybindings.aiTrigger ?? 'Ctrl+Space';
}

// ============================================================
// WELCOME MESSAGE & INIT (per-tab)
// ============================================================

function showWelcome(tab: TabInstance, version: string): void {
  const b = S.brand;
  const d = S.gray;
  const r = S.reset;

  tab.term.write(
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

// Onboarding intro — shown when Ollama is not running or no model is configured
async function showOnboarding(tab: TabInstance): Promise<void> {
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

  tab.term.write(lines.join('\r\n') + '\r\n');
}

async function initTab(tab: TabInstance): Promise<void> {
  const version = await window.electronAPI.getVersion().catch(() => '0.0.0');
  showWelcome(tab, version);
  await showOnboarding(tab);
  tab.welcomeShown = true;

  const isWin = window.electronAPI.getPlatform() === 'win32';
  if (isWin) {
    tab.ptyBuffer = [];
    window.electronAPI.ptyWrite(tab.id, '\r');
  } else {
    for (const data of tab.ptyBuffer) {
      tab.term.write(data);
    }
    tab.ptyBuffer = [];
  }
}

// ============================================================
// PTY DATA / EXIT ROUTING (tab-aware)
// ============================================================

window.electronAPI.onPtyData((tabId, data) => {
  const tab = tabInstances.get(tabId);
  if (!tab) return;
  if (!tab.welcomeShown) {
    tab.ptyBuffer.push(data);
  } else {
    tab.term.write(data);
  }
});

window.electronAPI.onPtyExit((tabId) => {
  const tab = tabInstances.get(tabId);
  if (!tab) return;
  tab.term.write('\r\n[Process exited]\r\n');
});

// ============================================================
// TERMINAL RESIZE
//
// Custom fit calculation: uses clientHeight (reliable across
// box-sizing modes) minus explicit padding to determine the
// content area available for the terminal grid.  This prevents
// xterm.js rows from rendering into the pane's padding zone
// which would cause content to appear behind the hint bar.
// ============================================================

function fitTab(tab: TabInstance): void {
  const core = (tab.term as any)._core;
  const dims = core._renderService?.dimensions;
  if (!dims?.css?.cell?.width || !dims?.css?.cell?.height) {
    // Render dimensions not ready yet — fall back to FitAddon
    tab.fitAddon.fit();
    window.electronAPI.ptyResize(tab.id, tab.term.cols, tab.term.rows);
    return;
  }

  const pane = tab.paneEl;
  const paneStyle = getComputedStyle(pane);
  // clientHeight includes padding but NOT border/scrollbar.
  // Subtract padding explicitly to get the true content area.
  const availableHeight = pane.clientHeight
    - (parseInt(paneStyle.paddingTop) || 0)
    - (parseInt(paneStyle.paddingBottom) || 0);
  const availableWidth = pane.clientWidth
    - (parseInt(paneStyle.paddingLeft) || 0)
    - (parseInt(paneStyle.paddingRight) || 0);

  const cols = Math.max(2, Math.floor(availableWidth / dims.css.cell.width));
  const rows = Math.max(1, Math.floor(availableHeight / dims.css.cell.height));

  if (tab.term.rows !== rows || tab.term.cols !== cols) {
    core._renderService.clear();
    tab.term.resize(cols, rows);
  }

  window.electronAPI.ptyResize(tab.id, tab.term.cols, tab.term.rows);
}

function fitTerminal(): void {
  const tab = tabInstances.get(activeTabId);
  if (!tab) return;
  fitTab(tab);
}
window.addEventListener('resize', fitTerminal);
setTimeout(fitTerminal, 100);

// ResizeObserver: re-fit terminal whenever its container dimensions change
const terminalContainer = document.getElementById('terminal-container')!;
const resizeObserver = new ResizeObserver(() => fitTerminal());
resizeObserver.observe(terminalContainer);

// ============================================================
// 2. INLINE AI MODE (per-tab)
//
// Ctrl+Space enters "AI mode" directly in the terminal.
// States: idle → input → streaming → approval → idle
// ============================================================

function enterInlineMode(tab: TabInstance): void {
  if (tab.inlineState !== 'idle') return;
  tab.inlineState = 'input';
  tab.inlineInputBuffer = '';
  tab.inlineResponseBuffer = '';
  tab.inlineCommands = [];
  tab.inlineCommandIndex = 0;
  tab.inlineAcceptedCommands = [];
  tab.inlineHistoryIndex = -1;
  tab.inlineHistoryStash = '';

  inlineSeparatorOpen(tab);
  tab.term.write(`${S.prompt}open-os > ${S.input}`);
}

function handleInlineInput(tab: TabInstance, data: string): void {
  switch (tab.inlineState) {
    case 'input':
      handleInlineTyping(tab, data);
      break;
    case 'streaming':
      if (data === '\x1b') {
        tab.term.write(`${S.reset}\r\n${S.error}[cancelled]${S.reset}\r\n`);
        inlineSeparatorClose(tab);
        window.electronAPI.ptyWrite(tab.id, '\r');
        resetInlineState(tab);
      }
      break;
    case 'approval':
      handleInlineApproval(tab, data);
      break;
  }
}

function inlineReplaceInput(tab: TabInstance, text: string): void {
  const eraseLen = tab.inlineInputBuffer.length;
  if (eraseLen > 0) tab.term.write('\b \b'.repeat(eraseLen));
  tab.inlineInputBuffer = text;
  if (text) tab.term.write(text);
}

function handleTabCompletion(tab: TabInstance): void {
  if (tab.tabCompletionBusy) return;

  const match = tab.inlineInputBuffer.match(/(\S+)$/);
  if (!match) return;
  const partial = match[1];
  const prefix = (partial.endsWith('/') || partial.endsWith('\\'))
    ? ''
    : partial.split(/[/\\]/).pop() || '';

  tab.tabCompletionBusy = true;
  window.electronAPI.fsComplete(tab.id, partial).then((matches) => {
    tab.tabCompletionBusy = false;
    if (tab.inlineState !== 'input' || matches.length === 0) return;

    let common = matches[0];
    for (let i = 1; i < matches.length; i++) {
      while (common && !matches[i].startsWith(common)) {
        common = common.slice(0, -1);
      }
    }

    const toAdd = common.slice(prefix.length);
    if (toAdd) {
      tab.inlineInputBuffer += toAdd;
      tab.term.write(S.input + toAdd);
    }
  }).catch(() => { tab.tabCompletionBusy = false; });
}

function handleInlineTyping(tab: TabInstance, data: string): void {
  // Arrow up / arrow down — history navigation
  if (data === '\x1b[A') {
    if (tab.inlineHistory.length === 0) return;
    if (tab.inlineHistoryIndex === -1) {
      tab.inlineHistoryStash = tab.inlineInputBuffer;
      tab.inlineHistoryIndex = tab.inlineHistory.length - 1;
    } else if (tab.inlineHistoryIndex > 0) {
      tab.inlineHistoryIndex--;
    } else {
      return;
    }
    inlineReplaceInput(tab, tab.inlineHistory[tab.inlineHistoryIndex]);
    return;
  }
  if (data === '\x1b[B') {
    if (tab.inlineHistoryIndex === -1) return;
    if (tab.inlineHistoryIndex < tab.inlineHistory.length - 1) {
      tab.inlineHistoryIndex++;
      inlineReplaceInput(tab, tab.inlineHistory[tab.inlineHistoryIndex]);
    } else {
      tab.inlineHistoryIndex = -1;
      inlineReplaceInput(tab, tab.inlineHistoryStash);
    }
    return;
  }

  if (data === '\t') {
    handleTabCompletion(tab);
    return;
  }

  if (data === '\r') {
    tab.term.write(S.reset);
    submitInlineQuery(tab);
  } else if (data === '\x7f' || data === '\b') {
    if (tab.inlineInputBuffer.length > 0) {
      tab.inlineInputBuffer = tab.inlineInputBuffer.slice(0, -1);
      tab.term.write('\b \b');
    }
  } else if (data === '\x1b' || data === '\x03') {
    tab.term.write(S.reset);
    exitInlineMode(tab);
  } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
    tab.inlineInputBuffer += data;
    tab.term.write(data);
  }
}

function submitInlineQuery(tab: TabInstance): void {
  const prompt = tab.inlineInputBuffer.trim();
  if (!prompt) {
    exitInlineMode(tab);
    return;
  }

  // Save to history (avoid consecutive duplicates)
  if (tab.inlineHistory.length === 0 || tab.inlineHistory[tab.inlineHistory.length - 1] !== prompt) {
    tab.inlineHistory.push(prompt);
  }
  tab.inlineHistoryIndex = -1;
  tab.inlineHistoryStash = '';

  tab.inlineState = 'streaming';
  tab.aiQuerySource = 'inline';
  tab.inlineResponseBuffer = '';

  tab.term.write(`\r\n${S.dim}...${S.reset}`);

  const context = captureTerminalContext(tab);
  window.electronAPI.aiQuery(tab.id, prompt, context);
}

// --- Multi-command: sequential review with immediate execution ---

function showCommandReview(tab: TabInstance): void {
  const i = tab.inlineCommandIndex;
  const total = tab.inlineCommands.length;
  const cmd = tab.inlineCommands[i];
  const preview = formatCommandPreview(cmd);
  tab.term.write(
    `\r\n\r\n${S.gray}Command ${i + 1}/${total} ─${S.reset}\r\n  ${S.cmd}${preview}${S.reset}` +
    `\r\n${S.approval}  [R]un  [S]kip  [C]ancel${S.reset}`,
  );
}

// --- Single command: insert / run / cancel ---

function showCommandConfirm(tab: TabInstance): void {
  const cmd = tab.inlineAcceptedCommands[0];
  const preview = formatCommandPreview(cmd);
  tab.term.write(
    `\r\n\r\n${S.gray}►${S.reset}\r\n  ${S.cmd}${preview}${S.reset}` +
    `\r\n${S.approval}  [I]nsert  [R]un  [C]ancel${S.reset}`,
  );
}

function advanceOrExit(tab: TabInstance): void {
  tab.inlineCommandIndex++;
  if (tab.inlineCommandIndex < tab.inlineCommands.length) {
    showCommandReview(tab);
  } else {
    exitInlineMode(tab);
  }
}

function handleInlineApproval(tab: TabInstance, data: string): void {
  if (tab.inlineReviewBusy) return;
  const key = data.toLowerCase();

  // Review phase (multi-command): run immediately or skip
  if (tab.inlineCommandIndex < tab.inlineCommands.length) {
    if (key === 'r') {
      const cmd = tab.inlineCommands[tab.inlineCommandIndex];
      tab.term.write(`${S.reset}\r\n`);
      inlineSeparatorClose(tab);
      window.electronAPI.ptyWrite(tab.id, '\r');
      setTimeout(() => {
        window.electronAPI.ptyWrite(tab.id, cmd.replace(/\n/g, '\r') + '\r');
        tab.inlineCommandIndex++;
        if (tab.inlineCommandIndex < tab.inlineCommands.length) {
          tab.inlineReviewBusy = true;
          setTimeout(() => {
            tab.inlineReviewBusy = false;
            inlineSeparatorOpen(tab);
            showCommandReview(tab);
          }, 500);
        } else {
          resetInlineState(tab);
        }
      }, 50);
    } else if (key === 's') {
      advanceOrExit(tab);
    } else if (key === 'c' || data === '\x1b') {
      exitInlineMode(tab);
    }
    return;
  }

  // Confirm phase (single command): insert, run, or cancel
  const cmd = tab.inlineAcceptedCommands[0];

  if (key === 'i') {
    tab.term.write(`${S.reset}\r\n`);
    inlineSeparatorClose(tab);
    resetInlineState(tab);
    window.electronAPI.ptyWrite(tab.id, '\r');
    setTimeout(() => window.electronAPI.ptyWrite(tab.id, cmd.replace(/\n/g, '\r')), 50);
  } else if (key === 'r') {
    tab.term.write(`${S.reset}\r\n`);
    inlineSeparatorClose(tab);
    resetInlineState(tab);
    window.electronAPI.ptyWrite(tab.id, '\r');
    setTimeout(() => window.electronAPI.ptyWrite(tab.id, cmd.replace(/\n/g, '\r') + '\r'), 50);
  } else if (key === 'c' || data === '\x1b') {
    exitInlineMode(tab);
  }
}

function exitInlineMode(tab: TabInstance): void {
  tab.term.write(`${S.reset}\r\n`);
  inlineSeparatorClose(tab);
  window.electronAPI.ptyWrite(tab.id, '\r');
  resetInlineState(tab);
}

function resetInlineState(tab: TabInstance): void {
  tab.inlineState = 'idle';
  tab.inlineInputBuffer = '';
  tab.inlineResponseBuffer = '';
  tab.inlineCommands = [];
  tab.inlineCommandIndex = 0;
  tab.inlineAcceptedCommands = [];
  tab.inlineReviewBusy = false;
  tab.aiQuerySource = null;
}

// ============================================================
// 3. PANEL (overlay) — shared across tabs
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
  const tab = tabInstances.get(activeTabId);
  if (tab) tab.term.focus();
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
// ============================================================

window.electronAPI.onToggleAIPanel(async () => {
  if (aiPanelOpen) {
    closeAIPanel();
    return;
  }

  const tab = tabInstances.get(activeTabId);
  if (!tab) return;

  if (tab.inlineState !== 'idle') {
    exitInlineMode(tab);
    return;
  }

  const config = await window.electronAPI.configGet();
  configuredModel = config.model ?? undefined;

  if (!configuredModel) {
    openAIPanel();
    return;
  }

  enterInlineMode(tab);
});

// ============================================================
// 5. TERMINAL CONTEXT CAPTURE (per-tab)
// ============================================================

function captureTerminalContext(tab: TabInstance, lineCount = 30): string {
  const buffer = tab.term.buffer.active;
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
// 6. PANEL QUERY (uses active tab)
// ============================================================

function sendPanelQuery(): void {
  const tab = tabInstances.get(activeTabId);
  if (!tab) return;

  const prompt = aiInput.value.trim();
  if (!prompt || tab.isStreaming) return;

  tab.isStreaming = true;
  tab.panelSuggestedCommand = '';
  tab.panelResponseBuffer = '';
  aiOutput.textContent = '';
  aiActions.classList.add('hidden');
  aiStatus.textContent = 'thinking...';
  tab.aiQuerySource = 'panel';

  const context = captureTerminalContext(tab);
  window.electronAPI.aiQuery(tab.id, prompt, context);
}

aiSend.addEventListener('click', sendPanelQuery);
aiInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendPanelQuery();
  }
});

// ============================================================
// 7. AI RESPONSE ROUTING (tab-aware)
// ============================================================

window.electronAPI.onAiChunk((tabId, chunk) => {
  const tab = tabInstances.get(tabId);
  if (!tab) return;

  if (tab.aiQuerySource === 'inline') {
    tab.inlineResponseBuffer += chunk;
  } else if (tab.aiQuerySource === 'panel') {
    tab.panelResponseBuffer += chunk;
    aiStatus.textContent = 'generating...';
  }
});

window.electronAPI.onAiDone((tabId) => {
  const tab = tabInstances.get(tabId);
  if (!tab) return;

  if (tab.aiQuerySource === 'inline' && tab.inlineState === 'streaming') {
    const { text, commands } = parseAiResponse(tab.inlineResponseBuffer);

    if (text) {
      tab.term.write(`\r\n${S.response}${text.replace(/\n/g, '\r\n')}${S.reset}`);
    }

    if (commands.length === 0) {
      exitInlineMode(tab);
    } else if (commands.length === 1) {
      tab.inlineCommands = commands;
      tab.inlineCommandIndex = 1; // past review — go straight to confirm
      tab.inlineAcceptedCommands = commands.slice();
      showCommandConfirm(tab);
      tab.inlineState = 'approval';
    } else {
      tab.inlineCommands = commands;
      tab.inlineCommandIndex = 0;
      tab.inlineAcceptedCommands = [];
      showCommandReview(tab);
      tab.inlineState = 'approval';
    }
  } else if (tab.aiQuerySource === 'panel') {
    tab.isStreaming = false;
    aiStatus.textContent = '';

    const { text, commands } = parseAiResponse(tab.panelResponseBuffer);

    let display = text;
    if (commands.length > 0) {
      display += '\n\n' + commands.map((c) => `$ ${c}`).join('\n\n');
    }
    aiOutput.textContent = display;

    if (commands.length > 0) {
      tab.panelSuggestedCommand = commands.join('\n');
      aiActions.classList.remove('hidden');
    }
    tab.aiQuerySource = null;
  }
});

window.electronAPI.onAiError((tabId, error) => {
  const tab = tabInstances.get(tabId);
  if (!tab) return;

  if (tab.aiQuerySource === 'inline') {
    tab.term.write(`\r\n${S.error}[Error] ${error}${S.reset}\r\n`);
    inlineSeparatorClose(tab);
    window.electronAPI.ptyWrite(tab.id, '\r');
    resetInlineState(tab);
  } else if (tab.aiQuerySource === 'panel') {
    tab.isStreaming = false;
    aiStatus.textContent = '';
    aiOutput.textContent = `[Error] ${error}`;
    tab.aiQuerySource = null;
  }
});

// ============================================================
// 8. PANEL ACTION HANDLERS (use active tab)
// ============================================================

aiActions.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const action = target.dataset.action;
  const tab = tabInstances.get(activeTabId);
  if (!action || !tab || !tab.panelSuggestedCommand) return;
  const cmd = tab.panelSuggestedCommand;

  switch (action) {
    case 'insert':
      window.electronAPI.ptyWrite(tab.id, cmd.replace(/\n/g, '\r'));
      closeAIPanel();
      break;
    case 'run':
      window.electronAPI.ptyWrite(tab.id, cmd.replace(/\n/g, '\r') + '\r');
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
  const tab = tabInstances.get(activeTabId);
  if (!tab) return;
  const selection = tab.term.getSelection();
  if (selection) {
    navigator.clipboard.writeText(selection);
  }
});

window.electronAPI.onTermPaste((text) => {
  const tab = tabInstances.get(activeTabId);
  if (!tab) return;
  if (tab.inlineState === 'input') {
    tab.inlineInputBuffer += text;
    tab.term.write(S.input + text);
  } else if (tab.inlineState === 'idle') {
    window.electronAPI.ptyWrite(tab.id, text);
  }
});

window.electronAPI.onTermClear(() => {
  const tab = tabInstances.get(activeTabId);
  if (!tab) return;
  tab.term.clear();
  tab.term.write('\x1b[2J\x1b[H');
  window.electronAPI.ptyWrite(tab.id, '\r');
});

// ============================================================
// 10. SETTINGS (open config file)
// ============================================================

document.getElementById('ai-settings')!.addEventListener('click', () => {
  window.electronAPI.configOpen();
});

// ============================================================
// 11. TAB CONTROLS — "+" button & context menu "New Tab"
// ============================================================

document.getElementById('tab-add')!.addEventListener('click', createAndSwitchNewTab);
window.electronAPI.onTabNewRequest(() => createAndSwitchNewTab());

// ============================================================
// 12. STARTUP — create first tab
// ============================================================

(async () => {
  await applyConfig().catch(() => {});
  const firstTab = createTabInstance();
  switchToTab(firstTab.id);
  await initTab(firstTab);
})();
