"""判定日志服务（短剧审核脚本上报）

用途：把油猴脚本每条"合集判定"记录落盘并可视化管理。
  · 存储：追加写 JSONL（backend/logs/judge_log.jsonl），一行一条，utf-8
  · 上报：POST /judge_log           body: {"entries":[{...}, ...]} 或单条对象
  · 查询：GET  /judge_log           参数 limit/offset/mode/outcome/q（JSON）
  · 统计：GET  /judge_log/stats     按结果/模式/原因聚合
  · 导出：GET  /judge_log/export    CSV（带 BOM，Excel 直接打开不乱码）
  · 查看：GET  /judge_log/view      简单网页表格（5 秒自动刷新）
  · 清空：POST /judge_log/clear

注意：id 以"子样本第一条 id"（子样本第2列）为准，母本合集 id 只作参考保留。
"""

import csv
import io
import json
import os
import threading
import time

from flask import Blueprint, Response, current_app, jsonify, request

LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
LOG_FILE = os.path.join(LOG_DIR, "judge_log.jsonl")
MAX_ROWS_READ = 20000        # 单次最多读取的尾部行数
MAX_ROWS_VIEW = 500          # 网页默认展示条数
_write_lock = threading.Lock()

judge_log_bp = Blueprint("judge_log", __name__)

# CSV / 表格列定义：(内部字段, 表头)
COLUMNS = [
    ("time", "时间"),
    ("kind", "类型"),
    ("dataId", "数据id(第2列)"),
    ("keyId", "key_id"),
    ("childId", "子样本首条id"),
    ("parentId", "母本合集id"),
    ("name", "短剧名"),
    ("originalName", "疑似原短剧名"),
    ("score", "匹配分"),
    ("episodes", "集数"),
    ("similar", "相似"),
    ("mode", "模式"),
    ("outcome", "结果"),
    ("counts.judge777", "777条数"),
    ("counts.judge601", "601条数"),
    ("counts.scoreHigh", "高分>95"),
    ("counts.wrong594", "已打594"),
    ("counts.total", "子样本总数"),
    ("matchMode", "展开核对"),
    ("keyword", "命中关键词"),
    ("ultimate", "终极关键词"),
    ("reason", "判定原因"),
    ("simDetail", "相似明细"),
    ("detailText", "检测明细"),
    ("isSlow", "慢合集"),
    ("version", "脚本版本"),
    ("received_at", "服务端接收时间"),
]


# ---------------------------------------------------------------------------
# 存取
# ---------------------------------------------------------------------------
def _ensure_dir():
    os.makedirs(LOG_DIR, exist_ok=True)


def _dig(rec, path):
    """取嵌套字段：counts.judge777 → rec['counts']['judge777']"""
    cur = rec
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
    return cur


def _append_entries(entries):
    _ensure_dir()
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    written = 0
    with _write_lock:
        with io.open(LOG_FILE, "a", encoding="utf-8") as f:
            for e in entries:
                if not isinstance(e, dict):
                    continue
                rec = dict(e)
                rec.setdefault("received_at", now)
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                written += 1
    return written


def _read_tail(limit=MAX_ROWS_READ):
    """读取文件末尾 limit 行（返回按时间正序的列表）"""
    if not os.path.exists(LOG_FILE):
        return []
    with _write_lock:
        with io.open(LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    if limit and len(lines) > limit:
        lines = lines[-limit:]
    out = []
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        try:
            out.append(json.loads(ln))
        except Exception:
            continue
    return out


def _filter(records, mode=None, outcome=None, q=None):
    def keep(r):
        if mode and str(r.get("mode", "")) != str(mode):
            return False
        if outcome and outcome not in str(r.get("outcome", "")):
            return False
        if q:
            hay = " ".join([
                str(r.get("childId", "")), str(r.get("parentId", "")),
                str(r.get("name", "")), str(r.get("originalName", "")),
                str(r.get("reason", "")),
            ])
            if q not in hay:
                return False
        return True
    return [r for r in records if keep(r)]


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------
@judge_log_bp.route("/judge_log", methods=["POST", "OPTIONS"])
def judge_log_post():
    if request.method == "OPTIONS":
        return Response("", status=204)

    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"ok": False, "error": "请求体不是合法 JSON"}), 400

    if isinstance(data, dict) and isinstance(data.get("entries"), list):
        entries = data["entries"]
    elif isinstance(data, list):
        entries = data
    elif isinstance(data, dict) and data:
        entries = [data]                       # 允许直接提交单条
    else:
        return jsonify({"ok": False, "error": "entries 为空"}), 400

    if not entries:
        return jsonify({"ok": False, "error": "entries 为空"}), 400

    written = _append_entries(entries)
    current_app.logger.info("判定日志: 接收 %d 条 → 落盘 %d 条 (%s)", len(entries), written, LOG_FILE)
    return jsonify({"ok": True, "written": written, "file": LOG_FILE})


