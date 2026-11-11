// Yuvizbot — personal finance assistant for Telegram.
// Pure logic: no Cloudflare- or Telegram-specific I/O lives here, so it can be
// unit-tested with a fake store and a fake Telegram client.

const MAX_TX = 5000;

export const COMMANDS = [
  ['help', 'Show all commands'],
  ['spent', 'Log an expense: /spent 12.50 food lunch'],
  ['earned', 'Log income: /earned 2500 salary'],
  ['balance', 'This month + all-time balance'],
  ['report', 'Spending by category (optionally /report 2026-10)'],
  ['budget', 'Set or view budgets: /budget food 300'],
  ['history', 'Recent transactions'],
  ['undo', 'Remove the last transaction'],
  ['currency', 'Set your currency: /currency EUR'],
  ['convert', 'Convert currency: /convert 100 USD EUR'],
  ['loan', 'Loan payment: /loan 20000 6.5 5'],
  ['goal', 'Savings plan: /goal 10000 24'],
  ['compound', 'Growth: /compound 1000 7 10 100'],
  ['export', 'Download all transactions as CSV'],
  ['reset', 'Delete all your data'],
];

const HELP = `<b>💰 Yuvizbot — your finance assistant</b>

<b>Track money</b>
/spent 12.50 food lunch — log an expense
/earned 2500 salary — log income
<i>Shortcut: just send</i> <code>12.5 food lunch</code> <i>(expense) or</i> <code>+2500 salary</code> <i>(income)</i>
/undo — remove the last entry
/history — last 10 entries (/history 30 for more)

<b>Understand it</b>
/balance — this month and all-time
/report — spending by category vs budget
/report 2026-10 — a specific month
/budget food 300 — monthly budget (/budget to list, /budget food 0 to remove)

<b>Calculators</b>
/convert 100 USD EUR — live exchange rate
/loan 20000 6.5 5 — amount, annual rate %, years
/goal 10000 24 — target, months (optional: /goal 10000 24 4 for 4% interest)
/compound 1000 7 10 100 — start, annual %, years, monthly add

<b>Settings</b>
/currency EUR — your display currency (now: {cur})
/export — CSV of all transactions
/reset — delete all your data

<i>Educational tool, not professional financial advice.</i>`;

// ---------- helpers ----------

export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function parseAmount(s) {
  if (s == null) return NaN;
  const cleaned = String(s).replace(/[$€£₪,\s]/g, '');
  if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned)) return NaN;
  return Number(cleaned);
}

