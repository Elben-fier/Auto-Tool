// ==UserScript==
// @name         Shift短剧审核-相似度矩阵版【9.1】
// @namespace    https://doubao.com/userscripts
// @version      9.2.1
// @description  判定结果可上报本地后端日志（POST /judge_log，记录子样本第一条id与判定原因）；除硬规则（多字/单字终极关键词、普通关键词仅第3列、匹配分<低分下限）外一律展开核对：得分>95 的条数≥4 或 状态码 777/601 达标（子样本≤30条的小合集≥2、大合集≥4）→ 全剧审核；否则全选+批量错误后点「查询」刷新；含终极关键词、关键词双列比对、30s/60s重试、永久跳过、严格等待加载与慢处理档位
// @author       Doubao
// @match        https://tools.vobile.cn/quality/dramaReview*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-end
// ==/UserScript==

// ============================== 9.2.1 匹配分读不到：不再中断整轮（重读 → 跳过 → 刷新后重试） ==============================
//  【问题】9.1~9.2.0 的"相邻 3 行读不到匹配分 → 立即停止运行并弹窗"在实际使用中【经常误触发】：
//          列表/母本还在刷新时第5列会短暂为空，脚本却判为"页面改版"直接停下；
//          使用者往往"再点一次开始运行"就能继续（因为重启会清零连续计数），但过几条又停。
//  【本质】9.1.7 之后"匹配分读不到"已不再导致"直接全错"（改为展开核对），
//          所以这条"防整批误判"的保险已经没有必要用"中断整轮"来实现；
//          而"读不到"的真实含义多半就是需求里说的"该母本还没刷新好"。
//  【本次】把 noScoreStopCount（相邻N行读不到就停）改为三段式：
//    ① 重读：先等加载完成，再重读 scoreRetryCount 次（间隔 scoreRetryGapMs，默认 3 次 × 1.2s），
//           读到了就用新分数继续正常判定；
//    ② 跳过：仍读不到 → 记入 notReadyIds（=「还没刷新好」），本轮先跳过该合集、继续审别的行，
//           绝不判错、绝不中断整轮；点过「查询」刷新列表后自动清零并重试；
//    ③ 汇总：同一合集跳过 scoreGiveUpRounds 次（默认 3）仍读不到 → 本轮彻底放弃它
//           （进 giveUpIds，避免"跳过→结束确认→又扫到"来回打转），结束时在弹窗里列出
//           这些合集（含 id/短剧名/行号/第5列原文/尝试次数）供人工处理。
//  【安全网】本轮"还没刷新好"累计到 scoreSkipWarnCount（默认 5）时，面板日志提示
//           检查 SELECTORS.parentScoreCell —— 只提示，不停止运行。
//  【面板】「异常行上限（相邻N行读不到就停）」改为「匹配分重读：读不到重读N次(0=立即跳过)」。
//  【不变】判定规则、模式1/模式2 流程、扫描与结束判定（9.2.0）、慢处理档位（9.1.9）。
// ==========================================================================

// ============================== 9.2.0 扫描与结束判定（已审核=边界 + 结束前刷新确认） ==============================
//  【需求】"遇到已审核说明下面的数据都已经是审核过的了；看看是不是第一行，不是就说明可以往回审核试试；
//          遇到展开异常/母本没匹配分的说明该母本还没刷新好；能审则审，然后就说明审核结束了"
//  【本次】
//    ① pickTarget 改为【每一轮都从「起始行」往下扫】（不再沿用上一轮的下标）：
//       面板「起始行号」= 每轮的扫描起点；原"往下续扫 + 回绕到前面"的机制取消（每轮从顶扫本就覆盖全部）。
//    ② 「已审核」只作边界标记，不再当可审行（说明下面都已审过）；扫到的第一个可审行就是本轮目标。
//    ③ 第2列 id 读不到的行 → 视为"还没刷新好"的异常行：跳过它继续往下看，
//       不再像以前那样"一读不到就整脚本停止"；只有【整段所有行】id 都读不到才判为页面改版并停止。
//    ④ 扫不到可审行时不再立刻收工：先点「查询」刷新列表确认（默认两次 endConfirmRounds=2），
//       每次等加载完成 + endConfirmSettleMs(1.5s) 稳定后重扫；仍无可审行 → 判定审核结束。
//    ⑤ "审完"的口径 = 页面除了【已审核】与【已跳过的异常数据】之外，没有未审核行。
//  【不变】判定规则、模式1/模式2 流程、展开/判错/全剧审核/各类等待
//          （"相邻多行读不到匹配分即停止运行"这条保护已在 9.2.1 改为"重读 → 跳过 → 刷新后重试"）。
// ==========================================================================

