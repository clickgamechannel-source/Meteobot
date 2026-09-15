process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // фикс SSL на Railway

const { Bot } = require('@maxhub/max-bot-api');
const fetch = require('node-fetch');
const http = require('http');
const fs = require('fs');

// ===== НАСТРОЙКИ =====
const WIND_LIMIT = 4;
const CHECK_MINUTES = 10;
const LAT = 48.8105;         // Рай-Александровка, Николаевская община, Краматорский р-н
const LON = 37.8513;
const PLACE = 'Рай-Александровка';

const bot = new Bot(process.env.BOT_TOKEN);
const WEATHER_KEY = process.env.WEATHER_KEY;

process.on('uncaughtException', (e) => console.error('uncaughtException:', e.message));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message));

// ===== НАПРАВЛЕНИЕ ВЕТРА =====
function windDir(deg) {
  const dirs = [
    ['С', 'северный'], ['СВ', 'северо-восточный'], ['В', 'восточный'], ['ЮВ', 'юго-восточный'],
    ['Ю', 'южный'], ['ЮЗ', 'юго-западный'], ['З', 'западный'], ['СЗ', 'северо-западный']
  ];
  return dirs[Math.round((deg || 0) / 45) % 8];
}

// ===== ПОДПИСЧИКИ: Upstash Redis, а если не настроен — файл =====
let redis = null;
if (process.env.REDIS_URL && process.env.REDIS_TOKEN) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({ url: process.env.REDIS_URL, token: process.env.REDIS_TOKEN });
  console.log('Хранилище подписчиков: Upstash Redis (постоянное)');
} else {
  console.log('Хранилище подписчиков: локальный файл (сбрасывается при обновлении)');
}

const SUBS_FILE = 'subscribers.json';
let subscribers = new Set();

