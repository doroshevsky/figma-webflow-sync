import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN || '';
const WEBFLOW_CLIENT_ID = process.env.WEBFLOW_CLIENT_ID || '';
const WEBFLOW_CLIENT_SECRET = process.env.WEBFLOW_CLIENT_SECRET || '';
const WEBFLOW_REDIRECT_URI = process.env.WEBFLOW_REDIRECT_URI || '';
const WEBFLOW_SITE_ID = process.env.WEBFLOW_SITE_ID || '';

const TOKEN_FILE = path.join(process.cwd(), 'token.json');

function loadTokenFromDisk() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveTokenToDisk(tokenData) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
  } catch (err) {
    console.warn('Failed to persist token:', err.message);
  }
}

let oauthToken = loadTokenFromDisk();

function getAccessToken() {
  if (oauthToken && oauthToken.access_token) return oauthToken.access_token;
  if (WEBFLOW_TOKEN) return WEBFLOW_TOKEN;
  return '';
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/auth/status', (req, res) => {
  const token = getAccessToken();
  res.json({ authorized: !!token, source: oauthToken ? 'oauth' : WEBFLOW_TOKEN ? 'env' : 'none' });
});

app.get('/auth/start', (req, res) => {
  if (!WEBFLOW_CLIENT_ID || !WEBFLOW_REDIRECT_URI) {
    return res.status(500).send('Missing WEBFLOW_CLIENT_ID or WEBFLOW_REDIRECT_URI.');
  }

  const authUrl =
    'https://webflow.com/oauth/authorize' +
    `?client_id=${encodeURIComponent(WEBFLOW_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(WEBFLOW_REDIRECT_URI)}` +
    '&response_type=code' +
    '&scope=sites:read+pages:read';

  return res.redirect(authUrl);
});

app.get('/auth/reset', (req, res) => {
  try {
    oauthToken = null;
    if (fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE);
    }
    return res.send('OAuth token cleared. Please re-authorize.');
  } catch (err) {
    return res.status(500).send(err.message || 'Failed to clear token.');
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code.');

    if (!WEBFLOW_CLIENT_ID || !WEBFLOW_CLIENT_SECRET || !WEBFLOW_REDIRECT_URI) {
      return res.status(500).send('Missing OAuth env vars.');
    }

    const tokenResp = await fetch('https://api.webflow.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: WEBFLOW_CLIENT_ID,
        client_secret: WEBFLOW_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: WEBFLOW_REDIRECT_URI,
      }),
    });

    const tokenText = await tokenResp.text();
    if (!tokenResp.ok) {
      return res.status(tokenResp.status).send(tokenText);
    }

    oauthToken = JSON.parse(tokenText);
    saveTokenToDisk(oauthToken);

    return res.send('Webflow connected. You can close this tab and return to Figma.');
  } catch (err) {
    return res.status(500).send(err.message || 'OAuth error');
  }
});

app.get('/dom', async (req, res) => {
  try {
    const token = getAccessToken();
    if (!token) {
      return res.status(401).json({ error: 'Not authorized. Use /auth/start to connect Webflow.' });
    }

    const pageId = req.query.pageId;
    if (!pageId) {
      return res.status(400).json({ error: 'Missing pageId query parameter.' });
    }

    const url = `https://api.webflow.com/v2/pages/${encodeURIComponent(pageId)}/dom`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });

    const text = await resp.text();
    if (!resp.ok) {
      return res.status(resp.status).send(text);
    }

    res.setHeader('Content-Type', 'application/json');
    res.send(text);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

app.get('/sites', async (req, res) => {
  try {
    const token = getAccessToken();
    if (!token) {
      return res.status(401).json({ error: 'Not authorized. Use /auth/start to connect Webflow.' });
    }

    const sitesResp = await fetch('https://api.webflow.com/v2/sites', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    const sitesText = await sitesResp.text();
    if (!sitesResp.ok) {
      return res.status(sitesResp.status).send(sitesText);
    }

    const sites = JSON.parse(sitesText).sites || [];
    return res.json({
      count: sites.length,
      sites: sites.map((s) => ({ id: s.id, shortName: s.shortName, displayName: s.displayName })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

app.get('/resolve', async (req, res) => {
  try {
    const token = getAccessToken();
    if (!token) {
      return res.status(401).json({ error: 'Not authorized. Use /auth/start to connect Webflow.' });
    }

    const rawUrl = req.query.url;
    if (!rawUrl) {
      return res.status(400).json({ error: 'Missing url query parameter.' });
    }

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return res.status(400).json({ error: 'Invalid URL.' });
    }

    const path = parsed.pathname && parsed.pathname !== '' ? parsed.pathname : '/';

    let siteId = WEBFLOW_SITE_ID;
    const host = parsed.host || '';
    const subdomain = host.endsWith('.webflow.io')
      ? host.replace('.webflow.io', '')
      : null;

    if (!siteId) {
      const sitesResp = await fetch('https://api.webflow.com/v2/sites', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });
      const sitesText = await sitesResp.text();
      if (!sitesResp.ok) {
        return res.status(sitesResp.status).send(sitesText);
      }
      const sites = JSON.parse(sitesText).sites || [];
      if (!sites.length) return res.status(404).json({ error: 'No sites found.' });

      if (subdomain) {
        const matchSite = sites.find((s) => s.shortName === subdomain);
        if (matchSite) {
          siteId = matchSite.id;
        }
      }

      if (!siteId) {
        siteId = sites[0].id;
      }
    }

    const pagesResp = await fetch(`https://api.webflow.com/v2/sites/${siteId}/pages`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    const pagesText = await pagesResp.text();
    if (!pagesResp.ok) {
      return res.status(pagesResp.status).send(pagesText);
    }
    const pages = JSON.parse(pagesText).pages || [];

    const normalizedPath = path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path;
    const match = pages.find((p) => {
      const pPath = p.publishedPath || '/';
      const norm = pPath.endsWith('/') && pPath !== '/' ? pPath.slice(0, -1) : pPath;
      return norm === normalizedPath;
    });

    if (!match) {
      return res.status(404).json({ error: 'Page not found for URL path.', path: normalizedPath });
    }

    return res.json({ pageId: match.id, siteId });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Webflow proxy listening on port ${PORT}`);
});
