import { watchStock, fetchAllStocksCacheOrLoad } from './firebase-db.js';
import { addStockToList, updateLastAccessed } from './firestore-write.js';

let STOCKS = JSON.parse(localStorage.getItem('my_stocks')) || {};
let activeId = null;
let chart = null;
let allStocksCache = [];
let allStocksReady = false;
let allStocksLoading = false;
let highlightIndex = -1;
const subscriptions = {};
const accessedSet = new Set();

// ---------- 全局错误提示 ----------
let globalErrorShown = false;
function showGlobalError(msg) {
    if (globalErrorShown) return;
    globalErrorShown = true;
    const el = document.createElement('div');
    el.className = 'fixed top-4 left-1/2 transform -translate-x-1/2 bg-red-600 text-white px-6 py-3 rounded-xl shadow-lg z-50 text-sm font-bold';
    el.textContent = '⚠️ ' + msg;
    document.body.appendChild(el);
    setTimeout(() => { el.remove(); globalErrorShown = false; }, 6000);
}

// ---------- Logo 工具 ----------
const logoDomains = {
    'AAPL': 'apple.com', 'MSFT': 'microsoft.com', 'GOOGL': 'google.com',
    'AMZN': 'amazon.com', 'TSLA': 'tesla.com', 'NVDA': 'nvidia.com',
    'META': 'meta.com', 'NFLX': 'netflix.com',
    '01810': 'xiaomi.com', '00700': 'tencent.com', '09988': 'alibaba.com',
    '1810.HK': 'xiaomi.com', '700.HK': 'tencent.com', '9988.HK': 'alibaba.com'
};

function getLogoUrl(symbol) {
    if (logoDomains[symbol]) {
        return [
            `https://logo.clearbit.com/${logoDomains[symbol]}`,
            `https://www.google.com/s2/favicons?domain=${logoDomains[symbol]}&sz=32`
        ];
    }
    let domain;
    if (symbol.includes('.HK')) domain = `${symbol.split('.')[0]}.hk`;
    else if (/^\d+$/.test(symbol)) domain = `${symbol}.hk`;
    else domain = `${symbol.toLowerCase()}.com`;
    return [
        `https://logo.clearbit.com/${domain}`,
        `https://www.google.com/s2/favicons?domain=${domain}&sz=32`
    ];
}

function guessRegion(symbol) {
    if (symbol.includes('.HK')) return '港股';
    if (/^\d+$/.test(symbol)) return '港股';
    return '美股';
}

function getCurrencySymbol(region) {
    if (region === '港股') return 'HK$';
    if (region === '美股') return '$';
    return '¥';
}

function getLastHistColor(history) {
    if (!history || history.length < 2) return 'text-gray-400';
    const prices = history.map(item => item.price);
    const last = prices[prices.length - 1];
    const prev = prices[prices.length - 2];
    return last >= prev ? 'text-red-500' : 'text-green-500';
}

// ---------- 默认股票初始化 ----------
function ensureDefaultStock() {
    if (Object.keys(STOCKS).length > 0) return;
    const defaultSymbol = 'AAPL';
    const region = guessRegion(defaultSymbol);
    STOCKS[defaultSymbol] = {
        name: 'AAPL',
        logo: getLogoUrl(defaultSymbol),
        accuracy: '--',
        history: [],
        forecast: [],
        reason: '数据加载中...',
        region: region
    };
    saveToCache();
    setupSubscription(defaultSymbol);
}

// ---------- 页面初始化 ----------
window.onload = async () => {
    const resetContainer = document.createElement('div');
    resetContainer.className = 'reset-container';
    resetContainer.innerHTML = `<button class="reset-btn" onclick="clearAllData()">清除所有缓存数据</button>`;
    document.body.appendChild(resetContainer);

    const addBtn = document.getElementById('add-btn');
    if (addBtn) addBtn.onclick = () => addStock();

    initSearchLogic();
    ensureDefaultStock();
    render();
    Object.keys(STOCKS).forEach(id => setupSubscription(id));
};