async function loadSubs() {
  try {
    if (redis) {
      const list = await redis.smembers('subscribers');
      subscribers = new Set(list || []);
    } else {
      subscribers = new Set(JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')));
    }
    console.log('Подписчиков загружено:', subscribers.size);
  } catch (e) { /* первый запуск — список пуст */ }
}

async function addSub(id) {
  subscribers.add(id);
  try {
    if (redis) await redis.sadd('subscribers', id);
    else fs.writeFileSync(SUBS_FILE, JSON.stringify([...subscribers]));
  } catch (e) { console.error('Ошибка сохранения подписчика:', e.message); }
}

bot.on('bot_started', async (ctx) => {
  await addSub(ctx.user.user_id);
  ctx.reply('Вы подписаны на оповещения Метеодозора! Команда /погода — текущая погода.');
});

// ===== РАССЫЛКА =====
async function broadcast(text) {
  for (const id of subscribers) {
    try { await bot.api.sendMessageToUser(id, text); }
    catch (e) { console.error('Ошибка отправки', id, e.message); }
  }
}

// ===== ИСТОЧНИК 1: OpenWeatherMap (основной) =====
async function getCurrentOWM() {
  const url = `http://api.openweathermap.org/data/2.5/weather?lat=${LAT}&lon=${LON}&appid=${WEATHER_KEY}&units=metric&lang=ru`;
  const w = await (await fetch(url)).json();
  if (!w || !w.wind) throw new Error('OWM: плохой ответ ' + JSON.stringify(w).slice(0, 100));
  return w;
}
async function getForecastOWM() {
  const url = `http://api.openweathermap.org/data/2.5/forecast?lat=${LAT}&lon=${LON}&appid=${WEATHER_KEY}&units=metric&lang=ru&cnt=2`;
  return (await fetch(url)).json();
}

// ===== ИСТОЧНИК 2: Open-Meteo (перекрёстная проверка, без ключа) =====
async function getCurrentOM() {
  const url = `http://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
              `&current=temperature_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m&wind_speed_unit=ms`;
  const j = await (await fetch(url)).json();
  if (!j || !j.current) throw new Error('Open-Meteo: плохой ответ');
  const code = j.current.weather_code;
  const main =
    (code >= 95) ? 'Thunderstorm' :
    (code >= 51 && code <= 67) ? 'Rain' :
    (code >= 71 && code <= 86) ? 'Snow' :
    (code === 45 || code === 48) ? 'Fog' : 'Clear';
  return {
    main: { temp: j.current.temperature_2m },
    wind: { speed: j.current.wind_speed_10m, deg: j.current.wind_direction_10m },
    weather: [{ main, id: code, description: 'по данным Open-Meteo' }],
    visibility: 10000
  };
}

async function getCurrent() {
  try {
    const w = await getCurrentOWM();
    w._source = 'OpenWeatherMap';
    return w;
  } catch (e) {
    console.error('Основной источник недоступен, переключаюсь на Open-Meteo:', e.message);
    const w = await getCurrentOM();
    w._source = 'Open-Meteo (резерв)';
    return w;
  }
}

async function getCrossWind() {
  try { return (await getCurrentOM()).wind.speed; }
  catch (e) { return null; }
}

// ===== ЛОГИКА ОПОВЕЩЕНИЙ =====
const flags = { wind: false, rainNow: false, fogNow: false, rainSoon: false, fogSoon: false,
                stormNow: false, stormSoon: false, iceNow: false, iceSoon: false };

function isIcy(main, id, temp) {
  if (id === 511 || id === 66 || id === 67) return true;
  return ['Rain', 'Drizzle'].includes(main) && temp >= -3 && temp <= 1;
}

async function checkWeather() {
  try {
    const w = await getCurrent();
    const temp = w.main.temp;
    const wind = w.wind.speed;
    const [dirShort, dirFull] = windDir(w.wind.deg);
    const main = w.weather[0].main;
    const id = w.weather[0].id;
    const rainNow  = ['Rain', 'Drizzle'].includes(main);
    const stormNow = main === 'Thunderstorm';
    const fogNow   = ['Fog', 'Mist', 'Haze'].includes(main) || w.visibility < 1000;
    const iceNow   = isIcy(main, id, temp);

    if (wind > WIND_LIMIT && !flags.wind) {
      const cross = await getCrossWind();
      const confirm = cross === null ? '' :
        (cross > WIND_LIMIT
          ? `\n✅ Подтверждено вторым источником (${cross} м/с)`
          : `\n⚠️ Второй источник: ${cross} м/с — расхождение, следите за обстановкой`);
      await broadcast(`💨 ВНИМАНИЕ! ${PLACE}\nВетер усилился: ${wind} м/с, ${dirShort} (${dirFull})\nПорог: ${WIND_LIMIT} м/с${confirm}`);
      flags.wind = true;
    } else if (wind <= WIND_LIMIT) flags.wind = false;

    if (stormNow && !flags.stormNow) {
      await broadcast(`⛈ ${PLACE}: гроза! Ветер ${wind} м/с, ${dirShort}.`);
      flags.stormNow = true;
    } else if (!stormNow) flags.stormNow = false;

    if (rainNow && !flags.rainNow) {
      await broadcast(`🌧 ${PLACE}: начался дождь. Температура ${Math.round(temp)}°C.`);
      flags.rainNow = true;
    } else if (!rainNow) flags.rainNow = false;

    if (iceNow && !flags.iceNow) {
      await broadcast(`🧊 ОПАСНО! ${PLACE}: гололёд!\nОсадки при температуре ${Math.round(temp)}°C — дороги и провода обледеневают.`);
      flags.iceNow = true;
    } else if (!iceNow) flags.iceNow = false;

    if (fogNow && !flags.fogNow) {
      await broadcast(`🌫 ${PLACE}: туман, видимость менее 1000 м.`);
      flags.fogNow = true;
    } else if (!fogNow) flags.fogNow = false;

    let list = [];
    try { list = ((await getForecastOWM()) || {}).list || []; }
    catch (e) { console.error('Прогноз OWM недоступен:', e.message); }

    const stormSoon = list.some(i => i.weather[0].main === 'Thunderstorm');
    const iceSoon   = list.some(i => isIcy(i.weather[0].main, i.weather[0].id, i.main.temp));
    const rainSoon  = list.some(i => ['Rain', 'Drizzle'].includes(i.weather[0].main));
    const fogSoon   = list.some(i => ['Fog', 'Mist', 'Haze'].includes(i.weather[0].main));

    if (stormSoon && !stormNow && !flags.stormSoon) {
      await broadcast(`⛈ Гроза приближается к ${PLACE}, ожидается в ближайшие ~3 часа.`);
      flags.stormSoon = true;
    } else if (!stormSoon) flags.stormSoon = false;

    if (iceSoon && !iceNow && !flags.iceSoon) {
      await broadcast(`🧊 ВНИМАНИЕ! К ${PLACE} приближаются осадки при температуре около 0°C — возможен гололёд в ближайшие ~3 часа.`);
      flags.iceSoon = true;
    } else if (!iceSoon) flags.iceSoon = false;

    if (rainSoon && !rainNow && !flags.rainSoon) {
      await broadcast(`🌧 Дождь приближается к ${PLACE}, ожидается в ближайшие ~3 часа.`);
      flags.rainSoon = true;
    } else if (!rainSoon) flags.rainSoon = false;

    if (fogSoon && !fogNow && !flags.fogSoon) {
      await broadcast(`🌫 Туман приближается к ${PLACE}, ожидается в ближайшие ~3 часа.`);
      flags.fogSoon = true;
    } else if (!fogSoon) flags.fogSoon = false;

    console.log(new Date().toISOString(),
      `OK [${w._source}]: ${Math.round(temp)}°C, ветер ${wind} м/с ${dirShort}, дождь ${rainNow}, гроза ${stormNow}, гололёд ${iceNow}, туман ${fogNow}`);
  } catch (e) {
    console.error('Ошибка проверки погоды:', e.message);
  }
}

// ===== КОМАНДА /погода =====
bot.on('message_created', async (ctx) => {
  const text = (ctx.message.body.text || '').trim().toLowerCase();
  if (text === '/погода' || text === 'погода') {
    try {
      const w = await getCurrent();
      const cross = await getCrossWind();
      const [dirShort, dirFull] = windDir(w.wind.deg);
      const crossLine = cross === null ? '' : `\n🔁 Контроль (Open-Meteo): ветер ${cross} м/с`;
      ctx.reply(
        `📍 ${PLACE} сейчас [${w._source}]:\n` +
        `🌡 ${Math.round(w.main.temp)}°C, ${w.weather[0].description}\n` +
        `💨 Ветер: ${w.wind.speed} м/с, ${dirShort} (${dirFull})` + crossLine
      );
    } catch (e) { ctx.reply('Не удалось получить погоду, попробуйте позже.'); }
  }
});

// ===== ВЕБ-СЕРВЕР =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end('Meteodozor OK'); }).listen(PORT);

// ===== ЗАПУСК =====
(async () => {
  await loadSubs();
  setInterval(checkWeather, CHECK_MINUTES * 60 * 1000);
  checkWeather();
  bot.start();
  console.log('Бот запущен, мониторинг погоды активен');
})();
