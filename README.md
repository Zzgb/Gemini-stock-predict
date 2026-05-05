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
 *    - Auth: Firebase Admin SDK (通过 GitHub Secrets 安全存储)
 *    - News API (美股): Financial Modeling Prep (FMP) – 每日拉取美股个股新闻
 *    - News API (港股): AkShare 全球财经接口 – 按股票代码过滤相关新闻
 * 
 * 2. 数据采集逻辑 (Sync Logic):
 *    - Initial Load: 新自选股拉取最近 30 个交易日历史价格，合并去重
 *    - Sync Strategy: 日常增量更新覆盖最近 30 天，全量标识库采用批量读取，节省配额
 *    - News Sync: 通过定时任务或实时监听自动拉取最新 5 条个股新闻，按 symbol 二次过滤，存入 news/{symbol} 文档
 *    - Writing: 使用合并策略优雅覆盖历史数据，保持日期纯净 (YYYY-MM-DD)
 * 
 * 3. 前端架构 (Frontend Architecture):
 *    - Framework: HTML5, Tailwind CSS
 *    - Charting: Chart.js
 *    - Communication: Firebase Web SDK (v10) - onSnapshot 实时流监听
 *    - Local Cache: localStorage (自选列表、全量股票缓存、更新时间戳)
 *    - Search: 按需从 Firestore 加载全量股票并缓存，支持键盘上下选择、回车确认
 *    - Initialization: 新用户自动显示 AAPL 股票数据（无写入操作）
 *    - Currency: 根据股票市场自动显示 HK$ / $ / ¥
 * 
 * 4. 绘图与 UI 特性 (UI/UX Features):
 *    - Grid: 最后一条历史数据处垂直虚线分界 (tLine plugin)
 *    - Rendering: 历史实线 / 预测虚线分段绘制，无假数据连接点
 *    - Connector: 历史与预测之间通过插件动态绘制虚线，颜色跟随涨跌
 *    - Logic: 线段与点色动态红涨绿跌 (基于前一个有效点比较)
 *    - Interaction: 鼠标跟随半透明竖线、index 模式 Tooltip、缩放与横向滚动条
 *    - Accuracy: 实时计算历史收盘价与预测价的平均准确率，纯前端无额外读取
 *    - Background: 动态星空 + 红绿流星粒子背景 (红涨绿跌方向限制)
 * 
 * 5. 预测引擎 (AI Model):
 *    - Engine: Google Gemini API (gemini-3.1-flash-lite-preview)
 *    - Input: 历史价格 + 新闻标题
 *    - Output: Forecast Price (T+1/T+2/T+3, 仅交易日), Accuracy, Analysis Reason
 *    - Fallback: 若 Gemini 不可用，自动回退至移动平均占位预测
 * 
 * 6. 后端服务与部署 (Backend & Deployment):
 *    - 实时监听: Hugging Face Space 运行 app.py，监听 Firestore 变化，自动同步新自选股 → 新闻 → 预测
 *    - 定时任务: GitHub Actions (schedule: daily 9:00 UTC+8) 执行历史同步 + 新闻拉取 + 全量预测
 *    - 托管: GitHub Pages (前端静态网站) + GitHub Actions (后端定时任务)
 *    - 密钥管理: config_loader.py 优先读取 config.ini，回退到环境变量；生产环境通过 GitHub Secrets 注入
 *    - 清理机制: 月度清理不活跃股票 (30天未访问) 与残留 stocks 文档
 *    - Space 保活: cron-job.org 每 5 分钟 GET 请求防休眠
 * 
 */ -->

---

## 📎 本项目涉及的主要服务与 API 官网

| 服务 / API | 官方网站 / 控制台 |
|------------|------------------|
| Firebase (Firestore 数据库) | [https://console.firebase.google.com](https://console.firebase.google.com) |
| GitHub Pages (前端托管) | [https://pages.github.com](https://pages.github.com) |
| GitHub Actions (定时任务) | [https://github.com/features/actions](https://github.com/features/actions) |
| Hugging Face Spaces (实时监听) | [https://huggingface.co/spaces](https://huggingface.co/spaces) |
| Google Gemini API (AI 预测) | [https://aistudio.google.com](https://aistudio.google.com) |
| Financial Modeling Prep (美股新闻) | [https://site.financialmodelingprep.com/developer/docs](https://site.financialmodelingprep.com/developer/docs) |
| AkShare (港股新闻 / 历史数据) | [https://akshare.akfamily.xyz](https://akshare.akfamily.xyz) |
| cron-job.org (Space 保活) | [https://cron-job.org](https://cron-job.org) |

> 以上链接均为相应服务的官方首页或开发者入口，用于快速访问管理后台或查阅文档。