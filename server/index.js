import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN || '';
const WEBFLOW_SITE_ID = process.env.WEBFLOW_SITE_ID || '';

if (!WEBFLOW_TOKEN) {
  console.warn('WEBFLOW_TOKEN is not set. /dom requests will fail.');
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/dom', async (req, res) => {
  try {
    if (!WEBFLOW_TOKEN) {
      return res.status(500).json({ error: 'WEBFLOW_TOKEN is not set on the server.' });
    }

    const pageId = req.query.pageId;
    if (!pageId) {
      return res.status(400).json({ error: 'Missing pageId query parameter.' });
    }

    const url = `https://api.webflow.com/v2/pages/${encodeURIComponent(pageId)}/dom`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${WEBFLOW_TOKEN}`,
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
    if (!WEBFLOW_TOKEN) {
      return res.status(500).json({ error: 'WEBFLOW_TOKEN is not set on the server.' });
    }

    const sitesResp = await fetch('https://api.webflow.com/v2/sites', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${WEBFLOW_TOKEN}`,
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
    if (!WEBFLOW_TOKEN) {
      return res.status(500).json({ error: 'WEBFLOW_TOKEN is not set on the server.' });
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
          Authorization: `Bearer ${WEBFLOW_TOKEN}`,
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
        Authorization: `Bearer ${WEBFLOW_TOKEN}`,
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
