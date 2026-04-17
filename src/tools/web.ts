// ============================================================
// WEB TOOLS (for chat-mode agent)
//
// Two tools: web_search (DuckDuckGo HTML) and fetch_url (text
// extraction). No external deps — only Node.js stdlib so we can
// ship them in AppImage/pacman/deb/rpm without rebuilding native
// modules. Fragile-by-design: if DuckDuckGo ever breaks, swap
// search() for a SearXNG instance in ~20 lines.
// ============================================================

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 1_000_000;
const MAX_EXTRACTED_CHARS = 5_000;

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
  };
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web via DuckDuckGo. Use for current events, recent facts, or information outside your training data. Returns a numbered list of top results with titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch and extract plain text from a web page URL. Use after web_search when you need the full contents of a page. Only supports http/https public URLs. Returns up to 5000 characters of extracted text.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch (must be http or https)' },
        },
        required: ['url'],
      },
    },
  },
];

// --- Dispatcher: the single entrypoint used by main.ts ---

export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    if (name === 'web_search') {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query.trim()) return 'ERROR: empty query';
      return await webSearch(query);
    }
    if (name === 'fetch_url') {
      const url = typeof args.url === 'string' ? args.url : '';
      if (!url.trim()) return 'ERROR: empty url';
      return await fetchUrl(url);
    }
    return `ERROR: unknown tool "${name}"`;
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// --- web_search ---

async function webSearch(query: string): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await httpGet(url);

  // Titles + href come from <a class="result__a" href="...">title</a>
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  // Snippets come from <a class="result__snippet" ...>...</a>
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const titles: Array<{ url: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) !== null && titles.length < 10) {
    titles.push({ url: decodeDuckRedirect(m[1]), title: stripHtml(m[2]) });
  }

  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null && snippets.length < 10) {
    snippets.push(stripHtml(m[1]));
  }

  if (titles.length === 0) {
    return 'No results found.';
  }

  const top = titles.slice(0, 5);
  const lines: string[] = [];
  top.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (snippets[i]) lines.push(`   ${snippets[i]}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

function decodeDuckRedirect(href: string): string {
  // DuckDuckGo wraps outbound links: //duckduckgo.com/l/?uddg=<encoded>&rut=...
  const match = href.match(/[?&]uddg=([^&]+)/);
  if (match) {
    try { return decodeURIComponent(match[1]); } catch { /* fall through */ }
  }
  if (href.startsWith('//')) return 'https:' + href;
  return href;
}

// --- fetch_url ---

async function fetchUrl(rawUrl: string): Promise<string> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return 'ERROR: invalid URL'; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'ERROR: only http and https URLs are allowed';
  }
  if (isInternalHost(url.hostname)) {
    return 'ERROR: refusing to fetch internal/private host';
  }

  const html = await httpGet(rawUrl);
  return extractText(html);
}

function isInternalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0') return true;
  // IPv4 private ranges
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  // IPv6 loopback / link-local
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

function extractText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  text = stripHtml(text);
  text = text.replace(/[ \t\r\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > MAX_EXTRACTED_CHARS) {
    text = text.slice(0, MAX_EXTRACTED_CHARS) + '\n[... truncated]';
  }
  return text || '(empty page)';
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ''));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

// --- HTTP GET with redirect + timeout + size cap ---

function httpGet(rawUrl: string, redirectsLeft = MAX_REDIRECTS): Promise<string> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try { url = new URL(rawUrl); } catch { return reject(new Error('invalid URL')); }

    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,text/plain,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      },
      (res) => {
        const status = res.statusCode || 0;

        // Follow redirects
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          const nextUrl = new URL(res.headers.location, url).toString();
          httpGet(nextUrl, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${status}`));
        }

        const ct = String(res.headers['content-type'] || '').toLowerCase();
        if (ct && !ct.includes('text/html') && !ct.includes('text/plain') && !ct.includes('application/xhtml')) {
          res.resume();
          return reject(new Error(`unsupported content-type: ${ct}`));
        }

        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) {
            req.destroy(new Error('response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      },
    );

    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error('request timed out'));
    });
    req.on('error', reject);
    req.end();
  });
}
