// ============================================================
// ELECTRON MAIN PROCESS
// Responsibilities:
//   1. Create the app window
//   2. Manage the PTY (shell) via node-pty
//   3. Handle AI queries (Ollama HTTP) and stream responses
//   4. Bridge everything to the renderer via IPC
// ============================================================

import { app, BrowserWindow, ipcMain, Menu, clipboard } from 'electron';
import * as pty from 'node-pty';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as http from 'http';
import { execSync } from 'child_process';

let mainWindow: BrowserWindow;
let shell: pty.IPty;

// Conversation history for Ollama multi-turn context
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
const conversationHistory: ChatMessage[] = [];
const MAX_HISTORY_MESSAGES = 20; // 10 exchanges (user + assistant pairs)

// ============================================================
// CONFIG
// Persists user settings (selected model, etc.) to disk.
// Location: ~/.config/open-os-cli/config.json
// ============================================================

const CONFIG_DIR = path.join(os.homedir(), '.config', 'open-os-cli');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

interface AppConfig {
  model?: string;
}

function loadConfig(): AppConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveConfig(config: AppConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
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

  // Intercept Ctrl+Space at Electron level — before xterm.js can swallow it
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.control && input.code === 'Space' && input.type === 'keyDown') {
      _event.preventDefault();
      mainWindow.webContents.send('toggle-ai-panel');
    }
  });

  // Right-click context menu
  mainWindow.webContents.on('context-menu', () => {
    const menu = Menu.buildFromTemplate([
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
    ]);
    menu.popup({ window: mainWindow });
  });
}

// ============================================================
// 2. PTY (terminal shell)
// node-pty spawns a real shell (bash/zsh/fish) in a PTY.
// We pipe data between the PTY and the renderer (xterm.js).
// ============================================================

function createPty(): void {
  const isWin = os.platform() === 'win32';
  const defaultShell = isWin ? 'powershell.exe' : process.env.SHELL || 'bash';
  const shellArgs = isWin ? ['-NoLogo'] : [];

  shell = pty.spawn(defaultShell, shellArgs, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: os.homedir() || process.cwd(),
    env: process.env as { [key: string]: string },
  });

  // PTY output → renderer (xterm.js will display it)
  shell.onData((data: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', data);
    }
  });

  shell.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', exitCode);
    }
  });
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

function queryOllama(prompt: string, context: string): void {
  const config = loadConfig();
  const model = config.model;

  if (!model) {
    mainWindow.webContents.send('ai:error', 'No model selected. Press Ctrl+Space to configure.');
    return;
  }

  // Build user message and add to conversation history
  const userContent = context
    ? `Terminal context:\n\`\`\`\n${context}\n\`\`\`\n\n${prompt}`
    : prompt;

  conversationHistory.push({ role: 'user', content: userContent });

  // Trim oldest messages to stay within budget
  while (conversationHistory.length > MAX_HISTORY_MESSAGES) {
    conversationHistory.shift();
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...conversationHistory,
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
              mainWindow.webContents.send('ai:chunk', json.message.content);
            }
            if (json.done && !doneSent) {
              doneSent = true;
              if (currentAssistantResponse) {
                conversationHistory.push({ role: 'assistant', content: currentAssistantResponse });
              }
              mainWindow.webContents.send('ai:done');
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
            conversationHistory.push({ role: 'assistant', content: currentAssistantResponse });
          }
          mainWindow.webContents.send('ai:done');
        }
      });
    },
  );

  req.on('error', (err: Error) => {
    // Roll back the user message since the request failed
    const lastIdx = conversationHistory.length - 1;
    if (lastIdx >= 0 && conversationHistory[lastIdx].role === 'user') {
      conversationHistory.pop();
    }

    const message =
      err.message.includes('ECONNREFUSED')
        ? `Cannot connect to Ollama at ${OLLAMA_HOST}:${OLLAMA_PORT}. Is Ollama running?`
        : err.message;
    mainWindow.webContents.send('ai:error', message);
  });

  req.write(body);
  req.end();
}

// ============================================================
// 4. IPC HANDLERS
// These connect the renderer (UI) to the PTY and AI provider.
// ============================================================

function setupIPC(): void {
  // --- PTY ---
  ipcMain.on('pty:write', (_event, data: string) => {
    shell.write(data);
  });

  ipcMain.on('pty:resize', (_event, size: { cols: number; rows: number }) => {
    shell.resize(size.cols, size.rows);
  });

  // --- AI ---
  ipcMain.on('ai:query', (_event, payload: { prompt: string; context: string }) => {
    queryOllama(payload.prompt, payload.context);
  });

  // --- Filesystem tab-completion for inline AI prompt ---
  ipcMain.handle('fs:complete', (_event, partial: string) => {
    let cwd: string;
    try {
      if (os.platform() === 'linux') {
        cwd = fs.readlinkSync(`/proc/${shell.pid}/cwd`);
      } else if (os.platform() === 'darwin') {
        cwd = execSync(`lsof -p ${shell.pid} -Fn | grep '^fcwd$' -A1 | grep '^n' | cut -c2-`,
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
  ipcMain.handle('config:get', () => loadConfig());

  ipcMain.handle('config:save-model', (_event, model: string) => {
    const config = loadConfig();
    config.model = model;
    saveConfig(config);
    return config;
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

app.whenReady().then(() => {
  createWindow();
  createPty();
  setupIPC();
});

app.on('window-all-closed', () => {
  shell?.kill();
  app.quit();
});