// ============================== 9.1.9 慢处理档位全量生效（补齐未接线的等待闸门） ==============================
//  【背景】"慢处理"（集数 > slowEpisodeThreshold=300）本意是给大合集更宽的等待上限，
//          但原实现只接了 7 处；下面这些关键等待点无论快慢都按"普通"档位走：
//            · expandRowAndWait 内部"展开后等加载完成"（原固定用 loadingWaitMax）
//            · clickRowButton「点击按钮前」转圈闸门（原固定 loadingWaitMax）
//            · clickQuery「点击查询前」转圈闸门（原固定 loadingWaitMax）
//            · 模式2「勾选子样本前 / 勾选后等待就绪」两处闸门（原固定 loadingWaitMax）
//            · clickConfirm「确认弹窗就绪」等待（原硬编码 20000ms）
//          => 慢合集在这些点上并不更宽容，"慢处理"其实只生效了一半。
//  【本次】新增 state.curSlow（进入 processOneCollection 时按 meta.isSlow 登记）+ loadWaitMax()：
//          以上闸门统一走 loadWaitMax()（慢合集取 loadingWaitMaxSlow）；
//          「确认弹窗就绪」新增独立档位 confirmReadyWaitMax(20s) / confirmReadyWaitMaxSlow(40s)。
//  【不变】判定规则、模式1/模式2 流程，以及展开/判错/全剧审核/等待移走的既有档位全部不动。
//  【顺带】上报字段 version 由硬编码的 9.1.5 改为跟随本版本；修正 matchMode 的过期注释。
// ==========================================================================

// ============================== 9.1.8 601/777 门槛按合集大小分档 ==============================
//  【需求】"存在两个 601 或 777 也是对的" —— 但门槛不能一概而论，要看母本展开的数据量：
//        · 子样本条数 ≤ 30 条（小合集）→ 状态码 777 / 601 各自 ≥ 2 条即算"有前人数据"
//        · 子样本条数 >  30 条（大合集）→ 仍要求各自 ≥ 4 条
//  【配置】smallCollectionMaxRows(30) / correctCodeMinCountSmall(2) / correctCodeMinCount(4)
//  【不变】高分判据仍为"得分 > 95 的条数 ≥ highScoreMinCount(4)"；低分下限(90)仍是硬规则
// ==========================================================================

// ============================== 9.1.7 进一步降低"误判全错" ==============================
//  【背景】最怕的是"该对的被判全错"。原规则里有两条特别容易误杀：
//        ① 不相似 且 匹配分 ≤95 → 直接全错（连展开都不展开，看不到子样本里的大量高分数据）
//        ② 匹配分读不到        → 直接全错
//  【本次】这两条都改成【展开核对】；现在只有"匹配分 < 低分下限(90)"这一条硬规则会直接全错。
//  【展开核对统一判据】满足任一 → 模式1（全剧审核）：
//        · 子样本得分(第8列) > 95 的条数 ≥ 4            （大量高分数据 = 该合集质量好）
//        · 或 状态码 777 ≥ 4 条 ／ 601 ≥ 4 条（各自计）  （前人已判定）
//        都不满足 → 模式2（全错）
//  【说明】相似度与匹配分从此不再决定"通过与否"，只写进判定日志/理由，便于事后分析。
//          想调整松紧只改 CONFIG：highScoreThreshold / highScoreMinCount / correctCodeMinCount / lowScoreFloor
// ==========================================================================

// ============================== 9.1.6 修复：单字终极关键词误杀 ==============================
//  【问题】终极关键词里有单字「画」，规则是"第3列命中 → 直接全错，不执行任何后续判定"。
//          结果像「画币为诺，救恩父女是我的靠山」这种正常剧名（首字就是"画"）被直接判全错，
//          哪怕：两列完全相同（相似）、匹配分 98 > 95、子样本得分>95 有 6 条 —— 本该"通过"也没机会。
//  【修复】单字终极关键词改为"双列比对"：
//          · 第3列命中该字、第4列也有同一个字  → 不再直接判错，继续正常判定
//          · 第3列命中该字、第4列没有         → 仍然直接全错（保留拦截能力）
//          · 多字终极关键词（红果/充电专属/动画/免费/剪辑/花絮/拍摄/论剑大会/动漫/定档/首播）行为不变
// ==========================================================================

// ============================== 9.1.5 新增：判定日志上报 ==============================
//  【功能】每条合集判定都上报到本地后端，便于事后汇总/排查：
//        POST http://127.0.0.1:5002/judge_log   {"entries":[{...}]}
//        · 记录的 id 用【子样本第一条的 id】（子样本第2列），母本合集 id 仅作参考一并保留
//        · 一并记录：短剧名 / 原短剧名 / 匹配分 / 是否相似 / 相似明细 / 命中关键词 / 终极关键词 /
//                    判定模式(1/2) / 结果 / 判定原因(完整中文) / 777·601条数 / 高分(>95)条数 / 已打594 / 子样本总数
//        · 查看：浏览器打开 http://127.0.0.1:5002/judge_log/view （5秒自动刷新、可筛选、可导出CSV）
//  【安全】后端没开时只提示一次并冷却 60s，之后静默丢弃，完全不影响审核流程
//  【开关】面板勾选「上报判定日志」；CONFIG.reportEnabled / backendBase
// ==========================================================================

// ============================== 9.1.4 补充 ==============================
//  【本次】按需求移除面板底部的"判定说明"整块文本（.tip），面板更紧凑；
//          判定规则本身没有任何变化（规则细节见启动时控制台日志与源码注释）。
// ==========================================================================

// ============================== 9.1.3 补充 ==============================
//  【一】相似 且 匹配分 > 95 不再"直接全剧审核"，改为【展开核对】：
//        展开后满足任一条件才通过（模式1）：
//          · 子样本得分(第8列) > 95 的条数 ≥ 4 条
//          · 或 状态码 777 ≥ 4 条 ／ 601 ≥ 4 条（两个码各自计数，达到即算）
//        都不满足 → 模式2（全选 + 批量错误）
//        => 至此"通过"都必须展开核对，没有任何"不展开直接通过"的路径了
//  【二】全错处理（模式2）收尾动作改为点击页面「查询」刷新列表，不再点「全剧审核」
//  【三】"连续 N 行读不到匹配分就停止"改为按【页面上真正相邻的行】计数（中间夹着已审核/已跳过的行会打断），
//        并打印第5列原文便于排查；阈值可在面板调整
// ==========================================================================

