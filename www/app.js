/* ============================================================================
 * リスト · app
 * 纯前端应用，无服务端。这一份就是「客户端后端」：
 *   校验 / 持久化 / 撤销 / 跨标签同步 / 导入导出 / 历史归档 / 番茄钟 / 角色
 *
 * ⚠️ 实装前必做：把下面 ASSETS 里的三张立绘换成你自己托管的图片。
 * ==========================================================================*/
(() => {
"use strict";

/* ============================================================================
 * 立绘资源
 * 要求：
 *   1. 纯白背景（抠图靠从四边泛洪填充白色，背景不纯会抠出洞）
 *   2. 竖版全身，人物居中，建议 850×1250 左右
 *   3. 必须同源相对路径（当前 CSP 的 img-src 为 'self' data: blob:，
 *      远程立绘会被拦；跨域 canvas 也会污染 getImageData）
 * ==========================================================================*/
const ASSETS = {
  kanna:  "./assets/kanna.png",
  sakura: "./assets/sakura.png",
  cafe:   "./assets/cafe.png",
};

/* ---------------------------------------------------------------- 常量 */
const SCHEMA_VERSION = 4;                 // v4：新增 pomodoros
const STORAGE_KEY = "lumina-todo-v2";
const LEGACY_KEY  = "lumina-todo-v1";
const SEED_KEY    = "lumina-todo-seeded";
const THEME_KEY   = "lumina-theme";
const POMO_KEY    = "lumina-pomo";
const MAX_TEXT  = 500;
const MAX_ITEMS = 2000;
const UNDO_DEPTH = 30;
const DAY_MS = 86400000;
const MIN = 60000;
const MAX_JS_TIME = 8.64e15;

const CATEGORY_LABELS = { inbox:"收件箱", work:"工作", personal:"私事", study:"学习", health:"健康" };
const PRIO_LABELS = { low:"随意", medium:"在意", high:"要紧" };
const PRIORITIES = Object.keys(PRIO_LABELS);
const CATEGORIES = Object.keys(CATEGORY_LABELS);
const CAT_ICONS = {
  inbox:'<path d="M3.5 13h4l1.5 3h6l1.5-3h4"/><path d="M5.5 5h13l2 8v5a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 18v-5Z"/>',
  work:'<rect x="3.5" y="7.5" width="17" height="12" rx="2.5"/><path d="M9 7.5v-2a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5.5v2"/>',
  personal:'<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  study:'<path d="M12 6.5 3.5 10 12 13.5 20.5 10Z"/><path d="M7 11.8V16c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5v-4.2"/>',
  health:'<path d="M12 19.5S4 15 4 9.8A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 20 9.8c0 5.2-8 9.7-8 9.7Z"/>',
};
const SMART_TITLES = { all:"全部", today:"今天", overdue:"已逾期", active:"进行中", history:"历史记录" };

const EMPTY_ICONS = {
  search:'<circle cx="11" cy="11" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m19.6 19.6-3.3-3.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  note:'<rect x="4.5" y="3.5" width="15" height="17" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8.5 9h7M8.5 13h4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  check:'<circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8.4 12.2 11 14.8l4.8-5.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  clock:'<path d="M3.6 10.5a8.6 8.6 0 1 1 .6 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M3.2 19.5v-4.4h4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 7.6V12l3 1.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
};

/* 番茄钟时长预设（分钟）：focus / short / long / 几轮一次长休息 */
const PRESETS = [
  { focus:25, short:5,  long:15, per:4, label:"25 / 5"  },
  { focus:50, short:10, long:25, per:2, label:"50 / 10" },
  { focus:15, short:3,  long:12, per:4, label:"15 / 3"  },
];

/* ------------------------------------------------------ 主题 + 角色台词 */
const THEMES = {
  kanna: {
    name:"栞那", jp:"かんな", desc:"星光咖啡馆的深夜 · 月光与蝴蝶",
    brand:"星屑の栞", charName:"明月栞那", art:ASSETS.kanna,
    mark:"#sym-butterfly", spark:["#sym-butterfly","#sym-star4","#sym-star4"],
    placeholder:"今晚，想留下点什么呢……？",
    emotes:{ done:"♪", allDone:"✧", add:"✎", deleted:"…", poke:"？", hello:"✧", overdue:"！", history:"❋",
             focusStart:"✦", focusHalf:"·", focusEnd:"✧", restStart:"♨", restNag:"！", restEnd:"✦", skipRest:"？" },
    lines:{
      morning:["早上好……今天也慢慢来吧。","天亮了呢。要从哪一件开始？"],
      afternoon:["下午了呢……还剩几件？","这个时间，最容易走神了吧？"],
      evening:["晚上好。该收尾了吧？","咖啡馆也快开门了呢……"],
      night:["已经很晚了……不勉强自己，好吗？","夜里做的决定，多半会后悔哦。"],
      add:["记下了。……接下来呢？","嗯，写下来就不会忘了。"],
      done:["嘻嘻嘻，又少了一件呢。","做得很好哦……真的。","这样就好。不用着急的。"],
      allDone:["全部结束了呢……嘻嘻嘻。","今天就到这里吧。要喝点什么吗？"],
      overdue:["有几件……已经等你很久了吧？","拖着也没关系。只是，别忘了。"],
      deleted:["消失了呢……不过，没关系的。","有些事，放下也是一种收尾。"],
      history:["过去的事，我都替你留着哦。","回头看看，也挺好的吧？"],
      poke:["……怎么了？","别一直盯着我看啦。嘻嘻嘻。","厨房那边，我还得回去呢。","活了一百多年，也没见过这么闲的人。"],
      idle:["……","风有点凉呢。","还在吗？"],
      hello:["今晚，就由我来陪你吧。"],
      focusStart:["那么……开始吧。","这段时间，我陪着你。","专心一点哦。我看着呢。"],
      focusHalf:["一半了呢……还撑得住吗？","过半了。别硬撑哦。"],
      focusNear:["快到了。……最后一点点。","还剩一会儿。慢慢来。"],
      focusEnd:["时间到了。……先停下吧。","够了哦。手离开键盘。"],
      restStart:["休息时间。真的，别再看屏幕了。","去接杯水吧……我等你。","站起来，走两步。就两步。"],
      restNag:["还坐着呢？……我说了，休息。","嘻嘻嘻，我可是会一直说到你走开为止哦。","肩膀，已经僵了吧？"],
      restEnd:["休息够了吧？……那，继续。","回来了呢。再来一轮？"],
      skipRest:["……又不休息。","随你吧。不过，我记下了哦。","活了一百多年，这种人我见过很多。后来都后悔了。"],
      longRest:["这一轮辛苦了。多歇一会儿吧。","四轮了呢……去躺一下也可以哦。"],
      pause:["先停一下？……嗯，可以的。"],
    },
  },
  sakura: {
    name:"樱", jp:"さくら", desc:"少女漫画原稿纸 · 网点与缎带",
    brand:"今日のリスト", charName:"小樱", art:ASSETS.sakura,
    mark:"#sym-petal", spark:["#sym-petal","#sym-star4","#sym-heart"],
    placeholder:"今天想做点什么呢…？",
    emotes:{ done:"♥", allDone:"★", add:"✚", deleted:"～", poke:"！", hello:"♥", overdue:"！", history:"♪",
             focusStart:"✊", focusHalf:"·", focusEnd:"★", restStart:"☕", restNag:"！", restEnd:"✊", skipRest:"？" },
    lines:{
      morning:["早上好！今天也一起加油吧～","新的一天，先挑最难的那件！"],
      afternoon:["下午啦，还差几件就搞定咯！","别偷懒哦，我看着呢！"],
      evening:["快收尾啦，冲刺一下！","晚上再做完两件，超棒的！"],
      night:["这么晚啦，明天再说也行的～","早点睡嘛，任务不会跑掉的！"],
      add:["记好啦！交给我吧～","又多一件，没关系没关系！"],
      done:["完成一件啦，好厉害！","诶嘿，进度条动了！","这个速度，超快的嘛！"],
      allDone:["全部搞定！去休息一下吧～","一件不剩！今天太棒啦！"],
      overdue:["有几件拖到现在啦，快点嘛～","那几个已经过期咯，别装作没看见！"],
      deleted:["删掉啦，没关系的！","不做也是一种选择嘛～"],
      history:["看看以前做过多少，超有成就感的！"],
      poke:["诶嘿嘿，戳我干嘛啦～","痒痒的！","要一起加油吗？"],
      idle:["唔……","在发呆吗？","要不要休息一下？"],
      hello:["我来陪你一起做啦！"],
      focusStart:["开始咯！我给你计时～","这一轮，冲！","加油加油，我看着你！"],
      focusHalf:["一半啦，坚持住！","过半咯，超快的！"],
      focusNear:["最后一点点，冲鸭！","马上就到，别停！"],
      focusEnd:["时间到！好棒好棒！","这一轮完成啦～"],
      restStart:["休息休息！离开椅子！","去喝点水嘛～","伸个懒腰，快点！"],
      restNag:["还坐着？！快去休息啦！","不动的话我要生气咯～","眼睛会坏掉的啦！"],
      restEnd:["休息好啦？再来一轮！","精神了吧，冲！"],
      skipRest:["诶——不休息吗……","真拿你没办法。","那我陪你继续，但别累坏了！"],
      longRest:["四轮啦！这次多休息一会儿～","超厉害的！去躺一下吧！"],
      pause:["暂停一下也没关系的！"],
    },
  },
  cafe: {
    name:"珈琲", jp:"コーヒー", desc:"午后的暖褐 · 麻布与咖啡渍",
    brand:"珈琲とリスト", charName:"店员小姐", art:ASSETS.cafe,
    mark:"#sym-bean", spark:["#sym-bean","#sym-star4","#sym-heart"],
    placeholder:"配着咖啡，先做哪一件？",
    emotes:{ done:"✓", allDone:"☕", add:"✎", deleted:"—", poke:"？", hello:"☕", overdue:"！", history:"❋",
             focusStart:"☕", focusHalf:"·", focusEnd:"✓", restStart:"☕", restNag:"！", restEnd:"☕", skipRest:"？" },
    lines:{
      morning:["咖啡刚煮好，慢慢来吧。","早安。先坐下，再开始。"],
      afternoon:["下午续一杯吗？","这个时段的光最好了。"],
      evening:["快打烊了，收个尾吧。","最后一杯，要吗？"],
      night:["这个点还在忙？给你煮杯淡的。","打烊了，剩下的明天再说。"],
      add:["记在单子上了。","好的，下一位。"],
      done:["不错。再来一件？","嗯，稳稳的。"],
      allDone:["都做完了。续杯吗？","单子空了，坐着歇会儿。"],
      overdue:["有几张单子，压很久了。","这几件，要不要今天解决？"],
      deleted:["撤单了。","没关系，常有的事。"],
      history:["以前的单子都留着呢。"],
      poke:["……需要点什么吗？","豆子刚烘好，闻闻？","我在这儿，随时叫我。"],
      idle:["……","豆子还在磨。","慢慢来。"],
      hello:["欢迎光临。今天想做点什么？"],
      focusStart:["计时开始。咖啡给你温着。","这段时间，不打扰你。"],
      focusHalf:["一半了。要续杯吗？","过半。手边的凉了吧。"],
      focusNear:["快到点了。","最后一段，稳住。"],
      focusEnd:["时间到。停一下。","这一杯的时间，用完了。"],
      restStart:["休息。杯子放下，人站起来。","去窗边看看。就五分钟。","这一段是我的规矩，不许赖。"],
      restNag:["还没起来？","坐太久了。真的。","腰会疼的，别问我怎么知道。"],
      restEnd:["歇好了？续一杯继续。","可以了。回座吧。"],
      skipRest:["……行吧。","不休息的客人，我见多了。","记得，账总是要还的。"],
      longRest:["这一轮结束，多歇会儿。","去外面透透气吧。"],
      pause:["先停着。杯子我给你留着。"],
    },
  },
};
const THEME_IDS = ["kanna","sakura","cafe"];

const TAB_ID = (() => {
  try { return crypto.randomUUID().slice(0, 8); }
  catch { return Math.random().toString(36).slice(2, 10); }
})();

/* ============================================================================
 * 存储可用性探测
 * 三种「不可用」成因分开处理，否则用户无从下手：
 *   sandbox  预览 iframe / file:// 被浏览器策略拒绝，环境问题
 *   private  无痕模式，关窗即丢
 *   blocked  站点存储权限被关
 * ==========================================================================*/
function probeStorage(){
  let ls;
  try { ls = window.localStorage; } catch { return { writable:false, reason:"blocked" }; }
  if (!ls) return { writable:false, reason:"blocked" };
  try {
    ls.setItem("__lumina_probe__","1");
    ls.removeItem("__lumina_probe__");
    return { writable:true, reason:null };
  } catch (err) {
    const sandboxed = (() => {
      try { return window.self !== window.top || location.protocol === "file:"; }
      catch { return true; } // 读 window.top 抛错本身就说明被嵌在跨源页里
    })();
    if (sandboxed) return { writable:false, reason:"sandbox" };
    const quota = err && (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED" || err.code === 22);
    return { writable:false, reason: quota ? "private" : "blocked" };
  }
}
const probe = probeStorage();
let storageWritable = probe.writable;
let unavailableReason = probe.reason;

const memFallback = new Map();
const store = {
  get(k){ if(!storageWritable) return memFallback.has(k)?memFallback.get(k):null;
          try { return localStorage.getItem(k); } catch { return null; } },
  set(k,v){ if(!storageWritable){ memFallback.set(k,v); return false; }
            localStorage.setItem(k,v); return true; }, // 配额错误交给调用方
};

/* ---------------------------------------------------------------- 工具 */
function uid(){
  try { return crypto.randomUUID(); }
  catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}-${Math.random().toString(36).slice(2,6)}`; }
}
function isISODate(v){
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y,m,d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m-1, d));
  return dt.getUTCFullYear()===y && dt.getUTCMonth()===m-1 && dt.getUTCDate()===d;
}
function dayKey(ts){
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
const todayStr = () => dayKey(Date.now());
function startOfDay(ts){ const d = new Date(ts); d.setHours(0,0,0,0); return d.getTime(); }
/* 用 UTC 做天数差，避开夏令时导致的 ±1 天 */
function daysBetween(aKey, bKey){
  const [ay,am,ad] = aKey.split("-").map(Number);
  const [by,bm,bd] = bKey.split("-").map(Number);
  return Math.round((Date.UTC(by,bm-1,bd) - Date.UTC(ay,am-1,ad)) / DAY_MS);
}
function boundedInt(value, min, max, fallback = min){
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
function cssEscape(v){
  if (window.CSS && typeof CSS.escape === "function") return CSS.escape(v);
  return String(v).replace(/["\\\]\[]/g, "\\$&");
}
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function mmss(ms){
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2,"0")}:${String(s % 60).padStart(2,"0")}`;
}

/* ============================================================================
 * 立绘抠图
 * 从四边泛洪填充把连通的白色抹成透明。白色衣服因为被线稿围住、
 * 与边缘不连通，所以不会被误伤。
 * 跨域取像素会抛 SecurityError，整段包在 try 里，失败就退回相框样式。
 * ==========================================================================*/
const cutoutCache = new Map();   // themeId -> dataURL | null（null = 抠不了）
const cutoutPending = new Set();

function keyOutWhite(imgData, w, h){
  const px = imgData.data;
  const seen = new Uint8Array(w * h);
  const stack = [];
  const isBg = (i) => px[i] > 236 && px[i+1] > 236 && px[i+2] > 236;
  const push = (x, y) => {
    const p = y * w + x;
    if (seen[p]) return;
    if (!isBg(p << 2)) return;
    seen[p] = 1; stack.push(p);
  };
  for (let x = 0; x < w; x++){ push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++){ push(0, y); push(w - 1, y); }
  while (stack.length){
    const p = stack.pop();
    const x = p % w, y = (p / w) | 0;
    px[(p << 2) + 3] = 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  /* 边缘羽化：紧贴透明区的浅色像素按亮度降不透明度，消掉锯齿白边 */
  for (let y = 1; y < h - 1; y++){
    for (let x = 1; x < w - 1; x++){
      const p = y * w + x, i = p << 2;
      if (px[i+3] === 0) continue;
      if (seen[p-1] || seen[p+1] || seen[p-w] || seen[p+w]){
        const lum = px[i] * .299 + px[i+1] * .587 + px[i+2] * .114;
        if (lum > 228) px[i+3] = Math.max(0, 255 - (lum - 228) * 9);
      }
    }
  }
}

/**
 * 立绘抠图（启动友好）：
 * - 先显示原图，图加载后立刻抠当前主题（降采样，不堵太久）
 * - 最长边压到 CUTOUT_MAX，像素量约降一个数量级
 * - 其它主题等打开主题面板再预热
 */
const CUTOUT_MAX = 480;

function makeCutout(themeId){
  if (cutoutCache.has(themeId) || cutoutPending.has(themeId)) return;
  cutoutPending.add(themeId);
  const img = new Image();
  img.decoding = "async";
  img.crossOrigin = "anonymous";
  const fail = () => { cutoutPending.delete(themeId); cutoutCache.set(themeId, null); };
  img.onerror = fail;
  img.onload = () => {
    try {
      const w0 = img.naturalWidth, h0 = img.naturalHeight;
      if (!w0 || !h0) return fail();
      const scale = Math.min(1, CUTOUT_MAX / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * scale));
      const h = Math.max(1, Math.round(h0 * scale));
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return fail();
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h);
      keyOutWhite(data, w, h);
      ctx.putImageData(data, 0, 0);
      let url = "";
      try {
        url = c.toDataURL("image/webp", 0.86);
        if (!url.startsWith("data:image/webp")) url = c.toDataURL("image/png");
      } catch {
        url = c.toDataURL("image/png");
      }
      cutoutCache.set(themeId, url);
      cutoutPending.delete(themeId);
      if (themeId === currentTheme) paintPortrait();
      else {
        const im = themeList && themeList.querySelector(`img[data-theme="${cssEscape(themeId)}"]`);
        if (im && im.getAttribute("src") !== url) im.src = url;
      }
    } catch { fail(); }
  };
  img.src = THEMES[themeId].art;
}

/** 打开主题面板时再预热其它立绘 */
function warmOtherCutouts(){
  THEME_IDS.forEach((id) => { if (id !== currentTheme) makeCutout(id); });
}

function paintPortrait(){
  const cut = cutoutCache.get(currentTheme);
  const src = cut || THEMES[currentTheme].art;
  charaPortrait.classList.toggle("is-cut", Boolean(cut));
  if (charaImg.getAttribute("src") !== src){
    charaImg.classList.remove("ready");
    charaImg.alt = THEMES[currentTheme].charName;
    charaImg.onload = () => charaImg.classList.add("ready");
    charaImg.src = src;
    if (charaImg.complete) charaImg.classList.add("ready");
  }
  themeList.querySelectorAll(".theme-face img").forEach((im) => {
    const id = im.dataset.theme;
    const s = cutoutCache.get(id) || THEMES[id].art;
    if (im.getAttribute("src") !== s) im.src = s;
  });
}

/* ---------------------------------------------------------------- 状态 */
let todos = [];
let currentFilter = "all";
let searchQuery = "";
let selectedPriority = "low";
let historyRange = 30;
let editingId = null;
let pendingExternal = null;
let persistState = storageWritable ? "ok" : "unavailable";
let noticeDismissed = false;
let currentTheme = "kanna";
let lastLine = "";
const undoStack = [];

/* ----------------------------------------------------------------- DOM */
const $ = (s) => document.querySelector(s);
const composer = $("#composer"), todoInput = $("#todoInput"), addBtn = $("#addBtn");
const dueDateInput = $("#dueDate"), categorySelect = $("#category");
const dueDateWrap = $("#dueDateWrap"), dueDateCalBtn = $("#dueDateCalBtn"), dueDatePop = $("#dueDatePop");
const dueDateGrid = $("#dueDateGrid"), dueDateTitle = $("#dueDateTitle");
const dueDatePrev = $("#dueDatePrev"), dueDateNext = $("#dueDateNext");
const dueDateTodayBtn = $("#dueDateToday"), dueDateClearBtn = $("#dueDateClear");
const todoList = $("#todoList"), scroller = $("#scroller"), emptyState = $("#emptyState");
const emptyMark = $("#emptyMark"), emptyTitle = $("#emptyTitle"), emptyBody = $("#emptyBody"), emptyLine = $("#emptyLine");
const charaPortrait = $("#charaPortrait"), charaImg = $("#charaImg"), charaWrap = $("#chara");
const charaBtn = $("#charaBtn"), charaTilt = $("#charaTilt"), charaReact = $("#charaReact"), charaEmote = $("#charaEmote");
const bubble = $("#bubble"), bubbleTxt = $("#bubbleTxt"), bubbleName = $("#bubbleName");
const searchInput = $("#searchInput"), searchClear = $("#searchClear"), searchKbd = $("#searchKbd");
const viewTitle = $("#viewTitle"), viewCount = $("#viewCount"), sortNote = $("#sortNote");
const toastEl = $("#toast"), toastMsg = $("#toastMsg"), toastAction = $("#toastAction");
const rowTpl = $("#rowTpl"), catNav = $("#catNav"), sparkles = $("#sparkles");
const notice = $("#notice"), noticeTitle = $("#noticeTitle"), noticeBody = $("#noticeBody");
const statusCounts = $("#statusCounts"), statusPct = $("#statusPct"), miniFill = $("#miniFill");
const storeChip = $("#storeChip"), storeLabel = $("#storeLabel"), savedFlash = $("#savedFlash");
const undoBtn = $("#undoBtn"), historyBar = $("#historyBar"), historyStat = $("#historyStat");
const themeBtn = $("#themeBtn"), themePop = $("#themePop"), themeList = $("#themeList");
const brandName = $("#brandName"), titleMarkUse = $("#titleMarkUse"), composerMarkUse = $("#composerMarkUse");
const pomoEl = $("#pomo"), pomoArc = $("#pomoArc"), pomoGlyph = $("#pomoGlyph");
const pomoTime = $("#pomoTime"), pomoSub = $("#pomoSub"), pomoDots = $("#pomoDots");
const pomoMain = $("#pomoMain"), pomoMainIco = $("#pomoMainIco"), pomoMainTxt = $("#pomoMainTxt");
const pomoSkip = $("#pomoSkip"), pomoReset = $("#pomoReset"), pomoPreset = $("#pomoPreset");
const pomoTally = $("#pomoTally"), pomoBell = $("#pomoBell");
const tbPomo = $("#tbPomo"), tbPomoLab = $("#tbPomoLab"), tbPomoTime = $("#tbPomoTime");

const BASE_TITLE = document.title;
const ARC_LEN = 2 * Math.PI * 22.5;

/* ============================================================================
 * 角色动作
 * 四层各管一个 transform，互不覆盖：
 *   .chara-btn 悬停 / .chara-tilt 跟随 / .chara-react 反应 / .portrait 漂浮
 * ==========================================================================*/
const REACTIONS = ["r-hop","r-tada","r-shake","r-nod","r-shy","r-sway","r-peek","r-tug","r-doze"];
let reactTimer = null;

function play(name){
  if (reducedMotion()) return;
  clearTimeout(reactTimer);
  charaReact.classList.remove(...REACTIONS);
  void charaReact.offsetWidth;            // 强制回流，保证同名动画能重放
  charaReact.classList.add(name);
  reactTimer = setTimeout(() => charaReact.classList.remove(name), 3400);
}

let emoteTimer = null;
function emote(symbol){
  if (!symbol || reducedMotion()) return;
  charaEmote.textContent = symbol;
  charaEmote.classList.remove("go");
  void charaEmote.offsetWidth;
  charaEmote.classList.add("go");
  clearTimeout(emoteTimer);
  emoteTimer = setTimeout(() => charaEmote.classList.remove("go"), 1200);
}

/* 指针跟随：rAF 节流，只在真的动了才写 transform */
let tiltRaf = 0, tiltX = 0, tiltR = 0;
function applyTilt(){
  tiltRaf = 0;
  charaTilt.style.transform = `translateX(${tiltX.toFixed(2)}px) rotate(${tiltR.toFixed(2)}deg)`;
}
function trackPointer(e){
  if (reducedMotion()) return;
  const r = charaBtn.getBoundingClientRect();
  if (!r.width) return;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height * .35;
  const dx = Math.max(-1, Math.min(1, (e.clientX - cx) / 420));
  const dy = Math.max(-1, Math.min(1, (e.clientY - cy) / 420));
  tiltX = dx * 4;
  tiltR = dx * 2.6 - dy * .6;
  if (!tiltRaf) tiltRaf = requestAnimationFrame(applyTilt);
}
function resetTilt(){
  tiltX = 0; tiltR = 0;
  if (!tiltRaf) tiltRaf = requestAnimationFrame(applyTilt);
}

/* 发呆：90 秒没动静就自己动一下 */
let idleTimer = null;
function pokeIdleClock(){
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    play(Math.random() < .5 ? "r-sway" : "r-peek");
    if (Math.random() < .45) say("idle");
    pokeIdleClock();
  }, 90000 + Math.random() * 40000);
}

