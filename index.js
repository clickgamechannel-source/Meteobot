process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { Bot } = require('@maxhub/max-bot-api');
const fetch = require('node-fetch');
const http = require('http');
const fs = require('fs');

// ===== НАСТРОЙКИ =====
const WIND_LIMIT = 4;          // порог среднего ветра, м/с
const GUST_LIMIT = 8;          // порог порывов ветра, м/с
const CHECK_MINUTES = 10;      // интервал проверки
const DIGEST_HOUR_UTC = 3;     // 6:00 по Москве = 3:00 UTC
const ADMIN_PASS = 'метео2026';// <<< СМЕНИТЕ ПАРОЛЬ АДМИНА НА СВОЙ!
const LAT = 48.8105;           // Рай-Александровка, Николаевская община
const LON = 37.8513;
const PLACE = 'Рай-Александровка';

const bot = new Bot(process.env.BOT_TOKEN);
const WEATHER_KEY = process.env.WEATHER_KEY;

process.on('uncaughtException', (e) => console.error('uncaughtException:', e.message));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message));

function windDir(deg) {
  const dirs = [['С','северный'],['СВ','северо-восточный'],['В','восточный'],['ЮВ','юго-восточный'],
                ['Ю','южный'],['ЮЗ','юго-западный'],['З','западный'],['СЗ','северо-западный']];
  return dirs[Math.round((deg || 0) / 45) % 8];
}

function rainWord(mm) {
  if (mm == null) return '';
  if (mm < 0.5) return ` (слабый, ${mm} мм/ч)`;
  if (mm < 4)   return ` (умеренный, ${mm} мм/ч)`;
  return ` (ЛИВЕНЬ, ${mm} мм/ч!)`;
}

// ===== ХРАНИЛИЩЕ: Upstash Redis, иначе файл =====
let redis = null;
if (process.env.REDIS_URL && process.env.REDIS_TOKEN) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({ url: process.env.REDIS_URL, token: process.env.REDIS_TOKEN });
  console.log('Хранилище: Upstash Redis');
} else {
  console.log('Хранилище: локальный файл');
}

const SUBS_FILE = 'subscribers.json';
let subscribers = new Set();
let adminId = null;

