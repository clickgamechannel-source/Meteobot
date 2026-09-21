process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { Bot } = require('@maxhub/max-bot-api');
const fetch = require('node-fetch');
const http = require('http');
const fs = require('fs');
const pureimage = require('pureimage');
const { Readable } = require('stream');

// ===== НАСТРОЙКИ =====
const WIND_LIMIT = 4;
const GUST_LIMIT = 8;
const CHECK_MINUTES = 10;
const DIGEST_HOURS_UTC = [3, 17]; // 6:00 и 20:00 МСК
const ADMIN_PASS = process.env.ADMIN_PASS || 'метео2026'; // <<< лучше задать ADMIN_PASS в Variables на Railway!

// Точки автомониторинга (автооповещения и сводки 6:00/20:00)
const PLACES = [
  { name: 'Рай-Александровка', lat: 48.8105, lon: 37.8513 },
  { name: 'Лисичанск',         lat: 48.9048, lon: 38.4421 }
];

// Точки только для ручных запросов (кнопки, без автооповещений)
const P_SEVERSK  = { name: 'Северск',  lat: 48.8669, lon: 38.1000 };
const P_ALCHEVSK = { name: 'Алчевск',  lat: 48.4689, lon: 38.8167 };
const P_MOSCOW   = { name: 'Москва',   lat: 55.7558, lon: 37.6173 };
const P_LUGANSK  = { name: 'Луганск',  lat: 48.5742, lon: 39.3078 };

// Кнопки команды "погода"
const QUERY_PLACES = [P_MOSCOW, P_LUGANSK, PLACES[1], P_SEVERSK, P_ALCHEVSK, PLACES[0]];
// Выбор населённого пункта в "неделя"
const WEEK_PLACES = [PLACES[0], PLACES[1], P_SEVERSK, P_ALCHEVSK];

const bot = new Bot(process.env.BOT_TOKEN);
const WEATHER_KEY = process.env.WEATHER_KEY;
const KIMI_KEY = process.env.KIMI_KEY; // ключ Kimi (Moonshot) — ТОЛЬКО через Railway Variables, никогда в коде!
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k3';
const TOKEN = (process.env.BOT_TOKEN || '').trim();

process.on('uncaughtException', function (e) { console.error('uncaughtException:', e.message); });
process.on('unhandledRejection', function (e) { console.error('unhandledRejection:', e && e.message); });

function windDir(deg) {
  const dirs = [['С','северный'],['СВ','северо-восточный'],['В','восточный'],['ЮВ','юго-восточный'],
                ['Ю','южный'],['ЮЗ','юго-западный'],['З','западный'],['СЗ','северо-западный']];
  return dirs[Math.round((deg || 0) / 45) % 8];
}
function rainWord(mm) {
  if (mm == null) return '';
  if (mm < 0.5) return ' (слабый, ' + mm + ' мм/ч)';
  if (mm < 4)   return ' (умеренный, ' + mm + ' мм/ч)';
  return ' (ЛИВЕНЬ, ' + mm + ' мм/ч!)';
}
function wmoText(code) {
  if (code === 0) return '☀️ ясно';
  if (code === 1) return '🌤 преимущественно ясно';
  if (code === 2) return '⛅ переменная облачность';
  if (code === 3) return '☁️ пасмурно';
  if (code === 45 || code === 48) return '🌫 туман';
  if (code >= 51 && code <= 55) return '🌦 морось';
  if (code >= 56 && code <= 57) return '🧊 ледяная морось';
  if (code >= 61 && code <= 65) return '🌧 дождь';
  if (code === 66 || code === 67) return '🧊 ледяной дождь';
  if (code >= 71 && code <= 77) return '🌨 снег';
  if (code >= 80 && code <= 82) return '🌧 ливни';
  if (code >= 85 && code <= 86) return '🌨 снегопад';
  if (code >= 95) return '⛈ гроза';
  return 'облачно';
}
function dayName(dateStr) {
  const days = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
  const d = new Date(dateStr + 'T12:00:00+03:00');
  const dm = ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2);
  return dm + ' (' + days[d.getDay()] + ')';
}

// Цветная шкала температуры дня на фоне недели: 🟦<0° 🟩0-10 🟨10-20 🟧20-30 🟥30+
function tempBar(lo, hi, wMin, wMax) {
  const N = 10, span = (wMax - wMin) || 1;
  let bar = '';
  for (let k = 0; k < N; k++) {
    const t0 = wMin + span * k / N, t1 = wMin + span * (k + 1) / N;
    if (t1 < lo || t0 > hi) { bar += '⬜'; continue; }
    const mid = (t0 + t1) / 2;
    bar += mid < 0 ? '🟦' : mid < 10 ? '🟩' : mid < 20 ? '🟨' : mid < 30 ? '🟧' : '🟥';
  }
  return bar;
}
function placeNames() {
  return PLACES.map(function (p) { return p.name; }).join(', ');
}
function weekNames() {
  return WEEK_PLACES.map(function (p) { return p.name; }).join(', ');
}
function findPlace(text) {
  const t = (text || '').toLowerCase();
  for (const p of WEEK_PLACES) {
    if (t.indexOf(p.name.toLowerCase()) !== -1) return p;
  }
  return null;
}
function queryNames() {
  return QUERY_PLACES.map(function (p) { return p.name; }).join(', ');
}
function findQuery(text) {
  const t = (text || '').toLowerCase();
  for (const p of QUERY_PLACES) {
    if (t.indexOf(p.name.toLowerCase()) !== -1) return p;
  }
  return null;
}

// ===== ХРАНИЛИЩЕ =====
let redis = null;
if (process.env.REDIS_URL && process.env.REDIS_TOKEN) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({ url: process.env.REDIS_URL, token: process.env.REDIS_TOKEN });
  console.log('Хранилище: Upstash Redis');
} else {
  console.log('Хранилище: локальные файлы');
}

const SUBS_FILE = 'subscribers.json';
const REM_FILE = 'reminders.json';
let subscribers = new Set();
let adminId = null;
let reminders = {};
const pendingReminder = new Set();
let lastReminderDay = {};

