process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { Bot } = require('@maxhub/max-bot-api');
const fetch = require('node-fetch');
const http = require('http');
const fs = require('fs');

// ===== НАСТРОЙКИ =====
const WIND_LIMIT = 4;
const GUST_LIMIT = 8;
const CHECK_MINUTES = 10;
const DIGEST_HOURS_UTC = [3, 17]; // 6:00 и 20:00 МСК
const ADMIN_PASS = process.env.ADMIN_PASS || 'метео2026'; // <<< лучше задать ADMIN_PASS в Variables на Railway!

// Точки мониторинга
const PLACES = [
  { name: 'Рай-Александровка', lat: 48.8105, lon: 37.8513 },
  { name: 'Лисичанск',         lat: 48.9048, lon: 38.4421 },
  { name: 'Северск',           lat: 48.8669, lon: 38.1000 },
  { name: 'Алчевск',           lat: 48.4689, lon: 38.8167 }
];

// Точки для кнопочной команды "погода" (по запросу, без автомониторинга)
const P_MOSCOW  = { name: 'Москва',  lat: 55.7558, lon: 37.6173 };
const P_LUGANSK = { name: 'Луганск', lat: 48.5742, lon: 39.3078 };
const QUERY_PLACES = [P_MOSCOW, P_LUGANSK, PLACES[1], PLACES[2], PLACES[3], PLACES[0]];

const bot = new Bot(process.env.BOT_TOKEN);
const WEATHER_KEY = process.env.WEATHER_KEY;
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
function placeNames() {
  return PLACES.map(function (p) { return p.name; }).join(', ');
}
function findPlace(text) {
  const t = (text || '').toLowerCase();
  for (const p of PLACES) {
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
  'отписаться — выключить рассылку';

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
  const buttons = PLACES.map(function (p) {
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

// Расчётный детектор тумана: влажность >= 93%, точка росы близко, ветер слабый
function fogRisk(om) {
  if (!om || om.humidity == null || om.dew == null) return false;
  const spread = om.main.temp - om.dew;
  return om.humidity >= 93 && spread <= 2.5 && om.wind.speed <= 5;
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
  return header + '\n━━━━━━━━━━━━━━━\n' +
    '🌡 Температура: от ' + Math.round(Math.min.apply(null, temps)) + '° до ' + Math.round(Math.max.apply(null, temps)) + '°C\n' +
    '💨 Ветер: до ' + maxWind + ' м/с (порывы до ' + maxGust + ' м/с), ' + dd[0] + ' (' + dd[1] + ')\n' +
    '☔ Осадки: ' + precip;
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
                    fogSoon: false, stormNow: false, stormSoon: false, iceNow: false, iceSoon: false };
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
    const lines = [];
    for (let k = 0; k < d.time.length; k++) {
      lines.push(
        '📆 ' + dayName(d.time[k]) + '\n' +
        '   ' + wmoText(d.weather_code[k]) + '\n' +
        '   🌡 ' + Math.round(d.temperature_2m_min[k]) + '°...' + Math.round(d.temperature_2m_max[k]) + '°C\n' +
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
    ctx.reply(
      '📍 ' + p.name + ' | сводка сейчас\n━━━━━━━━━━━━━━━\n' +
      '🌡 Температура: ' + Math.round(w.main.temp) + '°C\n' +
      '☁️ Состояние: ' + w.weather[0].description + '\n' +
      '💨 Ветер: ' + w.wind.speed + ' м/с' + gust + ', ' + dirShort + ' (' + dirFull + ')\n' +
      fogLine + humLine + '\n' +
      '🔁 Контроль (Open-Meteo): ' + (om ? Math.round(om.main.temp) + '°C, ветер ' + om.wind.speed + ' м/с, ' + omDir : 'недоступен') +
      ', туман: ' + (omFog === null ? 'н/д' : (omFog ? 'да' : 'нет')) + warn + '\n━━━━━━━━━━━━━━━'
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
    else { ctx.reply('Не знаю такой точки. Доступны: ' + queryNames()); }
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
                 ', ветер ' + i.wind.speed + ' м/с ' + windDir(i.wind.deg)[0];
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
    else { ctx.reply('Не знаю такой точки. Доступны: ' + placeNames()); }
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

  ctx.reply('Не понял команду 🤔\n\n' + MENU_TEXT);
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
