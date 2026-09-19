import fs from "node:fs";
import http from "node:http";

const DEFAULT_CDP = "http://127.0.0.1:9222";
const cdpUrl = String(process.env.JEV_BROWSER_CDP_URL || DEFAULT_CDP).replace(/\/$/, "");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`CDP HTTP ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(new Error(`CDP returned invalid JSON: ${error.message}`)); }
      });
    });
    request.on("error", reject);
  });
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    const WebSocketImpl = globalThis.WebSocket;
    if (!WebSocketImpl) throw new Error("This Node runtime has no WebSocket implementation");
    this.socket = new WebSocketImpl(this.url);
    this.socket.addEventListener("message", event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "CDP command failed"));
      else pending.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timed out")), 10000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connection failed")); }, { once: true });
    });
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
    }
    return result?.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch {}
  }
}

async function targetPage() {
  const targets = await httpJson(`${cdpUrl}/json/list`);
  const target = targets.find(item =>
    item.type === "page" && /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//i.test(item.url || "")
  );
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("No ChatGPT page found in the configured Chrome debugging session");
  }
  return target;
}

async function withPage(callback) {
  const target = await targetPage();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try { return await callback(client, target); }
  finally { client.close(); }
}

const PAGE_STATE = `(() => {
  const body = document.body?.innerText || "";
  const composers = [...document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]')]
    .filter(element => element.offsetParent !== null && !element.disabled);
  const composer = composers.at(-1);
  const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const last = assistants.at(-1);
  const buttons = [...document.querySelectorAll('button')].slice(-30)
    .map(button => ({ disabled: button.disabled, visible: button.offsetParent !== null, label: button.getAttribute("aria-label"), testid: button.getAttribute("data-testid"), text: (button.innerText || "").slice(0, 40) }));
  const loginText = /log in|sign up|giri[sş]|kay[ıi]t ol/i.test(body) && !composer;
  return {
    url: location.href,
    title: document.title,
    loggedIn: Boolean(composer) && !loginText,
    composer: Boolean(composer),
    composerValueLength: composer ? String(composer.value || composer.innerText || "").length : 0,
    composerTag: composer?.tagName || null,
    composerPlaceholder: composer?.getAttribute("placeholder") || null,
    composerOuter: composer?.outerHTML?.slice(0, 800) || null,
    buttons,
    assistantCount: assistants.length,
    lastAssistant: last?.innerText || ""
  };
})()`;

async function status() {
  return withPage(async client => client.evaluate(PAGE_STATE));
}

async function send(prompt) {
  if (process.env.JEV_BROWSER_ALLOW_TRANSMIT !== "1") {
    throw new Error("Browser transmission is disabled; set JEV_BROWSER_ALLOW_TRANSMIT=1 after user approval");
  }
  return withPage(async client => {
    await client.call("Page.bringToFront");
    let before = await client.evaluate(PAGE_STATE);
    for (let attempt = 0; attempt < 20 && !before.composer; attempt++) {
      await sleep(500);
      before = await client.evaluate(PAGE_STATE);
    }
    if (!before.loggedIn || !before.composer) {
      throw new Error("ChatGPT is not ready; complete login and open a new chat first");
    }
    if (before.assistantCount > 0) {
      throw new Error("Open a fresh ChatGPT chat before starting a supervised code task");
    }

    const focused = await client.evaluate(`(() => {
      const element = [...document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]')]
        .filter(candidate => candidate.offsetParent !== null && !candidate.disabled).at(-1);
      if (!element) return false;
      element.focus();
      return true;
    })()`);
    if (!focused) throw new Error("ChatGPT composer was not found");
    await client.call("Input.insertText", { text: prompt });
    const clicked = await client.evaluate(`(() => {
      const composer = [...document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]')]
        .filter(candidate => candidate.offsetParent !== null && !candidate.disabled).at(-1);
      const form = composer?.closest("form");
      const button = form?.querySelector('button[type="submit"]') || document.querySelector('button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="Gönder"]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) {
      await client.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await client.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    }

    const deadline = Date.now() + Number(process.env.JEV_BROWSER_RESPONSE_TIMEOUT_MS || 180000);
    let stable = 0;
    let candidate = "";
    while (Date.now() < deadline) {
      await sleep(1000);
      const current = await client.evaluate(PAGE_STATE);
      const responseChanged = current.assistantCount > before.assistantCount || current.lastAssistant !== before.lastAssistant;
      if (current.lastAssistant && responseChanged) {
        if (current.lastAssistant === candidate) stable += 1;
        else { candidate = current.lastAssistant; stable = 1; }
        if (stable >= 2) return { before, after: current, response: current.lastAssistant };
      }
    }
    throw new Error("ChatGPT response timed out before a stable assistant response was available");
  });
}

async function main() {
  const command = process.argv[2] || "status";
  if (command === "status") {
    process.stdout.write(JSON.stringify(await status(), null, 2));
    return;
  }
  if (command === "send") {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    if (typeof input?.prompt !== "string" || !input.prompt.trim()) throw new Error("stdin JSON must contain a non-empty prompt");
    process.stdout.write(JSON.stringify(await send(input.prompt), null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().then(() => {
  process.exit(0);
}).catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(4);
});