/* ---------------------------------------------------------- 角色说话 */
function timeSlot(){
  const h = new Date().getHours();
  if (h < 6 || h >= 23) return "night";
  if (h < 11) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}
function pickLine(kind){
  const pool = THEMES[currentTheme].lines[kind];
  if (!pool || !pool.length) return null;
  if (pool.length === 1) return pool[0];
  let pick = pool[Math.floor(Math.random() * pool.length)];
  let guard = 0;
  while (pick === lastLine && guard++ < 4) pick = pool[Math.floor(Math.random() * pool.length)];
  return pick;
}
/* kind 同时决定台词、动作、头顶符号 */
const MOTION_BY_KIND = {
  done:"r-hop", allDone:"r-tada", add:"r-nod", deleted:"r-shake",
  poke:"r-shy", hello:"r-hop", overdue:"r-peek", history:"r-nod", idle:"r-sway",
  focusStart:"r-nod", focusHalf:"r-sway", focusNear:"r-peek", focusEnd:"r-hop",
  restStart:"r-tug", restNag:"r-tug", restEnd:"r-hop", skipRest:"r-shake",
  longRest:"r-doze", pause:"r-sway",
};
function say(kind, opts){
  const line = pickLine(kind);
  if (line){
    lastLine = line;
    bubbleTxt.textContent = line;
    bubbleTxt.classList.remove("in");
    void bubbleTxt.offsetWidth;
    bubbleTxt.classList.add("in");
  }
  const motion = (opts && opts.motion) || MOTION_BY_KIND[kind];
  if (motion) play(motion);
  const sym = THEMES[currentTheme].emotes[kind];
  if (sym) emote(sym);
  if (kind === "deleted" || kind === "overdue" || kind === "restNag" || kind === "restStart"){
    bubble.classList.remove("nudge");
    void bubble.offsetWidth;
    bubble.classList.add("nudge");
  }
  pokeIdleClock();
}
function sayGreeting(){
  if (todos.some(isOverdue)) say("overdue");
  else say(timeSlot(), { motion:"r-nod" });
}

/* ============================================================================
 * 番茄钟
 * 关键设计：用「结束时刻 endsAt」而不是倒数计数器。
 * 后台标签页的 setInterval 会被浏览器节流到 1s 甚至几十秒一跳，
 * 逐帧递减必然走慢。每次 tick 都拿 endsAt 减当前时间，
 * 无论被节流多久、电脑睡眠过、还是页面关了重开，算出来都是对的。
 * ==========================================================================*/
const pomo = {
  mode:"focus",        // focus | short | long
  running:false,
  endsAt:null,         // 运行中：结束时刻
  leftMs:null,         // 暂停中：剩余
  segmentMs:null,      // 本段开始时的预设时长（换预设/补跑时打卡仍按当时那段）
  round:0,             // 已完成的专注轮数（判断长休息）
  taskId:null,         // 绑定的待办
  presetIdx:0,
  sound:false,
  tallyDay:todayStr(),
  tally:0,             // 今天完成的专注段数
  halfSaid:false,
  nearSaid:false,
};
let pomoTick = null;
let nagTimer = null;
let audioCtx = null;
let segmentTransitionTimer = null;
let segmentTransitionVersion = 0;

const preset = () => PRESETS[pomo.presetIdx];
const durationOf = (mode) => (mode === "focus" ? preset().focus : mode === "short" ? preset().short : preset().long) * MIN;
const MODE_LABEL = { focus:"专注", short:"短憩", long:"长憩" };
const isResting = () => pomo.mode !== "focus";

function savePomo(){
  try {
    store.set(POMO_KEY, JSON.stringify({
      mode:pomo.mode, running:pomo.running, endsAt:pomo.endsAt, leftMs:pomo.leftMs,
      segmentMs:pomo.segmentMs,
      round:pomo.round, taskId:pomo.taskId, presetIdx:pomo.presetIdx,
      sound:pomo.sound, tallyDay:pomo.tallyDay, tally:pomo.tally,
    }));
  } catch { /* 存不下不影响计时 */ }
  syncNativePomoNotify();
}
function loadPomo(){
  let raw;
  try { raw = JSON.parse(store.get(POMO_KEY) || "null"); } catch { raw = null; }
  if (!raw || typeof raw !== "object") return;
  if (["focus","short","long"].includes(raw.mode)) pomo.mode = raw.mode;
  if (Number.isInteger(raw.presetIdx) && PRESETS[raw.presetIdx]) pomo.presetIdx = raw.presetIdx;
  pomo.sound = raw.sound === true;
  pomo.round = boundedInt(raw.round, 0, 999999, 0);
  pomo.taskId = typeof raw.taskId === "string" ? raw.taskId : null;
  if (Number.isFinite(raw.segmentMs) && raw.segmentMs > 0) pomo.segmentMs = raw.segmentMs;
  /* 跨天了就把今日计数清零 */
  if (raw.tallyDay === todayStr() && Number.isFinite(raw.tally)) { pomo.tallyDay = raw.tallyDay; pomo.tally = boundedInt(raw.tally, 0, 999999, 0); }
  else { pomo.tallyDay = todayStr(); pomo.tally = 0; }

  if (raw.running && Number.isFinite(raw.endsAt)){
    if (raw.endsAt > Date.now()){
      pomo.running = true; pomo.endsAt = raw.endsAt; pomo.leftMs = null;
      // 旧存档无 segmentMs：用 endsAt 推不出开始时刻，回退当前预设
      if (!(Number.isFinite(pomo.segmentMs) && pomo.segmentMs > 0)) {
        pomo.segmentMs = durationOf(pomo.mode);
      }
      startTick();
    } else {
      /* 人不在的时候那一段已经跑完了 */
      const realEndedAt = raw.endsAt; // 先留住真实结束时刻，打卡用它而不是重启时刻
      // 旧存档无 segmentMs 时与仍在跑的分支一致：回退当前预设，避免打卡时长 0
      if (!(Number.isFinite(pomo.segmentMs) && pomo.segmentMs > 0)) {
        pomo.segmentMs = durationOf(pomo.mode);
      }
      pomo.running = false; pomo.endsAt = null;
      finishSegment(true, realEndedAt);
    }
  } else if (Number.isFinite(raw.leftMs)){
    pomo.leftMs = Math.max(0, raw.leftMs);
    if (!(Number.isFinite(pomo.segmentMs) && pomo.segmentMs > 0)) {
      pomo.segmentMs = durationOf(pomo.mode);
    }
  }
  reconcilePomoTask();
}

