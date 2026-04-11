// ==UserScript==
// @name         NAI maleLab - Danbooru Tag Lookup
// @namespace    nai-malelab-danbooru
// @version      1.2
// @description  在 Danbooru 页面上检查 artist / copyright / character tag 是否存在于 NAI maleLab 数据库
// @match        https://danbooru.donmai.us/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  // ========== 配置 ==========
  // 改成你的 NAI maleLab 实际地址（含 base_path）
  const BASE_URL = 'https://www.adonais.cfd/taglab';
  // ==========================

  const API_URL = `${BASE_URL}/api/danbooru-artist-lookup`;

  // 是否检查 copyright / character tag（artist 永远检查）
  // 通过 Tampermonkey 菜单命令切换，持久化在 GM storage
  let CHECK_EXTRA = GM_getValue('nml_check_extra', true);

  // Danbooru 的 tag-type 约定：1=artist, 3=copyright, 4=character
  const TAG_TYPE_MAP = {
    1: 'artist',
    3: 'copyright',
    4: 'character',
  };

  GM_addStyle(`
    .nml-lookup-badge {
      display: inline-block;
      margin-left: 6px;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: bold;
      vertical-align: middle;
      cursor: pointer;
      text-decoration: none !important;
    }
    .nml-lookup-badge.found {
      background: #2e7d32;
      color: #fff;
    }
    .nml-lookup-badge.not-found {
      background: #666;
      color: #ccc;
    }
    .nml-lookup-badge.error {
      background: #c62828;
      color: #fff;
    }
    .nml-lookup-badge.loading {
      background: #555;
      color: #aaa;
    }
    /* 以 outline 颜色区分不同类别的 tag（artist 无额外描边） */
    .nml-lookup-badge.kind-copyright {
      outline: 1px solid #c792ea;
      outline-offset: -1px;
    }
    .nml-lookup-badge.kind-character {
      outline: 1px solid #ffb86b;
      outline-offset: -1px;
    }
    .nml-tooltip {
      position: absolute;
      z-index: 99999;
      background: #1e1e1e;
      color: #eee;
      border: 1px solid #555;
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 12px;
      max-width: 320px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      pointer-events: none;
    }
    .nml-tooltip .nml-match-name {
      font-weight: bold;
      color: #8cf;
    }
    .nml-tooltip .nml-match-dim {
      color: #aaa;
      font-size: 11px;
    }
    .nml-tooltip .nml-match-labels {
      color: #cfa;
      font-size: 11px;
      margin-top: 2px;
    }
    .nml-tooltip .nml-kind-header {
      color: #aaa;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 4px;
    }
  `);

  function doLookup(tagName) {
    return new Promise((resolve, reject) => {
      const url = `${API_URL}?name=${encodeURIComponent(tagName)}`;
      console.log('[NML] requesting:', url);
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        withCredentials: true,
        onload(resp) {
          console.log('[NML] response status:', resp.status, 'for', tagName);
          try {
            resolve(JSON.parse(resp.responseText));
          } catch {
            console.error('[NML] invalid JSON:', resp.responseText.slice(0, 200));
            reject(new Error('Invalid JSON'));
          }
        },
        onerror(err) {
          console.error('[NML] request error:', err);
          reject(err);
        },
      });
    });
  }

  function createTooltip(matches, kind) {
    const tip = document.createElement('div');
    tip.className = 'nml-tooltip';
    if (kind) {
      const header = document.createElement('div');
      header.className = 'nml-kind-header';
      header.textContent = kind;
      tip.appendChild(header);
    }
    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = '数据库中无匹配';
      tip.appendChild(empty);
      return tip;
    }
    matches.forEach((m) => {
      const row = document.createElement('div');
      row.style.marginBottom = '4px';
      row.innerHTML =
        `<span class="nml-match-name">${esc(m.name)}</span>` +
        (m.dimension ? ` <span class="nml-match-dim">[${esc(m.dimension)}]</span>` : '') +
        (m.labels && m.labels.length
          ? `<div class="nml-match-labels">${m.labels.map(esc).join(', ')}</div>`
          : '');
      tip.appendChild(row);
    });
    return tip;
  }

  function esc(s) {
    const d = document.createElement('span');
    d.textContent = s;
    return d.innerHTML;
  }

  // 沿 DOM 向上查找包含 tag-type-N 的祖先节点，返回类别字符串
  function tagKindFor(linkEl) {
    let node = linkEl;
    while (node && node !== document.body) {
      if (node.classList) {
        for (const typeNum of Object.keys(TAG_TYPE_MAP)) {
          if (node.classList.contains(`tag-type-${typeNum}`)) {
            return TAG_TYPE_MAP[typeNum];
          }
        }
      }
      node = node.parentElement;
    }
    return 'unknown';
  }

  // 根据当前开关状态返回所有需要检查的 tag 链接
  function findLookupTags() {
    const types = [1]; // artist 永远检查
    if (CHECK_EXTRA) {
      types.push(3, 4); // copyright, character
    }
    const selectors = [];
    types.forEach((t) => {
      selectors.push(`.tag-type-${t} a.search-tag`);
      selectors.push(`li.tag-type-${t} a[href*="tags="]`);
    });
    return document.querySelectorAll(selectors.join(', '));
  }

  async function processTag(linkEl) {
    const tagName = linkEl.textContent.trim().replace(/ /g, '_');
    if (!tagName || linkEl.dataset.nmlProcessed) return;
    linkEl.dataset.nmlProcessed = '1';

    const kind = tagKindFor(linkEl);
    const badge = document.createElement('span');
    badge.className = `nml-lookup-badge loading kind-${kind}`;
    badge.textContent = '...';
    linkEl.parentElement.appendChild(badge);

    try {
      const data = await doLookup(tagName);
      console.log('[NML] lookup result for', tagName, data);
      if (!data.ok) {
        badge.className = `nml-lookup-badge error kind-${kind}`;
        badge.textContent = data.error === 'login_required' ? '未登录' : '错误';
        return;
      }
      if (data.matches && data.matches.length > 0) {
        badge.className = `nml-lookup-badge found kind-${kind}`;
        badge.textContent = `✓ ${data.matches.length}`;
        const firstId = data.matches[0].id;
        badge.style.cursor = 'pointer';
        badge.addEventListener('click', () => {
          window.open(`${BASE_URL}/tag/${firstId}`, '_blank');
        });
      } else {
        badge.className = `nml-lookup-badge not-found kind-${kind}`;
        badge.textContent = '✗';
      }

      // hover tooltip
      let tooltip = null;
      badge.addEventListener('mouseenter', (e) => {
        tooltip = createTooltip(data.matches || [], kind);
        document.body.appendChild(tooltip);
        tooltip.style.left = e.pageX + 10 + 'px';
        tooltip.style.top = e.pageY + 10 + 'px';
      });
      badge.addEventListener('mouseleave', () => {
        if (tooltip) {
          tooltip.remove();
          tooltip = null;
        }
      });
    } catch (err) {
      console.error('[NML] lookup failed for', tagName, err);
      badge.className = `nml-lookup-badge error kind-${kind}`;
      badge.textContent = '!';
    }
  }

  // Tampermonkey 菜单命令：切换是否检查 copyright/角色 tag
  if (typeof GM_registerMenuCommand === 'function') {
    const label = CHECK_EXTRA
      ? '✓ 检查 copyright/角色 tag（点击关闭）'
      : '✗ 检查 copyright/角色 tag（点击开启）';
    GM_registerMenuCommand(label, () => {
      CHECK_EXTRA = !CHECK_EXTRA;
      GM_setValue('nml_check_extra', CHECK_EXTRA);
      // 刷新页面以重新扫描 tag（最简单可靠的方式）
      location.reload();
    });
  }

  // 启动
  function init() {
    const tagLinks = findLookupTags();
    console.log('[NML] found', tagLinks.length, 'lookup tags on page (extra:', CHECK_EXTRA, ')');
    tagLinks.forEach((el) => processTag(el));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 处理 Danbooru 的动态加载
  const observer = new MutationObserver(() => {
    findLookupTags().forEach((el) => processTag(el));
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
