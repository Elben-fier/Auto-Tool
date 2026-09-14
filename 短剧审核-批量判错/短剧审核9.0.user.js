// ==UserScript==
// @name         Shift短剧审核-终极关键词版【9.0】
// @namespace    https://doubao.com/userscripts
// @version      9.0.0
// @description  终极关键词直接全错 + 关键词双列比对 + 相似度闸门(带匹配分后续判定) + 匹配分/子样本分档 → 决定【直接全剧审核】或【全选+批量错误+全剧审核】；含30s/60s重试、永久跳过与严格等待加载
// @author       Doubao
// @match        https://tools.vobile.cn/quality/dramaReview*
// @grant        GM_setClipboard
// @run-at       document-end
// ==/UserScript==

// ============================== 9.0.0 更新记录 ==============================
//  【一】新增「终极关键词」机制（最高优先级）：
//        第3列（短剧名）一旦命中终极关键词 → 直接模式2（全选+批量错误+全剧审核），
//        不看第4列、不看匹配分、不看子样本，任何后续判定都不执行。
//        当前终极关键词：红果 / 充电专属 / 动画 / 免费 / 剪辑 / 花絮 / 拍摄 / 论剑大会 / 动漫 / 定档 / 首播 / 画
//  【二】相似度闸门增加"后续步骤"（短剧名 ≤4 字 且与第4列无相同词/字时）：
//        旧：直接模式2（全错）
//        新：再看母本匹配分 → ≥90 → 展开合集，按"好样本(≥90分)条数 ≥3 或 存在 601/777"判断
//                                （与 90~95 分档机制相同）：满足 → 模式1；不满足 → 模式2
//                             <90 → 直接模式2（全错）
//                             读不到 → 展开看 601/777 痕迹兜底
//  【沿用】8.0 的：关键词双列比对、匹配分分档(>95 / 90~95 / <90 / 读不到)、
//          只用第2列id判断全剧审核完成、30s/60s重试、永久跳过、严格等待加载
// ==========================================================================


