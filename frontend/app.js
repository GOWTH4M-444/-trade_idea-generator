// Institutional Trading Terminal Engine v3.2

let tvChart = null;
let candleSeries = null;
let volumeSeries = null;
let sma20Series = null;
let sma50Series = null;
let lineSeries = null;

let chartType = 'candle';
let activeTimeframe = '1d';
let pollingTimer = null;
let cryptoWebSocket = null;
let currentAnalysisData = null;
let latestRealPrice = 0.0;
let latestCandleObj = null;

let activeWatchlistTab = 'ALL';

// User Indicator Selection State - Volume only is enabled by default for a clean chart
const indicatorConfig = {
    volume: true,     // Default: ONLY Volume indicator active
    sma20: false,
    sma50: false,
    patterns: false,
    rsi: false,
    macd: false,
    orderbook: false,
    quant: false,
    backtest: false,
    news: false
};

let watchlistItems = [
    // US NASDAQ / NYSE Leaders
    { symbol: 'AAPL', price: null, change: null, market: 'US', type: 'STOCK' },
    { symbol: 'NVDA', price: null, change: null, market: 'US', type: 'STOCK' },
    { symbol: 'TSLA', price: null, change: null, market: 'US', type: 'STOCK' },
    { symbol: 'MSFT', price: null, change: null, market: 'US', type: 'STOCK' },
    { symbol: 'AMZN', price: null, change: null, market: 'US', type: 'STOCK' },
    { symbol: 'GOOGL', price: null, change: null, market: 'US', type: 'STOCK' },
    
    // Indian Sensex & Nifty 50 Top Stocks & Indices
    { symbol: 'RELIANCE.NS', price: null, change: null, market: 'IN', type: 'STOCK' },
    { symbol: 'TCS.NS', price: null, change: null, market: 'IN', type: 'STOCK' },
    { symbol: 'INFY.NS', price: null, change: null, market: 'IN', type: 'STOCK' },
    { symbol: 'HDFCBANK.NS', price: null, change: null, market: 'IN', type: 'STOCK' },
    { symbol: 'TATAMOTORS.NS', price: null, change: null, market: 'IN', type: 'STOCK' },
    { symbol: '^NSEI', price: null, change: null, market: 'IN', type: 'INDEX' },
    { symbol: '^BSESN', price: null, change: null, market: 'IN', type: 'INDEX' },

    // Global Futures & Commodities
    { symbol: 'GC=F', price: null, change: null, market: 'FUTURES', type: 'COMMODITY' },
    { symbol: 'SI=F', price: null, change: null, market: 'FUTURES', type: 'COMMODITY' },
    { symbol: 'CL=F', price: null, change: null, market: 'FUTURES', type: 'COMMODITY' },

    // Crypto & Forex
    { symbol: 'BTC-USD', price: null, change: null, market: 'CRYPTO', type: 'CRYPTO' },
    { symbol: 'ETH-USD', price: null, change: null, market: 'CRYPTO', type: 'CRYPTO' },
    { symbol: 'USDINR=X', price: null, change: null, market: 'FOREX', type: 'FOREX' }
];

// Persistent UI state via ui-kit.js
const UIK = window.UI;
let analysisSeq = 0;
let activeIdeaIdx = null;
let ideaPriceLines = [];
let currentIdeas = [];
let chartResizeObserver = null;
let watchlistSort = UIK.store.get('wlSort', 'default');
let lastBacktest = null;
const VALID_TF = ['1m', '5m', '15m', '1h', '1d', '1wk'];

