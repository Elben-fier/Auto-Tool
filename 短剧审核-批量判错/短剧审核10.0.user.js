// ==UserScript==
// @name         Shift短剧审核-统一勾选处理版【10.0】
// @namespace    https://doubao.com/userscripts
// @version      10.0.0
// @description  取消双模式：一律【展开→勾选→批量错误(等594)→全剧审核】，判定链只决定勾选范围（全错=全选子样本 / 正确=只勾选待判低分行）；保留终极关键词、关键词双列比对、相似度闸门、30s/60s重试、永久跳过与严格等待加载
// @author       Doubao
// @match        https://tools.vobile.cn/quality/dramaReview*
// @grant        GM_setClipboard
// @run-at       document-end
// ==/UserScript==

// ============================== 10.0.0 更新记录 ==============================
//  【核心变更】取消 7.0~9.0 的"双模式"（模式1=不展开直接全剧审核 / 模式2=全选判错）：
//        原因：模式1 既不展开也不勾选就直接点「全剧审核」，与页面"先勾选再提交"的实际流程不符，
//              被判为"正确"的合集没有真正勾选就提交，结果不可靠。
//        10.0 统一为一条流程（恢复 5.0「勾选」版的做法）：
//            展开合集 → 勾选目标子样本 → 批量错误（等目标行变 594）→ 全剧审核（等合集移走）
//  【判定链只决定"勾选范围"】
//        · 全错处理（勾选全部子样本，表头全选优先，逐行兜底）：
//            ⓪ 终极关键词命中  ① 普通关键词仅出现在第3列  ② 相似度闸门不通过且匹配分<90
//            ⑤ 匹配分<90       ⑥ 匹配分读不到且无 601/777 痕迹
//        · 勾选处理（只勾选"待判低分行"：未打594 且 得分<childScoreThreshold）：
//            ③ 匹配分>95       ④ 90≤匹配分≤95 且（好样本≥3条 或 有601/777）
//            ⑥ 匹配分读不到但有 601/777   ② 相似度不通过但匹配分≥90（按 ④ 判定）
//        · 勾选处理时若已无待判低分行 → 不点「批量错误」，直接进入全剧审核
//  【等响应按范围区分】全错处理 → 所有子样本都必须变 594；
//                      勾选处理 → 只有待判低分行必须变 594（既有 777/601 痕迹保留不动）
//  【沿用】9.0 的终极关键词、关键词双列比对、相似度闸门、只用第2列id判断完成、
//          30s/60s重试、永久跳过、严格等待加载（转圈闸门）
// ==========================================================================

// ==========================================================================


