'use strict';
const statusNode = document.getElementById('status');
async function check() {
  const list = document.getElementById('films');
  list.replaceChildren();
  statusNode.textContent = 'Проверяю сервер и получение фильмов…';
  try {
    const configResponse = await fetch('family-config.json', { cache: 'no-store' });
    if (!configResponse.ok) throw new Error('Не опубликован family-config.json.');
    const config = await configResponse.json();
    const healthResponse = await fetch(config.api_url + '/health');
    const health = await healthResponse.json();
    if (!healthResponse.ok || !health.ok) throw new Error(health.message || 'Нет связи с базой данных.');
    const response = await fetch(config.api_url + '/api/catalog?category=movies');
    const catalog = await response.json();
    if (!response.ok) throw new Error(catalog.message || 'Не удалось получить каталог.');
    statusNode.textContent = 'Сервер и база работают. Получено фильмов: ' + catalog.items.length + '.\n' + (catalog.warning || 'Кэш: ' + catalog.cache) + '\n' + config.api_url;
    catalog.items.slice(0, 5).forEach(item => {
      const li = document.createElement('li');
      li.textContent = item.title + (item.year ? ' · ' + item.year : '');
      list.append(li);
    });
  } catch (error) { statusNode.textContent = 'Не удалось завершить проверку: ' + error.message; }
}
document.getElementById('check').addEventListener('click', check);
document.getElementById('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(document.getElementById('plugin').textContent); document.getElementById('copy').textContent = 'Адрес скопирован'; }
  catch { document.getElementById('copy').textContent = 'Выделите и скопируйте адрес выше'; }
});
check();
