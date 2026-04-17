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
      tabCreateChat: (tabId: string) => void;
      tabClose: (tabId: string) => void;
      onTabNewRequest: (callback: () => void) => void;
      onChatTabNewRequest: (callback: () => void) => void;
      // AI (tab-aware)
      aiQuery: (tabId: string, prompt: string, context: string) => void;
      chatQuery: (tabId: string, prompt: string) => void;
      onAiChunk: (callback: (tabId: string, chunk: string) => void) => void;
      onAiThinkingChunk: (callback: (tabId: string, chunk: string) => void) => void;
      onAiToolCall: (callback: (tabId: string, name: string, args: Record<string, unknown>) => void) => void;
      onAiToolResult: (callback: (tabId: string, name: string, result: string) => void) => void;
      onAiDone: (callback: (tabId: string, metrics?: Record<string, number> | null) => void) => void;
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
      ollamaShowModel: (name: string) => Promise<Record<string, unknown> | null>;
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
  // Strip markdown code fences that some models wrap around JSON
  const stripped = raw.replace(/^```\w*\s*\n?([\s\S]*?)\n?\s*```$/m, '$1').trim();
  const tryParse = (s: string): AiResponse | null => {
    try {
      const parsed = JSON.parse(s);
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
      return null;
    }
  };
  return tryParse(raw) ?? tryParse(stripped) ?? { text: raw, commands: extractCommands(raw) };
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

type ChatSegment =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool-call'; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; name: string; content: string };

interface TabInstance {
  id: string;
  type: 'terminal' | 'chat';
  term: Terminal;
  fitAddon: FitAddon;
  paneEl: HTMLDivElement;
  tabEl: HTMLDivElement;
  // Chat-specific fields (null for terminal tabs)
  chatMessagesEl: HTMLDivElement | null;
  chatInputEl: HTMLTextAreaElement | null;
  chatSendBtn: HTMLButtonElement | null;
  chatModelInfoEl: HTMLDivElement | null;
  chatStreamEl: HTMLDivElement | null;
  chatSegments: ChatSegment[];
  chatModelContextLength: number;
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
  winStartupFilter: boolean;
  winFilterTimer: ReturnType<typeof setTimeout> | null;
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
    type: 'terminal',
    term: newTerm,
    fitAddon: newFitAddon,
    paneEl,
    tabEl,
    chatMessagesEl: null,
    chatInputEl: null,
    chatSendBtn: null,
    chatModelInfoEl: null,
    chatStreamEl: null,
    chatSegments: [],
    chatModelContextLength: 0,
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
    winStartupFilter: false,
    winFilterTimer: null,
    ptyBuffer: [],
    panelSuggestedCommand: '',
    panelResponseBuffer: '',
    isStreaming: false,
  };

  tabInstances.set(id, tab);

  // Shift+Enter: insert a newline without executing the command.
  // On Windows, PowerShell enables win32-input-mode (\x1b[?9001h) so we must
  // send the Shift+Enter as a win32-input-mode key event for PSReadLine's
  // AddLine handler to recognise it.  Format: ESC[Vk;Sc;Uc;Kd;Cs;Rc_
  // On Unix shells, \n (vs \r for Enter) is the standard soft-newline.
  newTerm.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey && tab.inlineState === 'idle') {
      e.preventDefault();
      const isWin = window.electronAPI.getPlatform() === 'win32';
      if (isWin) {
        // VK_RETURN=13, ScanCode=28, Char=13, KeyDown=1, SHIFT_PRESSED=16, Repeat=1
        window.electronAPI.ptyWrite(id, '\x1b[13;28;13;1;16;1_');
      } else {
        // \x16 = Ctrl+V (quoted-insert in readline/ZLE) makes the shell
        // treat the next character literally, so \n is inserted into the
        // prompt instead of executing the command.
        window.electronAPI.ptyWrite(id, '\x16\n');
      }
      return false;
    }
    return true;
  });

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
  if (next.type === 'terminal') {
    fitTab(next);
    next.term.focus();
  } else if (next.chatInputEl) {
    next.chatInputEl.focus();
  }
}

function closeTab(tabId: string): void {
  // Prevent closing the last tab
  if (tabInstances.size <= 1) return;

  const tab = tabInstances.get(tabId);
  if (!tab) return;

  // Tell main process to clean up
  window.electronAPI.tabClose(tabId);

  // Clean up DOM
  tab.tabEl.remove();
  tab.paneEl.remove();
  if (tab.type === 'terminal') tab.term.dispose();
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
// CHAT TAB SYSTEM
// ============================================================

// --- Lightweight markdown renderer ---

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarkdown(text: string): string {
  // Split into code blocks and non-code sections
  const parts: string[] = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(renderMarkdownInline(text.slice(lastIndex, match.index)));
    }
    const code = escapeHtml(match[2].trimEnd());
    parts.push(`<pre class="chat-code-block"><code>${code}</code></pre>`);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(renderMarkdownInline(text.slice(lastIndex)));
  }

  return parts.join('');
}