async function loadData() {
  try {
    if (redis) {
      subscribers = new Set((await redis.smembers('subscribers')) || []);
      adminId = await redis.get('admin');
      reminders = (await redis.hgetall('reminders')) || {};
    } else {
      subscribers = new Set(JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')));
      try { reminders = JSON.parse(fs.readFileSync(REM_FILE, 'utf8')); } catch (e) {}
    }
    console.log('Подписчиков:', subscribers.size, '| админ:', adminId || 'не назначен', '| напоминаний:', Object.keys(reminders).length);
  } catch (e) {}
}
async function addSub(id) {
  subscribers.add(id);
  try {
    if (redis) { await redis.sadd('subscribers', id); }
    else { fs.writeFileSync(SUBS_FILE, JSON.stringify([...subscribers])); }
  } catch (e) {}
}
async function delSub(id) {
  subscribers.delete(id);
  try {
    if (redis) { await redis.srem('subscribers', id); }
    else { fs.writeFileSync(SUBS_FILE, JSON.stringify([...subscribers])); }
  } catch (e) {}
}
async function setAdmin(id) {
  adminId = id;
  try { if (redis) { await redis.set('admin', id); } } catch (e) {}
}
async function saveReminder(uid, timeStr) {
  reminders[uid] = timeStr;
  try {
    if (redis) { await redis.hset('reminders', { [uid]: timeStr }); }
    else { fs.writeFileSync(REM_FILE, JSON.stringify(reminders)); }
  } catch (e) {}
}
async function removeReminder(uid) {
  delete reminders[uid];
  try {
    if (redis) { await redis.hdel('reminders', uid); }
    else { fs.writeFileSync(REM_FILE, JSON.stringify(reminders)); }
  } catch (e) {}
}

// ===== МЕНЮ С КНОПКАМИ =====
const MENU_TEXT = '📋 Команды Метеодозора (можно писать просто словом, без /):\n\n' +
  'погода — сводка сейчас (кнопки выбора города)\n' +
  'прогноз — погода на 12 часов по всем точкам\n' +
  'неделя — прогноз на 7 дней (выбор населённого пункта)\n' +
  'напоминание — ежедневная сводка в ваше время\n' +
  'отписаться — выключить рассылку\n\n' +
  '🤖 Я понимаю и свободные вопросы: «будет ли завтра дождь?», «что надеть?», «когда похолодает?», «можно ехать?»';

async function sendMenu(userId) {
  try {
    const res = await fetch('https://botapi.max.ru/messages?user_id=' + userId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': TOKEN },
      body: JSON.stringify({
        text: MENU_TEXT,
        attachments: [{
          type: 'inline_keyboard',
          payload: { buttons: [
            [{ type: 'callback', text: '🌤 Погода', payload: 'cmd:погода' }],
            [{ type: 'callback', text: '📅 Прогноз на 12 ч', payload: 'cmd:прогноз' }],
            [{ type: 'callback', text: '🗓 Прогноз на неделю', payload: 'cmd:неделя' }],
            [{ type: 'callback', text: '⏰ Напоминание', payload: 'cmd:напоминание' }],
            [{ type: 'callback', text: '🚫 Отписаться', payload: 'cmd:отписаться' }]
          ]}
        }]
      })
    });
    console.log('Меню с кнопками отправлено, статус:', res.status);
    if (res.status !== 200) {
      console.log('Ответ MAX:', (await res.text()).slice(0, 200));
      await bot.api.sendMessageToUser(userId, MENU_TEXT);
    }
  } catch (e) {
    console.error('Кнопки не отправились, шлю текст:', e.message);
    try { await bot.api.sendMessageToUser(userId, MENU_TEXT); } catch (e2) {}
  }
}

// Выбор населённого пункта для прогноза на неделю
async function sendWeekPicker(userId, replyFn) {
  const text = '🗓 Прогноз на неделю — выберите населённый пункт:';
  const buttons = WEEK_PLACES.map(function (p) {
    return [{ type: 'callback', text: '🗓 ' + p.name, payload: 'week:' + p.name }];
  });
  try {
    const res = await fetch('https://botapi.max.ru/messages?user_id=' + userId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': TOKEN },
      body: JSON.stringify({
        text: text,
        attachments: [{ type: 'inline_keyboard', payload: { buttons: buttons } }]
      })
    });
    if (res.status !== 200) {
      await replyFn(text + '\n(или напишите, например: неделя Лисичанск)');
    }
  } catch (e) {
    console.error('Выбор города не отправился:', e.message);
    try { await replyFn(text + '\n(или напишите, например: неделя Лисичанск)'); } catch (e2) {}
  }
}

// Выбор населённого пункта для текущей погоды
async function sendWeatherPicker(userId, replyFn) {
  const text = '🌤 Погода сейчас — выберите населённый пункт:';
  const buttons = QUERY_PLACES.map(function (p) {
    return [{ type: 'callback', text: '🌤 ' + p.name, payload: 'wp:' + p.name }];
  });
  try {
    const res = await fetch('https://botapi.max.ru/messages?user_id=' + userId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': TOKEN },
      body: JSON.stringify({
        text: text,
        attachments: [{ type: 'inline_keyboard', payload: { buttons: buttons } }]
      })
    });
    if (res.status !== 200) {
      await replyFn(text + '\n(или напишите, например: погода Москва)');
    }
  } catch (e) {
    console.error('Выбор города (погода) не отправился:', e.message);
    try { await replyFn(text + '\n(или напишите, например: погода Москва)'); } catch (e2) {}
  }
}

bot.on('bot_started', async function (ctx) {
  await addSub(ctx.user.user_id);
  try { await ctx.reply('Добро пожаловать в Метеодозор! Вы подписаны на оповещения о погоде: ' + placeNames() + '.'); } catch (e) {}
  await sendMenu(ctx.user.user_id);
});

// ===== РАССЫЛКА =====
async function broadcast(text) {
  for (const id of subscribers) {
    try { await bot.api.sendMessageToUser(id, text); }
    catch (e) { console.error('Ошибка отправки', id, e.message); }
  }
}

// ===== ИСТОЧНИКИ ПОГОДЫ =====
async function getCurrentOWM(p) {
  const url = 'http://api.openweathermap.org/data/2.5/weather?lat=' + p.lat + '&lon=' + p.lon +
              '&appid=' + WEATHER_KEY + '&units=metric&lang=ru';
  const w = await (await fetch(url)).json();
  if (!w || !w.wind) throw new Error('OWM: плохой ответ');
  return w;
}
async function getForecastOWM(p, cnt) {
  const url = 'http://api.openweathermap.org/data/2.5/forecast?lat=' + p.lat + '&lon=' + p.lon +
              '&appid=' + WEATHER_KEY + '&units=metric&lang=ru&cnt=' + cnt;
  return (await fetch(url)).json();
}

// Open-Meteo: текущие + влажность, точка росы, почасовая видимость
async function getCurrentOM(p) {
  const url = 'http://api.open-meteo.com/v1/forecast?latitude=' + p.lat + '&longitude=' + p.lon +
              '&current=temperature_2m,relative_humidity_2m,dew_point_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m' +
              '&hourly=visibility&wind_speed_unit=ms&timezone=Europe%2FMoscow&forecast_days=2';
  const j = await (await fetch(url)).json();
  if (!j || !j.current) throw new Error('Open-Meteo: плохой ответ');
  const code = j.current.weather_code;
  const main = (code >= 95) ? 'Thunderstorm' : (code >= 51 && code <= 67) ? 'Rain' :
               (code >= 71 && code <= 86) ? 'Snow' : (code === 45 || code === 48) ? 'Fog' : 'Clear';
  // Видимость на текущий час из почасового ряда
  let vis = null;
  try {
    const curKey = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 13);
    for (let k = 0; k < j.hourly.time.length; k++) {
      if (j.hourly.time[k].slice(0, 13) === curKey) { vis = j.hourly.visibility[k]; break; }
    }
  } catch (e) {}
  return {
    main: { temp: j.current.temperature_2m },
    humidity: j.current.relative_humidity_2m,
    dew: j.current.dew_point_2m,
    wind: { speed: j.current.wind_speed_10m, deg: j.current.wind_direction_10m },
    weather: [{ main: main, id: code, description: 'по данным Open-Meteo' }],
    visibility: vis
  };
}
async function getWeekOM(p) {
  const url = 'http://api.open-meteo.com/v1/forecast?latitude=' + p.lat + '&longitude=' + p.lon +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant' +
    '&wind_speed_unit=ms&timezone=Europe%2FMoscow&forecast_days=7';
  const j = await (await fetch(url)).json();
  if (!j || !j.daily) throw new Error('Open-Meteo weekly: плохой ответ');
  return j.daily;
}
async function getCurrent(p) {
  try { const w = await getCurrentOWM(p); w._source = 'OpenWeatherMap'; return w; }
  catch (e) {
    console.error('OWM недоступен (' + p.name + '), резерв Open-Meteo:', e.message);
    const w = await getCurrentOM(p);
    if (w.visibility == null) w.visibility = 10000;
    w._source = 'Open-Meteo (резерв)'; return w;
  }
}
async function getCrossWind(p) {
  try { return (await getCurrentOM(p)).wind.speed; } catch (e) { return null; }
}

