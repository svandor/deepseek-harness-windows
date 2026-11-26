/**
 * dsh-browser/cdp — minimál DevTools-protokoll kliens (függőség nélkül).
 *
 * A Node 22+ globális `WebSocket`-jére épül; a protokoll JSON üzenetekkel megy.
 * A kliens NEM tud az oldalról: csak `send`/`once`/`evaluate` és a lapműveletek.
 *
 * Miért saját: a repóban bizonyított minta a `.test-dsh-home\probe-hero.mjs`
 * (ugyanez a mechanizmus, 14 KB-ban, már képernyőképet is készített a felületről)
 * — így nincs új npm-függőség, ami a sandboxban EPERM-mel elhalna.
 */

/** Egy CDP küldemény-válasz pár alapértelmezett várakozása. */
const SEND_TIMEOUT_MS = 30000;

/**
 * CDP kliens egy cél (page) WebSocket-végpontjára.
 * @param {string} wsUrl
 * @param {{WebSocketImpl?: typeof WebSocket, onEvent?: (method: string, params: object) => void, sendTimeoutMs?: number}} [options]
 */
export function createCdpClient(wsUrl, options = {}) {
  const Impl = options.WebSocketImpl ?? globalThis.WebSocket;
  if (typeof Impl !== "function") throw new Error("ehhez a Node-verzióhoz nincs WebSocket (Node 22+ kell)");
  const socket = new Impl(wsUrl);
  const pending = new Map();
  const handlers = new Map();
  const events = [];
  let nextId = 0;
  let closed = false;

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`CDP WebSocket hiba: ${wsUrl}`)), { once: true });
    socket.addEventListener("close", () => {
      closed = true;
      for (const entry of pending.values()) entry.reject(new Error("a CDP kapcsolat lezárult"));
      pending.clear();
    }, { once: true });
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof message?.id === "number") {
      const entry = pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method}: ${String(message.error.message ?? "CDP hiba")}`));
      else entry.resolve(message.result ?? {});
      return;
    }
    if (typeof message?.method === "string") {
      const params = message.params ?? {};
      events.push({ method: message.method, params });
      if (events.length > 400) events.shift();
      for (const listener of handlers.get(message.method) ?? []) {
        try {
          listener(params);
        } catch {
          /* egy hibás figyelő ne vigye el a többit */
        }
      }
      try {
        options.onEvent?.(message.method, params);
      } catch {
        /* a diagnosztika nem hathat a működésre */
      }
    }
  });

  /**
   * Egy CDP hívás.
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  function send(method, params) {
    if (closed) return Promise.reject(new Error(`a CDP kapcsolat zárt (${method})`));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP időtúllépés: ${method}`));
      }, options.sendTimeoutMs ?? SEND_TIMEOUT_MS);
      pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      try {
        socket.send(JSON.stringify({ id, method, params: params ?? {} }));
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /**
   * Egy esemény bevárása (a hívás ELŐTT kell feliratkozni, hogy ne maradjon le).
   * @param {string} method
   * @param {number} [timeoutMs]
   * @returns {Promise<object>}
   */
  function once(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const set = handlers.get(method) ?? new Set();
      const listener = (params) => {
        cleanup();
        resolve(params);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`nem jött meg a(z) ${method} esemény`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        set.delete(listener);
        handlers.set(method, set);
      };
      set.add(listener);
      handlers.set(method, set);
    });
  }

  /** @returns {Promise<void>} */
  async function close() {
    closed = true;
    try {
      socket.close();
    } catch {
      /* már zárt */
    }
  }

  return { ready, send, once, close, events, get closed() { return closed; } };
}

/**
 * A lap magas szintű műveletei egy CDP kliensen.
 * @param {ReturnType<typeof createCdpClient>} client
 */
