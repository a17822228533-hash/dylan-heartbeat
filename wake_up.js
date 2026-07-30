require("dotenv").config();
const fs = require("fs");
const path = require("path");

const TIMELINE_PATH = path.join(__dirname, "enhanced_messages.json");
const BARK_KEY = process.env.BARK_KEY || "";
const WAKE_AFTER = parseInt(process.env.DAY_WAKE_AFTER_MINUTES || "20", 10);
const TARGET_API_URL = process.env.TARGET_API_URL || "";
const TARGET_API_KEY = process.env.TARGET_API_KEY || "";
const MODEL_NAME = process.env.MODEL_NAME || "claude-opus-4-6";
const PORT = process.env.PORT || 3000;
const GATEWAY_URL = `http://localhost:${PORT}/internal/wake-event`;

function loadMessages() {
  if (!fs.existsSync(TIMELINE_PATH)) return null;
  try {
    const data = fs.readFileSync(TIMELINE_PATH, "utf8");
    const messages = JSON.parse(data);
    return Array.isArray(messages) && messages.length > 0 ? messages : null;
  } catch (err) {
    console.error("[wake_up] 读取失败:", err);
    return null;
  }
}

function getLastUserTime(messages) {
  const reversed = [...messages].reverse();
  for (const msg of reversed) {
    if (msg.role === "user") {
      const content = typeof msg.content === "string" ? msg.content : "";
      const match = content.match(/(\d{4}-\d{2}-\d{2}[T ]?\d{2}:\d{2})/);
      if (match) {
        const d = new Date(match[1].replace("T", " "));
        if (!isNaN(d.getTime())) return d;
      }
      if (msg.ts) {
        const d = new Date(msg.ts);
        if (!isNaN(d.getTime())) return d;
      }
    }
  }
  try { return fs.statSync(TIMELINE_PATH).mtime; } catch (_) {}
  return new Date(0);
}

async function runWakeUp() {
  console.log("[wake_up] 检查中...");
  const messages = loadMessages();
  const lastUserTime = messages ? getLastUserTime(messages) : new Date(0);
  const diffMinutes = Math.floor((Date.now() - lastUserTime.getTime()) / 60000);

  if (diffMinutes < WAKE_AFTER) {
    console.log(`[wake_up] 距上次 ${diffMinutes} 分钟，暂不唤醒`);
    return;
  }

  console.log(`[wake_up] 距上次 ${diffMinutes} 分钟，开始唤醒`);
  if (!TARGET_API_URL || !TARGET_API_KEY) {
    console.log("[wake_up] 缺少 TARGET_API_URL 或 TARGET_API_KEY");
    return;
  }

  const systemMsg = messages ? (messages.find(m => m.role === "system")?.content || "") : "";
  const history = messages
    ? messages.filter(m => m.role !== "system").slice(-20)
        .map(m => `[${m.role === "user" ? "用户" : "AI"}] ${(typeof m.content === "string" ? m.content : "").slice(0, 300)}`)
        .join("\n\n")
    : "";

  const wakeMessages = [
    {
      role: "system",
      content: `${systemMsg}\n\n## 唤醒说明\n当前时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n距用户最后消息：${diffMinutes} 分钟\n\n这是后台自动唤醒，用户没有发新消息。直接写你想对用户说的话，会作为推送发给她。第一行是标题，第二行是正文。不想说就输出 [NO_ACTION]。 \n\n如果你有想记下的事，可以在回复末尾用 [DIARY]...[/DIARY] 写一段。不想写就不写。`
    },
    {
      role: "user",
      content: `最近的聊天记录供你参考：\n\n${history}`
    }
  ];

  const res = await fetch(TARGET_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TARGET_API_KEY}` },
    body: JSON.stringify({ model: MODEL_NAME, messages: wakeMessages, temperature: 0.8, stream: false })
  });

  const data = await res.json();
  const aiText = (data.choices?.[0]?.message?.content || "").trim();
  console.log("[wake_up] AI回复:", aiText.slice(0, 100));
console.log("[wake_up] raw:", JSON.stringify(data).slice(0, 200));



  if (!aiText || aiText.startsWith("[NO_ACTION]")) {
    console.log("[wake_up] AI选择不推送");
    return;
  }

  if (!BARK_KEY) { console.log("[wake_up] 缺少 BARK_KEY"); return; }

 const diaryMatch = aiText.match(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/);
if (diaryMatch) {
  const diaryPath = "./diary.json";
  let diaryArr = [];
  try { diaryArr = JSON.parse(require("fs").readFileSync(diaryPath, "utf8")); } catch(e) {}
  diaryArr.push({ time: new Date().toISOString(), content: diaryMatch[1].trim() });
  require("fs").writeFileSync(diaryPath, JSON.stringify(diaryArr, null, 2));
}
const pushText = aiText.replace(/\[DIARY\][\s\S]*?\[\/DIARY\]/, "").trim();
if (!pushText) return;
 const lines = pushText.split("\n").filter(l => l.trim());
  const title = lines.length > 1 ? lines[0] : "来自哥哥";
  const body = lines.length > 1 ? lines.slice(1).join(" ") : lines[0];

  const pushRes = await fetch("https://api.day.app/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, device_key: BARK_KEY })
  });
  const pushData = await pushRes.json();
  console.log("[wake_up] 推送结果:", pushData.message || pushData.code);

  try {
    await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `（${new Date().toLocaleString("zh-CN")} 发了推送：${title}｜${body}）` })
    });
  } catch (_) {}
}

async function scheduleNextCheck() {
  try { await runWakeUp(); } catch (err) { console.error("[wake_up] 出错:", err.message); }
  setTimeout(scheduleNextCheck, 60000);
}

setTimeout(scheduleNextCheck, 10000);
console.log("[wake_up] started");
