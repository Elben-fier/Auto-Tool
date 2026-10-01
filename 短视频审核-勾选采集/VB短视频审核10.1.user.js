// ==UserScript==
// @name         VB短视频审核10.1
// @namespace    https://doubao.com/userscripts
// @version      10.1.1
// @description  qualityTest 一页一轮自动审核：合并接口一次拿「相似度+人物/手机/屏幕」（相似度不过自动跳过检测，图只下一次）→ 勾错误行批量错误 → 表头全选勾正确行批量正确 → 等下一页；判定结果可上报后端日志（id 取第2列）
// @author       Doubao
// @match        https://tools.vobile.cn/quality/qualityTest*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      *
// @run-at       document-end
// ==/UserScript==

// ============================== 10.1.1 修订（10.1 的修正版） ==============================
//  【1】上报的 id 加强：第2列 id（dataId）+ 第15列 key_id + antd 行 key 三个都记，
//       仅当第2列为空时额外记整行文本（诊断用）；开跑时打印"列自检"（前3行的第2/7/8/15列）。
//  【2】送检顺序彻底改成"先相似度 → 再对剩余行做 YOLO"：
//       有 /review_batch 时用合并接口（一次请求、图只下一次）；
//       没有该接口（旧后端）时，也改成【先 /compare 全部 → 相似度不达标的直接判错、不送检测
//       → 只对剩下的行 /detect_batch_detail】，不再沿用旧的"先整批 YOLO"。
//  【3】离开一会就"自动暂停"的四种保险：
//       ① 列表空了不再直接结束 → 点「查 询」刷新确认（默认连续 2 次仍空才算清完）；
//       ② 本轮异常（含严格等待超时）不再立刻停止 → 默认重试 2 次；
//       ③ 最大页数上限 50 → 999（不再跑一会就到顶停止）；
//       ④ 标签页在后台时提示（浏览器会节流定时器导致变慢）。
//  【4】勾正确行的"表头全选"校验改严：必须与正确行数完全相等，否则退回逐行勾选（防止表格
//       补入下一页数据时把新页的行也一起批量正确）。
// ==============================================================================

// ============================== 10.1.0 更新记录 ==============================
//  【一】勾选正确行改为「表头全选」：批量错误之后错误行已从表格消失，剩下的本来就全是正确行，
//        直接点表头那个 Select all 即可，不再逐行点。
//        安全校验：先确认错误行 key 已全部消失；若仍有残留 / 全选后行数不对 → 自动退回逐行勾选。
//  【二】检测与相似度合并成一次请求（后端新接口 /review_batch）：
//        旧流程：先整批 /detect_batch_detail（YOLO）→ 再整批 /compare（相似度），
//                第5列图被下载/传输/解码两遍，两次 HTTP 往返。
//        新流程：一次 /review_batch —— 后端先算相似度，**相似度不过阈值就直接返回（跳过 YOLO）**，
//                相似度达标才做检测；第5列图只下一次。判定规则与结果与旧流程完全一致，只是更快。
//        兼容：若后端是旧版（没有该接口）→ 自动退回原来的两步调用。
//  【三】判定数据上报后端日志（复用 /judge_log，kind='video'）：
//        每行记录：数据id(第2列) / 名称 / 得分 / 判定 / 原因 / 相似度 / 有人·手机·屏幕 / 页码 / 时间。
//        查看：http://127.0.0.1:5002/judge_log/view ；后端没开只提示一次并冷却 60s，不影响审核。
// ==============================================================================

// ============================== 处理逻辑（一页一轮） ==============================
//  1) 预热图片（滚动表格触发懒加载）→ 等表格稳定 → 取当前页所有行（约100条）
//     同时取出 第5列图(主图) 与 第6列图(对比图)
//  2) 判定（任一命中即为【错误】）：
//       ① 得分 ≤ scoreWrongMax（默认74）            → 低分，直接错误（不送检测，省时间）
//       ② 图片检测失败（下载失败/解码失败）          → 错误（可配置改为跳过）
//       ③ 第5列 vs 第6列 相似度 < simThreshold(默认0.40) → 错误
//       ④ 检出手机 / 检出屏幕（置信度 ≥ objectConf，默认0.55） → 错误
//       ⑤ 无人（人物置信度 < personConf，默认0.35 且人脸未命中） → 错误
//     以上都不命中 → 【正确】
//  3) 运行模式（面板切换）：
//       「只扫当前页」 = 只检测报告，不勾选、不提交
//       「测试模式」勾选 = 自动勾选错误行，但不点「批量错误/批量正确」（核对用）
//       正式模式（不勾测试模式，默认） = 勾错误 → 批量错误 → 等错误行消失
//                                     → 勾正确 → 批量正确 → 等下一页数据刷新 → 下一轮
//  4) 随时可停；同一页异常自动停止并提示，避免误操作。
//  5) 排错：面板日志有【错误原因分布】+ 逐行判错原因；「复制明细(TSV)」「复制判错原因」
//     可把明细/原因复制到剪贴板（可直接粘进 Excel 分析或反馈）。
// ==================================================================================

