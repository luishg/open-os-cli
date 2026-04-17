// ============================================================
// ELECTRON MAIN PROCESS
// Responsibilities:
//   1. Create the app window
//   2. Manage the PTY (shell) via node-pty
//   3. Handle AI queries (Ollama HTTP) and stream responses
//   4. Bridge everything to the renderer via IPC
// ============================================================

import { app, BrowserWindow, ipcMain, Menu, clipboard, shell as electronShell } from 'electron';
import * as pty from 'node-pty';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as http from 'http';
import { execSync, spawn } from 'child_process';
import { TOOL_SCHEMAS, executeTool } from './tools/web';

let mainWindow: BrowserWindow;

// Conversation history for Ollama multi-turn context
interface ToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}
const MAX_HISTORY_MESSAGES = 20; // 10 exchanges (user + assistant pairs)
const MAX_TOOL_ROUNDS = 4;        // agent-loop safety cap in chat mode

// Per-tab state: each tab has its own PTY (terminal) or just conversation history (chat)
interface TabState {
  type: 'terminal' | 'chat';
  shell: pty.IPty | null;
  conversationHistory: ChatMessage[];
}
const tabs = new Map<string, TabState>();
const MAX_CHAT_HISTORY_MESSAGES = 50; // 25 exchanges for chat tabs

// ============================================================
// CONFIG
// Persists user settings to disk in Ghostty/Kitty-style key-value format.
// Location: ~/.config/open-os-cli/config.conf
// Theme files: ~/.config/open-os-cli/themes/{name}.json
// ============================================================

const CONFIG_DIR = path.join(os.homedir(), '.config', 'open-os-cli');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.conf');
const THEMES_DIR = path.join(CONFIG_DIR, 'themes');

// --- Config interfaces ---

interface ResolvedConfig {
  model: string | null;
  theme: string | null;
  font: { family: string; size: number };
  cursor: { blink: boolean; style: 'block' | 'underline' | 'bar' };
  window: {
    padding: { top: number; right: number; bottom: number; left: number };
    scrollback: number;
  };
  keybindings: { aiTrigger: string };
  chat: { toolsEnabled: boolean };
}

