const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.PAGESPEED_API_KEY || 'AIzaSyAKVkXSDdbVt7nF4CNysCr0xtxmMRYt90k';

function fetchPageSpeed(site, strategy, attempt, callback) {
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(site)}&strategy=${strategy}&category=performance&key=${API_KEY}`;
  https.get(apiUrl, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        const hasError = parsed.error || parsed.lighthouseResult?.runtimeError?.code;
        const isRetryable = hasError && attempt < 3;
        if (isRetryable) {
          const delay = attempt * 2000;
          setTimeout(() => fetchPageSpeed(site, strategy, attempt + 1, callback), delay);
        } else {
          callback(null, data);
        }
      } catch(e) {
        if (attempt < 3) {
          setTimeout(() => fetchPageSpeed(site, strategy, attempt + 1, callback), attempt * 2000);
        } else {
          callback(e, null);
        }
      }
    });
  }).on('error', (e) => {
    if (attempt < 3) {
      setTimeout(() => fetchPageSpeed(site, strategy, attempt + 1, callback), attempt * 2000);
    } else {
      callback(e, null);
    }
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const urlObj = new URL(req.url, `http://localhost:${PORT}`);

  if (urlObj.pathname === '/pagespeed') {
    const site = urlObj.searchParams.get('url');
    const strategy = urlObj.searchParams.get('strategy') || 'mobile';
    if (!site) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing url param' })); return; }

    fetchPageSpeed(site, strategy, 1, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(data);
      }
    });
    return;
  }

  if (urlObj.pathname === '/' || urlObj.pathname === '/index.html') {
    const fs = require('fs');
    const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`✅ PageSpeed proxy rodando na porta ${PORT}`);
});
