"""
股价历史数据同步脚本（纯历史数据，不含新闻）
- 每月：更新全球标识库、清理不活跃股票、清理残留 stocks 文档
- 日常：同步 list 中自选股的历史数据
"""
import firebase_admin
from firebase_admin import credentials, firestore
import akshare as ak
from datetime import datetime, timedelta
import json
import os

def log(msg, level="INFO"):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] [{level}] {msg}")

if not firebase_admin._apps:
    if os.path.exists("serviceAccountKey.json"):
        cred = credentials.Certificate("serviceAccountKey.json")
    elif os.environ.get("FIREBASE_SERVICE_ACCOUNT"):
        cred = credentials.Certificate(json.loads(os.environ.get("FIREBASE_SERVICE_ACCOUNT")))
    else:
        raise RuntimeError("未找到 Firebase 私钥")
    firebase_admin.initialize_app(cred)

db = firestore.client(database_id="gupiaoyucedata")

# ---------- 月度清理逻辑 ----------
def clean_stale_and_orphans():
    log("开始月度清理")
    list_ref = db.collection("settings").document("list")
    list_doc = list_ref.get()
    if not list_doc.exists:
        log("list 不存在，跳过清理")
        return
    list_data = list_doc.to_dict()
    now = datetime.now()
    threshold = timedelta(days=30)
    symbols_to_remove = {}
    for field_name, value in list_data.items():
        if field_name in ["create_time", "create_by", "update_time", "stockNames"]:
            continue
        if isinstance(value, list) and len(value) >= 2:
            symbol = value[0]
            stock_ref = db.collection("stocks").document(symbol)
            stock_snap = stock_ref.get()
            if stock_snap.exists:
                data = stock_snap.to_dict()
                last = data.get("lastAccessed")
                if last is None or (now - last) > threshold:
                    symbols_to_remove[symbol] = field_name
            else:
                symbols_to_remove[symbol] = field_name
    if symbols_to_remove:
        batch = db.batch()
        for symbol, field_name in symbols_to_remove.items():
            log(f"清理不活跃股票: {symbol}")
            batch.update(list_ref, {field_name: firestore.DELETE_FIELD})
            batch.delete(db.collection("stocks").document(symbol))
        batch.commit()
        log(f"已清理 {len(symbols_to_remove)} 只不活跃股票")
    else:
        log("所有自选股近期均被访问")
    list_doc = list_ref.get()
    list_data_updated = list_doc.to_dict() if list_doc.exists else {}
    active_symbols = set()
    for key, val in list_data_updated.items():
        if isinstance(val, list) and len(val) >= 2:
            active_symbols.add(val[0])
    orphan_docs = []
    for doc in db.collection("stocks").stream():
        if doc.id not in active_symbols:
            orphan_docs.append(doc)
    if orphan_docs:
        batch = db.batch()
        for doc in orphan_docs:
            log(f"删除残留文档: {doc.id}")
            batch.delete(doc.reference)
        batch.commit()
        log(f"已清理 {len(orphan_docs)} 个残留 stocks 文档")
    else:
        log("无残留文档")
    log("月度清理完成")

# ---------- 全球标识库同步 ----------
def update_all_stock_identifiers():
    log("检查全球标识库")
    config_ref = db.collection("all_stocks").document("_config")
    config_doc = config_ref.get()
    current_date = datetime.now()
    should_update = True
    if config_doc.exists:
        last_update_str = config_doc.to_dict().get("lastUpdate_time")
        if last_update_str:
            last_update_date = datetime.strptime(last_update_str, "%Y-%m-%d")
            if (current_date - last_update_date).days < 30:
                log("未满一个月，跳过")
                should_update = False
    if not should_update:
        return
    log("抓取全量股票列表")
    try:
        df_hk = ak.stock_hk_spot_em()
        df_us = ak.stock_us_spot_em().head(10000)  # 扩大美股抓取范围
        now = datetime.now()
        existing_ids = set()
        all_stocks_snap = db.collection("all_stocks").select([]).get()
        for doc in all_stocks_snap:
            existing_ids.add(doc.id)
        batch = db.batch()
        written = 0
        for _, row in df_hk.iterrows():
            symbol = f"{row['代码']}.HK"
            data = {
                "displayName": f"{row['名称']}-{symbol}",
                "name": row['名称'],
                "symbol": symbol,
                "region": "港股",
                "update_time": now
            }
            ref = db.collection("all_stocks").document(symbol)
            if symbol in existing_ids:
                batch.update(ref, data)
            else:
                data["create_time"] = now
                data["create_by"] = "Gemini AI"
                batch.set(ref, data)
            written += 1
        for _, row in df_us.iterrows():
            symbol = row['代码']
            data = {
                "displayName": f"{row['名称']}-{symbol}",
                "name": row['名称'],
                "symbol": symbol,
                "region": "美股",
                "update_time": now
            }
            ref = db.collection("all_stocks").document(symbol)
            if symbol in existing_ids:
                batch.update(ref, data)
            else:
                data["create_time"] = now
                data["create_by"] = "Gemini AI"
                batch.set(ref, data)
            written += 1
        batch.commit()
        config_ref.set({
            "lastUpdate_time": current_date.strftime("%Y-%m-%d"),
            "update_time": now
        }, merge=True)
        log(f"all_stocks 同步完成，处理 {written} 只股票")
    except Exception as e:
        log(f"all_stocks 同步失败: {e}", "ERROR")
    clean_stale_and_orphans()

