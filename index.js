process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { Bot } = require('@maxhub/max-bot-api');
const fetch = require('node-fetch');
const http = require('http');
const fs = require('fs');

// ===== НАСТРОЙКИ =====
const WIND_LIMIT = 4;          // порог среднего ветра, м/с
const GUST_LIMIT = 8;          // порог порывов ветра, м/с
const CHECK_MINUTES = 10;      // интервал проверки погоды
const DIGEST_HOUR_UTC = 3;     // утренняя сводка: 6:00 МСК = 3:00 UTC
const ADMIN_PASS = 'метео2026';// <<< СМЕНИТЕ ПАРОЛЬ АДМИНА!
const LAT = 48.8105;           // Рай-Александровка, Николаевская община
const LON = 37.8513;
const PLACE = 'Рай-Александровка';

const bot = new Bot(process.env.BOT_TOKEN);
const WEATHER_KEY = process.env.WEATHER_KEY;

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

// ===== ХРАНИЛИЩЕ: Upstash Redis, иначе файлы =====
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

bot.on('bot_started', async function (ctx) {
  await addSub(ctx.user.user_id);
  ctx.reply('Вы подписаны на оповещения Метеодозора!\nКоманды: /погода, /прогноз, /неделя, /напоминание, /отписаться');
});

// ===== РАССЫЛКА =====
async function broadcast(text) {
  for (const id of subscribers) {
    try { await bot.api.sendMessageToUser(id, text); }
    catch (e) { console.error('Ошибка отправки', id, e.message); }
  }
}

// ===== ИСТОЧНИКИ ПОГОДЫ =====
async function getCurrentOWM() {
  const url = 'http://api.openweathermap.org/data/2.5/weather?lat=' + LAT + '&lon=' + LON +
              '&appid=' + WEATHER_KEY + '&units=metric&lang=ru';
  const w = await (await fetch(url)).json();
  if (!w || !w.wind) throw new Error('OWM: плохой ответ');
  return w;
}
async function getForecastOWM(cnt) {
  const url = 'http://api.openweathermap.org/data/2.5/forecast?lat=' + LAT + '&lon=' + LON +
              '&appid=' + WEATHER_KEY + '&units=metric&lang=ru&cnt=' + cnt;
  return (await fetch(url)).json();
}
async function getCurrentOM() {
  const url = 'http://api.open-meteo.com/v1/forecast?latitude=' + LAT + '&longitude=' + LON +
              '&current=temperature_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m&wind_speed_unit=ms';
  const j = await (await fetch(url)).json();
  if (!j || !j.current) throw new Error('Open-Meteo: плохой ответ');
  const code = j.current.weather_code;
  const main = (code >= 95) ? 'Thunderstorm' : (code >= 51 && code <= 67) ? 'Rain' :
               (code >= 71 && code <= 86) ? 'Snow' : (code === 45 || code === 48) ? 'Fog' : 'Clear';
  return {
    main: { temp: j.current.temperature_2m },
    wind: { speed: j.current.wind_speed_10m, deg: j.current.wind_direction_10m },
    weather: [{ main: main, id: code, description: 'по данным Open-Meteo' }],
    visibility: 10000
  };
}
async function getWeekOM() {
  const url = 'http://api.open-meteo.com/v1/forecast?latitude=' + LAT + '&longitude=' + LON +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant' +
    '&wind_speed_unit=ms&timezone=Europe%2FMoscow&forecast_days=7';
  const j = await (await fetch(url)).json();
  if (!j || !j.daily) throw new Error('Open-Meteo weekly: плохой ответ');
  return j.daily;
}
async function getCurrent() {
  try { const w = await getCurrentOWM(); w._source = 'OpenWeatherMap'; return w; }
  catch (e) {
    console.error('OWM недоступен, резерв Open-Meteo:', e.message);
    const w = await getCurrentOM(); w._source = 'Open-Meteo (резерв)'; return w;
  }
}
async function getCrossWind() {
  try { return (await getCurrentOM()).wind.speed; } catch (e) { return null; }
}

// ===== СВОДКА НА ДЕНЬ (для утренней рассылки и напоминаний) =====
async function buildDayText(header) {
  const f = await getForecastOWM(4);
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
    '☔ Осадки: ' + precip + '\n━━━━━━━━━━━━━━━';
}

// ===== ОПОВЕЩЕНИЯ =====
const flags = { wind: false, gust: false, rainNow: false, fogNow: false, rainSoon: false,
                fogSoon: false, stormNow: false, stormSoon: false, iceNow: false, iceSoon: false };

