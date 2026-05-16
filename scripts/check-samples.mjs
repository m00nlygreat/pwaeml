import { readdir, readFile } from 'node:fs/promises';
import PostalMime from 'postal-mime';
import { stripAttachmentsFromEml } from '../src/mime-detach.js';

const files = (await readdir('.')).filter((file) => file.toLowerCase().endsWith('.eml'));
let failures = 0;

for (const file of files) {
  const bytes = new Uint8Array(await readFile(file));
  const email = await PostalMime.parse(bytes, {
    attachmentEncoding: 'arraybuffer',
    rfc822Attachments: true,
  });

  const expected = (email.attachments || []).filter((item) => item.disposition === 'attachment').length;
  const stripped = stripAttachmentsFromEml(bytes);
  const after = await PostalMime.parse(stripped.bytes, {
    attachmentEncoding: 'arraybuffer',
    rfc822Attachments: true,
  });
  const afterCount = (after.attachments || []).filter((item) => item.disposition === 'attachment').length;
  const ok = expected === stripped.removedCount && afterCount === 0;

  if (!ok) failures += 1;
  console.log(`${ok ? 'ok' : 'fail'} ${file}: expected=${expected} removed=${stripped.removedCount} afterAttachment=${afterCount}`);
}

if (!files.length) {
  console.log('no sample .eml files found');
}

process.exitCode = failures ? 1 : 0;
