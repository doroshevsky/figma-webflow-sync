// Webflow -> Figma sync (MVP)
// TODO: Fill in BACKEND_URL.
// TODO: Define section/component mapping and data-figma-key attributes in Webflow.

const BACKEND_URL = "https://figma-webflow-sync.onrender.com"; // Render backend base URL

// Attribute names in Webflow
const FIGMA_KEY_ATTR = "data-figma-key";
const FIGMA_SECTION_ATTR = "data-figma-section";

// Optional: map section names to component keys from a Figma library
const SECTION_COMPONENT_KEYS = {
  "Navbar 1": "8379df5a56dd95897cd33df2cca17fd7c27ec9d0",
  "Navbar 2": "bd0854c2bdc1d14d9f293771d9cd52ccf95cd3ca",
};

const STACK_GAP = 120; // px between sections when reordering
const REBUILD_SECTIONS = true; // when true, remove existing sections and re-import

figma.showUI(__html__, { width: 260, height: 120 });

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'init') {
    if (!BACKEND_URL || BACKEND_URL.indexOf('YOUR-RENDER-URL') !== -1) {
      figma.ui.postMessage({ type: 'auth-status', authorized: false });
      figma.ui.postMessage({ type: 'status', message: 'Set BACKEND_URL in code.js' });
      return;
    }
    try {
      const authorized = await checkAuthorized(BACKEND_URL);
      figma.ui.postMessage({ type: 'auth-status', authorized });
    } catch (err) {
      figma.ui.postMessage({ type: 'auth-status', authorized: false });
    }
    return;
  }

  if (msg.type === 'connect') {
    if (!BACKEND_URL || BACKEND_URL.indexOf('YOUR-RENDER-URL') !== -1) {
      figma.ui.postMessage({ type: 'status', message: 'Set BACKEND_URL in code.js' });
      return;
    }
    const cleanedBase =
      BACKEND_URL && BACKEND_URL[BACKEND_URL.length - 1] === '/' ? BACKEND_URL.slice(0, -1) : BACKEND_URL;
    const authUrl = `${cleanedBase}/auth/start`;
    figma.openURL(authUrl);
    figma.ui.postMessage({ type: 'status', message: 'Waiting for Webflow authorization...' });
    pollAuthStatus(cleanedBase, 0);
    return;
  }
  if (msg.type === 'get-key') {
    const selection = figma.currentPage.selection;
    if (!selection.length) {
      figma.ui.postMessage({ type: 'status', message: 'Select a component or instance.' });
      return;
    }

    const node = selection[0];
    let key = null;

    if (node.type === 'COMPONENT') {
      key = node.key;
    } else if (node.type === 'INSTANCE') {
      key = node.mainComponent ? node.mainComponent.key : null;
    }

    if (!key) {
      figma.ui.postMessage({
        type: 'status',
        message: 'No component key found. Ensure the component is published and select the main component or instance.',
      });
      return;
    }

    figma.ui.postMessage({ type: 'status', message: `Component key: ${key}` });
    return;
  }

  if (msg.type !== 'sync') return;

  try {
    if (!BACKEND_URL || BACKEND_URL.indexOf('YOUR-RENDER-URL') !== -1) {
      throw new Error('Set BACKEND_URL in code.js');
    }

    const pageUrl = msg.url;
    if (!pageUrl) {
      throw new Error('Paste a Webflow page URL in the input field.');
    }

    await ensureAuthorized(BACKEND_URL);
    figma.ui.postMessage({ type: 'status', message: 'Resolving page ID...' });
    const pageId = await resolvePageId(BACKEND_URL, pageUrl);

    figma.ui.postMessage({ type: 'status', message: 'Fetching Webflow DOM...' });
    const dom = await fetchWebflowDom(BACKEND_URL, pageId);

    figma.ui.postMessage({ type: 'status', message: 'Parsing content...' });
    const parsed = parseDom(dom);
    const keyCount = Object.keys(parsed.textByKey).length;
    const sectionsPreview = parsed.sectionOrder.slice(0, 5).join(', ');
    const sectionCount = parsed.sectionOrder.length;

    figma.ui.postMessage({ type: 'status', message: 'Placing sections...' });
    await ensureSections(parsed.sectionOrder, REBUILD_SECTIONS);
    reorderSections(parsed.sectionOrder);

    figma.ui.postMessage({ type: 'status', message: 'Updating text...' });
    const updated = await applyTextUpdates(parsed.textByKey);

    figma.ui.postMessage({
      type: 'status',
      message: `Done. Updated ${updated} text nodes. Parsed ${keyCount} keys. Sections: ${sectionCount ? sectionsPreview : 'none'}.`,
    });
  } catch (err) {
    figma.ui.postMessage({ type: 'status', message: `Error: ${err.message}` });
  }
};