# ---------- 维护自选列表 ----------
def init_or_update_list_doc():
    log("检查 settings/list")
    list_ref = db.collection("settings").document("list")
    now = datetime.now()
    if not list_ref.get().exists:
        list_ref.set({
            "小米集团-W": ["01810", "港股", "小米集团-W"],
            "特斯拉":     ["TSLA",  "美股", "特斯拉"],
            "苹果":       ["AAPL",  "美股", "苹果"],
            "英伟达":     ["NVDA",  "美股", "英伟达"],
            "create_time": now,
            "create_by": "Gemini AI",
            "update_time": now
        })
        log("list 已创建")
    else:
        list_ref.update({"update_time": now})
        log("list 已更新")

# ---------- 单只股票历史数据同步 ----------
def smart_sync_logic(symbol, region):
    log(f"同步: {symbol} ({region})")
    try:
        doc_ref = db.collection("stocks").document(symbol)
        doc_snap = doc_ref.get()
        if region == "港股":
            api_code = symbol.zfill(5)
        else:
            api_code = symbol
        if region == "港股":
            df = ak.stock_hk_hist(symbol=api_code, period="daily", adjust="")
            df.rename(columns={'日期': 'date', '收盘': 'close'}, inplace=True)
        else:
            df = ak.stock_us_daily(symbol=api_code, adjust="qfq")
            df.rename(columns={'date': 'date', 'close': 'close'}, inplace=True)
        if df is None or df.empty:
            log(f"{symbol} 未获取到行情数据", "WARN")
            return
        now = datetime.now()
        new_data = {}
        for _, row in df.iterrows():
            date_str = str(row['date'])[:10]
            new_data[date_str] = round(float(row['close']), 2)
        if not doc_snap.exists:
            log(f"新建文档，拉取最近 30 天数据: {symbol}")
            latest_dates = sorted(new_data.keys())[-30:]
            new_entries = [{"date": d, "price": new_data[d]} for d in latest_dates]
            doc_ref.set({
                "history": new_entries,
                "forecast": [],
                "symbol": symbol,
                "create_time": now,
                "create_by": "Gemini AI",
                "update_time": now
            })
            log(f"文档已创建，写入 {len(new_entries)} 条历史数据")
        else:
            db_data = doc_snap.to_dict()
            old_history = db_data.get("history", [])
            existing_dates = {}
            for item in old_history:
                d = item["date"]
                existing_dates[d] = item["price"]
            latest_new = sorted(new_data.keys())[-30:]
            for d in latest_new:
                existing_dates[d] = new_data[d]
            merged_history = [{"date": k, "price": existing_dates[k]} for k in sorted(existing_dates.keys())]
            if merged_history == old_history:
                log(f"数据已是最新，无需更新: {symbol}")
                doc_ref.update({"update_time": now})
            else:
                doc_ref.update({
                    "history": merged_history,
                    "update_time": now
                })
                log(f"历史数据已更新，总记录数: {len(merged_history)}")
    except Exception as e:
        log(f"同步出错: {e}", "ERROR")

# ---------- 主入口 ----------
if __name__ == "__main__":
    update_all_stock_identifiers()
    init_or_update_list_doc()
    list_snap = db.collection("settings").document("list").get().to_dict()
    if list_snap:
        for field_name, value_array in list_snap.items():
            if field_name in ["create_time", "create_by", "update_time", "stockNames"]:
                continue
            if isinstance(value_array, list) and len(value_array) >= 2:
                symbol = value_array[0]
                region = value_array[1]
                smart_sync_logic(symbol, region)