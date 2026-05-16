import PostalMime from 'postal-mime';
import { zipSync } from 'fflate';
import {
  Archive,
  Code2,
  Download,
  Eye,
  FileDown,
  FileUp,
  FolderOpen,
  MailOpen,
  Paperclip,
  Type,
  createIcons,
} from 'lucide';
import './styles.css';
import { safeFileName, stripAttachmentsFromEml, uniqueFileName } from './mime-detach.js';

const iconSet = {
  Archive,
  Code2,
  Download,
  Eye,
  FileDown,
  FileUp,
  FolderOpen,
  MailOpen,
  Paperclip,
  Type,
};

const filePickerTypes = [
  {
    description: 'EML files',
    accept: {
      'message/rfc822': ['.eml'],
      'text/plain': ['.eml'],
      'application/octet-stream': ['.eml'],
    },
  },
];

const elements = {
  app: document.querySelector('.app-shell'),
  openButton: document.querySelector('#openButton'),
  emptyOpenButton: document.querySelector('#emptyOpenButton'),
  fileInput: document.querySelector('#fileInput'),
  fileStatus: document.querySelector('#fileStatus'),
  zipButton: document.querySelector('#zipButton'),
  strippedButton: document.querySelector('#strippedButton'),
  includeInlineToggle: document.querySelector('#includeInlineToggle'),
  allowRemoteToggle: document.querySelector('#allowRemoteToggle'),
  messageMeta: document.querySelector('#messageMeta'),
  attachmentCount: document.querySelector('#attachmentCount'),
  attachmentsList: document.querySelector('#attachmentsList'),
  subjectText: document.querySelector('#subjectText'),
  tabs: document.querySelectorAll('.tab-button'),
  emptyState: document.querySelector('#emptyState'),
  htmlPreview: document.querySelector('#htmlPreview'),
  textPreview: document.querySelector('#textPreview'),
  sourcePreview: document.querySelector('#sourcePreview'),
};

const state = {
  current: null,
  activeTab: 'html',
  statusTimer: 0,
  objectUrls: [],
};

refreshIcons();
bindEvents();
renderEmptyState();

function bindEvents() {
  elements.openButton.addEventListener('click', openFile);
  elements.emptyOpenButton.addEventListener('click', openFile);
  elements.fileInput.addEventListener('change', onInputFileChange);
  elements.zipButton.addEventListener('click', downloadAttachmentZip);
  elements.strippedButton.addEventListener('click', downloadStrippedEml);
  elements.includeInlineToggle.addEventListener('change', renderAttachments);
  elements.allowRemoteToggle.addEventListener('change', renderPreview);
  elements.attachmentsList.addEventListener('click', onAttachmentListClick);

  for (const tab of elements.tabs) {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;
      renderPreview();
    });
  }

  document.addEventListener(
    'keydown',
    (event) => {
      const isOpenShortcut = (event.ctrlKey || event.metaKey) && event.code === 'KeyO';
      if (!isOpenShortcut) return;

      event.preventDefault();
      event.stopPropagation();
      openFile();
    },
    true
  );

  bindDragAndDrop();
  bindLaunchQueue();
}

async function openFile() {
  try {
    if ('showOpenFilePicker' in window) {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: filePickerTypes,
      });
      const file = await handle.getFile();
      await openFileObject(file, { handle, source: 'picker' });
      return;
    }

    elements.fileInput.value = '';
    elements.fileInput.click();
  } catch (error) {
    if (!isAbortError(error)) {
      showStatus('파일을 열 수 없습니다.');
      throw error;
    }
  }
}

async function onInputFileChange() {
  const [file] = elements.fileInput.files || [];
  if (file) {
    await openFileObject(file, { source: 'input' });
  }
}

async function openFileObject(file, { handle = null, source = 'unknown' } = {}) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.eml')) {
    showStatus('EML 파일만 열 수 있습니다.');
    return;
  }

  clearObjectUrls();
  setBusy(true);

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const email = await PostalMime.parse(bytes, {
      attachmentEncoding: 'arraybuffer',
      rfc822Attachments: true,
    });

    state.current = {
      bytes,
      email,
      fileName: file.name,
      handle,
      source,
      lastModified: file.lastModified || null,
      sourceText: decodeSource(bytes),
    };

    document.title = `${email.subject || file.name} - 퐤믈`;
    renderCurrentMessage();
    showStatus(`${file.name} 열림`);
  } catch (error) {
    renderEmptyState();
    showStatus('EML을 해석할 수 없습니다.');
    throw error;
  } finally {
    setBusy(false);
  }
}

