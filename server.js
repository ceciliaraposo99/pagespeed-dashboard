const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.PAGESPEED_API_KEY || 'AIzaSyAKVkXSDdbVt7nF4CNysCr0xtxmMRYt90k';

const SHEETS = [
  { company: 'Creditável', spreadsheetId: '17CrjCrPVw2CZ1iC10_S-eOZnnjcblyA8O6PPXD6NQoI', gid: '847864582', ranges: ['D15:E15','D29:E29','D43:E43','D56:E56'] },
  { company: 'Neocred',    spreadsheetId: '1tIl6N1kJv4JGhr_GhwFFEUUD4B0MljOMIMfsITboRbg', gid: '1035220480', ranges: ['D15:E15','D29:E29'] }
];

// ── Cache ──────────────────────────────────────────────
const psCache   = new Map(); // url -> { data, ts }
const urlsCache = { data: null, ts: 0 };
const PS_TTL    = 15 * 60 * 1000; // 15 min
const URLS_TTL  =  5 * 60 * 1000; //  5 min

// ── Slack alerts ──────────────────────────────────────
const SLACK_TOKEN    = process.env.SLACK_TOKEN || '';
const SLACK_CHANNEL  = 'C0B6HAU1664'; // #core-vitals-alert
const alertedToday   = new Set(); // avoid duplicate alerts per URL per day

function slackAlert(url, metrics) {
  if (!SLACK_TOKEN) return;

  // Check thresholds: LCP > 4s or INP > 500ms
  const issues = [];
  if (metrics.lcp  != null && metrics.lcp  > 4)   issues.push(`🐌 *LCP:* ${metrics.lcp}s _(limite: 4s)_`);
  if (metrics.inp  != null && metrics.inp  > 500)  issues.push(`🖱️ *INP:* ${metrics.inp}ms _(limite: 500ms)_`);
  if (!issues.length) return;

  // Deduplicate: one alert per URL per calendar day
  const todayKey = url + '|' + new Date().toISOString().slice(0,10);
  if (alertedToday.has(todayKey)) return;
  alertedToday.add(todayKey);
  setTimeout(() => alertedToday.delete(todayKey), 24*60*60*1000);

  const score     = metrics.score != null ? metrics.score : '–';
  const scoreEmoji = metrics.score >= 90 ? '🟢' : metrics.score >= 50 ? '🟡' : '🔴';
  const message = [
    `${scoreEmoji} *Alerta Core Web Vitals* — score ${score}`,
    `🔗 <https://${url.replace(/^https?:\/\//, '')}|${url.replace(/^https?:\/\//, '')}>`,
    '',
    issues.join('\n'),
    '',
    `_Detectado em ${new Date().toLocaleString('pt-BR', {timeZone:'America/Recife'})}_`
  ].join('\n');

  const body = JSON.stringify({ channel: SLACK_CHANNEL, text: message });
  const opts = {
    hostname: 'slack.com',
    path: '/api/chat.postMessage',
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + SLACK_TOKEN,
      'Content-Length': Buffer.byteLength(body)
    }
  };
  const req = https.request(opts, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => {
      const r = JSON.parse(d);
      if (!r.ok) console.error('[slack] error:', r.error);
      else console.log('[slack] alert sent for', url);
    });
  });
  req.on('error', e => console.error('[slack] request error:', e.message));
  req.write(body); req.end();
}