function renderMarkdownInline(text: string): string {
  let html = escapeHtml(text);

  // Inline code (must come before bold/italic to avoid conflicts)
  html = html.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic (single *)
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

  // Headers (at line start)
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Unordered list items
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');

  // Ordered list items
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li>.*?<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Line breaks
  html = html.replace(/\n/g, '<br>');

  return html;
}

// --- Render segments (text, thinking, tool-call, tool-result) into HTML ---
//
// Segments are appended by the streaming IPC handlers in the order they arrive.
// This lets tool calls appear inline between text chunks, preserving the
// "assistant thought → used tool → kept talking" flow as a single bubble.
//
// Fallback: for older models that emit raw <think>...</think> instead of using
// Ollama's dedicated thinking field, we detect and extract those tags out of
// text segments at render time.

function renderSegmentsHtml(segments: ChatSegment[], isStreaming: boolean): string {
  let html = '';
  let hasAnyContent = false;

  for (const seg of segments) {
    if (seg.type === 'thinking') {
      if (!seg.content) continue;
      html += `<div class="chat-thinking-label">${isStreaming ? 'Thinking...' : 'Thinking'}</div>`;
      html += `<div class="chat-thinking">${escapeHtml(seg.content)}</div>`;
      hasAnyContent = true;
    } else if (seg.type === 'text') {
      if (!seg.content) continue;
      // Fallback: older models embed <think>...</think> in the text stream
      const { thinking, rest } = extractLegacyThink(seg.content);
      if (thinking) {
        html += `<div class="chat-thinking-label">${isStreaming ? 'Thinking...' : 'Thinking'}</div>`;
        html += `<div class="chat-thinking">${escapeHtml(thinking)}</div>`;
        hasAnyContent = true;
      }
      if (rest) {
        html += renderMarkdown(rest);
        hasAnyContent = true;
      }
    } else if (seg.type === 'tool-call') {
      const argsStr = formatToolArgs(seg.args);
      html += `<div class="chat-tool-call">` +
        `<div class="chat-tool-call-header">🔧 ${escapeHtml(seg.name)}</div>` +
        (argsStr ? `<div class="chat-tool-call-args">${escapeHtml(argsStr)}</div>` : '') +
        `</div>`;
      hasAnyContent = true;
    } else if (seg.type === 'tool-result') {
      html += `<div class="chat-tool-result">${escapeHtml(seg.content)}</div>`;
      hasAnyContent = true;
    }
  }

  if (!hasAnyContent && !isStreaming) {
    html = '<em style="color:#555e70">(empty response)</em>';
  }
  return html;
}

function extractLegacyThink(buf: string): { thinking: string; rest: string } {
  const thinkStart = buf.indexOf('<think>');
  if (thinkStart === -1) return { thinking: '', rest: buf };
  const thinkEnd = buf.indexOf('</think>');
  if (thinkEnd === -1) {
    return { thinking: buf.slice(thinkStart + 7), rest: '' };
  }
  return {
    thinking: buf.slice(thinkStart + 7, thinkEnd),
    rest: (buf.slice(0, thinkStart) + buf.slice(thinkEnd + 8)).trimStart(),
  };
}

function formatToolArgs(args: Record<string, unknown>): string {
  if (!args) return '';
  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
}

function appendTextChunk(tab: TabInstance, chunk: string): void {
  const last = tab.chatSegments[tab.chatSegments.length - 1];
  if (last && last.type === 'text') {
    last.content += chunk;
  } else {
    tab.chatSegments.push({ type: 'text', content: chunk });
  }
}

function appendThinkingChunk(tab: TabInstance, chunk: string): void {
  const last = tab.chatSegments[tab.chatSegments.length - 1];
  if (last && last.type === 'thinking') {
    last.content += chunk;
  } else {
    tab.chatSegments.push({ type: 'thinking', content: chunk });
  }
}

function renderStreamingMessage(tab: TabInstance): void {
  if (!tab.chatStreamEl) return;

  let html = renderSegmentsHtml(tab.chatSegments, true);
  html += '<span class="chat-streaming-cursor"></span>';

  tab.chatStreamEl.innerHTML = html;

  if (tab.chatMessagesEl) {
    tab.chatMessagesEl.scrollTop = tab.chatMessagesEl.scrollHeight;
  }
}

// --- Finalize assistant message (remove cursor, apply full markdown, add metrics) ---

