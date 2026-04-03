import type { PromptFile, Workspace } from '../types/models';

type ZipEntry = {
  nameBytes: Uint8Array;
  contentBytes: Uint8Array;
  crc32: number;
  offset: number;
  dosTime: number;
  dosDate: number;
};

function ensureMdPath(path: string) {
  return path.toLowerCase().endsWith('.md') ? path : `${path}.md`;
}

function safeName(input: string) {
  return input.replace(/[^a-z0-9-_]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

function getDosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function writeUint16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, true);
}

async function inflateRaw(bytes: Uint8Array) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Compressed ZIP entries are not supported in this environment.');
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const decompressed = await new Response(stream).arrayBuffer();
  return new Uint8Array(decompressed);
}

function findEndOfCentralDirectoryOffset(bytes: Uint8Array, view: DataView) {
  const minEocdSize = 22;
  if (bytes.length < minEocdSize) {
    throw new Error('ZIP file is malformed or truncated.');
  }

  const maxCommentLength = 0xffff;
  const minOffset = Math.max(0, bytes.length - (minEocdSize + maxCommentLength));

  for (let offset = bytes.length - minEocdSize; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      return offset;
    }
  }

  throw new Error('ZIP central directory not found.');
}

function buildZip(files: Array<{ path: string; content: string }>) {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];
  const localParts: Uint8Array[] = [];
  let offset = 0;

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.path);
    const contentBytes = encoder.encode(file.content);
    const checksum = crc32(contentBytes);
    const { dosTime, dosDate } = getDosDateTime(new Date());

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0);
    writeUint16(localView, 8, 0);
    writeUint16(localView, 10, dosTime);
    writeUint16(localView, 12, dosDate);
    writeUint32(localView, 14, checksum);
    writeUint32(localView, 18, contentBytes.length);
    writeUint32(localView, 22, contentBytes.length);
    writeUint16(localView, 26, nameBytes.length);
    writeUint16(localView, 28, 0);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, contentBytes);

    entries.push({
      nameBytes,
      contentBytes,
      crc32: checksum,
      offset,
      dosTime,
      dosDate,
    });

    offset += localHeader.length + contentBytes.length;
  });

  const centralParts: Uint8Array[] = [];
  let centralSize = 0;

  entries.forEach((entry) => {
    const centralHeader = new Uint8Array(46 + entry.nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, entry.dosTime);
    writeUint16(centralView, 14, entry.dosDate);
    writeUint32(centralView, 16, entry.crc32);
    writeUint32(centralView, 20, entry.contentBytes.length);
    writeUint32(centralView, 24, entry.contentBytes.length);
    writeUint16(centralView, 28, entry.nameBytes.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, entry.offset);
    centralHeader.set(entry.nameBytes, 46);

    centralParts.push(centralHeader);
    centralSize += centralHeader.length;
  });

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  writeUint32(eocdView, 0, 0x06054b50);
  writeUint16(eocdView, 4, 0);
  writeUint16(eocdView, 6, 0);
  writeUint16(eocdView, 8, entries.length);
  writeUint16(eocdView, 10, entries.length);
  writeUint32(eocdView, 12, centralSize);
  writeUint32(eocdView, 16, offset);
  writeUint16(eocdView, 20, 0);

  return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
}

export async function exportWorkspaceMarkdownZip(workspace: Workspace, files: PromptFile[]) {
  const blob = buildZip(
    files.map((file) => ({
      path: ensureMdPath(file.path),
      content: file.content,
    })),
  );

  const workspaceName = safeName(workspace.name || 'workspace') || 'workspace';
  const timestamp = new Date().toISOString().slice(0, 10);
  const fileName = `${workspaceName}-stock-research-${timestamp}.zip`;

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function readMarkdownEntriesFromImport(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'md') {
    return [{ path: file.name, content: await file.text() }];
  }

  if (extension !== 'zip') {
    throw new Error('Unsupported file type. Please upload a .md or .zip file.');
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries: Array<{ path: string; content: string }> = [];

  const eocdOffset = findEndOfCentralDirectoryOffset(bytes, view);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);

  if (centralDirectoryOffset + centralDirectorySize > bytes.length) {
    throw new Error('ZIP file is malformed or truncated.');
  }

  let offset = centralDirectoryOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('ZIP central directory entry is malformed.');
    }

    const generalPurposeBitFlag = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;

    if (fileNameEnd > bytes.length) {
      throw new Error('ZIP central directory entry is malformed.');
    }

    const entryName = decoder.decode(bytes.slice(fileNameStart, fileNameEnd));
    const isMarkdown = entryName.toLowerCase().endsWith('.md') && !entryName.endsWith('/');

    if (isMarkdown) {
      if ((generalPurposeBitFlag & 0x1) !== 0) {
        throw new Error(`ZIP entry is encrypted and cannot be imported: ${entryName}`);
      }

      if (localHeaderOffset + 30 > bytes.length || view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
        throw new Error(`ZIP local header is malformed for entry: ${entryName}`);
      }

      const localFileNameLength = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
      const contentStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
      const contentEnd = contentStart + compressedSize;

      if (contentEnd > bytes.length) {
        throw new Error('ZIP file is malformed or truncated.');
      }

      const rawContent = bytes.slice(contentStart, contentEnd);
      let decodedContent: string;

      if (compressionMethod === 0) {
        decodedContent = decoder.decode(rawContent);
      } else if (compressionMethod === 8) {
        decodedContent = decoder.decode(await inflateRaw(rawContent));
      } else {
        throw new Error(`ZIP entry uses unsupported compression method (${compressionMethod}): ${entryName}`);
      }

      entries.push({ path: entryName, content: decodedContent });
    }

    offset = fileNameEnd + extraLength + commentLength;
  }

  return entries;
}
