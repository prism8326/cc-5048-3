/* Node runner for the pure-math suite: node test/run-cpu.js */
'use strict';
const st = require('../src/selftest');
const summary = st.summary(st.cpuSuite());
for (const r of summary.results) {
  console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.name + (r.detail ? ' (' + r.detail + ')' : ''));
}
console.log(`\n${summary.pass}/${summary.total} passed`);
process.exit(summary.allPass ? 0 : 1);
