#!/usr/bin/env node
/**
 * Prints the daemon URL as a QR code so you can open it on your phone without
 * typing a MagicDNS name on a touch keyboard.
 *
 * Deliberately does NOT encode the password or a token. A QR code is shoulder
 * -surfable and ends up in screenshots; it carries only the address, and the
 * password is still typed on the device. Pairing convenience is not worth
 * putting a credential into an image.
 *
 * Zero dependencies: the QR encoder is ~120 lines below, which is cheaper than
 * adding a package to a security-sensitive project.
 *
 * Usage:
 *   node scripts/pair.mjs                    # auto-detect the tailnet URL
 *   node scripts/pair.mjs https://host:8787  # explicit
 */

import { execFileSync } from 'node:child_process';

function detectTailscaleUrl() {
  const candidates = [
    'tailscale',
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    '/usr/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ];
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ['status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const dns = JSON.parse(out)?.Self?.DNSName;
      if (dns) return `https://${dns.replace(/\.$/, '')}`;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/* --------------------------- minimal QR encoder --------------------------- */
/* Byte mode, error correction level L, smallest version that fits.           */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, eccLen) {
  const gen = rsGenerator(eccLen);
  const res = new Array(eccLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < eccLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

// [version, totalCodewords, eccPerBlock, blocks] for EC level L.
const VERSIONS = [
  [1, 26, 7, 1],
  [2, 44, 10, 1],
  [3, 70, 15, 1],
  [4, 100, 20, 1],
  [5, 134, 26, 1],
  [6, 172, 36, 1],
  [7, 196, 40, 2],
  [8, 242, 48, 2],
  [9, 292, 60, 2],
  [10, 346, 72, 2],
];

const ALIGN_PATTERNS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

function pickVersion(byteLen) {
  for (const [version, total, ecc, blocks] of VERSIONS) {
    const dataCodewords = total - ecc * blocks;
    // 4 bits mode + 8 or 16 bits length + payload, rounded up to bytes.
    const lengthBits = version < 10 ? 8 : 16;
    const needed = Math.ceil((4 + lengthBits + byteLen * 8) / 8);
    if (needed <= dataCodewords) return { version, total, ecc, blocks, dataCodewords };
  }
  return null;
}

export function buildQr(text) {
  const bytes = [...Buffer.from(text, 'utf8')];
  const spec = pickVersion(bytes.length);
  if (!spec) return null;

  const { version, ecc, blocks, dataCodewords } = spec;
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  push(0, Math.min(4, dataCodewords * 8 - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  const PAD = [0xec, 0x11];
  let padIndex = 0;
  while (data.length < dataCodewords) data.push(PAD[padIndex++ % 2]);

  // Split into blocks, ECC each, then interleave.
  const perBlock = Math.floor(dataCodewords / blocks);
  const dataBlocks = [];
  const eccBlocks = [];
  let offset = 0;
  for (let b = 0; b < blocks; b++) {
    const size = b < blocks - 1 ? perBlock : dataCodewords - offset;
    const block = data.slice(offset, offset + size);
    offset += size;
    dataBlocks.push(block);
    eccBlocks.push(rsEncode(block, ecc));
  }

  const final = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) final.push(block[i]);
  }
  for (let i = 0; i < ecc; i++) {
    for (const block of eccBlocks) final.push(block[i]);
  }

  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));

  const placeFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const edge = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        modules[rr][cc] = edge !== 2 && edge !== 4 ? 1 : 0;
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  for (const pos of ALIGN_PATTERNS[version]) {
    for (const pos2 of ALIGN_PATTERNS[version]) {
      if (modules[pos][pos2] !== null) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          modules[pos + r][pos2 + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1 ? 1 : 0;
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    if (modules[6][i] === null) modules[6][i] = bit;
    if (modules[i][6] === null) modules[i][6] = bit;
  }

  // Reserve format areas; they are filled after masking.
  const reserved = [];
  for (let i = 0; i < 9; i++) {
    if (modules[8][i] === null) reserved.push([8, i]);
    if (modules[i][8] === null) reserved.push([i, 8]);
  }
  for (let i = 0; i < 8; i++) {
    if (modules[8][size - 1 - i] === null) reserved.push([8, size - 1 - i]);
    if (modules[size - 1 - i][8] === null) reserved.push([size - 1 - i, 8]);
  }
  for (const [r, c] of reserved) modules[r][c] = 0;
  modules[size - 8][8] = 1; // dark module

  // Zigzag data placement, mask 0.
  let bitIndex = 0;
  const dataBits = [];
  for (const byte of final) for (let i = 7; i >= 0; i--) dataBits.push((byte >> i) & 1);

  const isReserved = new Set(reserved.map(([r, c]) => `${r},${c}`));
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      for (const c of [col, col - 1]) {
        const row = ((size - 1 - col) / 2) % 2 === 0 ? size - 1 - i : i;
        if (modules[row][c] !== null && !isReserved.has(`${row},${c}`)) continue;
        if (isReserved.has(`${row},${c}`)) continue;
        const bit = bitIndex < dataBits.length ? dataBits[bitIndex++] : 0;
        // Mask pattern 0: (row + col) % 2 === 0
        modules[row][c] = (row + c) % 2 === 0 ? bit ^ 1 : bit;
      }
    }
  }

  // Format info for EC level L, mask 0.
  const FORMAT_L_MASK0 = 0b111011111000100;
  const formatBits = [];
  for (let i = 14; i >= 0; i--) formatBits.push((FORMAT_L_MASK0 >> i) & 1);

  const formatPositions1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  const formatPositions2 = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];
  formatPositions1.forEach(([r, c], i) => {
    modules[r][c] = formatBits[14 - i];
  });
  formatPositions2.forEach(([r, c], i) => {
    modules[r][c] = formatBits[i];
  });

  return modules;
}

export function render(modules) {
  const size = modules.length;
  const quiet = 2;
  const lines = [];
  // Two rows per line using half-block characters keeps the code square in a
  // terminal, where cells are twice as tall as they are wide.
  for (let row = -quiet; row < size + quiet; row += 2) {
    let line = '';
    for (let col = -quiet; col < size + quiet; col++) {
      const inBounds = (r, c) => r >= 0 && r < size && c >= 0 && c < size;
      const top = inBounds(row, col) ? modules[row][col] : 0;
      const bottom = inBounds(row + 1, col) ? modules[row + 1][col] : 0;
      // Inverted: dark modules render as light blocks on a dark terminal.
      if (top && bottom) line += ' ';
      else if (top) line += '\u2584';
      else if (bottom) line += '\u2580';
      else line += '\u2588';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/* ------------------------------------ CLI ---------------------------------- */

function main() {
  const url = process.argv[2] ?? detectTailscaleUrl();
  if (!url) {
    console.error('Could not determine the daemon URL.');
    console.error('Pass it explicitly:  node scripts/pair.mjs https://laptop.tailnet.ts.net');
    console.error('Or run scripts/setup-tailscale.ps1 first.');
    process.exit(1);
  }

  console.log('');
  const modules = buildQr(url);
  if (modules) {
    console.log(render(modules));
  } else {
    console.log('(URL too long to encode as a QR code here)');
  }
  console.log('');
  console.log(`  ${url}`);
  console.log('');
  console.log('  Scan with your phone, then enter your REY_PASSWORD.');
  console.log('  The QR code contains only this address — no password, no token.');
  console.log('');
}

// Only run the CLI when invoked directly, so tests can import the encoder.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('pair.mjs')) {
  main();
}
