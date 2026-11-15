'use strict';

/**
 * Page bridge: the only part of this project that touches the live web page.
 *
 * It exists because the official site is a UI, not an API. To let a local agent
 * use it, something has to type into the composer and read the answer back out.
 * That is exactly what this file does - nothing else. It never reads cookies,
 * tokens, or account data, and it never calls any DeepSeek endpoint itself.
 *
 * Every selector here is written defensively (`pickComposer`, `pickSendButton`,
 * `readMessages`) because DeepSeek ships new builds with hashed class names.
 * If the page changes, the agent stops with a readable error instead of typing
 * into the void.
 */

/* ------------------------------------------------------------------ */
/* selectors                                                           */
/* ------------------------------------------------------------------ */

// Injected helpers are plain functions serialised by executeJavaScript, so they
// must be self-contained: no imports, no closures over Node values.
const HELPERS = String.raw`
  const __pickComposer = () => {
    const areas = [...document.querySelectorAll('textarea')]
      .filter((t) => !t.disabled && !t.readOnly && t.offsetParent !== null);
    if (!areas.length) return null;
    // The chat composer is the widest visible textarea.
    areas.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    return areas[0];
  };

  const __pickSendButton = () => {
    const boxes = [...document.querySelectorAll('div.ds-button, button')]
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 20 && r.height > 20 && r.width < 80 && b.offsetParent !== null;
      });
    // The send control is a filled circle sitting right of the composer.
    const scored = boxes.map((b) => {
      const cls = String(b.className || '');
      let score = 0;
      if (/primary/.test(cls)) score += 3;
      if (/circle/.test(cls)) score += 3;
      if (/filled/.test(cls)) score += 2;
      if (!/disabled/.test(cls)) score += 2;
      const r = b.getBoundingClientRect();
      score += r.x / 1000; // right-most wins ties
      return { b, score, cls };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.length ? scored[0] : null;
  };

  const __isSendDisabled = (b) => {
    if (!b) return true;
    const cls = String(b.className || '');
    return /disabled/.test(cls) || b.getAttribute('aria-disabled') === 'true' || b.disabled === true;
  };

  const __messageRoots = () => [...document.querySelectorAll('div.ds-message')];

  const __textOf = (root) => {
    const md = [...root.querySelectorAll('.ds-markdown')];
    if (md.length) return md.map((n) => n.innerText.trim()).filter(Boolean).join('\n\n').trim();
    return (root.innerText || '').trim();
  };
`;

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

// Read the composer's current text (used to detect the moment sending cleared it).
const READ_COMPOSER = `(() => {
  ${HELPERS}
  const ta = __pickComposer();
  return ta ? ta.value : null;
})()`;

// Type text into the composer the way a human would: set the value through the
// native setter (React tracks its own copy) then fire the events React listens
// to, so the send button actually lights up.
const TYPE_TEXT = (text) => `(() => {
  ${HELPERS}
  const ta = __pickComposer();
  if (!ta) return { ok: false, error: 'composer-not-found' };
  const proto = Object.getPrototypeOf(ta);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  ta.focus();
  if (desc && desc.set) desc.set.call(ta, ${JSON.stringify(text)});
  else ta.value = ${JSON.stringify(text)};
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: ta.value.length };
})()`;

// Press the send button. Returns whether it was clickable at all, so the caller
// can distinguish "page busy" from "nothing to send".
const CLICK_SEND = `(() => {
  ${HELPERS}
  const picked = __pickSendButton();
  if (!picked) return { ok: false, error: 'send-button-not-found' };
  if (__isSendDisabled(picked.b)) return { ok: false, error: 'send-disabled', cls: picked.cls };
  picked.b.click();
  return { ok: true, cls: picked.cls };
})()`;

// Conversation snapshot: how many assistant messages, their text, and whether
// anything still looks like it is streaming.
const SNAPSHOT = `(() => {
  ${HELPERS}
  const roots = __messageRoots();
  const msgs = roots.map((r) => {
    const cls = String(r.className || '');
    return {
      text: __textOf(r),
      // The site marks the assistant's own turns differently from the user's;
      // a user turn is one whose text we just sent, so callers compare instead.
      hasThink: !!r.querySelector('.ds-think-content'),
      len: (r.innerText || '').length,
    };
  });
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  return {
    count: msgs.length,
    msgs,
    compserEmpty: (() => { const ta = __pickComposer(); return ta ? ta.value.trim() === '' : null; })(),
    stopVisible: [...document.querySelectorAll('div.ds-button, button')].some((b) => {
      const cls = String(b.className || '');
      const r = b.getBoundingClientRect();
      return r.width > 20 && r.height > 20 && /circle/.test(cls) && !/primary/.test(cls) && b.offsetParent !== null;
    }),
    lastLen: last ? last.len : 0,
    lastText: last ? last.text : '',
    lastHead: last ? last.text.slice(0, 120) : '',
  };
})()`;

