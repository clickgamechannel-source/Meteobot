const { Bot } = require('@maxhub/max-bot-api');
const fetch = require('node-fetch');
const http = require('http');
const fs = require('fs');

// ===== НАСТРОЙКИ =====
const WIND_LIMIT = 4;        // порог ветра, м/с
const CHECK_MINUTES = 10;    // интервал проверки погоды
const LAT = 48.571;          // Рай-Александровка
const LON = 37.982;
const PLACE = 'Рай-Александровка';

const bot = new Bot(process.env.BOT_TOKEN);
const WEATHER_KEY = process.env.WEATHER_KEY;

// ===== ПОДПИСЧИКИ (хранятся в файле) =====
const SUBS_FILE = 'subscribers.json';
let subscribers = new Set();
try {
  subscribers = new Set(JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')));
} catch (e) { /* файла пока нет — начнём с пустого списка */ }

function saveSubs() {
  fs.writeFileSync(SUBS_FILE, JSON.stringify([...subscribers]));
}

bot.on('bot_started', (ctx) => {
  subscribers.add(ctx.user.user_id);
  saveSubs();
  ctx.reply('Вы подписаны на оповещения Метеодозора! Команда /погода — текущая погода.');
});

// ===== РАССЫЛКА =====
async function broadcast(text) {
  for (const id of subscribers) {
    try {
      await bot.api.sendMessageToUser(id, text);
    } catch (e) {
      console.error('Ошибка отправки', id, e.message);
    }
  }
}

// ===== ПОГОДА =====
const flags = { wind: false, rainNow: false, fogNow: false, rainSoon: false, fogSoon: false };

async function getCurrent() {
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${LAT}&lon=${LON}&appid=${WEATHER_KEY}&units=metric&lang=ru`;
  return (await fetch(url)).json();
}

async function getForecast() {
  const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${LAT}&lon=${LON}&appid=${WEATHER_KEY}&units=metric&lang=ru&cnt=2`;
  return (await fetch(url)).json();
}

async function checkWeather() {
  try {
    const w = await getCurrent();
    const wind = w.wind.speed;
    const rainNow = w.weather[0].main === 'Rain' || w.weather[0].main === 'Drizzle' || w.weather[0].main === 'Thunderstorm';
    const fogNow = ['Fog', 'Mist', 'Haze'].includes(w.weather[0].main) || w.visibility < 1000;

    // Ветер
    if (wind > WIND_LIMIT && !flags.wind) {
      await broadcast(`💨 ВНИМАНИЕ! ${PLACE}\nВетер усилился: ${wind} м/с (порог ${WIND_LIMIT} м/с)`);
      flags.wind = true;
    } else if (wind <= WIND_LIMIT) flags.wind = false;

    // Дождь идёт
    if (rainNow && !flags.rainNow) {
      await broadcast(`🌧 ${PLACE}: начался дождь.`);
      flags.rainNow = true;
    } else if (!rainNow) flags.rainNow = false;

    // Туман есть
    if (fogNow && !flags.fogNow) {
      await broadcast(`🌫 ${PLACE}: туман, видимость ${w.visibility} м.`);
      flags.fogNow = true;
    } else if (!fogNow) flags.fogNow = false;

    // Прогноз на ~3 часа: дождь и туман приближаются
    const f = await getForecast();
    const soon = (f.list || []).map(i => i.weather[0].main);
    const rainSoon = soon.some(m => ['Rain', 'Drizzle', 'Thunderstorm'].includes(m));
    const fogSoon = soon.some(m => ['Fog', 'Mist', 'Haze'].includes(m));

    if (rainSoon && !rainNow && !flags.rainSoon) {
      await broadcast(`🌧 Дождь приближается к ${PLACE}, ожидается в ближайшие ~3 часа.`);
      flags.rainSoon = true;
    } else if (!rainSoon) flags.rainSoon = false;

    if (fogSoon && !fogNow && !flags.fogSoon) {
      await broadcast(`🌫 Туман приближается к ${PLACE}, ожидается в ближайшие ~3 часа.`);
      flags.fogSoon = true;
    } else if (!fogSoon) flags.fogSoon = false;

    console.log(new Date().toISOString(), `ветер ${wind} м/с, дождь: ${rainNow}, туман: ${fogNow}`);
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
      ctx.reply(
        `📍 ${PLACE} сейчас:\n` +
        `🌡 ${Math.round(w.main.temp)}°C, ${w.weather[0].description}\n` +
        `💨 Ветер: ${w.wind.speed} м/с\n` +
        `👁 Видимость: ${w.visibility} м`
      );
    } catch (e) {
      ctx.reply('Не удалось получить погоду, попробуйте позже.');
    }
  }
});

// ===== ВЕБ-СЕРВЕР (нужен для хостинга) =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Meteodozor OK');
}).listen(PORT);

// ===== ЗАПУСК =====
setInterval(checkWeather, CHECK_MINUTES * 60 * 1000);
checkWeather();
bot.start();
console.log('Бот запущен, мониторинг погоды активен');