// ============================== 9.1.2 补充（低分保护） ==============================
//  【问题】9.1.1 中"相似 且 匹配分 ≤95 → 展开看 777/601 → 通过"这条路径对匹配分没有下限：
//         只要两列被判为相似、子样本里 777 或 601 超过 3 条，即使匹配分只有十几分也会直接全剧审核通过。
//  【本次补充】新增低分下限保护 lowScoreFloor（默认 90，面板可调，0=关闭）：
//         · 匹配分 < lowScoreFloor → 一律【模式2：全选 + 批量错误 + 全剧审核】，不看 777/601，绝不可能通过
//         · 于是"通过"只剩两条路：
//              ① 相似 且 匹配分 > 95（不展开，直接全剧审核）
//              ② 匹配分 ≥ 下限 且 展开后 777/601 任一个 > 3 条（已展开，直接全剧审核）
// ==========================================================================

// ============================== 9.1.1 补充 ==============================
//  【本次补充】展开后的判定由"只有 777 > 3 条"改为"777 > 3 条【或】601 > 3 条（两个码各自计数）"：
//        · 展开后分别统计状态码 777 与 601 的条数
//        · 任一个 > 3 条（即 ≥ 4）→ 【模式1】直接点「全剧审核」
//        · 两个都不足 4 条        → 【模式2】全选 + 批量错误 + 全剧审核
//        · 配置：judgeCodes: ['777', '601']（合并了原来的 correctCodes），阈值仍为 correctCodeMinCount: 4
//        · 日志会分别打印「777 X 条 / 601 Y 条」，并在判定原因里写明是哪个码超限
// ==========================================================================