// ===== РАДАР RAINVIEWER (только оповещения) =====
let radarFrame = { path: null, ts: 0 };
function getRadarFramePath() {
  if (radarFrame.path && Date.now() - radarFrame.ts < 10 * 60 * 1000) return Promise.resolve(radarFrame.path);
  return fetch('https://api.rainviewer.com/public/weather-maps.json')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      const past = j.radar && j.radar.past;
      if (!past || !past.length) throw new Error('нет кадров радара');
      radarFrame = { path: past[past.length - 1].path, ts: Date.now() };
      return radarFrame.path;
    });
}

// Ближайший дождь по радару, км (null — в зоне ~200 км сухо). Мозаика 3x3 тайла, z=7.
function radarRainKm(p) {
  return getRadarFramePath().then(function (framePath) {
    const Z = 7, SIZE = 256, N = Math.pow(2, Z);
    const latR = p.lat * Math.PI / 180;
    const gpx = (p.lon + 180) / 360 * SIZE * N;
    const gpy = (1 - Math.asinh(Math.tan(latR)) / Math.PI) / 2 * SIZE * N;
    const tx = Math.floor(gpx / SIZE), ty = Math.floor(gpy / SIZE);
    const ox = gpx - (tx - 1) * SIZE, oy = gpy - (ty - 1) * SIZE; // точка в координатах мозаики
    const kmPx = 156543.03392 * Math.cos(latR) / N / 1000;
    const jobs = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const u = 'https://tilecache.rainviewer.com' + framePath + '/256/' + Z + '/' + (tx + dx) + '/' + (ty + dy) + '/1/1_1.png';
        jobs.push(fetch(u)
          .then(function (r) { if (!r.ok) throw new Error('tile ' + r.status); return r.buffer(); })
          .then(function (buf) { return pureimage.decodePNGFromStream(Readable.from([buf])); })
          .catch(function () { return null; }));
      }
    }
    return Promise.all(jobs).then(function (imgs) {
      let best = null;
      for (let t = 0; t < imgs.length; t++) {
        const img = imgs[t];
        if (!img) continue;
        const bx = (t % 3) * SIZE, by = Math.floor(t / 3) * SIZE;
        for (let y = 0; y < SIZE; y++) {
          for (let x = 0; x < SIZE; x++) {
            const c = img.getPixelRGBA(x, y);
            const a = (c >>> 24) & 255;
            const sum = (c & 255) + ((c >>> 8) & 255) + ((c >>> 16) & 255);
            if (a > 40 && sum >= 60) {
              const d = Math.hypot(bx + x - ox, by + y - oy) * kmPx;
              if (best === null || d < best) best = d;
            }
          }
        }
      }
      return best;
    });
  });
}

// Расчётный детектор тумана: влажность >= 93%, точка росы близко, ветер слабый
function fogRisk(om) {
  if (!om || om.humidity == null || om.dew == null) return false;
  const spread = om.main.temp - om.dew;
  return om.humidity >= 93 && spread <= 2.5 && om.wind.speed <= 5;
}


// ===== МОЗГ: выводы и свободные вопросы =====
// Итоговый вывод по дню для сводок
function dayVerdict(precip, maxWind, maxGust, tMin, tMax) {
  const notes = [];
  if (precip.indexOf('гроза') !== -1) notes.push('гроза — не уходите далеко от укрытия');
  else if (precip.indexOf('дождь') !== -1 || precip.indexOf('ливн') !== -1) notes.push('пригодится зонт');
  else if (precip.indexOf('снег') !== -1) notes.push('одевайтесь теплее, будет снег');
  if (precip.indexOf('туман') !== -1) notes.push('туман — на дороге внимательнее');
  if (precip.indexOf('ледян') !== -1) notes.push('ледяные осадки — возможен гололёд');
  if (maxGust >= 15 || maxWind >= 10) notes.push('очень сильный ветер — закрепите всё на улице');
  else if (maxGust >= 8) notes.push('порывистый ветер');
  if (tMax <= -5) notes.push('морозно');
  else if (tMin <= 0 && tMax > 0) notes.push('ночью заморозки — утром возможна наледь');
  else if (tMax >= 30) notes.push('жарко — вода и тень');
  if (!notes.length) return '💡 Вывод: спокойная погода, без сюрпризов.';
  return '💡 Вывод: ' + notes.join('; ') + '.';
}

function hasAny(t, words) {
  for (let i = 0; i < words.length; i++) { if (t.indexOf(words[i]) !== -1) return true; }
  return false;
}

// Конкретный день недели (1=завтра, 2=послезавтра)
async function answerDay(ctx, p, offset, word) {
  const d = await getWeekOM(p);
  if (offset >= d.time.length) { ctx.reply('Нет данных на ' + word + '.'); return; }
  const tLo = Math.round(d.temperature_2m_min[offset]), tHi = Math.round(d.temperature_2m_max[offset]);
  const wMin = Math.min.apply(null, d.temperature_2m_min);
  const wMax = Math.max.apply(null, d.temperature_2m_max);
  ctx.reply('🤖 ' + p.name + ', ' + word + ' (' + dayName(d.time[offset]) + '):\n' +
    wmoText(d.weather_code[offset]) + ', ' + tLo + '°...' + tHi + '°C  ' + tempBar(tLo, tHi, wMin, wMax) + '\n' +
    '💨 ветер до ' + d.wind_speed_10m_max[offset] + ' м/с (порывы ' + d.wind_gusts_10m_max[offset] + ')\n' +
    dayVerdict(wmoText(d.weather_code[offset]), d.wind_speed_10m_max[offset], d.wind_gusts_10m_max[offset], tLo, tHi));
}

// Ближайшие выходные
async function answerWeekend(ctx, p) {
  const d = await getWeekOM(p);
  const lines = [];
  for (let k = 0; k < d.time.length; k++) {
    const wd = new Date(d.time[k] + 'T12:00:00+03:00').getDay();
    if (wd === 6 || wd === 0) {
      lines.push(dayName(d.time[k]) + ': ' + wmoText(d.weather_code[k]) + ', ' +
        Math.round(d.temperature_2m_min[k]) + '°...' + Math.round(d.temperature_2m_max[k]) +
        '°C, ветер до ' + d.wind_speed_10m_max[k] + ' м/с');
    }
  }
  if (!lines.length) { ctx.reply('Выходные пока за пределами прогноза.'); return; }
  ctx.reply('🤖 ' + p.name + ' — на выходных:\n' + lines.join('\n'));
}

