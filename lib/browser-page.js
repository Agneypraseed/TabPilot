// These functions are serialized by chrome.scripting; keep their dependencies inside them.
export function collectVisiblePageState() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const roots = [document];
  const elements = [];
  for (let index = 0; index < roots.length; index += 1) {
    for (const element of roots[index].querySelectorAll('*')) {
      elements.push(element);
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return !element.closest('[inert]') && style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
      style.display !== 'none' && Number(style.opacity) !== 0 &&
      rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  };
  const describe = (element, id) => {
    const root = element.getRootNode();
    const references = normalize(element.getAttribute('aria-labelledby')).split(' ').filter(Boolean);
    const referencedLabel = references.map((reference) => root.getElementById?.(reference)?.textContent || '').join(' ');
    const linkedLabel = element.labels ? [...element.labels].map((label) => label.innerText).join(' ') : '';
    const imageLabel = [...element.querySelectorAll('img[alt]')].map((image) => image.alt).join(' ');
    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute('type') || '';
    const label = [referencedLabel, element.getAttribute('aria-label'), linkedLabel,
      element.innerText, imageLabel, element.getAttribute('title'),
      tag === 'input' && /^(?:submit|button|reset)$/.test(type) ? element.value : '', element.textContent]
      .map(normalize).find(Boolean) || '';
    let kind = 'control';
    if (tag === 'input' || tag === 'textarea') kind = 'input';
    else if (tag === 'select') kind = 'select';
    else if (element.isContentEditable) kind = 'editable';
    else if (tag === 'a') kind = 'link';
    const href = element.href || '';
    const rect = element.getBoundingClientRect();
    return {
      id, tag, role: element.getAttribute('role') || '', kind,
      label: normalize(label).slice(0, 180), type: type.slice(0, 24),
      placeholder: String(element.getAttribute('placeholder') || '').slice(0, 100), href,
      download: String(element.getAttribute('download') || '').slice(0, 100),
      isDownload: Boolean(element.hasAttribute('download') || /\bdownload\b/i.test(label) ||
        /\.(?:pdf|csv|tsv|zip|7z|rar|docx?|xlsx?|pptx?|rtf|txt|json|xml|png|jpe?g|webp)(?:$|[?#])/i.test(href)),
      disabled: Boolean(element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true'),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      hasPopup: element.getAttribute('aria-haspopup') || ''
    };
  };
  const fingerprint = (control) => JSON.stringify([control.tag, control.role, control.kind, control.label, control.type, control.href]);
  const selector = 'button,a[href],input:not([type="password"]):not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="menuitem"],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  const targets = elements.filter((element) => element.matches(selector) && isVisible(element)).slice(0, 45);
  const controls = targets.map(describe);
  // getRandomValues also works on ordinary HTTP pages inspected by an extension.
  const snapshotId = [...crypto.getRandomValues(new Uint32Array(4))].join('-');
  globalThis[Symbol.for('tabpilot.pageTargets')] = { document, snapshotId, targets, controls, describe, fingerprint, isVisible };
  return {
    snapshotId,
    text: String(document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 10000),
    viewport: { width: innerWidth, height: innerHeight }, controls,
    page: { title: document.title || '', url: location.href }
  };
}

export function resolveBrowserTarget({ snapshotId, controlId }) {
  const registry = globalThis[Symbol.for('tabpilot.pageTargets')];
  if (!registry || registry.document !== document || registry.snapshotId !== snapshotId) {
    return { error: 'The page changed after the model read it. Start the task again to inspect the new page.' };
  }
  const element = registry.targets[controlId];
  if (!element?.isConnected) return { error: 'The chosen control was removed from the page. No click was sent.' };
  const current = registry.describe(element, controlId);
  if (registry.fingerprint(current) !== registry.fingerprint(registry.controls[controlId])) {
    return { error: 'The chosen control changed while the model was thinking. No click was sent.' };
  }
  if (current.disabled || !registry.isVisible(element)) return { error: 'The chosen control is now disabled or hidden. No click was sent.' };
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(innerWidth, rect.right);
  const bottom = Math.min(innerHeight, rect.bottom);
  for (const [horizontal, vertical] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]]) {
    const x = left + (right - left) * horizontal;
    const y = top + (bottom - top) * vertical;
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const nested = hit.shadowRoot.elementFromPoint(x, y);
      if (!nested || nested === hit) break;
      hit = nested;
    }
    if (hit === element || element.contains(hit)) return { x, y };
  }
  return { error: 'Another element covers the chosen control. No click was sent.' };
}
