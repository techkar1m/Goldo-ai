/**
 * Goldo — static site server.
 *
 * Zero dependencies on purpose: Railway's Nixpacks builder needs nothing but
 * Node, so a deploy is a git push with no install step to break.
 *
 * Serves ./public with clean URLs (/method -> public/method.html), gzip for
 * text assets, conditional requests, a real 404 page and the security headers
 * the Botpress webchat needs to keep working.
 */

'use strict';

const http = require('http');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, 'public');

// Botpress serves the webchat bundle, the bot config and the runtime socket
// from these hosts. If the widget ever stops rendering after a Botpress
// upgrade, set DISABLE_CSP=1 on Railway to rule the policy in or out.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.botpress.cloud https://files.bpcontent.cloud",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.botpress.cloud",
  "font-src 'self' data: https://fonts.gstatic.com https://cdn.botpress.cloud",
  "img-src 'self' data: blob: https:",
  "media-src 'self' https://*.botpress.cloud",
  "connect-src 'self' https://*.botpress.cloud https://*.bpcontent.cloud wss://*.botpress.cloud",
  "frame-src 'self' https://*.botpress.cloud",
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
  '.csv': 'text/csv; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const COMPRESSIBLE = /^(text\/|application\/(json|xml|manifest\+json)|image\/svg)/;

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (process.env.DISABLE_CSP !== '1') res.setHeader('Content-Security-Policy', CSP);
  // Railway terminates TLS in front of us, so HSTS is safe to advertise.
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function cacheControl(ext, pathname) {
  if (ext === '.html' || pathname === '/sitemap.xml' || pathname === '/robots.txt') {
    return 'public, max-age=0, must-revalidate';
  }
  if (ext === '.css' || ext === '.js' || ext === '.svg' || ext === '.woff2') {
    return 'public, max-age=3600, stale-while-revalidate=86400';
  }
  return 'public, max-age=86400';
}

/**
 * Map a URL path to a file inside ROOT, or null if it escapes the root.
 * Tries, in order: the exact file, path + ".html", path + "/index.html".
 */
async function resolveFile(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (rel.includes('\0')) return null;

  const target = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  // path.normalize collapses "..", but re-check that we never left ROOT.
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (target !== ROOT && !target.startsWith(rootWithSep)) return null;

  const candidates = rel.endsWith('/')
    ? [path.join(target, 'index.html')]
    : [target, target + '.html', path.join(target, 'index.html')];

  for (const candidate of candidates) {
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) return { file: candidate, stat };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function etagFor(stat) {
  return `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
}

function send(req, res, status, body, headers = {}) {
  securityHeaders(res);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

  const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const type = String(headers['Content-Type'] || '');

  if (wantsGzip && COMPRESSIBLE.test(type) && body.length > 1024) {
    const gz = zlib.gzipSync(body);
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Content-Length', gz.length);
    res.writeHead(status);
    return res.end(req.method === 'HEAD' ? undefined : gz);
  }

  res.setHeader('Content-Length', body.length);
  res.writeHead(status);
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function sendErrorPage(req, res, status, fallbackText) {
  const page = path.join(ROOT, `${status}.html`);
  try {
    const body = await fsp.readFile(page);
    return send(req, res, status, body, {
      'Content-Type': MIME['.html'],
      'Cache-Control': 'no-store',
    });
  } catch {
    return send(req, res, status, Buffer.from(fallbackText), {
      'Content-Type': MIME['.txt'],
      'Cache-Control': 'no-store',
    });
  }
}

const server = http.createServer(async (req, res) => {
  const started = process.hrtime.bigint();

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (process.env.QUIET_LOGS !== '1') {
      console.log(`${req.method} ${req.url} ${res.statusCode} ${ms.toFixed(1)}ms`);
    }
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(req, res, 405, Buffer.from('Method Not Allowed'), {
      'Content-Type': MIME['.txt'],
      Allow: 'GET, HEAD',
    });
  }

  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return sendErrorPage(req, res, 400, 'Bad Request');
  }

  // Railway's healthcheck target. Kept dependency-free and uncached.
  if (pathname === '/healthz') {
    const body = Buffer.from(
      JSON.stringify({ status: 'ok', uptime: Math.round(process.uptime()), version: 1 })
    );
    return send(req, res, 200, body, {
      'Content-Type': MIME['.json'],
      'Cache-Control': 'no-store',
    });
  }

  // Canonicalise: strip the .html suffix so every page has one URL.
  if (pathname.endsWith('.html') && pathname !== '/index.html') {
    securityHeaders(res);
    res.writeHead(301, { Location: pathname.slice(0, -5) });
    return res.end();
  }
  if (pathname === '/index.html') {
    securityHeaders(res);
    res.writeHead(301, { Location: '/' });
    return res.end();
  }
  // Trailing slashes on real pages, e.g. /method/ -> /method
  if (pathname.length > 1 && pathname.endsWith('/')) {
    const trimmed = pathname.replace(/\/+$/, '');
    if (await resolveFile(trimmed)) {
      securityHeaders(res);
      res.writeHead(301, { Location: trimmed });
      return res.end();
    }
  }

  const found = await resolveFile(pathname);
  if (!found) return sendErrorPage(req, res, 404, 'Not Found');

  const ext = path.extname(found.file).toLowerCase();
  const etag = etagFor(found.stat);

  if (req.headers['if-none-match'] === etag) {
    securityHeaders(res);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', cacheControl(ext, pathname));
    res.writeHead(304);
    return res.end();
  }

  let body;
  try {
    body = await fsp.readFile(found.file);
  } catch (err) {
    console.error('read failed', found.file, err.message);
    return sendErrorPage(req, res, 500, 'Internal Server Error');
  }

  return send(req, res, 200, body, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cacheControl(ext, pathname),
    ETag: etag,
    'Last-Modified': found.stat.mtime.toUTCString(),
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Goldo site listening on http://${HOST}:${PORT} (serving ${ROOT})`);
});

// Railway sends SIGTERM on redeploy; drain in-flight requests before exiting.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

module.exports = server;
