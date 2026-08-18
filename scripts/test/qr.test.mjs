/**
 * Verifies the hand-rolled QR encoder against a real decoder.
 *
 * A QR code that renders as plausible-looking blocks but does not decode is
 * worse than no QR code at all — you would only find out standing in a hallway
 * pointing a phone at a terminal. jsQR is an independent implementation, so this
 * is a genuine round-trip check rather than testing the encoder against itself.
 *
 * Run: node --test scripts/test/qr.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { buildQr } from '../pair.mjs';

/** Render modules to RGBA pixels at `scale`, with a quiet zone, for jsQR. */
function toPixels(modules, scale = 4, quiet = 4) {
  const size = modules.length;
  const dim = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);

  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      const dark = mx >= 0 && mx < size && my >= 0 && my < size && modules[my][mx] === 1;
      const value = dark ? 0 : 255;
      const i = (y * dim + x) * 4;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return { data, width: dim, height: dim };
}

function roundTrip(text) {
  const modules = buildQr(text);
  assert.ok(modules, `encoder returned nothing for ${text.length} chars`);
  const { data, width, height } = toPixels(modules);
  const decoded = jsQR(data, width, height);
  return decoded?.data ?? null;
}

test('a tailnet URL round-trips through a real decoder', () => {
  const url = 'https://laptop.tailnet.ts.net';
  assert.equal(roundTrip(url), url);
});

test('a URL with an explicit port round-trips', () => {
  const url = 'https://my-desktop.tail9c2f1.ts.net:8787';
  assert.equal(roundTrip(url), url);
});

test('a loopback dev URL round-trips', () => {
  const url = 'http://127.0.0.1:8787';
  assert.equal(roundTrip(url), url);
});

test('a long hostname still round-trips', () => {
  const url = 'https://franz-jason-dolores-work-laptop.tail1a2b3c.ts.net';
  assert.equal(roundTrip(url), url);
});

test('encoder reports failure rather than emitting a broken code when text is too long', () => {
  // Beyond version 10 at EC level L, which is all this encoder supports.
  const tooLong = `https://example.com/${'x'.repeat(400)}`;
  assert.equal(buildQr(tooLong), null);
});

test('modules are square and a valid QR dimension', () => {
  const modules = buildQr('https://laptop.tailnet.ts.net');
  const size = modules.length;
  for (const row of modules) assert.equal(row.length, size);
  // Versions 1..10 → 21, 25, … 57 modules per side.
  assert.equal((size - 17) % 4, 0);
  assert.ok(size >= 21 && size <= 57);
});

test('every module is a definite 0 or 1 — no unfilled cells', () => {
  const modules = buildQr('https://laptop.tailnet.ts.net');
  for (const [r, row] of modules.entries()) {
    for (const [c, cell] of row.entries()) {
      assert.ok(cell === 0 || cell === 1, `module ${r},${c} is ${String(cell)}`);
    }
  }
});