/** 导入、跨标签同步或旧存档不能留下指向不存在/已完成待办的绑定。 */
function reconcilePomoTask(){
  if (!pomo.taskId) return false;
  const task = todos.find((t) => t.id === pomo.taskId);
  if (task && !task.completed) return false;
  pomo.taskId = null;
  savePomo();
  return true;
}

function remaining(){
  if (pomo.running && pomo.endsAt) return Math.max(0, pomo.endsAt - Date.now());
  if (pomo.leftMs != null) return pomo.leftMs;
  return durationOf(pomo.mode);
}

function chime(kind){
  if (!pomo.sound) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = audioCtx || new AC();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const notes = kind === "rest" ? [784, 587, 494] : [523, 659, 784];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = f;
      const t0 = audioCtx.currentTime + i * 0.16;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.14, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0); o.stop(t0 + 0.6);
    });
  } catch { /* 音频起不来不影响计时 */ }
}
function notify(title, body){
  if (!pomo.sound) return;
  try {
    if (typeof window.__luminaNotifyNow === "function") {
      window.__luminaNotifyNow(title, body);
      return;
    }
  } catch { /* fall through */ }
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (!document.hidden) return;      // 人在页面上就别弹系统通知了
    new Notification(title, { body, silent:true });
  } catch { /* 通知失败无所谓 */ }
}

/** 把番茄状态交给 iOS 调度/取消本地通知；桌面环境为 no-op。 */
function syncNativePomoNotify(){
  try {
    if (typeof window.__luminaOnPomoChange !== "function") return;
    window.__luminaOnPomoChange({
      running: pomo.running,
      sound: pomo.sound,
      mode: pomo.mode,
      endsAt: pomo.endsAt,
    });
  } catch { /* ignore */ }
}

function startTick(){
  clearInterval(pomoTick);
  pomoTick = setInterval(() => {
    if (!pomo.running) return;
    if (remaining() <= 0) finishSegment(false);
    else renderPomo();
  }, 250);
}
function stopTick(){ clearInterval(pomoTick); pomoTick = null; }

/* 休息期间每 70 秒念叨一次，切走了就不念（不烦人） */
function startNag(){
  clearInterval(nagTimer);
  nagTimer = setInterval(() => {
    if (!pomo.running || !isResting()) return;
    if (!document.hidden) say("restNag");
  }, 70000);
}
function stopNag(){ clearInterval(nagTimer); nagTimer = null; }

/** 用户手动操作后，过期的「专注结束后自动休息」回调不得覆盖新状态。 */
function cancelSegmentTransition(){
  segmentTransitionVersion++;
  if (segmentTransitionTimer){
    clearTimeout(segmentTransitionTimer);
    segmentTransitionTimer = null;
  }
}
function scheduleSegmentTransition(){
  cancelSegmentTransition();
  const version = segmentTransitionVersion;
  segmentTransitionTimer = setTimeout(() => {
    segmentTransitionTimer = null;
    if (version !== segmentTransitionVersion || pomo.running || !isResting() || pomo.leftMs != null) return;
    startSegment(pomo.mode, true, { fromTransition:true });
  }, 900);
}

function startSegment(mode, announce, opts = {}){
  if (!opts.fromTransition) cancelSegmentTransition();
  pomo.mode = mode;
  pomo.running = true;
  const dur = durationOf(mode);
  pomo.segmentMs = dur;
  pomo.endsAt = Date.now() + dur;
  pomo.leftMs = null;
  pomo.halfSaid = false;
  pomo.nearSaid = false;
  startTick();
  if (isResting()) startNag(); else stopNag();
  savePomo(); renderPomo(); render();
  if (announce !== false){
    if (mode === "focus") say("focusStart");
    else say(mode === "long" ? "longRest" : "restStart");
  }
}

/* 把刚跑完的这一段专注同步到 ClickUp。永不抛错（硬约束 3：失败不影响计时 UI）。 */
function logPomoToClickUp(endedAt, segmentMs){
  try {
    const bridge = window.luminaClickUp;
    if (!bridge || typeof bridge.logPomo !== "function") return; // 网页版没有桥

    const task = pomo.taskId ? todos.find((x) => x.id === pomo.taskId) : null;
    // 优先用本段开始时记下的时长，避免中途换预设把 25 记成 50
    const ms = Number.isFinite(segmentMs) && segmentMs > 0 ? segmentMs : durationOf("focus");
    const minutes = Math.round(ms / MIN);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const at = Number.isFinite(endedAt) && endedAt > 0 ? Math.trunc(endedAt) : Date.now();
    // Same completed segment must retain its id across queue recovery or an
    // app restart after the POST has already left the device.
    const operationId = "pomo-" + at + "-" + minutes;

    // 不用 await：finishSegment 必须立刻落盘/渲染；同步抛也要吞掉
    Promise.resolve(
      bridge.logPomo({
        title: task ? task.text : "",
        minutes,
        endedAt: at,
        operationId,
      })
    )
      .then((r) => { if (!r || !r.ok) console.warn("[clickup] 打卡未成功：", r && r.error); })
      .catch((e) => console.warn("[clickup] 打卡异常：", e));
  } catch (e) {
    console.warn("[clickup] 打卡异常：", e);
  }
}

function finishSegment(silentCatchUp, endedAtOverride){
  cancelSegmentTransition();
  const wasFocus = pomo.mode === "focus";
  /* 必须在清空 endsAt 之前取真实结束时刻：
   * - restorePomo 显式传入 raw.endsAt
   * - 切回标签页 / tick 补跑时 pomo.endsAt 仍是当初那一段的墙钟时刻
   * 否则 ClickUp 会把关机/后台期间那段记成「现在」 */
  const realEndedAt = Number.isFinite(endedAtOverride)
    ? endedAtOverride
    : (Number.isFinite(pomo.endsAt) ? pomo.endsAt : Date.now());
  const finishedSegmentMs = pomo.segmentMs;
  pomo.running = false;
  pomo.endsAt = null;
  pomo.leftMs = null;
  stopTick(); stopNag();

  if (wasFocus){
    pomo.round++;
    const today = todayStr();
    const finishedDay = dayKey(realEndedAt);
    if (pomo.tallyDay !== today){ pomo.tallyDay = today; pomo.tally = 0; }
    // A segment recovered after midnight belongs to its actual completion day.
    if (finishedDay === today) pomo.tally++;
    /* 给绑定的待办记一个番茄 */
    if (pomo.taskId){
      const t = todos.find((x) => x.id === pomo.taskId);
      if (t){ t.pomodoros = (t.pomodoros || 0) + 1; t.updatedAt = Date.now(); persist(); }
    }
    const nextMode = pomo.round % preset().per === 0 ? "long" : "short";
    // 先落盘「已结算」，再异步打卡：崩溃后不可重复记番茄 / 重复打卡
    pomo.mode = nextMode;
    pomo.segmentMs = null;
    savePomo();
    /* 同步到 ClickUp：失败只写日志，绝不影响计时 */
    logPomoToClickUp(realEndedAt, finishedSegmentMs);
    chime("rest");
    renderPomo(); render();
    if (silentCatchUp){
      say("focusEnd");
      toast("你不在的时候，那一轮已经结束了");
      return;
    }
    say("focusEnd");
    notify("专注结束", "该休息了。");
    /* 休息自动开始：这是「催你休息」的核心，不给你不休息的选项 */
    scheduleSegmentTransition();
  } else {
    chime("focus");
    pomo.mode = "focus";
    pomo.segmentMs = null;
    savePomo(); renderPomo(); render();
    if (silentCatchUp){ say("restEnd"); return; }
    say("restEnd");
    notify("休息结束", "可以继续了。");
  }
}

function toggleRun(){
  cancelSegmentTransition();
  if (pomo.running){
    pomo.leftMs = remaining();
    pomo.running = false;
    pomo.endsAt = null;
    // 暂停保留 segmentMs，继续时仍按本段原时长打卡
    stopTick(); stopNag();
    savePomo(); renderPomo(); render();
    say("pause");
  } else {
    const left = pomo.leftMs != null && pomo.leftMs > 0 ? pomo.leftMs : durationOf(pomo.mode);
    if (!(Number.isFinite(pomo.segmentMs) && pomo.segmentMs > 0)) {
      pomo.segmentMs = durationOf(pomo.mode);
    }
    pomo.running = true;
    pomo.endsAt = Date.now() + left;
    pomo.leftMs = null;
    pomo.halfSaid = false; pomo.nearSaid = false;
    startTick();
    if (isResting()) startNag();
    savePomo(); renderPomo(); render();
    if (pomo.mode === "focus") say("focusStart");
    else say(pomo.mode === "long" ? "longRest" : "restStart");
    /* 音频上下文必须在用户手势里解锁 */
    if (pomo.sound){
      try { const AC = window.AudioContext || window.webkitAudioContext; if (AC){ audioCtx = audioCtx || new AC(); audioCtx.resume(); } } catch {}
    }
  }
}

function skipSegment(){
  cancelSegmentTransition();
  const skippingRest = isResting();
  stopTick(); stopNag();
  pomo.running = false; pomo.endsAt = null; pomo.leftMs = null; pomo.segmentMs = null;
  if (skippingRest){
    pomo.mode = "focus";
    savePomo(); renderPomo(); render();
    say("skipRest");                  // 跳过休息她会有意见
  } else {
    pomo.mode = pomo.round % preset().per === (preset().per - 1) ? "long" : "short";
    savePomo(); renderPomo(); render();
    say("restStart");
  }
}

function resetSegment(){
  cancelSegmentTransition();
  stopTick(); stopNag();
  pomo.running = false; pomo.endsAt = null; pomo.leftMs = null; pomo.segmentMs = null;
  pomo.halfSaid = false; pomo.nearSaid = false;
  savePomo(); renderPomo(); render();
}

function focusOnTask(id){
  const t = todos.find((x) => x.id === id);
  if (!t || t.completed) return;
  pomo.taskId = id;
  if (isResting()){
    /* 休息还没结束就想干活？先说一句再放行 */
    say("skipRest");
    stopNag();
    pomo.mode = "focus";
  }
  startSegment("focus", true);
  toast(`开始专注：${t.text.slice(0, 18)}${t.text.length > 18 ? "…" : ""}`);
}
function setPomoPreset(idx){
  if (!PRESETS[idx]) return null;
  pomo.presetIdx = idx;
  if (!pomo.running){
    pomo.leftMs = null;
    // 专注刚结束的 900ms 过渡中，要按照新预设重新决定短休息/长休息。
    if (segmentTransitionTimer){
      pomo.mode = pomo.round % preset().per === 0 ? "long" : "short";
    }
  }
  savePomo(); renderPomo();
  return PRESETS[idx];
}

function renderPomo(){
  const total = durationOf(pomo.mode);
  const left = remaining();
  const ratio = total > 0 ? 1 - left / total : 0;

  pomoEl.dataset.mode = pomo.mode;
  pomoEl.dataset.run = String(pomo.running);
  charaWrap.dataset.resting = String(pomo.running && isResting());

  pomoArc.style.strokeDasharray = String(ARC_LEN);
  pomoArc.style.strokeDashoffset = String(ARC_LEN * (1 - ratio));
  pomoGlyph.textContent = MODE_LABEL[pomo.mode];
  pomoTime.textContent = mmss(left);

  /* 副标题：优先显示绑定的待办。用 textContent 塞进 <b>，不拼 HTML */
  const task = pomo.taskId ? todos.find((t) => t.id === pomo.taskId) : null;
  if (pomo.running && pomo.mode === "focus" && task){
    pomoSub.replaceChildren();
    const b = document.createElement("b");
    b.textContent = task.text;
    pomoSub.appendChild(b);
    pomoSub.title = task.text;
  } else {
    pomoSub.title = "";
    pomoSub.textContent = pomo.running
      ? (isResting() ? "别看屏幕了，走两步" : "专注中")
      : (pomo.leftMs != null && pomo.leftMs > 0 ? "已暂停" : isResting() ? "该休息了" : "准备好了就开始");
  }

  /* 轮次点 */
  const per = preset().per;
  const doneInCycle = pomo.round % per;
  if (pomoDots.childElementCount !== per){
    pomoDots.replaceChildren();
    for (let i = 0; i < per; i++) pomoDots.appendChild(document.createElement("i"));
  }
  [...pomoDots.children].forEach((el, i) => el.classList.toggle("on", i < doneInCycle));

  pomoMainTxt.textContent = pomo.running
    ? "暂停"
    : (pomo.leftMs != null && pomo.leftMs > 0 ? "继续" : (isResting() ? "开始休息" : "开始专注"));
  pomoMainIco.innerHTML = pomo.running
    ? '<path d="M8.5 4.5h3.2v15H8.5zM14.3 4.5h3.2v15h-3.2z" fill="currentColor" stroke="none"/>'
    : '<path d="M7 4.5 19 12 7 19.5Z" fill="currentColor" stroke="none"/>';
  pomoPreset.textContent = preset().label;
  pomoTally.textContent = `今天 ${pomo.tally} 个`;
  pomoBell.setAttribute("aria-pressed", String(pomo.sound));

  /* 工具条胶囊 + 标签页标题 */
  if (pomo.running){
    tbPomo.hidden = false;
    tbPomo.dataset.rest = String(isResting());
    tbPomoLab.textContent = MODE_LABEL[pomo.mode];
    tbPomoTime.textContent = mmss(left);
    document.title = `${mmss(left)} · ${MODE_LABEL[pomo.mode]} — ${BASE_TITLE}`;
  } else {
    tbPomo.hidden = true;
    document.title = BASE_TITLE;
  }

  /* 中途的两句提醒，各只说一次 */
  if (pomo.running && pomo.mode === "focus" && total > 4 * MIN){
    if (!pomo.halfSaid && left <= total / 2){ pomo.halfSaid = true; say("focusHalf"); }
    else if (!pomo.nearSaid && left <= 60000){ pomo.nearSaid = true; say("focusNear"); }
  }
}

/* ---------------------------------------------------------------- 主题 */
function buildThemeList(){
  const frag = document.createDocumentFragment();
  THEME_IDS.forEach((id) => {
    const t = THEMES[id];
    const b = document.createElement("button");
    b.type = "button";
    b.className = "theme-opt";
    b.dataset.theme = id;
    b.setAttribute("role","radio");
    b.setAttribute("aria-checked","false");
    b.innerHTML =
      `<span class="theme-face"><img data-theme="${id}" src="${t.art}" alt=""></span>`
      + `<span class="theme-meta">`
      +   `<span class="theme-nm">${t.name}<span class="jp">${t.jp} · ${t.charName}</span></span>`
      +   `<span class="theme-desc">${t.desc}</span>`
      + `</span>`
      + `<svg class="theme-tick" viewBox="0 0 24 24"><path d="M4.5 12.5 9.5 17.5 19.5 6.5"/></svg>`;
    b.addEventListener("click", () => { applyTheme(id, true); themePop.hidePopover?.(); });
    frag.appendChild(b);
  });
  themeList.appendChild(frag);
}

