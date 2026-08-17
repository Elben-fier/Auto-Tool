// ==UserScript==
// @name         Shift短剧审核-自动批量判错工具【弹窗修复版】
// @namespace    https://doubao.com/userscripts
// @version      4.0.0
// @description  修复确认弹窗无法自动关闭 + 单条Shift死循环 + 批量错误/全剧审核自动提交
// @author       Doubao
// @match        https://tools.vobile.cn/quality/dramaReview*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  console.log('[短剧审核脚本] 4.0弹窗修复版已加载');

  // ========== 可配置项 ==========
  const CONFIG = {
    parentScoreThreshold: 95,
    childScoreThreshold: 90,
    expandWaitMax: 15000,
    modalWaitMax: 5000,
    afterActionDelay: 2500,
    checkInterval: 500,
    batchBtnWaitMax: 5000
  };

  // ========== 运行状态 ==========
  const state = { running: false, processedCount: 0 };

  // ========== 元素选择器 ==========
  const SELECTORS = {
    parentRow: 'tr.ant-table-row.ant-table-row-level-0',
    expandIcon: '.ant-table-row-expand-icon',
    parentScoreCell: 'td:nth-child(5)',
    statusCell: 'td:nth-child(7)',
    expandedRow: 'tr.ant-table-expanded-row',
    childSelectAll: '.ant-pro-table thead th:first-child input.ant-checkbox-input',
    childRow: '.ant-pro-table tbody tr.ant-table-row',
    childCheckbox: 'td:first-child input.ant-checkbox-input',
    childScoreCell: 'td:nth-child(8)'
  };

  // ========== 工具函数 ==========
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  // 按文本内容查找元素（替代不兼容的 :contains()）
  const findByText = (root, selector, text) => {
    const elements = root.querySelectorAll(selector);
    for (const el of elements) {
      if (el.textContent.trim().includes(text.trim())) return el;
    }
    return null;
  };

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
        if (target) { clearTimeout(timer); observer.disconnect(); resolve(target); }
      });
      observer.observe(context, { childList: true, subtree: true });
    });
  };

  // 等待弹窗确定按钮出现（双选择器兼容 .ant-modal 和 .ant-modal-confirm）
  const waitForConfirmBtn = async (timeout = 5000) => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      for (const sel of ['.ant-modal .ant-btn-primary', '.ant-modal-confirm-btns .ant-btn-primary']) {
        const btn = document.querySelector(sel);
        if (btn && btn.textContent.trim().includes('确')) return btn;
      }
      await delay(300);
    }
    return null;
  };

  // 等待子表格加载
  const waitForChildTable = async (expandedRow) => {
    const startTime = Date.now();
    while (Date.now() - startTime < CONFIG.expandWaitMax) {
      if (expandedRow.querySelectorAll(SELECTORS.childRow).length > 0) return true;
      await delay(CONFIG.checkInterval);
    }
    throw new Error('子表格加载超时');
  };

  // 获取第一条父行
  const getFirstParentRow = () => document.querySelector(SELECTORS.parentRow);

  // 获取审核状态
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

  // ========== 拖拽 ==========
  const initDrag = (panel, handle) => {
    let dragging = false, ox = 0, oy = 0;
    handle.style.cursor = 'move';
    handle.style.userSelect = 'none';
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      const r = panel.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      panel.style.right = 'auto';
      panel.style.left = r.left + 'px';
      panel.style.top = r.top + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const l = Math.max(0, Math.min(e.clientX - ox, window.innerWidth - panel.offsetWidth));
      const t = Math.max(0, Math.min(e.clientY - oy, window.innerHeight - panel.offsetHeight));
      panel.style.left = l + 'px';
      panel.style.top = t + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  };

  // ========== 核心业务 ==========

  // 展开行并等待子表格
  const expandRowAndWait = async (parentRow) => {
    const expandBtn = parentRow.querySelector(SELECTORS.expandIcon);
    if (!expandBtn) throw new Error('未找到展开按钮');

    if (!expandBtn.classList.contains('ant-table-row-expand-icon-expanded')) {
      expandBtn.click();
      await delay(300);
    }

    let expandedRow = parentRow.nextElementSibling;
    while (expandedRow && !expandedRow.classList.contains('ant-table-expanded-row')) {
      expandedRow = expandedRow.nextElementSibling;
    }
    if (!expandedRow) throw new Error('未找到展开区域');

    await waitForChildTable(expandedRow);
    return expandedRow;
  };

  // 勾选子样本（双模式入口）
  const checkChildRows = async (expandedRow, parentScore) => {
    if (parentScore <= CONFIG.parentScoreThreshold) {
      return selectAllChildRows(expandedRow);
    } else {
      return checkChildRowsByShift(expandedRow);
    }
  };

  // 一键全选
  const selectAllChildRows = async (expandedRow) => {
    const selectAll = expandedRow.querySelector(SELECTORS.childSelectAll);
    if (selectAll && !selectAll.checked) {
      selectAll.click();
      await delay(300);
    }
    const count = expandedRow.querySelectorAll(SELECTORS.childRow).length;
    console.log(`[全选] 共 ${count} 条`);
    return count;
  };

  // Shift连续多选（修复单条死循环）
  const checkChildRowsByShift = async (expandedRow) => {
    const allRows = Array.from(expandedRow.querySelectorAll(SELECTORS.childRow));
    if (allRows.length === 0) return 0;

    // 筛选符合条件且未勾选的行索引
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
      console.log('[Shift] 无符合条件的低分样本');
      return 0;
    }

    // 划分连续区块
    const blocks = [];
    let cur = [targetIndexes[0]];
    for (let i = 1; i < targetIndexes.length; i++) {
      if (targetIndexes[i] === targetIndexes[i - 1] + 1) {
        cur.push(targetIndexes[i]);
      } else {
        blocks.push(cur);
        cur = [targetIndexes[i]];
      }
    }
    blocks.push(cur);

    // 每个区块点首行 + Shift点末行
    let totalChecked = 0;
    for (const block of blocks) {
      if (!state.running) break;

      const firstIdx = block[0];
      const lastIdx = block[block.length - 1];
      const firstCb = allRows[firstIdx].querySelector(SELECTORS.childCheckbox);

      if (!firstCb) continue;

      // ===== 修复: 单条数据只点一次，不做Shift+click =====
      if (block.length === 1) {
        firstCb.click();
        totalChecked++;
        await delay(50);
        continue;
      }

      // 多条: 点首行 + Shift点末行
      const lastCb = allRows[lastIdx].querySelector(SELECTORS.childCheckbox);
      if (!lastCb) continue;

      firstCb.click();
      await delay(50);

      lastCb.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, shiftKey: true
      }));

      totalChecked += block.length;
      await delay(100);
    }

    console.log(`[Shift] ${blocks.length} 个区块，勾选 ${totalChecked} 条`);
    return totalChecked;
  };

  // 点击批量错误 + 确认弹窗
  const executeBatchError = async (expandedRow) => {
    let batchBtn = findByText(expandedRow, 'button', '批量错误');
    if (!batchBtn || batchBtn.disabled) {
      batchBtn = findByText(
        expandedRow.closest('.ant-table-tbody') || document,
        'button',
        '批量错误'
      );
    }

    if (!batchBtn) {
      console.warn('[批量错误] 未找到按钮');
      return false;
    }
    if (batchBtn.disabled) {
      console.warn('[批量错误] 按钮已禁用（可能无勾选项）');
      return false;
    }

    console.log('[批量错误] 点击按钮');
    batchBtn.click();
    await delay(800);

    const confirmBtn = await waitForConfirmBtn(CONFIG.modalWaitMax);
    if (confirmBtn) {
      console.log('[批量错误] 点击确定');
      confirmBtn.click();
      await delay(CONFIG.afterActionDelay);
      return true;
    }
    console.warn('[批量错误] 确认弹窗未出现');
    return false;
  };

  // 点击全剧审核 + 确认弹窗
  const executeFullReview = async (parentRow) => {
    let fullBtn = findByText(parentRow, 'button', '全剧审核');
    if (!fullBtn) {
      fullBtn = findByText(
        parentRow.closest('tbody') || document,
        'button',
        '全剧审核'
      );
    }

    if (!fullBtn) {
      console.warn('[全剧审核] 未找到按钮');
      return false;
    }

    console.log('[全剧审核] 点击按钮');
    fullBtn.click();
    await delay(800);

    const confirmBtn = await waitForConfirmBtn(CONFIG.modalWaitMax);
    if (confirmBtn) {
      console.log('[全剧审核] 点击确定');
      confirmBtn.click();
      await delay(CONFIG.afterActionDelay);
      return true;
    }
    console.warn('[全剧审核] 确认弹窗未出现');
    return false;
  };

  // 处理单条短剧
  const processOneDrama = async () => {
    const firstRow = getFirstParentRow();
    if (!firstRow) { console.warn('未找到数据行'); return false; }

    const status = getRowStatus(firstRow);
    if (status === '已审核') {
      console.log('第一条已审核，全部处理完成');
      return 'finished';
    }

    const parentScore = getParentScore(firstRow);
    console.log(`===== 处理 [匹配最高分: ${parentScore}] =====`);

    try {
      // 1. 展开
      const expandedRow = await expandRowAndWait(firstRow);
      if (!state.running) return false;

      // 2. 勾选
      const checked = await checkChildRows(expandedRow, parentScore);
      if (!state.running) return false;

      // 3. 批量错误（有勾选项才执行）
      if (checked > 0) {
        await executeBatchError(expandedRow);
        if (!state.running) return false;
      }

      // 4. 全剧审核
      await executeFullReview(firstRow);

      state.processedCount++;
      updatePanel();
      console.log(`✅ 第 ${state.processedCount} 条完成`);
      return true;

    } catch (e) {
      console.error('处理失败:', e.message);
      return false;
    }
  };

  // 主循环
  const runLoop = async () => {
    while (state.running) {
      const result = await processOneDrama();
      if (result === 'finished') {
        stopRun();
        alert(`全部处理完成！共 ${state.processedCount} 条`);
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
      <div class="panel-title">短剧审核助手 4.0</div>
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
        <div class="tip">父级≤阈值: 全选→批量错误→全剧审核<br>父级>阈值: Shift多选低分→批量错误→全剧审核</div>
      </div>
    `;

    document.body.appendChild(panel);

    const style = document.createElement('style');
    style.textContent = `
      #drama-audit-panel{position:fixed;top:100px;right:20px;width:260px;background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.15);z-index:999999;font-size:14px;font-family:system-ui,sans-serif;}
      .panel-title{padding:10px 14px;background:#722ed1;color:#fff;border-radius:8px 8px 0 0;font-weight:500;}
      .panel-body{padding:14px;}
      .form-row{display:flex;align-items:center;gap:6px;margin-bottom:10px;}
      .form-row label{width:70px;font-size:13px;color:#666;}
      .form-row input{width:60px;padding:4px 6px;border:1px solid #d9d9d9;border-radius:4px;outline:none;}
      .stat-row{margin-bottom:10px;color:#333;}
      .stat-row b{color:#722ed1;font-size:16px;}
      .btn-row{display:flex;gap:8px;margin-bottom:10px;}
      .btn{flex:1;padding:6px 0;border:none;border-radius:4px;cursor:pointer;font-size:13px;}
      .btn:disabled{opacity:0.5;cursor:not-allowed;}
      .btn-start{background:#52c41a;color:#fff;}
      .btn-stop{background:#ff4d4f;color:#fff;}
      .tip{font-size:12px;color:#999;line-height:1.6;}
    `;
    document.head.appendChild(style);

    initDrag(panel, panel.querySelector('.panel-title'));

    document.querySelector('#start-btn').addEventListener('click', () => {
      const p = parseInt(document.querySelector('#parent-threshold').value);
      const c = parseInt(document.querySelector('#child-threshold').value);
      if (!isNaN(p)) CONFIG.parentScoreThreshold = p;
      if (!isNaN(c)) CONFIG.childScoreThreshold = c;
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
    try { renderPanel(); } catch (e) { console.error('初始化失败:', e); }
  };

  if (document.readyState === 'complete') {
    setTimeout(init, 1500);
  } else {
    window.addEventListener('load', () => setTimeout(init, 1500));
  }
})();