function isIcy(main, id, temp) {
  if (id === 511 || id === 66 || id === 67) return true;
  return ['Rain', 'Drizzle'].includes(main) && temp >= -3 && temp <= 1;
}

async function checkWeather() {
  try {
    const w = await getCurrent();
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
    let fogNow = ['Fog', 'Mist', 'Haze', 'Smoke'].includes(main) || (w.visibility && w.visibility < 2000);
    try { const om = await getCurrentOM(); if (om.weather[0].main === 'Fog') fogNow = true; } catch (e) {}
    const iceNow = isIcy(main, id, temp);

    if (wind > WIND_LIMIT && !flags.wind) {
      const cross = await getCrossWind();
      const confirm = cross === null ? '' :
        (cross > WIND_LIMIT ? '\n✅ Подтверждено вторым источником (' + cross + ' м/с)'
                            : '\n⚠️ Второй источник: ' + cross + ' м/с — расхождение');
      await broadcast('💨 ВНИМАНИЕ! ' + PLACE + '\nВетер усилился: ' + wind + ' м/с, ' + dirShort +
                      ' (' + dirFull + ')\nПорог: ' + WIND_LIMIT + ' м/с' + confirm);
      flags.wind = true;
    } else if (wind <= WIND_LIMIT) flags.wind = false;

    if (gust > GUST_LIMIT && !flags.gust) {
      await broadcast('🌪 ОПАСНО! ' + PLACE + '\nПорывы ветра до ' + gust + ' м/с, ' + dirShort + ' (' + dirFull + ')!');
      flags.gust = true;
    } else if (gust <= GUST_LIMIT) flags.gust = false;

    if (stormNow && !flags.stormNow) {
      await broadcast('⛈ ' + PLACE + ': гроза! Ветер ' + wind + ' м/с, ' + dirShort + '.');
      flags.stormNow = true;
    } else if (!stormNow) flags.stormNow = false;

    if (rainNow && !flags.rainNow) {
      await broadcast('🌧 ' + PLACE + ': начался дождь' + rainWord(rainMm) + '\nТемпература ' + Math.round(temp) + '°C.');
      flags.rainNow = true;
    } else if (!rainNow) flags.rainNow = false;

    if (iceNow && !flags.iceNow) {
      await broadcast('🧊 ОПАСНО! ' + PLACE + ': гололёд!\nОсадки при температуре ' + Math.round(temp) + '°C — дороги и провода обледеневают.');
      flags.iceNow = true;
    } else if (!iceNow) flags.iceNow = false;

    if (fogNow && !flags.fogNow) {
      await broadcast('🌫 ' + PLACE + ': туман, видимость менее 2 км.');
      flags.fogNow = true;
    } else if (!fogNow) flags.fogNow = false;

    let list = [];
    try { list = ((await getForecastOWM(2)) || {}).list || []; }
    catch (e) { console.error('Прогноз недоступен:', e.message); }

    const stormSoon = list.some(function (i) { return i.weather[0].main === 'Thunderstorm'; });
    const iceSoon   = list.some(function (i) { return isIcy(i.weather[0].main, i.weather[0].id, i.main.temp); });
    const rainSoon  = list.some(function (i) { return ['Rain', 'Drizzle'].includes(i.weather[0].main); });
    const fogSoon   = list.some(function (i) { return ['Fog', 'Mist', 'Haze'].includes(i.weather[0].main); });

    if (stormSoon && !stormNow && !flags.stormSoon) {
      await broadcast('⛈ Гроза приближается к ' + PLACE + ', ~3 часа.'); flags.stormSoon = true;
    } else if (!stormSoon) flags.stormSoon = false;
    if (iceSoon && !iceNow && !flags.iceSoon) {
      await broadcast('🧊 ВНИМАНИЕ! К ' + PLACE + ' приближаются осадки при ~0°C — возможен гололёд в ближайшие ~3 часа.'); flags.iceSoon = true;
    } else if (!iceSoon) flags.iceSoon = false;
    if (rainSoon && !rainNow && !flags.rainSoon) {
      await broadcast('🌧 Дождь приближается к ' + PLACE + ', ~3 часа.'); flags.rainSoon = true;
    } else if (!rainSoon) flags.rainSoon = false;
    if (fogSoon && !fogNow && !flags.fogSoon) {
      await broadcast('🌫 Туман приближается к ' + PLACE + ', ~3 часа.'); flags.fogSoon = true;
    } else if (!fogSoon) flags.fogSoon = false;

    console.log(new Date().toISOString(),
      'OK [' + w._source + ']: ' + Math.round(temp) + '°C, ветер ' + wind + '/' + gust + ' м/с ' + dirShort +
      ', дождь ' + rainNow + ', гроза ' + stormNow + ', гололёд ' + iceNow + ', туман ' + fogNow);
  } catch (e) {
    console.error('Ошибка проверки погоды:', e.message);
  }
}