function applyTheme(id, announce){
  if (!THEMES[id]) id = "kanna";
  currentTheme = id;
  const t = THEMES[id];
  document.documentElement.dataset.theme = id;
  brandName.textContent = t.brand;
  titleMarkUse.setAttribute("href", t.mark);
  composerMarkUse.setAttribute("href", t.mark);
  bubbleName.textContent = t.charName;
  todoInput.placeholder = t.placeholder;
  themeList.querySelectorAll(".theme-opt").forEach((el) => {
    el.setAttribute("aria-checked", String(el.dataset.theme === id));
  });
  paintPortrait();
  makeCutout(id);
  try { store.set(THEME_KEY, id); } catch { /* 主题存不下不影响使用 */ }
  lastLine = "";
  if (announce) say("hello");
  if (!emptyState.hidden) renderEmpty();
}
function cycleTheme(){
  const i = THEME_IDS.indexOf(currentTheme);
  applyTheme(THEME_IDS[(i + 1) % THEME_IDS.length], true);
}
/* popover 定位：贴按钮右下角，超出视口往里收 */
function placePopover(){
  warmOtherCutouts();
  const r = themeBtn.getBoundingClientRect();
  const w = Math.min(292, window.innerWidth - 20);
  themePop.style.width = w + "px";
  themePop.style.top = (r.bottom + 8) + "px";
  themePop.style.left = Math.max(10, Math.min(r.right - w, window.innerWidth - w - 10)) + "px";
}

/* ============================================================================
 * 校验
 * 任何进入内存的数据都必须过这一关：localStorage 可能被人手改过，
 * 导入的 JSON 更是完全不可信。字段缺失、类型错误、id 重复全部就地修正。
 * ==========================================================================*/
function safeTimestamp(value, fallback){
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= MAX_JS_TIME ? n : fallback;
}

function sanitizeTodo(raw, seen){
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const text = typeof raw.text === "string" ? raw.text.trim().slice(0, MAX_TEXT) : "";
  if (!text) return null;
  let id = typeof raw.id === "string" && raw.id.length > 0 && raw.id.length <= 64 ? raw.id : uid();
  if (seen.has(id)) id = uid();
  seen.add(id);

  const createdAt = safeTimestamp(raw.createdAt, Date.now());
  const updatedAt = safeTimestamp(raw.updatedAt, createdAt);
  const completed = raw.completed === true;
  /* v2 及更早没有 completedAt：用 updatedAt 兜底，历史视图才不会全挤在「更早」 */
  const completedAt = completed
    ? safeTimestamp(raw.completedAt, updatedAt)
    : null;
  const pomodoros = boundedInt(raw.pomodoros, 0, 999, 0);
  const clickupTaskId =
    typeof raw.clickupTaskId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw.clickupTaskId)
      ? raw.clickupTaskId
      : null;
  let clickupUrl = null;
  if (
    typeof raw.clickupUrl === "string" &&
    raw.clickupUrl.length > 0 &&
    raw.clickupUrl.length <= 300
  ){
    try {
      const u = new URL(raw.clickupUrl);
      if (u.protocol === "https:" && (u.hostname === "app.clickup.com" || u.hostname === "clickup.com")) {
        clickupUrl = u.toString();
      }
    } catch { /* drop */ }
  }
  // 有合法 taskId 但 url 脏：补官方 deep link，避免丢关联
  if (clickupTaskId && !clickupUrl) clickupUrl = "https://app.clickup.com/t/" + clickupTaskId;

  return {
    id, text, completed,
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : "low",
    category: CATEGORIES.includes(raw.category) ? raw.category : "inbox",
    dueDate: isISODate(raw.dueDate) ? raw.dueDate : null,
    createdAt, updatedAt, completedAt, pomodoros,
    clickupTaskId,
    clickupUrl,
  };
}
function sanitizeList(arr){
  if (!Array.isArray(arr)) return { todos:[], dropped:0 };
  const seen = new Set(); const out = []; let dropped = 0;
  for (const raw of arr){
    if (out.length >= MAX_ITEMS){ dropped++; continue; }
    const t = sanitizeTodo(raw, seen);
    if (t) out.push(t); else dropped++;
  }
  return { todos: out, dropped };
}

/* ------------------------------------------------------------ 读取/迁移 */
function loadState(){
  let recovered = 0;
  const rawV2 = store.get(STORAGE_KEY);
  if (rawV2){
    try {
      const parsed = JSON.parse(rawV2);
      const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.todos) ? parsed.todos : null;
      if (list){ const r = sanitizeList(list); todos = r.todos; recovered = r.dropped; }
      else recovered = -1;
    } catch { recovered = -1; }
    return recovered;
  }
  const rawV1 = store.get(LEGACY_KEY);
  if (rawV1){
    try { const r = sanitizeList(JSON.parse(rawV1)); todos = r.todos; recovered = r.dropped; persist(); }
    catch { recovered = -1; }
  }
  return recovered;
}

/* ---------------------------------------------------------------- 写入 */
function persist(){
  const payload = JSON.stringify({ v:SCHEMA_VERSION, writer:TAB_ID, savedAt:Date.now(), todos });
  if (!storageWritable){ setPersistState("unavailable"); return false; }
  try {
    store.set(STORAGE_KEY, payload);
    setPersistState("ok");
    flashSaved();
    return true;
  } catch (err) {
    const quota = err && (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED" || err.code === 22);
    setPersistState(quota ? "quota" : "error");
    return false;   // 写失败绝不中断 UI，改动仍在内存里
  }
}

/* ---------------------------------------------------------------- 撤销 */
function snapshot(label){
  undoStack.push({ label, todos: todos.map((t) => ({ ...t })), pomoTaskId:pomo.taskId });
  if (undoStack.length > UNDO_DEPTH) undoStack.shift();
  syncUndoBtn();
}
function undo(){
  const snap = undoStack.pop();
  syncUndoBtn();
  if (!snap){ toast("没有可以撤销的操作了"); return; }
  todos = snap.todos;
  pomo.taskId = typeof snap.pomoTaskId === "string" && todos.some((t) => t.id === snap.pomoTaskId && !t.completed)
    ? snap.pomoTaskId
    : null;
  savePomo();
  persist(); render();
  play("r-nod");
  toast(`已撤销：${snap.label}`);
}

/* ------------------------------------------------------------ 存储提示 */
const NOTICE_COPY = {
  unavailable: {
    sandbox: ["预览环境不保存数据","当前页面被嵌在预览窗口里（或用 file:// 打开），浏览器不允许写本地存储。功能都能用，但刷新即丢。下载文件正常打开、或部署到任意域名下，就会自动开始保存。","note"],
    private: ["无痕模式下不长期保存","浏览器在隐私窗口里限制了本地存储。可以照常使用，关闭窗口后数据不保留，重要内容请先导出备份。","note"],
    blocked: ["浏览器禁止了本地存储","该站点的存储权限被关闭。在浏览器设置里允许本站保存数据后刷新，或先导出备份再换环境使用。","note"],
  },
  quota: ["存储空间已满","最近的改动没能写入磁盘。请先导出备份，再清除已完成事项腾出空间。","warn"],
  error: ["保存失败","写入本地存储时出错，改动仍在页面中但没有落盘。建议立即导出备份。","warn"],
};
function setPersistState(next){
  if (persistState === next) return;
  persistState = next;
  noticeDismissed = false;
  renderNotice(); renderStoreChip();
}
function renderNotice(){
  if (persistState === "ok" || noticeDismissed){ notice.hidden = true; return; }
  const e = persistState === "unavailable"
    ? NOTICE_COPY.unavailable[unavailableReason] || NOTICE_COPY.unavailable.blocked
    : NOTICE_COPY[persistState];
  if (!e){ notice.hidden = true; return; }
  noticeTitle.textContent = e[0];
  noticeBody.textContent = e[1];
  notice.dataset.tone = e[2];
  notice.hidden = false;
}
function renderStoreChip(){
  const map = {
    ok:          ["ok",  "本地存储"],
    unavailable: ["off", unavailableReason === "sandbox" ? "预览模式" : unavailableReason === "private" ? "无痕模式" : "存储被禁用"],
    quota:       ["bad", "空间已满"],
    error:       ["bad", "保存失败"],
  }[persistState];
  storeChip.dataset.state = map[0];
  storeLabel.textContent = map[1];
}

let savedTimer = null;
function flashSaved(){
  savedFlash.classList.add("on");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedFlash.classList.remove("on"), 950);
}

/* -------------------------------------------------------------- 撒花 */
function themeSparkColors(){
  const cs = getComputedStyle(document.documentElement);
  return [1,2,3,4].map((i) => cs.getPropertyValue(`--spark-${i}`).trim() || "currentColor");
}
function burst(x, y, count){
  if (reducedMotion()) return;
  const shapes = THEMES[currentTheme].spark;
  const colors = themeSparkColors();
  const n = count || 7;
  for (let i = 0; i < n; i++){
    const s = document.createElement("span");
    s.className = "spark";
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const dist = 26 + Math.random() * 30;
    s.style.left = x + "px";
    s.style.top = y + "px";
    s.style.setProperty("--dx", `${Math.cos(a) * dist}px`);
    s.style.setProperty("--dy", `${Math.sin(a) * dist - 10}px`);
    s.style.setProperty("--rot", `${Math.random() * 220 - 110}deg`);
    s.style.animationDelay = `${i * 14}ms`;
    s.style.color = colors[i % colors.length];
    s.innerHTML = `<svg viewBox="0 0 24 24" width="9" height="9"><use href="${shapes[i % shapes.length]}"/></svg>`;
    sparkles.appendChild(s);
    s.addEventListener("animationend", () => s.remove(), { once:true });
    setTimeout(() => s.remove(), 1200); // animationend 不触发时兜底
  }
}
function burstAtChara(count){
  const r = charaBtn.getBoundingClientRect();
  if (!r.width) return;
  burst(r.left + r.width / 2, r.top + r.height * .34, count);
}

/* ---------------------------------------------------------------- Toast */
let toastTimer = null;
function toast(message, action){
  toastMsg.textContent = message;
  if (action){
    toastAction.hidden = false;
    toastAction.textContent = action.label;
    toastAction.onclick = () => { hideToast(); action.run(); };
  } else {
    toastAction.hidden = true; toastAction.onclick = null;
  }
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 6000 : 2200);
}
function hideToast(){ clearTimeout(toastTimer); toastEl.classList.remove("show"); toastAction.onclick = null; }

/* ---------------------------------------------------------------- 派生 */
const isOverdue = (t) => !t.completed && t.dueDate !== null && t.dueDate < todayStr();
const isToday   = (t) => t.dueDate !== null && t.dueDate === todayStr();
const isHistory = () => currentFilter === "history";

function matchesFilter(t, f){
  if (f.startsWith("cat:")) return t.category === f.slice(4);
  if (f === "active") return !t.completed;
  if (f === "history") return t.completed;
  if (f === "overdue") return isOverdue(t);
  if (f === "today") return !t.completed && (isToday(t) || isOverdue(t));
  return true;
}
function getVisible(){
  const q = searchQuery;
  let list = todos.filter((t) => matchesFilter(t, currentFilter) && (!q || t.text.toLowerCase().includes(q)));
  if (isHistory()){
    if (historyRange > 0){
      const cutoff = startOfDay(Date.now()) - (historyRange - 1) * DAY_MS;
      list = list.filter((t) => (t.completedAt ?? t.updatedAt) >= cutoff);
    }
    list = list.slice().sort((a,b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt));
  }
  return list;
}
/* 筛选或搜索状态下禁止排序：视觉相邻的两项在数组里可能隔着隐藏项 */
const sortingEnabled = () => currentFilter === "all" && searchQuery === "";
const isTouchUi =
  ("ontouchstart" in window) ||
  (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0);

/* ---------------------------------------------------------------- 渲染 */
function render(){
  const visible = getVisible();
  const sortable = sortingEnabled();
  const history = isHistory();

  composer.hidden = history;
  if (history) composer.classList.remove("is-open");
  historyBar.hidden = !history;

  todoList.replaceChildren();
  if (visible.length){
    emptyState.hidden = true;
    const frag = document.createDocumentFragment();
    if (history) renderGrouped(visible, frag);
    else visible.forEach((t, i) => frag.appendChild(buildRow(t, i, sortable)));
    todoList.appendChild(frag);
  } else {
    emptyState.hidden = false;
    renderEmpty();
  }

  viewTitle.textContent = currentFilter.startsWith("cat:")
    ? CATEGORY_LABELS[currentFilter.slice(4)]
    : SMART_TITLES[currentFilter] || "全部";
  viewCount.textContent = visible.length ? `${visible.length} 件` : "";
  sortNote.textContent = history
    ? "按完成时间倒序"
    : sortable
      ? (isTouchUi ? "长按手柄可排序" : "拖动手柄可排序")
      : "筛选中，排序已锁定";

  if (history) renderHistoryStat(visible);
  updateStats();
}

function groupLabel(key){
  const diff = daysBetween(key, todayStr());
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff === 2) return "前天";
  if (diff < 7) return `${diff} 天前`;
  const [y,m,d] = key.split("-").map(Number);
  const wd = "日一二三四五六"[new Date(y, m-1, d).getDay()];
  return y === new Date().getFullYear() ? `${m}月${d}日 周${wd}` : `${y}年${m}月${d}日`;
}
function renderGrouped(list, frag){
  // 先扫一遍计数，避免每个分组 O(n) filter 导致 O(n²)。
  const dayCounts = new Map();
  for (const t of list){
    const key = dayKey(t.completedAt ?? t.updatedAt);
    dayCounts.set(key, (dayCounts.get(key) || 0) + 1);
  }
  let lastKey = null, i = 0;
  for (const t of list){
    const key = dayKey(t.completedAt ?? t.updatedAt);
    if (key !== lastKey){
      lastKey = key;
      const n = dayCounts.get(key) || 0;
      const head = document.createElement("li");
      head.className = "group-head";
      head.innerHTML = `<span class="gh-title"></span><span class="gh-sub tnum"></span>`
        + `<span class="gh-rule"></span><span class="gh-n tnum">${n} 件</span>`;
      head.querySelector(".gh-title").textContent = groupLabel(key);
      if (daysBetween(key, todayStr()) < 7){
        const [, m, d] = key.split("-").map(Number);
        head.querySelector(".gh-sub").textContent = `${m}/${d}`;
      }
      frag.appendChild(head);
    }
    frag.appendChild(buildRow(t, i++, false));
  }
}

function renderHistoryStat(visible){
  if (visible.length === 0){ historyStat.textContent = ""; return; }
  const days = new Set(visible.map((t) => dayKey(t.completedAt ?? t.updatedAt))).size;
  const total = todos.filter((t) => t.completed).length;
  const pomos = visible.reduce((n, t) => n + (t.pomodoros || 0), 0);
  const scope = historyRange === 0 ? "全部" : `近 ${historyRange} 天`;
  historyStat.innerHTML = `${scope}完成 <b>${visible.length}</b> 件，分布在 ${days} 天`
    + (pomos > 0 ? ` · ${pomos} 个番茄` : "")
    + (historyRange > 0 && total > visible.length ? ` · 累计 ${total} 件` : "");
}

function renderEmpty(){
  let icon, title, body;

  if (searchQuery){
    icon = "search"; title = "什么都没找到呢…";
    body = `“${searchInput.value.trim()}” 没有命中任何一条。换个词试试，或者清空搜索框。`;
  } else if (isHistory()){
    icon = "clock";
    if (todos.some((x) => x.completed)){
      title = "这段时间还没有记录";
      body = `${historyRange === 0 ? "全部" : `近 ${historyRange} 天`}没有完成的事项。把范围放宽看看？`;
    } else {
      title = "还没有可以回顾的事";
      body = "勾掉第一件待办，它就会带着完成时间存进这里。";
    }
  } else if (todos.length === 0){
    icon = "note"; title = "还是空空的一天";
    body = "在上面那一行写下第一件事吧。点一下输入框，就会展开优先级、分类和日期。";
  } else {
    const m = {
      today:   ["check","今天没有安排哦","没有截止到今天、也没有逾期的事项。"],
      overdue: ["check","一件都没拖延","所有带日期的待办都还在时间之内，很棒。"],
      active:  ["check","全部搞定啦","当前没有进行中的事项，休息一下吧。"],
    }[currentFilter] || ["note","这个分类是空的","换个视图看看，或者给新待办选上这个分类。"];
    [icon, title, body] = m;
  }

  emptyMark.innerHTML = EMPTY_ICONS[icon];
  emptyTitle.textContent = title;
  emptyBody.textContent = body;

  const line = pickLine(isHistory() ? "history" : todos.length === 0 ? "hello" : "allDone");
  emptyLine.textContent = line ? `「${line}」` : "";
  emptyLine.hidden = !line;
}