// Вопрос про дождь: радар (факт) + прогноз (вероятность)
async function answerRain(ctx, p) {
  let radarLine = '📡 Радар недоступен.\n';
  try {
    const km = await radarRainKm(p);
    if (km === null) radarLine = '📡 Радар: в зоне ~200 км осадков нет.\n';
    else if (km <= 25) radarLine = '📡 Радар: дождь УЖЕ в ~' + Math.max(1, Math.round(km)) + ' км от нас — ждите скоро!\n';
    else radarLine = '📡 Радар: дождь в ~' + Math.round(km) + ' км — пока далеко, но следим.\n';
  } catch (e) {}
  let fcLine = '📅 Прогноз недоступен.';
  try {
    const f = await getForecastOWM(p, 8);
    const list = (f && f.list) || [];
    const wet = list.filter(function (i) { return (i.pop || 0) >= 0.3 || ['Rain', 'Drizzle', 'Thunderstorm'].includes(i.weather[0].main); });
    if (!wet.length) fcLine = '📅 Прогноз на ближайшие сутки: осадков не ожидается.';
    else {
      const lines = wet.slice(0, 4).map(function (i) {
        const t = new Date(i.dt * 1000 + 3 * 3600 * 1000);
        const hh = ('0' + t.getUTCHours()).slice(-2);
        const dd2 = ('0' + t.getUTCDate()).slice(-2) + '.' + ('0' + (t.getUTCMonth() + 1)).slice(-2);
        return '— ' + dd2 + ' в ' + hh + ':00, вероятность ~' + Math.round((i.pop || 0) * 100) + '%, ' + i.weather[0].description;
      });
      fcLine = '📅 Когда ждать осадки (мск):\n' + lines.join('\n');
    }
  } catch (e) {}
  ctx.reply('🤖 ' + p.name + ': будет ли дождь?\n' + radarLine + fcLine);
}

// Температурный тренд недели
async function answerTrend(ctx, p) {
  const d = await getWeekOM(p);
  let coldest = 0, warmest = 0;
  for (let k = 1; k < d.time.length; k++) {
    if (d.temperature_2m_max[k] < d.temperature_2m_max[coldest]) coldest = k;
    if (d.temperature_2m_max[k] > d.temperature_2m_max[warmest]) warmest = k;
  }
  const trend = [];
  for (let k = 0; k < d.time.length; k++) {
    trend.push(dayName(d.time[k]) + ': ' + Math.round(d.temperature_2m_min[k]) + '°...' + Math.round(d.temperature_2m_max[k]) + '°');
  }
  let verdict = '📉 Самый холодный день: ' + dayName(d.time[coldest]) + ' (днём ' + Math.round(d.temperature_2m_max[coldest]) + '°C).';
  if (warmest > 0 && d.temperature_2m_max[warmest] > d.temperature_2m_max[0] + 2) {
    verdict += '\n📈 Потепление к ' + dayName(d.time[warmest]) + ' — до ' + Math.round(d.temperature_2m_max[warmest]) + '°C.';
  }
  ctx.reply('🤖 ' + p.name + ' — тренд на неделю:\n' + trend.join('\n') + '\n' + verdict);
}

// Вопрос про ветер
async function answerWind(ctx, p) {
  const w = await getCurrent(p);
  let maxW = w.wind.speed, maxG = w.wind.gust || 0;
  try {
    const f = await getForecastOWM(p, 8);
    const list = (f && f.list) || [];
    if (list.length) {
      maxW = Math.max.apply(null, list.map(function (i) { return i.wind.speed; }));
      maxG = Math.max.apply(null, list.map(function (i) { return i.wind.gust || 0; }));
    }
  } catch (e) {}
  const dd = windDir(w.wind.deg);
  let verdict;
  if (maxG >= 15 || maxW >= 10) verdict = '💡 Опасно сильный ветер! Закрепите всё на улице, не паркуйтесь под деревьями.';
  else if (maxG >= 8 || maxW >= 6) verdict = '💡 Ветрено — держите головной убор, на дороге возможны порывы.';
  else if (maxW >= 4) verdict = '💡 Умеренный ветер — неприятно, но не опасно.';
  else verdict = '💡 Ветер слабый, ничего не грозит.';
  ctx.reply('🤖 ' + p.name + ': ветер\n' +
    'Сейчас: ' + w.wind.speed + ' м/с' + (w.wind.gust ? ' (порывы ' + w.wind.gust + ')' : '') + ', ' + dd[0] + '\n' +
    'Максимум за сутки: ' + maxW + ' м/с, порывы до ' + maxG + ' м/с\n' + verdict);
}

// Что надеть
async function answerClothes(ctx, p) {
  const w = await getCurrent(p);
  const fl0 = Math.round(w.main.feels_like != null ? w.main.feels_like : w.main.temp);
  const wet = ['Rain', 'Drizzle', 'Thunderstorm'].includes(w.weather[0].main);
  const tips = [];
  if (fl0 <= -15) tips.push('очень тёплая куртка, шапка, шарф, перчатки');
  else if (fl0 <= -5) tips.push('зимняя куртка и шапка');
  else if (fl0 <= 5) tips.push('тёплая куртка');
  else if (fl0 <= 12) tips.push('лёгкая куртка или толстовка');
  else if (fl0 <= 20) tips.push('кофта с длинным рукавом');
  else if (fl0 <= 27) tips.push('футболка, можно лёгкое');
  else tips.push('максимально лёгкая одежда, головной убор от солнца');
  if (w.wind.speed >= 6) tips.push('ветровка или капюшон — ветер ' + w.wind.speed + ' м/с');
  if (wet) tips.push('зонт или дождевик — идёт дождь');
  ctx.reply('🤖 ' + p.name + ': что надеть\n' +
    'Сейчас ' + Math.round(w.main.temp) + '°C, ощущается как ' + fl0 + '°C\n' +
    '💡 ' + tips.join('; ') + '.');
}

// Можно ли ехать (состояние дороги)
async function answerRoad(ctx, p) {
  const w = await getCurrent(p);
  const temp = w.main.temp;
  const main = w.weather[0].main;
  const wet = ['Rain', 'Drizzle', 'Thunderstorm'].includes(main);
  const ice = isIcy(main, w.weather[0].id, temp);
  let om = null;
  try { om = await getCurrentOM(p); } catch (e) {}
  const vis = (om && om.visibility != null) ? om.visibility : ((w.visibility != null) ? w.visibility : 10000);
  const fog = ['Fog', 'Mist', 'Haze', 'Smoke'].includes(main) || vis < 2000 ||
              (om && om.weather[0].main === 'Fog') || (om && fogRisk(om));
  const risks = [];
  if (ice) risks.push('🧊 ГОЛОЛЁД — по возможности не выезжайте');
  if (fog) risks.push('🌫 туман, видимость ~' + Math.round(vis) + ' м — снизьте скорость, включите противотуманки');
  if (wet) risks.push('🌧 мокрая дорога — увеличьте дистанцию');
  if ((w.wind.gust || 0) >= 8 || w.wind.speed >= 8) risks.push('💨 сильные порывы ветра — держите руль крепче');
  if (temp <= 0 && !ice) risks.push('❄️ минус — на мостах возможна наледь');
  const verdict = risks.length ? risks.join('\n') : '✅ Дорога спокойная: без осадков, видимость хорошая, ветер слабый.';
  ctx.reply('🤖 ' + p.name + ': можно ли ехать?\n' + verdict);
}

