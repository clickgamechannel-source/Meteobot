process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // фикс SSL на Railway

const { Bot } = require('@maxhub/max-bot-api');
const fetch = require('node-fetch');
const http = require('http');
const fs = require('fs');

// ===== НАСТРОЙКИ =====
const WIND_LIMIT = 4;        // порог ветра, м/с
const CHECK_MINUTES = 10;    // интервал проверки погоды
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
  return dirs[Math.round(deg / 45) % 8];
}

// ===== ПОДПИСЧИКИ =====
const SUBS_FILE = 'subscribers.json';
let subscribers = new Set();
try { subscribers = new Set(JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'))); } catch (e) {}
function saveSubs() { try { fs.writeFileSync(SUBS_FILE, JSON.stringify([...subscribers])); } catch (e) {} }

bot.on('bot_started', (ctx) => {
  subscribers.add(ctx.user.user_id);
  saveSubs();
  ctx.reply('Вы подписаны на оповещения Метеодозора! Команда /погода — текущая погода.');
});

// ===== РАССЫЛКА =====
async function broadcast(text) {
  for (const id of subscribers) {
    try { await bot.api.sendMessageToUser(id, text); }
    catch (e) { console.error('Ошибка отправки', id, e.message); }
  }
}

// ===== ПОГОДА =====
const flags = { wind: false, rainNow: false, fogNow: false, rainSoon: false, fogSoon: false,
                stormNow: false, stormSoon: false, iceNow: false, iceSoon: false };

async function getCurrent() {
  const url = `http://api.openweathermap.org/data/2.5/weather?lat=${LAT}&lon=${LON}&appid=${WEATHER_KEY}&units=metric&lang=ru`;
  return (await fetch(url)).json();
}
async function getForecast() {
  const url = `http://api.openweathermap.org/data/2.5/forecast?lat=${LAT}&lon=${LON}&appid=${WEATHER_KEY}&units=metric&lang=ru&cnt=2`;
  return (await fetch(url)).json();
}

// Гололёд: ледяной дождь (id 511) или дождь/морось при температуре около нуля
function isIcy(main, id, temp) {
  if (id === 511) return true;
  return ['Rain', 'Drizzle'].includes(main) && temp >= -3 && temp <= 1;
}

async function checkWeather() {
  try {
    const w = await getCurrent();
    if (!w || !w.wind) { console.error('Странный ответ погоды:', JSON.stringify(w)); return; }

    const temp = w.main.temp;
    const wind = w.wind.speed;
    const [dirShort, dirFull] = windDir(w.wind.deg);
    const main = w.weather[0].main;
    const id = w.weather[0].id;
    const rainNow  = ['Rain', 'Drizzle'].includes(main);
    const stormNow = main === 'Thunderstorm';
    const fogNow   = ['Fog', 'Mist', 'Haze'].includes(main) || w.visibility < 1000;
    const iceNow   = isIcy(main, id, temp);

    // --- ВЕТЕР ---
    if (wind > WIND_LIMIT && !flags.wind) {
      await broadcast(`💨 ВНИМАНИЕ! ${PLACE}\nВетер усилился: ${wind} м/с, ${dirShort} (${dirFull})\nПорог: ${WIND_LIMIT} м/с`);
      flags.wind = true;
    } else if (wind <= WIND_LIMIT) flags.wind = false;

    // --- ГРОЗА сейчас ---
    if (stormNow && !flags.stormNow) {
      await broadcast(`⛈ ${PLACE}: гроза! Ветер ${wind} м/с, ${dirShort}.`);
      flags.stormNow = true;
    } else if (!stormNow) flags.stormNow = false;

    // --- ДОЖДЬ сейчас ---
    if (rainNow && !flags.rainNow) {
      await broadcast(`🌧 ${PLACE}: начался дождь. Температура ${Math.round(temp)}°C.`);
      flags.rainNow = true;
    } else if (!rainNow) flags.rainNow = false;

    // --- ГОЛОЛЁД сейчас ---
    if (iceNow && !flags.iceNow) {
      await broadcast(`🧊 ОПАСНО! ${PLACE}: гололёд!\nОсадки при температуре ${Math.round(temp)}°C — дороги и провода обледеневают.`);
      flags.iceNow = true;
    } else if (!iceNow) flags.iceNow = false;

    // --- ТУМАН сейчас ---
    if (fogNow && !flags.fogNow) {
      await broadcast(`🌫 ${PLACE}: туман, видимость ${w.visibility} м.`);
      flags.fogNow = true;
    } else if (!fogNow) flags.fogNow = false;

    // --- ПРОГНОЗ на ~3 часа ---
    const f = await getForecast();
    const list = (f && f.list) || [];
    const soonMain = list.map(i => i.weather[0].main);
    const soonIds  = list.map(i => i.weather[0].id);
    const soonTemp = list.map(i => i.main.temp);

    const rainSoon  = soonMain.some(m => ['Rain', 'Drizzle'].includes(m));
    const stormSoon = soonMain.includes('Thunderstorm');
    const fogSoon   = soonMain.some(m => ['Fog', 'Mist', 'Haze'].includes(m));
    const iceSoon   = list.some(i => isIcy(i.weather[0].main, i.weather[0].id, i.main.temp));

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
      `OK: ${Math.round(temp)}°C, ветер ${wind} м/с ${dirShort}, дождь ${rainNow}, гроза ${stormNow}, гололёд ${iceNow}, туман ${fogNow}`);
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
      if (!w || !w.wind) { ctx.reply('Погодный сервис пока не отвечает, попробуйте позже.'); return; }
      const [dirShort, dirFull] = windDir(w.wind.deg);
      ctx.reply(
        `📍 ${PLACE} сейчас:\n` +
        `🌡 ${Math.round(w.main.temp)}°C, ${w.weather[0].description}\n` +
        `💨 Ветер: ${w.wind.speed} м/с, ${dirShort} (${dirFull})\n` +
        `👁 Видимость: ${w.visibility} м`
      );
    } catch (e) { ctx.reply('Не удалось получить погоду, попробуйте позже.'); }
  }
});

// ===== ВЕБ-СЕРВЕР =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end('Meteodozor OK'); }).listen(PORT);

// ===== ЗАПУСК =====
setInterval(checkWeather, CHECK_MINUTES * 60 * 1000);
checkWeather();
bot.start();
console.log('Бот запущен, мониторинг погоды активен');