(function () {
  'use strict';

  console.log('[短剧审核8.0] 智能判定全剧审核版已加载');

  // ========== 可配置项 ==========
  const CONFIG = {
    // —— 模式判定（8.0 分档）——
    parentScoreThreshold: 95,      // 母本匹配最高分(第5列)：> 该值 → 模式1（直接全剧审核）
    midScoreMin: 90,               // 90 ≤ 匹配分 ≤ 95 → 疑似正确，需展开看子样本（<90 直接全错）
    childScoreGood: 90,            // 子样本得分(第8列) ≥ 该值 视为"好样本"
    childScoreGoodMinCount: 3,     // 好样本条数 ≥ 该值（默认3）→ 判该合集正确
    correctCodes: ['777', '601'],  // 子样本状态码(第3列)：出现这些码 → 前人已判定 → 有正确数据
    wrongCode: '594',              // 判错完成标志（全选+批量错误后，子样本状态码 0 → 594）
    unjudgedCode: '0',             // 未判定
    // —— 慢处理（集数 > 阈值）——
    slowEpisodeThreshold: 300,
    expandWaitMax: 15000,          // 普通：展开合集最长等待
    expandWaitMaxSlow: 30000,      // 慢合集：展开最长等待
    batchErrorWaitMax: 90000,      // 普通：批量错误后等待全部594(最长，需>60s以便30s/60s重试)
    batchErrorWaitMaxSlow: 150000, // 慢合集
    fullReviewWaitMax: 90000,      // 普通：全剧审核后等待合集移走(最长)
    fullReviewWaitMaxSlow: 150000, // 慢合集
    settleAfterBatchError: 1000,   // 判错成功后额外等待（落库缓冲）
    settleAfterBatchErrorSlow: 3000,
    // —— 等待期间的重试（8.0 新增）——
    retryEnabled: true,            // 等待无响应时是否重试点击
    retryAtSec: [30, 60],          // 在第 30s / 60s 各重试一次（含首次点击，每个按钮最多点 3 次）
    // —— 严格等待加载完成（antd 转圈闸门）——
    strictLoading: true,           // true=严格等待（推荐）；false=只按超时/数据变化判断
    loadingWaitMax: 90000,         // 普通合集：单次等待"加载完成"的最长时间(ms)
    loadingWaitMaxSlow: 150000,    // 慢合集：放宽
    loadingCalmMs: 800,            // 连续多少毫秒无转圈才算"加载完成"
    // —— 弹窗/按钮 ——
    modalWaitMax: 8000,            // 确认弹窗最长等待
    batchBtnWaitMax: 5000,         // 按钮从禁用变可用最长等待
    checkInterval: 500,            // 轮询间隔
    // —— 关键词规则（8.0：双列比对）——
    nameKeywords: ['短剧', '画', '漫剧', 'AI', '充电', '红果', '专属', '动画', '免费', '剪辑', '花絮', '拍摄', '经典', '剧', '真人', '免', '动漫', '动', '&', '定档', '首播', '漫', 'ai', '果'],
    // —— 9.0 终极关键词（最高优先级）：第3列一旦命中 → 直接全错，不看后续任何判定 ——
    ultimateKeywords: ['红果', '充电专属', '动画', '免费', '剪辑', '花絮', '拍摄', '论剑大会', '动漫', '定档', '首播', '画'],
    // —— 相似度闸门：第3列短剧名 vs 第4列(疑似抄袭的原短剧名) ——
    //   仅当短剧名长度 ≤ similarGateNameLen 时才做这个判定；超过则跳过闸门，直接看匹配分
    similarGateNameLen: 4,         // 短剧名(归一化后)字数 ≤ 该值 → 执行相似度闸门；> 该值 → 跳过闸门
    similarMinSubstr: 2,           // 存在连续 N 个字相同（如"渐染"）即算有相同词
    similarMinCommonChars: 3,      // 或 两段文本公共的不同字 ≥ N 个
    // —— 运行 ——
    startRow: 1,                   // 起始行号（1开始）
    afterProblemDelay: 2000,       // 跳过合集后等待再继续
    maxSkipCount: 20,              // 最多跳过多少个合集（安全上限，超过则停止提示人工）
  };

  // ========== 运行状态 ==========
  const state = {
    running: false,
    processedCount: 0,
    mode1Count: 0,       // 直接全剧审核次数
    mode2Count: 0,       // 全选判错次数
    workIndex: 0,        // 当前工作行（0=第1行）
    skipIds: new Set(),  // 已永久跳过的合集id（本轮不再处理）
    skipList: [],        // 跳过明细：{id,name,reason,time}
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
    childScoreCell: 'td:nth-child(8)',   // 子样本得分（8.0 新增：≥90 的好样本条数用于判定）
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
    console.log('[短剧9.0] ' + msg);
    const el = document.querySelector('#s9-log');
    if (!el) return;
    const line = document.createElement('div');
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    el.prepend(line);
    while (el.children.length > 200) el.lastChild.remove();
  }

  function setStatus(msg) {
    console.log('[状态] ' + msg);
    const el = document.querySelector('#s9-status');
    if (el) el.textContent = msg;
    // 最小化时下方也显示当前状态
    const t = document.querySelector('#s9-mini-status');
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
    catch (e) { console.warn('[短剧9.0] 点击失败:', e.message || e); return false; }
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
      if (!sp.closest('#s9-panel')) return true;
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

  // 合集元信息：ID(第2列，唯一) / 名字(第3列) / 原短剧名(第4列) / 匹配最高分(第5列) / 集数(第10列)
  // 8.0：id 只用第2列，不再用文本兜底（避免文本重复导致判断卡死）
  function getCollectionMeta(row) {
    const id = cellText(row, SELECTORS.parentIdCell);
    const name = cellText(row, SELECTORS.parentNameCell);
    const originalName = cellText(row, SELECTORS.parentOriginalNameCell);
    const score = parseNum(cellText(row, SELECTORS.parentScoreCell));
    const episodes = parseNum(cellText(row, SELECTORS.episodesCell)) || 0;
    return {
      id: id,
      name: name,
      originalName: originalName,
      score: score,
      episodes: episodes,
      isSlow: episodes > CONFIG.slowEpisodeThreshold,
    };
  }

  // ========== 9.0 终极关键词（最高优先级） ==========
  // 第3列（短剧名）一旦命中 → 直接全错，不看第4列、不看匹配分、不看子样本
  function getUltimateKeyword(name) {
    if (!name) return '';
    for (const kw of CONFIG.ultimateKeywords) {
      if (kw && name.includes(kw)) return kw;
    }
    return '';
  }

  // ========== 关键词规则（8.0：双列比对） ==========
  // 第3列（短剧名）命中关键词后，再看第4列（疑似抄袭原短剧名）是否也含【同一个词】：
  //   两边都有 → 疑似正确（hit=false, dual=true），继续后面的判定
  //   第4列没有 → 直接全错（hit=true）
  // 第3列没命中 → hit=false, dual=false（不能作为"疑似正确"依据，交给后面的规则）
  // 返回 { hit, dual, kw }
  function getKeywordRule(parentRow, meta) {
    const name = meta ? meta.name : cellText(parentRow, SELECTORS.parentNameCell);
    const orig = meta ? meta.originalName : cellText(parentRow, SELECTORS.parentOriginalNameCell);
    if (!name) return { hit: false, dual: false, kw: '' };
    for (const kw of CONFIG.nameKeywords) {
      if (!kw) continue;
      if (name.includes(kw)) {
        const dual = !!(orig && orig.includes(kw));
        return { hit: !dual, dual: dual, kw: kw };
      }
    }
    return { hit: false, dual: false, kw: '' };
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

  // 汇总当前展开子表：状态码分布 + 好样本条数（子样本得分 ≥ childScoreGood）
  function getCodeStats(expandedRow) {
    const rows = getChildRows(expandedRow);
    const counters = {};
    let unjudged = 0;
    let scoreGood = 0;          // 8.0：子样本得分 ≥ childScoreGood 的条数
    let scoreKnown = 0;         // 能读到得分的条数（便于排查列错）
    const correctHits = [];
    rows.forEach((row) => {
      const code = getChildCode(row);
      counters[code] = (counters[code] || 0) + 1;
      // 空值也视为未判定（避免列结构异常时被误认为已完成）
      if (code === CONFIG.unjudgedCode || code === '') unjudged++;
      if (CONFIG.correctCodes.includes(code)) correctHits.push(code);

      const sc = parseNum(cellText(row, SELECTORS.childScoreCell));
      if (sc !== null) {
        scoreKnown++;
        if (sc >= CONFIG.childScoreGood) scoreGood++;
      }
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
      scoreGood: scoreGood,              // ≥90 分的好样本条数
      scoreKnown: scoreKnown,
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

  // ========== 等待期的重试（8.0 新增） ==========
  // 在等待的第 30s / 60s 各重试点击一次同一按钮（含首次点击，每个按钮最多点 3 次）
  // 仅当"页面已静止（无转圈）但状态没变化"时才重试；还在转圈说明系统在处理 → 继续等
  // retried：本按钮已用过的重试时间点数组 [30] / [30,60]
  async function retryTick(start, retried, R, btnText, expandedRow, what) {
    if (!CONFIG.retryEnabled) return;
    const elapsed = Date.now() - start;
    for (const sec of CONFIG.retryAtSec) {
      if (elapsed < sec * 1000 || retried.includes(sec)) continue;
      retried.push(sec);

      if (isLoading()) {
        log('⏳ 第' + sec + 's：系统仍在处理（有转圈），不重试，继续等待' + (what || ''));
        return;
      }
      log('⚠️ 第' + sec + 's：页面已静止但状态未变化（可能没点到）→ 重试点击「' + btnText + '」' + (what || ''));
      setStatus('第' + sec + 's 重试「' + btnText + '」...');
      const ok = await clickRowButtonRetry(R, btnText, expandedRow, 1, 0);
      log(ok ? '↻ 已重新提交「' + btnText + '」，继续等待' : '↻ 重试「' + btnText + '」未点通');
      return;
    }
  }

  // ========== 等待全部子样本变成 594（判错完成） ==========
  // 模式2 的"等响应"：批量错误提交后，必须满足三个条件才算完成：
  //   ① 所有子样本状态码都是 594（不能只看"不再是0"，否则原有 777/601 会误判为完成）
  //   ② 页面转圈已结束（点确认后确认键旁/表格上会出现转圈，必须等它消失）
  //   8.0：等待期间第 30s / 60s 会各重试点击一次「批量错误」
  async function waitAllJudged(expandedRow, R, timeout) {
    const start = Date.now();
    const retried = [];
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

      await retryTick(start, retried, R, '批量错误', expandedRow, '（判错等待中）');
      await delay(CONFIG.checkInterval);
    }
    return false;
  }

  // ========== 全剧审核后等待系统完成 ==========
  // 完成标志（8.0：只用第2列合集id判断，不再用文本兜底）：
  //   当前工作行的合集id 已不是刚处理的那个（说明该合集已被移走）
  //   或该行状态变为已审核 / 行消失；
  // 并且要求页面无转圈（点「全剧审核」后会出现转圈，转圈结束才算系统处理完）
  // 等待期间第 30s / 60s 会各重试点击一次「全剧审核」
  async function waitReviewCompleted(meta, R, expandedRow, timeout) {
    const start = Date.now();
    const retried = [];
    while (Date.now() - start < timeout) {
      if (!state.running) return 'stopped';

      const rows = qsa(document, SELECTORS.parentRow);
      const cur = rows[state.workIndex];
      const loading = isLoading();
      if (loading) setStatus('全剧审核处理中（系统转圈中…）');

      if (!loading) {
        if (!cur) return 'done';                      // 行没了 → 处理完成
        if (getRowStatus(cur).includes('已审核')) return 'done'; // 该位置已是已审核合集
        const curMeta = getCollectionMeta(cur);
        // 8.0：严格用第2列id比较（id唯一）；id读不到时不用文本兜底，交给外层判为异常
        if (curMeta.id && curMeta.id !== meta.id) return 'next';
      }

      await retryTick(start, retried, R, '全剧审核', expandedRow, '（全剧审核等待中）');
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
    const outcome = await waitReviewCompleted(meta, R, exp, reviewWait);
    if (outcome === 'stall') {
      log('全剧审核等待超时(' + Math.round(reviewWait / 1000) + 's)，合集仍未被移走（已含30s/60s两次重试）');
      return 'problem';
    }
    if (outcome === 'stopped') return 'problem';
    return 'ok';
  }

  // ========== 处理单个合集（8.0 判定） ==========
  // 模式1：直接全剧审核（不勾选、不判错）
  // 模式2：全选 + 批量错误（等全部594）+ 全剧审核
  // 判定优先级：
  //   ① 关键词双列比对：第3列命中关键词且第4列也有同一个词 → 疑似正确（继续）；第4列没有 → 模式2
  //   ② 相似度闸门（短剧名 ≤4 字时）不相似 → 模式2
  //   ③ 匹配分 > 95 → 模式1（不展开）
  //   ④ 90 ≤ 匹配分 ≤ 95 → 疑似正确 → 展开后：好样本(≥90分)条数 ≥3 或 存在 601/777 → 模式1；否则模式2
  //   ⑤ 匹配分 < 90 → 模式2（不展开）
  //   ⑥ 匹配分读不到 → 展开看 601/777 痕迹 → 有 → 模式1；无 → 模式2
  // 返回 { result: 'ok'|'problem', mode: 1|2|0, reason }
  async function processOneCollection(R, meta) {
    const expandWait = meta.isSlow ? CONFIG.expandWaitMaxSlow : CONFIG.expandWaitMax;
    const expandFn = () => expandRowAndWait(R, expandWait);

    // ---- 第0步：严格等待上一轮遗留下的加载完成 ----
    const startLoadWait = meta.isSlow ? CONFIG.loadingWaitMaxSlow : CONFIG.loadingWaitMax;
    if (CONFIG.strictLoading && !(await waitLoadingDone('开始处理本轮前', startLoadWait))) {
      return { result: 'problem', mode: 0, reason: '上一轮加载未完成' };
    }

    // ---- 第1步：母行信息 + 终极关键词 + 关键词 + 相似度（不需要展开）----
    const ultimateKw = getUltimateKeyword(meta.name);
    const kwr = getKeywordRule(R, meta);
    const sim = checkSimilarOriginalName(R, meta);
    const gateActive = sim.nameLen <= CONFIG.similarGateNameLen;

    log('终极关键词检查：短剧名「' + meta.name + '」 → ' +
      (ultimateKw ? ('命中「' + ultimateKw + '」→ 直接全错（跳过所有后续判定）') : '未命中'));
    log('关键词比对：短剧名「' + meta.name + '」 vs 原短剧名「' + meta.originalName + '」 → ' +
      (kwr.kw ? ('命中「' + kwr.kw + '」，第4列' + (kwr.dual ? '也有该词 → 疑似正确' : '没有该词 → 直接全错'))
        : '第3列未命中关键词'));
    log('相似度比对：短剧名(' + sim.nameLen + '字) → ' +
      (gateActive ? (sim.similar ? '相似·疑似正确' : '不相似（转按匹配分判定）') : '跳过闸门(名称>' + CONFIG.similarGateNameLen + '字)') +
      '（' + sim.detail + '）');

    const score = meta.score;
    let mode = 0, reason = '', expandReason = '';

    if (ultimateKw) {
      // ⓪ 9.0 终极关键词：第3列命中 → 直接全错，不看任何后续判定
      mode = 2;
      reason = '【终极关键词】「' + ultimateKw + '」出现在第3列 → 直接全错（不执行后续任何判定）';
    } else if (kwr.hit) {
      // ① 第3列命中普通关键词、第4列没有 → 直接全错
      mode = 2;
      reason = '关键词「' + kwr.kw + '」仅出现在第3列（第4列无该词）→ 直接全错';
    } else if (gateActive && !sim.similar) {
      // ② 相似度闸门不通过（短剧名≤4字 且与第4列无相同词/字）→ 9.0 改为再看匹配分
      if (score !== null && score < CONFIG.midScoreMin) {
        mode = 2;
        reason = '短剧名' + sim.nameLen + '字≤' + CONFIG.similarGateNameLen + ' 且与第4列无相同词/字，' +
          '匹配分 ' + score + ' < ' + CONFIG.midScoreMin + ' → 直接全错';
      } else {
        // 匹配分 ≥90（或读不到）→ 展开看子样本，与 90~95 分档同一机制
        expandReason = '短剧名' + sim.nameLen + '字≤' + CONFIG.similarGateNameLen + ' 且与第4列无相同词/字' +
          (score === null ? '（匹配分读不到）' : '，但匹配分 ' + score + ' ≥ ' + CONFIG.midScoreMin) +
          ' → 疑似正确，需展开判断：好样本(≥' + CONFIG.childScoreGood + '分)条数 ≥' +
          CONFIG.childScoreGoodMinCount + ' 或 存在 ' + CONFIG.correctCodes.join('/');
      }
    } else if (score !== null && score > CONFIG.parentScoreThreshold) {
      // ③ 匹配分 > 95 → 模式1
      mode = 1;
      reason = '匹配分 ' + score + ' > ' + CONFIG.parentScoreThreshold + ' → 存在正确数据' +
        (kwr.dual ? '（关键词「' + kwr.kw + '」两列都有）' : '');
    } else if (score !== null && score >= CONFIG.midScoreMin) {
      // ④ 90~95 → 需展开看子样本（mode 保持 0 = 待定）
      expandReason = '匹配分 ' + score + ' ∈ [' + CONFIG.midScoreMin + ',' + CONFIG.parentScoreThreshold +
        '] → 疑似正确，需展开判断：好样本(≥' + CONFIG.childScoreGood + '分)条数 ≥' +
        CONFIG.childScoreGoodMinCount + ' 或 存在 ' + CONFIG.correctCodes.join('/');
    } else if (score !== null) {
      // ⑤ < 90 → 直接全错
      mode = 2;
      reason = '匹配分 ' + score + ' < ' + CONFIG.midScoreMin + ' → 一律按错误数据处理' +
        (kwr.dual ? '（关键词两列都有，但匹配分过低）' : '');
    } else {
      // ⑥ 匹配分读不到 → 展开看痕迹（mode 保持 0 = 待定）
      expandReason = '匹配分读取失败 → 需展开查看 ' + CONFIG.correctCodes.join('/') + ' 痕迹';
    }

    if (mode !== 0) {
      log('===== 判定模式' + mode + '：' + reason + ' =====');
      setStatus('模式' + mode + '：' + reason);
    }

    // ---- 模式1：不展开合集，直接点「全剧审核」（点不通才展开兜底）----
    if (mode === 1) {
      log('模式1 → 不展开合集，直接全剧审核');
      const r = await doFullReview(R, meta, expandFn, null);
      return { result: r, mode: 1, reason: reason };
    }

    // ---- 需要展开：模式2（勾选判错）或 待定（子样本判定）----
    if (mode === 0) {
      log('===== 判定待定：' + expandReason + ' =====');
      setStatus('待定：' + expandReason);
    }
    setStatus((mode === 2 ? '模式2 · ' : '') + '展开合集「' + meta.name + '」(' + meta.episodes + '集' +
      (meta.isSlow ? '·慢处理' : '') + ')...');
    let expandedRow;
    try {
      expandedRow = await expandFn();
    } catch (e) {
      log('展开失败: ' + e.message);
      return { result: 'problem', mode: 0, reason: '展开失败: ' + e.message };
    }

    const stats = getCodeStats(expandedRow);
    log('子样本统计：共 ' + stats.total + ' 条 | 状态码 ' + stats.detail +
      ' | 得分≥' + CONFIG.childScoreGood + ' 的好样本 ' + stats.scoreGood + ' 条' +
      '(可读得分 ' + stats.scoreKnown + ' 条)');

    // 待定 → 用子样本判定（匹配分 90~95 或 匹配分读不到）
    if (mode === 0) {
      const byScore = (score !== null && score >= CONFIG.midScoreMin);
      const goodEnough = stats.scoreGood >= CONFIG.childScoreGoodMinCount;
      if (byScore) {
        if (goodEnough || stats.hasCorrect) {
          mode = 1;
          reason = '匹配分 ' + score + ' 疑似正确，且子样本' +
            (goodEnough ? ('好样本 ' + stats.scoreGood + ' 条 ≥ ' + CONFIG.childScoreGoodMinCount) : '') +
            (goodEnough && stats.hasCorrect ? '、' : '') +
            (stats.hasCorrect ? ('存在状态码 ' + Array.from(new Set(stats.correctHits)).join('/')) : '') +
            ' → 判该合集正确';
        } else {
          mode = 2;
          reason = '匹配分 ' + score + ' 疑似正确，但子样本不满足条件（好样本 ' + stats.scoreGood + ' 条 < ' +
            CONFIG.childScoreGoodMinCount + '，且无 ' + CONFIG.correctCodes.join('/') + ' 痕迹）→ 全错';
        }
      } else {
        // 匹配分读不到：用 601/777 痕迹兜底
        if (stats.hasCorrect) {
          mode = 1;
          reason = '匹配分读取失败，但存在状态码 ' + Array.from(new Set(stats.correctHits)).join('/') + ' → 判该合集正确';
        } else {
          mode = 2;
          reason = '匹配分读取失败且无 ' + CONFIG.correctCodes.join('/') + ' 痕迹 → 全错';
        }
      }
      log('===== 补充判定模式' + mode + '：' + reason + ' =====');
      setStatus('模式' + mode + '：' + reason);
      if (mode === 1) {
        log('模式1 → 已展开，直接全剧审核（不勾选）');
        const r = await doFullReview(R, meta, null, expandedRow);
        return { result: r, mode: 1, reason: reason };
      }
    }
    log('===== 判定模式' + (mode || '待定') + '：' + reason + ' =====');
    setStatus('模式' + (mode || '待定') + '：' + reason);

    // ---- 模式1：不展开合集，直接点「全剧审核」（点不通才展开兜底）----
    if (mode === 1) {
      log('模式1 → 不展开合集，直接全剧审核');
      const r = await doFullReview(R, meta, expandFn, null);
      return { result: r, mode: 1 };
    }

    // ---- 模式2：全选 + 批量错误（等全部594）+ 全剧审核 ----
    // 注意：无论当前子样本是什么状态（哪怕没有 0），都必须执行"全选 + 批量错误"，不能跳过判错。
    // 严格等待：勾选前确保子表已渲染完（无转圈）
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

    // 等响应：所有子样本变 594 且转圈结束；等待期间 30s/60s 会重试点击「批量错误」
    const judgeWait = meta.isSlow ? CONFIG.batchErrorWaitMaxSlow : CONFIG.batchErrorWaitMax;
    const ok = await waitAllJudged(expandedRow, R, judgeWait);
    if (!ok) {
      const last = getCodeStats(expandedRow);
      log('等待594+加载完成超时(' + Math.round(judgeWait / 1000) + 's，已含30s/60s两次重试)，状态码分布: ' +
        last.detail + (isLoading() ? '（页面仍有转圈）' : '') + '，判定该合集有问题');
      return { result: 'problem', mode: 2, reason: '批量错误等待超时（594未齐）' };
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

  // ========== 主循环（8.0：id 唯一 + 永久跳过） ==========
  // 选取目标行：从 workIndex 开始往后找第一个「id 未跳过 且 状态不是已审核」的合集
  // 找不到 → 全部处理完成
  function pickTarget() {
    const rows = Array.from(qsa(document, SELECTORS.parentRow));
    if (rows.length === 0) return { done: true, why: '页面无数据行' };

    // 先检查 id 是否可读（第2列是唯一标识，读不到不能靠文本兜底）
    const check = (i) => {
      const R = rows[i];
      const meta = getCollectionMeta(R);
      if (!meta.id) {
        return { done: true, why: '第' + (i + 1) + '行第2列(合集id)读取为空，可能是页面改版 → 停止运行，请检查第2列选择器' };
      }
      if (state.skipIds.has(meta.id)) return null;            // 已永久跳过
      if (getRowStatus(R).includes('已审核')) return null;     // 已审核 → 跳过
      return { R: R, meta: meta, idx: i };
    };

    // 第一遍：从当前工作行往后找
    for (let i = state.workIndex; i < rows.length; i++) {
      const r = check(i);
      if (!r) continue;
      if (r.done) return r;
      state.workIndex = r.idx;
      return r;
    }
    // 第二遍：回绕到前面找（避免跳过后漏掉前面的行）
    for (let i = 0; i < Math.min(state.workIndex, rows.length); i++) {
      const r = check(i);
      if (!r) continue;
      if (r.done) return r;
      state.workIndex = r.idx;
      return r;
    }
    return { done: true, why: '已无可处理的合集（其余均为已审核或已跳过）' };
  }

  async function runLoop() {
    let done = false;
    while (state.running) {
      try {
        const target = pickTarget();
        if (target.done) {
          log(target.why);
          done = true;
          break;
        }

        const R = target.R, meta = target.meta;
        log('===== 处理 第' + (target.idx + 1) + '行 合集[' + meta.id + ']「' + meta.name +
          '」集数' + meta.episodes + ' 匹配分' + (meta.score === null ? '-' : meta.score) +
          (meta.isSlow ? '（慢处理）' : '') + ' =====');

        const res = await processOneCollection(R, meta);
        if (!state.running) break;

        if (res.result === 'ok') {
          state.processedCount++;
          if (res.mode === 1) state.mode1Count++;
          if (res.mode === 2) state.mode2Count++;
          updatePanel();
          log('✅ 第' + (target.idx + 1) + '行合集完成（模式' + res.mode + '，累计 ' + state.processedCount + ' 条）');
          continue;
        }

        // problem：收起合集 → 【永久跳过】，换下一行继续（不再整脚本停止）
        setStatus('该合集处理异常，收起并永久跳过，换下一行继续...');
        log('收起问题合集...');
        await collapseRow(R);
        await delay(CONFIG.afterProblemDelay);

        state.skipIds.add(meta.id);
        state.skipList.push({
          id: meta.id,
          name: meta.name,
          reason: res.reason || ('模式' + res.mode + ' 处理异常'),
          time: new Date().toLocaleTimeString(),
        });
        log('⏭ 已永久跳过合集[' + meta.id + ']「' + meta.name + '」原因：' + (res.reason || '处理异常') +
          '（本轮不再处理，需人工处理）');
        updatePanel();

        if (state.skipIds.size >= CONFIG.maxSkipCount) {
          log('累计跳过已达上限 ' + CONFIG.maxSkipCount + ' 个，停止运行，请人工处理');
          done = true;
          break;
        }
        // 从下一行开始找目标（永久跳过当前合集）
        state.workIndex = target.idx + 1;
      } catch (e) {
        console.error('[短剧9.0] 主循环异常:', e);
        log('主循环异常: ' + (e.message || e) + '，3秒后继续');
        await delay(3000);
      }
    }
    setStatus(done ? '全部处理完成' : '已停止');
    stopRun();
    if (done) {
      const skipText = state.skipList.length > 0
        ? ('\n跳过 ' + state.skipList.length + ' 个合集（需人工处理）：\n' +
           state.skipList.slice(0, 10).map((s) => ' · [' + s.id + '] ' + s.name + ' ← ' + s.reason).join('\n') +
           (state.skipList.length > 10 ? '\n …（其余见面板「复制跳过清单」）' : ''))
        : '\n（无跳过合集）';
      setTimeout(() => alert('处理完成！共处理 ' + state.processedCount + ' 个合集\n模式1(直接全剧审核) ' +
        state.mode1Count + ' 个 / 模式2(全选判错) ' + state.mode2Count + ' 个' + skipText), 100);
    }
  }

  // ========== 面板 ==========
  function updatePanel() {
    const c = document.querySelector('#s9-count');
    if (c) c.textContent = state.processedCount;
    const r = document.querySelector('#s9-row');
    if (r) r.textContent = (state.workIndex + 1);
    const m1 = document.querySelector('#s9-m1');
    if (m1) m1.textContent = state.mode1Count;
    const m2 = document.querySelector('#s9-m2');
    if (m2) m2.textContent = state.mode2Count;
    const sk = document.querySelector('#s9-skip');
    if (sk) sk.textContent = state.skipList.length;
  }

  // 跳过清单文本（供「复制跳过清单」）
  function buildSkipText() {
    if (!state.skipList || state.skipList.length === 0) return '（本轮没有跳过的合集）';
    const lines = ['# 跳过合集清单（需人工处理）  共 ' + state.skipList.length + ' 个',
      '# 合集id\t短剧名\t跳过原因\t时间'];
    state.skipList.forEach((s) => lines.push([s.id, s.name, s.reason, s.time].join('\t')));
    return lines.join('\n');
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
    if (document.querySelector('#s9-panel')) return;
    const panel = document.createElement('div');
    panel.id = 's9-panel';
    panel.innerHTML = `
      <div class="p9-title" id="s9-title">短剧审核助手 9.0
        <button id="s9-min" class="p9-min" title="最小化/展开">—</button>
      </div>
      <div class="p9-statusline"><span id="s9-status">空闲</span></div>
      <div class="p9-main" id="s9-main">
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
          <label class="p9-check"><input type="checkbox" id="strict-loading" ${CONFIG.strictLoading ? 'checked' : ''}> <b>严格等待加载完成</b></label>
          <span>转圈消失才点下一步</span>
        </div>
        <div class="stat-row">当前行：第 <b id="s9-row">1</b> 行 &nbsp;|&nbsp; 已完成：<b id="s9-count">0</b> 个 &nbsp;|&nbsp; 已跳过：<b id="s9-skip">0</b> 个</div>
        <div class="stat-row">模式1(直接全剧)：<b id="s9-m1">0</b> &nbsp;|&nbsp; 模式2(全选判错)：<b id="s9-m2">0</b></div>
        <div class="btn-row">
          <button id="start-btn" class="btn btn-start">开始运行</button>
          <button id="stop-btn" class="btn btn-stop" disabled>停止</button>
        </div>
        <div class="btn-row">
          <button id="copy-skip-btn" class="btn btn-copy">复制跳过清单</button>
        </div>
        <div class="tip">
          <b>9.0 判定</b>：<br>
          ⓪ <b>终极关键词</b>（${CONFIG.ultimateKeywords.join('、')}）：第3列命中 → <b>直接全错</b>，不执行任何后续判定<br>
          ① 关键词双列比对：第3列命中且第4列也有同一词 → 疑似正确（继续）；第4列没有 → 直接模式2<br>
          ② 相似度闸门（短剧名 ≤${CONFIG.similarGateNameLen} 字 且与第4列无相同词/字）：<br>
          &nbsp;&nbsp;&nbsp;匹配分 &lt;${CONFIG.midScoreMin} → 直接模式2；匹配分 ≥${CONFIG.midScoreMin} → 疑似正确 → 展开按 ④ 的机制判定<br>
          ③ 匹配分 &gt;${CONFIG.parentScoreThreshold} → 模式1（不展开直接全剧审核）<br>
          ④ ${CONFIG.midScoreMin} ≤ 匹配分 ≤ ${CONFIG.parentScoreThreshold} → 疑似正确 → 展开后：好样本(≥${CONFIG.childScoreGood}分) ≥${CONFIG.childScoreGoodMinCount} 条 <b>或</b> 存在 ${CONFIG.correctCodes.join('/')} → 模式1；否则模式2<br>
          ⑤ 匹配分 &lt;${CONFIG.midScoreMin} → 模式2（直接全错，不展开）⑥ 匹配分读不到 → 展开看 ${CONFIG.correctCodes.join('/')} 兜底<br>
          <b>等待/重试</b>：全剧审核是否完成<b>只看第2列合集id</b>（唯一）；等待期间第 ${CONFIG.retryAtSec.join('s / ')}s 各重试点击一次同一按钮（最多3次）；仍无响应 → <b>永久跳过该合集，换下一行继续</b><br>
          <b>严格等待</b>：每次点击前/展开后/提交后都等 antd 转圈消失；转圈期间不判定完成
        </div>
        <div class="p9-log" id="s9-log"></div>
      </div>
      <div class="p9-mini-status" id="s9-mini-status"></div>
    `;
    document.body.appendChild(panel);

    const css = document.createElement('style');
    css.textContent = `
      #s9-panel{position:fixed;top:100px;right:20px;width:300px;background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.15);z-index:999999;font-size:13px;font-family:system-ui,sans-serif;}
      .p9-title{padding:8px 12px;background:#722ed1;color:#fff;border-radius:8px 8px 0 0;font-weight:600;position:relative;}
      .p9-min{position:absolute;right:8px;top:6px;width:22px;height:22px;line-height:18px;border:none;border-radius:4px;background:rgba(255,255,255,.25);color:#fff;cursor:pointer;font-size:14px;}
      .p9-min:hover{background:rgba(255,255,255,.45);}
      .p9-statusline{padding:6px 12px;background:#fff7e6;border-bottom:1px solid #ffe7ba;color:#d46b08;font-size:12px;min-height:26px;}
      .p9-statusline span{word-break:break-all;}
      .p9-mini-status{display:none;padding:6px 12px;background:#fff7e6;color:#d46b08;font-size:12px;border-radius:0 0 8px 8px;}
      .p9-main{padding:10px 12px;}
      .form-row{display:flex;align-items:center;gap:5px;margin-bottom:8px;}
      .form-row label{width:86px;font-size:12px;color:#666;flex:none;}
      .form-row input{width:58px;padding:3px 5px;border:1px solid #d9d9d9;border-radius:4px;outline:none;font-size:12px;}
      .form-row span{font-size:11px;color:#999;}
      .p9-check{display:flex;align-items:center;gap:4px;cursor:pointer;color:#d46b08;font-weight:600;}
      .stat-row{margin-bottom:8px;color:#333;font-size:12px;}
      .stat-row b{color:#722ed1;font-size:15px;}
      .btn-row{display:flex;gap:8px;margin-bottom:8px;}
      .btn{flex:1;padding:6px 0;border:none;border-radius:4px;cursor:pointer;font-size:13px;}
      .btn:disabled{opacity:0.5;cursor:not-allowed;}
      .btn-start{background:#52c41a;color:#fff;}
      .btn-stop{background:#ff4d4f;color:#fff;}
      .btn-copy{background:#f6ffed;color:#389e0d;border:1px solid #b7eb8f;font-size:12px;}
      .tip{font-size:11px;color:#999;margin-bottom:8px;line-height:1.7;}
      .tip b{color:#722ed1;}
      .p9-log{max-height:160px;overflow-y:auto;background:#fafafa;border-radius:4px;padding:5px 7px;font-size:11px;font-family:Consolas,monospace;line-height:1.6;color:#666;word-break:break-all;}
    `;
    document.head.appendChild(css);

    initDrag(panel, panel.querySelector('#s9-title'));

    // 最小化/展开
    const main = panel.querySelector('#s9-main');
    const miniStatus = panel.querySelector('#s9-mini-status');
    document.querySelector('#s9-min').addEventListener('click', () => {
      const hidden = main.style.display === 'none';
      main.style.display = hidden ? '' : 'none';
      miniStatus.style.display = hidden ? 'none' : '';
      document.querySelector('#s9-min').textContent = hidden ? '—' : '□';
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

    // 复制跳过清单（TSV）
    const copyBtn = document.querySelector('#copy-skip-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const text = buildSkipText();
        try {
          GM_setClipboard(text);
          log('✅ 已复制跳过清单（' + state.skipList.length + ' 个合集）');
        } catch (e) {
          // 无 GM 权限时退化为控制台输出
          console.log(text);
          log('复制失败（' + (e.message || e) + '），已把清单打印到控制台');
        }
      });
    }
  }

  function startRun() {
    if (state.running) return;
    state.running = true;
    state.processedCount = 0;
    state.mode1Count = 0;
    state.mode2Count = 0;
    state.skipIds = new Set();
    state.skipList = [];
    state.workIndex = CONFIG.startRow - 1;
    document.querySelector('#start-btn').disabled = true;
    document.querySelector('#stop-btn').disabled = false;
    updatePanel();
    setStatus('启动中...');
    log('===== 开始运行（从第' + CONFIG.startRow + '行起）=====');
    log('严格等待加载完成：' + (CONFIG.strictLoading ? '开（转圈消失才点下一步）' : '关') +
      '；等待上限 普通' + Math.round(CONFIG.loadingWaitMax / 1000) + 's / 慢合集' +
      Math.round(CONFIG.loadingWaitMaxSlow / 1000) + 's');
    log('等待重试：第 ' + CONFIG.retryAtSec.join('s、') + 's 各重试点击一次（每按钮最多3次）；' +
      '仍无响应 → 永久跳过该合集换下一行（最多跳过 ' + CONFIG.maxSkipCount + ' 个）');
    log('终极关键词（第3列命中即直接全错）：' + CONFIG.ultimateKeywords.join('、'));
    log('判定：⓪终极关键词→直接全错 ①关键词双列比对(第3列命中且第4列同词→疑似正确；否则全错) ' +
      '②相似度闸门(短剧名≤' + CONFIG.similarGateNameLen + '字 且无同词/字：匹配分<' + CONFIG.midScoreMin +
      '→全错；≥' + CONFIG.midScoreMin + '→展开看子样本) ③匹配分>' + CONFIG.parentScoreThreshold + '→模式1 ④[' +
      CONFIG.midScoreMin + ',' + CONFIG.parentScoreThreshold + ']→展开看子样本(好样本≥' +
      CONFIG.childScoreGood + '分 且 条数≥' + CONFIG.childScoreGoodMinCount + ' 或 有 ' +
      CONFIG.correctCodes.join('/') + '→模式1) ⑤<' + CONFIG.midScoreMin + '→模式2 ⑥读不到→痕迹兜底');
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