// Погодный контекст для ИИ (текущее + 3 дня по выбранной точке)
async function buildWeatherContext(p) {
  const lines = [];
  try {
    const w = await getCurrent(p);
    lines.push(p.name + ' сейчас: ' + Math.round(w.main.temp) + '°C, ' + w.weather[0].description +
               ', ветер ' + w.wind.speed + ' м/с' + (w.wind.gust ? ' (порывы ' + w.wind.gust + ' м/с)' : ''));
  } catch (e) {}
  try {
    const d = await getWeekOM(p);
    for (let k = 0; k < Math.min(3, d.time.length); k++) {
      lines.push(dayName(d.time[k]) + ': ' + wmoText(d.weather_code[k]) + ', ' +
                 Math.round(d.temperature_2m_min[k]) + '°...' + Math.round(d.temperature_2m_max[k]) +
                 '°C, ветер до ' + d.wind_speed_10m_max[k] + ' м/с');
    }
  } catch (e) {}
  return lines.join('\n');
}

// Запрос к Kimi K3 (модель рассуждающая: без temperature, с запасом токенов)
function askKimi(question, p) {
  if (!KIMI_KEY) return Promise.resolve(null);
  return buildWeatherContext(p).then(function (context) {
    const body = JSON.stringify({
      model: KIMI_MODEL,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: 'Ты — Метеодозор, погодный бот в мессенджере MAX. Отвечай по-русски, кратко (2-5 предложений), дружелюбно, можно с эмодзи. Опирайся только на данные погоды из контекста; если данных не хватает — честно скажи. Не выдумывай цифры.' },
        { role: 'user', content: 'Данные погоды:\n' + (context || 'нет данных') + '\n\nВопрос пользователя: ' + question }
      ]
    });
    return fetch('https://api.moonshot.ai/v1/chat/completions', {
      method: 'POST',
      timeout: 45000,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KIMI_KEY },
      body: body
    }).then(function (r) {
      if (!r.ok) throw new Error('Kimi HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      return (c && c.trim()) ? c.trim() : null;
    });
  }).catch(function (e) {
    console.error('Kimi:', e.message);
    return null;
  });
}

// Роутер свободных вопросов
async function smartReply(ctx, low) {
  const p = findQuery(low) || findPlace(low) || PLACES[0];
  const note = (findQuery(low) || findPlace(low)) ? '' : '\n(это для ' + p.name + ' — можно уточнить другой город)';
  try {
    if (hasAny(low, ['послезавтра'])) { await answerDay(ctx, p, 2, 'послезавтра'); }
    else if (hasAny(low, ['завтра'])) { await answerDay(ctx, p, 1, 'завтра'); }
    else if (hasAny(low, ['выходн'])) { await answerWeekend(ctx, p); }
    else if (hasAny(low, ['дождик', 'дождь', 'осадк', 'ливень', 'зонт', 'мокро', 'накрапыв'])) { await answerRain(ctx, p); }
    else if (hasAny(low, ['потеплее', 'похолодае', 'теплее', 'холоднее', 'заморозк', 'мороз', 'тренд'])) { await answerTrend(ctx, p); }
    else if (hasAny(low, ['ветер', 'ветрено', 'шторм', 'ураган', 'порыв'])) { await answerWind(ctx, p); }
    else if (hasAny(low, ['надеть', 'одеться', 'одеваться', 'куртк', 'шапк', 'шорты'])) { await answerClothes(ctx, p); }
    else if (hasAny(low, ['дорог', 'за руль', 'ехать', 'поехать', 'гололёд', 'гололед', 'видимость'])) { await answerRoad(ctx, p); }
    else if (hasAny(low, ['сейчас', 'сегодня', 'на улице', 'погод'])) { await sendWeatherNow(ctx, p); }
    else {
      const ai = await askKimi(low, p);
      if (ai) ctx.reply('🤖 ' + ai);
      else ctx.reply('🤖 Я умею отвечать на свободные вопросы! Спросите, например:\n' +
        '— «будет ли завтра дождь?»\n— «когда похолодает?»\n— «что надеть?»\n' +
        '— «можно ехать?»\n— «какой ветер?»\n— «погода на выходных»\n\n' + MENU_TEXT);
    }
    if (note) { try { await ctx.reply(note.trim()); } catch (e2) {} }
  } catch (e) {
    console.error('Мозг:', e.message);
    ctx.reply('Не понял вопрос 🤔\n\n' + MENU_TEXT);
  }
}

// ===== СВОДКА НА ДЕНЬ =====
async function buildDayText(p, header) {
  const f = await getForecastOWM(p, 4);
  const list = (f && f.list) || [];
  if (!list.length) return null;
  const temps = list.map(function (i) { return i.main.temp; });
  const maxWind = Math.max.apply(null, list.map(function (i) { return i.wind.speed; }));
  const maxGust = Math.max.apply(null, list.map(function (i) { return i.wind.gust || 0; }));
  const windy = list.reduce(function (a, b) { return a.wind.speed >= b.wind.speed ? a : b; });
  const dd = windDir(windy.wind.deg);
  const conds = {};
  list.forEach(function (i) { conds[i.weather[0].main] = true; });
  let precip = 'без осадков';
  if (conds['Thunderstorm']) precip = '⛈ возможна гроза';
  else if (conds['Rain'] || conds['Drizzle']) precip = '🌧 ожидается дождь';
  else if (conds['Snow']) precip = '🌨 ожидается снег';
  if (conds['Fog'] || conds['Mist'] || conds['Haze']) precip += ', 🌫 туман';
  const tMin = Math.round(Math.min.apply(null, temps));
  const tMax = Math.round(Math.max.apply(null, temps));
  return header + '\n━━━━━━━━━━━━━━━\n' +
    '🌡 Температура: от ' + tMin + '° до ' + tMax + '°C\n' +
    '💨 Ветер: до ' + maxWind + ' м/с (порывы до ' + maxGust + ' м/с), ' + dd[0] + ' (' + dd[1] + ')\n' +
    '☔ Осадки: ' + precip + '\n' +
    dayVerdict(precip, maxWind, maxGust, tMin, tMax);
}

// Сводка сразу по всем точкам (для утренней рассылки и напоминаний)
async function buildAllText(header) {
  const parts = [];
  for (const p of PLACES) {
    try {
      const t = await buildDayText(p, '📍 ' + p.name);
      if (t) parts.push(t);
    } catch (e) { console.error('Сводка (' + p.name + '):', e.message); }
  }
  if (!parts.length) return null;
  return header + '\n' + parts.join('\n━━━━━━━━━━━━━━━\n') + '\n━━━━━━━━━━━━━━━';
}

// ===== ОПОВЕЩЕНИЯ =====
const flags = {};
PLACES.forEach(function (p) {
  flags[p.name] = { wind: false, gust: false, rainNow: false, fogNow: false, rainSoon: false,
                    fogSoon: false, stormNow: false, stormSoon: false, iceNow: false, iceSoon: false, radarRain: false };
});

function isIcy(main, id, temp) {
  if (id === 511 || id === 66 || id === 67) return true;
  return ['Rain', 'Drizzle'].includes(main) && temp >= -3 && temp <= 1;
}