async function fetchWebflowDom(baseUrl, pageId) {
  let res;
  try {
    const cleanedBase =
      baseUrl && baseUrl[baseUrl.length - 1] === '/' ? baseUrl.slice(0, -1) : baseUrl;
    const url = cleanedBase + '/dom?pageId=' + encodeURIComponent(pageId);
    res = await fetchWithTimeout(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } }, 30000);
  } catch (err) {
    throw new Error(
      'Network error while calling backend (timeout). Render free instances can be slow to wake up. Try again or refresh auth.'
    );
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Webflow API error ${res.status}: ${text}`);
  }

  return await res.json();
}

async function resolvePageId(baseUrl, pageUrl) {
  const cleanedBase =
    baseUrl && baseUrl[baseUrl.length - 1] === '/' ? baseUrl.slice(0, -1) : baseUrl;
  const url = cleanedBase + '/resolve?url=' + encodeURIComponent(pageUrl);
  const res = await fetchWithTimeout(
    url,
    { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    30000
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resolve error ${res.status}: ${text}`);
  }
  const data = await res.json();
  if (!data.pageId) throw new Error('Resolve error: pageId not found');
  return data.pageId;
}

async function ensureAuthorized(baseUrl) {
  const cleanedBase =
    baseUrl && baseUrl[baseUrl.length - 1] === '/' ? baseUrl.slice(0, -1) : baseUrl;
  const url = cleanedBase + '/auth/status';
  const res = await fetchWithTimeout(
    url,
    { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    15000
  );
  if (!res.ok) throw new Error('Auth status check failed.');
  const data = await res.json();
  if (!data.authorized) {
    throw new Error('Not connected to Webflow. Click "Connect Webflow" first.');
  }
}

async function checkAuthorized(baseUrl) {
  const cleanedBase =
    baseUrl && baseUrl[baseUrl.length - 1] === '/' ? baseUrl.slice(0, -1) : baseUrl;
  const url = cleanedBase + '/auth/status';
  const res = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) return false;
  const data = await res.json();
  return !!data.authorized;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  if (typeof AbortController === 'undefined') {
    return fetch(url, options || {});
  }
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const opts = options ? Object.assign({}, options) : {};
    opts.signal = controller.signal;
    return await fetch(url, opts);
  } finally {
    clearTimeout(id);
  }
}

function pollAuthStatus(baseUrl, attempt) {
  if (attempt > 30) {
    figma.ui.postMessage({
      type: 'status',
      message: 'Auth not completed yet. Please finish in browser and try Sync.',
    });
    return;
  }

  const url = baseUrl + '/auth/status';
  fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } })
    .then((res) => res.json())
    .then((data) => {
      if (data && data.authorized) {
        figma.ui.postMessage({ type: 'status', message: 'Webflow connected. You can sync now.' });
        figma.ui.postMessage({ type: 'auth-status', authorized: true });
        return;
      }
      setTimeout(() => pollAuthStatus(baseUrl, attempt + 1), 1000);
    })
    .catch(() => {
      setTimeout(() => pollAuthStatus(baseUrl, attempt + 1), 1000);
    });
}

