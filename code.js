// Webflow -> Figma sync (MVP)
// TODO: Fill in BACKEND_URL and WEBFLOW_PAGE_ID.
// TODO: Define section/component mapping and data-figma-key attributes in Webflow.

const BACKEND_URL = "https://figma-webflow-sync.onrender.com"; // Render backend base URL
const WEBFLOW_PAGE_ID = "698b0dfd793838e9c699e7d9"; // Static page ID

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
    if (!BACKEND_URL || BACKEND_URL.indexOf('YOUR-RENDER-URL') !== -1 || !WEBFLOW_PAGE_ID) {
      throw new Error('Set BACKEND_URL and WEBFLOW_PAGE_ID in code.js');
    }

    figma.ui.postMessage({ type: 'status', message: 'Fetching Webflow DOM...' });
    const dom = await fetchWebflowDom(BACKEND_URL, WEBFLOW_PAGE_ID);

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
    res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    throw new Error(
      'Network error while calling backend. Check BACKEND_URL and Render deployment.'
    );
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Webflow API error ${res.status}: ${text}`);
  }

  return await res.json();
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

  const baseX = Math.min(...orderedNodes.map((n) => n.x));
  const baseY = Math.min(...orderedNodes.map((n) => n.y));

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
