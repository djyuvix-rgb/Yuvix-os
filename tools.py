"""Finance tools the agent can call. Each returns a JSON-serialisable dict."""
import ast
import json
import math
import operator
import sqlite3
import time
from pathlib import Path

import yfinance as yf

import os
DB_PATH = Path(os.getenv("FINBOT_DB", Path(__file__).with_name("finbot.db")))


# ---------------------------------------------------------------- storage
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""CREATE TABLE IF NOT EXISTS holdings(
        user_id INTEGER, ticker TEXT, shares REAL, cost_basis REAL,
        PRIMARY KEY(user_id, ticker))""")
    conn.execute("""CREATE TABLE IF NOT EXISTS profile(
        user_id INTEGER PRIMARY KEY, data TEXT)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS alerts(
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, chat_id INTEGER,
        ticker TEXT, direction TEXT, price REAL, created REAL)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS history(
        user_id INTEGER PRIMARY KEY, messages TEXT)""")
    return conn


# ---------------------------------------------------------------- market data
def _price(ticker: str):
    t = yf.Ticker(ticker)
    fi = t.fast_info
    price = fi.get("lastPrice") or fi.get("last_price")
    prev = fi.get("previousClose") or fi.get("previous_close")
    cur = fi.get("currency")
    return price, prev, cur


def get_quote(tickers: list[str]):
    out = {}
    for tk in tickers[:10]:
        try:
            price, prev, cur = _price(tk)
            chg = ((price - prev) / prev * 100) if price and prev else None
            out[tk.upper()] = {"price": round(price, 4) if price else None,
                               "change_pct_today": round(chg, 2) if chg is not None else None,
                               "currency": cur}
        except Exception as e:  # noqa: BLE001
            out[tk.upper()] = {"error": str(e)}
    return out


def get_price_history(ticker: str, period: str = "1y", interval: str = "1wk"):
    df = yf.Ticker(ticker).history(period=period, interval=interval)
    if df.empty:
        return {"error": f"No data for {ticker}"}
    closes = df["Close"].dropna()
    first, last = float(closes.iloc[0]), float(closes.iloc[-1])
    rets = closes.pct_change().dropna()
    per_year = {"1d": 252, "1wk": 52, "1mo": 12}.get(interval, 252)
    peak = closes.cummax()
    return {
        "ticker": ticker.upper(), "period": period, "interval": interval,
        "start": round(first, 4), "end": round(last, 4),
        "total_return_pct": round((last / first - 1) * 100, 2),
        "annualised_volatility_pct": round(float(rets.std()) * math.sqrt(per_year) * 100, 2),
        "max_drawdown_pct": round(float(((closes - peak) / peak).min()) * 100, 2),
        "high": round(float(closes.max()), 4), "low": round(float(closes.min()), 4),
        "recent_closes": {str(d.date()): round(float(v), 4) for d, v in closes.tail(12).items()},
    }


def get_fundamentals(ticker: str):
    info = yf.Ticker(ticker).info or {}
    keys = ["longName", "sector", "industry", "marketCap", "trailingPE", "forwardPE",
            "priceToBook", "dividendYield", "payoutRatio", "profitMargins",
            "revenueGrowth", "earningsGrowth", "debtToEquity", "returnOnEquity",
            "beta", "fiftyTwoWeekHigh", "fiftyTwoWeekLow", "targetMeanPrice",
            "recommendationKey", "totalAssets", "expenseRatio", "category",
            "longBusinessSummary"]
    data = {k: info.get(k) for k in keys if info.get(k) is not None}
    if "longBusinessSummary" in data:
        data["longBusinessSummary"] = data["longBusinessSummary"][:600]
    return data or {"error": f"No fundamentals for {ticker}"}


def convert_currency(amount: float, from_ccy: str, to_ccy: str):
    if from_ccy.upper() == to_ccy.upper():
        return {"result": amount}
    rate, _, _ = _price(f"{from_ccy.upper()}{to_ccy.upper()}=X")
    return {"rate": rate, "result": round(amount * rate, 2)}


# ---------------------------------------------------------------- calculators
_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
        ast.Div: operator.truediv, ast.Pow: operator.pow, ast.Mod: operator.mod,
        ast.FloorDiv: operator.floordiv, ast.USub: operator.neg, ast.UAdd: operator.pos}
_FUNCS = {"sqrt": math.sqrt, "log": math.log, "exp": math.exp, "abs": abs,
          "round": round, "min": min, "max": max}


def _eval(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp):
        return _OPS[type(node.op)](_eval(node.left), _eval(node.right))
    if isinstance(node, ast.UnaryOp):
        return _OPS[type(node.op)](_eval(node.operand))
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCS:
        return _FUNCS[node.func.id](*[_eval(a) for a in node.args])
    raise ValueError("Unsupported expression")


def calculate(expression: str):
    return {"result": _eval(ast.parse(expression, mode="eval").body)}


def project_investment(initial: float, monthly: float, annual_return_pct: float,
                       years: int, annual_fee_pct: float = 0.0, inflation_pct: float = 0.0):
    r = (annual_return_pct - annual_fee_pct) / 100 / 12
    bal, contributed, yearly = initial, initial, []
    for m in range(1, years * 12 + 1):
        bal = bal * (1 + r) + monthly
        contributed += monthly
        if m % 12 == 0:
            real = bal / ((1 + inflation_pct / 100) ** (m / 12))
            yearly.append({"year": m // 12, "balance": round(bal), "in_todays_money": round(real)})
    step = max(1, len(yearly) // 10)
    return {"final_balance": round(bal), "total_contributed": round(contributed),
            "growth": round(bal - contributed),
            "final_in_todays_money": yearly[-1]["in_todays_money"] if yearly else round(bal),
            "by_year": yearly[::step] + ([yearly[-1]] if yearly and yearly[-1] not in yearly[::step] else [])}


def loan_payment(principal: float, annual_rate_pct: float, years: float):
    n, r = int(years * 12), annual_rate_pct / 100 / 12
    pay = principal / n if r == 0 else principal * r / (1 - (1 + r) ** -n)
    return {"monthly_payment": round(pay, 2), "total_paid": round(pay * n, 2),
            "total_interest": round(pay * n - principal, 2)}


# ---------------------------------------------------------------- portfolio
def portfolio_update(user_id: int, ticker: str, shares: float, cost_basis_per_share: float | None = None):
    tk = ticker.upper()
    with db() as c:
        if shares <= 0:
            c.execute("DELETE FROM holdings WHERE user_id=? AND ticker=?", (user_id, tk))
            return {"removed": tk}
        c.execute("INSERT OR REPLACE INTO holdings VALUES(?,?,?,?)",
                  (user_id, tk, shares, cost_basis_per_share))
    return {"saved": tk, "shares": shares, "cost_basis_per_share": cost_basis_per_share}


def portfolio_view(user_id: int):
    with db() as c:
        rows = c.execute("SELECT ticker, shares, cost_basis FROM holdings WHERE user_id=?",
                         (user_id,)).fetchall()
    if not rows:
        return {"holdings": [], "note": "Portfolio is empty."}
    holdings, total, total_cost = [], 0.0, 0.0
    for tk, sh, cb in rows:
        try:
            price, _, cur = _price(tk)
        except Exception:  # noqa: BLE001
            price, cur = None, None
        value = price * sh if price else None
        h = {"ticker": tk, "shares": sh, "price": price and round(price, 2),
             "currency": cur, "value": value and round(value, 2)}
        if cb and price:
            h["gain_pct"] = round((price / cb - 1) * 100, 2)
            total_cost += cb * sh
        if value:
            total += value
        holdings.append(h)
    for h in holdings:
        if h["value"] and total:
            h["weight_pct"] = round(h["value"] / total * 100, 1)
    return {"holdings": holdings, "total_value": round(total, 2),
            "note": "Totals mix currencies if holdings are in different currencies."}


# ---------------------------------------------------------------- profile & alerts
def profile_get(user_id: int):
    with db() as c:
        row = c.execute("SELECT data FROM profile WHERE user_id=?", (user_id,)).fetchone()
    return json.loads(row[0]) if row else {}


def profile_update(user_id: int, **fields):
    data = profile_get(user_id)
    data.update({k: v for k, v in fields.items() if v is not None})
    with db() as c:
        c.execute("INSERT OR REPLACE INTO profile VALUES(?,?)", (user_id, json.dumps(data)))
    return {"profile": data}


def alert_create(user_id: int, chat_id: int, ticker: str, direction: str, price: float):
    with db() as c:
        cur = c.execute("INSERT INTO alerts(user_id,chat_id,ticker,direction,price,created) VALUES(?,?,?,?,?,?)",
                        (user_id, chat_id, ticker.upper(), direction, price, time.time()))
    return {"alert_id": cur.lastrowid, "ticker": ticker.upper(), "direction": direction, "price": price}


def alert_list(user_id: int):
    with db() as c:
        rows = c.execute("SELECT id,ticker,direction,price FROM alerts WHERE user_id=?", (user_id,)).fetchall()
    return {"alerts": [dict(zip(["id", "ticker", "direction", "price"], r)) for r in rows]}


def alert_delete(user_id: int, alert_id: int):
    with db() as c:
        c.execute("DELETE FROM alerts WHERE user_id=? AND id=?", (user_id, alert_id))
    return {"deleted": alert_id}


# ---------------------------------------------------------------- schemas for Claude
def _s(props, req):
    return {"type": "object", "properties": props, "required": req}


TOOL_SCHEMAS = [
    {"name": "get_quote", "description": "Live price and today's % change for stocks, ETFs, crypto (BTC-USD), FX (EURUSD=X), indices (^GSPC). Yahoo Finance tickers.",
     "input_schema": _s({"tickers": {"type": "array", "items": {"type": "string"}}}, ["tickers"])},
    {"name": "get_price_history", "description": "Historical performance stats: total return, volatility, max drawdown, recent closes.",
     "input_schema": _s({"ticker": {"type": "string"},
                         "period": {"type": "string", "enum": ["1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "max"]},
                         "interval": {"type": "string", "enum": ["1d", "1wk", "1mo"]}}, ["ticker"])},
    {"name": "get_fundamentals", "description": "Valuation and business fundamentals for a stock or fund (P/E, margins, growth, dividend, expense ratio, analyst target).",
     "input_schema": _s({"ticker": {"type": "string"}}, ["ticker"])},
    {"name": "convert_currency", "description": "Convert an amount between currencies at the live rate.",
     "input_schema": _s({"amount": {"type": "number"}, "from_ccy": {"type": "string"}, "to_ccy": {"type": "string"}},
                        ["amount", "from_ccy", "to_ccy"])},
    {"name": "calculate", "description": "Evaluate an arithmetic expression exactly. Always use this instead of mental maths. Supports + - * / ** % sqrt log exp abs round min max.",
     "input_schema": _s({"expression": {"type": "string"}}, ["expression"])},
    {"name": "project_investment", "description": "Project growth of savings/investments with monthly contributions, fees and inflation.",
     "input_schema": _s({"initial": {"type": "number"}, "monthly": {"type": "number"},
                         "annual_return_pct": {"type": "number"}, "years": {"type": "integer"},
                         "annual_fee_pct": {"type": "number"}, "inflation_pct": {"type": "number"}},
                        ["initial", "monthly", "annual_return_pct", "years"])},
    {"name": "loan_payment", "description": "Monthly payment and total interest for a loan or mortgage.",
     "input_schema": _s({"principal": {"type": "number"}, "annual_rate_pct": {"type": "number"}, "years": {"type": "number"}},
                        ["principal", "annual_rate_pct", "years"])},
    {"name": "portfolio_update", "description": "Add/update a holding in the user's saved portfolio. shares=0 removes it.",
     "input_schema": _s({"ticker": {"type": "string"}, "shares": {"type": "number"},
                         "cost_basis_per_share": {"type": "number"}}, ["ticker", "shares"])},
    {"name": "portfolio_view", "description": "Show the user's saved portfolio valued at live prices, with weights and gains.",
     "input_schema": _s({}, [])},
    {"name": "profile_update", "description": "Save facts about the user for personalised guidance (only what they told you).",
     "input_schema": _s({"country": {"type": "string"}, "base_currency": {"type": "string"},
                         "age": {"type": "integer"}, "risk_tolerance": {"type": "string", "enum": ["low", "medium", "high"]},
                         "goals": {"type": "string"}, "time_horizon_years": {"type": "number"},
                         "monthly_income": {"type": "number"}, "monthly_savings": {"type": "number"},
                         "emergency_fund_months": {"type": "number"}, "debts": {"type": "string"},
                         "notes": {"type": "string"}}, [])},
    {"name": "alert_create", "description": "Create a price alert; the user gets a Telegram message when the price crosses the level.",
     "input_schema": _s({"ticker": {"type": "string"}, "direction": {"type": "string", "enum": ["above", "below"]},
                         "price": {"type": "number"}}, ["ticker", "direction", "price"])},
    {"name": "alert_list", "description": "List the user's active price alerts.", "input_schema": _s({}, [])},
    {"name": "alert_delete", "description": "Delete a price alert by id.", "input_schema": _s({"alert_id": {"type": "integer"}}, ["alert_id"])},
]

_USER_TOOLS = {"portfolio_update", "portfolio_view", "profile_update", "alert_list", "alert_delete"}


def run_tool(name: str, args: dict, user_id: int, chat_id: int):
    fn = globals()[name]
    if name == "alert_create":
        return fn(user_id, chat_id, **args)
    if name in _USER_TOOLS:
        return fn(user_id, **args)
    return fn(**args)
