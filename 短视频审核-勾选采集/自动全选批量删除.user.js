// ==UserScript==
// @name         短剧审核-自动全选批量删除
// @namespace    https://github.com/elben-fier/short-drama-review
// @version      1.0.0
// @description  自动全选当前页并批量删除，循环直到删完，每轮删除后等待10秒
// @author       Auto
// @match        https://tools.vobile.cn/quality/qualityTest*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        batchDeleteText: "批量删除", // 批量删除按钮上的文字（用于定位）
        waitAfterDelete: 10000,      // 每轮删除后等待时间(ms)
        modalWaitMax: 5000,          // 确认弹窗最长等待时间(ms)
        tableWaitMax: 20000,         // 表格刷新最长等待时间(ms)
    };

    const state = {
        running: false,
        roundCount: 0,
    };

    const SEL = {
        row: "tr.ant-table-row.ant-table-row-level-0",
        selectAll: ".ant-table-thead input.ant-checkbox-input",
        tbody: ".ant-table-tbody",
    };

    const delay = ms => new Promise(r => setTimeout(r, ms));

    // ========== 日志 ==========
    function log(msg) {
        console.log("[批量删除] " + msg);
        const el = document.querySelector("#del-log");
        if (!el) return;
        const line = document.createElement("div");
        line.textContent = "[" + new Date().toLocaleTimeString() + "] " + msg;
        el.prepend(line);
        while (el.children.length > 200) el.lastChild.remove();
    }

    // ========== 元素查找 ==========
    const findByText = (root, selector, text) => {
        const elements = (root || document).querySelectorAll(selector);
        const needle = (text || "").replace(/\s+/g, "");
        for (const el of elements) {
            if ((el.textContent || "").replace(/\s+/g, "").includes(needle)) return el;
        }
        return null;
    };

    // 等待确认弹窗内的确定/确认/删除按钮出现
    async function waitForConfirmBtn(timeout) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            // 策略1: ant-popconfirm 内的按钮
            const pcs = document.querySelectorAll(".ant-popconfirm");
            for (const pc of pcs) {
                if (pc.offsetParent === null) continue; // 不可见跳过
                const btns = pc.querySelectorAll("button");
                for (const btn of btns) {
                    const txt = btn.textContent.replace(/\s+/g, "");
                    if (txt.includes("确定") || txt.includes("确认") || txt.includes("删除")) {
                        return btn;
                    }
                }
            }
            // 策略2: ant-modal 内的 primary 按钮
            const modals = document.querySelectorAll(".ant-modal-wrap, .ant-modal");
            for (const modal of modals) {
                if (modal.offsetParent === null) continue;
                const btns = modal.querySelectorAll("button.ant-btn-primary");
                for (const btn of btns) {
                    const txt = btn.textContent.replace(/\s+/g, "");
                    if (txt.includes("确定") || txt.includes("确认") || txt.includes("删除")) {
                        return btn;
                    }
                }
            }
            await delay(200);
        }
        return null;
    }

    // 全选当前页所有行
    function selectAllRows() {
        const selectAll = document.querySelector(SEL.selectAll);
        if (!selectAll) return false;
        if (!selectAll.checked) selectAll.click();
        return true;
    }

    // 点击批量删除按钮 + 确认弹窗
    async function clickBatchDelete() {
        let batchBtn = findByText(document, "button", CONFIG.batchDeleteText);
        if (!batchBtn) {
            log("未找到「" + CONFIG.batchDeleteText + "」按钮");
            return false;
        }
        if (batchBtn.disabled) {
            log("批量删除按钮已禁用（可能无勾选项）");
            return false;
        }

        batchBtn.click();
        await delay(800);

        const confirmBtn = await waitForConfirmBtn(CONFIG.modalWaitMax);
        if (confirmBtn) {
            confirmBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            confirmBtn.click();
            confirmBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
            return true;
        }
        log("未找到确认弹窗按钮");
        return false;
    }

    // 等待表格稳定（行数连续不变）
    async function waitForTableSettled(timeout) {
        const start = Date.now();
        let lastCount = document.querySelectorAll(SEL.row).length;
        let stableSince = Date.now();
        while (Date.now() - start < timeout) {
            await delay(400);
            const count = document.querySelectorAll(SEL.row).length;
            if (count === lastCount) {
                if (Date.now() - stableSince >= 1200) return count;
            } else {
                lastCount = count;
                stableSince = Date.now();
            }
        }
        return document.querySelectorAll(SEL.row).length;
    }

    // ========== 主循环 ==========
    async function runLoop() {
        while (state.running) {
            // 等表格稳定
            await waitForTableSettled(CONFIG.tableWaitMax);

            const rows = document.querySelectorAll(SEL.row);
            if (rows.length === 0) {
                log("已无数据，全部删除完成");
                break;
            }

            log("当前 " + rows.length + " 条数据，全选...");
            selectAllRows();
            await delay(500);

            const ok = await clickBatchDelete();
            if (!ok) {
                log("批量删除未成功，停止");
                break;
            }

            state.roundCount++;
            log("第 " + state.roundCount + " 轮删除完成，等待 " + (CONFIG.waitAfterDelete / 1000) + " 秒...");
            updatePanel();

            // 等待 10 秒（系统处理删除并刷新数据）
            await delay(CONFIG.waitAfterDelete);
        }
        log("===== 全部删除完成 =====");
        stopRun();
    }

    // ========== 面板 ==========
    function updatePanel() {
        const el = document.querySelector("#del-round");
        if (el) el.textContent = state.roundCount;
    }

    function buildPanel() {
        if (document.querySelector("#del-panel")) return;
        const panel = document.createElement("div");
        panel.id = "del-panel";
        panel.innerHTML = `
            <div class="del-title">自动批量删除</div>
            <div class="del-body">
                <div class="del-stat">已删轮次：<b id="del-round">0</b></div>
                <div class="del-row">
                    <button id="del-start" class="del-btn del-go">开始删除</button>
                    <button id="del-stop" class="del-btn del-stop" disabled>停止</button>
                </div>
                <div class="del-tip">每轮：全选 → 批量删除 → 确认 → 等待10秒 → 下一轮，直到删完</div>
                <div class="del-log" id="del-log"></div>
            </div>
        `;
        document.body.appendChild(panel);

        const css = document.createElement("style");
        css.textContent = `
            #del-panel{position:fixed;top:100px;right:20px;width:250px;background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);z-index:999999;font-size:13px;font-family:system-ui,sans-serif;}
            .del-title{padding:10px 14px;background:#ff4d4f;color:#fff;border-radius:8px 8px 0 0;font-weight:600;cursor:move;user-select:none;}
            .del-body{padding:12px 14px;}
            .del-stat{margin-bottom:8px;color:#333;}
            .del-stat b{color:#ff4d4f;font-size:16px;}
            .del-row{display:flex;gap:8px;margin-bottom:8px;}
            .del-btn{flex:1;padding:6px 0;border:none;border-radius:4px;cursor:pointer;font-size:13px;}
            .del-btn:disabled{opacity:.45;cursor:not-allowed;}
            .del-go{background:#ff4d4f;color:#fff;}
            .del-stop{background:#f5f5f5;color:#333;border:1px solid #d9d9d9;}
            .del-tip{font-size:11px;color:#999;margin-bottom:8px;line-height:1.5;}
            .del-log{max-height:180px;overflow-y:auto;background:#fafafa;border-radius:4px;padding:6px 8px;font-size:11px;font-family:Consolas,monospace;line-height:1.6;color:#666;word-break:break-all;}
        `;
        document.head.appendChild(css);

        // 拖拽
        let dragging = false, ox = 0, oy = 0;
        const title = panel.querySelector(".del-title");
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

        document.querySelector("#del-start").addEventListener("click", startRun);
        document.querySelector("#del-stop").addEventListener("click", stopRun);
    }

    function startRun() {
        if (state.running) return;
        state.running = true;
        state.roundCount = 0;
        document.querySelector("#del-start").disabled = true;
        document.querySelector("#del-stop").disabled = false;
        updatePanel();
        runLoop();
    }

    function stopRun() {
        state.running = false;
        const startBtn = document.querySelector("#del-start");
        const stopBtn = document.querySelector("#del-stop");
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
