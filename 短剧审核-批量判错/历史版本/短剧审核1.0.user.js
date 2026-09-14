// ==UserScript==
// @name         Shift短剧审核-自动批量判错工具【优化版】
// @namespace    https://doubao.com/userscripts
// @version      1.1.1
// @description  新增Shift连续多选，大幅提升低分筛选勾选速度
// @author       Doubao
// @match        https://tools.vobile.cn/quality/dramaReview*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  console.log('[短剧审核脚本] 已加载 - Shift连续多选优化版');

  // ========== 可配置项 ==========
  const CONFIG = {
    parentScoreThreshold: 95,    // 父级匹配最高分阈值，高于此值走筛选模式
    childScoreThreshold: 90,     // 子样本得分阈值，低于此值判错
    expandWaitMax: 15000,        // 展开子表格最长等待时间(ms)
    modalWaitDelay: 1000,        // 等待弹窗出现时间
    afterActionDelay: 2000,      // 操作后等待页面刷新时间
    checkInterval: 500,          // 轮询检测间隔
    batchBtnWaitMax: 5000        // 等待批量错误按钮可用的最长时间
  };

  // ========== 运行状态 ==========
  const state = {
    running: false,
    processedCount: 0
  };

  // ========== 元素选择器 ==========
  const SELECTORS = {
    // 父级表格行
    parentRow: 'tr.ant-table-row.ant-table-row-level-0',
    // 展开加号按钮
    expandIcon: '.ant-table-row-expand-icon',
    // 父级第5列：匹配最高分
    parentScoreCell: 'td:nth-child(5)',
    // 父级第7列：审核状态
    statusCell: 'td:nth-child(7)',
    // 全剧审核按钮
    fullReviewBtn: 'button:has(span):contains("全剧审核")',
    // 展开后的子表格容器行
    expandedRow: 'tr.ant-table-expanded-row',
    // 子表格（展开区域内的表格）
    childTable: '.ant-pro-table .ant-table',
    // 子表格表头全选框
    childSelectAll: '.ant-pro-table thead th:first-child input.ant-checkbox-input',
    // 子表格行
    childRow: '.ant-pro-table tbody tr.ant-table-row',
    // 子表格复选框（每行）
    childCheckbox: 'td:first-child input.ant-checkbox-input',
    // 子表格得分列（第8列）
    childScoreCell: 'td:nth-child(8)',
    // 子区域顶部批量错误按钮
    batchErrorBtn: '.ant-pro-table-list-toolbar button.ant-btn-dangerous:has(span):contains("批量错误")',
    // 弹窗确定按钮
    confirmBtn: '.ant-modal-wrap .ant-modal button.ant-btn-primary span:contains("确 定")'
  };

  // ========== 工具函数 ==========
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  // 等待元素出现
  const waitForElement = (selector, context = document, timeout = 10000) => {
    return new Promise((resolve, reject) => {
      const el = context.querySelector(selector);
      if (el) return resolve(el);

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`等待超时: ${selector}`));
      }, timeout);

      const observer = new MutationObserver(() => {
        const target = context.querySelector(selector);
        if (target) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(target);
        }
      });

      observer.observe(context, { childList: true, subtree: true });
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

  // 等待批量错误按钮可用
  const waitForBatchBtnEnabled = async (expandedRow) => {
    const startTime = Date.now();
    while (Date.now() - startTime < CONFIG.batchBtnWaitMax) {
      const btn = expandedRow.querySelector(SELECTORS.batchErrorBtn);
      if (btn && !btn.disabled) return btn;
      await delay(200);
    }
    return null;
  };

  // 获取第一条父级行
  const getFirstParentRow = () => document.querySelector(SELECTORS.parentRow);

  // 获取行的审核状态
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
    }

    // 找到对应的展开行
    let expandedRow = parentRow.nextElementSibling;
    while (expandedRow && !expandedRow.classList.contains('ant-table-expanded-row')) {
      expandedRow = expandedRow.nextElementSibling;
    }

    if (!expandedRow) throw new Error('未找到展开区域');

    await waitForChildTable(expandedRow);
    return expandedRow;
  };

  // 勾选子样本（低于阈值一键全选，高于阈值Shift连续多选）
  const checkChildRows = async (expandedRow, parentScore) => {
    if (parentScore <= CONFIG.parentScoreThreshold) {
      // === 低于阈值：一键全选 ===
      const selectAll = expandedRow.querySelector(SELECTORS.childSelectAll);
      if (!selectAll) {
        console.warn('未找到子表格全选框，降级为逐行勾选');
        return checkChildRowsOneByOne(expandedRow, true);
      }

      if (!selectAll.checked) {
        selectAll.click();
        await delay(300); // 等待全选响应
      }

      const rowCount = expandedRow.querySelectorAll(SELECTORS.childRow).length;
      console.log(`一键全选完成，共 ${rowCount} 条`);
      return rowCount;

    } else {
      // === 高于阈值：Shift连续多选（优化核心） ===
      return checkChildRowsByShift(expandedRow);
    }
  };

  // 【新增优化】Shift连续多选：识别连续低分区，每区仅需2次点击
  const checkChildRowsByShift = async (expandedRow) => {
    const allRows = Array.from(expandedRow.querySelectorAll(SELECTORS.childRow));
    if (allRows.length === 0) return 0;

    // 第一步：离线筛选所有符合条件（得分<阈值且未勾选）的行索引
    const targetIndexes = [];
    allRows.forEach((row, index) => {
      const scoreCell = row.querySelector(SELECTORS.childScoreCell);
      const checkbox = row.querySelector(SELECTORS.childCheckbox);
      if (!scoreCell || !checkbox || checkbox.checked) return;

      const score = parseFloat(scoreCell.textContent.trim());
      if (!isNaN(score) && score < CONFIG.childScoreThreshold) {
        targetIndexes.push(index);
      }
    });

    if (targetIndexes.length === 0) {
      console.log('无符合条件的低分样本');
      return 0;
    }

    // 第二步：把连续的索引划分成区块
    const continuousBlocks = [];
    let currentBlock = [targetIndexes[0]];

    for (let i = 1; i < targetIndexes.length; i++) {
      if (targetIndexes[i] === targetIndexes[i - 1] + 1) {
        currentBlock.push(targetIndexes[i]);
      } else {
        continuousBlocks.push(currentBlock);
        currentBlock = [targetIndexes[i]];
      }
    }
    continuousBlocks.push(currentBlock);

    // 第三步：每个连续区块执行「点首行 + Shift点末行」
    let totalChecked = 0;
    for (const block of continuousBlocks) {
      if (!state.running) break;

      const firstIndex = block[0];
      const lastIndex = block[block.length - 1];
      const firstCheckbox = allRows[firstIndex].querySelector(SELECTORS.childCheckbox);
      const lastCheckbox = allRows[lastIndex].querySelector(SELECTORS.childCheckbox);

      if (!firstCheckbox || !lastCheckbox) continue;

      // 1. 普通点击首行
      firstCheckbox.click();
      await delay(50);

      // 2. 按住 Shift 点击末行，触发连续多选
      const shiftClickEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        shiftKey: true
      });
      lastCheckbox.dispatchEvent(shiftClickEvent);

      totalChecked += block.length;
      await delay(100); // 区块间短暂等待，避免页面渲染卡顿
    }

    console.log(`Shift连续多选完成，共 ${continuousBlocks.length} 个连续区块，勾选 ${totalChecked} 条低分样本`);
    return totalChecked;
  };

  // 逐行勾选（兼容降级模式）
  const checkChildRowsOneByOne = async (expandedRow, allCheck) => {
    const childRows = expandedRow.querySelectorAll(SELECTORS.childRow);
    let checkedCount = 0;

    for (const row of childRows) {
      if (!state.running) break;

      const checkbox = row.querySelector(SELECTORS.childCheckbox);
      if (!checkbox || checkbox.checked) continue;

      let shouldCheck = allCheck;

      if (!allCheck) {
        const scoreCell = row.querySelector(SELECTORS.childScoreCell);
        if (scoreCell) {
          const score = parseFloat(scoreCell.textContent.trim());
          if (!isNaN(score) && score < CONFIG.childScoreThreshold) {
            shouldCheck = true;
          }
        }
      }

      if (shouldCheck) {
        checkbox.click();
        checkedCount++;
        await delay(50);
      }
    }

    console.log(`逐行勾选完成，共勾选 ${checkedCount} 条`);
    return checkedCount;
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
    console.log(`开始处理，匹配最高分：${parentScore}，状态：${status}`);

    try {
      // 1. 展开并等待子表格
      const expandedRow = await expandRowAndWait(firstRow);
      if (!state.running) return false;

      // 2. 勾选符合条件的子样本
      await checkChildRows(expandedRow, parentScore);
      if (!state.running) return false;

      state.processedCount++;
      updatePanel();

      console.log(`第 ${state.processedCount} 条勾选完成`);
      return true;

    } catch (e) {
      console.error('处理单条失败:', e);
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
        <div class="tip">高于父级阈值：Shift连续多选低分样本<br>低于父级阈值：一键全选判错</div>
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