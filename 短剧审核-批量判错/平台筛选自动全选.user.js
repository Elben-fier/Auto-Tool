// ==UserScript==
// @name         dramaReview-平台筛选自动全选
// @namespace    https://doubao.com/userscripts
// @version      1.0.0
// @description  页面打开自动执行一次：重置 website_name 平台多选框 → 打开下拉 → 滚动加载虚拟列表 → 逐个点选全部平台
// @author       Doubao
// @match        https://tools.vobile.cn/quality/dramaReview*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  console.log('[平台全选] 脚本已加载');

  // ========== 可配置 ==========
  const CONFIG = {
    inputId: 'website_name',     // 平台多选框的搜索输入框 id
    listId: 'website_name_list', // 下拉列表 id（input 的 aria-owns 指向它）
    waitInputMax: 30000,         // 等待输入框出现(ms)
    waitDropdownMax: 8000,       // 等待下拉出现(ms)
    stepDelay: 220,              // 每滚动一步后的停留(ms)
    clickDelay: 60,              // 每点击一个选项后的间隔(ms)
    settleDelay: 400,            // 整轮扫描后的稳定等待(ms)
    maxPasses: 12,               // 最多扫描轮数（安全上限）
    maxFailPerText: 3,           // 同一选项点击失败次数上限（防止死循环）
    maxTotalMs: 180000,          // 整体最长执行时间(ms)
  };

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(msg) {
    console.log('[平台全选] ' + msg);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    return true;
  }

  function safeClick(el) {
    if (!el || !el.isConnected) return false;
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.click();
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return true;
    } catch (e) {
      console.warn('[平台全选] 点击失败:', e.message || e);
      return false;
    }
  }

  // 等待某选择器出现
  async function waitFor(selector, root, timeout, filter) {
    root = root || document;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = root.querySelector(selector);
      if (el && (!filter || filter(el))) return el;
      await delay(300);
    }
    return null;
  }

  // ========== 1. 打开下拉 ==========
  async function openDropdown(root) {
    const selector = root.querySelector('.ant-select-selector');
    if (!selector) { log('未找到 .ant-select-selector'); return false; }
    // 若下拉已展开（非 hidden）则无需再点
    const list = document.getElementById(CONFIG.listId);
    if (list && !list.classList.contains('ant-select-dropdown-hidden')) return true;

    safeClick(selector);
    await delay(500);

    // 若仍未展开，尝试聚焦输入框再点一次
    const input = root.querySelector('input#' + CONFIG.inputId);
    if (input) {
      try { input.focus(); } catch (e) {}
      await delay(150);
      safeClick(selector);
      await delay(500);
    }
    return true;
  }

  function getDropdown() {
    const byId = document.getElementById(CONFIG.listId);
    if (byId && !byId.classList.contains('ant-select-dropdown-hidden')) return byId;
    // 兜底：找可见的 .ant-select-dropdown
    const drops = document.querySelectorAll('.ant-select-dropdown');
    for (const d of drops) {
      if (!d.classList.contains('ant-select-dropdown-hidden') && isVisible(d)) return d;
    }
    return null;
  }

  // ========== 2. 找到可滚动容器（虚拟列表） ==========
  function getScrollHolder(dropdown) {
    const candidates = dropdown.querySelectorAll(
      '.rc-virtual-list-holder, .rc-virtual-list, .ant-select-dropdown, .ant-select-item'
    );
    for (const c of candidates) {
      if (c.scrollHeight > c.clientHeight + 2) return c;
    }
    return null;
  }

  // ========== 3. 收集当前可见选项 ==========
  function collectVisibleOptions(dropdown) {
    const options = [];
    const nodes = dropdown.querySelectorAll('.ant-select-item-option');
    for (const node of nodes) {
      const contentEl = node.querySelector('.ant-select-item-option-content') || node;
      const text = (contentEl.textContent || '').trim();
      if (!text) continue;
      options.push({
        node: node,
        text: text,
        selected: node.classList.contains('ant-select-item-option-selected'),
      });
    }
    return options;
  }

  // ========== 4. 主流程 ==========
  async function selectAllPlatforms() {
    const totalStart = Date.now();

    // 1) 等输入框出现
    log('等待平台输入框 #' + CONFIG.inputId + ' ...');
    const input = await waitFor('input#' + CONFIG.inputId, document, CONFIG.waitInputMax, isVisible);
    if (!input) { log('❌ 超时未找到输入框，可能页面未加载或选择器失效'); return; }

    const root = input.closest('.ant-select');
    if (!root) { log('❌ 未找到 .ant-select 容器'); return; }
    log('✅ 找到平台多选框');

    // 2) 重置：先清空已有选择（默认页面打开无选择，此步一般无操作）
    await resetSelections(root);
    await delay(400);

    // 3) 打开下拉（轮询等待真正展开）
    await openDropdown(root);
    let dropdown = null;
    const dropStart = Date.now();
    while (Date.now() - dropStart < CONFIG.waitDropdownMax) {
      dropdown = getDropdown();
      if (dropdown) break;
      // 可能首次点击后下拉正在挂载，重试点击
      await openDropdown(root);
      await delay(300);
    }
    if (!dropdown) {
      log('❌ 下拉未出现（' + Math.round(CONFIG.waitDropdownMax / 1000) + 's）。页面结构诊断：');
      log('   .ant-select-dropdown 数量: ' + document.querySelectorAll('.ant-select-dropdown').length);
      log('   存在 #' + CONFIG.listId + ' ? ' + !!document.getElementById(CONFIG.listId));
      return;
    }
    log('✅ 下拉已展开');

    // 4) 滚动扫描 + 逐个点选
    const clicked = new Set();      // 已成功点击的平台名
    const failCount = new Map();    // 平台名 → 失败次数
    let lastPassClicks = -1;
    let done = false;

    for (let pass = 1; pass <= CONFIG.maxPasses; pass++) {
      if (Date.now() - totalStart > CONFIG.maxTotalMs) { log('⚠️ 超过总时长限制，停止'); break; }

      const holder = getScrollHolder(dropdown);
      if (holder) holder.scrollTop = 0;
      await delay(150);

      let newClicksInPass = 0;
      let reachedBottom = !holder; // 无可滚动容器 → 一次看完

      // 逐步向下滚动，边滚边点
      while (true) {
        if (Date.now() - totalStart > CONFIG.maxTotalMs) break;

        // 下拉可能被关闭 → 重新打开
        dropdown = getDropdown();
        if (!dropdown) {
          log('下拉被关闭，重新打开...');
          await openDropdown(root);
          dropdown = getDropdown();
          if (!dropdown) { log('❌ 下拉重新打开失败'); break; }
        }

        const visible = collectVisibleOptions(dropdown);
        for (const opt of visible) {
          if (opt.selected) continue;              // 已选中跳过（防误点取消）
          if (clicked.has(opt.text)) continue;     // 已成功点过
          const fails = failCount.get(opt.text) || 0;
          if (fails >= CONFIG.maxFailPerText) {    // 多次失败，放弃该项避免死循环
            log('⚠️ 多次点击无效，跳过: ' + opt.text);
            clicked.add(opt.text);
            continue;
          }
          if (safeClick(opt.node)) {
            clicked.add(opt.text);
            newClicksInPass++;
            log('已点选: ' + opt.text);
            await delay(CONFIG.clickDelay);
          } else {
            failCount.set(opt.text, fails + 1);
          }
        }

        // 滚动到底了吗？
        if (!holder) break;
        const curHolder = getScrollHolder(dropdown) || holder;
        if (curHolder.scrollTop + curHolder.clientHeight >= curHolder.scrollHeight - 4) {
          reachedBottom = true;
          break;
        }
        curHolder.scrollTop += Math.max(100, Math.round(curHolder.clientHeight * 0.7));
        await delay(CONFIG.stepDelay);
      }

      await delay(CONFIG.settleDelay);

      // 这一轮没有任何新增点击 → 已全部点完（或都失败）
      if (newClicksInPass === 0 && lastPassClicks === 0 && reachedBottom) {
        done = true;
        break;
      }
      lastPassClicks = newClicksInPass;

      // 兜底：扫描一轮后如果下面已无未选项但仍没滚到底标记，再滚一次
      if (pass === CONFIG.maxPasses) {
        log('达到最大扫描轮数');
      }
    }

    // 5) 收尾：Esc 收起下拉（避免遮挡页面）
    try {
      const inp = root.querySelector('input#' + CONFIG.inputId);
      if (inp) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    } catch (e) {}

    const tags = root.querySelectorAll('.ant-select-selection-item');
    log('===== 执行完成 =====');
    log('成功点选平台数: ' + clicked.size);
    log('当前已选标签: ' + Array.from(tags).map((t) => t.getAttribute('title') || t.textContent.trim()).join('、'));
    if (!done) log('⚠️ 可能未全部选完（达到轮数/时长上限），可再次刷新页面重试，或控制台执行 window.__selectAllWebsites()');
  }

  // 重置筛选框：优先点清除按钮(.ant-select-clear)，否则逐个点标签的 x
  async function resetSelections(root) {
    const clearBtn = root.querySelector('.ant-select-clear');
    if (clearBtn && isVisible(clearBtn)) {
      safeClick(clearBtn);
      log('已点击清除按钮（重置筛选）');
      await delay(400);
      return;
    }
    const removes = Array.from(root.querySelectorAll('.ant-select-selection-item-remove'));
    if (removes.length > 0) {
      for (const r of removes) {
        safeClick(r);
        await delay(150);
      }
      log('已逐个移除 ' + removes.length + ' 个已选标签');
      await delay(300);
      return;
    }
    log('筛选框当前为空，无需重置');
  }

  // ========== 初始化：页面打开自动执行一次 ==========
  let started = false;
  function init() {
    if (started) return;
    started = true;
    log('页面加载完成，2.5s 后自动执行平台全选...');
    setTimeout(() => {
      selectAllPlatforms().catch((e) => {
        console.error('[平台全选] 执行异常:', e);
        log('❌ 执行异常: ' + (e.message || e));
      });
    }, 2500);
    // 供手动重试
    window.__selectAllWebsites = () => { started = true; return selectAllPlatforms(); };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // 稍等页面数据渲染
    setTimeout(init, 2000);
  }
})();
