"""
后端常驻进程 - 实时监听 + 定时任务（集成港股新闻）
- 监听 settings/list 变动，发现新增股票时执行：历史同步 -> 新闻拉取 -> 单只预测
- 港股新闻使用 AkShare 全球财经接口 + 代码关键词过滤
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
    - 港股：使用 AkShare 全球财经接口，在标题中搜索股票代码过滤
    """
    if region == "美股":
        _fetch_news_from_fmp(symbol)
    elif region == "港股":
        _fetch_news_from_akshare(symbol)

def _fetch_news_from_fmp(symbol):
    """通过 FMP API 获取美股个股新闻"""
    if not FMP_API_KEY:
        print("   ⚠️ FMP_API_KEY 未配置，跳过美股新闻")
        return
    try:
        params = {"symbols": symbol, "limit": 5, "apikey": FMP_API_KEY}
        resp = requests.get(FMP_BASE_URL, params=params, timeout=10)
        if resp.status_code != 200:
            print(f"   ❌ FMP 新闻请求失败 ({resp.status_code})")
            return
        raw_articles = resp.json()
        if not raw_articles:
            print(f"   ⚠️ {symbol} 无美股新闻数据")
            return

        # ★ 按 symbol 字段二次过滤，只保留本股新闻
        filtered = [art for art in raw_articles
                    if art.get("symbol", "").upper() == symbol.upper()]
        if filtered:
            articles = filtered
        else:
            print(f"   ⚠️ {symbol} 未找到专属美股新闻，保留旧数据")
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
        print(f"   ❌ FMP 新闻拉取异常: {e}")

def _fetch_news_from_akshare(symbol):
    """通过 AkShare 全球财经接口获取港股个股新闻"""
    try:
        df = ak.stock_info_global_em()
        if df is None or df.empty:
            print("   ⚠️ AkShare 全球新闻接口未返回数据")
            return

        # 按股票代码在标题中搜索（港股常见代码格式：01810、1810、小米等）
        keywords = [symbol, symbol.lstrip("0")]  # 01810 -> 1810
        pattern = '|'.join(keywords)
        matched = df[df['标题'].str.contains(pattern, case=False, na=False)]
        if matched.empty:
            print(f"   ⚠️ {symbol} 未找到相关港股新闻，保留旧数据")
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
        print(f"   ❌ AkShare 新闻拉取异常: {e}")

def _write_news_to_firestore(symbol, news_items, raw_len=0, filtered_len=0):
    """将新闻写入 Firestore news/{symbol} 文档，覆盖旧数据"""
    if not news_items:
        return
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
    log_extra = f"，原始{raw_len}条 → 过滤后{filtered_len}条" if raw_len else ""
    print(f"   ✅ {symbol} 新闻已更新 ({len(news_items)}条){log_extra}")

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
            current_fields = set(data.keys()) - {
                "create_time", "create_by", "update_time", "stockNames"
            }
            new_fields = current_fields - previous_fields
            print(f"📊 current: {current_fields}")
            print(f"📊 previous: {previous_fields}")
            print(f"📊 new fields: {new_fields}")
            previous_fields = current_fields
            for field_name in new_fields:
                value = data[field_name]
                if isinstance(value, list) and len(value) >= 2:
                    symbol, region = value[0], value[1]
                    print(f"🆕 新股票 {symbol} 触发同步及新闻拉取")
                    # 1. 同步历史数据
                    smart_sync_logic(symbol, region)
                    # 2. 拉取新闻（根据地区选择来源）
                    fetch_and_store_news(symbol, region)
                    # 3. 单只预测
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
    print("👂 已启动 list 监听")
    return watch

# ---------- 定时任务 ----------
def scheduled_job():
    print(f"\n⏰ 定时任务触发 - {datetime.now()}")
    # 1. 全量标识库维护（内部已含一个月检查）
    update_all_stock_identifiers()
    # 2. 历史同步 + 新闻拉取
    list_snap = db.collection("settings").document("list").get().to_dict()
    if list_snap:
        for fname, val in list_snap.items():
            if fname in ["create_time", "create_by", "update_time", "stockNames"]:
                continue
            if isinstance(val, list) and len(val) >= 2:
                symbol = val[0]
                region = val[1]
                # 同步历史数据（内部已有判断，不需要额外操作）
                smart_sync_logic(symbol, region)
                # ★ 拉取新闻（根据地区自动选择来源）
                fetch_and_store_news(symbol, region)
                time.sleep(0.5)  # 避免接口限流
    # 3. 全量预测
    generate_and_update_forecasts()
    print("✅ 定时任务完成")

# ---------- 主入口 ----------
if __name__ == "__main__":
    init_or_update_list_doc()
    listener = start_listener()
    # 注意：如果部署到 Oracle Cloud 等常驻服务器，建议保留定时任务作为兜底
    schedule.every().day.at("09:00").do(scheduled_job)
    print("⏳ 定时任务已设置：每天 09:00")
    try:
        while True:
            schedule.run_pending()
            time.sleep(60)
    except KeyboardInterrupt:
        print("🛑 停止")
        listener.unsubscribe()