// ---------- 搜索逻辑（Bug6修复：下拉框挂载到body并动态定位）----------
function initSearchLogic() {
    const input = document.getElementById('stock-input');
    let resultBox = document.getElementById('search-results');
    if (!resultBox) {
        resultBox = document.createElement('div');
        resultBox.id = 'search-results';
        resultBox.className = 'search-results';
        document.body.appendChild(resultBox);    // 挂载到body脱离父容器层级
    }

    const updateHighlightStyle = () => {
        const items = resultBox.querySelectorAll('.search-item');
        items.forEach((item, idx) => {
            if (idx === highlightIndex) {
                item.classList.add('bg-white/20');
            } else {
                item.classList.remove('bg-white/20');
            }
        });
    };

    const positionResultBox = () => {
        const rect = input.getBoundingClientRect();
        resultBox.style.position = 'fixed';
        resultBox.style.left = rect.left + 'px';
        resultBox.style.top = (rect.bottom + 8) + 'px';
        resultBox.style.width = rect.width + 'px';
    };

    const ensureCache = async () => {
        if (!allStocksReady && !allStocksLoading) {
            allStocksLoading = true;
            input.placeholder = '正在加载股票列表...';
            const { list, error } = await fetchAllStocksCacheOrLoad();
            allStocksLoading = false;
            if (error) {
                showGlobalError('股票列表加载失败，请稍后重试');
                input.placeholder = '输入代码（如 1810.HK）';
                return;
            }
            allStocksCache = list;
            allStocksReady = true;
            input.placeholder = '输入代码（如 1810.HK）';
        }
    };

    input.addEventListener('focus', () => {
        positionResultBox();
        ensureCache();
    });

    input.addEventListener('input', async (e) => {
        await ensureCache();
        const query = e.target.value.toUpperCase().trim();
        if (!query || !allStocksReady) {
            resultBox.style.display = 'none';
            highlightIndex = -1;
            return;
        }
        const matches = allStocksCache
            .filter(s => s.symbol.includes(query) || s.name.toUpperCase().includes(query))
            .slice(0, 5);
        resultBox.innerHTML = matches.map(m =>
            `<div class="search-item" onmousedown="event.preventDefault(); selectStock('${m.symbol}', '${m.name}')">${m.symbol} ${m.name}</div>`
        ).join('');
        positionResultBox();
        resultBox.style.display = matches.length ? 'block' : 'none';
        highlightIndex = -1;
        updateHighlightStyle();
    });

    window.addEventListener('resize', () => {
        if (resultBox.style.display === 'block') positionResultBox();
    });
    window.addEventListener('scroll', () => {
        if (resultBox.style.display === 'block') positionResultBox();
    });

    input.addEventListener('keydown', (e) => {
        const items = resultBox.querySelectorAll('.search-item');
        // 输入法组合输入时不处理任何键盘事件
        if (e.isComposing) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (items.length > 0) {
                highlightIndex = (highlightIndex + 1) % items.length;
                updateHighlightStyle();
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (items.length > 0) {
                highlightIndex = (highlightIndex - 1 + items.length) % items.length;
                updateHighlightStyle();
            }
        } else if (e.key === 'Escape') {
            resultBox.style.display = 'none';
            highlightIndex = -1;
            updateHighlightStyle();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (highlightIndex >= 0 && items.length > 0) {
                const sym = items[highlightIndex].textContent.split(' ')[0];
                const name = items[highlightIndex].textContent.substring(sym.length + 1);
                selectStock(sym, name);
                addStock();                     // 键盘选择后直接添加
            } else {
                addStock();
            }
        }
    });

    input.addEventListener('blur', () => {
        setTimeout(() => {
            resultBox.style.display = 'none';
            highlightIndex = -1;
        }, 200);
    });
}

window.selectStock = (id, name) => {
    const input = document.getElementById('stock-input');
    input.value = name ? `${id} ${name}` : id;
    document.getElementById('search-results').style.display = 'none';
    highlightIndex = -1;
};

