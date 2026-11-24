/**
 * mailverify-widget.js —— 邮箱验证码前端组件（可迁移套件 · 零依赖，自注入样式）
 *
 * 用途：给注册表单加「邮箱验证码」环节。配套服务端 portal-mail-verify（:5113），
 *       需要站点把对外前缀（如 /api/mailv/ 或 /mailv/）反代到该服务。
 *
 * 接入（2 行）：
 *   <div id="mvMount"></div>
 *   <script src="/js/mailverify-widget.js?v=20261119" defer></script>
 *   （页面 JS 里）var MV = MailVerify.mount(document.getElementById('mvMount'), {
 *     api: '/api/mailv',                       // 本站可用的服务前缀
 *     getCaptchaToken: function () { return window.PCW && PCW.token() || ''; },
 *     captchaMount: document.querySelector('[data-pcw]'),   // 可选：人机验证挂载点（联动启停）
 *     onCaptchaConsumed: function () { window.PCW && PCW.reset(); },  // 发送已烧毁令牌后复位
 *     onNeedCaptcha: function () { 高亮人机验证区等 },
 *   });
 *
 * 注册提交时：
 *   var r = await MV.verify();          // → {ok:true, receipt, email} 或 {ok:false, error}
 *   // 把 r.receipt 与 MV.email() 随注册表单上送；后端验签 + 烧毁后建号
 *
 * 行为细节：
 *  - 发送按钮联动人机验证：未拿到 PCW 令牌时禁用（用户没过人机验证就点不了）
 *  - 发送成功：右侧提示「XX秒后可重新发送」倒计时（服务端同步强校 60s），
 *    倒计时结束按钮变「重新发送」，并回调 onCaptchaConsumed 让页面复位 PCW
 *  - 左侧固定提示「如未收到验证码，请到垃圾箱查看邮件」
 *  - 主题：通过 CSS 变量 --mvw-fg / --mvw-border / --mvw-input-bg 等适配页面
 */
