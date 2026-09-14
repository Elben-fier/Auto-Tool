// ==UserScript==
// @name         Shift短剧审核-自动判错确认版【5.0】
// @namespace    https://doubao.com/userscripts
// @version      5.0.0
// @description  594判错确认+慢处理+全剧审核完成后才切下一行；问题合集自动收起并固定第2行继续；面板可最小化并实时显示状态/进度
// @author       Doubao
// @match        https://tools.vobile.cn/quality/dramaReview*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  console.log('[短剧审核5.0] 594判错确认版已加载');

  // ========== 可配置项 ==========
  const CONFIG = {
    parentScoreThreshold: 95,      // 父级匹配最高分阈值：≤ 走全选，> 走低分筛选
    childScoreThreshold: 90,       // 子样本得分阈值：得分 < 该值 → 判错（问题数据）
    slowEpisodeThreshold: 300,     // 合集集数(第10列) > 该值 → 慢处理
    // —— 普通合集等待 ——
    expandWaitMax: 15000,          // 展开合集最长等待
    batchErrorWaitMax: 15000,      // 批量错误后等待全部594(最长)
    fullReviewWaitMax: 45000,      // 全剧审核后等待合集移走(最长)
    settleAfterBatchError: 1000,   // 判错成功后额外等待（落库缓冲）
    // —— 慢合集(>300集)等待 ——
    expandWaitMaxSlow: 30000,
    batchErrorWaitMaxSlow: 25000,
    fullReviewWaitMaxSlow: 60000,
    settleAfterBatchErrorSlow: 3000,
    // —— 弹窗/按钮 ——
    modalWaitMax: 8000,            // 确认弹窗最长等待
    batchBtnWaitMax: 5000,         // 批量按钮从禁用变可用最长等待
    checkInterval: 500,            // 轮询间隔
    // —— 全错筛选（短剧名关键词/字数）——
    nameKeywords: ['短剧', '画', '漫剧', 'AI', '充电', '红果', '专属', '动画', '免费', '剪辑', '花絮', '拍摄', '经典', '剧', '真人', '免', '动漫', '动', '&', '定档', '首播', '漫', 'ai', '果'],
    nameMinLength: 4,
    // —— 运行 ——
    startRow: 1,                   // 起始行号（1开始；问题合集跳过后期固定第2行）
    maxSkipPerId: 2,               // 同一合集连续异常次数上限，达到即停止人工介入
    afterProblemDelay: 2000,       // 收起问题合集后等待再继续
  };

  // ========== 运行状态 ==========
  const state = {
    running: false,
    processedCount: 0,
    workIndex: 0,        // 当前工作行（0=第1行）；问题合集跳过后固定为1
    workRowLabel: 1,
    failId: null,        // 正在累计失败次数的合集标识
    failCount: 0,
    statusText: '空闲',
    judgeDone: 0,        // 594已完成数
    judgeNeed: 0,        // 594需要总数
  };

  // ========== 元素选择器 ==========
  const SELECTORS = {
    parentRow: 'tr.ant-table-row.ant-table-row-level-0',
    expandIcon: '.ant-table-row-expand-icon',
    parentIdCell: 'td:nth-child(2)',     // 合集ID（判定是否还是同一个）
    parentNameCell: 'td:nth-child(3)',   // 合集名/短剧名（全错筛选）
    parentScoreCell: 'td:nth-child(5)',  // 匹配最高分
    statusCell: 'td:nth-child(7)',       // 审核状态
    episodesCell: 'td:nth-child(10)',    // 集数
    expandedRow: 'tr.ant-table-expanded-row',
    childSelectAll: '.ant-pro-table thead th:first-child input.ant-checkbox-input',
    childRow: '.ant-pro-table tbody tr.ant-table-row',
    childCheckbox: 'td:first-child input.ant-checkbox-input',
    childScoreCell: 'td:nth-child(8)',   // 子样本得分
    childHideFlagCell: 'td:nth-child(3)',// 子样本 hide_flag：判错成功后 0 → 594
  };

  // ========== 工具函数 ==========
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const qsa = (root, sel) => (root || document).querySelectorAll(sel);
  const qs = (root, sel) => (root || document).querySelector(sel);

  // 取单元格文本（结构如 <td><div class=" ">226</div></td>，textContent 已包含内层文本）
  function cellText(row, selector) {
    const el = row ? row.querySelector(selector) : null;
    return el ? el.textContent.replace(/\s+/g, '').trim() : '';
  }

  function parseNum(text) {
    const n = parseFloat(text);
    return isNaN(n) ? null : n;
  }

  function log(msg) {
    console.log('[短剧5.0] ' + msg);
    const el = document.querySelector('#s5-log');
    if (!el) return;
    const line = document.createElement('div');
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    el.prepend(line);
    while (el.children.length > 200) el.lastChild.remove();
  }

  function setStatus(msg) {
    state.statusText = msg;
    console.log('[状态] ' + msg);
    const el = document.querySelector('#s5-status');
    if (el) el.textContent = msg;
    // 最小化时标题栏也显示当前状态
    const t = document.querySelector('#s5-mini-status');
    if (t) t.textContent = msg;
  }

  // 按文本查找元素（替代不兼容的 :contains()）
  function findByText(root, selector, text) {
    const elements = (root || document).querySelectorAll(selector);
    for (const el of elements) {
      if ((el.textContent || '').trim().includes(text)) return el;
    }
    return null;
  }

  // 等待元素出现
  function waitForElement(selector, context, timeout) {
    context = context || document;
    timeout = timeout || 10000;
    return new Promise((resolve, reject) => {
      const el = context.querySelector(selector);
      if (el) return resolve(el);
      const observer = new MutationObserver(() => {
        const target = context.querySelector(selector);
        if (target) { clearTimeout(timer); observer.disconnect(); resolve(target); }
      });
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error('等待超时: ' + selector));
      }, timeout);
      observer.observe(context, { childList: true, subtree: true });
    });
  }

  // 元素是否可见
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
  }

  // 安全点击
  function safeClick(el) {
    if (!el || !el.isConnected) return false;
    try { el.click(); return true; }
    catch (e) { console.warn('[短剧5.0] 点击失败:', e.message || e); return false; }
  }

  // ==========【弹窗确定按钮】ant-popconfirm 优先（4.5 同款） ==========
  async function waitForConfirmBtn(timeout) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      // 策略1: .ant-popconfirm
      const popconfirms = document.querySelectorAll('.ant-popconfirm');
      for (const pc of popconfirms) {
        if (!pc.isConnected) continue;
        const style = window.getComputedStyle(pc);
        if (style.display === 'none' || style.opacity === '0') continue;
        const btns = pc.querySelectorAll('button');
        for (const btn of btns) {
          const txt = (btn.textContent || '').replace(/\s+/g, '');
          if ((txt.includes('确定') || txt.includes('确认') || txt.includes('删除')) && !txt.includes('取消')) {
            return btn;
          }
        }
      }
      // 策略2: .ant-modal 内 primary
      const modals = document.querySelectorAll('.ant-modal-wrap, .ant-modal');
      for (const modal of modals) {
        if (!modal.isConnected) continue;
        const style = window.getComputedStyle(modal);
        if (style.display === 'none') continue;
        const btns = modal.querySelectorAll('button.ant-btn-primary');
        for (const btn of btns) {
          const txt = (btn.textContent || '').replace(/\s+/g, '');
          if ((txt.includes('确定') || txt.includes('确认') || txt.includes('删除')) && !txt.includes('取消')) {
            return btn;
          }
        }
      }
      await delay(200);
    }
    console.warn('[弹窗定位] 超时，未找到确定按钮');
    return null;
  }

  // 确认弹窗增强点击
  async function clickConfirm(timeout) {
    const confirmBtn = await waitForConfirmBtn(timeout);
    if (!confirmBtn) return false;
    confirmBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    safeClick(confirmBtn);
    confirmBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  }

  // ========== 行信息 ==========
  function getRowStatus(row) {
    return cellText(row, SELECTORS.statusCell);
  }

  function getParentScore(row) {
    const n = parseNum(cellText(row, SELECTORS.parentScoreCell));
    return n === null ? null : n;
  }

  // 合集元信息：ID(第2列) / 名字(第3列) / 集数(第10列) / 是否慢处理
  function getCollectionMeta(row) {
    const id = cellText(row, SELECTORS.parentIdCell) || cellText(row, SELECTORS.parentNameCell);
    const name = cellText(row, SELECTORS.parentNameCell);
    const episodes = parseNum(cellText(row, SELECTORS.episodesCell)) || 0;
    return {
      id: id || 'unknown-' + Date.now(),
      name: name,
      episodes: episodes,
      isSlow: episodes > CONFIG.slowEpisodeThreshold,
    };
  }

  // ========== 全错筛选（4.5 同款） ==========
  function checkParentName(parentRow) {
    const name = cellText(parentRow, SELECTORS.parentNameCell);
    if (!name) { console.warn('[全错] 母行短剧名为空'); return false; }
    for (const kw of CONFIG.nameKeywords) {
      if (name.includes(kw)) {
        console.log('[全错] 短剧名"' + name + '"含关键词"' + kw + '" → 全选判错');
        return true;
      }
    }
    if (name.length <= CONFIG.nameMinLength) {
      console.log('[全错] 短剧名"' + name + '"字数' + name.length + '≤' + CONFIG.nameMinLength + ' → 全选判错');
      return true;
    }
    return false;
  }

  // ========== hide_flag 判定 ==========
  // hide_flag 在子样本第3列：判错成功后变成 594（原本 0）
  function isFlagged594(row) {
    const txt = cellText(row, SELECTORS.childHideFlagCell);
    if (!txt) return false;
    return /(^|[^\d])594([^\d]|$)/.test(txt);
  }

  function getChildRows(expandedRow) {
    return Array.from(qsa(expandedRow, SELECTORS.childRow));
  }

  // 规则行 = 需要被判错(需要594)的行：全错=全部子行；阈值=得分<childScoreThreshold 的行
  function getRuleRows(expandedRow, fullError) {
    const rows = getChildRows(expandedRow);
    if (fullError) return rows;
    return rows.filter((row) => {
      const score = parseNum(cellText(row, SELECTORS.childScoreCell));
      return score !== null && score < CONFIG.childScoreThreshold;
    });
  }

  // 勾选某个子行（若未勾选且未打594）
  function checkChildRow(row) {
    if (isFlagged594(row)) return false;
    const cb = row.querySelector(SELECTORS.childCheckbox);
    if (!cb) return false;
    if (!cb.checked) safeClick(cb);
    return true;
  }

  // ========== 展开/收起合集 ==========
  async function expandRowAndWait(parentRow, timeout) {
    const expandBtn = parentRow.querySelector(SELECTORS.expandIcon);
    if (!expandBtn) throw new Error('未找到展开按钮');

    if (!expandBtn.classList.contains('ant-table-row-expand-icon-expanded')) {
      safeClick(expandBtn);
      await delay(300);
    }

    let expandedRow = parentRow.nextElementSibling;
    while (expandedRow && !expandedRow.classList.contains('ant-table-expanded-row')) {
      expandedRow = expandedRow.nextElementSibling;
    }
    if (!expandedRow) throw new Error('未找到展开区域');

    // 等待子样本行出现
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!state.running) throw new Error('已停止');
      if (getChildRows(expandedRow).length > 0) return expandedRow;
      await delay(CONFIG.checkInterval);
    }
    throw new Error('子表格加载超时(' + Math.round(timeout / 1000) + 's)');
  }

  // 收起合集：若当前已展开则再点一次展开按钮
  async function collapseRow(parentRow) {
    const expandBtn = parentRow.querySelector(SELECTORS.expandIcon);
    if (!expandBtn) return;
    if (expandBtn.classList.contains('ant-table-row-expand-icon-expanded')) {
      safeClick(expandBtn);
      await delay(500);
    }
  }

  // ========== 勾选待判行 ==========
  // 返回实际勾选数量（跳过了已勾选和已打594的行）
  async function selectTargetRows(expandedRow, fullError) {
    const rows = getChildRows(expandedRow);
    if (rows.length === 0) return 0;

    if (fullError) {
      // 全错：逐行勾选未打594的行（不点表头全选，避免把已判错的行重复选中）
      let count = 0;
      for (const row of rows) {
        if (!state.running) break;
        if (checkChildRow(row)) { count++; await delay(30); }
      }
      return count;
    }

    // 阈值：Shift 连续多选 未勾选且未打594 且 低分 的行
    const targetIndexes = [];
    rows.forEach((row, index) => {
      if (isFlagged594(row)) return;
      const score = parseNum(cellText(row, SELECTORS.childScoreCell));
      const checkbox = row.querySelector(SELECTORS.childCheckbox);
      if (!checkbox || checkbox.checked) return;
      if (score !== null && score < CONFIG.childScoreThreshold) targetIndexes.push(index);
    });
    if (targetIndexes.length === 0) return 0;

    // 划分连续区块
    const blocks = [];
    let cur = [targetIndexes[0]];
    for (let i = 1; i < targetIndexes.length; i++) {
      if (targetIndexes[i] === targetIndexes[i - 1] + 1) cur.push(targetIndexes[i]);
      else { blocks.push(cur); cur = [targetIndexes[i]]; }
    }
    blocks.push(cur);

    let totalChecked = 0;
    for (const block of blocks) {
      if (!state.running) break;
      const firstCb = rows[block[0]].querySelector(SELECTORS.childCheckbox);
      if (!firstCb) continue;
      if (block.length === 1) {
        firstCb.click();
        totalChecked++;
        await delay(50);
        continue;
      }
      const lastCb = rows[block[block.length - 1]].querySelector(SELECTORS.childCheckbox);
      if (!lastCb) continue;
      firstCb.click();
      await delay(50);
      lastCb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
      totalChecked += block.length;
      await delay(100);
    }
    return totalChecked;
  }

  // ========== 点击按钮 + 确认弹窗 ==========
  // scope: 在该元素内找按钮；找不到则逐级向外扩大到整个表格体/文档
  // 带重试：提交失败可能是点击瞬间的抖动，先重试几次再判定为异常
  async function clickActionButtonRetry(scope, btnText, attempts, gapMs) {
    attempts = attempts || 3;
    gapMs = gapMs || 3000;
    for (let i = 1; i <= attempts; i++) {
      if (!state.running) return false;
      const ok = await clickActionButton(scope, btnText);
      if (ok) return true;
      if (i < attempts) {
        log('「' + btnText + '」提交未成功，' + (gapMs / 1000) + 's 后第 ' + (i + 1) + ' 次重试...');
        setStatus('重试「' + btnText + '」(' + (i + 1) + '/' + attempts + ')...');
        await delay(gapMs);
      }
    }
    return false;
  }

  async function clickActionButton(scope, btnText) {
    let btn = findByText(scope, 'button', btnText);
    if (!btn || btn.disabled) {
      btn = findByText(scope.closest ? (scope.closest('.ant-table-tbody') || document) : document, 'button', btnText);
    }
    if (!btn) { console.warn('[按钮] 未找到「' + btnText + '」'); return false; }

    // 按钮可能刚勾选后短暂禁用 → 等待可用
    const start = Date.now();
    while (btn.disabled) {
      if (Date.now() - start > CONFIG.batchBtnWaitMax) {
        console.warn('[按钮] 「' + btnText + '」长时间禁用（可能无勾选项）');
        return false;
      }
      await delay(300);
    }

    console.log('[按钮] 点击「' + btnText + '」');
    safeClick(btn);
    await delay(800);
    if (!(await clickConfirm(CONFIG.modalWaitMax))) {
      console.warn('[按钮] 「' + btnText + '」确认弹窗未出现');
      return false;
    }
    return true;
  }

  // ========== 等待全部问题数据打上594（判错成功标志） ==========
  // 只要还有规则行未变594就继续等；全部594返回 true
  async function waitAllFlagged594(expandedRow, fullError, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!state.running) return false;

      const remain = getRuleRows(expandedRow, fullError).filter((r) => !isFlagged594(r));
      const total = state.judgeNeed || (state.judgeDone + remain.length);
      state.judgeDone = total - remain.length;
      state.judgeNeed = total;
      setStatus('判错处理中 hide_flag 594: ' + state.judgeDone + '/' + total + (remain.length === 0 ? ' ✅' : ' ⏳'));

      if (remain.length === 0) return true;
      await delay(CONFIG.checkInterval);
    }
    return false;
  }

  // ========== 全剧审核后等待系统完成 ==========
  // 完成标志：当前工作行的合集ID已不是刚处理的那个（已审核合集自动移到列表末尾）
  // 或该行状态变为已审核 / 行消失
  async function waitReviewCompleted(meta, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!state.running) return 'stopped';
      const rows = qsa(document, SELECTORS.parentRow);
      const R = rows[state.workIndex];
      if (!R) return 'done';                      // 行没了 → 处理完成
      if (getRowStatus(R).includes('已审核')) return 'done'; // 该位置已是已审核合集
      const curMeta = getCollectionMeta(R);
      if (curMeta.id !== meta.id) return 'next';  // 换成了新合集 → 处理完成
      await delay(CONFIG.checkInterval);
    }
    return 'stall';
  }

  // ========== 处理单个合集 ==========
  // 返回 'ok' 处理完成 | 'problem' 合集有问题(收起并跳过)
  async function processOneCollection(R, meta, isFullError) {
    // 1. 展开（慢合集放宽等待）
    const expandWait = meta.isSlow ? CONFIG.expandWaitMaxSlow : CONFIG.expandWaitMax;
    setStatus('展开合集「' + meta.name + '」(' + meta.episodes + '集' + (meta.isSlow ? '·慢处理' : '') + ')...');
    let expandedRow;
    try {
      expandedRow = await expandRowAndWait(R, expandWait);
    } catch (e) {
      log('展开失败: ' + e.message);
      return 'problem';
    }

    // 2. 计算需要判错(需要594)的问题数据
    const needRows = getRuleRows(expandedRow, isFullError).filter((r) => !isFlagged594(r));
    if (needRows.length === 0) {
      log('子表内问题数据已全部打594，直接进入全剧审核');
    } else {
      // 3. 勾选
      state.judgeNeed = needRows.length;
      state.judgeDone = 0;
      setStatus('勾选待判子样本 ' + needRows.length + ' 条（' + (isFullError ? '全错' : '低分<' + CONFIG.childScoreThreshold) + '）...');
      const checked = await selectTargetRows(expandedRow, isFullError);
      if (!state.running) return 'problem';
      if (checked === 0) {
        log('无新增可勾选行，检查是否全部已勾选/已判错');
      }
      await delay(500);

      // 4. 批量错误（判错）——失败自动重试3次
      log('点击「批量错误」...');
      if (!(await clickActionButtonRetry(expandedRow, '批量错误', 3, 3000))) {
        log('批量错误提交失败（按钮不可用或弹窗未出现）');
        return 'problem';
      }

      // 5. 等待全部594（判错成功才继续）——慢合集放宽
      const judgeWait = meta.isSlow ? CONFIG.batchErrorWaitMaxSlow : CONFIG.batchErrorWaitMax;
      const ok = await waitAllFlagged594(expandedRow, isFullError, judgeWait);
      if (!ok) {
        log('等待594超时(' + Math.round(judgeWait / 1000) + 's)，仍有未判错数据，判定合集有问题');
        return 'problem';
      }
      log('✅ 判错完成，全部问题数据 hide_flag=594');

      // 6. 判错成功后额外等待（落库缓冲）
      setStatus('判错成功，等待系统落库...');
      await delay(meta.isSlow ? CONFIG.settleAfterBatchErrorSlow : CONFIG.settleAfterBatchError);
      if (!state.running) return 'problem';
    }

    // 7. 全剧审核 —— 只有判错全部完成才执行（失败自动重试3次）
    setStatus('提交「全剧审核」...');
    if (!(await clickActionButtonRetry(R, '全剧审核', 3, 3000))) {
      log('全剧审核提交失败');
      return 'problem';
    }

    // 8. 等待系统完成全剧审核（合集被移到列表末尾 / 状态变已审核）
    const reviewWait = meta.isSlow ? CONFIG.fullReviewWaitMaxSlow : CONFIG.fullReviewWaitMax;
    setStatus('全剧审核处理中，等待合集移走...');
    const outcome = await waitReviewCompleted(meta, reviewWait);
    if (outcome === 'stall') {
      log('全剧审核等待超时(' + Math.round(reviewWait / 1000) + 's)，合集仍未被移走');
      return 'problem';
    }
    if (outcome === 'stopped') return 'problem';
    return 'ok';
  }

  // ========== 主循环 ==========
  async function runLoop() {
    let done = false;
    while (state.running) {
      try {
        // 取当前工作行
        const rows = qsa(document, SELECTORS.parentRow);
        if (rows.length === 0) { log('页面无数据行'); done = true; break; }

        const R = rows[state.workIndex];
        if (!R) {
          if (state.workIndex > 0) {
            log('第2行不存在——若第1行仍有问题合集未处理，请停止后人工处理；其余已完成');
          } else {
            log('第1行不存在，全部处理完成');
          }
          done = true;
          break;
        }

        const status = getRowStatus(R);
        if (status.includes('已审核')) {
          log('当前工作行已是「已审核」，全部处理完成');
          done = true;
          break;
        }

        const meta = getCollectionMeta(R);
        const isFullError = checkParentName(R);
        log('===== 处理 第' + (state.workIndex + 1) + '行 合集[' + meta.id + ']「' + meta.name + '」集数' + meta.episodes + (meta.isSlow ? '（慢处理）' : '') + ' | 全错=' + isFullError + ' =====');

        // 同一合集失败次数累计（换合集则清零）
        if (state.failId !== meta.id) {
          state.failId = meta.id;
          state.failCount = 0;
        }

        const result = await processOneCollection(R, meta, isFullError);
        if (!state.running) break;

        if (result === 'ok') {
          state.failCount = 0;
          state.processedCount++;
          updatePanel();
          log('✅ 第' + (state.workIndex + 1) + '行合集完成（累计 ' + state.processedCount + ' 条）');
          continue;
        }

        // problem：收起合集 → 跳过
        state.failCount++;
        setStatus('该合集处理异常，收起并跳过（第' + state.failCount + '次）...');
        log('收起问题合集...');
        await collapseRow(R);
        await delay(CONFIG.afterProblemDelay);

        if (state.failCount >= CONFIG.maxSkipPerId) {
          log('同一合集连续异常 ' + state.failCount + ' 次，停止运行，请人工处理');
          done = true;
          break;
        }
        if (state.workIndex === 0) {
          state.workIndex = 1; // 固定第2行继续（第1行问题合集不再自动重试）
          state.workRowLabel = 2;
          log('已固定从第2行继续判定（第1行合集可能无法正常打开）');
          updatePanel();
        }
      } catch (e) {
        console.error('[短剧5.0] 主循环异常:', e);
        log('主循环异常: ' + (e.message || e) + '，3秒后继续');
        await delay(3000);
      }
    }
    setStatus(done ? '全部处理完成' : '已停止');
    stopRun();
    if (done) {
      setTimeout(() => alert('全部处理完成！共 ' + state.processedCount + ' 条合集'), 100);
    }
  }

  // ========== 面板 ==========
  function updatePanel() {
    const el = document.querySelector('#s5-count');
    if (el) el.textContent = state.processedCount;
    const r = document.querySelector('#s5-row');
    if (r) r.textContent = (state.workIndex + 1);
  }

  function initDrag(panel, handle) {
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
  }

  function buildPanel() {
    if (document.querySelector('#s5-panel')) return;
    const panel = document.createElement('div');
    panel.id = 's5-panel';
    panel.innerHTML = `
      <div class="p5-title" id="s5-title">短剧审核助手 5.0
        <button id="s5-min" class="p5-min" title="最小化/展开">—</button>
      </div>
      <div class="p5-statusline"><span id="s5-status">空闲</span></div>
      <div class="p5-main" id="s5-main">
        <div class="form-row">
          <label>起始行号：</label>
          <input type="number" id="start-row" value="${CONFIG.startRow}" min="1">
          <span>行</span>
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
        <div class="form-row">
          <label>慢处理集数：</label>
          <input type="number" id="slow-threshold" value="${CONFIG.slowEpisodeThreshold}" min="1">
          <span>集以上</span>
        </div>
        <div class="stat-row">当前行：第 <b id="s5-row">1</b> 行 &nbsp;|&nbsp; 已完成：<b id="s5-count">0</b> 条</div>
        <div class="btn-row">
          <button id="start-btn" class="btn btn-start">开始运行</button>
          <button id="stop-btn" class="btn btn-stop" disabled>停止</button>
        </div>
        <div class="tip">
          判错安全机制：批量错误后必须等所有问题数据 hide_flag=594 才点全剧审核<br>
          合集异常(打不开/594超时) → 收起并固定第2行继续<br>
          >${CONFIG.slowEpisodeThreshold}集合集自动慢处理（更长等待）<br>
          全剧审核完成 = 该合集自动移到列表末尾（当前行ID变化）
        </div>
        <div class="p5-log" id="s5-log"></div>
      </div>
      <div class="p5-mini-status" id="s5-mini-status"></div>
    `;
    document.body.appendChild(panel);

    const css = document.createElement('style');
    css.textContent = `
      #s5-panel{position:fixed;top:100px;right:20px;width:290px;background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.15);z-index:999999;font-size:13px;font-family:system-ui,sans-serif;}
      .p5-title{padding:8px 12px;background:#722ed1;color:#fff;border-radius:8px 8px 0 0;font-weight:600;position:relative;}
      .p5-min{position:absolute;right:8px;top:6px;width:22px;height:22px;line-height:18px;border:none;border-radius:4px;background:rgba(255,255,255,.25);color:#fff;cursor:pointer;font-size:14px;}
      .p5-min:hover{background:rgba(255,255,255,.45);}
      .p5-statusline{padding:6px 12px;background:#fff7e6;border-bottom:1px solid #ffe7ba;color:#d46b08;font-size:12px;min-height:26px;}
      .p5-statusline span{word-break:break-all;}
      .p5-mini-status{display:none;padding:6px 12px;background:#fff7e6;color:#d46b08;font-size:12px;border-radius:0 0 8px 8px;}
      .p5-main{padding:10px 12px;}
      .form-row{display:flex;align-items:center;gap:5px;margin-bottom:8px;}
      .form-row label{width:86px;font-size:12px;color:#666;flex:none;}
      .form-row input{width:58px;padding:3px 5px;border:1px solid #d9d9d9;border-radius:4px;outline:none;font-size:12px;}
      .stat-row{margin-bottom:8px;color:#333;font-size:12px;}
      .stat-row b{color:#722ed1;font-size:15px;}
      .btn-row{display:flex;gap:8px;margin-bottom:8px;}
      .btn{flex:1;padding:6px 0;border:none;border-radius:4px;cursor:pointer;font-size:13px;}
      .btn:disabled{opacity:0.5;cursor:not-allowed;}
      .btn-start{background:#52c41a;color:#fff;}
      .btn-stop{background:#ff4d4f;color:#fff;}
      .tip{font-size:11px;color:#999;margin-bottom:8px;line-height:1.7;}
      .p5-log{max-height:160px;overflow-y:auto;background:#fafafa;border-radius:4px;padding:5px 7px;font-size:11px;font-family:Consolas,monospace;line-height:1.6;color:#666;word-break:break-all;}
    `;
    document.head.appendChild(css);

    initDrag(panel, panel.querySelector('#s5-title'));

    // 最小化/展开
    const main = panel.querySelector('#s5-main');
    const miniStatus = panel.querySelector('#s5-mini-status');
    const statusEl = panel.querySelector('#s5-status');
    document.querySelector('#s5-min').addEventListener('click', () => {
      const hidden = main.style.display === 'none';
      main.style.display = hidden ? '' : 'none';
      miniStatus.style.display = hidden ? 'none' : '';
      if (hidden) document.querySelector('#s5-min').textContent = '—';
      else document.querySelector('#s5-min').textContent = '□';
      if (!hidden) miniStatus.textContent = '';
    });

    document.querySelector('#start-btn').addEventListener('click', () => {
      const row = parseInt(document.querySelector('#start-row').value);
      const p = parseInt(document.querySelector('#parent-threshold').value);
      const c = parseInt(document.querySelector('#child-threshold').value);
      const s = parseInt(document.querySelector('#slow-threshold').value);
      if (!isNaN(row) && row > 0) CONFIG.startRow = row;
      if (!isNaN(p)) CONFIG.parentScoreThreshold = p;
      if (!isNaN(c)) CONFIG.childScoreThreshold = c;
      if (!isNaN(s) && s > 0) CONFIG.slowEpisodeThreshold = s;
      startRun();
    });
    document.querySelector('#stop-btn').addEventListener('click', stopRun);
  }

  function startRun() {
    if (state.running) return;
    state.running = true;
    state.processedCount = 0;
    state.failId = null;
    state.failCount = 0;
    state.workIndex = CONFIG.startRow - 1;
    state.workRowLabel = CONFIG.startRow;
    document.querySelector('#start-btn').disabled = true;
    document.querySelector('#stop-btn').disabled = false;
    updatePanel();
    setStatus('启动中...');
    log('===== 开始运行（从第' + CONFIG.startRow + '行起）=====');
    // 结构自检：打印第1~2行解析结果，便于发现页面改版
    setTimeout(debugStructure, 1500);
    runLoop();
  }

  function stopRun() {
    state.running = false;
    document.querySelector('#start-btn').disabled = false;
    document.querySelector('#stop-btn').disabled = true;
  }

  // 结构自检：输出首行解析到的 ID/名字/集数/状态，方便确认选择器是否失效
  function debugStructure() {
    try {
      const rows = qsa(document, SELECTORS.parentRow);
      for (let i = 0; i < Math.min(2, rows.length); i++) {
        const meta = getCollectionMeta(rows[i]);
        console.log('[自检] 第' + (i + 1) + '行 → ID:[' + meta.id + '] 名字:[' + meta.name + '] 集数:' + meta.episodes + ' 状态:[' + getRowStatus(rows[i]) + ']');
      }
    } catch (e) {
      console.warn('[自检] 页面结构解析异常:', e);
    }
  }

  // ========== 初始化 ==========
  const init = () => {
    try { buildPanel(); } catch (e) { console.error('初始化失败:', e); }
  };

  if (document.readyState === 'complete') {
    setTimeout(init, 1500);
  } else {
    window.addEventListener('load', () => setTimeout(init, 1500));
  }
})();
