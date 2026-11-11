import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleUpdate, loanPayment, goalDeposit, compound, parseAmount } from '../src/bot.js';

function harness(now = Date.UTC(2026, 10, 11)) {
  const db = new Map();
  const sent = [];
  const docs = [];
  const deps = {
    store: { get: async (k) => (db.has(k) ? structuredClone(db.get(k)) : null), put: async (k, v) => db.set(k, structuredClone(v)) },
    tg: {
      sendMessage: async (chatId, text) => sent.push(text),
      sendDocument: async (chatId, name, content) => docs.push({ name, content }),
    },
    rate: async (from, to) => (from === 'USD' && to === 'EUR' ? 0.9 : Promise.reject(new Error('x'))),
    now: () => now,
  };
  const say = async (text) => {
    await handleUpdate({ message: { chat: { id: 42 }, text } }, deps);
    return sent.at(-1);
  };
  return { say, sent, docs, db };
}

test('parseAmount', () => {
  assert.equal(parseAmount('12.50'), 12.5);
  assert.equal(parseAmount('$1,200'), 1200);
  assert.ok(Number.isNaN(parseAmount('abc')));
  assert.ok(Number.isNaN(parseAmount('1e5')));
});

test('help', async () => {
  const { say } = harness();
  assert.match(await say('/start'), /Yuvizbot/);
  assert.match(await say('/help@Yuvizbot'), /\/spent/);
});

test('log expenses and income, balance', async () => {
  const { say } = harness();
  assert.match(await say('/spent 12.50 food lunch'), /12\.50 USD.*food.*lunch/);
  assert.match(await say('30 transport'), /Spent.*30\.00 USD.*transport/);
  assert.match(await say('+2000 salary'), /Earned.*2,000\.00 USD/);
  const bal = await say('/balance');
  assert.match(bal, /Income: 2,000\.00 USD/);
  assert.match(bal, /Expenses: 42\.50 USD/);
  assert.match(bal, /Net: <b>1,957\.50 USD/);
  assert.match(bal, /Savings rate: 98%/);
});

test('budget warnings', async () => {
  const { say } = harness();
  assert.match(await say('/budget food 100'), /set to 100\.00 USD/);
  assert.match(await say('/spent 85 food'), /85% of food budget.*\n.*Only 15\.00 USD left/);
  assert.match(await say('/spent 20 food'), /Over budget by <b>5\.00 USD/);
  assert.match(await say('/budget'), /food: 100\.00 USD/);
  assert.match(await say('/report'), /food<\/b> 105\.00 USD \/ 100\.00 USD ⚠️/);
  assert.match(await say('/budget food 0'), /Removed/);
});

test('report filters by month', async () => {
  const h1 = harness(Date.UTC(2026, 9, 5));
  await h1.say('/spent 10 food');
  assert.match(await h1.say('/report 2026-10'), /food<\/b> 10\.00 USD/);
  assert.match(await h1.say('/report 2026-09'), /No expenses/);
});

test('history, undo, export, reset', async () => {
  const { say, docs } = harness();
  await say('/spent 5 coffee "flat white"');
  await say('/spent 7 snacks');
  assert.match(await say('/history'), /snacks[\s\S]*coffee/);
  assert.match(await say('/undo'), /Removed expense of 7\.00 USD/);
  await say('/export');
  assert.equal(docs.length, 1);
  assert.match(docs[0].content, /^date,type,amount/);
  assert.match(docs[0].content, /"coffee","""flat white"""/);
  assert.match(await say('/reset'), /confirm/);
  assert.match(await say('/reset confirm'), /deleted/);
  assert.match(await say('/history'), /No transactions/);
});

test('escapes HTML in user input', async () => {
  const { say } = harness();
  assert.match(await say('/spent 1 <b>x</b> <script>'), /&lt;b&gt;x&lt;\/b&gt;.*&lt;script&gt;/);
});

test('currency and convert', async () => {
  const { say } = harness();
  assert.match(await say('/currency eur'), /EUR/);
  assert.match(await say('/spent 3 food'), /3\.00 EUR/);
  assert.match(await say('/convert 100 USD EUR'), /90\.00 EUR/);
  assert.match(await say('/convert 100 USD XYZ'), /Couldn't get a rate/);
  assert.match(await say('/convert abc'), /Usage/);
});

test('calculators', async () => {
  assert.ok(Math.abs(loanPayment(20000, 6.5, 5) - 391.32) < 0.01);
  assert.equal(loanPayment(1200, 0, 1), 100);
  assert.equal(goalDeposit(1200, 12), 100);
  assert.ok(goalDeposit(10000, 24, 4) < 10000 / 24);
  assert.equal(compound(1000, 0, 1, 100), 2200);
  assert.ok(Math.abs(compound(1000, 12, 1) - 1126.83) < 0.01);
  const { say } = harness();
  assert.match(await say('/loan 20000 6.5 5'), /Monthly payment: <b>391\.32 USD/);
  assert.match(await say('/goal 1200 12'), /100\.00 USD<\/b> per month/);
  assert.match(await say('/compound 1000 7 10 100'), /Value: <b>/);
  assert.match(await say('/loan'), /Usage/);
});

test('unknown input', async () => {
  const { say } = harness();
  assert.match(await say('hello'), /didn't catch/);
  assert.match(await say('/nope'), /Unknown command/);
});

test('ignores non-text updates', async () => {
  const { sent } = harness();
  await handleUpdate({ message: { chat: { id: 1 }, photo: [] } }, { store: {}, tg: {} });
  await handleUpdate({ callback_query: {} }, { store: {}, tg: {} });
  assert.equal(sent.length, 0);
});