async function checkPlace(p) {
  const fl = flags[p.name];
  try {
    const w = await getCurrent(p);
    const temp = w.main.temp;
    const wind = w.wind.speed;
    const gust = w.wind.gust || 0;
    const dd = windDir(w.wind.deg);
    const dirShort = dd[0], dirFull = dd[1];
    const main = w.weather[0].main;
    const id = w.weather[0].id;
    const rainMm = w.rain && w.rain['1h'];
    const rainNow  = ['Rain', 'Drizzle'].includes(main);
    const stormNow = main === 'Thunderstorm';

    // Туман: официальный статус + видимость + РАСЧЁТ по влажности/точке росы
    let fogNow = ['Fog', 'Mist', 'Haze', 'Smoke'].includes(main) || (w.visibility && w.visibility < 2000);
    let fogCalc = false;
    try {
      const om = await getCurrentOM(p);
      if (om.weather[0].main === 'Fog') fogNow = true;
      if (om.visibility != null && om.visibility < 2000) fogNow = true;
      if (!fogNow && fogRisk(om)) { fogNow = true; fogCalc = true; }
    } catch (e) {}

    const iceNow = isIcy(main, id, temp);

    if (wind > WIND_LIMIT && !fl.wind) {
      const cross = await getCrossWind(p);
      const confirm = cross === null ? '' :
        (cross > WIND_LIMIT ? '\n✅ Подтверждено вторым источником (' + cross + ' м/с)'
                            : '\n⚠️ Второй источник: ' + cross + ' м/с — расхождение');
      await broadcast('💨 ВНИМАНИЕ! ' + p.name + '\nВетер усилился: ' + wind + ' м/с, ' + dirShort +
                      ' (' + dirFull + ')\nПорог: ' + WIND_LIMIT + ' м/с' + confirm);
      fl.wind = true;
    } else if (wind <= WIND_LIMIT) fl.wind = false;

    if (gust > GUST_LIMIT && !fl.gust) {
      await broadcast('🌪 ОПАСНО! ' + p.name + '\nПорывы ветра до ' + gust + ' м/с, ' + dirShort + ' (' + dirFull + ')!');
      fl.gust = true;
    } else if (gust <= GUST_LIMIT) fl.gust = false;

    if (stormNow && !fl.stormNow) {
      await broadcast('⛈ ' + p.name + ': гроза! Ветер ' + wind + ' м/с, ' + dirShort + '.');
      fl.stormNow = true;
    } else if (!stormNow) fl.stormNow = false;

    if (rainNow && !fl.rainNow) {
      await broadcast('🌧 ' + p.name + ': начался дождь' + rainWord(rainMm) + '\nТемпература ' + Math.round(temp) + '°C.');
      fl.rainNow = true;
    } else if (!rainNow) fl.rainNow = false;

    if (iceNow && !fl.iceNow) {
      await broadcast('🧊 ОПАСНО! ' + p.name + ': гололёд!\nОсадки при температуре ' + Math.round(temp) + '°C — дороги и провода обледеневают.');
      fl.iceNow = true;
    } else if (!iceNow) fl.iceNow = false;

    if (fogNow && !fl.fogNow) {
      if (fogCalc) {
        await broadcast('🌫 ' + p.name + ': вероятен ТУМАН (по расчёту: высокая влажность и точка росы).\nВидимость может быть плохой — будьте осторожны на дороге.');
      } else {
        await broadcast('🌫 ' + p.name + ': туман, видимость менее 2 км.');
      }
      fl.fogNow = true;
    } else if (!fogNow) fl.fogNow = false;

    let list = [];
    try { list = ((await getForecastOWM(p, 2)) || {}).list || []; }
    catch (e) { console.error('Прогноз недоступен (' + p.name + '):', e.message); }

    const stormSoon = list.some(function (i) { return i.weather[0].main === 'Thunderstorm'; });
    const iceSoon   = list.some(function (i) { return isIcy(i.weather[0].main, i.weather[0].id, i.main.temp); });
    const rainSoon  = list.some(function (i) { return ['Rain', 'Drizzle'].includes(i.weather[0].main); });
    const fogSoon   = list.some(function (i) { return ['Fog', 'Mist', 'Haze'].includes(i.weather[0].main); });

    if (stormSoon && !stormNow && !fl.stormSoon) {
      await broadcast('⛈ Гроза приближается к ' + p.name + ', ~3 часа.'); fl.stormSoon = true;
    } else if (!stormSoon) fl.stormSoon = false;
    if (iceSoon && !iceNow && !fl.iceSoon) {
      await broadcast('🧊 ВНИМАНИЕ! К ' + p.name + ' приближаются осадки при ~0°C — возможен гололёд в ближайшие ~3 часа.'); fl.iceSoon = true;
    } else if (!iceSoon) fl.iceSoon = false;
    if (rainSoon && !rainNow && !fl.rainSoon) {
      await broadcast('🌧 Дождь приближается к ' + p.name + ', ~3 часа.'); fl.rainSoon = true;
    } else if (!rainSoon) fl.rainSoon = false;
    if (fogSoon && !fogNow && !fl.fogSoon) {
      await broadcast('🌫 Туман приближается к ' + p.name + ', ~3 часа.'); fl.fogSoon = true;
    } else if (!fogSoon) fl.fogSoon = false;

    // Радар RainViewer: реальные осадки рядом (только оповещение)
    try {
      const kmRadar = await radarRainKm(p);
      if (kmRadar !== null && kmRadar <= 25 && !fl.radarRain) {
        await broadcast('🌧 РАДАР: дождь виден в ~' + Math.max(1, Math.round(kmRadar)) + ' км от ' + p.name + '!\nОсадки реальные (не прогноз) — вероятно, скоро дойдут до нас.');
        fl.radarRain = true;
      } else if ((kmRadar === null || kmRadar > 25) && fl.radarRain) fl.radarRain = false;
    } catch (e) { console.error('Радар (' + p.name + '):', e.message); }

    console.log(new Date().toISOString(),
      'OK ' + p.name + ' [' + w._source + ']: ' + Math.round(temp) + '°C, ветер ' + wind + '/' + gust + ' м/с ' + dirShort +
      ', дождь ' + rainNow + ', гроза ' + stormNow + ', гололёд ' + iceNow + ', туман ' + fogNow + (fogCalc ? ' (расчёт)' : ''));
  } catch (e) {
    console.error('Ошибка проверки погоды (' + p.name + '):', e.message);
  }
}

async function checkWeather() {
  for (const p of PLACES) { await checkPlace(p); }
}

// ===== СВОДКИ 6:00 И 20:00 МСК =====
let lastDigestSlot = '';
async function digestTick() {
  const now = new Date();
  const h = now.getUTCHours();
  if (DIGEST_HOURS_UTC.indexOf(h) === -1) return;
  const slot = now.toISOString().slice(0, 10) + '-' + h;
  if (lastDigestSlot === slot) return;
  lastDigestSlot = slot;
  try {
    const morning = (h === DIGEST_HOURS_UTC[0]);
    const text = await buildAllText(morning ? '🌅 Доброе утро! Прогноз на сегодня:'
                                            : '🌆 Добрый вечер! Прогноз на ночь:');
    if (text) {
      await broadcast(text + (morning ? '\nХорошего дня! Напишите «погода» — текущая сводка'
                                      : '\nСпокойного вечера! Напишите «погода» — текущая сводка'));
      console.log('Сводка отправлена, слот ' + slot);
    }
  } catch (e) { console.error('Ошибка сводки:', e.message); }
}

