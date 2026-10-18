import { crc32 } from "node:zlib";

/**
 * A strict little ZIP reader for the tests: walks the central directory
 * (ZIP64 aware), cross checks every local header and data descriptor, and
 * verifies each CRC. Throws on anything inconsistent.
 */

export interface ReadEntry {
  name: string;
  data: Buffer;
  crc: number;
  zip64: boolean;
  utf8: boolean;
  mode: number;
}

const U32 = 0xffffffff;

function u64(buffer: Buffer, at: number): number {
  return Number(buffer.readBigUInt64LE(at));
}

function expectSig(buffer: Buffer, at: number, sig: number, what: string): void {
  if (buffer.readUInt32LE(at) !== sig) {
    throw new Error(`bad ${what} signature at ${String(at)}`);
  }
}

export function readZip(buffer: Buffer): ReadEntry[] {
  const endAt = buffer.length - 22;
  expectSig(buffer, endAt, 0x06054b50, "end of central directory");
  let count = buffer.readUInt16LE(endAt + 10);
  let cdSize = buffer.readUInt32LE(endAt + 12);
  let cdOffset = buffer.readUInt32LE(endAt + 16);
  if (count === 0xffff || cdSize === U32 || cdOffset === U32) {
    const locatorAt = endAt - 20;
    expectSig(buffer, locatorAt, 0x07064b50, "zip64 locator");
    const recordAt = u64(buffer, locatorAt + 8);
    expectSig(buffer, recordAt, 0x06064b50, "zip64 end record");
    count = u64(buffer, recordAt + 32);
    cdSize = u64(buffer, recordAt + 40);
    cdOffset = u64(buffer, recordAt + 48);
    if (recordAt !== cdOffset + cdSize) {
      throw new Error("zip64 end record is not right after the central directory");
    }
  } else if (endAt !== cdOffset + cdSize) {
    throw new Error("end record is not right after the central directory");
  }

  const entries: ReadEntry[] = [];
  let at = cdOffset;
  for (let index = 0; index < count; index++) {
    expectSig(buffer, at, 0x02014b50, "central header");
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    let compressed = buffer.readUInt32LE(at + 20);
    let size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const mode = buffer.readUInt32LE(at + 38) >>> 16;
    let offset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    let zip64 = false;
    let extraAt = at + 46 + nameLength;
    const extraEnd = extraAt + extraLength;
    while (extraAt < extraEnd) {
      const id = buffer.readUInt16LE(extraAt);
      const length = buffer.readUInt16LE(extraAt + 2);
      if (id === 0x0001) {
        zip64 = true;
        let field = extraAt + 4;
        if (size === U32) {
          size = u64(buffer, field);
          field += 8;
        }
        if (compressed === U32) {
          compressed = u64(buffer, field);
          field += 8;
        }
        if (offset === U32) {
          offset = u64(buffer, field);
        }
      }
      extraAt += 4 + length;
    }
    if (method !== 0 || compressed !== size) {
      throw new Error(`${name}: not stored`);
    }

    expectSig(buffer, offset, 0x04034b50, "local header");
    const localFlags = buffer.readUInt16LE(offset + 6);
    const localNameLength = buffer.readUInt16LE(offset + 26);
    const localExtraLength = buffer.readUInt16LE(offset + 28);
    const localName = buffer.toString("utf8", offset + 30, offset + 30 + localNameLength);
    if (localName !== name || localFlags !== flags) {
      throw new Error(`${name}: local header disagrees with the central directory`);
    }
    const dataAt = offset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataAt, dataAt + size);
    if (crc32(data) !== crc) {
      throw new Error(`${name}: crc mismatch`);
    }
    if ((flags & 0x0008) !== 0) {
      const descriptorAt = dataAt + size;
      expectSig(buffer, descriptorAt, 0x08074b50, "data descriptor");
      const descriptorCrc = buffer.readUInt32LE(descriptorAt + 4);
      const descriptorSize =
        localExtraLength > 0
          ? u64(buffer, descriptorAt + 16)
          : buffer.readUInt32LE(descriptorAt + 12);
      if (descriptorCrc !== crc || descriptorSize !== size) {
        throw new Error(`${name}: data descriptor disagrees`);
      }
    }
    entries.push({ name, data: Buffer.from(data), crc, zip64, utf8: (flags & 0x0800) !== 0, mode });
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (at !== cdOffset + cdSize) {
    throw new Error("central directory size mismatch");
  }
  return entries;
}
