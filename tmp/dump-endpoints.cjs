/* eslint-disable no-console */
const fs = require('node:fs')
const vm = require('node:vm')

let code = fs.readFileSync(new URL('./main.dart.js', `file://${__dirname}/`), 'utf8')

// main.dart.js is an IIFE; inject a hook at the end to export internal tables.
const hook = ';globalThis.__dump={u:typeof u!=="undefined"?u:undefined,A:typeof A!=="undefined"?A:undefined,B:typeof B!=="undefined"?B:undefined};'
const idx = code.lastIndexOf('})();')
if (idx !== -1) {
  code = code.slice(0, idx) + hook + code.slice(idx)
}

// Minimal DOM-ish stubs to let the script run far enough to initialize
// its constant tables. We expect it to throw eventually.
const context = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  TextDecoder,
  TextEncoder,
  URL,
  self: {},
  window: {},
  globalThis: {},
  navigator: {
    vendor: 'Google Inc.',
    userAgent: 'node',
  },
  document: {
    baseURI: 'https://cp2nus.evs.com.sg/',
    head: { append() {} },
    createElement() {
      return { getContext() { return null }, style: {}, setAttribute() {}, addEventListener() {} }
    },
  },
}
context.window = context
context.globalThis = context
context.self = context

let thrown
try {
  vm.runInNewContext(code, context, { timeout: 20000 })
} catch (e) {
  thrown = e
}

const dump = context.__dump
if (!dump?.u) {
  console.error('Failed to extract u; first error:', thrown ? String(thrown) : '<none>')
  process.exit(1)
}

const u = dump.u

for (const k of ['y', 'i', 'n', 'J', 'F', 'd']) {
  try {
    console.log(`u.${k}=`, u[k])
  } catch (e) {
    console.log(`u.${k}=<error>`, String(e))
  }
}
