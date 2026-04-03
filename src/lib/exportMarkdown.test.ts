import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';

import { readMarkdownEntriesFromImport } from './exportMarkdown.js';

type TestZipEntry = {
  path: string;
  content: string;
  method?: 0 | 8;
};

function writeUint16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, true);
}

function buildZip(entries: TestZipEntry[]) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const directory: Array<{ name: Uint8Array; data: Uint8Array; method: 0 | 8; offset: number }> = [];

  let localOffset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const source = encoder.encode(entry.content);
    const method = entry.method ?? 0;
    const data = method === 8 ? deflateRawSync(source) : source;

    const localHeader = new Uint8Array(30 + name.length);
    const localView = new DataView(localHeader.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0);
    writeUint16(localView, 8, method);
    writeUint16(localView, 10, 0);
    writeUint16(localView, 12, 0);
    writeUint32(localView, 14, 0);
    writeUint32(localView, 18, data.length);
    writeUint32(localView, 22, source.length);
    writeUint16(localView, 26, name.length);
    writeUint16(localView, 28, 0);
    localHeader.set(name, 30);

    localParts.push(localHeader, data);
    directory.push({ name, data, method, offset: localOffset });
    localOffset += localHeader.length + data.length;
  }

  let centralSize = 0;
  for (const entry of directory) {
    const centralHeader = new Uint8Array(46 + entry.name.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0);
    writeUint16(centralView, 10, entry.method);
    writeUint16(centralView, 12, 0);
    writeUint16(centralView, 14, 0);
    writeUint32(centralView, 16, 0);
    writeUint32(centralView, 20, entry.data.length);
    writeUint32(centralView, 24, 0);
    writeUint16(centralView, 28, entry.name.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, entry.offset);
    centralHeader.set(entry.name, 46);

    centralParts.push(centralHeader);
    centralSize += centralHeader.length;
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  writeUint32(eocdView, 0, 0x06054b50);
  writeUint16(eocdView, 4, 0);
  writeUint16(eocdView, 6, 0);
  writeUint16(eocdView, 8, entries.length);
  writeUint16(eocdView, 10, entries.length);
  writeUint32(eocdView, 12, centralSize);
  writeUint32(eocdView, 16, localOffset);
  writeUint16(eocdView, 20, 0);

  return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
}

test('reads uncompressed markdown entries from zip', async () => {
  const zip = buildZip([
    { path: 'notes/alpha.md', content: '# Alpha', method: 0 },
    { path: 'notes/beta.md', content: 'Beta content', method: 0 },
  ]);

  const file = new File([zip], 'import.zip', { type: 'application/zip' });
  const entries = await readMarkdownEntriesFromImport(file);

  assert.deepEqual(entries, [
    { path: 'notes/alpha.md', content: '# Alpha' },
    { path: 'notes/beta.md', content: 'Beta content' },
  ]);
});

test('reads compressed markdown entries from zip', async () => {
  const zip = buildZip([{ path: 'deep/report.md', content: 'Compressed content ✅', method: 8 }]);

  const file = new File([zip], 'compressed.zip', { type: 'application/zip' });
  const entries = await readMarkdownEntriesFromImport(file);

  assert.deepEqual(entries, [{ path: 'deep/report.md', content: 'Compressed content ✅' }]);
});

test('ignores non-markdown files and keeps relative markdown paths', async () => {
  const zip = buildZip([
    { path: 'notes/summary.md', content: 'Keep me', method: 0 },
    { path: 'notes/data.csv', content: 'a,b,c', method: 8 },
    { path: 'image.png', content: 'binary-ish', method: 0 },
  ]);

  const file = new File([zip], 'mixed.zip', { type: 'application/zip' });
  const entries = await readMarkdownEntriesFromImport(file);

  assert.deepEqual(entries, [{ path: 'notes/summary.md', content: 'Keep me' }]);
});

test('throws a clear error for malformed zip archives', async () => {
  const malformed = new File([new Uint8Array([0x50, 0x4b, 0x03])], 'bad.zip', { type: 'application/zip' });

  await assert.rejects(readMarkdownEntriesFromImport(malformed), /malformed|central directory/i);
});
