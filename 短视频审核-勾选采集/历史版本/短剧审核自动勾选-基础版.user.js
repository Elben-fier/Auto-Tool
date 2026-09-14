// ==UserScript==
// @name         短剧审核自动识别勾选工具
// @namespace    https://github.com/elben-fier/short-drama-review
// @version      2.0.0
// @description  自动扫描审核表格图片人脸与文本人名，命中自动勾选。可视化面板 + 翻页自动重置。
// @author       Auto
// @match        https://tools.vobile.cn/quality/qualityTest*
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function () {
    "use strict";

    // =======================================================================
    // 可配置项
    // =======================================================================
    const CONFIG = {
        backendUrl: "http://127.0.0.1:5002",
        rateLimit: 5,            // 每秒最大请求数（提速）
        debounceMs: 300,         // 滚动防抖
        imageWaitMs: 1500,       // 单张图片最大等待时间（5s→1.5s 避免超时拖慢）
        scanStartDelayMs: 1000,  // 初始扫描延迟
        afterActionDelay: 1000,  // 勾选后等待时间
        skipFaceDetect: false,   // 跳过人脸检测开关
        skipNameDetect: false,   // 跳过人名检测开关
        debugCoords: true,       // 调试：在控制台输出坐标信息
    };

    // DOM 选择器
    const SEL = {
        row: "tr.ant-table-row.ant-table-row-level-0",
        tbody: ".ant-table-tbody",
        checkbox: ".ant-checkbox-wrapper",
        image: ".ant-image-img",
    };

    // =======================================================================
    // 运行状态
    // =======================================================================
    const state = {
        running: false,
        scanning: false,
        processedKeys: new Set(),
        hitCount: 0,
        faceHits: 0,
        nameHits: 0,
        totalRows: 0,
        currentRow: 0,
        lastRequestAt: 0,
        scrollTimer: null,
        pageObserver: null,
    };

    // =======================================================================
    // 工具函数
    // =======================================================================
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    const minInterval = () => 1000 / CONFIG.rateLimit;

    // =======================================================================
    // HTTP 请求（速率限制 + 429 重试）
    // =======================================================================
    function apiPost(path, body) {
        return new Promise((resolve, reject) => {
            const now = Date.now();
            const wait = Math.max(0, state.lastRequestAt + minInterval() - now);
            state.lastRequestAt = Math.max(now, state.lastRequestAt + minInterval());

            const doReq = () => {
                const url = CONFIG.backendUrl + path;
                console.log("[apiPost] 发起请求:", url);
                GM_xmlhttpRequest({
                    method: "POST",
                    url: url,
                    headers: { "Content-Type": "application/json" },
                    data: JSON.stringify(body),
                    timeout: 10000,
                    onload(r) {
                        console.log("[apiPost] 响应:", r.status, r.responseText ? r.responseText.substring(0, 200) : "(empty)");
                        if (r.status === 429) {
                            setTimeout(() => apiPost(path, body).then(resolve).catch(reject), 600);
                            return;
                        }
                        try { resolve(JSON.parse(r.responseText)); }
                        catch (e) { reject(e); }
                    },
                    onerror: function(err) {
                        console.error("[apiPost] 请求失败:", err);
                        reject(err || new Error("GM_xmlhttpRequest error"));
                    },
                    ontimeout: function() {
                        console.error("[apiPost] 请求超时");
                        reject(new Error("timeout"));
                    },
                });
            };
            wait > 0 ? setTimeout(doReq, wait) : doReq();
        });
    }

    // =======================================================================
    // 图片加载等待
    // =======================================================================
    function waitForImage(img) {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve(true);
        return new Promise((resolve) => {
            const tid = setTimeout(() => resolve(false), CONFIG.imageWaitMs);
            img.addEventListener("load", () => { clearTimeout(tid); resolve(true); }, { once: true });
            img.addEventListener("error", () => { clearTimeout(tid); resolve(false); }, { once: true });
        });
    }

    // =======================================================================
    // 屏幕绝对坐标计算（修正：统一转为物理像素后再加和）
    // =======================================================================
    function getAbsoluteRect(el) {
        const r = el.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        // chromeH / chromeW 是 CSS 像素，screenLeft/screenTop 也是 CSS 像素
        const chromeH = window.outerHeight - window.innerHeight;
        const chromeW = (window.outerWidth - window.innerWidth) / 2;

        // 视口左上角在屏幕上的 CSS 像素位置
        const vpCssLeft = (window.screenLeft || window.screenX || 0) + chromeW;
        const vpCssTop = (window.screenTop || window.screenY || 0) + chromeH;

        // 统一转为物理像素：(CSS坐标 + CSS偏移) × DPR
        const abs = {
            left: Math.round((vpCssLeft + r.left) * dpr),
            top: Math.round((vpCssTop + r.top) * dpr),
            width: Math.round(r.width * dpr),
            height: Math.round(r.height * dpr),
        };

        if (CONFIG.debugCoords) {
            console.log(
                "[坐标调试] dpr=" + dpr +
                " screenPos=(" + (window.screenLeft || window.screenX || 0) + "," + (window.screenTop || window.screenY || 0) + ")" +
                " chromeH=" + chromeH +
                " vpCss=(" + vpCssLeft + "," + vpCssTop + ")" +
                " rect=(" + r.left + "," + r.top + " " + r.width + "x" + r.height + ")" +
                " → 物理=(" + abs.left + "," + abs.top + " " + abs.width + "x" + abs.height + ")"
            );
        }

        return abs;
    }

    // =======================================================================
    // Ant Design 图片预览：点击小图 → 弹出大图 → 检测完 → 关闭预览
    // =======================================================================
    let _detectCallCount = 0;
    async function detectFaceWithPreview(img, row) {
        _detectCallCount++;
        const callId = _detectCallCount;
        const rowKey = row.getAttribute("data-row-key") || "-";
        console.log(`[审核工具] detectFaceWithPreview #${callId} 开始, row=${rowKey}`);

        const cb = row.querySelector(SEL.checkbox);
        const cbInput = cb ? cb.querySelector("input.ant-checkbox-input") : null;
        const wasChecked = cbInput ? cbInput.checked : false;

        console.log(`[审核工具] #${callId} 等待上一轮预览关闭...`);
        await ensurePreviewClosed();
        console.log(`[审核工具] #${callId} 预览已关闭, 点击缩略图...`);

        img.click();

        // 轮询等待预览图出现且尺寸有效（不固定延时，适配动画速度）
        let previewImg = null;
        let abs = null;
        for (let attempt = 0; attempt < 15; attempt++) {
            await delay(200);
            previewImg = document.querySelector(".ant-image-preview-img");
            if (previewImg && previewImg.complete && previewImg.naturalWidth > 0) {
                abs = getAbsoluteRect(previewImg);
                if (abs.width > 20 && abs.height > 20) break;
            }
            console.log(`[审核工具] #${callId} 等待预览就绪 attempt=${attempt+1} previewImg=${!!previewImg} abs=${abs ? abs.width+'x'+abs.height : 'null'}`);
        }

        if (!previewImg) {
            console.log(`[审核工具] #${callId} 预览图未出现, 放弃`);
            closePreview();
            restoreCheckbox(cb, wasChecked);
            return false;
        }

        if (!abs || abs.width <= 20 || abs.height <= 20) {
            console.log(`[审核工具] #${callId} 预览图尺寸无效 (${abs ? abs.width+'x'+abs.height : 'null'}), 放弃`);
            closePreview();
            await ensurePreviewClosed();
            restoreCheckbox(cb, wasChecked);
            return false;
        }

        console.log(`[审核工具] #${callId} 预览就绪, complete=${previewImg.complete} nw=${previewImg.naturalWidth} rect=(${abs.left},${abs.top} ${abs.width}x${abs.height})`);

        let hasFace = false;
        try {
            console.log(`[审核工具] #${callId} 调用 /detect API...`);
            const res = await apiPost("/detect", abs);
            console.log(`[审核工具] #${callId} /detect 返回:`, JSON.stringify(res));
            hasFace = res.hasFace === true;
        } catch (e) {
            console.warn(`[审核工具] #${callId} 人脸检测API调用失败:`, e.message || e);
        }

        closePreview();
        console.log(`[审核工具] #${callId} 关闭预览, 等待动画...`);
        await ensurePreviewClosed();
        console.log(`[审核工具] #${callId} 预览已关闭`);

        if (!hasFace) {
            restoreCheckbox(cb, wasChecked);
        }

        console.log(`[审核工具] #${callId} 结果: hasFace=${hasFace}`);
        return hasFace;
    }

    function restoreCheckbox(cb, wasChecked) {
        if (!cb) return;
        const input = cb.querySelector("input.ant-checkbox-input");
        if (!input) return;
        if (input.checked !== wasChecked) {
            cb.click();
        }
    }

    async function ensurePreviewClosed() {
        // 先确保关闭动画有时间执行
        await delay(400);
        const maxWait = 2000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
            const wrap = document.querySelector(".ant-image-preview-wrap");
            const img = document.querySelector(".ant-image-preview-img");
            // wrap 和 img 都不在 DOM 中才认为完全关闭
            if (!wrap && !img) return;
            if (wrap) {
                const style = window.getComputedStyle(wrap);
                if (style.display === "none") return;
            }
            await delay(150);
        }
    }

    function closePreview() {
        // ESC 最可靠，不会受 DOM 结构变化影响
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
    }

    // =======================================================================
    // 核心检测：单行
    // =======================================================================
    async function processRow(row) {
        const key = row.getAttribute("data-row-key");
        if (!key || state.processedKeys.has(key)) return { hit: false, face: false, name: false };

        state.processedKeys.add(key);
        let hit = false, isFace = false, isName = false;

        // --- 人脸检测（可跳过），只看第一张图 ---
        if (!CONFIG.skipFaceDetect) {
            const imgs = row.querySelectorAll(SEL.image);
            if (imgs.length > 0) {
                const img = imgs[0]; // 只看第一张图
                // 确保缩略图已加载（否则点不开预览）
                if (!img.complete || img.naturalWidth === 0) {
                    const ok = await waitForImage(img);
                    if (ok) {
                        try {
                            const hasFace = await detectFaceWithPreview(img, row);
                            if (hasFace) {
                                hit = true; isFace = true; state.faceHits++;
                                addLog("行 " + key + " 预览大图检测到人脸 ✓", "hit");
                            }
                        } catch (e) {
                            console.warn("[审核工具] 人脸检测异常:", e.message || e);
                        }
                    }
                } else {
                    try {
                        const hasFace = await detectFaceWithPreview(img, row);
                        if (hasFace) {
                            hit = true; isFace = true; state.faceHits++;
                            addLog("行 " + key + " 预览大图检测到人脸 ✓", "hit");
                        }
                    } catch (e) {
                        console.warn("[审核工具] 人脸检测异常:", e.message || e);
                    }
                }
            }
        }

        // --- 人名检测（可跳过） ---
        if (!hit && !CONFIG.skipNameDetect) {
            const text = (row.textContent || "").trim();
            if (text.length > 0) {
                try {
                    const res = await apiPost("/detect_text_name", { text });
                    if (res.hasPerson) { hit = true; isName = true; state.nameHits++; }
                } catch (e) { /* fall through */ }
            }
        }

        // --- 勾选 ---
        if (hit) {
            const cb = row.querySelector(SEL.checkbox);
            if (cb) {
                const input = cb.querySelector("input.ant-checkbox-input");
                if (!input || !input.checked) {
                    cb.click();
                    state.hitCount++;
                    await delay(100);
                }
            }
        }

        return { hit, face: isFace, name: isName };
    }

    // =======================================================================
    // 全页扫描
    // =======================================================================
    async function scanPage() {
        if (state.scanning) return;
        state.scanning = true;

        const rows = document.querySelectorAll(SEL.row);
        state.totalRows = rows.length;
        state.currentRow = 0;
        updatePanel();

        addLog(`开始扫描，共 ${rows.length} 行`, "info");

        for (const row of rows) {
            if (!state.running) break;
            state.currentRow++;
            updatePanel();

            const key = row.getAttribute("data-row-key") || "-";
            const result = await processRow(row);

            if (result.hit) {
                const tag = result.face ? "人脸" : "人名";
                addLog(`行 ${key} → ${tag}命中 ✓`, "hit");
            }
        }

        addLog(`本页扫描完成 | 命中 ${state.hitCount} 条 (人脸${state.faceHits} / 人名${state.nameHits})`, "ok");
        state.scanning = false;
        updatePanel();
    }

    // =======================================================================
    // 翻页监听
    // =======================================================================
    function setupPageObserver() {
        const tbody = document.querySelector(SEL.tbody);
        if (!tbody) {
            setTimeout(setupPageObserver, 1000);
            return;
        }
        state.pageObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.type !== "childList") continue;
                // 只响应表格行的增删（真正的翻页），忽略复选框、预览等内部 DOM 变动
                let hasRowChange = false;
                for (const node of m.addedNodes) {
                    if (node.nodeType === 1 && (node.matches && node.matches("tr.ant-table-row") || node.querySelector && node.querySelector("tr.ant-table-row"))) {
                        hasRowChange = true; break;
                    }
                }
                for (const node of m.removedNodes) {
                    if (node.nodeType === 1 && (node.matches && node.matches("tr.ant-table-row") || node.querySelector && node.querySelector("tr.ant-table-row"))) {
                        hasRowChange = true; break;
                    }
                }
                if (!hasRowChange) continue;
                addLog("检测到翻页，重置并重新扫描…", "info");
                state.processedKeys.clear();
                state.hitCount = 0;
                state.faceHits = 0;
                state.nameHits = 0;
                updatePanel();
                setTimeout(scanPage, 500);
                return;
            }
        });
        state.pageObserver.observe(tbody, { childList: true, subtree: true });
    }

    // =======================================================================
    // 滚动防抖
    // =======================================================================
    function setupScrollDebounce() {
        window.addEventListener("scroll", () => {
            clearTimeout(state.scrollTimer);
            state.scrollTimer = setTimeout(() => {
                if (state.running) scanPage();
            }, CONFIG.debounceMs);
        }, { passive: true });
    }

    // =======================================================================
    // 日志
    // =======================================================================
    function addLog(msg, type) {
        console.log(`[审核工具] ${msg}`);
        const el = document.querySelector("#audit-log");
        if (!el) return;
        const line = document.createElement("div");
        line.className = "log-line log-" + (type || "");
        line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        el.prepend(line);
        // 保留最近 200 条
        while (el.children.length > 200) el.lastChild.remove();
    }

    // =======================================================================
    // 可视化控制面板
    // =======================================================================
    function buildPanel() {
        if (document.querySelector("#audit-panel")) return;

        const panel = document.createElement("div");
        panel.id = "audit-panel";
        panel.innerHTML = `
            <div class="panel-header" id="panel-header">短剧审核助手 2.0</div>
            <div class="panel-body">
                <div class="cfg-row">
                    <label>后端地址</label>
                    <input id="cfg-backend" value="${CONFIG.backendUrl}">
                </div>
                <div class="cfg-row">
                    <label>速率限制</label>
                    <input id="cfg-rate" type="number" value="${CONFIG.rateLimit}" min="1" max="10" style="width:50px">
                    <span>条/秒</span>
                </div>
                <div class="toggle-row">
                    <label class="toggle-label">
                        <input type="checkbox" id="toggle-face" ${CONFIG.skipFaceDetect ? "" : "checked"}>
                        <span>人脸检测</span>
                    </label>
                    <label class="toggle-label">
                        <input type="checkbox" id="toggle-name" ${CONFIG.skipNameDetect ? "" : "checked"}>
                        <span>人名检测</span>
                    </label>
                    <label class="toggle-label">
                        <input type="checkbox" id="toggle-debug" ${CONFIG.debugCoords ? "checked" : ""}>
                        <span>坐标调试</span>
                    </label>
                </div>
                <div class="stat-grid">
                    <div class="stat-item">
                        <div class="stat-val" id="stat-total">0</div>
                        <div class="stat-label">总行数</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-val" id="stat-current">0</div>
                        <div class="stat-label">当前行</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-val hit" id="stat-hits">0</div>
                        <div class="stat-label">命中</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-val" id="stat-face">0</div>
                        <div class="stat-label">人脸</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-val" id="stat-name">0</div>
                        <div class="stat-label">人名</div>
                    </div>
                </div>
                <div class="progress-wrap">
                    <div class="progress-bar" id="progress-bar"></div>
                </div>
                <div class="btn-row">
                    <button id="btn-start" class="btn btn-go">▶ 开始扫描</button>
                    <button id="btn-stop" class="btn btn-stop" disabled>■ 停止</button>
                    <button id="btn-rescan" class="btn btn-rescan">↻ 重新扫描</button>
                </div>
                <div class="btn-row">
                    <button id="btn-debug-shot" class="btn btn-debug">📷 截图验证</button>
                </div>
                <div class="log-wrap" id="audit-log"></div>
            </div>
        `;
        document.body.appendChild(panel);

        // 样式
        const css = document.createElement("style");
        css.textContent = `
#audit-panel {
    position:fixed;top:100px;right:20px;width:300px;background:#fff;
    border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.15);
    z-index:999999;font-size:13px;font-family:system-ui,sans-serif;
}
.panel-header {
    padding:10px 14px;background:#1677ff;color:#fff;
    border-radius:8px 8px 0 0;font-weight:600;cursor:move;user-select:none;
}
.panel-body { padding:12px 14px; }
.cfg-row {
    display:flex;align-items:center;gap:6px;margin-bottom:8px;
}
.cfg-row label { width:56px;font-size:12px;color:#666; }
.cfg-row input {
    flex:1;padding:4px 6px;border:1px solid #d9d9d9;border-radius:4px;
    outline:none;font-size:12px;
}
.cfg-row span { font-size:12px;color:#999; }
.stat-grid {
    display:grid;grid-template-columns:repeat(5,1fr);gap:4px;
    margin-bottom:8px;text-align:center;
}
.stat-val {
    font-size:16px;font-weight:700;color:#333;
}
.stat-val.hit { color:#1677ff; }
.stat-label { font-size:10px;color:#999; }
.progress-wrap {
    height:4px;background:#f0f0f0;border-radius:2px;
    margin-bottom:10px;overflow:hidden;
}
.progress-bar {
    height:100%;width:0;background:#1677ff;
    border-radius:2px;transition:width .3s;
}
.btn-row { display:flex;gap:6px;margin-bottom:8px; }
.btn {
    flex:1;padding:6px 0;border:none;border-radius:4px;
    cursor:pointer;font-size:12px;font-weight:500;
}
.btn:disabled { opacity:0.45;cursor:not-allowed; }
.btn-go { background:#1677ff;color:#fff; }
.btn-stop { background:#ff4d4f;color:#fff; }
.btn-rescan { background:#f5f5f5;color:#333;border:1px solid #d9d9d9; }
.btn-debug { background:#fff7e6;color:#d46b08;border:1px solid #ffd591;flex:0.6;font-size:11px; }
.log-wrap {
    max-height:200px;overflow-y:auto;background:#fafafa;
    border-radius:4px;padding:6px 8px;font-size:11px;
    font-family:Consolas,monospace;line-height:1.6;
}
.log-line { word-break:break-all; }
.log-info { color:#666; }
.log-hit { color:#1677ff; }
.log-ok { color:#52c41a;font-weight:500; }
.toggle-row { display:flex;gap:10px;margin-bottom:8px;font-size:12px; }
.toggle-label { display:flex;align-items:center;gap:3px;cursor:pointer;color:#555; }
.toggle-label input { margin:0; }
`;
        document.head.appendChild(css);

        // 拖拽
        initDrag(panel, panel.querySelector("#panel-header"));

        // 按钮事件
        document.querySelector("#btn-start").addEventListener("click", startRun);
        document.querySelector("#btn-stop").addEventListener("click", stopRun);
        document.querySelector("#btn-rescan").addEventListener("click", () => {
            state.processedKeys.clear();
            state.hitCount = 0; state.faceHits = 0; state.nameHits = 0;
            updatePanel();
            scanPage();
        });

        // 配置输入
        document.querySelector("#cfg-backend").addEventListener("change", function () {
            CONFIG.backendUrl = this.value.trim();
        });
        document.querySelector("#cfg-rate").addEventListener("change", function () {
            CONFIG.rateLimit = Math.max(1, parseInt(this.value) || 5);
        });
        // 功能开关
        document.querySelector("#toggle-face").addEventListener("change", function () {
            CONFIG.skipFaceDetect = !this.checked;
            addLog("人脸检测: " + (this.checked ? "开启" : "关闭"), "info");
        });
        document.querySelector("#toggle-name").addEventListener("change", function () {
            CONFIG.skipNameDetect = !this.checked;
            addLog("人名检测: " + (this.checked ? "开启" : "关闭"), "info");
        });
        document.querySelector("#toggle-debug").addEventListener("change", function () {
            CONFIG.debugCoords = this.checked;
            addLog("坐标调试: " + (this.checked ? "开启" : "关闭"), "info");
        });

        // 调试截图按钮：点击缩略图→弹出预览大图→对大图截图→关闭预览
        document.querySelector("#btn-debug-shot").addEventListener("click", async () => {
            const thumb = document.querySelector(SEL.image);
            if (!thumb) {
                addLog("截图验证: 页面未找到 .ant-image-img 缩略图", "info");
                return;
            }
            // 确保缩略图加载后点击打开预览
            if (!thumb.complete || thumb.naturalWidth === 0) {
                addLog("截图验证: 等待缩略图加载…", "info");
                await waitForImage(thumb);
            }
            addLog("截图验证: 点击缩略图打开预览…", "info");
            thumb.click();
            await delay(800);

            let previewImg = document.querySelector(".ant-image-preview-img");
            if (!previewImg) {
                await delay(500);
                previewImg = document.querySelector(".ant-image-preview-img");
            }
            if (!previewImg) {
                addLog("截图验证: 未找到预览大图", "info");
                closePreview();
                return;
            }

            // 等大图加载
            if (!previewImg.complete || previewImg.naturalWidth === 0) {
                addLog("截图验证: 等待预览大图加载…", "info");
                await waitForImage(previewImg);
            }

            const abs = getAbsoluteRect(previewImg);
            addLog("截图验证: 大图坐标 (" + abs.left + "," + abs.top + " " + abs.width + "x" + abs.height + ")", "info");
            try {
                const res = await apiPost("/debug_screenshot", abs);
                addLog("截图验证: 大图已保存 → " + res.saved, "ok");
            } catch (e) {
                addLog("截图验证失败: " + e, "info");
            }

            closePreview();
            await delay(300);
        });
    }

    // =======================================================================
    // 面板更新
    // =======================================================================
    function updatePanel() {
        const set = (id, v) => { const e = document.querySelector(id); if (e) e.textContent = v; };
        set("#stat-total", state.totalRows);
        set("#stat-current", state.currentRow);
        set("#stat-hits", state.hitCount);
        set("#stat-face", state.faceHits);
        set("#stat-name", state.nameHits);
        const bar = document.querySelector("#progress-bar");
        if (bar) {
            bar.style.width = state.totalRows > 0
                ? Math.round(state.currentRow / state.totalRows * 100) + "%"
                : "0%";
        }
    }

    // =======================================================================
    // 拖拽
    // =======================================================================
    function initDrag(panel, handle) {
        let dragging = false, ox = 0, oy = 0;
        handle.addEventListener("mousedown", (e) => {
            dragging = true;
            const r = panel.getBoundingClientRect();
            ox = e.clientX - r.left;
            oy = e.clientY - r.top;
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
    }

    // =======================================================================
    // 控制
    // =======================================================================
    async function startRun() {
        if (state.running) return;
        state.running = true;
        state.hitCount = 0; state.faceHits = 0; state.nameHits = 0;
        state.processedKeys.clear();
        document.querySelector("#btn-start").disabled = true;
        document.querySelector("#btn-stop").disabled = false;
        addLog("===== 检查后端连通性 =====", "info");

        // 诊断：检查 GM_xmlhttpRequest 是否可用
        console.log("[审核工具] GM_xmlhttpRequest 类型:", typeof GM_xmlhttpRequest);
        if (typeof GM_xmlhttpRequest === "undefined") {
            addLog("❌ GM_xmlhttpRequest 不可用! 请检查脚本 @grant 权限", "info");
        }

        // 健康检查
        addLog("正在连接 " + CONFIG.backendUrl + " ...", "info");
        try {
            const h = await apiPost("/health", {});
            addLog("✅ 后端连接成功: " + JSON.stringify(h), "ok");
        } catch (e) {
            addLog("❌ 后端连接失败: " + (e.message || e), "info");
            console.error("[审核工具] 健康检查详细错误:", e);
        }

        addLog("===== 开始扫描 =====", "info");
        updatePanel();
        scanPage().then(() => {
            if (state.running) {
                addLog("首轮扫描完成，等待翻页或滚动触发…", "ok");
            }
        });
    }

    function stopRun() {
        state.running = false;
        state.scanning = false;
        document.querySelector("#btn-start").disabled = false;
        document.querySelector("#btn-stop").disabled = true;
        addLog("===== 已停止 =====", "info");
        updatePanel();
    }

    // =======================================================================
    // 初始化
    // =======================================================================
    function init() {
        console.log("[审核工具] 2.0 可视化版已加载");
        buildPanel();
        setupPageObserver();
        setupScrollDebounce();
        addLog("面板就绪，点击「开始扫描」启动", "info");
        updatePanel();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