(function () {
  'use strict';

  console.log('[短剧审核10.0] 统一勾选处理版已加载');

  // ========== 可配置项 ==========
  const CONFIG = {
    // —— 判定链（10.0：只决定"勾选范围"，不再决定"直接全剧审核"）——
    parentScoreThreshold: 95,      // 母本匹配最高分(第5列)：> 该值 → 勾选处理（只把低分子样本判错）
    midScoreMin: 90,               // 90 ≤ 匹配分 ≤ 95 → 疑似正确，展开看子样本（<90 → 全错处理）
    childScoreGood: 90,            // 子样本得分(第8列) ≥ 该值 视为"好样本"
    childScoreGoodMinCount: 3,     // 好样本条数 ≥ 该值（默认3）→ 判该合集正确 → 勾选处理
    childScoreThreshold: 90,       // 勾选处理的"待判低分行"门槛：得分 < 该值 且 未打594 才勾选判错
    tickScope: 'lowScore',         // 勾选处理的范围：'lowScore'=只勾选待判低分行（默认）；
                                   //                'allUnjudged'=勾选所有未打594的行（含既有777/601）
    correctCodes: ['777', '601'],  // 子样本状态码(第3列)：出现这些码 → 前人已判定 → 有正确数据
    wrongCode: '594',              // 判错完成标志（批量错误后，子样本状态码 0 → 594）
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
    fullErrorCount: 0,   // 全错处理次数（全选子样本判错）
    tickCount: 0,        // 勾选处理次数（只勾选待判低分行判错）
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
    console.log('[短剧10.0] ' + msg);
    const el = document.querySelector('#s10-log');
    if (!el) return;
    const line = document.createElement('div');
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    el.prepend(line);
    while (el.children.length > 200) el.lastChild.remove();
  }

  function setStatus(msg) {
    console.log('[状态] ' + msg);
    const el = document.querySelector('#s10-status');
    if (el) el.textContent = msg;
    // 最小化时下方也显示当前状态
    const t = document.querySelector('#s10-mini-status');
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
    catch (e) { console.warn('[短剧10.0] 点击失败:', e.message || e); return false; }
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
      if (!sp.closest('#s10-panel')) return true;
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
    let scoreGood = 0;          // 子样本得分 ≥ childScoreGood 的条数
    let scoreLow = 0;           // 10.0：待判低分行条数（未打594 且 得分 < childScoreThreshold）
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
        // 10.0：勾选处理的目标行 = 未打594 且 得分低于门槛
        if (sc < CONFIG.childScoreThreshold && code !== CONFIG.wrongCode) scoreLow++;
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
      scoreLow: scoreLow,                // 待判低分行条数（勾选处理的目标行）
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

  // ========== 待判低分行（勾选处理的目标行） ==========
  // 条件：未打 594（避免重复勾选已判错的行） 且 得分 < childScoreThreshold
  // 说明：得分读不到的行不参与勾选（无法判断，避免把好数据误判为错误）
  function getLowScoreTargetRows(expandedRow) {
    return getChildRows(expandedRow).filter((row) => {
      if (getChildCode(row) === CONFIG.wrongCode) return false;
      const sc = parseNum(cellText(row, SELECTORS.childScoreCell));
      return sc !== null && sc < CONFIG.childScoreThreshold;
    });
  }

  // 勾选处理的目标行（受 CONFIG.tickScope 控制）：
  //   'lowScore'    → 只勾选待判低分行（未打594 且 得分 < childScoreThreshold）
  //   'allUnjudged' → 勾选所有未打594的行（既有的 777/601 也会一并被判错）
  function getTickTargetRows(expandedRow) {
    if (CONFIG.tickScope === 'allUnjudged') {
      return getChildRows(expandedRow).filter((row) => getChildCode(row) !== CONFIG.wrongCode);
    }
    return getLowScoreTargetRows(expandedRow);
  }

  // ========== 勾选目标子样本（10.0 新增：范围由判定链决定） ==========
  // fullError=true （全错处理）：表头全选优先、逐行兜底 → 勾选全部子样本
  // fullError=false（勾选处理）：勾选"待判目标行"（见 getTickTargetRows，默认只勾待判低分行）
  // 返回勾选到的目标行数（含此前已勾选的目标行）
  async function selectTargetRows(expandedRow, fullError) {
    if (fullError) return await selectAllChildRows(expandedRow);

    const targets = getTickTargetRows(expandedRow);
    if (targets.length === 0) return 0;
    let count = 0;
    for (const row of targets) {
      if (!state.running) break;
      const cb = row.querySelector(SELECTORS.childCheckbox);
      if (!cb) continue;
      if (cb.checked) { count++; continue; }
      safeClick(cb);
      count++;
      await delay(60);
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

  // ========== 等待判错完成（目标行变 594） ==========
  // 10.0 按勾选范围区分完成条件：
  //   ① 全错处理（fullError=true）：所有子样本状态码都必须是 594
  //      （不能只看"不再是0"，否则原有的 777/601 会被误判为已完成）
  //   ② 勾选处理（fullError=false）：只有"待判低分行"（未打594 且 得分<childScoreThreshold）必须变 594，
  //      既有的 777/601 等痕迹保留不动
  // 并且要求页面转圈已结束；等待期间第 30s / 60s 会各重试点击一次「批量错误」
  async function waitAllJudged(expandedRow, R, timeout, fullError, needTargets) {
    const start = Date.now();
    const retried = [];
    while (Date.now() - start < timeout) {
      if (!state.running) return false;

      const stats = getCodeStats(expandedRow);
      const loading = isLoading();
      const targetsLeft = fullError ? 0 : getTickTargetRows(expandedRow).length;
      const remaining = fullError ? stats.notWrong : targetsLeft;
      const need = fullError ? stats.total : (needTargets || (targetsLeft + stats.wrong));
      state.judgeNeed = need;
      state.judgeDone = fullError ? stats.wrong : Math.max(0, need - targetsLeft);

      setStatus((fullError ? '全错处理' : '勾选处理') + ' · 判错中 594: ' +
        state.judgeDone + '/' + state.judgeNeed +
        (remaining === 0 ? ' ✅' : ' ⏳ 剩余待判 ' + remaining + ' 条') +
        (loading ? '（系统处理中…）' : '') + ' [' + stats.detail + ']');

      if (stats.total > 0 && remaining === 0 && !loading) return true;

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
  // 10.0：全剧审核固定发生在"展开 + 勾选 + 批量错误"之后（expandedRow 必定存在）；
  //       expandFn 仍保留作兜底：按钮找不到/点不通时展开后重试，避免误判异常。
  // expandedRow：已展开时传入，便于在展开区内定位按钮
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

  // ========== 处理单个合集（10.0 统一勾选流程） ==========
  // 【10.0 核心】取消"双模式"，任何情况都走同一条流程：
  //     展开合集 → 勾选目标子样本 → 批量错误（等目标行变 594）→ 全剧审核（等合集移走）
  //   判定链只决定"勾选范围"：
  //     · 全错处理（fullError=true） ：勾选全部子样本（表头全选优先，逐行兜底）→ 批量错误
  //     · 勾选处理（fullError=false）：勾选"待判目标行"，范围由 CONFIG.tickScope 决定：
  //             'lowScore'（默认）＝只勾选待判低分行（未打594 且 得分<childScoreThreshold）
  //             'allUnjudged'     ＝勾选所有未打594的行（既有的 777/601 也会一并被判错）
  //                                    若无待判目标行 → 跳过「批量错误」，直接全剧审核
  //   判定链（沿用 9.0 规则，结果映射为勾选范围）：
  //     ⓪ 终极关键词命中                        → 全错
  //     ① 普通关键词仅在第3列（第4列无同词）     → 全错
  //     ② 相似度闸门不通过：匹配分<90 → 全错；≥90（或读不到）→ 展开按 ④ 判定
  //     ③ 匹配分 > 95                           → 勾选处理
  //     ④ 90 ≤ 匹配分 ≤ 95 → 展开后：好样本(≥90分)条数 ≥3 或 存在 601/777 → 勾选处理；否则全错
  //     ⑤ 匹配分 < 90                           → 全错
  //     ⑥ 匹配分读不到 → 展开后：有 601/777 → 勾选处理；否则全错
  // 返回 { result: 'ok'|'problem', fullError: bool, reason }
  async function processOneCollection(R, meta) {
    const expandWait = meta.isSlow ? CONFIG.expandWaitMaxSlow : CONFIG.expandWaitMax;
    const expandFn = () => expandRowAndWait(R, expandWait);

    // ---- 第0步：严格等待上一轮遗留下的加载完成 ----
    const startLoadWait = meta.isSlow ? CONFIG.loadingWaitMaxSlow : CONFIG.loadingWaitMax;
    if (CONFIG.strictLoading && !(await waitLoadingDone('开始处理本轮前', startLoadWait))) {
      return { result: 'problem', fullError: true, reason: '上一轮加载未完成' };
    }

    // ---- 第1步：母行信息 + 终极关键词 + 关键词 + 相似度（不需要展开）----
    const ultimateKw = getUltimateKeyword(meta.name);
    const kwr = getKeywordRule(R, meta);
    const sim = checkSimilarOriginalName(R, meta);
    const gateActive = sim.nameLen <= CONFIG.similarGateNameLen;

    log('终极关键词检查：短剧名「' + meta.name + '」 → ' +
      (ultimateKw ? ('命中「' + ultimateKw + '」→ 全错处理（跳过所有后续判定）') : '未命中'));
    log('关键词比对：短剧名「' + meta.name + '」 vs 原短剧名「' + meta.originalName + '」 → ' +
      (kwr.kw ? ('命中「' + kwr.kw + '」，第4列' + (kwr.dual ? '也有该词 → 疑似正确' : '没有该词 → 全错处理'))
        : '第3列未命中关键词'));
    log('相似度比对：短剧名(' + sim.nameLen + '字) → ' +
      (gateActive ? (sim.similar ? '相似·疑似正确' : '不相似（转按匹配分判定）') : '跳过闸门(名称>' + CONFIG.similarGateNameLen + '字)') +
      '（' + sim.detail + '）');

    const score = meta.score;
    let fullError = true;      // 默认按全错处理
    let reason = '';
    let needExpand = false;    // 需要展开后再按子样本判定（匹配分 90~95 / 读不到）
    let expandReason = '';

    if (ultimateKw) {
      // ⓪ 终极关键词：第3列命中 → 全错处理，不看任何后续判定
      fullError = true;
      reason = '【终极关键词】「' + ultimateKw + '」出现在第3列 → 全错处理（不执行后续任何判定）';
    } else if (kwr.hit) {
      // ① 第3列命中普通关键词、第4列没有 → 全错处理
      fullError = true;
      reason = '关键词「' + kwr.kw + '」仅出现在第3列（第4列无该词）→ 全错处理';
    } else if (gateActive && !sim.similar) {
      // ② 相似度闸门不通过（短剧名≤4字 且与第4列无相同词/字）
      if (score !== null && score < CONFIG.midScoreMin) {
        fullError = true;
        reason = '短剧名' + sim.nameLen + '字≤' + CONFIG.similarGateNameLen + ' 且与第4列无相同词/字，' +
          '匹配分 ' + score + ' < ' + CONFIG.midScoreMin + ' → 全错处理';
      } else {
        needExpand = true;
        expandReason = '短剧名' + sim.nameLen + '字≤' + CONFIG.similarGateNameLen + ' 且与第4列无相同词/字' +
          (score === null ? '（匹配分读不到）' : '，但匹配分 ' + score + ' ≥ ' + CONFIG.midScoreMin) +
          ' → 疑似正确，需展开判断：好样本(≥' + CONFIG.childScoreGood + '分)条数 ≥' +
          CONFIG.childScoreGoodMinCount + ' 或 存在 ' + CONFIG.correctCodes.join('/');
      }
    } else if (score !== null && score > CONFIG.parentScoreThreshold) {
      // ③ 匹配分 > 95 → 勾选处理（只把低分子样本判错，其余保留）
      fullError = false;
      reason = '匹配分 ' + score + ' > ' + CONFIG.parentScoreThreshold + ' → 存在正确数据 → 勾选处理' +
        (kwr.dual ? '（关键词「' + kwr.kw + '」两列都有）' : '');
    } else if (score !== null && score >= CONFIG.midScoreMin) {
      // ④ 90~95 → 展开看子样本（待定）
      needExpand = true;
      expandReason = '匹配分 ' + score + ' ∈ [' + CONFIG.midScoreMin + ',' + CONFIG.parentScoreThreshold +
        '] → 疑似正确，需展开判断：好样本(≥' + CONFIG.childScoreGood + '分)条数 ≥' +
        CONFIG.childScoreGoodMinCount + ' 或 存在 ' + CONFIG.correctCodes.join('/');
    } else if (score !== null) {
      // ⑤ < 90 → 全错处理
      fullError = true;
      reason = '匹配分 ' + score + ' < ' + CONFIG.midScoreMin + ' → 一律按错误数据处理' +
        (kwr.dual ? '（关键词两列都有，但匹配分过低）' : '');
    } else {
      // ⑥ 匹配分读不到 → 展开看痕迹（待定）
      needExpand = true;
      expandReason = '匹配分读取失败 → 需展开查看 ' + CONFIG.correctCodes.join('/') + ' 痕迹';
    }

    if (!needExpand) {
      log('===== 判定：' + (fullError ? '全错处理（全选子样本判错）'
        : (CONFIG.tickScope === 'allUnjudged' ? '勾选处理（勾所有未判错行）' : '勾选处理（只勾选待判低分行）')) +
        '：' + reason + ' =====');
      setStatus((fullError ? '全错处理' : '勾选处理') + '：' + reason);
    } else {
      log('===== 判定待定：' + expandReason + ' =====');
      setStatus('待定：' + expandReason);
    }

    // ---- 第2步：展开合集（10.0：所有分支都先展开，不再有"不展开直接全剧审核"）----
    setStatus('展开合集「' + meta.name + '」(' + meta.episodes + '集' +
      (meta.isSlow ? '·慢处理' : '') + ')...');
    let expandedRow;
    try {
      expandedRow = await expandFn();
    } catch (e) {
      log('展开失败: ' + e.message);
      return { result: 'problem', fullError: fullError, reason: '展开失败: ' + e.message };
    }

    const stats = getCodeStats(expandedRow);
    log('子样本统计：共 ' + stats.total + ' 条 | 状态码 ' + stats.detail +
      ' | 好样本(≥' + CONFIG.childScoreGood + '分) ' + stats.scoreGood + ' 条' +
      ' | 待判低分行(<' + CONFIG.childScoreThreshold + '分) ' + stats.scoreLow + ' 条' +
      ' | 未判错行 ' + stats.notWrong + ' 条' +
      '(可读得分 ' + stats.scoreKnown + ' 条；勾选范围=' +
      (CONFIG.tickScope === 'allUnjudged' ? '所有未判错行' : '只勾待判低分行') + ')');

    // ---- 第3步：待定分支用子样本判定（匹配分 90~95 或 匹配分读不到）----
    if (needExpand) {
      const byScore = (score !== null && score >= CONFIG.midScoreMin);
      const goodEnough = stats.scoreGood >= CONFIG.childScoreGoodMinCount;
      if (byScore) {
        if (goodEnough || stats.hasCorrect) {
          fullError = false;
          reason = '匹配分 ' + score + ' 疑似正确，且子样本' +
            (goodEnough ? ('好样本 ' + stats.scoreGood + ' 条 ≥ ' + CONFIG.childScoreGoodMinCount) : '') +
            (goodEnough && stats.hasCorrect ? '、' : '') +
            (stats.hasCorrect ? ('存在状态码 ' + Array.from(new Set(stats.correctHits)).join('/')) : '') +
            ' → 勾选处理';
        } else {
          fullError = true;
          reason = '匹配分 ' + score + ' 疑似正确，但子样本不满足条件（好样本 ' + stats.scoreGood + ' 条 < ' +
            CONFIG.childScoreGoodMinCount + '，且无 ' + CONFIG.correctCodes.join('/') + ' 痕迹）→ 全错处理';
        }
      } else {
        if (stats.hasCorrect) {
          fullError = false;
          reason = '匹配分读取失败，但存在状态码 ' + Array.from(new Set(stats.correctHits)).join('/') + ' → 勾选处理';
        } else {
          fullError = true;
          reason = '匹配分读取失败且无 ' + CONFIG.correctCodes.join('/') + ' 痕迹 → 全错处理';
        }
      }
      log('===== 补充判定：' + (fullError ? '全错处理' : '勾选处理') + '：' + reason + ' =====');
      setStatus((fullError ? '全错处理' : '勾选处理') + '：' + reason);
    }

    // ---- 第4步：勾选目标子样本 → 批量错误 → 等目标行变 594 ----
    const targetCount = fullError ? stats.total
      : (CONFIG.tickScope === 'allUnjudged' ? stats.notWrong : stats.scoreLow);
    if (!fullError && targetCount === 0) {
      log('勾选处理：无待判目标行（' + (CONFIG.tickScope === 'allUnjudged'
        ? ('所有子样本都已打 ' + CONFIG.wrongCode)
        : ('未打' + CONFIG.wrongCode + ' 且 得分<' + CONFIG.childScoreThreshold + ' 的子样本为 0')) +
        '）→ 跳过「批量错误」，直接进入全剧审核');
      setStatus('勾选处理：无可判错子样本，直接全剧审核...');
    } else {
      // 严格等待：勾选前确保子表已渲染完（无转圈）
      if (CONFIG.strictLoading && !(await waitLoadingDone('勾选子样本前', CONFIG.loadingWaitMax))) {
        return { result: 'problem', fullError: fullError, reason: '勾选前加载未完成' };
      }
      setStatus((fullError ? '全错处理' : '勾选处理') + ' · 勾选目标子样本 ' + targetCount + ' 条...');
      log((fullError ? '全错处理' : '勾选处理') + ' 状态码分布: ' + stats.detail +
        '（已是594 ' + stats.wrong + ' 条，待处理 ' + stats.notWrong + ' 条；勾选范围=' +
        (fullError ? '全部子样本'
          : (CONFIG.tickScope === 'allUnjudged' ? '所有未判错行' : '待判低分行')) + '）');

      const checked = await selectTargetRows(expandedRow, fullError);
      if (!state.running) return { result: 'problem', fullError: fullError, reason: '已停止' };
      log('已勾选 ' + checked + ' / ' + targetCount + ' 条' +
        (fullError ? '（全选）' : (CONFIG.tickScope === 'allUnjudged' ? '（所有未判错行）' : '（待判低分行）')));
      if (checked === 0) {
        log('勾选失败（复选框未生效），判定该合集有问题');
        return { result: 'problem', fullError: fullError, reason: '勾选失败（复选框未生效）' };
      }
      // 严格等待：勾选后也可能触发渲染/请求，等加载结束再点「批量错误」
      if (CONFIG.strictLoading && !(await waitLoadingDone('勾选后等待就绪', CONFIG.loadingWaitMax))) {
        return { result: 'problem', fullError: fullError, reason: '勾选后加载未完成' };
      }

      // 批量错误（判错）——失败自动重试3次
      log('点击「批量错误」...');
      if (!(await clickRowButtonRetry(R, '批量错误', expandedRow, 3, 3000))) {
        log('批量错误提交失败（按钮不可用或弹窗未出现）');
        return { result: 'problem', fullError: fullError, reason: '批量错误提交失败' };
      }

      // 等响应：目标行全部变 594 且转圈结束；等待期间 30s/60s 会重试点击「批量错误」
      const judgeWait = meta.isSlow ? CONFIG.batchErrorWaitMaxSlow : CONFIG.batchErrorWaitMax;
      const ok = await waitAllJudged(expandedRow, R, judgeWait, fullError, targetCount);
      if (!ok) {
        const last = getCodeStats(expandedRow);
        log('等待594+加载完成超时(' + Math.round(judgeWait / 1000) + 's，已含30s/60s两次重试)，状态码分布: ' +
          last.detail + '，待判目标行剩余 ' +
          (fullError || CONFIG.tickScope === 'allUnjudged' ? last.notWrong : last.scoreLow) + ' 条' +
          (isLoading() ? '（页面仍有转圈）' : '') + '，判定该合集有问题');
        return { result: 'problem', fullError: fullError, reason: '批量错误等待超时（594未齐）' };
      }
      log('✅ 判错完成：' + (fullError
        ? ('全部子样本状态码=' + CONFIG.wrongCode)
        : ((CONFIG.tickScope === 'allUnjudged' ? '所有未判错行' : '待判低分行') + '已全部=' + CONFIG.wrongCode +
          '（保留既有 ' + CONFIG.correctCodes.join('/') + ' 等痕迹）')) +
        '，且系统处理已结束');

      // 判错成功后额外等待（落库缓冲）
      setStatus('判错成功，等待系统落库...');
      await delay(meta.isSlow ? CONFIG.settleAfterBatchErrorSlow : CONFIG.settleAfterBatchError);
      if (!state.running) return { result: 'problem', fullError: fullError, reason: '已停止' };
    }

    // ---- 第5步：全剧审核（行已展开，expandedRow 传入便于定位按钮）----
    const r2 = await doFullReview(R, meta, null, expandedRow);
    return { result: r2, fullError: fullError, reason: reason };
  }

  // ========== 主循环（10.0：id 唯一 + 永久跳过） ==========
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
          if (res.fullError) state.fullErrorCount++;
          else state.tickCount++;
          updatePanel();
          log('✅ 第' + (target.idx + 1) + '行合集完成（' + (res.fullError ? '全错处理' : '勾选处理') +
            '，累计 ' + state.processedCount + ' 条）');
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
          reason: res.reason || '处理异常',
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
        console.error('[短剧10.0] 主循环异常:', e);
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
      setTimeout(() => alert('处理完成！共处理 ' + state.processedCount + ' 个合集\n全错处理(全选判错) ' +
        state.fullErrorCount + ' 个 / 勾选处理(低分筛选判错) ' + state.tickCount + ' 个' + skipText), 100);
    }
  }

  // ========== 面板 ==========
  function updatePanel() {
    const c = document.querySelector('#s10-count');
    if (c) c.textContent = state.processedCount;
    const r = document.querySelector('#s10-row');
    if (r) r.textContent = (state.workIndex + 1);
    const m1 = document.querySelector('#s10-m1');
    if (m1) m1.textContent = state.fullErrorCount;
    const m2 = document.querySelector('#s10-m2');
    if (m2) m2.textContent = state.tickCount;
    const sk = document.querySelector('#s10-skip');
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
    if (document.querySelector('#s10-panel')) return;
    const panel = document.createElement('div');
    panel.id = 's10-panel';
    panel.innerHTML = `
      <div class="p10-title" id="s10-title">短剧审核助手 10.0
        <button id="s10-min" class="p10-min" title="最小化/展开">—</button>
      </div>
      <div class="p10-statusline"><span id="s10-status">空闲</span></div>
      <div class="p10-main" id="s10-main">
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
          <label>低分门槛：</label>
          <input type="number" id="child-threshold" value="${CONFIG.childScoreThreshold}" min="0" max="100">
          <span>勾选处理时低于该分才勾选</span>
        </div>
        <div class="form-row">
          <label>勾选范围：</label>
          <select id="tick-scope">
            <option value="lowScore"${CONFIG.tickScope === 'lowScore' ? ' selected' : ''}>只勾待判低分行</option>
            <option value="allUnjudged"${CONFIG.tickScope === 'allUnjudged' ? ' selected' : ''}>勾所有未判错行</option>
          </select>
        </div>
        <div class="form-row">
          <label>慢处理集数：</label>
          <input type="number" id="slow-threshold" value="${CONFIG.slowEpisodeThreshold}" min="1">
          <span>集以上</span>
        </div>
        <div class="form-row">
          <label class="p10-check"><input type="checkbox" id="strict-loading" ${CONFIG.strictLoading ? 'checked' : ''}> <b>严格等待加载完成</b></label>
          <span>转圈消失才点下一步</span>
        </div>
        <div class="stat-row">当前行：第 <b id="s10-row">1</b> 行 &nbsp;|&nbsp; 已完成：<b id="s10-count">0</b> 个 &nbsp;|&nbsp; 已跳过：<b id="s10-skip">0</b> 个</div>
        <div class="stat-row">全错(全选判错)：<b id="s10-m1">0</b> &nbsp;|&nbsp; 勾选(低分筛选)：<b id="s10-m2">0</b></div>
        <div class="btn-row">
          <button id="start-btn" class="btn btn-start">开始运行</button>
          <button id="stop-btn" class="btn btn-stop" disabled>停止</button>
        </div>
        <div class="btn-row">
          <button id="copy-skip-btn" class="btn btn-copy">复制跳过清单</button>
        </div>
        <div class="tip">
          <b>10.0 统一流程</b>：<b>展开 → 勾选 → 批量错误（等594）→ 全剧审核</b>（不再有"不展开直接全剧审核"）<br>
          判定链只决定<b>勾选范围</b>：<br>
          ⓪ <b>终极关键词</b>（${CONFIG.ultimateKeywords.join('、')}）：第3列命中 → <b>全错处理</b>，不执行任何后续判定<br>
          ① 关键词双列比对：第3列命中且第4列也有同一词 → 疑似正确（继续）；第4列没有 → <b>全错处理</b><br>
          ② 相似度闸门（短剧名 ≤${CONFIG.similarGateNameLen} 字 且与第4列无相同词/字）：匹配分 &lt;${CONFIG.midScoreMin} → <b>全错处理</b>；≥${CONFIG.midScoreMin} → 展开按 ④ 判定<br>
          ③ 匹配分 &gt;${CONFIG.parentScoreThreshold} → <b>勾选处理</b><br>
          ④ ${CONFIG.midScoreMin} ≤ 匹配分 ≤ ${CONFIG.parentScoreThreshold} → 展开后：好样本(≥${CONFIG.childScoreGood}分) ≥${CONFIG.childScoreGoodMinCount} 条 <b>或</b> 存在 ${CONFIG.correctCodes.join('/')} → <b>勾选处理</b>；否则 <b>全错处理</b><br>
          ⑤ 匹配分 &lt;${CONFIG.midScoreMin} → <b>全错处理</b>；⑥ 匹配分读不到 → 展开看 ${CONFIG.correctCodes.join('/')}：有 → 勾选处理，无 → 全错处理<br>
          <b>勾选范围</b>：全错处理 = <b>全选全部子样本</b>再批量错误；勾选处理 = <b>${CONFIG.tickScope === 'allUnjudged' ? '勾选所有未判错行' : ('只勾选待判低分行（未打594 且 得分&lt;' + CONFIG.childScoreThreshold + '）')}</b>，已无目标行则跳过「批量错误」<br>
          <b>等待/重试</b>：全剧审核是否完成<b>只看第2列合集id</b>（唯一）；等待期间第 ${CONFIG.retryAtSec.join('s / ')}s 各重试点击一次同一按钮（最多3次）；仍无响应 → <b>永久跳过该合集，换下一行继续</b><br>
          <b>严格等待</b>：每次点击前/展开后/勾选后/提交后都等 antd 转圈消失；转圈期间不判定完成
        </div>

        <div class="p10-log" id="s10-log"></div>
      </div>
      <div class="p10-mini-status" id="s10-mini-status"></div>
    `;
    document.body.appendChild(panel);

    const css = document.createElement('style');
    css.textContent = `
      #s10-panel{position:fixed;top:100px;right:20px;width:300px;background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.15);z-index:999999;font-size:13px;font-family:system-ui,sans-serif;}
      .p10-title{padding:8px 12px;background:#722ed1;color:#fff;border-radius:8px 8px 0 0;font-weight:600;position:relative;}
      .p10-min{position:absolute;right:8px;top:6px;width:22px;height:22px;line-height:18px;border:none;border-radius:4px;background:rgba(255,255,255,.25);color:#fff;cursor:pointer;font-size:14px;}
      .p10-min:hover{background:rgba(255,255,255,.45);}
      .p10-statusline{padding:6px 12px;background:#fff7e6;border-bottom:1px solid #ffe7ba;color:#d46b08;font-size:12px;min-height:26px;}
      .p10-statusline span{word-break:break-all;}
      .p10-mini-status{display:none;padding:6px 12px;background:#fff7e6;color:#d46b08;font-size:12px;border-radius:0 0 8px 8px;}
      .p10-main{padding:10px 12px;}
      .form-row{display:flex;align-items:center;gap:5px;margin-bottom:8px;}
      .form-row label{width:86px;font-size:12px;color:#666;flex:none;}
      .form-row input{width:58px;padding:3px 5px;border:1px solid #d9d9d9;border-radius:4px;outline:none;font-size:12px;}
      .form-row select{flex:1;padding:3px 5px;border:1px solid #d9d9d9;border-radius:4px;outline:none;font-size:12px;background:#fff;color:#333;}
      .form-row span{font-size:11px;color:#999;}
      .p10-check{display:flex;align-items:center;gap:4px;cursor:pointer;color:#d46b08;font-weight:600;}
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
      .p10-log{max-height:160px;overflow-y:auto;background:#fafafa;border-radius:4px;padding:5px 7px;font-size:11px;font-family:Consolas,monospace;line-height:1.6;color:#666;word-break:break-all;}
    `;
    document.head.appendChild(css);

    initDrag(panel, panel.querySelector('#s10-title'));

    // 最小化/展开
    const main = panel.querySelector('#s10-main');
    const miniStatus = panel.querySelector('#s10-mini-status');
    document.querySelector('#s10-min').addEventListener('click', () => {
      const hidden = main.style.display === 'none';
      main.style.display = hidden ? '' : 'none';
      miniStatus.style.display = hidden ? 'none' : '';
      document.querySelector('#s10-min').textContent = hidden ? '—' : '□';
    });

    document.querySelector('#start-btn').addEventListener('click', () => {
      const row = parseInt(document.querySelector('#start-row').value);
      const p = parseInt(document.querySelector('#parent-threshold').value);
      const s = parseInt(document.querySelector('#slow-threshold').value);
      const cEl = document.querySelector('#child-threshold');
      const c = cEl ? parseInt(cEl.value) : NaN;
      const tsEl = document.querySelector('#tick-scope');
      const strictEl = document.querySelector('#strict-loading');
      if (!isNaN(row) && row > 0) CONFIG.startRow = row;
      if (!isNaN(p)) CONFIG.parentScoreThreshold = p;
      if (!isNaN(c)) CONFIG.childScoreThreshold = c;
      if (tsEl && tsEl.value) CONFIG.tickScope = tsEl.value;
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
    state.fullErrorCount = 0;
    state.tickCount = 0;
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
    log('终极关键词（第3列命中即全错处理）：' + CONFIG.ultimateKeywords.join('、'));
    log('10.0 统一流程：展开 → 勾选 → 批量错误（等目标行594）→ 全剧审核；判定链只决定勾选范围');
    log('判定：⓪终极关键词→全错 ①关键词双列比对(第3列命中且第4列同词→继续；否则全错) ' +
      '②相似度闸门(短剧名≤' + CONFIG.similarGateNameLen + '字 且无同词/字：匹配分<' + CONFIG.midScoreMin +
      '→全错；≥' + CONFIG.midScoreMin + '→展开判定) ③匹配分>' + CONFIG.parentScoreThreshold + '→勾选处理 ④[' +
      CONFIG.midScoreMin + ',' + CONFIG.parentScoreThreshold + ']→展开(好样本≥' +
      CONFIG.childScoreGood + '分 且 条数≥' + CONFIG.childScoreGoodMinCount + ' 或 有 ' +
      CONFIG.correctCodes.join('/') + '→勾选处理) ⑤<' + CONFIG.midScoreMin + '→全错 ⑥读不到→痕迹兜底');
    log('勾选范围：全错处理=全选全部子样本；勾选处理=' + (CONFIG.tickScope === 'allUnjudged'
      ? '勾选所有未判错行'
      : ('只勾选待判低分行（未打' + CONFIG.wrongCode + ' 且 得分<' + CONFIG.childScoreThreshold + '）')));
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
      console.log('[自检] 勾选处理门槛：子样本得分列 = ' + SELECTORS.childScoreCell +
        '，未打' + CONFIG.wrongCode + ' 且 得分 < ' + CONFIG.childScoreThreshold + ' → 待判低分行');
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
