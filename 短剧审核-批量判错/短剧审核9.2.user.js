// ==UserScript==
// @name         Shift短剧审核-相似度矩阵版【9.2】
// @namespace    https://doubao.com/userscripts
// @version      9.2.1
// @description  判定结果可上报本地后端日志（POST /judge_log，记录子样本第一条id与判定原因）；除硬规则（关键词双列比对、母本最高分(第5列)<90）外一律展开核对（子样本得分0=没刷新出来，不计入统计）：低分(<80)条数 > 正确数据条数 → 全错；否则 得分≥93 的条数≥4 或 状态码777/601达标（有效行≤30条的小合集≥2、大合集≥4）→ 全剧审核，都不满足 → 全选+批量错误后点「查询」刷新；含关键词双列比对（命中词第4列缺任一即全错）、30s/60s重试、永久跳过、严格等待加载、慢处理档位与预演模式
// @author       Doubao
// @match        https://tools.vobile.cn/quality/dramaReview*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-end
// ==/UserScript==

// ============================== 当前机制摘要（完整变更史见 docs/版本演进记录.md） ==============================
//  【判定链】硬规则（命中即模式2全错，不看子样本）：
//      ① 关键词双列比对：第3列命中的关键词，只要有任一个在第4列没有 → 全错
//         （9.4.0 起取消"终极关键词"，全部关键词都走这条；两列都有则放行继续判定）
//      ② 母本最高分 < lowScoreFloor(默认90)
//    其余一切情况（相似/不相似、母本最高分高低/读不到）→【展开核对】：
//      · 子样本得分 = 0 或读不到的行走 =「还没刷新出来」→ 整行不计入任何统计（9.3.0）
//      · 低分(<80)条数 > 正确数据条数 → 模式2 全错（9.3.0 新增，优先于"高分够多"）
//      · 否则 得分≥93 的条数 ≥ 4 或 状态码 777/601 各自达标
//        （有效行 ≤ 30 条的小合集 ≥ 2；> 30 条的大合集 ≥ 4）→ 模式1（点「全剧审核」）
//      · 都不满足 → 模式2（全选 + 批量错误 → 等全部 594 → 点页面「查询」刷新列表）
//    "正确数据" = 判定码 777/601 或 得分≥93（同一行只算一次）。
//    相似度与母本最高分不再决定通过与否，只写进判定日志与判定理由（v9.1.7 起）。
//  【术语】母本最高分 = 母本第5列 = 子样本单条分的最大值（面板「母本最高分」只影响日志标签，
//      「母本最低线」=90 分底线：最高分低于它一律全错）；单条分 = 子样本第8列（高分≥93 / 低分<80）。
//  【扫描与结束】每轮从面板「起始行号」往下扫；只认**母本行**（9.4.2：子表行的 class 与母本行相同，
//      必须用 isChildTableRow()/getParentRows() 排掉，否则会把展开区里的子样本行当成母本行）；
//      「已审核」只作边界（说明下面都已审过）；
//      第2列 id 读不到的异常行跳过继续看；扫不到可审行时点「查询」刷新确认两次，
//      确认页面除「已审核」与「已跳过的异常数据」外没有未审核行 → 判定审核结束（v9.2.0）。
//  【母本最高分读不到】先等加载完成并重读 N 次；仍读不到 = "母本还没刷新好" → 本轮跳过该合集、
//      继续审别的行，刷新列表后自动重试，结束时汇总（不再中断整轮，v9.2.1）。
//  【稳定性】严格等待加载（转圈闸门）、30s/60s 重试、异常永久跳过、慢处理档位（集数 > 300
//      时所有等待闸门放宽，v9.1.9）、判定日志上报 POST /judge_log（v9.1.5）。
//  【预演模式】面板勾选「预演（只判定不点击）」→ 判定链与上报照跑，但不点任何按钮（9.3.0；9.4.2 起
//      预演读完统计会把自己展开的合集收起，避免子表行留在 DOM 里），
//      用于改规则后先在真实页面空跑核对结果。
//  【9.4.3 修复（代码审查发现）】
//      ① 上报上下文串台：进入 processOneCollection 先清空 state.lastJudge —— 否则"第0步
//         （上一轮加载未完成）"提前 return 时，会把上一个合集的 childId/关键词写进这一条的日志；
//      ② 判定码与"正确数据"口径不一致：777/601 行即使分数没刷新也计入"正确数据"
//         （原来会出现"码已够 4 条 但 correct=0"被低分规则误判全错的自相矛盾）；
//      ③ 全选兜底：selectAllChildRows 改为返回"实际处于勾选状态的行数"，避免"这些行本来就勾着"
//         时返回 0 被当成"勾选失败"而把合集永久跳过；
//      ④ 确认弹窗：等转圈期间弹窗可能已关闭/被重渲染 —— 点击前重新确认按钮仍在，并返回真实点击结果
//         （原来无论点没点到都当成功，会白等一轮再把这合集当异常跳过）；
//      ⑤ 展开区节点失效：waitAllJudged 每轮用 resolveExpandedRow() 重新定位展开行（React 重渲染后）；
//      ⑥ 子表分页预警：子表若带分页，"全选"可能只勾当前页 → 模式2 永远等不到全部 594，现会提示；
//      ⑦ 母本行过滤自检：过滤后为 0 行会明确报错，避免静默空跑；
//      ⑧ 「复制跳过清单」补上"还没刷新好（母本最高分读不到）"的合集明细；
//      ⑨ 全剧审核/查询刷新的完成判定改为"按合集 id 是否还在列表里"（原来只看 workIndex 那一格，
//         列表重排后那一格会换成别的合集 → 把这个合集误判成已完成而漏掉）；
//      ⑩ 判定日志上报遇到非 2xx 也进冷却（原来只有网络错误才冷却，后端报 404/500 时会刷屏）。
//  【9.4.4 修复（独立审查第二轮）】
//      ⑪【重要】子样本"有效行为 0"（得分全是 0/读不到）时不再判全错 —— 原来会真的全选+批量错误打 594；
//         现在与"母本最高分读不到"同一套：本轮跳过、刷新列表后自动重试；
//      ⑫ 点击按钮改用 safeClick 的返回值（原来丢弃返回值 → 元素失效时"没点到"也被当成已提交）；
//      ⑬ 确认弹窗只在【点击后新出现的】弹窗里找确定键（原来全文档找第一个"确定/确认/删除"，
//         可能点到页面自带弹窗）；找不到新弹窗时才退回原来的宽松查找；
//      ⑭ 按「停止」不再给被打断的合集写一条假的判定日志（reportJudge 移到停止判断之后）；
//      ⑮ "跳过满上限"与"真的审完"在结束弹窗里区分开（原来都会显示"处理完成！"）；
//      ⑯ 主循环同一合集连续异常 maxErrTriesPerRow(3) 次就永久跳过（唯一可能原地打转的地方）；
//      ⑰ 母本行已从列表消失时立即停止重读（不再白跑剩下的重读轮次，首轮还压在 90s 闸门里）；
//      ⑱ 上报的 counts 按 CONFIG.judgeCodes 动态生成（原来写死 judge777/judge601）。
//  【版本号提醒】文件内部版本见上方 @version；历史文件「短剧审核9.0」也用过内部号 9.2.0，勿混淆。
//  注意：9.4.2 那版的上报字段 version 漏改，日志里显示的是 9.4.1（9.4.3 起已跟随版本）。
//  规则拆解：docs/短剧审核9.1判定机制详解.md ｜ 逐版本变更史：docs/版本演进记录.md
//  注：9.2.2 仅把原先堆在这里的 164 行逐版变更记录并入上述文档，脚本代码未改动。
// ==========================================================================
// ============================== 9.2.1 系统更新：0 分行不会被改成 594（判错完成判定只认"有效行"） ==============================
//  【系统更新（2026-10-11 实机）】批量错误之后，**"得分为 0/读不到"的行状态码不会变**
//      （它们仍是原码，不会变成 594）。
//  【影响】旧判据是"全部子样本 = 594 才算判错完成" → 只要合集里有 1 条 0 分行，
//      这个条件**永远不可能满足** → 每个这样的合集都会白等 90/150s（还包含 30s/60s 两次重试），
//      然后被当成"处理异常"**永久跳过**；跳过满 maxSkipCount(20) 个还会把整轮停掉。
//      换句话说：全错判定其实已经提交成功了，脚本却以为失败。
//  【本次】完成判定改为只看**有效行**（有效行 = 得分非 0 且可读的行）：
//      · getCodeStats 新增 `validWrong`（有效行里已是 594 的条数）
//      · waitAllJudged 用 "validWrong === valid && 无转圈" 判完成（进度条也按有效行显示）
//      · 若**一条有效行都没有** → 系统不会产生任何 594，直接视为"批量错误这一步已完成"，
//        并打印警告日志（继续走 查询刷新），不再白等
//      · 日志/超时原因都改为按有效行口径，并注明有多少条 0 分行被忽略
//  【不变】判定规则、展开核对、扫描与结束、预演、慢处理等全部不动。
// ==========================================================================
// ============================== 9.2.0 页面改版适配（子表新增一列）+ 收尾收起全部母本行 ==============================
//  【页面变化】展开合集后，子样本表在**第3列插入了 episode-index**，原来的状态码(hide-flag)
//      被顶到**第4列**，其后各列整体右移一位 → 单条分从第8列变成**第9列**。
//      本版据此更新 SELECTORS：childCodeCell 第3列 → **第4列**；childScoreCell 第8列 → **第9列**。
//      ⚠️ 得分列右移是"插入一列"的必然推论（页面未明说），已加自检帮你确认（见 ④）。
//  【本次改动】
//      ① 上述子表列号适配（9.2.0 的核心）；
//      ② 关键词表按需求更新：移除「短剧」「动」「果」，现为 22 个词；
//      ③ 处理完并显示"审核完成"之前，**收起页面上全部已展开的母本行**
//         （collapseAllExpandedRows()，点 .ant-table-row-expand-icon-expanded / aria-label="关闭行"）；
//      ④ 新增"子表列结构自检"：每轮第一次展开时，把子表列头 + 首行各列文本 + 当前解析到的
//         状态码列/单条分列的值打到控制台（F12）与面板日志，一眼就能核对列号。
//  【版本号说明（重要）】文件名 9.2 = 面向页面的代际；本文件内部 @version 从 9.2.0 重新计。
//      历史：短剧审核9.0 内部编到过 9.2.0、短剧审核9.1 内部编到 9.4.4 —— 三者是不同文件，
//      看到版本号时请以 @name 里的【9.2】/【9.1】/【9.0】为准。
//  【与 9.1 的关系】9.1 的判定逻辑与本文件一致，但**列号是旧的**（状态码第3列/得分第8列），
//      在改版后的页面上会读错列 —— 同一页面请只启用本文件（9.2），并把 9.1 停用。
// ==========================================================================

