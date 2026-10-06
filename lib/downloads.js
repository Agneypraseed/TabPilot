export function safeDownloadFolder(value) {
  const parts = String(value || 'TabPilot').replaceAll('\\', '/').split('/').map((part) =>
    part.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').trim().slice(0, 60)
  ).filter((part) => part && part !== '.' && part !== '..').slice(0, 4);
  return parts.join('/') || 'TabPilot';
}

export function safeDownloadFilename(value) {
  const basename = String(value || 'download').split(/[\\/]/).pop() || 'download';
  const filename = basename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180);
  if (!filename) return 'download';
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(filename)) return `_${filename}`;
  return filename;
}

export function normalizeSourcePage(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return `${url.origin}${url.pathname}`;
  } catch { return ''; }
}

export function sameSourcePage(left, right) {
  const source = normalizeSourcePage(left);
  const expected = normalizeSourcePage(right);
  return Boolean(source && expected && source === expected);
}

export function isDownloadControl(control) {
  if (!control) return false;
  return Boolean(
    control.isDownload || (typeof control.download === 'string' && control.download.length > 0) ||
    /\b(?:download|export)\b/i.test(`${control.label || ''} ${control.role || ''}`) ||
    /\.(?:pdf|csv|tsv|zip|7z|rar|docx?|xlsx?|pptx?|rtf|txt|json|xml|png|jpe?g|webp)(?:$|[?#])/i.test(control.href || '')
  );
}
