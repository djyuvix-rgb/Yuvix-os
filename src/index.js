// Cloudflare Worker entry point: receives Telegram webhooks and stores data in KV.
import { handleUpdate, COMMANDS } from './bot.js';

const API = 'https://api.telegram.org';

// The webhook secret is derived from the bot token, so only one secret is needed.
async function webhookSecret(token) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`yuvizbot:${token}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

function telegram(token) {
  const call = async (method, body) => {
    const res = await fetch(`${API}/bot${token}/${method}`, body instanceof FormData
      ? { method: 'POST', body }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) console.error(`Telegram ${method} failed:`, data.description);
    return data;
  };
  return {
    call,
    sendMessage: (chat_id, text) =>
      call('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    sendDocument: (chat_id, filename, content, caption) => {
      const form = new FormData();
      form.append('chat_id', String(chat_id));
      form.append('caption', caption || '');
      form.append('document', new Blob([content], { type: 'text/csv' }), filename);
      return call('sendDocument', form);
    },
  };
}

function kvStore(kv) {
  return {
    get: (k) => kv.get(k, 'json'),
    put: (k, v) => kv.put(k, JSON.stringify(v)),
  };
}

// Free exchange rates, no API key (European Central Bank data).
async function rate(from, to) {
  const res = await fetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
  if (!res.ok) throw new Error(`rate ${res.status}`);
  const data = await res.json();
  const r = data.rates && data.rates[to];
  if (typeof r !== 'number') throw new Error('no rate');
  return r;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) return new Response('TELEGRAM_BOT_TOKEN is not set', { status: 500 });
    const secret = await webhookSecret(token);
    const tg = telegram(token);

    if (request.method === 'POST' && url.pathname === '/webhook') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await request.json();
      try {
        await handleUpdate(update, { store: kvStore(env.DATA), tg, rate });
      } catch (err) {
        console.error(err);
        const chatId = update.message?.chat?.id;
        if (chatId) await tg.sendMessage(chatId, 'Sorry, something went wrong. Please try again.');
      }
      return new Response('ok');
    }

    // One-time setup: registers the webhook and the command menu.
    // Protected by the derived secret: /setup?key=<secret>
    if (url.pathname === '/setup') {
      if (url.searchParams.get('key') !== secret) return new Response('forbidden', { status: 403 });
      const hook = await tg.call('setWebhook', {
        url: `${url.origin}/webhook`,
        secret_token: secret,
        allowed_updates: ['message', 'edited_message'],
        drop_pending_updates: false,
      });
      const cmds = await tg.call('setMyCommands', {
        commands: COMMANDS.map(([command, description]) => ({ command, description })),
      });
      return Response.json({ webhook: hook, commands: cmds });
    }

    return new Response('Yuvizbot is running.');
  },
};