function renderCurrentMessage() {
  const current = state.current;
  if (!current) {
    renderEmptyState();
    return;
  }

  const { email, fileName, bytes } = current;
  const attachmentTotal = email.attachments?.length || 0;
  const subject = email.subject || '(제목 없음)';

  elements.fileStatus.textContent = `${fileName} · ${formatBytes(bytes.byteLength)}`;
  elements.subjectText.textContent = subject;
  elements.messageMeta.innerHTML = renderMetaRows([
    ['From', formatAddress(email.from)],
    ['To', formatAddressList(email.to)],
    ['Cc', formatAddressList(email.cc)],
    ['Date', formatDate(email.date)],
    ['Message-ID', email.messageId || '-'],
    ['파일', `${fileName} · ${formatBytes(bytes.byteLength)}`],
  ]);
  elements.attachmentCount.textContent = String(attachmentTotal);

  renderAttachments();
  renderPreview();
}

function renderEmptyState() {
  state.current = null;
  clearObjectUrls();
  elements.fileStatus.textContent = '파일 없음';
  elements.subjectText.textContent = 'EML 파일을 열어 주세요';
  elements.messageMeta.innerHTML = renderMetaRows([['상태', '대기 중']]);
  elements.attachmentCount.textContent = '0';
  elements.attachmentsList.innerHTML = '<p class="empty-note">첨부 없음</p>';
  elements.zipButton.disabled = true;
  elements.strippedButton.disabled = true;
  elements.emptyState.hidden = false;
  elements.htmlPreview.hidden = true;
  elements.textPreview.hidden = true;
  elements.sourcePreview.hidden = true;
  refreshIcons();
}