// ── HTTP helpers ───────────────────────────────────────
function httpsGetRaw(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpsGetRaw(res.headers.location).then(resolve).catch(reject);
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function httpsGetJSON(url) {
  return httpsGetRaw(url).then(d => JSON.parse(d));
}

// ── Parse URLs from CSV cell ───────────────────────────
function parseUrls(text) {
  const matches = text.match(/https?:\/\/[^\s",\\]+/g) || [];
  return [...new Set(matches.map(u => u.replace(/\/*$/, '')))];
}

// ── Fetch active URLs from Sheets ─────────────────────
async function fetchActiveUrls() {
  if (urlsCache.data && Date.now() - urlsCache.ts < URLS_TTL) return urlsCache.data;
  const result = [];
  for (const sheet of SHEETS) {
    const squads = [];
    for (const range of sheet.ranges) {
      const url = `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/export?format=csv&gid=${sheet.gid}&range=${range}`;
      try {
        const csv   = await httpsGetRaw(url);
        const label = csv.split(',')[0].replace(/^"|"$/g, '').trim() || range;
        const urls  = parseUrls(csv);
        if (urls.length) squads.push({ squad: label, urls });
      } catch(e) { squads.push({ squad: range, urls: [], error: e.message }); }
    }
    result.push({ company: sheet.company, squads });
  }
  urlsCache.data = result; urlsCache.ts = Date.now();
  return result;
}

// ── Fetch PageSpeed (with retry) ──────────────────────
function fetchPS(site, strategy, attempt) {
  return new Promise((resolve, reject) => {
    const url = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(site)}&strategy=${strategy}&category=performance&key=${API_KEY}`;
    httpsGetJSON(url).then(parsed => {
      const hasError = parsed.error || parsed.lighthouseResult?.runtimeError?.code;
      if (hasError && attempt < 3)
        setTimeout(() => fetchPS(site, strategy, attempt+1).then(resolve).catch(reject), attempt * 2000);
      else resolve(parsed);
    }).catch(e => {
      if (attempt < 3) setTimeout(() => fetchPS(site, strategy, attempt+1).then(resolve).catch(reject), attempt * 2000);
      else reject(e);
    });
  });
}

// ── Extract metrics from PageSpeed response ───────────
function extractMetrics(d) {
  // Use CrUX field data (real user experience, last 28 days)
  // This matches what pagespeed.web.dev shows in the "field data" section
  const field  = d.loadingExperience?.metrics;
  const origin = d.originLoadingExperience?.metrics;
  const pick   = k => {
    const m = field?.[k] || origin?.[k];
    return m?.percentile ?? null;
  };

  // Score from Lighthouse (no CrUX equivalent)
  const cats  = d.lighthouseResult?.categories;
  const score = cats?.performance?.score != null
    ? Math.round(cats.performance.score * 100) : null;

  const lcpMs  = pick('LARGEST_CONTENTFUL_PAINT_MS');
  const inp    = pick('INTERACTION_TO_NEXT_PAINT');
  const clsRaw = pick('CUMULATIVE_LAYOUT_SHIFT_SCORE');

  // If no CrUX data available, fall back to Lighthouse lab data
  const audits  = d.lighthouseResult?.audits;
  const lcpLab  = audits?.['largest-contentful-paint']?.numericValue;
  const inpLab  = audits?.['interaction-to-next-paint']?.numericValue
               ?? audits?.['total-blocking-time']?.numericValue;
  const clsLab  = audits?.['cumulative-layout-shift']?.numericValue;

  const lcp = lcpMs  != null ? +(lcpMs  / 1000).toFixed(2)
            : lcpLab != null ? +(lcpLab / 1000).toFixed(2) : null;
  const inpV= inp    != null ? Math.round(inp)
            : inpLab != null ? Math.round(inpLab)           : null;
  const cls = clsRaw != null ? +(clsRaw / 100).toFixed(3)
            : clsLab != null ? +clsLab.toFixed(3)           : null;

  return {
    score,
    lcp,
    inp: inpV,
    cls,
    source: lcpMs != null ? 'crux' : 'lighthouse',
    error: d.error?.message || d.lighthouseResult?.runtimeError?.message || null
  };
}

// ── Background pre-fetch all active URLs ──────────────
async function prefetchAll() {
  console.log('[prefetch] starting…');
  let urls_sheet;
  try { urls_sheet = await fetchActiveUrls(); } catch(e) { console.error('[prefetch] sheets error', e.message); return; }
  const all = [];
  urls_sheet.forEach(g => g.squads.forEach(s => s.urls.forEach(u => all.push(u))));
  for (const url of all) {
    const key = url + '|mobile';
    if (psCache.has(key) && Date.now() - psCache.get(key).ts < PS_TTL) continue;
    try {
      console.log('[prefetch]', url);
      const data = await fetchPS(url, 'mobile', 1);
      const m = extractMetrics(data);
      psCache.set(key, { data: m, ts: Date.now() });
      slackAlert(url, m);
    } catch(e) { console.error('[prefetch] error', url, e.message); }
  }
  console.log('[prefetch] done — cached', psCache.size, 'URLs');
}

// Run once at startup, then every 15 min
prefetchAll();
setInterval(prefetchAll, PS_TTL);

// ── HTTP Server ───────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const u = new URL(req.url, `http://localhost:${PORT}`);

  // GET /active-urls — returns squads + pre-fetched metrics
  if (u.pathname === '/active-urls') {
    fetchActiveUrls().then(groups => {
      const result = groups.map(g => ({
        company: g.company,
        squads: g.squads.map(s => ({
          squad: s.squad,
          urls: s.urls.map(url => {
            const key    = url + '|mobile';
            const cached = psCache.get(key);
            return { url, metrics: cached ? cached.data : null };
          })
        }))
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  // GET /pagespeed?url=...&strategy=mobile — individual lookup (domínios tab)
  if (u.pathname === '/pagespeed') {
    const site     = u.searchParams.get('url');
    const strategy = u.searchParams.get('strategy') || 'mobile';
    if (!site) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing url' })); return; }
    const key    = site + '|' + strategy;
    const cached = psCache.get(key);
    if (cached && Date.now() - cached.ts < PS_TTL) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(JSON.stringify(cached.data)); return;
    }
    fetchPS(site, strategy, 1).then(data => {
      const metrics = extractMetrics(data);
      psCache.set(key, { data: metrics, ts: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
      res.end(JSON.stringify(metrics));
    }).catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    return;
  }

  // GET /cache-status — debug
  if (u.pathname === '/cache-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cached_urls: psCache.size, urls_cache_age_s: Math.round((Date.now()-urlsCache.ts)/1000) }));
    return;
  }

  // Serve dashboard
  if (u.pathname === '/' || u.pathname === '/index.html') {
    const fs = require('fs');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(__dirname + '/index.html', 'utf8'));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`✅ Proxy on :${PORT}`));
