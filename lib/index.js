/* ==========================================================================
   dsh-violet-boot — host 侧插件
   职责：在 WebServer 渲染 index.html 时，把薇尔莉特主题开机动画注入 <head>
   与 <body>。这是唯一能在“首帧之前”生效的位置——因为原生 boot 遮罩存在的
   整段时间正是“插件尚未加载完”，客户端插件永远来不及介入。

   注入协议：dsh-host-webserver 的 `webserver/index-inject` 事件。
   `collectIndexInjections()` 每次渲染 index 时发一次该事件，每个订阅者往
   table 里 push 自己的行；`renderIndexInjections` 把 head 行插到 <head>
   之后、body 行插到 <body> 之后（本插件只使用结构化行，不用 tapIndex）。
   ========================================================================== */
import { readFileSync } from "node:fs";

/** 主题照片的占位符：boot.css 里以 url("__VE_PORTRAIT_SRC__") 的形式出现。 */
const PORTRAIT_PLACEHOLDER = "__VE_PORTRAIT_SRC__";

/** 打包在插件内的默认主题照片（1024 见方原图的裁切 + 压缩版）。 */
const PORTRAIT_ASSET = "assets/portrait.jpg";

/** 万一读不到随包照片，用一块暖色渐变顶上，至少舞台结构是完整的。 */
const PORTRAIT_FALLBACK =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="740" viewBox="0 0 720 740">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#fdf9ee"/><stop offset="1" stop-color="#e7d9bb"/>' +
      "</linearGradient></defs>" +
      '<rect width="720" height="740" fill="url(#g)"/>' +
      "</svg>"
  );

/** 默认配置；可用 cordis patch 的 config 覆盖，也可用环境变量覆盖。 */
export const DEFAULT_CONFIG = {
  /** 动画最短播放时长（毫秒）：加载再快也不闪一下就走。 */
  minDurationMs: 2500,
  /** 最长播放时长（毫秒）：兜底，任何情况下都不会永久遮挡界面。 */
  maxDurationMs: 20000,
  /** 收尾淡出时长（毫秒）。 */
  outroMs: 760,
  /** 允许点击 / 按键 / 滚轮跳过。 */
  skippable: true,
  /** 信纸上被逐字敲出来的字样；留空 = 不显示（默认，画面干净优先）。 */
  wordmark: "",
  /** 副标题；留空 = 不显示（默认）。 */
  subtitle: "",
  /** 加载完成时在右下角盖一枚火漆印；默认关（整页纯白，画面干净优先）。 */
  seal: false,
  /** 进度行文案。 */
  hint: "Loading plugins…",
  /** 每个字符的打字间隔（毫秒）。 */
  typedCharMs: 135,
  /** 背景中飘散的信件数量。 */
  letters: 12,
  /** 背景尘埃数量。 */
  motes: 26,
  /** 主题照片：留空则用随包的 assets/portrait.jpg；也可给 http(s) 或 data: 地址。 */
  portrait: ""
};

/** 环境变量覆盖表，方便在无法改 profile patch 时临时调整。 */
const ENV_KEYS = {
  VIOLET_BOOT_MIN_MS: "minDurationMs",
  VIOLET_BOOT_MAX_MS: "maxDurationMs",
  VIOLET_BOOT_OUTRO_MS: "outroMs",
  VIOLET_BOOT_SKIPPABLE: "skippable",
  VIOLET_BOOT_WORDMARK: "wordmark",
  VIOLET_BOOT_SUBTITLE: "subtitle",
  VIOLET_BOOT_SEAL: "seal",
  VIOLET_BOOT_HINT: "hint",
  VIOLET_BOOT_PORTRAIT: "portrait"
};

function fromEnv(key, current) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return current;
  if (typeof current === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : current;
  }
  if (typeof current === "boolean") return raw !== "0" && raw.toLowerCase() !== "false";
  return raw;
}