// ===== УТРЕННЯЯ СВОДКА 6:00 МСК =====
let lastDigestDate = '';
async function digestTick() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() === DIGEST_HOUR_UTC && lastDigestDate !== today) {
    lastDigestDate = today;
    try {
      const text = await buildDayText('🌅 Доброе утро! Прогноз на сегодня — ' + PLACE);
      if (text) {
        await broadcast(text + '\nХорошего дня! /погода — текущая сводка');
        console.log('Утренняя сводка отправлена');
      }
    } catch (e) { console.error('Ошибка сводки:', e.message); }
  }
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
        const text = await buildDayText('⏰ Ваша сводка погоды — ' + PLACE);
        if (text) await bot.api.sendMessageToUser(uid, text);
      } catch (e) { console.error('Ошибка напоминания', uid, e.message); }
    }
  }
}

// ===== МЕНЮ КОМАНД (с диагностикой ответа MAX) =====
async function setCommands() {
  const cmdsRu = [
    { name: 'погода', description: 'Текущая сводка погоды' },
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
    let res = await fetch('https://botapi.max.ru/me?access_token=' + process.env.BOT_TOKEN, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: cmdsRu })
    });
    let body = await res.text();
    console.log('Меню команд (ru): статус', res.status, '| ответ MAX:', body.slice(0, 300));

    if (res.status !== 200) {
      res = await fetch('https://botapi.max.ru/me?access_token=' + process.env.BOT_TOKEN, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands: cmdsLat })
      });
      body = await res.text();
      console.log('Меню команд (lat): статус', res.status, '| ответ MAX:', body.slice(0, 300));
    }
  } catch (e) { console.error('Не удалось установить команды:', e.message); }
}

