// ==UserScript==
// @name         NAI maleLab - Danbooru Artist Lookup FIRST VERSION
// @namespace    nai-malelab-danbooru
// @version      1.1
// @description  在 Danbooru 页面上检查 artist tag 是否存在于 NAI maleLab 数据库
// @match        https://danbooru.donmai.us/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  // ========== 配置 ==========
  // 改成你的 NAI maleLab 实际地址（含 base_path）
  const BASE_URL = 'https://www.adonais.cfd/taglab';
  // ==========================

  const API_URL = `${BASE_URL}/api/danbooru-artist-lookup`;

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
  `);

  function doLookup(artistName) {
    return new Promise((resolve, reject) => {
      const url = `${API_URL}?name=${encodeURIComponent(artistName)}`;
      console.log('[NML] requesting:', url);
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        withCredentials: true,
        onload(resp) {
          console.log('[NML] response status:', resp.status, 'for', artistName);
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

  function createTooltip(matches) {
    const tip = document.createElement('div');
    tip.className = 'nml-tooltip';
    if (matches.length === 0) {
      tip.textContent = '数据库中无匹配';
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

  // 查找页面上所有 artist 类型的 tag 链接
  function findArtistTags() {
    return document.querySelectorAll(
      '.tag-type-1 a.search-tag, ' +
      'li.tag-type-1 a[href*="tags="]'
    );
  }

  async function processTag(linkEl) {
    const tagName = linkEl.textContent.trim().replace(/ /g, '_');
    if (!tagName || linkEl.dataset.nmlProcessed) return;
    linkEl.dataset.nmlProcessed = '1';

    const badge = document.createElement('span');
    badge.className = 'nml-lookup-badge loading';
    badge.textContent = '...';
    linkEl.parentElement.appendChild(badge);

    try {
      const data = await doLookup(tagName);
      console.log('[NML] lookup result for', tagName, data);
      if (!data.ok) {
        badge.className = 'nml-lookup-badge error';
        badge.textContent = data.error === 'login_required' ? '未登录' : '错误';
        return;
      }
      if (data.matches && data.matches.length > 0) {
        badge.className = 'nml-lookup-badge found';
        badge.textContent = `✓ ${data.matches.length}`;
        const firstId = data.matches[0].id;
        badge.style.cursor = 'pointer';
        badge.addEventListener('click', () => {
          window.open(`${BASE_URL}/tag/${firstId}`, '_blank');
        });
      } else {
        badge.className = 'nml-lookup-badge not-found';
        badge.textContent = '✗';
      }

      // hover tooltip
      let tooltip = null;
      badge.addEventListener('mouseenter', (e) => {
        tooltip = createTooltip(data.matches || []);
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
      badge.className = 'nml-lookup-badge error';
      badge.textContent = '!';
    }
  }

  // 启动
  function init() {
    const artistLinks = findArtistTags();
    console.log('[NML] found', artistLinks.length, 'artist tags on page');
    artistLinks.forEach((el) => processTag(el));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 处理 Danbooru 的动态加载
  const observer = new MutationObserver(() => {
    findArtistTags().forEach((el) => processTag(el));
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