// ---------- 添加自选（Bug2校验）----------
window.addStock = async function () {
    const input = document.getElementById('stock-input');
    const rawVal = input.value.trim();
    if (!rawVal) { alert("未选择股票"); return; }

    const val = rawVal.split(' ')[0].toUpperCase();

    let finalSymbol = val, finalName = val, finalRegion = guessRegion(val);
    if (allStocksReady) {
        const matched = allStocksCache.find(s =>
            s.symbol === val || s.symbol.replace('.HK', '') === val || s.symbol === val + '.HK'
        );
        if (matched) {
            finalSymbol = matched.symbol;
            finalName = matched.name;
            finalRegion = matched.region;
        } else {
            showGlobalError("股票代码不存在，请从搜索列表中选择");
            return;
        }
    }

    if (STOCKS[finalSymbol]) {
        activeId = finalSymbol;
        input.value = '';
        render();
        return;
    }

    STOCKS[finalSymbol] = {
        name: finalName,
        logo: getLogoUrl(finalSymbol),
        accuracy: '--',
        history: [],
        forecast: [],
        reason: '数据拉取中...',
        region: finalRegion
    };

    try {
        await addStockToList(finalSymbol, finalRegion, finalName);
    } catch (e) {
        console.error('写入自选列表失败', e);
        showGlobalError('添加自选失败，请稍后重试');
    }

    saveToCache();
    setupSubscription(finalSymbol);
    activeId = finalSymbol;
    input.value = '';
    render();
};

// ---------- 实时监听 ----------
function setupSubscription(id) {
    if (subscriptions[id]) {
        subscriptions[id]();
        delete subscriptions[id];
    }

    const onError = (err) => {
        console.error(`监听 ${id} 出错:`, err);
        if (STOCKS[id]) {
            STOCKS[id].error = true;
            STOCKS[id].reason = '⚠️ 数据获取失败，可能是配额已满或网络问题';
            saveToCache();
            render();
        }
    };

    const unsubscribe = watchStock(id, (cloudData) => {
        if (STOCKS[id]) {
            STOCKS[id] = { ...STOCKS[id], ...cloudData, error: false };
            saveToCache();
            render();

            if (!accessedSet.has(id)) {
                accessedSet.add(id);
                updateLastAccessed(id).catch(e => console.warn('记录访问失败', e));
            }
        }
    }, onError);

    subscriptions[id] = unsubscribe;
}

// ---------- 准确率计算 ----------
function calcAccuracy(history, forecast) {
    if (!history.length || !forecast.length) return 0;
    const histMap = {};
    history.forEach(item => {
        const d = item.date.substring(0, 10);
        histMap[d] = item.price;
    });
    let totalAccuracy = 0;
    let count = 0;
    forecast.forEach(item => {
        const fd = item.date.substring(0, 10);
        const actual = histMap[fd];
        if (actual !== undefined && actual !== 0) {
            const error = Math.abs(item.price - actual) / actual;
            totalAccuracy += 1 - error;
            count++;
        }
    });
    if (count === 0) return 0;
    return totalAccuracy / count;
}

// ---------- 拖拽排序（Bug修复：只允许手柄拖拽）----------
let draggedCard = null;
let draggedIndex = -1;

function handleDragStart(e) {
    const handle = e.target.closest('.drag-handle');
    if (!handle) {
        e.preventDefault();
        return;
    }
    draggedCard = handle.closest('.glass-card');
    if (!draggedCard) return;
    draggedIndex = Array.from(draggedCard.parentNode.children).indexOf(draggedCard);
    e.dataTransfer.setData('text/plain', '');
    e.dataTransfer.effectAllowed = 'move';
    draggedCard.classList.add('opacity-50');
}

function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}

function handleDrop(e) {
    e.preventDefault();
    if (!draggedCard || draggedIndex === -1) return;

    const targetCard = e.target.closest('.glass-card');
    if (!targetCard || targetCard === draggedCard) return;

    const cards = Array.from(targetCard.parentNode.children);
    const targetIndex = cards.indexOf(targetCard);
    if (targetIndex === -1) return;

    const ids = Object.keys(STOCKS);
    const movedId = ids.splice(draggedIndex, 1)[0];
    ids.splice(targetIndex, 0, movedId);
    const newStocks = {};
    ids.forEach(id => { newStocks[id] = STOCKS[id]; });
    STOCKS = newStocks;
    saveToCache();
    render();
}

