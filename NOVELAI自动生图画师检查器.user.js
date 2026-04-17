// ==UserScript==
// @name         NovelAI Clipboard Prompt Runner v3.1
// @namespace    https://example.local/
// @version      3.1.0
// @description  从剪贴板读取 subject，按模板 / sex / tags / Quick Runs 自动生成 NovelAI 图片（无脚本内确认弹窗）
// @author       Adonais
// @match        https://novelai.net/image*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'nai_clip_prompt_runner_v31';

  const VALID_RUN_MODES = [
    'single_prompt',
    'sex_split_tags_joined',
    'tag_split_first_sex',
    'full_combo',
  ];

  const DEFAULTS = {
    template: '1.5::artist:${subject}::,1${sex}, cowboy_shot,solo${tagBlock}',
    selectedSexes: ['girl', 'boy'],
    sexOrderFirst: 'girl',
    tagOptions: ['year 2023', 'year 2024', 'year 2025'],
    selectedTags: [],
    runMode: 'sex_split_tags_joined',
    hotkeyEnabled: true,
    hotkey: {
      altKey: true,
      shiftKey: true,
      code: 'KeyQ',
    },
    maxWaitMsPerGeneration: 180000,
    settleAfterClickMs: 1500,
    pollIntervalMs: 1000,
    quickRuns: [
      {
        name: '单girl',
        config: {
          selectedSexes: ['girl'],
          sexOrderFirst: 'girl',
          selectedTags: [],
          runMode: 'sex_split_tags_joined',
        },
      },
      {
        name: '单boy',
        config: {
          selectedSexes: ['boy'],
          sexOrderFirst: 'boy',
          selectedTags: [],
          runMode: 'sex_split_tags_joined',
        },
      },
      {
        name: 'boy+girl',
        config: {
          selectedSexes: ['boy', 'girl'],
          sexOrderFirst: 'boy',
          selectedTags: [],
          runMode: 'sex_split_tags_joined',
        },
      },
      {
        name: 'boy+year 2023',
        config: {
          selectedSexes: ['boy'],
          sexOrderFirst: 'boy',
          selectedTags: ['year 2023'],
          runMode: 'sex_split_tags_joined',
        },
      },
    ],
  };

  let state = null;
  let draft = null;
  let running = false;
  let settingsDialog = null;

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function uniqStrings(arr) {
    return [...new Set((arr || []).map(v => String(v).trim()).filter(Boolean))];
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }

  function normalizeQuickRunConfig(cfg) {
    const out = {};
    if (!cfg || typeof cfg !== 'object') return out;

    if ('template' in cfg) out.template = String(cfg.template ?? '');
    if (Array.isArray(cfg.selectedSexes)) {
      out.selectedSexes = uniqStrings(cfg.selectedSexes).filter(v => v === 'girl' || v === 'boy');
    }
    if ('sexOrderFirst' in cfg) {
      out.sexOrderFirst = cfg.sexOrderFirst === 'boy' ? 'boy' : 'girl';
    }
    if (Array.isArray(cfg.selectedTags)) {
      out.selectedTags = uniqStrings(cfg.selectedTags);
    }
    if ('runMode' in cfg && VALID_RUN_MODES.includes(cfg.runMode)) {
      out.runMode = cfg.runMode;
    }
    return out;
  }

  function mergeState(saved) {
    const merged = deepClone(DEFAULTS);

    if (saved && typeof saved === 'object') {
      if ('template' in saved) merged.template = String(saved.template ?? merged.template);

      if (Array.isArray(saved.selectedSexes)) {
        merged.selectedSexes = uniqStrings(saved.selectedSexes).filter(v => v === 'girl' || v === 'boy');
      }

      if ('sexOrderFirst' in saved) {
        merged.sexOrderFirst = saved.sexOrderFirst === 'boy' ? 'boy' : 'girl';
      }

      if (Array.isArray(saved.tagOptions)) {
        merged.tagOptions = uniqStrings(saved.tagOptions);
      }

      if (Array.isArray(saved.selectedTags)) {
        merged.selectedTags = uniqStrings(saved.selectedTags);
      }

      if ('runMode' in saved && VALID_RUN_MODES.includes(saved.runMode)) {
        merged.runMode = saved.runMode;
      }

      if ('hotkeyEnabled' in saved) merged.hotkeyEnabled = !!saved.hotkeyEnabled;

      if (saved.hotkey && typeof saved.hotkey === 'object') {
        merged.hotkey = {
          altKey: saved.hotkey.altKey !== false,
          shiftKey: saved.hotkey.shiftKey !== false,
          code: saved.hotkey.code || merged.hotkey.code,
        };
      }

      if ('maxWaitMsPerGeneration' in saved) merged.maxWaitMsPerGeneration = Number(saved.maxWaitMsPerGeneration || merged.maxWaitMsPerGeneration);
      if ('settleAfterClickMs' in saved) merged.settleAfterClickMs = Number(saved.settleAfterClickMs || merged.settleAfterClickMs);
      if ('pollIntervalMs' in saved) merged.pollIntervalMs = Number(saved.pollIntervalMs || merged.pollIntervalMs);

      if (Array.isArray(saved.quickRuns)) {
        merged.quickRuns = saved.quickRuns
          .filter(item => item && typeof item.name === 'string' && item.name.trim())
          .map(item => ({
            name: item.name.trim(),
            config: normalizeQuickRunConfig(item.config),
          }));
      }
    }

    if (!merged.selectedSexes.length) {
      merged.selectedSexes = ['girl'];
    }

    if (!VALID_RUN_MODES.includes(merged.runMode)) {
      merged.runMode = DEFAULTS.runMode;
    }

    merged.tagOptions = uniqStrings([...merged.tagOptions, ...merged.selectedTags]);

    return merged;
  }

  function buildEffectiveConfig(baseConfig, overrideConfig) {
    const base = deepClone(baseConfig || state || DEFAULTS);
    const over = normalizeQuickRunConfig(overrideConfig || {});

    if ('template' in over) base.template = over.template;
    if ('selectedSexes' in over) base.selectedSexes = deepClone(over.selectedSexes);
    if ('sexOrderFirst' in over) base.sexOrderFirst = over.sexOrderFirst;
    if ('selectedTags' in over) base.selectedTags = deepClone(over.selectedTags);
    if ('runMode' in over) base.runMode = over.runMode;

    base.tagOptions = uniqStrings([...(base.tagOptions || []), ...(base.selectedTags || [])]);

    return mergeState(base);
  }

  async function gmGet(key, fallback) {
    try {
      const v = GM_getValue(key, fallback);
      if (v && typeof v.then === 'function') return await v;
      return v;
    } catch {
      return fallback;
    }
  }

  async function gmSet(key, value) {
    try {
      const r = GM_setValue(key, value);
      if (r && typeof r.then === 'function') await r;
    } catch (e) {
      console.error('[NAI Runner] save failed', e);
    }
  }

  async function saveState() {
    await gmSet(STORAGE_KEY, state);
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

  function toast(msg, isError = false) {
    let box = document.getElementById('nai-runner-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'nai-runner-toast';
      document.body.appendChild(box);
    }
    box.textContent = msg;
    box.style.background = isError ? 'rgba(180,40,40,0.94)' : 'rgba(20,20,30,0.94)';
    box.style.opacity = '1';
    clearTimeout(box._hideTimer);
    box._hideTimer = setTimeout(() => {
      box.style.opacity = '0';
    }, 2600);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function isVisible(el) {
    return !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function getVisiblePromptEditor() {
    const editors = Array.from(document.querySelectorAll('.ProseMirror[contenteditable="true"]'))
      .filter(isVisible);
    return editors[0] || null;
  }

  function getGenerateButton() {
    const buttons = Array.from(document.querySelectorAll('button')).filter(isVisible);
    let btn = buttons.find(b => /Generate\s+\d+\s+Image/i.test((b.innerText || '').trim()));
    if (btn) return btn;
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
    try {
      if (document.execCommand) {
        inserted = document.execCommand('insertText', false, text);
      }
    } catch (e) {
      console.warn('[NAI Runner] execCommand failed', e);
    }

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

  async function waitUntilGenerationLooksFinished(cfg) {
    const startedAt = Date.now();
    await sleep(cfg.settleAfterClickMs);

    while (Date.now() - startedAt < cfg.maxWaitMsPerGeneration) {
      const btn = getGenerateButton();
      if (btn) {
        const text = (btn.innerText || '').trim();
        const looksReady = /Generate/i.test(text) && !isButtonBusy(btn);
        if (looksReady) return true;
      }
      await sleep(cfg.pollIntervalMs);
    }

    throw new Error('等待本轮生成完成超时');
  }

  async function readClipboardText() {
    const text = await navigator.clipboard.readText();
    return normalizeSubject(text);
  }

  function orderedSexesFromConfig(cfg) {
    const base = cfg.sexOrderFirst === 'boy' ? ['boy', 'girl'] : ['girl', 'boy'];
    return base.filter(sex => (cfg.selectedSexes || []).includes(sex));
  }

  function orderedSelectedTags(cfg) {
    const selected = uniqStrings(cfg.selectedTags || []);
    const options = uniqStrings(cfg.tagOptions || []);
    return [
      ...options.filter(tag => selected.includes(tag)),
      ...selected.filter(tag => !options.includes(tag)),
    ];
  }

  function applyTemplate(template, vars) {
    return String(template || '').replace(/\$\{(\w+)\}/g, (_, key) => {
      return vars[key] == null ? '' : String(vars[key]);
    });
  }

  function buildQueue(cfg, subject) {
    const orderedSexes = orderedSexesFromConfig(cfg);
    const tags = orderedSelectedTags(cfg);

    if (!orderedSexes.length) {
      throw new Error('至少选择一个 sex');
    }

    const queue = [];

    const pushItem = (sex, tagsForThisPrompt) => {
      const joinedTags = (tagsForThisPrompt || []).join(', ');
      const ctx = {
        subject,
        sex,
        tags: joinedTags,
        tag: tagsForThisPrompt?.length === 1 ? tagsForThisPrompt[0] : '',
        tagBlock: joinedTags ? `, ${joinedTags}` : '',
      };
      const prompt = applyTemplate(cfg.template, ctx);
      queue.push({
        sex,
        tags: tagsForThisPrompt || [],
        prompt,
      });
    };

    switch (cfg.runMode) {
      case 'single_prompt': {
        pushItem(orderedSexes[0], tags);
        break;
      }

      case 'sex_split_tags_joined': {
        for (const sex of orderedSexes) {
          pushItem(sex, tags);
        }
        break;
      }

      case 'tag_split_first_sex': {
        const sex = orderedSexes[0];
        if (tags.length) {
          for (const tag of tags) pushItem(sex, [tag]);
        } else {
          pushItem(sex, []);
        }
        break;
      }

      case 'full_combo': {
        if (tags.length) {
          for (const sex of orderedSexes) {
            for (const tag of tags) {
              pushItem(sex, [tag]);
            }
          }
        } else {
          for (const sex of orderedSexes) {
            pushItem(sex, []);
          }
        }
        break;
      }

      default:
        throw new Error('未知运行模式');
    }

    return queue;
  }

  async function runQueue(queue, cfg) {
    if (running) {
      toast('脚本正在运行中');
      return;
    }

    running = true;
    updateDock();

    try {
      const editor = getVisiblePromptEditor();
      if (!editor) throw new Error('没找到当前可见的 Prompt 编辑器');

      const btn = getGenerateButton();
      if (!btn) throw new Error('没找到 Generate 按钮');

      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        setProseMirrorText(editor, item.prompt);
        await sleep(300);

        const currentBtn = getGenerateButton();
        clickLikeUser(currentBtn);

        toast(`已提交 ${i + 1}/${queue.length}: 1${item.sex}${item.tags.length ? ` · ${item.tags.join(', ')}` : ''}`);
        await waitUntilGenerationLooksFinished(cfg);
        await sleep(700);
      }

      toast(`完成，共 ${queue.length} 条`);
    } catch (err) {
      console.error(err);
      toast(`失败：${err.message}`, true);
    } finally {
      running = false;
      updateDock();
    }
  }

  async function runFromClipboardWithConfig(cfg) {
    const subject = await readClipboardText();
    if (!subject) throw new Error('剪贴板里没有可用内容');

    const queue = buildQueue(cfg, subject);
    if (!queue.length) throw new Error('没有生成到任何待跑队列');

    await runQueue(queue, cfg);
  }

  async function runCurrentState() {
    try {
      await runFromClipboardWithConfig(mergeState(state));
    } catch (err) {
      console.error(err);
      toast(`失败：${err.message}`, true);
    }
  }

  async function runQuickRunByIndex(index) {
    try {
      const item = state.quickRuns[index];
      if (!item) return;
      const cfg = buildEffectiveConfig(state, item.config);
      await runFromClipboardWithConfig(cfg);
    } catch (err) {
      console.error(err);
      toast(`失败：${err.message}`, true);
    }
  }

  async function runDraftNow() {
    if (!draft) return;
    try {
      const cfg = mergeState(draft);
      await runFromClipboardWithConfig(cfg);
    } catch (err) {
      console.error(err);
      toast(`失败：${err.message}`, true);
    }
  }

  function hotkeyMatched(e) {
    return !!(
      state.hotkeyEnabled &&
      e.code === state.hotkey.code &&
      e.altKey === state.hotkey.altKey &&
      e.shiftKey === state.hotkey.shiftKey
    );
  }

  function ensureDialogs() {
    if (!settingsDialog) {
      settingsDialog = document.createElement('dialog');
      settingsDialog.id = 'nai-runner-settings-dialog';
      document.body.appendChild(settingsDialog);
      settingsDialog.addEventListener('close', () => {
        draft = null;
      });
    }
  }

  function createDock() {
    if (document.getElementById('nai-runner-dock')) return;

    const dock = document.createElement('div');
    dock.id = 'nai-runner-dock';
    dock.innerHTML = `
      <div id="nai-runner-dock-main"></div>
      <div id="nai-runner-dock-quick"></div>
    `;
    document.body.appendChild(dock);

    updateDock();
  }

  function updateDock() {
    const main = document.getElementById('nai-runner-dock-main');
    const quick = document.getElementById('nai-runner-dock-quick');
    if (!main || !quick) return;

    main.innerHTML = `
      <button type="button" id="nai-runner-run-current" class="nai-btn nai-btn-primary" ${running ? 'disabled' : ''}>
        ${running ? 'Running...' : 'Run Current'}
      </button>
      <button type="button" id="nai-runner-open-settings" class="nai-btn nai-btn-ghost" ${running ? 'disabled' : ''}>
        ⚙
      </button>
    `;

    quick.innerHTML = state.quickRuns.map((item, idx) => `
      <button
        type="button"
        class="nai-btn nai-btn-quick"
        data-quick-run="${idx}"
        title="${escapeAttr(item.name)}"
        ${running ? 'disabled' : ''}
      >${escapeHtml(item.name)}</button>
    `).join('');

    document.getElementById('nai-runner-run-current')?.addEventListener('click', runCurrentState);
    document.getElementById('nai-runner-open-settings')?.addEventListener('click', openSettingsDialog);

    quick.querySelectorAll('[data-quick-run]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.quickRun);
        await runQuickRunByIndex(idx);
      });
    });
  }

  function getRunModeLabel(mode) {
    switch (mode) {
      case 'single_prompt': return '单条运行';
      case 'sex_split_tags_joined': return '按 sex 拆分';
      case 'tag_split_first_sex': return '按 tag 拆分';
      case 'full_combo': return '全组合';
      default: return mode;
    }
  }

  function getQuickRunSummary(item) {
    const cfg = buildEffectiveConfig(state, item.config);
    const sexes = orderedSexesFromConfig(cfg).map(s => `1${s}`).join(' + ');
    const tags = orderedSelectedTags(cfg);
    const tagsText = tags.length ? ` · ${tags.join(', ')}` : '';
    return `${sexes} · ${getRunModeLabel(cfg.runMode)}${tagsText}`;
  }

  function buildDraftFromState() {
    return deepClone(state);
  }

  function openSettingsDialog() {
    ensureDialogs();
    draft = buildDraftFromState();
    renderSettingsDialog();
    settingsDialog.showModal();
    refreshPreviewInSettings();
  }

  function renderSettingsDialog() {
    if (!draft || !settingsDialog) return;

    settingsDialog.innerHTML = `
      <div class="nai-settings-wrap">
        <div class="nai-settings-head">
          <div>
            <h2>NovelAI Prompt Runner</h2>
            <div class="nai-subtle">变量：<code>\${subject}</code> <code>\${sex}</code> <code>\${tags}</code> <code>\${tag}</code> <code>\${tagBlock}</code></div>
          </div>
          <button type="button" class="nai-icon-btn" id="nai-settings-close">×</button>
        </div>

        <div class="nai-settings-grid">
          <section class="nai-card">
            <div class="nai-card-title">当前运行设置</div>

            <label class="nai-label">模板</label>
            <textarea id="nai-template" rows="3">${escapeHtml(draft.template)}</textarea>
            <div class="nai-subtle">推荐：<code>1.5::artist:\${subject}::,1\${sex}, cowboy_shot,solo\${tagBlock}</code></div>

            <div class="nai-form-row">
              <div>
                <label class="nai-label">Sex</label>
                <div class="nai-pill-row">
                  <label class="nai-pill">
                    <input type="checkbox" id="nai-sex-girl" ${draft.selectedSexes.includes('girl') ? 'checked' : ''}>
                    <span>girl</span>
                  </label>
                  <label class="nai-pill">
                    <input type="checkbox" id="nai-sex-boy" ${draft.selectedSexes.includes('boy') ? 'checked' : ''}>
                    <span>boy</span>
                  </label>
                </div>
              </div>

              <div>
                <label class="nai-label">顺序</label>
                <select id="nai-sex-order">
                  <option value="girl" ${draft.sexOrderFirst === 'girl' ? 'selected' : ''}>girl → boy</option>
                  <option value="boy" ${draft.sexOrderFirst === 'boy' ? 'selected' : ''}>boy → girl</option>
                </select>
              </div>
            </div>

            <label class="nai-label">运行模式</label>
            <select id="nai-run-mode">
              <option value="single_prompt" ${draft.runMode === 'single_prompt' ? 'selected' : ''}>单条运行</option>
              <option value="sex_split_tags_joined" ${draft.runMode === 'sex_split_tags_joined' ? 'selected' : ''}>按 sex 拆分</option>
              <option value="tag_split_first_sex" ${draft.runMode === 'tag_split_first_sex' ? 'selected' : ''}>按 tag 拆分（仅首个 sex）</option>
              <option value="full_combo" ${draft.runMode === 'full_combo' ? 'selected' : ''}>sex × tag 全组合</option>
            </select>

            <div class="nai-toggle-list">
              <label class="nai-toggle">
                <input type="checkbox" id="nai-hotkey-enabled" ${draft.hotkeyEnabled ? 'checked' : ''}>
                <span>启用热键 Alt + Shift + Q</span>
              </label>
            </div>
          </section>

          <section class="nai-card">
            <div class="nai-card-title">Tags / Years</div>

            <div class="nai-add-row">
              <input id="nai-new-tag" type="text" placeholder="例如：year 2026 或别的 tag">
              <button type="button" class="nai-btn nai-btn-primary" id="nai-add-tag">添加</button>
            </div>

            <div id="nai-tag-list" class="nai-tag-list">
              ${renderTagRows(draft)}
            </div>
          </section>

          <section class="nai-card nai-card-span-2">
            <div class="nai-card-title">Quick Runs</div>
            <div class="nai-subtle">把“当前运行设置”保存成一个右下角按钮。平时直接点按钮跑，不再弹脚本内确认框。</div>

            <div class="nai-quick-toolbar">
              <button type="button" class="nai-btn nai-btn-primary" id="nai-save-current-as-quick">把当前设置保存成按钮</button>
            </div>

            <div class="nai-quick-list">
              ${renderQuickRunRows(draft)}
            </div>
          </section>

          <section class="nai-card nai-card-span-2">
            <div class="nai-card-title">本次预览</div>
            <div class="nai-preview-toolbar">
              <button type="button" class="nai-btn nai-btn-ghost" id="nai-refresh-preview">刷新预览</button>
            </div>
            <div id="nai-preview-box" class="nai-preview-box">正在生成预览…</div>
          </section>
        </div>

        <div class="nai-settings-foot">
          <button type="button" class="nai-btn nai-btn-primary" id="nai-save-settings">保存设置</button>
          <button type="button" class="nai-btn nai-btn-primary" id="nai-run-draft-now">按当前设置直接运行</button>
          <button type="button" class="nai-btn nai-btn-ghost" id="nai-cancel-settings">关闭</button>
        </div>
      </div>
    `;

    bindSettingsDialogEvents();
  }

  function renderTagRows(cfg) {
    if (!cfg.tagOptions.length) {
      return `<div class="nai-subtle">还没有 tag，先添加一个。</div>`;
    }

    return cfg.tagOptions.map(tag => `
      <label class="nai-tag-item">
        <input
          type="checkbox"
          class="nai-tag-check"
          data-tag="${escapeAttr(tag)}"
          ${cfg.selectedTags.includes(tag) ? 'checked' : ''}
        >
        <span class="nai-tag-text">${escapeHtml(tag)}</span>
        <button
          type="button"
          class="nai-tag-del"
          data-tag="${escapeAttr(tag)}"
          title="删除"
        >×</button>
      </label>
    `).join('');
  }

  function renderQuickRunRows(cfg) {
    if (!cfg.quickRuns.length) {
      return `<div class="nai-subtle">还没有 Quick Run。先在左边配好，然后点“把当前设置保存成按钮”。</div>`;
    }

    return cfg.quickRuns.map((item, idx) => `
      <div class="nai-quick-item">
        <div class="nai-quick-main">
          <div class="nai-quick-name">${escapeHtml(item.name)}</div>
          <div class="nai-quick-summary">${escapeHtml(getQuickRunSummary(item))}</div>
        </div>
        <div class="nai-quick-actions">
          <button type="button" class="nai-btn nai-btn-ghost" data-quick-action="load" data-quick-index="${idx}">载入</button>
          <button type="button" class="nai-btn nai-btn-ghost" data-quick-action="run" data-quick-index="${idx}">运行</button>
          <button type="button" class="nai-btn nai-btn-ghost" data-quick-action="rename" data-quick-index="${idx}">改名</button>
          <button type="button" class="nai-btn nai-btn-ghost" data-quick-action="delete" data-quick-index="${idx}">删除</button>
        </div>
      </div>
    `).join('');
  }

  function collectSettingsFormIntoDraft() {
    if (!draft || !settingsDialog) return;

    draft.template = settingsDialog.querySelector('#nai-template')?.value ?? draft.template;
    draft.sexOrderFirst = settingsDialog.querySelector('#nai-sex-order')?.value === 'boy' ? 'boy' : 'girl';
    draft.runMode = settingsDialog.querySelector('#nai-run-mode')?.value || draft.runMode;
    draft.hotkeyEnabled = !!settingsDialog.querySelector('#nai-hotkey-enabled')?.checked;

    const selectedSexes = [];
    if (settingsDialog.querySelector('#nai-sex-girl')?.checked) selectedSexes.push('girl');
    if (settingsDialog.querySelector('#nai-sex-boy')?.checked) selectedSexes.push('boy');
    draft.selectedSexes = selectedSexes;

    draft.selectedTags = Array.from(settingsDialog.querySelectorAll('.nai-tag-check'))
      .filter(el => el.checked)
      .map(el => el.dataset.tag)
      .filter(Boolean);

    draft.tagOptions = uniqStrings(draft.tagOptions || []);
  }

  async function refreshPreviewInSettings() {
    const box = settingsDialog?.querySelector('#nai-preview-box');
    if (!box || !draft) return;

    collectSettingsFormIntoDraft();
    const cfg = mergeState(draft);

    box.textContent = '正在生成预览…';

    try {
      let subject = '<clipboard>';
      try {
        const clip = await readClipboardText();
        if (clip) subject = clip;
      } catch {
        // 无权限时就显示占位
      }

      const queue = buildQueue(cfg, subject);

      if (!queue.length) {
        box.innerHTML = `<div class="nai-subtle">当前没有可运行条目。</div>`;
        return;
      }

      box.innerHTML = queue.map((item, idx) => `
        <div class="nai-preview-item">
          <div class="nai-preview-meta">#${idx + 1} · 1${escapeHtml(item.sex)}${item.tags.length ? ` · ${escapeHtml(item.tags.join(', '))}` : ''}</div>
          <pre>${escapeHtml(item.prompt)}</pre>
        </div>
      `).join('');
    } catch (err) {
      box.innerHTML = `<div class="nai-error">${escapeHtml(err.message)}</div>`;
    }
  }

  function commitDraftToState(message) {
    if (!draft) return;
    state = mergeState(draft);
    saveState();
    updateDock();
    toast(message);
  }

  function bindSettingsDialogEvents() {
    settingsDialog.querySelector('#nai-settings-close')?.addEventListener('click', () => settingsDialog.close());
    settingsDialog.querySelector('#nai-cancel-settings')?.addEventListener('click', () => settingsDialog.close());

    ['#nai-template', '#nai-sex-girl', '#nai-sex-boy', '#nai-sex-order', '#nai-run-mode', '#nai-hotkey-enabled']
      .forEach(sel => {
        const el = settingsDialog.querySelector(sel);
        if (!el) return;

        el.addEventListener('input', () => {
          collectSettingsFormIntoDraft();
          refreshPreviewInSettings();
        });
        el.addEventListener('change', () => {
          collectSettingsFormIntoDraft();
          refreshPreviewInSettings();
        });
      });

    settingsDialog.querySelector('#nai-add-tag')?.addEventListener('click', () => {
      collectSettingsFormIntoDraft();
      const input = settingsDialog.querySelector('#nai-new-tag');
      const value = String(input.value || '').trim();
      if (!value) return;

      if (!draft.tagOptions.includes(value)) draft.tagOptions.push(value);
      if (!draft.selectedTags.includes(value)) draft.selectedTags.push(value);

      renderSettingsDialog();
      refreshPreviewInSettings();
    });

    settingsDialog.querySelectorAll('.nai-tag-check').forEach(chk => {
      chk.addEventListener('change', () => {
        collectSettingsFormIntoDraft();
        refreshPreviewInSettings();
      });
    });

    settingsDialog.querySelectorAll('.nai-tag-del').forEach(btn => {
      btn.addEventListener('click', () => {
        collectSettingsFormIntoDraft();
        const tag = btn.dataset.tag;
        draft.tagOptions = draft.tagOptions.filter(t => t !== tag);
        draft.selectedTags = draft.selectedTags.filter(t => t !== tag);
        renderSettingsDialog();
        refreshPreviewInSettings();
      });
    });

    settingsDialog.querySelector('#nai-refresh-preview')?.addEventListener('click', () => {
      collectSettingsFormIntoDraft();
      refreshPreviewInSettings();
    });

    settingsDialog.querySelector('#nai-save-settings')?.addEventListener('click', () => {
      collectSettingsFormIntoDraft();
      if (!draft.selectedSexes.length) {
        toast('至少勾选一个 sex', true);
        return;
      }
      commitDraftToState('设置已保存');
    });

    settingsDialog.querySelector('#nai-run-draft-now')?.addEventListener('click', async () => {
      collectSettingsFormIntoDraft();
      if (!draft.selectedSexes.length) {
        toast('至少勾选一个 sex', true);
        return;
      }
      const cfg = mergeState(draft);
      settingsDialog.close();
      await runFromClipboardWithConfig(cfg);
    });

    settingsDialog.querySelector('#nai-save-current-as-quick')?.addEventListener('click', () => {
      collectSettingsFormIntoDraft();

      if (!draft.selectedSexes.length) {
        toast('至少勾选一个 sex', true);
        return;
      }

      const name = prompt('这个按钮叫什么名字？', '');
      if (!name || !name.trim()) return;

      const quickName = name.trim();
      const snapshot = {
        template: draft.template,
        selectedSexes: deepClone(draft.selectedSexes),
        sexOrderFirst: draft.sexOrderFirst,
        selectedTags: deepClone(draft.selectedTags),
        runMode: draft.runMode,
      };

      const idx = draft.quickRuns.findIndex(item => item.name === quickName);
      if (idx >= 0) {
        const ok = confirm(`已存在同名按钮「${quickName}」，要覆盖吗？`);
        if (!ok) return;
        draft.quickRuns[idx] = { name: quickName, config: snapshot };
      } else {
        draft.quickRuns.push({ name: quickName, config: snapshot });
      }

      commitDraftToState(`已保存按钮：${quickName}`);
      draft = buildDraftFromState();
      renderSettingsDialog();
      refreshPreviewInSettings();
    });

    settingsDialog.querySelectorAll('[data-quick-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.quickIndex);
        const action = btn.dataset.quickAction;
        const item = draft.quickRuns[idx];
        if (!item) return;

        if (action === 'load') {
          collectSettingsFormIntoDraft();
          const cfg = buildEffectiveConfig(draft, item.config);

          draft.template = cfg.template;
          draft.selectedSexes = deepClone(cfg.selectedSexes);
          draft.sexOrderFirst = cfg.sexOrderFirst;
          draft.selectedTags = deepClone(cfg.selectedTags);
          draft.tagOptions = uniqStrings([...(draft.tagOptions || []), ...(cfg.selectedTags || [])]);
          draft.runMode = cfg.runMode;

          renderSettingsDialog();
          refreshPreviewInSettings();
          toast(`已载入：${item.name}`);
          return;
        }

        if (action === 'run') {
          const cfg = buildEffectiveConfig(state, item.config);
          settingsDialog.close();
          await runFromClipboardWithConfig(cfg);
          return;
        }

        if (action === 'rename') {
          const name = prompt('新的按钮名字', item.name);
          if (!name || !name.trim()) return;
          item.name = name.trim();
          commitDraftToState('按钮名称已更新');
          draft = buildDraftFromState();
          renderSettingsDialog();
          refreshPreviewInSettings();
          return;
        }

        if (action === 'delete') {
          const ok = confirm(`删除按钮「${item.name}」？`);
          if (!ok) return;
          draft.quickRuns.splice(idx, 1);
          commitDraftToState('按钮已删除');
          draft = buildDraftFromState();
          renderSettingsDialog();
          refreshPreviewInSettings();
        }
      });
    });
  }

  function buildDraftFromState() {
    return deepClone(state);
  }

  function bindHotkey() {
    window.addEventListener('keydown', (e) => {
      if (!hotkeyMatched(e)) return;
      e.preventDefault();
      e.stopPropagation();
      runCurrentState();
    }, true);
  }

  function installMenuCommands() {
    if (typeof GM_registerMenuCommand === 'function') {
      try {
        GM_registerMenuCommand('Open NovelAI Runner Settings', () => openSettingsDialog());
        GM_registerMenuCommand('Run Current Config', () => runCurrentState());
      } catch (e) {
        console.warn('[NAI Runner] menu command failed', e);
      }
    }
  }

  function injectStyles() {
    GM_addStyle(`
      #nai-runner-dock {
        position: fixed;
        right: 18px;
        bottom: 88px;
        z-index: 999999;
        display: grid;
        gap: 8px;
        justify-items: end;
        max-width: min(520px, calc(100vw - 30px));
      }

      #nai-runner-dock-main,
      #nai-runner-dock-quick {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .nai-btn {
        border: 0;
        border-radius: 999px;
        padding: 10px 14px;
        font-size: 14px;
        line-height: 1;
        cursor: pointer;
        box-shadow: 0 6px 20px rgba(0,0,0,.25);
      }

      .nai-btn:disabled {
        opacity: .7;
        cursor: wait;
      }

      .nai-btn-primary {
        background: #f0e7b3;
        color: #222;
      }

      .nai-btn-ghost {
        background: #2b3043;
        color: #f3f5ff;
      }

      .nai-btn-quick {
        background: #202536;
        color: #f3f5ff;
      }

      #nai-runner-toast {
        position: fixed;
        right: 18px;
        bottom: 150px;
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
        max-width: 420px;
        white-space: pre-wrap;
        word-break: break-word;
      }

      #nai-runner-settings-dialog {
        width: min(980px, calc(100vw - 40px));
        max-height: calc(100vh - 40px);
        border: 0;
        border-radius: 18px;
        padding: 0;
        background: #171a24;
        color: #f3f5ff;
        box-shadow: 0 20px 50px rgba(0,0,0,.45);
      }

      #nai-runner-settings-dialog::backdrop {
        background: rgba(0,0,0,.5);
      }

      .nai-settings-wrap {
        padding: 18px;
      }

      .nai-settings-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 16px;
      }

      .nai-settings-head h2 {
        margin: 0 0 6px 0;
        font-size: 20px;
      }

      .nai-icon-btn {
        width: 38px;
        height: 38px;
        border: 0;
        border-radius: 12px;
        background: #2a3044;
        color: #fff;
        font-size: 22px;
        cursor: pointer;
      }

      .nai-settings-grid {
        display: grid;
        grid-template-columns: minmax(320px, 1.05fr) minmax(300px, .95fr);
        gap: 14px;
      }

      .nai-card {
        background: #1d2231;
        border: 1px solid #2f354b;
        border-radius: 16px;
        padding: 14px;
      }

      .nai-card-span-2 {
        grid-column: 1 / -1;
      }

      .nai-card-title {
        font-size: 16px;
        font-weight: 700;
        margin-bottom: 12px;
      }

      .nai-label {
        display: block;
        font-weight: 700;
        margin-bottom: 8px;
      }

      textarea,
      input[type="text"],
      select {
        width: 100%;
        box-sizing: border-box;
        background: #0f131d;
        color: #fff;
        border: 1px solid #3a425b;
        border-radius: 12px;
        padding: 10px 12px;
        outline: none;
      }

      textarea {
        resize: vertical;
        min-height: 84px;
      }

      .nai-subtle {
        color: #b9c0d8;
        font-size: 12px;
        line-height: 1.5;
        margin-top: 6px;
      }

      .nai-form-row {
        display: grid;
        grid-template-columns: 1fr 220px;
        gap: 12px;
        margin: 14px 0;
      }

      .nai-pill-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .nai-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        background: #262c3e;
        border-radius: 999px;
        padding: 8px 12px;
      }

      .nai-toggle-list {
        display: grid;
        gap: 10px;
        margin-top: 14px;
      }

      .nai-toggle {
        display: flex;
        align-items: center;
        gap: 10px;
        background: #262c3e;
        border-radius: 12px;
        padding: 10px 12px;
      }

      .nai-add-row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        margin-bottom: 12px;
      }

      .nai-tag-list {
        display: grid;
        gap: 8px;
        max-height: 280px;
        overflow: auto;
      }

      .nai-tag-item {
        display: grid;
        grid-template-columns: 22px minmax(0, 1fr) 36px;
        align-items: center;
        gap: 10px;
        background: #262c3e;
        border-radius: 12px;
        padding: 10px 12px;
      }

      .nai-tag-item input[type="checkbox"] {
        margin: 0;
      }

      .nai-tag-text {
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .nai-tag-del {
        width: 32px;
        height: 32px;
        border: 0;
        border-radius: 10px;
        background: #f0e7b3;
        color: #222;
        font-size: 18px;
        cursor: pointer;
      }

      .nai-quick-toolbar {
        margin-bottom: 12px;
      }

      .nai-quick-list {
        display: grid;
        gap: 10px;
      }

      .nai-quick-item {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        background: #262c3e;
        border-radius: 14px;
        padding: 12px;
      }

      .nai-quick-main {
        min-width: 0;
      }

      .nai-quick-name {
        font-weight: 700;
        margin-bottom: 4px;
      }

      .nai-quick-summary {
        color: #c5cbe1;
        font-size: 12px;
        line-height: 1.5;
        word-break: break-word;
      }

      .nai-quick-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .nai-preview-toolbar {
        margin-bottom: 10px;
      }

      .nai-preview-box {
        background: #0f131d;
        border: 1px solid #323952;
        border-radius: 14px;
        padding: 10px;
        max-height: 320px;
        overflow: auto;
      }

      .nai-preview-item {
        padding: 10px;
        border-radius: 12px;
        background: #1b2030;
        margin-bottom: 10px;
      }

      .nai-preview-item:last-child {
        margin-bottom: 0;
      }

      .nai-preview-meta {
        color: #cbd3ef;
        font-size: 12px;
      }

      .nai-preview-item pre {
        margin: 8px 0 0 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        line-height: 1.5;
      }

      .nai-settings-foot {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
        margin-top: 16px;
      }

      .nai-error {
        color: #ff9a9a;
      }

      code {
        background: #262c3e;
        padding: 2px 6px;
        border-radius: 6px;
      }

      @media (max-width: 820px) {
        .nai-settings-grid {
          grid-template-columns: 1fr;
        }

        .nai-card-span-2 {
          grid-column: auto;
        }

        .nai-form-row {
          grid-template-columns: 1fr;
        }

        .nai-quick-item {
          grid-template-columns: 1fr;
        }

        .nai-quick-actions {
          justify-content: flex-start;
        }
      }
    `);
  }

  async function init() {
    state = mergeState(await gmGet(STORAGE_KEY, null));
    injectStyles();
    ensureDialogs();
    createDock();
    bindHotkey();
    installMenuCommands();
    toast('Prompt Runner v3.1 已加载');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
