/**
 * app.js 的 Node 测试夹具：用宽松的假 DOM 把整页脚本跑起来，
 * 只通过它暴露的 window.__lumina* 接口驱动（Agent 工具、导出快照、storage 事件）。
 * 多个「标签页」共享同一个 localStorage Map，storage 事件由测试手动投递。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WWW = path.join(__dirname, "..", "www");
const APP_SRC = fs.readFileSync(path.join(WWW, "app.js"), "utf8");
const TOOLS_SRC = fs.readFileSync(path.join(WWW, "agent-tools.js"), "utf8");

/** 未知属性一律给一个「什么都能点」的替身：可调用（返回新元素）、可继续取属性。 */
function deepFake() {
  const fn = function () {
    return fakeElement("div");
  };
  return new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => 0;
      if (typeof k === "symbol" || k === "then") return undefined;
      if (k in t) return t[k];
      return deepFake();
    },
    apply: () => fakeElement("div"),
  });
}

function fakeElement(tag = "div") {
  const listeners = new Map();
  const classes = new Set();
  const attrs = new Map();
  const base = {
    tagName: String(tag).toUpperCase(),
    style: new Proxy(
      { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" },
      { get: (t, k) => (k in t ? t[k] : ""), set: (t, k, v) => ((t[k] = v), true) }
    ),
    dataset: {},
    hidden: false,
    disabled: false,
    value: "",
    checked: false,
    textContent: "",
    innerHTML: "",
    children: [],
    childNodes: [],
    options: [],
    parentNode: null,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : Boolean(force);
        if (on) classes.add(c);
        else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
    addEventListener: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    removeEventListener: () => {},
    dispatchEvent: () => true,
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    hasAttribute: (k) => attrs.has(k),
    appendChild(child) {
      return child;
    },
    append() {},
    prepend() {},
    insertBefore(child) {
      return child;
    },
    removeChild(child) {
      return child;
    },
    replaceChildren() {},
    remove() {},
    contains: () => false,
    closest: () => null,
    matches: () => false,
    querySelector: () => fakeElement("div"),
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    focus() {},
    blur() {},
    click() {},
    select() {},
    scrollIntoView() {},
    animate: () => ({ finished: Promise.resolve(), cancel() {}, onfinish: null }),
    getContext: () => null,
    cloneNode() {
      return fakeElement(tag);
    },
    offsetWidth: 0,
    offsetHeight: 0,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
  return new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === "symbol" || k === "then") return undefined;
      return deepFake();
    },
  });
}

function makeClock() {
  let offset = 0;
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  return {
    Date: FakeDate,
    advance(ms) {
      offset += ms;
    },
  };
}

function makeStorageMap(map) {
  const m = map || new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    get length() {
      return m.size;
    },
    key: (i) => Array.from(m.keys())[i] ?? null,
    _map: m,
  };
}

/**
 * 加载一个 app.js 实例（一个「标签页」）。
 * opts.storage: 共享的 localStorage 对象；opts.clickup: window.luminaClickUp 替身；
 * opts.confirm: window.confirm 返回值。
 */
function loadApp(opts = {}) {
  const storage = opts.storage || makeStorageMap();
  // 可拨的时钟：clock.advance(ms) 让番茄钟「过去」一段时间
  const clock = opts.clock || makeClock();
  const windowListeners = new Map();
  const docEls = new Map();
  const document = {
    readyState: "complete",
    hidden: false,
    visibilityState: "visible",
    documentElement: fakeElement("html"),
    body: fakeElement("body"),
    head: fakeElement("head"),
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
    createElement: (tag) => fakeElement(tag),
    createElementNS: (_ns, tag) => fakeElement(tag),
    createDocumentFragment: () => fakeElement("fragment"),
    createTextNode: () => fakeElement("text"),
    getElementById(id) {
      if (!docEls.has(id)) docEls.set(id, fakeElement("div"));
      return docEls.get(id);
    },
    querySelector(sel) {
      if (!docEls.has(sel)) docEls.set(sel, fakeElement("div"));
      return docEls.get(sel);
    },
    querySelectorAll: () => [],
  };
  const toasts = [];
  const sandbox = {
    console: opts.console || { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    // 夹具里的计时器全部 unref：页面自带的闲置/台词循环不该拖住测试进程
    setTimeout: (fn, ms, ...a) => {
      const t = setTimeout(fn, ms, ...a);
      t.unref?.();
      return t;
    },
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: (fn) => {
      const t = setTimeout(fn, 0);
      t.unref?.();
      return t;
    },
    cancelAnimationFrame() {},
    queueMicrotask,
    localStorage: storage,
    document,
    location: { protocol: "https:", href: "https://app.test/", hash: "", search: "" },
    navigator: { maxTouchPoints: 0, userAgent: "node", language: "zh-CN" },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    innerWidth: 390,
    innerHeight: 844,
    Image: class {
      constructor() {
        this.onload = null;
        this.onerror = null;
      }
      set src(_v) {}
    },
    Blob: class {
      constructor(parts) {
        this.parts = parts;
      }
    },
    URL: Object.assign(function (...a) { return new URL(...a); }, {
      createObjectURL: () => "blob:test",
      revokeObjectURL() {},
    }),
    Intl,
    Date: clock.Date,
    Math,
    JSON,
    Promise,
    Map,
    Set,
    crypto: { randomUUID: () => require("crypto").randomUUID() },
    confirm: () => (opts.confirm === undefined ? true : opts.confirm),
    alert() {},
    CSS: { escape: (s) => String(s) },
    Notification: undefined,
    luminaClickUp: opts.clickup,
    toast: undefined,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = (name, fn) => {
    if (!windowListeners.has(name)) windowListeners.set(name, []);
    windowListeners.get(name).push(fn);
  };
  sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = () => true;
  if (opts.beforeLoad) opts.beforeLoad(sandbox);
  vm.createContext(sandbox);
  vm.runInContext(TOOLS_SRC, sandbox, { filename: "agent-tools.js" });
  vm.runInContext(APP_SRC, sandbox, { filename: "app.js" });
  const toastEl = document.getElementById("toastMsg");
  return {
    sandbox,
    storage,
    clock,
    toasts,
    agent: sandbox.__luminaAgent,
    invoke: (name, args) => sandbox.__luminaAgent.invoke(name, args || {}),
    /** 把一次外部写入作为 storage 事件投递给本页 */
    deliverStorage(key, newValue) {
      for (const fn of windowListeners.get("storage") || []) fn({ key, newValue });
    },
    lastToast: () => toastEl.textContent,
  };
}

module.exports = { loadApp, makeStorageMap, makeClock, fakeElement };
