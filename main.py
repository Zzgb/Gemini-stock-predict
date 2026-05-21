"""
后端常驻进程 - 实时监听 + 定时任务（集成港股新闻）
- 监听 settings/list 变动，发现新增股票时执行：历史同步 -> 新闻拉取 -> 单只预测
- 港股新闻使用 AkShare 全球财经接口 + 股票名称/代码关键词过滤
- 美股新闻使用 FMP Stock News API，按 symbol 字段二次过滤
- 新闻拉取函数可被其他脚本导入复用
- 定时任务每日 9:00 执行：历史同步、新闻拉取、全量预测
"""
import firebase_admin
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1 import watch
import schedule
import time
from datetime import datetime
import os
import json
import requests
import akshare as ak
from config_loader import get_key
from sync_stocks import smart_sync_logic, init_or_update_list_doc, update_all_stock_identifiers
from generate_forecast import generate_and_update_forecasts, generate_single_forecast

def log(msg, level="INFO"):
    """统一日志输出，带时间戳"""
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] [{level}] {msg}")

# ---------- 初始化 Firebase ----------
def get_firebase_credentials():
    if os.path.exists("serviceAccountKey.json"):
        return credentials.Certificate("serviceAccountKey.json")
    env_key = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    if env_key:
        return credentials.Certificate(json.loads(env_key))
    raise RuntimeError("未找到 Firebase 私钥")

if not firebase_admin._apps:
    cred = get_firebase_credentials()
    firebase_admin.initialize_app(cred)

db = firestore.client(database_id="gupiaoyucedata")

# ---------- FMP 新闻拉取（美股）----------
FMP_API_KEY = get_key("FMP_API_KEY")
FMP_BASE_URL = "https://financialmodelingprep.com/stable/news/stock"

def fetch_and_store_news(symbol, region):
    """
    拉取单只股票的新闻并覆盖写入 news/{symbol}。
    - 美股：使用 FMP API，按返回的 symbol 字段二次过滤
    - 港股：使用 AkShare 全球财经接口，在标题中搜索股票名称/代码过滤
    """
    if region == "美股":
        _fetch_news_from_fmp(symbol)
    elif region == "港股":
        _fetch_news_from_akshare(symbol)

def _fetch_news_from_fmp(symbol):
    """通过 FMP API 获取美股个股新闻"""
    if not FMP_API_KEY:
        log("FMP_API_KEY 未配置，跳过美股新闻", "WARN")
        return
    try:
        params = {"symbols": symbol, "limit": 5, "apikey": FMP_API_KEY}
        resp = requests.get(FMP_BASE_URL, params=params, timeout=10)
        if resp.status_code != 200:
            log(f"FMP 新闻请求失败 ({resp.status_code})", "ERROR")
            return
        raw_articles = resp.json()
        if not raw_articles:
            log(f"{symbol} 无美股新闻数据", "WARN")
            return

        filtered = [art for art in raw_articles
                    if art.get("symbol", "").upper() == symbol.upper()]
        if filtered:
            articles = filtered
        else:
            log(f"{symbol} 未找到专属美股新闻，保留旧数据", "WARN")
            return

        news_items = []
        for art in articles[:5]:
            news_items.append({
                "title": art.get("title", ""),
                "url": art.get("url", ""),
                "source": art.get("site", ""),
                "published": art.get("publishedDate", "")[:10]
                    if art.get("publishedDate") else ""
            })
        _write_news_to_firestore(symbol, news_items, raw_len=len(raw_articles),
                                 filtered_len=len(articles))
    except Exception as e:
        log(f"FMP 新闻拉取异常: {e}", "ERROR")

def _fetch_news_from_akshare(symbol):
    """通过 AkShare 全球财经接口获取港股个股新闻"""
    try:
        chinese_name = None
        list_doc = db.collection("settings").document("list").get()
        if list_doc.exists:
            list_data = list_doc.to_dict()
            for field_name, val in list_data.items():
                if isinstance(val, list) and len(val) >= 2 and val[0] == symbol:
                    chinese_name = val[2] if len(val) >= 3 else None
                    break
        
        keywords = [symbol, symbol.lstrip("0")]
        if chinese_name:
            keywords.append(chinese_name)
        if chinese_name and "-" in chinese_name:
            keywords.append(chinese_name.split("-")[0])
        
        log(f"港股新闻搜索关键词: {keywords}")
        
        df = ak.stock_info_global_em()
        if df is None or df.empty:
            log("AkShare 全球新闻接口未返回数据，即将清空旧新闻", "WARN")
            _write_news_to_firestore(symbol, [])
            return
        
        pattern = '|'.join(keywords)
        matched = df[df['标题'].str.contains(pattern, case=False, na=False)]
        
        if matched.empty:
            log(f"{symbol} 未找到相关港股新闻，即将清空旧新闻", "WARN")
            _write_news_to_firestore(symbol, [])
            return
        
        news_items = []
        for _, row in matched.head(5).iterrows():
            news_items.append({
                "title": str(row.get("标题", "")),
                "url": "",
                "source": str(row.get("来源", "")),
                "published": str(row.get("发布时间", ""))
            })
        _write_news_to_firestore(symbol, news_items, filtered_len=len(matched))
        
    except Exception as e:
        log(f"AkShare 新闻拉取异常: {e}，即将清空旧新闻", "ERROR")
        _write_news_to_firestore(symbol, [])

