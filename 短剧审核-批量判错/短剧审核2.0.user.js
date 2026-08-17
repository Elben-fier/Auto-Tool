// ==UserScript==
// @name         Vobile短剧审核-自动批量判错工具【最终修复版】
// @namespace    https://doubao.com/userscripts
// @version      1.3.0
// @description  彻底修复选择器语法错误，批量错误+全剧审核稳定点击
// @author       Doubao
// @match        https://tools.vobile.cn/quality/dramaReview*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  console.log('[短剧审核脚本] 最终修复版已加载');

  // ========== 可配置项 ==========
  const CONFIG = {
    parentScoreThreshold: 95,    // 父级匹配最高分阈值
    childScoreThreshold: 90,     // 子样本得分阈值
    expandWaitMax: 15000,        // 子表格最长加载时间(ms)
    modalWaitMax: 5000,          // 弹窗最长等待时间(ms)
    afterActionDelay: 2500,      // 操作后等待页面刷新时间(ms)
    checkInterval: 500           // 轮询检测间隔(ms)
  };

  // ========== 运行状态 ==========
  const state = {
    running: false,
    processedCount: 0
  };

  // ========== 纯标准CSS选择器，无任何非标准伪类 ==========
  const SELECTORS = {
    // 父级表格
    parentRow: 'tr.ant-table-row.ant-table-row-level-0',
    expandIcon: '.ant-table-row-expand-icon',
    parentScoreCell: 'td:nth-child(5)',
    statusCell: 'td:nth-child(7)',
    // 展开区域
    expandedRow: 'tr.ant-table-expanded-row',
    childSelectAll: '.ant-pro-table thead th:first-child input.ant-checkbox-input',
    childRow: '.ant-pro-table tbody tr.ant-table-row',
    childCheckbox: 'td:first-child input.ant-checkbox-input',
    childScoreCell: 'td:nth-child(8)',
    // 工具栏按钮组（批量正确/错误/重试/矫正都在这个容器里）
    toolbarBtnGroup: '.ant-pro-table-list-toolbar-right',
    toolbarBtn: '.ant-pro-table-list-toolbar-right .ant-btn',
    // 弹窗确定按钮（双重兼容）
    modalPrimaryBtn: '.ant-modal .ant-btn-primary',
    modalConfirmBtn: '.ant-modal-confirm-btns .ant-btn-primary'
  };

  // ========== 核心工具函数 ==========
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  /**
   * 在指定范围内，按文本内容查找元素
   * 完全替代非标准的 :contains()
   */
  const findElementByText = (root, selector, text) => {
    const elements = root.querySelectorAll(selector);
    for (const el of elements) {
      if (el.textContent.trim().includes(text.trim())) {
        return el;
      }
    }
    return null;
  };

  /**
   * 等待元素出现（支持文本匹配）
   */
  const waitForElement = (root, selector, text = null, timeout = 10000) => {
    return new Promise((resolve, reject) => {
      // 先立即检测一次
      const firstCheck = text
        ? findElementByText(root, selector, text)
        : root.querySelector(selector);
      if (firstCheck) return resolve(firstCheck);

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`等待超时: ${selector} ${text || ''}`));
      }, timeout);

      const observer = new MutationObserver(() => {
        const target = text
          ? findElementByText(root, selector, text)
          : root.querySelector(selector);
        if (target) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(target);
        }
      });

      observer.observe(root, { childList: true, subtree: true });
    });
  };

  // 等待子表格加载完成
  const waitForChildTable = async (expandedRow) => {
    const startTime = Date.now();
    while (Date.now() - startTime < CONFIG.expandWaitMax) {
      const rows = expandedRow.querySelectorAll(SELECTORS.childRow);
      if (rows.length > 0) return rows.length;
      await delay(CONFIG.checkInterval);
    }
    throw new Error('子表格加载超时');
  };

  // 获取第一条父行
  const getFirstParentRow = () => document.querySelector(SELECTORS.parentRow);

  // 获取行审核状态
  const getRowStatus = (row) => {
    const cell = row.querySelector(SELECTORS.statusCell);
    return cell ? cell.textContent.trim() : '';
  };

  // 获取父行匹配最高分
  const getParentScore = (row) => {
    const cell = row.querySelector(SELECTORS.parentScoreCell);
    if (!cell) return null;
    const score = parseFloat(cell.textContent.trim());
    return isNaN(score) ? null : score;
  };

  // ========== 拖拽功能 ==========
  const initDrag = (panel, dragHandle) => {
    let isDragging = false;
    let offsetX = 0, offsetY = 0;

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

    document.addEventListener('mouseup', () => { isDragging = false; });
  };

  // ========== 核心业务逻辑 ==========

  // 展开行并等待子表格加载
  const expandRowAndWait = async (parentRow) => {
    const expandBtn = parentRow.querySelector(SELECTORS.expandIcon);
    if (!expandBtn) throw new Error('未找到展开按钮');

    const isExpanded = expandBtn.classList.contains('ant-table-row-expand-icon-expanded');
    if (!isExpanded) {
      expandBtn.click();
      console.log('[步骤1] 点击展开按钮');
    }

    // 找到对应的展开行
    let expandedRow = parentRow.nextElementSibling;
    while (expandedRow && !expandedRow.classList.contains('ant-table-expanded-row')) {
      expandedRow = expandedRow.nextElementSibling;
    }

    if (!expandedRow) throw new Error('未找到展开区域');

    await waitForChildTable(expandedRow);
    console.log('[步骤2] 子表格加载完成');
    return expandedRow;
  };

  // 勾选子样本
  const checkChildRows = async (expandedRow, parentScore) => {
    if (parentScore <= CONFIG.parentScoreThreshold) {
      // 低于阈值：一键全选
      const selectAll = expandedRow.querySelector(SELECTORS.childSelectAll);
      if (selectAll && !selectAll.checked) {
        selectAll.click();
        await delay(300);
      }
      const count = expandedRow.querySelectorAll(SELECTORS.childRow).length;
      console.log(`[步骤3] 一键全选完成，共 ${count} 条`);
      return count;
    } else {
      // 高于阈值：逐行筛选低分
      const childRows = expandedRow.querySelectorAll(SELECTORS.childRow);
      let checkedCount = 0;
      for (const row of childRows) {
        if (!state.running) break;
        const checkbox = row.querySelector(SELECTORS.childCheckbox);
        if (!checkbox || checkbox.checked) continue;

        const scoreCell = row.querySelector(SELECTORS.childScoreCell);
        if (scoreCell) {
          const score = parseFloat(scoreCell.textContent.trim());
          if (!isNaN(score) && score < CONFIG.childScoreThreshold) {
            checkbox.click();
            checkedCount++;
            await delay(50);
          }
        }
      }
      console.log(`[步骤3] 筛选勾选完成，共 ${checkedCount} 条低分样本`);
      return checkedCount;
    }
  };

  // 【核心修复】执行批量错误 + 确认弹窗
  const executeBatchError = async (expandedRow) => {
    // 1. 在工具栏中找到「批量错误」按钮
    const batchBtn = findElementByText(expandedRow, SELECTORS.toolbarBtn, '批量错误');
    if (!batchBtn || batchBtn.disabled) {
      console.warn('[步骤4] 未找到可用的批量错误按钮');
      return false;
    }

    console.log('[步骤4] 点击批量错误按钮');
    batchBtn.click();
    await delay(800);

    // 2. 等待弹窗并点击确定（双重兜底）
    try {
      let confirmBtn = await waitForElement(document, SELECTORS.modalPrimaryBtn, null, CONFIG.modalWaitMax);
      // 二次校验文本，避免点错
      if (!confirmBtn || !confirmBtn.textContent.trim().includes('确定')) {
        confirmBtn = await waitForElement(document, SELECTORS.modalConfirmBtn, null, 2000);
      }

      if (confirmBtn) {
        console.log('[步骤5] 点击确认弹窗的确定按钮');
        confirmBtn.click();
        await delay(CONFIG.afterActionDelay);
        return true;
      }
    } catch (e) {
      console.warn('[步骤5] 确认弹窗未出现:', e.message);
    }
    return false;
  };

  // 【核心修复】执行全剧审核 + 确认弹窗
  const executeFullReview = async (parentRow) => {
    // 1. 在父行操作列找到「全剧审核」按钮
    const fullBtn = findElementByText(parentRow, '.ant-btn', '全剧审核');
    if (!fullBtn) {
      console.warn('[步骤6] 未找到全剧审核按钮');
      return false;
    }

    console.log('[步骤6] 点击全剧审核按钮');
    fullBtn.click();
    await delay(800);

    // 2. 等待弹窗并点击确定
    try {
      const confirmBtn = await waitForElement(document, SELECTORS.modalPrimaryBtn, null, CONFIG.modalWaitMax);
      if (confirmBtn && confirmBtn.textContent.trim().includes('确定')) {
        console.log('[步骤7] 点击全剧审核确认按钮');
        confirmBtn.click();
        await delay(CONFIG.afterActionDelay);
        return true;
      }
    } catch (e) {
      console.warn('[步骤7] 全剧审核确认弹窗未出现:', e.message);
    }
    return false;
  };

  // 处理单条短剧
  const processOneDrama = async () => {
    const firstRow = getFirstParentRow();
    if (!firstRow) {
      console.warn('未找到数据行');
      return false;
    }

    const status = getRowStatus(firstRow);
    if (status === '已审核') {
      console.log('第一条已审核，全部处理完成');
      return 'finished';
    }

    const parentScore = getParentScore(firstRow);
    console.log(`===== 开始处理，匹配最高分：${parentScore}，状态：${status} =====`);

    try {
      const expandedRow = await expandRowAndWait(firstRow);
      if (!state.running) return false;

      const checkedCount = await checkChildRows(expandedRow, parentScore);
      if (!state.running) return false;

      if (checkedCount > 0) {
        await executeBatchError(expandedRow);
      }
      if (!state.running) return false;

      await executeFullReview(firstRow);
      state.processedCount++;
      updatePanel();

      console.log(`✅ 第 ${state.processedCount} 条处理完成`);
      return true;

    } catch (e) {
      console.error('处理单条失败:', e.message);
      return false;
    }
  };

  // 主循环
  const runLoop = async () => {
    while (state.running) {
      const result = await processOneDrama();

      if (result === 'finished') {
        stopRun();
        alert(`全部处理完成！共处理 ${state.processedCount} 条短剧`);
        break;
      }

      if (!state.running) break;
      await delay(1000);
    }
  };

  // ========== 控制面板 ==========
  const renderPanel = () => {
    if (document.querySelector('#drama-audit-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'drama-audit-panel';
    panel.innerHTML = `
      <div class="panel-title">短剧审核助手</div>
      <div class="panel-body">
        <div class="form-row">
          <label>父级阈值：</label>
          <input type="number" id="parent-threshold" value="${CONFIG.parentScoreThreshold}" min="0" max="100">
          <span>分</span>
        </div>
        <div class="form-row">
          <label>子级阈值：</label>
          <input type="number" id="child-threshold" value="${CONFIG.childScoreThreshold}" min="0" max="100">
          <span>分以下判错</span>
        </div>
        <div class="stat-row">已处理：<b id="processed-num">0</b> 条</div>
        <div class="btn-row">
          <button id="start-btn" class="btn btn-start">开始运行</button>
          <button id="stop-btn" class="btn btn-stop" disabled>停止</button>
        </div>
        <div class="tip">高于父级阈值：仅判错低分样本<br>低于父级阈值：一键全选判错</div>
      </div>
    `;

    document.body.appendChild(panel);

    const style = document.createElement('style');
    style.textContent = `
      #drama-audit-panel {
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
        background: #722ed1;
        color: #fff;
        border-radius: 8px 8px 0 0;
        font-weight: 500;
      }
      .panel-body { padding: 14px; }
      .form-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 10px;
      }
      .form-row label {
        width: 70px;
        font-size: 13px;
        color: #666;
      }
      .form-row input {
        width: 60px;
        padding: 4px 6px;
        border: 1px solid #d9d9d9;
        border-radius: 4px;
        outline: none;
      }
      .stat-row {
        margin-bottom: 10px;
        color: #333;
      }
      .stat-row b {
        color: #722ed1;
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
      .btn-start { background: #52c41a; color: #fff; }
      .btn-stop { background: #ff4d4f; color: #fff; }
      .tip {
        font-size: 12px;
        color: #999;
        line-height: 1.5;
      }
    `;
    document.head.appendChild(style);

    initDrag(panel, panel.querySelector('.panel-title'));

    document.querySelector('#start-btn').addEventListener('click', () => {
      const pVal = parseInt(document.querySelector('#parent-threshold').value);
      const cVal = parseInt(document.querySelector('#child-threshold').value);
      if (!isNaN(pVal)) CONFIG.parentScoreThreshold = pVal;
      if (!isNaN(cVal)) CONFIG.childScoreThreshold = cVal;
      startRun();
    });

    document.querySelector('#stop-btn').addEventListener('click', stopRun);
  };

  const updatePanel = () => {
    const el = document.querySelector('#processed-num');
    if (el) el.textContent = state.processedCount;
  };

  const startRun = () => {
    if (state.running) return;
    state.running = true;
    state.processedCount = 0;
    document.querySelector('#start-btn').disabled = true;
    document.querySelector('#stop-btn').disabled = false;
    runLoop();
  };

  const stopRun = () => {
    state.running = false;
    document.querySelector('#start-btn').disabled = false;
    document.querySelector('#stop-btn').disabled = true;
  };

  // ========== 初始化 ==========
  const init = () => {
    try {
      renderPanel();
      console.log('[短剧审核脚本] 初始化完成');
    } catch (e) {
      console.error('面板渲染失败:', e);
    }
  };

  if (document.readyState === 'complete') {
    setTimeout(init, 1500);
  } else {
    window.addEventListener('load', () => setTimeout(init, 1500));
  }

})();