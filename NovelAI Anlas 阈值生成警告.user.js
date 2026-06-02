// ==UserScript==
// @name         NovelAI Anlas Threshold Guard
// @namespace    https://example.local/
// @version      1.0.0
// @description  在 NovelAI 图片生成按钮被点击时读取页面显示的 Anlas 消耗，超过自定义阈值则弹出确认警告，取消确认会拦截本次生成。
// @author       Adonais
// @match        https://novelai.net/image*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'nai_anlas_threshold_guard_v1';
  const DEFAULTS = {
    enabled: true,
    threshold: 0,
    customCostSelector: '',
    showDock: true,
  };

  let state = loadState();
  let dock = null;
  let lastDetection = null;

  function loadState() {
    try {
      return { ...DEFAULTS, ...(GM_getValue(STORAGE_KEY, {}) || {}) };
    } catch (err) {
      console.warn('[NAI Anlas Guard] Failed to load settings.', err);
      return { ...DEFAULTS };
    }
  }

  function saveState() {
    try {
      GM_setValue(STORAGE_KEY, state);
    } catch (err) {
      console.warn('[NAI Anlas Guard] Failed to save settings.', err);
    }
  }

  function isGuardUi(el) {
    return !!el?.closest?.('#nai-anlas-guard-dock');
  }

  function isVisible(el) {
    if (!el || isGuardUi(el)) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function textOf(el) {
    return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function parseNumberFromText(text) {
    const normalized = String(text || '').replace(/,/g, '').trim();
    const exact = normalized.match(/^-?\d+(?:\.\d+)?$/);
    if (exact) return Number(exact[0]);

    const withAnlas = normalized.match(/(?:anlas|消耗|花费|cost)[^\d-]*(-?\d+(?:\.\d+)?)/i)
      || normalized.match(/(-?\d+(?:\.\d+)?)[^\d]*(?:anlas|消耗|花费|cost)/i);
    return withAnlas ? Number(withAnlas[1]) : NaN;
  }

  function getGenerateButtonFromTarget(target) {
    const button = target?.closest?.('button');
    if (!button || !isVisible(button)) return null;
    const text = textOf(button);
    if (!/Generate/i.test(text)) return null;
    if (/Cancel|Generating|Queue|Queued|Waiting|Stop/i.test(text)) return null;
    return button;
  }

  function getCurrentGenerateButton() {
    return Array.from(document.querySelectorAll('button'))
      .filter(isVisible)
      .find(button => /Generate/i.test(textOf(button)) && !/Cancel|Generating|Queue|Queued|Waiting|Stop/i.test(textOf(button))) || null;
  }

  function getLeafTextElements() {
    return Array.from(document.querySelectorAll('span, div, p, strong, b'))
      .filter(el => isVisible(el) && textOf(el) && Array.from(el.children).every(child => !textOf(child)));
  }

  function buildCandidate(el, source, generateButton) {
    const value = parseNumberFromText(textOf(el));
    if (!Number.isFinite(value)) return null;
    const rect = el.getBoundingClientRect();
    const buttonRect = generateButton?.getBoundingClientRect?.();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    let distance = 100000;
    if (buttonRect) {
      const buttonX = buttonRect.left + buttonRect.width / 2;
      const buttonY = buttonRect.top + buttonRect.height / 2;
      distance = Math.hypot(centerX - buttonX, centerY - buttonY);
    }

    const ancestryText = textOf(el.closest('section, aside, form, [role="dialog"], [class]') || el.parentElement || el);
    let score = 0;
    if (/anlas/i.test(ancestryText)) score += 1000;
    if (/cost|消耗|花费/i.test(ancestryText)) score += 250;
    if (source === 'custom selector') score += 2000;
    if (source === 'anlas label') score += 1200;
    if (source === 'nearest number') score += Math.max(0, 400 - distance);
    if (value < 0) score -= 500;
    if (value > 100000) score -= 500;

    return { value, el, source, score, distance };
  }

  function detectFromCustomSelector(generateButton) {
    const selector = String(state.customCostSelector || '').trim();
    if (!selector) return null;
    try {
      const el = document.querySelector(selector);
      return el && !isGuardUi(el) && isVisible(el) ? buildCandidate(el, 'custom selector', generateButton) : null;
    } catch (err) {
      console.warn('[NAI Anlas Guard] Invalid custom Anlas selector:', selector, err);
      return null;
    }
  }

  function detectFromAnlasLabels(generateButton) {
    const labelNodes = Array.from(document.querySelectorAll('body *'))
      .filter(el => isVisible(el) && /anlas/i.test(textOf(el)));
    const candidates = [];

    for (const label of labelNodes) {
      const scopes = [label, label.parentElement, label.parentElement?.parentElement, label.closest('section, aside, form, [class]')]
        .filter(Boolean);
      for (const scope of scopes) {
        for (const el of scope.querySelectorAll('span, div, p, strong, b')) {
          const candidate = buildCandidate(el, 'anlas label', generateButton);
          if (candidate) candidates.push(candidate);
        }
      }
    }

    return candidates.sort((a, b) => b.score - a.score)[0] || null;
  }

  function detectNearestNumericLeaf(generateButton) {
    const candidates = getLeafTextElements()
      .map(el => buildCandidate(el, 'nearest number', generateButton))
      .filter(Boolean)
      .filter(candidate => candidate.value >= 0 && candidate.distance < 600)
      .sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  function detectAnlasCost() {
    const generateButton = getCurrentGenerateButton();
    const candidates = [
      detectFromCustomSelector(generateButton),
      detectFromAnlasLabels(generateButton),
      detectNearestNumericLeaf(generateButton),
    ].filter(Boolean).sort((a, b) => b.score - a.score);

    lastDetection = candidates[0] || null;
    return lastDetection;
  }

  function shouldBlockGeneration() {
    if (!state.enabled) return false;

    const threshold = Number(state.threshold);
    if (!Number.isFinite(threshold)) return false;

    const detection = detectAnlasCost();
    if (!detection || !Number.isFinite(detection.value)) {
      const proceedWithoutReading = window.confirm(
        'NovelAI Anlas 阈值警告：未能可靠读取当前页面显示的 Anlas 消耗。\n\n'
        + `当前阈值：${threshold}\n\n`
        + '点击“确定”继续生成；点击“取消”拦截本次生成。'
      );
      return !proceedWithoutReading;
    }

    if (detection.value <= threshold) return false;

    const proceed = window.confirm(
      'NovelAI Anlas 阈值警告：本次生成显示的 Anlas 消耗超过阈值。\n\n'
      + `检测值：${detection.value}\n`
      + `阈值：${threshold}\n`
      + `来源：${detection.source}\n\n`
      + '点击“确定”仍然生成；点击“取消”拦截本次生成。'
    );
    return !proceed;
  }

  function interceptGenerateClick(event) {
    const generateButton = getGenerateButtonFromTarget(event.target);
    if (!generateButton) return;

    if (shouldBlockGeneration()) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      updateDock();
    }
  }

  function promptThreshold() {
    const raw = window.prompt('设置 Anlas 警告阈值：当检测到的 Anlas 消耗大于该值时弹出警告。', String(state.threshold));
    if (raw == null) return;

    const value = Number(raw.trim());
    if (!Number.isFinite(value) || value < 0) {
      window.alert('阈值必须是大于或等于 0 的数字。');
      return;
    }

    state.threshold = value;
    saveState();
    updateDock();
  }

  function promptCustomSelector() {
    const raw = window.prompt(
      '可选：填写用于读取 Anlas 数值的 CSS selector。\n留空则自动从包含 Anlas 的区域或 Generate 按钮附近的数字中识别。',
      state.customCostSelector || ''
    );
    if (raw == null) return;

    state.customCostSelector = raw.trim();
    saveState();
    updateDock();
  }

  function toggleEnabled() {
    state.enabled = !state.enabled;
    saveState();
    updateDock();
  }

  function toggleDock() {
    state.showDock = !state.showDock;
    saveState();
    updateDock();
  }

  function updateDock() {
    if (!state.showDock) {
      dock?.remove();
      dock = null;
      return;
    }

    const detection = detectAnlasCost();
    const valueText = detection ? `${detection.value} (${detection.source})` : '未检测到';

    if (!dock) {
      dock = document.createElement('div');
      dock.id = 'nai-anlas-guard-dock';
      dock.innerHTML = `
        <div class="nai-anlas-guard-title">Anlas Guard</div>
        <div class="nai-anlas-guard-row">状态：<button type="button" data-action="toggle-enabled"></button></div>
        <div class="nai-anlas-guard-row">阈值：<button type="button" data-action="threshold"></button></div>
        <div class="nai-anlas-guard-row">当前：<span data-role="current"></span></div>
        <div class="nai-anlas-guard-actions">
          <button type="button" data-action="selector">Selector</button>
          <button type="button" data-action="hide">隐藏</button>
        </div>
      `;
      document.body.appendChild(dock);
      dock.addEventListener('click', event => {
        const action = event.target?.dataset?.action;
        if (action === 'toggle-enabled') toggleEnabled();
        if (action === 'threshold') promptThreshold();
        if (action === 'selector') promptCustomSelector();
        if (action === 'hide') toggleDock();
      });
    }

    dock.querySelector('[data-action="toggle-enabled"]').textContent = state.enabled ? '启用' : '停用';
    dock.querySelector('[data-action="threshold"]').textContent = String(state.threshold);
    dock.querySelector('[data-role="current"]').textContent = valueText;
  }

  function registerMenuCommands() {
    GM_registerMenuCommand('设置 Anlas 阈值', promptThreshold);
    GM_registerMenuCommand('设置 Anlas CSS selector', promptCustomSelector);
    GM_registerMenuCommand('启用/停用 Anlas Guard', toggleEnabled);
    GM_registerMenuCommand('显示/隐藏 Anlas Guard 面板', toggleDock);
  }

  GM_addStyle(`
    #nai-anlas-guard-dock {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      min-width: 190px;
      padding: 10px 12px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 12px;
      background: rgba(20, 20, 28, 0.92);
      color: #f7f7fb;
      font: 12px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(8px);
    }
    #nai-anlas-guard-dock .nai-anlas-guard-title {
      margin-bottom: 6px;
      font-weight: 700;
      color: #ffcf70;
    }
    #nai-anlas-guard-dock .nai-anlas-guard-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin: 4px 0;
    }
    #nai-anlas-guard-dock .nai-anlas-guard-actions {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    #nai-anlas-guard-dock button {
      cursor: pointer;
      border: 1px solid rgba(255, 255, 255, 0.22);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.1);
      color: inherit;
      padding: 2px 7px;
      font: inherit;
    }
    #nai-anlas-guard-dock button:hover {
      background: rgba(255, 255, 255, 0.18);
    }
  `);

  document.addEventListener('click', interceptGenerateClick, true);
  registerMenuCommands();
  updateDock();
  window.setInterval(updateDock, 1500);
})();
