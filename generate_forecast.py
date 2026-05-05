"""
股价预测脚本（已接入 Gemini，支持从 news 集合读取新闻）
- 从 stocks 文档获取历史数据，从 news 文档获取最近新闻
- 调用 Gemini API 生成未来 3 个交易日的预测价格
- 自动提取 AI 返回的准确率、投资理由
"""
import firebase_admin
from firebase_admin import credentials, firestore
from datetime import datetime, timedelta
import json
import os
import time
from config_loader import get_key

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

# ---------- Gemini 配置 ----------
try:
    import google.generativeai as genai
    GEMINI_AVAILABLE = True
except ImportError:
    GEMINI_AVAILABLE = False
    print("⚠️ google-generativeai 未安装。安装命令：pip install google-generativeai")

GEMINI_API_KEY = get_key("GEMINI_API_KEY")
GEMINI_MODEL = "gemini-3.1-flash-lite-preview"

if GEMINI_AVAILABLE and GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
    model = genai.GenerativeModel(GEMINI_MODEL)
else:
    model = None
    if not GEMINI_API_KEY:
        print("⚠️ GEMINI_API_KEY 未配置，Gemini 不可用。")

# ---------- 占位预测 ----------
def dummy_forecast(history, days=3):
    if not history:
        return [0.0] * days, "50%", "数据不足，无法生成预测"
    recent_prices = [item["price"] for item in history[-5:]]
    avg = sum(recent_prices) / len(recent_prices)
    prices = [round(avg * (1 + 0.01 * (i + 1)), 2) for i in range(days)]
    return prices, "50%", f"基于最近5日移动平均线生成，仅供参考。T+1预测: {prices[0]}"

# ---------- 从 news 集合读取新闻 ----------
def get_recent_news(symbol):
    """返回该股票的最新5条新闻标题列表（字符串），若无有效新闻则返回空列表"""
    news_ref = db.collection("news").document(symbol)
    doc = news_ref.get()
    if not doc.exists:
        return []
    data = doc.to_dict()
    items = data.get("news", [])
    # 严格校验：只有当 items 是非空列表，且其中至少有一条包含有效 title 字段的新闻时，才提取标题
    if not items or not isinstance(items, list):
        return []
    titles = [item.get("title", "") for item in items if item.get("title", "").strip()]
    return titles[:5] if titles else []

# ---------- Gemini 预测 ----------
def gemini_forecast(history, recent_news=None, days=3):
    if not model:
        print("   ⚠️ Gemini 未配置，使用占位预测")
        return dummy_forecast(history, days)

    recent = history[-10:]
    hist_text = "\n".join([f"{item['date']}: {item['price']}" for item in recent])

    news_section = ""
    if recent_news:
        news_text = "\n".join([f"- {title}" for title in recent_news])
        news_section = f"【最新相关新闻】\n{news_text}\n\n"

    prompt = f"""# 角色
    你是一位在华尔街工作多年的资深量化金融分析师，擅长结合技术面、基本面和消息面进行股价预测。

    # 任务
    请对以下股票的未来 {days} 个交易日收盘价进行预测，并给出你的综合判断。

    # 数据
    {news_section}【历史股价数据】（最近{len(history)}个交易日）
    {hist_text}

    # 分析要求
    请分三个步骤进行推理：
    1. **技术面分析**：观察历史价格走势，判断当前处于上涨/下跌/震荡趋势，识别关键支撑位和阻力位。
    2. **消息面解读**（如有新闻）：分析新闻中的利好/利空因素，量化其对股价的可能影响。
    3. **综合预测**：结合以上两点，给出未来 {days} 个交易日的具体预测价和信心程度。

    # 输出格式
    请严格以 JSON 格式输出，不要包含其他文字：
    {{
    "analysis": "你对这只股票的综合分析（40字以内）",
    "forecast": [T+1预测价, T+2预测价, T+3预测价],
    "accuracy": "你的信心程度（具体百分比，如 73%）",
    "reason": "预测理由（60字以内）"
    }}

    # 注意事项
    - 价格保留两位小数，应体现连续性和趋势
    - accuracy 必须根据数据波动性、新闻影响力动态给出具体数字，不能全部相同
    - 如果新闻为空，请只基于技术面进行预测
    - 用中文输出
    """
    try:
        print("   🤖 正在调用 Gemini API（含新闻分析）...")
        response = model.generate_content(prompt)
        text = response.text.strip()
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        result = json.loads(text)
        prices = result.get("forecast", [])
        accuracy = result.get("accuracy", "50%")
        reason = result.get("reason", "基于 AI 模型分析生成")
        if len(prices) < days:
            last_price = prices[-1] if prices else recent[-1]["price"]
            prices += [round(last_price, 2)] * (days - len(prices))
        prices = [round(float(p), 2) for p in prices[:days]]
        print(f"   ✅ Gemini 预测成功")
        return prices, accuracy, reason
    except Exception as e:
        print(f"   ❌ Gemini 调用失败: {e}")
        print("   ↩️ 回退到占位预测")
        return dummy_forecast(history, days)

