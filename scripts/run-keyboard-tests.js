"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(rootDir, "www/js/mobile-ux.js"), "utf8");

async function load({ native = false, visual = true } = {}) {
  const properties = new Map();
  const classes = new Set();
  const viewportEvents = new Map();
  const windowEvents = new Map();
  const documentEvents = new Map();
  const keyboardEvents = new Map();
  const timers = [];
  const root = {
    style: { setProperty: (key, value) => properties.set(key, value) },
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
    },
    dataset: {},
  };
  const document = {
    documentElement: root,
    readyState: "complete",
    activeElement: null,
    getElementById: () => null,
    querySelector: () => null,
    addEventListener: (name, callback) => documentEvents.set(name, callback),
  };
  const sandbox = {
    document,
    navigator: { maxTouchPoints: 1 },
    innerHeight: 844,
    visualViewport: visual ? {
      height: 844,
      offsetTop: 0,
      addEventListener: (name, callback) => viewportEvents.set(name, callback),
    } : undefined,
    addEventListener: (name, callback) => windowEvents.set(name, callback),
    setTimeout: (callback) => timers.push(callback),
    clearTimeout() {},
    MutationObserver: class { observe() {} },
    Capacitor: native ? {
      Plugins: {
        Keyboard: {
          addListener: async (name, callback) => keyboardEvents.set(name, callback),
        },
      },
    } : undefined,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  await new Promise(setImmediate);
  return {
    sandbox, properties, classes, viewportEvents, windowEvents, documentEvents, keyboardEvents,
    runTimers: () => { while (timers.length) timers.shift()(); },
  };
}

function field(document, id, scroller, top = 600) {
  const input = {
    id, tagName: "INPUT", type: "password", isConnected: true,
    classList: { contains: (name) => name === "settings-input" },
    closest: () => scroller,
    getBoundingClientRect: () => ({
      top: top - scroller.scrollTop, bottom: top + 44 - scroller.scrollTop,
    }),
    scrollIntoView: () => { throw new Error("Must scroll only the settings body"); },
  };
  document.activeElement = input;
  return input;
}

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(rootDir, "capacitor.config.json"), "utf8"));
  assert.equal(config.plugins.Keyboard.resize, "native");
  console.log("✓ iOS resizes the WebView containing fixed chat/settings panels");

  const native = await load({ native: true });
  native.keyboardEvents.get("keyboardWillShow")({ keyboardHeight: 344 });
  native.sandbox.innerHeight = 500;
  native.sandbox.visualViewport.height = 500;
  native.viewportEvents.get("resize")();
  native.keyboardEvents.get("keyboardDidShow")({ keyboardHeight: 344 });
  assert.equal(native.properties.get("--vvh"), "500px");
  assert.equal(native.properties.get("--vvb"), "0px");
  assert.ok(native.classes.has("kb-open"));
  console.log("✓ A resized native WebView does not subtract the keyboard twice");

  native.keyboardEvents.get("keyboardWillHide")();
  native.sandbox.innerHeight = 844;
  native.sandbox.visualViewport.height = 844;
  native.viewportEvents.get("resize")();
  native.keyboardEvents.get("keyboardDidHide")();
  assert.equal(native.properties.get("--vvh"), "844px");
  assert.equal(native.properties.get("--vvb"), "0px");
  assert.ok(!native.classes.has("kb-open"));
  console.log("✓ Hiding the native keyboard restores full height and safe-area state");

  const web = await load();
  web.sandbox.visualViewport.height = 500;
  web.viewportEvents.get("resize")();
  assert.equal(web.properties.get("--vvh"), "500px");
  assert.equal(web.properties.get("--vvb"), "344px");
  assert.ok(web.classes.has("kb-open"));
  web.sandbox.visualViewport.offsetTop = 100;
  web.viewportEvents.get("scroll")();
  assert.equal(web.properties.get("--vvt"), "100px");
  assert.equal(web.properties.get("--vvb"), "244px");
  console.log("✓ Overlay keyboards and viewport panning use actual visible bounds");

  const scroller = { scrollTop: 0, getBoundingClientRect: () => ({ top: 110, bottom: 600 }) };
  const input = field(web.sandbox.document, "setApiKey", scroller);
  web.documentEvents.get("focusin")({ target: input });
  web.runTimers();
  assert.equal(scroller.scrollTop, 56);
  web.sandbox.visualViewport.height = 400;
  web.viewportEvents.get("resize")();
  web.runTimers();
  assert.equal(scroller.scrollTop, 156);
  console.log("✓ Settings fields scroll within the sheet, including later keyboard changes");

  scroller.scrollTop = 0;
  const stale = field(web.sandbox.document, "setCuToken", scroller);
  web.documentEvents.get("focusin")({ target: stale });
  web.sandbox.document.activeElement = null;
  web.runTimers();
  assert.equal(scroller.scrollTop, 0);
  console.log("✓ Pending focus timers cannot jump to a field after focus leaves it");

  const chat = field(web.sandbox.document, "chatInput", scroller);
  web.documentEvents.get("focusin")({ target: chat });
  web.runTimers();
  assert.equal(scroller.scrollTop, 0);
  console.log("✓ The docked chat composer does not scroll the document");

  const fallback = await load({ visual: false });
  fallback.sandbox.innerHeight = 400;
  fallback.windowEvents.get("resize")();
  assert.equal(fallback.properties.get("--vvh"), "400px");
  assert.equal(fallback.properties.get("--vvb"), "0px");
  console.log("✓ Native viewport resizing also works without visualViewport");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
