const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.PAGESPEED_API_KEY || 'AIzaSyAKVkXSDdbVt7nF4CNysCr0xtxmMRYt90k';

// Planilhas e intervalos de URLs ativas
const SHEETS = [
  {
    company: 'Creditável',
    spreadsheetId: '17CrjCrPVw2CZ1iC10_S-eOZnnjcblyA8O6PPXD6NQoI',
    gid: '847864582',
    ranges: ['D15:E15', 'D29:E29', 'D43:E43', 'D56:E56']
  },
  {
    company: 'Neocred',
    spreadsheetId: '1tIl6N1kJv4JGhr_GhwFFEUUD4B0MljOMIMfsITboRbg',
    gid: '1638901989',
    ranges: ['D15:E15', 'D29:E29']
  }
];

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error: ' + data.slice(0, 100))); }
      });
    }).on('error', reject);
  });
}

function httpsGetRaw(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGetRaw(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseUrls(cellValue) {
  if (!cellValue) return [];
  // Extrai todas as URLs http/https da célula
  const matches = cellValue.match(/https?:\/\/[^\s\]]+/g) || [];
  return [...new Set(matches.map(u => u.replace(/\/+$/, '').trim()))];
}

async function fetchActiveUrls() {
  const result = [];

  for (const sheet of SHEETS) {
    const squads = [];

    for (const range of sheet.ranges) {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheet.spreadsheetId}/values/${range}?key=${API_KEY}&majorDimension=ROWS&ranges=${range}&includeGridData=false`;
      // Use gid-based export to get correct sheet
      const exportUrl = `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/export?format=csv&gid=${sheet.gid}&range=${range}&key=${API_KEY}`;
      try {
        const csvData = await httpsGetRaw(exportUrl);
        // CSV: first col = label, second col = urls (may be multiline in quotes)
        const label = csvData.split(',')[0].replace(/^"|"$/g, '').trim() || range;
        // Extract all URLs from the CSV content
        const urls = parseUrls(csvData);
        if (urls.length > 0) {
          squads.push({ squad: label, urls });
        }
      } catch(e) {
        squads.push({ squad: range, urls: [], error: e.message });
      }
    }

    result.push({ company: sheet.company, squads });
  }

  return result;
}

function fetchPageSpeed(site, strategy, attempt, callback) {
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(site)}&strategy=${strategy}&category=performance&key=${API_KEY}`;
  https.get(apiUrl, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        const hasError = parsed.error || parsed.lighthouseResult?.runtimeError?.code;
        if (hasError && attempt < 3) {
          setTimeout(() => fetchPageSpeed(site, strategy, attempt + 1, callback), attempt * 2000);
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


  // Rota: debug — ver resposta bruta da Sheets API
  if (urlObj.pathname === '/debug-sheets') {
    const sheetId = urlObj.searchParams.get('id') || '17CrjCrPVw2CZ1iC10_S-eOZnnjcblyA8O6PPXD6NQoI';
    const range = urlObj.searchParams.get('range') || 'D15:E15';
    const sheetName = urlObj.searchParams.get('sheet') || 'URL_BALANCER atualizado';
    // Use CSV export with gid — avoids sheet name encoding issues
    const gid = urlObj.searchParams.get('gid') || '847864582';
    const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}&range=${range}`;
    httpsGetRaw(exportUrl)
      .then(csv => {
        const urls = parseUrls(csv);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url_called: exportUrl, csv_preview: csv.slice(0, 500), urls_found: urls }, null, 2));
      })
      .catch(e => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message, url_called: exportUrl }));
      });
    return;
  }

  // Rota: dados PageSpeed
  if (urlObj.pathname === '/pagespeed') {
    const site = urlObj.searchParams.get('url');
    const strategy = urlObj.searchParams.get('strategy') || 'mobile';
    if (!site) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing url param' })); return; }
    fetchPageSpeed(site, strategy, 1, (err, data) => {
      if (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); }
      else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(data); }
    });
    return;
  }

  // Rota: URLs ativas das planilhas
  if (urlObj.pathname === '/active-urls') {
    fetchActiveUrls()
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      })
      .catch(e => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }

  // Rota: servir o dashboard
  if (urlObj.pathname === '/' || urlObj.pathname === '/index.html') {
    const fs = require('fs');
    const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`✅ Proxy rodando na porta ${PORT}`);
  console.log(`   /pagespeed    → PageSpeed Insights`);
  console.log(`   /active-urls  → URLs ativas das planilhas`);
});
