/**
 * Deterministic, zero-dependency Chrome Web Store / AMO ZIP builder for `extension/`.
 * Strips the unpacked-dev `key` from `manifest.json` without mutating `extension/manifest.json`.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

const DOS_DATE_1980 = 0x0021;
const UTF8_FLAG = 0x0800;
const DEFLATE_METHOD = 8;
const UNIX_MODE_0644 = (0o100644 << 16) >>> 0;
const EXCLUDED = /(^\.|\/\.|Thumbs\.db$|\.map$|\.test\.[cm]?[jt]s$)/;

function listExtensionFiles(baseDir, relDir = "") {
  const fullDir = relDir ? join(baseDir, relDir) : baseDir;
  return readdirSync(fullDir).sort().flatMap((entry) => {
    const relPath = relDir ? posix.join(relDir, entry) : entry;
    if (EXCLUDED.test(relPath)) return [];
    return statSync(join(baseDir, relPath)).isDirectory()
      ? listExtensionFiles(baseDir, relPath)
      : [relPath];
  });
}

function serializeEntryPayload(extDir, relPath) {
  const raw = readFileSync(join(extDir, relPath));
  if (relPath !== "manifest.json") return raw;
  const manifest = JSON.parse(raw.toString("utf8"));
  delete manifest.key;
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function encodeLocalRecord(nameBuf, raw, compressed, crc) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(DEFLATE_METHOD, 8);
  header.writeUInt16LE(DOS_DATE_1980, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(raw.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  return Buffer.concat([header, nameBuf, compressed]);
}

function encodeCentralRecord(nameBuf, rawLen, compLen, crc, localOffset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(DEFLATE_METHOD, 10);
  header.writeUInt16LE(DOS_DATE_1980, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compLen, 20);
  header.writeUInt32LE(rawLen, 24);
  header.writeUInt16LE(nameBuf.length, 28);
  header.writeUInt32LE(UNIX_MODE_0644, 38);
  header.writeUInt32LE(localOffset, 42);
  return Buffer.concat([header, nameBuf]);
}

function encodeEndRecord(count, centralSize, centralOffset) {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return eocd;
}

function encodeEntryPair(extDir, relPath, offset) {
  const nameBuf = Buffer.from(relPath, "utf8");
  const raw = serializeEntryPayload(extDir, relPath);
  const compressed = deflateRawSync(raw, { level: 9 });
  const crc = crc32(raw) >>> 0;
  const local = encodeLocalRecord(nameBuf, raw, compressed, crc);
  const central = encodeCentralRecord(nameBuf, raw.length, compressed.length, crc, offset);
  return { local, central };
}

export function buildStoreZip(rootDir) {
  const extDir = join(rootDir, "extension");
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const relPath of listExtensionFiles(extDir)) {
    const { local, central } = encodeEntryPair(extDir, relPath, offset);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralBlock = Buffer.concat(centrals);
  return Buffer.concat([...locals, centralBlock, encodeEndRecord(centrals.length, centralBlock.length, offset)]);
}

function decodeCentralEntry(zipBuf, cursor) {
  const method = zipBuf.readUInt16LE(cursor + 10);
  const compLen = zipBuf.readUInt32LE(cursor + 20);
  const nameLen = zipBuf.readUInt16LE(cursor + 28);
  const localOffset = zipBuf.readUInt32LE(cursor + 42);
  const name = zipBuf.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
  const dataStart = localOffset + 30 + zipBuf.readUInt16LE(localOffset + 26) + zipBuf.readUInt16LE(localOffset + 28);
  const slice = zipBuf.subarray(dataStart, dataStart + compLen);
  const next = cursor + 46 + nameLen + zipBuf.readUInt16LE(cursor + 30) + zipBuf.readUInt16LE(cursor + 32);
  return { name, data: method === DEFLATE_METHOD ? inflateRawSync(slice) : Buffer.from(slice), next };
}

export function readZipEntries(zipBuf) {
  const eocdOffset = zipBuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zipBuf.readUInt16LE(eocdOffset + 8);
  let cursor = zipBuf.readUInt32LE(eocdOffset + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    const decoded = decodeCentralEntry(zipBuf, cursor);
    entries.set(decoded.name, decoded.data);
    cursor = decoded.next;
  }
  return entries;
}

function writeCurrentStoreZip() {
  const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(rootDir, "extension", "manifest.json"), "utf8"));
  const outPath = join(rootDir, "store", `agentic-tab-context-${manifest.version}.zip`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buildStoreZip(rootDir));
  process.stdout.write(`${outPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeCurrentStoreZip();
}
