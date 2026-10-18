// Local test server. Mimics what Vercel does: serves public/ and runs api/*.js.
// Not used on Vercel. Run with: npm start
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    const file = path.join(__dirname, url.pathname + '.js');
    if (!file.startsWith(path.join(__dirname, 'api')) || !fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{"error":"not found"}');
    }
    req.query = Object.fromEntries(url.searchParams);
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
    try { return await require(file)(req, res); }
    catch (e) { console.error(e); res.statusCode = 500; return res.end('{"error":"server error"}'); }
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(__dirname, 'public', rel);
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file)) {
    res.statusCode = 404; return res.end('Not found');
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log('Dashboard on http://localhost:' + PORT));
