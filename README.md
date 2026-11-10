# FinAgent: a Telegram finance agent that works like Manus

FinAgent is an autonomous assistant powered by Claude. When you ask it something, it plans the steps, uses its tools, shows each step live in the chat (🔎 searching… 📈 quote… 🧮 calculating…) and then answers.

**What it can do**
- 🔎 Search the web for news, interest rates, tax rules and fund details, and name its sources
- 📈 Get live prices for stocks, ETFs, crypto (`BTC-USD`), currency pairs (`EURUSD=X`) and indices (`^GSPC`)
- 📊 Look up past performance, volatility, drawdowns and fundamentals (P/E, dividends, growth, fees)
- 🧮 Do exact calculations: compound growth with fees and inflation, loan and mortgage payments, currency conversion
- 💼 Save your portfolio and value it at live prices, with weights and gains
- 📝 Remember your profile (age, country, goals, risk tolerance) so its advice fits you
- 🔔 Send price alerts to Telegram when a price crosses a level you set

> It gives educational guidance, not licensed financial advice.

## Setup (about 10 minutes)

1. **Create the bot.** In Telegram, open **@BotFather**, send `/newbot` and follow the prompts. Copy the token it gives you.
2. **Get a Claude API key.** Get one at https://console.anthropic.com, add some credit, and turn on **web search** under the organisation's privacy settings.
3. **Configure.** Copy `.env.example` to `.env` and fill in both keys.
4. **Run it.**
   ```bash
   pip install -r requirements.txt
   python bot.py
   ```
5. Send your bot `/start` in Telegram.

**Keep it private (recommended).** Message the bot once. It replies with your Telegram ID only if you have already set `ALLOWED_USER_IDS` (to any value). Otherwise, get your ID from **@userinfobot**. Put the ID in `ALLOWED_USER_IDS` and restart the bot.

## Run it 24/7
The bot only works while `bot.py` is running. Some ways to keep it running:
- **Railway / Render / Fly.io:** push this folder (a Dockerfile is included) and set the variables from `.env` in the dashboard. Use a "worker" or "background" service; it does not need a web port.
- **Any VPS:** `docker build -t finagent . && docker run -d --restart=always --env-file .env -e FINBOT_DB=/data/finbot.db -v $PWD/data:/data finagent`

## Commands
`/start` help · `/portfolio` portfolio health check · `/profile` what it knows about you · `/alerts` · `/reset` clear the chat (keeps your portfolio and profile)

## Customise
- Change the model with `CLAUDE_MODEL` (default `claude-sonnet-5-5`; `claude-opus-5-5` reasons more deeply but costs more).
- Edit `SYSTEM` in `bot.py` to change its personality or advice style.
- Add a tool in `tools.py`: write the function, then add its schema to `TOOL_SCHEMAS`.

## Files
`bot.py` Telegram handlers and the agent loop · `tools.py` market data, calculators, portfolio, profile, alerts · `finbot.db` SQLite file, created automatically