function handleDragEnd(e) {
    if (draggedCard) {
        draggedCard.classList.remove('opacity-50');
    }
    draggedCard = null;
    draggedIndex = -1;
}

// ---------- 列表渲染（只允许手柄拖拽，Feat1修复）----------
function render() {
    const container = document.getElementById('stock-container');
    if (!container) return;

    container.innerHTML = Object.keys(STOCKS).map(id => {
        const s = STOCKS[id];
        const isActive = activeId === id;
        const isError = s.error;

        const aiAccuracy = s.accuracy || '--';
        const rawHistAcc = calcAccuracy(s.history || [], s.forecast || []);
        const histAccuracyStr = rawHistAcc > 0 ? `${(rawHistAcc * 100).toFixed(1)}%` : '--';

        const lastPrice = s.history?.length ? s.history[s.history.length - 1].price : 0;
        const lastHistDate = s.history?.length ? s.history[s.history.length - 1].date : '';
        const nextForecast = (s.forecast || []).find(f => f.date > lastHistDate);
        const nextPrice = nextForecast ? nextForecast.price : 0;
        const region = s.region || guessRegion(id);
        const currencySymbol = getCurrencySymbol(region);
        const forecastColorClass = nextPrice >= lastPrice ? 'price-up' : 'price-down';
        const lastHistColorClass = getLastHistColor(s.history || []);
        const logoUrls = Array.isArray(s.logo) ? s.logo : [s.logo];

        return `
            <div class="glass-card ${isActive ? 'active-card' : ''} ${isError ? 'border-red-500/40' : ''}"
                 ondragover="handleDragOver(event)"
                 ondrop="handleDrop(event)">
                <div class="p-5 flex items-center justify-between cursor-pointer" onclick="toggleActive('${id}')">
                    <div class="flex items-center gap-4">
                        <div class="drag-handle cursor-grab text-gray-500 hover:text-gray-300 mr-1" 
                             title="拖拽排序"
                             draggable="true"
                             ondragstart="handleDragStart(event)"
                             ondragend="handleDragEnd(event)">☰</div>
                        <div class="logo-wrapper">
                            <img src="${logoUrls[0]}" loading="lazy"
                                 onerror="this.onerror=null;this.src='${logoUrls[1] || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect fill=%22%23333%22 width=%2232%22 height=%2232%22/%3E%3C/svg%3E'}';">
                        </div>
                        <div>
                            <h3 class="font-bold text-sm">${s.name || id} ${isError ? '<span class="text-red-400 text-[10px] ml-2">(离线)</span>' : ''}</h3>
                            <p class="text-[10px] text-gray-500">${id}</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-6">
                        <div class="text-right">
                            <p class="text-[9px] text-gray-500 font-bold">最新收盘价</p>
                            <p class="font-mono font-bold ${isError ? 'text-gray-500' : lastHistColorClass}">${isError ? '--' : currencySymbol + lastPrice.toFixed(2)}</p>
                        </div>
                        <div class="text-right">
                            <p class="text-[9px] text-gray-500 font-bold">下一个交易日预测收盘价</p>
                            <p class="font-mono font-bold ${isError ? 'text-gray-500' : forecastColorClass}">${isError ? '--' : currencySymbol + nextPrice.toFixed(2)}</p>
                        </div>
                        <div class="text-right">
                            <p class="text-[9px] text-gray-500 font-bold">预测准确率</p>
                            <p class="font-mono font-bold">${aiAccuracy}</p>
                        </div>
                        <div class="text-right">
                            <p class="text-[9px] text-gray-500 font-bold">历史准确率</p>
                            <p class="font-mono font-bold">${histAccuracyStr}</p>
                        </div>
                        <div class="opacity-30 hover:opacity-100 p-2" onclick="removeStock(event, '${id}')">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                        </div>
                    </div>
                </div>
                ${isActive ? `
                    <div class="px-5 pb-6 border-t border-white/5">
                        <div class="h-72 mt-6 relative">
                            <canvas id="chart-canvas"></canvas>
                            ${isError ? '<div class="absolute inset-0 flex items-center justify-center text-red-400 text-sm bg-black/20 backdrop-blur-sm">数据暂时不可用，请稍后重试</div>' : ''}
                        </div>
                        <div class="chart-controls mt-2 flex items-center justify-center gap-2 text-xs">
                            <button id="chart-zoom-out" class="px-2 py-1 bg-white/10 rounded hover:bg-white/20">-</button>
                            <button id="chart-zoom-in" class="px-2 py-1 bg-white/10 rounded hover:bg-white/20">+</button>
                            <input type="range" id="chart-scroll" class="flex-1 mx-2" min="0" max="100" value="100">
                        </div>
                        <div class="mt-4 p-4 bg-white/5 rounded-xl text-xs text-gray-400">${s.reason || (isError ? '无法获取预测理由' : '')}</div>
                    </div>` : ''}
            </div>
        `;
    }).join('');

    if (activeId) setTimeout(() => initChart(activeId), 50);
}

