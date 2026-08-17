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
        rateLimit: 5,            // 每秒最大请求数
        batchSize: 3,            // 每批同时下载并检测的图片数量
        debounceMs: 300,         // 滚动防抖
        imageWaitMs: 5000,       // 缩略图最大等待时间
        previewWaitMs: 10000,    // 预览大图出现并加载完成的最大等待时间
        afterActionDelay: 200,   // 勾选后等待时间
        skipFaceDetect: false,   // 跳过人脸检测开关
        skipNameDetect: false,   // 跳过人名检测开关
        scoreThreshold: 80,      // 分数低于该值时跳过该行（不检测、不勾选）
        skipLowScore: true,      // 启用「低分跳过」开关
        debugCoords: true,       // 调试：在控制台输出坐标信息
        modalWaitMax: 5000,      // 确认弹窗最长等待时间
        refreshWaitMax: 15000,   // 批量处理后页面刷新最长等待
        nextBatchWaitMax: 20000, // 批量错误后等待下一批数据的最长时间（20秒内无数据则停止）
        batchActionWait: 2500,   // 点击确认后的固定等待时间
    };

    // DOM 选择器
    const SEL = {
        row: "tr.ant-table-row.ant-table-row-level-0",
        tbody: ".ant-table-tbody",
        checkbox: ".ant-checkbox-wrapper",
        image: ".ant-image-img",
        scoreCell: "td:nth-child(8) .commonText-gqPoHv",
        selectAll: ".ant-table-thead input.ant-checkbox-input",
        batchBtn: "button.ant-btn",
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
        skippedCount: 0,
        totalRows: 0,
        currentRow: 0,
        lastRequestAt: 0,
        scrollTimer: null,
        pageObserver: null,
        autoMode: false,
        batchCount: 0,
        batchLoopRunning: false,
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
    // 批量图片检测：下载图片 URL → base64 → 批量 POST /detect_batch
    // =======================================================================
    function downloadImageAsBase64(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                responseType: "arraybuffer",
                timeout: 15000,
                onload(r) {
                    if (r.status !== 200) {
                        reject(new Error("HTTP " + r.status));
                        return;
                    }
                    try {
                        const bytes = new Uint8Array(r.response);
                        let binary = "";
                        const chunk = 0x8000;
                        for (let i = 0; i < bytes.length; i += chunk) {
                            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
                        }
                        resolve(btoa(binary));
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror() { reject(new Error("下载失败")); },
                ontimeout() { reject(new Error("超时")); },
            });
        });
    }

    // 批量检测一批行的人脸。items: [{key, url, row}]，返回 Map<key, boolean>
    // URL 下载失败的行自动回退到预览截屏方案
    async function detectFacesBatch(items) {
        const results = new Map();

        // 1. 并发下载所有 URL（失败返回 null）
        const downloads = await Promise.all(items.map((it) => {
            if (!it.url) return Promise.resolve({ key: it.key, b64: null });
            return downloadImageAsBase64(it.url)
                .then((b64) => ({ key: it.key, b64 }))
                .catch((e) => {
                    console.warn(`[审核工具] 图片下载失败 key=${it.key}:`, e.message || e);
                    return { key: it.key, b64: null };
                });
        }));

        // 2. 下载成功的批量检测
        const okItems = downloads.filter((d) => d.b64);
        if (okItems.length > 0) {
            try {
                const res = await apiPost("/detect_batch", { images: okItems.map((d) => d.b64) });
                const arr = Array.isArray(res.results) ? res.results : [];
                okItems.forEach((d, i) => results.set(d.key, arr[i] === true));
            } catch (e) {
                console.warn("[审核工具] 批量检测请求失败:", e.message || e);
                okItems.forEach((d) => results.set(d.key, false));
            }
        }

        // 3. 下载失败的行 → 回退到预览截屏单条检测
        const failItems = downloads.filter((d) => !d.b64);
        for (const d of failItems) {
            const item = items.find((it) => it.key === d.key);
            const row = item ? (findRowByKey(item.key) || item.row) : null;
            const img = row ? row.querySelector(SEL.image) : null;
            if (img) {
                try {
                    results.set(d.key, await detectFaceWithPreview(img, row));
                } catch (e) {
                    results.set(d.key, false);
                }
            } else {
                results.set(d.key, false);
            }
        }

        return results;
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

        // 确保上一次预览完全关闭，否则点新缩略图会读到旧图
        await ensurePreviewClosed();

        // 点击 .ant-image 容器（onClick 挂在容器上，比点 img 更稳）
        const wrapper = img.closest(".ant-image") || img;
        console.log(`[审核工具] #${callId} 点击缩略图打开预览...`);
        wrapper.click();

        // 等待预览大图出现并加载完成（用可配置超时，避免未缓存的大图还没加载完就放弃）
        let previewImg = null;
        let abs = null;
        const waitStart = Date.now();
        while (Date.now() - waitStart < CONFIG.previewWaitMs) {
            await delay(200);
            const cand = document.querySelector(".ant-image-preview-img");
            if (cand && cand.complete && cand.naturalWidth > 0) {
                const r = getAbsoluteRect(cand);
                if (r.width > 20 && r.height > 20) {
                    previewImg = cand;
                    abs = r;
                    break;
                }
            }
        }

        if (!previewImg) {
            console.warn(`[审核工具] #${callId} 预览图未出现或未加载完成, 放弃 (row=${rowKey})`);
            closePreview();
            await ensurePreviewClosed();
            restoreCheckbox(rowKey, wasChecked);
            return false;
        }

        console.log(`[审核工具] #${callId} 预览就绪, rect=(${abs.left},${abs.top} ${abs.width}x${abs.height})`);

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
        await ensurePreviewClosed();

        if (!hasFace) {
            restoreCheckbox(rowKey, wasChecked);
        }

        console.log(`[审核工具] #${callId} 结果: hasFace=${hasFace}`);
        return hasFace;
    }

    // 按 data-row-key 重新定位行，避免异步 await 期间 React 重渲染导致 row 引用错位
    function findRowByKey(key) {
        if (!key || key === "-") return null;
        const rows = document.querySelectorAll(SEL.row);
        for (const r of rows) {
            if (r.getAttribute("data-row-key") === key) return r;
        }
        return null;
    }

    function restoreCheckbox(key, wasChecked) {
        const row = findRowByKey(key);
        if (!row) return;
        const cb = row.querySelector(SEL.checkbox);
        if (!cb) return;
        const input = cb.querySelector("input.ant-checkbox-input");
        if (!input) return;
        if (input.checked !== wasChecked) {
            cb.click();
        }
    }

    async function ensurePreviewClosed() {
        const maxWait = 4000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
            const wrap = document.querySelector(".ant-image-preview-wrap");
            const img = document.querySelector(".ant-image-preview-img");
            // 完全关闭 = wrap 与 img 都已从 DOM 移除
            if (!wrap && !img) return true;
            // 仍存在则主动触发关闭（可能上一次关闭失败）
            closePreview();
            await delay(200);
        }
        // 超时兜底：直接移除残留预览 DOM，避免阻塞后续行
        document.querySelectorAll(".ant-image-preview-wrap").forEach((el) => el.remove());
        console.warn("[审核工具] 预览关闭超时，已强制移除残留 DOM");
        return false;
    }

    function closePreview() {
        // 同时触发多种关闭方式，提高成功率（React17+ 合成 ESC 不会进 React 树，需点按钮/遮罩）
        const closeBtn = document.querySelector(".ant-image-preview-close");
        if (closeBtn) { try { closeBtn.click(); } catch (e) {} }

        const mask = document.querySelector(".ant-image-preview-mask");
        if (mask) { try { mask.click(); } catch (e) {} }

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
    }

    // 单行处理逻辑已内联到 scanPage 的批量流程（分数跳过 → 批量人脸检测 → 人名检测 → 勾选）

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

        // 1. 预收集需要处理的行（分数跳过 + 去重 + 提取图片 URL）
        const tasks = [];
        for (const row of rows) {
            const key = row.getAttribute("data-row-key");
            if (!key || state.processedKeys.has(key)) continue;

            // 分数阈值跳过
            if (CONFIG.skipLowScore) {
                const scoreEl = row.querySelector(SEL.scoreCell);
                if (scoreEl) {
                    const score = parseFloat(scoreEl.textContent.trim());
                    if (!isNaN(score) && score < CONFIG.scoreThreshold) {
                        state.skippedCount++;
                        state.processedKeys.add(key);
                        addLog("行 " + key + " 分数 " + score + " < " + CONFIG.scoreThreshold + "，跳过", "info");
                        continue;
                    }
                }
            }
            state.processedKeys.add(key);

            let url = "";
            if (!CONFIG.skipFaceDetect) {
                const img = row.querySelector(SEL.image);
                if (img) url = img.currentSrc || img.src || "";
            }
            tasks.push({ key, row, url });
        }

        // 2. 分批处理（每批 batchSize 条，批量下载+批量检测人脸）
        for (let i = 0; i < tasks.length; i += CONFIG.batchSize) {
            if (!state.running) break;
            const batch = tasks.slice(i, i + CONFIG.batchSize);

            let faceMap = new Map();
            if (!CONFIG.skipFaceDetect) {
                faceMap = await detectFacesBatch(batch);
            }

            // 逐行：人脸结果 + 人名检测 + 勾选
            for (const t of batch) {
                if (!state.running) break;
                state.currentRow++;
                updatePanel();

                let hit = false, isFace = false, isName = false;

                if (!CONFIG.skipFaceDetect && faceMap.get(t.key) === true) {
                    hit = true; isFace = true; state.faceHits++;
                    addLog("行 " + t.key + " 检测到人脸 ✓", "hit");
                }

                if (!hit && !CONFIG.skipNameDetect) {
                    const curRow = findRowByKey(t.key) || t.row;
                    const text = (curRow.textContent || "").trim();
                    if (text.length > 0) {
                        try {
                            const res = await apiPost("/detect_text_name", { text });
                            if (res.hasPerson) { hit = true; isName = true; state.nameHits++; }
                        } catch (e) { /* fall through */ }
                    }
                }

                if (hit) {
                    const curRow = findRowByKey(t.key);
                    const cb = curRow ? curRow.querySelector(SEL.checkbox) : null;
                    if (cb) {
                        const input = cb.querySelector("input.ant-checkbox-input");
                        if (!input || !input.checked) {
                            cb.click();
                            state.hitCount++;
                            await delay(100);
                        }
                    }
                }
            }
        }

        addLog(`本页扫描完成 | 命中 ${state.hitCount} 条 (人脸${state.faceHits} / 人名${state.nameHits})`, "ok");
        state.scanning = false;
        updatePanel();
    }

    // =======================================================================
    // 自动批处理模块
    // =======================================================================
    // 抑制 antd 固定列渲染竞态导致的 insertBefore 报错（良性，不影响功能，仅避免刷屏/中断）
    function setupErrorSuppression() {
        window.addEventListener("error", (e) => {
            if (e && e.message && e.message.indexOf("insertBefore") !== -1) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);
    }

    // 按文本查找元素（兼容不同 class）
    const findByText = (root, selector, text) => {
        const elements = (root || document).querySelectorAll(selector);
        const needle = (text || "").replace(/\s+/g, "");
        for (const el of elements) {
            if ((el.textContent || "").replace(/\s+/g, "").includes(needle)) return el;
        }
        return null;
    };

    // 安全点击：元素必须在 DOM 中，并包裹 try-catch，避免 React 渲染竞争报错
    const safeClick = (el) => {
        if (!el || !el.isConnected) return false;
        try { el.click(); return true; }
        catch (e) { console.warn("[审核工具] 点击失败:", e.message || e); return false; }
    };

    // 等待确认弹窗的「确定/确认」按钮出现（参照短剧审核4.5）
    async function waitForConfirmBtn(timeout) {
        const start = Date.now();
        const t = timeout || CONFIG.modalWaitMax;
        while (Date.now() - start < t) {
            // 策略1：ant-popconfirm
            const popconfirms = document.querySelectorAll(".ant-popconfirm");
            for (const pc of popconfirms) {
                if (!pc.isConnected) continue;
                const style = window.getComputedStyle(pc);
                if (style.display === "none" || style.opacity === "0") continue;
                const btns = pc.querySelectorAll("button");
                for (const btn of btns) {
                    const txt = (btn.textContent || "").replace(/\s+/g, "");
                    if (txt.includes("确定") || txt.includes("确认")) return btn;
                }
            }
            // 策略2：ant-modal 内的 primary 按钮
            const modals = document.querySelectorAll(".ant-modal-wrap, .ant-modal");
            for (const modal of modals) {
                if (!modal.isConnected) continue;
                const style = window.getComputedStyle(modal);
                if (style.display === "none") continue;
                const btns = modal.querySelectorAll("button.ant-btn-primary");
                for (const btn of btns) {
                    const txt = (btn.textContent || "").replace(/\s+/g, "");
                    if (txt.includes("确定") || txt.includes("确认")) return btn;
                }
            }
            await delay(200);
        }
        return null;
    }

    // 点击批量按钮 + 确认弹窗
    async function clickBatchAndConfirm(batchText) {
        const btn = findByText(document, SEL.batchBtn, batchText);
        if (!btn || btn.disabled) {
            addLog(`「${batchText}」按钮不存在或已禁用（可能无勾选项）`, "info");
            return false;
        }
        addLog(`点击「${batchText}」按钮...`, "info");
        safeClick(btn);
        await delay(800);

        const confirmBtn = await waitForConfirmBtn();
        if (!confirmBtn) {
            addLog(`「${batchText}」确认弹窗未出现`, "info");
            return false;
        }
        addLog(`「${batchText}」确认弹窗出现，点击确认`, "info");
        try {
            confirmBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            safeClick(confirmBtn);
            confirmBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        } catch (e) {
            console.warn("[审核工具] 确认点击异常:", e.message || e);
        }
        await delay(CONFIG.batchActionWait);
        return true;
    }

    // 全选当前页所有行（点击表头全选 checkbox）
    function selectAllRows() {
        const selectAll = document.querySelector(SEL.selectAll);
        if (!selectAll || !selectAll.isConnected) {
            addLog("未找到表头全选框", "info");
            return false;
        }
        if (!selectAll.checked) safeClick(selectAll);
        return true;
    }

    // 等待表格行数变化（翻页/刷新）
    async function waitForRowCountChange(prevCount, timeout) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (!state.running) break;
            const count = document.querySelectorAll(SEL.row).length;
            if (count !== prevCount) return count;
            await delay(400);
        }
        return document.querySelectorAll(SEL.row).length;
    }

    // 等待表格稳定（行数连续一段时间不变）
    async function waitForTableSettled(timeout, stableMs) {
        const start = Date.now();
        const t = timeout || CONFIG.nextBatchWaitMax;
        const stable = stableMs || 1200;
        let lastCount = document.querySelectorAll(SEL.row).length;
        let stableSince = Date.now();
        while (Date.now() - start < t) {
            if (!state.running) break;
            await delay(400);
            const count = document.querySelectorAll(SEL.row).length;
            if (count === lastCount) {
                if (Date.now() - stableSince >= stable) return count;
            } else {
                lastCount = count;
                stableSince = Date.now();
            }
        }
        return document.querySelectorAll(SEL.row).length;
    }

    // 等待下一批数据出现（批量错误后系统刷新）。
    // beforeFirstKey: 批量错误前首行的 data-row-key，用于区分「残留旧行」与「真正的新一批」。
    // 返回新行数；超时（20秒）仍无新数据返回 0。
    async function waitForNextBatch(beforeFirstKey, timeout) {
        const t = timeout || CONFIG.nextBatchWaitMax;
        const start = Date.now();
        while (Date.now() - start < t) {
            if (!state.running) return 0;
            const rows = document.querySelectorAll(SEL.row);
            const count = rows.length;
            const firstKey = count > 0 ? rows[0].getAttribute("data-row-key") : null;

            // 数据「变化」= 表格被清空，或首行 key 已与批量错误前不同（说明旧数据被处理/替换）
            const changed = count === 0 || firstKey !== beforeFirstKey;

            // 只有变化之后出现的新数据，才认定为下一批
            if (changed && count > 0) {
                await waitForTableSettled(CONFIG.refreshWaitMax, 1200);
                return document.querySelectorAll(SEL.row).length;
            }
            await delay(400);
        }
        return 0;
    }

    // 自动批处理主循环
    async function autoBatchLoop() {
        state.batchLoopRunning = true;
        state.batchCount = 0;
        addLog("===== 自动批处理启动 =====", "ok");

        while (state.running && state.autoMode) {
            // 等表格稳定，避免上一轮残留渲染
            await waitForTableSettled(CONFIG.refreshWaitMax, 1000);
            if (!state.running || !state.autoMode) break;

            const rowCount = document.querySelectorAll(SEL.row).length;
            if (rowCount === 0) {
                addLog("当前页无数据，可能已全部处理完", "info");
                break;
            }

            // 1. 扫描并勾选（命中人脸/人名的行）
            addLog(`【第${state.batchCount + 1}批】扫描 ${rowCount} 条...`, "ok");
            state.processedKeys.clear();
            state.hitCount = 0; state.faceHits = 0; state.nameHits = 0; state.skippedCount = 0;
            updatePanel();
            await scanPage();
            if (!state.running || !state.autoMode) break;
            addLog(`扫描完成，命中 ${state.hitCount} 条`, "ok");

            // 2. 批量正确（有勾选命中才执行）
            if (state.hitCount > 0) {
                const okCorrect = await clickBatchAndConfirm("批量正确");
                if (!state.running || !state.autoMode) break;
                if (okCorrect) {
                    addLog("等待页面刷新...", "info");
                    await waitForRowCountChange(rowCount, CONFIG.refreshWaitMax);
                    await waitForTableSettled(CONFIG.refreshWaitMax, 1000);
                } else {
                    addLog("「批量正确」未成功，直接进入全选判错", "info");
                }
            }

            // 3. 全选剩余数据
            if (!state.running || !state.autoMode) break;
            addLog("全选剩余数据...", "info");
            selectAllRows();
            await delay(600);

            // 4. 批量错误（处理剩余未命中的）
            const beforeFirstKey = (() => {
                const first = document.querySelector(SEL.row);
                return first ? first.getAttribute("data-row-key") : null;
            })();
            const okError = await clickBatchAndConfirm("批量错误");
            if (!state.running || !state.autoMode) break;
            if (!okError) {
                addLog("「批量错误」未成功，等待后重试", "info");
                await delay(CONFIG.batchActionWait);
                continue;
            }

            // 5. 等待系统更新下一批数据（20秒内无数据则停止）
            addLog("等待系统更新下一批数据（20秒内无数据则停止）...", "info");
            const nextRows = await waitForNextBatch(beforeFirstKey, CONFIG.nextBatchWaitMax);
            if (!state.running || !state.autoMode) break;
            if (nextRows === 0) {
                addLog("20秒内未出现新数据，全部处理完成，停止", "ok");
                break;
            }

            state.batchCount++;
            addLog(`✅ 第${state.batchCount}批处理完成，当前 ${nextRows} 条`, "ok");
            updatePanel();
        }

        state.batchLoopRunning = false;
        addLog("===== 自动批处理结束 =====", "info");
        stopRun();
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
                // 自动批处理模式由主循环控制流程，避免与 React 渲染竞争（insertBefore 报错来源）
                if (state.autoMode) continue;
                addLog("检测到翻页，重置并重新扫描…", "info");
                state.processedKeys.clear();
                state.hitCount = 0;
                state.faceHits = 0;
                state.nameHits = 0;
                state.skippedCount = 0;
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
                if (state.running && !state.autoMode) scanPage();
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
    // 探测图片 URL（验证能否直接下载图片，用于批量加速方案的可行性判断）
    // =======================================================================
    async function probeImageUrls() {
        const imgs = document.querySelectorAll(SEL.image);
        if (imgs.length === 0) {
            addLog("探测：当前页未找到图片缩略图", "info");
            console.log("[探测] 未找到 .ant-image-img");
            return;
        }

        // 收集去重后的 URL
        const seen = new Set();
        const urls = [];
        imgs.forEach((img) => {
            const src = img.currentSrc || img.src || img.getAttribute("data-src") || "";
            if (src && !seen.has(src)) {
                seen.add(src);
                urls.push(src);
            }
        });

        console.log(`[探测] 缩略图 ${imgs.length} 个，唯一 URL ${urls.length} 个：`);
        urls.forEach((u, i) => console.log(`  [${i}] ${u}`));
        addLog(`探测：找到 ${urls.length} 个唯一图片URL，已打印到控制台`, "info");

        // 对前 3 个 URL 做 GET 下载探测，确认状态码 / 大小 / 类型
        const probeCount = Math.min(3, urls.length);
        for (let i = 0; i < probeCount; i++) {
            const info = await probeDownload(urls[i]);
            const ok = info.indexOf("200") === 0;
            addLog(`探测[${i}] ${info}`, ok ? "ok" : "info");
        }
        addLog("探测完成：请打开控制台(F12)查看完整 URL 列表", "info");
    }

    function probeDownload(url) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                responseType: "blob",
                timeout: 8000,
                onload(r) {
                    let size = 0;
                    let ctype = "";
                    try { size = r.response ? r.response.size : 0; } catch (e) {}
                    try {
                        const h = r.responseHeaders || "";
                        const m = h.match(/content-type:\s*([^\r\n]+)/i);
                        if (m) ctype = m[1].trim();
                    } catch (e) {}
                    resolve(`HTTP ${r.status} ${size}字节 ${ctype}`);
                },
                onerror() { resolve("网络错误(可能跨域/防盗链/鉴权被拒)"); },
                ontimeout() { resolve("超时(>8s)"); },
            });
        });
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
                <div class="cfg-row">
                    <label>分数阈值</label>
                    <input id="cfg-score" type="number" value="${CONFIG.scoreThreshold}" min="0" max="100" style="width:50px">
                    <span>分以下跳过</span>
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
                    <label class="toggle-label">
                        <input type="checkbox" id="toggle-skip-low" ${CONFIG.skipLowScore ? "checked" : ""}>
                        <span>低分跳过</span>
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
                    <div class="stat-item">
                        <div class="stat-val" id="stat-skip">0</div>
                        <div class="stat-label">跳过</div>
                    </div>
                </div>
                <div class="progress-wrap">
                    <div class="progress-bar" id="progress-bar"></div>
                </div>
                <div class="auto-row">
                    <label class="toggle-label auto-label">
                        <input type="checkbox" id="toggle-auto">
                        <span>自动批处理（扫描→批量正确→全选→批量错误→下一批）</span>
                    </label>
                </div>
                <div class="btn-row">
                    <button id="btn-start" class="btn btn-go">▶ 开始扫描</button>
                    <button id="btn-stop" class="btn btn-stop" disabled>■ 停止</button>
                    <button id="btn-rescan" class="btn btn-rescan">↻ 重新扫描</button>
                </div>
                <div class="btn-row">
                    <button id="btn-debug-shot" class="btn btn-debug">📷 截图验证</button>
                    <button id="btn-probe-url" class="btn btn-debug">🔍 探测图片URL</button>
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
    display:grid;grid-template-columns:repeat(6,1fr);gap:4px;
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
.auto-row { margin-bottom:8px; }
.auto-label { color:#d46b08;font-weight:600;font-size:12px; }
`;
        document.head.appendChild(css);

        // 拖拽
        initDrag(panel, panel.querySelector("#panel-header"));

        // 按钮事件
        document.querySelector("#btn-start").addEventListener("click", startRun);
        document.querySelector("#btn-stop").addEventListener("click", stopRun);
        document.querySelector("#btn-rescan").addEventListener("click", () => {
            state.processedKeys.clear();
            state.hitCount = 0; state.faceHits = 0; state.nameHits = 0; state.skippedCount = 0;
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
        document.querySelector("#cfg-score").addEventListener("change", function () {
            CONFIG.scoreThreshold = Math.max(0, parseInt(this.value) || 0);
            addLog("分数阈值: " + CONFIG.scoreThreshold + " 分以下跳过", "info");
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
        document.querySelector("#toggle-skip-low").addEventListener("change", function () {
            CONFIG.skipLowScore = this.checked;
            addLog("低分跳过: " + (this.checked ? "开启" : "关闭"), "info");
        });
        document.querySelector("#toggle-auto").addEventListener("change", function () {
            state.autoMode = this.checked;
            addLog("自动批处理: " + (this.checked ? "开启" : "关闭"), "info");
        });

        // 探测图片 URL 按钮
        document.querySelector("#btn-probe-url").addEventListener("click", probeImageUrls);

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
        set("#stat-skip", state.skippedCount);
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
        state.hitCount = 0; state.faceHits = 0; state.nameHits = 0; state.skippedCount = 0;
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
        if (state.autoMode) {
            addLog("自动批处理模式：扫描→批量正确→全选→批量错误→下一批，循环...", "info");
            autoBatchLoop();
        } else {
            scanPage().then(() => {
                if (state.running) {
                    addLog("首轮扫描完成，等待翻页或滚动触发…", "ok");
                }
            });
        }
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
        setupErrorSuppression();
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
