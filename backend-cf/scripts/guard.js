import { readFileSync } from 'node:fs';
const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
if (!/^name\s*=\s*"family-cinema-api"$/m.test(config) || !/^database_name\s*=\s*"family_cinema_db"$/m.test(config) || (config.match(/\[\[d1_databases\]\]/g) || []).length !== 1 || /^\s*(routes|route|zone_id)\s*=/m.test(config)) {
  throw new Error('Остановлено: настройки выходят за пределы family-cinema-api / family_cinema_db.');
}
console.log('Проверено: только family-cinema-api и family_cinema_db; маршрутов чужих сайтов нет.');
