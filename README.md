# Yuvix-os · Yuvizbot

**Yuvizbot** ([@Yuvizbot](https://t.me/Yuvizbot)) is a personal finance assistant for Telegram. It runs **free** on Cloudflare Workers, stays online 24/7 and needs no server.

## What it does

| Command | Example | What it does |
|---|---|---|
| `/spent` | `/spent 12.50 food lunch` | Log an expense (or just send `12.5 food lunch`) |
| `/earned` | `/earned 2500 salary` | Log income (or just send `+2500 salary`) |
| `/balance` | | This month's income, expenses, net and savings rate, plus all-time net |
| `/report` | `/report 2026-10` | Spending by category with bars, compared with budgets |
| `/budget` | `/budget food 300` | Monthly budget per category, with warnings at 80% and over |
| `/history` | `/history 30` | Recent transactions |
| `/undo` | | Remove the last entry |
| `/currency` | `/currency EUR` | Display currency |
| `/convert` | `/convert 100 USD EUR` | Live exchange rates (free ECB data) |
| `/loan` | `/loan 20000 6.5 5` | Monthly payment and total interest |
| `/goal` | `/goal 10000 24 4` | Monthly savings needed to reach a target |
| `/compound` | `/compound 1000 7 10 100` | Investment growth with monthly contributions |
| `/export` | | Download all transactions as CSV |
| `/reset` | `/reset confirm` | Delete all your data |

Each Telegram chat has its own private data, stored in Cloudflare KV.

## Go live (one-time setup, about 10 minutes, all free)

### 1. Get your bot token
In Telegram, open **@BotFather**, send `/mybots`, choose **@Yuvizbot**, then **API Token**. Copy the token (it looks like `123456:ABC-...`).

> If the token has ever been shared, choose **Revoke current token** first.

### 2. Create a free Cloudflare account
Sign up at <https://dash.cloudflare.com/sign-up>. Then:
- **Account ID**: on the dashboard home, open the account menu (⋯) next to your account name and choose **Copy account ID**. It is also shown on the right of the **Workers & Pages** overview page.
- **Enable workers.dev**: open **Workers & Pages** once so Cloudflare gives you a free `*.workers.dev` subdomain.
- **API token**: go to **My Profile → API Tokens → Create Token** and use the **Edit Cloudflare Workers** template. Create it and copy the token.

### 3. Add three secrets to this GitHub repo
In the repo, open **Settings → Secrets and variables → Actions → New repository secret** and add:

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the token from BotFather |
| `CLOUDFLARE_API_TOKEN` | the Cloudflare API token |
| `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare account ID |

### 4. Deploy
Open the **Actions** tab, select the latest **Deploy Yuvizbot** run and click **Re-run all jobs**. You can also push any commit, or use **Run workflow** once this is merged to `main`.

The workflow runs the tests, creates the storage, deploys the bot and connects it to Telegram. When it finishes with ✅, open <https://t.me/Yuvizbot> and send `/start`.

Every later push to `main` redeploys the bot automatically.

## Free tier limits
Cloudflare Workers free plan: 100,000 requests/day; KV free plan: 100,000 reads and 1,000 writes per day. That covers about 1,000 logged transactions a day, far more than one person needs.

## Develop
```bash
npm install
npm test          # unit tests (node:test)
```
Code: `src/bot.js` (all bot logic), `src/index.js` (Cloudflare Worker + Telegram API), `.github/workflows/deploy.yml` (deploy).

*Yuvizbot is an educational tool, not professional financial advice.*