// ============================== 9.1.0 更新记录（相似度矩阵版） ==============================
//  【本次要求】相似度对"所有文本"生效（不再限制短剧名 ≤4 字），并按 相似度 × 匹配分 二维判定：
//        ① 相似 且 匹配分 > 95                  → 【模式1】不展开，直接点「全剧审核」
//        ② 相似 且 匹配分 ≤ 95                  → 【展开合集】数状态码 777 / 601 的条数（各自计数）：
//                                                 任一个 > 3 条 → 模式1（全剧审核）；都不足 → 模式2（全错）
//        ③ 不相似 且 匹配分 > 95                → 【展开合集】同 ② 判据（777 或 601 各自 > 3 条 → 模式1；否则模式2）
//        ④ 不相似 且 匹配分 ≤ 95                → 【模式2】直接全错（不数 777/601，仍走全选判错）
//        ⑤ 匹配分读不到                          → 【模式2】直接全错（不数 777/601，仍走全选判错）
//  【优先级】终级关键词 → 关键词双列比对 → 上面这张相似度矩阵（关键词规则仍最优先）
//  【与 9.0 的差异】
//        · 相似度不再受"短剧名字数 ≤4"限制，所有行都比对
//        · 90~95 那一档的特殊判据取消：现在 ≤95 一侧统一"展开数 777"
//        · 601 的计数规则见 9.1.1 补充（9.1.0 时只有 777 算数）；删除配置 bandScoreMin / similarGateNameLen
//  【沿用】终极关键词、关键词双列比对、严格等待加载（转圈闸门）、30s/60s 重试、
//          永久跳过（换下一行）、只用第2列 id 判断全剧审核完成
// ==========================================================================

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

  console.log('[短剧审核9.1] 相似度矩阵版已加载');

  // ========== 可配置项 ==========
  const CONFIG = {
    // —— 模式判定（9.1.0：相似度 × 匹配分 二维判定）——
    parentScoreThreshold: 95,      // 匹配最高分(第5列)：相似 且 > 该值 → 展开核对高分明细（9.1.3）
    highScoreThreshold: 95,        // 【展开核对】子样本得分(第8列) > 该值 视为"高分明细"
    highScoreMinCount: 4,          // 【展开核对】高分明细 ≥ 该条数 → 模式1（全剧审核）
    queryBtnText: '查询',          // 全错处理后的收尾：点击页面「查询」按钮刷新列表（不再点全剧审核）
    endConfirmRounds: 2,           // 9.2.0：扫不到可审行时，点「查询」刷新确认的次数（0=不确认直接结束）
    endConfirmSettleMs: 1500,      // 9.2.0：每次刷新确认后额外的稳定等待(ms)，等列表重排完再重扫
    lowScoreFloor: 90,             // 【低分保护】匹配分 < 该值 → 一律全错（不看 777/601，不可能通过）；0=关闭
    judgeCodes: ['777', '601'],    // 需要展开时统计的子样本状态码（两个码各自计数）
    correctCodeMinCount: 4,        // 【大合集】任一 judgeCode 的条数 ≥ 该值 → 模式1（子样本 > smallCollectionMaxRows 条时用）
    correctCodeMinCountSmall: 2,   // 【小合集】子样本 ≤ smallCollectionMaxRows 条时，门槛降为 ≥ 该值
    smallCollectionMaxRows: 30,    // 小合集的判定边界：子样本条数 ≤ 该值 视为小合集（9.1.8）
    scoreRetryCount: 3,            // 9.2.1：母本匹配分读不到时，先等加载完成并重读几次；仍读不到才算"还没刷新好"
    scoreRetryGapMs: 1200,         // 9.2.1：匹配分重读的间隔(ms)
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
    // —— 关键词规则（8.0：双列比对）——
    nameKeywords: ['短剧', '画', '漫剧', 'AI', '充电', '红果', '专属', '动画', '免费', '剪辑', '花絮', '拍摄', '经典', '剧', '真人', '免', '动漫', '动', '&', '定档', '首播', '漫', 'ai', '果'],
    // —— 9.0 终极关键词（最高优先级）：第3列一旦命中 → 直接全错，不看后续任何判定 ——
    //   9.1.6：多字关键词 → 命中即直接全错；单字关键词（如「画」）→ 需第4列也没有该字才全错
    ultimateKeywords: ['红果', '充电专属', '动画', '免费', '剪辑', '花絮', '拍摄', '论剑大会', '动漫', '定档', '首播', '画'],
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
  };

  // ========== 运行状态 ==========
  const state = {
    running: false,
    processedCount: 0,
    mode1Count: 0,       // 直接全剧审核次数
    mode2Count: 0,       // 全选判错次数
    notReadyIds: new Set(),  // 9.2.1：匹配分读不到 =「母本还没刷新好」的合集id（本轮先跳过，列表刷新后自动重试）
    notReadyList: [],        // 9.2.1：明细 {id,name,row,raw,tries,time}，结束时汇总提示
    notReadyTries: new Map(),// 9.2.1：id → 已跳过次数（超过 scoreGiveUpRounds 就本轮彻底放弃，防来回打转）
    giveUpIds: new Set(),    // 9.2.1：本轮彻底放弃的合集id（匹配分始终读不到，需人工处理）
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
    console.log('[短剧9.1] ' + msg);
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
    catch (e) { console.warn('[短剧9.1] 点击失败:', e.message || e); return false; }
  }

  // 9.1.9：当前合集的「等待加载完成」上限——慢合集取更宽的档位
  // 原实现只有部分位置判断了慢处理，导致 expandRowAndWait 内部、点击前闸门、勾选前后闸门
  // 无论快慢都按普通档走；这里统一取值，让「慢处理」真正全量生效。
  function loadWaitMax() {
    return state.curSlow ? CONFIG.loadingWaitMaxSlow : CONFIG.loadingWaitMax;
  }

  // ========== 9.2.1：母本匹配分（第5列）读取 ==========
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
      setStatus('等母本匹配分刷新（第 ' + i + '/' + tries + ' 次）...');
      if (CONFIG.strictLoading && i === 1) await waitLoadingDone('等母本匹配分刷新', loadWaitMax());
      await delay(CONFIG.scoreRetryGapMs);
      if (!R || !R.isConnected) {
        last = { score: null, raw: '(行已消失)' };
        continue;
      }
      last = readParentScore(R);
      if (last.score !== null) {
        log('✓ 匹配分已刷新出来：' + last.score + '（重读第 ' + i + ' 次）');
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
  // 9.1.9：等待弹窗就绪的档位也按"慢处理"分档（原来慢合集也只有硬编码的 20s）
  async function clickConfirm(timeout) {
    const confirmBtn = await waitForConfirmBtn(timeout);
    if (!confirmBtn) return false;
    if (CONFIG.strictLoading) {
      await waitLoadingDone('确认弹窗就绪',
        state.curSlow ? CONFIG.confirmReadyWaitMaxSlow : CONFIG.confirmReadyWaitMax);
    }
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
  // 9.1.6：只返回"多字"（≥2 字）终极关键词 —— 命中即直接全错
  function getUltimateKeyword(name) {
    if (!name) return '';
    for (const kw of CONFIG.ultimateKeywords) {
      if (kw && kw.length >= 2 && name.includes(kw)) return kw;
    }
    return '';
  }

  // 9.1.6：单字终极关键词（如「画」）—— 太宽，改为"双列比对"：第4列也有该字就不直接判错
  function getSingleCharUltimate(name) {
    if (!name) return '';
    for (const kw of CONFIG.ultimateKeywords) {
      if (kw && kw.length === 1 && name.includes(kw)) return kw;
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

  // 汇总当前展开子表：状态码分布 + 各 judgeCode(777/601) 条数 + 可读得分条数
  // 9.1.1：展开判定用"777 或 601 的条数（各自计数）"，故这里统计 judgeCounts
  function getCodeStats(expandedRow) {
    const rows = getChildRows(expandedRow);
    const counters = {};
    let unjudged = 0;
    let scoreKnown = 0;         // 能读到得分的条数（便于排查列错）
    let scoreHigh = 0;          // 9.1.3：得分 > highScoreThreshold 的条数（"高分明细"）
    const judgeCounts = {};     // 9.1.1：各 judgeCode 的子样本条数，如 {777: 5, 601: 0}
    CONFIG.judgeCodes.forEach((c) => { judgeCounts[c] = 0; });
    rows.forEach((row) => {
      const code = getChildCode(row);
      counters[code] = (counters[code] || 0) + 1;
      // 空值也视为未判定（避免列结构异常时被误认为已完成）
      if (code === CONFIG.unjudgedCode || code === '') unjudged++;
      if (CONFIG.judgeCodes.includes(code)) judgeCounts[code] = (judgeCounts[code] || 0) + 1;

      const sc = parseNum(cellText(row, SELECTORS.childScoreCell));
      if (sc !== null) {
        scoreKnown++;
        if (sc > CONFIG.highScoreThreshold) scoreHigh++;
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
      judgeCounts: judgeCounts,          // 各 judgeCode 的条数
      scoreHigh: scoreHigh,              // 得分 > highScoreThreshold 的条数
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
  async function waitReviewCompleted(meta, R, expandedRow, timeout, btnText, clickFn) {
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
    // 9.2.1：列表刷新后，之前"还没刷新好"（匹配分读不到）的合集重新参与扫描
    if (state.notReadyIds.size > 0) {
      log('↻ 列表已刷新 → 重新尝试之前读不到匹配分的 ' + state.notReadyIds.size + ' 个合集');
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
      script: '短剧审核9.1',
      version: '9.2.1',
      childId: c.childId || '',                 // 子样本第一条 id（子样本第2列）
      childRowText: c.childRowText || '',
      parentId: meta.id,                        // 母本合集 id（仅作参考）
      name: meta.name,
      originalName: meta.originalName,
      score: meta.score,
      episodes: meta.episodes,
      isSlow: !!meta.isSlow,
      similar: !!c.similar,
      simDetail: c.simDetail || '',
      keyword: c.kw || '',
      keywordDual: !!c.dual,
      ultimate: c.ultimate || '',
      matchMode: c.matchMode || '',             // 展开核对类型：similar-high / similar / dissimilar-high / dissimilar / no-score
      mode: res.mode || 0,
      result: res.result || '',
      outcome: res.result === 'ok'
        ? (res.mode === 1 ? '通过(全剧审核)' : '全错(批量错误)')
        : '异常/跳过',
      reason: res.reason || '',
      counts: {
        total: counts.total || 0,
        wrong594: counts.wrong || 0,
        scoreHigh: counts.scoreHigh || 0,
        judge777: judge['777'] || 0,
        judge601: judge['601'] || 0,
      },
    };
  }

  function reportJudge(meta, res, ctx) {
    if (!CONFIG.reportEnabled) return;
    try {
      reportQueue.push(buildJudgeEntry(meta, res, ctx));
      while (reportQueue.length > 300) reportQueue.shift();   // 后端长期不可用时避免内存膨胀
      flushReports();
    } catch (e) {
      console.warn('[短剧9.1] 组装判定日志失败:', e);
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
          log('⚠️ 判定日志上报失败（HTTP ' + r.status + '），丢弃 ' + batch.length + ' 条');
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

  // ========== 处理单个合集（9.1.3 判定：相似度 × 匹配分 + 低分保护 + 展开核对） ==========
  // 模式1（通过）：一律"展开核对后"才可能通过（点「全剧审核」；不勾选、不判错）
  // 模式2（全错）：展开 + 全选 + 批量错误（等全部594）→ 点「查询」刷新列表（不再点全剧审核）
  // 判定优先级（9.1.3）：
  //   ⓪ 多字终极关键词命中第3列                    → 模式2（不执行后续判定）
  //   ⓪-2 单字终极关键词（第4列也没有）              → 模式2
  //   ① 关键词双列比对：第3列命中且第4列无同词      → 模式2
  //   ② 匹配分 < 低分下限(lowScoreFloor)             → 模式2（唯一保留的硬规则：不看子样本）
  //   ③ 其余一切情况（相似/不相似、匹配分高/低/读不到）→ 展开核对（9.1.7 统一判据）：
  //        得分 > highScoreThreshold 的条数 ≥ highScoreMinCount  → 模式1
  //        或 777/601 各自 ≥ correctCodeMinCount                  → 模式1
  //        都不满足                                               → 模式2（全错）
  // 相似度判据（所有文本都比对）：连续 similarMinSubstr 字相同 或 公共不同字 ≥ similarMinCommonChars
  // 返回 { result: 'ok'|'problem', mode: 1|2, reason }
  async function processOneCollection(R, meta) {
    // 9.1.9：登记本合集是否慢处理 → 所有「等待加载完成」闸门统一由 loadWaitMax() 取值
    state.curSlow = !!meta.isSlow;
    const expandWait = meta.isSlow ? CONFIG.expandWaitMaxSlow : CONFIG.expandWaitMax;
    const expandFn = () => expandRowAndWait(R, expandWait);

    // ---- 第0步：严格等待上一轮遗留下的加载完成 ----
    const startLoadWait = meta.isSlow ? CONFIG.loadingWaitMaxSlow : CONFIG.loadingWaitMax;
    if (CONFIG.strictLoading && !(await waitLoadingDone('开始处理本轮前', startLoadWait))) {
      return { result: 'problem', mode: 0, reason: '上一轮加载未完成' };
    }

    // ---- 第1步：母行信息 + 终极关键词 + 关键词 + 相似度（不需要展开）----
    const ultimateKw = getUltimateKeyword(meta.name);          // 多字：命中即全错
    const singleUlt = getSingleCharUltimate(meta.name);        // 单字：还要看第4列（9.1.6）
    const kwr = getKeywordRule(R, meta);
    const sim = checkSimilarOriginalName(R, meta);
    const similar = sim.similar;   // 9.1.0：所有文本都比对相似度（不再限制短剧名字数）

    log('终极关键词检查：短剧名「' + meta.name + '」 → ' +
      (ultimateKw ? ('命中「' + ultimateKw + '」→ 直接全错（跳过所有后续判定）')
        : (singleUlt ? ('命中单字「' + singleUlt + '」→ 需看第4列是否也有该字（9.1.6）') : '未命中')));
    log('关键词比对：短剧名「' + meta.name + '」 vs 原短剧名「' + meta.originalName + '」 → ' +
      (kwr.kw ? ('命中「' + kwr.kw + '」，第4列' + (kwr.dual ? '也有该词 → 继续按匹配分判定' : '没有该词 → 直接全错'))
        : '第3列未命中关键词'));
    log('相似度比对（所有文本都算）：短剧名「' + meta.name + '」 vs 原短剧名「' + meta.originalName + '」(' +
      sim.nameLen + '字) → ' + (similar ? '相似' : '不相似') + '（' + sim.detail + '）');

    // 9.1.5：初始化本轮判定上下文（供上报日志；展开后会补上子样本首条 id 与统计数字）
    state.lastJudge = {
      childId: '', childRowText: '', similar: similar, simDetail: sim.detail,
      kw: kwr.kw || '', dual: !!kwr.dual,
      ultimate: ultimateKw || (singleUlt ? (singleUlt + '(单字,需双列)') : ''),
      matchMode: '', counts: null,
    };

    const score = meta.score;
    let mode = 0, reason = '';
    let needExpand = false, expandKind = '', expandReason = '';

    if (ultimateKw) {
      // ⓪ 多字终极关键词：第3列命中 → 直接全错，不看子样本
      mode = 2;
      reason = '【终极关键词】「' + ultimateKw + '」出现在第3列 → 直接全错（不执行后续判定）';
    } else if (singleUlt && !(meta.originalName || '').includes(singleUlt)) {
      // ⓪-2 单字终极关键词（9.1.6）：只有"第4列也没有这个字"时才全错
      mode = 2;
      reason = '单字终极关键词「' + singleUlt + '」只出现在第3列（第4列没有该字）→ 直接全错';
    } else if (kwr.hit) {
      // ① 第3列命中普通关键词、第4列没有 → 直接全错
      mode = 2;
      reason = '关键词「' + kwr.kw + '」仅出现在第3列（第4列无该词）→ 直接全错';
    } else if (score !== null && CONFIG.lowScoreFloor > 0 && score < CONFIG.lowScoreFloor) {
      // ② 低分保护（9.1.7：唯一保留的"不看子样本"硬规则）
      mode = 2;
      reason = '匹配分 ' + score + ' < 低分下限 ' + CONFIG.lowScoreFloor +
        ' → 直接全错（低分保护，不看子样本）' + (kwr.dual ? '（关键词两列都有）' : '');
    } else {
      // ③ 其余一切情况都展开核对（9.1.7）：
      //     相似/不相似、匹配分高/低/读不到 都不再直接判错，改由"子样本质量"决定
      needExpand = true;
      expandKind = (score === null)
        ? 'no-score'
        : (similar
            ? (score > CONFIG.parentScoreThreshold ? 'similar-high' : 'similar')
            : (score > CONFIG.parentScoreThreshold ? 'dissimilar-high' : 'dissimilar'));
      expandReason = '相似=' + (similar ? '是' : '否') + '、匹配分=' + (score === null ? '读不到' : score) +
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

    // 9.1.1：各判定码的条数，如 "777 5 条 / 601 0 条"；9.1.3：再加"得分 > 95 的条数"
    const judgeText = CONFIG.judgeCodes.map((c) => c + ' ' + (stats.judgeCounts[c] || 0) + ' 条').join(' / ');
    log('子样本统计：共 ' + stats.total + ' 条 | 状态码 ' + stats.detail +
      ' | ' + judgeText + ' | 得分>' + CONFIG.highScoreThreshold + ' ' + stats.scoreHigh + ' 条' +
      ' | 已打594 ' + stats.wrong + ' 条(可读得分 ' + stats.scoreKnown + ' 条)');

    // ---- 待定 → 按展开核对结果判定 ----
    if (needExpand) {
      // 9.1.7：展开核对统一判据（所有分支同一套）
      //   ① 高分数据够多：得分 > highScoreThreshold 的条数 ≥ highScoreMinCount
      //   ② 或 前人已判定：777 / 601 各自 ≥ 门槛（9.1.8：小合集 ≥2，大合集 ≥4）
      const smallColl = stats.total > 0 && stats.total <= CONFIG.smallCollectionMaxRows;
      const codeNeed = smallColl ? CONFIG.correctCodeMinCountSmall : CONFIG.correctCodeMinCount;
      const hitCodes = CONFIG.judgeCodes.filter((c) => (stats.judgeCounts[c] || 0) >= codeNeed);
      const highHit = stats.scoreHigh >= CONFIG.highScoreMinCount;
      const head = (similar ? '两列相似' : '两列不相似') + '、匹配分 ' +
        (score === null ? '读不到' : score) + '（' + expandKind + '），展开后：' +
        judgeText + ' / 得分>' + CONFIG.highScoreThreshold + ' ' + stats.scoreHigh + ' 条' +
        ' / 共 ' + stats.total + ' 条' + (smallColl ? ('（小合集，码门槛 ' + codeNeed + '）') : '');
      const hit = highHit || hitCodes.length > 0;
      if (hit) {
        mode = 1;
        reason = head + ' → ' + (highHit
          ? ('得分>' + CONFIG.highScoreThreshold + ' 的条数 ' + stats.scoreHigh + ' ≥ ' + CONFIG.highScoreMinCount)
          : ('状态码 ' + hitCodes.join('/') + ' 各自 ≥ ' + codeNeed + ' 条')) +
          ' → 判该合集正确';
      } else {
        mode = 2;
        reason = head + ' → 得分>' + CONFIG.highScoreThreshold + ' 不足 ' + CONFIG.highScoreMinCount +
          ' 条，且没有判定码 ≥ ' + codeNeed + ' 条 → 全错';
      }
      log('===== 补充判定模式' + mode + '：' + reason + ' =====');
      setStatus('模式' + mode + '：' + reason);
      if (mode === 1) {
        log('模式1 → 已展开，直接全剧审核（不勾选、不判错）');
        const r = await doFullReview(R, meta, null, expandedRow);
        return { result: r, mode: 1, reason: reason };
      }
    }

    // ---- 模式2：全选 + 批量错误（等全部594）+ 全剧审核 ----
    // 注意：无论当前子样本是什么状态（哪怕没有 0），都必须执行"全选 + 批量错误"，不能跳过判错。
    // 严格等待：勾选前确保子表已渲染完（无转圈）
    if (CONFIG.strictLoading && !(await waitLoadingDone('勾选子样本前', loadWaitMax()))) {
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
    if (CONFIG.strictLoading && !(await waitLoadingDone('勾选后等待就绪', loadWaitMax()))) {
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
    const rows = Array.from(qsa(document, SELECTORS.parentRow));
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
      if (state.notReadyIds.has(meta.id)) continue;      // 9.2.1：匹配分读不到=还没刷新好，本轮先跳过
      if (state.giveUpIds.has(meta.id)) continue;        // 9.2.1：多次刷新仍读不到匹配分，本轮已放弃
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
  // 扫不到可审行时先别急着收工：列表可能还在刷新（母本没匹配分 / 展开异常都可能是"还没刷新好"），
  // 所以点「查询」刷新列表再看一眼 —— 默认点两次（CONFIG.endConfirmRounds）。
  // 返回：刷新后出现的可审行对象（说明还没审完，继续审） | null（确认已审完）
  async function confirmReviewFinished(why) {
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
    let abortReason = '';       // 9.1 保护：非正常停止的原因（连续读不到匹配分）
    while (state.running) {
      try {
        let target = pickTarget();
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
          if (!target) { done = true; break; }
        }

        const R = target.R, meta = target.meta;

        // ---- 9.2.1：匹配分读不到 = "母本还没刷新好"，不再中断整轮运行 ----
        // 旧做法（9.1~9.2.0）：相邻 3 行读不到匹配分 → 判为选择器失效，立即停止并弹窗；
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
              log('⛔ 第' + (target.idx + 1) + '行「' + meta.name + '」匹配分多次刷新仍读不到（第5列原文「' +
                (sc.raw || '(空)') + '」，已试 ' + tries + ' 次）→ 本轮放弃该合集，结束时汇总，可人工处理');
            } else {
              log('⏸ 第' + (target.idx + 1) + '行「' + meta.name + '」匹配分读不到（第5列原文「' +
                (sc.raw || '(空)') + '」，第 ' + tries + '/' + CONFIG.scoreGiveUpRounds + ' 次）→ ' +
                '视为母本还没刷新好：本轮先跳过它、继续审别的行（刷新列表后自动重试）');
            }
            if (state.notReadyList.length === CONFIG.scoreSkipWarnCount) {
              log('⚠️ 本轮已有 ' + state.notReadyList.length + ' 个合集读不到匹配分。脚本不会因此停止；' +
                '但如果整表都读不到，请检查 SELECTORS.parentScoreCell（第5列）是否失效');
            }
            updatePanel();
            continue;                     // 不判错、不展开，继续扫下一行
          }
        }

        log('===== 处理 第' + (target.idx + 1) + '行 合集[' + meta.id + ']「' + meta.name +
          '」集数' + meta.episodes + ' 匹配分' + (meta.score === null ? '-' : meta.score) +
          (meta.isSlow ? '（慢处理）' : '') + ' =====');

        const res = await processOneCollection(R, meta);
        reportJudge(meta, res, state.lastJudge);   // 9.1.5：上报判定日志（后端没开也不影响审核）
        if (!state.running) break;

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
          break;
        }
        // 从下一行开始找目标（永久跳过当前合集）
        state.workIndex = target.idx + 1;
      } catch (e) {
        console.error('[短剧9.1] 主循环异常:', e);
        log('主循环异常: ' + (e.message || e) + '，3秒后继续');
        await delay(3000);
      }
    }
    setStatus(abortReason ? ('⛔ 已停止：' + abortReason) : (done ? '全部处理完成' : '已停止'));
    stopRun();
    if (!done && abortReason) {
      setTimeout(() => alert('⚠️ 脚本已自动停止\n原因：' + abortReason +
        '\n\n已处理 ' + state.processedCount + ' 个合集；本行及之后的行未处理。' +
        '\n请按 F12 查看控制台「自检」输出，确认 SELECTORS（第2列 id / 第5列匹配分）是否失效。'), 100);
    }
    if (done) {
      const skipText = state.skipList.length > 0
        ? ('\n跳过 ' + state.skipList.length + ' 个合集（需人工处理）：\n' +
           state.skipList.slice(0, 10).map((s) => ' · [' + s.id + '] ' + s.name + ' ← ' + s.reason).join('\n') +
           (state.skipList.length > 10 ? '\n …（其余见面板「复制跳过清单」）' : ''))
        : '\n（无跳过合集）';
      const notReadyText = state.notReadyList.length > 0
        ? ('\n\n⏸ 还没刷新好（匹配分读不到）' + state.notReadyList.length + ' 个，本轮未处理：\n' +
           state.notReadyList.slice(0, 8).map((s) => ' · [' + s.id + '] ' + s.name +
             '（第' + s.row + '行，第5列原文「' + (s.raw || '(空)') + '」，试了' + (s.tries || 1) + '次）').join('\n') +
           (state.notReadyList.length > 8 ? '\n …（其余见面板日志）' : '') +
           (state.giveUpIds.size > 0 ? ('\n其中 ' + state.giveUpIds.size + ' 个多次刷新仍读不到，本轮已放弃，需人工处理') : '') +
           '\n可再点一次「开始运行」重试这些合集')
        : '';
      setTimeout(() => alert('处理完成！共处理 ' + state.processedCount + ' 个合集\n模式1(直接全剧审核) ' +
        state.mode1Count + ' 个 / 模式2(全选判错) ' + state.mode2Count + ' 个' +
        '\n结束确认：已点「' + CONFIG.queryBtnText + '」刷新 ' + CONFIG.endConfirmRounds +
        ' 次，未再发现未审核行' + skipText + notReadyText), 100);
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
      <div class="p9-title" id="s9-title">短剧审核助手 9.1
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
          <label>匹配分阈值：</label>
          <input type="number" id="parent-threshold" value="${CONFIG.parentScoreThreshold}" min="0" max="100">
          <span>分以上=有正确数据</span>
        </div>
        <div class="form-row">
          <label>低分下限：</label>
          <input type="number" id="low-floor" value="${CONFIG.lowScoreFloor}" min="0" max="100">
          <span>低于该分一律全错</span>
        </div>
        <div class="form-row">
          <label>匹配分重读：</label>
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
    log('严格等待加载完成：' + (CONFIG.strictLoading ? '开（转圈消失才点下一步）' : '关') +
      '；等待上限 普通' + Math.round(CONFIG.loadingWaitMax / 1000) + 's / 慢合集' +
      Math.round(CONFIG.loadingWaitMaxSlow / 1000) + 's（9.1.9 起展开后加载、点击前/勾选前后闸门、' +
      '确认弹窗就绪都按此分档）');
    log('等待重试：第 ' + CONFIG.retryAtSec.join('s、') + 's 各重试点击一次（每按钮最多3次）；' +
      '仍无响应 → 永久跳过该合集换下一行（最多跳过 ' + CONFIG.maxSkipCount + ' 个）');
    log('匹配分读不到（9.2.1）：先等加载完成并重读 ' + CONFIG.scoreRetryCount + ' 次（间隔 ' +
      CONFIG.scoreRetryGapMs + 'ms）；仍读不到 → 视为"母本还没刷新好"，本轮跳过该合集、继续审别的行，' +
      '刷新列表后自动重试并在结束时汇总（不再中断整轮运行）');
    log('扫描与结束（9.2.0）：每轮从第' + CONFIG.startRow + '行往下扫；「已审核」视为边界（下面都已审过）；' +
      '第2列 id 读不到的异常行跳过继续看；扫不到可审行时点「' + CONFIG.queryBtnText + '」刷新确认 ' +
      CONFIG.endConfirmRounds + ' 次，确认没有未审核行才判定审核结束');
    log('终极关键词：多字命中即全错，单字（' +
      CONFIG.ultimateKeywords.filter((k) => k && k.length === 1).join('、') +
      '）改为双列比对（第4列也有则不判错）｜当前表：' + CONFIG.ultimateKeywords.join('、'));
    log('低分保护：匹配分 < ' + CONFIG.lowScoreFloor + ' → 一律全错，不看状态码 ' +
      CONFIG.judgeCodes.join('/') + (CONFIG.lowScoreFloor > 0 ? '' : '（当前已关闭）'));
    log('判定（9.1.7：除低分下限外一律展开核对）：' +
      '⓪多字终极关键词→全错 ⓪-2单字终极关键词(第4列也没有)→全错 ①关键词仅第3列→全错 ' +
      '②匹配分<' + CONFIG.lowScoreFloor + '→全错（唯一硬规则，不看子样本） ' +
      '③其余一律展开核对：得分>' + CONFIG.highScoreThreshold + ' 的条数≥' + CONFIG.highScoreMinCount +
      ' 或 ' + CONFIG.judgeCodes.join('/') + ' 各自≥' + CONFIG.correctCodeMinCount +
      '（子样本≤' + CONFIG.smallCollectionMaxRows + ' 条的小合集：≥' + CONFIG.correctCodeMinCountSmall +
      '）→模式1，都不满足→模式2；相似度与匹配分只写日志、不再决定通过与否');
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
