// Lista de avatares disponibles para elegir al unirse/crear sala.
// Servidos vía jsDelivr CDN desde el repositorio open-source alohe/avatars.
const BASE = 'https://cdn.jsdelivr.net/gh/alohe/avatars/png/';

const FILES = [
  'notion_1.png','notion_2.png','notion_3.png','notion_4.png','notion_5.png','notion_6.png',
  'memo_1.png','memo_2.png','memo_3.png','memo_4.png','memo_5.png','memo_6.png',
  'vibrent_1.png','vibrent_2.png','vibrent_3.png','vibrent_4.png','vibrent_5.png','vibrent_6.png',
  'bluey_1.png','bluey_2.png','bluey_3.png','bluey_4.png','bluey_5.png','bluey_6.png',
  'teams_1.png','teams_2.png','teams_3.png','teams_4.png','teams_5.png','teams_6.png',
  'toon_1.png','toon_2.png','toon_3.png','toon_4.png','toon_5.png','toon_6.png',
  'upstream_1.png','upstream_2.png','upstream_3.png','upstream_4.png','upstream_5.png','upstream_6.png',
  '3d_1.png','3d_2.png','3d_3.png','3d_4.png','3d_5.png',
];

const AVATARS = FILES.map((f) => BASE + f);

module.exports = { AVATARS };
