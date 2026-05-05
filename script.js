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

// 根据地区返回货币符号
function getCurrencySymbol(region) {
    if (region === '港股') return 'HK$';
    if (region === '美股') return '$';
    return '¥'; // 默认人民币（未来扩展）
}

// ---------- 默认股票初始化（无需写入 Firestore）----------
function ensureDefaultStock() {
    if (Object.keys(STOCKS).length > 0) return; // 已有股票，不需要初始化
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
    // 确保新用户/清除缓存后至少显示 AAPL
    ensureDefaultStock();
    render();
    Object.keys(STOCKS).forEach(id => setupSubscription(id));
};

// ---------- 搜索逻辑 ----------
function initSearchLogic() {
    const input = document.getElementById('stock-input');
    let resultBox = document.getElementById('search-results') || document.createElement('div');
    resultBox.id = 'search-results';
    resultBox.className = 'search-results';
    input.parentNode.style.position = 'relative';
    input.parentNode.appendChild(resultBox);

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

    input.addEventListener('focus', ensureCache);
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
            `<div class="search-item" onmousedown="event.preventDefault(); selectStock('${m.symbol}')">${m.symbol} ${m.name}</div>`
        ).join('');
        resultBox.style.display = matches.length ? 'block' : 'none';
        highlightIndex = -1;
        updateHighlightStyle();
    });

    input.addEventListener('keydown', (e) => {
        const items = resultBox.querySelectorAll('.search-item');
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
                selectStock(sym);
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

window.selectStock = (id) => {
    document.getElementById('stock-input').value = id;
    document.getElementById('search-results').style.display = 'none';
    highlightIndex = -1;
};

// ---------- 添加自选 ----------
window.addStock = async function () {
    const input = document.getElementById('stock-input');
    const val = input.value.toUpperCase().trim();
    if (!val) { alert("未选择股票"); return; }

    let finalSymbol = val, finalName = val, finalRegion = guessRegion(val);
    if (allStocksReady) {
        const matched = allStocksCache.find(s =>
            s.symbol === val || s.symbol.replace('.HK', '') === val || s.symbol === val + '.HK'
        );
        if (matched) {
            finalSymbol = matched.symbol;
            finalName = matched.name;
            finalRegion = matched.region;
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

// ---------- 列表渲染 ----------
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
        const nextPrice = s.forecast?.length ? s.forecast[0].price : 0;
        const region = s.region || guessRegion(id);
        const currencySymbol = getCurrencySymbol(region);
        const colorClass = nextPrice >= lastPrice ? 'price-up' : 'price-down';
        const logoUrls = Array.isArray(s.logo) ? s.logo : [s.logo];

        return `
            <div class="glass-card ${isActive ? 'active-card' : ''} ${isError ? 'border-red-500/40' : ''}">
                <div class="p-5 flex items-center justify-between cursor-pointer" onclick="toggleActive('${id}')">
                    <div class="flex items-center gap-4">
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
                            <p class="text-[9px] text-gray-500 font-bold">明日预测价</p>
                            <p class="font-mono font-bold ${isError ? 'text-gray-500' : colorClass}">${isError ? '--' : currencySymbol + nextPrice.toFixed(2)}</p>
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

// ---------- K线图 ----------
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

    const foreData = labels.map(date => {
        const found = foreArr.find(item => item.date.substring(0, 10) === date);
        return found ? found.price : null;
    });

    const lastHistDate = histArr.length ? histArr[histArr.length - 1].date.substring(0, 10) : null;

    const segmentColor = (ctx) => {
        const p0 = ctx.p0.parsed.y;
        const p1 = ctx.p1.parsed.y;
        return p1 >= p0 ? '#ff453a' : '#32d74b';
    };

    // 辅助函数：向前查找第一个非空值
    const findPrevValid = (data, index) => {
        for (let i = index - 1; i >= 0; i--) {
            if (data[i] !== null) return data[i];
        }
        return null;
    };

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
            // 预测数据集
            pointBackgroundColor: function(ctx) {
                const idx = ctx.dataIndex;
                const curr = ctx.dataset.data[idx];
                if (curr == null) return '#ff453a';
                let prev = findPrevValid(ctx.dataset.data, idx);
                // 如果向前找不到有效值，则用最后一条历史收盘价比较
                if (prev == null && histData.length > 0) {
                    const lastHistPrice = histData.filter(d => d !== null).pop();
                    if (lastHistPrice !== undefined) {
                        prev = lastHistPrice;
                    }
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

                    let lastHistPoint = null;
                    for (let i = histData.length - 1; i >= 0; i--) {
                        if (histData[i] !== null) {
                            lastHistPoint = histMeta.data[i];
                            break;
                        }
                    }
                    let firstForePoint = null;
                    for (let i = 0; i < foreData.length; i++) {
                        if (foreData[i] !== null) {
                            firstForePoint = foreMeta.data[i];
                            break;
                        }
                    }

                    if (!lastHistPoint || !firstForePoint) return;

                    const ctx = chart.ctx;
                    ctx.save();
                    ctx.setLineDash([5, 5]);
                    ctx.beginPath();
                    ctx.moveTo(lastHistPoint.x, lastHistPoint.y);
                    ctx.lineTo(firstForePoint.x, firstForePoint.y);

                    const lastHistPrice = histData.filter(d => d !== null).pop();
                    const firstForePrice = foreData.filter(d => d !== null)[0];
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
    if (confirm(`移除 ${id}?`)) {
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
        STOCKS = {}; // 清空对象
        saveToCache();
        // 重新初始化默认股票
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