(function () {
  'use strict';

  console.log('[短剧审核9.2] 相似度矩阵版已加载');

  // ========== 可配置项 ==========
  const CONFIG = {
    // —— 模式判定（9.1.0：相似度 × 母本最高分 二维判定）——
    parentScoreThreshold: 95,      // 匹配最高分(第5列)：相似 且 > 该值 → 展开核对高分明细（9.1.3）
    highScoreThreshold: 93,        // 【展开核对】子样本得分(第8列) ≥ 该值 视为"高分数据"（9.3.0：95 → 93）
    lowScoreThreshold: 80,         // 9.3.0：子样本得分(第8列) 在 (0, 该值) 之间 视为"低分数据"
    dryRun: false,                 // 9.3.0：预演模式——判定与上报照跑，但不点任何按钮（面板可勾选，用于验证规则）
    highScoreMinCount: 4,          // 【展开核对】高分明细 ≥ 该条数 → 模式1（全剧审核）
    queryBtnText: '查询',          // 全错处理后的收尾：点击页面「查询」按钮刷新列表（不再点全剧审核）
    endConfirmRounds: 2,           // 9.2.0：扫不到可审行时，点「查询」刷新确认的次数（0=不确认直接结束）
    endConfirmSettleMs: 1500,      // 9.2.0：每次刷新确认后额外的稳定等待(ms)，等列表重排完再重扫
    lowScoreFloor: 90,             // 【母本最低线】母本最高分(第5列) < 该值 → 一律全错（90 分是底线：
                                   //   即使子样本 777/601 够多也不救）；0=关闭
    judgeCodes: ['777', '601'],    // 需要展开时统计的子样本状态码（两个码各自计数）
    correctCodeMinCount: 4,        // 【大合集】任一 judgeCode 的条数 ≥ 该值 → 模式1（子样本 > smallCollectionMaxRows 条时用）
    correctCodeMinCountSmall: 2,   // 【小合集】子样本 ≤ smallCollectionMaxRows 条时，门槛降为 ≥ 该值
    smallCollectionMaxRows: 30,    // 小合集的判定边界：子样本条数 ≤ 该值 视为小合集（9.1.8）
    scoreRetryCount: 3,            // 9.2.1：母本最高分读不到时，先等加载完成并重读几次；仍读不到才算"还没刷新好"
    scoreRetryGapMs: 1200,         // 9.2.1：母本最高分重读的间隔(ms)
    scoreSkipWarnCount: 5,         // 9.2.1：本轮"还没刷新好"累计到该条数时，提示检查第5列选择器（只提示，不停止运行）
    scoreGiveUpRounds: 3,          // 9.2.1：同一合集最多尝试几次（每次都是"重读+跳过+等下次刷新"）；超过则本轮彻底放弃并汇总
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
    confirmReadyWaitMax: 20000,    // 9.1.9：点确认前的"弹窗就绪"等待（配合严格等待）
    confirmReadyWaitMaxSlow: 40000,// 9.1.9：慢合集的"弹窗就绪"等待（放宽；原来硬编码 20s，慢合集也只有一个档）
    batchBtnWaitMax: 5000,         // 按钮从禁用变可用最长等待
    checkInterval: 500,            // 轮询间隔
    // —— 关键词（9.4.0：取消"终极关键词"，全部走双列比对；第3列命中的任一个词在第4列没有 → 全错）——
    nameKeywords: ['画', '漫剧', 'AI', '充电', '红果', '专属', '动画', '免费', '剪辑', '花絮', '拍摄', '经典', '剧', '真人', '免', '动漫', '&', '定档', '首播', '漫', 'ai', '论剑大会'],   // 9.2.0：按需求移除「短剧」「动」「果」
    // —— 9.4.0：原「终极关键词」表已取消 ——
    //   原先 12 个终极词里 11 个本就在 nameKeywords 中（「充电专属」由「充电」「专属」覆盖），
    //   唯一不在表里的「论剑大会」已补进 nameKeywords；现在所有关键词一律走双列比对。
    // —— 相似度：第3列短剧名 vs 第4列(疑似抄袭的原短剧名) ——
    //   9.1.0：所有文本都比对相似度（不再限制短剧名字数）
    similarMinSubstr: 2,           // 存在连续 N 个字相同（如"渐染"）即算相似
    similarMinCommonChars: 3,      // 或 两段文本公共的不同字 ≥ N 个
    // —— 判定日志上报（9.1.5：POST 到本地后端 /judge_log）——
    reportEnabled: true,                     // 是否上报判定日志（面板可开关）
    backendBase: 'http://127.0.0.1:5002',    // 后端地址（接口为 /judge_log）
    reportTimeoutMs: 8000,                   // 单次上报超时(ms)
    reportRetryCooldownMs: 60000,            // 上报失败后的冷却(ms)，避免后端没开时刷屏
    // —— 运行 ——
    startRow: 1,                   // 起始行号（1开始）
    afterProblemDelay: 2000,       // 跳过合集后等待再继续
    maxSkipCount: 20,              // 最多跳过多少个合集（安全上限，超过则停止提示人工）
    maxErrTriesPerRow: 3,          // 9.4.4：同一合集连续抛异常多少次就永久跳过（防止原地重试不前进）
  };

  // ========== 运行状态 ==========
  const state = {
    running: false,
    processedCount: 0,
    mode1Count: 0,       // 直接全剧审核次数
    mode2Count: 0,       // 全选判错次数
    notReadyIds: new Set(),  // 9.2.1：母本最高分读不到 =「母本还没刷新好」的合集id（本轮先跳过，列表刷新后自动重试）
    notReadyList: [],        // 9.2.1：明细 {id,name,row,raw,tries,time}，结束时汇总提示
    notReadyTries: new Map(),// 9.2.1：id → 已跳过次数（超过 scoreGiveUpRounds 就本轮彻底放弃，防来回打转）
    giveUpIds: new Set(),    // 9.2.1：本轮彻底放弃的合集id（母本最高分始终读不到，需人工处理）
    errTries: new Map(),     // 9.4.4：id → 主循环异常次数（超过 maxErrTriesPerRow 就永久跳过，防原地重试）
    doneIds: new Set(),  // 9.1.3：本轮已成功处理过的合集id（查询后可能仍留在列表里，避免重复处理）
    lastJudge: null,     // 9.1.5：本轮判定的上下文（子样本首条id/相似/关键词/统计），供上报日志用
    workIndex: 0,        // 当前工作行（0=第1行）
    skipIds: new Set(),  // 已永久跳过的合集id（本轮不再处理）
    skipList: [],        // 跳过明细：{id,name,reason,time}
    judgeDone: 0,        // 594已完成数
    judgeNeed: 0,        // 594需要总数
    curSlow: false,      // 9.1.9：当前合集是否按"慢处理"档位等待（集数 > slowEpisodeThreshold）
  };

  // ========== 元素选择器 ==========
  const SELECTORS = {
    // 母本行。注意：antd 的子表行同样带 ant-table-row-level-0，所以取母本行必须用
    // getParentRows()（会排掉"展开区里的子表行"），不能直接用它全文档查 —— 见 9.4.2
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
    childCodeCell: 'td:nth-child(4)',    // 子样本状态码（9.2.0：页面在第3列插入了 episode-index，状态码/hide-flag 移到第4列）
                                        //   取值：0=未判定 594=判错完成 777/601=前人已判定(有正确数据)
    childScoreCell: 'td:nth-child(9)',   // 子样本单条分（9.2.0：第3列插入新列后整体右移一位，8 → 9）
    childIdCell: 'td:nth-child(2)',      // 9.1.5：子样本第一条的 id（上报判定日志用；按要求不用母本id）
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
    console.log('[短剧9.2] ' + msg);
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
    catch (e) { console.warn('[短剧9.2] 点击失败:', e.message || e); return false; }
  }

  // 9.1.9：当前合集的「等待加载完成」上限——慢合集取更宽的档位
  // 原实现只有部分位置判断了慢处理，导致 expandRowAndWait 内部、点击前闸门、勾选前后闸门
  // 无论快慢都按普通档走；这里统一取值，让「慢处理」真正全量生效。
  function loadWaitMax() {
    return state.curSlow ? CONFIG.loadingWaitMaxSlow : CONFIG.loadingWaitMax;
  }

  // ========== 9.2.1：母本最高分（第5列）读取 ==========
  // 读不到 ≠ 页面改版：多数情况是母本还没刷新好。这里先重读几次，仍读不到就交给上层
  // 按「还没刷新好」处理（本轮先跳过该合集、继续审别的行，刷新列表后自动重试）。
  function readParentScore(R) {
    const el = R ? R.querySelector(SELECTORS.parentScoreCell) : null;
    const raw = ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
    return { score: parseNum(raw), raw: raw };
  }

  // 重读若干次；返回 { score, raw }，score 仍为 null 表示确实读不到
  async function waitParentScore(R) {
    let last = readParentScore(R);
    if (last.score !== null) return last;

    const tries = Math.max(0, CONFIG.scoreRetryCount | 0);
    for (let i = 1; i <= tries; i++) {
      if (!state.running) return last;
      setStatus('等母本最高分刷新（第 ' + i + '/' + tries + ' 次）...');
      if (CONFIG.strictLoading && i === 1) await waitLoadingDone('等母本最高分刷新', loadWaitMax());
      await delay(CONFIG.scoreRetryGapMs);
      if (!R || !R.isConnected) {
        // 9.4.4：行都已经不在文档里了 → 立刻返回，不必把剩下的重读轮次（每轮还带 1.2s 等待）跑完
        log('母本行已从列表消失 → 停止重读母本最高分');
        return { score: null, raw: '(行已消失)' };
      }
      last = readParentScore(R);
      if (last.score !== null) {
        log('✓ 母本最高分已刷新出来：' + last.score + '（重读第 ' + i + ' 次）');
        return last;
      }
    }
    return last;
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
  // 9.4.4：点击按钮前先拍一张"当前已有弹窗"的快照；找确定键时优先只看新出现的弹窗
  function snapshotOverlays() {
    return new Set(Array.from(document.querySelectorAll('.ant-popconfirm, .ant-modal-wrap, .ant-modal')));
  }

  function pickConfirmBtnIn(nodes, mode) {
    for (const node of nodes) {
      if (!node.isConnected) continue;
      if (mode === 'popconfirm' && !node.classList.contains('ant-popconfirm')) continue;
      const sel = mode === 'popconfirm' ? 'button' : 'button.ant-btn-primary';
      const btns = node.querySelectorAll(sel);
      for (const btn of btns) {
        const txt = (btn.textContent || '').replace(/\s+/g, '');
        if ((txt.includes('确定') || txt.includes('确认') || txt.includes('删除')) && !txt.includes('取消')) {
          return btn;
        }
      }
    }
    return null;
  }

  // 只认"可见"的弹窗（display:none / opacity:0 视为不可见）
  function visibleOverlays(selector, exclude) {
    const out = [];
    for (const el of document.querySelectorAll(selector)) {
      if (!el.isConnected) continue;
      if (exclude && exclude.has(el)) continue;            // 点击前就存在的 → 排除
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.opacity === '0') continue;
      out.push(el);
    }
    return out;
  }

  async function waitForConfirmBtn(timeout, knownOverlays) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      // 第1轮：优先只在【点击后新出现】的弹窗里找（最不容易误点）
      const freshPc = visibleOverlays('.ant-popconfirm', knownOverlays);
      let btn = pickConfirmBtnIn(freshPc, 'popconfirm');
      if (btn) return btn;
      const freshModal = visibleOverlays('.ant-modal-wrap, .ant-modal', knownOverlays);
      btn = pickConfirmBtnIn(freshModal, 'modal');
      if (btn) return btn;

      // 第2轮：没有新弹窗时，退回原来的宽松查找（保证兼容：有些页面弹窗是复用的旧节点）
      const anyPc = visibleOverlays('.ant-popconfirm', null);
      btn = pickConfirmBtnIn(anyPc, 'popconfirm');
      if (btn) return btn;
      const anyModal = visibleOverlays('.ant-modal-wrap, .ant-modal', null);
      btn = pickConfirmBtnIn(anyModal, 'modal');
      if (btn) return btn;

      await delay(200);
    }
    console.warn('[弹窗定位] 超时，未找到确定按钮');
    return null;
  }

  // 确认弹窗增强点击（7.0：点确定前也要求页面无转圈）
  // 9.1.9：等待弹窗就绪的档位也按"慢处理"分档（原来慢合集也只有硬编码的 20s）
  async function clickConfirm(timeout, knownOverlays) {
    const confirmBtn = await waitForConfirmBtn(timeout, knownOverlays);
    if (!confirmBtn) return false;
    if (CONFIG.strictLoading) {
      await waitLoadingDone('确认弹窗就绪',
        state.curSlow ? CONFIG.confirmReadyWaitMaxSlow : CONFIG.confirmReadyWaitMax);
    }
    // 9.4.3：等转圈的这段时间里弹窗可能已自动关闭 / 被 React 换掉 →
    //   必须重新确认按钮还在，并且真的点到了（否则会把"没点到"当成"已提交"，
    //   后面白等一轮 594 或等合集移走，最后把这个合集误判为异常跳过）
    if (!confirmBtn.isConnected) {
      console.warn('[按钮] 确认按钮在等待期间已失效（弹窗关闭或重渲染）→ 视为未提交');
      return false;
    }
    confirmBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const clicked = safeClick(confirmBtn);
    confirmBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return clicked;
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

  // ========== 关键词规则（8.0 双列比对；9.4.0：取消终极关键词，改"任一命中词缺失即全错"） ==========
  // 把第3列（短剧名）命中的**全部**关键词都拿去和第4列（疑似抄袭原短剧名）比对：
  //   · 命中的词第4列**全都有** → 疑似正确（hit=false, dual=true），继续后面的判定
  //   · 只要有**任一个**命中词第4列没有 → 直接全错（hit=true，missing 列出缺的那些词）
  //   · 第3列一个词都没命中 → hit=false, dual=false（不作为"疑似正确"依据，交给后面的规则）
  // 返回 { hit, dual, kw, matched, missing }
  //   kw      = 上报/日志用的一行文本（命中词；hit 时只列缺失的词）
  //   matched = 第3列命中的全部关键词
  //   missing = 其中第4列没有的词
  function getKeywordRule(parentRow, meta) {
    const name = meta ? meta.name : cellText(parentRow, SELECTORS.parentNameCell);
    const orig = meta ? meta.originalName : cellText(parentRow, SELECTORS.parentOriginalNameCell);
    const empty = { hit: false, dual: false, kw: '', matched: [], missing: [] };
    if (!name) return empty;

    const matched = [];
    const missing = [];
    for (const kw of CONFIG.nameKeywords) {
      if (!kw) continue;
      if (!name.includes(kw)) continue;
      matched.push(kw);
      if (!(orig && orig.includes(kw))) missing.push(kw);
    }
    if (matched.length === 0) return empty;
    if (missing.length === 0) {
      return { hit: false, dual: true, kw: matched.join('/'), matched: matched, missing: [] };
    }
    return { hit: true, dual: false, kw: missing.join('/'), matched: matched, missing: missing };
  }

  // ========== 相似度比对：第3列短剧名 vs 第4列(疑似抄袭的原短剧名) ==========
  // 9.1.0：所有文本都比对（不再限制短剧名字数）
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

  // 相似判定：命中"连续N字相同"或"公共不同字≥N" → 相似
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
        reason: '相似：两列存在连续 ' + lcs + ' 字相同（≥' + CONFIG.similarMinSubstr + '）',
        detail: '最长连续相同 ' + lcs + ' 字 / 公共字 ' + common + ' 个',
      });
    }
    if (common >= CONFIG.similarMinCommonChars) {
      return Object.assign(base, {
        similar: true,
        reason: '相似：两列公共不同字 ' + common + ' 个（≥' + CONFIG.similarMinCommonChars + '）',
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

  // 9.1.5：子样本“第一条”的 id（子样本第2列）—— 判定日志用的就是这个 id（不用母本 id）
  function getFirstChildId(expandedRow) {
    const rows = getChildRows(expandedRow);
    if (!rows.length) return '';
    return cellText(rows[0], SELECTORS.childIdCell);
  }

  // 9.1.5：子样本第一条的整行文本（截断），便于核对"id 是不是取对列了"
  function getFirstChildRowText(expandedRow) {
    const rows = getChildRows(expandedRow);
    if (!rows.length) return '';
    const txt = (rows[0].textContent || '').replace(/\s+/g, ' ').trim();
    return txt.length > 160 ? txt.slice(0, 160) + '…' : txt;
  }

  // 汇总当前展开子表：状态码分布 + 各 judgeCode(777/601) 条数 + 得分分层
  // 9.1.1：展开判定用"777 或 601 的条数（各自计数）"，故这里统计 judgeCounts
  // 9.3.0：得分 = 0 或读不到的行走 =「这条还没刷新出来」→ 不计入 base/低分/高分/正确数据
  // 9.2.1：**系统对"得分为 0/读不到"的行不会改状态码**（实测：批量错误后这些行仍是原码）
  //        → 因此另外统计 validWrong（"有效行"里已是 594 的条数），供"判错完成"判定使用；
  //          wrong/notWrong 仍按全部行统计，只用于日志展示。
  function getCodeStats(expandedRow) {
    const rows = getChildRows(expandedRow);
    const counters = {};
    let unjudged = 0;
    let scoreKnown = 0;         // 能读到得分的条数（便于排查列错）
    let scoreHigh = 0;          // 得分 ≥ highScoreThreshold(93) 的条数
    let scoreLow = 0;           // 9.3.0：0 < 得分 < lowScoreThreshold(80) 的条数
    let notReady = 0;           // 9.3.0：得分 = 0 或读不到 → 视为还没刷新，不计入判定统计
    let correct = 0;            // 9.3.0：正确数据行数（判定码 777/601 或 高分；同一行只算一次）
    let validWrong = 0;         // 9.2.1：**有效行**里状态码已是 594 的条数（判错完成判定用）
    const judgeCounts = {};     // 9.1.1：各 judgeCode 的子样本条数，如 {777: 5, 601: 0}
    CONFIG.judgeCodes.forEach((c) => { judgeCounts[c] = 0; });
    rows.forEach((row) => {
      const sc = parseNum(cellText(row, SELECTORS.childScoreCell));
      const notReadyRow = (sc === null || sc === 0);   // 9.3.0：0 分/读不到 = 还没刷新出来

      const code = getChildCode(row);
      counters[code] = (counters[code] || 0) + 1;
      // 空值也视为未判定（避免列结构异常时被误认为已完成）
      if (code === CONFIG.unjudgedCode || code === '') unjudged++;
      const isJudgeCode = CONFIG.judgeCodes.includes(code);
      if (isJudgeCode) judgeCounts[code] = (judgeCounts[code] || 0) + 1;

      // 9.4.3：判定码(777/601)是"前人已判定"的证据，与得分有没有刷新无关 →
      //   无论该行分数是否可读，都计入"正确数据"。
      //   （否则会出现自相矛盾：judgeCounts 里 777 已够 4 条，但 correct=0，被低分规则判全错）
      const isHigh = !notReadyRow && sc >= CONFIG.highScoreThreshold;
      if (isJudgeCode || isHigh) correct++;
      if (notReadyRow) { notReady++; return; }         // 分数相关统计（有效行/低分/高分）不含该行

      scoreKnown++;
      if (code === CONFIG.wrongCode) validWrong++;     // 9.2.1：只数"有效行"的 594
      if (isHigh) scoreHigh++;
      else if (sc < CONFIG.lowScoreThreshold) scoreLow++;
    });
    const detail = Object.keys(counters)
      .map((k) => (k === '' ? '(空)' : k) + '×' + counters[k])
      .join(', ');
    const wrongCount = counters[CONFIG.wrongCode] || 0;
    const validRows = rows.length - notReady;
    return {
      total: rows.length,                // 展开后渲染出的全部行数
      valid: validRows,                  // 9.3.0：有效行数（不含 0 分/读不到）
      notReady: notReady,                // 9.3.0：0 分/读不到的行数
      unjudged: unjudged,
      wrong: wrongCount,                 // 已是 594 的行数（全部行，含没刷新的；仅用于日志展示）
      notWrong: rows.length - wrongCount, // 还不是 594 的行数（全部行；仅用于日志展示）
      validWrong: validWrong,            // 9.2.1：有效行里已是 594 的条数（判错完成判定用）
      counters: counters,
      detail: detail,
      judgeCounts: judgeCounts,          // 各 judgeCode 的条数
      scoreHigh: scoreHigh,              // 得分 ≥ highScoreThreshold 的条数
      scoreLow: scoreLow,                // 9.3.0：低分条数
      correct: correct,                  // 9.3.0：正确数据条数（去重后）
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
    for (const row of rows) {
      if (!state.running) break;
      const cb = row.querySelector(SELECTORS.childCheckbox);
      if (cb && !cb.checked) {
        safeClick(cb);
        await delay(30);
      }
    }
    // 9.4.3：返回"实际处于勾选状态的行数"，而不是"点了几次" ——
    //   否则在"这些行本来就是勾选状态"时返回 0，调用方会误判成"勾选失败"而把合集永久跳过
    let checkedNow = 0;
    rows.forEach((row) => {
      const cb = row.querySelector(SELECTORS.childCheckbox);
      if (cb && cb.checked) checkedNow++;
    });
    return checkedNow;
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
        const wait = loadWaitMax();   // 9.1.9：慢合集走 loadingWaitMaxSlow
        if (CONFIG.strictLoading && !(await waitLoadingDone('合集展开后加载', wait))) {
          throw new Error('展开后加载未完成（转圈未结束）');
        }
        return expandedRow;
      }
      await delay(CONFIG.checkInterval);
    }
    throw new Error('子表格加载超时(' + Math.round(timeout / 1000) + 's)');
  }

  // ========== 9.4.2：只取"母本行" ==========
  // 母本行与子样本行的 class 都是 tr.ant-table-row.ant-table-row-level-0（antd 的 level 是"表内层级"，
  // 子表自己也是 level-0），所以直接 document.querySelectorAll(SELECTORS.parentRow) 会把
  // **展开区里的子表行**也当成母本行 —— 症状：日志里出现「母本最高分读不到（第5列原文「预览」）」、
  // 短剧名是纯数字（其实是子样本状态码），而且一行一行慢慢跳（每行还要等重读）。
  // 这里统一过滤：① 落在 tr.ant-table-expanded-row 里的行不要；② 嵌在另一个表格里的行不要。
  function isChildTableRow(r) {
    // ① 落在某个展开区（tr.ant-table-expanded-row）里的行 → 子表行
    if (r.closest('tr.ant-table-expanded-row')) return true;
    // ② 本行所属的表格容器位于另一个表格的单元格(td)里 → 也是子表
    //    （比"祖先里存在另一个表格"更精确：放在卡片/容器里的主表不会被误判掉）
    const tbl = r.closest('.ant-pro-table, .ant-table-wrapper');
    if (!tbl) return false;
    const td = tbl.closest('td');
    return !!(td && td.closest('table'));
  }

  // 取全部母本行（保持 DOM 顺序）
  let parentFilterWarned = false;
  function getParentRows() {
    const all = Array.from(qsa(document, SELECTORS.parentRow));
    const rows = all.filter((r) => !isChildTableRow(r));
    // 9.4.3：万一过滤把母本行全筛没了（页面结构变化），必须吵醒使用者 ——
    //   否则脚本会"扫不到任何合集"而静默空跑一轮
    if (rows.length === 0 && all.length > 0 && !parentFilterWarned) {
      parentFilterWarned = true;
      log('⛔ 母本行过滤后为 0（页面原始 ' + all.length + ' 行）→ isChildTableRow() 可能误判，' +
        '本轮将扫不到任何合集；请把这条日志反馈给维护者');
    }
    return rows;
  }

  // ========== 9.4.3：展开区定位与"子表分页"预警 ==========
  // React 重渲染后，之前抓到的展开行节点可能已失效（isConnected=false / 里面查不到子表行）。
  // 这时按"母本行 → 下一个 tr.ant-table-expanded-row"重新定位一次；找不到就退回原缓存。
  function resolveExpandedRow(parentRow, cached) {
    if (cached && cached.isConnected && getChildRows(cached).length > 0) return cached;
    let sib = parentRow ? parentRow.nextElementSibling : null;
    while (sib && !sib.classList.contains('ant-table-expanded-row')) sib = sib.nextElementSibling;
    if (sib) {
      if (cached && sib !== cached) log('↻ 展开区节点已变化 → 已重新定位（继续等待判错完成）');
      return sib;
    }
    return cached;
  }

  // 子表带分页时，"表头全选"通常只覆盖当前页 → 模式2 可能永远等不到"全部子样本 = 594"。
  // 这里只做预警（不改变流程），方便定位"点了批量错误却一直等不到 594"的原因。
  function warnIfChildPaginated(expandedRow) {
    if (!expandedRow) return;
    const items = expandedRow.querySelectorAll('.ant-pagination .ant-pagination-item');
    if (items.length > 1) {
      log('⚠️ 子表带分页（分页器有 ' + items.length + ' 个页码）→「全选」可能只勾到当前页；' +
        '如果模式2 总是等不到"全部 594"，请检查这里');
    }
  }

  // ========== 9.2.0：收起页面上所有"已展开"的母本行 ==========
  // 需求：脚本处理完数据、显示"审核完成"后，把全行母本都闭合（点展开按钮收起）。
  // 注意：只收**母本行**上的展开图标（button.ant-table-row-expand-icon-expanded，
  //   aria-label="关闭行"），展开区里子表自己的展开图标不动。
  async function collapseAllExpandedRows() {
    const icons = Array.from(document.querySelectorAll('.ant-table-row-expand-icon-expanded'))
      .filter((el) => !isChildTableRow(el.closest('tr') || el));
    if (icons.length === 0) return 0;
    let n = 0;
    for (const el of icons) {
      if (!el.isConnected) continue;
      if (safeClick(el)) n++;
      await delay(120);
    }
    return n;
  }

  // ========== 9.2.0：子表列结构自检 ==========
  // 页面在子表第3列插入了 episode-index，状态码/得分列都右移了一位（3→4、8→9）。
  // 这里在每轮第一次展开时，把列头与首行各列文本打到控制台，方便一眼核对列号是否还对得上。
  let childDumpDone = false;
  function dumpChildColumns(expandedRow) {
    if (childDumpDone || !expandedRow) return;
    childDumpDone = true;
    try {
      const ths = Array.from(expandedRow.querySelectorAll('.ant-pro-table thead th, thead th'));
      const row = getChildRows(expandedRow)[0];
      const tds = row ? Array.from(row.querySelectorAll('td')) : [];
      const fmt = (arr) => arr.map((el, i) =>
        (i + 1) + '=' + ((el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 14) || '(空)')).join(' | ');
      console.log('[自检] 子表列头：' + fmt(ths));
      console.log('[自检] 子表首行：' + fmt(tds));
      console.log('[自检] 当前解析：状态码列=' + SELECTORS.childCodeCell +
        '（首行值「' + cellText(row, SELECTORS.childCodeCell) + '」）、单条分列=' +
        SELECTORS.childScoreCell + '（首行值「' + cellText(row, SELECTORS.childScoreCell) + '」）');
      log('🔎 子表列结构自检已打印到控制台（F12）：状态码列首行「' +
        cellText(row, SELECTORS.childCodeCell) + '」、单条分列首行「' +
        cellText(row, SELECTORS.childScoreCell) + '」——列号不对请把控制台那三行发我');

      // 9.2.0：列头文字 vs 写死列号 —— 不一致就明确告警（页面再改版时立刻能看到，而不是静默判错）
      const thText = (idx) => {
        const th = ths[idx - 1];
        return th ? (th.textContent || '').replace(/\s+/g, '').toLowerCase() : '';
      };
      const codeIdx = parseInt((SELECTORS.childCodeCell.match(/nth-child\((\d+)\)/) || [])[1], 10);
      const scoreIdx = parseInt((SELECTORS.childScoreCell.match(/nth-child\((\d+)\)/) || [])[1], 10);
      const codeHdr = thText(codeIdx);
      const scoreHdr = thText(scoreIdx);
      if (codeHdr && !/状态|hide|flag|码/.test(codeHdr)) {
        log('⚠️ 子表第 ' + codeIdx + ' 列表头是「' + codeHdr + '」，不像状态码列 → 列号可能又变了，' +
          '请看控制台 [自检] 三行后调整 SELECTORS.childCodeCell');
      }
      if (scoreHdr && !/得分|评分|匹配|score|rate/.test(scoreHdr)) {
        log('⚠️ 子表第 ' + scoreIdx + ' 列表头是「' + scoreHdr + '」，不像单条分列 → 列号可能又变了，' +
          '请看控制台 [自检] 三行后调整 SELECTORS.childScoreCell');
      }
      if (tds.length && ths.length && tds.length !== ths.length) {
        log('⚠️ 子表列数不一致（表头 ' + ths.length + ' 列 / 首行 ' + tds.length +
          ' 列）→ 可能存在隐藏列（如 antd 滚动条占位列），请核对自检输出');
      }
    } catch (e) { /* 自检失败不影响流程 */ }
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
    const rows = getParentRows();                       // 9.4.2：只按母本行算几何位置
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
    if (CONFIG.strictLoading && !(await waitLoadingDone('点击「' + btnText + '」前', loadWaitMax()))) return false;

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
    // 9.4.4：记录点击前已经存在的弹窗 —— 点完后只在"新冒出来的"弹窗里找确定键，
    //   避免页面上残留的别的弹窗（例如页面自带的删除确认）被误点
    const knownOverlays = snapshotOverlays();
    if (!safeClick(btn)) {
      console.warn('[按钮] 「' + btnText + '」点击失败（元素已失效）');
      return false;
    }
    await delay(800);

    if (await clickConfirm(CONFIG.modalWaitMax, knownOverlays)) return true;
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
  async function retryTick(start, retried, R, btnText, expandedRow, what, clickFn) {
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
      const ok = clickFn ? await clickFn() : await clickRowButtonRetry(R, btnText, expandedRow, 1, 0);
      log(ok ? '↻ 已重新提交「' + btnText + '」，继续等待' : '↻ 重试「' + btnText + '」未点通');
      return;
    }
  }

  // ========== 等待全部子样本变成 594（判错完成） ==========
  // 模式2 的"等响应"：批量错误提交后，必须满足才算完成：
  //   ① **有效行**的状态码都是 594（有效行 = 得分非 0 且可读的行）
  //      9.2.1 实测：系统对"得分为 0/读不到"的行**不会改状态码**（批量错误后它们仍是原码），
  //      所以完成判定**必须排除这些行** —— 否则"等全部 594"永远等不到，
  //      每个含 0 分行的合集都会白等 90/150s，然后被当成异常永久跳过（20 个就停整轮）。
  //   ② 页面转圈已结束（点确认后确认键旁/表格上会出现转圈，必须等它消失）
  //   ③ 若一条有效行都没有 → 系统不会产生任何 594，直接视为判错动作已完成（会打警告日志）
  // 8.0：等待期间第 30s / 60s 会各重试点击一次「批量错误」
  async function waitAllJudged(expandedRow, R, timeout) {
    const start = Date.now();
    const retried = [];
    while (Date.now() - start < timeout) {
      if (!state.running) return false;

      expandedRow = resolveExpandedRow(R, expandedRow);   // 9.4.3：节点失效则重新定位
      const stats = getCodeStats(expandedRow);
      const loading = isLoading();
      state.judgeNeed = stats.valid;                      // 9.2.1：按有效行计进度
      state.judgeDone = stats.validWrong;
      setStatus('模式2 · 判错处理中 594: ' + stats.validWrong + '/' + stats.valid +
        (stats.valid === 0
          ? ('　⚠️ 无有效行（' + stats.notReady + ' 条 0分/读不到，系统不会产生 594）')
          : (stats.validWrong === stats.valid ? ' ✅' : ' ⏳ [' + stats.detail + ']')) +
        (loading ? '（系统处理中…）' : ''));

      if (!loading) {
        if (stats.valid === 0) {
          log('⚠️ 该合集没有有效行（' + stats.notReady + ' 条全是 0 分/读不到）→ ' +
            '系统不会产生 594，视为「批量错误」这一步已完成，继续走查询刷新');
          return true;
        }
        if (stats.validWrong === stats.valid) return true;
      }

      await retryTick(start, retried, R, '批量错误', expandedRow, '（判错等待中）');
      await delay(CONFIG.checkInterval);
    }
    return false;
  }

  // ========== 全剧审核后等待系统完成 ==========
  // 完成标志（9.4.3：只看第2列合集id，不再依赖 workIndex 下标）：
  //   ① 这个合集 id 已不在列表里（被移走）；或
  //   ② 它还在列表里、但状态已变成「已审核」
  // 并且要求页面无转圈（点「全剧审核」后会出现转圈，转圈结束才算系统处理完）
  // 等待期间第 30s / 60s 会各重试点击一次「全剧审核」
  async function waitReviewCompleted(meta, R, expandedRow, timeout, btnText, clickFn) {
    const start = Date.now();
    const retried = [];
    while (Date.now() - start < timeout) {
      if (!state.running) return 'stopped';

      const rows = getParentRows();                     // 9.4.2：只数母本行
      const loading = isLoading();
      if (loading) setStatus('全剧审核处理中（系统转圈中…）');

      if (!loading) {
        // 9.4.3：用"这个合集 id 还在不在列表里"判断完成，而不是只看 workIndex 那一格 ——
        //   列表刷新/重排（已审核的会沉到下面）后，原下标可能已经换成别的合集，
        //   只看那一格会把这个合集误判成"已完成"，从而漏掉它
        let mine = null;
        for (const r of rows) {
          const m = getCollectionMeta(r);
          if (m.id && m.id === meta.id) { mine = r; break; }
        }
        if (!mine) return 'done';                                  // 已从列表移走 → 完成
        if (getRowStatus(mine).includes('已审核')) return 'done';   // 仍在列表但状态已变「已审核」→ 完成
      }

      const waitBtn = btnText || '全剧审核';
      await retryTick(start, retried, R, waitBtn, expandedRow, '（' + waitBtn + '等待中）', clickFn);
      await delay(CONFIG.checkInterval);
    }
    return 'stall';
  }

  // ========== 点击页面「查询」按钮（9.1.3：全错处理后的收尾动作） ==========
  // 为什么：全错（批量错误）提交后不需要再点「全剧审核」，点「查询」刷新列表即可，
  //         被判错的合集会自己从列表里移走。
  // 定位：页面级 primary 按钮 → 文本（去掉空格）等于 CONFIG.queryBtnText；排除自己的面板与弹窗内按钮
  function findQueryButton() {
    const pick = (list) => {
      for (const b of list) {
        if (b.closest('#s9-panel')) continue;                        // 排除脚本面板
        if (b.closest('.ant-popconfirm') || b.closest('.ant-modal-wrap')) continue; // 排除弹窗
        if (b.disabled) continue;
        const r = b.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;               // 不可见
        const txt = (b.textContent || '').replace(/\s+/g, '');
        if (txt === CONFIG.queryBtnText) return b;
      }
      return null;
    };
    return pick(document.querySelectorAll('button.ant-btn-primary')) ||
           pick(document.querySelectorAll('button'));
  }

  // 点击「查询」；返回是否点通
  async function clickQuery() {
    if (CONFIG.strictLoading && !(await waitLoadingDone('点击「' + CONFIG.queryBtnText + '」前', loadWaitMax()))) return false;
    const btn = findQueryButton();
    if (!btn) {
      log('⚠️ 未找到「' + CONFIG.queryBtnText + '」按钮（页面可能改版；继续等待列表刷新）');
      return false;
    }
    log('点击「' + CONFIG.queryBtnText + '」刷新列表...');
    safeClick(btn);
    // 9.2.1：列表刷新后，之前"还没刷新好"（母本最高分读不到）的合集重新参与扫描
    if (state.notReadyIds.size > 0) {
      log('↻ 列表已刷新 → 重新尝试之前读不到母本最高分的 ' + state.notReadyIds.size + ' 个合集');
      state.notReadyIds = new Set();
    }
    return true;
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

  // ========== 判定日志上报（9.1.5） ==========
  // 把每条合集判定 POST 到本地后端 /judge_log；后端没开时只提示一次并冷却，绝不影响审核
  const reportQueue = [];
  let reporting = false;
  let reportCooldownUntil = 0;
  let reportWarned = false;
  let reportOkLogged = false;

  function buildJudgeEntry(meta, res, ctx) {
    const c = ctx || {};
    const counts = c.counts || {};
    const judge = counts.judge || {};
    return {
      time: new Date().toLocaleString(),
      ts: Date.now(),
      script: '短剧审核9.2',
      version: '9.2.1',
      childId: c.childId || '',                 // 子样本第一条 id（子样本第2列）
      childRowText: c.childRowText || '',
      parentId: meta.id,                        // 母本合集 id（仅作参考）
      name: meta.name,
      originalName: meta.originalName,
      score: meta.score,
      episodes: meta.episodes,
      isSlow: !!meta.isSlow,
      dryRun: !!CONFIG.dryRun,                  // 9.3.0：本条是否为预演（未执行点击）
      similar: !!c.similar,
      simDetail: c.simDetail || '',
      keyword: c.kw || '',
      keywordDual: !!c.dual,
      ultimate: c.ultimate || '',
      matchMode: c.matchMode || '',             // 展开核对类型：similar-high / similar / dissimilar-high / dissimilar / no-score
      mode: res.mode || 0,
      result: res.result || '',
      outcome: CONFIG.dryRun
        ? ('预演(未点击) · 本应' + (res.mode === 1 ? '通过(全剧审核)' : '全错(批量错误)'))
        : (res.result === 'ok'
            ? (res.mode === 1 ? '通过(全剧审核)' : '全错(批量错误)')
            : (res.result === 'notready' ? '还没刷新好(未处理)' : '异常/跳过')),
      reason: res.reason || '',
      counts: (function () {
        // 9.4.4：按 CONFIG.judgeCodes 动态生成（原来写死 judge777/judge601，
        //   一旦改 judgeCodes，这两项就恒为 0，后端统计会失真）
        const out = {
          total: counts.total || 0,
          wrong594: counts.wrong || 0,
          scoreHigh: counts.scoreHigh || 0,
        };
        CONFIG.judgeCodes.forEach((c) => { out['judge' + c] = judge[c] || 0; });
        out.judgeCounts = Object.assign({}, judge);
        return out;
      })(),
    };
  }

  function reportJudge(meta, res, ctx) {
    if (!CONFIG.reportEnabled) return;
    try {
      reportQueue.push(buildJudgeEntry(meta, res, ctx));
      while (reportQueue.length > 300) reportQueue.shift();   // 后端长期不可用时避免内存膨胀
      flushReports();
    } catch (e) {
      console.warn('[短剧9.2] 组装判定日志失败:', e);
    }
  }

  function flushReports() {
    if (reporting || reportQueue.length === 0) return;
    if (Date.now() < reportCooldownUntil) return;             // 冷却期内不再尝试
    if (typeof GM_xmlhttpRequest !== 'function') {
      if (!reportWarned) { reportWarned = true; log('⚠️ 缺少 GM_xmlhttpRequest 权限 → 判定日志未上报'); }
      reportQueue.length = 0;
      return;
    }
    const batch = reportQueue.splice(0, 50);
    reporting = true;
    GM_xmlhttpRequest({
      method: 'POST',
      url: CONFIG.backendBase + '/judge_log',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      data: JSON.stringify({ entries: batch }),
      timeout: CONFIG.reportTimeoutMs,
      onload: (r) => {
        reporting = false;
        if (r.status >= 200 && r.status < 300) {
          reportCooldownUntil = 0;
          if (!reportOkLogged) {
            reportOkLogged = true;
            log('✅ 判定日志已上报后端（查看：' + CONFIG.backendBase + '/judge_log/view）');
          }
        } else {
          // 9.4.3：非 2xx 也进冷却 —— 否则后端一直报 4xx/5xx 时，每批都会往面板日志刷一行
          reportCooldownUntil = Date.now() + CONFIG.reportRetryCooldownMs;
          log('⚠️ 判定日志上报失败（HTTP ' + r.status + '），丢弃 ' + batch.length +
            ' 条并暂停上报 ' + Math.round(CONFIG.reportRetryCooldownMs / 1000) + 's' +
            (r.status === 404 ? '（404：后端可能是旧版或缺 /judge_log 路由，请重启后端）' : ''));
        }
        if (reportQueue.length) setTimeout(flushReports, 300);
      },
      onerror: () => {
        reporting = false;
        reportCooldownUntil = Date.now() + CONFIG.reportRetryCooldownMs;
        if (!reportWarned) {
          reportWarned = true;
          log('⚠️ 判定日志上报失败（后端未启动？' + CONFIG.backendBase + '）→ 暂停上报 ' +
            Math.round(CONFIG.reportRetryCooldownMs / 1000) + 's，不影响审核');
        }
      },
      ontimeout: () => {
        reporting = false;
        reportCooldownUntil = Date.now() + CONFIG.reportRetryCooldownMs;
      },
    });
  }

  // ========== 9.3.0：预演模式的结果对象 ==========
  // 预演 = 判定链与日志上报照跑，但绝不点击任何按钮（全剧审核 / 批量错误 / 查询刷新都不点）。
  // 用途：改判定规则后，先在真实页面空跑一轮核对结果，确认无误再关掉预演正式跑。
  function dryRunResult(mode, reason) {
    log('🧪 预演：本应执行【模式' + mode +
      (mode === 1 ? '：全剧审核（判正确）' : '：全选 + 批量错误 + 查询刷新（判全错）') + '】——未点击任何按钮');
    return { result: 'ok', mode: mode, reason: reason + '（预演：未执行任何点击）', dryRun: true };
  }

  // ========== 处理单个合集（9.1.3 判定：相似度 × 母本最高分 + 母本最低线 + 展开核对） ==========
  // 模式1（通过）：一律"展开核对后"才可能通过（点「全剧审核」；不勾选、不判错）
  // 模式2（全错）：展开 + 全选 + 批量错误（等全部594）→ 点「查询」刷新列表（不再点全剧审核）
  // 判定优先级（9.4.x）：
  //   ① 关键词双列比对：第3列命中的词里，有任一个第4列没有 → 模式2（9.4.0 起取消终极关键词）
  //   ② 母本最高分(第5列) < 母本最低线(lowScoreFloor=90)   → 模式2（唯一不看子样本的硬规则）
  //   ③ 其余一切情况（相似/不相似、母本最高分高/低/读不到）→ 展开核对：
  //        低分(<lowScoreThreshold) 条数 > 正确数据条数             → 模式2（优先）
  //        否则 得分≥highScoreThreshold 的条数 ≥ highScoreMinCount  → 模式1
  //        或   777/601 各自 ≥ 门槛（有效行≤30 ≥2；>30 ≥4）        → 模式1
  //        都不满足                                                → 模式2（全错）
  //   （得分=0/读不到的行走不计入以上统计；正确数据 = 777/601 或 得分≥93，按行去重）
  // 相似度判据（所有文本都比对）：连续 similarMinSubstr 字相同 或 公共不同字 ≥ similarMinCommonChars
  // 返回 { result: 'ok'|'problem', mode: 0|1|2, reason }
  async function processOneCollection(R, meta) {
    // 9.4.3：先把上报上下文清空 —— 否则"第0步"提前 return（上一轮加载未完成）时，
    //   会把【上一个合集】的 childId/关键词等当成这一条的写进判定日志
    state.lastJudge = {
      childId: '', childRowText: '', similar: false, simDetail: '',
      kw: '', dual: false, ultimate: '', matchMode: '', counts: null,
    };
    // 9.1.9：登记本合集是否慢处理 → 所有「等待加载完成」闸门统一由 loadWaitMax() 取值
    state.curSlow = !!meta.isSlow;
    const expandWait = meta.isSlow ? CONFIG.expandWaitMaxSlow : CONFIG.expandWaitMax;
    const expandFn = () => expandRowAndWait(R, expandWait);

    // ---- 第0步：严格等待上一轮遗留下的加载完成 ----
    const startLoadWait = meta.isSlow ? CONFIG.loadingWaitMaxSlow : CONFIG.loadingWaitMax;
    if (CONFIG.strictLoading && !(await waitLoadingDone('开始处理本轮前', startLoadWait))) {
      return { result: 'problem', mode: 0, reason: '上一轮加载未完成' };
    }

    // ---- 第1步：母行信息 + 关键词 + 相似度（不需要展开）----
    const kwr = getKeywordRule(R, meta);
    const sim = checkSimilarOriginalName(R, meta);
    const similar = sim.similar;   // 9.1.0：所有文本都比对相似度（不再限制短剧名字数）

    log('关键词比对（9.4.0：第3列命中的词必须第4列全都有，缺一个就全错）：短剧名「' + meta.name +
      '」 vs 原短剧名「' + meta.originalName + '」 → ' +
      (kwr.matched.length === 0
        ? '第3列未命中关键词'
        : ('命中「' + kwr.matched.join('、') + '」' +
           (kwr.hit ? ('，其中第4列没有「' + kwr.missing.join('、') + '」→ 直接全错')
                    : '，且第4列都有 → 继续后续判定'))));
    log('相似度比对（所有文本都算）：短剧名「' + meta.name + '」 vs 原短剧名「' + meta.originalName + '」(' +
      sim.nameLen + '字) → ' + (similar ? '相似' : '不相似') + '（' + sim.detail + '）');

    // 9.1.5：初始化本轮判定上下文（供上报日志；展开后会补上子样本首条 id 与统计数字）
    state.lastJudge = {
      childId: '', childRowText: '', similar: similar, simDetail: sim.detail,
      kw: kwr.kw || '', dual: !!kwr.dual,
      ultimate: '',            // 9.4.0：终极关键词已取消，字段保留兼容旧日志
      matchMode: '', counts: null,
    };

    const score = meta.score;
    let mode = 0, reason = '';
    let needExpand = false, expandKind = '', expandReason = '';

    if (kwr.hit) {
      // ① 关键词（9.4.0：第3列命中的词里，有任一个第4列没有）→ 直接全错
      mode = 2;
      reason = '关键词「' + kwr.missing.join('、') + '」出现在第3列但第4列没有（命中：' +
        kwr.matched.join('、') + '）→ 直接全错';
    } else if (score !== null && CONFIG.lowScoreFloor > 0 && score < CONFIG.lowScoreFloor) {
      // ② 母本最低线（9.1.7：唯一保留的"不看子样本"硬规则；90 分是底线，777/601 够多也不救）
      mode = 2;
      reason = '母本最高分 ' + score + ' < 母本最低线 ' + CONFIG.lowScoreFloor +
        ' → 直接全错（90 分是底线：即使子样本 777/601 够多也不救）' + (kwr.dual ? '（关键词两列都有）' : '');
    } else {
      // ③ 其余一切情况都展开核对（9.1.7）：
      //     相似/不相似、母本最高分高/低/读不到 都不再直接判错，改由"子样本质量"决定
      needExpand = true;
      expandKind = (score === null)
        ? 'no-score'
        : (similar
            ? (score > CONFIG.parentScoreThreshold ? 'similar-high' : 'similar')
            : (score > CONFIG.parentScoreThreshold ? 'dissimilar-high' : 'dissimilar'));
      expandReason = '相似=' + (similar ? '是' : '否') + '、母本最高分=' + (score === null ? '读不到' : score) +
        ' → 展开核对：得分 > ' + CONFIG.highScoreThreshold + ' 的条数 ≥ ' + CONFIG.highScoreMinCount +
        ' 条，或状态码 ' + CONFIG.judgeCodes.join('/') + ' 各自 ≥ ' + CONFIG.correctCodeMinCount +
        ' 条（子样本 ≤ ' + CONFIG.smallCollectionMaxRows + ' 条的小合集只要 ≥ ' +
        CONFIG.correctCodeMinCountSmall + ' 条）→ 模式1；都不满足 → 模式2';
    }

    if (!needExpand) {
      log('===== 判定模式' + mode + '：' + reason + ' =====');
      setStatus('模式' + mode + '：' + reason);
    } else {
      log('===== 判定待定（需展开核对）：' + expandReason + ' =====');
      setStatus('待定：' + expandReason);
    }

    // ---- 展开合集（模式2 与 待定 都需要展开）----
    setStatus((mode === 2 ? '模式2 · ' : '待定 · ') + '展开合集「' + meta.name + '」(' + meta.episodes + '集' +
      (meta.isSlow ? '·慢处理' : '') + ')...');
    let expandedRow;
    try {
      expandedRow = await expandFn();
    } catch (e) {
      log('展开失败: ' + e.message);
      return { result: 'problem', mode: (mode || 2), reason: '展开失败: ' + e.message };
    }

    const stats = getCodeStats(expandedRow);
    warnIfChildPaginated(expandedRow);          // 9.4.3：子表分页预警（只提示，不改流程）
    dumpChildColumns(expandedRow);              // 9.2.0：子表列结构自检（每轮第一次展开时打印一次）

    // ---- 9.4.4：有效行为 0（子样本得分全是 0/读不到）→ 绝不能据此判全错 ----
    // 这种合集等于"一条可用数据都没有"，判全错会真的全选 + 批量错误打 594（破坏性误判）。
    // 与"母本最高分读不到"同一套处理：本轮跳过、刷新列表后重试。
    if (needExpand && stats.valid === 0) {
      log('⏸ 该合集子样本得分全部为 0/读不到（有效行 0 / 共 ' + stats.total +
        ' 条）→ 视为还没刷新好：本轮跳过，不判错、不点击');
      return { result: 'notready', mode: 0, reason: '子样本得分全部未刷新（有效行 0）' };
    }

    // 9.1.5：子样本第一条 id（子样本第2列）+ 第一条整行文本 + 统计数字 → 供上报
    if (state.lastJudge) {
      state.lastJudge.childId = getFirstChildId(expandedRow);
      state.lastJudge.childRowText = getFirstChildRowText(expandedRow);
      state.lastJudge.matchMode = expandKind || '';
      state.lastJudge.counts = {
        total: stats.total,
        wrong: stats.wrong,
        scoreHigh: stats.scoreHigh,
        judge: Object.assign({}, stats.judgeCounts),
      };
    }

    // 9.1.1：各判定码的条数，如 "777 5 条 / 601 0 条"；9.3.0：再加"得分≥93 / 低分<80 / 正确数据"条数
    const judgeText = CONFIG.judgeCodes.map((c) => c + ' ' + (stats.judgeCounts[c] || 0) + ' 条').join(' / ');
    log('子样本统计：共 ' + stats.total + ' 条 | 状态码 ' + stats.detail +
      ' | ' + judgeText + ' | 得分≥' + CONFIG.highScoreThreshold + ' ' + stats.scoreHigh + ' 条' +
      ' | 低分<' + CONFIG.lowScoreThreshold + ' ' + stats.scoreLow + ' 条' +
      ' | 正确数据 ' + stats.correct + ' 条' +
      ' | 有效 ' + stats.valid + ' 条' + (stats.notReady > 0 ? ('（' + stats.notReady + ' 条 0分/读不到未计入）') : '') +
      ' | 已打594 ' + stats.wrong + ' 条(可读得分 ' + stats.scoreKnown + ' 条)');

    // ---- 待定 → 按展开核对结果判定 ----
    if (needExpand) {
      // 9.3.0 展开核对判据（书写顺序即优先级）：
      //   ⓪ 低分数据条数 > 正确数据条数                    → 模式2（9.3.0 新增，优先于"高分够多就通过"）
      //   ① 高分数据够多：得分 ≥ highScoreThreshold 的条数 ≥ highScoreMinCount
      //   ② 或 前人已判定：777 / 601 各自 ≥ 门槛（9.1.8：小合集 ≥2，大合集 ≥4）
      //   都不满足 → 模式2
      // 注意：得分 = 0 / 读不到的行走（还没刷新出来）不计入以上任何一项。
      const smallColl = stats.valid > 0 && stats.valid <= CONFIG.smallCollectionMaxRows;
      const codeNeed = smallColl ? CONFIG.correctCodeMinCountSmall : CONFIG.correctCodeMinCount;
      const hitCodes = CONFIG.judgeCodes.filter((c) => (stats.judgeCounts[c] || 0) >= codeNeed);
      const highHit = stats.scoreHigh >= CONFIG.highScoreMinCount;
      const lowWins = stats.scoreLow > stats.correct;      // 9.3.0：低分多于正确数据 → 判错
      const head = (similar ? '两列相似' : '两列不相似') + '、母本最高分 ' +
        (score === null ? '读不到' : score) + '（' + expandKind + '），展开后：' +
        judgeText + ' / 得分≥' + CONFIG.highScoreThreshold + ' ' + stats.scoreHigh + ' 条' +
        ' / 低分<' + CONFIG.lowScoreThreshold + ' ' + stats.scoreLow + ' 条' +
        ' / 正确数据 ' + stats.correct + ' 条' +
        ' / 有效 ' + stats.valid + ' 条' +
        (stats.notReady > 0 ? ('（' + stats.notReady + ' 条 0分/读不到未计入）') : '') +
        (smallColl ? ('（小合集，码门槛 ' + codeNeed + '）') : '');
      const hit = highHit || hitCodes.length > 0;
      if (lowWins) {
        mode = 2;
        reason = head + ' → 低分(<' + CONFIG.lowScoreThreshold + ') ' + stats.scoreLow +
          ' 条 > 正确数据 ' + stats.correct + ' 条 → 全错';
      } else if (hit) {
        mode = 1;
        reason = head + ' → ' + (highHit
          ? ('得分≥' + CONFIG.highScoreThreshold + ' 的条数 ' + stats.scoreHigh + ' ≥ ' + CONFIG.highScoreMinCount)
          : ('状态码 ' + hitCodes.join('/') + ' 各自 ≥ ' + codeNeed + ' 条')) +
          ' → 判该合集正确';
      } else {
        mode = 2;
        reason = head + ' → 得分≥' + CONFIG.highScoreThreshold + ' 不足 ' + CONFIG.highScoreMinCount +
          ' 条，且没有判定码 ≥ ' + codeNeed + ' 条 → 全错';
      }
      log('===== 补充判定模式' + mode + '：' + reason + ' =====');
      setStatus('模式' + mode + '：' + reason);
      if (mode === 1) {
        if (CONFIG.dryRun) {
          // 9.4.2：预演不点击，但要把本行为读统计而展开的子表收起来，
          //   否则那 60 行子样本会一直留在 DOM 里干扰后面的扫描
          await collapseRow(R);
          log('🧪 预演：已收起本次为读统计而展开的合集');
          return dryRunResult(1, reason);
        }
        log('模式1 → 已展开，直接全剧审核（不勾选、不判错）');
        const r = await doFullReview(R, meta, null, expandedRow);
        return { result: r, mode: 1, reason: reason };
      }
    }

    // ---- 9.3.0 预演模式：判定已出结果 → 收起展开的子表后返回，不点任何按钮 ----
    if (CONFIG.dryRun) {
      await collapseRow(R);                                 // 9.4.2：别把子表留在 DOM 里
      log('🧪 预演：已收起本次为读统计而展开的合集');
      return dryRunResult(mode || 2, reason);
    }

    // ---- 模式2：全选 + 批量错误（等全部594）+ 全剧审核 ----
    // 注意：无论当前子样本是什么状态（哪怕没有 0），都必须执行"全选 + 批量错误"，不能跳过判错。
    // 严格等待：勾选前确保子表已渲染完（无转圈）
    if (CONFIG.strictLoading && !(await waitLoadingDone('勾选子样本前', loadWaitMax()))) {
      return { result: 'problem', mode: 2 };
    }
    setStatus('模式2 · 全选子样本 ' + stats.total + ' 条...');
    log('模式2 当前状态码分布: ' + stats.detail + '（全部行已是594 ' + stats.wrong + ' 条，待处理 ' +
      stats.notWrong + ' 条；其中**有效行** ' + stats.valid + ' 条，已594 ' + stats.validWrong +
      ' 条；另有 ' + stats.notReady + ' 条 0分/读不到——系统不会改它们的状态码，不参与等待）');
    const checked = await selectAllChildRows(expandedRow);
    if (!state.running) return { result: 'problem', mode: 2 };
    log('已勾选 ' + checked + ' / ' + stats.total + ' 条');
    if (checked === 0) {
      log('勾选失败（复选框未生效），判定该合集有问题');
      return { result: 'problem', mode: 2 };
    }
    // 7.0 严格等待：勾选后也可能触发渲染/请求，等加载结束再点「批量错误」
    if (CONFIG.strictLoading && !(await waitLoadingDone('勾选后等待就绪', loadWaitMax()))) {
      return { result: 'problem', mode: 2 };
    }

    // 批量错误（判错）——失败自动重试3次
    log('点击「批量错误」...');
    if (!(await clickRowButtonRetry(R, '批量错误', expandedRow, 3, 3000))) {
      log('批量错误提交失败（按钮不可用或弹窗未出现）');
      return { result: 'problem', mode: 2 };
    }

    // 等响应：**有效行**都变 594 且转圈结束（0分/读不到的行系统不改状态码，不等待）；
    //   等待期间 30s/60s 会重试点击「批量错误」
    const judgeWait = meta.isSlow ? CONFIG.batchErrorWaitMaxSlow : CONFIG.batchErrorWaitMax;
    const ok = await waitAllJudged(expandedRow, R, judgeWait);
    if (!ok) {
      const last = getCodeStats(expandedRow);
      log('等待594+加载完成超时(' + Math.round(judgeWait / 1000) + 's，已含30s/60s两次重试)：' +
        '有效行已594 ' + last.validWrong + '/' + last.valid + '，状态码分布 ' + last.detail +
        (isLoading() ? '（页面仍有转圈）' : '') + '，判定该合集有问题');
      return { result: 'problem', mode: 2, reason: '批量错误等待超时（有效行 594 未齐）' };
    }
    log('✅ 判错完成：有效行状态码全部=' + CONFIG.wrongCode + '，且系统处理已结束' +
      (getCodeStats(expandedRow).notReady > 0
        ? ('（另有 ' + getCodeStats(expandedRow).notReady + ' 条 0分/读不到的行，系统未改其状态码，已忽略）')
        : ''));

    // 判错成功后额外等待（落库缓冲）
    setStatus('判错成功，等待系统落库...');
    await delay(meta.isSlow ? CONFIG.settleAfterBatchErrorSlow : CONFIG.settleAfterBatchError);
    if (!state.running) return { result: 'problem', mode: 2 };

    // ---- 收尾（9.1.3）：不再点「全剧审核」，改为点「查询」刷新列表，等全错数据自己移走 ----
    setStatus('全错已提交，点击「' + CONFIG.queryBtnText + '」刷新列表...');
    const clicked = await clickQuery();
    if (!clicked) log('⚠️ 「' + CONFIG.queryBtnText + '」未点通，继续等待列表自行刷新');

    const queryLoadWait = meta.isSlow ? CONFIG.loadingWaitMaxSlow : CONFIG.loadingWaitMax;
    if (CONFIG.strictLoading && !(await waitLoadingDone('「' + CONFIG.queryBtnText + '」刷新中', queryLoadWait))) {
      log('⚠️ 查询刷新等待超时，但该合集已全部判错(594)，继续下一行');
      return { result: 'ok', mode: 2, reason: reason + '（查询刷新等待超时，已判错）' };
    }

    const queryReviewWait = meta.isSlow ? CONFIG.fullReviewWaitMaxSlow : CONFIG.fullReviewWaitMax;
    setStatus('等待列表刷新，全错数据移走...');
    const qOutcome = await waitReviewCompleted(meta, R, expandedRow, queryReviewWait, CONFIG.queryBtnText, clickQuery);
    if (qOutcome === 'stopped') return { result: 'problem', mode: 2, reason: '已停止' };
    if (qOutcome === 'stall') {
      // 数据已经判错成功，这里只是列表没刷新出来 → 记为完成（doneIds 会阻止重复处理），不当作异常跳过
      log('ℹ️ 等待 ' + Math.round(queryReviewWait / 1000) + 's 列表仍未刷新（该合集已全部判错594）' +
        '，按完成处理并继续下一行');
      return { result: 'ok', mode: 2, reason: reason + '（列表未刷新，但已判错）' };
    }
    log('✅ 「' + CONFIG.queryBtnText + '」刷新完成，该合集已移走');
    return { result: 'ok', mode: 2, reason: reason };
  }

  // ========== 主循环（8.0：id 唯一 + 永久跳过；9.2.0：每轮从"起始行"往下扫 + 已审核为边界） ==========
  // 9.2.0 扫描规则（按需求："遇到已审核说明下面都审过了"）：
  //   · 每一轮都从【起始行】往下扫，不再沿用上一轮的下标（列表刷新后会重排/补位）
  //   · 「已审核」行只作边界标记（下面都已审过），本身不再当可审行
  //   · 跳过：本轮已处理过(doneIds) / 已永久跳过=异常数据(skipIds) / 状态含「已审核」
  //   · 第2列 id 读不到的行走不算候选（视为"还没刷新好"），跳过它继续往下看
  //   · 第一个可审行就是本轮目标；一个都没有 → done（再交给 confirmReviewFinished 刷新确认）
  function pickTarget() {
    const rows = getParentRows();                        // 9.4.2：排除展开区里的子表行
    if (rows.length === 0) return { done: true, why: '页面无数据行' };

    const startIdx = Math.max(0, (CONFIG.startRow || 1) - 1);
    if (startIdx >= rows.length) {
      return { done: true, why: '起始行第' + (startIdx + 1) + '行超出当前列表（共 ' + rows.length + ' 行）→ 无可审行' };
    }
    let firstReviewedIdx = -1;   // 第一行「已审核」的位置（边界）
    let unreadableId = 0;        // 第2列读不到的行数（"还没刷新好"的迹象）

    for (let i = startIdx; i < rows.length; i++) {
      const R = rows[i];
      if (getRowStatus(R).includes('已审核')) {          // 9.2.0：已审核 = 边界（下面都审过了）
        if (firstReviewedIdx < 0) firstReviewedIdx = i;
        continue;
      }
      const meta = getCollectionMeta(R);
      if (!meta.id) {
        unreadableId++;
        log('⚠️ 第' + (i + 1) + '行第2列(合集id)读不到 → 视为还没刷新好的异常行，先跳过、继续往下看');
        continue;
      }
      if (state.skipIds.has(meta.id)) continue;          // 异常数据（本轮已永久跳过）
      if (state.notReadyIds.has(meta.id)) continue;      // 9.2.1：母本最高分读不到=还没刷新好，本轮先跳过
      if (state.giveUpIds.has(meta.id)) continue;        // 9.2.1：多次刷新仍读不到母本最高分，本轮已放弃
      if (state.doneIds.has(meta.id)) continue;          // 本轮已处理过
      state.workIndex = i;
      return { R: R, meta: meta, idx: i, boundary: firstReviewedIdx, unreadableId: unreadableId };
    }

    // 整段（起始行往下）没有一个可审行
    if (unreadableId > 0 && unreadableId === rows.length - startIdx) {
      return { done: true, abort: true,
        why: '从第' + (startIdx + 1) + '行起，第2列(合集id)全部读取为空，疑似页面改版 → 停止运行，请检查第2列选择器' };
    }
    return {
      done: true,
      boundary: firstReviewedIdx,
      unreadableId: unreadableId,
      why: (firstReviewedIdx === startIdx
        ? '第' + (startIdx + 1) + '行已是「已审核」→ 说明下面的数据都已审核过'
        : '全表只剩「已审核」与已跳过的异常数据') +
        (unreadableId > 0 ? '（另有 ' + unreadableId + ' 行还没刷新好）' : ''),
    };
  }

  // ========== 9.2.0：结束前的「查询」刷新确认 ==========
  // 扫不到可审行时先别急着收工：列表可能还在刷新（母本最高分读不到 / 展开异常都可能是"还没刷新好"），
  // 所以点「查询」刷新列表再看一眼 —— 默认点两次（CONFIG.endConfirmRounds）。
  // 返回：刷新后出现的可审行对象（说明还没审完，继续审） | null（确认已审完）
  async function confirmReviewFinished(why) {
    // 9.3.0 预演：不点「查询」，直接结束（否则预演会真的点击页面）
    if (CONFIG.dryRun) {
      log('🧪 预演：不点「' + CONFIG.queryBtnText + '」确认，本轮直接结束');
      return null;
    }
    const rounds = Math.max(0, CONFIG.endConfirmRounds | 0);
    if (rounds === 0) return null;

    for (let r = 1; r <= rounds; r++) {
      if (!state.running) return null;
      log('🔎 扫描结果：' + why + ' → 第 ' + r + '/' + rounds + ' 次点击「' +
        CONFIG.queryBtnText + '」刷新确认...');
      setStatus('刷新确认中（' + r + '/' + rounds + '）...');

      if (!(await clickQuery())) log('⚠️ 「' + CONFIG.queryBtnText + '」未点通，继续等列表刷新后再看');
      if (CONFIG.strictLoading && !(await waitLoadingDone('「' + CONFIG.queryBtnText + '」刷新确认', loadWaitMax()))) {
        log('⚠️ 刷新确认等待超时，仍再看一眼列表');
      }
      await delay(CONFIG.endConfirmSettleMs);

      const t = pickTarget();
      if (!t.done) {
        log('✅ 刷新后出现可审行（第' + (t.idx + 1) + '行）→ 继续审核');
        return t;
      }
      log('　↳ 第 ' + r + ' 次刷新后仍无可审行' + (t.why ? '（' + t.why + '）' : ''));
    }
    return null;
  }

  async function runLoop() {
    let done = false;
    let stopKind = '';          // 9.4.4：finished=真的审完 / skipLimit=跳过满上限提前结束
    let abortReason = '';       // 9.1 保护：非正常停止的原因（id 全读不到）
    while (state.running) {
      let target = null;        // 9.4.4：提到 try 外，catch 里才能知道是哪一行出的异常
      try {
        target = pickTarget();
        if (target.done) {
          if (target.abort) {                       // 整段 id 都读不到 → 页面改版，仍按"立即停止"处理
            abortReason = target.why;
            log('⛔ ' + target.why);
            setStatus('⛔ ' + target.why);
            break;
          }
          log(target.why);
          // 9.2.0：结束前先点「查询」刷新确认（默认两次）；刷新后若又出现未审核行 → 继续审
          target = await confirmReviewFinished(target.why);
          if (!target) {
            // 9.4.4：这里的 null 有两种含义 —— ①真的审完了 ②用户点了停止/被中断。
            //   必须区分，否则"点了停止"也会弹"处理完成！"
            if (!state.running) break;
            done = true;
            stopKind = 'finished';
            break;
          }
        }

        const R = target.R, meta = target.meta;

        // ---- 9.2.1：母本最高分读不到 = "母本还没刷新好"，不再中断整轮运行 ----
        // 旧做法（9.1~9.2.0）：相邻 3 行读不到母本最高分 → 判为选择器失效，立即停止并弹窗；
        //   实际使用中它经常在"列表还在刷新"时误触发（重新点开始又能继续），故改为：
        //   ① 先等加载完成并重读 scoreRetryCount 次（间隔 scoreRetryGapMs）；
        //   ② 读到了 → 用新分数继续正常判定；
        //   ③ 仍读不到 → 记入 notReadyIds（=「还没刷新好」），本轮先跳过它、继续审别的行；
        //      点过「查询」刷新列表后会自动重试；结束时在汇总弹窗里列出这些合集。
        if (meta.score === null) {
          const sc = await waitParentScore(R);
          if (sc.score !== null) {
            meta.score = sc.score;
          } else {
            // 记「还没刷新好」：本轮跳过，刷新列表后再试；试满 scoreGiveUpRounds 次仍读不到 → 本轮彻底放弃该合集
            // （否则"跳过→结束确认点查询→重新扫到→又跳过"会来回打转）
            const tries = (state.notReadyTries.get(meta.id) || 0) + 1;
            state.notReadyTries.set(meta.id, tries);
            state.notReadyIds.add(meta.id);

            const exist = state.notReadyList.find((x) => x.id === meta.id);
            if (exist) {
              exist.tries = tries;
              exist.raw = sc.raw;
              exist.time = new Date().toLocaleTimeString();
            } else {
              state.notReadyList.push({
                id: meta.id, name: meta.name, row: target.idx + 1,
                raw: sc.raw, tries: tries, time: new Date().toLocaleTimeString(),
              });
            }

            if (tries > CONFIG.scoreGiveUpRounds) {
              state.giveUpIds.add(meta.id);          // 本轮不再当候选（结束时会汇总提示）
              log('⛔ 第' + (target.idx + 1) + '行「' + meta.name + '」母本最高分多次刷新仍读不到（第5列原文「' +
                (sc.raw || '(空)') + '」，已试 ' + tries + ' 次）→ 本轮放弃该合集，结束时汇总，可人工处理');
            } else {
              log('⏸ 第' + (target.idx + 1) + '行「' + meta.name + '」母本最高分读不到（第5列原文「' +
                (sc.raw || '(空)') + '」，第 ' + tries + '/' + CONFIG.scoreGiveUpRounds + ' 次）→ ' +
                '视为母本还没刷新好：本轮先跳过它、继续审别的行（刷新列表后自动重试）');
            }
            if (state.notReadyList.length === CONFIG.scoreSkipWarnCount) {
              log('⚠️ 本轮已有 ' + state.notReadyList.length + ' 个合集读不到母本最高分。脚本不会因此停止；' +
                '但如果整表都读不到，请检查 SELECTORS.parentScoreCell（第5列）是否失效');
            }
            updatePanel();
            continue;                     // 不判错、不展开，继续扫下一行
          }
        }

        log('===== 处理 第' + (target.idx + 1) + '行 合集[' + meta.id + ']「' + meta.name +
          '」集数' + meta.episodes + ' 母本最高分' + (meta.score === null ? '-' : meta.score) +
          (meta.isSlow ? '（慢处理）' : '') + ' =====');

        const res = await processOneCollection(R, meta);
        // 9.4.4：先判断是否已被「停止」打断 —— 否则会把这条被打断的合集当成"判定结果"写进日志
        if (!state.running) break;
        reportJudge(meta, res, state.lastJudge);   // 9.1.5：上报判定日志（后端没开也不影响审核）

        // ---- 9.4.4：判定途中发现"数据还没刷新好"（子样本得分全是 0/读不到）----
        // 与"母本最高分读不到"同一套处理：本轮跳过、刷新列表后自动重试，绝不判错
        if (res.result === 'notready') {
          const tries = (state.notReadyTries.get(meta.id) || 0) + 1;
          state.notReadyTries.set(meta.id, tries);
          state.notReadyIds.add(meta.id);
          if (tries > CONFIG.scoreGiveUpRounds) state.giveUpIds.add(meta.id);
          const entry = {
            id: meta.id, name: meta.name, row: target.idx + 1,
            raw: res.reason || '子样本得分全部未刷新', tries: tries,
            time: new Date().toLocaleTimeString(),
          };
          const exist = state.notReadyList.find((x) => x.id === meta.id);
          if (exist) Object.assign(exist, entry); else state.notReadyList.push(entry);
          log('⏸ 第' + (target.idx + 1) + '行「' + meta.name + '」' + (res.reason || '子样本得分全部未刷新') +
            '（第 ' + tries + '/' + CONFIG.scoreGiveUpRounds + ' 次）→ 本轮跳过，刷新列表后自动重试');
          updatePanel();
          await collapseRow(R);            // 为读统计展开过 → 收起来，别把子表行留在 DOM
          continue;
        }

        if (res.result === 'ok') {
          state.doneIds.add(meta.id);          // 9.1.3：防止同一合集在列表未刷新时被重复处理
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
          stopKind = 'skipLimit';        // 9.4.4：这是"提前结束"，不能显示成"处理完成"
          break;
        }
        // 从下一行开始找目标（永久跳过当前合集）
        state.workIndex = target.idx + 1;
      } catch (e) {
        console.error('[短剧9.2] 主循环异常:', e);
        // 9.4.4：同一个合集反复抛异常时必须有上限 —— 否则会每 3 秒原地重试、永不推进
        //   （这是"扫描→处理→结束确认→再扫描"这条链上唯一可能不终止的地方）
        const errId = (target && target.meta) ? target.meta.id : '';
        if (errId) {
          const n = (state.errTries.get(errId) || 0) + 1;
          state.errTries.set(errId, n);
          if (n >= CONFIG.maxErrTriesPerRow) {
            state.skipIds.add(errId);
            state.skipList.push({
              id: errId, name: target.meta.name,
              reason: '连续异常 ' + n + ' 次：' + (e.message || e),
              time: new Date().toLocaleTimeString(),
            });
            log('⛔ 合集[' + errId + '] 连续异常 ' + n + ' 次 → 本轮永久跳过，换下一行');
            updatePanel();
          }
        }
        log('主循环异常: ' + (e.message || e) + '，3秒后继续');
        await delay(3000);
      }
    }
    setStatus(abortReason ? ('⛔ 已停止：' + abortReason) : (done ? '全部处理完成' : '已停止'));
    stopRun();
    if (!done && abortReason) {
      setTimeout(() => alert('⚠️ 脚本已自动停止\n原因：' + abortReason +
        '\n\n已处理 ' + state.processedCount + ' 个合集；本行及之后的行未处理。' +
        '\n请按 F12 查看控制台「自检」输出，确认 SELECTORS（第2列 id / 第5列母本最高分）是否失效。'), 100);
    }
    if (done) {
      // 9.2.0：处理完并显示"审核完成"前，先把页面上所有已展开的母本行收起来（需求 2）
      const closed = await collapseAllExpandedRows();
      log(closed > 0 ? ('🧹 已收起页面上全部展开的母本行（' + closed + ' 个）')
                     : '🧹 页面上没有展开中的母本行，无需收起');
      const skipText = state.skipList.length > 0
        ? ('\n跳过 ' + state.skipList.length + ' 个合集（需人工处理）：\n' +
           state.skipList.slice(0, 10).map((s) => ' · [' + s.id + '] ' + s.name + ' ← ' + s.reason).join('\n') +
           (state.skipList.length > 10 ? '\n …（其余见面板「复制跳过清单」）' : ''))
        : '\n（无跳过合集）';
      const notReadyText = state.notReadyList.length > 0
        ? ('\n\n⏸ 还没刷新好（母本最高分读不到 / 子样本得分全为 0）' + state.notReadyList.length +
           ' 个，本轮未处理：\n' +
           state.notReadyList.slice(0, 8).map((s) => ' · [' + s.id + '] ' + s.name +
             '（第' + s.row + '行，第5列原文「' + (s.raw || '(空)') + '」，试了' + (s.tries || 1) + '次）').join('\n') +
           (state.notReadyList.length > 8 ? '\n …（其余见面板日志）' : '') +
           (state.giveUpIds.size > 0 ? ('\n其中 ' + state.giveUpIds.size + ' 个多次刷新仍读不到，本轮已放弃，需人工处理') : '') +
           '\n可再点一次「开始运行」重试这些合集')
        : '';
      const dr = !!CONFIG.dryRun;
      const drTitle = dr ? '🧪 预演结束（未执行任何点击）\n'
        : (stopKind === 'skipLimit'
            ? ('⚠️ 已跳过 ' + state.skipIds.size + ' 个合集（达上限 ' + CONFIG.maxSkipCount +
               '）——本轮【提前结束】，不是全部审完\n')
            : '');
      const modeLine = '模式1(' + (dr ? '本应全剧审核' : '直接全剧审核') + ') ' + state.mode1Count +
        ' 个 / 模式2(' + (dr ? '本应全选判错' : '全选判错') + ') ' + state.mode2Count + ' 个';
      const endLine = dr
        ? '\n预演：未执行任何点击（「' + CONFIG.queryBtnText + '」刷新确认已跳过）'
        : ('\n结束确认：已点「' + CONFIG.queryBtnText + '」刷新 ' + CONFIG.endConfirmRounds +
           ' 次，未再发现未审核行');
      setTimeout(() => alert(drTitle + '处理完成！共处理 ' + state.processedCount + ' 个合集\n' +
        modeLine + endLine + skipText + notReadyText), 100);
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
    const lines = [];
    // 9.4.3：即使没有异常跳过，也要能把"还没刷新好"的合集带走（否则这份剪贴板清单会漏掉它们）
    if (!state.skipList || state.skipList.length === 0) {
      lines.push('# 跳过合集清单（需人工处理）：本轮没有异常跳过的合集');
    } else {
      lines.push('# 跳过合集清单（需人工处理）  共 ' + state.skipList.length + ' 个');
      lines.push('# 合集id\t短剧名\t跳过原因\t时间');
      state.skipList.forEach((s) => lines.push([s.id, s.name, s.reason, s.time].join('\t')));
    }
    if (state.notReadyList && state.notReadyList.length > 0) {
      lines.push('');
      lines.push('# 还没刷新好（母本最高分读不到 / 子样本得分全为 0）  共 ' + state.notReadyList.length + ' 个');
      lines.push('# 合集id\t短剧名\t第5列原文\t尝试次数\t时间');
      state.notReadyList.forEach((s) => lines.push(
        [s.id, s.name, s.raw || '(空)', s.tries || 1, s.time].join('\t')));
    }
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
      <div class="p9-title" id="s9-title">短剧审核助手 9.2
        <button id="s9-min" class="p9-min" title="最小化/展开">—</button>
      </div>
      <div class="p9-statusline"><span id="s9-status">空闲</span></div>
      <div class="p9-main" id="s9-main">
        <div class="form-row">
          <label>起始行号：</label>
          <input type="number" id="start-row" value="${CONFIG.startRow}" min="1">
          <span>行（每轮扫描起点）</span>
        </div>
        <div class="form-row">
          <label>母本最高分：</label>
          <input type="number" id="parent-threshold" value="${CONFIG.parentScoreThreshold}" min="0" max="100">
          <span>阈值（仅日志标签）</span>
        </div>
        <div class="form-row">
          <label>母本最低线：</label>
          <input type="number" id="low-floor" value="${CONFIG.lowScoreFloor}" min="0" max="100">
          <span>最高分低于此→全错</span>
        </div>
        <div class="form-row">
          <label>母本分重读：</label>
          <input type="number" id="noscore-limit" value="${CONFIG.scoreRetryCount}" min="0" max="9">
          <span>读不到重读N次(0=立即跳过)</span>
        </div>
        <div class="form-row">
          <label>慢处理集数：</label>
          <input type="number" id="slow-threshold" value="${CONFIG.slowEpisodeThreshold}" min="1">
          <span>集以上（等待档位全部放宽）</span>
        </div>
        <div class="form-row">
          <label class="p9-check"><input type="checkbox" id="strict-loading" ${CONFIG.strictLoading ? 'checked' : ''}> <b>严格等待加载完成</b></label>
          <span>转圈消失才点下一步</span>
        </div>
        <div class="form-row">
          <label class="p9-check"><input type="checkbox" id="dry-run" ${CONFIG.dryRun ? 'checked' : ''}> <b>预演（只判定不点击）</b></label>
          <span>验证规则用</span>
        </div>
        <div class="form-row">
          <label class="p9-check"><input type="checkbox" id="report-log" ${CONFIG.reportEnabled ? 'checked' : ''}> <b>上报判定日志</b></label>
          <span>POST /judge_log</span>
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
      const lfEl = document.querySelector('#low-floor');
      const lf = lfEl ? parseInt(lfEl.value) : NaN;
      const nsEl = document.querySelector('#noscore-limit');
      const ns = nsEl ? parseInt(nsEl.value) : NaN;
      const s = parseInt(document.querySelector('#slow-threshold').value);
      const strictEl = document.querySelector('#strict-loading');
      if (!isNaN(row) && row > 0) CONFIG.startRow = row;
      if (!isNaN(p)) CONFIG.parentScoreThreshold = p;
      if (!isNaN(lf)) CONFIG.lowScoreFloor = lf;
      if (!isNaN(ns) && ns >= 0) CONFIG.scoreRetryCount = ns;
      if (!isNaN(s) && s > 0) CONFIG.slowEpisodeThreshold = s;
      if (strictEl) CONFIG.strictLoading = strictEl.checked;
      const rpEl = document.querySelector('#report-log');
      if (rpEl) CONFIG.reportEnabled = rpEl.checked;
      const drEl = document.querySelector('#dry-run');
      if (drEl) CONFIG.dryRun = drEl.checked;      // 9.3.0：预演（只判定不点击）
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
    state.notReadyIds = new Set();
    state.notReadyList = [];
    state.notReadyTries = new Map();
    state.giveUpIds = new Set();
    parentFilterWarned = false;   // 9.4.3：每轮重置"母本行过滤异常"提示
    childDumpDone = false;         // 9.2.0：每轮重置"子表列结构自检"
    state.errTries = new Map();    // 9.4.4：重置异常计数
    state.doneIds = new Set();
    state.lastJudge = null;
    state.curSlow = false;      // 9.1.9：本轮开始前重置"慢处理"档位
    reportCooldownUntil = 0;
    reportWarned = false;
    reportOkLogged = false;
    state.skipIds = new Set();
    state.skipList = [];
    state.workIndex = CONFIG.startRow - 1;
    document.querySelector('#start-btn').disabled = true;
    document.querySelector('#stop-btn').disabled = false;
    updatePanel();
    setStatus('启动中...');
    log('===== 开始运行（从第' + CONFIG.startRow + '行起）=====');
    log('运行模式：' + (CONFIG.dryRun
      ? '🧪 预演（只走判定与上报，不点任何按钮；结果见面板日志与 judge_log）'
      : '正式（会真实执行 全剧审核 / 批量错误 / 查询刷新）'));
    log('严格等待加载完成：' + (CONFIG.strictLoading ? '开（转圈消失才点下一步）' : '关') +
      '；等待上限 普通' + Math.round(CONFIG.loadingWaitMax / 1000) + 's / 慢合集' +
      Math.round(CONFIG.loadingWaitMaxSlow / 1000) + 's（9.1.9 起展开后加载、点击前/勾选前后闸门、' +
      '确认弹窗就绪都按此分档）');
    log('等待重试：第 ' + CONFIG.retryAtSec.join('s、') + 's 各重试点击一次（每按钮最多3次）；' +
      '仍无响应 → 永久跳过该合集换下一行（最多跳过 ' + CONFIG.maxSkipCount + ' 个）');
    log('母本最高分读不到（9.2.1）：先等加载完成并重读 ' + CONFIG.scoreRetryCount + ' 次（间隔 ' +
      CONFIG.scoreRetryGapMs + 'ms）；仍读不到 → 视为"母本还没刷新好"，本轮跳过该合集、继续审别的行，' +
      '刷新列表后自动重试并在结束时汇总（不再中断整轮运行）');
    log('扫描与结束（9.2.0）：每轮从第' + CONFIG.startRow + '行往下扫；「已审核」视为边界（下面都已审过）；' +
      '第2列 id 读不到的异常行跳过继续看；扫不到可审行时点「' + CONFIG.queryBtnText + '」刷新确认 ' +
      CONFIG.endConfirmRounds + ' 次，确认没有未审核行才判定审核结束');
    log('关键词（9.4.0：已取消终极关键词，全部双列比对；第3列命中的词第4列缺任一个 → 全错）｜当前表：' +
      CONFIG.nameKeywords.join('、'));
    log('母本最低线：母本最高分(第5列) < ' + CONFIG.lowScoreFloor +
      ' → 一律全错（90 分是底线，即使 777/601 够多也不救），当前状态码 ' +
      CONFIG.judgeCodes.join('/') + (CONFIG.lowScoreFloor > 0 ? '' : '（当前最低线已设为 0 = 关闭）'));
    log('判定（9.4.3）：' +
      '①关键词：第3列命中的词第4列缺任一个→全错（已取消终极关键词） ' +
      '②母本最高分<' + CONFIG.lowScoreFloor + '→全错（硬规则，不看子样本） ' +
      '③其余一律展开核对（得分=0/读不到的条不计入统计）：' +
      '低分(<' + CONFIG.lowScoreThreshold + ')条数 > 正确数据条数 → 全错（优先）；' +
      '否则 得分≥' + CONFIG.highScoreThreshold + ' 的条数≥' + CONFIG.highScoreMinCount +
      ' 或 ' + CONFIG.judgeCodes.join('/') + ' 各自≥' + CONFIG.correctCodeMinCount +
      '（有效行≤' + CONFIG.smallCollectionMaxRows + ' 条的小合集：≥' + CONFIG.correctCodeMinCountSmall +
      '）→模式1，都不满足→模式2；相似度与母本最高分只写日志、不再决定通过与否');
    log('模式2 收尾：批量错误(594)完成后点击「' + CONFIG.queryBtnText + '」刷新列表，不再点「全剧审核」');
    log('（面板已不再显示判定说明，完整规则见本段日志与源码注释）');
    log('判定日志上报：' + (CONFIG.reportEnabled
      ? ('开 → ' + CONFIG.backendBase + '/judge_log（记录 id 用【子样本第一条】(第2列)；查看 ' +
         CONFIG.backendBase + '/judge_log/view）')
      : '关'));
    // 结构自检：打印第1~2行解析结果，便于发现页面改版
    setTimeout(debugStructure, 1500);
    runLoop();
  }

  function stopRun() {
    state.running = false;
    document.querySelector('#start-btn').disabled = false;
    document.querySelector('#stop-btn').disabled = true;
  }

  // 结构自检：输出首行解析到的 ID/名字/母本最高分/集数/状态，方便确认选择器是否失效
  function debugStructure() {
    try {
      const rows = getParentRows();                      // 9.4.2：只自检母本行
      const allRows = Array.from(qsa(document, SELECTORS.parentRow));
      if (allRows.length !== rows.length) {
        console.log('[自检] 母本行 ' + rows.length + ' 行（已排除子表行 ' + (allRows.length - rows.length) +
          ' 行；子表行与母本行 class 相同，必须靠 isChildTableRow() 排掉）');
      }
      for (let i = 0; i < Math.min(2, rows.length); i++) {
        const meta = getCollectionMeta(rows[i]);
        const sim = checkSimilarOriginalName(rows[i], meta);
        console.log('[自检] 第' + (i + 1) + '行 → ID:[' + meta.id + '] 短剧名:[' + meta.name +
          '] 原短剧名:[' + meta.originalName + '] 母本最高分:' + (meta.score === null ? '-' : meta.score) +
          ' 集数:' + meta.episodes + ' 状态:[' + getRowStatus(rows[i]) + ']');
        console.log('[自检] 第' + (i + 1) + '行 相似判定（所有文本都算） → ' + (sim.similar ? '相似' : '不相似') +
          '（' + sim.detail + '）');
      }
      console.log('[自检] 子样本状态码列 = ' + SELECTORS.childCodeCell + '（0=未判定, ' +
        CONFIG.wrongCode + '=判错完成, ' + CONFIG.judgeCodes.join('/') + '=前人已判定(参与计数)）');
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