function finalizeStreamingMessage(tab: TabInstance, metrics?: Record<string, number> | null): void {
  if (!tab.chatStreamEl) return;

  let html = renderSegmentsHtml(tab.chatSegments, false);

  // Response metrics
  if (metrics && metrics.evalCount > 0) {
    const tokensGen = metrics.evalCount;
    const evalSec = metrics.evalDuration / 1e9;
    const tokPerSec = evalSec > 0 ? (tokensGen / evalSec).toFixed(1) : '—';
    const ttft = metrics.promptEvalDuration > 0
      ? (metrics.promptEvalDuration / 1e6).toFixed(0) + 'ms'
      : '—';
    const totalSec = (metrics.totalDuration / 1e9).toFixed(1);

    let metricsHtml = `<div class="chat-response-metrics">` +
      `<span>${tokensGen} tokens</span>` +
      `<span>${tokPerSec} tok/s</span>` +
      `<span>TTFT ${ttft}</span>` +
      `<span>${totalSec}s total</span>`;

    // Context usage (if we know the model's context length)
    if (tab.chatModelContextLength > 0 && metrics.promptEvalCount > 0) {
      const pct = ((metrics.promptEvalCount / tab.chatModelContextLength) * 100).toFixed(1);
      const fillWidth = Math.min(100, (metrics.promptEvalCount / tab.chatModelContextLength) * 100);
      metricsHtml += `<span class="chat-context-bar">` +
        `ctx ${metrics.promptEvalCount.toLocaleString()}/${formatContextSize(tab.chatModelContextLength)}` +
        ` (${pct}%) ` +
        `<span class="chat-context-bar-track"><span class="chat-context-bar-fill" style="width:${fillWidth}%"></span></span>` +
        `</span>`;
    }

    metricsHtml += `</div>`;
    html += metricsHtml;
  }

  tab.chatStreamEl.innerHTML = html;

  if (tab.chatMessagesEl) {
    tab.chatMessagesEl.scrollTop = tab.chatMessagesEl.scrollHeight;
  }
}

function formatContextSize(tokens: number): string {
  if (tokens >= 1000000) return (tokens / 1000000).toFixed(0) + 'M';
  if (tokens >= 1000) return (tokens / 1000).toFixed(0) + 'K';
  return String(tokens);
}

// --- Send a chat message ---

function sendChatMessage(tab: TabInstance): void {
  if (!tab.chatInputEl || !tab.chatSendBtn || !tab.chatMessagesEl) return;

  const prompt = tab.chatInputEl.value.trim();
  if (!prompt || tab.isStreaming) return;

  // Disable input during streaming
  tab.isStreaming = true;
  tab.chatInputEl.disabled = true;
  tab.chatSendBtn.disabled = true;
  tab.chatSegments = [];
  tab.aiQuerySource = 'chat' as any;

  // Add user message to the UI
  const userMsg = document.createElement('div');
  userMsg.className = 'chat-msg chat-msg-user';
  const userLabel = document.createElement('div');
  userLabel.className = 'chat-msg-label';
  userLabel.textContent = 'You';
  userMsg.appendChild(userLabel);
  const userText = document.createElement('div');
  userText.textContent = prompt;
  userMsg.appendChild(userText);
  tab.chatMessagesEl.appendChild(userMsg);

  // Create assistant message placeholder
  const assistantMsg = document.createElement('div');
  assistantMsg.className = 'chat-msg chat-msg-assistant';
  const assistantLabel = document.createElement('div');
  assistantLabel.className = 'chat-msg-label';
  assistantLabel.textContent = configuredModel || 'Assistant';
  assistantMsg.appendChild(assistantLabel);
  const contentEl = document.createElement('div');
  assistantMsg.appendChild(contentEl);
  tab.chatMessagesEl.appendChild(assistantMsg);
  tab.chatStreamEl = contentEl;

  // Auto-scroll
  tab.chatMessagesEl.scrollTop = tab.chatMessagesEl.scrollHeight;

  // Clear input
  tab.chatInputEl.value = '';
  tab.chatInputEl.style.height = 'auto';

  // Send query
  window.electronAPI.chatQuery(tab.id, prompt);
}

// --- Create chat tab ---

