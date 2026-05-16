const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

export function safeFileName(name, fallback = 'attachment') {
  let value = String(name || '').trim() || fallback;
  value = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[ .]+$/g, '');
  if (!value) value = fallback;

  const stem = value.split('.', 1)[0].toUpperCase();
  return WINDOWS_RESERVED_NAMES.has(stem) ? `_${value}` : value;
}

export function uniqueFileName(name, usedNames) {
  const safeName = safeFileName(name);
  if (!usedNames.has(safeName.toLowerCase())) {
    usedNames.add(safeName.toLowerCase());
    return safeName;
  }

  const dotIndex = safeName.lastIndexOf('.');
  const stem = dotIndex > 0 ? safeName.slice(0, dotIndex) : safeName;
  const suffix = dotIndex > 0 ? safeName.slice(dotIndex) : '';
  let counter = 2;
  while (true) {
    const candidate = `${stem}-${counter}${suffix}`;
    const key = candidate.toLowerCase();
    if (!usedNames.has(key)) {
      usedNames.add(key);
      return candidate;
    }
    counter += 1;
  }
}

export function stripAttachmentsFromEml(bytes, { includeInline = false } = {}) {
  const source = bytesToBinaryString(bytes);
  const ranges = [];

  collectRemovalRanges(source, 0, source.length, includeInline, ranges);

  return {
    bytes: omitRanges(bytes, ranges),
    removedCount: ranges.length,
    ranges,
  };
}

function bytesToBinaryString(bytes) {
  const chunkSize = 0x8000;
  let value = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    value += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return value;
}

function collectRemovalRanges(source, start, end, includeInline, ranges) {
  const split = findHeaderBodySplit(source, start, end);
  if (!split) return 'keep';

  const headers = parseHeaders(source.slice(start, split.headerEnd));
  if (isAttachmentPart(headers, includeInline)) {
    return 'attachment';
  }

  const contentType = getHeader(headers, 'content-type') || '';
  if (!/^multipart\//i.test(firstToken(contentType))) {
    return 'keep';
  }

  const boundary = getParameter(contentType, 'boundary');
  if (!boundary) return 'keep';

  const boundaries = findBoundaryLines(source, boundary, split.bodyStart, end);
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const current = boundaries[index];
    const next = boundaries[index + 1];
    if (current.closing) continue;

    const childStart = current.lineEnd;
    const childEnd = next.start;
    const childResult = collectRemovalRanges(source, childStart, childEnd, includeInline, ranges);

    if (childResult === 'attachment') {
      ranges.push({ start: current.start, end: next.start });
    }
  }

  return 'keep';
}

function findHeaderBodySplit(source, start, end) {
  const crlfIndex = source.indexOf('\r\n\r\n', start);
  const lfIndex = source.indexOf('\n\n', start);
  const candidates = [];

  if (crlfIndex >= start && crlfIndex < end) {
    candidates.push({ headerEnd: crlfIndex, bodyStart: crlfIndex + 4 });
  }
  if (lfIndex >= start && lfIndex < end) {
    candidates.push({ headerEnd: lfIndex, bodyStart: lfIndex + 2 });
  }

  if (!candidates.length) return null;
  return candidates.sort((left, right) => left.headerEnd - right.headerEnd)[0];
}

function parseHeaders(headerBlock) {
  const headers = new Map();
  let currentName = '';
  let currentValue = '';

  const commit = () => {
    if (!currentName) return;
    const key = currentName.toLowerCase();
    const values = headers.get(key) || [];
    values.push(currentValue.trim());
    headers.set(key, values);
  };

  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && currentName) {
      currentValue += ` ${line.trim()}`;
      continue;
    }

    commit();
    const separator = line.indexOf(':');
    if (separator === -1) {
      currentName = '';
      currentValue = '';
      continue;
    }

    currentName = line.slice(0, separator).trim();
    currentValue = line.slice(separator + 1).trim();
  }
  commit();

  return headers;
}

function isAttachmentPart(headers, includeInline) {
  const dispositionHeader = getHeader(headers, 'content-disposition') || '';
  const disposition = firstToken(dispositionHeader);

  if (disposition === 'attachment') return true;
  if (disposition !== 'inline' || !includeInline) return false;

  return Boolean(
    getParameter(dispositionHeader, 'filename') ||
      getParameter(dispositionHeader, 'filename*') ||
      getParameter(getHeader(headers, 'content-type') || '', 'name') ||
      getParameter(getHeader(headers, 'content-type') || '', 'name*')
  );
}

function getHeader(headers, name) {
  return headers.get(name.toLowerCase())?.[0] || '';
}

function firstToken(headerValue) {
  return String(headerValue || '').split(';', 1)[0].trim().toLowerCase();
}

function getParameter(headerValue, name) {
  const target = name.toLowerCase();
  const parts = splitParameters(headerValue);

  for (const part of parts.slice(1)) {
    const equals = part.indexOf('=');
    if (equals === -1) continue;

    const key = part.slice(0, equals).trim().toLowerCase();
    if (key !== target) continue;

    return unquoteParameter(part.slice(equals + 1).trim());
  }

  return '';
}

function splitParameters(headerValue) {
  const parts = [];
  let current = '';
  let quoted = false;
  let escaped = false;

  for (const char of String(headerValue || '')) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && quoted) {
      escaped = true;
      current += char;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }

    if (char === ';' && !quoted) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  parts.push(current.trim());
  return parts;
}

function unquoteParameter(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return value;
}

function findBoundaryLines(source, boundary, start, end) {
  const marker = `--${boundary}`;
  const boundaries = [];
  let position = start;

  while (position < end) {
    const found = source.indexOf(marker, position);
    if (found === -1 || found >= end) break;

    if (!isLineStart(source, found, start)) {
      position = found + marker.length;
      continue;
    }

    const afterMarker = found + marker.length;
    const nextChar = source[afterMarker] || '';
    if (nextChar && nextChar !== '-' && nextChar !== '\r' && nextChar !== '\n' && nextChar !== ' ' && nextChar !== '\t') {
      position = afterMarker;
      continue;
    }

    boundaries.push({
      start: found,
      lineEnd: findLineEnd(source, found, end),
      closing: source.startsWith('--', afterMarker),
    });
    position = afterMarker;
  }

  return boundaries;
}

function isLineStart(source, position, bodyStart) {
  return position === bodyStart || position === 0 || source.charCodeAt(position - 1) === 10;
}

function findLineEnd(source, start, end) {
  const lineFeed = source.indexOf('\n', start);
  if (lineFeed === -1 || lineFeed >= end) return end;
  return lineFeed + 1;
}

function omitRanges(bytes, ranges) {
  const normalized = normalizeRanges(ranges, bytes.length);
  if (!normalized.length) return bytes.slice();

  const removedLength = normalized.reduce((sum, range) => sum + range.end - range.start, 0);
  const output = new Uint8Array(bytes.length - removedLength);
  let readOffset = 0;
  let writeOffset = 0;

  for (const range of normalized) {
    const kept = bytes.subarray(readOffset, range.start);
    output.set(kept, writeOffset);
    writeOffset += kept.length;
    readOffset = range.end;
  }

  const tail = bytes.subarray(readOffset);
  output.set(tail, writeOffset);
  return output;
}

function normalizeRanges(ranges, maxLength) {
  const sorted = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(maxLength, range.start)),
      end: Math.max(0, Math.min(maxLength, range.end)),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const normalized = [];
  for (const range of sorted) {
    const previous = normalized[normalized.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }
    normalized.push(range);
  }
  return normalized;
}