interface ThemeColors {
  terminal: {
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
    black?: string;
    red?: string;
    green?: string;
    yellow?: string;
    blue?: string;
    magenta?: string;
    cyan?: string;
    white?: string;
    brightBlack?: string;
    brightRed?: string;
    brightGreen?: string;
    brightYellow?: string;
    brightBlue?: string;
    brightMagenta?: string;
    brightCyan?: string;
    brightWhite?: string;
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

// --- Defaults ---

const DEFAULT_CONFIG: ResolvedConfig = {
  model: null,
  theme: null,
  font: {
    family: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
    size: 14,
  },
  cursor: { blink: true, style: 'block' },
  window: {
    padding: { top: 16, right: 20, bottom: 16, left: 20 },
    scrollback: 1000,
  },
  keybindings: { aiTrigger: 'Ctrl+Space' },
  chat: { toolsEnabled: true },
};

const DEFAULT_THEME: ThemeColors = {
  terminal: {
    background: '#1a1a2e',
    foreground: '#e0e0e0',
    cursor: '#00b4d8',
    selectionBackground: '#00b4d844',
  },
  ui: {
    background: '#1a1a2e',
    panelBackground: '#0d1b2a',
    panelBorder: '#00b4d8',
    panelHeaderBackground: '#0a1628',
    hintBarBackground: '#0a1628',
    hintBarColor: '#3a5a7c',
    accent: '#00b4d8',
  },
};

// --- .conf parser (Ghostty/Kitty-style key = value) ---

function parseConfFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function loadConfigRaw(): Record<string, string> {
  try {
    return parseConfFile(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

// --- .conf writer ---

function writeConfFile(filePath: string, sections: { comment?: string; entries: [string, string][] }[]): void {
  const lines: string[] = [];
  for (const section of sections) {
    if (section.comment) {
      lines.push(`# ${section.comment}`);
    }
    for (const [key, value] of section.entries) {
      lines.push(`${key} = ${value}`);
    }
    lines.push('');
  }
  fs.writeFileSync(filePath, lines.join('\n'));
}

// --- Save a single key into the .conf file (preserves other values & comments) ---

function saveConfigKey(key: string, value: string): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  let content = '';
  try {
    content = fs.readFileSync(CONFIG_FILE, 'utf-8');
  } catch {
    // File doesn't exist yet — will be created
  }

  const lines = content.split('\n');
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#') || !trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const lineKey = trimmed.slice(0, eqIdx).trim();
    if (lineKey === key) {
      lines[i] = `${key} = ${value}`;
      found = true;
      break;
    }
  }

  if (!found) {
    // Append the key at the end
    lines.push(`${key} = ${value}`);
  }

  fs.writeFileSync(CONFIG_FILE, lines.join('\n'));
}

// --- Config resolution (flat keys → typed config) ---

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveConfig(): ResolvedConfig {
  const raw = loadConfigRaw();
  const d = DEFAULT_CONFIG;

  const parsedSize = parseFloat(raw['font-size']);
  const parsedScrollback = parseInt(raw['window-scrollback'], 10);
  const parsedPadTop = parseInt(raw['window-padding-top'], 10);
  const parsedPadRight = parseInt(raw['window-padding-right'], 10);
  const parsedPadBottom = parseInt(raw['window-padding-bottom'], 10);
  const parsedPadLeft = parseInt(raw['window-padding-left'], 10);

  const cursorStyle = raw['cursor-style'] || d.cursor.style;
  const validStyles = ['block', 'underline', 'bar'];

  const blinkValue = raw['cursor-blink'];
  const blink = blinkValue === 'true' ? true
    : blinkValue === 'false' ? false
    : d.cursor.blink;

  return {
    model: raw['model'] || d.model,
    theme: raw['theme'] || d.theme,
    font: {
      family: raw['font-family']?.trim() || d.font.family,
      size: !isNaN(parsedSize) ? clamp(Math.round(parsedSize), 6, 72) : d.font.size,
    },
    cursor: {
      blink,
      style: validStyles.includes(cursorStyle)
        ? cursorStyle as 'block' | 'underline' | 'bar' : d.cursor.style,
    },
    window: {
      padding: {
        top: !isNaN(parsedPadTop) ? clamp(parsedPadTop, 0, 200) : d.window.padding.top,
        right: !isNaN(parsedPadRight) ? clamp(parsedPadRight, 0, 200) : d.window.padding.right,
        bottom: !isNaN(parsedPadBottom) ? clamp(parsedPadBottom, 0, 200) : d.window.padding.bottom,
        left: !isNaN(parsedPadLeft) ? clamp(parsedPadLeft, 0, 200) : d.window.padding.left,
      },
      scrollback: !isNaN(parsedScrollback) ? clamp(parsedScrollback, 0, 100000) : d.window.scrollback,
    },
    keybindings: {
      aiTrigger: raw['keybind-ai-trigger']?.trim() || d.keybindings.aiTrigger,
    },
    chat: {
      toolsEnabled: raw['chat-tools-enabled'] === 'false' ? false
        : raw['chat-tools-enabled'] === 'true' ? true
        : d.chat.toolsEnabled,
    },
  };
}

// --- Theme loading (themes stay as JSON — they're structured data, not user-edited frequently) ---

function loadTheme(name: string | null): ThemeColors {
  if (!name) return DEFAULT_THEME;

  try {
    const themeFile = path.join(THEMES_DIR, `${name}.json`);
    const raw = JSON.parse(fs.readFileSync(themeFile, 'utf-8'));
    const t = raw.terminal || {};
    const u = raw.ui || {};
    const dt = DEFAULT_THEME.terminal;
    const du = DEFAULT_THEME.ui;

    return {
      terminal: {
        background: typeof t.background === 'string' ? t.background : dt.background,
        foreground: typeof t.foreground === 'string' ? t.foreground : dt.foreground,
        cursor: typeof t.cursor === 'string' ? t.cursor : dt.cursor,
        selectionBackground: typeof t.selectionBackground === 'string' ? t.selectionBackground : dt.selectionBackground,
        ...(typeof t.black === 'string' && { black: t.black }),
        ...(typeof t.red === 'string' && { red: t.red }),
        ...(typeof t.green === 'string' && { green: t.green }),
        ...(typeof t.yellow === 'string' && { yellow: t.yellow }),
        ...(typeof t.blue === 'string' && { blue: t.blue }),
        ...(typeof t.magenta === 'string' && { magenta: t.magenta }),
        ...(typeof t.cyan === 'string' && { cyan: t.cyan }),
        ...(typeof t.white === 'string' && { white: t.white }),
        ...(typeof t.brightBlack === 'string' && { brightBlack: t.brightBlack }),
        ...(typeof t.brightRed === 'string' && { brightRed: t.brightRed }),
        ...(typeof t.brightGreen === 'string' && { brightGreen: t.brightGreen }),
        ...(typeof t.brightYellow === 'string' && { brightYellow: t.brightYellow }),
        ...(typeof t.brightBlue === 'string' && { brightBlue: t.brightBlue }),
        ...(typeof t.brightMagenta === 'string' && { brightMagenta: t.brightMagenta }),
        ...(typeof t.brightCyan === 'string' && { brightCyan: t.brightCyan }),
        ...(typeof t.brightWhite === 'string' && { brightWhite: t.brightWhite }),
      },
      ui: {
        background: typeof u.background === 'string' ? u.background : du.background,
        panelBackground: typeof u.panelBackground === 'string' ? u.panelBackground : du.panelBackground,
        panelBorder: typeof u.panelBorder === 'string' ? u.panelBorder : du.panelBorder,
        panelHeaderBackground: typeof u.panelHeaderBackground === 'string' ? u.panelHeaderBackground : du.panelHeaderBackground,
        hintBarBackground: typeof u.hintBarBackground === 'string' ? u.hintBarBackground : du.hintBarBackground,
        hintBarColor: typeof u.hintBarColor === 'string' ? u.hintBarColor : du.hintBarColor,
        accent: typeof u.accent === 'string' ? u.accent : du.accent,
      },
    };
  } catch {
    return DEFAULT_THEME;
  }
}

// --- Keybinding parsing ---

interface ParsedKeybinding {
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  code: string;
}

function parseKeybinding(binding: string): ParsedKeybinding {
  const parts = binding.split('+').map(p => p.trim());
  const key = parts.pop() || 'Space';
  const modifiers = new Set(parts.map(m => m.toLowerCase()));

  // Map user-friendly names to Electron input.code values
  const codeMap: Record<string, string> = {
    space: 'Space', enter: 'Enter', tab: 'Tab', escape: 'Escape',
    backspace: 'Backspace', delete: 'Delete',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  };

  const keyLower = key.toLowerCase();
  const code = codeMap[keyLower]
    || (keyLower.length === 1 && keyLower >= 'a' && keyLower <= 'z' ? `Key${key.toUpperCase()}` : key);

  return {
    control: modifiers.has('ctrl') || modifiers.has('control'),
    shift: modifiers.has('shift'),
    alt: modifiers.has('alt'),
    meta: modifiers.has('meta') || modifiers.has('cmd') || modifiers.has('super'),
    code,
  };
}

// --- Open config in system editor ---

function ensureConfigFile(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  // Read existing values (if any) to preserve user settings
  const existing = loadConfigRaw();
  const d = DEFAULT_CONFIG;

  writeConfFile(CONFIG_FILE, [
    {
      comment: 'AI Model',
      entries: [['model', existing['model'] || '']],
    },
    {
      comment: 'Theme (load from ~/.config/open-os-cli/themes/{name}.json)',
      entries: [['# theme', existing['theme'] || 'dracula']],
    },
    {
      comment: 'Font',
      entries: [
        ['font-family', existing['font-family'] || d.font.family],
        ['font-size', existing['font-size'] || String(d.font.size)],
      ],
    },
    {
      comment: 'Cursor',
      entries: [
        ['cursor-blink', existing['cursor-blink'] || String(d.cursor.blink)],
        ['cursor-style', existing['cursor-style'] || d.cursor.style],
      ],
    },
    {
      comment: 'Window',
      entries: [
        ['window-padding-top', existing['window-padding-top'] || String(d.window.padding.top)],
        ['window-padding-right', existing['window-padding-right'] || String(d.window.padding.right)],
        ['window-padding-bottom', existing['window-padding-bottom'] || String(d.window.padding.bottom)],
        ['window-padding-left', existing['window-padding-left'] || String(d.window.padding.left)],
        ['window-scrollback', existing['window-scrollback'] || String(d.window.scrollback)],
      ],
    },
    {
      comment: 'Keybindings',
      entries: [
        ['keybind-ai-trigger', existing['keybind-ai-trigger'] || d.keybindings.aiTrigger],
      ],
    },
    {
      comment: 'Chat (agent / web tools). Requires a model with the "tools" capability.',
      entries: [
        ['chat-tools-enabled', existing['chat-tools-enabled'] || String(d.chat.toolsEnabled)],
      ],
    },
  ]);
}

function openConfigFile(): void {
  ensureConfigFile();

  // Platform-specific: open in text editor (not browser)
  if (os.platform() === 'darwin') {
    // macOS: open -t forces default text editor
    spawn('open', ['-t', CONFIG_FILE], { detached: true, stdio: 'ignore' }).unref();
  } else if (os.platform() === 'win32') {
    // Windows: shell.openPath works correctly for .conf
    electronShell.openPath(CONFIG_FILE);
  } else {
    // Linux: prefer $VISUAL/$EDITOR, fall back to xdg-open (.conf = text/plain)
    const editor = process.env.VISUAL || process.env.EDITOR || 'xdg-open';
    spawn(editor, [CONFIG_FILE], { detached: true, stdio: 'ignore' }).unref();
  }
}

// ============================================================
// 1. WINDOW
// ============================================================

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    title: 'open-os cli',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Remove the default Electron menu bar (File, Edit, View, Help)
  Menu.setApplicationMenu(null);

  mainWindow.loadFile(path.join(__dirname, 'frontend', 'index.html'));

  // Intercept AI trigger keybinding at Electron level — before xterm.js can swallow it
  const config = resolveConfig();
  const aiTrigger = parseKeybinding(config.keybindings.aiTrigger);

  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (
      input.type === 'keyDown' &&
      input.control === aiTrigger.control &&
      input.shift === aiTrigger.shift &&
      input.alt === aiTrigger.alt &&
      input.meta === aiTrigger.meta &&
      input.code === aiTrigger.code
    ) {
      _event.preventDefault();
      mainWindow.webContents.send('toggle-ai-panel');
    }
  });

