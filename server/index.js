import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN || '';

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

app.listen(PORT, () => {
  console.log(`Webflow proxy listening on port ${PORT}`);
});
