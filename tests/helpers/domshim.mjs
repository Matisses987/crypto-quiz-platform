// 最小 DOM shim：让成品 HTML 的界面脚本能在 node 里跑冒烟流程（仅测试用）。
export function createDom(options) {
  const opts = options || {};
  const registry = new Map();
  const listeners = [];
  const checkedInputs = [];
  const lookup = new Map();

  function makeClassList(node) {
    return {
      add(name) {
        const set = new Set(String(node.className || "").split(/\s+/).filter(Boolean));
        set.add(name);
        node.className = Array.from(set).join(" ");
      },
      remove(name) {
        const set = new Set(String(node.className || "").split(/\s+/).filter(Boolean));
        set.delete(name);
        node.className = Array.from(set).join(" ");
      },
      contains(name) {
        return String(node.className || "").split(/\s+/).indexOf(name) >= 0;
      },
    };
  }

  function makeElement(tag, id) {
    const node = {
      tagName: String(tag || "div").toUpperCase(),
      id: id || "",
      innerHTML: "",
      textContent: "",
      className: "",
      style: {},
      value: "",
      checked: false,
      files: [],
      children: [],
      clickCount: 0,
      focus() {},
      setSelectionRange() {},
      appendChild(child) { this.children.push(child); return child; },
      removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; },
      addEventListener(type, handler) { listeners.push({ node: this, type, handler }); },
      removeEventListener() {},
      setAttribute(name, value) { this["attr_" + name] = value; },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(this, "attr_" + name) ? this["attr_" + name] : null; },
      click() { this.clickCount += 1; },
      // querySelector 返回惰性桩节点（真实 DOM 里存在对应节点；桩节点上的事件监听为空操作）
      querySelector(selector) {
        if (lookup.has(selector)) return lookup.get(selector);
        if (!this.__lazy) this.__lazy = new Map();
        if (!this.__lazy.has(selector)) this.__lazy.set(selector, makeElement("div"));
        return this.__lazy.get(selector);
      },
      querySelectorAll(selector) {
        if (selector === "input[name=\"opt\"]:checked" || selector === 'input[name="opt"]:checked') return checkedInputs.slice();
        if (selector === 'input[name="mockOpt"]:checked' || selector === "input[name=\"mockOpt\"]:checked") return checkedInputs.slice();
        const value = lookup.get(selector);
        return Array.isArray(value) ? value : [];
      },
    };
    node.classList = makeClassList(node);
    Object.defineProperty(node, "firstChild", {
      get() {
        if (!this.__first) this.__first = makeElement("div");
        return this.__first;
      },
    });
    return node;
  }

  function getElementById(id) {
    if (lookup.has(id)) return lookup.get(id);
    if (lookup.has("#" + id)) return lookup.get("#" + id);
    if (!registry.has(id)) {
      const node = makeElement("div", id);
      registry.set(id, node);
    }
    return registry.get(id);
  }

  const navButtons = ["home", "setup", "wrongbook", "stats", "team", "io", "mock", "review"].map((key) => {
    const node = makeElement("button");
    node.setAttribute("data-nav", key);
    return node;
  });

  const document = {
    readyState: "complete",
    getElementById,
    createElement: (tag) => makeElement(tag),
    addEventListener(type, handler) { listeners.push({ node: null, type, handler }); },
    querySelector(selector) {
      if (lookup.has(selector)) return lookup.get(selector);
      return makeElement("div");
    },
    querySelectorAll(selector) {
      if (selector === "#nav button") return navButtons.slice();
      if (selector === 'input[name="opt"]:checked') return checkedInputs.slice();
      if (selector === 'input[name="mockOpt"]:checked') return checkedInputs.slice();
      const value = lookup.get(selector);
      return Array.isArray(value) ? value : [];
    },
    body: makeElement("body"),
  };

  const storageMap = new Map(Object.entries(opts.storage || {}));
  const localStorage = {
    getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
    setItem: (key, value) => { storageMap.set(key, String(value)); },
    removeItem: (key) => { storageMap.delete(key); },
    get length() { return storageMap.size; },
    key: (index) => Array.from(storageMap.keys())[index],
  };

  const window = {
    document,
    localStorage,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
    URL: { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} },
    Blob: class Blob { constructor(parts) { this.parts = parts; } },
    console,
    addEventListener(type, handler) { listeners.push({ node: window, type, handler }); },
    removeEventListener(type, handler) {
      const index = listeners.findIndex((entry) => entry.node === window && entry.type === type && entry.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
  };

  const context = {
    document,
    window,
    localStorage,
    console: { log() {}, error() {}, warn() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL: window.URL,
    Blob: window.Blob,
    FileReader: class FileReader { readAsText() { this.onerror && this.onerror(); } },
  };

  return {
    document,
    window,
    context,
    navButtons,
    registry,
    storageMap,
    getElementById,
    makeElement,
    /** 注册 selector -> 元素，供 querySelector/querySelectorAll 命中 */
    register(selector, value) { lookup.set(selector, value); },
    /** 模拟已勾选的作答控件 */
    setChecked(values) {
      checkedInputs.length = 0;
      for (const value of values) {
        const node = makeElement("input");
        node.value = value;
        node.checked = true;
        checkedInputs.push(node);
      }
    },
    /** 触发某个节点上注册的事件（例如状态筛选 select 的 change） */
    fire(node, type, event) {
      const target = listeners.filter((entry) => entry.node === node && entry.type === type);
      for (const entry of target) entry.handler(event || { target: node, preventDefault() {} });
      return target.length;
    },
    fireDocument(type, event) {
      const target = listeners.filter((entry) => entry.node === null && entry.type === type);
      for (const entry of target) entry.handler(event || { target: { tagName: "DIV" }, preventDefault() {} });
      return target.length;
    },
    /** 触发 window 上的事件（beforeunload / pagehide 等） */
    fireWindow(type, event) {
      const target = listeners.filter((entry) => entry.node === window && entry.type === type);
      for (const entry of target) entry.handler(event || { type });
      return target.length;
    },
    window,
  };
}