async function loadData() {
  try {
    if (redis) {
      subscribers = new Set((await redis.smembers('subscribers')) || []);
      adminId = await redis.get('admin');
    } else {
      subscribers = new Set(JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')));
    }
    console.log('Подписчиков:', subscribers.size, '| админ:', adminId || 'не назначен');
  } catch (e) {}
}
async function addSub(id) {
  subscribers.add(id);
  try {
    if (redis) await redis.sadd('subscribers', id);
    else fs.writeFileSync(SUBS_FILE, JSON.stringify([...subscribers]));
  } catch (e) {}
}
async function delSub(id) {
  subscribers.delete(id);
  try {
    if (redis) await redis.srem('subscribers', id);
    else fs.writeFileSync(SUBS_FILE, JSON.stringify([...subscribers]));
  } catch (e) {}
}
async function setAdmin(id) {
  adminId = id;
  try { if (redis) await redis.set('admin', id); } catch (e) {}
}

bot.on('bot_started', async (ctx) => {
  await addSub(ctx.user.user_id);
  ctx.reply('Вы подписаны на оповещения Метеодозора!\nКоманды: /погода, /прогноз, /отписаться');
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
  const url = `http://api.openweathermap.org/data/2.5/weather?lat=${LAT}&lon=${LON}&appid=${WEATHER_KEY}&units=metric&lang=ru`;
  const w = await (await fetch(url)).json();
  if (!w || !w.wind) throw new Error('OWM: плохой ответ');
  return w;
}
async function getForecastOWM(cnt = 2) {
  const url = `http://api.openweathermap.org/data/2.5/forecast?lat=${LAT}&lon=${LON}&appid=${WEATHER_KEY}&units=metric&lang=ru&cnt=${cnt}`;
  return (await fetch(url)).json();
}
async function getCurrentOM() {
  const url = `http://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
              `&current=temperature_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m&wind_speed_unit=ms`;
  const j = await (await fetch(url)).json();
  if (!j || !j.current) throw new Error('Open-Meteo: плохой ответ');
  const code = j.current.weather_code;
  const main = (code >= 95) ? 'Thunderstorm' : (code >= 51 && code <= 67) ? 'Rain' :
               (code >= 71 && code <= 86) ? 'Snow' : (code === 45 || code === 48) ? 'Fog' : 'Clear';
  return {
    main: { temp: j.current.temperature_2m },
    wind: { speed: j.current.wind_speed_10m, deg: j.current.wind_direction_10m },
    weather: [{ main, id: code, description: 'по данным Open-Meteo' }],
    visibility: 10000
  };
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
    const [dirShort, dirFull] = windDir(w.wind.deg);
    const main = w.weather[0].main;
    const id = w.weather[0].id;
    const rainMm = w.rain && w.rain['1h'];
    const rainNow  = ['Rain', 'Drizzle'].includes(main);
    const stormNow = main === 'Thunderstorm';
    let fogNow = ['Fog', 'Mist', 'Haze', 'Smoke'].includes(main) || (w.visibility && w.visibility < 2000);
    try { const om = await getCurrentOM(); if (om.weather[0].main === 'Fog') fogNow = true; } catch (e) {}
    const iceNow = isIcy(main, id, temp);

    // ВЕТЕР
    if (wind > WIND_LIMIT && !flags.wind) {
      const cross = await getCrossWind();
      const confirm = cross === null ? '' :
        (cross > WIND_LIMIT ? `\n✅ Подтверждено вторым источником (${cross} м/с)`
                            : `\n⚠️ Второй источник: ${cross} м/с — расхождение`);
      await broadcast(`💨 ВНИМАНИЕ! ${PLACE}\nВетер усилился: ${wind} м/с, ${dirShort} (${dirFull})\nПорог: ${WIND_LIMIT} м/с${confirm}`);
      flags.wind = true;
    } else if (wind <= WIND_LIMIT) flags.wind = false;

    // ПОРЫВЫ
    if (gust > GUST_LIMIT && !flags.gust) {
      await broadcast(`🌪 ОПАСНО! ${PLACE}\nПорывы ветра до ${gust} м/с, ${dirShort} (${dirFull})!`);
      flags.gust = true;
    } else if (gust <= GUST_LIMIT) flags.gust = false;

    // ГРОЗА
    if (stormNow && !flags.stormNow) {
      await broadcast(`⛈ ${PLACE}: гроза! Ветер ${wind} м/с, ${dirShort}.`);
      flags.stormNow = true;
    } else if (!stormNow) flags.stormNow = false;

    // ДОЖДЬ (с интенсивностью)
    if (rainNow && !flags.rainNow) {
      await broadcast(`🌧 ${PLACE}: начался дождь${rainWord(rainMm)}\nТемпература ${Math.round(temp)}°C.`);
      flags.rainNow = true;
    } else if (!rainNow) flags.rainNow = false;

    // ГОЛОЛЁД
    if (iceNow && !flags.iceNow) {
      await broadcast(`🧊 ОПАСНО! ${PLACE}: гололёд!\nОсадки при температуре ${Math.round(temp)}°C — дороги и провода обледеневают.`);
      flags.iceNow = true;
    } else if (!iceNow) flags.iceNow = false;

    // ТУМАН
    if (fogNow && !flags.fogNow) {
      await broadcast(`🌫 ${PLACE}: туман, видимость менее 2 км.`);
      flags.fogNow = true;
    } else if (!fogNow) flags.fogNow = false;

    // ПРОГНОЗ на ~3 часа
    let list = [];
    try { list = ((await getForecastOWM(2)) || {}).list || []; }
    catch (e) { console.error('Прогноз недоступен:', e.message); }

    const stormSoon = list.some(i => i.weather[0].main === 'Thunderstorm');
    const iceSoon   = list.some(i => isIcy(i.weather[0].main, i.weather[0].id, i.main.temp));
    const rainSoon  = list.some(i => ['Rain', 'Drizzle'].includes(i.weather[0].main));
    const fogSoon   = list.some(i => ['Fog', 'Mist', 'Haze'].includes(i.weather[0].main));

    if (stormSoon && !stormNow && !flags.stormSoon) {
      await broadcast(`⛈ Гроза приближается к ${PLACE}, ~3 часа.`); flags.stormSoon = true;
    } else if (!stormSoon) flags.stormSoon = false;
    if (iceSoon && !iceNow && !flags.iceSoon) {
      await broadcast(`🧊 ВНИМАНИЕ! К ${PLACE} приближаются осадки при ~0°C — возможен гололёд в ближайшие ~3 часа.`); flags.iceSoon = true;
    } else if (!iceSoon) flags.iceSoon = false;
    if (rainSoon && !rainNow && !flags.rainSoon) {
      await broadcast(`🌧 Дождь приближается к ${PLACE}, ~3 часа.`); flags.rainSoon = true;
    } else if (!rainSoon) flags.rainSoon = false;
    if (fogSoon && !fogNow && !flags.fogSoon) {
      await broadcast(`🌫 Туман приближается к ${PLACE}, ~3 часа.`); flags.fogSoon = true;
    } else if (!fogSoon) flags.fogSoon = false;

    console.log(new Date().toISOString(),
      `OK [${w._source}]: ${Math.round(temp)}°C, ветер ${wind}/${gust} м/с ${dirShort}, дождь ${rainNow}, гроза ${stormNow}, гололёд ${iceNow}, туман ${fogNow}`);
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
      const f = await getForecastOWM(4); // ближайшие 12 часов
      const list = (f && f.list) || [];
      if (!list.length) return;
      const temps = list.map(i => i.main.temp);
      const maxWind = Math.max(...list.map(i => i.wind.speed));
      const maxGust = Math.max(...list.map(i => i.wind.gust || 0));
      const windy = list.reduce((a, b) => (a.wind.speed >= b.wind.speed ? a : b));
      const [dShort, dFull] = windDir(windy.wind.deg);
      const conds = new Set(list.map(i => i.weather[0].main));
      let precip = 'без осадков';
      if (conds.has('Thunderstorm')) precip = '⛈ возможна гроза';
      else if (conds.has('Rain') || conds.has('Drizzle')) precip = '🌧 ожидается дождь';
      else if (conds.has('Snow')) precip = '🌨 ожидается снег';
      if ([...conds].some(c => ['Fog', 'Mist', 'Haze'].includes(c))) precip += ', 🌫 туман';

      await broadcast(
        `🌅 Доброе утро! Прогноз на сегодня — ${PLACE}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🌡 Температура: от ${Math.round(Math.min(...temps))}° до ${Math.round(Math.max(...temps))}°C\n` +
        `💨 Ветер: до ${maxWind} м/с (порывы до ${maxGust} м/с), ${dShort} (${dFull})\n` +
        `☔ Осадки: ${precip}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `Хорошего дня! /погода — текущая сводка`
      );
      console.log('Утренняя сводка отправлена');
    } catch (e) { console.error('Ошибка сводки:', e.message); }
  }
}