/** 合并顺序：默认值 → cordis config → 环境变量。 */
export function resolveConfig(config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config && typeof config === "object" ? config : {}) };
  for (const [envKey, cfgKey] of Object.entries(ENV_KEYS)) {
    cfg[cfgKey] = fromEnv(envKey, cfg[cfgKey]);
  }
  return cfg;
}

function readAsset(name) {
  /* 每次渲染都重新读盘：改完 boot.css / boot.js 刷新页面即可见效，无需重启 host。 */
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

/** 随包照片 → data URI。每次渲染重读，换掉 assets/portrait.jpg 刷新即生效。 */
function bundledPortrait() {
  /* 注意是 ../assets：本文件在 lib/ 下。 */
  const bytes = readFileSync(new URL(`../${PORTRAIT_ASSET}`, import.meta.url));
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

/**
 * 配置里自带的照片地址。只接受不含引号 / 括号 / 尖括号 / 空白 / 反斜杠的值，
 * 因为它会被直接写进 CSS 的 url("…")，也必须保证不会撞上 </style 校验。
 */
function customPortrait(value) {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (!v) return "";
  if (/["'()<>\s\\]/.test(v)) {
    throw new Error(`portrait 含有不安全的字符（引号 / 括号 / 尖括号 / 空白）：${v.slice(0, 40)}`);
  }
  return v;
}

/**
 * 构造注入表的行。抽成纯函数，方便 tools/render-preview.mjs 用与线上
 * 完全相同的行来生成预览页。onWarn 可选，用于把降级情况报给宿主日志。
 */
export function buildRows(config, onWarn) {
  const cfg = resolveConfig(config);
  let src = "";
  try {
    src = customPortrait(cfg.portrait);
  } catch (err) {
    if (onWarn) onWarn(err && err.message ? err.message : String(err));
  }
  if (!src) {
    try {
      src = bundledPortrait();
    } catch (err) {
      if (onWarn) {
        onWarn(`读不到 ${PORTRAIT_ASSET}（${err && err.message ? err.message : err}），改用占位图`);
      }
      src = PORTRAIT_FALLBACK;
    }
  }
  const css = readAsset("boot.css").replaceAll(PORTRAIT_PLACEHOLDER, src);
  const js = readAsset("boot.js");
  assertSafe(css, "</style", "boot.css");
  assertSafe(js, "</script", "boot.js");
  return [
    { kind: "global", name: "__VIOLET_BOOT__", value: cfg },
    { kind: "style", text: css },
    { kind: "script", placement: "body", text: js }
  ];
}

function assertSafe(text, needle, name) {
  if (text.includes(needle)) {
    throw new Error(
      `${name} 含字面量 ${needle}，会提前关闭内联元素；请改成转义写法（例如 "<\\/script"）`
    );
  }
}

function log(ctx, level, message) {
  const logger = ctx && ctx.logger;
  if (logger && typeof logger[level] === "function") logger[level](message);
  else if (level === "warn") console.warn(message);
}

/**
 * cordis 插件入口。
 * @param ctx host 侧插件上下文（需提供 webServer 服务与事件总线）。
 * @param config 由 profile patch 传入的配置（可省略）。
 */
export function apply(ctx, config) {
  if (!ctx || typeof ctx.on !== "function") {
    console.warn("dsh-violet-boot: 未拿到可用的 cordis 上下文，跳过注入");
    return;
  }
  const cfg = resolveConfig(config);
  const warn = (message) => log(ctx, "warn", `dsh-violet-boot: ${message}`);
  ctx.on("webserver/index-inject", (table) => {
    if (!Array.isArray(table)) return;
    try {
      table.push(...buildRows(cfg, warn));
    } catch (err) {
      log(ctx, "warn", `dsh-violet-boot: 注入失败 — ${err && err.message ? err.message : err}`);
    }
  });
  log(
    ctx,
    "info",
    `dsh-violet-boot: 已挂载薇尔莉特开机动画（最短 ${cfg.minDurationMs}ms / 最长 ${cfg.maxDurationMs}ms${
      cfg.skippable ? " / 可跳过" : ""
    } / 主题照片 ${cfg.portrait ? "自定义" : "随包"}）`
  );
}

export default apply;
