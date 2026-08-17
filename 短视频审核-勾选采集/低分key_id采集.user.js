// ==UserScript==
// @name         Vobile审核-低分key_id采集脚本
// @namespace    https://doubao.com/userscripts
// @version      1.4.3
// @description  得分≤阈值 或 名称含关键词，满足其一即采集，面板可拖拽【修复翻页过快导致数据不全】
// @author       Doubao
// @match        https://tools.vobile.cn/quality/qualityTest*
// @grant        GM_setClipboard
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  console.log('[采集脚本] 已加载');

  // 修复1：补充对象逗号
  const CONFIG = {
    scoreThreshold: 80,
    nameKeywords: ['剪辑', '花絮','龚婉怡','姚冠宇','王凯沐','张翅','邓灵枢','余茵','刘萧旭','王凯','李柯以','徐轸轸'],
    pageWaitMax: 20000,       // 翻页后最长等待时间(ms)
    pageStayDelay: 1500,      // 点击下一页后先等待的时间(ms)
    renderSettleDelay: 2000   // 检测到页码切换后，额外等待数据渲染完整的时间(ms)
  };

  const state = {
    running: false,
    keyIdSet: new Set(),
    currentPage: 1
  };

  const SELECTORS = {
    tableRow: 'tr.ant-table-row.ant-table-row-level-0',
    sampleNameCell: 'td:nth-child(7) .commonText-gqPoHv',
    scoreCell: 'td:nth-child(8) .commonText-gqPoHv',
    keyIdCell: 'td:nth-child(15) .commonText-gqPoHv',
    nextPageBtn: 'li.ant-pagination-next > button',
    nextPageDisabled: 'li.ant-pagination-next.ant-pagination-disabled',
    activePageItem: 'li.ant-pagination-item-active'
  };

  // ========== 工具函数 ==========
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  const waitForTable = async () => {
    const startTime = Date.now();
    while (Date.now() - startTime < CONFIG.pageWaitMax) {
      const rows = document.querySelectorAll(SELECTORS.tableRow);
      if (rows.length > 0) return rows.length;
      await delay(300);
    }
    throw new Error('表格加载超时，请刷新页面重试');
  };

  // 获取当前分页的页码（antd 分页高亮项）
  const getActivePage = () => {
    const el = document.querySelector(SELECTORS.activePageItem);
    return el ? parseInt(el.textContent.trim(), 10) : NaN;
  };

  // 获取当前页第一行的 key_id，用于在拿不到页码时兜底判断页面是否切换
  const getFirstRowKeyId = () => {
    const firstRow = document.querySelector(SELECTORS.tableRow);
    if (!firstRow) return null;
    const keyIdEl = firstRow.querySelector(SELECTORS.keyIdCell);
    return keyIdEl ? keyIdEl.textContent.trim() : null;
  };

  // 检查名称是否包含关键词
  const matchKeyword = (name) => {
    if (!CONFIG.nameKeywords || CONFIG.nameKeywords.length === 0) return false;
    return CONFIG.nameKeywords.some(keyword => name.includes(keyword));
  };

  // ========== 拖拽功能 ==========
  const initDrag = (panel, dragHandle) => {
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    dragHandle.style.cursor = 'move';
    dragHandle.style.userSelect = 'none';

    dragHandle.addEventListener('mousedown', (e) => {
      isDragging = true;
      const rect = panel.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      panel.style.right = 'auto';
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      let left = e.clientX - offsetX;
      let top = e.clientY - offsetY;

      const maxLeft = window.innerWidth - panel.offsetWidth;
      const maxTop = window.innerHeight - panel.offsetHeight;
      left = Math.max(0, Math.min(left, maxLeft));
      top = Math.max(0, Math.min(top, maxTop));

      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  };

  // ========== 核心采集逻辑 ==========
  const collectCurrentPage = () => {
    const rows = document.querySelectorAll(SELECTORS.tableRow);
    if (rows.length === 0) {
      console.warn('[采集脚本] 当前页未找到数据行');
      return 0;
    }

    let addCount = 0;
    rows.forEach((row, index) => {
      try {
        const nameEl = row.querySelector(SELECTORS.sampleNameCell);
        const scoreEl = row.querySelector(SELECTORS.scoreCell);
        const keyIdEl = row.querySelector(SELECTORS.keyIdCell);

        if (!nameEl || !scoreEl || !keyIdEl) {
          console.warn(`第${index+1}行缺少必要字段`);
          return;
        }

        const sampleName = nameEl.textContent.trim();
        const score = parseFloat(scoreEl.textContent.trim());
        const keyId = keyIdEl.textContent.trim();

        // 或逻辑：得分≤阈值  或者  名称含关键词，满足其一就采集
        const scoreMatch = !isNaN(score) && score <= CONFIG.scoreThreshold;
        const nameMatch = matchKeyword(sampleName);

        if ((scoreMatch || nameMatch) && keyId) {
          state.keyIdSet.add(keyId);
          addCount++;
        }
      } catch (e) {
        console.error('行解析失败:', e);
      }
    });

    console.log(`第${state.currentPage}页采集完成，本页新增${addCount}条，累计${state.keyIdSet.size}条`);
    return addCount;
  };

  // 修复2：翻页逻辑调整——等待页码真正切换且数据渲染完整后再继续，避免采集到旧页数据
  const waitForPage = async (targetPage, beforeKeyId) => {
    const startTime = Date.now();
    while (Date.now() - startTime < CONFIG.pageWaitMax) {
      const activePage = getActivePage();
      const firstKeyId = getFirstRowKeyId();

      // 优先用页码判断是否切换；若拿不到页码，退回用首行 key_id 变化判断
      const pageChanged = !isNaN(activePage)
        ? activePage === targetPage
        : (beforeKeyId !== null && firstKeyId !== null && firstKeyId !== beforeKeyId);

      if (pageChanged) {
        // 页面已切换，额外等待一段时间，确保整页数据渲染完整
        await delay(CONFIG.renderSettleDelay);
        return true;
      }
      await delay(300);
    }
    throw new Error(`第${targetPage}页加载超时，请检查网络或调大等待时间`);
  };

  const goNextPage = async () => {
    if (document.querySelector(SELECTORS.nextPageDisabled)) {
      console.log('[采集脚本] 已到最后一页');
      return false;
    }

    const nextBtn = document.querySelector(SELECTORS.nextPageBtn);
    if (!nextBtn || nextBtn.disabled) {
      console.log('[采集脚本] 下一页按钮不可用');
      return false;
    }

    const targetPage = state.currentPage + 1;
    const beforeKeyId = getFirstRowKeyId();

    nextBtn.click();
    await delay(CONFIG.pageStayDelay);
    try {
      await waitForPage(targetPage, beforeKeyId);
      state.currentPage = targetPage;
      return true;
    } catch (e) {
      console.error('翻页后表格加载失败:', e);
      alert(`翻页异常：${e.message}`);
      return false;
    }
  };

  const runCollect = async () => {
    console.log('[采集脚本] 开始采集，筛选规则：得分≤' + CONFIG.scoreThreshold + ' 或 名称包含：' + CONFIG.nameKeywords.join('、'));
    try {
      await waitForTable();
    } catch (e) {
      alert(`表格加载失败：${e.message}，请确认页面数据已加载`);
      stopCollect();
      return;
    }

    while (state.running) {
      try {
        collectCurrentPage();
        updatePanel();

        const hasNext = await goNextPage();
        if (!hasNext) {
          stopCollect();
          const result = Array.from(state.keyIdSet).join(',');
          GM_setClipboard(result);
          alert(`采集完成！共筛选出 ${state.keyIdSet.size} 条符合条件的数据\nkey_id 已自动复制到剪贴板`);
          break;
        }
      } catch (e) {
        console.error('采集流程出错:', e);
        stopCollect();
        alert('采集中途出错，请查看控制台日志');
        break;
      }

      if (!state.running) break;
    }
  };

  // ========== 控制面板 ==========
  const renderPanel = () => {
    if (document.querySelector('#collect-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'collect-panel';
    panel.innerHTML = `
      <div class="panel-title">key_id 采集工具</div>
      <div class="panel-body">
        <div class="tip">规则：满足以下任一条件即采集</div>
        <div class="form-row">
          <label>得分阈值：</label>
          <input type="number" id="threshold-input" value="${CONFIG.scoreThreshold}" min="0" max="100">
          <span>分及以下</span>
        </div>
        <div class="form-row">
          <label>名称关键词：</label>
          <input type="text" id="keyword-input" value="${CONFIG.nameKeywords.join(',')}" placeholder="逗号分隔多个关键词">
        </div>
        <div class="stat-row">已采集：<b id="collect-count">0</b> 条</div>
        <div class="stat-row">当前页：<b id="page-num">1</b></div>
        <div class="btn-row">
          <button id="start-collect" class="btn btn-primary">开始采集</button>
          <button id="stop-collect" class="btn btn-danger" disabled>停止</button>
        </div>
        <button id="copy-result" class="btn btn-block" disabled>复制全部key_id</button>
      </div>
    `;
    document.body.appendChild(panel);

    const style = document.createElement('style');
    style.textContent = `
      #collect-panel {
        position: fixed;
        top: 100px;
        right: 20px;
        width: 240px;
        background: #fff;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.15);
        z-index: 999999;
        font-size: 14px;
        font-family: system-ui, sans-serif;
      }
      .panel-title {
        padding: 10px 14px;
        background: #1677ff;
        color: #fff;
        border-radius: 8px 8px 0 0;
        font-weight: 500;
      }
      .panel-body { padding: 14px; }
      .tip {
        font-size: 12px;
        color: #666;
        margin-bottom: 10px;
      }
      .form-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 10px;
        flex-wrap: wrap;
      }
      .form-row label {
        width: 70px;
        font-size: 13px;
        color: #666;
      }
      #threshold-input {
        width: 60px;
        padding: 4px 6px;
        border: 1px solid #d9d9d9;
        border-radius: 4px;
        outline: none;
      }
      #keyword-input {
        flex: 1;
        min-width: 120px;
        padding: 4px 6px;
        border: 1px solid #d9d9d9;
        border-radius: 4px;
        outline: none;
        font-size: 13px;
      }
      .stat-row {
        margin-bottom: 8px;
        color: #333;
      }
      .stat-row b {
        color: #1677ff;
        font-size: 16px;
      }
      .btn-row {
        display: flex;
        gap: 8px;
        margin-bottom: 10px;
      }
      .btn {
        flex: 1;
        padding: 6px 0;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-primary { background: #1677ff; color: #fff; }
      .btn-danger { background: #ff4d4f; color: #fff; }
      .btn-block {
        width: 100%;
        background: #52c41a;
        color: #fff;
        margin-top: 4px;
      }
    `;
    document.head.appendChild(style);

    // 初始化拖拽
    const titleBar = panel.querySelector('.panel-title');
    initDrag(panel, titleBar);

    // 绑定事件
    document.querySelector('#start-collect').addEventListener('click', () => {
      const scoreVal = parseInt(document.querySelector('#threshold-input').value);
      const keywordVal = document.querySelector('#keyword-input').value.trim();

      if (!isNaN(scoreVal)) CONFIG.scoreThreshold = scoreVal;
      // 优化关键词分割，去除首尾空白、过滤空值
      CONFIG.nameKeywords = keywordVal
        ? keywordVal.split(/[,，]/).map(k => k.trim()).filter(k => k)
        : [];

      startCollect();
    });

    document.querySelector('#stop-collect').addEventListener('click', stopCollect);

    document.querySelector('#copy-result').addEventListener('click', () => {
      const result = Array.from(state.keyIdSet).join(',');
      GM_setClipboard(result);
      alert(`已复制 ${state.keyIdSet.size} 条 key_id 到剪贴板`);
    });

    console.log('[采集脚本] 面板已渲染');
  };

  const updatePanel = () => {
    const countEl = document.querySelector('#collect-count');
    const pageEl = document.querySelector('#page-num');
    if (countEl) countEl.textContent = state.keyIdSet.size;
    if (pageEl) pageEl.textContent = state.currentPage;
    document.querySelector('#copy-result').disabled = state.keyIdSet.size === 0;
  };

  const startCollect = () => {
    if (state.running) return;
    state.running = true;
    state.keyIdSet.clear();
    state.currentPage = 1;
    document.querySelector('#start-collect').disabled = true;
    document.querySelector('#stop-collect').disabled = false;
    updatePanel();
    runCollect();
  };

  const stopCollect = () => {
    state.running = false;
    document.querySelector('#start-collect').disabled = false;
    document.querySelector('#stop-collect').disabled = true;
    updatePanel();
  };

  // ========== 初始化 ==========
  const init = () => {
    try {
      renderPanel();
    } catch (e) {
      console.error('面板渲染失败:', e);
    }
  };

  if (document.readyState === 'complete') {
    setTimeout(init, 1000);
  } else {
    window.addEventListener('load', () => setTimeout(init, 1000));
  }
})();