def _write_news_to_firestore(symbol, news_items, raw_len=0, filtered_len=0):
    """将新闻写入 Firestore news/{symbol} 文档，覆盖旧数据"""
    news_ref = db.collection("news").document(symbol)
    now = datetime.now()
    
    if news_ref.get().exists:
        news_ref.update({"news": news_items, "update_time": now})
    else:
        news_ref.set({
            "news": news_items,
            "create_time": now,
            "create_by": "DeepSeek",
            "update_time": now
        })
    
    log_extra = f"，原始{raw_len}条 -> 过滤后{filtered_len}条" if raw_len else ""
    if news_items:
        log(f"{symbol} 新闻已更新 ({len(news_items)}条){log_extra}")
    else:
        log(f"{symbol} 无相关新闻，已清空旧数据", "WARN")

# ---------- 实时监听 ----------
previous_fields = set()

def on_list_snapshot(doc_snapshot, changes, read_time):
    global previous_fields
    for doc in doc_snapshot:
        if doc.id == "list":
            log("list 变更", "INFO")
            data = doc.to_dict()
            if not data:
                continue
            current_fields = set(data.keys()) - {
                "create_time", "create_by", "update_time", "stockNames"
            }
            new_fields = current_fields - previous_fields
            log(f"current: {current_fields}")
            log(f"previous: {previous_fields}")
            log(f"new fields: {new_fields}")
            previous_fields = current_fields
            for field_name in new_fields:
                value = data[field_name]
                if isinstance(value, list) and len(value) >= 2:
                    symbol, region = value[0], value[1]
                    log(f"新股票 {symbol} 触发同步及新闻拉取")
                    # 增加间隔和重试
                    time.sleep(3)
                    max_retries = 2
                    for attempt in range(max_retries):
                        try:
                            smart_sync_logic(symbol, region)
                            break
                        except Exception as e:
                            if attempt == max_retries - 1:
                                log(f"{symbol} 同步失败（已重试{max_retries}次）: {e}", "ERROR")
                            else:
                                log(f"{symbol} 同步出错，2秒后重试: {e}", "WARN")
                                time.sleep(2)
                    # 拉取新闻
                    fetch_and_store_news(symbol, region)
                    # 单只预测
                    generate_single_forecast(symbol)

def start_listener():
    list_ref = db.collection("settings").document("list")
    snap = list_ref.get()
    if snap.exists:
        data = snap.to_dict()
        global previous_fields
        previous_fields = set(data.keys()) - {
            "create_time", "create_by", "update_time", "stockNames"
        }
    watch = list_ref.on_snapshot(on_list_snapshot)
    log("已启动 list 监听")
    return watch

# ---------- 定时任务 ----------
def scheduled_job():
    log("定时任务触发", "INFO")
    # 阶段1: 全球标识库更新（失败不影响后续）
    try:
        update_all_stock_identifiers()
    except Exception as e:
        log(f"全球标识库更新失败（已跳过）: {e}", "ERROR")

    # 阶段2: 各股票历史同步 & 新闻
    try:
        list_snap = db.collection("settings").document("list").get().to_dict()
        if list_snap:
            for fname, val in list_snap.items():
                if fname in ["create_time", "create_by", "update_time", "stockNames"]:
                    continue
                if isinstance(val, list) and len(val) >= 2:
                    symbol = val[0]
                    region = val[1]
                    try:
                        smart_sync_logic(symbol, region)
                    except Exception as e:
                        log(f"{symbol} 历史同步失败（已跳过）: {e}", "ERROR")
                    try:
                        fetch_and_store_news(symbol, region)
                    except Exception as e:
                        log(f"{symbol} 新闻拉取失败（已跳过）: {e}", "ERROR")
                    time.sleep(0.5)
    except Exception as e:
        log(f"自选股列表获取失败（已跳过）: {e}", "ERROR")

    # 阶段3: 生成预测
    try:
        generate_and_update_forecasts()
    except Exception as e:
        log(f"预测生成失败（已跳过）: {e}", "ERROR")

    log("定时任务完成")

# ---------- 主入口 ----------
if __name__ == "__main__":
    init_or_update_list_doc()
    listener = start_listener()
    schedule.every().day.at("09:00").do(scheduled_job)
    log("定时任务已设置：每天 09:00")
    try:
        while True:
            schedule.run_pending()
            time.sleep(60)
    except KeyboardInterrupt:
        log("停止监听", "WARN")
        listener.unsubscribe()