function buildRow(todo, index, sortable){
  const node = rowTpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = todo.id;
  node.style.setProperty("--i", String(Math.min(index, 14)));
  node.classList.add(`prio-${todo.priority}`);
  if (todo.completed) node.classList.add("done");
  if (pomo.running && pomo.mode === "focus" && pomo.taskId === todo.id) node.classList.add("focusing");
  node.draggable = sortable;

  /* 全部用 textContent，不拼 HTML：待办正文是用户输入，绝不进 innerHTML */
  const textEl = node.querySelector(".row-text");
  textEl.textContent = todo.text;
  node.title = todo.text;

  const check = node.querySelector(".check");
  check.setAttribute("aria-pressed", String(todo.completed));

  const flag = node.querySelector(".flag");
  if (todo.priority === "high"){ flag.innerHTML = '<use href="#sym-heart"/>'; flag.style.color = "var(--accent)"; }
  else if (todo.priority === "medium"){ flag.innerHTML = '<use href="#sym-star4"/>'; flag.style.color = "var(--alt)"; }
  flag.setAttribute("title", PRIO_LABELS[todo.priority]);

  if (todo.pomodoros > 0){
    const el = node.querySelector(".meta-pomo");
    el.hidden = false;
    el.querySelector(".meta-pomo-n").textContent = `×${todo.pomodoros}`;
    el.title = `已投入 ${todo.pomodoros} 个番茄`;
  }

  node.querySelector(".meta-cat").textContent = CATEGORY_LABELS[todo.category];

  const due = formatDue(todo.dueDate, todo.completed);
  if (due){
    const el = node.querySelector(".meta-due");
    el.hidden = false; el.textContent = due.label; el.dataset.state = due.state;
    if (due.title) el.title = due.title;
  }

  if (todo.clickupTaskId){
    const el = node.querySelector(".meta-cu");
    if (el){
      el.hidden = false;
      const url = isSafeClickUpUrl(todo.clickupUrl) ? todo.clickupUrl : null;
      const dueHint = formatScheduleLabel(todo.dueDate);
      el.title = url
        ? ("已传到 ClickUp · 点击打开" + (dueHint ? " · 本地截止 " + dueHint : ""))
        : ("已传到 ClickUp · " + todo.clickupTaskId);
      if (url){
        el.classList.add("is-link");
        el.setAttribute("role", "link");
        el.tabIndex = 0;
        const open = (e) => {
          e.stopPropagation();
          e.preventDefault();
          openSafeClickUp(url);
        };
        el.addEventListener("click", open);
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") open(e);
        });
      }
    }
  } else if (!todo.completed){
    /* 未同步：行上常驻「↑CU」，不用悬停才出现 */
    const pushMeta = node.querySelector(".meta-cu-push");
    if (pushMeta){
      pushMeta.hidden = false;
      const dueHint = formatScheduleLabel(todo.dueDate);
      pushMeta.title = dueHint
        ? "传到 ClickUp My Work（日程 " + dueHint + "）"
        : "传到 ClickUp My Work（无截止日期 → 日程默认今天）";
      pushMeta.addEventListener("click", (e) => {
        e.stopPropagation();
        pushTodoToClickUp(todo.id, pushMeta);
      });
    }
  }

  if (todo.completed && isHistory()){
    const ts = todo.completedAt ?? todo.updatedAt;
    const el = node.querySelector(".meta-done");
    el.hidden = false;
    el.querySelector(".meta-done-txt").textContent =
      new Intl.DateTimeFormat("zh-CN", { hour:"2-digit", minute:"2-digit", hour12:false }).format(ts);
    el.title = new Intl.DateTimeFormat("zh-CN", { dateStyle:"long", timeStyle:"short" }).format(ts) + " 完成";
  }

  check.addEventListener("click", (e) => { e.stopPropagation(); toggleTodo(todo.id, check); });
  node.querySelector('[data-act="focus"]').addEventListener("click", (e) => { e.stopPropagation(); focusOnTask(todo.id); });
  const cuBtn = node.querySelector('[data-act="clickup"]');
  if (cuBtn){
    if (todo.clickupTaskId){
      cuBtn.classList.add("is-synced");
      cuBtn.title = isSafeClickUpUrl(todo.clickupUrl)
        ? "打开 ClickUp 任务"
        : "已同步到 ClickUp";
      cuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isSafeClickUpUrl(todo.clickupUrl)) openSafeClickUp(todo.clickupUrl);
        else pushTodoToClickUp(todo.id, cuBtn);
      });
    } else {
      cuBtn.title = "传到 ClickUp My Work";
      cuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        pushTodoToClickUp(todo.id, cuBtn);
      });
    }
  }
  node.querySelector('[data-act="edit"]').addEventListener("click", () => startEdit(node, todo.id));
  node.querySelector('[data-act="delete"]').addEventListener("click", () => removeTodo(todo.id));
  textEl.addEventListener("dblclick", () => startEdit(node, todo.id));
  node.addEventListener("click", (e) => { if (!e.target.closest("button,input")) node.focus(); });

  node.addEventListener("keydown", (e) => {
    if (e.target !== node) return;
    if (e.key === "Enter"){ e.preventDefault(); startEdit(node, todo.id); }
    else if (e.key === " "){ e.preventDefault(); toggleTodo(todo.id, check); }
    else if (e.key === "Backspace" || e.key === "Delete"){ e.preventDefault(); removeTodo(todo.id); }
    else if (e.key.toLowerCase() === "f"){ e.preventDefault(); focusOnTask(todo.id); }
    else if (e.key.toLowerCase() === "u"){ e.preventDefault(); pushTodoToClickUp(todo.id); }
    else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")){ e.preventDefault(); nudge(todo.id, e.key === "ArrowUp" ? -1 : 1); }
    else if (e.key === "ArrowUp" || e.key === "ArrowDown"){ e.preventDefault(); moveFocus(node, e.key === "ArrowUp" ? -1 : 1); }
  });

  if (sortable) attachDrag(node, todo.id);
  return node;
}

function moveFocus(node, delta){
  const rows = [...todoList.querySelectorAll(".row")];
  const i = rows.indexOf(node) + delta;
  if (i < 0){ if (!composer.hidden) todoInput.focus(); return; }
  if (i < rows.length) rows[i].focus();
}

function formatDue(dateStr, completed){
  if (!dateStr) return null;
  const today = todayStr();
  const [y, m, d] = dateStr.split("-").map(Number);
  const full = `${y}年${m}月${d}日`;
  if (!completed && dateStr < today){
    return { label:`逾期 ${daysBetween(dateStr, today)} 天`, state:"overdue", title:`原定 ${full}` };
  }
  if (dateStr === today) return { label:"今天", state:"today", title:full };
  return { label:`${m}月${d}日`, state:"future", title:full };
}

function updateStats(){
  const total = todos.length;
  const done = todos.filter((t) => t.completed).length;
  const active = total - done;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const todayDone = todos.filter((t) => t.completed && dayKey(t.completedAt ?? t.updatedAt) === todayStr()).length;

  statusCounts.textContent = total === 0 ? "空清单" : `共 ${total} 件 · 还剩 ${active} 件 · 今天完成 ${todayDone} 件`;
  statusPct.textContent = `${pct}%`;
  miniFill.style.transform = `scaleX(${pct/100})`;
  miniFill.dataset.full = String(total > 0 && pct === 100);

  const counts = {
    all: total, active, completed: done,
    overdue: todos.filter(isOverdue).length,
    today: todos.filter((t) => !t.completed && (isToday(t) || isOverdue(t))).length,
  };
  CATEGORIES.forEach((c) => { counts["cat:"+c] = todos.filter((t) => t.category === c && !t.completed).length; });
  document.querySelectorAll("[data-count]").forEach((el) => {
    const n = counts[el.dataset.count] ?? 0;
    el.textContent = n === 0 ? "" : n;
  });
  document.querySelector('[data-filter="overdue"]').dataset.warn = String(counts.overdue > 0);
}

function syncUndoBtn(){
  const empty = undoStack.length === 0;
  undoBtn.disabled = empty;
  undoBtn.style.opacity = empty ? ".4" : "1";
  undoBtn.style.pointerEvents = empty ? "none" : "auto";
}

/* ============================================================================
 * 就地编辑
 * settled 闸门是必需的：finish(false) 里把 input 设成 hidden 会同步触发
 * blur，blur 又调 finish(true)，结果「取消」变成「提交」。
 * 必须先摘监听、再改 DOM，且整个 finish 只允许跑一次。
 * ==========================================================================*/
function startEdit(node, id){
  const todo = todos.find((t) => t.id === id);
  if (!todo || editingId) return;
  editingId = id;

  const textEl = node.querySelector(".row-text");
  const input = node.querySelector(".row-edit");
  const original = todo.text;

  textEl.hidden = true;
  input.hidden = false;
  input.value = original;
  input.focus(); input.select();

  let settled = false;
  const finish = (commit) => {
    if (settled) return;
    settled = true;
    input.removeEventListener("blur", onBlur);
    input.removeEventListener("keydown", onKey);
    editingId = null;

    const next = input.value.trim().slice(0, MAX_TEXT);
    input.hidden = true; textEl.hidden = false;

    let committed = false;
    if (commit && next && next !== original){
      const rebased = rebasePendingEdit(id);
      snapshot("编辑待办");
      // 若编辑期间收到了其他标签页的数据，先以那份最新数据为撤销基线，
      // 再覆写本次只编辑的 text；否则一次 undo 会回滚对方的全部改动。
      updateTodo(id, { text: next }, { persist:false });
      persist();
      if (rebased) toast("已同步其他标签页的改动，并保留当前编辑");
      committed = true;
      play("r-nod");
    } else if (commit && !next){
      toast("内容是空的，没有改动");
    }
    flushExternal(committed ? id : null);
  };
  const onBlur = () => finish(true);
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === "Enter"){ e.preventDefault(); finish(true); }
    else if (e.key === "Escape"){ e.preventDefault(); finish(false); }
  };
  input.addEventListener("blur", onBlur);
  input.addEventListener("keydown", onKey);
}

/* ---------------------------------------------------------------- 变更 */
function addTodo(text, priority, category, dueDate){
  if (todos.length >= MAX_ITEMS){ toast(`最多只能保存 ${MAX_ITEMS} 条`); return; }
  snapshot("添加待办");
  const now = Date.now();
  todos.unshift({
    id: uid(), text: text.slice(0, MAX_TEXT), completed: false,
    priority, category, dueDate: isISODate(dueDate) ? dueDate : null,
    createdAt: now, updatedAt: now, completedAt: null, pomodoros: 0,
    clickupTaskId: null, clickupUrl: null,
  });
  render(); persist();
  say("add");
}

/** 正在上传的本地 id，防连点 */
const clickupPushing = new Set();

/** 与主进程 safeClickUpTaskUrl / isClickUpTaskId 对齐的轻量校验（渲染层不信任 IPC 回包） */
function isSafeClickUpTaskId(id){
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}
function isSafeClickUpUrl(url){
  if (typeof url !== "string" || url.length === 0 || url.length > 300) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "app.clickup.com" || u.hostname === "clickup.com");
  } catch {
    return false;
  }
}
/** 经 Electron setWindowOpenHandler → shell.openExternal；非法 url 静默忽略 */
function openSafeClickUp(url){
  if (!isSafeClickUpUrl(url)) return false;
  try {
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  } catch {
    return false;
  }
}
/** YYYY-MM-DD → 口语日程标签（今天 / 明天 / M月D日） */
function formatScheduleLabel(iso){
  if (!isISODate(iso)) return null;
  const today = todayStr();
  if (iso === today) return "今天";
  const t = new Date(today + "T12:00:00");
  t.setDate(t.getDate() + 1);
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  if (iso === `${y}-${m}-${d}`) return "明天";
  const [yy, mm, dd] = iso.split("-").map(Number);
  if (yy === new Date().getFullYear()) return `${mm}月${dd}日`;
  return `${yy}年${mm}月${dd}日`;
}
function findClickUpBtn(todoId){
  try {
    const row = todoList.querySelector(`.row[data-id="${cssEscape(todoId)}"]`);
    if (!row) return null;
    return (
      row.querySelector('[data-act="clickup-meta"]') ||
      row.querySelector('[data-act="clickup"]')
    );
  } catch {
    return null;
  }
}

/**
 * 核心：把本地待办传到 ClickUp My Work（创建任务 + 指派自己）。
 * UI 按钮与 AI Agent 共用。永远 resolve，不 throw。
 * @returns {Promise<{ok:boolean, message?:string, error?:string, code?:string, taskId?:string, url?:string, already?:boolean}>}
 */