  // Right-click context menu
  mainWindow.webContents.on('context-menu', () => {
    const menu = Menu.buildFromTemplate([
      {
        label: 'New Tab',
        click: () => mainWindow.webContents.send('tab:new-request'),
      },
      {
        label: 'New Chat Tab',
        click: () => mainWindow.webContents.send('tab:new-chat-request'),
      },
      { type: 'separator' },
      {
        label: 'Copy',
        click: () => mainWindow.webContents.send('term:copy'),
      },
      {
        label: 'Paste',
        click: () => {
          const text = clipboard.readText();
          if (text) mainWindow.webContents.send('term:paste', text);
        },
      },
      { type: 'separator' },
      {
        label: 'Clear',
        click: () => mainWindow.webContents.send('term:clear'),
      },
      { type: 'separator' },
      {
        label: 'Settings',
        click: () => openConfigFile(),
      },
    ]);
    menu.popup({ window: mainWindow });
  });
}

// ============================================================
// 2. PTY (terminal shell) — per-tab
// node-pty spawns a real shell (bash/zsh/fish) in a PTY.
// Each tab gets its own PTY and conversation history.
// ============================================================

function createTab(tabId: string): void {
  const isWin = os.platform() === 'win32';
  const defaultShell = isWin ? 'powershell.exe' : process.env.SHELL || 'bash';
  const shellArgs = isWin ? ['-NoLogo'] : [];

  const tabShell = pty.spawn(defaultShell, shellArgs, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: os.homedir() || process.cwd(),
    env: process.env as { [key: string]: string },
  });

  const tabState: TabState = { type: 'terminal', shell: tabShell, conversationHistory: [] };
  tabs.set(tabId, tabState);

  // PTY output → renderer (tagged with tabId)
  tabShell.onData((data: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', tabId, data);
    }
  });

  tabShell.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', tabId, exitCode);
    }
    tabs.delete(tabId);
  });
}