(function () {
  'use strict';
  if (window.MailVerify) return;

  var CSS = [
    '.mvw{font-size:13px}',
    '.mvw-row{display:flex;gap:8px;align-items:stretch}',
    '.mvw-email{flex:1;min-width:0;padding:8px 12px;font-size:13.5px;border-radius:8px;outline:none;',
      'background:var(--mvw-input-bg,#fff);color:var(--mvw-fg,#151515);border:1px solid var(--mvw-border,rgba(0,0,0,.15));',
      'font-family:inherit;transition:border-color .12s,box-shadow .12s}',
    '.mvw-email:focus{border-color:var(--mvw-accent,#d4568f);box-shadow:0 0 0 1.5px var(--mvw-accent-mid,rgba(212,86,143,.3))}',
    '.mvw-send{flex:0 0 auto;padding:8px 14px;font-size:12.5px;font-weight:500;border-radius:8px;cursor:pointer;',
      'border:1px solid var(--mvw-border,rgba(0,0,0,.15));background:var(--mvw-btn-bg,#fff);color:var(--mvw-fg,#151515);',
      'font-family:inherit;white-space:nowrap;transition:background .12s,opacity .12s}',
    '.mvw-send:hover{background:var(--mvw-hover,#efeeea)}',
    '.mvw-send:disabled{opacity:.45;cursor:not-allowed}',
    '.mvw-hints{display:flex;gap:8px;justify-content:space-between;align-items:baseline;flex-wrap:wrap;',
      'margin:5px 2px 0;font-size:11.5px;color:var(--mvw-muted,#8a8a86)}',
    '.mvw-code{margin-top:8px;width:100%;padding:8px 12px;font-size:13.5px;border-radius:8px;outline:none;',
      'background:var(--mvw-input-bg,#fff);color:var(--mvw-fg,#151515);border:1px solid var(--mvw-border,rgba(0,0,0,.15));',
      'font-family:inherit;letter-spacing:2px;transition:border-color .12s,box-shadow .12s}',
    '.mvw-code:focus{border-color:var(--mvw-accent,#d4568f);box-shadow:0 0 0 1.5px var(--mvw-accent-mid,rgba(212,86,143,.3))}',
    '.mvw-msg{margin-top:6px;font-size:12px;min-height:16px}',
    '.mvw-msg.err{color:var(--mvw-err,#d9564a)}',
    '.mvw-msg.ok{color:var(--mvw-ok,#3d9a50)}',
    '@media (max-width:560px){.mvw-hints{flex-direction:column;gap:2px}}',
  ].join('');

  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function mount(container, opts) {
    opts = opts || {};
    var api = (opts.api || '/api/mailv').replace(/\/+$/, '');
    var state = { email: '', receipt: null, countdown: 0, timer: null, sending: false };

    container.classList.add('mvw');
    var row = el('div', 'mvw-row');
    var emailIn = el('input', 'mvw-email');
    emailIn.type = 'email';
    emailIn.placeholder = opts.emailPlaceholder || '用于接收验证码的邮箱';
    emailIn.autocomplete = 'email';
    var sendBtn = el('button', 'mvw-send', '发送验证码');
    sendBtn.type = 'button';
    row.appendChild(emailIn);
    row.appendChild(sendBtn);

    var hints = el('div', 'mvw-hints');
    var hintLeft = el('span', 'mvw-hint-left', opts.leftHint || '如未收到验证码，请到垃圾箱查看邮件');
    var hintRight = el('span', 'mvw-hint-right', opts.rightHint || '没有邮箱？请用您的QQ号@qq.com');
    hints.appendChild(hintLeft);
    hints.appendChild(hintRight);

    var codeIn = el('input', 'mvw-code');
    codeIn.type = 'text';
    codeIn.inputMode = 'numeric';
    codeIn.maxLength = 6;
    codeIn.placeholder = '6 位邮箱验证码';

    var msg = el('div', 'mvw-msg');

    container.appendChild(row);
    container.appendChild(hints);
    container.appendChild(codeIn);
    container.appendChild(msg);

    function say(text, cls) {
      msg.textContent = text || '';
      msg.className = 'mvw-msg' + (cls ? ' ' + cls : '');
    }

    function captchaToken() {
      try { return (opts.getCaptchaToken && opts.getCaptchaToken()) || ''; } catch (_) { return ''; }
    }

    /** 发送按钮：有人机验证令牌才可用（用户没过人机验证就点不了） */
    function updateSendBtn() {
      if (state.countdown > 0 || state.sending) return;
      sendBtn.disabled = !captchaToken();
    }

    // 联动人机验证：令牌就位事件 + 兜底轮询
    if (opts.captchaMount && typeof opts.captchaMount.addEventListener === 'function') {
      opts.captchaMount.addEventListener('pcw:verified', updateSendBtn);
    }
    var poll = setInterval(updateSendBtn, 700);
    updateSendBtn();

    function startCountdown(sec) {
      state.countdown = sec;
      sendBtn.disabled = true;
      sendBtn.textContent = '发送中…';
      clearInterval(state.timer);
      state.timer = setInterval(function () {
        state.countdown -= 1;
        if (state.countdown <= 0) {
          clearInterval(state.timer);
          state.countdown = 0;
          sendBtn.textContent = opts.resendText || '重新发送';
          hintRight.textContent = opts.rightHint || '没有邮箱？请用您的QQ号@qq.com';
          updateSendBtn();
        } else {
          sendBtn.textContent = state.countdown + ' 秒后可重新发送';
        }
      }, 1000);
    }

    sendBtn.addEventListener('click', function () {
      if (state.sending || state.countdown > 0) return;
      var email = emailIn.value.trim();
      if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[A-Za-z]{2,24}$/.test(email)) {
        say('请输入正确的邮箱地址', 'err');
        emailIn.focus();
        return;
      }
      var token = captchaToken();
      if (!token) {
        say('请先完成人机验证', 'err');
        if (opts.onNeedCaptcha) opts.onNeedCaptcha();
        return;
      }
      state.sending = true;
      sendBtn.disabled = true;
      sendBtn.textContent = '发送中…';
      say('');
      fetch(api + '/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, captchaToken: token }),
      }).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
        .then(function (o) {
          state.sending = false;
          if (o.s === 200 && o.j && o.j.ok) {
            state.email = email;
            say('验证码已发送，请查收邮件', 'ok');
            startCountdown(o.j.cooldown || 60);
            if (opts.onCaptchaConsumed) opts.onCaptchaConsumed(); // 令牌已被烧毁，页面复位 PCW
            codeIn.focus();
          } else {
            sendBtn.textContent = '发送验证码';
            updateSendBtn();
            say((o.j && o.j.error) || ('发送失败 (HTTP ' + o.s + ')'), 'err');
            // 人机验证被拒/失效 → 复位复选框让用户重验
            if (opts.onCaptchaFail && /人机验证/.test((o.j && o.j.error) || '')) opts.onCaptchaFail();
          }
        })
        .catch(function () {
          state.sending = false;
          sendBtn.textContent = '发送验证码';
          updateSendBtn();
          say('网络错误，请稍后重试', 'err');
        });
    });

    /** 校验验证码 → 换取一次性收据（注册提交前调用） */
    function verify() {
      var email = emailIn.value.trim();
      var code = codeIn.value.trim();
      if (!email || !code) return Promise.resolve({ ok: false, error: '请输入接收邮箱和验证码' });
      return fetch(api + '/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, code: code }),
      }).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
        .then(function (o) {
          if (o.s === 200 && o.j && o.j.ok) {
            state.receipt = o.j.receipt;
            state.email = o.j.email || email;
            say('邮箱验证通过', 'ok');
            return { ok: true, receipt: o.j.receipt, email: state.email };
          }
          say((o.j && o.j.error) || ('验证失败 (HTTP ' + o.s + ')'), 'err');
          return { ok: false, error: (o.j && o.j.error) || '验证失败' };
        })
        .catch(function () { return { ok: false, error: '网络错误，请稍后重试' }; });
    }

    return {
      /** 当前填写并（可能）已验证的邮箱 */
      email: function () { return emailIn.value.trim(); },
      /** 校验验证码并返回 {ok, receipt?, error?}，receipt 有效期 15 分钟、注册成功前由后端烧毁 */
      verify: verify,
      /** 校验是否已通过（拿过收据） */
      verified: function () { return !!state.receipt; },
      /** 锁定/解锁整个组件（注册提交期间用） */
      lock: function (on) {
        [emailIn, codeIn, sendBtn].forEach(function (e) { e.disabled = !!on; });
        if (!on) updateSendBtn();
      },
      /** 复位（注册失败、切换面板时用） */
      reset: function () {
        clearInterval(state.timer);
        state = { email: '', receipt: null, countdown: 0, timer: null, sending: false };
        emailIn.value = ''; codeIn.value = '';
        sendBtn.textContent = '发送验证码';
        hintRight.textContent = opts.rightHint || '没有邮箱？请用您的QQ号@qq.com';
        say('');
        updateSendBtn();
      },
    };
  }

  window.MailVerify = { mount: mount, version: '20261119' };
})();
