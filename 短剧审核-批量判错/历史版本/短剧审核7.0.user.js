// ==UserScript==
// @name         Shift短剧审核-双模式全剧审核版【7.0】
// @namespace    https://doubao.com/userscripts
// @version      7.0.0
// @description  两种处理方式：①匹配分>阈值 → 不展开合集直接全剧审核；②其余视为全错 → 展开+全选+批量错误(等全部594)+全剧审核；【7.0 新增严格等待加载完成：转圈消失才进行下一步】
// @author       Doubao
// @match        https://tools.vobile.cn/quality/dramaReview*
// @grant        none
// @run-at       document-end
// ==/UserScript==

// ============================== 7.0.0 更新记录 ==============================
//  【新增】严格等待加载完成（antd 转圈闸门），解决"系统还在处理脚本就点下一步"的问题：
//    - 点「全剧审核」确认后，确认键旁会出现转圈 → 现在会等转圈消失再判断合集是否移走；
//    - 点「批量错误」确认后同样出现转圈 → 等转圈消失 + 全部子样本变 594 才算判错完成；
//    - 每次点击按钮前 / 展开合集后 / 勾选前，都要求页面无转圈才继续；
//    - 严格等待超时（默认90s，慢合集150s）则该轮不点击、安全停止并提示，不会硬冲。
//  转圈识别：button.ant-btn-loading（按钮内转圈）、.ant-spin-dot-spin / .ant-spin-spinning（区域转圈）
// ============================================================================


