<!-- /**
 * PROJECT NAME : 股票预测项目 (Stock Prediction Project)
 * AUTHORS      : Gemini(架构) & DeepSeek(代码) & Claude(救火) & Zzzzk(划水)
 * START DATE   : 2026-05-03
 * DESCRIPTION  : 基于 AI 驱动的实时股价监控与趋势预测系统，集成全球金融数据可视化与 Gemini 预测模型。
 * 
 * --- 技术栈解析 (STACK ANALYSIS) ---
 * 
 * 1. 数据引擎 (Data Engine):
 *    - Language: Python
 *    - Data Source: AkShare (HK/US Stocks)
 *    - DB Instance: Firebase (Firestore) - Name: gupiaoyucedata
 *    - Auth: Firebase Admin SDK (serviceAccountKey.json)
 * 
 * 2. 数据采集逻辑 (Sync Logic):
 *    - Initial Load: 新加入自选股初始拉取最近 30 个交易日历史价格，并自动合并去重，保证连续性
 *    - Sync Strategy: 日常增量更新覆盖最近 30 天，全量标识库采用批量读取，节省配额
 *    - Writing: 使用合并策略优雅覆盖历史数据，保持日期纯净 (YYYY-MM-DD)
 * 
 * 3. 前端架构 (Frontend Architecture):
 *    - Framework: HTML5, Tailwind CSS
 *    - Charting: Chart.js
 *    - Communication: Firebase Web SDK (v10) - onSnapshot 实时流监听
 *    - Local Cache: localStorage (自选列表、全量股票缓存、更新时间戳)
 *    - 搜索: 按需从 Firestore 加载全量股票并缓存，支持键盘上下选择、回车确认
 * 
 * 4. 绘图与 UI 特性 (UI/UX Features):
 *    - Grid: 最后一条历史数据处垂直虚线分界 (tLine plugin)
 *    - Rendering: 历史实线 / 预测虚线分段绘制，无假数据连接点
 *    - Connector: 历史与预测之间通过插件动态绘制虚线，颜色跟随涨跌
 *    - Logic: 线段与点色动态红涨绿跌 (基于 P1-P0 差值)
 *    - Interaction: 鼠标跟随半透明竖线、index 模式 Tooltip、缩放与横向滚动条
 *    - Accuracy: 实时计算历史收盘价与预测价的平均准确率，纯前端无额外读取
 * 
 * 5. 预测引擎 (AI Model):
 *    - Engine: Google Gemini API
 *    - Output: Forecast Price (T+1/T+2/T+3, 仅交易日), Accuracy, Analysis Reason
 *    - Fallback: 若 Gemini 不可用，自动回退至移动平均占位预测
 * 
 * 6. 后端服务 (Backend Services):
 *    - 实时监听: main.py 监听 settings/list 变化，自动同步新自选股并触发单只预测
 *    - 定时任务: 每日 16:30 全量同步 + 全量预测，确保数据持续更新
 *    - 脚本: sync_stocks.py (历史同步), generate_forecast.py (预测生成), clear_forecasts.py (清空预测)
 * 
 */ -->