function destroyTab(tabId: string): void {
  const tab = tabs.get(tabId);
  if (tab) {
    if (tab.shell) tab.shell.kill();
    tabs.delete(tabId);
  }
}

// --- Chat tab (no PTY, just conversation history) ---

function createChatTab(tabId: string): void {
  const tabState: TabState = { type: 'chat', shell: null, conversationHistory: [] };
  tabs.set(tabId, tabState);
}

// ============================================================
// 3. AI PROVIDER — OLLAMA
//
// Sends a streaming request to Ollama's /api/chat endpoint.
// Each chunk is forwarded to the renderer via IPC so the AI
// panel can display the response as it arrives.
//
// This is the ONLY place that talks to the LLM.
// The renderer never calls Ollama directly.
// ============================================================

const OLLAMA_HOST = 'localhost';
const OLLAMA_PORT = 11434;

// Lists models installed in Ollama (GET /api/tags)
function listOllamaModels(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/tags`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const names = (json.models || []).map((m: { name: string }) => m.name);
            resolve(names);
          } catch {
            resolve([]);
          }
        });
      })
      .on('error', (err) => reject(err));
  });
}

// Detect Linux distro from /etc/os-release (returns "" on non-Linux)
function getDistro(): string {
  try {
    const content = fs.readFileSync('/etc/os-release', 'utf-8');
    const match = content.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function buildSystemPrompt(): string {
  const platform = os.platform();
  const arch = os.arch();
  const isWin = platform === 'win32';
  const isMac = platform === 'darwin';
  const userShell = isWin ? 'powershell' : path.basename(process.env.SHELL || 'bash');
  const distro = getDistro();

  const platformName = isWin ? 'Windows' : isMac ? 'macOS' : (distro || 'Linux');
  const envLine = [platformName, arch, `shell: ${userShell}`].join(', ');

  let platformHint = '';
  if (isWin) {
    platformHint = '\nUse PowerShell syntax. Do NOT suggest Unix/bash commands (ls -l, grep, cat, chmod, etc.). Use PowerShell cmdlets: Get-ChildItem, Select-String, Get-Content, Set-ExecutionPolicy, etc.';
  } else if (isMac) {
    platformHint = '\nThis is macOS. Use BSD/macOS command variants. Use brew for package management if relevant.';
  }

  return `You are a concise terminal assistant.
Environment: ${envLine}.${platformHint}
Always respond with JSON: {"text": "brief explanation", "commands": ["command1", "command2"]}
Each command must be a complete, runnable shell command (may contain newlines for heredocs).
Use an empty commands array when no commands are needed.
Warn before dangerous commands (rm -rf, dd, mkfs…).`;
}

function queryOllama(tabId: string, prompt: string, context: string): void {
  const config = resolveConfig();
  const model = config.model;
  const tab = tabs.get(tabId);

  if (!model) {
    const trigger = config.keybindings.aiTrigger;
    mainWindow.webContents.send('ai:error', tabId, `No model selected. Press ${trigger} to configure.`);
    return;
  }

  // Use per-tab conversation history (fall back to empty if tab was closed)
  const history = tab?.conversationHistory ?? [];

  // Build user message and add to conversation history
  const userContent = context
    ? `Terminal context:\n\`\`\`\n${context}\n\`\`\`\n\n${prompt}`
    : prompt;

  history.push({ role: 'user', content: userContent });

  // Trim oldest messages to stay within budget
  while (history.length > MAX_HISTORY_MESSAGES) {
    history.shift();
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...history,
  ];

  const body = JSON.stringify({
    model,
    messages,
    stream: true,
    format: 'json',
  });

  let currentAssistantResponse = '';

  const req = http.request(
    {
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    (res) => {
      let buffer = '';
      let doneSent = false;

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            if (json.message?.content) {
              currentAssistantResponse += json.message.content;
              mainWindow.webContents.send('ai:chunk', tabId, json.message.content);
            }
            if (json.done && !doneSent) {
              doneSent = true;
              if (currentAssistantResponse) {
                history.push({ role: 'assistant', content: currentAssistantResponse });
              }
              mainWindow.webContents.send('ai:done', tabId);
            }
          } catch {
            // Incomplete JSON line — will be completed in the next chunk
          }
        }
      });

      // Fallback: if stream ended without a done message
      res.on('end', () => {
        if (!doneSent) {
          doneSent = true;
          if (currentAssistantResponse) {
            history.push({ role: 'assistant', content: currentAssistantResponse });
          }
          mainWindow.webContents.send('ai:done', tabId);
        }
      });
    },
  );

  req.on('error', (err: Error) => {
    // Roll back the user message since the request failed
    const lastIdx = history.length - 1;
    if (lastIdx >= 0 && history[lastIdx].role === 'user') {
      history.pop();
    }

    const message =
      err.message.includes('ECONNREFUSED')
        ? `Cannot connect to Ollama at ${OLLAMA_HOST}:${OLLAMA_PORT}. Is Ollama running?`
        : err.message;
    mainWindow.webContents.send('ai:error', tabId, message);
  });

  req.write(body);
  req.end();
}

