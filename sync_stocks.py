"""
股价历史数据同步脚本（纯历史数据，不含新闻）
- 每月：更新全球标识库、清理不活跃股票、清理残留 stocks 文档
- 日常：同步 list 中自选股的历史数据
- 美股全量列表从 GitHub JSON 文件获取（避免 AkShare 东财接口被限）
- 港股全量列表继续使用 AkShare
"""
import firebase_admin
from firebase_admin import credentials, firestore
import akshare as ak
from datetime import datetime, timedelta
import json
import os
import requests
import time
import random


# ---------- 数据源 URL ----------
US_STOCK_JSON_URLS = {
    "NASDAQ": "https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/nasdaq/nasdaq_full_tickers.json",
    "NYSE":   "https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/nyse/nyse_full_tickers.json",
    "AMEX":   "https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/amex/amex_full_tickers.json",
}

def log(msg, level="INFO"):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] [{level}] {msg}")

# ---------- 设置全局请求头 ----------
session = requests.Session()
session.headers.update({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.8,en-US;q=0.5,en;q=0.3',
    'Connection': 'keep-alive'
})

if not firebase_admin._apps:
    if os.path.exists("serviceAccountKey.json"):
        cred = credentials.Certificate("serviceAccountKey.json")
    elif os.environ.get("FIREBASE_SERVICE_ACCOUNT"):
        cred = credentials.Certificate(json.loads(os.environ.get("FIREBASE_SERVICE_ACCOUNT")))
    else:
        raise RuntimeError("未找到 Firebase 私钥")
    firebase_admin.initialize_app(cred)

db = firestore.client(database_id="gupiaoyucedata")

# ---------- 从 JSON 文件提取美股全量列表 ----------
def fetch_us_stock_list_from_json():
    """从 rreichel3/US-Stock-Symbols 的 JSON 文件获取美股全量列表，合并去重"""
    all_stocks = []
    seen_symbols = set()

    log("开始从 GitHub JSON 文件下载美股全量列表")

    for exchange_name, url in US_STOCK_JSON_URLS.items():
        try:
            log(f"下载 {exchange_name} 数据: {url}")
            resp = session.get(url, timeout=30)
            resp.raise_for_status()
            raw_data = resp.json()

            if not isinstance(raw_data, list):
                log(f"{exchange_name} 数据格式异常，跳过", "WARN")
                continue

            valid_count = 0
            for item in raw_data:
                if not isinstance(item, dict):
                    continue

                # 提取 symbol（大小写不敏感）
                symbol = None
                for key in ['symbol', 'Symbol', 'SYMBOL', 'ticker', 'Ticker']:
                    val = item.get(key)
                    if isinstance(val, str) and val.strip():
                        symbol = val.strip().upper()
                        break
                if not symbol:
                    continue

                # 提取 name
                name = None
                lower_map = {str(k).lower(): v for k, v in item.items()}
                for key in ['name', 'company', 'company name', 'companyname',
                            'security name', 'securityname', 'security']:
                    val = lower_map.get(key)
                    if isinstance(val, str) and val.strip():
                        name = val.strip()
                        break
                if not name:
                    name = symbol  # 无名称时用代码

                # 去重
                if symbol not in seen_symbols:
                    seen_symbols.add(symbol)
                    all_stocks.append({
                        "symbol": symbol,
                        "name": name,
                        "displayName": f"{name}-{symbol}",
                        "region": "美股"
                    })
                    valid_count += 1

            log(f"{exchange_name} 获取到 {valid_count} 只有效股票")

        except Exception as e:
            log(f"下载 {exchange_name} 失败: {e}", "ERROR")
            # 单个交易所失败不影响其他交易所，继续处理

    log(f"美股全量列表下载完成，共 {len(all_stocks)} 只股票（三大交易所去重后）")
    return all_stocks

# ---------- 带指数退避的港股取数函数 ----------
def fetch_stock_list_with_retry(fetch_func, name, max_retries=3, base_delay=2):
    for attempt in range(max_retries):
        try:
            delay = base_delay * (2 ** attempt) + random.uniform(0, 2)
            log(f"{name} 尝试第 {attempt+1}/{max_retries} 次，等待 {delay:.1f} 秒")
            time.sleep(delay)
            df = fetch_func()
            if df is not None and not df.empty:
                log(f"{name} 取数成功，获取到 {len(df)} 条数据")
                return df
            else:
                log(f"{name} 取数结果为空，重试中...", "WARN")
        except Exception as e:
            log(f"{name} 取数失败 (尝试 {attempt+1}/{max_retries}): {e}", "ERROR")
            if attempt == max_retries - 1:
                log(f"{name} 重试耗尽，最终失败", "ERROR")
                return None
            wait_time = base_delay * (2 ** attempt) + random.uniform(1, 3)
            log(f"{name} 等待 {wait_time:.1f} 秒后重试...", "WARN")
            time.sleep(wait_time)
    return None

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

    log("开始抓取全量股票列表")
    try:
        # ★ 港股：使用 AkShare
        log("抓取港股全量列表（AkShare）")
        df_hk = fetch_stock_list_with_retry(
            lambda: ak.stock_hk_spot_em(),
            "港股全量列表"
        )

        # ★ 美股：使用 GitHub JSON 文件
        us_stocks_from_json = fetch_us_stock_list_from_json()

        if df_hk is None or not us_stocks_from_json:
            log("全量取数部分失败，终止本次同步", "ERROR")
            if df_hk is None:
                log("港股取数失败，本次全量更新取消", "ERROR")
                return
            if not us_stocks_from_json:
                log("美股取数失败，本次全量更新取消", "ERROR")
                return
            return

        now = datetime.now()
        existing_ids = set()
        all_stocks_snap = db.collection("all_stocks").select([]).get()
        for doc in all_stocks_snap:
            existing_ids.add(doc.id)

        batch = db.batch()
        written = 0

        # 写入港股
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

        # 写入美股
        for stock in us_stocks_from_json:
            symbol = stock["symbol"]
            data = {
                "displayName": stock["displayName"],
                "name": stock["name"],
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
        log(f"all_stocks 同步完成，共处理 {written} 只股票")

    except Exception as e:
        log(f"all_stocks 同步失败: {e}", "ERROR")
    try:
        clean_stale_and_orphans()
    except Exception as e:
        log(f"月度清理失败（已跳过）: {e}", "ERROR")

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