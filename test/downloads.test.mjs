import test from 'node:test';
import assert from 'node:assert/strict';
import { isDownloadControl, normalizeSourcePage, safeDownloadFilename, safeDownloadFolder, sameSourcePage } from '../lib/downloads.js';

test('download folder stays relative and within Chrome Downloads', () => {
  assert.equal(safeDownloadFolder('Reports/2026'), 'Reports/2026');
  assert.equal(safeDownloadFolder('../../Reports'), 'Reports');
  assert.equal(safeDownloadFolder('C:\\Users\\Alice\\Desktop'), 'C_/Users/Alice/Desktop');
  assert.equal(safeDownloadFolder(''), 'TabPilot');
});

test('download filenames use a safe basename', () => {
  assert.equal(safeDownloadFilename('C:\\tmp\\quarterly report.pdf'), 'quarterly report.pdf');
  assert.equal(safeDownloadFilename('CON.txt'), '_CON.txt');
  assert.equal(safeDownloadFilename(''), 'download');
});

test('only links or controls that look like downloads get download waiting behavior', () => {
  assert.equal(isDownloadControl({ label: 'Continue', download: '' }), false);
  assert.equal(isDownloadControl({ label: 'Download invoice', download: '' }), true);
  assert.equal(isDownloadControl({ label: 'Invoice', href: 'https://files.example/invoice.pdf' }), true);
  assert.equal(isDownloadControl({ label: 'Export report' }), true);
});

test('download routing matches only an HTTP(S) source page path', () => {
  assert.equal(normalizeSourcePage('https://example.com/reports?session=private#row'), 'https://example.com/reports');
  assert.equal(normalizeSourcePage('chrome://downloads'), '');
  assert.equal(sameSourcePage('https://example.com/reports?x=1', 'https://example.com/reports?x=2'), true);
  assert.equal(sameSourcePage('https://example.com/other', 'https://example.com/reports'), false);
});