{
    const savedInd = UIK.store.get('indicators', null);
    if (savedInd) Object.keys(indicatorConfig).forEach(k => {
        if (k !== 'volume' && typeof savedInd[k] === 'boolean') indicatorConfig[k] = savedInd[k];
    });
    const savedTf = UIK.store.get('tf', null);
    if (VALID_TF.includes(savedTf)) activeTimeframe = savedTf;
    const savedType = UIK.store.get('chartType', 'candle');
    chartType = savedType === 'line' ? 'line' : 'candle';
    const savedWl = UIK.store.get('watchlist', null);
    if (Array.isArray(savedWl) && savedWl.length) {
        const clean = savedWl
            .filter(i => i && typeof i.symbol === 'string' && /^[\^A-Za-z0-9.=\-]{1,20}$/.test(i.symbol))
            .map(i => ({ symbol: i.symbol.toUpperCase(), price: null, change: null, market: i.market || 'AUTO', type: i.type || 'STOCK' }));
        if (clean.length) watchlistItems = clean;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const tickerInput = document.getElementById('ticker-input');
    const searchDropdown = document.getElementById('search-suggestions');
    const tfBtns = document.querySelectorAll('.tf-btn');

    const accountCapitalInput = document.getElementById('account-capital');
    const riskPercentInput = document.getElementById('risk-percent');
    
    const btnCandle = document.getElementById('btn-chart-candle');
    const btnLine = document.getElementById('btn-chart-line');
    
    const drawerToggleBtn = document.getElementById('drawer-toggle-btn');
    const drawerHeader = document.querySelector('.drawer-header');
    const drawerBody = document.getElementById('drawer-content');

    const addWatchlistInput = document.getElementById('add-watchlist-input');

    const savedCalc = UIK.store.get('calc', null);
    if (savedCalc) {
        if (savedCalc.capital) accountCapitalInput.value = savedCalc.capital;
        if (savedCalc.risk) riskPercentInput.value = savedCalc.risk;
    }
    const tvContainerForLoading = document.getElementById('chart-loading');
    function setChartLoading(on, label) {
        if (!tvContainerForLoading) return;
        const lbl = document.getElementById('chart-loading-label');
        if (lbl && label) lbl.textContent = label;
        tvContainerForLoading.classList.toggle('show', !!on);
    }
    function persistIndicators() { UIK.store.set('indicators', indicatorConfig); }
    function persistWatchlist() {
        UIK.store.set('watchlist', watchlistItems.map(({ symbol, market, type }) => ({ symbol, market, type })));
    }
    const isMobile = () => window.matchMedia('(max-width: 900px)').matches;

    function setChartType(type) {
        chartType = type === 'line' ? 'line' : 'candle';
        UIK.store.set('chartType', chartType);
        if (btnCandle && btnLine) {
            btnCandle.classList.toggle('active', chartType === 'candle');
            btnLine.classList.toggle('active', chartType === 'line');
        }
        if (currentAnalysisData) renderTradingViewChart(currentAnalysisData.chart_data, currentAnalysisData.metadata.currency);
    }
    if (btnCandle && btnLine) {
        btnCandle.classList.toggle('active', chartType === 'candle');
        btnLine.classList.toggle('active', chartType === 'line');
        btnCandle.addEventListener('click', () => setChartType('candle'));
        btnLine.addEventListener('click', () => setChartType('line'));
    }

    // Indicator Selector Feature UI Controller
    const btnIndicatorDropdown = document.getElementById('btn-indicator-dropdown');
    const indicatorDropdownMenu = document.getElementById('indicator-dropdown-menu');
    const btnResetIndicators = document.getElementById('btn-reset-indicators');

    if (btnIndicatorDropdown && indicatorDropdownMenu) {
        btnIndicatorDropdown.addEventListener('click', (e) => {
            e.stopPropagation();
            indicatorDropdownMenu.classList.toggle('hidden');
        });

        document.addEventListener('click', (e) => {
            if (!indicatorDropdownMenu.contains(e.target) && !btnIndicatorDropdown.contains(e.target)) {
                indicatorDropdownMenu.classList.add('hidden');
            }
        });
    }

    if (btnResetIndicators) {
        btnResetIndicators.addEventListener('click', () => {
            // Reset all indicators except Volume to false
            Object.keys(indicatorConfig).forEach(k => {
                if (k !== 'volume') {
                    indicatorConfig[k] = false;
                    const chk = document.getElementById(`chk-ind-${k}`);
                    if (chk) chk.checked = false;
                }
            });

            // Hide all bottom panes
            ['pane-rsi', 'pane-macd', 'pane-orderbook', 'pane-quant', 'pane-backtest', 'pane-news'].forEach(id => {
                const pane = document.getElementById(id);
                if (pane) pane.classList.add('hidden');
            });

            // Re-render chart with only Volume
            if (currentAnalysisData) {
                renderTradingViewChart(currentAnalysisData.chart_data, currentAnalysisData.metadata.currency);
            }
            updateActiveIndicatorPills();
            persistIndicators();
        });
    }

    const indicatorKeys = ['sma20', 'sma50', 'patterns', 'rsi', 'macd', 'orderbook', 'quant', 'backtest', 'news'];
    indicatorKeys.forEach(key => {
        const chk = document.getElementById(`chk-ind-${key}`);
        if (chk) {
            chk.checked = indicatorConfig[key];
            chk.addEventListener('change', () => {
                setIndicatorState(key, chk.checked);
            });
        }
    });

    function setIndicatorState(key, enabled) {
        indicatorConfig[key] = enabled;
        const chk = document.getElementById(`chk-ind-${key}`);
        if (chk) chk.checked = enabled;

        // Overlay indicators trigger chart re-render
        if (['sma20', 'sma50', 'patterns'].includes(key)) {
            if (currentAnalysisData) {
                renderTradingViewChart(currentAnalysisData.chart_data, currentAnalysisData.metadata.currency);
            }
        }

        // Panel indicators toggle DOM pane visibility
        const paneMap = {
            rsi: 'pane-rsi',
            macd: 'pane-macd',
            orderbook: 'pane-orderbook',
            quant: 'pane-quant',
            backtest: 'pane-backtest',
            news: 'pane-news'
        };

        if (paneMap[key]) {
            const pane = document.getElementById(paneMap[key]);
            if (pane) {
                if (enabled) {
                    pane.classList.remove('hidden');
                } else {
                    pane.classList.add('hidden');
                }
            }
        }

        if (key === 'backtest' && enabled && lastBacktest) {
            requestAnimationFrame(() => UIK.drawEquity(document.getElementById('equity-canvas'), lastBacktest.curve, lastBacktest.sym));
        }

        if (key === 'orderbook' && enabled && currentAnalysisData) {
            const m = currentAnalysisData.metadata;
            loadOrderBook(m.symbol, m.currency === 'INR' ? '₹' : '$');
        }

        updateActiveIndicatorPills();
        persistIndicators();

        // Smoothly adjust chart scale & resize
        setTimeout(() => {
            if (tvChart) {
                const container = document.getElementById('tv-chart-container');
                if (container) {
                    tvChart.applyOptions({
                        width: container.clientWidth || container.parentElement.clientWidth,
                        height: container.clientHeight || container.parentElement.clientHeight
                    });
                }
            }
        }, 80);
    }

    function updateActiveIndicatorPills() {
        const pillsContainer = document.getElementById('active-indicator-pills');
        const badgeElem = document.getElementById('active-indicators-count');
        if (!pillsContainer) return;

        pillsContainer.innerHTML = '';
        let activeCount = 0;

        if (indicatorConfig.volume) {
            activeCount++;
            const volPill = document.createElement('span');
            volPill.className = 'ind-pill default';
            volPill.textContent = 'Vol (Default)';
            pillsContainer.appendChild(volPill);
        }

        const labelMap = {
            sma20: 'SMA 20',
            sma50: 'SMA 50',
            patterns: 'Patterns',
            rsi: 'RSI',
            macd: 'MACD',
            orderbook: 'Order Book',
            quant: 'Quant',
            backtest: 'Backtest',
            news: 'News'
        };

        Object.keys(labelMap).forEach(key => {
            if (indicatorConfig[key]) {
                activeCount++;
                const pill = document.createElement('span');
                pill.className = 'ind-pill';
                pill.innerHTML = `<span>${labelMap[key]}</span><span class="ind-pill-remove" data-key="${key}" title="Remove indicator">✕</span>`;
                pillsContainer.appendChild(pill);
            }
        });

        if (badgeElem) badgeElem.textContent = activeCount;

        pillsContainer.querySelectorAll('.ind-pill-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const key = btn.getAttribute('data-key');
                if (key) setIndicatorState(key, false);
            });
        });
    }

    updateActiveIndicatorPills();
    indicatorKeys.forEach(k => { if (indicatorConfig[k]) setIndicatorState(k, true); });

    document.querySelectorAll('.pane-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-target');
            const targetElem = document.getElementById(targetId);
            if (targetElem) {
                targetElem.classList.toggle('hidden');
                btn.textContent = targetElem.classList.contains('hidden') ? '▶' : '▼';
            }
        });
    });

    function setTimeframe(tf) {
        if (!VALID_TF.includes(tf)) return;
        activeTimeframe = tf;
        UIK.store.set('tf', tf);
        tfBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-tf') === tf));
        const hudTf = document.getElementById('hud-tf');
        if (hudTf) hudTf.textContent = tf.toUpperCase();
        if (typeof updateCountdownTimerFn === 'function') updateCountdownTimerFn();
        const activeSymbol = document.getElementById('symbol-badge').textContent || 'AAPL';
        triggerAnalysis(activeSymbol, 'AUTO', tf);
    }
    tfBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-tf') === activeTimeframe));
    tfBtns.forEach(btn => btn.addEventListener('click', () => setTimeframe(btn.getAttribute('data-tf'))));

    if (drawerHeader) {
        drawerHeader.addEventListener('click', () => {
            drawerBody.classList.toggle('collapsed');
            drawerToggleBtn.textContent = drawerBody.classList.contains('collapsed') ? '▲' : '▼';
        });
    }

    function addToWatchlist(raw) {
        const sym = String(raw || '').trim().toUpperCase();
        if (!sym) return;
        if (!/^[\^A-Za-z0-9.=\-]{1,20}$/.test(sym)) { UIK.toast(`"${sym}" doesn't look like a valid ticker`, { type: 'warn' }); return; }
        if (watchlistItems.some(i => i.symbol === sym)) {
            UIK.toast(`${sym} is already in your watchlist`, { type: 'info' });
        } else {
            watchlistItems.unshift({ symbol: sym, price: null, change: null, market: 'AUTO', type: 'STOCK' });
            persistWatchlist();
            renderWatchlist();
            refreshQuotes();
            UIK.toast(`${sym} added to watchlist`, { type: 'success' });
        }
        triggerAnalysis(sym, 'AUTO', activeTimeframe);
    }

    if (addWatchlistInput) {
        addWatchlistInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                addToWatchlist(addWatchlistInput.value);
                addWatchlistInput.value = '';
            }
        });
    }

    const btnRunBacktest = document.getElementById('btn-run-backtest');
    if (btnRunBacktest) {
        btnRunBacktest.addEventListener('click', () => {
            const activeSymbol = document.getElementById('symbol-badge').textContent || 'AAPL';
            runStrategyBacktest(activeSymbol, false);
        });
    }

    const btnRefreshIdeas = document.getElementById('btn-refresh-ideas');
    if (btnRefreshIdeas) {
        btnRefreshIdeas.addEventListener('click', () => {
            refreshTradeIdeasOnly();
        });
    }

    let searchTimeout = null;
    tickerInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        const query = tickerInput.value.trim();
        
        if (query.length < 2) {
            searchDropdown.classList.add('hidden');
            return;
        }

        searchTimeout = setTimeout(async () => {
            try {
                const res = await fetch(`${CONFIG.API_BASE_URL}/search?query=${encodeURIComponent(query)}`);
                if (res.ok) {
                    const data = await res.json();
                    renderSuggestions(data.suggestions);
                }
            } catch (err) {
                console.error("Search suggestion error:", err);
            }
        }, 200);
    });

    function renderSuggestions(suggestions) {
        if (!suggestions || suggestions.length === 0) {
            searchDropdown.classList.add('hidden');
            return;
        }

        searchDropdown.innerHTML = '';
        suggestions.forEach(item => {
            const div = document.createElement('div');
            div.className = 'suggestion-item';
            div.innerHTML = `
                <span class="s-name">${escapeHtml(item.name)} (${escapeHtml(item.symbol)})</span>
                <span class="s-type">${escapeHtml(item.type)}</span>
            `;
            div.addEventListener('click', () => {
                tickerInput.value = item.symbol;
                searchDropdown.classList.add('hidden');
                triggerAnalysis(item.symbol, 'AUTO', activeTimeframe);
            });
            searchDropdown.appendChild(div);
        });
        searchDropdown.classList.remove('hidden');
    }

    document.addEventListener('click', (e) => {
        if (!tickerInput.contains(e.target) && !searchDropdown.contains(e.target)) {
            searchDropdown.classList.add('hidden');
        }
    });

    tickerInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const symbol = tickerInput.value.trim();
            searchDropdown.classList.add('hidden');
            if (symbol) triggerAnalysis(symbol, 'AUTO', activeTimeframe);
        }
    });

    accountCapitalInput.addEventListener('input', updateCalculatorDisplay);
    riskPercentInput.addEventListener('input', updateCalculatorDisplay);

    function updateCalculatorDisplay() {
        if (!currentAnalysisData) return;
        const capital = parseFloat(accountCapitalInput.value) || 10000;
        const riskPct = parseFloat(riskPercentInput.value) || 2;
        const maxRisk = (capital * riskPct) / 100;
        UIK.store.set('calc', { capital: accountCapitalInput.value, risk: riskPercentInput.value });

        const currencySym = currentAnalysisData.metadata.currency === 'INR' ? '₹' : '$';
        document.getElementById('drawer-max-risk').textContent = `${currencySym}${maxRisk.toFixed(2)}`;
        document.getElementById('calc-risk-out').textContent = `${currencySym}${maxRisk.toFixed(2)}`;

        renderTradeIdeas(currentAnalysisData.ai_analysis, currentAnalysisData.metadata.currency, currentAnalysisData.api_key_configured, { recalc: true });
    }

    document.querySelectorAll('.wl-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.wl-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeWatchlistTab = tab.getAttribute('data-market');
            renderWatchlist();
        });
    });

    function visibleWatchlist() {
        const filtered = watchlistItems.filter(item => {
            if (activeWatchlistTab === 'ALL') return true;
            if (activeWatchlistTab === 'US') return item.market === 'US';
            if (activeWatchlistTab === 'IN') return item.market === 'IN' || item.symbol.endsWith('.NS') || item.symbol.endsWith('.BO') || item.symbol.startsWith('^NSE') || item.symbol.startsWith('^BSE');
            if (activeWatchlistTab === 'FUTURES') return item.market === 'FUTURES' || item.symbol.endsWith('=F') || item.type === 'COMMODITY';
            if (activeWatchlistTab === 'CRYPTO') return item.market === 'CRYPTO' || item.symbol.endsWith('-USD') || item.type === 'CRYPTO';
            return true;
        });
        if (watchlistSort === 'default') return filtered;
        const quoted = filtered.filter(i => i.change != null);
        const unquoted = filtered.filter(i => i.change == null);
        quoted.sort((a, b) => watchlistSort === 'gainers' ? b.change - a.change : a.change - b.change);
        return [...quoted, ...unquoted];
    }

    const wlSortBtn = document.getElementById('wl-sort-btn');
    const SORT_LABELS = { default: 'Sort: Default', gainers: 'Sort: Gainers', losers: 'Sort: Losers' };
    if (wlSortBtn) {
        wlSortBtn.textContent = SORT_LABELS[watchlistSort] || SORT_LABELS.default;
        wlSortBtn.addEventListener('click', () => {
            const order = ['default', 'gainers', 'losers'];
            watchlistSort = order[(order.indexOf(watchlistSort) + 1) % order.length];
            UIK.store.set('wlSort', watchlistSort);
            wlSortBtn.textContent = SORT_LABELS[watchlistSort];
            renderWatchlist();
        });
    }

    function removeFromWatchlist(symbol) {
        const idx = watchlistItems.findIndex(i => i.symbol === symbol);
        if (idx < 0) return;
        const [removed] = watchlistItems.splice(idx, 1);
        persistWatchlist();
        renderWatchlist();
        UIK.toast(`${symbol} removed`, {
            type: 'info',
            action: { label: 'Undo', onClick: () => { watchlistItems.splice(idx, 0, removed); persistWatchlist(); renderWatchlist(); } }
        });
    }

    function renderWatchlist() {
        const container = document.getElementById('watchlist-items');
        if (!container) return;

        const items = visibleWatchlist();
        document.getElementById('watchlist-count').textContent = items.length;
        const scroll = container.scrollTop;
        container.innerHTML = '';

        const activeSymbol = document.getElementById('symbol-badge').textContent || 'AAPL';

        items.forEach(item => {
            const div = document.createElement('div');
            const isActive = item.symbol.toUpperCase() === activeSymbol.toUpperCase();
            const flashCls = item.flash > 0 ? 'flash-up' : (item.flash < 0 ? 'flash-down' : '');
            div.className = `watchlist-item ${isActive ? 'active' : ''} ${flashCls}`.trim();

            const hasQuote = item.price !== null && item.price !== undefined && item.change !== null && item.change !== undefined;
            const isPos = hasQuote && item.change >= 0;
            const sign = isPos ? '+' : '';
            const barW = hasQuote ? Math.min(50, Math.abs(item.change) * 10) : 0;
            const barLeft = isPos ? 50 : 50 - barW;

            div.innerHTML = `
                <button class="wl-remove" type="button" aria-label="Remove ${escapeHtml(item.symbol)}" title="Remove from watchlist">✕</button>
                <div class="wl-symbol">${escapeHtml(item.symbol)}</div>
                <div class="wl-price-col num-mono">
                    <span class="wl-price">${item.price != null ? formatPrice(item.price) : '--'}</span>
                    <span class="wl-pct ${hasQuote ? (isPos ? 'num-val positive' : 'num-val negative') : 'num-val'}">${hasQuote ? sign + item.change.toFixed(2) + '%' : '--'}</span>
                </div>
                <div class="wl-bar ${isPos ? '' : 'neg'}" title="Daily move (full bar = 5%)"><i style="left:${barLeft}%;width:${barW}%"></i></div>
            `;

            div.querySelector('.wl-remove').addEventListener('click', (e) => {
                e.stopPropagation();
                removeFromWatchlist(item.symbol);
            });
            div.addEventListener('click', () => {
                triggerAnalysis(item.symbol, item.market || 'AUTO', activeTimeframe);
                if (isMobile()) setMobileTab('chart');
            });

            container.appendChild(div);
        });
        container.scrollTop = scroll;
        watchlistItems.forEach(i => { i.flash = 0; });
    }

    function showIdeasSkeleton() {
        const list = document.getElementById('trade-ideas-list');
        if (!list) return;
        const card = `<div class="skeleton-card"><div class="sk-line w40"></div><div class="sk-line tall"></div><div class="sk-line w90"></div><div class="sk-line w60"></div></div>`;
        list.innerHTML = card + card;
    }

    async function triggerAnalysis(ticker, market = 'AUTO', interval = '1d') {
        stopAllLiveStreams();
        const seq = ++analysisSeq;
        setChartLoading(true, `Loading ${String(ticker).toUpperCase()}…`);
        showIdeasSkeleton();

        try {
            const response = await fetch(`${CONFIG.API_BASE_URL}/analyze?ticker=${encodeURIComponent(ticker)}&market=${encodeURIComponent(market)}&interval=${encodeURIComponent(interval)}`);

            if (!response.ok) {
                const errData = await response.json().catch(() => ({ detail: 'Failed to fetch ticker data.' }));
                throw new Error(errData.detail || `HTTP Error ${response.status}`);
            }

            const data = await response.json();
            if (seq !== analysisSeq) return;

            if (!data.success) {
                throw new Error('Analysis payload returned unsuccessful status.');
            }

            currentAnalysisData = data;
            latestRealPrice = data.metadata.current_price;
            UIK.store.set('symbol', data.metadata.symbol);

            renderHeader(data.metadata, data.indicators);
            renderWatchlist();
            updateCalculatorDisplay();
            renderIndicators(data.indicators);
            updateOrderBookAndQuantMatrix(data.metadata, data.indicators);
            updateNewsFeed(data.metadata.symbol);
            runStrategyBacktest(data.metadata.symbol, true);
            renderTradingViewChart(data.chart_data, data.metadata.currency);
            renderTradeIdeas(data.ai_analysis, data.metadata.currency, data.api_key_configured);

            initLivePriceStream(data.metadata.symbol, data.metadata.asset_class);
            startOrderBookRefresh(data.metadata.symbol, data.metadata.currency === 'INR' ? '₹' : '$');

        } catch (error) {
            if (seq !== analysisSeq) return;
            console.error("Analysis Error:", error);
            updateFreshnessBadge('delayed', 'Feed Delayed');
            UIK.toast(`Couldn't load ${String(ticker).toUpperCase()}: ${error.message}`, {
                type: 'error',
                action: { label: 'Retry', onClick: () => triggerAnalysis(ticker, market, interval) }
            });
            if (currentAnalysisData) {
                const m = currentAnalysisData.metadata;
                renderTradeIdeas(currentAnalysisData.ai_analysis, m.currency, currentAnalysisData.api_key_configured, { recalc: true });
                initLivePriceStream(m.symbol, m.asset_class);
                startOrderBookRefresh(m.symbol, m.currency === 'INR' ? '₹' : '$');
            } else {
                const list = document.getElementById('trade-ideas-list');
                if (list) list.innerHTML = '<div class="news-empty">Could not load data. Check that backend is running.</div>';
            }
        } finally {
            if (seq === analysisSeq) setChartLoading(false);
        }
    }

    function updateOrderBookAndQuantMatrix(meta, indicators) {
        const currPrice = meta.current_price || 100;
        const currencySym = meta.currency === 'INR' ? '₹' : '$';

        loadOrderBook(meta.symbol, currencySym);

        const rvol = Number(indicators.vol_ratio);
        const qRvol = document.getElementById('q-rvol');
        if (qRvol) {
            qRvol.textContent = Number.isFinite(rvol) ? `${rvol.toFixed(2)}x (${rvol >= 1.5 ? 'Volume Spike' : 'Normal Vol'})` : '--';
            qRvol.className = `q-val num-mono ${Number.isFinite(rvol) && rvol >= 1.5 ? 'positive' : ''}`;
        }

        const q52w = document.getElementById('q-52w-pos');
        if (q52w) {
            const high52 = meta.fifty_two_week_high;
            const low52 = meta.fifty_two_week_low;
            if (high52 && low52 && high52 > low52) {
                const pos = Math.round(((currPrice - low52) / (high52 - low52)) * 100);
                const label = meta.fifty_two_week_high_is_true_52w ? '52W range' : 'loaded-period range';
                q52w.textContent = `${pos}% of ${label}`;
            } else {
                q52w.textContent = '--';
            }
        }

        const qAtr = document.getElementById('q-atr');
        if (qAtr) {
            if (indicators.atr_14 != null) {
                const pct = indicators.atr_pct != null ? ` (${indicators.atr_pct}% of price)` : '';
                qAtr.textContent = `${currencySym}${indicators.atr_14}${pct}`;
            } else {
                qAtr.textContent = '--';
            }
        }

        const qSent = document.getElementById('q-sentiment');
        const qScore = document.getElementById('quant-score-tag');
        if (qSent && qScore) {
            const score = Number(indicators.technical_score);
            qScore.textContent = `Score: ${score}/100`;
            qScore.className = `pane-status ${score >= 55 ? 'positive' : 'negative'}`;
            qSent.textContent = indicators.sentiment || '--';
            qSent.className = `q-val ${score >= 55 ? 'positive' : 'negative'}`;
        }
    }

    function formatPrice(v) {
        if (v === null || v === undefined || isNaN(v)) return '--';
        const n = Number(v);
        if (n >= 1000) return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return n < 1 ? n.toFixed(4) : n.toFixed(2);
    }

    function setOrderBookEmpty(message) {
        const bidsList = document.getElementById('bids-list');
        const asksList = document.getElementById('asks-list');
        if (bidsList) bidsList.innerHTML = `<div class="news-empty">${escapeHtml(message)}</div>`;
        if (asksList) asksList.innerHTML = '';
        const tag = document.getElementById('orderbook-bias-tag');
        if (tag) { tag.textContent = 'Unavailable'; tag.className = 'pane-status'; }
        const bidPct = document.getElementById('bid-pct-val');
        const askPct = document.getElementById('ask-pct-val');
        if (bidPct) bidPct.textContent = '--';
        if (askPct) askPct.textContent = '--';
        const bidsBar = document.getElementById('ob-bids-bar');
        const asksBar = document.getElementById('ob-asks-bar');
        if (bidsBar) bidsBar.style.width = '0%';
        if (asksBar) asksBar.style.width = '0%';
    }

    async function loadOrderBook(symbol, currencySym) {
        if (!indicatorConfig.orderbook) return;
        try {
            const res = await fetch(`${CONFIG.API_BASE_URL}/orderbook?ticker=${encodeURIComponent(symbol)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const book = await res.json();
            if (currentAnalysisData && currentAnalysisData.metadata.symbol !== symbol) return;

            if (!book.available) {
                setOrderBookEmpty(book.reason || 'Order book not available for this instrument.');
                return;
            }

            const render = (levels) => levels.map(l =>
                `<div class="ob-row"><span>${currencySym}${formatPrice(l.price)}</span><span>${l.qty != null ? Number(l.qty).toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' qty' : '--'}</span></div>`
            ).join('');
            document.getElementById('bids-list').innerHTML = render(book.bids);
            document.getElementById('asks-list').innerHTML = render(book.asks);

            const bidQty = book.bids.reduce((a, l) => a + (Number(l.qty) || 0), 0);
            const askQty = book.asks.reduce((a, l) => a + (Number(l.qty) || 0), 0);
            const total = bidQty + askQty;
            const tag = document.getElementById('orderbook-bias-tag');
            const bidPct = document.getElementById('bid-pct-val');
            const askPct = document.getElementById('ask-pct-val');
            const bidsBar = document.getElementById('ob-bids-bar');
            const asksBar = document.getElementById('ob-asks-bar');

            if (total > 0) {
                const b = (bidQty / total) * 100;
                bidPct.textContent = `${b.toFixed(1)}%`;
                askPct.textContent = `${(100 - b).toFixed(1)}%`;
                bidsBar.style.width = `${b}%`;
                asksBar.style.width = `${100 - b}%`;
                tag.textContent = `${book.level} · ${b >= 50 ? b.toFixed(1) + '% Buyers' : (100 - b).toFixed(1) + '% Sellers'}`;
                tag.className = `pane-status ${b >= 50 ? 'positive' : 'negative'}`;
            } else {
                bidPct.textContent = '--';
                askPct.textContent = '--';
                bidsBar.style.width = '0%';
                asksBar.style.width = '0%';
                tag.textContent = `${book.level} · sizes n/a`;
                tag.className = 'pane-status';
            }
        } catch (err) {
            setOrderBookEmpty('Could not load order book.');
        }
    }

    function startOrderBookRefresh(symbol, currencySym) {
        if (orderBookTimer) clearInterval(orderBookTimer);
        orderBookTimer = setInterval(() => loadOrderBook(symbol, currencySym), 10000);
    }

    async function runStrategyBacktest(symbol, isQuiet = false) {
        const btn = document.getElementById('btn-run-backtest');
        if (btn && !isQuiet) {
            btn.textContent = '⏳ Calculating...';
            btn.disabled = true;
        }

        const setText = (id, text, cls) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = text;
            if (cls !== undefined) el.className = cls;
        };
        const fin = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

        try {
            const res = await fetch(`${CONFIG.API_BASE_URL}/backtest?ticker=${encodeURIComponent(symbol)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (currentAnalysisData && currentAnalysisData.metadata.symbol !== symbol) return;
            if (!(data.success && data.backtest)) throw new Error('No backtest data');

            const bt = data.backtest;
            const cur = data.metadata && data.metadata.currency === 'INR' ? '₹' : '$';
            const winrate = fin(bt.win_rate_pct) ? Number(bt.win_rate_pct) : null;
            const roi = fin(bt.net_roi_pct) ? Number(bt.net_roi_pct) : null;

            setText('bt-winrate', winrate != null ? `${winrate.toFixed(1)}%` : '--');
            setText('backtest-winrate-tag', winrate != null ? `Win Rate: ${winrate.toFixed(1)}%` : 'Win Rate: --');
            setText('bt-roi', roi != null ? `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%` : '--', `bt-val ${roi == null ? '' : (roi >= 0 ? 'positive' : 'negative')}`);
            setText('bt-pf', fin(bt.profit_factor) ? `${Number(bt.profit_factor).toFixed(2)}x` : '--');
            setText('bt-dd', fin(bt.max_drawdown_pct) ? `${Number(bt.max_drawdown_pct).toFixed(1)}%` : '--', 'bt-val negative');
            setText('bt-trades', fin(bt.total_trades) ? String(bt.total_trades) : '--');
            setText('bt-rr', bt.avg_rr_ratio || '--');

            const tradesContainer = document.getElementById('bt-trades-list');
            if (tradesContainer) {
                tradesContainer.innerHTML = '';
                const log = Array.isArray(bt.trades_log) ? bt.trades_log.slice(-5).reverse() : [];
                if (!log.length) tradesContainer.innerHTML = '<div class="news-empty">No completed trades in this period.</div>';
                log.forEach(trade => {
                    const pnl = Number(trade.pnl) || 0;
                    const isWin = pnl >= 0;
                    const div = document.createElement('div');
                    div.className = `bt-trade-row ${isWin ? 'win' : 'loss'}`;
                    div.innerHTML = `
                        <span>${escapeHtml(trade.exit_date)} (${escapeHtml(trade.type)})</span>
                        <span>Entry: ${escapeHtml(trade.entry)} → Exit: ${escapeHtml(trade.exit)}</span>
                        <span class="${isWin ? 'positive' : 'negative'}">${isWin ? '+' : '-'}${cur}${Math.abs(pnl).toFixed(2)} (${isWin ? 'WIN' : 'LOSS'})</span>
                    `;
                    tradesContainer.appendChild(div);
                });
            }

            lastBacktest = { curve: bt.equity_curve || [], sym: cur };
            requestAnimationFrame(() => UIK.drawEquity(document.getElementById('equity-canvas'), lastBacktest.curve, cur));
        } catch (err) {
            console.error("Backtest Fetch Error:", err);
            if (!isQuiet) UIK.toast('Backtest failed. Try again in a moment.', { type: 'error' });
        } finally {
            if (btn) {
                btn.textContent = '⚡ Run Backtest';
                btn.disabled = false;
            }
        }
    }

    function timeAgo(iso) {
        if (!iso) return '';
        const t = Date.parse(iso);
        if (isNaN(t)) return '';
        const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.round(mins / 60);
        if (hrs < 48) return `${hrs}h ago`;
        return `${Math.round(hrs / 24)}d ago`;
    }

    async function updateNewsFeed(symbol) {
        const container = document.getElementById('live-news-feed');
        if (!container) return;
        container.innerHTML = '<div class="news-empty">Loading headlines…</div>';

        try {
            const res = await fetch(`${CONFIG.API_BASE_URL}/news?ticker=${encodeURIComponent(symbol)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (currentAnalysisData && currentAnalysisData.metadata.symbol !== symbol) return;

            container.innerHTML = '';
            if (!data.ok) {
                container.innerHTML = '<div class="news-empty">News feed is unavailable right now.</div>';
                return;
            }
            if (!data.items || data.items.length === 0) {
                container.innerHTML = '<div class="news-empty">No recent headlines for this symbol.</div>';
                return;
            }

            data.items.forEach(item => {
                const div = document.createElement('div');
                div.className = 'news-tape-item';
                const safeUrl = item.url && /^https?:\/\//i.test(item.url) ? item.url : null;
                const headline = safeUrl
                    ? `<a class="news-headline" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>`
                    : `<span class="news-headline">${escapeHtml(item.title)}</span>`;
                div.innerHTML = `
                    <span class="news-badge catalyst">[${escapeHtml(item.publisher)}]</span>
                    ${headline}
                    <span class="news-time">${escapeHtml(timeAgo(item.published))}</span>
                `;
                container.appendChild(div);
            });
        } catch (err) {
            container.innerHTML = '<div class="news-empty">Could not load headlines.</div>';
        }
    }

    let orderBookTimer = null;

    function detectCandlestickPatterns(chartData) {
        const markers = [];
        const prices = chartData.prices || [];
        const highs = chartData.highs || prices;
        const lows = chartData.lows || prices;
        const timestamps = chartData.timestamps || [];
        if (prices.length < 4) return markers;

        let lastTimeVal = null;

        for (let i = 2; i < prices.length; i++) {
            const rawTime = timestamps[i];
            const timeVal = formatLwTime(rawTime);

            if (lastTimeVal !== null && timeVal <= lastTimeVal) continue;
            lastTimeVal = timeVal;

            const close = prices[i];
            const prevClose = prices[i-1];
            const open = (chartData.opens && chartData.opens[i] !== undefined) ? chartData.opens[i] : prevClose;
            const high = highs[i] || Math.max(open, close);
            const low = lows[i] || Math.min(open, close);

            const bodySize = Math.abs(close - open);
            const candleRange = high - low || 0.01;
            const upperWick = high - Math.max(open, close);
            const lowerWick = Math.min(open, close) - low;

            const prevOpen = (chartData.opens && chartData.opens[i-1] !== undefined) ? chartData.opens[i-1] : (i > 1 ? prices[i-2] : prevClose);

            // Bullish Engulfing
            if (prevClose < prevOpen && close > open && close >= prevOpen && open <= prevClose) {
                markers.push({ time: timeVal, position: 'belowBar', color: '#00D4A0', shape: 'arrowUp', text: 'Bullish Engulfing' });
            }
            // Bearish Engulfing
            else if (prevClose > prevOpen && close < open && close <= prevOpen && open >= prevClose) {
                markers.push({ time: timeVal, position: 'aboveBar', color: '#FF5D5D', shape: 'arrowDown', text: 'Bearish Engulfing' });
            }
            // Hammer
            else if (lowerWick >= bodySize * 1.8 && upperWick <= bodySize * 0.6 && close >= open) {
                markers.push({ time: timeVal, position: 'belowBar', color: '#00D4A0', shape: 'circle', text: 'Hammer' });
            }
            // Shooting Star
            else if (upperWick >= bodySize * 1.8 && lowerWick <= bodySize * 0.6 && close <= open) {
                markers.push({ time: timeVal, position: 'aboveBar', color: '#FF5D5D', shape: 'circle', text: 'Shooting Star' });
            }
            // Doji
            else if (bodySize <= candleRange * 0.12) {
                markers.push({ time: timeVal, position: 'aboveBar', color: '#f59e0b', shape: 'square', text: 'Doji' });
            }
        }
        return markers;
    }

    function initLivePriceStream(symbol, assetClass) {
        stopAllLiveStreams();
        if (assetClass === 'CRYPTO' || symbol.includes('-USD') || symbol.includes('BTC') || symbol.includes('ETH')) {
            updateFreshnessBadge('ws', 'Live WebSocket');
            const pair = symbol.replace('-USD', '').toLowerCase() + 'usdt';
            const wsUrl = `wss://stream.binance.com:9443/ws/${pair}@ticker`;

            try {
                cryptoWebSocket = new WebSocket(wsUrl);
                cryptoWebSocket.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    if (data && data.c) {
                        onLivePriceTickReceived(parseFloat(data.c));
                    }
                };
                cryptoWebSocket.onerror = () => {
                    start10sPollingLoop(symbol);
                };
                return;
            } catch (err) {
                start10sPollingLoop(symbol);
            }
        }

        start10sPollingLoop(symbol);
    }

    function start10sPollingLoop(symbol) {
        updateFreshnessBadge('polling', 'Polling (10s)');

        pollingTimer = setInterval(async () => {
            try {
                const res = await fetch(`${CONFIG.API_BASE_URL}/live-price?ticker=${encodeURIComponent(symbol)}`);
                if (res.ok) {
                    const priceData = await res.json();
                    if (priceData.success && priceData.price) {
                        updateFreshnessBadge('polling', 'Polling (10s)');
                        latestRealPrice = priceData.price;
                        onLivePriceTickReceived(priceData.price, false);
                    } else if (priceData.status === 'feed_delayed') {
                        updateFreshnessBadge('delayed', 'Feed Delayed');
                    }
                } else {
                    updateFreshnessBadge('delayed', 'Feed Delayed');
                }
            } catch (err) {
                updateFreshnessBadge('delayed', 'Feed Delayed');
            }
        }, 10000);
    }

    function stopAllLiveStreams() {
        if (cryptoWebSocket) {
            try { cryptoWebSocket.close(); } catch (e) {}
            cryptoWebSocket = null;
        }
        if (pollingTimer) {
            clearInterval(pollingTimer);
            pollingTimer = null;
        }
        if (orderBookTimer) {
            clearInterval(orderBookTimer);
            orderBookTimer = null;
        }
    }

    function updateFreshnessBadge(mode, label) {
        const badge = document.getElementById('data-freshness-badge');
        const labelElem = document.getElementById('freshness-label');
        if (!badge || !labelElem) return;
        badge.className = `freshness-badge mode-${mode}`;
        labelElem.textContent = label;
    }

    function onLivePriceTickReceived(newPrice, isMicro = false) {
        if (!newPrice || !latestRealPrice) return;

        const priceElem = document.getElementById('current-price');
        const isUp = newPrice >= latestRealPrice;
        if (!isMicro) latestRealPrice = newPrice;

        priceElem._tweenToken = (priceElem._tweenToken || 0) + 1;
        priceElem.textContent = newPrice.toFixed(2);
        if (currentAnalysisData) document.title = `${currentAnalysisData.metadata.symbol} ${newPrice.toFixed(2)} · AI Trade Terminal`;
        if (!isMicro) {
            priceElem.className = `num-mono live-price-tick ${isUp ? 'tick-up' : 'tick-down'}`;
            setTimeout(() => {
                priceElem.className = 'num-mono live-price-tick';
            }, 150);
        }

        if (latestCandleObj) {
            latestCandleObj.close = round2(newPrice);
            if (newPrice > latestCandleObj.high) latestCandleObj.high = round2(newPrice);
            if (newPrice < latestCandleObj.low) latestCandleObj.low = round2(newPrice);

            if (chartType === 'candle' && candleSeries) candleSeries.update(latestCandleObj);
            else if (chartType === 'line' && lineSeries) lineSeries.update({ time: latestCandleObj.time, value: round2(newPrice) });

            if (currentAnalysisData) {
                const chartData = currentAnalysisData.chart_data;
                const lastVol = chartData && chartData.volumes && chartData.volumes.length > 0 ? chartData.volumes[chartData.volumes.length - 1] : null;
                updateFloatingHud(latestCandleObj, lastVol, currentAnalysisData.metadata.symbol, activeTimeframe, currentAnalysisData.metadata.currency);
            }
        }

        if (currentAnalysisData && currentAnalysisData.chart_data) {
            const chartData = currentAnalysisData.chart_data;
            if (chartData.prices && chartData.prices.length > 0) {
                chartData.prices[chartData.prices.length - 1] = round2(newPrice);
                if (chartData.highs && chartData.highs.length > 0) {
                    chartData.highs[chartData.highs.length - 1] = Math.max(chartData.highs[chartData.highs.length - 1], round2(newPrice));
                }
                if (chartData.lows && chartData.lows.length > 0) {
                    chartData.lows[chartData.lows.length - 1] = Math.min(chartData.lows[chartData.lows.length - 1], round2(newPrice));
                }
                const fallbackCanvas = document.getElementById('fallback-chart-canvas');
                if (fallbackCanvas && !fallbackCanvas.classList.contains('hidden')) {
                    renderFallbackCanvasChart(chartData, currentAnalysisData.metadata.currency);
                }
            }
        }
    }

    function renderHeader(meta, indicators) {
        document.getElementById('symbol-badge').textContent = meta.symbol;
        document.getElementById('asset-type-badge').textContent = meta.asset_class || 'STOCK';
        document.getElementById('chart-symbol-name').textContent = meta.symbol;
        
        const hudSym = document.getElementById('hud-sym');
        const hudTf = document.getElementById('hud-tf');
        if (hudSym) hudSym.textContent = meta.symbol;
        if (hudTf) hudTf.textContent = activeTimeframe.toUpperCase();
        
        const currencySym = meta.currency === 'INR' ? '₹' : '$';
        document.getElementById('currency-symbol').textContent = currencySym;
        document.getElementById('calc-currency-sym').textContent = currencySym;
        const priceEl = document.getElementById('current-price');
        const prevShown = parseFloat(String(priceEl.textContent).replace(/,/g, ''));
        if (priceEl.dataset.sym === meta.symbol) UIK.tween(priceEl, prevShown, meta.current_price, v => v.toFixed(2));
        else { priceEl._tweenToken = (priceEl._tweenToken || 0) + 1; priceEl.textContent = meta.current_price.toFixed(2); }
        priceEl.dataset.sym = meta.symbol;
        document.title = `${meta.symbol} ${meta.current_price.toFixed(2)} · AI Trade Terminal`;

        const changeBadge = document.getElementById('price-change-badge');
        const isPos = indicators.price_change >= 0;
        const sign = isPos ? '+' : '';
        changeBadge.textContent = `${sign}${indicators.price_change_pct.toFixed(2)}%`;
        changeBadge.className = `pct-badge num-mono ${isPos ? 'positive' : 'negative'}`;

        const sentBadge = document.getElementById('sentiment-tag');
        sentBadge.textContent = indicators.sentiment;
        sentBadge.className = `sentiment-badge ${indicators.technical_score >= 55 ? 'positive' : 'negative'}`;

        const oVal = meta.open !== undefined ? meta.open : meta.current_price;
        const hVal = meta.high !== undefined ? meta.high : meta.current_price;
        const lVal = meta.low !== undefined ? meta.low : meta.current_price;
        const cVal = meta.close !== undefined ? meta.close : meta.current_price;
        const volVal = meta.volume || 0;

        updateFloatingHud({ open: oVal, high: hVal, low: lVal, close: cVal }, volVal, meta.symbol, activeTimeframe, meta.currency);
    }

    function renderIndicators(indicators) {
        const rsiVal = indicators.rsi_14 || 50;
        document.getElementById('rsi-val-readout').textContent = rsiVal.toFixed(2);
        document.getElementById('rsi-bar').style.width = `${Math.min(Math.max(rsiVal, 0), 100)}%`;
        
        const rsiTag = document.getElementById('rsi-status-tag');
        if (rsiVal <= 35) { rsiTag.textContent = 'Oversold'; rsiTag.className = 'pane-status positive'; }
        else if (rsiVal >= 70) { rsiTag.textContent = 'Overbought'; rsiTag.className = 'pane-status negative'; }
        else { rsiTag.textContent = 'Neutral'; rsiTag.className = 'pane-status neutral'; }

        document.getElementById('macd-line-val').textContent = indicators.macd_line >= 0 ? `+${indicators.macd_line.toFixed(2)}` : indicators.macd_line.toFixed(2);
        document.getElementById('macd-signal-val').textContent = indicators.macd_signal.toFixed(2);
        document.getElementById('macd-hist-val').textContent = indicators.macd_diff >= 0 ? `+${indicators.macd_diff.toFixed(2)}` : indicators.macd_diff.toFixed(2);
        
        const macdTag = document.getElementById('macd-status-tag');
        macdTag.textContent = indicators.macd_status;
        macdTag.className = `pane-status ${indicators.macd_status === 'Bullish' ? 'positive' : 'negative'}`;

        document.getElementById('bb-status-val').textContent = indicators.bb_status;
        document.getElementById('ema-cross-val').textContent = indicators.ema_crossover;
        const fmtLvl = (v) => (v !== undefined && v !== null && Number.isFinite(Number(v))) ? Number(v).toFixed(2) : 'N/A';
        document.getElementById('sr-levels-val').textContent = `S: ${fmtLvl((indicators.support_levels || [])[0])} | R: ${fmtLvl((indicators.resistance_levels || [])[0])}`;
    }

    function formatLwTime(t) {
        if (typeof t === 'number') return t;
        if (typeof t === 'string') {
            if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
            const timestamp = Date.parse(t.replace(' ', 'T'));
            if (!isNaN(timestamp)) {
                return Math.floor(timestamp / 1000);
            }
        }
        return t;
    }

    function updateFloatingHud(candle, volume, sym, tf, currency) {
        if (!candle) return;
        const hudSym = document.getElementById('hud-sym');
        const hudTf = document.getElementById('hud-tf');
        const hudOpen = document.getElementById('hud-open');
        const hudHigh = document.getElementById('hud-high');
        const hudLow = document.getElementById('hud-low');
        const hudClose = document.getElementById('hud-close');
        const hudChg = document.getElementById('hud-chg');
        const hudVol = document.getElementById('hud-vol');

        const currSym = currency === 'INR' ? '₹' : '$';
        if (hudSym && sym) hudSym.textContent = sym;
        if (hudTf && tf) hudTf.textContent = tf.toUpperCase();

        const open = candle.open !== undefined ? candle.open : (candle.value || 0);
        const high = candle.high !== undefined ? candle.high : open;
        const low = candle.low !== undefined ? candle.low : open;
        const close = candle.close !== undefined ? candle.close : (candle.value || open);

        if (hudOpen) hudOpen.textContent = `${currSym}${open.toFixed(2)}`;
        if (hudHigh) hudHigh.textContent = `${currSym}${high.toFixed(2)}`;
        if (hudLow) hudLow.textContent = `${currSym}${low.toFixed(2)}`;
        if (hudClose) {
            hudClose.textContent = `${currSym}${close.toFixed(2)}`;
            hudClose.className = `hud-val ${close >= open ? 'positive' : 'negative'}`;
        }

        const topO = document.getElementById('top-open');
        const topH = document.getElementById('top-high');
        const topL = document.getElementById('top-low');
        const topC = document.getElementById('top-close');
        if (topO) topO.textContent = `${currSym}${open.toFixed(2)}`;
        if (topH) topH.textContent = `${currSym}${high.toFixed(2)}`;
        if (topL) topL.textContent = `${currSym}${low.toFixed(2)}`;
        if (topC) {
            topC.textContent = `${currSym}${close.toFixed(2)}`;
            topC.className = `top-ohlc-val ${close >= open ? 'positive' : 'negative'}`;
        }

        if (hudChg) {
            const change = close - open;
            const changePct = open > 0 ? (change / open) * 100 : 0;
            const isUp = change >= 0;
            hudChg.textContent = `${isUp ? '+' : ''}${changePct.toFixed(2)}%`;
            hudChg.className = `hud-val ${isUp ? 'positive' : 'negative'}`;
        }

        if (hudVol) {
            if (volume !== null && volume !== undefined) {
                let volStr = '';
                if (volume >= 1000000) volStr = `${(volume / 1000000).toFixed(2)}M`;
                else if (volume >= 1000) volStr = `${(volume / 1000).toFixed(1)}K`;
                else volStr = `${volume}`;
                hudVol.textContent = volStr;
            } else {
                hudVol.textContent = '--';
            }
        }
    }

    function renderTradingViewChart(chartData, currency) {
        const container = document.getElementById('tv-chart-container');
        const fallbackCanvas = document.getElementById('fallback-chart-canvas');

        if (!container) return;
        container.style.backgroundColor = '#131922';
        if (chartResizeObserver) { chartResizeObserver.disconnect(); chartResizeObserver = null; }
        if (tvChart) { try { tvChart.remove(); } catch (e) {} tvChart = null; }
        candleSeries = lineSeries = volumeSeries = sma20Series = sma50Series = null;
        ideaPriceLines = [];
        container.innerHTML = '';

        if (!window.LightweightCharts) {
            renderFallbackCanvasChart(chartData, currency);
            return;
        }

        try {
            fallbackCanvas.classList.add('hidden');
            container.classList.remove('hidden');

            tvChart = LightweightCharts.createChart(container, {
                width: container.clientWidth || container.parentElement.clientWidth || 600,
                height: container.clientHeight || container.parentElement.clientHeight || 460,
                layout: {
                    background: { type: 'solid', color: '#131922' },
                    backgroundColor: '#131922',
                    textColor: '#8B95A1',
                    fontFamily: 'Inter, sans-serif'
                },
                grid: {
                    vertLines: { color: '#1F2733' },
                    horzLines: { color: '#1F2733' }
                },
                crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
                rightPriceScale: { borderColor: '#1F2733' },
                timeScale: { borderColor: '#1F2733', timeVisible: true }
            });

            const candleData = [];
            const volumeData = [];
            const sma20Data = [];
            const sma50Data = [];
            const lineData = [];

            const timestamps = chartData.timestamps || [];
            const prices = chartData.prices || [];
            const highs = chartData.highs || prices;
            const lows = chartData.lows || prices;
            const volumes = chartData.volumes || [];
            const sma20 = chartData.sma20 || [];
            const sma50 = chartData.sma50 || [];

            let lastTimeVal = null;

            for (let i = 0; i < timestamps.length; i++) {
                const rawTime = timestamps[i];
                const timeStr = formatLwTime(rawTime);

                if (lastTimeVal !== null && timeStr <= lastTimeVal) continue;
                lastTimeVal = timeStr;

                const close = round2(prices[i]);
                const prevClose = i > 0 ? round2(prices[i-1]) : close;
                const open = (chartData.opens && chartData.opens[i] !== undefined)
                    ? round2(chartData.opens[i])
                    : (i > 0 ? prevClose : round2(close * 0.998));
                const high = round2(Math.max(highs[i], open, close));
                const low = round2(Math.min(lows[i], open, close));

                const candleObj = { time: timeStr, open: open, high: high, low: low, close: close };
                candleData.push(candleObj);
                lineData.push({ time: timeStr, value: close });

                const isUp = close >= open;
                volumeData.push({
                    time: timeStr,
                    value: volumes[i],
                    color: isUp ? 'rgba(0, 212, 160, 0.4)' : 'rgba(255, 93, 93, 0.4)'
                });

                if (sma20[i] !== null && sma20[i] !== undefined) sma20Data.push({ time: timeStr, value: round2(sma20[i]) });
                if (sma50[i] !== null && sma50[i] !== undefined) sma50Data.push({ time: timeStr, value: round2(sma50[i]) });
            }

            if (candleData.length > 0) {
                latestCandleObj = { ...candleData[candleData.length - 1] };
            }

            if (chartType === 'candle') {
                candleSeries = tvChart.addCandlestickSeries({
                    upColor: '#00D4A0', downColor: '#FF5D5D', borderVisible: false, wickUpColor: '#00D4A0', wickDownColor: '#FF5D5D'
                });
                candleSeries.setData(candleData);

                if (indicatorConfig.patterns) {
                    const patternMarkers = detectCandlestickPatterns(chartData);
                    if (patternMarkers && patternMarkers.length > 0) {
                        candleSeries.setMarkers(patternMarkers);
                    }
                }
            } else {
                lineSeries = tvChart.addLineSeries({ color: '#5B7FFF', lineWidth: 2 });
                lineSeries.setData(lineData);
            }

            if (indicatorConfig.volume) {
                volumeSeries = tvChart.addHistogramSeries({
                    priceFormat: { type: 'volume' },
                    priceScaleId: '',
                    scaleMargins: { top: 0.8, bottom: 0 }
                });
                volumeSeries.setData(volumeData);
            }

            if (indicatorConfig.sma20 && sma20Data.length > 0) {
                sma20Series = tvChart.addLineSeries({ color: '#f59e0b', lineWidth: 1.5, lineStyle: LightweightCharts.LineStyle.Dotted });
                sma20Series.setData(sma20Data);
            }

            if (indicatorConfig.sma50 && sma50Data.length > 0) {
                sma50Series = tvChart.addLineSeries({ color: '#06b6d4', lineWidth: 1.5, lineStyle: LightweightCharts.LineStyle.Dashed });
                sma50Series.setData(sma50Data);
            }

            tvChart.timeScale().fitContent();

            const lastVol = volumes.length > 0 ? volumes[volumes.length - 1] : 0;
            updateFloatingHud(latestCandleObj, lastVol, currentAnalysisData ? currentAnalysisData.metadata.symbol : 'AAPL', activeTimeframe, currency);

            tvChart.subscribeCrosshairMove((param) => {
                if (!param || !param.point || !param.time) {
                    const lastVol = volumes.length > 0 ? volumes[volumes.length - 1] : 0;
                    updateFloatingHud(latestCandleObj, lastVol, currentAnalysisData ? currentAnalysisData.metadata.symbol : 'AAPL', activeTimeframe, currency);
                    return;
                }

                let candle = null;
                if (param.seriesData) {
                    if (typeof param.seriesData.get === 'function') {
                        candle = (chartType === 'candle' && candleSeries) ? param.seriesData.get(candleSeries) : (lineSeries ? param.seriesData.get(lineSeries) : null);
                    } else if (typeof param.seriesData === 'object') {
                        candle = (chartType === 'candle' && candleSeries) ? param.seriesData[candleSeries] : (lineSeries ? param.seriesData[lineSeries] : null);
                    }
                }

                let vol = null;
                if (volumeSeries && param.seriesData) {
                    const volData = typeof param.seriesData.get === 'function' ? param.seriesData.get(volumeSeries) : param.seriesData[volumeSeries];
                    if (volData) vol = volData.value;
                }

                if (candle) {
                    updateFloatingHud(candle, vol, currentAnalysisData ? currentAnalysisData.metadata.symbol : 'AAPL', activeTimeframe, currency);
                } else {
                    const lastVol = volumes.length > 0 ? volumes[volumes.length - 1] : 0;
                    updateFloatingHud(latestCandleObj, lastVol, currentAnalysisData ? currentAnalysisData.metadata.symbol : 'AAPL', activeTimeframe, currency);
                }
            });

            container.onmouseleave = () => {
                const lastVol = volumes.length > 0 ? volumes[volumes.length - 1] : 0;
                updateFloatingHud(latestCandleObj, lastVol, currentAnalysisData ? currentAnalysisData.metadata.symbol : 'AAPL', activeTimeframe, currency);
            };

            const resizeChartContainer = () => {
                if (tvChart && container) {
                    const w = container.clientWidth || container.parentElement.clientWidth || 600;
                    const h = container.clientHeight || container.parentElement.clientHeight || 460;
                    tvChart.applyOptions({ width: w, height: h });
                }
            };

            if (window.ResizeObserver && container.parentElement) {
                chartResizeObserver = new ResizeObserver(resizeChartContainer);
                chartResizeObserver.observe(container.parentElement);
            } else {
                window.onresize = resizeChartContainer;
            }

            applyIdeaLines();

        } catch (err) {
            console.error("TradingView Chart initialization error, falling back to Canvas:", err);
            renderFallbackCanvasChart(chartData, currency);
        }
    }

    function renderFallbackCanvasChart(chartData, currency) {
        const container = document.getElementById('tv-chart-container');
        const canvas = document.getElementById('fallback-chart-canvas');

        if (!canvas) return;
        if (container) container.classList.add('hidden');
        canvas.classList.remove('hidden');

        const ctx = canvas.getContext('2d');
        const rect = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : { width: 600, height: 380 };
        canvas.width = rect.width || 600;
        canvas.height = rect.height || 380;

        const w = canvas.width;
        const h = canvas.height;
        const paddingRight = 70;
        const paddingBottom = 25;
        const chartW = w - paddingRight;
        const chartH = h - paddingBottom;

        ctx.fillStyle = '#131922';
        ctx.fillRect(0, 0, w, h);

        const prices = chartData.prices || [];
        const highs = chartData.highs || prices;
        const lows = chartData.lows || prices;
        const timestamps = chartData.timestamps || [];
        const sma20 = chartData.sma20 || [];
        const sma50 = chartData.sma50 || [];
        const volumes = chartData.volumes || [];

        if (prices.length === 0) return;

        let minPrice = Math.min(...lows);
        let maxPrice = Math.max(...highs);
        if (minPrice === maxPrice) { minPrice *= 0.95; maxPrice *= 1.05; }
        const priceRange = maxPrice - minPrice;

        ctx.strokeStyle = '#1F2733';
        ctx.lineWidth = 1;
        ctx.fillStyle = '#8B95A1';
        ctx.font = '11px "JetBrains Mono", monospace';

        const gridSteps = 5;
        for (let i = 0; i <= gridSteps; i++) {
            const y = (chartH / gridSteps) * i;
            const priceVal = maxPrice - (priceRange / gridSteps) * i;

            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(chartW, y);
            ctx.stroke();

            const currencySym = currency === 'INR' ? '₹' : '$';
            ctx.fillText(`${currencySym}${priceVal.toFixed(2)}`, chartW + 6, y + 4);
        }

        const dateSteps = Math.min(6, timestamps.length);
        const stepIdx = Math.floor(timestamps.length / dateSteps);
        for (let i = 0; i < dateSteps; i++) {
            const idx = Math.min(i * stepIdx, timestamps.length - 1);
            const x = (idx / Math.max(1, timestamps.length - 1)) * chartW;

            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, chartH);
            ctx.stroke();

            const dateLabel = String(timestamps[idx]).slice(5, 10);
            ctx.fillText(dateLabel, Math.max(0, x - 12), chartH + 16);
        }

        const barWidth = Math.max(3, (chartW / prices.length) * 0.65);
        const maxVol = Math.max(...volumes, 1);

        for (let i = 0; i < prices.length; i++) {
            const x = (i / Math.max(1, prices.length - 1)) * chartW;
            const close = prices[i];
            const prevClose = i > 0 ? prices[i-1] : close;
            const open = (chartData.opens && chartData.opens[i] !== undefined) ? chartData.opens[i] : (i > 0 ? prevClose : close * 0.998);
            const high = highs[i] || Math.max(open, close);
            const low = lows[i] || Math.min(open, close);

            const isUp = close >= open;
            const candleColor = isUp ? '#00D4A0' : '#FF5D5D';

            if (indicatorConfig.volume) {
                const volH = (volumes[i] / maxVol) * (chartH * 0.22);
                ctx.fillStyle = isUp ? 'rgba(0, 212, 160, 0.25)' : 'rgba(255, 93, 93, 0.25)';
                ctx.fillRect(x - barWidth / 2, chartH - volH, barWidth, volH);
            }

            if (chartType === 'candle') {
                const yHigh = chartH - ((high - minPrice) / priceRange) * chartH;
                const yLow = chartH - ((low - minPrice) / priceRange) * chartH;

                ctx.strokeStyle = candleColor;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(x, yHigh);
                ctx.lineTo(x, yLow);
                ctx.stroke();

                const yOpen = chartH - ((open - minPrice) / priceRange) * chartH;
                const yClose = chartH - ((close - minPrice) / priceRange) * chartH;
                const bodyY = Math.min(yOpen, yClose);
                const bodyH = Math.max(2, Math.abs(yClose - yOpen));

                ctx.fillStyle = candleColor;
                ctx.fillRect(x - barWidth / 2, bodyY, barWidth, bodyH);
            }
        }

        if (chartType === 'line') {
            ctx.strokeStyle = '#5B7FFF';
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let i = 0; i < prices.length; i++) {
                const x = (i / Math.max(1, prices.length - 1)) * chartW;
                const y = chartH - ((prices[i] - minPrice) / priceRange) * chartH;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }

        if (indicatorConfig.sma20 && sma20.length > 0) {
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            let started = false;
            for (let i = 0; i < sma20.length; i++) {
                if (sma20[i] !== null && sma20[i] !== undefined) {
                    const x = (i / Math.max(1, prices.length - 1)) * chartW;
                    const y = chartH - ((sma20[i] - minPrice) / priceRange) * chartH;
                    if (!started) { ctx.moveTo(x, y); started = true; }
                    else ctx.lineTo(x, y);
                }
            }
            ctx.stroke();
            ctx.setLineDash([]);
        }

        if (indicatorConfig.sma50 && sma50.length > 0) {
            ctx.strokeStyle = '#06b6d4';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            let started = false;
            for (let i = 0; i < sma50.length; i++) {
                if (sma50[i] !== null && sma50[i] !== undefined) {
                    const x = (i / Math.max(1, prices.length - 1)) * chartW;
                    const y = chartH - ((sma50[i] - minPrice) / priceRange) * chartH;
                    if (!started) { ctx.moveTo(x, y); started = true; }
                    else ctx.lineTo(x, y);
                }
            }
            ctx.stroke();
            ctx.setLineDash([]);
        }

        const lastVol = volumes.length > 0 ? volumes[volumes.length - 1] : 0;
        if (prices.length > 0) {
            const lastClose = prices[prices.length - 1];
            const lastOpen = (chartData.opens && chartData.opens.length > 0) ? chartData.opens[chartData.opens.length - 1] : lastClose;
            const lastHigh = highs.length > 0 ? highs[highs.length - 1] : lastClose;
            const lastLow = lows.length > 0 ? lows[lows.length - 1] : lastClose;
            updateFloatingHud({ open: lastOpen, high: lastHigh, low: lastLow, close: lastClose }, lastVol, currentAnalysisData ? currentAnalysisData.metadata.symbol : 'AAPL', activeTimeframe, currency);
        }

        canvas.onmousemove = (e) => {
            const rect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const idx = Math.min(Math.max(0, Math.floor((mouseX / chartW) * prices.length)), prices.length - 1);
            if (idx >= 0 && idx < prices.length) {
                const c = prices[idx];
                const o = (chartData.opens && chartData.opens[idx] !== undefined) ? chartData.opens[idx] : (idx > 0 ? prices[idx - 1] : c * 0.998);
                const h = highs[idx] || Math.max(o, c);
                const l = lows[idx] || Math.min(o, c);
                const v = volumes[idx] || 0;
                updateFloatingHud({ open: o, high: h, low: l, close: c }, v, currentAnalysisData ? currentAnalysisData.metadata.symbol : 'AAPL', activeTimeframe, currency);
            }
        };

        canvas.onmouseleave = () => {
            if (latestCandleObj) {
                const lastVol = volumes.length > 0 ? volumes[volumes.length - 1] : 0;
                updateFloatingHud(latestCandleObj, lastVol, currentAnalysisData ? currentAnalysisData.metadata.symbol : 'AAPL', activeTimeframe, currency);
            }
        };
    }

    function mainSeries() { return chartType === 'candle' ? candleSeries : lineSeries; }

    function ideaNumbers(idea) {
        const entry = parseFloat(idea.entry_price) || latestRealPrice || 1;
        const stop = parseFloat(idea.stop_loss) || (entry * 0.95);
        const target = parseFloat(idea.target_price) || (entry * 1.05);
        const risk = Math.abs(entry - stop) || (entry * 0.02);
        const reward = Math.abs(target - entry);
        return { entry, stop, target, risk, reward, long: target >= entry, rr: reward / risk };
    }

    function clearIdeaLines() {
        const s = mainSeries();
        ideaPriceLines.forEach(l => { try { if (s) s.removePriceLine(l); } catch (e) {} });
        ideaPriceLines = [];
    }

    function applyIdeaLines() {
        clearIdeaLines();
        if (activeIdeaIdx == null) return;
        const idea = currentIdeas[activeIdeaIdx];
        const s = mainSeries();
        if (!idea || !s || !window.LightweightCharts) return;
        const n = ideaNumbers(idea);
        const LS = LightweightCharts.LineStyle;
        [['Entry', n.entry, '#5B7FFF', LS.Solid], ['Target', n.target, '#00D4A0', LS.Dashed], ['Stop', n.stop, '#FF5D5D', LS.Dashed]]
            .forEach(([title, price, color, lineStyle]) => {
                ideaPriceLines.push(s.createPriceLine({ price, color, lineWidth: 1, lineStyle, axisLabelVisible: true, title }));
            });
    }

    function plotIdea(idx) {
        activeIdeaIdx = activeIdeaIdx === idx ? null : idx;
        applyIdeaLines();
        document.querySelectorAll('#trade-ideas-list .trade-idea-card').forEach((card, i) => {
            const on = i === activeIdeaIdx;
            card.classList.toggle('plotted', on);
            const b = card.querySelector('[data-act="plot"]');
            if (b) { b.classList.toggle('on', on); b.textContent = on ? '✓ On chart' : '📍 Plot on chart'; }
        });
        if (activeIdeaIdx != null && isMobile()) setMobileTab('chart');
    }

    function renderTradeIdeas(aiAnalysis, currency, apiKeyConfigured, opts = {}) {
        const container = document.getElementById('trade-ideas-list');
        const apiWarning = document.getElementById('api-warning-bar');
        const recalc = !!opts.recalc;

        container.innerHTML = '';
        
        // Clean production badge display
        if (apiWarning) {
            const isQuant = !apiKeyConfigured || (aiAnalysis && aiAnalysis.source === 'quant-fallback');
            apiWarning.classList.remove('hidden');
            const msg = apiWarning.querySelector('span');
            if (msg) {
                if (isQuant) {
                    msg.innerHTML = `⚡ <b>Algorithmic Engine Active</b> — Generating rule-based quantitative trade setups`;
                } else {
                    msg.innerHTML = `🤖 <b>Claude AI Enhanced</b> — Real-time institutional narrative setups`;
                }
            }
        }

        if (!recalc) {
            activeIdeaIdx = null;
            clearIdeaLines();
            const updateTimeElem = document.getElementById('ideas-updated-time');
            const timelineTagElem = document.getElementById('ideas-timeline-tag');
            if (updateTimeElem) {
                updateTimeElem.textContent = `Updated: ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
            }
            if (timelineTagElem) timelineTagElem.textContent = `⏱ Live ${activeTimeframe.toUpperCase()} Setups`;
        }

        const ideas = (aiAnalysis && aiAnalysis.trade_ideas) || [];
        currentIdeas = ideas;
        const currencySym = currency === 'INR' ? '₹' : '$';

        if (ideas.length === 0) {
            container.innerHTML = '<div style="padding: 12px; color: var(--text-secondary);">No trade ideas generated.</div>';
            return;
        }

        const capital = parseFloat(accountCapitalInput.value) || 10000;
        const riskPct = parseFloat(riskPercentInput.value) || 2;
        const maxRiskAmount = (capital * riskPct) / 100;
        const symbol = currentAnalysisData ? currentAnalysisData.metadata.symbol : '';

        ideas.forEach((idea, idx) => {
            const card = document.createElement('div');
            card.className = 'trade-idea-card' + (recalc ? ' no-anim' : '') + (idx === activeIdeaIdx ? ' plotted' : '');
            card.style.setProperty('--i', idx);

            const n = ideaNumbers(idea);
            const units = Math.floor(maxRiskAmount / n.risk);
            const riskPctPrice = (n.risk / n.entry) * 100;
            const rewardPctPrice = (n.reward / n.entry) * 100;
            const reasoning = idea.reasoning || '';
            const isPlotted = idx === activeIdeaIdx;

            card.innerHTML = `
                <div class="card-timeline-row">
                    <span class="card-tf-badge">${escapeHtml(idea.timeframe || `TIMEFRAME: ${activeTimeframe.toUpperCase()}`)}</span>
                    <span class="card-status-badge">⚡ Fresh Entry Setup</span>
                </div>
                <div class="card-top">
                    <span class="setup-name"><span class="dir-tag ${n.long ? 'long' : 'short'}">${n.long ? 'LONG' : 'SHORT'}</span>${escapeHtml(idea.setup_type || 'Trade Setup')}</span>
                    <span class="rr-tag num-mono">R:R ${escapeHtml(idea.risk_reward_ratio || '1:' + n.rr.toFixed(1))}</span>
                </div>

                <div class="card-metrics-grid num-mono">
                    <div class="cm-box"><span class="cm-lbl">Entry</span><span class="cm-val val-entry">${currencySym}${n.entry.toFixed(2)}</span></div>
                    <div class="cm-box"><span class="cm-lbl">Target</span><span class="cm-val val-target">${currencySym}${n.target.toFixed(2)}</span></div>
                    <div class="cm-box"><span class="cm-lbl">Stop Loss</span><span class="cm-val val-stop">${currencySym}${n.stop.toFixed(2)}</span></div>
                </div>

                <div class="rr-visual" title="Risk vs reward, from entry">
                    <div class="rr-bar"><div class="rr-risk" style="flex-grow:${n.risk}"></div><div class="rr-reward" style="flex-grow:${n.reward}"></div></div>
                    <div class="rr-caption"><span>-${riskPctPrice.toFixed(1)}% risk</span><span>+${rewardPctPrice.toFixed(1)}% reward</span></div>
                </div>

                <div class="reasoning-text clamped">${escapeHtml(reasoning)}</div>
                <div class="card-sizing"><span>Size <b>${units.toLocaleString()}</b> units</span><span>Risk <b>${currencySym}${maxRiskAmount.toFixed(2)}</b></span></div>
                <div class="card-actions">
                    <button class="card-btn ${isPlotted ? 'on' : ''}" data-act="plot" type="button">${isPlotted ? '✓ On chart' : '📍 Plot on chart'}</button>
                    <button class="card-btn" data-act="copy" type="button">⧉ Copy plan</button>
                    ${reasoning.length > 140 ? '<button class="card-btn" data-act="more" type="button">More</button>' : ''}
                </div>
            `;

            card.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-act]');
                if (!btn) return;
                const act = btn.getAttribute('data-act');
                if (act === 'plot') plotIdea(idx);
                else if (act === 'more') {
                    const t = card.querySelector('.reasoning-text');
                    const collapsed = t.classList.toggle('clamped');
                    btn.textContent = collapsed ? 'More' : 'Less';
                } else if (act === 'copy') {
                    const text = `${symbol} ${n.long ? 'LONG' : 'SHORT'} · ${idea.setup_type || 'Trade Setup'}\nEntry ${currencySym}${n.entry.toFixed(2)} | Target ${currencySym}${n.target.toFixed(2)} | Stop ${currencySym}${n.stop.toFixed(2)} | R:R 1:${n.rr.toFixed(2)}\nSize ${units} units (risking ${currencySym}${maxRiskAmount.toFixed(2)})`;
                    const done = () => UIK.toast('Trade plan copied', { type: 'success' });
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(text).then(done, () => UIK.toast('Clipboard blocked by browser', { type: 'warn' }));
                    } else {
                        UIK.toast('Clipboard not available in this context', { type: 'warn' });
                    }
                }
            });

            container.appendChild(card);
        });

        const n0 = ideaNumbers(ideas[activeIdeaIdx != null ? activeIdeaIdx : 0]);
        const units0 = Math.floor(maxRiskAmount / n0.risk);
        document.getElementById('calc-qty-out').textContent = `${units0.toLocaleString()} units`;
        document.getElementById('calc-profit-out').textContent = `+${currencySym}${(units0 * n0.reward).toFixed(2)}`;
    }

    async function refreshTradeIdeasOnly() {
        const btn = document.getElementById('btn-refresh-ideas');
        const symbol = (currentAnalysisData && currentAnalysisData.metadata ? currentAnalysisData.metadata.symbol : document.getElementById('symbol-badge').textContent) || 'AAPL';
        const market = (currentAnalysisData && currentAnalysisData.metadata ? currentAnalysisData.metadata.market : 'AUTO') || 'AUTO';

        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<span class="refresh-icon spinning">🔄</span> <span class="refresh-label">Refreshing...</span>`;
        }

        try {
            const res = await fetch(`${CONFIG.API_BASE_URL}/analyze?ticker=${encodeURIComponent(symbol)}&market=${encodeURIComponent(market)}&interval=${encodeURIComponent(activeTimeframe)}`);
            if (res.ok) {
                const data = await res.json();
                if (data.success && data.ai_analysis) {
                    currentAnalysisData = data;
                    latestRealPrice = data.metadata.current_price;

                    renderHeader(data.metadata, data.indicators);
                    updateCalculatorDisplay();
                    renderIndicators(data.indicators);
                    renderTradeIdeas(data.ai_analysis, data.metadata.currency, data.api_key_configured);
                }
            }
            else UIK.toast('Could not refresh trade ideas', { type: 'error' });
        } catch (err) {
            console.error("Refresh trade ideas error:", err);
            UIK.toast('Could not refresh trade ideas', { type: 'error' });
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<span class="refresh-icon">🔄</span> <span class="refresh-label">Refresh</span>`;
            }
        }
    }

    function round2(num) { return Math.round(Number(num) * 100) / 100; }
    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    // =========================================================================
    // DYNAMIC TRADING TERMINAL ENGINES
    // =========================================================================

    // 1. Live Ticker Tape (real prices from /quotes)
    const marqueeTapeData = [
        { symbol: '^GSPC', name: 'S&P 500', price: null, change: null },
        { symbol: '^IXIC', name: 'NASDAQ', price: null, change: null },
        { symbol: '^NSEI', name: 'NIFTY 50', price: null, change: null },
        { symbol: '^BSESN', name: 'SENSEX', price: null, change: null },
        { symbol: 'GC=F', name: 'GOLD', price: null, change: null },
        { symbol: 'CL=F', name: 'CRUDE OIL', price: null, change: null },
        { symbol: 'BTC-USD', name: 'BITCOIN', price: null, change: null },
        { symbol: 'ETH-USD', name: 'ETHEREUM', price: null, change: null },
        { symbol: 'NVDA', name: 'NVDA', price: null, change: null },
        { symbol: 'AAPL', name: 'AAPL', price: null, change: null },
        { symbol: 'RELIANCE.NS', name: 'RELIANCE', price: null, change: null },
        { symbol: 'USDINR=X', name: 'USD/INR', price: null, change: null }
    ];

    function paintTapeItem(el, item, flash) {
        const hasQuote = item.price != null && item.change != null;
        const isPos = hasQuote && item.change >= 0;
        const priceEl = el.querySelector('.tape-price');
        const pctEl = el.querySelector('.tape-pct');
        if (priceEl) priceEl.textContent = item.price != null ? formatPrice(item.price) : '--';
        if (pctEl) {
            pctEl.textContent = hasQuote ? `${isPos ? '+' : ''}${item.change.toFixed(2)}%` : '--';
            pctEl.className = `tape-pct ${hasQuote ? (isPos ? 'positive' : 'negative') : ''}`;
        }
        if (flash) {
            el.classList.add(flash > 0 ? 'tick-up' : 'tick-down');
            setTimeout(() => el.classList.remove('tick-up', 'tick-down'), 400);
        }
    }

    function initMarqueeTickerTape() {
        const tapeTrack = document.getElementById('tape-track');
        if (!tapeTrack) return;

        let html = '';
        for (let copy = 0; copy < 2; copy++) {
            marqueeTapeData.forEach((item, idx) => {
                html += `
                    <div class="tape-item" data-sym="${escapeHtml(item.symbol)}" id="tape-item-${copy}-${idx}" title="Click to view ${escapeHtml(item.name)}">
                        <span class="tape-sym">${escapeHtml(item.name)}</span>
                        <span class="tape-price">--</span>
                        <span class="tape-pct">--</span>
                    </div>
                `;
            });
        }
        tapeTrack.innerHTML = html;

        tapeTrack.querySelectorAll('.tape-item').forEach(itemElem => {
            itemElem.addEventListener('click', () => {
                const sym = itemElem.getAttribute('data-sym');
                if (sym) triggerAnalysis(sym, 'AUTO', activeTimeframe);
            });
        });
    }

    let quotesInFlight = false;
    async function refreshQuotes() {
        if (quotesInFlight) return;
        const symbols = [...new Set([
            ...marqueeTapeData.map(i => i.symbol),
            ...watchlistItems.map(i => i.symbol)
        ])];
        const chunks = [];
        for (let i = 0; i < symbols.length; i += 30) chunks.push(symbols.slice(i, i + 30));

        quotesInFlight = true;
        try {
            const results = await Promise.all(chunks.map(async chunk => {
                const res = await fetch(`${CONFIG.API_BASE_URL}/quotes?tickers=${encodeURIComponent(chunk.join(','))}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return (await res.json()).quotes || [];
            }));
            const bySymbol = {};
            results.flat().forEach(q => { if (q && q.ok) bySymbol[q.symbol.toUpperCase()] = q; });

            marqueeTapeData.forEach((item, idx) => {
                const q = bySymbol[item.symbol.toUpperCase()];
                if (!q) return;
                const dir = item.price != null ? Math.sign(q.price - item.price) : 0;
                item.price = q.price;
                item.change = q.change_pct;
                for (let copy = 0; copy < 2; copy++) {
                    const el = document.getElementById(`tape-item-${copy}-${idx}`);
                    if (el) paintTapeItem(el, item, dir);
                }
            });
            watchlistItems.forEach(item => {
                const q = bySymbol[item.symbol.toUpperCase()];
                if (!q) return;
                item.flash = item.price != null ? Math.sign(q.price - item.price) : 0;
                item.price = q.price;
                item.change = q.change_pct;
            });
            renderWatchlist();
        } catch (err) {
            console.warn('Quote refresh failed:', err);
        } finally {
            quotesInFlight = false;
        }
    }

    // 2. Real-Time Candle Close Countdown Timer Engine
    let updateCountdownTimerFn = null;

    function initCandleCountdownTimer() {
        const timerElem = document.getElementById('candle-countdown-timer');

        updateCountdownTimerFn = function() {
            if (!timerElem) return;
            const now = new Date();
            let secondsLeft = 0;

            const assetClass = currentAnalysisData && currentAnalysisData.metadata ? currentAnalysisData.metadata.asset_class : null;
            if ((activeTimeframe === '1d' || activeTimeframe === '1wk') && assetClass !== 'CRYPTO') {
                timerElem.textContent = '⏱ --';
                return;
            }

            if (activeTimeframe === '1m') {
                secondsLeft = 60 - (now.getSeconds() % 60);
            } else if (activeTimeframe === '5m') {
                secondsLeft = 300 - ((now.getMinutes() % 5) * 60 + now.getSeconds());
            } else if (activeTimeframe === '15m') {
                secondsLeft = 900 - ((now.getMinutes() % 15) * 60 + now.getSeconds());
            } else if (activeTimeframe === '1h') {
                secondsLeft = 3600 - (now.getMinutes() * 60 + now.getSeconds());
            } else if (activeTimeframe === '1d') {
                secondsLeft = 86400 - (now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds());
            } else if (activeTimeframe === '1wk') {
                const daysLeft = (7 - now.getUTCDay()) % 7;
                secondsLeft = (daysLeft * 86400) + (86400 - (now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds()));
            }

            if (secondsLeft < 0) secondsLeft = 0;

            if (activeTimeframe === '1d' || activeTimeframe === '1wk') {
                const hours = Math.floor(secondsLeft / 3600);
                const mins = Math.floor((secondsLeft % 3600) / 60);
                timerElem.textContent = `⏱ ${String(hours).padStart(2, '0')}h ${String(mins).padStart(2, '0')}m`;
            } else {
                const mins = Math.floor(secondsLeft / 60);
                const secs = secondsLeft % 60;
                timerElem.textContent = `⏱ ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
            }
        };

        updateCountdownTimerFn();
        setInterval(updateCountdownTimerFn, 1000);
    }

    // Initialize Dynamic Terminal Features
    initMarqueeTickerTape();
    initCandleCountdownTimer();
    renderWatchlist();
    refreshQuotes();
    setInterval(() => { if (!document.hidden) refreshQuotes(); }, 15000);

    // Header clock & session status
    const clockEl = document.getElementById('clock-readout');
    const pillsEl = document.getElementById('session-pills');
    let lastPills = '';
    function tickClock() {
        if (clockEl) clockEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        if (pillsEl) {
            const html = UIK.sessionStatus().map(s =>
                `<span class="session-pill ${s.open ? 'open' : ''}" title="${s.name} ${s.open ? 'open' : 'closed'} (regular hours; holidays not modelled)"><span class="sp-dot"></span>${s.name}</span>`
            ).join('');
            if (html !== lastPills) { pillsEl.innerHTML = html; lastPills = html; }
        }
    }
    tickClock();
    setInterval(tickClock, 1000);

    // Mobile tabs
    const bodyEl = document.querySelector('.terminal-body');
    function setMobileTab(tab) {
        if (bodyEl) bodyEl.setAttribute('data-mobile-tab', tab);
        document.querySelectorAll('.mobile-tab').forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === tab));
    }
    document.querySelectorAll('.mobile-tab').forEach(b => b.addEventListener('click', () => setMobileTab(b.getAttribute('data-tab'))));
    setMobileTab('chart');

    // Splitter resizers
    UIK.initSplitters(bodyEl);

    // Command palette & keyboard shortcuts
    UIK.onAnalyze = (sym) => triggerAnalysis(sym, 'AUTO', activeTimeframe);
    const IND_LABELS = { sma20: 'SMA 20', sma50: 'SMA 50', patterns: 'Candlestick patterns', rsi: 'RSI panel', macd: 'MACD panel', orderbook: 'Order book', quant: 'Quant matrix', backtest: 'Backtest panel', news: 'News feed' };
    UIK.palette.setProvider(() => {
        const items = [];
        watchlistItems.forEach(w => items.push({
            group: 'Symbol', label: w.symbol,
            hint: w.change != null ? `${w.change >= 0 ? '+' : ''}${w.change.toFixed(2)}%` : '',
            run: () => triggerAnalysis(w.symbol, w.market || 'AUTO', activeTimeframe)
        }));
        [['1m', '1 minute'], ['5m', '5 minutes'], ['15m', '15 minutes'], ['1h', '1 hour'], ['1d', '1 day'], ['1wk', '1 week']].forEach(([tf, name], i) =>
            items.push({ group: 'Timeframe', label: `Timeframe: ${name}`, hint: String(i + 1), keywords: tf, run: () => setTimeframe(tf) }));
        items.push({ group: 'Chart', label: 'Chart: Candles', hint: 'C', run: () => setChartType('candle') });
        items.push({ group: 'Chart', label: 'Chart: Line', hint: 'C', run: () => setChartType('line') });
        Object.keys(IND_LABELS).forEach(k => items.push({
            group: 'Indicator', label: `${indicatorConfig[k] ? 'Hide' : 'Show'} ${IND_LABELS[k]}`,
            run: () => setIndicatorState(k, !indicatorConfig[k])
        }));
        items.push({ group: 'Action', label: 'Refresh AI trade ideas', hint: 'R', run: () => refreshTradeIdeasOnly() });
        items.push({ group: 'Action', label: 'Toggle position calculator', run: () => drawerHeader && drawerHeader.click() });
        items.push({ group: 'Action', label: 'Keyboard shortcuts', hint: '?', run: () => UIK.showShortcuts() });
        return items;
    });
    document.getElementById('btn-palette').addEventListener('click', () => UIK.palette.open());
    document.getElementById('btn-help').addEventListener('click', () => UIK.showShortcuts());

    document.addEventListener('keydown', (e) => {
        const tag = (e.target.tagName || '').toLowerCase();
        const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            UIK.palette.isOpen() ? UIK.palette.close() : UIK.palette.open();
            return;
        }
        if (e.key === 'Escape') {
            UIK.palette.close();
            UIK.closeShortcuts();
            if (indicatorDropdownMenu) indicatorDropdownMenu.classList.add('hidden');
            searchDropdown.classList.add('hidden');
            return;
        }
        if (typing || e.ctrlKey || e.metaKey || e.altKey || UIK.palette.isOpen()) return;

        if (e.key === '/') { e.preventDefault(); tickerInput.focus(); tickerInput.select(); }
        else if (e.key === '?') { UIK.showShortcuts(); }
        else if (/^[1-6]$/.test(e.key)) { setTimeframe(VALID_TF[Number(e.key) - 1]); }
        else if (e.key.toLowerCase() === 'c') { setChartType(chartType === 'candle' ? 'line' : 'candle'); }
        else if (e.key.toLowerCase() === 'r') { refreshTradeIdeasOnly(); }
        else if (e.key.toLowerCase() === 'i') { e.preventDefault(); if (btnIndicatorDropdown) btnIndicatorDropdown.click(); }
        else if (e.key === '[' || e.key === ']') {
            const list = visibleWatchlist();
            if (!list.length) return;
            const cur = (document.getElementById('symbol-badge').textContent || '').toUpperCase();
            const at = list.findIndex(i => i.symbol.toUpperCase() === cur);
            const next = list[(at + (e.key === ']' ? 1 : -1) + list.length) % list.length];
            triggerAnalysis(next.symbol, next.market || 'AUTO', activeTimeframe);
        }
    });

    // Initial load
    const startSymbol = UIK.store.get('symbol', 'AAPL');
    const startItem = watchlistItems.find(i => i.symbol.toUpperCase() === String(startSymbol).toUpperCase());
    triggerAnalysis(startSymbol, startItem ? (startItem.market || 'AUTO') : 'AUTO', activeTimeframe);
});
