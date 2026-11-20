/*
 * Headless GPU verification: launches Chromium, loads the real page over a
 * local static server and runs the same self-test module the page uses,
 * reading actual WebGL framebuffer pixels. No mocks of the renderer.
 *
 * Usage: node test/run-gpu.js [parallel-erp|ods]
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
      fs.readFile(p, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const mode = process.argv[2] || 'parallel-erp';
  const srv = await serve();
  const port = srv.address().port;
  const localLibs = [
    path.join(ROOT, 'vendor/root/usr/lib/aarch64-linux-gnu'),
    path.join(ROOT, 'vendor/root/lib/aarch64-linux-gnu')
  ].filter(fs.existsSync);
  process.env.LD_LIBRARY_PATH = localLibs.concat(process.env.LD_LIBRARY_PATH || '').join(':');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const failures = [];
  page.on('console', (m) => { if (m.type() === 'error') failures.push('console.error: ' + m.text()); });
  page.on('pageerror', (e) => failures.push('pageerror: ' + e.message));

  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.__PV && window.__PV.renderer', { timeout: 15000 });
  // Let the first frames build their static ray-cast assets.
  await new Promise(r => setTimeout(r, 500));

  const cpu = await page.evaluate(() => window.__PV.runCpu());
  const gpu = await page.evaluate((m) => window.__PV.runGpu({ stereoMode: m }), mode);

  console.log('=== CPU suite ===');
  for (const r of cpu.results) console.log(`${r.pass ? 'PASS' : 'FAIL'} - ${r.name}${r.detail ? ' (' + r.detail + ')' : ''}`);
  console.log(`\n=== GPU suite (stereoMode=${mode}) ===`);
  for (const r of gpu.results) console.log(`${r.pass ? 'PASS' : 'FAIL'} - ${r.name}${r.detail ? ' (' + r.detail + ')' : ''}`);
  console.log(`\nCPU ${cpu.pass}/${cpu.total}, GPU ${gpu.pass}/${gpu.total}`);
  if (failures.length) console.log('\nBROWSER ISSUES:\n' + failures.join('\n'));

  // Put the live application into the tested convention so the capture shows
  // that mode's real rendering (its own generator + shader path), then let a
  // couple of animation frames paint before reading the framebuffer.
  await page.evaluate((m) => window.__PV.setStereoMode(m), mode);
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(ROOT, `test/screenshot-${mode}.png`) });
  await browser.close();
  srv.close();

  const ok = cpu.allPass && gpu.allPass && failures.length === 0;
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