export function money(n, cur) {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${abs} ${cur}`;
}

function monthKey(ts) {
  return new Date(ts).toISOString().slice(0, 7);
}

function bar(fraction, width = 10) {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function emptyUser() {
  return { currency: 'USD', tx: [], budgets: {}, nextId: 1 };
}

// Monthly payment of an amortizing loan.
export function loanPayment(principal, annualRatePct, years) {
  const n = Math.round(years * 12);
  const r = annualRatePct / 100 / 12;
  if (r === 0) return principal / n;
  return (principal * r) / (1 - Math.pow(1 + r, -n));
}

// Monthly deposit needed to reach `target` in `months` at annual rate.
export function goalDeposit(target, months, annualRatePct = 0) {
  const r = annualRatePct / 100 / 12;
  if (r === 0) return target / months;
  return (target * r) / (Math.pow(1 + r, months) - 1);
}

// Future value with monthly compounding and monthly contributions.
export function compound(start, annualRatePct, years, monthly = 0) {
  const n = Math.round(years * 12);
  const r = annualRatePct / 100 / 12;
  if (r === 0) return start + monthly * n;
  const g = Math.pow(1 + r, n);
  return start * g + monthly * ((g - 1) / r);
}

// ---------- handler ----------

/**
 * @param {object} update Telegram update
 * @param {object} deps
 * @param {{get(k:string):Promise<any>, put(k:string,v:any):Promise<void>}} deps.store
 * @param {{sendMessage(chatId, text):Promise<void>, sendDocument(chatId, filename, content, caption):Promise<void>}} deps.tg
 * @param {(from:string,to:string)=>Promise<number>} [deps.rate] exchange-rate lookup
 * @param {()=>number} [deps.now]
 */
export async function handleUpdate(update, deps) {
  const msg = update.message || update.edited_message;
  if (!msg || typeof msg.text !== 'string') return;
  const chatId = msg.chat.id;
  const now = deps.now ? deps.now() : Date.now();
  const key = `u:${chatId}`;

  const user = (await deps.store.get(key)) || emptyUser();
  const reply = (text) => deps.tg.sendMessage(chatId, text);
  const save = () => deps.store.put(key, user);
  const cur = user.currency;

  let text = msg.text.trim();
  let cmd;
  let args;
  if (text.startsWith('/')) {
    const [head, ...rest] = text.split(/\s+/);
    cmd = head.slice(1).split('@')[0].toLowerCase();
    args = rest;
  } else {
    // Free-text shortcut: "12.5 food lunch" or "+2500 salary"
    const parts = text.split(/\s+/);
    if (!Number.isNaN(parseAmount(parts[0]))) {
      cmd = parts[0].startsWith('+') ? 'earned' : 'spent';
      args = [parts[0].replace(/^\+/, ''), ...parts.slice(1)];
    } else {
      return reply(`I didn't catch that. Try <code>12.5 food lunch</code> or /help.`);
    }
  }

  switch (cmd) {
    case 'start':
    case 'help':
      return reply(HELP.replace('{cur}', esc(cur)));

    case 'spent':
    case 's':
    case 'earned':
    case 'income':
    case 'i': {
      const type = cmd.startsWith('s') ? 'expense' : 'income';
      const amt = parseAmount(args[0]);
      if (!(amt > 0)) {
        return reply(type === 'expense'
          ? 'Usage: <code>/spent 12.50 food lunch</code>'
          : 'Usage: <code>/earned 2500 salary</code>');
      }
      const cat = (args[1] || (type === 'expense' ? 'other' : 'income')).toLowerCase().slice(0, 32);
      const note = args.slice(2).join(' ').slice(0, 200);
      user.tx.push({ id: user.nextId++, t: now, type, amt: Math.round(amt * 100) / 100, cat, note });
      if (user.tx.length > MAX_TX) user.tx.splice(0, user.tx.length - MAX_TX);
      await save();

      let out = type === 'expense'
        ? `✅ Spent <b>${money(amt, cur)}</b> on <b>${esc(cat)}</b>${note ? ` — ${esc(note)}` : ''}`
        : `✅ Earned <b>${money(amt, cur)}</b> (${esc(cat)})${note ? ` — ${esc(note)}` : ''}`;

      if (type === 'expense' && user.budgets[cat]) {
        const m = monthKey(now);
        const used = user.tx
          .filter((x) => x.type === 'expense' && x.cat === cat && monthKey(x.t) === m)
          .reduce((a, x) => a + x.amt, 0);
        const limit = user.budgets[cat];
        const pct = Math.round((used / limit) * 100);
        out += `\n${bar(used / limit)} ${pct}% of ${esc(cat)} budget (${money(used, cur)} / ${money(limit, cur)})`;
        if (used > limit) out += `\n⚠️ Over budget by <b>${money(used - limit, cur)}</b>`;
        else if (pct >= 80) out += `\n⚠️ Only ${money(limit - used, cur)} left this month`;
      }
      return reply(out);
    }

    case 'balance': {
      const m = monthKey(now);
      let inc = 0, exp = 0, allInc = 0, allExp = 0;
      for (const x of user.tx) {
        const thisMonth = monthKey(x.t) === m;
        if (x.type === 'income') { allInc += x.amt; if (thisMonth) inc += x.amt; }
        else { allExp += x.amt; if (thisMonth) exp += x.amt; }
      }
      const rate = inc > 0 ? Math.round(((inc - exp) / inc) * 100) : null;
      return reply(
        `<b>📊 ${m}</b>\n` +
        `Income: ${money(inc, cur)}\n` +
        `Expenses: ${money(exp, cur)}\n` +
        `Net: <b>${money(inc - exp, cur)}</b>` +
        (rate !== null ? `\nSavings rate: ${rate}%` : '') +
        `\n\n<b>All time</b>\nNet: <b>${money(allInc - allExp, cur)}</b> (${user.tx.length} entries)`
      );
    }

    case 'report': {
      const m = args[0] && /^\d{4}-\d{2}$/.test(args[0]) ? args[0] : monthKey(now);
      const byCat = {};
      let total = 0, inc = 0;
      for (const x of user.tx) {
        if (monthKey(x.t) !== m) continue;
        if (x.type === 'income') { inc += x.amt; continue; }
        byCat[x.cat] = (byCat[x.cat] || 0) + x.amt;
        total += x.amt;
      }
      for (const c of Object.keys(user.budgets)) if (!(c in byCat)) byCat[c] = 0;
      const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
      if (!cats.length) return reply(`No expenses recorded for ${m}.`);
      const lines = cats.map(([c, v]) => {
        const b = user.budgets[c];
        if (b) {
          const flag = v > b ? ' ⚠️' : '';
          return `${bar(v / b)} <b>${esc(c)}</b> ${money(v, cur)} / ${money(b, cur)}${flag}`;
        }
        return `${bar(total ? v / total : 0)} <b>${esc(c)}</b> ${money(v, cur)} (${total ? Math.round((v / total) * 100) : 0}%)`;
      });
      return reply(
        `<b>🧾 Spending report ${m}</b>\n\n${lines.join('\n')}\n\n` +
        `Total spent: <b>${money(total, cur)}</b>\nIncome: ${money(inc, cur)}\nNet: <b>${money(inc - total, cur)}</b>`
      );
    }

    case 'budget': {
      if (!args.length) {
        const entries = Object.entries(user.budgets);
        if (!entries.length) return reply('No budgets yet. Set one with <code>/budget food 300</code>');
        const total = entries.reduce((a, [, v]) => a + v, 0);
        return reply(`<b>Monthly budgets</b>\n${entries.map(([c, v]) => `• ${esc(c)}: ${money(v, cur)}`).join('\n')}\n\nTotal: <b>${money(total, cur)}</b>`);
      }
      const cat = args[0].toLowerCase().slice(0, 32);
      const amt = parseAmount(args[1]);
      if (Number.isNaN(amt) || amt < 0) return reply('Usage: <code>/budget food 300</code> (use 0 to remove)');
      if (amt === 0) {
        delete user.budgets[cat];
        await save();
        return reply(`🗑 Removed budget for <b>${esc(cat)}</b>`);
      }
      user.budgets[cat] = amt;
      await save();
      return reply(`🎯 Budget for <b>${esc(cat)}</b> set to ${money(amt, cur)} / month`);
    }

    case 'history': {
      const n = Math.min(Math.max(parseInt(args[0], 10) || 10, 1), 50);
      if (!user.tx.length) return reply('No transactions yet. Try <code>12.5 food lunch</code>');
      const rows = user.tx.slice(-n).reverse().map((x) => {
        const d = new Date(x.t).toISOString().slice(0, 10);
        const s = x.type === 'income' ? '+' : '-';
        return `<code>${d}</code> ${s}${money(x.amt, cur)} ${esc(x.cat)}${x.note ? ` — ${esc(x.note)}` : ''}`;
      });
      return reply(`<b>Last ${rows.length} entries</b>\n${rows.join('\n')}`);
    }

    case 'undo': {
      const last = user.tx.pop();
      if (!last) return reply('Nothing to undo.');
      await save();
      return reply(`↩️ Removed ${last.type} of ${money(last.amt, cur)} (${esc(last.cat)})`);
    }

    case 'currency': {
      const c = (args[0] || '').toUpperCase();
      if (!/^[A-Z]{3}$/.test(c)) return reply(`Your currency is <b>${esc(cur)}</b>. Change it with <code>/currency EUR</code>`);
      user.currency = c;
      await save();
      return reply(`💱 Display currency set to <b>${c}</b>. (Existing amounts are not converted.)`);
    }

    case 'convert': {
      const amt = parseAmount(args[0]);
      const from = (args[1] || '').toUpperCase();
      const to = (args[2] || cur).toUpperCase();
      if (!(amt > 0) || !/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
        return reply('Usage: <code>/convert 100 USD EUR</code>');
      }
      if (!deps.rate) return reply('Currency conversion is not available right now.');
      try {
        const r = from === to ? 1 : await deps.rate(from, to);
        return reply(`💱 ${money(amt, from)} = <b>${money(amt * r, to)}</b>\n<i>1 ${from} = ${r.toFixed(4)} ${to}</i>`);
      } catch {
        return reply(`Couldn't get a rate for ${esc(from)} → ${esc(to)}. Check the currency codes.`);
      }
    }

    case 'loan': {
      const [p, rate, yrs] = args.map(parseAmount);
      if (!(p > 0) || !(rate >= 0) || !(yrs > 0)) return reply('Usage: <code>/loan 20000 6.5 5</code> (amount, annual rate %, years)');
      const pay = loanPayment(p, rate, yrs);
      const total = pay * Math.round(yrs * 12);
      return reply(
        `<b>🏦 Loan of ${money(p, cur)}</b> at ${rate}% for ${yrs} years\n` +
        `Monthly payment: <b>${money(pay, cur)}</b>\n` +
        `Total paid: ${money(total, cur)}\nTotal interest: ${money(total - p, cur)}`
      );
    }

    case 'goal': {
      const target = parseAmount(args[0]);
      const months = parseAmount(args[1]);
      const rate = args[2] != null ? parseAmount(args[2]) : 0;
      if (!(target > 0) || !(months >= 1) || !(rate >= 0)) return reply('Usage: <code>/goal 10000 24</code> (target, months, optional annual interest %)');
      const dep = goalDeposit(target, months, rate);
      return reply(
        `<b>🎯 Goal: ${money(target, cur)} in ${months} months</b>${rate ? ` at ${rate}%` : ''}\n` +
        `Save <b>${money(dep, cur)}</b> per month` +
        (rate ? `\nInterest earned: ${money(target - dep * months, cur)}` : '')
      );
    }

    case 'compound': {
      const [start, rate, yrs, monthly = 0] = args.map(parseAmount);
      if (!(start >= 0) || !(rate >= 0) || !(yrs > 0) || !(monthly >= 0)) {
        return reply('Usage: <code>/compound 1000 7 10 100</code> (start, annual %, years, optional monthly add)');
      }
      const fv = compound(start, rate, yrs, monthly);
      const contributed = start + monthly * Math.round(yrs * 12);
      return reply(
        `<b>📈 After ${yrs} years at ${rate}%</b>\n` +
        `Value: <b>${money(fv, cur)}</b>\n` +
        `You put in: ${money(contributed, cur)}\nGrowth: ${money(fv - contributed, cur)}`
      );
    }

    case 'export': {
      if (!user.tx.length) return reply('Nothing to export yet.');
      const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
      const csv = ['date,type,amount,currency,category,note']
        .concat(user.tx.map((x) => [new Date(x.t).toISOString(), x.type, x.amt.toFixed(2), cur, q(x.cat), q(x.note)].join(',')))
        .join('\n');
      return deps.tg.sendDocument(chatId, 'yuvizbot-transactions.csv', csv, `${user.tx.length} transactions`);
    }

    case 'reset': {
      if ((args[0] || '').toLowerCase() !== 'confirm') {
        return reply('⚠️ This deletes ALL your transactions and budgets.\nSend <code>/reset confirm</code> to proceed.');
      }
      await deps.store.put(key, emptyUser());
      return reply('🧹 All your data has been deleted.');
    }

    default:
      return reply('Unknown command. Send /help to see what I can do.');
  }
}