(function () {
  'use strict';

  console.log('[VB短视频审核10.1] 已加载');

  // =======================================================================
  // 可配置项
  // =======================================================================
  const CONFIG = {
    backendUrl: 'http://127.0.0.1:5002',
    batchSize: 6,                 // 每批送检图片数（后端限速 4.5 张/秒）
    testMode: false,              // 测试模式：自动勾选错误行，但不点「批量错误/批量正确」（正式跑时保持 false）
    confirmOnStart: true,         // 正式模式点「开始处理」时弹一次确认框（防误点，可关）
    alertOnFinish: true,          // 全部处理完成时弹窗提示
    autoStart: false,             // 打开页面是否自动开始（默认手动点「开始处理」）
    warmUpImages: true,           // 扫描前滚动表格，触发图片懒加载（避免"缺图"导致误判）
    // —— 严格等待加载完成（antd 转圈消失才算完；转圈期间绝不点任何按钮）——
    strictLoading: true,          // true=严格等待（推荐）；false=只按超时/数据变化判断
    loadingWaitMax: 90000,        // 单次等待"加载完成"的最长时间(ms)；严格模式下超时则本轮不点击，安全停止
    loadingCalmMs: 800,           // 连续多少毫秒没有转圈才算"加载完成"（防止恰好在两次渲染间隙误判）
    scoreWrongMax: 74,            // 得分 ≤ 该值 → 直接判错（75 及以上才继续做图片检测）
    onDownloadFail: 'wrong',      // 图片下载/检测失败时：wrong=算错误 / skip=跳过不判
    useDetailApi: true,           // 用明细接口(含手机/屏幕判定)；失败时自动退回旧接口(仅有人/无人)
    checkObjects: true,           // 是否启用"手机/屏幕 → 判错"规则（如遇误报可关掉）
    objectConf: 0.55,             // ★手机/屏幕置信度阈值（调高=更不容易误判"疑似手机屏幕"）
    personConf: 0.35,             // 人物置信度阈值（调低=更容易认出小人物/远景人物）
    checkSimilarity: true,        // 是否启用"第5列 vs 第6列 相似度 → 判错"规则
    simThreshold: 0.40,           // ★相似度阈值（低于该值判错；实测同图变体≥0.83、异图≤0.33）
    onCompareUnavailable: 'skip', // 两张图缺一张/比对失败时：skip=不判该规则 / wrong=判错
    // 说明：提交后的等待已改为"严格等待加载完成 + 数据变化判断"，不再用固定延时
    refreshWaitMax: 30000,        // 等"错误行消失+加载完成"最长等待
    nextPageWaitMax: 30000,       // 等"下一页数据"最长等待
    stableMs: 1200,               // 表格稳定判定时间
    checkInterval: 400,           // 轮询间隔
    maxRounds: 999,               // 最多处理多少页（10.1.1：50 → 999，避免跑一会就到上限停止）
    // —— 10.1.1 防"自动暂停" ——
    emptyConfirmTimes: 2,         // 列表空了 → 点「查询」确认几次（连续这么多次仍空才算清完）
    maxProblemRetries: 2,         // 本轮异常（含等待超时）允许重试几次，超过才停止
    problemRetryDelayMs: 5000,    // 重试前的等待
    queryBtnText: '查询',         // 刷新列表用的按钮文本（antd 渲染成"查 询"，脚本按去空格比较）
    // —— 合并送检（10.1：相似度 + 检测一次搞定）——
    useReviewApi: true,           // true=用合并接口 /review_batch（后端不支持会自动退回两步调用）
    reviewApiPath: '/review_batch',
    // —— 判定日志上报（10.1：POST /judge_log）——
    reportEnabled: true,          // 是否上报判定日志（面板可开关）
    reportTimeoutMs: 15000,       // 单次上报超时(ms)
    reportRetryCooldownMs: 60000, // 上报失败后的冷却(ms)，避免后端没开时刷屏
  };

  // =======================================================================
  // 选择器（qualityTest 页）
  // =======================================================================
  const SEL = {
    row: 'tr.ant-table-row.ant-table-row-level-0',
    tbody: '.ant-table-tbody',
    checkbox: '.ant-checkbox-wrapper',
    checkboxInput: 'input.ant-checkbox-input',
    selectAll: '.ant-table-thead input.ant-checkbox-input',
    image: '.ant-image-img',
    imageCol5: 'td:nth-child(5)',   // 第5列图片（主图）
    imageCol6: 'td:nth-child(6)',   // 第6列图片（对比图）
    nameCell: 'td:nth-child(7) .commonText-gqPoHv',
    scoreCell: 'td:nth-child(8) .commonText-gqPoHv',
    keyIdCell: 'td:nth-child(15) .commonText-gqPoHv',
    dataIdCell: 'td:nth-child(2)',   // 10.1：审核数据 id（第2列，上报判定日志用）
    batchBtn: 'button.ant-btn',
  };

  // =======================================================================
  // 运行状态
  // =======================================================================
  const state = {
    running: false,
    mode: (CONFIG.testMode ? 'check' : 'full'),  // scan=只检测 / check=勾选但不提交 / full=正式提交
    rounds: 0,
    wrongCount: 0,
    correctCount: 0,
    lastWrongKeys: [],
    lastCorrectKeys: [],
    lastDetails: [],     // 最近一页的逐行明细（供「复制明细」使用）
    problemRetries: 0,   // 10.1.1：连续异常次数（用于"异常重试"）
  };

  // =======================================================================
  // 工具函数
  // =======================================================================
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const qsa = (root, sel) => (root || document).querySelectorAll(sel);

  function text(el) {
    return el ? (el.textContent || '').replace(/\s+/g, '').trim() : '';
  }

  function log(msg, toConsoleOnly) {
    console.log('[短视频10.1] ' + msg);
    if (toConsoleOnly) return;
    const el = document.querySelector('#v1-log');
    if (!el) return;
    const line = document.createElement('div');
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    el.prepend(line);
    while (el.children.length > 300) el.lastChild.remove();
  }

  function setStatus(msg) {
    console.log('[状态] ' + msg);
    const el = document.querySelector('#v1-status');
    if (el) el.textContent = msg;
    const m = document.querySelector('#v1-mini');
    if (m) m.textContent = msg;
  }

  // 把最近一页的明细导出成文本（TSV，可直接粘进 Excel / 发给我分析）
  function buildDetailText() {
    if (!state.lastDetails || state.lastDetails.length === 0) return '（暂无明细，请先点「只扫当前页」）';
    const cols = ['序号', 'key_id', '名称', '得分', '判定', '原因', '有人', '相似度', 'SSIM', '手机', '屏幕', '人物置信度', '手机置信度', '屏幕置信度'];
    const head = '# 短视频勾选明细  阈值：低分≤' + CONFIG.scoreWrongMax +
      ' 相似度<' + CONFIG.simThreshold +
      ' 手机/屏幕判错=' + (CONFIG.checkObjects ? '开' : '关') +
      ' 模式=' + state.mode +
      ' 导出时间=' + new Date().toLocaleString();
    const lines = [head, cols.join('\t')];
    state.lastDetails.forEach((r) => {
      lines.push(cols.map((c) => (r[c] === null || r[c] === undefined ? '' : r[c])).join('\t'));
    });
    return lines.join('\n');
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const st = window.getComputedStyle(el);
    return !(st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0');
  }

  function safeClick(el) {
    if (!el || !el.isConnected) return false;
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.click();
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return true;
    } catch (e) {
      console.warn('[短视频勾选] 点击失败:', e.message || e);
      return false;
    }
  }

  function findByText(root, selector, needle) {
    for (const el of qsa(root, selector)) {
      if (text(el).includes(needle)) return el;
    }
    return null;
  }

  // =======================================================================
  // 后端请求
  // =======================================================================
  function apiPost(path, body, timeout) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: CONFIG.backendUrl + path,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body),
        timeout: timeout || 60000,
        onload(r) {
          if (r.status === 429) {
            setTimeout(() => apiPost(path, body, timeout).then(resolve).catch(reject), 800);
            return;
          }
          try { resolve(JSON.parse(r.responseText)); }
          catch (e) { reject(e); }
        },
        onerror: () => reject(new Error('请求失败（后端未启动？）')),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  function downloadImageAsBase64(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'arraybuffer',
        timeout: 15000,
        onload(r) {
          if (r.status !== 200) { reject(new Error('HTTP ' + r.status)); return; }
          try {
            const bytes = new Uint8Array(r.response);
            let binary = '';
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
            }
            resolve(btoa(binary));
          } catch (e) { reject(e); }
        },
        onerror: () => reject(new Error('下载失败')),
        ontimeout: () => reject(new Error('下载超时')),
      });
    });
  }

  // 批量检测（明细版）：返回与 items 对齐，元素为
  //   {person, face, phone, screen, ok, conf} 或 null（下载/检测失败）
  async function detectBatch(items) {
    const results = new Array(items.length).fill(null);

    const downloads = await Promise.all(items.map((it) =>
      it.url ? downloadImageAsBase64(it.url).then((b64) => b64).catch(() => null) : Promise.resolve(null)
    ));

    const okIdx = [], okB64 = [];
    downloads.forEach((b64, i) => { if (b64) { okIdx.push(i); okB64.push(b64); } });

    if (okB64.length > 0) {
      // 优先明细接口
      if (CONFIG.useDetailApi) {
        try {
          const res = await apiPost('/detect_batch_detail', {
            images: okB64,
            person_conf: CONFIG.personConf,
            object_conf: CONFIG.objectConf,
          });
          const arr = Array.isArray(res.results) ? res.results : [];
          okIdx.forEach((idx, j) => {
            const d = arr[j];
            if (d && typeof d === 'object') results[idx] = d;
          });
          return results;
        } catch (e) {
          log('明细接口不可用（' + (e.message || e) + '），退回旧接口');
          CONFIG.useDetailApi = false;
        }
      }
      // 退回旧接口：仅返回 true=有人 / false=无人
      try {
        const res = await apiPost('/detect_batch', { images: okB64 });
        const arr = Array.isArray(res.results) ? res.results : [];
        okIdx.forEach((idx, j) => {
          results[idx] = { person: arr[j] === true, face: false, phone: false, screen: false, ok: arr[j] === true, conf: {} };
        });
      } catch (e) {
        log('批量检测失败: ' + (e.message || e));
      }
    }
    return results;
  }

  // 相似度比对（第5列 vs 第6列）：返回与 pairs 对齐，元素为 {sim,ssim,...} 或 null
  async function compareBatch(pairs) {
    const results = new Array(pairs.length).fill(null);

    // 先把两张图都下载成 base64（缺一张则记 null）
    const encoded = await Promise.all(pairs.map(async (p) => {
      const a = p.a ? await downloadImageAsBase64(p.a).catch(() => null) : null;
      const b = p.b ? await downloadImageAsBase64(p.b).catch(() => null) : null;
      return { a: a, b: b };
    }));

    const okIdx = [], okPairs = [];
    encoded.forEach((e, i) => { if (e.a && e.b) { okIdx.push(i); okPairs.push({ a: e.a, b: e.b }); } });

    if (okPairs.length > 0) {
      try {
        const res = await apiPost('/compare', { pairs: okPairs });
        const arr = Array.isArray(res.results) ? res.results : [];
        okIdx.forEach((idx, j) => { results[idx] = arr[j] || null; });
      } catch (e) {
        log('相似度接口调用失败: ' + (e.message || e));
      }
    }
    return results;
  }

  // =======================================================================
  // 页面数据
  // =======================================================================
  function getRows() {
    return Array.from(qsa(document, SEL.row));
  }

  function getFirstRowKey() {
    const r = getRows()[0];
    return r ? r.getAttribute('data-row-key') : null;
  }

  function collectRowInfo(row) {
    const cellImg = (sel) => {
      const cell = row.querySelector(sel);
      if (!cell) return '';
      const img = cell.querySelector(SEL.image) || cell.querySelector('img');
      return img ? (img.currentSrc || img.src || '') : '';
    };
    const img = row.querySelector(SEL.image);
    const keyIdEl = row.querySelector(SEL.keyIdCell);
    const nameEl = row.querySelector(SEL.nameCell);
    const scoreEl = row.querySelector(SEL.scoreCell);
    const score = scoreEl ? parseFloat((scoreEl.textContent || '').trim()) : NaN;
    const url5 = cellImg(SEL.imageCol5);
    const url6 = cellImg(SEL.imageCol6);
    const dataIdEl = row.querySelector(SEL.dataIdCell);
    const keyIdEl2 = row.querySelector(SEL.keyIdCell);
    return {
      row: row,
      key: row.getAttribute('data-row-key') || '',
      dataId: dataIdEl ? (dataIdEl.textContent || '').replace(/\s+/g, '').trim() : '',
      keyId2: keyIdEl2 ? (keyIdEl2.textContent || '').trim() : '',
      keyId: keyIdEl ? (keyIdEl.textContent || '').trim() : '',
      name: nameEl ? (nameEl.textContent || '').trim() : '',
      score: isNaN(score) ? null : score,
      url5: url5,
      url6: url6,
      url: url5 || (img ? (img.currentSrc || img.src || '') : ''),
    };
  }

  function findRowByKey(key) {
    if (!key) return null;
    for (const r of getRows()) {
      if (r.getAttribute('data-row-key') === key) return r;
    }
    return null;
  }

  // 勾选某一行（返回 true=已勾选）
  function checkRow(row) {
    if (!row || !row.isConnected) return false;
    const wrap = row.querySelector(SEL.checkbox);
    const input = row.querySelector(SEL.checkboxInput);
    if (input && input.checked) return true;
    if (wrap) return safeClick(wrap);
    if (input) return safeClick(input);
    return false;
  }

  // 按 key 列表勾选
  async function checkRowsByKeys(keys) {
    let done = 0;
    for (const k of keys) {
      if (!state.running) break;
      const row = findRowByKey(k);
      if (!row) continue;
      if (checkRow(row)) { done++; await delay(25); }
    }
    return done;
  }

  // ========== 页面「查询」按钮 + 空态确认（10.1.1）==========
  // 定位：页面级 primary 按钮 → 文本去掉空格后等于 queryBtnText；排除自己的面板与弹窗
  function findQueryButton() {
    const pick = (list) => {
      for (const b of list) {
        if (b.closest('#v1-panel')) continue;
        if (b.closest('.ant-popconfirm') || b.closest('.ant-modal-wrap')) continue;
        if (b.disabled) continue;
        const r = b.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const txt = (b.textContent || '').replace(/\s+/g, '');
        if (txt === CONFIG.queryBtnText) return b;
      }
      return null;
    };
    return pick(document.querySelectorAll('button.ant-btn-primary')) ||
           pick(document.querySelectorAll('button'));
  }

  async function clickQuery() {
    const btn = findQueryButton();
    if (!btn) { log('⚠️ 未找到「' + CONFIG.queryBtnText + '」按钮（页面可能改版）'); return false; }
    if (!(await waitLoadingDone('点击「' + CONFIG.queryBtnText + '」前'))) return false;
    log('点击「' + CONFIG.queryBtnText + '」刷新列表...');
    safeClick(btn);
    return true;
  }

  // 是否处于 antd 空态（"暂无数据"）
  function isEmptyState() {
    const e = document.querySelector('.ant-empty');
    if (e && isVisible(e)) return true;
    return getRows().length === 0;
  }

  // 列表空了 → 点「查询」刷新并确认：连续 confirmTimes 次都空 → 返回 true（确实清完）
  // 一旦刷出数据 → 返回 false（还没清完，继续处理）
  async function confirmListEmpty(confirmTimes) {
    const times = confirmTimes || CONFIG.emptyConfirmTimes;
    for (let i = 1; i <= times; i++) {
      setStatus('列表空了 → 点「' + CONFIG.queryBtnText + '」确认（第 ' + i + '/' + times + ' 次）...');
      log('列表为空 → 点「' + CONFIG.queryBtnText + '」刷新确认（第 ' + i + '/' + times + ' 次）');
      await clickQuery();
      if (CONFIG.strictLoading && !(await waitLoadingDone('查询刷新'))) {
        log('⚠️ 查询刷新等待超时（不轻易判定清空，继续下一轮确认）');
        continue;
      }
      await waitForTableSettled(8000, CONFIG.stableMs);
      const n = getRows().length;
      if (n > 0) {
        log('查询后出现数据：' + n + ' 行 → 说明还没清完，继续处理');
        return false;
      }
      log('第 ' + i + ' 次确认：仍然无数据' + (isEmptyState() ? '（页面显示"暂无数据"）' : ''));
    }
    return true;
  }

  // 统计当前页已勾选的行数（用于"表头全选"后核对）
  function countCheckedRows() {
    return getRows().filter((r) => {
      const i = r.querySelector(SEL.checkboxInput);
      return !!(i && i.checked);
    }).length;
  }

  // ========== 合并送检（10.1）==========
  // 一次请求同时拿「第5列vs第6列 相似度」+「第5列图 人物/手机/屏幕检测」
  //   · 第5列图只下载一次（旧流程要下载两遍：检测一遍、比对一遍）
  //   · 后端先算相似度：不过阈值 → 直接返回（跳过 YOLO）
  // 返回与 items 对齐的数组；后端不支持该接口时返回 null（调用方退回旧的两步流程）
  async function reviewBatch(items) {
    const results = new Array(items.length).fill(null);
    const dl = await Promise.all(items.map(async (it) => {
      const u5 = it.url5 || it.url;
      const a = u5 ? await downloadImageAsBase64(u5).catch(() => null) : null;
      const b = (CONFIG.checkSimilarity && it.url6)
        ? await downloadImageAsBase64(it.url6).catch(() => null) : null;
      return { a: a, b: b };
    }));
    const okIdx = [], okItems = [];
    dl.forEach((e, i) => { if (e.a) { okIdx.push(i); okItems.push({ col5: e.a, col6: e.b || null }); } });
    if (okItems.length === 0) return results;

    try {
      const res = await apiPost(CONFIG.reviewApiPath, {
        items: okItems,
        person_conf: CONFIG.personConf,
        object_conf: CONFIG.objectConf,
        sim_threshold: CONFIG.simThreshold,
        skip_detect_when_sim_low: true,
      }, 180000);
      const arr = Array.isArray(res.results) ? res.results : [];
      okIdx.forEach((idx, j) => { results[idx] = arr[j] || null; });
      return results;
    } catch (e) {
      log('合并接口不可用（' + (e.message || e) + '）→ 退回「先检测、再相似度」两步调用');
      return null;
    }
  }

  // 把合并结果拆成判定逻辑需要的 it.det / it.cmp（判定规则完全不变）
  function applyMergedResults(batch, res) {
    res.forEach((v, j) => {
      const it = batch[j].item;
      if (!v || v.decode_failed || v.error) { it.det = null; it.cmp = null; return; }
      // 相似度不过阈值时后端跳过了检测：给个占位 det（判定顺序里"相似度低"会先命中，结果不变）
      it.det = v.detect_skipped
        ? { person: null, face: null, phone: null, screen: null, ok: false, conf: {}, skipped: true }
        : { person: v.person, face: v.face, phone: v.phone, screen: v.screen, ok: v.ok, conf: v.conf || {} };
      it.cmp = (v.sim_ok && typeof v.sim === 'number')
        ? { ok: true, sim: v.sim, ssim: v.ssim, hash8: v.hash8, hash16: v.hash16, hist: v.hist, aspect: v.aspect }
        : null;
    });
  }

  // ========== 判定日志上报（10.1，复用后端 /judge_log）==========
  const reportQueue = [];
  let reporting = false, reportCooldownUntil = 0, reportWarned = false, reportOkLogged = false;

  function enqueueReports(entries) {
    if (!CONFIG.reportEnabled || !entries || entries.length === 0) return;
    for (const e of entries) reportQueue.push(e);
    while (reportQueue.length > 500) reportQueue.shift();   // 后端长期不可用时防内存膨胀
    flushReports();
  }

  function flushReports() {
    if (reporting || reportQueue.length === 0) return;
    if (Date.now() < reportCooldownUntil) return;
    const batch = reportQueue.splice(0, 100);
    reporting = true;
    apiPost('/judge_log', { entries: batch }, CONFIG.reportTimeoutMs)
      .then(() => {
        reporting = false;
        reportCooldownUntil = 0;
        if (!reportOkLogged) {
          reportOkLogged = true;
          log('✅ 判定日志已上报后端（查看：' + CONFIG.backendUrl + '/judge_log/view）');
        }
        if (reportQueue.length) setTimeout(flushReports, 300);
      })
      .catch(() => {
        reporting = false;
        reportCooldownUntil = Date.now() + CONFIG.reportRetryCooldownMs;
        if (!reportWarned) {
          reportWarned = true;
          log('⚠️ 判定日志上报失败（后端未启动？' + CONFIG.backendUrl + '）→ 暂停上报 ' +
            Math.round(CONFIG.reportRetryCooldownMs / 1000) + 's，不影响审核');
        }
      });
  }

  // 上报本页每行的判定（kind='video'，审核数据 id 取第2列）
  function reportVideoPage(items, wrong, unknown, roundNo) {
    if (!CONFIG.reportEnabled || !items || items.length === 0) return;
    const whyByKey = {};
    wrong.forEach((w) => { whyByKey[w.key] = w.why; });
    const unknownKeys = new Set(unknown.map((x) => x.key));
    const entries = items.map((it) => {
      const d = it.det || null;
      const c = it.cmp || null;
      let verdict = '正确', why = '';
      if (whyByKey[it.key]) { verdict = '错误'; why = whyByKey[it.key]; }
      else if (unknownKeys.has(it.key)) { verdict = '跳过'; why = '未参与判定'; }
      const simTxt = (c && c.ok) ? Number(c.sim.toFixed(3)) : null;
      return {
        time: new Date().toLocaleString(),
        ts: Date.now(),
        kind: 'video',
        script: 'VB短视频审核10.1',
        version: '10.1.0',
        dataId: it.dataId || '',                 // ← 第2列的审核数据 id（10.1.1 主字段）
        keyId: it.keyId2 || it.keyId || '',      // ← 第15列 key_id（一并记录，便于核对）
        rowKey: it.key || '',
        rowText: (it.dataId ? '' : ((it.row && it.row.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 120)),
        childId: '',
        parentId: '',
        name: it.name || '',
        originalName: '',
        score: it.score,
        episodes: 0,
        isSlow: false,
        similar: simTxt === null ? null : (simTxt >= CONFIG.simThreshold),
        simDetail: simTxt === null ? '' : ('相似度 ' + simTxt),
        keyword: '', keywordDual: false, ultimate: '', matchMode: '',
        mode: (verdict === '错误' ? 2 : 1),
        result: 'ok',
        outcome: (verdict === '错误' ? '短视频-错误'
          : (verdict === '跳过' ? '短视频-跳过' : '短视频-正确')),
        reason: why || '',
        detailText: '有人=' + (d ? (d.person === true ? '是' : (d.person === null ? '未检测' : '否')) : '未检测') +
          ' 手机=' + (d ? (d.phone ? '是' : '否') : '-') +
          ' 屏幕=' + (d ? (d.screen ? '是' : '否') : '-') +
          ' 相似度=' + (simTxt === null ? '-' : simTxt) +
          (it.lowScore ? ' 低分=是' : '') +
          ' 页码=' + roundNo,
        counts: null,
      };
    });
    enqueueReports(entries);
  }

  // =======================================================================
  // 表格等待
  // =======================================================================
  async function waitForTableSettled(timeout, stableMs) {
    const t = timeout || 20000;
    const stable = stableMs || CONFIG.stableMs;
    const start = Date.now();
    let last = getRows().length;
    let stableSince = Date.now();
    while (Date.now() - start < t) {
      if (!state.running) break;
      await delay(CONFIG.checkInterval);
      const cur = getRows().length;
      if (cur === last) {
        if (Date.now() - stableSince >= stable) return cur;
      } else {
        last = cur;
        stableSince = Date.now();
      }
    }
    return getRows().length;
  }

  // ========== 严格等待加载完成（antd 转圈） ==========
  // 页面是否处于加载中：任一按钮在提交中(ant-btn-loading) 或 表格区域有转圈(ant-spin-spinning)
  function isLoading() {
    if (document.querySelector('button.ant-btn-loading')) return true;
    const scopes = ['.ant-pro-table', '.ant-table-wrapper', '.ant-table'];
    for (const s of scopes) {
      const el = document.querySelector(s);
      if (el && el.querySelector('.ant-spin-spinning')) return true;
    }
    // 兜底：页面任何位置的转圈（排除我们自己的面板）
    for (const sp of document.querySelectorAll('.ant-spin-spinning')) {
      if (!sp.closest('#v1-panel')) return true;
    }
    return false;
  }

  // 严格等待「加载完成」：必须连续 loadingCalmMs 毫秒都没有转圈才算完成
  // 返回 true=已完成 / false=超时（严格模式下调用方应放弃本轮点击，避免误操作）
  async function waitLoadingDone(what, maxWait) {
    if (!CONFIG.strictLoading) return true;
    const t = maxWait || CONFIG.loadingWaitMax;
    const start = Date.now();
    let calmSince = 0;
    while (Date.now() - start < t) {
      if (!state.running) return false;
      if (isLoading()) {
        calmSince = 0;
        setStatus('⏳ 等待加载完成' + (what ? '（' + what + '）' : '') +
          ' ' + Math.round((Date.now() - start) / 1000) + 's ...');
      } else {
        if (!calmSince) calmSince = Date.now();
        if (Date.now() - calmSince >= CONFIG.loadingCalmMs) return true;
      }
      await delay(CONFIG.checkInterval);
    }
    log('⚠️ 等待加载完成超时（' + Math.round(t / 1000) + 's）：' + (what || '') + ' —— 为安全起见本轮不点击');
    return false;
  }

  // 等指定 key 的行从表格消失（说明批量错误已生效）
  // 严格模式下还要等转圈结束，避免"行还没消失/数据还在刷新"就进行下一步
  async function waitRowsGone(keys, timeout) {
    const keySet = new Set(keys);
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!state.running) return false;
      const remain = getRows().filter((r) => keySet.has(r.getAttribute('data-row-key'))).length;
      const loading = isLoading();
      setStatus('已提交「批量错误」，等待错误行消失：剩 ' + remain + ' / ' + keys.length +
        (loading ? '（系统处理中…）' : ''));
      if (remain === 0 && !loading) return true;
      await delay(CONFIG.checkInterval);
    }
    return false;
  }

  // 等下一页数据（首行 key 变化 或 表格清空）；严格模式下还要求转圈已结束
  async function waitNextPage(beforeFirstKey, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!state.running) return 0;
      const rows = getRows();
      const count = rows.length;
      const firstKey = count > 0 ? rows[0].getAttribute('data-row-key') : null;
      if (count === 0) {
        // 10.1.1：空列表不直接结束 → 点「查询」刷新确认（连续 N 次仍空才算清完）
        if (await confirmListEmpty()) return 0;
        const n2 = getRows().length;
        if (n2 > 0) {
          await waitForTableSettled(15000, CONFIG.stableMs);
          await waitLoadingDone('查询后数据渲染');
          return getRows().length;
        }
        continue;
      }
      if (firstKey && firstKey !== beforeFirstKey && !isLoading()) {
        await waitForTableSettled(15000, CONFIG.stableMs);
        await waitLoadingDone('下一页数据渲染');
        return getRows().length;
      }
      if (isLoading()) setStatus('等待系统处理（下一页数据加载中…）');
      await delay(CONFIG.checkInterval);
    }
    return -1; // 超时且无变化
  }

  // 预热图片：滚动表格到底再回顶，触发图片懒加载，并等图片 URL 就绪
  // （避免"图片还没加载 → 缺图 → 被判错误"这类误判）
  async function warmUpImages(timeout) {
    const t = timeout || 8000;
    const rows = getRows();
    if (rows.length === 0) return;

    try {
      const last = rows[rows.length - 1];
      if (last && last.scrollIntoView) last.scrollIntoView({ block: 'end' });
      await delay(600);
      if (rows[0] && rows[0].scrollIntoView) rows[0].scrollIntoView({ block: 'start' });
      await delay(400);
    } catch (e) {
      console.warn('[短视频勾选] 滚动预热失败:', e.message || e);
    }

    // 等图片 URL 就绪（约 90% 行有图即可，避免个别懒加载慢的行一直等）
    const start = Date.now();
    while (Date.now() - start < t) {
      if (!state.running) return;
      const cur = getRows();
      const ready = cur.filter((r) => {
        const img = r.querySelector(SEL.image) || r.querySelector('img');
        return img && (img.currentSrc || img.src);
      }).length;
      if (cur.length === 0 || ready >= Math.ceil(cur.length * 0.9)) return;
      setStatus('等待图片加载 ' + ready + ' / ' + cur.length + ' ...');
      await delay(400);
    }
    log('⚠️ 图片加载等待超时，仍继续（个别行可能"缺图"）');
  }

  // =======================================================================
  // 按钮点击（批量错误 / 批量正确）
  // =======================================================================
  async function waitForConfirmBtn(timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const pops = document.querySelectorAll('.ant-popconfirm');
      for (const pc of pops) {
        if (!pc.isConnected) continue;
        const st = window.getComputedStyle(pc);
        if (st.display === 'none' || st.opacity === '0') continue;
        for (const btn of pc.querySelectorAll('button')) {
          const t = text(btn);
          if ((t.includes('确定') || t.includes('确认')) && !t.includes('取消')) return btn;
        }
      }
      const modals = document.querySelectorAll('.ant-modal-wrap, .ant-modal');
      for (const m of modals) {
        if (!m.isConnected) continue;
        if (window.getComputedStyle(m).display === 'none') continue;
        for (const btn of m.querySelectorAll('button.ant-btn-primary')) {
          const t = text(btn);
          if ((t.includes('确定') || t.includes('确认')) && !t.includes('取消')) return btn;
        }
      }
      await delay(200);
    }
    return null;
  }

  // 找到可见且未禁用的批量按钮（优先工具栏范围）
  function findBatchButton(btnText) {
    const roots = [
      document.querySelector('.ant-pro-table-list-toolbar'),
      document.querySelector('.ant-table-toolbar'),
      document.querySelector('.ant-table-container'),
      document,
    ].filter(Boolean);
    for (const root of roots) {
      for (const b of qsa(root, SEL.batchBtn)) {
        if (!text(b).includes(btnText)) continue;
        if (!isVisible(b)) continue;
        if (b.disabled) continue;
        return b;
      }
    }
    return null;
  }

  async function clickBatch(btnText, attempts) {
    attempts = attempts || 3;
    for (let i = 1; i <= attempts; i++) {
      if (!state.running) return false;

      // 严格模式：点击前必须已加载完毕（无转圈），否则不点
      if (CONFIG.strictLoading && !(await waitLoadingDone('点击「' + btnText + '」前'))) return false;

      const btn = findBatchButton(btnText);
      if (!btn) {
        log('未找到可用的「' + btnText + '」按钮（第 ' + i + ' 次）');
        await delay(1500);
        continue;
      }
      log('点击「' + btnText + '」...');
      safeClick(btn);
      await delay(800);

      const confirmBtn = await waitForConfirmBtn(8000);
      if (confirmBtn) {
        // 严格模式：弹窗确定按钮同样要等它不再转圈（有些确认按钮点下去自己会转圈）
        if (CONFIG.strictLoading) await waitLoadingDone('确认弹窗就绪', 15000);
        confirmBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        safeClick(confirmBtn);
        confirmBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return true;
      }
      log('「' + btnText + '」确认弹窗未出现，重试...');
      await delay(2000);
    }
    return false;
  }

  // =======================================================================
  // 单页处理
  // =======================================================================
  async function processOnePage() {
    setStatus('等待表格稳定...');
    await waitForTableSettled(20000);

    // 严格等待：页面/表格加载完毕（转圈消失）再开始
    if (!(await waitLoadingDone('开始检测前'))) return 'problem';

    // 预热图片（触发懒加载），避免缺图误判
    if (CONFIG.warmUpImages) {
      setStatus('预热图片（触发懒加载）...');
      await warmUpImages(8000);
      await waitForTableSettled(10000);
      if (!(await waitLoadingDone('图片加载完成'))) return 'problem';
    }

    let rows = getRows();
    if (rows.length === 0) {
      // 10.1.1：空页可能只是"还没刷新出来" → 点「查询」确认；连续确认仍空才算清完
      log('当前页无数据 → 点「' + CONFIG.queryBtnText + '」刷新确认...');
      if (await confirmListEmpty()) {
        log('连续 ' + CONFIG.emptyConfirmTimes + ' 次确认仍无数据 → 处理结束');
        return 'empty';
      }
      rows = getRows();
      if (rows.length === 0) { log('刷新后仍无数据，处理结束'); return 'empty'; }
      log('刷新后出现 ' + rows.length + ' 行 → 继续处理');
    }
    const firstKeyBefore = getFirstRowKey();
    log('===== 第 ' + (state.rounds + 1) + ' 页：共 ' + rows.length + ' 行，开始检测 =====');

    // 1) 采集行信息
    const items = rows.map(collectRowInfo);
    // 10.1.1：列自检（前 3 行）—— 确认"第2列 id / 第15列 key_id"取对没有
    log('列自检（前3行）：' + items.slice(0, 3).map((it, i) =>
      '#' + (i + 1) + ' 第2列=[' + (it.dataId || '空') + '] 第7列=[' + (it.name || '').slice(0, 8) +
      '] 第8列=[' + (it.score === null ? '空' : it.score) + '] 第15列=[' + (it.keyId2 || '').slice(0, 14) + ']'
    ).join(' ｜ '));

    // 2) 低分行先直接判错（不送检测，省时间）；其余行才送检测
    const toDetect = [];
    items.forEach((it, idx) => {
      it.lowScore = (it.score !== null && it.score <= CONFIG.scoreWrongMax);
      if (!it.lowScore) toDetect.push({ idx: idx, item: it });
    });
    log('得分 ≤ ' + CONFIG.scoreWrongMax + ' 直接判错 ' + (items.length - toDetect.length) + ' 条；' +
      '送检测 ' + toDetect.length + ' 条');

    // 2) 送检（10.1.1：一律「先相似度 → 再对剩余行做 YOLO」）
    //    ① 有合并接口 /review_batch → 一次请求（后端先算相似度，不过阈值就直接返回、不跑 YOLO）
    //    ② 后端是旧版（没有该接口）→ 先整批 /compare，相似度不达标的直接判错、不送检测；
    //       只对"相似度达标 / 缺图"的行调 /detect_batch_detail
    let mergedOk = CONFIG.useReviewApi && CONFIG.checkSimilarity && toDetect.length > 0;
    if (mergedOk) {
      setStatus('合并送检中（' + toDetect.length + ' 条，每批 ' + CONFIG.batchSize + ' 条）...');
      for (let i = 0; i < toDetect.length; i += CONFIG.batchSize) {
        if (!state.running) return 'stopped';
        const batch = toDetect.slice(i, i + CONFIG.batchSize);
        const res = await reviewBatch(batch.map((x) => x.item));
        if (res === null) { mergedOk = false; CONFIG.useReviewApi = false; break; }
        applyMergedResults(batch, res);
        setStatus('合并送检进度 ' + Math.min(i + batch.length, toDetect.length) + ' / ' + toDetect.length);
      }
    }
    if (toDetect.length > 0 && !mergedOk) {
      // —— ① 先整批算相似度 ——
      if (CONFIG.checkSimilarity) {
        setStatus('相似度比对中（' + toDetect.length + ' 对）...');
        for (let i = 0; i < toDetect.length; i += CONFIG.batchSize) {
          if (!state.running) return 'stopped';
          const batch = toDetect.slice(i, i + CONFIG.batchSize);
          const pairs = batch.map((x) => ({ a: x.item.url5, b: x.item.url6 }));
          const res = await compareBatch(pairs);
          res.forEach((v, j) => { batch[j].item.cmp = v; });
          setStatus('相似度进度 ' + Math.min(i + batch.length, toDetect.length) + ' / ' + toDetect.length);
        }
      }
      // —— ② 只对"相似度达标 / 缺图"的行做检测（相似度不达标的直接判错，省掉 YOLO）——
      const needDetect = toDetect.filter((x) => {
        const c = x.item.cmp;
        if (!c || !c.ok) return true;                  // 缺图/比对失败 → 仍需检测
        return c.sim >= CONFIG.simThreshold;           // 相似度达标才需要检测
      });
      const skipped = toDetect.length - needDetect.length;
      if (skipped > 0) {
        log('先相似度：' + skipped + ' 条相似度不达标 → 直接判错（已跳过 YOLO），剩余 ' +
          needDetect.length + ' 条送检测');
        toDetect.forEach((x) => {
          const c = x.item.cmp;
          if (c && c.ok && c.sim < CONFIG.simThreshold) {
            // 占位 det：判定顺序里"相似度低"会先命中，判定结果与原因与旧流程一致
            x.item.det = { person: null, face: null, phone: null, screen: null, ok: false, conf: {}, skipped: true };
          }
        });
      }
      for (let i = 0; i < needDetect.length; i += CONFIG.batchSize) {
        if (!state.running) return 'stopped';
        const batch = needDetect.slice(i, i + CONFIG.batchSize);
        const res = await detectBatch(batch.map((x) => x.item));
        res.forEach((v, j) => { batch[j].item.det = v; });
        setStatus('检测进度 ' + Math.min(i + batch.length, needDetect.length) + ' / ' + needDetect.length);
      }
    }

    // 2.5) 相似度统计（合并/旧流程共用）
    let simMissing = 0;
    if (CONFIG.checkSimilarity) {
      simMissing = toDetect.filter((x) => !x.item.cmp || !x.item.cmp.ok).length;
      const sims = toDetect.map((x) => (x.item.cmp && x.item.cmp.ok ? x.item.cmp.sim : null)).filter((v) => v !== null);
      if (sims.length > 0) {
        const avg = sims.reduce((a, b) => a + b, 0) / sims.length;
        log('相似度统计：最低 ' + Math.min.apply(null, sims).toFixed(3) +
          ' / 平均 ' + avg.toFixed(3) +
          ' / 最高 ' + Math.max.apply(null, sims).toFixed(3) +
          '（阈值 ' + CONFIG.simThreshold + '）');
      }
      if (simMissing > 0) log('⚠️ ' + simMissing + ' 条无法比对（第5/6列缺图或下载失败）→ 按配置「' + CONFIG.onCompareUnavailable + '」处理');
    }

    // 3) 判定：错误 / 正确 / 未知
    const wrong = [], correct = [], unknown = [];
    items.forEach((it) => {
      // 3.1 低分 → 错误
      if (it.lowScore) {
        wrong.push(Object.assign({}, it, { why: '低分≤' + CONFIG.scoreWrongMax }));
        return;
      }
      // 3.2 图片检测失败 → 按配置处理
      const d = it.det;
      if (!d) {
        if (CONFIG.onDownloadFail === 'wrong') {
          wrong.push(Object.assign({}, it, { why: '检测失败(按错误)' }));
        } else if (CONFIG.onDownloadFail === 'correct') {
          correct.push(Object.assign({}, it, { why: '检测失败(按正确)' }));
        } else {
          unknown.push(Object.assign({}, it, { why: '检测失败(跳过)' }));
        }
        return;
      }
      // 3.3 第5列 vs 第6列 相似度过低 → 错误
      if (CONFIG.checkSimilarity) {
        const c = it.cmp;
        if (c && c.ok) {
          if (c.sim < CONFIG.simThreshold) {
            wrong.push(Object.assign({}, it, { why: '相似度低(' + c.sim.toFixed(3) + ')' }));
            return;
          }
        } else if (CONFIG.onCompareUnavailable === 'wrong') {
          wrong.push(Object.assign({}, it, { why: '相似度不可用(按错误)' }));
          return;
        }
      }
      // 3.4 手机 / 屏幕 → 错误（可用面板开关关闭该规则）
      if (CONFIG.checkObjects && d.phone) { wrong.push(Object.assign({}, it, { why: '检出手机' })); return; }
      if (CONFIG.checkObjects && d.screen) { wrong.push(Object.assign({}, it, { why: '检出屏幕' })); return; }
      // 3.5 无人 → 错误
      if (!d.person) { wrong.push(Object.assign({}, it, { why: '无人' })); return; }
      // 3.6 有人且无手机屏幕、相似度达标 → 正确
      correct.push(Object.assign({}, it, { why: d.face ? '有人(人脸)' : '有人' }));
    });

    state.wrongCount = wrong.length;
    state.correctCount = correct.length;
    state.lastWrongKeys = wrong.map((x) => x.key);
    state.lastCorrectKeys = correct.map((x) => x.key);
    updatePanel();

    log('检测完成 → 错误 ' + wrong.length + ' 条 / 正确 ' + correct.length + ' 条' +
      (unknown.length ? ' / 未知(跳过) ' + unknown.length + ' 条' : ''));
    // 错误原因分布
    const whyCount = {};
    wrong.forEach((w) => { whyCount[w.why] = (whyCount[w.why] || 0) + 1; });
    log('【错误原因分布】' + (Object.keys(whyCount).map((k) => k + '×' + whyCount[k]).join(' / ') || '无'));

    // 逐行打印判错原因（面板里直接看得到；最多 30 行）
    if (wrong.length > 0) {
      log('—— 逐行判错原因（最多列 30 条，完整明细点「复制明细」）——');
      wrong.slice(0, 30).forEach((w) => {
        const d = w.det || {};
        const c = w.cmp || {};
        const simTxt = c && c.ok ? c.sim.toFixed(3) : '缺图/失败';
        const personTxt = d.person === true ? '有人' : (d.person === false ? '无人' : '未检测');
        log('判错 ' + w.keyId + ' ｜原因=' + w.why +
          ' ｜得分=' + (w.score === null ? '-' : w.score) +
          ' ｜' + personTxt +
          ' ｜手机=' + (d.phone ? '是' : '否') + ' 屏幕=' + (d.screen ? '是' : '否') +
          ' ｜相似度=' + simTxt);
      });
      if (wrong.length > 30) log('（其余 ' + (wrong.length - 30) + ' 条见「复制明细」或 F12 console.table）');
    }
    if (unknown.length > 0) log('未知(未参与判定，保持原状) key_id: ' + unknown.map((x) => x.keyId).filter(Boolean).join(', '));

    // 生成明细（同时用于 console.table 和「复制明细」）
    const wrongKeySet = new Set(state.lastWrongKeys);
    const unknownKeySet = new Set(unknown.map((x) => x.key));
    state.lastDetails = items.map((it, idx) => {
      const d = it.det || null;
      const c = it.cmp || null;
      let verdict = '正确';
      let why = '';
      if (wrongKeySet.has(it.key)) {
        const w = wrong.find((x) => x.key === it.key);
        why = w ? w.why : '';
        verdict = '错误';
      } else if (unknownKeySet.has(it.key)) {
        verdict = '跳过';
      } else if (it.lowScore) {
        verdict = '错误';
      }
      return {
        序号: idx + 1,
        key_id: it.keyId,
        名称: it.name,
        得分: it.score,
        判定: verdict,
        原因: why,
        有人: d ? (d.person ? '是' : '否') : (it.lowScore ? '(低分未检测)' : '?'),
        相似度: c && c.ok ? Number(c.sim.toFixed(3)) : null,
        SSIM: c && c.ok ? Number(c.ssim.toFixed(3)) : null,
        手机: d ? (d.phone ? '是' : '') : '',
        屏幕: d ? (d.screen ? '是' : '') : '',
        人物置信度: d && d.conf ? d.conf.person : null,
        手机置信度: d && d.conf ? d.conf.phone : null,
        屏幕置信度: d && d.conf ? d.conf.screen : null,
      };
    });
    console.table(state.lastDetails);

    // 3.7) 上报本页判定到后端日志（kind='video'，审核数据 id 取第2列）
    reportVideoPage(items, wrong, unknown, state.rounds + 1);

    // 4) 只扫描模式 / 测试模式 到此为止
    if (state.mode === 'scan') {
      log('★只扫描模式：未勾选、未点击任何按钮。');
      setStatus('扫描完成：错误 ' + wrong.length + ' / 正确 ' + correct.length);
      return 'scan';
    }

    // 5) 勾选错误行（测试模式也会真实勾选，但不点批量按钮）
    if (wrong.length > 0) {
      // 严格等待：勾选前也要确保页面加载完毕（否则勾选可能被后续渲染覆盖）
      if (!(await waitLoadingDone('勾选错误行前'))) return 'problem';
      setStatus('勾选错误行 ' + wrong.length + ' 条...');
      const checked = await checkRowsByKeys(state.lastWrongKeys);
      log('错误行已勾选 ' + checked + ' / ' + wrong.length);
      if (checked === 0) {
        log('错误行勾选失败，停止本轮（请检查复选框选择器）');
        return 'problem';
      }
      await delay(500);
    } else {
      log('本页没有错误数据');
    }

    // 5.5) 测试模式：勾完就停，不点任何批量按钮
    if (state.mode === 'check') {
      log('★测试模式：已自动勾选 ' + wrong.length + ' 个错误行，未点击「批量错误/批量正确」。');
      log('   这些行才是会判错的（正确行 ' + correct.length + ' 条未被勾选）');
      log('   正确行 key_id: ' + correct.map((x) => x.keyId).filter(Boolean).join(', '));
      setStatus('测试模式完成：已勾选错误 ' + wrong.length + ' 行（未提交）');
      return 'check';
    }

    // 6) 正式模式：提交批量错误 & 等错误行消失
    if (wrong.length > 0) {
      // 严格等待：点「批量错误」前必须已加载完毕（无转圈）
      if (!(await waitLoadingDone('点击「批量错误」前'))) return 'problem';
      if (!(await clickBatch('批量错误', 3))) {
        log('「批量错误」提交失败，停止本轮');
        return 'problem';
      }
      const gone = await waitRowsGone(state.lastWrongKeys, CONFIG.refreshWaitMax);
      if (!gone) {
        log('⚠️ 等待错误行消失+加载完成超时（' + Math.round(CONFIG.refreshWaitMax / 1000) + 's）');
        // 严格模式：没等到系统处理完，不做下一步，本轮安全停止
        if (CONFIG.strictLoading) return 'problem';
      } else {
        log('✅ 错误行已全部消失且系统处理完成');
      }
      // 再确认一次加载已结束（严格模式）
      if (CONFIG.strictLoading && !(await waitLoadingDone('批量错误处理完成'))) return 'problem';
      if (!state.running) return 'stopped';
    }

    // 7) 勾选正确行 → 批量正确
    if (correct.length > 0) {
      // 严格等待：点「批量正确」前必须已加载完毕（无转圈）
      if (!(await waitLoadingDone('点击「批量正确」前'))) return 'problem';

      setStatus('勾选正确行 ' + correct.length + ' 条...');
      const aliveKeys = state.lastCorrectKeys.filter((k) => !!findRowByKey(k));
      // 10.1：批量错误之后错误行已消失，页面上剩下的本来就全是正确行 → 直接点表头全选即可
      //       安全校验：若仍有错误行残留（或全选行数对不上）→ 退回逐行勾选
      const leftover = state.lastWrongKeys.filter((k) => !!findRowByKey(k));
      let checked = 0;
      if (leftover.length > 0) {
        log('⚠️ 仍有 ' + leftover.length + ' 条错误行未从表格消失 → 退回逐行勾选正确行（避免把错误行也提交正确）');
        checked = await checkRowsByKeys(aliveKeys);
      } else if (aliveKeys.length > 0) {
        const selAll = document.querySelector(SEL.selectAll);
        if (selAll) {
          if (!selAll.checked) { safeClick(selAll); await delay(400); }
          checked = countCheckedRows();
          if (checked === aliveKeys.length) {
            log('表头全选已勾选 ' + checked + ' 行（错误行已全部消失，剩下的都是正确行）');
          } else {
            // 10.1.1：必须完全相等 —— 多勾（例如表格补入了下一页数据）也退回逐行勾选，避免误提交
            log('⚠️ 表头全选勾到 ' + checked + ' 行，与正确行数 ' + aliveKeys.length +
              ' 不一致 → 退回逐行勾选（更安全）');
            const selAllReset = document.querySelector(SEL.selectAll);
            if (selAllReset && selAllReset.checked) { safeClick(selAllReset); await delay(300); }
            checked = await checkRowsByKeys(aliveKeys);
          }
        } else {
          log('未找到表头全选框 → 逐行勾选正确行');
          checked = await checkRowsByKeys(aliveKeys);
        }
      }
      if (checked === 0) {
        // 兜底：按 key 勾不到就全选
        log('按 key 勾选失败，改用表头全选（兜底）');
        const selAll2 = document.querySelector(SEL.selectAll);
        if (selAll2 && !selAll2.checked) safeClick(selAll2);
        await delay(500);
        checked = countCheckedRows();
      }
      log('正确行已勾选 ' + checked + ' / ' + correct.length);
      await delay(500);

      if (!(await clickBatch('批量正确', 3))) {
        log('「批量正确」提交失败，停止本轮');
        return 'problem';
      }
      // 严格等待：等批量正确处理完成（转圈消失）再等下一页
      if (!(await waitLoadingDone('批量正确处理完成'))) return 'problem';
      if (!state.running) return 'stopped';
    } else {
      log('本页没有正确数据，跳过「批量正确」');
    }

    // 7) 等下一页数据刷新
    state.rounds++;
    updatePanel();
    setStatus('等待下一页数据刷新...');
    const nextCount = await waitNextPage(firstKeyBefore, CONFIG.nextPageWaitMax);
    if (nextCount === 0) { log('列表已空，处理结束'); return 'done'; }
    if (nextCount === -1) { log('等待下一页数据超时（无新数据），处理结束'); return 'done'; }
    log('下一页数据已就绪：' + nextCount + ' 行');
    return 'next';
  }

  // =======================================================================
  // 主循环
  // =======================================================================
  async function runLoop() {
    while (state.running) {
      let outcome;
      try {
        outcome = await processOnePage();
      } catch (e) {
        console.error('[短视频勾选] 单页处理异常:', e);
        log('单页处理异常: ' + (e.message || e) + '，3 秒后重试');
        await delay(3000);
        outcome = 'retry';
      }
      if (!state.running) break;
      if (outcome === 'scan') { log('只扫描模式结束（未勾选未提交）'); break; }
      if (outcome === 'check') { log('测试模式结束（已勾选错误行，未提交）'); break; }
      if (outcome === 'empty' || outcome === 'done') break;
      if (outcome === 'problem') {
        // 10.1.1：本轮异常（等待超时/页面抖动等）不再立刻停止 → 重试几次，超过上限才停
        state.problemRetries = (state.problemRetries || 0) + 1;
        if (state.problemRetries <= CONFIG.maxProblemRetries) {
          log('⚠️ 本轮异常（第 ' + state.problemRetries + '/' + CONFIG.maxProblemRetries + ' 次）→ ' +
            Math.round(CONFIG.problemRetryDelayMs / 1000) + 's 后重试本页（不停止）');
          setStatus('异常，' + Math.round(CONFIG.problemRetryDelayMs / 1000) + 's 后重试本页...');
          await delay(CONFIG.problemRetryDelayMs);
          continue;
        }
        log('本轮异常连续 ' + state.problemRetries + ' 次 → 停止运行（请检查页面/后端/网络）');
        break;
      }
      state.problemRetries = 0;   // 正常完成一轮 → 清零
      if (state.rounds >= CONFIG.maxRounds) { log('已达最大页数 ' + CONFIG.maxRounds + '，停止'); break; }
    }
    stopRun();
    log('===== 运行结束：共处理 ' + state.rounds + ' 页，累计错误 ' + state.wrongCount + ' / 正确 ' + state.correctCount + ' =====');
    if (CONFIG.alertOnFinish && state.rounds > 0) {
      setTimeout(() => {
        alert('处理结束\n共处理 ' + state.rounds + ' 页\n累计：错误 ' + state.wrongCount +
          ' 条 / 正确 ' + state.correctCount + ' 条\n（未勾选未提交的行请看面板日志）');
      }, 100);
    }
  }

  // =======================================================================
  // 面板
  // =======================================================================
  function updatePanel() {
    const set = (id, v) => { const e = document.querySelector(id); if (e) e.textContent = v; };
    set('#v1-round', state.rounds);
    set('#v1-wrong', state.wrongCount);
    set('#v1-correct', state.correctCount);
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
      panel.style.left = Math.max(0, Math.min(e.clientX - ox, window.innerWidth - panel.offsetWidth)) + 'px';
      panel.style.top = Math.max(0, Math.min(e.clientY - oy, window.innerHeight - panel.offsetHeight)) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  function buildPanel() {
    if (document.querySelector('#v1-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'v1-panel';
    panel.innerHTML = `
      <div class="v1-title" id="v1-title">VB短视频审核 10.1
        <button id="v1-min" class="v1-min" title="最小化/展开">—</button>
      </div>
      <div class="v1-statusline"><span id="v1-status">空闲</span></div>
      <div class="v1-main" id="v1-main">
        <div class="v1-row">
          <label class="v1-check"><input type="checkbox" id="v1-test" ${CONFIG.testMode ? 'checked' : ''}> <b>测试模式</b>（自动勾选，但不点批量按钮）</label>
        </div>
        <div class="v1-row">
          <label class="v1-check2"><input type="checkbox" id="v1-object" ${CONFIG.checkObjects ? 'checked' : ''}> 手机/屏幕 也判错</label>
        </div>
        <div class="v1-row">
          <label class="v1-check2"><input type="checkbox" id="v1-strict" ${CONFIG.strictLoading ? 'checked' : ''}> <b>严格等待加载完成</b>（转圈消失才点下一步）</label>
        </div>
        <div class="v1-row">
          <label class="v1-check2"><input type="checkbox" id="v1-report" ${CONFIG.reportEnabled ? 'checked' : ''}> <b>上报判定日志</b>（POST /judge_log）</label>
        </div>
        <div class="v1-row">
          <label>低分判错：</label>
          <input type="number" id="v1-score" value="${CONFIG.scoreWrongMax}" min="0" max="100" style="width:56px">
          <span>分及以下直接判错</span>
        </div>
        <div class="v1-row">
          <label>相似度阈值：</label>
          <input type="number" id="v1-sim" value="${CONFIG.simThreshold}" min="0" max="1" step="0.05" style="width:56px">
          <span>第5列vs第6列，低于则判错</span>
        </div>
        <div class="v1-row">
          <label>手机/屏幕阈值：</label>
          <input type="number" id="v1-objconf" value="${CONFIG.objectConf}" min="0" max="1" step="0.05" style="width:56px">
          <span>调高=减少"疑似手机屏幕"误判</span>
        </div>
        <div class="v1-row">
          <label>人物阈值：</label>
          <input type="number" id="v1-personconf" value="${CONFIG.personConf}" min="0" max="1" step="0.05" style="width:56px">
          <span>调低=更容易认出小人物</span>
        </div>
        <div class="v1-row">
          <label>每批张数：</label>
          <input type="number" id="v1-batch" value="${CONFIG.batchSize}" min="1" max="12" style="width:56px">
        </div>
        <div class="v1-stat">页数：<b id="v1-round">0</b> ｜ 上页错误：<b id="v1-wrong">0</b> ｜ 上页正确：<b id="v1-correct">0</b></div>
        <div class="v1-btns">
          <button id="v1-start" class="v1-btn v1-go">开始处理</button>
          <button id="v1-scan" class="v1-btn v1-scan">只扫当前页</button>
          <button id="v1-stop" class="v1-btn v1-stop" disabled>停止</button>
        </div>
        <div class="v1-btns">
          <button id="v1-copy" class="v1-btn v1-copy">复制明细(TSV)</button>
          <button id="v1-copywrong" class="v1-btn v1-copy">复制判错原因</button>
        </div>
        <div class="v1-tip">
          <b>默认=正式模式</b>：勾错误→批量错误→等错误行消失→<b>表头全选勾正确行</b>→批量正确→等下一页自动刷新（点开始会弹确认框）<br>
          <b>合并送检</b>：一次请求同时拿「相似度 + 人物/手机/屏幕」；相似度不过阈值就直接判错、不再跑检测；第5列图只下一次（后端无该接口会自动退回两步调用）<br>
          <b>判定日志</b>：每行上报到 /judge_log（id 取第2列），查看 <b>127.0.0.1:5002/judge_log/view</b>；后端没开不影响审核<br>
          <b>严格等待</b>：每次点击前/提交后都必须等 antd 转圈消失（加载完成）才进行下一步；超时则本轮不点击、安全停止<br>
          想先核对：勾上 <b>测试模式</b>（只自动勾选错误行，不点任何按钮）或点「只扫当前页」<br>
          判定：得分≤${CONFIG.scoreWrongMax} 或 相似度&lt;${CONFIG.simThreshold} 或 检出手机/屏幕(≥${CONFIG.objectConf}) 或 无人(&lt;${CONFIG.personConf}) 或 检测失败 → <b>错误</b>；其余 → 正确<br>
          相似度=第5列图 vs 第6列图；人物阈值只作用于 YOLO，人脸命中仍算有人；需先启动后端 127.0.0.1:5002
        </div>
        <div class="v1-log" id="v1-log"></div>
      </div>
      <div class="v1-mini" id="v1-mini"></div>
    `;
    document.body.appendChild(panel);

    const css = document.createElement('style');
    css.textContent = `
      #v1-panel{position:fixed;top:100px;right:20px;width:320px;background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);z-index:999999;font-size:13px;font-family:system-ui,sans-serif;}
      .v1-title{padding:8px 12px;background:#1677ff;color:#fff;border-radius:8px 8px 0 0;font-weight:600;position:relative;}
      .v1-min{position:absolute;right:8px;top:6px;width:22px;height:22px;line-height:18px;border:none;border-radius:4px;background:rgba(255,255,255,.25);color:#fff;cursor:pointer;font-size:14px;}
      .v1-statusline{padding:6px 12px;background:#fff7e6;border-bottom:1px solid #ffe7ba;color:#d46b08;font-size:12px;min-height:26px;}
      .v1-statusline span{word-break:break-all;}
      .v1-mini{display:none;padding:6px 12px;background:#fff7e6;color:#d46b08;font-size:12px;border-radius:0 0 8px 8px;}
      .v1-main{padding:10px 12px;}
      .v1-row{display:flex;align-items:center;gap:5px;margin-bottom:8px;font-size:12px;color:#666;}
      .v1-row input[type=number]{padding:3px 5px;border:1px solid #d9d9d9;border-radius:4px;outline:none;font-size:12px;}
      .v1-check{display:flex;align-items:center;gap:5px;cursor:pointer;color:#d46b08;}
      .v1-check2{display:flex;align-items:center;gap:5px;cursor:pointer;color:#1677ff;}
      .v1-stat{margin-bottom:8px;color:#333;font-size:12px;}
      .v1-stat b{color:#1677ff;font-size:15px;}
      .v1-btns{display:flex;gap:6px;margin-bottom:8px;}
      .v1-btn{flex:1;padding:6px 0;border:none;border-radius:4px;cursor:pointer;font-size:12px;}
      .v1-btn:disabled{opacity:.45;cursor:not-allowed;}
      .v1-go{background:#1677ff;color:#fff;}
      .v1-scan{background:#f5f5f5;color:#333;border:1px solid #d9d9d9;}
      .v1-stop{background:#ff4d4f;color:#fff;}
      .v1-copy{background:#f6ffed;color:#389e0d;border:1px solid #b7eb8f;}
      .v1-tip{font-size:11px;color:#999;margin-bottom:8px;line-height:1.7;}
      .v1-log{max-height:180px;overflow-y:auto;background:#fafafa;border-radius:4px;padding:6px 8px;font-size:11px;font-family:Consolas,monospace;line-height:1.6;color:#666;word-break:break-all;}
    `;
    document.head.appendChild(css);

    initDrag(panel, panel.querySelector('#v1-title'));

    const main = panel.querySelector('#v1-main');
    const mini = panel.querySelector('#v1-mini');
    document.querySelector('#v1-min').addEventListener('click', () => {
      const hidden = main.style.display === 'none';
      main.style.display = hidden ? '' : 'none';
      mini.style.display = hidden ? 'none' : '';
      document.querySelector('#v1-min').textContent = hidden ? '—' : '□';
    });

    // 统一从面板读取配置（开始/扫描共用）
    function readPanelConfig() {
      CONFIG.testMode = document.querySelector('#v1-test').checked;
      CONFIG.checkObjects = document.querySelector('#v1-object').checked;
      CONFIG.strictLoading = document.querySelector('#v1-strict').checked;
      CONFIG.scoreWrongMax = parseInt(document.querySelector('#v1-score').value);
      if (isNaN(CONFIG.scoreWrongMax)) CONFIG.scoreWrongMax = 74;
      CONFIG.simThreshold = parseFloat(document.querySelector('#v1-sim').value);
      if (isNaN(CONFIG.simThreshold)) CONFIG.simThreshold = 0.40;
      CONFIG.objectConf = parseFloat(document.querySelector('#v1-objconf').value);
      if (isNaN(CONFIG.objectConf)) CONFIG.objectConf = 0.55;
      CONFIG.personConf = parseFloat(document.querySelector('#v1-personconf').value);
      if (isNaN(CONFIG.personConf)) CONFIG.personConf = 0.35;
      CONFIG.batchSize = Math.max(1, Math.min(12, parseInt(document.querySelector('#v1-batch').value) || 6));
      CONFIG.reportEnabled = document.querySelector('#v1-report').checked;
    }

    document.querySelector('#v1-start').addEventListener('click', () => {
      readPanelConfig();
      startRun();
    });

    document.querySelector('#v1-scan').addEventListener('click', async () => {
      if (state.running) return;
      readPanelConfig();
      state.running = true;
      state.mode = 'scan';
      document.querySelector('#v1-start').disabled = true;
      document.querySelector('#v1-scan').disabled = true;
      document.querySelector('#v1-stop').disabled = false;
      log('===== 只扫当前页（不勾选、不提交）=====');
      try {
        await processOnePage();
      } catch (e) {
        log('扫描异常: ' + (e.message || e));
      }
      stopRun();
    });

    document.querySelector('#v1-stop').addEventListener('click', stopRun);

    // 复制明细（TSV，可直接粘 Excel 或发给我）
    document.querySelector('#v1-copy').addEventListener('click', () => {
      const text = buildDetailText();
      try { GM_setClipboard(text); log('✅ 已复制明细到剪贴板（' + state.lastDetails.length + ' 行 TSV，可直接粘进 Excel）'); }
      catch (e) { log('复制失败: ' + (e.message || e)); }
    });

    // 只复制判错行及其原因
    document.querySelector('#v1-copywrong').addEventListener('click', () => {
      const wrongRows = state.lastDetails.filter((r) => r.判定 === '错误');
      if (wrongRows.length === 0) { log('当前没有判错行（或还没扫描）'); return; }
      const byWhy = {};
      wrongRows.forEach((r) => { byWhy[r.原因] = (byWhy[r.原因] || 0) + 1; });
      const head = '# 判错原因汇总  低分≤' + CONFIG.scoreWrongMax + ' 相似度<' + CONFIG.simThreshold +
        ' 手机/屏幕=' + (CONFIG.checkObjects ? '开' : '关');
      const lines = [head,
        '# 分布: ' + Object.keys(byWhy).map((k) => k + '×' + byWhy[k]).join(' / '),
        '# key_id\t原因\t得分\t有人\t相似度\t手机\t屏幕'];
      wrongRows.forEach((r) => {
        lines.push([r.key_id, r.原因, r.得分, r.有人, r.相似度, r.手机, r.屏幕].join('\t'));
      });
      try { GM_setClipboard(lines.join('\n')); log('✅ 已复制 ' + wrongRows.length + ' 条判错原因到剪贴板'); }
      catch (e) { log('复制失败: ' + (e.message || e)); }
    });

    setTimeout(() => {
      log('已就绪。建议先点「只扫当前页」核对检测结果（F12 有明细表格 console.table），再点「开始处理」。');
      log('当前阈值：低分≤' + CONFIG.scoreWrongMax + '；相似度≥' + CONFIG.simThreshold +
        '；手机/屏幕< ' + CONFIG.objectConf + '（≥该值才算手机/屏幕）' +
        '；人物≥' + CONFIG.personConf +
        '；手机/屏幕判错=' + (CONFIG.checkObjects ? '开' : '关') +
        '；测试模式=' + (CONFIG.testMode ? '开（只勾选不提交）' : '关（会真的提交）'));
      log('送检方式：' + (CONFIG.useReviewApi ? '合并接口 /review_batch（快）' : '两步调用（兼容旧后端）') +
        '；勾正确行：表头全选；判定日志上报：' + (CONFIG.reportEnabled ? '开' : '关'));
    }, 500);
  }

  function startRun() {
    if (state.running) return;
    const willSubmit = !CONFIG.testMode;
    if (willSubmit && CONFIG.confirmOnStart) {
      const ok = window.confirm('即将开始【正式处理】：会自动勾选错误行并点击「批量错误 / 批量正确」提交，属于不可逆操作。\n\n确定继续吗？\n（想先只看不提交，请勾选面板上的「测试模式」）');
      if (!ok) { log('已取消（未开始）'); return; }
    }
    state.running = true;
    state.mode = willSubmit ? 'full' : 'check';
    state.rounds = 0;
    state.wrongCount = 0;
    state.correctCount = 0;
    reportCooldownUntil = 0;
    reportWarned = false;
    reportOkLogged = false;
    state.problemRetries = 0;
    document.querySelector('#v1-start').disabled = true;
    document.querySelector('#v1-scan').disabled = true;
    document.querySelector('#v1-stop').disabled = false;
    updatePanel();
    log('===== 开始处理（' + (state.mode === 'check' ? '测试模式：会自动勾选错误行，但不点批量按钮' : '正式模式：会自动勾选并点击提交') + '）=====');
    log('防暂停保险：列表空→点「' + CONFIG.queryBtnText + '」确认 ' + CONFIG.emptyConfirmTimes +
      ' 次｜本轮异常重试 ' + CONFIG.maxProblemRetries + ' 次｜最大页数 ' + CONFIG.maxRounds +
      '｜后台标签页会被浏览器节流(变慢)');
    if (document.hidden) {
      log('⚠️ 当前标签页在后台：浏览器会降低定时器频率，脚本会明显变慢，建议保持本页在前台可见');
    }
    runLoop();
  }

  function stopRun() {
    state.running = false;
    const s = document.querySelector('#v1-start');
    const c = document.querySelector('#v1-scan');
    const t = document.querySelector('#v1-stop');
    if (s) s.disabled = false;
    if (c) c.disabled = false;
    if (t) t.disabled = true;
  }

  // =======================================================================
  // 初始化
  // =======================================================================
  const init = () => {
    try { buildPanel(); } catch (e) { console.error('面板初始化失败:', e); }
    if (CONFIG.autoStart) setTimeout(startRun, 2000);
  };

  if (document.readyState === 'complete') {
    setTimeout(init, 1500);
  } else {
    window.addEventListener('load', () => setTimeout(init, 1500));
  }
})();