// --- Chat-mode Ollama query (free-form text with optional tool-use agent loop) ---

// Capability cache: avoid re-hitting /api/show every turn for the same model.
const toolCapabilityCache = new Map<string, boolean>();

async function modelSupportsTools(model: string): Promise<boolean> {
  if (toolCapabilityCache.has(model)) return toolCapabilityCache.get(model)!;
  const info = await showOllamaModel(model);
  const caps = (info as { capabilities?: unknown } | null)?.capabilities;
  const supported = Array.isArray(caps) && caps.includes('tools');
  toolCapabilityCache.set(model, supported);
  return supported;
}

function buildChatSystemPrompt(): string {
  return (
    'You are a helpful assistant. You have access to two tools: ' +
    'web_search(query) to search the web, and fetch_url(url) to read a web page. ' +
    'Use tools ONLY when you need information outside your training data — recent events, ' +
    'specific URLs, or real-time facts. Do NOT call tools for general conversation, ' +
    'coding questions, or topics you already know. ' +
    'When you do use results from tools, cite the source URLs in your final answer.'
  );
}

interface RoundResult {
  text: string;
  toolCalls: ToolCall[];
  metrics: Record<string, number> | null;
}

// One streaming round against /api/chat. Emits ai:chunk/ai:thinking-chunk as tokens arrive.
// Does NOT emit ai:done — the outer loop decides whether this was the final round.
function streamOneRound(
  tabId: string,
  model: string,
  messages: ChatMessage[],
  useTools: boolean,
): Promise<RoundResult> {
  return new Promise((resolve, reject) => {
    const payload: Record<string, unknown> = { model, messages, stream: true, think: true };
    if (useTools) payload.tools = TOOL_SCHEMAS;
    const body = JSON.stringify(payload);

    let text = '';
    const toolCalls: ToolCall[] = [];
    let metrics: Record<string, number> | null = null;

    const req = http.request(
      {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let buffer = '';
        let settled = false;

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const json = JSON.parse(line);
              if (json.message?.thinking) {
                mainWindow.webContents.send('ai:thinking-chunk', tabId, json.message.thinking);
              }
              if (json.message?.content) {
                text += json.message.content;
                mainWindow.webContents.send('ai:chunk', tabId, json.message.content);
              }
              if (Array.isArray(json.message?.tool_calls)) {
                for (const tc of json.message.tool_calls) {
                  if (tc?.function?.name) toolCalls.push(tc as ToolCall);
                }
              }
              if (json.done && !settled) {
                settled = true;
                metrics = {
                  totalDuration: json.total_duration || 0,
                  loadDuration: json.load_duration || 0,
                  promptEvalCount: json.prompt_eval_count || 0,
                  promptEvalDuration: json.prompt_eval_duration || 0,
                  evalCount: json.eval_count || 0,
                  evalDuration: json.eval_duration || 0,
                };
                resolve({ text, toolCalls, metrics });
              }
            } catch {
              // Incomplete JSON line — wait for next chunk
            }
          }
        });

        res.on('end', () => {
          if (!settled) {
            settled = true;
            resolve({ text, toolCalls, metrics });
          }
        });
      },
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function queryChatOllama(tabId: string, prompt: string): Promise<void> {
  const config = resolveConfig();
  const model = config.model;
  const tab = tabs.get(tabId);

  if (!model) {
    mainWindow.webContents.send('ai:error', tabId, 'No model selected. Configure a model in Settings.');
    return;
  }

  const history = tab?.conversationHistory ?? [];
  const rollbackLength = history.length;
  history.push({ role: 'user', content: prompt });

  const maxHistory = tab?.type === 'chat' ? MAX_CHAT_HISTORY_MESSAGES : MAX_HISTORY_MESSAGES;
  while (history.length > maxHistory) {
    history.shift();
  }

  const useTools = config.chat.toolsEnabled && await modelSupportsTools(model);

  try {
    let lastMetrics: Record<string, number> | null = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const messages: ChatMessage[] = useTools
        ? [{ role: 'system', content: buildChatSystemPrompt() }, ...history]
        : [...history];

      const result = await streamOneRound(tabId, model, messages, useTools);
      lastMetrics = result.metrics;

      if (result.toolCalls.length === 0) {
        if (result.text) {
          history.push({ role: 'assistant', content: result.text });
        }
        mainWindow.webContents.send('ai:done', tabId, result.metrics);
        return;
      }

      // Persist the assistant turn (including tool_calls) so the model sees its own request on the next turn
      history.push({
        role: 'assistant',
        content: result.text,
        tool_calls: result.toolCalls,
      });

      // Execute each tool and append its result to history
      for (const call of result.toolCalls) {
        const name = call.function?.name || 'unknown';
        const args = (call.function?.arguments || {}) as Record<string, unknown>;
        mainWindow.webContents.send('ai:tool-call', tabId, name, args);
        const toolResult = await executeTool(name, args);
        history.push({ role: 'tool', content: toolResult, tool_name: name });
        const preview = toolResult.length > 300 ? toolResult.slice(0, 300) + '…' : toolResult;
        mainWindow.webContents.send('ai:tool-result', tabId, name, preview);
      }
    }

    // Safety cap reached — surface as a synthetic tool-result and close out
    mainWindow.webContents.send('ai:tool-result', tabId, 'system', '[aborted: max tool rounds reached]');
    mainWindow.webContents.send('ai:done', tabId, lastMetrics);
  } catch (err) {
    // Roll back to pre-query state so the user can retry cleanly
    history.length = rollbackLength;
    const message = err instanceof Error && err.message.includes('ECONNREFUSED')
      ? `Cannot connect to Ollama at ${OLLAMA_HOST}:${OLLAMA_PORT}. Is Ollama running?`
      : err instanceof Error ? err.message : 'Unknown error';
    mainWindow.webContents.send('ai:error', tabId, message);
  }
}

