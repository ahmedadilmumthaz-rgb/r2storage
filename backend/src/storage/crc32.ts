// CRC-32 (IEEE 802.3) — table-based, zero dependencies. Node 20 has no built-in
// crc32 (zlib.crc32 landed in Node 22), and a 4-byte checksum isn't worth a
// dependency. Used to verify/emit S3's x-amz-checksum-crc32 header, which
// aws-sdk-v3 sends by default on uploads since 2024.

let TABLE: Uint32Array | null = null;

function table(): Uint32Array {
  if (TABLE) return TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  TABLE = t;
  return t;
}

export class Crc32 {
  private crc = 0xffffffff;

  update(data: Buffer): void {
    const t = table();
    for (let i = 0; i < data.length; i++) {
      this.crc = (t[(this.crc ^ data[i]) & 0xff] ^ (this.crc >>> 8)) >>> 0;
    }
  }

  // Base64 of the 4-byte big-endian CRC, the format S3 uses for the
  // x-amz-checksum-crc32 header.
  digest(): string {
    const c = (this.crc ^ 0xffffffff) >>> 0;
    return Buffer.from([c >>> 24, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff]).toString('base64');
  }
}