function renderMetaRows(rows) {
  return rows
    .map(
      ([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value || '-')}</dd>
        </div>
      `
    )
    .join('');
}

function renderAttachments() {
  const current = state.current;
  if (!current) return;

  const { email } = current;
  const attachments = email.attachments || [];
  const detachable = getDetachableAttachments();

  elements.zipButton.disabled = detachable.length === 0;
  elements.strippedButton.disabled = detachable.length === 0;

  if (!attachments.length) {
    elements.attachmentsList.innerHTML = '<p class="empty-note">첨부 없음</p>';
    return;
  }

  elements.attachmentsList.innerHTML = attachments
    .map((attachment, index) => {
      const name = attachment.filename || `attachment-${index + 1}`;
      const size = attachment.content ? byteLength(attachment.content) : 0;
      const disposition = attachment.disposition || 'part';
      const badgeClass = disposition === 'inline' ? 'badge inline' : 'badge';

      return `
        <article class="attachment-item">
          <div>
            <div class="attachment-title">
              <span>${escapeHtml(name)}</span>
              <span class="${badgeClass}">${escapeHtml(disposition)}</span>
            </div>
            <div class="attachment-detail">${escapeHtml(attachment.mimeType || 'application/octet-stream')} · ${formatBytes(size)}</div>
          </div>
          <button class="icon-button" type="button" data-attachment-index="${index}" title="다운로드" aria-label="${escapeAttribute(name)} 다운로드">
            <i data-lucide="download" aria-hidden="true"></i>
          </button>
        </article>
      `;
    })
    .join('');
  refreshIcons(elements.attachmentsList);
}

function renderPreview() {
  const current = state.current;
  if (!current) return;

  const { email, sourceText } = current;
  const hasHtml = Boolean(email.html);
  const activeTab = state.activeTab === 'html' && !hasHtml && email.text ? 'text' : state.activeTab;

  for (const tab of elements.tabs) {
    tab.classList.toggle('active', tab.dataset.tab === activeTab);
  }

  elements.emptyState.hidden = true;
  elements.htmlPreview.hidden = activeTab !== 'html';
  elements.textPreview.hidden = activeTab !== 'text';
  elements.sourcePreview.hidden = activeTab !== 'source';

  if (activeTab === 'html') {
    elements.htmlPreview.srcdoc = buildPreviewDocument(email);
  } else if (activeTab === 'text') {
    elements.textPreview.textContent = email.text || htmlToText(email.html) || '';
  } else {
    elements.sourcePreview.textContent = sourceText;
  }
}

function buildPreviewDocument(email) {
  const html = email.html || `<pre>${escapeHtml(email.text || '')}</pre>`;
  const safeHtml = sanitizeEmailHtml(html, {
    allowRemote: elements.allowRemoteToggle.checked,
    cidMap: buildCidUrlMap(email),
  });

  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <base target="_blank" />
    <style>
      html { color-scheme: light; background: oklch(100% 0 0); }
      body {
        max-width: 900px;
        margin: 0 auto;
        padding: 32px 36px;
        color: oklch(18% 0.012 250);
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
        font-size: 15px;
        line-height: 1.64;
      }
      * { box-sizing: border-box; }
      img { max-width: 100%; height: auto; }
      table { max-width: 100%; border-collapse: collapse; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; }
      blockquote {
        margin-inline: 0;
        padding-left: 14px;
        border-left: 2px solid oklch(58% 0.18 255);
        color: oklch(34% 0.012 250);
      }
      a { color: oklch(48% 0.18 255); }
      .remote-blocked {
        display: inline-grid;
        place-items: center;
        min-width: 160px;
        min-height: 42px;
        border: 1px dashed oklch(80% 0.008 250);
        border-radius: 8px;
        color: oklch(54% 0.012 250);
        background: oklch(97% 0.003 250);
      }
    </style>
  </head>
  <body>${safeHtml}</body>
</html>`;
}

function sanitizeEmailHtml(html, { allowRemote, cidMap }) {
  const document = new DOMParser().parseFromString(html, 'text/html');

  document.querySelectorAll('script, iframe, object, embed, form, input, button, meta[http-equiv="refresh"]').forEach((node) => {
    node.remove();
  });

  for (const style of document.querySelectorAll('style')) {
    if (!allowRemote && /@import|url\s*\(\s*["']?https?:/i.test(style.textContent || '')) {
      style.remove();
    }
  }

  for (const element of document.querySelectorAll('*')) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value || '';

      if (name.startsWith('on') || name === 'srcdoc') {
        element.removeAttribute(attribute.name);
        continue;
      }

      if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (name === 'style' && !allowRemote && /url\s*\(\s*["']?https?:/i.test(value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  for (const element of document.querySelectorAll('[src], [href]')) {
    for (const attributeName of ['src', 'href']) {
      const value = element.getAttribute(attributeName);
      if (!value) continue;

      if (/^cid:/i.test(value)) {
        const cid = normalizeCid(value.slice(4));
        const objectUrl = cidMap.get(cid);
        if (objectUrl) {
          element.setAttribute(attributeName, objectUrl);
        } else {
          element.removeAttribute(attributeName);
        }
        continue;
      }

      if (attributeName === 'src' && isRemoteUrl(value) && !allowRemote) {
        element.removeAttribute('src');
        element.removeAttribute('srcset');
        element.classList.add('remote-blocked');
        if (!element.getAttribute('alt')) {
          element.setAttribute('alt', '원격 이미지 차단됨');
        }
      }
    }
  }

  for (const element of document.querySelectorAll('[srcset]')) {
    const value = element.getAttribute('srcset') || '';
    if (!allowRemote && /https?:/i.test(value)) {
      element.removeAttribute('srcset');
    }
  }

  for (const link of document.querySelectorAll('a[href]')) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noreferrer noopener');
  }

  return document.body.innerHTML;
}

function buildCidUrlMap(email) {
  const cidMap = new Map();
  clearObjectUrls();

  for (const attachment of email.attachments || []) {
    if (!attachment.contentId || !attachment.content) continue;
    const blob = new Blob([toUint8Array(attachment.content)], {
      type: attachment.mimeType || 'application/octet-stream',
    });
    const objectUrl = URL.createObjectURL(blob);
    state.objectUrls.push(objectUrl);
    cidMap.set(normalizeCid(attachment.contentId), objectUrl);
  }

  return cidMap;
}

function getDetachableAttachments() {
  const attachments = state.current?.email.attachments || [];
  const includeInline = elements.includeInlineToggle.checked;

  return attachments.filter((attachment) => {
    if (attachment.disposition === 'attachment') return true;
    return includeInline && attachment.disposition === 'inline' && attachment.filename;
  });
}

async function downloadAttachmentZip() {
  const current = state.current;
  if (!current) return;

  const attachments = getDetachableAttachments();
  if (!attachments.length) {
    showStatus('저장할 첨부파일이 없습니다.');
    return;
  }

  const usedNames = new Set();
  const files = {};
  for (const [index, attachment] of attachments.entries()) {
    const filename = uniqueFileName(attachment.filename || `attachment-${index + 1}`, usedNames);
    files[filename] = toUint8Array(attachment.content);
  }

  const zipped = zipSync(files, { level: 6 });
  const name = `${baseName(current.fileName)}-attachments.zip`;
  downloadBlob(new Blob([zipped], { type: 'application/zip' }), name);
  showStatus(`${attachments.length}개 첨부파일 ZIP 저장`);
}

async function downloadStrippedEml() {
  const current = state.current;
  if (!current) return;

  const { bytes, removedCount } = stripAttachmentsFromEml(current.bytes, {
    includeInline: elements.includeInlineToggle.checked,
  });

  if (!removedCount) {
    showStatus('제거할 첨부 파트를 찾지 못했습니다.');
    return;
  }

  downloadBlob(new Blob([bytes], { type: 'message/rfc822' }), `${baseName(current.fileName)}-detached.eml`);
  showStatus(`${removedCount}개 MIME 파트 제거`);
}

function onAttachmentListClick(event) {
  const button = event.target.closest('[data-attachment-index]');
  if (!button || !state.current) return;

  const index = Number(button.dataset.attachmentIndex);
  const attachment = state.current.email.attachments?.[index];
  if (!attachment) return;

  const name = safeFileName(attachment.filename || `attachment-${index + 1}`);
  downloadBlob(
    new Blob([toUint8Array(attachment.content)], {
      type: attachment.mimeType || 'application/octet-stream',
    }),
    name
  );
  showStatus(`${name} 저장`);
}

function downloadBlob(blob, filename) {
  const anchor = document.createElement('a');
  const url = URL.createObjectURL(blob);
  anchor.href = url;
  anchor.download = safeFileName(filename, 'download');
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function bindDragAndDrop() {
  let dragDepth = 0;

  document.addEventListener(
    'dragenter',
    (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepth += 1;
      elements.app.classList.add('drag-over');
    },
    true
  );

  document.addEventListener(
    'dragover',
    (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    true
  );

  document.addEventListener(
    'dragleave',
    (event) => {
      if (!isFileDrag(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        elements.app.classList.remove('drag-over');
      }
    },
    true
  );

  document.addEventListener(
    'drop',
    async (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepth = 0;
      elements.app.classList.remove('drag-over');

      const handle = await getDroppedFileHandle(event);
      if (handle?.kind === 'file') {
        const file = await handle.getFile();
        await openFileObject(file, { handle, source: 'drop' });
        return;
      }

      const [file] = event.dataTransfer.files || [];
      await openFileObject(file, { source: 'drop' });
    },
    true
  );
}

function bindLaunchQueue() {
  if (!('launchQueue' in window) || !('LaunchParams' in window)) return;

  window.launchQueue.setConsumer(async (launchParams) => {
    const [handle] = launchParams.files || [];
    if (!handle) return;

    const file = await handle.getFile();
    await openFileObject(file, { handle, source: 'launch' });
  });
}

async function getDroppedFileHandle(event) {
  const item = Array.from(event.dataTransfer?.items || []).find(({ kind }) => kind === 'file');
  if (!item || typeof item.getAsFileSystemHandle !== 'function') return null;
  return item.getAsFileSystemHandle();
}

function isFileDrag(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function setBusy(isBusy) {
  elements.openButton.disabled = isBusy;
  elements.emptyOpenButton.disabled = isBusy;
}

function showStatus(message) {
  let statusElement = document.querySelector('.status-toast');
  if (!statusElement) {
    statusElement = document.createElement('div');
    statusElement.className = 'status-toast';
    statusElement.setAttribute('role', 'status');
    document.body.append(statusElement);
  }

  statusElement.textContent = message;
  statusElement.classList.add('status-toast-visible');
  window.clearTimeout(state.statusTimer);
  state.statusTimer = window.setTimeout(() => {
    statusElement.classList.remove('status-toast-visible');
  }, 2400);
}

function clearObjectUrls() {
  for (const url of state.objectUrls) {
    URL.revokeObjectURL(url);
  }
  state.objectUrls = [];
}

function refreshIcons(root = document) {
  createIcons({ icons: iconSet, root });
}

function formatAddress(address) {
  if (!address) return '-';
  if (address.group) return formatAddressList(address.group);
  return address.name ? `${address.name} <${address.address || ''}>` : address.address || '-';
}

function formatAddressList(addresses) {
  if (!addresses?.length) return '-';
  return addresses.map(formatAddress).join(', ');
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '-';
  if (value < 1024) return `${value} B`;

  const units = ['KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = -1;
  do {
    size /= 1024;
    unitIndex += 1;
  } while (size >= 1024 && unitIndex < units.length - 1);

  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function byteLength(content) {
  if (content instanceof ArrayBuffer) return content.byteLength;
  if (ArrayBuffer.isView(content)) return content.byteLength;
  if (typeof content === 'string') return content.length;
  return 0;
}

function toUint8Array(content) {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  if (typeof content === 'string') return new TextEncoder().encode(content);
  return new Uint8Array();
}

function baseName(filename) {
  return safeFileName(String(filename || 'message').replace(/\.eml$/i, ''), 'message');
}

function decodeSource(bytes) {
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if (!utf8.includes('\uFFFD')) return utf8;

  try {
    return new TextDecoder('windows-1252').decode(bytes);
  } catch {
    return utf8;
  }
}

function htmlToText(html) {
  if (!html) return '';
  const document = new DOMParser().parseFromString(html, 'text/html');
  return document.body.textContent || '';
}

function isRemoteUrl(value) {
  return /^https?:\/\//i.test(value.trim());
}

function normalizeCid(value) {
  return String(value || '')
    .trim()
    .replace(/^<|>$/g, '')
    .toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}
