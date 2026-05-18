# Core Web Vitals Dashboard — Creditável & Neocred

Dashboard em tempo real de LCP, INP e CLS para todos os domínios.

## Por que precisa de um proxy?

A API do Google PageSpeed bloqueia chamadas diretas do browser (CORS).
O `server.js` é um proxy leve (zero dependências, Node puro) que resolve isso.

---

## Opção 1 — Rodar localmente

```bash
node server.js
# Acesse: http://localhost:3000
```

Não precisa instalar nada. Requer Node.js 14+.

---

## Opção 2 — Deploy gratuito no Railway (recomendado para compartilhar)

1. Acesse https://railway.app e crie uma conta
2. Clique em **New Project → Deploy from GitHub** (ou "Empty Project")
3. Faça upload dos arquivos ou conecte o repositório
4. O Railway detecta o `package.json` e sobe automaticamente
5. Vá em **Settings → Networking → Generate Domain**
6. Acesse a URL gerada — o dashboard já funciona

---

## Opção 3 — Deploy gratuito no Render

1. Acesse https://render.com
2. **New → Web Service**
3. Conecte o repositório ou faça upload
4. Build Command: (deixe em branco)
5. Start Command: `node server.js`
6. Acesse a URL gerada

---

## Opção 4 — Deploy no Vercel (serverless)

Adicione um arquivo `api/pagespeed.js`:

```js
const https = require('https');
module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const site = req.query.url;
  const strategy = req.query.strategy || 'mobile';
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(site)}&strategy=${strategy}&category=performance`;
  https.get(apiUrl, (r) => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => { res.setHeader('Content-Type','application/json'); res.end(d); });
  }).on('error', e => { res.status(500).end(JSON.stringify({error: e.message})); });
};
```

E no `index.html`, altere a linha:
```js
const PROXY = 'https://seu-projeto.vercel.app/api';
```

---

## Alterar o proxy no dashboard

No `index.html`, linha 1 do `<script>`:
```js
const PROXY = 'http://localhost:3000'; // ← altere para sua URL de produção
```
