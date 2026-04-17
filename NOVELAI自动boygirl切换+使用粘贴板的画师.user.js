// ==UserScript==
// @name         NovelAI Clipboard Subject -> Girl + Boy
// @namespace    https://example.local/
// @version      0.1.0
// @description  从剪贴板读取 subject，自动生成 1girl 和 1boy 两张
// @author       Adonais
// @match        https://novelai.net/image*
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    order: ['girl', 'boy'], // 改成 ['boy', 'girl'] 就会先 boy 后 girl
    hotkey: {
      altKey: true,
      shiftKey: true,
      code: 'KeyQ',
    },
    maxWaitMsPerGeneration: 180000, // 每次最多等 3 分钟
    settleAfterClickMs: 1500,
    pollIntervalMs: 1000,
    template: (subject, sex) => `1.5::artist:${subject}::,1${sex}, cowboy_shot,solo,`,
    floatingButtonText: 'Clip → Girl+Boy',
    debug: false,
  };

  let running = false;

  function log(...args) {
    if (CONFIG.debug) console.log('[NAI ClipGen]', ...args);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function isVisible(el) {
    return !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function toast(msg, isError = false) {
    let box = document.getElementById('nai-clipgen-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'nai-clipgen-toast';
      document.body.appendChild(box);
    }
    box.textContent = msg;
    box.style.background = isError ? 'rgba(180,40,40,0.92)' : 'rgba(20,20,30,0.92)';
    box.style.opacity = '1';
    clearTimeout(box._hideTimer);
    box._hideTimer = setTimeout(() => {
      box.style.opacity = '0';
    }, 2600);
  }

  function normalizeSubject(text) {
    return (text || '')
      .replace(/\r\n/g, ' ')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^,+|,+$/g, '')
      .trim();
  }

  function getVisiblePromptEditor() {
    const editors = Array.from(document.querySelectorAll('.ProseMirror[contenteditable="true"]'))
      .filter(isVisible);

    if (!editors.length) return null;

    // 通常当前显示中的 Prompt 编辑器就是唯一可见的 .ProseMirror
    return editors[0];
  }

  function getGenerateButton() {
    const buttons = Array.from(document.querySelectorAll('button')).filter(isVisible);

    // 优先找带有 Generate x Image 的按钮
    let btn = buttons.find(b => /Generate\s+\d+\s+Image/i.test((b.innerText || '').trim()));
    if (btn) return btn;

    // 宽松兜底
    btn = buttons.find(b => /Generate/i.test((b.innerText || '').trim()));
    return btn || null;
  }

  function isButtonBusy(btn) {
    if (!btn) return true;
    const text = (btn.innerText || '').trim();
    if (btn.disabled) return true;
    if (/Cancel|Generating|Queue|Queued|Waiting|Stop/i.test(text)) return true;
    return false;
  }

  function setProseMirrorText(editor, text) {
    if (!editor) throw new Error('找不到 Prompt 编辑器');

    editor.focus();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    let inserted = false;

    // 优先尝试像“真实输入”那样替换文本
    try {
      if (document.execCommand) {
        inserted = document.execCommand('insertText', false, text);
      }
    } catch (e) {
      log('execCommand failed:', e);
    }

    // 如果 execCommand 没成功，直接改 DOM 再派发事件
    const currentText = (editor.innerText || '').replace(/\n/g, '').trim();
    if (!inserted || currentText !== text.trim()) {
      editor.innerHTML = '';
      const p = document.createElement('p');
      p.textContent = text;
      editor.appendChild(p);
    }

    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text,
    }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    editor.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function clickLikeUser(el) {
    if (!el) throw new Error('找不到 Generate 按钮');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.click();
  }

  async function waitUntilGenerationLooksFinished() {
    const startedAt = Date.now();

    await sleep(CONFIG.settleAfterClickMs);

    while (Date.now() - startedAt < CONFIG.maxWaitMsPerGeneration) {
      const btn = getGenerateButton();
      if (btn) {
        const text = (btn.innerText || '').trim();
        const looksReady = /Generate/i.test(text) && !isButtonBusy(btn);
        if (looksReady) {
          return true;
        }
      }
      await sleep(CONFIG.pollIntervalMs);
    }

    throw new Error('等待本轮生成完成超时');
  }

  async function readClipboardText() {
    const text = await navigator.clipboard.readText();
    return normalizeSubject(text);
  }

  async function runSequence() {
    if (running) {
      toast('脚本正在运行中');
      return;
    }

    running = true;
    updateFloatingButton();

    try {
      toast('正在读取剪贴板...');
      const subject = await readClipboardText();

      if (!subject) {
        throw new Error('剪贴板里没有可用内容');
      }

      const editor = getVisiblePromptEditor();
      if (!editor) {
        throw new Error('没找到当前可见的 Prompt 编辑器');
      }

      const btn = getGenerateButton();
      if (!btn) {
        throw new Error('没找到 Generate 按钮');
      }

      toast(`读取到 subject：${subject}`);

      for (let i = 0; i < CONFIG.order.length; i++) {
        const sex = CONFIG.order[i];
        const prompt = CONFIG.template(subject, sex);

        log('setting prompt:', prompt);
        setProseMirrorText(editor, prompt);

        await sleep(300);

        const currentBtn = getGenerateButton();
        clickLikeUser(currentBtn);

        toast(`已提交：1${sex}`);

        await waitUntilGenerationLooksFinished();

        // 两轮之间略等一下，避免界面刚恢复可点就马上第二次
        await sleep(800);
      }

      toast('已完成：girl + boy');
    } catch (err) {
      console.error(err);
      toast(`失败：${err.message}`, true);
    } finally {
      running = false;
      updateFloatingButton();
    }
  }

  function hotkeyMatched(e) {
    return !!(
      e.code === CONFIG.hotkey.code &&
      e.altKey === CONFIG.hotkey.altKey &&
      e.shiftKey === CONFIG.hotkey.shiftKey
    );
  }

  function addFloatingButton() {
    if (document.getElementById('nai-clipgen-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'nai-clipgen-btn';
    btn.type = 'button';
    btn.textContent = CONFIG.floatingButtonText;
    btn.addEventListener('click', runSequence);
    document.body.appendChild(btn);
    updateFloatingButton();
  }

  function updateFloatingButton() {
    const btn = document.getElementById('nai-clipgen-btn');
    if (!btn) return;
    btn.textContent = running ? 'Running...' : CONFIG.floatingButtonText;
    btn.disabled = running;
    btn.style.opacity = running ? '0.75' : '1';
    btn.style.cursor = running ? 'wait' : 'pointer';
  }

  function bindHotkey() {
    window.addEventListener('keydown', (e) => {
      if (!hotkeyMatched(e)) return;
      e.preventDefault();
      e.stopPropagation();
      runSequence();
    }, true);
  }

  function init() {
    addFloatingButton();
    bindHotkey();
    toast('ClipGen 已加载');
  }

  GM_addStyle(`
    #nai-clipgen-btn {
      position: fixed;
      right: 24px;
      bottom: 96px;
      z-index: 999999;
      border: 0;
      border-radius: 999px;
      padding: 10px 14px;
      font-size: 14px;
      line-height: 1;
      background: #f0e7b3;
      color: #222;
      box-shadow: 0 6px 20px rgba(0,0,0,.25);
    }

    #nai-clipgen-toast {
      position: fixed;
      right: 24px;
      bottom: 146px;
      z-index: 999999;
      color: #fff;
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 13px;
      line-height: 1.4;
      box-shadow: 0 6px 20px rgba(0,0,0,.25);
      transition: opacity .2s ease;
      opacity: 0;
      pointer-events: none;
      max-width: 360px;
      white-space: pre-wrap;
      word-break: break-word;
    }
  `);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