// ---------- K线图（Bug5最终Connector：只处理最后一个历史点）----------
function initChart(id) {
    const s = STOCKS[id];
    const canvas = document.getElementById('chart-canvas');
    if (!canvas) return;

    if (s.error || (!s.history?.length && !s.forecast?.length)) {
        const ctx = canvas.getContext('2d');
        if (chart) chart.destroy();
        chart = null;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = '14px Inter, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.textAlign = 'center';
        ctx.fillText('数据暂不可用', canvas.width / 2, canvas.height / 2);
        return;
    }

    if (chart) chart.destroy();

    const histArr = s.history || [];
    const foreArr = s.forecast || [];

    const allDatesSet = new Set();
    histArr.forEach(item => allDatesSet.add(item.date.substring(0, 10)));
    foreArr.forEach(item => allDatesSet.add(item.date.substring(0, 10)));
    const labels = Array.from(allDatesSet).sort();

    const histData = labels.map(date => {
        const found = histArr.find(item => item.date.substring(0, 10) === date);
        return found ? found.price : null;
    });

    // Bug5：foreData 只保留真实预测数据，不插入任何假连接点
    const foreData = labels.map(date => {
        const found = foreArr.find(item => item.date.substring(0, 10) === date);
        return found ? found.price : null;
    });

    const lastHistDate = histArr.length ? histArr[histArr.length - 1].date.substring(0, 10) : null;

    const segmentColor = (ctx) => {
        const p0 = ctx.p0?.parsed?.y;
        const p1 = ctx.p1?.parsed?.y;
        if (p0 == null || p1 == null) return '#ff453a';
        return p1 >= p0 ? '#ff453a' : '#32d74b';
    };

    const findPrevValid = (data, index) => {
        for (let i = index - 1; i >= 0; i--) {
            if (data[i] !== null) return data[i];
        }
        return null;
    };

    // 首个有效点索引（用于灰点）
    let firstHistIndex = -1, firstForeIndex = -1;
    for (let i = 0; i < histData.length; i++) {
        if (histData[i] !== null) { firstHistIndex = i; break; }
    }
    for (let i = 0; i < foreData.length; i++) {
        if (foreData[i] !== null) { firstForeIndex = i; break; }
    }

    const datasets = [
        {
            label: '历史价格',
            data: histData,
            segment: { borderColor: segmentColor },
            borderWidth: 2,
            pointRadius: 3,
            pointBorderWidth: 0,
            pointHoverRadius: 5,
            pointHoverBorderWidth: 0,
            pointBackgroundColor: function(ctx) {
                const idx = ctx.dataIndex;
                if (idx === firstHistIndex) return '#555555';
                const curr = ctx.dataset.data[idx];
                if (curr == null) return '#ff453a';
                const prev = findPrevValid(ctx.dataset.data, idx);
                if (prev == null) return '#ff453a';
                return curr >= prev ? '#ff453a' : '#32d74b';
            },
            spanGaps: false,
        },
        {
            label: 'AI 预测',
            data: foreData,
            segment: { borderColor: segmentColor },
            borderDash: [5, 5],
            borderWidth: 2,
            pointRadius: 4,
            pointBorderWidth: 0,
            pointHoverRadius: 6,
            pointHoverBorderWidth: 0,
            pointBackgroundColor: function(ctx) {
                const idx = ctx.dataIndex;
                if (idx === firstForeIndex) return '#555555';
                const curr = ctx.dataset.data[idx];
                if (curr == null) return '#ff453a';
                let prev = findPrevValid(ctx.dataset.data, idx);
                if (prev == null && histData.length > 0) {
                    const lastHistPrice = histData.filter(d => d !== null).pop();
                    if (lastHistPrice !== undefined) prev = lastHistPrice;
                }
                if (prev == null) return '#ff453a';
                return curr >= prev ? '#ff453a' : '#32d74b';
            },
            spanGaps: false,
        }
    ];

    const ctx = canvas.getContext('2d');
    chart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    displayColors: false,
                    callbacks: {
                        label: (context) => {
                            const region = s.region || guessRegion(id);
                            const currencySymbol = getCurrencySymbol(region);
                            return `${context.dataset.label}: ${currencySymbol}${context.parsed.y.toFixed(2)}`;
                        }
                    }
                }
            },
            scales: {
                y: { position: 'right', grid: { color: 'rgba(255,255,255,0.05)' } },
                x: {
                    grid: { display: false },
                    min: labels.length > 10 ? labels[labels.length - 10] : undefined,
                    max: labels.length ? labels[labels.length - 1] : undefined
                }
            }
        },
        plugins: [
            {
                id: 'tLine',
                afterDraw(chart) {
                    if (!lastHistDate) return;
                    const xPos = chart.scales.x.getPixelForValue(lastHistDate);
                    const { ctx, chartArea: { top, bottom } } = chart;
                    ctx.save();
                    ctx.setLineDash([5, 5]);
                    ctx.beginPath();
                    ctx.moveTo(xPos, top);
                    ctx.lineTo(xPos, bottom);
                    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
                    ctx.stroke();
                    ctx.restore();
                }
            },
            {
                id: 'mouseLine',
                afterDraw(chart) {
                    const mouseX = chart.mouseX || -999;
                    const { ctx, chartArea: { top, bottom, left, right } } = chart;
                    if (mouseX > left && mouseX < right) {
                        ctx.save();
                        ctx.beginPath();
                        ctx.moveTo(mouseX, top);
                        ctx.lineTo(mouseX, bottom);
                        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
                        ctx.stroke();
                        ctx.restore();
                    }
                }
            },
            {
                id: 'connector',
                afterDatasetsDraw(chart) {
                    const histMeta = chart.getDatasetMeta(0);
                    const foreMeta = chart.getDatasetMeta(1);

                    // ★ 只处理最后一条历史有效数据 ★
                    let lastHistPoint = null;
                    let lastHistPrice = null;
                    let lastHistIdx = -1;
                    for (let i = histData.length - 1; i >= 0; i--) {
                        if (histData[i] !== null) {
                            lastHistPoint = histMeta.data[i];
                            lastHistPrice = histData[i];
                            lastHistIdx = i;
                            break;
                        }
                    }
                    if (!lastHistPoint || lastHistPoint.x == null) return;

                    const lastHistLabel = labels[lastHistIdx];
                    let firstForePoint = null;
                    let firstForePrice = null;
                    // 1. 先找同一天
                    for (let j = 0; j < foreData.length; j++) {
                        if (foreData[j] !== null && labels[j] === lastHistLabel) {
                            const pt = foreMeta.data[j];
                            if (pt && pt.x != null) {
                                firstForePoint = pt;
                                firstForePrice = foreData[j];
                                break;
                            }
                        }
                    }
                    // 2. 没有同一天，找向后第一个大于T日的预测点
                    if (!firstForePoint) {
                        for (let j = 0; j < foreData.length; j++) {
                            if (foreData[j] !== null && labels[j] > lastHistLabel) {
                                const pt = foreMeta.data[j];
                                if (pt && pt.x != null) {
                                    firstForePoint = pt;
                                    firstForePrice = foreData[j];
                                    break;
                                }
                            }
                        }
                        if (!firstForePoint) return; // 找不到就不画
                    }

                    const ctx = chart.ctx;
                    ctx.save();
                    ctx.setLineDash([5, 5]);
                    ctx.beginPath();
                    ctx.moveTo(lastHistPoint.x, lastHistPoint.y);
                    ctx.lineTo(firstForePoint.x, firstForePoint.y);
                    const color = (firstForePrice >= lastHistPrice) ? '#ff453a' : '#32d74b';
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2;
                    ctx.stroke();
                    ctx.restore();
                }
            }
        ]
    });

    // 滚动与缩放
    const allLabels = labels;
    let currentWindow = 10;
    let scrollIndex = allLabels.length - currentWindow;

    const scrollInput = document.getElementById('chart-scroll');
    const zoomOutBtn = document.getElementById('chart-zoom-out');
    const zoomInBtn = document.getElementById('chart-zoom-in');

    const updateVisibleRange = () => {
        if (allLabels.length === 0) return;
        const start = Math.max(0, Math.min(scrollIndex, allLabels.length - currentWindow));
        const end = Math.min(start + currentWindow - 1, allLabels.length - 1);
        chart.options.scales.x.min = allLabels[start];
        chart.options.scales.x.max = allLabels[end];
        chart.update('none');
        if (scrollInput) {
            scrollInput.max = Math.max(0, allLabels.length - currentWindow);
            scrollInput.value = start;
        }
    };

    if (scrollInput) {
        scrollInput.max = Math.max(0, allLabels.length - currentWindow);
        scrollInput.value = allLabels.length - currentWindow;
        scrollInput.addEventListener('input', (e) => {
            scrollIndex = parseInt(e.target.value, 10);
            updateVisibleRange();
        });
    }

    if (zoomOutBtn) {
        zoomOutBtn.addEventListener('click', () => {
            currentWindow = Math.max(3, currentWindow - 2);
            scrollIndex = Math.max(0, scrollIndex);
            updateVisibleRange();
        });
    }
    if (zoomInBtn) {
        zoomInBtn.addEventListener('click', () => {
            currentWindow = Math.min(allLabels.length, currentWindow + 2);
            scrollIndex = Math.max(0, allLabels.length - currentWindow);
            updateVisibleRange();
        });
    }

    scrollIndex = allLabels.length - currentWindow;
    updateVisibleRange();

    canvas.onmousemove = (evt) => {
        const rect = canvas.getBoundingClientRect();
        chart.mouseX = evt.clientX - rect.left;
        chart.draw();
    };
    canvas.onmouseleave = () => {
        chart.mouseX = null;
        chart.draw();
    };
}

// ---------- 删除与清空 ----------
window.removeStock = (e, id) => {
    e.stopPropagation();
    const name = STOCKS[id]?.name || '';
    if (confirm(`移除 ${id} ${name}？`)) {
        if (subscriptions[id]) {
            subscriptions[id]();
            delete subscriptions[id];
        }
        delete STOCKS[id];
        saveToCache();
        if (activeId === id) activeId = null;
        render();
    }
};

window.clearAllData = () => {
    if (confirm("确定清空所有自选股和本地缓存吗？")) {
        Object.values(subscriptions).forEach(unsub => unsub());
        for (const key in subscriptions) delete subscriptions[key];
        STOCKS = {};
        saveToCache();
        ensureDefaultStock();
        activeId = 'AAPL';
        render();
    }
};

function saveToCache() {
    localStorage.setItem('my_stocks', JSON.stringify(STOCKS));
}

window.toggleActive = (id) => {
    activeId = (activeId === id) ? null : id;
    render();
};

// 将拖拽相关函数暴露到全局
window.handleDragStart = handleDragStart;
window.handleDragOver = handleDragOver;
window.handleDrop = handleDrop;
window.handleDragEnd = handleDragEnd;