export function createPage(client) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** @returns {Promise<void>} */
  async function enable() {
    await client.send("Page.enable", {});
    await client.send("Runtime.enable", {});
  }

  /**
   * JS kifejezés kiértékelése az oldalon (JSON értékkel tér vissza).
   * @param {string} expression
   * @returns {Promise<any>}
   */
  async function evaluate(expression) {
    const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result?.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails;
      throw new Error(`oldal-hiba: ${String(detail?.exception?.description ?? detail?.text ?? "evaluate hiba")}`);
    }
    return result?.result?.value;
  }

  /**
   * A dokumentum kész állapotának bevárása (SPA-knál is használható).
   * @param {number} [timeoutMs]
   * @returns {Promise<boolean>}
   */
  async function waitReady(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if ((await evaluate("document.readyState")) === "complete") {
          await sleep(180); // egy rövid ülepedés a kliens-oldali renderelésnek
          return true;
        }
      } catch {
        /* az oldal még tölt */
      }
      await sleep(120);
    }
    return false;
  }

  /**
   * Navigálás + kész állapot.
   *
   * FONTOS (mért hiba, 2026-11-26): a `Page.navigate` után a `waitReady`
   * AZONNAL igazat adhat, mert az ELŐZŐ dokumentum `readyState`-je még
   * „complete" — ilyenkor a hívó a régi/félig töltött lapon olvas (üres `h1`,
   * üres szöveg). Ezért előbb a `Page.loadEventFired` eseményt várjuk be
   * (a feliratkozás a navigate ELŐTT történik, hogy ne maradjunk le róla),
   * és csak utána nézzük a `readyState`-et.
   * @param {string} url
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<{url: string, title: string, ready: boolean}>}
   */
  async function navigate(url, options = {}) {
    const timeoutMs = options.timeoutMs ?? 20000;
    const loaded = client.once("Page.loadEventFired", Math.min(timeoutMs, 15000)).catch(() => null);
    await client.send("Page.navigate", { url });
    await loaded;
    const ready = await waitReady(Math.max(2000, timeoutMs - 2000));
    const info = await evaluate("({ url: location.href, title: document.title })");
    return { url: String(info?.url ?? url), title: String(info?.title ?? ""), ready };
  }

  /**
   * Nézet beállítása (a képernyőkép méretéhez).
   * @param {number} width
   * @param {number} height
   * @returns {Promise<void>}
   */
  async function setViewport(width, height) {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
  }

  /**
   * Egy elem szövege/tulajdonságai.
   * @param {string} selector
   * @param {"text"|"html"|"value"|"attrs"|"exists"} [mode]
   * @returns {Promise<any>}
   */
  async function readElement(selector, mode = "text") {
    const sel = JSON.stringify(selector);
    const expression = `(() => {
      const el = document.querySelector(${sel});
      if (el === null) return null;
      switch (${JSON.stringify(mode)}) {
        case "html": return el.outerHTML;
        case "value": return el.value ?? null;
        case "attrs": return Array.from(el.attributes).reduce((acc, a) => { acc[a.name] = a.value; return acc; }, {});
        case "exists": return true;
        default: return el.innerText ?? el.textContent ?? "";
      }
    })()`;
    return evaluate(expression);
  }

  /**
   * Kattintás: valódi egér-esemény a középpontra, `el.click()` tartalékkal.
   * @param {string} selector
   * @returns {Promise<{clicked: string, method: "mouse"|"js"}>}
   */
  async function click(selector) {
    const sel = JSON.stringify(selector);
    const box = await evaluate(`(() => {
      const el = document.querySelector(${sel});
      if (el === null) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height };
    })()`);
    if (box === null || box === undefined) throw new Error(`nincs ilyen elem: ${selector}`);
    if (box.width > 0 && box.height > 0) {
      const point = { x: box.x, y: box.y };
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      await client.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
      return { clicked: selector, method: "mouse" };
    }
    // Láthatatlan (0 méretű) elem: programozott kattintás — a React is látja.
    await evaluate(`(() => { const el = document.querySelector(${sel}); el.click(); return true; })()`);
    return { clicked: selector, method: "js" };
  }

  /**
   * Szöveg beírása (framework-kompatibilis `input`/`change` eseménnyel).
   * @param {string} selector
   * @param {string} text
   * @param {{enter?: boolean}} [options]
   * @returns {Promise<{typed: string}>}
   */
  async function typeText(selector, text, options = {}) {
    const sel = JSON.stringify(selector);
    const payload = JSON.stringify(text);
    const ok = await evaluate(`(() => {
      const el = document.querySelector(${sel});
      if (el === null) return false;
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter !== undefined) setter.call(el, ${payload});
      else el.value = ${payload};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    if (ok !== true) throw new Error(`nincs ilyen elem: ${selector}`);
    if (options.enter === true) {
      for (const type of ["keyDown", "keyUp"]) {
        await client.send("Input.dispatchKeyEvent", {
          type,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: type === "keyDown" ? "\r" : undefined
        });
      }
    }
    return { typed: text };
  }

  /**
   * Képernyőkép PNG-ként (base64 → a hívó írja fájlba).
   * @param {{fullPage?: boolean, selector?: string}} [options]
   * @returns {Promise<{base64: string, width: number, height: number}>}
   */
  async function screenshot(options = {}) {
    if (typeof options.selector === "string" && options.selector !== "") {
      const sel = JSON.stringify(options.selector);
      const box = await evaluate(`(() => {
        const el = document.querySelector(${sel});
        if (el === null) return null;
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`);
      if (box === null || box === undefined) throw new Error(`nincs ilyen elem: ${options.selector}`);
      const shot = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 }
      });
      return { base64: String(shot.data ?? ""), width: Math.round(box.width), height: Math.round(box.height) };
    }
    if (options.fullPage === true) {
      const metrics = await client.send("Page.getLayoutMetrics", {});
      const size = metrics?.cssContentSize ?? metrics?.contentSize ?? { width: 1440, height: 900 };
      const shot = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
      });
      return { base64: String(shot.data ?? ""), width: Math.ceil(size.width), height: Math.ceil(size.height) };
    }
    const shot = await client.send("Page.captureScreenshot", { format: "png" });
    return { base64: String(shot.data ?? ""), width: 0, height: 0 };
  }

  /**
   * A konzol-sorok (a kliens gyűjti az eseményekből).
   * @param {number} [limit]
   * @returns {string[]}
   */
  function consoleLines(limit = 30) {
    const lines = [];
    for (const event of client.events) {
      if (event.method === "Runtime.consoleAPICalled") {
        const args = Array.isArray(event.params?.args) ? event.params.args : [];
        const text = args.map((entry) => String(entry?.value ?? entry?.description ?? entry?.type ?? "?")).join(" ");
        lines.push(`${String(event.params?.type ?? "log")}: ${text}`);
      } else if (event.method === "Runtime.exceptionThrown") {
        const detail = event.params?.exceptionDetails ?? {};
        lines.push(`exception: ${String(detail?.exception?.description ?? detail?.text ?? "?")}`);
      }
    }
    return lines.map((line) => line.slice(0, 500)).slice(-limit);
  }

  return { enable, evaluate, waitReady, navigate, setViewport, readElement, click, typeText, screenshot, consoleLines };
}
