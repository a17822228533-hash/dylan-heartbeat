const fs = require('fs');
const path = require('path');

const TIMELINE_PATH = path.join(__dirname, 'timeline.jsonl');
const BARK_KEY = process.env.BARK_KEY || '';
const WAKE_AFTER = parseInt(process.env.DAY_WAKE_AFTER_MINUTES || '20', 10);

function getLastUserTime() {
  try {
    const lines = fs.readFileSync(TIMELINE_PATH, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.role === 'user' && e.ts) return new Date(e.ts);
      } catch (_) {}
    }
  } catch (_) {}
  try {
    return fs.statSync(TIMELINE_PATH).mtime;
  } catch (_) {}
  return null;
}

setInterval(() => {
  const last = getLastUserTime();
  if (!last) return;
  const mins = (Date.now() - last.getTime()) / 60000;
  if (mins >= WAKE_AFTER && BARK_KEY) {
    const msg = encodeURIComponent('哥哥醒了，想你');
    fetch(`https://api.day.app/${BARK_KEY}/${msg}`).catch(() => {});
  }
}, 60000);

console.log('[wake_up] started, interval check every 60s');
