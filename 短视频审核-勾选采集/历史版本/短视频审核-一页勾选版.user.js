// ==UserScript==
// @name         短视频审核-一页勾选版【完整版】
// @namespace    https://doubao.com/userscripts
// @version      1.0.0
// @description  qualityTest 一页一轮自动审核：YOLO判人物/手机/屏幕 + 第5列vs第6列相似度 + 低分规则 → 勾选错误行批量错误、其余批量正确 → 等下一页自动刷新
// @author       Doubao
// @match        https://tools.vobile.cn/quality/qualityTest*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      *
// @run-at       document-end
// ==/UserScript==

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

  console.log('[短视频勾选] 完整版已加载');

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
    maxRounds: 50,                // 最多处理多少页（安全上限）
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
    console.log('[短视频勾选] ' + msg);
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
    return {
      row: row,
      key: row.getAttribute('data-row-key') || '',
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
      if (count === 0) return 0;
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

    const rows = getRows();
    if (rows.length === 0) {
      log('当前页无数据，处理结束');
      return 'empty';
    }
    const firstKeyBefore = getFirstRowKey();
    log('===== 第 ' + (state.rounds + 1) + ' 页：共 ' + rows.length + ' 行，开始检测 =====');

    // 1) 采集行信息
    const items = rows.map(collectRowInfo);

    // 2) 低分行先直接判错（不送检测，省时间）；其余行才送检测
    const toDetect = [];
    items.forEach((it, idx) => {
      it.lowScore = (it.score !== null && it.score <= CONFIG.scoreWrongMax);
      if (!it.lowScore) toDetect.push({ idx: idx, item: it });
    });
    log('得分 ≤ ' + CONFIG.scoreWrongMax + ' 直接判错 ' + (items.length - toDetect.length) + ' 条；' +
      '送检测 ' + toDetect.length + ' 条');

    setStatus('检测中（' + toDetect.length + ' 条，每批 ' + CONFIG.batchSize + ' 张）...');
    for (let i = 0; i < toDetect.length; i += CONFIG.batchSize) {
      if (!state.running) return 'stopped';
      const batch = toDetect.slice(i, i + CONFIG.batchSize);
      const res = await detectBatch(batch.map((x) => x.item));
      res.forEach((v, j) => { batch[j].item.det = v; });
      setStatus('检测进度 ' + Math.min(i + batch.length, toDetect.length) + ' / ' + toDetect.length);
    }

    // 2.5) 相似度比对：第5列图 vs 第6列图（只对送检测的行做）
    let simMissing = 0;
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
      let checked = 0;
      if (aliveKeys.length > 0) {
        checked = await checkRowsByKeys(aliveKeys);
      }
      if (checked === 0) {
        // 兜底：按 key 勾不到就全选（此时错误行已消失，全选=剩下的正确行）
        log('按 key 勾选失败，改用表头全选');
        const selAll = document.querySelector(SEL.selectAll);
        if (selAll && !selAll.checked) safeClick(selAll);
        await delay(500);
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
      if (outcome === 'problem') { log('本轮异常，停止运行'); break; }
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
      <div class="v1-title" id="v1-title">短视频勾选助手（完整版）
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
          <b>默认=正式模式</b>：勾错误→批量错误→等错误行消失→勾正确→批量正确→等下一页自动刷新（点开始会弹确认框）<br>
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
    document.querySelector('#v1-start').disabled = true;
    document.querySelector('#v1-scan').disabled = true;
    document.querySelector('#v1-stop').disabled = false;
    updatePanel();
    log('===== 开始处理（' + (state.mode === 'check' ? '测试模式：会自动勾选错误行，但不点批量按钮' : '正式模式：会自动勾选并点击提交') + '）=====');
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