/* ------------------------------------------------------------------ */
/* host side                                                           */
/* ------------------------------------------------------------------ */

const POLL_MS = 1200;
const SEND_CONFIRM_TIMEOUT_MS = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(wc, code) {
  if (!wc || wc.isDestroyed()) throw new Error('window is gone');
  return wc.executeJavaScript(code, true);
}

/**
 * Send one user turn and wait for the assistant's reply.
 *
 * Returns { ok, reply } or { ok:false, error, detail }. Never throws for
 * ordinary page-level failures; the caller logs them.
 */
async function sendAndWaitForReply(wc, text, options = {}) {
  const {
    onProgress = () => {},
    timeoutMs = 300000,
    settleMs = 2500,
    signal = null,
  } = options;

  const before = await evaluate(wc, SNAPSHOT);
  const baseCount = before.count;
  // The transcript is virtualised: old turns get unmounted as it grows, so
  // counting messages is unreliable. Instead remember what the last bubble
  // looked like before we sent, and treat "the tail is no longer that bubble"
  // as "a new answer exists".
  const previousTail = { text: before.lastText || '', len: before.lastLen || 0 };

  const typed = await evaluate(wc, TYPE_TEXT(text));
  if (!typed || !typed.ok) {
    return { ok: false, error: 'type-failed', detail: typed };
  }

  // Give React a beat to re-enable the send button.
  let clicked = null;
  const deadline = Date.now() + SEND_CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    clicked = await evaluate(wc, CLICK_SEND);
    if (clicked && clicked.ok) break;
    if (clicked && clicked.error === 'send-button-not-found') break;
    await sleep(400);
  }
  if (!clicked || !clicked.ok) {
    return { ok: false, error: 'send-failed', detail: clicked };
  }

  onProgress('sent');

  // Wait for the composer to clear, so we know the turn was accepted.
  const clearDeadline = Date.now() + 15000;
  let cleared = false;
  while (Date.now() < clearDeadline) {
    const value = await evaluate(wc, READ_COMPOSER);
    if (value !== null && value.trim() === '') { cleared = true; break; }
    await sleep(300);
  }

  onProgress(cleared ? 'accepted' : 'accepted-unclear');

  // Poll until the transcript tail is a new, settled assistant message.
  const hardDeadline = Date.now() + timeoutMs;
  let lastLen = -1;
  let stableSince = 0;
  let lastSnapshot = null;
  const startedAt = Date.now();

  while (Date.now() < hardDeadline) {
    if (signal && signal.aborted) return { ok: false, error: 'aborted' };

    const snap = await evaluate(wc, SNAPSHOT);
    lastSnapshot = snap;

    const tailText = snap.lastText || '';
    const isNewTail =
      tailText.length > 0 &&
      tailText !== previousTail.text &&
      !tailText.startsWith(previousTail.text.slice(0, 80));
    const grew = snap.count > baseCount;

    if ((isNewTail || grew) && snap.lastLen > 0) {
      const len = snap.lastLen;
      if (len !== lastLen) {
        lastLen = len;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= settleMs && !snap.stopVisible) {
        const last = snap.msgs[snap.msgs.length - 1];
        return {
          ok: true,
          reply: last.text,
          stats: { turns: snap.count - baseCount, len, ms: Date.now() - startedAt },
        };
      }
    }

    onProgress('waiting', { turns: Math.max(0, snap.count - baseCount), len: snap.lastLen });

    await sleep(POLL_MS);
  }

  return {
    ok: false,
    error: 'timeout',
    detail: lastSnapshot
      ? {
          count: lastSnapshot.count,
          lastLen: lastSnapshot.lastLen,
          lastHead: lastSnapshot.lastHead,
          previousTail: previousTail.text.slice(0, 120),
        }
      : null,
  };
}

module.exports = { sendAndWaitForReply, SNAPSHOT, POLL_MS };