async function pushTodoToClickUp(id, btnEl){
  const t = todos.find((x) => x.id === id);
  if (!t){
    return { ok:false, code:"NOT_FOUND", error:"找不到该待办", message:"找不到该待办" };
  }

  if (t.clickupTaskId){
    const url = isSafeClickUpUrl(t.clickupUrl) ? t.clickupUrl : null;
    const msg = "已经在 ClickUp 里了";
    toast(
      msg,
      url ? { label: "打开", run: () => openSafeClickUp(url) } : undefined
    );
    return {
      ok:true,
      already:true,
      taskId: t.clickupTaskId,
      url,
      message: url ? msg + " · 可打开任务" : msg + "（" + t.clickupTaskId + "）",
    };
  }

  const bridge = window.luminaClickUp;
  if (!bridge || typeof bridge.pushTodo !== "function"){
    const msg = "当前环境不支持 ClickUp 上传（请用桌面版 Lumina Todo）";
    toast(msg);
    return { ok:false, code:"NO_BRIDGE", error: msg, message: msg };
  }

  if (clickupPushing.has(id)){
    return { ok:false, code:"BUSY", error:"正在上传中", message:"正在上传中，稍等一下" };
  }
  clickupPushing.add(id);
  let btn = btnEl || findClickUpBtn(id);
  if (btn) btn.classList.add("is-busy");

  // 上传前快照字段：await 期间用户可能改字/改期，仍以上传意图为准
  const payload = {
    title: t.text,
    priority: t.priority,
    dueDate: t.dueDate || null,
    todoId: t.id,
  };
  const snapDue = payload.dueDate;

  try {
    const r = await bridge.pushTodo(payload);
    if (!r || !r.ok){
      const err = (r && r.error) || "传到 ClickUp 失败";
      toast(err);
      console.warn("[clickup] pushTodo 失败：", r);
      return {
        ok:false,
        code: (r && r.code) || "REQUEST_FAILED",
        error: err,
        message: err,
        retryable: Boolean(r && r.retryable),
      };
    }
    const scheduleDay =
      typeof r.scheduleDay === "string" && isISODate(r.scheduleDay)
        ? r.scheduleDay
        : (isISODate(snapDue) ? snapDue : todayStr());
    const scheduleDefaulted = Boolean(r.scheduleDefaulted) || !isISODate(snapDue);
    const dayLabel = formatScheduleLabel(scheduleDay) || scheduleDay;
    const scheduleHint = scheduleDefaulted
      ? `日程${dayLabel}（未设截止日期，已默认）`
      : `日程${dayLabel}`;
    const safeUrl = isSafeClickUpUrl(r.url) ? r.url : null;
    const openAction = safeUrl
      ? { label: "打开", run: () => openSafeClickUp(safeUrl) }
      : undefined;

    // await 后必须重新查找：可能已删除 / 另一路径已写入 taskId
    const live = todos.find((x) => x.id === id);
    if (!live){
      const msg = "已传到 ClickUp（本地条目已删除）· " + scheduleHint;
      toast(msg, openAction);
      return {
        ok:true,
        taskId: isSafeClickUpTaskId(r.taskId) ? r.taskId : undefined,
        url: safeUrl || undefined,
        scheduleDay,
        scheduleDefaulted,
        message: msg,
        orphaned: true,
      };
    }
    if (live.clickupTaskId){
      const url = isSafeClickUpUrl(live.clickupUrl) ? live.clickupUrl : safeUrl;
      const msg = "已经在 ClickUp 里了";
      toast(
        msg,
        url ? { label: "打开", run: () => openSafeClickUp(url) } : undefined
      );
      return {
        ok:true,
        already:true,
        taskId: live.clickupTaskId,
        url: url || null,
        message: msg,
      };
    }
    const taskId = isSafeClickUpTaskId(r.taskId) ? r.taskId : null;
    if (!taskId){
      const msg = "传到 ClickUp 成功但任务 id 异常";
      toast(msg);
      console.warn("[clickup] pushTodo 回包 id 非法：", r);
      return { ok:false, code:"BAD_RESPONSE", error: msg, message: msg };
    }
    live.clickupTaskId = taskId;
    live.clickupUrl = safeUrl || ("https://app.clickup.com/t/" + taskId);
    live.updatedAt = Date.now();
    persist();
    render();
    const msg = "已传到 ClickUp · " + scheduleHint;
    toast(msg, {
      label: "打开",
      run: () => openSafeClickUp(live.clickupUrl),
    });
    return {
      ok:true,
      taskId,
      url: live.clickupUrl,
      scheduleDay,
      scheduleDefaulted,
      todo: serializeTodo(live),
      message: msg + " · " + live.text,
    };
  } catch (e) {
    const msg = "传到 ClickUp 异常";
    toast(msg);
    console.warn("[clickup] pushTodo 异常：", e);
    return { ok:false, code:"EXCEPTION", error: e?.message || msg, message: msg };
  } finally {
    clickupPushing.delete(id);
    // render 可能换掉节点；旧 btn 与新 btn 都清 busy
    if (btn) btn.classList.remove("is-busy");
    const fresh = findClickUpBtn(id);
    if (fresh) fresh.classList.remove("is-busy");
  }
}

function toggleTodo(id, checkEl){
  const t = todos.find((x) => x.id === id);
  if (!t) return;
  const willComplete = !t.completed;
  /* 先取坐标：render() 之后这个节点就没了 */
  if (willComplete && checkEl){
    const r = checkEl.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2);
  }
  snapshot(willComplete ? "标记完成" : "取消完成");
  const now = Date.now();
  t.completed = willComplete;
  t.completedAt = willComplete ? now : null;
  t.updatedAt = now;
  /* 正在专注的那件事被勾掉了，解绑但不打断计时 */
  if (willComplete && pomo.taskId === id){ pomo.taskId = null; savePomo(); }
  render(); persist();
  refocusRow(id);
  if (willComplete){
    const restLeft = todos.filter((x) => !x.completed).length;
    const all = restLeft === 0 && todos.length > 0;
    say(all ? "allDone" : "done");
    if (all) setTimeout(() => burstAtChara(12), 160);
  } else {
    play("r-shake");
  }
}

function updateTodo(id, patch, opts = {}){
  const t = todos.find((x) => x.id === id);
  if (!t) return null;
  Object.assign(t, patch, { updatedAt: Date.now() });
  render();
  if (opts.persist !== false) persist();
  return t;
}

/* 数据先删，动画只是表演：重复点击、中途 render 都安全 */
function removeTodo(id){
  const idx = todos.findIndex((t) => t.id === id);
  if (idx < 0) return; // 幂等，连点两次不会重复提示
  snapshot("删除待办");
  todos.splice(idx, 1);
  if (pomo.taskId === id){ pomo.taskId = null; savePomo(); }
  persist(); updateStats();

  const node = todoList.querySelector(`.row[data-id="${cssEscape(id)}"]`);
  if (node && !reducedMotion()){
    node.classList.add("is-leaving");
    let settled = false;
    const done = () => { if (settled) return; settled = true; render(); };
    node.addEventListener("transitionend", done, { once:true });
    setTimeout(done, 240); // transitionend 不触发时兜底
  } else render();

  say("deleted");
  toast("已删除", { label:"撤销", run:undo });
}

function clearCompleted(){
  const n = todos.filter((t) => t.completed).length;
  if (n === 0){ toast("还没有已完成的待办"); return; }
  snapshot(`清除 ${n} 件已完成`);
  todos = todos.filter((t) => !t.completed);
  render(); persist();
  play("r-shake");
  toast(`已清除 ${n} 件历史记录`, { label:"撤销", run:undo });
}
/** 所有清除入口共用此处，确认永远来自用户而不是 Agent 参数。 */
function requestClearCompleted(){
  const n = todos.filter((t) => t.completed).length;
  if (n === 0) return { ok:true, cleared:0, message:"没有已完成项" };
  if (!window.confirm(`确定清除 ${n} 条已完成待办吗？此操作可通过“撤销”恢复。`)){
    return { ok:false, error:"用户取消了清除操作", code:"USER_CANCELLED", count:n };
  }
  clearCompleted();
  return { ok:true, cleared:n, message:`已清除 ${n} 条已完成` };
}

function nudge(id, delta){
  if (!sortingEnabled()){ toast("清除筛选和搜索后才能排序"); return; }
  const from = todos.findIndex((t) => t.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= todos.length) return;
  snapshot("调整顺序");
  const [item] = todos.splice(from, 1);
  todos.splice(to, 0, item);
  render(); persist();
  refocusRow(id);
}

/* 先移除、再算目标索引，否则往下拖会因为索引偏移落到目标项前面一位 */
function reorder(fromId, toId, placeAfter){
  if (!sortingEnabled() || fromId === toId) return;
  const from = todos.findIndex((t) => t.id === fromId);
  if (from < 0) return;
  snapshot("调整顺序");
  const [item] = todos.splice(from, 1);
  const to = todos.findIndex((t) => t.id === toId);
  if (to < 0){ todos.splice(Math.min(from, todos.length), 0, item); }
  else { todos.splice(placeAfter ? to + 1 : to, 0, item); }
  render(); persist();
  play("r-nod");
}

function refocusRow(id){
  const node = todoList.querySelector(`.row[data-id="${cssEscape(id)}"]`);
  if (node) node.focus({ preventScroll:true });
}

/* ---------------------------------------------------------------- 拖拽 */
let dragId = null;
function clearDragMarks(){
  todoList.querySelectorAll(".drag-over,.drag-over-top").forEach((el) => el.classList.remove("drag-over","drag-over-top"));
}
function attachDrag(node, id){
  node.addEventListener("dragstart", (e) => {
    dragId = id; node.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
    play("r-peek");
  });
  node.addEventListener("dragend", () => { dragId = null; node.classList.remove("dragging"); clearDragMarks(); });
  node.addEventListener("dragover", (e) => {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const r = node.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;   // 指针在下半区 = 插到后面
    node.classList.toggle("drag-over", after);
    node.classList.toggle("drag-over-top", !after);
  });
  node.addEventListener("dragleave", (e) => {
    if (node.contains(e.relatedTarget)) return; // 子元素间移动不闪烁
    node.classList.remove("drag-over","drag-over-top");
  });
  node.addEventListener("drop", (e) => {
    e.preventDefault();
    const after = node.classList.contains("drag-over");
    clearDragMarks();
    const fromId = e.dataTransfer.getData("text/plain") || dragId;
    if (fromId) reorder(fromId, id, after);
  });
}

