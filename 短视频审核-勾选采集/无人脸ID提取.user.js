// ==UserScript==
// @name         短剧审核-无人脸数据ID提取
// @namespace    https://github.com/elben-fier/short-drama-review
// @version      1.1.3
// @description  批量检测图片人脸 + 关键词筛选，提取无人脸或含关键词数据的 key_id 并复制到剪贴板（需配合本地后端 127.0.0.1:5002）
// @author       Auto
// @match        https://tools.vobile.cn/quality/qualityTest*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        backendUrl: "http://127.0.0.1:5002",
        batchSize: 3,            // 每批同时检测的图片数
        nameKeywords: [],        // 关键词列表（第7列文本包含任一关键词则提取）
        scoreThreshold: 80,      // 第8列分数低于该值则提取
        pageWaitMax: 20000,      // 翻页最长等待时间(ms)
        pageStayDelay: 1500,     // 点击下一页后先等待(ms)
        renderSettleDelay: 3000, // 页码切换后额外等待渲染(ms)
    };

    const state = {
        running: false,
        noFaceIds: new Set(),
        currentPage: 1,
        totalRows: 0,   // 当前页总行数
        currentRow: 0,  // 当前页已处理到第几条
    };

    const SEL = {
        row: "tr.ant-table-row.ant-table-row-level-0",
        image: ".ant-image-img",
        nameCell: "td:nth-child(7) .commonText-gqPoHv",   // 第7列：文本（用于关键词筛选）
        scoreCell: "td:nth-child(8) .commonText-gqPoHv",  // 第8列：分数
        keyIdCell: "td:nth-child(15) .commonText-gqPoHv",  // 第15列：key_id
        nextPageBtn: "li.ant-pagination-next > button",
        nextPageDisabled: "li.ant-pagination-next.ant-pagination-disabled",
        activePageItem: "li.ant-pagination-item-active",
    };

    const delay = ms => new Promise(r => setTimeout(r, ms));

    // ========== 日志 ==========
    function log(msg) {
        console.log("[无人脸提取] " + msg);
        const el = document.querySelector("#no-face-log");
        if (!el) return;
        const line = document.createElement("div");
        line.textContent = "[" + new Date().toLocaleTimeString() + "] " + msg;
        el.prepend(line);
        while (el.children.length > 200) el.lastChild.remove();
    }

    // ========== HTTP ==========
    function apiPost(path, body) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "POST",
                url: CONFIG.backendUrl + path,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify(body),
                timeout: 20000,
                onload(r) {
                    if (r.status === 429) {
                        setTimeout(() => apiPost(path, body).then(resolve).catch(reject), 600);
                        return;
                    }
                    try { resolve(JSON.parse(r.responseText)); }
                    catch (e) { reject(e); }
                },
                onerror: () => reject(new Error("请求失败")),
                ontimeout: () => reject(new Error("请求超时")),
            });
        });
    }

    // ========== 图片下载 + 批量人脸检测 ==========
    function downloadImageAsBase64(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                responseType: "arraybuffer",
                timeout: 15000,
                onload(r) {
                    if (r.status !== 200) { reject(new Error("HTTP " + r.status)); return; }
                    try {
                        const bytes = new Uint8Array(r.response);
                        let binary = "";
                        const chunk = 0x8000;
                        for (let i = 0; i < bytes.length; i += chunk) {
                            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
                        }
                        resolve(btoa(binary));
                    } catch (e) { reject(e); }
                },
                onerror: () => reject(new Error("下载失败")),
                ontimeout: () => reject(new Error("下载超时")),
            });
        });
    }

    // 批量检测人脸，返回与 items 对齐的布尔数组（true=有人脸）
    async function detectFacesBatch(items) {
        const results = new Array(items.length).fill(false);

        const downloads = await Promise.all(items.map(it =>
            it.url ? downloadImageAsBase64(it.url).catch(() => null) : Promise.resolve(null)
        ));

        const okIdx = [], okB64 = [];
        downloads.forEach((b64, i) => { if (b64) { okIdx.push(i); okB64.push(b64); } });

        if (okB64.length > 0) {
            try {
                const res = await apiPost("/detect_batch", { images: okB64 });
                const arr = Array.isArray(res.results) ? res.results : [];
                arr.forEach((hasFace, j) => { results[okIdx[j]] = (hasFace === true); });
            } catch (e) {
                console.warn("[无人脸提取] 批量检测请求失败:", e.message || e);
            }
        }
        return results;
    }

    // ========== 关键词筛选 ==========
    function matchKeyword(name) {
        if (!CONFIG.nameKeywords || CONFIG.nameKeywords.length === 0) return false;
        return CONFIG.nameKeywords.some(kw => kw && name.includes(kw));
    }

    // ========== 分页 ==========
    const getActivePage = () => {
        const el = document.querySelector(SEL.activePageItem);
        return el ? parseInt(el.textContent.trim(), 10) : NaN;
    };

    const getFirstRowKeyId = () => {
        const row = document.querySelector(SEL.row);
        if (!row) return null;
        const el = row.querySelector(SEL.keyIdCell);
        return el ? el.textContent.trim() : null;
    };

    async function waitForPage(targetPage, beforeKeyId) {
        const start = Date.now();
        while (Date.now() - start < CONFIG.pageWaitMax) {
            const activePage = getActivePage();
            const firstKeyId = getFirstRowKeyId();
            const keyChanged = beforeKeyId !== null && firstKeyId !== null && firstKeyId !== beforeKeyId;
            const changed = (!isNaN(activePage) && activePage === targetPage) || keyChanged;
            if (changed) {
                // 页码已切换，额外等待渲染完整
                await delay(CONFIG.renderSettleDelay);
                // 再等表格行数出现并稳定，避免数据未加载全
                const settleStart = Date.now();
                let last = document.querySelectorAll(SEL.row).length;
                while (Date.now() - settleStart < 5000) {
                    await delay(400);
                    const cur = document.querySelectorAll(SEL.row).length;
                    if (cur > 0 && cur === last) break;
                    last = cur;
                }
                return true;
            }
            await delay(300);
        }
        throw new Error("第" + targetPage + "页加载超时");
    }

    async function goNextPage() {
        if (document.querySelector(SEL.nextPageDisabled)) return false;
        const nextBtn = document.querySelector(SEL.nextPageBtn);
        if (!nextBtn || nextBtn.disabled) return false;
        const targetPage = state.currentPage + 1;
        const beforeKeyId = getFirstRowKeyId();
        nextBtn.click();
        await delay(CONFIG.pageStayDelay);
        await waitForPage(targetPage, beforeKeyId);
        state.currentPage = targetPage;
        return true;
    }

    // ========== 核心采集 ==========
    async function collectCurrentPage() {
        const rows = document.querySelectorAll(SEL.row);
        if (rows.length === 0) return 0;

        state.totalRows = rows.length;
        state.currentRow = 0;

        const items = [];
        rows.forEach(row => {
            const keyIdEl = row.querySelector(SEL.keyIdCell);
            const nameEl = row.querySelector(SEL.nameCell);
            const scoreEl = row.querySelector(SEL.scoreCell);
            const img = row.querySelector(SEL.image);
            const keyId = keyIdEl ? keyIdEl.textContent.trim() : "";
            const name = nameEl ? nameEl.textContent.trim() : "";
            const score = scoreEl ? parseFloat(scoreEl.textContent.trim()) : NaN;
            const url = img ? (img.currentSrc || img.src || "") : "";
            if (keyId) items.push({ keyId, name, url, score });
        });

        let addCount = 0;
        for (let i = 0; i < items.length; i += CONFIG.batchSize) {
            if (!state.running) break;
            const batch = items.slice(i, i + CONFIG.batchSize);

            const faceResults = await detectFacesBatch(batch);

            batch.forEach((it, j) => {
                const hasFace = faceResults[j] === true;
                const nameMatch = matchKeyword(it.name);
                const scoreLow = !isNaN(it.score) && it.score < CONFIG.scoreThreshold;
                // 提取条件：无人脸 或 第7列文本含关键词 或 第8列分数低于阈值
                if (!hasFace || nameMatch || scoreLow) {
                    if (!state.noFaceIds.has(it.keyId)) addCount++;
                    state.noFaceIds.add(it.keyId);
                }
            });

            // 更新进度
            state.currentRow = Math.min(i + batch.length, items.length);
            updatePanel();
        }

        return addCount;
    }

    async function runCollect() {
        const start = Date.now();
        while (Date.now() - start < CONFIG.pageWaitMax) {
            if (document.querySelectorAll(SEL.row).length > 0) break;
            await delay(300);
        }

        while (state.running) {
            const add = await collectCurrentPage();
            log("第" + state.currentPage + "页完成，本页新增 " + add + " 条，累计 " + state.noFaceIds.size + " 条");
            updatePanel();

            try {
                const hasNext = await goNextPage();
                if (!hasNext) {
                    const result = Array.from(state.noFaceIds).join(',');
                    GM_setClipboard(result);
                    log("全部完成！共 " + state.noFaceIds.size + " 条 key_id 已复制到剪贴板");
                    break;
                }
            } catch (e) {
                log("翻页异常: " + (e.message || e));
                break;
            }
        }
        stopRun();
    }

    // ========== 面板 ==========
    function updatePanel() {
        const c = document.querySelector("#nf-count");
        const p = document.querySelector("#nf-page");
        const prog = document.querySelector("#nf-progress");
        if (c) c.textContent = state.noFaceIds.size;
        if (p) p.textContent = state.currentPage;
        if (prog) prog.textContent = state.currentRow + " / " + state.totalRows;
        const btn = document.querySelector("#nf-copy");
        if (btn) btn.disabled = state.noFaceIds.size === 0;
    }

    function buildPanel() {
        if (document.querySelector("#nf-panel")) return;
        const panel = document.createElement("div");
        panel.id = "nf-panel";
        panel.innerHTML = `
            <div class="nf-title">无人脸ID提取</div>
            <div class="nf-body">
                <div class="nf-stat">当前页：第 <b id="nf-progress">0 / 0</b> 条</div>
                <div class="nf-stat">页码：<b id="nf-page">1</b> &nbsp;|&nbsp; 已提取：<b id="nf-count">0</b> 条</div>
                <div class="nf-row">
                    <label class="nf-label">关键词：</label>
                    <input type="text" id="nf-keyword" placeholder="逗号分隔，留空不启用">
                </div>
                <div class="nf-row">
                    <label class="nf-label">分数低于：</label>
                    <input type="number" id="nf-score" value="80" min="0" max="100" step="1">
                </div>
                <div class="nf-row">
                    <button id="nf-start" class="nf-btn nf-go">开始提取</button>
                    <button id="nf-stop" class="nf-btn nf-stop" disabled>停止</button>
                </div>
                <button id="nf-copy" class="nf-btn nf-copy" disabled>复制全部key_id</button>
                <div class="nf-log" id="no-face-log"></div>
            </div>
        `;
        document.body.appendChild(panel);

        const css = document.createElement("style");
        css.textContent = `
            #nf-panel{position:fixed;top:100px;right:20px;width:260px;background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);z-index:999999;font-size:13px;font-family:system-ui,sans-serif;}
            .nf-title{padding:10px 14px;background:#1677ff;color:#fff;border-radius:8px 8px 0 0;font-weight:600;cursor:move;user-select:none;}
            .nf-body{padding:12px 14px;}
            .nf-stat{margin-bottom:8px;color:#333;}
            .nf-stat b{color:#1677ff;font-size:15px;}
            .nf-row{display:flex;align-items:center;gap:6px;margin-bottom:8px;}
            .nf-label{font-size:12px;color:#666;white-space:nowrap;}
            .nf-row input{flex:1;padding:4px 6px;border:1px solid #d9d9d9;border-radius:4px;outline:none;font-size:12px;}
            #nf-score{flex:none;width:70px;}
            .nf-btn{flex:1;padding:6px 0;border:none;border-radius:4px;cursor:pointer;font-size:13px;}
            .nf-btn:disabled{opacity:.45;cursor:not-allowed;}
            .nf-go{background:#1677ff;color:#fff;}
            .nf-stop{background:#ff4d4f;color:#fff;}
            .nf-copy{width:100%;background:#52c41a;color:#fff;margin-bottom:8px;}
            .nf-log{max-height:180px;overflow-y:auto;background:#fafafa;border-radius:4px;padding:6px 8px;font-size:11px;font-family:Consolas,monospace;line-height:1.6;color:#666;word-break:break-all;}
        `;
        document.head.appendChild(css);

        // 拖拽
        let dragging = false, ox = 0, oy = 0;
        const title = panel.querySelector(".nf-title");
        title.addEventListener("mousedown", (e) => {
            dragging = true;
            const r = panel.getBoundingClientRect();
            ox = e.clientX - r.left; oy = e.clientY - r.top;
            panel.style.right = "auto";
            panel.style.left = r.left + "px";
            panel.style.top = r.top + "px";
            e.preventDefault();
        });
        document.addEventListener("mousemove", (e) => {
            if (!dragging) return;
            panel.style.left = Math.max(0, Math.min(e.clientX - ox, window.innerWidth - panel.offsetWidth)) + "px";
            panel.style.top = Math.max(0, Math.min(e.clientY - oy, window.innerHeight - panel.offsetHeight)) + "px";
        });
        document.addEventListener("mouseup", () => { dragging = false; });

        // 事件
        document.querySelector("#nf-start").addEventListener("click", startRun);
        document.querySelector("#nf-stop").addEventListener("click", stopRun);
        document.querySelector("#nf-copy").addEventListener("click", () => {
            const result = Array.from(state.noFaceIds).join(',');
            GM_setClipboard(result);
            log("已复制 " + state.noFaceIds.size + " 条 key_id 到剪贴板");
        });
    }

    function startRun() {
        if (state.running) return;
        // 读取关键词输入
        const kwVal = document.querySelector("#nf-keyword").value.trim();
        CONFIG.nameKeywords = kwVal
            ? kwVal.split(/[,，]/).map(k => k.trim()).filter(k => k)
            : [];

        // 读取分数阈值
        const scoreVal = parseFloat(document.querySelector("#nf-score").value);
        if (!isNaN(scoreVal)) CONFIG.scoreThreshold = scoreVal;

        state.running = true;
        state.noFaceIds.clear();
        const startPage = getActivePage();
        state.currentPage = Number.isNaN(startPage) ? 1 : startPage;
        state.totalRows = 0;
        state.currentRow = 0;
        document.querySelector("#nf-start").disabled = true;
        document.querySelector("#nf-stop").disabled = false;
        updatePanel();
        const ruleParts = ["无人脸", "分数<" + CONFIG.scoreThreshold];
        if (CONFIG.nameKeywords.length > 0) ruleParts.push("关键词：" + CONFIG.nameKeywords.join("、"));
        log("开始提取（第" + state.currentPage + "页起），规则：" + ruleParts.join(" 或 "));
        runCollect();
    }

    function stopRun() {
        state.running = false;
        const startBtn = document.querySelector("#nf-start");
        const stopBtn = document.querySelector("#nf-stop");
        if (startBtn) startBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = true;
    }

    // ========== 初始化 ==========
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", buildPanel);
    } else {
        buildPanel();
    }
})();