// ===== ЛИЧНЫЕ НАПОМИНАНИЯ =====
async function reminderTick() {
  const nowMsk = new Date(Date.now() + 3 * 3600 * 1000);
  const cur = ('0' + nowMsk.getUTCHours()).slice(-2) + ':' + ('0' + nowMsk.getUTCMinutes()).slice(-2);
  const today = nowMsk.toISOString().slice(0, 10);
  for (const uid in reminders) {
    if (reminders[uid] === cur && lastReminderDay[uid] !== today) {
      lastReminderDay[uid] = today;
      try {
        const text = await buildAllText('⏰ Ваша сводка погоды:');
        if (text) await bot.api.sendMessageToUser(uid, text);
      } catch (e) { console.error('Ошибка напоминания', uid, e.message); }
    }
  }
}

// ===== МЕНЮ КОМАНД В ПОЛЕ ВВОДА =====
async function setCommands() {
  const cmdsRu = [
    { name: 'погода', description: 'Погода сейчас — выбор города' },
    { name: 'прогноз', description: 'Прогноз на 12 часов' },
    { name: 'неделя', description: 'Прогноз на 7 дней' },
    { name: 'напоминание', description: 'Ежедневная сводка в ваше время' },
    { name: 'отписаться', description: 'Отключить оповещения' }
  ];
  const cmdsLat = [
    { name: 'pogoda', description: 'Текущая сводка погоды' },
    { name: 'prognoz', description: 'Прогноз на 12 часов' },
    { name: 'nedelya', description: 'Прогноз на 7 дней' },
    { name: 'napominanie', description: 'Ежедневная сводка в ваше время' },
    { name: 'otmena', description: 'Отключить оповещения' }
  ];
  try {
    let res = await fetch('https://botapi.max.ru/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': TOKEN },
      body: JSON.stringify({ commands: cmdsRu })
    });
    console.log('Меню команд (ru): статус', res.status);
    if (res.status !== 200) {
      res = await fetch('https://botapi.max.ru/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': TOKEN },
        body: JSON.stringify({ commands: cmdsLat })
      });
      console.log('Меню команд (lat): статус', res.status);
    }
  } catch (e) { console.error('Не удалось установить команды:', e.message); }
}

// ===== ПРОГНОЗ НА НЕДЕЛЮ ПО ТОЧКЕ =====
async function sendWeek(ctx, p) {
  try {
    const d = await getWeekOM(p);
    const wMin = Math.min.apply(null, d.temperature_2m_min);
    const wMax = Math.max.apply(null, d.temperature_2m_max);
    const lines = [];
    for (let k = 0; k < d.time.length; k++) {
      const tLo = Math.round(d.temperature_2m_min[k]), tHi = Math.round(d.temperature_2m_max[k]);
      lines.push(
        '📆 ' + dayName(d.time[k]) + '\n' +
        '   ' + wmoText(d.weather_code[k]) + '\n' +
        '   🌡 ' + tLo + '°...' + tHi + '°C  ' + tempBar(tLo, tHi, wMin, wMax) + '\n' +
        '   💨 ветер до ' + d.wind_speed_10m_max[k] + ' м/с (порывы ' + d.wind_gusts_10m_max[k] + '), ' + windDir(d.wind_direction_10m_dominant[k])[0]
      );
    }
    ctx.reply('🗓 ' + p.name + ' — прогноз на неделю (мск):\n━━━━━━━━━━━━━━━\n' + lines.join('\n━━━━━━━━━━━━━━━\n'));
  } catch (e) { ctx.reply('Не удалось получить прогноз на неделю (' + p.name + ').'); }
}

// ===== ПОГОДА СЕЙЧАС ПО ВЫБРАННОЙ ТОЧКЕ =====
async function sendWeatherNow(ctx, p) {
  try {
    const w = await getCurrent(p);
    const dd = windDir(w.wind.deg);
    const dirShort = dd[0], dirFull = dd[1];
    const gust = w.wind.gust ? ' (порывы до ' + w.wind.gust + ' м/с)' : '';
    let om = null;
    try { om = await getCurrentOM(p); } catch (e) {}
    const omFog = om ? (om.weather[0].main === 'Fog' || (om.visibility != null && om.visibility < 2000) || fogRisk(om)) : null;
    const omDir = om ? windDir(om.wind.deg)[0] : 'н/д';
    const vis = (om && om.visibility != null) ? om.visibility : ((w.visibility != null) ? w.visibility : 10000);
    const fogYes = ['Fog', 'Mist', 'Haze', 'Smoke'].includes(w.weather[0].main) ||
                   ((w.visibility != null) && w.visibility < 2000) || omFog === true;
    const fogLine = fogYes ? '🌫 Туман: ДА, видимость ~' + Math.round(vis) + ' м'
                           : '🌫 Туман: нет, видимость ~' + (vis >= 10000 ? '10+ км' : Math.round(vis) + ' м');
    const humLine = om && om.humidity != null
      ? '\n💧 Влажность: ' + om.humidity + '%, точка росы ' + Math.round(om.dew) + '°C' : '';
    let warn = '';
    if (om && Math.abs(w.wind.speed - om.wind.speed) > 2) {
      warn = '\n⚠️ Источники расходятся по ветру:\n   OpenWeatherMap: ' + w.wind.speed + ' м/с, ' + dirShort +
             '\n   Open-Meteo: ' + om.wind.speed + ' м/с, ' + omDir;
    }
    // Ощущается как + советы
    let feelLine = '';
    if (w.main.feels_like != null) {
      const fl0 = Math.round(w.main.feels_like);
      const tips = [];
      if (fl0 <= -10) tips.push('одевайтесь очень тепло');
      else if (fl0 <= 0) tips.push('нужна тёплая одежда');
      else if (fl0 >= 30) tips.push('жара — больше воды');
      if (w.wind.speed >= 8) tips.push('сильный ветер — держите головной убор');
      if (['Rain', 'Drizzle', 'Thunderstorm'].includes(w.weather[0].main)) tips.push('возьмите зонт');
      if (fogYes) tips.push('на дороге будьте внимательны');
      feelLine = '🤔 Ощущается как: ' + fl0 + '°C' + (tips.length ? ' — ' + tips.join('; ') : '') + '\n';
    }
    // Восход и закат (по смещению часового пояса из OpenWeatherMap)
    let sunLine = '';
    if (w.sys && w.sys.sunrise && w.sys.sunset) {
      const tzs = (w.timezone != null ? w.timezone : 3 * 3600) * 1000;
      const fm = function (ts) {
        const d2 = new Date(ts * 1000 + tzs);
        return ('0' + d2.getUTCHours()).slice(-2) + ':' + ('0' + d2.getUTCMinutes()).slice(-2);
      };
      sunLine = '🌅 Восход ' + fm(w.sys.sunrise) + ', закат ' + fm(w.sys.sunset) + '\n';
    }
    ctx.reply(
      '📍 ' + p.name + ' | сводка сейчас\n━━━━━━━━━━━━━━━\n' +
      '🌡 Температура: ' + Math.round(w.main.temp) + '°C\n' +
      feelLine +
      '☁️ Состояние: ' + w.weather[0].description + '\n' +
      '💨 Ветер: ' + w.wind.speed + ' м/с' + gust + ', ' + dirShort + ' (' + dirFull + ')\n' +
      fogLine + humLine + '\n' +
      '🔁 Контроль (Open-Meteo): ' + (om ? Math.round(om.main.temp) + '°C, ветер ' + om.wind.speed + ' м/с, ' + omDir : 'недоступен') +
      ', туман: ' + (omFog === null ? 'н/д' : (omFog ? 'да' : 'нет')) + warn + '\n' + sunLine + '━━━━━━━━━━━━━━━'
    );
  } catch (e) { ctx.reply('Не удалось получить погоду (' + p.name + '), попробуйте позже.'); }
}

