"""FinAgent — a Manus-style autonomous finance assistant for Telegram, powered by Claude."""
import asyncio
import html
import json
import logging
import os
import re
from datetime import datetime, timezone

from anthropic import AsyncAnthropic
from dotenv import load_dotenv
from telegram import Update
from telegram.constants import ChatAction, ParseMode
from telegram.ext import (Application, CommandHandler, ContextTypes, MessageHandler, filters)

import tools

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("finbot")

TELEGRAM_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-5-5")
MAX_STEPS = int(os.getenv("MAX_AGENT_STEPS", "15"))
HISTORY_TURNS = int(os.getenv("HISTORY_TURNS", "12"))
ALLOWED = {int(x) for x in os.getenv("ALLOWED_USER_IDS", "").replace(" ", "").split(",") if x}
ALERT_INTERVAL_MIN = int(os.getenv("ALERT_CHECK_MINUTES", "15"))

claude = AsyncAnthropic()

SYSTEM = """You are FinAgent, an autonomous personal-finance and investing research agent working inside Telegram.

How you work (like an agent, not a chatbot):
- For any non-trivial request, quietly plan the steps, then execute them with your tools before answering: search the web for current news, rates, rules and taxes; pull live quotes, history and fundamentals; run every number through calculate / project_investment / loan_payment instead of doing maths in your head.
- Keep going until the task is actually done. Compare options side by side when the user is choosing.
- Use the user's saved profile and portfolio. When they tell you facts about themselves (country, age, income, goals, risk tolerance, debts), save them with profile_update. If key facts are missing for personalised advice, ask at most 2 short questions — but still give useful general guidance in the same reply.

What good advice looks like:
- Fundamentals first: emergency fund, high-interest debt, employer matches, low-cost diversified index funds, fees, taxes, time horizon, and risk the user can actually stomach.
- Be concrete and honest: give clear options with pros, cons, risks and numbers. Say when something is speculative (single stocks, crypto, leverage, options) and never promise returns.
- Flag scams and red flags (guaranteed returns, pressure, "signals" groups, unregistered platforms).
- Rules and taxes depend on country — check with a search when it matters.
- You are not a licensed financial adviser. For big, irreversible or tax/legal-heavy decisions, suggest confirming with a licensed professional. Say this briefly once when relevant, not in every message.

Format for a phone screen: lead with the answer, short paragraphs, bullet points, **bold** for key figures. Keep it under ~250 words unless the user asks for a deep report. Cite sources (site names) for facts found on the web.
Today's date: {today}. User profile: {profile}"""


# ---------------------------------------------------------------- helpers
def allowed(update: Update) -> bool:
    return not ALLOWED or (update.effective_user and update.effective_user.id in ALLOWED)


def load_history(uid: int) -> list:
    with tools.db() as c:
        row = c.execute("SELECT messages FROM history WHERE user_id=?", (uid,)).fetchone()
    return json.loads(row[0]) if row else []


def save_history(uid: int, msgs: list):
    msgs = msgs[-HISTORY_TURNS * 2:]
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    with tools.db() as c:
        c.execute("INSERT OR REPLACE INTO history VALUES(?,?)", (uid, json.dumps(msgs)))


def md_to_tg_html(text: str) -> str:
    t = html.escape(text, quote=False)
    t = re.sub(r"```(?:\w+)?\n?(.*?)```", lambda m: f"<pre>{m.group(1)}</pre>", t, flags=re.S)
    t = re.sub(r"`([^`\n]+)`", r"<code>\1</code>", t)
    t = re.sub(r"^#{1,6}\s*(.+)$", r"<b>\1</b>", t, flags=re.M)
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"<i>\1</i>", t)
    t = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2">\1</a>', t)
    t = re.sub(r"^\s*[-*]\s+", "• ", t, flags=re.M)
    return t


def chunks(text: str, size: int = 3800):
    while text:
        if len(text) <= size:
            yield text
            return
        cut = text.rfind("\n", 0, size)
        cut = cut if cut > size // 2 else size
        yield text[:cut]
        text = text[cut:].lstrip("\n")


async def send_long(update: Update, text: str):
    for part in chunks(text):
        try:
            await update.effective_chat.send_message(md_to_tg_html(part), parse_mode=ParseMode.HTML,
                                                     disable_web_page_preview=True)
        except Exception:  # bad HTML → fall back to plain text
            await update.effective_chat.send_message(part, disable_web_page_preview=True)


STEP_ICONS = {"web_search": "🔎", "get_quote": "📈", "get_price_history": "📊", "get_fundamentals": "🏢",
              "calculate": "🧮", "project_investment": "🧮", "loan_payment": "🏦", "convert_currency": "💱",
              "portfolio_update": "💼", "portfolio_view": "💼", "profile_update": "📝",
              "alert_create": "🔔", "alert_list": "🔔", "alert_delete": "🔔"}


def describe(name: str, args: dict) -> str:
    detail = args.get("query") or args.get("ticker") or ", ".join(args.get("tickers", [])) or args.get("expression") or ""
    return f"{STEP_ICONS.get(name, '⚙️')} {name.replace('_', ' ')} {str(detail)[:60]}".strip()