(function () {
  'use strict';

  console.log('[短剧审核6.0] 双模式全剧审核版已加载');

  // ========== 可配置项 ==========
  const CONFIG = {
    // —— 模式判定 ——
    parentScoreThreshold: 95,      // 父行匹配最高分(第5列)：≤该值 → 一律模式2(全错)；>该值 → 模式1(有正确数据)
    correctCodes: ['777', '601'],  // 子样本状态码(第3列)：仅当匹配分读不到时作为兜底判据（有则模式1）
    wrongCode: '594',              // 判错完成标志（全选+批量错误后，子样本状态码 0 → 594）
    unjudgedCode: '0',             // 未判定
    // —— 慢处理（集数 > 阈值）——
    slowEpisodeThreshold: 300,
    expandWaitMax: 15000,          // 普通：展开合集最长等待
    expandWaitMaxSlow: 30000,      // 慢合集：展开最长等待
    batchErrorWaitMax: 15000,      // 普通：批量错误后等待全部594(最长)
    batchErrorWaitMaxSlow: 25000,  // 慢合集
    fullReviewWaitMax: 45000,      // 普通：全剧审核后等待合集移走(最长)
    fullReviewWaitMaxSlow: 60000,  // 慢合集
    settleAfterBatchError: 1000,   // 判错成功后额外等待（落库缓冲）
    settleAfterBatchErrorSlow: 3000,
    // —— 严格等待加载完成（7.0 新增：antd 转圈消失才进行下一步）——
    strictLoading: true,           // true=严格等待（推荐）；false=只按超时/数据变化判断
    loadingWaitMax: 90000,         // 普通合集：单次等待"加载完成"的最长时间(ms)
    loadingWaitMaxSlow: 150000,    // 慢合集(>slowEpisodeThreshold 集)：放宽
    loadingCalmMs: 800,            // 连续多少毫秒无转圈才算"加载完成"
    // —— 弹窗/按钮 ——
    modalWaitMax: 8000,            // 确认弹窗最长等待
    batchBtnWaitMax: 5000,         // 按钮从禁用变可用最长等待
    checkInterval: 500,            // 轮询间隔
    // —— 全错强制规则：命中关键词 → 强制走模式2（全错）——
    nameKeywords: ['短剧', '画', '漫剧', 'AI', '充电', '红果', '专属', '动画', '免费', '剪辑', '花絮', '拍摄', '经典', '剧', '真人', '免', '动漫', '动', '&', '定档', '首播', '漫', 'ai', '果'],
    // —— 疑似正确相似度闸门：第3列短剧名 vs 第4列(疑似抄袭的原短剧名) ——
    //   仅当短剧名长度 ≤ similarGateNameLen 时才做这个判定；超过则跳过闸门，直接看匹配分
    similarGateNameLen: 4,         // 短剧名(归一化后)字数 ≤ 该值 → 执行相似度闸门；> 该值 → 跳过闸门
    similarMinSubstr: 2,           // 存在连续 N 个字相同（如"渐染"）即算有相同词
    similarMinCommonChars: 3,      // 或 两段文本公共的不同字 ≥ N 个
    // —— 运行 ——
    startRow: 1,                   // 起始行号（1开始；问题合集跳过后期固定第2行）
    maxSkipPerId: 2,               // 同一合集连续异常次数上限，达到即停止人工介入
    afterProblemDelay: 2000,       // 收起问题合集后等待再继续
  };

  // ========== 运行状态 ==========
  const state = {
    running: false,
    processedCount: 0,
    mode1Count: 0,       // 直接全剧审核次数
    mode2Count: 0,       // 全选判错次数
    workIndex: 0,        // 当前工作行（0=第1行）；问题合集跳过后固定为1
    failId: null,        // 正在累计失败次数的合集标识
    failCount: 0,
    judgeDone: 0,        // 594已完成数
    judgeNeed: 0,        // 594需要总数
  };

  // ========== 元素选择器 ==========
  const SELECTORS = {
    parentRow: 'tr.ant-table-row.ant-table-row-level-0',
    expandIcon: '.ant-table-row-expand-icon',
    parentIdCell: 'td:nth-child(2)',     // 合集ID（判定是否还是同一个）
    parentNameCell: 'td:nth-child(3)',   // 合集名/短剧名
    parentOriginalNameCell: 'td:nth-child(4)', // 疑似抄袭的原短剧名（相似度比对用）
    parentScoreCell: 'td:nth-child(5)',  // 匹配最高分
    statusCell: 'td:nth-child(7)',       // 审核状态
    episodesCell: 'td:nth-child(10)',    // 集数
    childSelectAll: '.ant-pro-table thead th:first-child input.ant-checkbox-input',
    childRow: '.ant-pro-table tbody tr.ant-table-row',
    childCheckbox: 'td:first-child input.ant-checkbox-input',
    childCodeCell: 'td:nth-child(3)',    // 子样本状态码：0=未判定 594=判错完成 777/601=前人已判定(有正确数据)
  };

  // ========== 工具函数 ==========
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const qsa = (root, sel) => (root || document).querySelectorAll(sel);

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
    console.log('[短剧7.0] ' + msg);
    const el = document.querySelector('#s7-log');
    if (!el) return;
    const line = document.createElement('div');
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    el.prepend(line);
    while (el.children.length > 200) el.lastChild.remove();
  }

  function setStatus(msg) {
    console.log('[状态] ' + msg);
    const el = document.querySelector('#s7-status');
    if (el) el.textContent = msg;
    // 最小化时下方也显示当前状态
    const t = document.querySelector('#s7-mini-status');
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

  // 安全点击
  function safeClick(el) {
    if (!el || !el.isConnected) return false;
    try { el.click(); return true; }
    catch (e) { console.warn('[短剧7.0] 点击失败:', e.message || e); return false; }
  }

  // ========== 严格等待加载完成（antd 转圈闸门） ==========
  // 页面是否处于"处理中"：
  //   1) 任一按钮正在提交（ant-btn-loading）—— 例如点「批量错误」确认后，确认键旁出现的转圈
  //   2) 表格/区域正在加载（ant-spin-spinning / ant-spin-dot-spin）—— 例如点「全剧审核」后出现的转圈
  function isLoading() {
    if (document.querySelector('button.ant-btn-loading')) return true;
    if (document.querySelector('.ant-spin-dot-spin')) return true;

    const scopes = ['.ant-pro-table', '.ant-table-wrapper', '.ant-table', '.ant-modal', '.ant-popconfirm'];
    for (const s of scopes) {
      const els = document.querySelectorAll(s);
      for (const el of els) {
        if (el.querySelector('.ant-spin-spinning')) return true;
      }
    }
    // 兜底：页面任何位置还在转圈（排除我们自己的面板）
    for (const sp of document.querySelectorAll('.ant-spin-spinning')) {
      if (!sp.closest('#s7-panel')) return true;
    }
    return false;
  }

  // 严格等待「加载完成」：必须连续 loadingCalmMs 毫秒都没有转圈才算完成
  // 返回 true=已完成 / false=超时（严格模式下调用方应放弃本次点击，安全停止）
  async function waitLoadingDone(what, maxWait) {
    if (!CONFIG.strictLoading) return true;
    const t = maxWait || CONFIG.loadingWaitMax;
    const start = Date.now();
    let calmSince = 0;
    while (Date.now() - start < t) {
      if (!state.running) return false;
      if (isLoading()) {
        calmSince = 0;
        setStatus('⏳ 等待系统处理完成' + (what ? '（' + what + '）' : '') +
          ' ' + Math.round((Date.now() - start) / 1000) + 's ...');
      } else {
        if (!calmSince) calmSince = Date.now();
        if (Date.now() - calmSince >= CONFIG.loadingCalmMs) return true;
      }
      await delay(CONFIG.checkInterval);
    }
    log('⚠️ 等待系统处理完成超时（' + Math.round(t / 1000) + 's）：' + (what || '') + ' —— 为安全起见本轮不点击');
    return false;
  }

  // ==========【弹窗确定按钮】ant-popconfirm 优先（4.5/5.0 同款） ==========
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

  // 确认弹窗增强点击（7.0：点确定前也要求页面无转圈）
  async function clickConfirm(timeout) {
    const confirmBtn = await waitForConfirmBtn(timeout);
    if (!confirmBtn) return false;
    if (CONFIG.strictLoading) await waitLoadingDone('确认弹窗就绪', 20000);
    confirmBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    safeClick(confirmBtn);
    confirmBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  }

  // ========== 行信息 ==========
  function getRowStatus(row) {
    return cellText(row, SELECTORS.statusCell);
  }

  // 合集元信息：ID(第2列) / 名字(第3列) / 匹配最高分(第5列) / 集数(第10列) / 是否慢处理
  function getCollectionMeta(row) {
    const id = cellText(row, SELECTORS.parentIdCell) || cellText(row, SELECTORS.parentNameCell);
    const name = cellText(row, SELECTORS.parentNameCell);
    const originalName = cellText(row, SELECTORS.parentOriginalNameCell);
    const score = parseNum(cellText(row, SELECTORS.parentScoreCell));
    const episodes = parseNum(cellText(row, SELECTORS.episodesCell)) || 0;
    return {
      id: id || 'unknown-' + Date.now(),
      name: name,
      originalName: originalName,
      score: score,
      episodes: episodes,
      isSlow: episodes > CONFIG.slowEpisodeThreshold,
    };
  }

  // ========== 全错强制规则（关键词） ==========
  // 返回命中的原因字符串；未命中返回 null
  function getForceWrongReason(parentRow) {
    const name = cellText(parentRow, SELECTORS.parentNameCell);
    if (!name) return null;
    for (const kw of CONFIG.nameKeywords) {
      if (name.includes(kw)) return '合集名含关键词「' + kw + '」';
    }
    return null;
  }

  // ========== 疑似正确：第3列短剧名 vs 第4列(疑似抄袭的原短剧名) 相似度闸门 ==========
  // 归一化：只保留中文/字母/数字（去标点、空格，统一小写）
  function normalizeText(s) {
    return (s || '').toLowerCase().replace(/[^\u4e00-\u9fff0-9a-z]/g, '');
  }

  // 最长公共连续子串长度
  function longestCommonSubstrLen(a, b) {
    if (!a || !b) return 0;
    const n = a.length, m = b.length;
    let prev = new Array(m + 1).fill(0);
    let best = 0;
    for (let i = 1; i <= n; i++) {
      const cur = new Array(m + 1).fill(0);
      for (let j = 1; j <= m; j++) {
        if (a[i - 1] === b[j - 1]) {
          cur[j] = prev[j - 1] + 1;
          if (cur[j] > best) best = cur[j];
        }
      }
      prev = cur;
    }
    return best;
  }

  // 公共的不同字数量
  function commonCharCount(a, b) {
    if (!a || !b) return 0;
    const setB = new Set(b.split(''));
    const setA = new Set(a.split(''));
    let count = 0;
    setA.forEach((ch) => { if (setB.has(ch)) count++; });
    return count;
  }

  // 相似判定：命中"连续N字相同"或"公共不同字≥N" → 疑似正确
  // 返回 { similar: bool, reason: string, detail: string }
  function checkSimilarOriginalName(parentRow, meta) {
    const rawA = meta ? meta.name : cellText(parentRow, SELECTORS.parentNameCell);
    const rawB = meta ? meta.originalName : cellText(parentRow, SELECTORS.parentOriginalNameCell);
    const a = normalizeText(rawA);
    const b = normalizeText(rawB);

    if (!a || !b) {
      return {
        similar: false,
        nameLen: a.length,
        reason: '第3列或第4列为空（短剧名:"' + rawA + '" / 原短剧名:"' + rawB + '"）→ 无法比对',
        detail: '空值',
      };
    }

    const lcs = longestCommonSubstrLen(a, b);
    const common = commonCharCount(a, b);
    const base = { nameLen: a.length };

    if (lcs >= CONFIG.similarMinSubstr) {
      return Object.assign(base, {
        similar: true,
        reason: '疑似正确：两列存在连续 ' + lcs + ' 字相同（≥' + CONFIG.similarMinSubstr + '）',
        detail: '最长连续相同 ' + lcs + ' 字 / 公共字 ' + common + ' 个',
      });
    }
    if (common >= CONFIG.similarMinCommonChars) {
      return Object.assign(base, {
        similar: true,
        reason: '疑似正确：两列公共不同字 ' + common + ' 个（≥' + CONFIG.similarMinCommonChars + '）',
        detail: '最长连续相同 ' + lcs + ' 字 / 公共字 ' + common + ' 个',
      });
    }
    return Object.assign(base, {
      similar: false,
      reason: '两列既不满足连续' + CONFIG.similarMinSubstr + '字相同，公共字也仅 ' + common +
        ' 个（<' + CONFIG.similarMinCommonChars + '）→ 直接全错',
      detail: '最长连续相同 ' + lcs + ' 字 / 公共字 ' + common + ' 个',
    });
  }

  // ========== 子样本状态码判定 ==========
  // 状态码在子样本第3列：0=未判定；594=判错完成；777/601=前人已判定(有正确数据)
  function getChildCode(row) {
    const txt = cellText(row, SELECTORS.childCodeCell);
    if (!txt) return '';
    const m = txt.match(/\d+/);
    return m ? m[0] : txt;
  }

  function getChildRows(expandedRow) {
    return Array.from(qsa(expandedRow, SELECTORS.childRow));
  }

  // 汇总当前展开子表的状态码分布
  function getCodeStats(expandedRow) {
    const rows = getChildRows(expandedRow);
    const counters = {};
    let unjudged = 0;
    const correctHits = [];
    rows.forEach((row) => {
      const code = getChildCode(row);
      counters[code] = (counters[code] || 0) + 1;
      // 空值也视为未判定（避免列结构异常时被误认为已完成）
      if (code === CONFIG.unjudgedCode || code === '') unjudged++;
      if (CONFIG.correctCodes.includes(code)) correctHits.push(code);
    });
    const detail = Object.keys(counters)
      .map((k) => (k === '' ? '(空)' : k) + '×' + counters[k])
      .join(', ');
    const wrongCount = counters[CONFIG.wrongCode] || 0;
    return {
      total: rows.length,
      unjudged: unjudged,
      wrong: wrongCount,                 // 已是 594 的行数
      notWrong: rows.length - wrongCount, // 还不是 594 的行数（含 0 与其它状态码）
      counters: counters,
      detail: detail,
      hasCorrect: correctHits.length > 0,
      correctHits: correctHits,
    };
  }

  // ========== 全选子样本 ==========
  // 优先点表头全选框；没有则逐行勾选未勾选的行。返回勾选到的复选框数量
  async function selectAllChildRows(expandedRow) {
    const rows = getChildRows(expandedRow);
    if (rows.length === 0) return 0;

    const selectAll = expandedRow.querySelector(SELECTORS.childSelectAll);
    if (selectAll && selectAll.isConnected) {
      if (!selectAll.checked) {
        safeClick(selectAll);
        await delay(500);
      }
      // 统计勾选结果
      let checked = 0;
      rows.forEach((row) => {
        const cb = row.querySelector(SELECTORS.childCheckbox);
        if (cb && cb.checked) checked++;
      });
      if (checked > 0) return checked;
      log('表头全选未生效，改为逐行勾选');
    }

    // 兜底：逐行勾选
    let count = 0;
    for (const row of rows) {
      if (!state.running) break;
      const cb = row.querySelector(SELECTORS.childCheckbox);
      if (cb && !cb.checked) {
        safeClick(cb);
        count++;
        await delay(30);
      }
    }
    return count;
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

    // 等待子样本行出现（7.0：出现后还要等转圈结束，确保子表数据渲染完整）
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!state.running) throw new Error('已停止');
      if (getChildRows(expandedRow).length > 0) {
        const wait = CONFIG.loadingWaitMax;
        if (CONFIG.strictLoading && !(await waitLoadingDone('合集展开后加载', wait))) {
          throw new Error('展开后加载未完成（转圈未结束）');
        }
        return expandedRow;
      }
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

  // ========== 按钮定位与点击（严格限定在本行范围内） ==========
  // 查找顺序：① 本行内 → ② 本行展开区内 → ③ 几何上位于"本行 ~ 下一行"之间的按钮（限定在本行 tbody 内）
  // 目的：绝不退化成"全表格搜第一个同名按钮"，避免处理第 N 行时点到别的合集的按钮。
  function findRowButton(R, btnText, expandedRow) {
    let btn = findByText(R, 'button', btnText);
    if (btn) return btn;

    if (expandedRow) {
      btn = findByText(expandedRow, 'button', btnText);
      if (btn) return btn;
    }

    const tbody = R.closest('.ant-table-tbody') || document;
    const rowRect = R.getBoundingClientRect();
    const rows = Array.from(qsa(document, SELECTORS.parentRow));
    const idx = rows.indexOf(R);
    const nextTop = (idx >= 0 && rows[idx + 1])
      ? rows[idx + 1].getBoundingClientRect().top
      : Infinity;

    for (const b of qsa(tbody, 'button')) {
      if (!(b.textContent || '').trim().includes(btnText)) continue;
      const r = b.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;                    // 不可见
      if (r.top >= rowRect.top - 4 && r.top < nextTop) return b;        // 落在本行区域内
    }
    return null;
  }

  // 点击本行范围内的按钮 + 确认弹窗
  // 返回 true=已提交 | false=未提交
  async function clickRowButton(R, btnText, expandedRow) {
    // 7.0 严格等待：点击前页面必须已无转圈（否则点击可能无效/被覆盖）
    if (CONFIG.strictLoading && !(await waitLoadingDone('点击「' + btnText + '」前'))) return false;

    const btn = findRowButton(R, btnText, expandedRow);
    if (!btn) { console.warn('[按钮] 本行范围内未找到「' + btnText + '」'); return false; }

    // 按钮可能刚勾选后短暂禁用 → 等待可用；若等待中按钮消失，说明已在提交中，视为已提交
    const start = Date.now();
    while (btn.disabled) {
      if (!btn.isConnected) { log('「' + btnText + '」按钮已消失，判定为已提交'); return true; }
      if (Date.now() - start > CONFIG.batchBtnWaitMax) {
        console.warn('[按钮] 「' + btnText + '」长时间禁用（可能无勾选项）');
        return false;
      }
      await delay(300);
    }

    console.log('[按钮] 点击「' + btnText + '」');
    safeClick(btn);
    await delay(800);

    if (await clickConfirm(CONFIG.modalWaitMax)) return true;
    console.warn('[按钮] 「' + btnText + '」确认弹窗未出现');
    return false;
  }

  // 带重试的提交：提交失败可能是点击瞬间抖动；若按钮已消失则视为上一次已提交，避免重复点击
  async function clickRowButtonRetry(R, btnText, expandedRow, attempts, gapMs) {
    attempts = attempts || 3;
    gapMs = gapMs || 3000;
    const existedAtStart = !!findRowButton(R, btnText, expandedRow);

    for (let i = 1; i <= attempts; i++) {
      if (!state.running) return false;
      if (await clickRowButton(R, btnText, expandedRow)) return true;

      // 开始时按钮存在、现在没了 → 极可能上次点击已生效（提交后按钮被移除/替换）
      if (existedAtStart && !findRowButton(R, btnText, expandedRow)) {
        log('「' + btnText + '」按钮已消失，判定为已提交');
        return true;
      }
      if (i < attempts) {
        log('「' + btnText + '」提交未成功，' + (gapMs / 1000) + 's 后第 ' + (i + 1) + ' 次重试...');
        setStatus('重试「' + btnText + '」(' + (i + 1) + '/' + attempts + ')...');
        await delay(gapMs);
      }
    }
    return false;
  }

  // ========== 等待全部子样本变成 594（判错完成） ==========
  // 模式2 的"等响应"：批量错误提交后，必须满足三个条件才算完成：
  //   ① 所有子样本状态码都是 594（不能只看"不再是0"，否则原有 777/601 会误判为完成）
  //   ② 页面转圈已结束（7.0：点确认后确认键旁/表格上会出现转圈，必须等它消失）
  async function waitAllJudged(expandedRow, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!state.running) return false;

      const stats = getCodeStats(expandedRow);
      const loading = isLoading();
      state.judgeNeed = stats.total;
      state.judgeDone = stats.wrong;
      setStatus('模式2 · 判错处理中 594: ' + stats.wrong + '/' + stats.total +
        (stats.notWrong === 0 ? ' ✅' : ' ⏳ [' + stats.detail + ']') +
        (loading ? '（系统处理中…）' : ''));

      if (stats.total > 0 && stats.wrong === stats.total && !loading) return true;
      await delay(CONFIG.checkInterval);
    }
    return false;
  }

  // ========== 全剧审核后等待系统完成 ==========
  // 完成标志：当前工作行的合集ID已不是刚处理的那个（已审核合集自动移到列表末尾）
  // 或该行状态变为已审核 / 行消失；
  // 7.0：另外要求页面无转圈（点「全剧审核」后会出现转圈，转圈结束才算系统处理完）
  async function waitReviewCompleted(meta, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!state.running) return 'stopped';

      const rows = qsa(document, SELECTORS.parentRow);
      const R = rows[state.workIndex];
      const loading = isLoading();
      if (loading) setStatus('全剧审核处理中（系统转圈中…）');

      if (!loading) {
        if (!R) return 'done';                      // 行没了 → 处理完成
        if (getRowStatus(R).includes('已审核')) return 'done'; // 该位置已是已审核合集
        const curMeta = getCollectionMeta(R);
        if (curMeta.id !== meta.id) return 'next';  // 换成了新合集 → 处理完成
      }
      await delay(CONFIG.checkInterval);
    }
    return 'stall';
  }

  // ========== 提交全剧审核并等待完成 ==========
  // expandFn：可选兜底。模式1 不展开合集直接点「全剧审核」；
  //           若按钮找不到/点不通（例如按钮只出现在展开区里），才用 expandFn 展开后重试，避免误判异常。
  // expandedRow：若已展开则传入，便于在展开区内定位按钮
  // 返回 'ok' | 'problem'
  async function doFullReview(R, meta, expandFn, expandedRow) {
    setStatus('提交「全剧审核」...');
    let exp = expandedRow || null;
    let ok = await clickRowButtonRetry(R, '全剧审核', exp, 2, 2000);

    if (!ok && expandFn) {
      log('未直接点通「全剧审核」，展开合集后重试...');
      setStatus('展开合集后重试「全剧审核」...');
      try {
        exp = await expandFn();
      } catch (e) {
        log('展开失败: ' + e.message);
      }
      ok = await clickRowButtonRetry(R, '全剧审核', exp, 3, 3000);
    }
    if (!ok) {
      log('全剧审核提交失败');
      return 'problem';
    }

    // 7.0 严格等待：点完「全剧审核」并确认后会立刻出现转圈
    //   → 先等转圈结束（系统处理完成），再判断合集是否被移走
    const loadWait = meta.isSlow ? CONFIG.loadingWaitMaxSlow : CONFIG.loadingWaitMax;
    if (!(await waitLoadingDone('全剧审核处理中', loadWait))) return 'problem';

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

  // ========== 处理单个合集 ==========
  // 模式1：匹配分 > 阈值 → 有正确数据 → 【不展开合集】直接全剧审核
  // 模式2：命中关键词 / 短名不相似 / 匹配分 ≤ 阈值 → 全错 → 展开 + 全选 + 批量错误(等全部594) + 全剧审核
  // 特例：匹配分读不到时，才需要展开看子样本 777/601 痕迹来定模式
  // 返回 { result: 'ok'|'problem', mode: 1|2|0 }
  async function processOneCollection(R, meta) {
    const expandWait = meta.isSlow ? CONFIG.expandWaitMaxSlow : CONFIG.expandWaitMax;
    const expandFn = () => expandRowAndWait(R, expandWait);

    // ---- 第0步（7.0）：严格等待上一轮遗留下的加载完成，避免带着转圈就开始操作 ----
    const startLoadWait = meta.isSlow ? CONFIG.loadingWaitMaxSlow : CONFIG.loadingWaitMax;
    if (CONFIG.strictLoading && !(await waitLoadingDone('开始处理本轮前', startLoadWait))) {
      return { result: 'problem', mode: 0 };
    }

    // ---- 第1步：先用母行信息判定模式（这一步不需要展开，省掉展开等待）----
    // 优先级：① 名称命中关键词 → 强制全错
    //         ② 相似度闸门（仅当短剧名字数 ≤ similarGateNameLen 时执行）不相似 → 直接全错
    //         ③ 匹配分 ≤ 阈值 → 一律按错误数据处理（不被 777/601 翻盘）
    //         ④ 匹配分 > 阈值 → 存在正确数据 → 模式1
    //         ⑤ 匹配分读不到 → 才需要展开看 777/601 痕迹
    const forceReason = getForceWrongReason(R);
    const sim = checkSimilarOriginalName(R, meta);
    const gateActive = sim.nameLen <= CONFIG.similarGateNameLen; // 短剧名 ≤4 字 才做相似度闸门
    log('相似度比对：短剧名「' + meta.name + '」(' + sim.nameLen + '字) vs 原短剧名「' + meta.originalName +
      '」 → ' + (gateActive ? (sim.similar ? '相似·疑似正确' : '不相似') : '跳过闸门(名称>' +
      CONFIG.similarGateNameLen + '字)') + '（' + sim.detail + '）');

    let mode = 0, reason = '', needExpandForDecision = false;
    if (forceReason) {
      mode = 2;
      reason = '强制全错：' + forceReason;
    } else if (gateActive && !sim.similar) {
      mode = 2;
      reason = '短剧名' + sim.nameLen + '字≤' + CONFIG.similarGateNameLen + '，触发相似度闸门：' + sim.reason;
    } else if (meta.score !== null && meta.score <= CONFIG.parentScoreThreshold) {
      mode = 2;
      reason = '父行匹配最高分 ' + meta.score + ' ≤ ' + CONFIG.parentScoreThreshold + ' → 一律按错误数据处理' +
        (gateActive ? '；' + sim.reason : '；短剧名' + sim.nameLen + '字>' + CONFIG.similarGateNameLen + '，已跳过相似度闸门');
    } else if (meta.score !== null && meta.score > CONFIG.parentScoreThreshold) {
      mode = 1;
      reason = '父行匹配最高分 ' + meta.score + ' > ' + CONFIG.parentScoreThreshold + ' → 存在正确数据' +
        (gateActive ? '；' + sim.reason : '；短剧名' + sim.nameLen + '字>' + CONFIG.similarGateNameLen + '，已跳过相似度闸门');
    } else {
      needExpandForDecision = true;
      reason = '匹配分读取失败 → 需展开合集查看 ' + CONFIG.correctCodes.join('/') + ' 痕迹才能定模式';
    }
    log('===== 判定模式' + (mode || '待定') + '：' + reason + ' =====');
    setStatus('模式' + (mode || '待定') + '：' + reason);

    // ---- 模式1：不展开合集，直接点「全剧审核」（点不通才展开兜底）----
    if (mode === 1) {
      log('模式1 → 不展开合集，直接全剧审核');
      const r = await doFullReview(R, meta, expandFn, null);
      return { result: r, mode: 1 };
    }

    // ---- 需要展开：模式2（勾选判错）或 待定（看痕迹补判）----
    setStatus('展开合集「' + meta.name + '」(' + meta.episodes + '集' + (meta.isSlow ? '·慢处理' : '') + ')...');
    let expandedRow;
    try {
      expandedRow = await expandFn();
    } catch (e) {
      log('展开失败: ' + e.message);
      return { result: 'problem', mode: 0 };
    }

    const stats = getCodeStats(expandedRow);
    const traceText = Array.from(new Set(stats.correctHits)).join('/');
    log('子样本状态码分布: ' + stats.detail + '（共 ' + stats.total + ' 条，未判定 ' + stats.unjudged + ' 条）');

    // 只有"匹配分读不到"这种情况才靠痕迹补判
    if (needExpandForDecision) {
      if (stats.hasCorrect) {
        mode = 1;
        reason = '匹配分读取失败，但发现已判定痕迹 ' + traceText + ' → 存在正确数据';
      } else {
        mode = 2;
        reason = '匹配分读取失败且无正确数据痕迹 → 全错';
      }
      log('===== 补充判定模式' + mode + '：' + reason + ' =====');
      setStatus('模式' + mode + '：' + reason);
      if (mode === 1) {
        log('模式1 → 已展开，直接全剧审核（不勾选）');
        const r = await doFullReview(R, meta, null, expandedRow);
        return { result: r, mode: 1 };
      }
    }

    // ---- 模式2：全选 + 批量错误（等全部594）+ 全剧审核 ----
    // 注意：无论当前子样本是什么状态（哪怕没有 0），都必须执行"全选 + 批量错误"，不能跳过判错。
    // 7.0 严格等待：勾选前确保子表已渲染完（无转圈）
    if (CONFIG.strictLoading && !(await waitLoadingDone('勾选子样本前', CONFIG.loadingWaitMax))) {
      return { result: 'problem', mode: 2 };
    }
    setStatus('模式2 · 全选子样本 ' + stats.total + ' 条...');
    log('模式2 当前状态码分布: ' + stats.detail + '（已是594 ' + stats.wrong + ' 条，待处理 ' + stats.notWrong + ' 条）');
    const checked = await selectAllChildRows(expandedRow);
    if (!state.running) return { result: 'problem', mode: 2 };
    log('已勾选 ' + checked + ' / ' + stats.total + ' 条');
    if (checked === 0) {
      log('勾选失败（复选框未生效），判定该合集有问题');
      return { result: 'problem', mode: 2 };
    }
    // 7.0 严格等待：勾选后也可能触发渲染/请求，等加载结束再点「批量错误」
    if (CONFIG.strictLoading && !(await waitLoadingDone('勾选后等待就绪', CONFIG.loadingWaitMax))) {
      return { result: 'problem', mode: 2 };
    }

    // 批量错误（判错）——失败自动重试3次
    log('点击「批量错误」...');
    if (!(await clickRowButtonRetry(R, '批量错误', expandedRow, 3, 3000))) {
      log('批量错误提交失败（按钮不可用或弹窗未出现）');
      return { result: 'problem', mode: 2 };
    }

    // 等响应：所有子样本变 594 且转圈结束（点确认后确认键旁会出现转圈）
    const judgeWait = meta.isSlow ? CONFIG.batchErrorWaitMaxSlow : CONFIG.batchErrorWaitMax;
    const ok = await waitAllJudged(expandedRow, judgeWait);
    if (!ok) {
      const last = getCodeStats(expandedRow);
      log('等待594+加载完成超时(' + Math.round(judgeWait / 1000) + 's)，状态码分布: ' + last.detail +
        (isLoading() ? '（页面仍有转圈）' : '') + '，判定该合集有问题');
      return { result: 'problem', mode: 2 };
    }
    log('✅ 判错完成：全部子样本状态码=' + CONFIG.wrongCode + '，且系统处理已结束');

    // 判错成功后额外等待（落库缓冲）
    setStatus('判错成功，等待系统落库...');
    await delay(meta.isSlow ? CONFIG.settleAfterBatchErrorSlow : CONFIG.settleAfterBatchError);
    if (!state.running) return { result: 'problem', mode: 2 };

    // 6. 全剧审核（行已展开，expandedRow 传入便于定位按钮）
    const r2 = await doFullReview(R, meta, null, expandedRow);
    return { result: r2, mode: 2 };
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
        log('===== 处理 第' + (state.workIndex + 1) + '行 合集[' + meta.id + ']「' + meta.name +
          '」集数' + meta.episodes + ' 匹配分' + (meta.score === null ? '-' : meta.score) +
          (meta.isSlow ? '（慢处理）' : '') + ' =====');

        // 同一合集失败次数累计（换合集则清零）
        if (state.failId !== meta.id) {
          state.failId = meta.id;
          state.failCount = 0;
        }

        const { result, mode } = await processOneCollection(R, meta);
        if (!state.running) break;

        if (result === 'ok') {
          state.failCount = 0;
          state.processedCount++;
          if (mode === 1) state.mode1Count++;
          if (mode === 2) state.mode2Count++;
          updatePanel();
          log('✅ 第' + (state.workIndex + 1) + '行合集完成（模式' + mode + '，累计 ' + state.processedCount + ' 条）');
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
          log('已固定从第2行继续判定（第1行合集可能无法正常打开）');
          updatePanel();
        }
      } catch (e) {
        console.error('[短剧7.0] 主循环异常:', e);
        log('主循环异常: ' + (e.message || e) + '，3秒后继续');
        await delay(3000);
      }
    }
    setStatus(done ? '全部处理完成' : '已停止');
    stopRun();
    if (done) {
      setTimeout(() => alert('全部处理完成！共 ' + state.processedCount + ' 个合集（模式1 ' +
        state.mode1Count + ' 个 / 模式2 ' + state.mode2Count + ' 个）'), 100);
    }
  }

  // ========== 面板 ==========
  function updatePanel() {
    const c = document.querySelector('#s7-count');
    if (c) c.textContent = state.processedCount;
    const r = document.querySelector('#s7-row');
    if (r) r.textContent = (state.workIndex + 1);
    const m1 = document.querySelector('#s7-m1');
    if (m1) m1.textContent = state.mode1Count;
    const m2 = document.querySelector('#s7-m2');
    if (m2) m2.textContent = state.mode2Count;
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
    if (document.querySelector('#s7-panel')) return;
    const panel = document.createElement('div');
    panel.id = 's7-panel';
    panel.innerHTML = `
      <div class="p7-title" id="s7-title">短剧审核助手 7.0
        <button id="s7-min" class="p7-min" title="最小化/展开">—</button>
      </div>
      <div class="p7-statusline"><span id="s7-status">空闲</span></div>
      <div class="p7-main" id="s7-main">
        <div class="form-row">
          <label>起始行号：</label>
          <input type="number" id="start-row" value="${CONFIG.startRow}" min="1">
          <span>行</span>
        </div>
        <div class="form-row">
          <label>匹配分阈值：</label>
          <input type="number" id="parent-threshold" value="${CONFIG.parentScoreThreshold}" min="0" max="100">
          <span>分以上=有正确数据</span>
        </div>
        <div class="form-row">
          <label>慢处理集数：</label>
          <input type="number" id="slow-threshold" value="${CONFIG.slowEpisodeThreshold}" min="1">
          <span>集以上</span>
        </div>
        <div class="form-row">
          <label class="p7-check"><input type="checkbox" id="strict-loading" ${CONFIG.strictLoading ? 'checked' : ''}> <b>严格等待加载完成</b></label>
          <span>转圈消失才点下一步</span>
        </div>
        <div class="stat-row">当前行：第 <b id="s7-row">1</b> 行 &nbsp;|&nbsp; 已完成：<b id="s7-count">0</b> 个</div>
        <div class="stat-row">模式1(直接全剧)：<b id="s7-m1">0</b> &nbsp;|&nbsp; 模式2(全选判错)：<b id="s7-m2">0</b></div>
        <div class="btn-row">
          <button id="start-btn" class="btn btn-start">开始运行</button>
          <button id="stop-btn" class="btn btn-stop" disabled>停止</button>
        </div>
        <div class="tip">
          <b>7.0 严格等待</b>：每次点击前 / 展开后 / 提交后都要等 antd 转圈消失（加载完成）才进行下一步；<br>
          　　　「批量错误」确认键旁转圈消失 + 全部子样本变 ${CONFIG.wrongCode} → 才点「全剧审核」；<br>
          　　　「全剧审核」后转圈消失 → 才判断合集是否移走。超时(普通${Math.round(CONFIG.loadingWaitMax / 1000)}s/慢${Math.round(CONFIG.loadingWaitMaxSlow / 1000)}s)则该轮不点击、安全停止<br>
          <b>判定优先级</b>：① 合集名命中关键词 → 强制模式2<br>
          ② 相似度闸门（<b>仅当短剧名 ≤ ${CONFIG.similarGateNameLen} 字时执行</b>；>${CONFIG.similarGateNameLen}字 跳过此闸门）<br>
          &nbsp;&nbsp;&nbsp;第3列短剧名 vs 第4列疑似抄袭的原短剧名：命中（连续${CONFIG.similarMinSubstr}字相同 或 公共不同字≥${CONFIG.similarMinCommonChars}）→ 疑似正确<br>
          &nbsp;&nbsp;&nbsp;不命中 → <b>直接模式2（全错）</b><br>
          ③ 匹配分 ≤ ${CONFIG.parentScoreThreshold} → 模式2（全错）<br>
          ④ 匹配分 > ${CONFIG.parentScoreThreshold} → 模式1：<b>不展开合集</b>直接全剧审核<br>
          ⑤ 匹配分读不到时，才展开看子样本 ${CONFIG.correctCodes.join('/')} 痕迹兜底<br>
          <b>模式2</b>：展开 + 全选 + 批量错误 + 等全部 ${CONFIG.wrongCode} + 全剧审核；>${CONFIG.slowEpisodeThreshold}集 慢处理
        </div>
        <div class="p7-log" id="s7-log"></div>
      </div>
      <div class="p7-mini-status" id="s7-mini-status"></div>
    `;
    document.body.appendChild(panel);

    const css = document.createElement('style');
    css.textContent = `
      #s7-panel{position:fixed;top:100px;right:20px;width:300px;background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.15);z-index:999999;font-size:13px;font-family:system-ui,sans-serif;}
      .p7-title{padding:8px 12px;background:#722ed1;color:#fff;border-radius:8px 8px 0 0;font-weight:600;position:relative;}
      .p7-min{position:absolute;right:8px;top:6px;width:22px;height:22px;line-height:18px;border:none;border-radius:4px;background:rgba(255,255,255,.25);color:#fff;cursor:pointer;font-size:14px;}
      .p7-min:hover{background:rgba(255,255,255,.45);}
      .p7-statusline{padding:6px 12px;background:#fff7e6;border-bottom:1px solid #ffe7ba;color:#d46b08;font-size:12px;min-height:26px;}
      .p7-statusline span{word-break:break-all;}
      .p7-mini-status{display:none;padding:6px 12px;background:#fff7e6;color:#d46b08;font-size:12px;border-radius:0 0 8px 8px;}
      .p7-main{padding:10px 12px;}
      .form-row{display:flex;align-items:center;gap:5px;margin-bottom:8px;}
      .form-row label{width:86px;font-size:12px;color:#666;flex:none;}
      .form-row input{width:58px;padding:3px 5px;border:1px solid #d9d9d9;border-radius:4px;outline:none;font-size:12px;}
      .form-row span{font-size:11px;color:#999;}
      .p7-check{display:flex;align-items:center;gap:4px;cursor:pointer;color:#d46b08;font-weight:600;}
      .stat-row{margin-bottom:8px;color:#333;font-size:12px;}
      .stat-row b{color:#722ed1;font-size:15px;}
      .btn-row{display:flex;gap:8px;margin-bottom:8px;}
      .btn{flex:1;padding:6px 0;border:none;border-radius:4px;cursor:pointer;font-size:13px;}
      .btn:disabled{opacity:0.5;cursor:not-allowed;}
      .btn-start{background:#52c41a;color:#fff;}
      .btn-stop{background:#ff4d4f;color:#fff;}
      .tip{font-size:11px;color:#999;margin-bottom:8px;line-height:1.7;}
      .tip b{color:#722ed1;}
      .p7-log{max-height:160px;overflow-y:auto;background:#fafafa;border-radius:4px;padding:5px 7px;font-size:11px;font-family:Consolas,monospace;line-height:1.6;color:#666;word-break:break-all;}
    `;
    document.head.appendChild(css);

    initDrag(panel, panel.querySelector('#s7-title'));

    // 最小化/展开
    const main = panel.querySelector('#s7-main');
    const miniStatus = panel.querySelector('#s7-mini-status');
    document.querySelector('#s7-min').addEventListener('click', () => {
      const hidden = main.style.display === 'none';
      main.style.display = hidden ? '' : 'none';
      miniStatus.style.display = hidden ? 'none' : '';
      document.querySelector('#s7-min').textContent = hidden ? '—' : '□';
    });

    document.querySelector('#start-btn').addEventListener('click', () => {
      const row = parseInt(document.querySelector('#start-row').value);
      const p = parseInt(document.querySelector('#parent-threshold').value);
      const s = parseInt(document.querySelector('#slow-threshold').value);
      const strictEl = document.querySelector('#strict-loading');
      if (!isNaN(row) && row > 0) CONFIG.startRow = row;
      if (!isNaN(p)) CONFIG.parentScoreThreshold = p;
      if (!isNaN(s) && s > 0) CONFIG.slowEpisodeThreshold = s;
      if (strictEl) CONFIG.strictLoading = strictEl.checked;
      startRun();
    });
    document.querySelector('#stop-btn').addEventListener('click', stopRun);
  }

  function startRun() {
    if (state.running) return;
    state.running = true;
    state.processedCount = 0;
    state.mode1Count = 0;
    state.mode2Count = 0;
    state.failId = null;
    state.failCount = 0;
    state.workIndex = CONFIG.startRow - 1;
    document.querySelector('#start-btn').disabled = true;
    document.querySelector('#stop-btn').disabled = false;
    updatePanel();
    setStatus('启动中...');
    log('===== 开始运行（从第' + CONFIG.startRow + '行起）=====');
    log('严格等待加载完成：' + (CONFIG.strictLoading ? '开（转圈消失才点下一步）' : '关') +
      '；等待上限 普通' + Math.round(CONFIG.loadingWaitMax / 1000) + 's / 慢合集' +
      Math.round(CONFIG.loadingWaitMaxSlow / 1000) + 's');
    log('判定优先级：①名称命中关键词 → 强制模式2；②相似度闸门(仅短剧名≤' + CONFIG.similarGateNameLen +
      '字时执行：第3列 vs 第4列原短剧名，连续' + CONFIG.similarMinSubstr + '字相同 或 公共不同字≥' +
      CONFIG.similarMinCommonChars + ') 不命中 → 直接模式2；③匹配分≤' + CONFIG.parentScoreThreshold +
      ' → 模式2；④匹配分>' + CONFIG.parentScoreThreshold + ' → 模式1(直接全剧审核)；⑤匹配分读不到时才用 ' +
      CONFIG.correctCodes.join('/') + ' 痕迹兜底');
    // 结构自检：打印第1~2行解析结果，便于发现页面改版
    setTimeout(debugStructure, 1500);
    runLoop();
  }

  function stopRun() {
    state.running = false;
    document.querySelector('#start-btn').disabled = false;
    document.querySelector('#stop-btn').disabled = true;
  }

  // 结构自检：输出首行解析到的 ID/名字/匹配分/集数/状态，方便确认选择器是否失效
  function debugStructure() {
    try {
      const rows = qsa(document, SELECTORS.parentRow);
      for (let i = 0; i < Math.min(2, rows.length); i++) {
        const meta = getCollectionMeta(rows[i]);
        const sim = checkSimilarOriginalName(rows[i], meta);
        console.log('[自检] 第' + (i + 1) + '行 → ID:[' + meta.id + '] 短剧名:[' + meta.name +
          '] 原短剧名:[' + meta.originalName + '] 匹配分:' + (meta.score === null ? '-' : meta.score) +
          ' 集数:' + meta.episodes + ' 状态:[' + getRowStatus(rows[i]) + ']');
        console.log('[自检] 第' + (i + 1) + '行 相似判定 → ' + (sim.similar ? '疑似正确' : '不相似') +
          '（' + sim.detail + '）');
      }
      console.log('[自检] 子样本状态码列 = ' + SELECTORS.childCodeCell + '（0=未判定, ' +
        CONFIG.wrongCode + '=判错完成, ' + CONFIG.correctCodes.join('/') + '=前人已判定/有正确数据）');
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