// --- Model info (POST /api/show) for capabilities and context ---

function showOllamaModel(modelName: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ name: modelName });
    const req = http.request(
      {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/show',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ============================================================
// 4. IPC HANDLERS
// These connect the renderer (UI) to the PTY and AI provider.
// ============================================================

function setupIPC(): void {
  // --- Tab lifecycle ---
  ipcMain.on('tab:create', (_event, tabId: string) => {
    createTab(tabId);
  });

  ipcMain.on('tab:close', (_event, tabId: string) => {
    destroyTab(tabId);
  });

  // --- Chat tab lifecycle ---
  ipcMain.on('tab:create-chat', (_event, tabId: string) => {
    createChatTab(tabId);
  });

  // --- PTY (tab-aware, null-safe for chat tabs) ---
  ipcMain.on('pty:write', (_event, tabId: string, data: string) => {
    tabs.get(tabId)?.shell?.write(data);
  });

  ipcMain.on('pty:resize', (_event, size: { tabId: string; cols: number; rows: number }) => {
    tabs.get(size.tabId)?.shell?.resize(size.cols, size.rows);
  });

  // --- AI (tab-aware) ---
  ipcMain.on('ai:query', (_event, payload: { tabId: string; prompt: string; context: string }) => {
    queryOllama(payload.tabId, payload.prompt, payload.context);
  });

  // --- Chat query (free-form text, no JSON format) ---
  ipcMain.on('chat:query', (_event, payload: { tabId: string; prompt: string }) => {
    queryChatOllama(payload.tabId, payload.prompt);
  });

  // --- Filesystem tab-completion for inline AI prompt (tab-aware) ---
  ipcMain.handle('fs:complete', (_event, tabId: string, partial: string) => {
    const tab = tabs.get(tabId);
    let cwd: string;
    try {
      if (!tab || !tab.shell) throw new Error('tab not found');
      if (os.platform() === 'linux') {
        cwd = fs.readlinkSync(`/proc/${tab.shell.pid}/cwd`);
      } else if (os.platform() === 'darwin') {
        cwd = execSync(`lsof -p ${tab.shell.pid} -Fn | grep '^fcwd$' -A1 | grep '^n' | cut -c2-`,
          { encoding: 'utf-8' }).trim();
        if (!cwd) throw new Error('lsof returned empty');
      } else {
        cwd = process.env.USERPROFILE || process.env.HOME || process.cwd();
      }
    } catch {
      cwd = process.env.HOME || process.env.USERPROFILE || process.cwd();
    }
    const home = os.homedir();
    const expanded = partial.startsWith('~')
      ? partial.replace(/^~/, home)
      : partial;
    const resolved = path.resolve(cwd, expanded);
    const endsWithSep = partial.endsWith('/') || partial.endsWith('\\');
    const dir = endsWithSep ? resolved : path.dirname(resolved);
    const prefix = endsWithSep ? '' : path.basename(expanded);

    try {
      const entries = fs.readdirSync(dir);
      return entries
        .filter((e) => e.startsWith(prefix))
        .map((e) => {
          try {
            return fs.statSync(path.join(dir, e)).isDirectory() ? e + '/' : e;
          } catch {
            return e;
          }
        })
        .sort();
    } catch {
      return [];
    }
  });

  // --- App info ---
  ipcMain.handle('app:get-version', () => app.getVersion());

  // --- Config & Ollama model selection ---
  ipcMain.handle('config:get', () => resolveConfig());

  ipcMain.handle('config:get-theme', () => {
    const config = resolveConfig();
    return loadTheme(config.theme);
  });

  ipcMain.handle('config:open', () => {
    openConfigFile();
  });

  ipcMain.handle('config:save-model', (_event, model: string) => {
    saveConfigKey('model', model);
    return resolveConfig();
  });

  ipcMain.handle('ollama:show-model', async (_event, name: string) => {
    try {
      return await showOllamaModel(name);
    } catch {
      return null;
    }
  });

  ipcMain.handle('ollama:list-models', async () => {
    try {
      return { ok: true, models: await listOllamaModels() };
    } catch (err: unknown) {
      const message = err instanceof Error && err.message.includes('ECONNREFUSED')
        ? `Cannot connect to Ollama at ${OLLAMA_HOST}:${OLLAMA_PORT}. Is it running?`
        : (err instanceof Error ? err.message : 'Unknown error');
      return { ok: false, error: message };
    }
  });
}

// ============================================================
// 5. APP LIFECYCLE
// ============================================================

// Migrate old config.json → config.conf on first run after update
function migrateJsonConfig(): void {
  const oldFile = path.join(CONFIG_DIR, 'config.json');
  try {
    if (!fs.existsSync(oldFile)) return;
    // Only migrate if new .conf doesn't exist yet
    if (fs.existsSync(CONFIG_FILE)) return;
    const old = JSON.parse(fs.readFileSync(oldFile, 'utf-8'));
    if (old.model) saveConfigKey('model', old.model);
    // Leave old file in place — user can delete it manually
  } catch {
    // Migration is best-effort
  }
}

app.whenReady().then(() => {
  migrateJsonConfig();
  createWindow();
  setupIPC();
  // No PTY created here — the renderer requests the first tab via tab:create
});

app.on('window-all-closed', () => {
  for (const [, tab] of tabs) {
    if (tab.shell) tab.shell.kill();
  }
  tabs.clear();
  app.quit();
});