@judge_log_bp.route("/judge_log", methods=["GET"])
def judge_log_get():
    limit = request.args.get("limit", type=int) or 200
    offset = request.args.get("offset", type=int) or 0
    mode = request.args.get("mode") or None
    outcome = request.args.get("outcome") or None
    q = (request.args.get("q") or "").strip() or None

    records = _filter(_read_tail(), mode=mode, outcome=outcome, q=q)
    total = len(records)
    records = records[::-1]                    # 最新在前
    page = records[offset:offset + limit]
    return jsonify({"ok": True, "total": total, "offset": offset, "limit": limit, "entries": page})


@judge_log_bp.route("/judge_log/stats", methods=["GET"])
def judge_log_stats():
    records = _read_tail()
    by_outcome, by_mode, by_reason = {}, {}, {}
    score_hist = {"<90": 0, "90-95": 0, ">95": 0, "未知": 0}
    for r in records:
        by_outcome[r.get("outcome", "?")] = by_outcome.get(r.get("outcome", "?"), 0) + 1
        by_mode[str(r.get("mode", "?"))] = by_mode.get(str(r.get("mode", "?")), 0) + 1
        reason = str(r.get("reason", ""))[:60] or "(空)"
        by_reason[reason] = by_reason.get(reason, 0) + 1
        s = r.get("score")
        try:
            s = float(s)
            key = "<90" if s < 90 else ("90-95" if s <= 95 else ">95")
        except (TypeError, ValueError):
            key = "未知"
        score_hist[key] += 1
    top_reasons = sorted(by_reason.items(), key=lambda kv: -kv[1])[:20]
    return jsonify({
        "ok": True,
        "total": len(records),
        "by_outcome": by_outcome,
        "by_mode": by_mode,
        "score_hist": score_hist,
        "top_reasons": [{"reason": k, "count": v} for k, v in top_reasons],
        "file": LOG_FILE,
    })


@judge_log_bp.route("/judge_log/export", methods=["GET"])
def judge_log_export():
    mode = request.args.get("mode") or None
    outcome = request.args.get("outcome") or None
    q = (request.args.get("q") or "").strip() or None
    records = _filter(_read_tail(), mode=mode, outcome=outcome, q=q)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([title for _, title in COLUMNS])
    for r in records:
        row = []
        for key, _ in COLUMNS:
            v = _dig(r, key)
            if isinstance(v, bool):
                v = "是" if v else "否"
            row.append("" if v is None else v)
        writer.writerow(row)

    fname = "judge_log_%s.csv" % time.strftime("%Y%m%d_%H%M%S")
    body = "\ufeff" + buf.getvalue()          # BOM：Excel 直接打开不乱码
    return Response(
        body,
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="%s"' % fname},
    )


@judge_log_bp.route("/judge_log/clear", methods=["POST"])
def judge_log_clear():
    _ensure_dir()
    with _write_lock:
        if os.path.exists(LOG_FILE):
            os.remove(LOG_FILE)
    current_app.logger.warning("判定日志已清空: %s", LOG_FILE)
    return jsonify({"ok": True, "cleared": LOG_FILE})


