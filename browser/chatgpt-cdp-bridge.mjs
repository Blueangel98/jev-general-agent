import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const DEFAULT_CDP = "http://127.0.0.1:9222";
const cdpUrl = String(process.env.JEV_BROWSER_CDP_URL || DEFAULT_CDP).replace(/\/$/, "");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpJson(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method }, response => {
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
    request.end();
  });
}

async function createChatGptPage() {
  // Open a real temporary conversation at the browser level. Opening the
  // bare ChatGPT root can restore the last conversation into the new tab,
  // which makes the send-state checks ambiguous and can leave an old answer
  // attached to the new task.
  return httpJson(`${cdpUrl}/json/new?https://chatgpt.com/?temporary-chat=true`, "PUT");
}

async function closePreviousChatGptPages(exceptId = "") {
  const targets = await httpJson(`${cdpUrl}/json/list`);
  const pages = targets.filter(item =>
    item.type === "page" && item.id !== exceptId && /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//i.test(item.url || "")
  );
  for (const page of pages) {
    try { await httpJson(`${cdpUrl}/json/close/${encodeURIComponent(page.id)}`); }
    catch { /* A page may already be closing; continue with the fresh tab. */ }
  }
  // Chrome may report a closing target for a short period.  Do not create or
  // select the next task tab until the old ChatGPT page has actually gone.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const remaining = (await httpJson(`${cdpUrl}/json/list`)).filter(item =>
      item.type === "page" && item.id !== exceptId && /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//i.test(item.url || "")
    );
    if (remaining.length === 0) return;
    await sleep(250);
  }
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 15000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
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

  async evaluateObject(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: false,
      awaitPromise: true
    });
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
    }
    return result?.result?.objectId || null;
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

