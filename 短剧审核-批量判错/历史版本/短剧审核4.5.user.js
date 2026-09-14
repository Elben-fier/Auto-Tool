// ==UserScript==
// @name         Shift短剧审核-自动批量判错工具【通用弹窗定位版4.5】
// @namespace    https://doubao.com/userscripts
// @version      4.5.0
// @description  母行短剧名全错筛选+起始行号+批量错误后2s等待
// @author       Doubao
// @match        https://tools.vobile.cn/quality/dramaReview*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  console.log('[短剧审核脚本] 4.5全错筛选版已加载');

  // ========== 可配置项 ==========
  const CONFIG = {
    parentScoreThreshold: 95,
    childScoreThreshold: 90,
    expandWaitMax: 15000,
    modalWaitMax: 5000,
    afterActionDelay: 2500,
    batchErrorExtraWait: 2000,
    checkInterval: 500,
    batchBtnWaitMax: 5000,
    startRow: 1,
    // 全错筛选：短剧名包含以下任一关键词 → 全选判错
    nameKeywords: ['短剧', '画', '漫剧', 'AI', '充电', '红果', '专属', '动画', '免费', '剪辑', '花絮', '拍摄', '经典', '剧', '真人', '免', '动漫', '动', '&', '定档', '首播', '漫', 'ai', '果'],
    // 全错筛选：短剧名字数 ≤ 此值 → 全选判错
    nameMinLength: 4
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
    parentNameCell: 'td:nth-child(3)',
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

  // ==========【彻底重写 v2】弹窗确定按钮-直接命中ant-popconfirm ==========
  const waitForConfirmBtn = async (timeout = 5000) => {
    const startTime = Date.now();
    let debugDone = false;

    while (Date.now() - startTime < timeout) {
      // 策略1: 直接找 .ant-popconfirm 内的 primary 按钮（vobile实际使用的组件）
      const popconfirms = document.querySelectorAll('.ant-popconfirm');
      for (const pc of popconfirms) {
        // 跳过不可见的
        const style = window.getComputedStyle(pc);
        if (style.display === 'none' || style.opacity === '0') continue;

        // 在 popconfirm 内找确定按钮
        const btns = pc.querySelectorAll('button');
        for (const btn of btns) {
          const txt = btn.textContent.replace(/\s+/g, '');
          if (txt.includes('确定') || txt.includes('确认')) {
            if (!debugDone) console.log('[弹窗定位] ant-popconfirm 内找到确定按钮, class:', btn.className);
            return btn;
          }
        }
      }

      // 策略2: 兜底 - 找 .ant-modal 内的 primary 按钮
      const modals = document.querySelectorAll('.ant-modal-wrap, .ant-modal');
      for (const modal of modals) {
        const style = window.getComputedStyle(modal);
        if (style.display === 'none') continue;
        const btns = modal.querySelectorAll('button.ant-btn-primary');
        for (const btn of btns) {
          const txt = btn.textContent.replace(/\s+/g, '');
          if (txt.includes('确定') || txt.includes('确认')) {
            if (!debugDone) console.log('[弹窗定位] ant-modal 内找到确定按钮');
            return btn;
          }
        }
      }

      // 首次扫描调试
      if (!debugDone) {
        if (popconfirms.length > 0) {
          console.log('[调试] 页面共有', popconfirms.length, '个 ant-popconfirm 元素');
          for (let i = 0; i < popconfirms.length; i++) {
            const pc = popconfirms[i];
            const style = window.getComputedStyle(pc);
            console.log(`[调试]   #${i} display:${style.display} opacity:${style.opacity}`);
            const allBtns = pc.querySelectorAll('button');
            for (const b of allBtns) {
              console.log(`[调试]     button: "${b.textContent.trim()}" class:${b.className}`);
            }
          }
        } else {
          console.log('[调试] 页面无 .ant-popconfirm 元素');
        }
        const modalWraps = document.querySelectorAll('.ant-modal-wrap, .ant-modal-root');
        if (modalWraps.length > 0) {
          console.log('[调试] 页面共有', modalWraps.length, '个 ant-modal 元素');
          for (let i = 0; i < modalWraps.length; i++) {
            const m = modalWraps[i];
            const style = window.getComputedStyle(m);
            console.log(`[调试]   modal #${i} display:${style.display}`);
            const allBtns = m.querySelectorAll('button');
            for (const b of allBtns) {
              console.log(`[调试]     button: "${b.textContent.trim()}" class:${b.className}`);
            }
          }
        }
      }
      debugDone = true;
      await delay(200);
    }

    console.warn('[弹窗定位] 超时，未找到确定按钮');
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

  // 获取用户指定的父行（N从1开始）
  const getTargetParentRow = () => {
    const rows = document.querySelectorAll(SELECTORS.parentRow);
    return rows[CONFIG.startRow - 1] || null;
  };

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

  // ========== 全错筛选 ==========
  // 检查母行短剧名（第3列），命中则返回true表示该剧需全选判错
  const checkParentName = (parentRow) => {
    const nameCell = parentRow.querySelector(SELECTORS.parentNameCell);
    if (!nameCell) {
      console.warn('[全错] 未找到母行短剧名列(td:nth-child(3))');
      return false;
    }
    const name = nameCell.textContent.trim();
    if (!name) {
      console.warn('[全错] 母行短剧名为空');
      return false;
    }

    // 检查关键词
    for (const kw of CONFIG.nameKeywords) {
      if (name.includes(kw)) {
        console.log(`[全错] 母行短剧名"${name}"包含关键词"${kw}" → 全选判错`);
        return true;
      }
    }

    // 检查字数
    if (name.length <= CONFIG.nameMinLength) {
      console.log(`[全错] 母行短剧名"${name}"字数${name.length}≤${CONFIG.nameMinLength} → 全选判错`);
      return true;
    }

    console.log(`[全错] 母行短剧名"${name}"未命中，走阈值规则`);
    return false;
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

      // 单条数据只点一次，不做Shift+click
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
      console.log('[批量错误] 弹窗确定按钮找到，执行点击');
      // 增强点击：同时触发click + mousedown/mouseup，适配React弹窗
      confirmBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      confirmBtn.click();
      confirmBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await delay(CONFIG.afterActionDelay);
      return true;
    }
    console.warn('[批量错误] 确认弹窗确定按钮未找到！');
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
      console.log('[全剧审核] 弹窗确定按钮找到，执行点击');
      confirmBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      confirmBtn.click();
      confirmBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await delay(CONFIG.afterActionDelay);
      return true;
    }
    console.warn('[全剧审核] 确认弹窗确定按钮未找到！');
    return false;
  };

  // 处理用户指定行
  const processOneDrama = async () => {
    const targetRow = getTargetParentRow();
    if (!targetRow) { console.warn(`第${CONFIG.startRow}行不存在`); return false; }

    const status = getRowStatus(targetRow);
    if (status === '已审核') {
      console.log(`第${CONFIG.startRow}行已审核，全部处理完成`);
      return 'finished';
    }

    const parentScore = getParentScore(targetRow);
    // 提前检查母行短剧名，决定走全错还是阈值
    const isFullError = checkParentName(targetRow);
    console.log(`===== 处理 第${CONFIG.startRow}行 [匹配最高分: ${parentScore}] [短剧名判定: ${isFullError ? '全错' : '阈值'}] =====`);

    try {
      // 1. 展开
      const expandedRow = await expandRowAndWait(targetRow);
      if (!state.running) return false;

      // 2. 勾选
      let totalChecked = 0;
      if (isFullError) {
        // 母行短剧名命中全错规则 → 全选所有子行
        totalChecked = await selectAllChildRows(expandedRow);
        console.log(`[全错] 全选 ${totalChecked} 条子样本`);
      } else {
        // 未命中 → 走阈值分勾选
        totalChecked = await checkChildRows(expandedRow, parentScore);
      }
      if (!state.running) return false;

      // 3. 批量错误（有勾选项才执行）
      if (totalChecked > 0) {
        await executeBatchError(expandedRow);
        if (!state.running) return false;
        console.log('[等待] 批量错误完成，额外等待2s...');
        await delay(CONFIG.batchErrorExtraWait);
      }

      // 5. 全剧审核
      await executeFullReview(targetRow);

      state.processedCount++;
      updatePanel();
      console.log(`✅ 第${CONFIG.startRow}行完成（累计 ${state.processedCount} 条）`);
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
      <div class="panel-title">短剧审核助手 4.5</div>
      <div class="panel-body">
        <div class="form-row">
          <label>处理行号：</label>
          <input type="number" id="start-row" value="${CONFIG.startRow}" min="1">
          <span>第几行</span>
        </div>
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
        <div class="tip">【全错规则】短剧名含关键词(${CONFIG.nameKeywords.join('、')})或字数≤${CONFIG.nameMinLength}→全选判错<br>【阈值规则】父级≤${CONFIG.parentScoreThreshold}:全选 | 父级>${CONFIG.parentScoreThreshold}:Shift多选低分<br>批量错误后等待2s再审核</div>
      </div>
    `;

    document.body.appendChild(panel);

    const style = document.createElement('style');
    style.textContent = `
      #drama-audit-panel{position:fixed;top:100px;right:20px;width:280px;background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.15);z-index:999999;font-size:14px;font-family:system-ui,sans-serif;}
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
      const row = parseInt(document.querySelector('#start-row').value);
      const p = parseInt(document.querySelector('#parent-threshold').value);
      const c = parseInt(document.querySelector('#child-threshold').value);
      if (!isNaN(row) && row > 0) CONFIG.startRow = row;
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