# ---------------------------------------------------------------- agent loop
async def run_agent(update: Update, user_text: str) -> str:
    uid, chat_id = update.effective_user.id, update.effective_chat.id
    history = load_history(uid)
    messages = history + [{"role": "user", "content": user_text}]
    system = SYSTEM.format(today=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                           profile=json.dumps(tools.profile_get(uid)) or "{}")
    api_tools = tools.TOOL_SCHEMAS + [{"type": "web_search_20250305", "name": "web_search", "max_uses": 8}]

    status = await update.effective_chat.send_message("🧠 Thinking…")
    steps: list[str] = []

    async def show(step: str):
        steps.append(step)
        try:
            await status.edit_text("🧠 Working on it…\n\n" + "\n".join(steps[-8:]))
        except Exception:
            pass

    final_text = ""
    for _ in range(MAX_STEPS):
        await update.effective_chat.send_action(ChatAction.TYPING)
        resp = await claude.messages.create(model=MODEL, max_tokens=4096, system=system,
                                            tools=api_tools, messages=messages)
        messages.append({"role": "assistant", "content": [b.model_dump(exclude_none=True) for b in resp.content]})

        for b in resp.content:
            if b.type == "server_tool_use":
                await show(describe(b.name, b.input or {}))

        if resp.stop_reason == "pause_turn":  # long server-side search; let it continue
            continue
        if resp.stop_reason != "tool_use":
            final_text = "".join(b.text for b in resp.content if b.type == "text")
            break

        results = []
        for b in resp.content:
            if b.type != "tool_use":
                continue
            await show(describe(b.name, b.input))
            try:
                out = await asyncio.to_thread(tools.run_tool, b.name, b.input, uid, chat_id)
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": json.dumps(out, default=str)})
            except Exception as e:  # noqa: BLE001
                log.exception("tool %s failed", b.name)
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": f"Error: {e}", "is_error": True})
        messages.append({"role": "user", "content": results})
    else:
        final_text = "I hit my step limit on this one — here's where I got to. Ask me to continue if you'd like."

    try:
        await status.delete()
    except Exception:
        pass

    # Persist only the plain conversation (keeps history small and valid)
    save_history(uid, history + [{"role": "user", "content": user_text},
                                 {"role": "assistant", "content": final_text or "(no answer)"}])
    return final_text or "Sorry, I couldn't produce an answer. Try rephrasing?"


# ---------------------------------------------------------------- handlers
async def on_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not allowed(update):
        await update.message.reply_text(f"Not authorised. Your Telegram ID is {update.effective_user.id}.")
        return
    try:
        answer = await run_agent(update, update.message.text)
    except Exception as e:  # noqa: BLE001
        log.exception("agent failed")
        answer = f"⚠️ Something went wrong: {e}"
    await send_long(update, answer)


async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "👋 I'm FinAgent — your autonomous money & investing assistant.\n\n"
        "I research the web, pull live market data, run the numbers and remember your goals.\n\n"
        "Try:\n"
        "• I'm 30, save $800/month. How should I start investing?\n"
        "• Compare VOO vs QQQ vs VT over 10 years\n"
        "• Add 10 shares of AAPL at $180 to my portfolio\n"
        "• Alert me if BTC-USD drops below 60000\n"
        "• Should I pay off my 7% car loan or invest?\n\n"
        "/portfolio  /profile  /alerts  /reset\n\n"
        "ℹ️ Educational guidance, not licensed financial advice.")


async def cmd_reset(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if allowed(update):
        save_history(update.effective_user.id, [])
        await update.message.reply_text("🧹 Conversation cleared (profile, portfolio and alerts kept).")


async def cmd_shortcut(update: Update, ctx: ContextTypes.DEFAULT_TYPE, prompt: str):
    if not allowed(update):
        return
    await send_long(update, await run_agent(update, prompt))


async def cmd_portfolio(u, c): await cmd_shortcut(u, c, "Show my portfolio with a short health check (diversification, concentration, risk).")
async def cmd_profile(u, c): await cmd_shortcut(u, c, "Summarise what you know about my financial profile and what's missing.")
async def cmd_alerts(u, c): await cmd_shortcut(u, c, "List my active price alerts.")


async def check_alerts(ctx: ContextTypes.DEFAULT_TYPE):
    with tools.db() as c:
        rows = c.execute("SELECT id, chat_id, ticker, direction, price FROM alerts").fetchall()
    prices: dict[str, float | None] = {}
    for aid, chat_id, tk, direction, level in rows:
        if tk not in prices:
            try:
                prices[tk] = (await asyncio.to_thread(tools._price, tk))[0]
            except Exception:
                prices[tk] = None
        p = prices[tk]
        if p is None:
            continue
        if (direction == "above" and p >= level) or (direction == "below" and p <= level):
            await ctx.bot.send_message(chat_id, f"🔔 {tk} is {direction} {level}: now {p:,.2f}")
            with tools.db() as c:
                c.execute("DELETE FROM alerts WHERE id=?", (aid,))


def main():
    tools.db().close()
    app = Application.builder().token(TELEGRAM_TOKEN).concurrent_updates(True).build()
    app.add_handler(CommandHandler(["start", "help"], cmd_start))
    app.add_handler(CommandHandler("reset", cmd_reset))
    app.add_handler(CommandHandler("portfolio", cmd_portfolio))
    app.add_handler(CommandHandler("profile", cmd_profile))
    app.add_handler(CommandHandler("alerts", cmd_alerts))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_message))
    app.job_queue.run_repeating(check_alerts, interval=ALERT_INTERVAL_MIN * 60, first=30)
    log.info("FinAgent running with model %s", MODEL)
    app.run_polling()


if __name__ == "__main__":
    main()