async function withPage(callback, { fresh = false } = {}) {
  let created = null;
  if (fresh) {
    // Create the replacement first.  Closing the only existing ChatGPT page
    // first can terminate Chrome itself, making /json/new fail with ECONNREFUSED.
    created = await createChatGptPage();
    await sleep(3000);
    await closePreviousChatGptPages(created.id || "");
  }
  const target = created?.webSocketDebuggerUrl || created?.type === "page"
    ? created
    : await targetPage();
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

// Do not read assistant text while ChatGPT is still generating.  This state
// intentionally contains only DOM/control metadata; the response body is
// fetched with PAGE_STATE only after an explicit generation -> idle transition.
const PAGE_CONTROL_STATE = `(() => {
  const body = document.body?.innerText || "";
  const composers = [...document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]')]
    .filter(element => element.offsetParent !== null && !element.disabled);
  const composer = composers.at(-1);
  const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const buttons = [...document.querySelectorAll('button')]
    .filter(button => button.offsetParent !== null)
    .map(button => ({
      disabled: button.disabled,
      label: button.getAttribute("aria-label") || "",
      testid: button.getAttribute("data-testid") || "",
      text: (button.innerText || "").slice(0, 80)
    }));
  const stopButton = buttons.some(button =>
    /stop generating|stop response|yanıtı durdur|oluşturmayı durdur|durdur/i.test(
      button.label + " " + button.testid + " " + button.text
    )
  );
  const streamingMarker = Boolean(document.querySelector(
    '[aria-busy="true"], [data-is-streaming="true"], [data-streaming="true"], [data-state="streaming"], [class*="result-streaming"], [class*="streaming"]'
  ));
  const composerBusy = composer?.getAttribute("aria-busy") === "true";
  const loginText = /log in|sign up|giri[sş]|kay[ıi]t ol/i.test(body) && !composer;
  return {
    url: location.href,
    loggedIn: Boolean(composer) && !loginText,
    composer: Boolean(composer),
    composerLength: composer ? String(composer.value || composer.innerText || composer.textContent || "").length : 0,
    assistantCount: assistants.length,
    generating: stopButton || streamingMarker || composerBusy,
    generationEvidence: { stopButton, streamingMarker, composerBusy }
  };
})()`;

async function status() {
  return withPage(async client => client.evaluate(PAGE_STATE));
}

async function attachPromptFile(client, content) {
  const filePath = path.join(
    os.tmpdir(),
    `jev-chatgpt-task-${process.pid}-${Date.now()}.txt`
  );
  fs.writeFileSync(filePath, content, "utf8");

  await client.call("DOM.enable");
  await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find(candidate => /dosya ve daha fazlasını ekle|attach file|upload/i.test(
        candidate.getAttribute("aria-label") || candidate.innerText || ""
      ));
    if (button) button.click();
    return Boolean(button);
  })()`);

  const deadline = Date.now() + 10000;
  let inputObjectId = null;
  while (Date.now() < deadline && !inputObjectId) {
    inputObjectId = await client.evaluateObject(
      `document.querySelector('input[type="file"]')`
    );
    if (!inputObjectId) await sleep(250);
  }
  if (!inputObjectId) {
    fs.rmSync(filePath, { force: true });
    throw new Error("ChatGPT file-upload input was not found");
  }

  try {
    await client.call("DOM.setFileInputFiles", {
      objectId: inputObjectId,
      files: [filePath]
    });
  } catch (error) {
    fs.rmSync(filePath, { force: true });
    throw new Error(`ChatGPT text-file attachment failed: ${error.message}`);
  }
  // ChatGPT may show the document card before its upload state has settled.
  // Give the composer time to promote the attachment to a sendable item.
  await sleep(Number(process.env.JEV_BROWSER_ATTACHMENT_SETTLE_MS || 10000));
  return filePath;
}

async function send(prompt) {
  if (process.env.JEV_BROWSER_ALLOW_TRANSMIT !== "1") {
    throw new Error("Browser transmission is disabled; set JEV_BROWSER_ALLOW_TRANSMIT=1 after user approval");
  }
  let promptFilePath = null;
  try {
    return await withPage(async client => {
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

    const temporaryToggle = await client.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find(candidate => /geçici sohbet|temporary chat/i.test(candidate.getAttribute("aria-label") || candidate.innerText || ""));
      if (!button) return { found: false };
      const active = button.getAttribute("aria-pressed") === "true" || /active|selected|pressed/i.test(button.className || "");
      if (!active) button.click();
      return { found: true, clicked: !active, activeBefore: active };
    })()`);
    if (!temporaryToggle.found) throw new Error("ChatGPT temporary-chat control was not found");
    await sleep(400);

    // Chrome/ChatGPT can restore an unsent draft into a newly created tab.
    // A fresh page is not necessarily an empty composer, so clear it before
    // attaching a task file or inserting the next prompt.
    const restoredDraftLength = before.composerValueLength || 0;
    if (restoredDraftLength > 0) {
      const draftFocused = await client.evaluate(`(() => {
        const element = [...document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]')]
          .filter(candidate => candidate.offsetParent !== null && !candidate.disabled).at(-1);
        if (!element) return false;
        element.focus();
        return true;
      })()`);
      if (!draftFocused) throw new Error("ChatGPT restored a draft but its composer could not be focused");
      await client.call("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
      await client.call("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
      await client.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      await client.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      await sleep(300);
      let cleared = await client.evaluate(PAGE_CONTROL_STATE);
      if (cleared.composerLength > 0) {
        await client.evaluate(`(() => {
          const element = [...document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]')]
            .filter(candidate => candidate.offsetParent !== null && !candidate.disabled).at(-1);
          if (!element) return false;
          element.focus();
          document.execCommand("selectAll");
          document.execCommand("delete");
          return true;
        })()`);
        await sleep(300);
        cleared = await client.evaluate(PAGE_CONTROL_STATE);
      }
      if (cleared.composerLength > 0) {
        throw new Error(`ChatGPT restored an unsent draft that could not be cleared (length ${cleared.composerLength})`);
      }
    }

    const usePromptFile = prompt.length >= Number(process.env.JEV_BROWSER_FILE_THRESHOLD || 12000);
    let composerPrompt = prompt;
    if (usePromptFile) {
      promptFilePath = await attachPromptFile(client, prompt);
      composerPrompt = "Read the attached UTF-8 task file completely before acting. Follow every instruction in it and return only the exact JSON patch plan shape requested there. Do not answer from a partial read.";
    }

    const focused = await client.evaluate(`(() => {
      const element = [...document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]')]
        .filter(candidate => candidate.offsetParent !== null && !candidate.disabled).at(-1);
      if (!element) return false;
      element.focus();
      return true;
    })()`);
    if (!focused) throw new Error("ChatGPT composer was not found");

    // A single Input.insertText call can time out on a large code-generation
    // prompt even though Chrome has already inserted part of the text.  Send
    // bounded chunks and verify the composer after insertion before trying to
    // submit; otherwise the code below is never reached and the visible tab
    // is left with an unsent prompt.
    const inputChunkSize = 2048;
    for (let offset = 0; offset < composerPrompt.length; offset += inputChunkSize) {
      await client.call("Input.insertText", {
        text: composerPrompt.slice(offset, offset + inputChunkSize)
      });
      await sleep(40);
    }
    const entered = await client.evaluate(`(() => {
      const composer = [...document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]')]
        .filter(candidate => candidate.offsetParent !== null && !candidate.disabled).at(-1);
      return {
        found: Boolean(composer),
        length: composer ? String(composer.value || composer.innerText || composer.textContent || "").length : 0
      };
    })()`);
    if (!entered.found || entered.length < Math.max(1, Math.floor(composerPrompt.length * 0.98))) {
      throw new Error(`ChatGPT composer did not receive the complete prompt (expected ${composerPrompt.length}, got ${entered.length})`);
    }

    // Temporary-chat activation and file attachment can change the URL before
    // submission. Establish the baseline only after the complete prompt is
    // present so a navigation caused by the actual send is unambiguous.
    const submissionBaseline = await client.evaluate(PAGE_CONTROL_STATE);
    const sendDeadline = Date.now() + 15000;
    let clicked = false;
    let submissionAttempts = 0;
    while (Date.now() < sendDeadline && !clicked) {
      const observedBeforeSubmit = await client.evaluate(PAGE_CONTROL_STATE);
      if (observedBeforeSubmit.assistantCount > submissionBaseline.assistantCount ||
        observedBeforeSubmit.url !== submissionBaseline.url ||
        observedBeforeSubmit.generating ||
        observedBeforeSubmit.composerLength < Math.max(1, Math.floor(composerPrompt.length * 0.5))) {
        clicked = true;
        break;
      }
      if (submissionAttempts >= 3) {
        await sleep(500);
        continue;
      }
      const sendState = await client.evaluate(`(() => {
        const composer = [...document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]')]
          .filter(candidate => candidate.offsetParent !== null && !candidate.disabled).at(-1);
        const form = composer?.closest("form");
        const button = form?.querySelector('button[type="submit"]') || document.querySelector('button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="Gönder"], button[aria-label*="Prompt gönder"]');
        return {
          found: Boolean(button),
          disabled: Boolean(button?.disabled),
          composerLength: composer ? String(composer.value || composer.innerText || composer.textContent || "").length : 0,
          rect: button ? (() => { const r = button.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height }; })() : null
        };
      })()`);
      if (sendState.found && !sendState.disabled && sendState.composerLength > 0) {
        submissionAttempts += 1;
        await client.evaluate(`(() => {
          const composer = [...document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]')]
            .filter(candidate => candidate.offsetParent !== null && !candidate.disabled).at(-1);
          const form = composer?.closest("form");
          const button = form?.querySelector('button[type="submit"]') || document.querySelector('button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="Gönder"], button[aria-label*="Prompt gönder"]');
          if (!button || button.disabled) return false;
          button.scrollIntoView({ block: "center", inline: "center" });
          button.focus();
          button.click();
          return true;
        })()`);
        await sleep(1000);
        const afterClick = await client.evaluate(PAGE_CONTROL_STATE);
        clicked = afterClick.assistantCount > submissionBaseline.assistantCount ||
          afterClick.url !== submissionBaseline.url ||
          afterClick.generating ||
          afterClick.composerLength < Math.max(1, Math.floor(composerPrompt.length * 0.5));
        if (!clicked) {
          // A DOM click can be ignored by React when a file attachment has
          // just completed. Use a real browser input event at the current
          // button center, then verify the same submission evidence.
          if (sendState.rect?.width > 0 && sendState.rect?.height > 0) {
            await client.call("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: sendState.rect.x,
              y: sendState.rect.y
            });
            await client.call("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: sendState.rect.x,
              y: sendState.rect.y,
              button: "left",
              clickCount: 1
            });
            await client.call("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: sendState.rect.x,
              y: sendState.rect.y,
              button: "left",
              clickCount: 1
            });
            await sleep(1000);
            const afterMouseClick = await client.evaluate(PAGE_CONTROL_STATE);
            clicked = afterMouseClick.assistantCount > submissionBaseline.assistantCount ||
              afterMouseClick.url !== submissionBaseline.url ||
              afterMouseClick.generating ||
              afterMouseClick.composerLength < Math.max(1, Math.floor(composerPrompt.length * 0.5));
          }
        }
        if (!clicked) {
          // React/ProseMirror builds can ignore a native click while focus is
          // still inside the editor. Dispatch the complete keyboard event
          // sequence on the live composer before falling back to CDP Enter.
          await client.evaluate(`(() => {
            const composer = [...document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]')]
              .filter(candidate => candidate.offsetParent !== null && !candidate.disabled).at(-1);
            if (!composer) return false;
            composer.focus();
            for (const type of ["keydown", "keypress", "keyup"]) {
              composer.dispatchEvent(new KeyboardEvent(type, {
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true,
                composed: true
              }));
            }
            return true;
          })()`);
          await sleep(1000);
          const afterKeyboard = await client.evaluate(PAGE_CONTROL_STATE);
          clicked = afterKeyboard.assistantCount > submissionBaseline.assistantCount ||
            afterKeyboard.url !== submissionBaseline.url ||
            afterKeyboard.generating ||
            afterKeyboard.composerLength < Math.max(1, Math.floor(composerPrompt.length * 0.5));
        }
        if (!clicked) {
          // Some ChatGPT builds expose the button but do not route a synthetic
          // click through the React form handler.  Request submission directly
          // and verify it again instead of assuming the click worked.
          await client.evaluate(`(() => {
            const composer = [...document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]')]
              .filter(candidate => candidate.offsetParent !== null && !candidate.disabled).at(-1);
            const form = composer?.closest("form");
            const button = form?.querySelector('button[type="submit"]') || document.querySelector('button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="Gönder"], button[aria-label*="Prompt gönder"]');
            if (form && button && !button.disabled && typeof form.requestSubmit === "function") form.requestSubmit(button);
            return Boolean(form && button);
          })()`);
          await sleep(1000);
          const afterRequestSubmit = await client.evaluate(PAGE_CONTROL_STATE);
          clicked = afterRequestSubmit.assistantCount > submissionBaseline.assistantCount ||
            afterRequestSubmit.url !== submissionBaseline.url ||
            afterRequestSubmit.generating ||
            afterRequestSubmit.composerLength < Math.max(1, Math.floor(composerPrompt.length * 0.5));
        }
      }
      if (!clicked) await sleep(250);
    }
    if (!clicked) {
      // Enter is only a fallback after the button was given time to become
      // enabled.  This avoids silently inserting a newline into the prompt.
      await client.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await client.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await sleep(1000);
      const submitted = await client.evaluate(PAGE_CONTROL_STATE);
      if (submitted.assistantCount <= submissionBaseline.assistantCount &&
        submitted.url === submissionBaseline.url &&
        !submitted.generating &&
        submitted.composerLength >= Math.max(1, Math.floor(composerPrompt.length * 0.5))) {
        throw new Error("ChatGPT prompt was entered but the send action was not confirmed");
      }
    }

    // ChatGPT may spend several minutes reasoning or writing code. Do not
    // classify a still-running response as a failed synthesis too early.
    const deadline = Date.now() + Number(process.env.JEV_BROWSER_RESPONSE_TIMEOUT_MS || 3600000);
    let sawAssistant = false;
    let sawGenerating = false;
    let idlePolls = 0;
    while (Date.now() < deadline) {
      await sleep(1000);
      const control = await client.evaluate(PAGE_CONTROL_STATE);
      if (control.assistantCount > before.assistantCount) sawAssistant = true;
      if (control.generating) {
        sawGenerating = true;
        idlePolls = 0;
        continue;
      }
      if (sawAssistant && sawGenerating) {
        idlePolls += 1;
        // Require two idle polls after observing a real generation state.
        // Only now is assistant text read, so partial streaming content cannot
        // be mistaken for a completed patch plan.
        if (idlePolls >= 2) {
          const current = await client.evaluate(PAGE_STATE);
          if (current.assistantCount > before.assistantCount && current.lastAssistant) {
            return { before, after: current, temporaryChat: temporaryToggle, response: current.lastAssistant };
          }
        }
      }
    }
    throw new Error("ChatGPT response timed out before a verified generation-complete state was available");
    }, { fresh: true });
  } finally {
    if (promptFilePath) fs.rmSync(promptFilePath, { force: true });
  }
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