# ---------- 日期工具 ----------
def safe_parse_date(date_str):
    clean_date = str(date_str).strip()[:10]
    return datetime.strptime(clean_date, "%Y-%m-%d")

def next_trading_days(start_date, n):
    days = []
    current = start_date + timedelta(days=1)
    while len(days) < n:
        if current.weekday() < 5:
            days.append(current.strftime("%Y-%m-%d"))
        current += timedelta(days=1)
    return days

# ---------- 更新单只股票预测 ----------
def _update_forecast_for_stock(symbol, now):
    stock_ref = db.collection("stocks").document(symbol)
    stock_snap = stock_ref.get()
    if not stock_snap.exists:
        print(f"⚠️  stocks/{symbol} 不存在，跳过预测")
        return

    stock_data = stock_snap.to_dict()
    history = stock_data.get("history", [])
    if not history:
        print(f"⚠️  {symbol} 无历史数据，无法预测")
        return

    try:
        last_date = safe_parse_date(history[-1]["date"])
    except (ValueError, KeyError) as e:
        print(f"❌ 日期解析失败: '{history[-1].get('date', '')}', 错误: {e}")
        return

    # ★ 读取新闻
    news_titles = get_recent_news(symbol)
    if news_titles:
        print(f"   📰 已加载 {len(news_titles)} 条新闻")

    future_dates = next_trading_days(last_date, 3)
    predicted_prices, accuracy, reason = gemini_forecast(history, news_titles)

    forecast = stock_data.get("forecast", [])
    t1_str = future_dates[0]
    forecast = [item for item in forecast if item.get("date", "") < t1_str]
    for date_str, price in zip(future_dates, predicted_prices):
        forecast.append({"date": date_str, "price": price})

    stock_ref.update({
        "forecast": forecast,
        "accuracy": accuracy,
        "reason": reason,
        "update_time": now
    })
    print(f"✅ {symbol} 预测已更新，准确率: {accuracy}，T+1={future_dates[0]}")

def generate_single_forecast(symbol):
    print(f"🔮 单只预测: {symbol}")
    _update_forecast_for_stock(symbol, datetime.now())

def generate_and_update_forecasts():
    print("🔮 开始全量预测...")
    list_ref = db.collection("settings").document("list")
    list_doc = list_ref.get()
    if not list_doc.exists:
        print("❌ settings/list 不存在")
        return

    list_data = list_doc.to_dict()
    now = datetime.now()
    stock_items = [
        (field_name, value) for field_name, value in list_data.items()
        if field_name not in ["create_time", "create_by", "update_time", "stockNames"]
        and isinstance(value, list) and len(value) >= 2
    ]

    for idx, (field_name, value) in enumerate(stock_items):
        symbol = value[0]
        _update_forecast_for_stock(symbol, now)
        if idx < len(stock_items) - 1:
            print(f"   ⏳ 等待 10 秒...")
            time.sleep(10)

    print("🎉 全量预测完成")

if __name__ == "__main__":
    generate_and_update_forecasts()