// ===== КОМАНДЫ =====
bot.on('message_created', async function (ctx) {
  const text = (ctx.message.body.text || '').trim();
  const low = text.toLowerCase();
  const uid = ctx.user && ctx.user.user_id;

  // --- ввод времени после /напоминание ---
  if (pendingReminder.has(uid)) {
    if (low.indexOf('стоп') !== -1 || low.indexOf('отмена') !== -1) {
      pendingReminder.delete(uid);
      ctx.reply('Хорошо, напоминание не задаю.');
      return;
    }
    const m = text.match(/^(\d{1,2})[:.](\d{2})$/);
    if (m && +m[1] < 24 && +m[2] < 60) {
      const t = ('0' + (+m[1])).slice(-2) + ':' + m[2];
      pendingReminder.delete(uid);
      await saveReminder(uid, t);
      ctx.reply('✅ Готово! Теперь каждый день в ' + t + ' (мск) вам будет приходить сводка погоды.\nОтключить: /напоминание стоп');
    } else {
      ctx.reply('Не понял время. Напишите в формате ЧЧ:ММ, например 07:30');
    }
    return;
  }

  // --- /напоминание ---
  if (low === '/напоминание' || low === 'напоминание' || low === '/napominanie') {
    pendingReminder.add(uid);
    ctx.reply('⏰ В какое время присылать вам прогноз погоды каждый день?\nНапишите время в формате ЧЧ:ММ, например 07:30 (московское время).\nОтмена: напишите «стоп»');
    return;
  }
  if (low === '/напоминание стоп') {
    pendingReminder.delete(uid);
    await removeReminder(uid);
    ctx.reply('Напоминание отключено.');
    return;
  }

  // --- /погода ---
  if (low === '/погода' || low === 'погода' || low === '/pogoda') {
    try {
      const w = await getCurrent();
      const dd = windDir(w.wind.deg);
      const dirShort = dd[0], dirFull = dd[1];
      const gust = w.wind.gust ? ' (порывы до ' + w.wind.gust + ' м/с)' : '';
      const vis = (w.visibility != null) ? w.visibility : 10000;
      const fogOwm = ['Fog', 'Mist', 'Haze', 'Smoke'].includes(w.weather[0].main) || vis < 2000;
      let om = null;
      try { om = await getCurrentOM(); } catch (e) {}
      const omFog = om ? (om.weather[0].main === 'Fog') : null;
      const omDir = om ? windDir(om.wind.deg)[0] : 'н/д';
      const fogYes = fogOwm || omFog === true;
      const fogLine = fogYes ? '🌫 Туман: ДА, видимость ~' + vis + ' м'
                             : '🌫 Туман: нет, видимость ~' + (vis >= 10000 ? '10+ км' : vis + ' м');
      let warn = '';
      if (om && Math.abs(w.wind.speed - om.wind.speed) > 2) {
        warn = '\n⚠️ Источники расходятся по ветру:\n   OpenWeatherMap: ' + w.wind.speed + ' м/с, ' + dirShort +
               '\n   Open-Meteo: ' + om.wind.speed + ' м/с, ' + omDir;
      }
      ctx.reply(
        '📍 ' + PLACE + ' | сводка\n━━━━━━━━━━━━━━━\n' +
        '🌡 Температура: ' + Math.round(w.main.temp) + '°C\n' +
        '☁️ Состояние: ' + w.weather[0].description + '\n' +
        '💨 Ветер: ' + w.wind.speed + ' м/с' + gust + ', ' + dirShort + ' (' + dirFull + ')\n' +
        fogLine + '\n━━━━━━━━━━━━━━━\n' +
        '🔁 Контроль (Open-Meteo): ' + (om ? Math.round(om.main.temp) + '°C, ветер ' + om.wind.speed + ' м/с, ' + omDir : 'недоступен') +
        ', туман: ' + (omFog === null ? 'н/д' : (omFog ? 'да' : 'нет')) + warn
      );
    } catch (e) { ctx.reply('Не удалось получить погоду, попробуйте позже.'); }
    return;
  }

  // --- /прогноз ---
  if (low === '/прогноз' || low === 'прогноз' || low === '/prognoz') {
    try {
      const f = await getForecastOWM(4);
      const list = (f && f.list) || [];
      if (!list.length) { ctx.reply('Прогноз недоступен.'); return; }
      const lines = list.map(function (i) {
        const t = new Date(i.dt * 1000 + 3 * 3600 * 1000);
        const hh = ('0' + t.getUTCHours()).slice(-2);
        return '🕐 ' + hh + ':00 — ' + Math.round(i.main.temp) + '°C, ' + i.weather[0].description +
               ', ветер ' + i.wind.speed + ' м/с ' + windDir(i.wind.deg)[0];
      });
      ctx.reply('📅 ' + PLACE + ', прогноз на 12 часов (мск):\n━━━━━━━━━━━━━━━\n' + lines.join('\n'));
    } catch (e) { ctx.reply('Не удалось получить прогноз.'); }
    return;
  }

  // --- /неделя ---
  if (low === '/неделя' || low === 'неделя' || low === '/nedelya') {
    try {
      const d = await getWeekOM();
      const lines = [];
      for (let k = 0; k < d.time.length; k++) {
        lines.push(
          '📆 ' + dayName(d.time[k]) + '\n' +
          '   ' + wmoText(d.weather_code[k]) + '\n' +
          '   🌡 ' + Math.round(d.temperature_2m_min[k]) + '°...' + Math.round(d.temperature_2m_max[k]) + '°C\n' +
          '   💨 ветер до ' + d.wind_speed_10m_max[k] + ' м/с (порывы ' + d.wind_gusts_10m_max[k] + '), ' + windDir(d.wind_direction_10m_dominant[k])[0] + '\n' +
          '   ☔ осадки: ' + d.precipitation_sum[k] + ' мм'
        );
      }
      ctx.reply('🗓 ' + PLACE + ' — прогноз на неделю (мск):\n━━━━━━━━━━━━━━━\n' + lines.join('\n━━━━━━━━━━━━━━━\n'));
    } catch (e) { ctx.reply('Не удалось получить прогноз на неделю.'); }
    return;
  }

  // --- /отписаться ---
  if (low === '/отписаться' || low === 'отписаться' || low === '/otmena') {
    await delSub(uid);
    await removeReminder(uid);
    ctx.reply('Вы отписаны от оповещений. Чтобы вернуться — просто напишите боту снова.');
    return;
  }

  // --- /админ <пароль> ---
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

  // --- админские команды ---
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
  console.log('Бот запущен, мониторинг погоды активен');
})();