// ===== КОМАНДЫ =====
bot.on('message_created', async (ctx) => {
  const text = (ctx.message.body.text || '').trim();
  const low = text.toLowerCase();
  const uid = ctx.user && ctx.user.user_id;

  // --- /погода ---
  if (low === '/погода' || low === 'погода') {
    try {
      const w = await getCurrent();
      const [dirShort, dirFull] = windDir(w.wind.deg);
      const gust = w.wind.gust ? ` (порывы до ${w.wind.gust} м/с)` : '';
      const vis = (w.visibility != null) ? w.visibility : 10000;
      const fogOwm = ['Fog', 'Mist', 'Haze', 'Smoke'].includes(w.weather[0].main) || vis < 2000;
      let om = null;
      try { om = await getCurrentOM(); } catch (e) {}
      const omFog = om ? (om.weather[0].main === 'Fog') : null;
      const omDir = om ? windDir(om.wind.deg)[0] : 'н/д';
      const fogYes = fogOwm || omFog === true;
      const fogLine = fogYes ? `🌫 Туман: ДА, видимость ~${vis} м`
                             : `🌫 Туман: нет, видимость ~${vis >= 10000 ? '10+ км' : vis + ' м'}`;
      let warn = '';
      if (om && Math.abs(w.wind.speed - om.wind.speed) > 2) {
        warn = `\n⚠️ Источники расходятся по ветру:\n   OpenWeatherMap: ${w.wind.speed} м/с, ${dirShort}\n   Open-Meteo: ${om.wind.speed} м/с, ${omDir}`;
      }
      ctx.reply(
        `📍 ${PLACE} | сводка\n━━━━━━━━━━━━━━━\n` +
        `🌡 Температура: ${Math.round(w.main.temp)}°C\n` +
        `☁️ Состояние: ${w.weather[0].description}\n` +
        `💨 Ветер: ${w.wind.speed} м/с${gust}, ${dirShort} (${dirFull})\n` +
        fogLine + `\n━━━━━━━━━━━━━━━\n` +
        `🔁 Контроль (Open-Meteo): ${om ? Math.round(om.main.temp) + '°C, ветер ' + om.wind.speed + ' м/с, ' + omDir : 'недоступен'}, туман: ${omFog === null ? 'н/д' : (omFog ? 'да' : 'нет')}` + warn
      );
    } catch (e) { ctx.reply('Не удалось получить погоду, попробуйте позже.'); }
    return;
  }

  // --- /прогноз ---
  if (low === '/прогноз' || low === 'прогноз') {
    try {
      const f = await getForecastOWM(4);
      const list = (f && f.list) || [];
      if (!list.length) { ctx.reply('Прогноз недоступен.'); return; }
      const lines = list.map(i => {
        const t = new Date(i.dt * 1000 + 3 * 3600 * 1000); // МСК
        const hh = String(t.getUTCHours()).padStart(2, '0');
        const [ds] = windDir(i.wind.deg);
        return `🕐 ${hh}:00 — ${Math.round(i.main.temp)}°C, ${i.weather[0].description}, ветер ${i.wind.speed} м/с ${ds}`;
      });
      ctx.reply(`📅 ${PLACE}, прогноз на 12 часов (мск):\n━━━━━━━━━━━━━━━\n` + lines.join('\n'));
    } catch (e) { ctx.reply('Не удалось получить прогноз.'); }
    return;
  }

  // --- /отписаться ---
  if (low === '/отписаться' || low === 'отписаться') {
    await delSub(uid);
    ctx.reply('Вы отписаны от оповещений. Чтобы вернуться — просто напишите боту снова.');
    return;
  }

  // --- /админ <пароль> ---
  if (low.startsWith('/админ')) {
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
    if (uid === adminId) ctx.reply(`👥 Подписчиков в рассылке: ${subscribers.size}`);
    return;
  }
  if (low.startsWith('/сказать')) {
    if (uid !== adminId) return;
    const msg = text.slice('/сказать'.length).trim();
    if (!msg) { ctx.reply('Формат: /сказать <текст>'); return; }
    await broadcast(`📢 ${msg}`);
    ctx.reply(`Отправлено ${subscribers.size} подписчикам.`);
    return;
  }
});

// ===== ВЕБ-СЕРВЕР =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end('Meteodozor OK'); }).listen(PORT);

// ===== ЗАПУСК =====
(async () => {
  await loadData();
  setInterval(checkWeather, CHECK_MINUTES * 60 * 1000);
  setInterval(digestTick, 60 * 1000); // проверка времени сводки раз в минуту
  checkWeather();
  bot.start();
  console.log('Бот запущен, мониторинг погоды активен');
})();