function createChatTabInstance(): TabInstance {
  const id = String(nextTabId++);

  // --- DOM: tab bar entry ---
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.tabId = id;

  const titleSpan = document.createElement('span');
  titleSpan.className = 'tab-title';
  titleSpan.textContent = `Chat ${id}`;
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

  const addBtn = document.getElementById('tab-add')!;
  addBtn.parentElement!.insertBefore(tabEl, addBtn);

  // --- DOM: chat pane ---
  const paneEl = document.createElement('div');
  paneEl.className = 'terminal-pane chat-pane';
  paneEl.dataset.tabId = id;

  // Messages container (welcome is rendered inside, so it scrolls away)
  const messagesEl = document.createElement('div');
  messagesEl.className = 'chat-messages';
  paneEl.appendChild(messagesEl);

  // Input row — Claude Code style: "> " prompt + multiline textarea
  const inputRow = document.createElement('div');
  inputRow.className = 'chat-input-row';

  const promptEl = document.createElement('span');
  promptEl.className = 'chat-input-prompt';
  promptEl.textContent = '>';
  inputRow.appendChild(promptEl);

  const inputEl = document.createElement('textarea');
  inputEl.className = 'chat-input';
  inputEl.placeholder = 'Type a message...';
  inputEl.rows = 1;
  inputRow.appendChild(inputEl);

  const sendBtn = document.createElement('button');
  sendBtn.className = 'chat-send';
  sendBtn.textContent = 'Send';
  inputRow.appendChild(sendBtn);

  paneEl.appendChild(inputRow);

  // Model info bar (below input)
  const modelInfoEl = document.createElement('div');
  modelInfoEl.className = 'chat-model-info';
  paneEl.appendChild(modelInfoEl);

  document.getElementById('terminal-container')!.appendChild(paneEl);

  const tab: TabInstance = {
    id,
    type: 'chat',
    term: null as any,
    fitAddon: null as any,
    paneEl,
    tabEl,
    chatMessagesEl: messagesEl,
    chatInputEl: inputEl,
    chatSendBtn: sendBtn,
    chatModelInfoEl: modelInfoEl,
    chatStreamEl: null,
    chatSegments: [],
    chatModelContextLength: 0,
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
    welcomeShown: true,
    ptyBuffer: [],
    winStartupFilter: false,
    winFilterTimer: null,
    panelSuggestedCommand: '',
    panelResponseBuffer: '',
    isStreaming: false,
  };

  // Wire input events
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage(tab);
    }
  });

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
  });

  sendBtn.addEventListener('click', () => sendChatMessage(tab));

  tabInstances.set(id, tab);

  // Tell main process to create chat tab state
  window.electronAPI.tabCreateChat(id);

  // Apply cached config (font, colors, padding)
  if (cachedConfig && cachedTheme) {
    applyConfigToTab(tab, cachedConfig, cachedTheme);
  }

  updateTabBarCount();
  return tab;
}

async function showChatWelcome(tab: TabInstance): Promise<void> {
  if (!tab.chatMessagesEl) return;

  const version = await window.electronAPI.getVersion().catch(() => '0.0.0');
  const config = await window.electronAPI.configGet();
  const ollamaResult = await window.electronAPI.ollamaListModels();
  const ollamaRunning = ollamaResult.ok;

  // Build the welcome as a single <pre> block — same line structure as the
  // terminal welcome (showWelcome) so spacing and height match exactly.
  // Colors are applied via <span> with inline styles matching the ANSI
  // escape equivalents (S.brand = #00afff, S.gray = #8a8a8a).
  const brand = '#00afff';  // ANSI 256 color 39  (S.brand)
  const gray  = '#8a8a8a';  // ANSI 256 color 245 (S.gray)
  const white = '#ffffff';  // bold bright white   (S.white)

  const b = (t: string) => `<span style="color:${brand}">${t}</span>`;
  const d = (t: string) => `<span style="color:${gray}">${t}</span>`;
  const w = (t: string) => `<span style="color:${white};font-weight:bold">${t}</span>`;

  // Same lines as showWelcome() in the terminal, line by line
  const lines: string[] = [
    '',
    b(' \u2591\u2588\u2588\u2588\u2588\u2588\u2588\u2588  \u2591\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588   \u2591\u2588\u2588\u2588\u2588\u2588\u2588\u2588  \u2591\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588           \u2591\u2588\u2588\u2588\u2588\u2588\u2588\u2588   \u2591\u2588\u2588\u2588\u2588\u2588\u2588\u2588'),
    b('\u2591\u2588\u2588    \u2591\u2588\u2588 \u2591\u2588\u2588    \u2591\u2588\u2588 \u2591\u2588\u2588    \u2591\u2588\u2588 \u2591\u2588\u2588    \u2591\u2588\u2588 \u2591\u2588\u2588\u2588\u2588\u2588\u2588 \u2591\u2588\u2588    \u2591\u2588\u2588 \u2591\u2588\u2588'),
    b('\u2591\u2588\u2588    \u2591\u2588\u2588 \u2591\u2588\u2588    \u2591\u2588\u2588 \u2591\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588 \u2591\u2588\u2588    \u2591\u2588\u2588         \u2591\u2588\u2588    \u2591\u2588\u2588  \u2591\u2588\u2588\u2588\u2588\u2588\u2588\u2588'),
    b('\u2591\u2588\u2588    \u2591\u2588\u2588 \u2591\u2588\u2588\u2588   \u2591\u2588\u2588 \u2591\u2588\u2588        \u2591\u2588\u2588    \u2591\u2588\u2588         \u2591\u2588\u2588    \u2591\u2588\u2588        \u2591\u2588\u2588'),
    b(' \u2591\u2588\u2588\u2588\u2588\u2588\u2588\u2588  \u2591\u2588\u2588\u2591\u2588\u2588\u2588\u2588\u2588   \u2591\u2588\u2588\u2588\u2588\u2588\u2588\u2588  \u2591\u2588\u2588    \u2591\u2588\u2588          \u2591\u2588\u2588\u2588\u2588\u2588\u2588\u2588   \u2591\u2588\u2588\u2588\u2588\u2588\u2588\u2588'),
    b('           \u2591\u2588\u2588'),
    b('           \u2591\u2588\u2588'),
    '',
    ` ${d(`v${version} \u2014 Terminal emulator with private, local AI powered by Ollama`)}`,
    '',
    ` ${w('Chat tab')} ${d('\u2014 This is not a terminal. Chat freely with your LLM.')}`,
    ` ${d('Each Chat tab is an independent conversation.')}`,
    ` ${d('To start a fresh conversation, open a new Chat tab.')}`,
    '',
  ];

  // Onboarding (same structure as terminal onboarding)
  if (config.model && !ollamaRunning) {
    lines.push(` ${b('Ollama not reachable')}`);
    lines.push('');
    lines.push(`  ${d('The Ollama server does not appear to be running.')}`);
    lines.push(`  ${d('Start it with:')}  ${w('ollama serve')}`);
    lines.push('');
  } else if (!config.model) {
    if (!ollamaRunning) {
      lines.push(` ${b('Getting started')}`);
      lines.push('');
      lines.push(`  ${d(`This app uses ${w('Ollama')} for local AI. Install from ${b('https://ollama.com')} and pull a model:`)}`);
      lines.push(`    ${w('ollama pull llama3')}`);
      lines.push('');
    } else {
      lines.push(`  ${d(`Press ${w(getAiTriggerLabel())} or ${w('click')} the bar below to select a model.`)}`);
      lines.push('');
    }
  }

  const pre = document.createElement('pre');
  pre.className = 'chat-welcome';
  pre.innerHTML = lines.join('\n');
  tab.chatMessagesEl.appendChild(pre);
}

