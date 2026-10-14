// UI toolkit: self-contained helpers used by app.js (toasts, storage, tweening,
// command palette, resizable panels, equity curve renderer, shortcut help).
(function () {
    'use strict';

    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---- Safe persistent storage (private mode / blocked storage must not break the app)
    const store = {
        get(key, fallback) {
            try {
                const raw = localStorage.getItem('ati:' + key);
                return raw === null ? fallback : JSON.parse(raw);
            } catch (e) { return fallback; }
        },
        set(key, value) {
            try { localStorage.setItem('ati:' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
        }
    };

    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

    // ---- Toasts
    function toast(message, opts = {}) {
        const stack = document.getElementById('toast-stack');
        if (!stack) return;
        const type = opts.type || 'info';
        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.setAttribute('role', type === 'error' ? 'alert' : 'status');
        const icon = { info: 'ℹ', success: '✓', error: '⚠', warn: '!' }[type] || 'ℹ';
        el.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${esc(message)}</span>`;
        if (opts.action) {
            const btn = document.createElement('button');
            btn.className = 'toast-action';
            btn.type = 'button';
            btn.textContent = opts.action.label;
            btn.addEventListener('click', () => { opts.action.onClick(); dismiss(); });
            el.appendChild(btn);
        }
        stack.appendChild(el);
        while (stack.children.length > 4) stack.removeChild(stack.firstChild);
        let timer = setTimeout(dismiss, opts.ms || (type === 'error' ? 6000 : 3200));
        function dismiss() {
            clearTimeout(timer);
            el.classList.add('leaving');
            setTimeout(() => el.remove(), 220);
        }
        el.addEventListener('click', dismiss);
        return dismiss;
    }

    // ---- Number tween (count-up/down)
    function tween(el, from, to, format, ms = 450) {
        if (!el) return;
        if (reduceMotion || !isFinite(from) || !isFinite(to) || from === to) { el.textContent = format(to); return; }
        const start = performance.now();
        const token = (el._tweenToken = (el._tweenToken || 0) + 1);
        function frame(now) {
            if (el._tweenToken !== token) return;
            const t = Math.min(1, (now - start) / ms);
            const eased = 1 - Math.pow(1 - t, 3);
            el.textContent = format(from + (to - from) * eased);
            if (t < 1) requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
    }

    // ---- Command palette
    const palette = (function () {
        let root, input, list, items = [], filtered = [], index = 0, provider = () => [];

        function build() {
            root = document.createElement('div');
            root.id = 'cmd-palette';
            root.className = 'cmd-overlay hidden';
            root.innerHTML = `
                <div class="cmd-box" role="dialog" aria-modal="true" aria-label="Command palette">
                    <input class="cmd-input" type="text" placeholder="Type a ticker, command or setting…" autocomplete="off" spellcheck="false">
                    <div class="cmd-list" role="listbox"></div>
                    <div class="cmd-foot"><span>↑↓ navigate</span><span>↵ run</span><span>esc close</span></div>
                </div>`;
            document.body.appendChild(root);
            input = root.querySelector('.cmd-input');
            list = root.querySelector('.cmd-list');
            root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
            input.addEventListener('input', () => { index = 0; filter(); });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
                else if (e.key === 'Enter') { e.preventDefault(); run(filtered[index]); }
                else if (e.key === 'Escape') { e.preventDefault(); close(); }
            });
        }

        function score(query, text) {
            if (!query) return 1;
            const q = query.toLowerCase(), t = text.toLowerCase();
            const at = t.indexOf(q);
            if (at === 0) return 100;
            if (at > 0) return 60 - at;
            let qi = 0, s = 0;
            for (let i = 0; i < t.length && qi < q.length; i++) if (t[i] === q[qi]) { qi++; s++; }
            return qi === q.length ? s : 0;
        }

        function filter() {
            const q = input.value.trim();
            const scored = items
                .map(it => ({ it, s: score(q, it.label + ' ' + (it.keywords || '')) }))
                .filter(x => x.s > 0)
                .sort((a, b) => b.s - a.s)
                .slice(0, 12);
            filtered = scored.map(x => x.it);
            if (q && /^[\^A-Za-z0-9.=\-]{1,15}$/.test(q)) {
                const up = q.toUpperCase();
                const exact = filtered.some(it => it.label.toUpperCase() === up);
                if (!exact) {
                    const analyze = { label: `Analyze "${up}"`, group: 'Symbol', hint: 'Load any ticker', run: () => window.UI.onAnalyze && window.UI.onAnalyze(up) };
                    // Only a strong prefix/substring match outranks "analyze this ticker"; loose fuzzy hits must not hijack Enter.
                    const strong = scored.length && scored[0].s >= 40;
                    if (strong) filtered.push(analyze); else filtered.unshift(analyze);
                }
            }
            render();
        }

        function render() {
            if (!filtered.length) { list.innerHTML = '<div class="cmd-empty">No matches</div>'; return; }
            list.innerHTML = filtered.map((it, i) => `
                <div class="cmd-item ${i === index ? 'active' : ''}" role="option" data-i="${i}">
                    <span class="cmd-group">${esc(it.group || '')}</span>
                    <span class="cmd-label">${esc(it.label)}</span>
                    <span class="cmd-hint">${esc(it.hint || '')}</span>
                </div>`).join('');
            list.querySelectorAll('.cmd-item').forEach(node => {
                node.addEventListener('mousemove', () => { index = +node.dataset.i; highlight(); });
                node.addEventListener('click', () => run(filtered[+node.dataset.i]));
            });
        }

        function highlight() {
            list.querySelectorAll('.cmd-item').forEach((n, i) => n.classList.toggle('active', i === index));
            const a = list.querySelector('.cmd-item.active');
            if (a) a.scrollIntoView({ block: 'nearest' });
        }
        function move(d) { if (!filtered.length) return; index = (index + d + filtered.length) % filtered.length; highlight(); }
        function run(it) { if (!it) return; close(); try { it.run(); } catch (e) { console.error(e); } }

        function open() {
            if (!root) build();
            items = provider() || [];
            input.value = '';
            index = 0;
            filter();
            root.classList.remove('hidden');
            input.focus();
        }
        function close() { if (root) root.classList.add('hidden'); }
        function isOpen() { return !!root && !root.classList.contains('hidden'); }

        return { open, close, isOpen, setProvider(fn) { provider = fn; } };
    })();

    // ---- Resizable side panels (CSS variables on .terminal-body)
    function initSplitters(body) {
        if (!body) return;
        const defaults = { left: 200, right: 320 };
        const saved = store.get('cols', defaults);
        const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
        const apply = (l, r) => {
            body.style.setProperty('--col-left', l + 'px');
            body.style.setProperty('--col-right', r + 'px');
        };
        let left = clamp(+saved.left || defaults.left, 0, 420);
        let right = clamp(+saved.right || defaults.right, 0, 560);
        apply(left, right);

        [['left', 'split-left'], ['right', 'split-right']].forEach(([side, cls]) => {
            const handle = document.createElement('div');
            handle.className = `splitter ${cls}`;
            handle.setAttribute('role', 'separator');
            handle.setAttribute('aria-orientation', 'vertical');
            handle.title = 'Drag to resize · double-click to reset';
            body.appendChild(handle);

            handle.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                handle.setPointerCapture(e.pointerId);
                handle.classList.add('dragging');
                document.body.classList.add('is-resizing');
                const startX = e.clientX, startL = left, startR = right;
                const move = (ev) => {
                    const dx = ev.clientX - startX;
                    if (side === 'left') left = clamp(startL + dx, 0, 420);
                    else right = clamp(startR - dx, 0, 560);
                    apply(left, right);
                };
                const up = () => {
                    handle.classList.remove('dragging');
                    document.body.classList.remove('is-resizing');
                    handle.removeEventListener('pointermove', move);
                    handle.removeEventListener('pointerup', up);
                    handle.removeEventListener('pointercancel', up);
                    store.set('cols', { left, right });
                };
                handle.addEventListener('pointermove', move);
                handle.addEventListener('pointerup', up);
                handle.addEventListener('pointercancel', up);
            });
            handle.addEventListener('dblclick', () => {
                if (side === 'left') left = defaults.left; else right = defaults.right;
                apply(left, right);
                store.set('cols', { left, right });
            });
        });
    }

    // ---- Equity curve (canvas)
    function drawEquity(canvas, points, currencySym) {
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.clientWidth || 300, cssH = canvas.clientHeight || 90;
        canvas.width = cssW * dpr; canvas.height = cssH * dpr;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        const vals = (points || []).map(p => Number(p.capital)).filter(Number.isFinite);
        if (vals.length < 2) {
            ctx.fillStyle = '#5c6675'; ctx.font = '11px Inter, sans-serif';
            ctx.fillText('Equity curve unavailable', 10, cssH / 2);
            return;
        }
        const min = Math.min(...vals), max = Math.max(...vals);
        const range = (max - min) || 1;
        const padT = 8, padB = 14, padL = 4, padR = 4;
        const x = (i) => padL + (i / (vals.length - 1)) * (cssW - padL - padR);
        const y = (v) => padT + (1 - (v - min) / range) * (cssH - padT - padB);
        const up = vals[vals.length - 1] >= vals[0];
        const color = up ? '#00D4A0' : '#FF5D5D';

        // baseline = starting capital
        ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(padL, y(vals[0])); ctx.lineTo(cssW - padR, y(vals[0])); ctx.stroke();
        ctx.setLineDash([]);

        const grad = ctx.createLinearGradient(0, padT, 0, cssH - padB);
        grad.addColorStop(0, up ? 'rgba(0,212,160,0.28)' : 'rgba(255,93,93,0.28)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');

        const total = vals.length - 1;
        const draw = (progress) => {
            ctx.clearRect(0, 0, cssW, cssH);
            ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.moveTo(padL, y(vals[0])); ctx.lineTo(cssW - padR, y(vals[0])); ctx.stroke();
            ctx.setLineDash([]);
            const upto = Math.max(1, Math.floor(total * progress));
            ctx.beginPath();
            ctx.moveTo(x(0), y(vals[0]));
            for (let i = 1; i <= upto; i++) ctx.lineTo(x(i), y(vals[i]));
            ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.stroke();
            ctx.lineTo(x(upto), cssH - padB); ctx.lineTo(x(0), cssH - padB); ctx.closePath();
            ctx.fillStyle = grad; ctx.fill();
            ctx.fillStyle = '#8B95A1'; ctx.font = '10px "JetBrains Mono", monospace';
            ctx.fillText(`${currencySym}${Math.round(vals[0]).toLocaleString()}`, padL + 2, cssH - 2);
            const endTxt = `${currencySym}${Math.round(vals[upto]).toLocaleString()}`;
            ctx.textAlign = 'right'; ctx.fillStyle = color;
            ctx.fillText(endTxt, cssW - padR - 2, cssH - 2);
            ctx.textAlign = 'left';
        };
        if (reduceMotion) { draw(1); return; }
        const t0 = performance.now();
        const token = (canvas._eqToken = (canvas._eqToken || 0) + 1);
        const step = (now) => {
            if (canvas._eqToken !== token) return;
            const t = Math.min(1, (now - t0) / 700);
            draw(1 - Math.pow(1 - t, 3));
            if (t < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    // ---- Market session status (hours only; exchange holidays are not modelled)
    function sessionStatus() {
        const now = new Date();
        const parts = (tz) => {
            const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false });
            const o = {};
            f.formatToParts(now).forEach(p => { o[p.type] = p.value; });
            return { wd: o.weekday, mins: (parseInt(o.hour, 10) % 24) * 60 + parseInt(o.minute, 10) };
        };
        const weekday = (wd) => !['Sat', 'Sun'].includes(wd);
        const ny = parts('America/New_York');
        const in_ = parts('Asia/Kolkata');
        return [
            { name: 'NYSE', open: weekday(ny.wd) && ny.mins >= 570 && ny.mins < 960 },
            { name: 'NSE', open: weekday(in_.wd) && in_.mins >= 555 && in_.mins < 930 },
            { name: 'CRYPTO', open: true }
        ];
    }

    // ---- Shortcut help dialog
    function showShortcuts() {
        let dlg = document.getElementById('shortcut-help');
        if (!dlg) {
            dlg = document.createElement('div');
            dlg.id = 'shortcut-help';
            dlg.className = 'cmd-overlay hidden';
            dlg.innerHTML = `
                <div class="cmd-box help-box" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
                    <div class="help-title">Keyboard shortcuts</div>
                    <div class="help-grid">
                        <kbd>Ctrl/⌘ + K</kbd><span>Command palette</span>
                        <kbd>/</kbd><span>Focus ticker search</span>
                        <kbd>1 – 6</kbd><span>Switch timeframe (1m … 1W)</span>
                        <kbd>C</kbd><span>Toggle candles / line</span>
                        <kbd>R</kbd><span>Refresh AI trade ideas</span>
                        <kbd>I</kbd><span>Open indicators menu</span>
                        <kbd>[ / ]</kbd><span>Previous / next watchlist symbol</span>
                        <kbd>?</kbd><span>Show this help</span>
                        <kbd>Esc</kbd><span>Close dialogs</span>
                    </div>
                </div>`;
            document.body.appendChild(dlg);
            dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) dlg.classList.add('hidden'); });
        }
        dlg.classList.toggle('hidden');
    }
    function closeShortcuts() {
        const dlg = document.getElementById('shortcut-help');
        if (dlg) dlg.classList.add('hidden');
    }

    window.UI = { store, toast, tween, palette, initSplitters, drawEquity, sessionStatus, showShortcuts, closeShortcuts, esc, reduceMotion, onAnalyze: null };
})();
