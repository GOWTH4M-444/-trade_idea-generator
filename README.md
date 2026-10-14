# AI Trade Idea Generator ⚡

A full-stack financial analysis web application that generates data-driven stock trade ideas using real-time market data (`yfinance`), technical indicators (`pandas` + `ta`), and Claude AI (`claude-sonnet-4-6`).

Designed for decoupled deployment on **Render** (FastAPI Backend + Vanilla JS Frontend).

---

## 🏗 Architecture Diagram

```
+-------------------------------------------------------+
|                 FRONTEND (Render Static)              |
|   HTML5 / Modern Dark CSS / Vanilla JS / Chart.js    |
+-------------------------------------------------------+
                           |
                     HTTP / CORS fetch()
                           v
+-------------------------------------------------------+
|                 BACKEND (Render Web Service)          |
|                  FastAPI + Uvicorn                    |
+-------------------------------------------------------+
        |                          |                  |
        v                          v                  v
+---------------+        +------------------+   +--------------------+
|   yfinance    |        | pandas + ta lib  |   | Claude AI API      |
| (Price Data)  |        | (RSI, SMAs, S/R) |   | (JSON Trade Setups)|
+---------------+        +------------------+   +--------------------+
```

---

## 🛠 Tech Stack

- **Backend**: Python 3.11+, FastAPI, Uvicorn, `yfinance`, `pandas`, `ta` library, `anthropic` SDK, `python-dotenv`.
- **Frontend**: HTML5, Vanilla CSS3 (Custom Dark Theme with Glassmorphism), Vanilla JavaScript (Fetch API), `Chart.js` (via CDN).
- **Hosting / Deployment**: Decoupled deployment ready for Render.

---

## 🚀 Local Setup Instructions

### 1. Backend Setup

```bash
# Navigate to backend directory
cd backend

# Create virtual environment (optional but recommended)
python -m venv venv
# On Windows:
venv\Scripts\activate
# On macOS/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Create .env file from template
cp .env.example .env

# Add your Anthropic API Key in .env
# ANTHROPIC_API_KEY=your_actual_anthropic_api_key

# Run local development server
python main.py
# Server will run at http://127.0.0.1:8000
```

### 2. Frontend Setup

```bash
# Navigate to frontend directory
cd frontend

# Verify config.js points to your local backend:
# CONFIG.API_BASE_URL = "http://127.0.0.1:8000"

# Serve using any local web server, for example with Python:
python -m http.server 3000

# Open browser at http://localhost:3000
```

---

## ☁️ Render Deployment Steps

### 1. Deploy Backend (Render Web Service)
1. Push your repository to GitHub.
2. Log into [Render Dashboard](https://dashboard.render.com/) and click **New +** -> **Web Service**.
3. Connect your repository and set:
   - **Root Directory**: `backend`
   - **Environment**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. Under **Environment Variables**, add:
   - `ANTHROPIC_API_KEY`: `your_anthropic_api_key_here`
5. Click **Create Web Service**. Render will generate your backend URL (e.g., `https://ai-trade-idea-backend.onrender.com`).

### 2. Deploy Frontend (Render Static Site)
1. In `frontend/config.js`, update `API_BASE_URL` to your live Render backend URL:
   ```javascript
   const CONFIG = {
       API_BASE_URL: 'https://ai-trade-idea-backend.onrender.com'
   };
   ```
2. In Render Dashboard, click **New +** -> **Static Site**.
3. Connect your repository and set:
   - **Root Directory**: `frontend`
   - **Build Command**: *(leave empty)*
   - **Publish Directory**: `.`
4. Click **Create Static Site**. Your application is now live!

---

## ⚖️ Disclaimer
*For educational purposes only. Not financial advice. Not a SEBI-registered recommendation.*

---

## ✨ Advanced Frontend Features

New files: `frontend/ui-kit.js` (toasts, command palette, resizable panels, equity chart) and `frontend/dynamic.css`.

- **Command palette** (`Ctrl/⌘ + K`): jump to any ticker, switch timeframe/chart type, toggle indicators.
- **Keyboard shortcuts**: `/` search · `1–6` timeframes · `C` candles/line · `R` refresh ideas · `I` indicators · `[` `]` prev/next watchlist symbol · `?` help.
- **Plot trade ideas on the chart**: Entry / Target / Stop price lines, risk-vs-reward bar, LONG/SHORT tag, per-idea position size, copy plan.
- **Live watchlist**: price-flash rows, daily-move bar, gainers/losers sort, remove with Undo, add with validation.
- **Loading + error states**: chart loading overlay, skeleton idea cards, error toasts with Retry; stale responses are ignored.
- **Backtest equity curve** (animated), real values only (no placeholder numbers).
- **Resizable side panels** (drag the dividers, double-click to reset), market-session pills + clock, live price in the tab title.
- **Everything persists** in localStorage: symbol, timeframe, chart type, indicators, watchlist, capital/risk, panel widths.
- **Mobile layout** with bottom tabs (Watchlist / Chart / AI Ideas); respects `prefers-reduced-motion`.

---

## 🛠 Backend Fixes (v3.2)

Run the tests (no network or API key needed): `cd backend && pip install -r requirements-dev.txt && pytest -q`

- **Correct numbers**: prices were rounded to 2 decimals everywhere, wrecking crypto/FX (a $0.083 coin showed $0.08, EURUSD 1.08). Precision now fits the price. Indian indices report INR. Support/resistance are ordered nearest-first. Duplicate live bars are removed.
- **Backtester**: profit factor is a real ratio (or `null` with no losses, previously a currency amount); average R:R is computed from trades (was hardcoded `1:2.25`); no hidden leverage on expensive assets; the final equity point is never dropped.
- **AI ideas**: Claude output is validated (long: stop < entry < target, short: the reverse, levels within range) and R:R is recomputed. Identical requests are cached for 5 min so you are not billed twice. Default model is `claude-sonnet-4-6` (override with `ANTHROPIC_MODEL`); the old default was a retired model. The API reports `source` (`claude` / `quant-fallback`) and a clear `warning` when Claude is unavailable, shown in the UI banner.
- **Rule-based fallback** no longer produces inverted setups (e.g. a "long" whose target is below entry); mean reversion goes short when price is above its mean.
- **Timeframes**: `4h` is a true resample (was mislabeled 1h data); `1wk` fetches 2 years so indicators work; invalid `interval`/`period`/ticker values return `400`.
- **Security**: salted PBKDF2 passwords (old SHA-256 accounts still log in and are upgraded automatically); input validation on auth/watchlist/alerts; CORS no longer combines `*` with credentials (set `CORS_ORIGINS` in production); upstream errors are logged, not leaked to clients.
- **Reliability**: thread-safe, size-bounded cache; DB connections always closed, WAL + timeout; trade history de-duplicated and capped at 2,000 rows; live-price cached for 4 s; one bad symbol no longer fails a whole `/quotes` batch.
- **Known limitations**: `user_id` on watchlist/alert endpoints is client-supplied and there are no session tokens yet (fine for single-user/demo use). Alerts are stored but not yet evaluated.