async function loadChatModelInfo(tab: TabInstance): Promise<void> {
  if (!tab.chatModelInfoEl) return;
  const config = await window.electronAPI.configGet();
  const modelName = config.model;

  const sendHint =
    '<span class="chat-model-info-hint">' +
    '<kbd>Enter</kbd> send ' +
    '<span class="chat-model-info-sep">·</span> ' +
    '<kbd>Shift</kbd>+<kbd>Enter</kbd> newline' +
    '</span>';

  if (!modelName) {
    tab.chatModelInfoEl.innerHTML =
      '<span class="chat-model-info-detail">No model configured</span>' + sendHint;
    return;
  }

  const info = await window.electronAPI.ollamaShowModel(modelName);

  const groups: string[] = [];
  groups.push(
    `<span class="chat-model-info-group"><span class="chat-model-info-name">${escapeHtml(modelName)}</span></span>`
  );

  if (info) {
    const parts: string[] = [];

    const details = info.details as Record<string, string> | undefined;
    if (details?.parameter_size) parts.push(details.parameter_size);
    if (details?.quantization_level) parts.push(details.quantization_level);

    const modelInfo = info.model_info as Record<string, unknown> | undefined;
    const family = details?.family;
    if (modelInfo && family) {
      const ctxKey = `${family}.context_length`;
      const ctxLen = modelInfo[ctxKey] as number | undefined;
      if (ctxLen && ctxLen > 0) {
        tab.chatModelContextLength = ctxLen;
        parts.push(formatContextSize(ctxLen) + ' ctx');
      }
    }

    if (parts.length > 0) {
      groups.push(
        `<span class="chat-model-info-group"><span class="chat-model-info-detail">${parts.join(
          ' \u00b7 '
        )}</span></span>`
      );
    }

    const capabilities = info.capabilities as string[] | undefined;
    const badges: string[] = [];
    if (capabilities) {
      if (capabilities.includes('thinking'))
        badges.push('<span class="chat-capability-badge thinking">thinking</span>');
      if (capabilities.includes('vision'))
        badges.push('<span class="chat-capability-badge vision">vision</span>');
      if (capabilities.includes('tools'))
        badges.push('<span class="chat-capability-badge tools">tools</span>');
    }
    if (badges.length > 0) {
      groups.push(`<span class="chat-model-info-group">${badges.join(' ')}</span>`);
    }
  }

  const sep = '<span class="chat-model-info-sep">·</span>';
  tab.chatModelInfoEl.innerHTML = groups.join(` ${sep} `) + sendHint;
}

async function createAndSwitchNewChatTab(): Promise<void> {
  const tab = createChatTabInstance();
  switchToTab(tab.id);
  await showChatWelcome(tab);
  await loadChatModelInfo(tab);
  // Focus the chat input
  if (tab.chatInputEl) tab.chatInputEl.focus();
}

// ============================================================
// CONFIG APPLICATION
// Fetches resolved config + theme from main process and applies
// to xterm.js options, terminal padding, and UI CSS variables.
// ============================================================