function parseDom(dom) {
  const textByKey = {};
  const sectionOrder = [];

  const root = (dom && dom.dom) || (dom && dom.nodes) || dom;
  if (!root) return { textByKey, sectionOrder };

  if (Array.isArray(root)) {
    for (const node of root) {
      traverse(node, null, (n, currentSection) => {
        return handleNode(n, currentSection, textByKey, sectionOrder);
      });
    }
    return { textByKey, sectionOrder };
  }

  traverse(root, null, (node, currentSection) => {
    return handleNode(node, currentSection, textByKey, sectionOrder);
  });

  return { textByKey, sectionOrder };
}

function handleNode(node, currentSection, textByKey, sectionOrder) {
    const attrs = getAttrs(node);
    const sectionName = attrs[FIGMA_SECTION_ATTR];
    if (sectionName && !sectionOrder.includes(sectionName)) {
      sectionOrder.push(sectionName);
      currentSection = sectionName;
    }

    const key = attrs[FIGMA_KEY_ATTR];
    if (key) {
      const text = extractText(node).trim();
      if (text) textByKey[key] = text;
    }

    return currentSection;
}

function getAttrs(node) {
  if (!node) return {};
  if (node.attributes && Array.isArray(node.attributes)) {
    const map = {};
    for (const item of node.attributes) {
      if (!item) continue;
      if (item.name && typeof item.value === 'string') {
        map[item.name] = item.value;
      }
    }
    return map;
  }
  if (node.attributes && typeof node.attributes === 'object') return node.attributes;
  if (node.attrs && typeof node.attrs === 'object') return node.attrs;
  return {};
}

function traverse(node, currentSection, visitor) {
  if (!node) return;

  currentSection = visitor(node, currentSection) || currentSection;

  const children = node.children || node.childNodes || node.nodes || [];
  if (Array.isArray(children)) {
    for (const child of children) {
      traverse(child, currentSection, visitor);
    }
  }
}

function extractText(node) {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  if (node.text && typeof node.text.text === 'string') return node.text.text;
  if (typeof node.value === 'string') return node.value;

  const children = node.children || node.childNodes || node.nodes || [];
  if (!Array.isArray(children)) return '';

  return children.map(extractText).join('');
}

async function ensureSections(sectionOrder, rebuild) {
  if (!sectionOrder.length) return;

  const page = figma.currentPage;
  const existingByName = new Map();
  for (const node of page.children) {
    if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
      existingByName.set(node.name, node);
    }
  }

  if (rebuild) {
    for (const name of sectionOrder) {
      const node = existingByName.get(name);
      if (node) node.remove();
    }
  }

  for (const name of sectionOrder) {
    if (!rebuild && existingByName.has(name)) continue;
    const key = SECTION_COMPONENT_KEYS[name];
    if (!key) continue;

    const component = await figma.importComponentByKeyAsync(key);
    const instance = component.createInstance();
    instance.name = name;
    page.appendChild(instance);
  }
}

function reorderSections(sectionOrder) {
  if (!sectionOrder.length) return;

  const page = figma.currentPage;
  const byName = new Map();
  for (const node of page.children) {
    if (node.type === 'FRAME' || node.type === 'INSTANCE') {
      byName.set(node.name, node);
    }
  }

  const orderedNodes = sectionOrder.map((name) => byName.get(name)).filter(Boolean);
  if (!orderedNodes.length) return;

  const baseX = Math.min.apply(null, orderedNodes.map((n) => n.x));
  const baseY = Math.min.apply(null, orderedNodes.map((n) => n.y));

  let y = baseY;
  for (const node of orderedNodes) {
    node.x = baseX;
    node.y = y;
    y += node.height + STACK_GAP;
  }
}

async function applyTextUpdates(textByKey) {
  let updated = 0;

  const nodes = figma.currentPage.findAll((n) => n.type === 'TEXT');
  for (const node of nodes) {
    const key = node.name;
    if (!textByKey[key]) continue;

    if (node.hasMissingFont) {
      // Skip nodes with missing fonts to avoid errors
      continue;
    }

    if (node.fontName === figma.mixed) {
      // Mixed fonts are harder to update safely without range checks
      continue;
    }

    await figma.loadFontAsync(node.fontName);
    node.characters = textByKey[key];
    updated += 1;
  }

  return updated;
}