@judge_log_bp.route("/judge_log/view", methods=["GET"])
def judge_log_view():
    mode = request.args.get("mode") or None
    outcome = request.args.get("outcome") or None
    q = (request.args.get("q") or "").strip() or None
    limit = request.args.get("limit", type=int) or MAX_ROWS_VIEW
    auto = request.args.get("auto", "1") != "0"

    records = _filter(_read_tail(), mode=mode, outcome=outcome, q=q)
    total = len(records)
    rows = list(reversed(records))[:limit]

    def cell(r, key):
        v = _dig(r, key)
        if isinstance(v, bool):
            v = "是" if v else "否"
        if v is None:
            return ""
        s = str(v)
        if key == "reason":
            return _esc(s)
        return _esc(s[:80])

    trs = []
    for r in rows:
        outcome_txt = str(r.get("outcome", ""))
        cls = "ok" if outcome_txt.startswith("通过") else ("bad" if outcome_txt.startswith("全错") else "warn")
        tds = "".join('<td>%s</td>' % cell(r, key) for key, _ in COLUMNS)
        trs.append('<tr class="%s">%s</tr>' % (cls, tds))

    head = "".join("<th>%s</th>" % title for _, title in COLUMNS)
    refresh = '<meta http-equiv="refresh" content="5">' if auto else ""

    stats = judge_log_stats().get_json()
    summary = "总记录 %d ｜ 通过 %d ｜ 全错 %d ｜ 异常 %d ｜ 匹配分分布 %s" % (
        stats.get("total", 0),
        stats.get("by_outcome", {}).get("通过(全剧审核)", 0),
        stats.get("by_outcome", {}).get("全错(批量错误)", 0),
        stats.get("by_outcome", {}).get("异常/跳过", 0),
        stats.get("score_hist", {}),
    )

    def sel(name, value, options):
        opts = "".join(
            '<option value="%s"%s>%s</option>' % (v, " selected" if (value or "") == v else "", label)
            for v, label in options
        )
        return '<select name="%s">%s</select>' % (name, opts)

    html = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>短剧审核 · 判定日志</title>%(refresh)s
<style>
 body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;margin:16px;color:#222;background:#fafafa;}
 h2{margin:0 0 6px;}
 .bar{margin:10px 0;padding:8px 10px;background:#fff;border:1px solid #eee;border-radius:6px;font-size:13px;}
 .bar a,.bar button{margin-left:8px;}
 table{border-collapse:collapse;width:100%%;background:#fff;font-size:12px;}
 th,td{border:1px solid #eee;padding:4px 6px;text-align:left;vertical-align:top;}
 th{background:#f5f5f5;position:sticky;top:0;}
 tr.ok td{background:#f6ffed;} tr.bad td{background:#fff1f0;} tr.warn td{background:#fffbe6;}
 .muted{color:#888;font-size:12px;}
</style></head><body>
<h2>短剧审核 · 判定日志</h2>
<div class="bar">
  %(summary)s<br>
  <span class="muted">文件：%(file)s</span>
  <form method="get" style="display:inline">
    %(mode_sel)s %(outcome_sel)s
    <input type="text" name="q" placeholder="搜索 id/短剧名/原因" value="%(q)s">
    <input type="number" name="limit" value="%(limit)d" style="width:70px">
    <label><input type="checkbox" name="auto" value="0" %(auto_unchecked)s>暂停自动刷新</label>
    <button type="submit">筛选</button>
  </form>
  <a href="/judge_log/export?mode=%(mode)s&outcome=%(outcome)s&q=%(q)s">导出 CSV</a>
  <a href="/judge_log/stats">统计 JSON</a>
  <form method="post" action="/judge_log/clear" style="display:inline"
        onsubmit="return confirm('确定清空全部判定日志？此操作不可恢复');">
    <button type="submit">清空日志</button>
  </form>
</div>
<table><thead><tr>%(head)s</tr></thead><tbody>%(rows)s</tbody></table>
<p class="muted">显示 %(shown)d / %(total)d 条（最新在前）</p>
</body></html>""" % {
        "refresh": refresh,
        "summary": summary,
        "file": _esc(LOG_FILE),
        "head": head,
        "rows": "".join(trs) or '<tr><td colspan="%d">（暂无记录）</td></tr>' % len(COLUMNS),
        "shown": len(rows),
        "total": total,
        "limit": limit,
        "q": _esc(q or ""),
        "mode": _esc(mode or ""),
        "outcome": _esc(outcome or ""),
        "mode_sel": sel("mode", mode, [("", "全部模式"), ("1", "模式1(通过)"), ("2", "模式2(全错)")]),
        "outcome_sel": sel("outcome", outcome, [("", "全部结果"), ("通过", "通过"), ("全错", "全错"), ("异常", "异常/跳过")]),
        "auto_unchecked": "" if auto else "checked",
    }
    return Response(html, mimetype="text/html; charset=utf-8")


def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))