// ===== ОБРАБОТКА ТЕКСТА =====
async function onText(ctx, text) {
  const low = (text || '').trim().toLowerCase();
  const uid = ctx.user && ctx.user.user_id;

  if (pendingReminder.has(uid)) {
    if (low.indexOf('стоп') !== -1 || low.indexOf('отмена') !== -1) {
      pendingReminder.delete(uid);
      ctx.reply('Хорошо, напоминание не задаю.');
      return;
    }
    const m = text.trim().match(/^(\d{1,2})[:.](\d{2})$/);
    if (m && +m[1] < 24 && +m[2] < 60) {
      const t = ('0' + (+m[1])).slice(-2) + ':' + m[2];
      pendingReminder.delete(uid);
      await saveReminder(uid, t);
      ctx.reply('✅ Готово! Теперь каждый день в ' + t + ' (мск) вам будет приходить сводка по всем точкам.\nОтключить: напоминание стоп');
    } else {
      ctx.reply('Не понял время. Напишите в формате ЧЧ:ММ, например 07:30');
    }
    return;
  }

  if (low === '/напоминание' || low === 'напоминание') {
    pendingReminder.add(uid);
    ctx.reply('⏰ В какое время присылать вам прогноз погоды каждый день?\nНапишите время в формате ЧЧ:ММ, например 07:30 (московское время).\nОтмена: напишите «стоп»');
    return;
  }
  if (low === '/напоминание стоп' || low === 'напоминание стоп') {
    pendingReminder.delete(uid);
    await removeReminder(uid);
    ctx.reply('Напоминание отключено.');
    return;
  }

  if (low === '/погода' || low === 'погода') {
    await sendWeatherPicker(uid, function (t) { return ctx.reply(t); });
    return;
  }
  if (low.indexOf('погода ') === 0 || low.indexOf('/погода ') === 0) {
    const p = findQuery(low);
    if (p) { await sendWeatherNow(ctx, p); }
    else { await smartReply(ctx, low); }
    return;
  }

  if (low === '/прогноз' || low === 'прогноз') {
    const parts = [];
    for (const p of PLACES) {
      try {
        const f = await getForecastOWM(p, 4);
        const list = (f && f.list) || [];
        if (!list.length) { parts.push('📍 ' + p.name + '\nпрогноз недоступен'); continue; }
        const lines = list.map(function (i) {
          const t = new Date(i.dt * 1000 + 3 * 3600 * 1000);
          const hh = ('0' + t.getUTCHours()).slice(-2);
          return '🕐 ' + hh + ':00 — ' + Math.round(i.main.temp) + '°C, ' + i.weather[0].description +
                 ', ветер ' + i.wind.speed + ' м/с ' + windDir(i.wind.deg)[0] +
                 ((i.pop || 0) >= 0.3 ? ', осадки ~' + Math.round(i.pop * 100) + '%' : '');
        });
        parts.push('📍 ' + p.name + '\n' + lines.join('\n'));
      } catch (e) { parts.push('📍 ' + p.name + '\nпрогноз недоступен'); }
    }
    ctx.reply('📅 Прогноз на 12 часов (мск):\n━━━━━━━━━━━━━━━\n' + parts.join('\n━━━━━━━━━━━━━━━\n'));
    return;
  }

  if (low === '/неделя' || low === 'неделя') {
    await sendWeekPicker(uid, function (t) { return ctx.reply(t); });
    return;
  }
  if (low.indexOf('неделя ') === 0 || low.indexOf('/неделя ') === 0) {
    const p = findPlace(low);
    if (p) { await sendWeek(ctx, p); }
    else { ctx.reply('Не знаю такой точки. Доступны: ' + weekNames()); }
    return;
  }

  if (low === '/отписаться' || low === 'отписаться') {
    await delSub(uid);
    await removeReminder(uid);
    ctx.reply('Вы отписаны от оповещений. Чтобы вернуться — просто напишите боту снова.');
    return;
  }

  if (low === 'меню' || low === 'команды' || low === 'помощь' || low === '/меню' || low === '/start') {
    await sendMenu(uid);
    return;
  }

  if (low.indexOf('/админ') === 0) {
    const pass = text.split(/\s+/)[1];
    if (pass === ADMIN_PASS) {
      await setAdmin(uid);
      ctx.reply('✅ Вы назначены админом. Команды:\n/подписчики — число подписчиков\n/сказать <текст> — рассылка всем');
    } else {
      ctx.reply('Неверный пароль.');
    }
    return;
  }
  if (low === '/подписчики') {
    if (uid === adminId) ctx.reply('👥 Подписчиков в рассылке: ' + subscribers.size);
    return;
  }
  if (low.indexOf('/сказать') === 0) {
    if (uid !== adminId) return;
    const msg = text.slice(8).trim();
    if (!msg) { ctx.reply('Формат: /сказать <текст>'); return; }
    await broadcast('📢 ' + msg);
    ctx.reply('Отправлено ' + subscribers.size + ' подписчикам.');
    return;
  }

  await smartReply(ctx, low);
}

bot.on('message_created', async function (ctx) {
  try { await onText(ctx, ctx.message.body.text); }
  catch (e) { console.error('Ошибка обработки сообщения:', e.message); }
});

bot.on('message_callback', async function (ctx) {
  try {
    const payload = ctx.callback && ctx.callback.payload;
    const uid = ctx.user && ctx.user.user_id;
    if (!payload || !uid) return;
    const fakeCtx = {
      user: { user_id: uid },
      reply: function (t) { return bot.api.sendMessageToUser(uid, t); }
    };
    if (payload.indexOf('cmd:') === 0) {
      await onText(fakeCtx, payload.slice(4));
    } else if (payload.indexOf('week:') === 0) {
      const p = findPlace(payload.slice(5));
      if (p) { await sendWeek(fakeCtx, p); }
    } else if (payload.indexOf('wp:') === 0) {
      const p = findQuery(payload.slice(3));
      if (p) { await sendWeatherNow(fakeCtx, p); }
    }
  } catch (e) { console.error('Ошибка кнопки:', e.message); }
});

// ===== ВЕБ-СЕРВЕР =====
const PORT = process.env.PORT || 3000;
http.createServer(function (req, res) { res.writeHead(200); res.end('Meteodozor OK'); }).listen(PORT);

// ===== ЗАПУСК =====
(async function () {
  await loadData();
  setInterval(checkWeather, CHECK_MINUTES * 60 * 1000);
  setInterval(function () { digestTick(); reminderTick(); }, 60 * 1000);
  checkWeather();
  bot.start();
  setCommands();
  console.log('Бот запущен, мониторинг: ' + placeNames());
})();
