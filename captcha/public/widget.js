/* =========================================================================
 * PCW —— Turnstile 式人机验证复选框（portal-captcha widget）
 * 用法（页面只需引入本文件 + widget.css，二者由 hub 提供）：
 *   <link rel="stylesheet" href="/api/captcha/assets/widget.css">
 *   <script src="/api/captcha/assets/widget.js" defer></script>
 *   <div data-pcw data-api="/api/captcha"></div>     ← 卡牌页用 data-api="/captcha"
 *
 * 交互流：
 *   页面加载即静默采集（motion-attestation collector，记录鼠标/触摸/击键节奏）
 *   → 用户点击「请验证您是真人」
 *   → POST init/verify（bot-signal 即时指纹随轨迹一并上送）
 *   → 分数达标：复选框转绿色「验证成功」，令牌就位（window.PCW.token()）
 *   → 分数不足：自动弹出 go-captcha 图片点选挑战，通过后同样拿到令牌
 *
 * 页面取令牌：window.PCW.token()（或监听 mount 元素上的 pcw:verified 事件）
 * 注册表单提交前检查 window.PCW.token() 是否非空。
 * ========================================================================= */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- 工具 */
  function qs(el, sel) { return el.querySelector(sel); }
  function post(api, path, body) {
    return fetch(api + '/' + path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().then(function (j) { j._status = r.status; return j; });
    });
  }
  function get(api, path) {
    return fetch(api + '/' + path, { credentials: 'include' })
      .then(function (r) { return r.json(); });
  }

  /* ---------------------------------------------------------------- 状态 */
  var widgets = [];      // 全部实例（一页一个，但支持多个）
  var widgetSeq = 0;

  function createWidget(mount) {
    var api = mount.getAttribute('data-api') || '/api/captcha';
    var lang = {
      label: '请验证您是真人',
      verifying: '验证中…',
      ok: '验证成功',
      fail: '验证失败，点击重试',
      challenge: '请完成图片点选',
      error: '服务暂不可用，点击重试',
    };

    var state = 'idle';   // idle | verifying | ok | error
    var token = null;
    var collector = null;
    var botSignal = null;
    var busy = false;

    /* ---- DOM ---- */
    mount.classList.add('pcw');
    var box = document.createElement('div');
    box.className = 'pcw-box';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', 'false');
    box.setAttribute('tabindex', '0');
    box.innerHTML =
      '<span class="pcw-mark" aria-hidden="true"></span>' +
      '<span class="pcw-label">' + lang.label + '</span>' +
      '<span class="pcw-state" aria-live="polite"></span>';
    var foot = null; // 已移除隐私提示行（2026-11-19 应站长要求）
    var chalPanel = document.createElement('div');
    chalPanel.className = 'pcw-chal';
    chalPanel.style.display = 'none';
    chalPanel.innerHTML =
      '<div class="pcw-gocap"></div>' +
      '<div class="pcw-chal-load"><span class="pcw-chal-spin"></span><span>加载中…</span></div>' +
      '<div class="pcw-chal-msg" aria-live="polite"></div>';
    mount.appendChild(box);
    mount.appendChild(chalPanel);

    function setUi(next, text) {
      state = next;
      box.className = 'pcw-box pcw--' + next;
      box.setAttribute('aria-checked', next === 'ok' ? 'true' : 'false');
      // 挑战进行中：对辅助技术也声明为禁用，屏蔽重复激活
      if (next === 'challenge') box.setAttribute('aria-disabled', 'true');
      else box.removeAttribute('aria-disabled');
      var st = qs(mount, '.pcw-state');
      st.textContent = text || '';
      box.title = next === 'ok' ? lang.ok : '';
    }

    /* ---- 采集器：页面打开即挂上（motion-attestation collector，ESM 动态导入） ---- */
    var collectorReady = false;
    import(api + '/assets/collector.js').then(function (m) {
      collector = m.createCollector();
      collector.attach();
      if (box) collector.bind(box, 'pcw-checkbox');
      collectorReady = true;
    }).catch(function () { collectorReady = false; });

    /* ---- bot-signal 即时检查（自动化指纹；加载失败则跳过） ---- */
    var bsiReady = false;
    import(api + '/assets/bot-signal.js').then(function (m) {
      botSignal = m;
      bsiReady = true;
    }).catch(function () { bsiReady = false; });

    function collectFlags() {
      if (!bsiReady || !botSignal || !botSignal.detectInstantClient) return [];
      try {
        var r = botSignal.detectInstantClient(window);
        var flags = [];
        var signals = (r && r.signals) || [];
        for (var i = 0; i < signals.length; i++) {
          if (signals[i] && signals[i].weight >= 0.8 && signals[i].name) flags.push(signals[i].name);
        }
        return flags;
      } catch (e) { return []; }
    }

    /* ---- 挑战面板（go-captcha-jslib 全局构建，懒加载；复选框下方内嵌展开，非全屏弹窗） ---- */
    var capt = null, challengeKey = null, ccid = null; // ccid：verify 低分后服务端签发的挑战续接凭证
    var lastCh = null; // 最近一次挑战数据（容器宽度变化重建组件时重灌）

    function loadGoCaptcha() {
      if (global.GoCaptcha) return Promise.resolve();
      return new Promise(function (resolve, reject) {
        if (!document.getElementById('pcw-gocap-css')) {
          var l = document.createElement('link');
          l.id = 'pcw-gocap-css';
          l.rel = 'stylesheet';
          l.href = api + '/assets/gocaptcha.global.css';
          document.head.appendChild(l);
        }
        var s = document.createElement('script');
        s.src = api + '/assets/gocaptcha.global.js';
        s.onload = function () { resolve(); };
        s.onerror = function () { reject(new Error('go-captcha 加载失败')); };
        document.head.appendChild(s);
      });
    }

    /* ---- 按当前容器宽度构建/重建点选组件 ----
     * 关键：go-captcha 根元素(.gc-wrapper)的内联宽度 = config.width + 26
     * （左右 padding 12×2 + showTheme 边框 2），图片内联宽度 = config.width。
     * 所以 config.width 必须按「gocap 容器实宽 - 26」分配，否则根元素比容器宽、
     * 右侧圆角和图片右缘会被 .pcw-gocap 的 overflow:hidden 裁掉（桌面端同样存在，窄屏才显眼）。
     * 容器宽度会变（弹窗滚动条、转屏），所以用 ResizeObserver 持续盯（见 createWidget 尾部），
     * 宽度变了就整只重建（主图等比缩放，点选坐标不受影响）。 */
    function buildCapt() {
      var cw = (lastCh && lastCh.width) || 300, chh = (lastCh && lastCh.height) || 220;
      var wrap = qs(chalPanel, '.pcw-gocap');
      var wrapW = (wrap && wrap.clientWidth > 50) ? wrap.clientWidth : cw;
      var w = Math.max(100, Math.min(cw, wrapW - 26)); // 26 = gc-wrapper 左右 padding(12×2) + 主题边框 2
      var h = Math.round(chh * w / cw);
      if (!capt || capt._pcwW !== w) {
        var wrap2 = wrap;
        wrap2.innerHTML = ''; // 旧组件按旧宽度渲染，直接重建
        capt = new global.GoCaptcha.Click({
          width: w,
          height: h,
          title: lang.challenge,
        });
        capt._pcwW = w;
        capt.mount(wrap2);
        capt.setEvents({
          confirm: function (dots, reset) {
            // 组件按「显示尺寸」（等比缩放后，如 238×175）采集点击坐标，
            // 服务端按「挑战原图」（如 300×220）校验，必须先按比例还原到原图坐标空间：
            // 缩放比 = 原图尺寸 / 显示尺寸（cw/w、chh/h 即该比值）
            // （2026-11-19 修：此前图片≈原尺寸时误差在容差内没暴露）
            var sx = cw / w, sy = chh / h;
            var pts = (dots || []).map(function (d) {
              return { x: Math.round(d.x * sx), y: Math.round(d.y * sy) };
            });
            post(api, 'challenge/verify', { key: challengeKey, dots: pts, ccid: ccid }).then(function (r) {
              if (r && r.ok && r.token) {
                finish(r.token);
              } else {
                // 点错即换新图：go-captcha key 一次校验即作废，原图已不可能通过，重试没有意义
                reset();
                renewChallenge();
                var m = qs(chalPanel, '.pcw-chal-msg');
                if (m) m.textContent = '点选不正确，已更换图片，请重新点选';
              }
            }).catch(function () { reset(); renewChallenge(); });
            return false;
          },
          refresh: function () { renewChallenge(); },
          close: function () { closeChallenge(); revert(); },
        });
      }
      // 注意：setData 必须在复用/重建两条路径上都执行——
      // 失败自动换图、手动刷新走的都是「复用 + 重灌新图」，放不进重建分支里（2026-11-19 修）
      if (lastCh) capt.setData({ image: lastCh.image, thumb: lastCh.thumb });
      return capt;
    }

    function openChallenge() {
      if (!ccid) { setUi('error', lang.error); return; }
      // 先展开面板并显示加载动画：弱网下拉挑战图（含 base64 大 JSON）可能要几秒，
      // 不能让面板空着像卡死（2026-11-19）
      chalPanel.style.display = 'block';
      chalPanel.classList.add('pcw-loading');
      loadGoCaptcha().then(function () {
        return get(api, 'challenge?ccid=' + encodeURIComponent(ccid));
      }).then(function (ch) {
        if (!ch || !ch.key || !ch.image) {
          // 会话失效（ccid 过期/网络抖动等）：复位到待验证态，重点一次即可
          revert();
          chalPanel.classList.remove('pcw-loading');
          return;
        }
        challengeKey = ch.key;
        lastCh = ch;
        chalPanel.classList.remove('pcw-loading');
        buildCapt(); // 面板可见后按最终布局（含滚动条）构建
        var m = qs(chalPanel, '.pcw-chal-msg');
        if (m) m.textContent = '';
      }).catch(function (e) {
        chalPanel.classList.remove('pcw-loading');
        setUi('error', lang.error);
      });
    }

    function renewChallenge() {
      if (!ccid) return;
      chalPanel.classList.add('pcw-loading'); // 换图期间旧图置灰 + 转圈
      get(api, 'challenge?ccid=' + encodeURIComponent(ccid)).then(function (ch) {
        if (!ch || !ch.key || !ch.image) { revert(); closeChallenge(); return; }
        challengeKey = ch.key;
        lastCh = ch;
        chalPanel.classList.remove('pcw-loading');
        buildCapt(); // 宽度没变则复用，重灌新图
        var m = qs(chalPanel, '.pcw-chal-msg');
        if (m) m.textContent = '';
      }).catch(function () {
        chalPanel.classList.remove('pcw-loading');
      });
    }

    function closeChallenge() { chalPanel.style.display = 'none'; chalPanel.classList.remove('pcw-loading'); }
    function revert() { token = null; ccid = null; setUi('idle'); }

    /* ---- 主流程 ---- */
    function finish(t) {
      token = t;
      ccid = null; // 令牌已就位，续接凭证随之作废
      closeChallenge();
      setUi('ok', '');
      try {
        mount.dispatchEvent(new CustomEvent('pcw:verified', { detail: { token: t }, bubbles: true }));
      } catch (e) { /* CustomEvent 兼容性兜底 */ }
    }

    function start() {
      if (busy) return;
      if (state === 'ok') return;
      // 挑战进行中锁定复选框（2026-11-19）：低分已转入图片挑战后，反复点击/回车
      // 会重复触发 verify，且键盘连按积累的行为事件可能反过来"凑够判决"直接通过——必须堵死
      if (state === 'challenge') return;
      busy = true;
      setUi('verifying', lang.verifying);

      var t0 = Date.now();
      var waitCollector = function (cb) {
        // collector.isReady()：≥3s 且有基本交互。没攒够也最多等 4s 再提交（交给评分器判）
        if (collectorReady && collector && collector.isReady()) return cb();
        if (Date.now() - t0 > 4000) return cb();
        setTimeout(function () { waitCollector(cb); }, 250);
      };

      waitCollector(function () {
        var d = (collector && collector.getData) ? collector.getData() : {};
        var flags = collectFlags();
        post(api, 'init', {}).then(function (r) {
          if (!r || !r.cid) throw new Error('init failed');
          return post(api, 'verify', { cid: r.cid, d: d, ts: Date.now(), bsi: flags });
        }).then(function (r) {
          busy = false;
          if (r && r.ok && r.token) { finish(r.token); return; }
          if (r && r.challenge) {
            ccid = r.ccid || null; // 后续拉图/点选校验必须携带
            setUi('challenge', lang.challenge); // 进入挑战态：复选框锁定，直到点选通过
            openChallenge();
            return;
          }
          if (r && r._status === 429) { setUi('error', r.error || lang.error); return; }
          setUi('error', lang.fail);
        }).catch(function () {
          busy = false;
          setUi('error', lang.error);
        });
      });
    }

    box.addEventListener('click', function () { start(); });
    box.addEventListener('keydown', function (e) {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); start(); }
    });

    /* 持续响应容器宽度变化：滚动条出现/消失、转屏、弹窗缩放都会触发，
     * 挑战面板展开中且宽度变了就按新宽度重建组件（buildCapt 内部有去抖：宽度相同直接复用） */
    if (typeof ResizeObserver !== 'undefined') {
      try {
        new ResizeObserver(function () {
          if (lastCh && chalPanel && chalPanel.style.display !== 'none') buildCapt();
        }).observe(mount);
      } catch (e) { /* 老浏览器无 RO：打开面板时的一次性测量兜底 */ }
    }

    var inst = {
      el: mount,
      token: function () { return token; },
      reset: function () { revert(); },
      api: api,
    };
    inst._id = ++widgetSeq;
    widgets.push(inst);
    mount._pcw = inst;
    return inst;
  }

  /* ---------------------------------------------------------------- 启动 */
  function boot() {
    var nodes = document.querySelectorAll('[data-pcw]');
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i]._pcw) createWidget(nodes[i]);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.PCW = {
    token: function () {
      for (var i = 0; i < widgets.length; i++) {
        var t = widgets[i].token();
        if (t) return t;
      }
      return null;
    },
    reset: function () {
      // 注册失败（如用户名被占用）后调用：复选框回到待验证态，用户重新点一下即可（采集器一直挂着，重验很快）
      for (var i = 0; i < widgets.length; i++) widgets[i].reset();
    },
    widgets: widgets,
    boot: boot,
  };
})(window);