/* ----------------------------------------------------------- 导入/导出 */
function exportJSON(){
  const blob = new Blob([JSON.stringify({ v:SCHEMA_VERSION, exportedAt:new Date().toISOString(), todos }, null, 2)], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `todo-${todayStr()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  play("r-nod");
  toast(`已导出 ${todos.length} 条`);
}
function importJSON(file){
  if (!file) return;
  if (file.size > 5 * 1024 * 1024){ toast("文件太大了，已拒绝导入"); return; }
  const reader = new FileReader();
  reader.onerror = () => toast("文件读取失败");
  reader.onload = () => {
    let parsed;
    try { parsed = JSON.parse(String(reader.result)); } catch { toast("不是有效的 JSON 文件"); return; }
    const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.todos) ? parsed.todos : null;
    if (!list){ toast("文件里找不到待办数据"); return; }
    const { todos: clean, dropped } = sanitizeList(list);
    if (clean.length === 0){ toast("没有可导入的有效条目"); return; }
    snapshot("导入数据");
    todos = clean;
    reconcilePomoTask();
    render(); persist();
    play("r-hop");
    toast(dropped > 0 ? `已导入 ${clean.length} 条，跳过 ${dropped} 条无效数据` : `已导入 ${clean.length} 条`, { label:"撤销", run:undo });
  };
  reader.readAsText(file);
}

/* -------------------------------------------------------- 跨标签页同步 */
function applyExternal(list, opts = {}){
  todos = sanitizeList(list).todos;
  reconcilePomoTask();
  if (opts.resetUndo !== false){
    undoStack.length = 0;
    syncUndoBtn();
  }
  render();
  play("r-peek");
  toast(opts.message || "已同步其他标签页的改动");
}
/**
 * 编辑中收到外部更新时，先把本地状态换成外部最新版本，再由调用方创建撤销
 * 快照并写入本次字段改动。这样 undo 只撤当前编辑，不会倒退别的标签页修改。
 */
function rebasePendingEdit(id){
  if (!pendingExternal) return false;
  const list = pendingExternal;
  pendingExternal = null;
  const local = todos.find((t) => t.id === id);
  if (!local) return false;

  const merged = sanitizeList(list).todos;
  const index = merged.findIndex((t) => t.id === id);
  if (index < 0) merged.unshift({ ...local });
  todos = merged;
  reconcilePomoTask();
  return true;
}
function flushExternal(preserveEditedId = null){
  if (!pendingExternal) return;
  const list = pendingExternal; pendingExternal = null;
  if (!preserveEditedId){
    applyExternal(list);
    return;
  }

  const local = todos.find((t) => t.id === preserveEditedId);
  if (!local){
    applyExternal(list);
    return;
  }
  const merged = sanitizeList(list).todos;
  const index = merged.findIndex((t) => t.id === preserveEditedId);
  if (index >= 0) merged[index] = { ...local };
  else merged.unshift({ ...local });
  applyExternal(merged, {
    resetUndo:false,
    message:index >= 0 ? "已同步其他标签页的改动，并保留当前编辑" : "其他标签已删除该待办，已保留当前编辑",
  });
  persist();
}
window.addEventListener("storage", (e) => {
  /* 主题跨标签同步，但不弹提示 */
  if (e.key === THEME_KEY && e.newValue && THEMES[e.newValue] && e.newValue !== currentTheme){
    applyTheme(e.newValue, false);
    return;
  }
  if (e.key !== STORAGE_KEY || e.newValue == null) return;
  let parsed;
  try { parsed = JSON.parse(e.newValue); } catch { return; }
  if (!parsed || parsed.writer === TAB_ID) return;      // 自己写的不用回灌
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.todos) ? parsed.todos : null;
  if (!list) return;
  if (editingId){ pendingExternal = list; return; }     // 别把用户正在敲的字冲掉
  applyExternal(list);
});

/* ------------------------------------------------------------ 侧栏分类 */
function buildCategoryNav(){
  const frag = document.createDocumentFragment();
  CATEGORIES.forEach((c) => {
    const b = document.createElement("button");
    b.className = "nav-item";
    b.dataset.filter = "cat:" + c;
    b.setAttribute("aria-current","false");
    b.innerHTML = `<svg class="ico" viewBox="0 0 24 24">${CAT_ICONS[c]}</svg>`
      + `<span class="label">${CATEGORY_LABELS[c]}</span>`
      + `<span class="n tnum" data-count="cat:${c}"></span>`;
    frag.appendChild(b);
  });
  catNav.appendChild(frag);

  CATEGORIES.forEach((c) => {
    const o = document.createElement("option");
    o.value = c; o.textContent = CATEGORY_LABELS[c];
    categorySelect.appendChild(o);
  });
}

/* ------------------------------------------------------------ 日期选择 */
/** 解析用户输入：YYYY-MM-DD / 2026/8/6 / 8-6 / 8月6日 等 → ISO 或 null */
function parseUserDate(raw, now = Date.now()){
  const s = String(raw || "").trim();
  if (!s) return null;
  if (isISODate(s)) return s;
  let m = s.match(/^(\d{4})[./年\-](\d{1,2})[./月\-](\d{1,2})日?$/);
  if (m){
    const iso = `${m[1]}-${String(+m[2]).padStart(2,"0")}-${String(+m[3]).padStart(2,"0")}`;
    return isISODate(iso) ? iso : null;
  }
  m = s.match(/^(\d{1,2})[./月\-](\d{1,2})日?$/);
  if (m){
    const y = new Date(now).getFullYear();
    const iso = `${y}-${String(+m[1]).padStart(2,"0")}-${String(+m[2]).padStart(2,"0")}`;
    return isISODate(iso) ? iso : null;
  }
  return null;
}

function pad2(n){ return String(n).padStart(2, "0"); }

/** 日历弹层当前浏览的年月（0-based month） */
let dueCalView = { y: 0, m: 0 };

function isDueCalOpen(){
  return dueDatePop && !dueDatePop.hidden;
}

function closeDueCal(){
  if (!dueDatePop || dueDatePop.hidden) return;
  dueDatePop.hidden = true;
  if (dueDateCalBtn) dueDateCalBtn.setAttribute("aria-expanded", "false");
}

function positionDueCal(){
  if (!dueDatePop || !dueDateWrap) return;
  const r = dueDateWrap.getBoundingClientRect();
  const popW = dueDatePop.offsetWidth || 276;
  const popH = dueDatePop.offsetHeight || 300;
  const gap = 6;
  let left = r.left;
  let top = r.bottom + gap;
  if (left + popW > window.innerWidth - 8) left = Math.max(8, window.innerWidth - popW - 8);
  if (left < 8) left = 8;
  if (top + popH > window.innerHeight - 8 && r.top - gap - popH > 8){
    top = r.top - gap - popH;
  }
  dueDatePop.style.left = Math.round(left) + "px";
  dueDatePop.style.top = Math.round(top) + "px";
}

function renderDueCal(){
  if (!dueDateGrid || !dueDateTitle) return;
  const { y, m } = dueCalView;
  dueDateTitle.textContent = `${y}年${m + 1}月`;
  const selected = parseUserDate(dueDateInput.value);
  const today = todayStr();
  /* 周一为首（与国内主流日历一致）：Mon=0 … Sun=6 */
  const firstDow = (new Date(y, m, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();

  const frag = document.createDocumentFragment();
  const totalCells = 42; // 6 周
  for (let i = 0; i < totalCells; i++){
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "date-day";
    let cellY = y, cellM = m, cellD, muted = false;
    if (i < firstDow){
      cellD = prevDays - firstDow + i + 1;
      cellM = m - 1;
      if (cellM < 0){ cellM = 11; cellY = y - 1; }
      muted = true;
    } else if (i >= firstDow + daysInMonth){
      cellD = i - firstDow - daysInMonth + 1;
      cellM = m + 1;
      if (cellM > 11){ cellM = 0; cellY = y + 1; }
      muted = true;
    } else {
      cellD = i - firstDow + 1;
    }
    const iso = `${cellY}-${pad2(cellM + 1)}-${pad2(cellD)}`;
    btn.textContent = String(cellD);
    btn.dataset.date = iso;
    btn.setAttribute("role", "gridcell");
    btn.setAttribute("aria-label", iso);
    if (muted) btn.classList.add("is-muted");
    if (iso === today) btn.classList.add("is-today");
    if (selected && iso === selected){
      btn.classList.add("is-selected");
      btn.setAttribute("aria-selected", "true");
    }
    frag.appendChild(btn);
  }
  dueDateGrid.replaceChildren(frag);
}

function openDueCal(){
  if (!dueDatePop) return;
  const base = parseUserDate(dueDateInput.value) || todayStr();
  const [ys, ms] = base.split("-").map(Number);
  dueCalView = { y: ys, m: ms - 1 };
  dueDatePop.hidden = false;
  if (dueDateCalBtn) dueDateCalBtn.setAttribute("aria-expanded", "true");
  renderDueCal();
  positionDueCal();
}

function setDueDateValue(iso){
  dueDateInput.value = iso || "";
  dueDateInput.classList.toggle("is-invalid", Boolean(dueDateInput.value.trim()) && !parseUserDate(dueDateInput.value));
  if (isDueCalOpen()) renderDueCal();
}

/** 新建表单截止日期默认今天（可手动改掉；清空后下次展开再补回） */
function resetDueDateDefault(){
  setDueDateValue(todayStr());
}

function bindDueDatePicker(){
  if (!dueDateInput || !dueDateCalBtn || !dueDatePop) return;

  const toggleCal = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isDueCalOpen()) closeDueCal();
    else openDueCal();
  };
  dueDateCalBtn.addEventListener("click", toggleCal);
  /* 点左侧日历图标也打开（整颗 chip 更符合习惯） */
  if (dueDateWrap){
    dueDateWrap.addEventListener("click", (e) => {
      if (e.target === dueDateInput || dueDateInput.contains(e.target)) return;
      if (dueDatePop && dueDatePop.contains(e.target)) return;
      if (e.target.closest("button") === dueDateCalBtn || e.target.closest("svg")) toggleCal(e);
    });
  }

  dueDateInput.addEventListener("input", () => {
    const raw = dueDateInput.value.trim();
    dueDateInput.classList.toggle("is-invalid", Boolean(raw) && !parseUserDate(raw));
    if (isDueCalOpen()) renderDueCal();
  });
  dueDateInput.addEventListener("blur", () => {
    const p = parseUserDate(dueDateInput.value);
    if (p) setDueDateValue(p);
  });
  dueDateInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isDueCalOpen()){
      e.preventDefault();
      e.stopPropagation();
      closeDueCal();
      return;
    }
    if (e.key === "ArrowDown" && (e.altKey || e.metaKey || !dueDateInput.value)){
      e.preventDefault();
      openDueCal();
    }
  });

  dueDatePrev.addEventListener("click", (e) => {
    e.preventDefault();
    dueCalView.m -= 1;
    if (dueCalView.m < 0){ dueCalView.m = 11; dueCalView.y -= 1; }
    renderDueCal();
  });
  dueDateNext.addEventListener("click", (e) => {
    e.preventDefault();
    dueCalView.m += 1;
    if (dueCalView.m > 11){ dueCalView.m = 0; dueCalView.y += 1; }
    renderDueCal();
  });
  dueDateTodayBtn.addEventListener("click", (e) => {
    e.preventDefault();
    setDueDateValue(todayStr());
    closeDueCal();
  });
  dueDateClearBtn.addEventListener("click", (e) => {
    e.preventDefault();
    setDueDateValue("");
    closeDueCal();
  });
  dueDateGrid.addEventListener("click", (e) => {
    const btn = e.target.closest(".date-day");
    if (!btn || !btn.dataset.date) return;
    e.preventDefault();
    setDueDateValue(btn.dataset.date);
    closeDueCal();
  });

  window.addEventListener("resize", () => { if (isDueCalOpen()) positionDueCal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isDueCalOpen()){
      e.preventDefault();
      closeDueCal();
    }
  });
}

/* ------------------------------------------------------------ 事件绑定 */
function bindEvents(){
  const syncAdd = () => { addBtn.disabled = todoInput.value.trim().length === 0; };
  resetDueDateDefault();
  bindDueDatePicker();
  todoInput.addEventListener("input", syncAdd);
  todoInput.addEventListener("focus", () => {
    composer.classList.add("is-open");
    if (!dueDateInput.value.trim()) resetDueDateDefault();
    play("r-peek");
  });
  todoInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape"){
      if (isDueCalOpen()){ closeDueCal(); return; }
      if (todoInput.value){ todoInput.value = ""; syncAdd(); }
      else { todoInput.blur(); composer.classList.remove("is-open"); }
    }
    if (e.key === "ArrowDown" && !todoInput.value){
      const first = todoList.querySelector(".row");
      if (first){ e.preventDefault(); first.focus(); }
    }
  });
  document.addEventListener("click", (e) => {
    const onDateUi =
      (dueDateWrap && dueDateWrap.contains(e.target)) ||
      (dueDatePop && dueDatePop.contains(e.target));
    if (isDueCalOpen() && !onDateUi) closeDueCal();
    if (!composer.contains(e.target) && !onDateUi && !todoInput.value.trim()){
      composer.classList.remove("is-open");
    }
  });

  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = todoInput.value.trim();
    if (!text) return;
    const rawDue = dueDateInput.value.trim();
    const due = parseUserDate(rawDue);
    if (rawDue && !due){
      dueDateInput.classList.add("is-invalid");
      dueDateInput.focus();
      toast("日期格式不对，试试 2026-08-06 或点日历选");
      return;
    }
    addTodo(text, selectedPriority, categorySelect.value, due);
    todoInput.value = "";
    resetDueDateDefault();
    closeDueCal();
    syncAdd(); todoInput.focus();
  });

  document.querySelectorAll(".prio-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".prio-btn").forEach((b) => b.setAttribute("aria-pressed","false"));
      btn.setAttribute("aria-pressed","true");
      selectedPriority = btn.dataset.priority;
    });
  });

  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".range-btn").forEach((b) => b.setAttribute("aria-pressed","false"));
      btn.setAttribute("aria-pressed","true");
      historyRange = Number(btn.dataset.range);
      scroller.scrollTop = 0;
      render();
    });
  });

  document.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-filter]").forEach((b) => b.setAttribute("aria-current","false"));
      btn.setAttribute("aria-current","true");
      currentFilter = btn.dataset.filter;
      scroller.scrollTop = 0;
      render();
      if (currentFilter === "history") say("history");
      else if (currentFilter === "overdue" && todos.some(isOverdue)) say("overdue");
      else play("r-sway");
    });
  });

  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    const has = searchInput.value.length > 0;
    searchClear.hidden = !has; searchKbd.hidden = has;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchQuery = searchInput.value.trim().toLowerCase(); render(); }, 110);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape"){
      searchInput.value = ""; searchQuery = ""; searchClear.hidden = true; searchKbd.hidden = false;
      render(); searchInput.blur();
    }
  });
  searchClear.addEventListener("click", () => {
    searchInput.value = ""; searchQuery = ""; searchClear.hidden = true; searchKbd.hidden = false;
    render(); searchInput.focus();
  });

  $("#clearCompleted").addEventListener("click", requestClearCompleted);
  $("#exportBtn").addEventListener("click", exportJSON);
  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", (e) => { importJSON(e.target.files && e.target.files[0]); e.target.value = ""; });
  undoBtn.addEventListener("click", undo);
  $("#noticeClose").addEventListener("click", () => { noticeDismissed = true; notice.hidden = true; });
  storeChip.addEventListener("click", () => {
    if (persistState === "ok"){ toast(`数据保存在这台浏览器里，共 ${todos.length} 条`); return; }
    noticeDismissed = false; renderNotice();
  });

  /* ── 番茄钟控件 ── */
  pomoMain.addEventListener("click", toggleRun);
  pomoSkip.addEventListener("click", skipSegment);
  pomoReset.addEventListener("click", resetSegment);
  pomoPreset.addEventListener("click", () => {
    const next = setPomoPreset((pomo.presetIdx + 1) % PRESETS.length);
    if (next) toast(`时长已改为 ${next.label} 分钟`);
  });
  pomoBell.addEventListener("click", async () => {
    if (!pomo.sound){
      pomo.sound = true;
      /* 在用户手势里申请通知权限，不算骚扰 */
      try {
        if (typeof window.__luminaRequestNotifyPermission === "function") {
          await window.__luminaRequestNotifyPermission();
        } else if (typeof Notification !== "undefined" && Notification.permission === "default") {
          await Notification.requestPermission();
        }
      } catch { /* 拒绝就算了，声音还在 */ }
      chime("focus");
      toast("到点会响一声");
    } else {
      pomo.sound = false;
      toast("已静音");
    }
    savePomo(); renderPomo();
  });

  /* 戳她：说话 + 害羞侧身，连戳三次撒花。休息时戳只会被继续催 */
  let pokeCount = 0, pokeReset = null;
  charaBtn.addEventListener("click", () => {
    if (pomo.running && isResting()){ say("restNag"); return; }
    say("poke");
    pokeCount++;
    clearTimeout(pokeReset);
    pokeReset = setTimeout(() => { pokeCount = 0; }, 2600);
    if (pokeCount >= 3){
      pokeCount = 0;
      play("r-tada");
      burstAtChara(9);
    }
  });

  /* 指针跟随 */
  window.addEventListener("pointermove", trackPointer, { passive:true });
  window.addEventListener("pointerleave", resetTilt);
  window.addEventListener("blur", resetTilt);

  /* 切回标签页或 iOS 回前台立刻对表。 */
  const reconcileForeground = () => {
    if (pomo.running && remaining() <= 0) finishSegment(true);
    else renderPomo();
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) reconcileForeground();
  });
  window.addEventListener("lumina:foreground", reconcileForeground);

  /* 主题面板：优先用原生 popover，不支持就退化成点击循环 */
  const hasPopover = typeof themePop.showPopover === "function";
  themeBtn.addEventListener("click", () => {
    if (!hasPopover){ cycleTheme(); return; }
    placePopover();
    themePop.togglePopover();
  });
  window.addEventListener("resize", () => { if (themePop.matches?.(":popover-open")) placePopover(); });

  document.addEventListener("keydown", (e) => {
    const el = document.activeElement;
    const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !typing){ e.preventDefault(); undo(); return; }
    if (typing) return;
    if (e.key === "/"){ e.preventDefault(); searchInput.focus(); }
    else if (e.key.toLowerCase() === "n"){ e.preventDefault(); if (composer.hidden) document.querySelector('[data-filter="all"]').click(); todoInput.focus(); }
    else if (e.key.toLowerCase() === "h"){ e.preventDefault(); document.querySelector('[data-filter="history"]').click(); }
    else if (e.key.toLowerCase() === "t"){ e.preventDefault(); cycleTheme(); }
    else if (e.key.toLowerCase() === "p"){ e.preventDefault(); toggleRun(); }
    else if (e.key === "ArrowDown"){ const f = todoList.querySelector(".row"); if (f){ e.preventDefault(); f.focus(); } }
    else if (e.key === "Escape") hideToast();
  });
}

/* ------------------------------------------------------------ 首次示例 */
function seedIfFirstRun(){
  if (todos.length > 0 || store.get(SEED_KEY)) return;
  const now = Date.now();
  const yest = now - DAY_MS - 3 * 3600e3;
  todos = [
    { id:uid(), text:"悬停任意一行，点小闹钟对它开始专注", completed:false, priority:"high", category:"inbox", dueDate:todayStr(), createdAt:now, updatedAt:now, completedAt:null, pomodoros:0, clickupTaskId:null, clickupUrl:null },
    { id:uid(), text:"点行上的 ↑CU，或跟栞那说「传到 ClickUp」", completed:false, priority:"medium", category:"work", dueDate:null, createdAt:now-500, updatedAt:now-500, completedAt:null, pomodoros:0, clickupTaskId:null, clickupUrl:null },
    { id:uid(), text:"到点她会催你休息，而且不接受拒绝", completed:false, priority:"medium", category:"personal", dueDate:null, createdAt:now-1e3, updatedAt:now-1e3, completedAt:null, pomodoros:0, clickupTaskId:null, clickupUrl:null },
    { id:uid(), text:"按 P 开始或暂停，按 F 对选中项专注", completed:false, priority:"low", category:"study", dueDate:null, createdAt:now-2e3, updatedAt:now-2e3, completedAt:null, pomodoros:0, clickupTaskId:null, clickupUrl:null },
    { id:uid(), text:"昨天做完的事会进「历史记录」", completed:true, priority:"medium", category:"work", dueDate:null, createdAt:yest-1e5, updatedAt:yest, completedAt:yest, pomodoros:2, clickupTaskId:null, clickupUrl:null },
  ];
  persist();
  try { store.set(SEED_KEY, "1"); } catch { /* 配额问题不阻塞首屏 */ }
}

/* ---------------------------------------------------------------- AI Agent 桥接（供 chat.js 调用） */
function buildChatContext(){
  const today = todayStr();
  const active = todos.filter((t) => !t.completed);
  const doneToday = todos.filter((t) => t.completed && t.completedAt && dayKey(t.completedAt) === today);
  const lines = [];
  lines.push(`今天：${today}`);
  lines.push(`进行中 ${active.length} 件 · 今日已完成 ${doneToday.length} 件 · 清单共 ${todos.length} 件`);
  if (pomo.running){
    const left = pomo.endsAt ? Math.max(0, pomo.endsAt - Date.now()) : (pomo.leftMs || 0);
    const bound = pomo.taskId ? todos.find((x) => x.id === pomo.taskId) : null;
    lines.push(`番茄钟：进行中 mode=${pomo.mode} 剩余约 ${mmss(left)}` + (bound ? ` 绑定「${bound.text}」` : ""));
  } else {
    lines.push(`番茄钟：未运行（预设 ${PRESETS[pomo.presetIdx || 0]?.label || "25 / 5"}）`);
  }
  const prioRank = { high:0, medium:1, low:2 };
  const top = [...active].sort((a, b) => (prioRank[a.priority] - prioRank[b.priority]) || (a.createdAt - b.createdAt)).slice(0, 18);
  if (!top.length){
    lines.push("当前没有未完成待办。");
  } else {
    lines.push("未完成（最多 18 条，含 id 便于调用工具）：");
    for (const t of top){
      const due = t.dueDate ? ` · 截止 ${t.dueDate}${t.dueDate < today ? "（已逾期）" : t.dueDate === today ? "（今天）" : ""}` : "";
      const pomoN = t.pomodoros ? ` · 🍅${t.pomodoros}` : "";
      lines.push(`- id=${t.id} [${PRIO_LABELS[t.priority] || t.priority}] (${CATEGORY_LABELS[t.category] || t.category}) ${t.text}${due}${pomoN}`);
    }
  }
  return lines.join("\n");
}

function serializeTodo(t){
  return {
    id: t.id,
    text: t.text,
    completed: t.completed,
    priority: t.priority,
    category: t.category,
    dueDate: t.dueDate,
    pomodoros: t.pomodoros || 0,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
    clickupTaskId: t.clickupTaskId || null,
    clickupUrl: t.clickupUrl || null,
  };
}

/**
 * 按 id 或 match_text 找待办。
 * scope: "active" | "completed" | "any" —— 与 agent-tools MATCH_* 对齐（#20）
 * 多命中不自选，返回 { ambiguous, candidates }。
 * @returns {{ todo: object } | { error: string, ambiguous?: boolean, candidates?: object[] }}
 */
function findTodoByArgs(args, { scope = "active" } = {}){
  if (args?.id){
    const byId = todos.find((t) => t.id === args.id);
    if (byId) return { todo: byId };
    return { error: "找不到该 id 的待办" };
  }
  const q = String(args?.match_text || args?.text || "").trim().toLowerCase();
  if (!q) return { error: "需要提供 id 或 match_text" };
  let pool = todos.slice();
  if (scope === "active") pool = pool.filter((t) => !t.completed);
  else if (scope === "completed") pool = pool.filter((t) => t.completed);
  const exact = pool.filter((t) => t.text.toLowerCase() === q);
  if (exact.length === 1) return { todo: exact[0] };
  if (exact.length > 1){
    return {
      error: `「${q}」命中 ${exact.length} 条，请改用 id 或更准确的关键词`,
      ambiguous: true,
      candidates: exact.slice(0, 8).map(serializeTodo),
    };
  }
  const includes = pool.filter((t) => t.text.toLowerCase().includes(q));
  if (includes.length === 1) return { todo: includes[0] };
  if (includes.length > 1){
    return {
      error: `「${q}」命中 ${includes.length} 条，请改用 id 或更准确的关键词`,
      ambiguous: true,
      candidates: includes.slice(0, 8).map(serializeTodo),
    };
  }
  return { error: "找不到匹配的待办" };
}

function setAppView(view, historyRangeDays){
  const cat = ["inbox","work","personal","study","health"];
  let filter = view;
  if (cat.includes(view)) filter = "cat:" + view;
  const btn = document.querySelector(`[data-filter="${cssEscape(filter)}"]`);
  if (btn){
    document.querySelectorAll("[data-filter]").forEach((b) => b.setAttribute("aria-current","false"));
    btn.setAttribute("aria-current","true");
    currentFilter = filter;
    if (typeof historyRangeDays === "number" && [0, 7, 30].includes(historyRangeDays)){
      historyRange = historyRangeDays;
      document.querySelectorAll(".range-btn").forEach((b) => {
        b.setAttribute("aria-pressed", String(Number(b.dataset.range) === historyRange));
      });
    }
    render();
    if (currentFilter === "history") say("history");
    return { ok:true, view: currentFilter, historyRange };
  }
  return { ok:false, error:`未知视图 ${view}` };
}

function agentInvoke(name, rawArgs){
  let args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  // schema 防线：模型可以不遵守 parameters，执行前再验一遍
  const toolkit = typeof LUMINA_AGENT_TOOLS !== "undefined" ? LUMINA_AGENT_TOOLS : null;
  if (toolkit?.assertToolArgs){
    const check = toolkit.assertToolArgs(name, args);
    if (!check.ok){
      const msg = check.error?.message || "参数不合法";
      return {
        ok: false,
        error: msg,
        errorDetail: check.error,
        code: check.error?.code || "BAD_ARGS",
      };
    }
    args = check.args;
  }
  try {
    switch (name){
      case "list_todos": {
        const status = args.status || "active";
        const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 50);
        const q = String(args.query || "").trim().toLowerCase();
        let list = todos.slice();
        if (status === "active") list = list.filter((t) => !t.completed);
        else if (status === "completed") list = list.filter((t) => t.completed);
        else if (status === "overdue") list = list.filter(isOverdue);
        else if (status === "today") list = list.filter((t) => !t.completed && t.dueDate === todayStr());
        if (args.category && CATEGORIES.includes(args.category)){
          list = list.filter((t) => t.category === args.category);
        }
        if (q) list = list.filter((t) => t.text.toLowerCase().includes(q));
        list = list.slice(0, limit);
        return { ok:true, count:list.length, todos:list.map(serializeTodo) };
      }
      case "add_todo": {
        const text = String(args.text || "").trim();
        if (!text) return { ok:false, error:"text 不能为空" };
        const priority = PRIORITIES.includes(args.priority) ? args.priority : "medium";
        const category = CATEGORIES.includes(args.category) ? args.category : "inbox";
        let due = args.due_date ?? args.dueDate ?? null;
        if (due === "" || due === "null") due = null;
        if (due && !isISODate(due)) return { ok:false, error:`日期无效：${due}，请用 YYYY-MM-DD` };
        if (todos.length >= MAX_ITEMS) return { ok:false, error:`最多 ${MAX_ITEMS} 条` };
        addTodo(text, priority, category, due);
        const created = todos[0];
        return { ok:true, todo: serializeTodo(created), message:`已添加：${created.text}` };
      }
      case "update_todo": {
        const found = findTodoByArgs(args, { scope: "active" });
        if (!found?.todo){
          return {
            ok:false,
            error: found?.error || "找不到要修改的待办",
            code: found?.ambiguous ? "AMBIGUOUS" : "NOT_FOUND",
            candidates: found?.candidates,
          };
        }
        const t = found.todo;
        const patch = {};
        if (typeof args.text === "string" && args.text.trim()) patch.text = args.text.trim().slice(0, MAX_TEXT);
        if (PRIORITIES.includes(args.priority)) patch.priority = args.priority;
        if (CATEGORIES.includes(args.category)) patch.category = args.category;
        if ("due_date" in args || "dueDate" in args){
          let due = args.due_date ?? args.dueDate;
          if (due === null || due === "" || due === "null") patch.dueDate = null;
          else if (isISODate(due)) patch.dueDate = due;
          else return { ok:false, error:`日期无效：${due}` };
        }
        if (!Object.keys(patch).length) return { ok:false, error:"没有可更新的字段" };
        snapshot("AI 修改待办");
        updateTodo(t.id, patch);
        const next = todos.find((x) => x.id === t.id);
        return { ok:true, todo: serializeTodo(next), message:`已更新：${next.text}` };
      }
      case "complete_todo": {
        const found = findTodoByArgs(args, { scope: "active" });
        if (!found?.todo){
          return {
            ok:false,
            error: found?.error || "找不到待办",
            code: found?.ambiguous ? "AMBIGUOUS" : "NOT_FOUND",
            candidates: found?.candidates,
          };
        }
        const t = found.todo;
        if (t.completed) return { ok:true, todo: serializeTodo(t), message:"已经是完成状态" };
        toggleTodo(t.id);
        return { ok:true, todo: serializeTodo(todos.find((x) => x.id === t.id)), message:`已完成：${t.text}` };
      }
      case "uncomplete_todo": {
        const found = findTodoByArgs(args, { scope: "completed" });
        if (!found?.todo){
          return {
            ok:false,
            error: found?.error || "找不到待办",
            code: found?.ambiguous ? "AMBIGUOUS" : "NOT_FOUND",
            candidates: found?.candidates,
          };
        }
        const t = found.todo;
        if (!t.completed) return { ok:true, todo: serializeTodo(t), message:"已经是进行中" };
        toggleTodo(t.id);
        return { ok:true, todo: serializeTodo(todos.find((x) => x.id === t.id)), message:`已恢复：${t.text}` };
      }
      case "delete_todo": {
        const found = findTodoByArgs(args, { scope: "any" });
        if (!found?.todo){
          return {
            ok:false,
            error: found?.error || "找不到待办",
            code: found?.ambiguous ? "AMBIGUOUS" : "NOT_FOUND",
            candidates: found?.candidates,
          };
        }
        const t = found.todo;
        if (!window.confirm(`确定删除待办「${t.text}」吗？此操作可通过“撤销”恢复。`)){
          return { ok:false, error:"用户取消了删除操作", code:"USER_CANCELLED" };
        }
        const text = t.text;
        const id = t.id;
        removeTodo(id);
        return { ok:true, deleted:{ id, text }, message:`已删除：${text}（可撤销）` };
      }
      case "clear_completed": {
        return requestClearCompleted();
      }
      case "set_view": {
        return setAppView(args.view, args.history_range);
      }
      case "pomo_status": {
        const bound = pomo.taskId ? todos.find((x) => x.id === pomo.taskId) : null;
        return {
          ok:true,
          pomo:{
            mode: pomo.mode,
            running: pomo.running,
            remaining: mmss(remaining()),
            remainingMs: remaining(),
            round: pomo.round,
            tallyToday: pomo.tallyDay === todayStr() ? pomo.tally : 0,
            preset: preset().label,
            presetIdx: pomo.presetIdx,
            taskId: pomo.taskId,
            taskText: bound ? bound.text : null,
          },
        };
      }
      case "pomo_start": {
        if (args.mode && ["focus","short","long"].includes(args.mode)){
          startSegment(args.mode, true);
        } else if (!pomo.running){
          toggleRun();
        } else {
          return { ok:true, message:"番茄钟已在运行", pomo: agentInvoke("pomo_status").pomo };
        }
        return { ok:true, message:`番茄钟已开始（${MODE_LABEL[pomo.mode]}）`, pomo: agentInvoke("pomo_status").pomo };
      }
      case "pomo_pause": {
        if (!pomo.running) return { ok:true, message:"本来就没在跑" };
        toggleRun();
        return { ok:true, message:"已暂停", pomo: agentInvoke("pomo_status").pomo };
      }
      case "pomo_skip": {
        skipSegment();
        return { ok:true, message:`已跳过，当前：${MODE_LABEL[pomo.mode]}`, pomo: agentInvoke("pomo_status").pomo };
      }
      case "pomo_reset": {
        resetSegment();
        return { ok:true, message:"当前段已重置", pomo: agentInvoke("pomo_status").pomo };
      }
      case "pomo_focus_task": {
        const found = findTodoByArgs(args, { scope: "active" });
        if (!found?.todo){
          return {
            ok:false,
            error: found?.error || "找不到未完成待办",
            code: found?.ambiguous ? "AMBIGUOUS" : "NOT_FOUND",
            candidates: found?.candidates,
          };
        }
        const t = found.todo;
        if (t.completed) return { ok:false, error:"已完成的待办不能专注" };
        focusOnTask(t.id);
        return { ok:true, message:`开始专注：${t.text}`, todo: serializeTodo(t), pomo: agentInvoke("pomo_status").pomo };
      }
      case "pomo_set_preset": {
        const idx = Number(args.preset);
        const next = setPomoPreset(idx);
        if (!next) return { ok:false, error:"preset 只能是 0/1/2" };
        return { ok:true, message:`预设已切换为 ${next.label}`, preset: next };
      }
      case "set_theme": {
        if (!THEME_IDS.includes(args.theme)) return { ok:false, error:"主题只能是 kanna/sakura/cafe" };
        applyTheme(args.theme, true);
        return { ok:true, theme: args.theme, message:`已切换主题：${THEMES[args.theme].name}` };
      }
      case "push_todo_to_clickup": {
        const found = findTodoByArgs(args, { scope: "any" });
        if (!found?.todo){
          return {
            ok:false,
            error: found?.error || "找不到要上传的待办",
            code: found?.ambiguous ? "AMBIGUOUS" : "NOT_FOUND",
            candidates: found?.candidates,
          };
        }
        // 异步上传；agent-loop 会 await Promise
        return pushTodoToClickUp(found.todo.id);
      }
      case "undo": {
        if (!undoStack.length) return { ok:false, error:"没有可撤销的操作" };
        undo();
        return { ok:true, message:"已撤销上一步" };
      }
      case "get_app_status": {
        const active = todos.filter((t) => !t.completed).length;
        const done = todos.filter((t) => t.completed).length;
        return {
          ok:true,
          today: todayStr(),
          todos:{ total: todos.length, active, completed: done, overdue: todos.filter(isOverdue).length },
          theme: currentTheme,
          view: currentFilter,
          pomo: agentInvoke("pomo_status").pomo,
          context: buildChatContext(),
        };
      }
      default:
        return { ok:false, error:`未知工具：${name}` };
    }
  } catch (err){
    return { ok:false, error: err?.message || String(err) };
  }
}

const TOOL_LABELS = {
  list_todos:"查看清单", add_todo:"添加待办", update_todo:"修改待办",
  complete_todo:"完成待办", uncomplete_todo:"取消完成", delete_todo:"删除待办",
  clear_completed:"清除已完成", set_view:"切换视图",
  pomo_status:"番茄钟状态", pomo_start:"开始番茄钟", pomo_pause:"暂停番茄钟",
  pomo_skip:"跳过番茄钟", pomo_reset:"重置番茄钟", pomo_focus_task:"专注某待办",
  pomo_set_preset:"切换时长", set_theme:"切换主题",
  push_todo_to_clickup:"传到 ClickUp", undo:"撤销", get_app_status:"应用状态",
};

function installChatBridge(){
  window.__luminaGetChatContext = () => buildChatContext();
  window.__luminaGetThemeInfo = () => {
    const th = THEMES[currentTheme] || THEMES.kanna;
    return { id: currentTheme, charName: th.charName, brand: th.brand, name: th.name };
  };
  window.__luminaOnChatReply = () => {
    try { play("r-nod"); emote(THEMES[currentTheme].emotes.poke || "…"); } catch { /* ignore */ }
  };
  window.__luminaAgent = {
    invoke(name, args){ return agentInvoke(name, args); },
    toolLabel(name){ return TOOL_LABELS[name] || name; },
  };
  /* iOS 触摸排序：按 DOM 顺序重排内存 todos 并持久化 */
  window.__luminaReorder = (ids) => {
    if (!Array.isArray(ids) || !ids.length) return false;
    if (typeof sortingEnabled === "function" && !sortingEnabled()) {
      try { toast("清除筛选和搜索后才能排序"); } catch { /* ignore */ }
      return false;
    }
    const map = new Map(todos.map((t) => [t.id, t]));
    const next = [];
    for (const id of ids) {
      const t = map.get(id);
      if (t) { next.push(t); map.delete(id); }
    }
    for (const t of todos) if (map.has(t.id)) next.push(t);
    if (next.length !== todos.length) return false;
    let same = true;
    for (let i = 0; i < next.length; i++) if (next[i].id !== todos[i].id) { same = false; break; }
    if (same) return true;
    snapshot("调整顺序");
    todos = next;
    render(); persist();
    try { play("r-nod"); } catch { /* ignore */ }
    return true;
  };
  if (typeof window.__luminaInstallTouchReorder === "function") {
    try {
      window.__luminaInstallTouchReorder({
        getTodos: () => todos.slice(),
        setTodosAndPersist: (next) => {
          if (!Array.isArray(next)) return false;
          const ids = next.map((x) => (typeof x === "string" ? x : x?.id)).filter(Boolean);
          return window.__luminaReorder(ids);
        },
        render,
      });
    } catch { /* ignore */ }
  }
}

/* ---------------------------------------------------------------- 启动 */
function init(){
  $("#brandDate").textContent = new Intl.DateTimeFormat("zh-CN", { month:"long", day:"numeric", weekday:"long" }).format(new Date());
  buildThemeList();
  buildCategoryNav();
  const saved = store.get(THEME_KEY);
  applyTheme(THEMES[saved] ? saved : document.documentElement.dataset.theme || "kanna", false);

  const recovered = loadState();
  seedIfFirstRun();
  bindEvents();
  installChatBridge();
  syncUndoBtn();
  renderNotice(); renderStoreChip();
  loadPomo();
  render();
  renderPomo();
  sayGreeting();
  pokeIdleClock();

  /* 其它立绘不在启动时抠；打开主题面板时 warmOtherCutouts() */

  if (recovered === -1) toast("本地数据已损坏，已重置为空列表");
  else if (recovered > 0) toast(`已跳过 ${recovered} 条损坏的数据`);
}

document.readyState === "loading"
  ? document.addEventListener("DOMContentLoaded", init)
  : init();
})();
