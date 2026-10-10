/* ==========================================================================
   dsh-violet-boot — 薇尔莉特主题开机动画（行为层）
   作为内联 classic script 注入在 <body> 开头之后，因此先于 shell 的 module
   脚本执行：我们自己搭舞台，同时把原生 boot 遮罩当作“真实进度 + 结束信号”
   的传感器来用。
   结束条件（任一满足即收尾，绝不停留）：
     1) 用户点击 / 按键（可关闭）
     2) 原生遮罩曾出现且已消失，且已达到最短播放时长  → 应用已挂载
     3) 达到最长播放时长（兜底，避免永久遮挡界面）
   本文件作为内联脚本注入，因此整个文件里不得出现脚本闭合标签的字面量
   （写成 "<" + "/script" 也不行——校验是纯字符串匹配）。
   ========================================================================== */
(function () {
  "use strict";
  if (window.__veBoot && window.__veBoot.version) return;

  var DEFAULTS = {
    minDurationMs: 2500,
    maxDurationMs: 20000,
    outroMs: 760,
    sweepMs: 700,
    skippable: true,
    wordmark: "",
    subtitle: "",
    seal: false,
    hint: "Loading plugins…",
    typedCharMs: 135,
    letters: 12,
    motes: 26
  };

  var cfg = {};
  var given = window.__VIOLET_BOOT__ || {};
  for (var k in DEFAULTS) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
      cfg[k] = given[k] === undefined || given[k] === null ? DEFAULTS[k] : given[k];
    }
  }

  /* 尊重系统的“减弱动效”：不剥夺这段开场，但把它压到最短，不让人被迫等。 */
  var reduceMotion = false;
  try {
    reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (e) {
    reduceMotion = false;
  }
  if (reduceMotion) cfg.minDurationMs = Math.min(cfg.minDurationMs, 900);

  /* 0.1.x 的主角是一台手绘打字机（SVG），0.2.x 是一张“人像信笺”。
     0.3.0 起回到那张照片本身的样子：纯白底、人物居中，其余什么都不加。
     版面文案默认不出现（画面干净优先）；把 wordmark / subtitle 配成非空字符串
     就会把「逐字敲出的字样」和「副标题」加回来，排在画像下方。 */
  var typedMarkup = cfg.wordmark
    ? '<div class="ve-typedrow"><span class="ve-typed"></span><span class="ve-caret"></span></div>'
    : "";
  var captionMarkup = cfg.subtitle ? '<div class="ve-caption"><span class="ve-sub"></span></div>' : "";
  /* 火漆印：加载完成时盖在右下角；seal: false 就完全不出现。 */
  var sealMarkup = cfg.seal === false ? "" : '<div class="ve-seal"></div>';

  var MARKUP =
    '<div class="ve-vig"></div>' +
    '<div class="ve-rays"></div>' +
    '<div class="ve-motes"></div>' +
    '<div class="ve-letters"></div>' +
    '<div class="ve-stage">' +
    '<div class="ve-bloom"></div>' +
    '<div class="ve-portrait">' +
    '<div class="ve-photo" role="img" aria-label="Violet Evergarden"></div>' +
    "</div>" +
    typedMarkup +
    '<div class="ve-desk"><i class="ve-deskfill"></i><i class="ve-deskhead"></i></div>' +
    captionMarkup +
    '<div class="ve-hintline"><span class="ve-hinttext"></span><span class="ve-pct"></span></div>' +
    "</div>" +
    sealMarkup +
    '<div class="ve-sweep"></div>';

  var startedAt = Date.now();
  var root = null;
  var typedEl = null;
  var pctEl = null;
  var typedRow = null;
  var typed = 0;
  var shown = 0;
  var target = 0;
  var frozen = false;
  var finished = false;
  var finishedAt = 0;
  var released = false;
  var sawOverlay = false;
  var skipRequested = false;
  var rafId = 0;
  var tickId = 0;
  var overlayObserver = null;
  var failSeen = false;

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function stockOverlay() {
    return document.querySelector("[data-dsh-boot]");
  }

  /** 应用是否已经挂载出内容——没有原生遮罩时的“加载完成”判据。 */
  function appMounted() {
    var host = document.getElementById("root");
    if (host && host.childElementCount > 0) return true;
    return false;
  }

  /* 原生遮罩的生命周期可能短于一帧取样间隔，用观察器把它“看见过”这件事锁死，
     否则快速加载时我们会误判成“遮罩从未出现”而不必要地多挡 20 秒。 */
  function watchOverlay() {
    if (typeof window.MutationObserver !== "function") return null;
    var observer = new window.MutationObserver(function () {
      if (!sawOverlay && stockOverlay()) sawOverlay = true;
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    if (stockOverlay()) sawOverlay = true;
    return observer;
  }

  /** 原生遮罩上的环形进度 → 0..1。72deg 起步，满值 288deg。 */
  function readProgress() {
    var spinner = document.querySelector("[data-dsh-boot-spinner]");
    if (!spinner) return null;
    var raw = spinner.style.getPropertyValue("--dsh-boot-arc");
    if (!raw) raw = window.getComputedStyle(spinner).getPropertyValue("--dsh-boot-arc");
    var deg = parseFloat(raw);
    if (!isFinite(deg)) return null;
    var p = (deg - 72) / 216;
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  function spawnDecor() {
    var motes = root.querySelector(".ve-motes");
    var html = "";
    for (var i = 0; i < cfg.motes; i += 1) {
      html +=
        '<i class="ve-mote" style="--x:' +
        rand(4, 96).toFixed(2) +
        "%;--y:" +
        rand(28, 92).toFixed(2) +
        "%;--s:" +
        rand(1.6, 3.4).toFixed(1) +
        "px;--dx:" +
        rand(-26, 26).toFixed(0) +
        "px;--dur:" +
        rand(7, 15).toFixed(1) +
        "s;--delay:" +
        rand(0, 9).toFixed(1) +
        's"></i>';
    }
    motes.innerHTML = html;

    var letters = root.querySelector(".ve-letters");
    html = "";
    for (var j = 0; j < cfg.letters; j += 1) {
      html +=
        '<i class="ve-letter" style="--x:' +
        rand(6, 94).toFixed(2) +
        "%;--dx:" +
        rand(-60, 60).toFixed(0) +
        "px;--rot:" +
        rand(-22, 22).toFixed(0) +
        "deg;--dur:" +
        rand(16, 30).toFixed(1) +
        "s;--delay:" +
        rand(0, 14).toFixed(1) +
        's"></i>';
    }
    letters.innerHTML = html;
  }

  function mount() {
    root = document.createElement("div");
    root.id = "ve-boot";
    root.setAttribute("data-ve-boot", "");
    root.setAttribute("aria-hidden", "true");
    root.innerHTML = MARKUP;
    document.body.appendChild(root);

    typedEl = root.querySelector(".ve-typed");
    typedRow = root.querySelector(".ve-typedrow");
    pctEl = root.querySelector(".ve-pct");
    var sub = root.querySelector(".ve-sub");
    var hintText = root.querySelector(".ve-hinttext");
    if (sub) sub.textContent = cfg.subtitle;
    if (hintText) hintText.textContent = cfg.hint;

    spawnDecor();
    render();
    overlayObserver = watchOverlay();
    /* 淡入必须在“下一个可绘制帧”发生，但 rAF 在窗口隐藏/后台、以及无头截图的
       虚拟时间里会被节流甚至完全停摆——那样遮罩会一直停在 opacity 0，用户看到的
       是一片白（原生遮罩已被我们藏起来了）。所以定时器兜底一次，幂等。 */
    var shown = false;
    var showOnce = function () {
      if (shown || !root) return;
      shown = true;
      root.classList.add("ve-in");
    };
    window.requestAnimationFrame(showOnce);
    window.setTimeout(showOnce, 60);

    if (cfg.skippable) {
      window.addEventListener("pointerdown", onSkip, true);
      window.addEventListener("keydown", onSkip, true);
      window.addEventListener("wheel", onSkip, { capture: true, passive: true });
    }

    /* 不依赖 rAF 的兜底计时器：即使窗口被隐藏、rAF 被节流，也一定会收尾。 */
    window.setTimeout(function () {
      if (!finished) finish("timeout");
    }, cfg.maxDurationMs);

    window.requestAnimationFrame(loop);
    /* rAF 只在窗口可见且被合成时才跑；后台/隐藏窗口会被节流甚至停摆。
       补一个低频滴答，保证状态机（打字、进度、收尾判定）照常推进。 */
    tickId = window.setInterval(function () {
      if (finished || frozen) {
        window.clearInterval(tickId);
        tickId = 0;
        return;
      }
      loop(true);
    }, 120);
  }

  function onSkip() {
    if (finished) return;
    skipRequested = true;
    finish("skipped");
  }

  /* 每敲下一个字，整行轻轻一顿——替代原来打字机键帽的触感。 */
  function pulseStrike() {
    if (!typedRow) return;
    typedRow.classList.add("ve-strike");
    window.setTimeout(function () {
      typedRow.classList.remove("ve-strike");
    }, 110);
  }

  function render() {
    if (!root || !root.isConnected) return;
    root.style.setProperty("--ve-progress", shown.toFixed(4));
    if (pctEl) pctEl.textContent = Math.round(shown * 100) + "%";
    /* 火漆印 = “信写完了”。门限刻意留早一点：真实加载往往在最后一刻才冲到 100%，
       卡在 0.985 会让印章只闪一帧；0.84 之后它就有足够时间被看见。 */
    if (shown > 0.84) root.classList.add("ve-sealed");
    else root.classList.remove("ve-sealed");
  }

  function loop(fromTimer) {
    if (frozen || finished) return;
    var now = Date.now();
    var elapsed = now - startedAt;

    /* 打字机：按时间逐字打出品牌名，与加载进度解耦，读起来更自然。 */
    var wantChars = Math.min(cfg.wordmark.length, Math.floor(elapsed / cfg.typedCharMs) + 1);
    if (wantChars > typed) {
      typed = wantChars;
      if (typedEl) typedEl.textContent = cfg.wordmark.slice(0, typed);
      pulseStrike();
    }

    var el = stockOverlay();
    if (el) {
      sawOverlay = true;
      var real = readProgress();
      if (real !== null) target = real;
      if (!failSeen && el.textContent && el.textContent.indexOf("Failed to load") >= 0) {
        failSeen = true;
      }
    } else if (sawOverlay) {
      target = Math.max(target, 0.985);
    }

    /* 缓动跟随，避免进度跳变；结束时另由 finish() 拉满。 */
    if (!finished) shown += (target - shown) * 0.14;
    render();
    considerFinish(elapsed, el);
    if (!fromTimer) rafId = window.requestAnimationFrame(loop);
  }

  function considerFinish(elapsed, el) {
    if (finished) return;
    if (skipRequested) return finish("skipped");
    if (failSeen) return finish("failed");
    if (elapsed >= cfg.maxDurationMs) return finish("timeout");
    if (sawOverlay && !el && elapsed >= cfg.minDurationMs) return finish("mounted");
    /* 兜底：万一这版 DSH 的遮罩我们始终没认出来，只要应用已经挂载出内容，
       并且已过最短时长，就不要继续挡着用户。 */
    if (!sawOverlay && elapsed >= cfg.minDurationMs && appMounted()) return finish("mounted");
  }

  function finish(reason) {
    if (finished) return;
    finished = true;
    finishedAt = Date.now();
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (tickId) {
      window.clearInterval(tickId);
      tickId = 0;
    }
    target = 1;

    /* 无论何种原因结束，都先把进度拉满再收尾——除超时/失败，那两种情况优先让位。 */
    var graceful = reason === "mounted" || reason === "skipped" || reason === "manual";
    var holdMs = graceful ? 380 : 0;
    var ramp = window.setInterval(function () {
      shown += (1 - shown) * 0.32;
      if (graceful) render();
      if (shown > 0.995) {
        window.clearInterval(ramp);
      }
    }, 32);

    window.setTimeout(function () {
      window.clearInterval(ramp);
      if (graceful) {
        shown = 1;
        render();
      }
      root.classList.add("ve-out");
      release();
      window.setTimeout(teardown, cfg.outroMs);
    }, holdMs);
  }

  /** 交还控制权：让原生 boot 遮罩（含失败列表）重新可见。 */
  function release() {
    if (released) return;
    released = true;
    document.documentElement.classList.add("ve-release");
  }

  function teardown() {
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    if (overlayObserver) {
      overlayObserver.disconnect();
      overlayObserver = null;
    }
    window.removeEventListener("pointerdown", onSkip, true);
    window.removeEventListener("keydown", onSkip, true);
    window.removeEventListener("wheel", onSkip, true);
    if (window.__veBoot) window.__veBoot.done = true;
  }

  window.__veBoot = {
    version: "0.3.0",
    role: "boot-cinematic",
    config: cfg,
    skip: onSkip,
    release: function () {
      finish("manual");
    },
    /** 预览用：冻结在时间轴 t 毫秒处的画面。 */
    seek: function (ms, phase) {
      frozen = true;
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      var el = stockOverlay();
      if (el) sawOverlay = true;
      var real = readProgress();
      target = real === null ? (el ? 0.35 : 0.985) : real;
      shown = target;
      typed = Math.min(cfg.wordmark.length, Math.floor(ms / cfg.typedCharMs) + 1);
      if (typedEl) typedEl.textContent = cfg.wordmark.slice(0, typed);
      if (phase === "outro") root.classList.add("ve-out");
      render();
    },
    state: function () {
      return {
        elapsed: Date.now() - startedAt,
        typed: typed,
        shown: Math.round(shown * 1000) / 1000,
        finished: finished,
        released: released,
        sawOverlay: sawOverlay
      };
    }
  };

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
