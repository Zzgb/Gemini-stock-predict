"""
后端常驻进程 - 实时监听 + 定时任务
- 启动时不自动执行全量同步，仅启动监听器
- 监听 settings/list 变动，发现新增股票时执行：历史同步 -> 新闻拉取 -> 单只预测
- 定时任务每日 9:00 执行：历史同步、新闻拉取、全量预测（含月度全量标识库维护）
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
from config_loader import get_key
from sync_stocks import smart_sync_logic, init_or_update_list_doc, update_all_stock_identifiers
from generate_forecast import generate_and_update_forecasts, generate_single_forecast

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

# ---------- FMP 新闻拉取 ----------
FMP_API_KEY = get_key("FMP_API_KEY")
FMP_BASE_URL = "https://financialmodelingprep.com/stable/news/stock"

def fetch_and_store_news(symbol):
    """拉取单只股票的新闻并覆盖写入 news/{symbol}"""
    if not FMP_API_KEY:
        print("   ⚠️ FMP_API_KEY 未配置，跳过新闻")
        return
    try:
        params = {"symbols": symbol, "limit": 5, "apikey": FMP_API_KEY}
        resp = requests.get(FMP_BASE_URL, params=params, timeout=10)
        if resp.status_code != 200:
            print(f"   ❌ 新闻请求失败 ({resp.status_code})")
            return
        articles = resp.json()
        if not articles:
            return
        news_items = []
        for art in articles[:5]:
            news_items.append({
                "title": art.get("title", ""),
                "url": art.get("url", ""),
                "source": art.get("site", ""),
                "published": art.get("publishedDate", "")[:10] if art.get("publishedDate") else ""
            })
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
        print(f"   ✅ {symbol} 新闻已更新 ({len(news_items)}条)")
    except Exception as e:
        print(f"   ❌ 新闻拉取异常: {e}")

# ---------- 实时监听 ----------
previous_fields = set()

def on_list_snapshot(doc_snapshot, changes, read_time):
    global previous_fields
    for doc in doc_snapshot:
        if doc.id == "list":
            print("📡 list 变更")
            data = doc.to_dict()
            if not data:
                continue
            current_fields = set(data.keys()) - {"create_time", "create_by", "update_time", "stockNames"}
            new_fields = current_fields - previous_fields
            previous_fields = current_fields
            for field_name in new_fields:
                value = data[field_name]
                if isinstance(value, list) and len(value) >= 2:
                    symbol, region = value[0], value[1]
                    print(f"🆕 新股票 {symbol} 触发同步及新闻拉取")
                    # 1. 同步历史数据
                    smart_sync_logic(symbol, region)
                    # 2. 拉取新闻
                    fetch_and_store_news(symbol)
                    # 3. 单只预测
                    generate_single_forecast(symbol)

def start_listener():
    list_ref = db.collection("settings").document("list")
    snap = list_ref.get()
    if snap.exists:
        data = snap.to_dict()
        global previous_fields
        previous_fields = set(data.keys()) - {"create_time", "create_by", "update_time", "stockNames"}
    watch = list_ref.on_snapshot(on_list_snapshot)
    print("👂 已启动 list 监听")
    return watch

# ---------- 定时任务 ----------
def scheduled_job():
    print(f"\n⏰ 定时任务触发 - {datetime.now()}")
    # 1. 全量标识库维护（内部已含一个月检查，不满足条件自动跳过）
    update_all_stock_identifiers()
    # 2. 对所有自选股：历史同步 + 新闻拉取
    list_snap = db.collection("settings").document("list").get().to_dict()
    if list_snap:
        for fname, val in list_snap.items():
            if fname in ["create_time", "create_by", "update_time", "stockNames"]:
                continue
            if isinstance(val, list) and len(val) >= 2:
                symbol = val[0]
                region = val[1]
                smart_sync_logic(symbol, region)
                fetch_and_store_news(symbol)
                time.sleep(0.5)  # 避免接口限流
    # 3. 全量预测
    generate_and_update_forecasts()
    print("✅ 定时任务完成")

# ---------- 主入口 ----------
if __name__ == "__main__":
    # 建立初始自选列表（若不存在），然后启动监听
    # 不自动执行全量同步，避免启动时的配额浪费
    init_or_update_list_doc()
    listener = start_listener()
    schedule.every().day.at("9:00").do(scheduled_job)
    print("⏳ 定时任务已设置：每天 9:00")
    try:
        while True:
            schedule.run_pending()
            time.sleep(60)
    except KeyboardInterrupt:
        print("🛑 停止")
        listener.unsubscribe()