function applyConfigToTab(tab: TabInstance, config: AppConfigResolved, theme: ThemeColors): void {
  const p = config.window.padding;
  tab.paneEl.style.padding = `${p.top}px ${p.right}px ${p.bottom}px ${p.left}px`;

  if (tab.type === 'chat') {
    // Chat tabs: apply font and colors via CSS (no xterm.js)
    tab.paneEl.style.fontFamily = config.font.family;
    tab.paneEl.style.fontSize = config.font.size + 'px';
    tab.paneEl.style.color = theme.terminal.foreground;
    tab.paneEl.style.background = theme.terminal.background;
    return;
  }

  // Terminal tabs: apply to xterm.js options
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

function showWelcome(tab: TabInstance, version: string): number {
  const b = S.brand;
  const d = S.gray;
  const r = S.reset;

  const lines = [
    '',
    `${b} ░███████  ░████████   ░███████  ░████████           ░███████   ░███████${r}`,
    `${b}░██    ░██ ░██    ░██ ░██    ░██ ░██    ░██ ░██████ ░██    ░██ ░██${r}`,
    `${b}░██    ░██ ░██    ░██ ░█████████ ░██    ░██         ░██    ░██  ░███████${r}`,
    `${b}░██    ░██ ░███   ░██ ░██        ░██    ░██         ░██    ░██        ░██${r}`,
    `${b} ░███████  ░██░█████   ░███████  ░██    ░██          ░███████   ░███████${r}`,
    `${b}           ░██${r}`,
    `${b}           ░██${r}`,
    '',
    ` ${d}v${version} — Terminal emulator with private, local AI powered by Ollama${r}`,
    ` ${d}${getAiTriggerLabel()} — open-os assistant${r}`,
    '',
  ];
  tab.term.write(lines.join('\r\n') + '\r\n');
  return lines.length;
}

// Onboarding intro — shown when Ollama is not running or no model is configured
async function showOnboarding(tab: TabInstance): Promise<number> {
  const b = S.brand;
  const d = S.gray;
  const w = S.white;
  const r = S.reset;

  const config = await window.electronAPI.configGet();
  const ollamaResult = await window.electronAPI.ollamaListModels();
  const ollamaRunning = ollamaResult.ok;
  const hasModels = ollamaResult.ok && ollamaResult.models.length > 0;

  // If already configured and Ollama is reachable, skip onboarding
  if (config.model && ollamaRunning) return 0;

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
  return lines.length;
}

async function initTab(tab: TabInstance): Promise<void> {
  const version = await window.electronAPI.getVersion().catch(() => '0.0.0');
  const welcomeLines = showWelcome(tab, version);
  const onboardingLines = await showOnboarding(tab);
  tab.welcomeShown = true;

  const isWin = window.electronAPI.getPlatform() === 'win32';
  if (isWin) {
    // PowerShell clears the screen on startup (ESC[2J, ESC[H, floods of \r\n)
    // which would wipe the welcome banner. Discard the buffered startup output
    // and activate a short filter that strips destructive sequences from the
    // next chunks until the actual prompt arrives.
    tab.ptyBuffer = [];
    tab.winStartupFilter = true;
    // ConPTY maintains its own screen buffer and emits absolute cursor
    // positioning.  The welcome banner was written directly to xterm.js, so
    // ConPTY's cursor is still near row 0.  Feed Enter keys to the PTY to
    // advance ConPTY's internal cursor to match xterm.js.  The startup
    // filter eats the resulting echoed prompts, then sends one final Enter
    // to get a clean prompt that flows through the normal (unfiltered) path
    // with correct cursor positioning.
    const enters = '\r'.repeat(welcomeLines + onboardingLines);
    window.electronAPI.ptyWrite(tab.id, enters);
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

/** Strip PowerShell startup sequences that would clear the screen. */
function stripWinStartupNoise(data: string): string {
  return data
    .replace(/\x1b\[\?[0-9;]*[hlsr]/g, '')   // mode sets (cursor hide/show, focus events)
    .replace(/\x1b\[2J/g, '')                  // clear screen
    .replace(/\x1b\[H/g, '')                   // cursor home
    .replace(/\x1b\[K/g, '')                   // erase line
    .replace(/\x1b\[m/g, '')                   // reset attributes
    .replace(/\x1b\][^\x07]*\x07/g, '')        // OSC sequences (window title)
    .replace(/[\r\n]+/g, '');                   // collapse all newlines
}

window.electronAPI.onPtyData((tabId, data) => {
  const tab = tabInstances.get(tabId);
  if (!tab || tab.type === 'chat') return;
  if (!tab.welcomeShown) {
    tab.ptyBuffer.push(data);
  } else if (tab.winStartupFilter) {
    // Filter destructive sequences.  We feed Enter keys to the PTY to
    // advance ConPTY's cursor past the welcome banner, which causes
    // multiple prompt echoes.  Debounce: eat all intermediate prompts
    // and, once quiet, disable the filter and send one final Enter so
    // the shell emits a clean prompt through the normal (unfiltered)
    // path with correct ConPTY cursor positioning.
    const cleaned = stripWinStartupNoise(data);
    if (cleaned.length > 0) {
      if (tab.winFilterTimer) clearTimeout(tab.winFilterTimer);
      tab.winFilterTimer = setTimeout(() => {
        tab.winStartupFilter = false;
        tab.winFilterTimer = null;
        // Trigger a fresh prompt that passes through the normal path.
        window.electronAPI.ptyWrite(tab.id, '\r');
      }, 200);
    }
  } else {
    tab.term.write(data);
  }
});

window.electronAPI.onPtyExit((tabId) => {
  const tab = tabInstances.get(tabId);
  if (!tab || tab.type === 'chat') return;
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
  if (tab.type === 'chat') return;
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
  tab.term.write(`${S.prompt}> ${S.input}`);
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
const aiModelInfo = document.getElementById('ai-model-info')!;
const aiModelDetails = document.getElementById('ai-model-details')!;
const aiChangeModelBtn = document.getElementById('ai-change-model')!;
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
    await showModelInfo();
  }
}

function closeAIPanel(): void {
  aiPanelOpen = false;
  aiPanel.classList.remove('open');
  hintBar.classList.remove('hidden');
  aiStatus.textContent = '';
  const tab = tabInstances.get(activeTabId);
  if (tab && tab.type === 'terminal') tab.term.focus();
  else if (tab && tab.chatInputEl) tab.chatInputEl.focus();
  fitTerminal();
}

// Model selection list
async function showSetup(): Promise<void> {
  aiSetup.classList.remove('hidden');
  aiModelInfo.classList.add('hidden');
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

  setupMessage.textContent = 'Select a model';
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
  await showModelInfo();
}

// Model info display
async function showModelInfo(): Promise<void> {
  aiSetup.classList.add('hidden');
  aiModelInfo.classList.remove('hidden');
  aiModelLabel.textContent = `[${configuredModel}]`;
  aiModelDetails.innerHTML = '<span style="color:#3a5a7c">Loading model info...</span>';

  const info = await window.electronAPI.ollamaShowModel(configuredModel || '');

  if (!info) {
    aiModelDetails.innerHTML = `<div class="panel-model-name">${escapeHtml(configuredModel || '')}</div>` +
      `<div class="panel-model-row"><span class="label">Status</span> Could not load model details</div>`;
    return;
  }

  const details = info.details as Record<string, string> | undefined;
  const capabilities = info.capabilities as string[] | undefined;
  const modelInfoMap = info.model_info as Record<string, unknown> | undefined;
  const family = details?.family;

  let html = `<div class="panel-model-name">${escapeHtml(configuredModel || '')}</div>`;

  // Architecture / family
  if (details?.family) {
    const families = (details as any).families;
    const familyLabel = Array.isArray(families) ? families.join(', ') : details.family;
    html += `<div class="panel-model-row"><span class="label">Family</span> ${escapeHtml(familyLabel)}</div>`;
  }

  // Parameters and quantization
  if (details?.parameter_size) {
    html += `<div class="panel-model-row"><span class="label">Parameters</span> ${escapeHtml(details.parameter_size)}`;
    if (details?.quantization_level) html += ` (${escapeHtml(details.quantization_level)})`;
    html += `</div>`;
  }

  // Context window
  if (modelInfoMap && family) {
    const ctxLen = modelInfoMap[`${family}.context_length`] as number | undefined;
    if (ctxLen && ctxLen > 0) {
      html += `<div class="panel-model-row"><span class="label">Context</span> ${ctxLen.toLocaleString()} tokens (${formatContextSize(ctxLen)})</div>`;
    }
  }

  // Format
  if (details?.format) {
    html += `<div class="panel-model-row"><span class="label">Format</span> ${escapeHtml(details.format)}</div>`;
  }

  // Capabilities badges
  if (capabilities && capabilities.length > 0) {
    html += `<div class="panel-model-row"><span class="label">Capabilities</span> `;
    for (const cap of capabilities) {
      const cls = ['thinking', 'vision', 'tools', 'completion'].includes(cap) ? ` ${cap}` : '';
      html += `<span class="panel-badge${cls}">${escapeHtml(cap)}</span>`;
    }
    html += `</div>`;
  }

  aiModelDetails.innerHTML = html;
}

aiClose.addEventListener('click', closeAIPanel);

// Click on model label → switch model
aiModelLabel.addEventListener('click', () => {
  if (aiPanelOpen) showSetup();
});

// Change model button
aiChangeModelBtn.addEventListener('click', () => {
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

  // Chat tabs: focus the chat input instead of opening inline/panel
  if (tab.type === 'chat') {
    if (tab.chatInputEl) tab.chatInputEl.focus();
    return;
  }

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

// (Panel query removed — panel is now model selector/info only)

// ============================================================
// 7. AI RESPONSE ROUTING (tab-aware)
// ============================================================

// Thinking chunks (Ollama's dedicated message.thinking field)
window.electronAPI.onAiThinkingChunk((tabId, chunk) => {
  const tab = tabInstances.get(tabId);
  if (!tab) return;

  if ((tab.aiQuerySource as string) === 'chat') {
    appendThinkingChunk(tab, chunk);
    renderStreamingMessage(tab);
  }
});

window.electronAPI.onAiChunk((tabId, chunk) => {
  const tab = tabInstances.get(tabId);
  if (!tab) return;

  if ((tab.aiQuerySource as string) === 'chat') {
    appendTextChunk(tab, chunk);
    renderStreamingMessage(tab);
  } else if (tab.aiQuerySource === 'inline') {
    tab.inlineResponseBuffer += chunk;
  }
});

window.electronAPI.onAiToolCall((tabId, name, args) => {
  const tab = tabInstances.get(tabId);
  if (!tab) return;
  if ((tab.aiQuerySource as string) !== 'chat') return;
  tab.chatSegments.push({ type: 'tool-call', name, args: args || {} });
  renderStreamingMessage(tab);
});

window.electronAPI.onAiToolResult((tabId, name, result) => {
  const tab = tabInstances.get(tabId);
  if (!tab) return;
  if ((tab.aiQuerySource as string) !== 'chat') return;
  tab.chatSegments.push({ type: 'tool-result', name, content: result });
  renderStreamingMessage(tab);
});

window.electronAPI.onAiDone((tabId, metrics) => {
  const tab = tabInstances.get(tabId);
  if (!tab) return;

  if ((tab.aiQuerySource as string) === 'chat') {
    finalizeStreamingMessage(tab, metrics);
    tab.isStreaming = false;
    tab.chatStreamEl = null;
    tab.chatSegments = [];
    tab.aiQuerySource = null;
    // Re-enable input
    if (tab.chatInputEl) {
      tab.chatInputEl.disabled = false;
      tab.chatInputEl.focus();
    }
    if (tab.chatSendBtn) tab.chatSendBtn.disabled = false;
    return;
  }

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
  }
});

window.electronAPI.onAiError((tabId, error) => {
  const tab = tabInstances.get(tabId);
  if (!tab) return;

  if ((tab.aiQuerySource as string) === 'chat') {
    // Show error in chat
    if (tab.chatStreamEl) {
      tab.chatStreamEl.innerHTML = `<span style="color:#ff6b6b">[Error] ${escapeHtml(error)}</span>`;
    } else if (tab.chatMessagesEl) {
      const errorMsg = document.createElement('div');
      errorMsg.className = 'chat-msg chat-msg-error';
      errorMsg.textContent = `[Error] ${error}`;
      tab.chatMessagesEl.appendChild(errorMsg);
    }
    tab.isStreaming = false;
    tab.chatStreamEl = null;
    tab.chatSegments = [];
    tab.aiQuerySource = null;
    if (tab.chatInputEl) {
      tab.chatInputEl.disabled = false;
      tab.chatInputEl.focus();
    }
    if (tab.chatSendBtn) tab.chatSendBtn.disabled = false;
    return;
  }

  if (tab.aiQuerySource === 'inline') {
    tab.term.write(`\r\n${S.error}[Error] ${error}${S.reset}\r\n`);
    inlineSeparatorClose(tab);
    window.electronAPI.ptyWrite(tab.id, '\r');
    resetInlineState(tab);
  }
});

// ============================================================
// 8. COPY / PASTE / CLEAR (right-click context menu)
// ============================================================

window.electronAPI.onTermCopy(() => {
  const tab = tabInstances.get(activeTabId);
  if (!tab) return;
  if (tab.type === 'chat') {
    // Copy selected text from the chat pane
    const selection = window.getSelection();
    if (selection && selection.toString()) {
      navigator.clipboard.writeText(selection.toString());
    }
  } else {
    const selection = tab.term.getSelection();
    if (selection) {
      navigator.clipboard.writeText(selection);
    }
  }
});

window.electronAPI.onTermPaste((text) => {
  const tab = tabInstances.get(activeTabId);
  if (!tab) return;
  if (tab.type === 'chat') {
    if (tab.chatInputEl) {
      const input = tab.chatInputEl;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      input.selectionStart = input.selectionEnd = start + text.length;
      input.dispatchEvent(new Event('input'));
      input.focus();
    }
  } else if (tab.inlineState === 'input') {
    tab.inlineInputBuffer += text;
    tab.term.write(S.input + text);
  } else if (tab.inlineState === 'idle') {
    window.electronAPI.ptyWrite(tab.id, text);
  }
});

window.electronAPI.onTermClear(() => {
  const tab = tabInstances.get(activeTabId);
  if (!tab) return;
  if (tab.type === 'chat') {
    // Clear chat messages
    if (tab.chatMessagesEl) tab.chatMessagesEl.innerHTML = '';
  } else {
    tab.term.clear();
    tab.term.write('\x1b[2J\x1b[H');
    window.electronAPI.ptyWrite(tab.id, '\r');
  }
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
document.getElementById('tab-add-chat')!.addEventListener('click', createAndSwitchNewChatTab);
window.electronAPI.onTabNewRequest(() => createAndSwitchNewTab());
window.electronAPI.onChatTabNewRequest(() => createAndSwitchNewChatTab());

// ============================================================
// 12. STARTUP — create first tab
// ============================================================

(async () => {
  await applyConfig().catch(() => {});
  const firstTab = createTabInstance();
  switchToTab(firstTab.id);
  await initTab(firstTab);
})();
