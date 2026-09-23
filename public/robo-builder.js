// ==================== Builder de automação de Robô — MVP ====================
// Porte reduzido da UX do HAC Studio (lista vertical aninhada) pro HOC. Ver
// plano: C:\Users\novai\.claude\plans\enchanted-gathering-pearl.md

const rbToken = localStorage.getItem('token');
if (!rbToken) location.href = '/';
const RB_HEADERS = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + rbToken };

async function rbApi(method, url, body) {
  const resp = await fetch(url, { method, headers: RB_HEADERS, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await resp.json(); } catch {}
  if (!resp.ok) throw new Error(data?.erro || `Erro ${resp.status}`);
  return data;
}

function rbToast(msg, tipo) {
  if (window.hocToast) { hocToast(msg, tipo === 'error' ? 'erro' : tipo === 'success' ? 'ok' : 'info'); return; }
  console.log(`[${tipo || 'info'}] ${msg}`);
}

// ==================== Ícones (mesmo sistema do HAC Studio — SVG inline,
// stroke="currentColor", sem emoji) ====================

const RB_ICONS = {
  branch: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M6 8.2V16"/><path d="M8.2 6H14a4 4 0 0 1 4 4v3.8"/>',
  repeat: '<path d="M17 2 21 6 17 10"/><path d="M3 12V10a4 4 0 0 1 4-4h14"/><path d="M7 22 3 18 7 14"/><path d="M21 12v2a4 4 0 0 1-4 4H3"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  'clock-repeat': '<path d="M12 4a8 8 0 1 1-6.9 4"/><path d="M5 4v4h4"/><path d="M12 8v5l3 2"/>',
  'shield-alert': '<path d="M12 2 4 5v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V5z"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  layers: '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
  link: '<path d="M9 15 15 9"/><path d="M11 6l1.5-1.5a4 4 0 0 1 5.7 5.7L16.5 12"/><path d="M13 18l-1.5 1.5a4 4 0 0 1-5.7-5.7L7.5 12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="8.5" cy="8.5" r="1"/><circle cx="15.5" cy="8.5" r="1"/><circle cx="8.5" cy="15.5" r="1"/><circle cx="15.5" cy="15.5" r="1"/><circle cx="12" cy="12" r="1"/>',
  message: '<path d="M4 5h16v11H8l-4 4V5z"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
  calculator: '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="11" x2="8.01" y2="11"/><line x1="12" y1="11" x2="12.01" y2="11"/><line x1="16" y1="11" x2="16.01" y2="11"/><line x1="8" y1="15" x2="8.01" y2="15"/><line x1="12" y1="15" x2="12.01" y2="15"/><line x1="16" y1="15" x2="16.01" y2="15"/><line x1="8" y1="19" x2="16" y2="19"/>',
  pencil: '<path d="M4 20l1-4 11-11 3 3-11 11-4 1z"/><line x1="14" y1="6" x2="18" y2="10"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6z"/>',
  trash: '<line x1="4" y1="7" x2="20" y2="7"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.5 12.5 20 3"/><path d="M17 6l2 2"/><path d="M14 9l2 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><line x1="21" y1="21" x2="15.5" y2="15.5"/>',
  font: '<path d="M6 18 10 6h1l4 12"/><line x1="7.2" y1="14" x2="13.8" y2="14"/><path d="M16 18l2.5-6h.5L21 18"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><line x1="10" y1="12" x2="14" y2="12"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9" y1="4" x2="9" y2="20"/>',
  'file-text': '<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/><line x1="9" y1="13" x2="16" y2="13"/><line x1="9" y1="17" x2="16" y2="17"/>',
  filter: '<path d="M4 4h16l-6 8v6l-4 2v-8z"/>',
  broom: '<path d="M19 4 9 14"/><path d="M9 14l-5 5 2 2 5-5"/><path d="M13 10l4-6 3 3-6 4z"/>',
  sort: '<path d="M8 3v14"/><path d="M4 13l4 4 4-4"/><path d="M16 21V7"/><path d="M20 11l-4-4-4 4"/>',
  clipboard: '<rect x="6" y="4" width="12" height="17" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="15" y2="15"/>',
  scissors: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><line x1="7.5" y1="7.5" x2="20" y2="20"/><line x1="7.5" y1="16.5" x2="20" y2="4"/>',
  edit: '<path d="M4 21h16"/><path d="M6 17l1-4 9-9 3 3-9 9-4 1z"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  network: '<circle cx="12" cy="5" r="2.2"/><circle cx="5" cy="19" r="2.2"/><circle cx="19" cy="19" r="2.2"/><path d="M12 7.2V12"/><path d="M12 12 6.5 17"/><path d="M12 12 17.5 17"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  sparkles: '<path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  'id-card': '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="12" r="2"/><line x1="13" y1="10" x2="18" y2="10"/><line x1="13" y1="14" x2="18" y2="14"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 6l9 7 9-7"/>',
  phone: '<path d="M6 3h4l1.5 5-2.5 1.5a12 12 0 0 0 5.5 5.5L16 12.5l5 1.5v4a2 2 0 0 1-2 2C10.5 20.5 3.5 13.5 4 5a2 2 0 0 1 2-2z"/>',
  'map-pin': '<path d="M12 22s7-7.2 7-12a7 7 0 0 0-14 0c0 4.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.4"/>',
  dollar: '<circle cx="12" cy="12" r="9"/><path d="M12 6v12"/><path d="M15.5 9c0-1.5-1.5-2.5-3.5-2.5S8.5 7.5 8.5 9s1.5 2 3.5 2.5 3.5 1 3.5 2.5-1.5 2.5-3.5 2.5-3.5-1-3.5-2.5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  hash: '<line x1="9" y1="3" x2="7" y2="21"/><line x1="17" y1="3" x2="15" y2="21"/><line x1="4" y1="9" x2="20" y2="9"/><line x1="3" y1="15" x2="19" y2="15"/>',
  check: '<path d="M4 12l6 6L20 6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a15 15 0 0 1 0 18"/><path d="M12 3a15 15 0 0 0 0 18"/>',
  building: '<rect x="4" y="3" width="10" height="18"/><rect x="14" y="9" width="6" height="12"/><line x1="7" y1="7" x2="7" y2="7.01"/><line x1="11" y1="7" x2="11" y2="7.01"/><line x1="7" y1="11" x2="7" y2="11.01"/><line x1="11" y1="11" x2="11" y2="11.01"/><line x1="7" y1="15" x2="7" y2="15.01"/><line x1="11" y1="15" x2="11" y2="15.01"/>',
  'arrow-down': '<line x1="12" y1="4" x2="12" y2="17"/><path d="M6 12l6 6 6-6"/>',
  'arrow-up': '<line x1="12" y1="20" x2="12" y2="7"/><path d="M6 12l6-6 6 6"/>',
  'arrow-right': '<line x1="4" y1="12" x2="19" y2="12"/><path d="M13 6l6 6-6 6"/>',
  rss: '<circle cx="6" cy="18" r="1.6"/><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 5a15 15 0 0 1 15 15"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.5" y1="4.5" x2="6.5" y2="6.5"/><line x1="17.5" y1="17.5" x2="19.5" y2="19.5"/><line x1="4.5" y1="19.5" x2="6.5" y2="17.5"/><line x1="17.5" y1="6.5" x2="19.5" y2="4.5"/>',
  inbox: '<path d="M3 12h5l2 3h4l2-3h5"/><path d="M5 4h14l2 8v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6z"/>',
  bell: '<path d="M6 10a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  'alert-triangle': '<path d="M12 3 22 20H2z"/><line x1="12" y1="9" x2="12" y2="14"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  'credit-card': '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/>',
  'currency-exchange': '<path d="M4 7h13"/><path d="M13 3l4 4-4 4"/><path d="M20 17H7"/><path d="M11 21l-4-4 4-4"/>',
  bitcoin: '<circle cx="12" cy="12" r="9"/><path d="M10 7v10"/><path d="M14 7v10"/><path d="M8 8h6a2.5 2.5 0 0 1 0 5H8"/><path d="M8 13h7a2.5 2.5 0 0 1 0 5H8"/>',
  qrcode: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><line x1="14" y1="14" x2="14" y2="14.01"/><line x1="18" y1="14" x2="18" y2="14.01"/><line x1="14" y1="18" x2="14" y2="18.01"/><line x1="18" y1="18" x2="21" y2="18"/><line x1="21" y1="21" x2="21" y2="21.01"/>',
  terminal: '<polyline points="4 6 10 12 4 18"/><line x1="12" y1="18" x2="20" y2="18"/>',
  code: '<polyline points="9 6 3 12 9 18"/><polyline points="15 6 21 12 15 18"/>',
  braces: '<path d="M8 3c-2 0-3 1-3 3v4c0 1-1 2-2 2 1 0 2 1 2 2v4c0 2 1 3 3 3"/><path d="M16 3c2 0 3 1 3 3v4c0 1 1 2 2 2-1 0-2 1-2 2v4c0 2-1 3-3 3"/>',
  'bar-chart': '<line x1="6" y1="20" x2="6" y2="12"/><line x1="12" y1="20" x2="12" y2="6"/><line x1="18" y1="20" x2="18" y2="15"/>',
  plug: '<path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9c.2.6.7 1 1.6 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1z"/>',
  ban: '<circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  shield: '<path d="M12 2 4 5v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V5z"/>',
  versus: '<path d="M4 12h6"/><path d="M8 8l-4 4 4 4"/><path d="M20 12h-6"/><path d="M16 8l4 4-4 4"/>',
  'doc-word': '<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/><path d="M8 13l1.3 6L11 14l1.7 5L14 13"/>',
  'doc-slides': '<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/><rect x="8.5" y="12" width="7" height="5" rx="1"/>',
  resize: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  droplet: '<path d="M12 3c4 5 7 8.5 7 12a7 7 0 0 1-14 0c0-3.5 3-7 7-12z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5.5-5.5L9 17"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13.5" r="3.2"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2a4.5 4.5 0 0 0 4.5-4.5C21 6.4 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="9.5" cy="7.5" r="1"/><circle cx="14.5" cy="7" r="1"/><circle cx="17" cy="10.5" r="1"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="8" y1="4" x2="8" y2="9"/><line x1="15" y1="4" x2="15" y2="9"/><line x1="8" y1="15" x2="8" y2="20"/><line x1="15" y1="15" x2="15" y2="20"/>',
  music: '<circle cx="6" cy="18" r="2.5"/><circle cx="17" cy="16" r="2.5"/><path d="M8.5 18V5.5L19.5 3v12.5"/>',
  speaker: '<polygon points="4 9 8 9 12 5 12 19 8 15 4 15"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M18.5 6.5a9 9 0 0 1 0 11"/>',
  'mouse-pointer': '<path d="M4 3l7 17 2-7 7-2z"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6" y2="10.01"/><line x1="10" y1="10" x2="10" y2="10.01"/><line x1="14" y1="10" x2="14" y2="10.01"/><line x1="18" y1="10" x2="18" y2="10.01"/><line x1="7" y1="14" x2="17" y2="14"/>',
  'heart-pulse': '<path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-1 1.8-2.6 3.5-4.5 5.2"/><polyline points="5 12 8 12 9.5 9 11.5 15 13 12 16 12"/>',
  brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5h1a3 3 0 0 0 2-1"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5h-1a3 3 0 0 1-2-1"/><line x1="9" y1="4" x2="9" y2="20"/><line x1="15" y1="4" x2="15" y2="20"/>',
  package: '<path d="M21 8 12 3 3 8v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/><path d="M7 5.5 16 10.5"/>',
  shuffle: '<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>',
};

function _rbIcon(key, size, color) {
  size = size || 16;
  const inner = RB_ICONS[key] || RB_ICONS.gear;
  const stroke = color || 'currentColor';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;flex-shrink:0">${inner}</svg>`;
}

// ==================== Estado ====================

let rbSteps = [];
let rbAutomacaoId = null;
let rbRoboId = null;
let rbEmpresaSteps = false; // marca se algo mudou desde o último save
let rbSelectedId = null;
let rbDraggedId = null;
let rbBusca = '';
let rbPollTimer = null;
let rbCredenciais = []; // cofre da empresa (só nome + chaves dos campos são usados aqui)
let rbConfigIA = {};    // padrão da empresa (Configurações → IA)

const RB_ACOES = [
  { tipo: 'comment', label: 'Comentário', icone: 'message', cor: '#a0aec0', cat: 'Anotação' },
  { tipo: 'set_variable', label: 'Definir variável', icone: 'braces', cor: '#3b5bdb', cat: 'Variáveis' },
  { tipo: 'condition', label: 'Condição (Se/Senão)', icone: 'branch', cor: '#dd6b20', cat: 'Controle de fluxo', container: true },
  { tipo: 'loop_count', label: 'Repetir N vezes', icone: 'repeat', cor: '#dd6b20', cat: 'Controle de fluxo', container: true },
  { tipo: 'foreach', label: 'Para cada item', icone: 'list', cor: '#dd6b20', cat: 'Controle de fluxo', container: true },
  { tipo: 'try_catch', label: 'Tentar / Capturar', icone: 'shield-alert', cor: '#dd6b20', cat: 'Controle de fluxo', container: true },
  { tipo: 'wait', label: 'Aguardar', icone: 'clock', cor: '#718096', cat: 'Controle de fluxo' },
  { tipo: 'http_request', label: 'Requisição HTTP', icone: 'network', cor: '#2b6cb0', cat: 'HTTP' },
  { tipo: 'http_request_retry', label: 'HTTP com retry', icone: 'clock-repeat', cor: '#2b6cb0', cat: 'HTTP' },
  { tipo: 'send_email', label: 'Enviar e-mail', icone: 'mail', cor: '#2b6cb0', cat: 'Comunicação' },
  { tipo: 'call_ai_agent', label: 'Chamar IA', icone: 'sparkles', cor: '#6b46c1', cat: 'Inteligência Artificial' },
  { tipo: 'ai_open', label: 'Abrir sessão de IA', icone: 'key', cor: '#6b46c1', cat: 'Inteligência Artificial' },
  { tipo: 'ai_chat', label: 'Enviar mensagem (sessão)', icone: 'message', cor: '#6b46c1', cat: 'Inteligência Artificial' },
  { tipo: 'ai_close', label: 'Fechar sessão de IA', icone: 'x', cor: '#6b46c1', cat: 'Inteligência Artificial' },
  { tipo: 'read_file', label: 'Ler arquivo', icone: 'file-text', cor: '#276749', cat: 'Arquivos (na máquina)' },
  { tipo: 'write_file', label: 'Escrever arquivo', icone: 'edit', cor: '#276749', cat: 'Arquivos (na máquina)' },
  { tipo: 'run_command', label: 'Rodar comando', icone: 'terminal', cor: '#1a202c', cat: 'Sistema (na máquina)' },
  { tipo: 'browser_flow', label: 'Fluxo de navegador', icone: 'globe', cor: '#c53030', cat: 'Browser (na máquina)' },

  // ---- Sessão de browser persistente entre steps ----
  { tipo: 'browser_open', label: 'Abrir sessão de navegador', icone: 'globe', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name', 'target', 'headless', 'browser_profile'], agente: true },
  { tipo: 'browser_click', label: 'Clicar (sessão)', icone: 'mouse-pointer', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name', 'target'], agente: true },
  { tipo: 'browser_type', label: 'Digitar (sessão)', icone: 'keyboard', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name', 'target', 'value'], agente: true },
  { tipo: 'browser_extract', label: 'Extrair texto (sessão)', icone: 'clipboard', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name', 'target'], agente: true },
  { tipo: 'browser_wait', label: 'Aguardar elemento (sessão)', icone: 'clock', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name', 'target', 'seconds', 'timeout_seconds'], agente: true },
  { tipo: 'browser_screenshot', label: 'Screenshot (sessão)', icone: 'camera', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name', 'target'], agente: true },
  { tipo: 'browser_close', label: 'Fechar sessão de navegador', icone: 'x', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name'], agente: true },
  { tipo: 'browser_captcha_detect', label: 'Captcha foi resolvido?', icone: 'shield-alert', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name'], agente: true },
  { tipo: 'browser_captcha_wait', label: 'Aguardar resolução de captcha', icone: 'clock-repeat', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name', 'timeout_seconds'], agente: true },
  { tipo: 'browser_captcha_solve_image', label: 'Capturar imagem do captcha', icone: 'camera', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name', 'target'], agente: true },

  // ---- Expansão (formulário genérico por metadados de campo, ver RB_FIELD_META) ----
  { tipo: 'calculate', label: 'Calcular expressão', icone: 'calculator', cor: '#3b5bdb', cat: 'Variáveis', fields: ['expression'] },

  { tipo: 'date_diff', label: 'Diferença entre datas', icone: 'calendar', cor: '#718096', cat: 'Data/hora', fields: ['date_from', 'date_to', 'unit'] },
  { tipo: 'date_add', label: 'Somar/subtrair data', icone: 'calendar', cor: '#718096', cat: 'Data/hora', fields: ['date', 'date_amount', 'unit'] },
  { tipo: 'timezone_convert', label: 'Converter fuso horário', icone: 'globe', cor: '#718096', cat: 'Data/hora', fields: ['date', 'to_timezone'] },
  { tipo: 'is_business_day', label: 'É dia útil?', icone: 'calendar', cor: '#718096', cat: 'Data/hora', fields: ['date'] },
  { tipo: 'format_date', label: 'Formatar data', icone: 'calendar', cor: '#718096', cat: 'Data/hora', fields: ['date', 'format'] },

  { tipo: 'list_files', label: 'Listar arquivos', icone: 'list', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['directory', 'pattern'], agente: true },
  { tipo: 'delete_file', label: 'Excluir arquivo', icone: 'trash', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['file_path'], agente: true },
  { tipo: 'copy_file', label: 'Copiar arquivo', icone: 'copy', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['source_path', 'dest_path'], agente: true },
  { tipo: 'move_file', label: 'Mover arquivo', icone: 'arrow-right', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['source_path', 'dest_path'], agente: true },
  { tipo: 'file_hash', label: 'Hash de arquivo', icone: 'hash', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['file_path', 'hash_algo'], agente: true },
  { tipo: 'file_info', label: 'Info do arquivo', icone: 'info', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['file_path'], agente: true },
  { tipo: 'search_in_files', label: 'Buscar em arquivos', icone: 'search', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['directory', 'pattern', 'value'], agente: true },
  { tipo: 'convert_encoding', label: 'Converter encoding', icone: 'font', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['file_path', 'encoding_from', 'encoding_to'], agente: true },
  { tipo: 'delete_folder', label: 'Excluir pasta', icone: 'trash', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['directory'], agente: true },
  { tipo: 'ensure_dir', label: 'Garantir pasta', icone: 'folder', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['directory'], agente: true },
  { tipo: 'backup_folder', label: 'Backup de pasta', icone: 'archive', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['directory'], agente: true },
  { tipo: 'zip_files', label: 'Compactar (zip)', icone: 'package', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['data_input'] },
  { tipo: 'unzip_file', label: 'Descompactar (zip)', icone: 'package', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['file_base64'] },

  { tipo: 'read_excel', label: 'Ler Excel', icone: 'table', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['file_base64', 'sheet_name'] },
  { tipo: 'write_excel', label: 'Escrever Excel', icone: 'table', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'sheet_name'] },
  { tipo: 'read_csv', label: 'Ler CSV', icone: 'table', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['file_base64', 'delimiter'] },
  { tipo: 'write_csv', label: 'Escrever CSV', icone: 'table', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'delimiter'] },
  { tipo: 'write_row', label: 'Adicionar linha', icone: 'check', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'value'] },
  { tipo: 'write_cell', label: 'Escrever célula', icone: 'edit', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'row_index', 'cell_ref', 'value'] },
  { tipo: 'remove_row', label: 'Remover linha', icone: 'trash', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'row_index'] },
  { tipo: 'remove_cell', label: 'Remover célula', icone: 'trash', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'row_index', 'cell_ref'] },
  { tipo: 'filter_data', label: 'Filtrar dados', icone: 'filter', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'cell_ref', 'operator', 'value'] },
  { tipo: 'merge_data', label: 'Combinar dados', icone: 'link', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'data_input2', 'merge_key'] },
  { tipo: 'dedupe_data', label: 'Remover duplicados', icone: 'broom', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'cell_ref'] },
  { tipo: 'sort_group_data', label: 'Ordenar dados', icone: 'sort', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'sort_key'] },
  { tipo: 'sql_on_data', label: 'SQL sobre dados', icone: 'database', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'sql_query'] },
  { tipo: 'generate_fake_data', label: 'Gerar dados fake', icone: 'dice', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['fake_type', 'fake_count'] },

  { tipo: 'pdf_extract_text', label: 'Extrair texto de PDF', icone: 'file-text', cor: '#c53030', cat: 'PDF', fields: ['file_base64'] },
  { tipo: 'pdf_extract_tables', label: 'Extrair tabelas de PDF', icone: 'table', cor: '#c53030', cat: 'PDF', fields: ['file_base64'] },
  { tipo: 'pdf_merge', label: 'Juntar PDFs', icone: 'layers', cor: '#c53030', cat: 'PDF', fields: ['data_input'] },
  { tipo: 'pdf_split', label: 'Separar PDF', icone: 'scissors', cor: '#c53030', cat: 'PDF', fields: ['file_base64'] },
  { tipo: 'pdf_generate', label: 'Gerar PDF', icone: 'file-text', cor: '#c53030', cat: 'PDF', fields: ['content'] },
  { tipo: 'pdf_fill_form', label: 'Preencher formulário PDF', icone: 'edit', cor: '#c53030', cat: 'PDF', fields: ['file_base64', 'data_input'] },

  { tipo: 'validate_json_schema', label: 'Validar JSON Schema', icone: 'check-circle', cor: '#805ad5', cat: 'ETL/formatos', fields: ['data_input', 'schema_input'] },
  { tipo: 'convert_data_format', label: 'Converter formato de dados', icone: 'shuffle', cor: '#805ad5', cat: 'ETL/formatos', fields: ['data_input', 'format_from', 'format_to'] },
  { tipo: 'html_extract', label: 'Extrair de HTML', icone: 'code', cor: '#805ad5', cat: 'ETL/formatos', fields: ['data_input', 'css_selector'] },

  { tipo: 'validate_cpf_cnpj', label: 'Validar CPF/CNPJ', icone: 'id-card', cor: '#2f855a', cat: 'Validação BR', fields: ['value'] },
  { tipo: 'validate_email', label: 'Validar e-mail', icone: 'mail', cor: '#2f855a', cat: 'Validação BR', fields: ['value'] },
  { tipo: 'validate_phone', label: 'Validar telefone', icone: 'phone', cor: '#2f855a', cat: 'Validação BR', fields: ['value'] },
  { tipo: 'lookup_cep', label: 'Consultar CEP', icone: 'map-pin', cor: '#2f855a', cat: 'Validação BR', fields: ['value'] },
  { tipo: 'format_currency', label: 'Formatar moeda', icone: 'dollar', cor: '#2f855a', cat: 'Validação BR', fields: ['value', 'currency'] },

  { tipo: 'encrypt_text', label: 'Criptografar texto', icone: 'lock', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['value', 'secret_key'] },
  { tipo: 'decrypt_text', label: 'Descriptografar texto', icone: 'unlock', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['value', 'secret_key'] },
  { tipo: 'generate_jwt', label: 'Gerar JWT', icone: 'key', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['data_input', 'secret_key', 'expires_in'] },
  { tipo: 'verify_jwt', label: 'Verificar JWT', icone: 'key', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['value', 'secret_key'] },
  { tipo: 'hash_password', label: 'Hash de senha', icone: 'key', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['value'] },
  { tipo: 'verify_password', label: 'Verificar senha', icone: 'key', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['value', 'password_hash'] },
  { tipo: 'generate_otp', label: 'Gerar código OTP', icone: 'shield', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['secret_key'] },
  { tipo: 'verify_otp', label: 'Verificar código OTP', icone: 'shield', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['value', 'secret_key'] },
  { tipo: 'generate_secure_password', label: 'Gerar senha segura', icone: 'key', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['password_length'] },
  { tipo: 'check_ssl_cert', label: 'Checar certificado SSL', icone: 'shield', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['url'] },
  { tipo: 'hmac_sign', label: 'Assinar HMAC', icone: 'key', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['value', 'secret_key'] },

  { tipo: 'send_telegram', label: 'Enviar Telegram', icone: 'zap', cor: '#2b6cb0', cat: 'Comunicação', fields: ['api_key', 'to', 'email_body'] },
  { tipo: 'send_slack', label: 'Enviar Slack', icone: 'message', cor: '#2b6cb0', cat: 'Comunicação', fields: ['url', 'email_body'] },
  { tipo: 'send_discord', label: 'Enviar Discord', icone: 'message', cor: '#2b6cb0', cat: 'Comunicação', fields: ['url', 'email_body'] },
  { tipo: 'send_sms', label: 'Enviar SMS', icone: 'phone', cor: '#2b6cb0', cat: 'Comunicação', fields: ['api_key', 'api_secret', 'from_number', 'to', 'email_body'] },
  { tipo: 'send_whatsapp', label: 'Enviar WhatsApp', icone: 'phone', cor: '#2b6cb0', cat: 'Comunicação', fields: ['api_key', 'api_secret', 'from_number', 'to', 'email_body'] },
  { tipo: 'read_email_imap', label: 'Ler e-mails (IMAP)', icone: 'inbox', cor: '#2b6cb0', cat: 'Comunicação', fields: ['host', 'port', 'api_key', 'secret_key'] },
  { tipo: 'send_push_notification', label: 'Enviar push notification', icone: 'bell', cor: '#2b6cb0', cat: 'Comunicação', fields: ['api_key', 'api_secret', 'to', 'email_body'] },
  { tipo: 'create_incident', label: 'Criar incidente (PagerDuty)', icone: 'alert-triangle', cor: '#2b6cb0', cat: 'Comunicação', fields: ['api_key', 'email_body'] },

  { tipo: 'asaas_create_charge', label: 'Criar cobrança (Asaas)', icone: 'credit-card', cor: '#dd6b20', cat: 'Pagamentos', fields: ['api_key', 'data_input'] },
  { tipo: 'asaas_check_payment', label: 'Checar pagamento (Asaas)', icone: 'credit-card', cor: '#dd6b20', cat: 'Pagamentos', fields: ['api_key', 'value'] },
  { tipo: 'generate_pix_qr', label: 'Gerar QR Pix', icone: 'qrcode', cor: '#dd6b20', cat: 'Pagamentos', fields: ['pix_key', 'merchant_name', 'merchant_city', 'amount'] },
  { tipo: 'get_currency_rate', label: 'Cotação de moeda', icone: 'currency-exchange', cor: '#dd6b20', cat: 'Pagamentos', fields: ['value'] },
  { tipo: 'get_crypto_price', label: 'Preço de criptomoeda', icone: 'bitcoin', cor: '#dd6b20', cat: 'Pagamentos', fields: ['value'] },

  { tipo: 'get_weather', label: 'Consultar clima', icone: 'sun', cor: '#3182ce', cat: 'APIs externas', fields: ['api_key', 'value'] },
  { tipo: 'geocode_address', label: 'Geocodificar endereço', icone: 'map-pin', cor: '#3182ce', cat: 'APIs externas', fields: ['value'] },
  { tipo: 'calculate_distance', label: 'Calcular distância', icone: 'resize', cor: '#3182ce', cat: 'APIs externas', fields: ['coord_from', 'coord_to'] },
  { tipo: 'shorten_url', label: 'Encurtar URL', icone: 'link', cor: '#3182ce', cat: 'APIs externas', fields: ['url'] },
  { tipo: 'lookup_cnpj', label: 'Consultar CNPJ', icone: 'building', cor: '#3182ce', cat: 'APIs externas', fields: ['value'] },
  { tipo: 'get_holidays', label: 'Feriados (BR)', icone: 'calendar', cor: '#3182ce', cat: 'APIs externas', fields: ['value'] },
  { tipo: 'translate_text', label: 'Traduzir texto', icone: 'globe', cor: '#3182ce', cat: 'APIs externas', fields: ['api_key', 'value', 'target_lang'] },

  { tipo: 'download_file', label: 'Baixar arquivo', icone: 'arrow-down', cor: '#3182ce', cat: 'Web/scraping', fields: ['url'] },
  { tipo: 'upload_file', label: 'Enviar arquivo', icone: 'arrow-up', cor: '#3182ce', cat: 'Web/scraping', fields: ['url', 'file_base64'] },
  { tipo: 'scrape_html_table', label: 'Extrair tabela HTML', icone: 'table', cor: '#3182ce', cat: 'Web/scraping', fields: ['data_input', 'css_selector'] },
  { tipo: 'read_rss_feed', label: 'Ler feed RSS', icone: 'rss', cor: '#3182ce', cat: 'Web/scraping', fields: ['url'] },

  { tipo: 'detect_language', label: 'Detectar idioma', icone: 'globe', cor: '#6b46c1', cat: 'Texto/NLP', fields: ['value'] },
  { tipo: 'count_tokens', label: 'Contar tokens', icone: 'hash', cor: '#6b46c1', cat: 'Texto/NLP', fields: ['value'] },
  { tipo: 'compare_texts', label: 'Comparar textos', icone: 'versus', cor: '#6b46c1', cat: 'Texto/NLP', fields: ['data_input', 'data_input2'] },

  { tipo: 'generate_embedding', label: 'Gerar embedding', icone: 'brain', cor: '#6b46c1', cat: 'Inteligência Artificial', fields: ['api_key', 'value'] },
  { tipo: 'semantic_search', label: 'Busca semântica', icone: 'search', cor: '#6b46c1', cat: 'Inteligência Artificial', fields: ['value', 'data_input'] },
  { tipo: 'moderate_content', label: 'Moderar conteúdo', icone: 'shield', cor: '#6b46c1', cat: 'Inteligência Artificial', fields: ['api_key', 'value'] },
  { tipo: 'generate_ai_image', label: 'Gerar imagem IA', icone: 'palette', cor: '#6b46c1', cat: 'Inteligência Artificial', fields: ['api_key', 'value'] },
  { tipo: 'transcribe_audio', label: 'Transcrever áudio', icone: 'speaker', cor: '#6b46c1', cat: 'Inteligência Artificial', fields: ['api_key', 'file_base64'] },
  { tipo: 'text_to_speech', label: 'Texto pra fala', icone: 'speaker', cor: '#6b46c1', cat: 'Inteligência Artificial', fields: ['api_key', 'value', 'provedor'] },

  { tipo: 'check_port_open', label: 'Checar porta aberta', icone: 'plug', cor: '#1a202c', cat: 'Sistema/rede', fields: ['target', 'value'] },
  { tipo: 'dns_lookup', label: 'Consultar DNS', icone: 'globe', cor: '#1a202c', cat: 'Sistema/rede', fields: ['target'] },
  { tipo: 'whois_lookup', label: 'Consultar WHOIS', icone: 'search', cor: '#1a202c', cat: 'Sistema/rede', fields: ['value'] },
  { tipo: 'ssh_execute', label: 'Executar via SSH', icone: 'terminal', cor: '#1a202c', cat: 'Sistema/rede', fields: ['target', 'port', 'api_key', 'secret_key', 'command'] },
  { tipo: 'read_env_var', label: 'Ler variável de ambiente', icone: 'gear', cor: '#1a202c', cat: 'Sistema/rede', fields: ['value'] },
  { tipo: 'check_url_uptime', label: 'Checar disponibilidade (URL)', icone: 'heart-pulse', cor: '#1a202c', cat: 'Sistema/rede', fields: ['url'] },
  { tipo: 'system_stats', label: 'Estatísticas do sistema', icone: 'bar-chart', cor: '#1a202c', cat: 'Sistema (na máquina)', fields: [], agente: true },
  { tipo: 'list_processes', label: 'Listar processos', icone: 'list', cor: '#1a202c', cat: 'Sistema (na máquina)', fields: [], agente: true },

  { tipo: 'redis_get', label: 'Redis: ler chave', icone: 'database', cor: '#805ad5', cat: 'Banco/fila', fields: ['url', 'value'] },
  { tipo: 'redis_set', label: 'Redis: gravar chave', icone: 'database', cor: '#805ad5', cat: 'Banco/fila', fields: ['url', 'cell_ref', 'content'] },
  { tipo: 'queue_push', label: 'Fila: empilhar', icone: 'inbox', cor: '#805ad5', cat: 'Banco/fila', fields: ['url', 'value', 'content'] },
  { tipo: 'queue_pop', label: 'Fila: desempilhar', icone: 'inbox', cor: '#805ad5', cat: 'Banco/fila', fields: ['url', 'value'] },
  { tipo: 'sql_query_external', label: 'SQL externo (Postgres)', icone: 'database', cor: '#805ad5', cat: 'Banco/fila', fields: ['api_key', 'sql_query'] },

  { tipo: 'render_template', label: 'Renderizar template', icone: 'file-text', cor: '#dd6b20', cat: 'Templates/documentos', fields: ['content'] },
  { tipo: 'generate_word_doc', label: 'Gerar documento Word', icone: 'doc-word', cor: '#dd6b20', cat: 'Templates/documentos', fields: ['content'] },
  { tipo: 'generate_pptx', label: 'Gerar apresentação PPTX', icone: 'doc-slides', cor: '#dd6b20', cat: 'Templates/documentos', fields: ['content'] },

  { tipo: 'resize_image', label: 'Redimensionar imagem', icone: 'resize', cor: '#c53030', cat: 'Imagens', fields: ['file_base64', 'width', 'height'] },
  { tipo: 'convert_image_format', label: 'Converter formato de imagem', icone: 'image', cor: '#c53030', cat: 'Imagens', fields: ['file_base64', 'format_to'] },
  { tipo: 'add_watermark', label: 'Adicionar marca d\'água', icone: 'droplet', cor: '#c53030', cat: 'Imagens', fields: ['file_base64', 'value'] },
  { tipo: 'generate_thumbnail', label: 'Gerar miniatura', icone: 'image', cor: '#c53030', cat: 'Imagens', fields: ['file_base64', 'width', 'height'] },
  { tipo: 'generate_qrcode', label: 'Gerar QR code', icone: 'qrcode', cor: '#c53030', cat: 'Imagens', fields: ['value'] },
  { tipo: 'read_qrcode', label: 'Ler QR code', icone: 'qrcode', cor: '#c53030', cat: 'Imagens', fields: ['file_base64'] },
  { tipo: 'compare_images', label: 'Comparar imagens', icone: 'versus', cor: '#c53030', cat: 'Imagens', fields: ['data_input', 'data_input2'] },
  { tipo: 'ocr_image', label: 'OCR de imagem', icone: 'font', cor: '#c53030', cat: 'Imagens', fields: ['file_base64', 'ocr_lang'] },

  { tipo: 'transcode_media', label: 'Converter mídia', icone: 'film', cor: '#805ad5', cat: 'Áudio/vídeo (na máquina)', fields: ['source_path', 'dest_path'], agente: true },
  { tipo: 'extract_audio', label: 'Extrair áudio de vídeo', icone: 'music', cor: '#805ad5', cat: 'Áudio/vídeo (na máquina)', fields: ['source_path', 'dest_path'], agente: true },
  { tipo: 'trim_media', label: 'Cortar mídia', icone: 'scissors', cor: '#805ad5', cat: 'Áudio/vídeo (na máquina)', fields: ['source_path', 'dest_path', 'value', 'seconds'], agente: true },
  { tipo: 'extract_video_frame', label: 'Extrair frame de vídeo', icone: 'camera', cor: '#805ad5', cat: 'Áudio/vídeo (na máquina)', fields: ['source_path', 'dest_path', 'value'], agente: true },

  { tipo: 'gdrive_create_folder', label: 'Criar pasta (Google Drive)', icone: 'folder', cor: '#0f9d58', cat: 'Google Drive', fields: ['gdrive_file_name', 'gdrive_parent_id', 'api_key'] },
  { tipo: 'gdrive_upload_file', label: 'Enviar arquivo (Google Drive)', icone: 'arrow-up', cor: '#0f9d58', cat: 'Google Drive', fields: ['gdrive_file_name', 'gdrive_parent_id', 'gdrive_mime_type', 'file_base64', 'api_key'] },
  { tipo: 'gdrive_update_file_content', label: 'Atualizar conteúdo (Google Drive)', icone: 'edit', cor: '#0f9d58', cat: 'Google Drive', fields: ['gdrive_file_id', 'gdrive_mime_type', 'file_base64', 'api_key'] },
  { tipo: 'gdrive_download_file', label: 'Baixar arquivo (Google Drive)', icone: 'arrow-down', cor: '#0f9d58', cat: 'Google Drive', fields: ['gdrive_file_id', 'api_key'] },
  { tipo: 'gdrive_delete_file', label: 'Excluir arquivo/pasta (Google Drive)', icone: 'trash', cor: '#0f9d58', cat: 'Google Drive', fields: ['gdrive_file_id', 'api_key'] },
  { tipo: 'gdrive_list_files', label: 'Listar arquivos (Google Drive)', icone: 'list', cor: '#0f9d58', cat: 'Google Drive', fields: ['gdrive_parent_id', 'gdrive_query', 'api_key'] },
  { tipo: 'gdrive_rename_file', label: 'Renomear arquivo/pasta (Google Drive)', icone: 'pencil', cor: '#0f9d58', cat: 'Google Drive', fields: ['gdrive_file_id', 'gdrive_file_name', 'api_key'] },
  { tipo: 'gdrive_move_file', label: 'Mover arquivo (Google Drive)', icone: 'arrow-right', cor: '#0f9d58', cat: 'Google Drive', fields: ['gdrive_file_id', 'gdrive_new_parent_id', 'api_key'] },
  { tipo: 'gdrive_copy_file', label: 'Copiar arquivo (Google Drive)', icone: 'copy', cor: '#0f9d58', cat: 'Google Drive', fields: ['gdrive_file_id', 'gdrive_file_name', 'gdrive_parent_id', 'api_key'] },
  { tipo: 'gdrive_share_file', label: 'Compartilhar arquivo/pasta (Google Drive)', icone: 'link', cor: '#0f9d58', cat: 'Google Drive', fields: ['gdrive_file_id', 'gdrive_share_email', 'gdrive_share_role', 'api_key'] },
  { tipo: 'gdrive_file_info', label: 'Info do arquivo/pasta (Google Drive)', icone: 'info', cor: '#0f9d58', cat: 'Google Drive', fields: ['gdrive_file_id', 'api_key'] },

  { tipo: 'gsheets_create_spreadsheet', label: 'Criar planilha (Google Sheets)', icone: 'table', cor: '#188038', cat: 'Google Sheets', fields: ['gsheets_titulo', 'gdrive_parent_id', 'api_key'] },
  { tipo: 'gsheets_read_values', label: 'Ler intervalo (Google Sheets)', icone: 'table', cor: '#188038', cat: 'Google Sheets', fields: ['gsheets_id', 'gsheets_range', 'api_key'] },
  { tipo: 'gsheets_write_values', label: 'Escrever intervalo (Google Sheets)', icone: 'edit', cor: '#188038', cat: 'Google Sheets', fields: ['gsheets_id', 'gsheets_range', 'data_input', 'api_key'] },
  { tipo: 'gsheets_append_row', label: 'Adicionar linha (Google Sheets)', icone: 'check', cor: '#188038', cat: 'Google Sheets', fields: ['gsheets_id', 'gsheets_range', 'data_input', 'api_key'] },
  { tipo: 'gsheets_clear_values', label: 'Limpar intervalo (Google Sheets)', icone: 'broom', cor: '#188038', cat: 'Google Sheets', fields: ['gsheets_id', 'gsheets_range', 'api_key'] },
  { tipo: 'gsheets_list_sheets', label: 'Listar abas (Google Sheets)', icone: 'list', cor: '#188038', cat: 'Google Sheets', fields: ['gsheets_id', 'api_key'] },
  { tipo: 'gsheets_add_sheet', label: 'Criar aba (Google Sheets)', icone: 'folder', cor: '#188038', cat: 'Google Sheets', fields: ['gsheets_id', 'gsheets_titulo', 'api_key'] },
  { tipo: 'gsheets_delete_sheet', label: 'Excluir aba (Google Sheets)', icone: 'trash', cor: '#188038', cat: 'Google Sheets', fields: ['gsheets_id', 'gsheets_titulo', 'api_key'] },
];
const RB_ACOES_MAP = Object.fromEntries(RB_ACOES.map((a) => [a.tipo, a]));

// Metadados de campo pro formulário genérico (usado pelos steps de expansão
// acima, que têm `fields: [...]` em vez de um formulário escrito à mão).
const RB_FIELD_META = {
  value: { label: 'Valor', type: 'text', hint: 'Pode usar {output} ou {variavel}.' },
  expression: { label: 'Expressão', type: 'text', hint: 'Ex: {x} * 2 + Math.sqrt(9)' },
  data_input: { label: 'Dados (JSON)', type: 'textarea' },
  data_input2: { label: 'Dados 2 (JSON)', type: 'textarea' },
  file_base64: { label: 'Conteúdo (base64)', type: 'textarea', hint: 'Geralmente {output} de um step anterior (baixar arquivo, ler arquivo, etc.)' },
  file_path: { label: 'Caminho do arquivo', type: 'text' },
  directory: { label: 'Pasta', type: 'text' },
  source_path: { label: 'Caminho de origem', type: 'text' },
  dest_path: { label: 'Caminho de destino', type: 'text' },
  pattern: { label: 'Padrão de nome', type: 'text', placeholder: '*.txt' },
  url: { label: 'URL', type: 'text' },
  api_key: { label: 'API Key / usuário', type: 'text' },
  api_secret: { label: 'API Secret / senha', type: 'text' },
  secret_key: { label: 'Chave secreta', type: 'text' },
  to: { label: 'Destinatário', type: 'text' },
  from_number: { label: 'Número de origem', type: 'text' },
  subject: { label: 'Assunto', type: 'text' },
  email_body: { label: 'Mensagem', type: 'textarea' },
  content: { label: 'Conteúdo', type: 'textarea' },
  target: { label: 'Alvo (host/URL)', type: 'text' },
  host: { label: 'Host', type: 'text' },
  port: { label: 'Porta', type: 'text' },
  command: { label: 'Comando', type: 'text' },
  sql_query: { label: 'Consulta SQL', type: 'textarea' },
  schema_input: { label: 'Schema (JSON)', type: 'textarea' },
  css_selector: { label: 'Seletor CSS', type: 'text' },
  merge_key: { label: 'Campo-chave', type: 'text' },
  sort_key: { label: 'Campo de ordenação', type: 'text' },
  cell_ref: { label: 'Campo/célula', type: 'text' },
  row_index: { label: 'Índice da linha', type: 'text' },
  operator: { label: 'Operador', type: 'select', options: [['equals', 'igual a'], ['not_equals', 'diferente de'], ['contains', 'contém'], ['greater_than', 'maior que'], ['less_than', 'menor que']] },
  sheet_name: { label: 'Nome da planilha', type: 'text' },
  delimiter: { label: 'Delimitador', type: 'text', placeholder: ',' },
  format_from: { label: 'Formato de origem', type: 'select', options: [['json', 'JSON'], ['yaml', 'YAML'], ['xml', 'XML'], ['csv', 'CSV']] },
  format_to: { label: 'Formato de destino', type: 'select', options: [['json', 'JSON'], ['yaml', 'YAML'], ['xml', 'XML'], ['csv', 'CSV'], ['jpg', 'JPG'], ['png', 'PNG']] },
  encoding_from: { label: 'Encoding de origem', type: 'text', placeholder: 'latin-1' },
  encoding_to: { label: 'Encoding de destino', type: 'text', placeholder: 'utf-8' },
  fake_type: { label: 'Tipo de dado', type: 'select', options: [['name', 'Nome'], ['email', 'E-mail'], ['phone', 'Telefone'], ['address', 'Endereço'], ['company', 'Empresa'], ['cpf', 'CPF'], ['uuid', 'UUID'], ['number', 'Número'], ['date', 'Data']] },
  fake_count: { label: 'Quantidade', type: 'text', placeholder: '1' },
  hash_algo: { label: 'Algoritmo de hash', type: 'select', options: [['sha256', 'SHA-256'], ['md5', 'MD5'], ['sha1', 'SHA-1']] },
  password_length: { label: 'Tamanho da senha', type: 'text', placeholder: '16' },
  password_hash: { label: 'Hash pra comparar', type: 'text' },
  expires_in: { label: 'Expira em', type: 'text', placeholder: '1h' },
  currency: { label: 'Moeda', type: 'text', placeholder: 'BRL' },
  target_lang: { label: 'Idioma de destino', type: 'text', placeholder: 'EN' },
  pix_key: { label: 'Chave Pix', type: 'text' },
  merchant_name: { label: 'Nome do recebedor', type: 'text' },
  merchant_city: { label: 'Cidade', type: 'text' },
  amount: { label: 'Valor (R$)', type: 'text' },
  width: { label: 'Largura (px)', type: 'text' },
  height: { label: 'Altura (px)', type: 'text' },
  coord_from: { label: 'Coordenada de origem (lat,lon)', type: 'text' },
  coord_to: { label: 'Coordenada de destino (lat,lon)', type: 'text' },
  ocr_lang: { label: 'Idioma do OCR', type: 'text', placeholder: 'por' },
  max_iterations: { label: 'Máximo', type: 'text' },
  date: { label: 'Data', type: 'text', placeholder: 'AAAA-MM-DD ou {output}' },
  date_from: { label: 'Data inicial', type: 'text' },
  date_to: { label: 'Data final', type: 'text' },
  unit: { label: 'Unidade', type: 'select', options: [['days', 'dias'], ['hours', 'horas'], ['minutes', 'minutos'], ['seconds', 'segundos']] },
  date_amount: { label: 'Quantidade', type: 'text', hint: 'Positivo soma, negativo subtrai.' },
  to_timezone: { label: 'Fuso horário', type: 'text', placeholder: 'America/Sao_Paulo' },
  format: { label: 'Formato', type: 'text', placeholder: 'DD/MM/YYYY HH:mm' },
  provedor: { label: 'Voz/provedor', type: 'text' },
  seconds: { label: 'Segundos', type: 'text' },
  timeout_seconds: { label: 'Timeout (segundos)', type: 'text' },
  session_name: { label: 'Nome da sessão', type: 'text', placeholder: 'principal', hint: 'Mesmo nome usado em "Abrir sessão" — identifica qual navegador esse step controla.' },
  browser_profile: { label: 'Pasta de perfil persistente (opcional)', type: 'text', hint: 'Preenche pra manter login/cookies entre execuções (força janela visível, não headless).' },
  headless: { label: 'Sem interface visível (headless)', type: 'checkbox' },
  gdrive_file_id: { label: 'ID do arquivo/pasta', type: 'text', hint: 'Copie da URL do Drive (depois de "/d/" ou "/folders/"). Aceita {output} ou {variavel}.' },
  gdrive_parent_id: { label: 'ID da pasta (opcional)', type: 'text', hint: 'Vazio = raiz do Meu Drive da conta Google conectada.' },
  gdrive_new_parent_id: { label: 'ID da pasta de destino', type: 'text' },
  gdrive_file_name: { label: 'Nome do arquivo/pasta', type: 'text' },
  gdrive_mime_type: { label: 'Tipo (MIME, opcional)', type: 'text', placeholder: 'application/pdf' },
  gdrive_query: { label: 'Filtro extra (opcional)', type: 'text', placeholder: "name contains 'relatorio'", hint: 'Sintaxe de busca do Google Drive (campo "q" da API).' },
  gdrive_share_email: { label: 'E-mail para compartilhar (opcional)', type: 'text', hint: 'Vazio = compartilha com "qualquer pessoa com o link".' },
  gdrive_share_role: { label: 'Permissão', type: 'select', options: [['reader', 'Leitor'], ['writer', 'Editor'], ['commenter', 'Comentarista']] },
  gsheets_id: { label: 'ID da planilha', type: 'text', hint: 'Copie da URL do Sheets (depois de "/d/", antes de "/edit").' },
  gsheets_range: { label: 'Intervalo', type: 'text', placeholder: 'Página1!A1:C10' },
  gsheets_titulo: { label: 'Título', type: 'text' },
};

function rbGenericFields(step) {
  const acao = RB_ACOES_MAP[step.type];
  return acao?.fields || [];
}

function rbNovoId() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())).replace(/-/g, '').slice(0, 12);
}

function rbMarcarSujo() { rbEmpresaSteps = true; }

// ==================== Árvore de steps — helpers recursivos ====================

// [ [chave, array, label, classe], ... ] das branches que este step tem.
function rbBranches(step) {
  if (step.type === 'condition') return [['children_true', step.children_true ||= [], 'Verdadeiro', 'verdadeiro'], ['children_false', step.children_false ||= [], 'Falso', 'falso']];
  if (step.type === 'try_catch') return [['children_true', step.children_true ||= [], 'Tentar', 'tentar'], ['children_false', step.children_false ||= [], 'Capturar', 'capturar']];
  if (['loop_count', 'foreach', 'while_condition', 'parallel'].includes(step.type)) return [['children', step.children ||= [], 'Corpo', 'corpo']];
  return [];
}

function rbFindStep(id, list = rbSteps) {
  for (const s of list) {
    if (s.id === id) return s;
    for (const [, arr] of rbBranches(s)) {
      const found = rbFindStep(id, arr);
      if (found) return found;
    }
  }
  return null;
}

// {arr, index} do array que CONTÉM o step (pra remover/mover) — null se não achar.
function rbFindLocation(id, list = rbSteps) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return { arr: list, index: i };
    for (const [, arr] of rbBranches(list[i])) {
      const found = rbFindLocation(id, arr);
      if (found) return found;
    }
  }
  return null;
}

function rbRemoveStep(id) {
  const loc = rbFindLocation(id);
  if (loc) loc.arr.splice(loc.index, 1);
}

function rbComputeNumbers() {
  const map = {};
  let n = 0;
  (function walk(list) {
    for (const s of list) {
      n++;
      map[s.id] = n;
      for (const [, arr] of rbBranches(s)) walk(arr);
    }
  })(rbSteps);
  return map;
}

// ==================== Paleta ====================

function rbRenderPalette() {
  rbBusca = document.getElementById('rbBusca').value.trim().toLowerCase();
  const filtradas = RB_ACOES.filter((a) => !rbBusca || a.label.toLowerCase().includes(rbBusca));
  const porCategoria = {};
  for (const a of filtradas) (porCategoria[a.cat] ||= []).push(a);

  let html = '';
  for (const [cat, acoes] of Object.entries(porCategoria)) {
    html += `<div class="rb-cat-titulo">${escapeHtmlRb(cat)}</div>`;
    for (const a of acoes) {
      html += `
        <div class="rb-acao-item" draggable="true" ondragstart="rbPaletteDragStart(event,'${a.tipo}')" onclick="rbAddStep('${a.tipo}')">
          <span class="rb-acao-icone" style="color:${a.cor}">${_rbIcon(a.icone, 15, a.cor)}</span>
          <span>${escapeHtmlRb(a.label)}</span>
        </div>`;
    }
  }
  document.getElementById('rbPaletteLista').innerHTML = html || '<div style="padding:12px;color:#a0aec0;font-size:12px">Nada encontrado.</div>';
}

function escapeHtmlRb(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ==================== Criar / mover / remover steps ====================

function rbCriarStep(tipo) {
  const step = { id: rbNovoId(), type: tipo, name: RB_ACOES_MAP[tipo]?.label || tipo, enabled: true, config: {} };
  if (tipo === 'condition') { step.children_true = []; step.children_false = []; }
  if (tipo === 'try_catch') { step.children_true = []; step.children_false = []; }
  if (['loop_count', 'foreach', 'while_condition', 'parallel'].includes(tipo)) step.children = [];
  return step;
}

function rbAddStep(tipo) {
  rbSteps.push(rbCriarStep(tipo));
  rbMarcarSujo();
  rbRenderCanvas();
}

function rbInserirEm(step, containerArr, index) {
  containerArr.splice(index, 0, step);
}

function rbMoveStep(id, dir) {
  const loc = rbFindLocation(id);
  if (!loc) return;
  const novoIndex = loc.index + dir;
  if (novoIndex < 0 || novoIndex >= loc.arr.length) return;
  const [item] = loc.arr.splice(loc.index, 1);
  loc.arr.splice(novoIndex, 0, item);
  rbMarcarSujo();
  rbRenderCanvas();
}

function rbDeleteStep(id) {
  rbRemoveStep(id);
  if (rbSelectedId === id) { rbSelectedId = null; rbRenderProps(); }
  rbMarcarSujo();
  rbRenderCanvas();
}

function rbToggleEnabled(id) {
  const step = rbFindStep(id);
  if (step) step.enabled = step.enabled === false ? true : false;
  rbMarcarSujo();
  rbRenderCanvas();
}

// ==================== Renderização do canvas ====================

function rbRenderCanvas() {
  const numeros = rbComputeNumbers();
  document.getElementById('rbCanvasSteps').innerHTML = rbRenderStepList(rbSteps, numeros, 'root', null);
}

function rbRenderStepList(steps, numeros, containerId, branchKey) {
  let html = rbZoneHtml(containerId, branchKey, 0);
  if (!steps.length) {
    html += `<div class="rb-empty-branch" ondragover="rbZoneDragOver(event)" ondrop="rbZoneDrop(event,'${containerId}','${branchKey}',0)">Arraste uma ação aqui</div>`;
    return html;
  }
  steps.forEach((step, i) => {
    html += rbRenderStepCard(step, numeros);
    html += rbZoneHtml(containerId, branchKey, i + 1);
  });
  return html;
}

function rbZoneHtml(containerId, branchKey, index) {
  return `<div class="rb-zone" ondragover="rbZoneDragOver(event)" ondragleave="rbZoneDragLeave(event)" ondrop="rbZoneDrop(event,'${containerId}','${branchKey}',${index})"><div class="rb-zone-line"></div></div>`;
}

function rbRenderStepCard(step, numeros) {
  const acao = RB_ACOES_MAP[step.type] || { label: step.type, icone: 'gear', cor: '#718096' };
  const num = numeros[step.id];
  const desativado = step.enabled === false;
  const branches = rbBranches(step);
  const isContainer = branches.length > 0;

  const cardHtml = `
    <div class="rb-step ${rbSelectedId === step.id ? 'selecionado' : ''}" style="${desativado ? 'opacity:.45' : ''}"
         draggable="true" ondragstart="rbStepDragStart(event,'${step.id}')"
         onclick="rbSelectStep('${step.id}', event)">
      <span class="rb-step-num">${num}</span>
      <span class="rb-step-icone" style="background:${acao.cor}22;color:${acao.cor}">${_rbIcon(acao.icone, 14, acao.cor)}</span>
      <div class="rb-step-corpo">
        <div class="rb-step-nome">${escapeHtmlRb(step.name || acao.label)}</div>
        <div class="rb-step-resumo">${escapeHtmlRb(rbResumoStep(step))}</div>
      </div>
      <div class="rb-step-acoes">
        <button title="Mover pra cima" onclick="event.stopPropagation();rbMoveStep('${step.id}',-1)">▲</button>
        <button title="Mover pra baixo" onclick="event.stopPropagation();rbMoveStep('${step.id}',1)">▼</button>
        <button title="${desativado ? 'Ativar' : 'Desativar'}" onclick="event.stopPropagation();rbToggleEnabled('${step.id}')">${desativado ? '○' : '●'}</button>
        <button title="Remover" onclick="event.stopPropagation();rbDeleteStep('${step.id}')">✕</button>
      </div>
    </div>`;

  if (!isContainer) return cardHtml;

  const duasBranches = branches.length === 2;
  let branchesHtml = `<div class="rb-container-branches ${duasBranches ? 'duas' : ''}">`;
  for (const [key, arr, label, classe] of branches) {
    branchesHtml += `
      <div class="rb-branch ${classe}">
        <div class="rb-branch-label">${label}</div>
        ${rbRenderStepList(arr, numeros, step.id, key)}
      </div>`;
  }
  branchesHtml += '</div>';

  return `<div class="rb-container">${cardHtml}${branchesHtml}</div>`;
}

function rbResumoStep(step) {
  const c = step.config || {};
  switch (step.type) {
    case 'set_variable': return `${c.variable_name || '?'} = ${c.value || ''}`;
    case 'condition': return `se output ${c.operator || '?'} "${c.condition_value || ''}"`;
    case 'loop_count': return `${c.count || 0}x`;
    case 'foreach': return `sobre ${c.list_source || '?'}`;
    case 'wait': return `${c.seconds || 0}s`;
    case 'http_request': case 'http_request_retry': return `${(c.method || 'GET')} ${c.url || ''}`;
    case 'send_email': return `pra ${c.to || '?'}`;
    case 'call_ai_agent': return c.input_template || '{output}';
    case 'ai_open': return `"${c.session_name || '?'}" (${rbAiProvedorEfetivo(c)}${c.modelo ? ' / ' + c.modelo : ''})${c.keep_history === false ? '' : ' com memória'}`;
    case 'ai_chat': return `"${(c.input_template || '{output}').substring(0, 30)}" → sessão "${c.session_name || '?'}"`;
    case 'ai_close': return `sessão "${c.session_name || '?'}"`;
    case 'read_file': return c.file_path || '';
    case 'write_file': return c.file_path || '';
    case 'run_command': return c.command || '';
    case 'browser_flow': return `${(c.actions || []).length} ações`;
    default: {
      // Steps de expansão: mostra o primeiro campo preenchido (mais
      // curto que listar tudo, e já dá uma pista do que o step faz).
      const acao = RB_ACOES_MAP[step.type];
      for (const campo of (acao?.fields || [])) {
        if (c[campo]) return String(c[campo]).slice(0, 60);
      }
      return '';
    }
  }
}

// ==================== Seleção + painel de propriedades ====================

function rbSelectStep(id, ev) {
  if (ev) ev.stopPropagation();
  rbSelectedId = id;
  rbRenderCanvas();
  rbRenderProps();
}

function rbUpdateConfig(stepId, key, value) {
  const step = rbFindStep(stepId);
  if (!step) return;
  step.config = step.config || {};
  step.config[key] = value;
  rbMarcarSujo();
  rbRenderCanvas();
}

function rbUpdateName(stepId, value) {
  const step = rbFindStep(stepId);
  if (!step) return;
  step.name = value;
  rbMarcarSujo();
  rbRenderCanvas();
}

function rbField(label, inputHtml, hint) {
  return `<div class="rb-field"><label>${escapeHtmlRb(label)}</label>${inputHtml}${hint ? `<div class="rb-hint">${hint}</div>` : ''}</div>`;
}

// ==================== Sessão de IA (mesmo modelo da sessão de navegador) ====================
// Abrir sessão (token + configurações) → usar pelo nome → fechar. Ver lib/automationEngine.js.

const RB_AI_PROVEDORES = [['claude-sonnet', 'Claude Sonnet'], ['claude-haiku', 'Claude Haiku'], ['gpt-4o', 'GPT-4o'], ['gpt-4', 'GPT-4'], ['gemini', 'Gemini'], ['groq', 'Groq (Llama)']];
// Modelo padrão de cada provedor (o campo "Modelo" da sessão, se preenchido, sobrepõe).
const RB_AI_MODELO_PADRAO = { 'claude-sonnet': 'claude-sonnet-4-6', 'claude-haiku': 'claude-haiku-4-5-20251001', 'gpt-4o': 'gpt-4o', 'gpt-4': 'gpt-4', gemini: 'gemini-1.5-pro', groq: 'openai/gpt-oss-20b' };

// Modelos oferecidos na lista de escolha da sessão, por provedor. Quem escolhe o modelo é o
// usuário; "Outro" permite digitar qualquer id. A disponibilidade varia por conta/chave
// (ex.: na Groq, alguns Llama não existem mais em certas contas) — se a API responder
// "modelo não existe", é só escolher outro.
const RB_AI_ANTHROPIC_MODELOS = [
  ['claude-fable-5-1', 'Claude Fable 5.1'], ['claude-opus-5', 'Claude Opus 5'], ['claude-opus-4-7', 'Claude Opus 4.7'],
  ['claude-sonnet-5', 'Claude Sonnet 5'], ['claude-sonnet-4-6', 'Claude Sonnet 4.6'], ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
];
const RB_AI_OPENAI_MODELOS = [['gpt-4o', 'GPT-4o'], ['gpt-4o-mini', 'GPT-4o Mini'], ['gpt-4-turbo', 'GPT-4 Turbo'], ['gpt-4', 'GPT-4']];
const RB_AI_MODELOS = {
  'claude-sonnet': RB_AI_ANTHROPIC_MODELOS,
  'claude-haiku': RB_AI_ANTHROPIC_MODELOS,
  'gpt-4o': RB_AI_OPENAI_MODELOS,
  'gpt-4': RB_AI_OPENAI_MODELOS,
  gemini: [['gemini-2.5-pro', 'Gemini 2.5 Pro'], ['gemini-2.5-flash', 'Gemini 2.5 Flash'], ['gemini-2.0-flash', 'Gemini 2.0 Flash'], ['gemini-1.5-pro', 'Gemini 1.5 Pro'], ['gemini-1.5-flash', 'Gemini 1.5 Flash']],
  groq: [['openai/gpt-oss-20b', 'GPT-OSS 20B'], ['openai/gpt-oss-120b', 'GPT-OSS 120B'], ['llama-3.3-70b-versatile', 'Llama 3.3 70B'], ['llama-3.1-8b-instant', 'Llama 3.1 8B']],
};
const RB_AI_MODELO_OUTRO = '__outro__';
const RB_AI_OPENAI_TYPES = new Set(['generate_embedding', 'moderate_content', 'generate_ai_image', 'transcribe_audio', 'text_to_speech']);
const RB_GDRIVE_TYPES = new Set(['gdrive_create_folder', 'gdrive_upload_file', 'gdrive_update_file_content', 'gdrive_download_file', 'gdrive_delete_file', 'gdrive_list_files', 'gdrive_rename_file', 'gdrive_move_file', 'gdrive_copy_file', 'gdrive_share_file', 'gdrive_file_info',
  'gsheets_create_spreadsheet', 'gsheets_read_values', 'gsheets_write_values', 'gsheets_append_row', 'gsheets_clear_values', 'gsheets_list_sheets', 'gsheets_add_sheet', 'gsheets_delete_sheet']);

async function rbCarregarDadosIA() {
  try { rbCredenciais = await rbApi('GET', '/api/credenciais'); } catch { rbCredenciais = []; }
  try { rbConfigIA = (await rbApi('GET', '/api/config-ia')) || {}; } catch { rbConfigIA = {}; }
  if (rbSelectedId) rbRenderProps(); // redesenha o painel aberto com a lista de credenciais já carregada
}

// Provedor efetivo: o escolhido no step ou, se "Padrão da empresa", o de Configurações → IA.
function rbAiProvedorEfetivo(c) {
  return c.provedor || rbConfigIA.provedor || 'claude-sonnet';
}

function rbFindAiOpen(name, list = rbSteps) {
  if (!name) return null;
  for (const s of list) {
    if (s.type === 'ai_open' && ((s.config || {}).session_name || '').trim() === name) return s;
    for (const [, arr] of rbBranches(s)) {
      const found = rbFindAiOpen(name, arr);
      if (found) return found;
    }
  }
  return null;
}

// Aviso nos steps que usam uma sessão: confirma qual "Abrir sessão de IA" é o dono do
// nome e o provedor que será usado (ou avisa que não achou / que o provedor não serve).
function rbAiSessionNotice(sessionName, exigeOpenAI) {
  const name = (sessionName || '').trim();
  const open = rbFindAiOpen(name);
  if (!open) {
    return `<div class="rb-hint">${_rbIcon('alert-triangle', 12)} Nenhum step "Abrir sessão de IA" chamado "${escapeHtmlRb(name || '...')}" foi encontrado neste robô ainda. Adicione um (antes deste step) para usar o token e as configurações dele.</div>`;
  }
  const prov = rbAiProvedorEfetivo(open.config || {});
  if (exigeOpenAI && !['gpt-4o', 'gpt-4'].includes(prov)) {
    return `<div class="rb-hint">${_rbIcon('alert-triangle', 12)} A sessão "${escapeHtmlRb(name)}" usa o provedor <strong>${escapeHtmlRb(prov)}</strong>, mas esta ação só funciona com uma sessão OpenAI (GPT-4o / GPT-4).</div>`;
  }
  return `<div class="rb-hint">Usa a sessão "<strong>${escapeHtmlRb(name)}</strong>" (${escapeHtmlRb(prov)}), com o token e as configurações do step "Abrir sessão de IA".</div>`;
}

// Campo das ações OpenAI: sessão de IA (nome) OU token digitado no próprio step.
function rbAiKeyOrSession(id, c) {
  const name = (c.session_name || '').trim();
  let html = rbField('Sessão de IA (opcional)',
    `<input value="${escapeHtmlRb(c.session_name || '')}" placeholder="ex: openai — mesmo nome do step 'Abrir sessão de IA'" onchange="rbUpdateConfig('${id}','session_name',this.value);rbRenderProps()">`);
  if (name) return html + rbAiSessionNotice(name, true);
  html += rbField('API Key / usuário', `<input value="${escapeHtmlRb(c.api_key || '')}" oninput="rbUpdateConfig('${id}','api_key',this.value)">`,
    'Ou informe acima o nome de uma sessão de IA (OpenAI) para reutilizar o token dela em vários steps, sem colar a chave em cada um.');
  return html;
}

// Campo de credencial das ações do Google Drive/Sheets: de preferência a conta Google
// conectada em Operações → Credenciais ("Conectar conta Google" — app OAuth da própria
// empresa, a credencial inteira é usada); ou uma conta de serviço (JSON) do cofre ou
// colada direto no step. Cada step resolve a credencial e o token na hora.
function rbGDriveCredField(id, c) {
  const cred = rbCredenciais.find((x) => x.nome === c.credencial_nome);
  const ehOAuth = !!(cred && cred.campos && (cred.campos.client_id || cred.campos.refresh_token));
  let html = rbField('Conta Google — credencial do cofre', `<select onchange="rbUpdateConfig('${id}','credencial_nome',this.value);rbRenderProps()">
    <option value="">Colar JSON abaixo</option>
    ${c.credencial_nome && !cred ? `<option value="${escapeHtmlRb(c.credencial_nome)}" selected>${escapeHtmlRb(c.credencial_nome)} (não encontrada)</option>` : ''}
    ${rbCredenciais.map((x) => `<option value="${escapeHtmlRb(x.nome)}" ${x.nome === c.credencial_nome ? 'selected' : ''}>${escapeHtmlRb(x.nome)}</option>`).join('')}
  </select>`, 'Conecte a conta Google da empresa em Operações → Credenciais → "Conectar conta Google" e escolha aqui a credencial criada. O robô acessa só o Drive dessa conta.');
  if (c.credencial_nome && ehOAuth) {
    if (!cred.campos.refresh_token || !cred.campos.client_id) html += '<div style="font-size:11px;color:#B45309;margin:-4px 0 10px">Essa conta Google ainda não foi conectada — clique em "Conectar" nela em Operações → Credenciais.</div>';
  } else if (c.credencial_nome) {
    const campos = Object.keys((cred && cred.campos) || {});
    if (!campos.includes(c.campo_cred || 'service_account_json')) campos.unshift(c.campo_cred || 'service_account_json');
    html += rbField('Campo com o JSON da conta de serviço', `<select onchange="rbUpdateConfig('${id}','campo_cred',this.value)">
      ${campos.map((k) => `<option value="${escapeHtmlRb(k)}" ${k === (c.campo_cred || 'service_account_json') ? 'selected' : ''}>${escapeHtmlRb(k)}</option>`).join('')}
    </select>`);
  } else {
    html += rbField('JSON da credencial', `<textarea rows="4" placeholder='{"client_id":"...","client_secret":"...","refresh_token":"..."}  ou o JSON de uma conta de serviço' oninput="rbUpdateConfig('${id}','api_key',this.value)">${escapeHtmlRb(c.api_key || '')}</textarea>`,
      'Prefira uma credencial do cofre — o que for colado aqui fica salvo dentro do robô.');
  }
  return html;
}

// Troca de provedor: se a lista de modelos muda (ex.: Groq -> GPT), o modelo escolhido antes
// deixa de valer e volta ao padrão do novo provedor — senão seria enviado ao provedor errado.
function rbAiEscolherProvedor(stepId, valor) {
  const step = rbFindStep(stepId);
  if (!step) return;
  const c = (step.config = step.config || {});
  const antes = RB_AI_MODELOS[rbAiProvedorEfetivo(c)];
  c.provedor = valor;
  if (antes !== RB_AI_MODELOS[rbAiProvedorEfetivo(c)]) { c.modelo = ''; c.modelo_outro = false; }
  rbMarcarSujo();
  rbRenderCanvas();
  rbRenderProps();
}

// Escolha na lista de modelos: valor da lista, "" (padrão do provedor) ou "Outro" (mostra o campo de digitação).
function rbAiEscolherModelo(stepId, valor) {
  const step = rbFindStep(stepId);
  if (!step) return;
  step.config = step.config || {};
  if (valor === RB_AI_MODELO_OUTRO) {
    step.config.modelo_outro = true;
    step.config.modelo = '';
  } else {
    step.config.modelo_outro = false;
    step.config.modelo = valor;
  }
  rbMarcarSujo();
  rbRenderCanvas();
  rbRenderProps();
}

function rbRenderAiOpenForm(step, c) {
  const id = step.id;
  const inp = (key, ph) => `<input value="${escapeHtmlRb(c[key] || '')}" placeholder="${ph || ''}" oninput="rbUpdateConfig('${id}','${key}',this.value)">`;
  let form = rbField('Nome da sessão', inp('session_name', 'ex: assistente'),
    'Use o mesmo nome nos steps "Enviar mensagem" e nas ações OpenAI (embedding, moderação, imagem, Whisper, voz) para reaproveitar o mesmo token e as mesmas configurações. Existe só durante a execução.');

  form += rbField('Provedor', `<select onchange="rbAiEscolherProvedor('${id}',this.value)">
    <option value="" ${!c.provedor ? 'selected' : ''}>Padrão da empresa${rbConfigIA.provedor ? ' (' + escapeHtmlRb(rbConfigIA.provedor) + ')' : ''}</option>
    ${RB_AI_PROVEDORES.map((p) => `<option value="${p[0]}" ${c.provedor === p[0] ? 'selected' : ''}>${p[1]}</option>`).join('')}
  </select>`);

  // Modelo: lista para o usuário escolher (por provedor) + "Outro" para digitar qualquer id.
  const provEf = rbAiProvedorEfetivo(c);
  const lista = RB_AI_MODELOS[provEf] || [];
  const noLista = lista.some((m) => m[0] === c.modelo);
  const outro = c.modelo_outro || (!!c.modelo && !noLista);
  const padrao = RB_AI_MODELO_PADRAO[provEf] || '';
  form += rbField('Modelo', `<select onchange="rbAiEscolherModelo('${id}',this.value)">
    <option value="" ${!c.modelo && !outro ? 'selected' : ''}>Padrão do provedor${padrao ? ' (' + escapeHtmlRb(padrao) + ')' : ''}</option>
    ${lista.map((m) => `<option value="${escapeHtmlRb(m[0])}" ${c.modelo === m[0] && !c.modelo_outro ? 'selected' : ''}>${escapeHtmlRb(m[1])}${m[0] === padrao ? ' — padrão' : ''}</option>`).join('')}
    <option value="${RB_AI_MODELO_OUTRO}" ${outro ? 'selected' : ''}>Outro (digitar o id do modelo)…</option>
  </select>${outro ? `<input style="margin-top:6px" value="${escapeHtmlRb(c.modelo || '')}" placeholder="ex.: id exato do modelo" oninput="rbUpdateConfig('${id}','modelo',this.value)">` : ''}`,
    'A disponibilidade varia por conta/chave. Se a execução responder que o modelo não existe, escolha outro.');

  const cred = rbCredenciais.find((x) => x.nome === c.credencial_nome);
  form += rbField('Token — credencial do cofre (recomendado)', `<select onchange="rbUpdateConfig('${id}','credencial_nome',this.value);rbRenderProps()">
    <option value="">${!c.provedor ? 'Padrão da empresa / digitar token' : 'Digitar o token abaixo'}</option>
    ${c.credencial_nome && !cred ? `<option value="${escapeHtmlRb(c.credencial_nome)}" selected>${escapeHtmlRb(c.credencial_nome)} (não encontrada)</option>` : ''}
    ${rbCredenciais.map((x) => `<option value="${escapeHtmlRb(x.nome)}" ${x.nome === c.credencial_nome ? 'selected' : ''}>${escapeHtmlRb(x.nome)}</option>`).join('')}
  </select>`, 'O token fica guardado no cofre (Operações → Credenciais), não dentro do robô.');
  if (c.credencial_nome) {
    const campos = Object.keys((cred && cred.campos) || {});
    if (!campos.includes(c.campo_cred || 'api_key')) campos.unshift(c.campo_cred || 'api_key');
    form += rbField('Campo da credencial', `<select onchange="rbUpdateConfig('${id}','campo_cred',this.value)">
      ${campos.map((k) => `<option value="${escapeHtmlRb(k)}" ${k === (c.campo_cred || 'api_key') ? 'selected' : ''}>${escapeHtmlRb(k)}</option>`).join('')}
    </select>`);
  } else {
    form += rbField('Token (chave de API)', `<input type="password" autocomplete="new-password" value="${escapeHtmlRb(c.api_key || '')}" placeholder="vazio = usar o padrão da empresa" oninput="rbUpdateConfig('${id}','api_key',this.value)">`,
      'Digitado aqui, o token fica gravado dentro do robô. Prefira uma credencial do cofre. Também aceita {variavel}.');
  }

  form += rbField('Mensagem de sistema (opcional)', `<textarea rows="3" placeholder="Você é um assistente que..." oninput="rbUpdateConfig('${id}','system_message',this.value)">${escapeHtmlRb(c.system_message || '')}</textarea>`);

  // A Anthropic (Claude) não recebe temperatura (o backend não a envia): campo desabilitado com esse provedor.
  const claude = rbAiProvedorEfetivo(c).startsWith('claude');
  form += rbField('Temperatura (opcional)',
    `<input type="number" min="0" max="2" step="0.1" value="${escapeHtmlRb(c.temperature ?? '')}" placeholder="${claude ? 'não usada' : '0.7'}" ${claude ? 'disabled title="A Anthropic (Claude) não usa temperatura." style="opacity:.5;cursor:not-allowed"' : ''} oninput="rbUpdateConfig('${id}','temperature',this.value)">`,
    claude ? 'Desabilitada: a Anthropic (Claude) não usa temperatura. Vale para GPT e Gemini.' : 'Não é usada pela Anthropic (Claude) — só por GPT e Gemini.');
  form += rbField('Máximo de tokens na resposta (opcional)', `<input type="number" min="1" step="1" value="${escapeHtmlRb(c.max_tokens ?? '')}" placeholder="2048" oninput="rbUpdateConfig('${id}','max_tokens',this.value)">`);

  const memoria = c.keep_history !== false;
  form += `<div class="rb-field"><label class="rb-check"><input type="checkbox" ${memoria ? 'checked' : ''} onchange="rbUpdateConfig('${id}','keep_history',this.checked);rbRenderProps()"> Lembrar as mensagens anteriores da sessão</label>
    <div class="rb-hint">${memoria
      ? 'Cada "Enviar mensagem" nesta sessão vê as anteriores (como um chat). As mais antigas são descartadas ao passar do máximo, para limitar o custo em tokens.'
      : 'Cada "Enviar mensagem" é independente — a IA não vê as anteriores.'}</div></div>`;
  if (memoria) form += rbField('Máximo de mensagens lembradas', `<input type="number" min="2" step="2" value="${escapeHtmlRb(c.max_history_messages ?? 20)}" oninput="rbUpdateConfig('${id}','max_history_messages',this.value)">`);
  form += rbField('Salvar resultado na variável', inp('variable_name', 'opcional'));
  return form;
}

function rbRenderProps() {
  const el = document.getElementById('rbProps');
  if (!rbSelectedId) { el.innerHTML = '<div class="rb-props-placeholder">Selecione um step no canvas pra configurar, ou clique numa ação da paleta pra adicionar.</div>'; return; }
  const step = rbFindStep(rbSelectedId);
  if (!step) { el.innerHTML = ''; return; }
  const acao = RB_ACOES_MAP[step.type] || { label: step.type, icone: 'gear', cor: '#718096' };
  const c = step.config || {};
  const id = step.id;

  let form = `${rbField('Nome do step', `<input value="${escapeHtmlRb(step.name || '')}" oninput="rbUpdateName('${id}',this.value)">`)}`;

  const inp = (key, ph) => `<input value="${escapeHtmlRb(c[key] || '')}" placeholder="${ph || ''}" oninput="rbUpdateConfig('${id}','${key}',this.value)">`;
  const ta = (key, ph, rows) => `<textarea rows="${rows || 3}" placeholder="${ph || ''}" oninput="rbUpdateConfig('${id}','${key}',this.value)">${escapeHtmlRb(c[key] || '')}</textarea>`;
  const sel = (key, options) => `<select onchange="rbUpdateConfig('${id}','${key}',this.value)">${options.map((o) => `<option value="${o[0]}" ${c[key] === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select>`;
  const chk = (key, label) => `<label class="rb-check"><input type="checkbox" ${c[key] ? 'checked' : ''} onchange="rbUpdateConfig('${id}','${key}',this.checked)"> ${label}</label>`;

  if (step.type === 'set_variable') {
    form += rbField('Nome da variável', inp('variable_name', 'minha_variavel'));
    form += rbField('Valor', ta('value', 'Pode usar {output}, {input} ou {outra_variavel}'));
  } else if (step.type === 'condition') {
    form += rbField('Operador', sel('operator', [['contains','contém'],['not_contains','não contém'],['equals','igual a'],['not_equals','diferente de'],['starts_with','começa com'],['ends_with','termina com'],['is_empty','está vazio'],['not_empty','não está vazio'],['greater_than','maior que'],['less_than','menor que']]));
    form += rbField('Valor de comparação', inp('condition_value'), 'Comparado contra o {output} do step anterior.');
  } else if (step.type === 'loop_count') {
    form += rbField('Quantas vezes', inp('count', '5'));
    form += rbField('Variável do índice (opcional)', inp('index_variable', 'i'));
  } else if (step.type === 'foreach') {
    form += rbField('Lista (JSON ou uma linha por item)', ta('list_source', '["a","b","c"]'));
    form += rbField('Variável do item', inp('item_variable', 'item'));
  } else if (step.type === 'try_catch') {
    form += `<div class="rb-hint">Roda "Tentar"; se algum step falhar, roda "Capturar" (com {error} preenchido) em vez de abortar a automação.</div>`;
  } else if (step.type === 'wait') {
    form += rbField('Segundos', inp('seconds', '5'));
  } else if (step.type === 'http_request' || step.type === 'http_request_retry') {
    form += rbField('Método', sel('method', [['GET','GET'],['POST','POST'],['PUT','PUT'],['PATCH','PATCH'],['DELETE','DELETE']]));
    form += rbField('URL', inp('url', 'https://...'));
    form += rbField('Headers', ta('headers', 'Chave: Valor (uma por linha)'));
    form += rbField('Corpo (body)', ta('body'));
    if (step.type === 'http_request_retry') form += rbField('Máx. tentativas', inp('max_iterations', '3'));
    form += rbField('Salvar resposta na variável', inp('variable_name'));
  } else if (step.type === 'send_email') {
    form += rbField('Para', inp('to', 'destino@email.com'));
    form += rbField('Assunto', inp('subject'));
    form += rbField('Corpo', ta('email_body', '', 5));
    form += chk('is_html', 'Corpo é HTML');
    form += `<div class="rb-hint">Usa o SMTP configurado em Configurações → SMTP.</div>`;
  } else if (step.type === 'call_ai_agent') {
    form += rbField('Mensagem (template)', ta('input_template', '{output}'));
    form += rbField('Mensagem de sistema (opcional)', ta('system_message', '', 2));
    form += rbField('Provedor (vazio = padrão da empresa)', sel('provedor', [['','Padrão da empresa'],['claude-sonnet','Claude Sonnet'],['claude-haiku','Claude Haiku'],['gpt-4o','GPT-4o'],['gpt-4','GPT-4'],['gemini','Gemini']]));
    form += rbField('Salvar resposta na variável', inp('variable_name'));
  } else if (step.type === 'ai_open') {
    form += rbRenderAiOpenForm(step, c);
  } else if (step.type === 'ai_chat') {
    form += rbField('Nome da sessão', inp('session_name', 'ex: assistente'));
    form += rbAiSessionNotice(c.session_name, false);
    form += rbField('Mensagem (template)', ta('input_template', '{output}', 4), 'Use {output} (resultado do step anterior), {input} ou {variavel}.');
    form += rbField('Salvar resposta na variável', inp('variable_name'));
  } else if (step.type === 'ai_close') {
    form += rbField('Nome da sessão', inp('session_name', 'ex: assistente'));
    form += rbAiSessionNotice(c.session_name, false);
    form += `<div class="rb-hint">Descarta o token e a memória da conversa desta sessão. Opcional: ao terminar a execução, toda sessão de IA aberta é descartada sozinha.</div>`;
  } else if (step.type === 'read_file') {
    form += rbField('Caminho do arquivo', inp('file_path', 'C:\\pasta\\arquivo.txt'));
    form += rbField('Salvar conteúdo na variável', inp('variable_name'));
    form += `<div class="rb-hint">Roda na máquina do tenant (precisa de um agente online).</div>`;
  } else if (step.type === 'write_file') {
    form += rbField('Caminho do arquivo', inp('file_path'));
    form += rbField('Conteúdo', ta('content'));
    form += chk('append', 'Adicionar ao final (em vez de sobrescrever)');
    form += `<div class="rb-hint">Roda na máquina do tenant (precisa de um agente online).</div>`;
  } else if (step.type === 'run_command') {
    form += rbField('Comando', ta('command', 'python script.py'));
    form += rbField('Timeout (segundos)', inp('timeout_seconds', '60'));
    form += rbField('Salvar saída na variável', inp('variable_name'));
    form += `<div class="rb-hint">Roda na máquina do tenant (precisa de um agente online).</div>`;
  } else if (step.type === 'browser_flow') {
    form += chk('headless', 'Sem interface visível (headless)');
    form += rbRenderBrowserActions(step);
    form += `<div class="rb-hint">Roda na máquina do tenant, um browser por execução (sem sessão persistente entre steps nesta versão).</div>`;
  } else if (step.type === 'comment') {
    form += rbField('Anotação', ta('text'));
  } else {
    // Steps de expansão (fora do MVP original) — formulário genérico
    // gerado a partir de `acao.fields` + RB_FIELD_META, em vez de um
    // formulário escrito à mão pra cada um dos ~100 tipos.
    for (const campo of (acao.fields || [])) {
      // Ações OpenAI: o campo de chave vira "sessão de IA (nome) OU token digitado".
      if (campo === 'api_key' && RB_AI_OPENAI_TYPES.has(step.type)) { form += rbAiKeyOrSession(id, c); continue; }
      if (campo === 'api_key' && RB_GDRIVE_TYPES.has(step.type)) { form += rbGDriveCredField(id, c); continue; }
      const meta = RB_FIELD_META[campo];
      if (!meta) continue;
      let campoHtml;
      if (meta.type === 'select') campoHtml = sel(campo, meta.options);
      else if (meta.type === 'textarea') campoHtml = ta(campo, meta.placeholder);
      else if (meta.type === 'checkbox') campoHtml = chk(campo, meta.label);
      else campoHtml = inp(campo, meta.placeholder);
      form += meta.type === 'checkbox' ? `<div class="rb-field">${campoHtml}</div>` : rbField(meta.label, campoHtml, meta.hint);
    }
    form += rbField('Salvar resultado na variável', inp('variable_name'));
    if (acao.agente) form += `<div class="rb-hint">Roda na máquina do tenant (precisa de um agente online).</div>`;
  }

  el.innerHTML = `<div class="rb-props-titulo"><span class="rb-step-icone" style="background:${acao.cor}22;color:${acao.cor}">${_rbIcon(acao.icone, 14, acao.cor)}</span> ${escapeHtmlRb(acao.label)}</div>${form}`;
}

function rbRenderBrowserActions(step) {
  const acoes = step.config.actions || (step.config.actions = []);
  const tipos = [['open','Abrir URL'],['click','Clicar'],['type','Digitar'],['wait','Aguardar (s)'],['extract','Extrair texto'],['screenshot','Screenshot']];
  let html = '<div class="rb-field"><label>Ações do navegador</label>';
  acoes.forEach((a, i) => {
    html += `
      <div style="display:flex;gap:4px;margin-bottom:4px">
        <select style="width:auto" onchange="rbUpdateBrowserAction('${step.id}',${i},'type',this.value)">
          ${tipos.map((t) => `<option value="${t[0]}" ${a.type === t[0] ? 'selected' : ''}>${t[1]}</option>`).join('')}
        </select>
        <input placeholder="seletor/URL" value="${escapeHtmlRb(a.target || '')}" oninput="rbUpdateBrowserAction('${step.id}',${i},'target',this.value)">
        <input placeholder="valor" value="${escapeHtmlRb(a.value || '')}" oninput="rbUpdateBrowserAction('${step.id}',${i},'value',this.value)">
        <button onclick="rbRemoveBrowserAction('${step.id}',${i})" style="border:none;background:none;color:#c53030;cursor:pointer">✕</button>
      </div>`;
  });
  html += `<button class="btn-secondary" style="width:100%;margin-top:4px" onclick="rbAddBrowserAction('${step.id}')">+ Ação</button></div>`;
  return html;
}

function rbUpdateBrowserAction(stepId, i, key, value) {
  const step = rbFindStep(stepId);
  if (!step?.config?.actions?.[i]) return;
  step.config.actions[i][key] = value;
  rbMarcarSujo();
}

function rbAddBrowserAction(stepId) {
  const step = rbFindStep(stepId);
  if (!step) return;
  (step.config.actions ||= []).push({ type: 'open', target: '', value: '' });
  rbMarcarSujo();
  rbRenderProps();
  rbRenderCanvas();
}

function rbRemoveBrowserAction(stepId, i) {
  const step = rbFindStep(stepId);
  if (!step?.config?.actions) return;
  step.config.actions.splice(i, 1);
  rbMarcarSujo();
  rbRenderProps();
  rbRenderCanvas();
}

// ==================== Drag and drop ====================

let rbDraggedTipo = null; // quando arrasta da paleta (ação nova)

function rbPaletteDragStart(ev, tipo) {
  rbDraggedTipo = tipo;
  rbDraggedId = null;
  ev.dataTransfer.effectAllowed = 'copy';
}

function rbStepDragStart(ev, stepId) {
  ev.stopPropagation();
  rbDraggedId = stepId;
  rbDraggedTipo = null;
  ev.dataTransfer.effectAllowed = 'move';
}

function rbZoneDragOver(ev) {
  ev.preventDefault();
  ev.currentTarget.classList.add('rb-over');
}
function rbZoneDragLeave(ev) {
  ev.currentTarget.classList.remove('rb-over');
}

function rbContainerArr(containerId, branchKey) {
  if (containerId === 'root') return rbSteps;
  const container = rbFindStep(containerId);
  if (!container) return null;
  const found = rbBranches(container).find(([k]) => k === branchKey);
  return found ? found[1] : null;
}

// true se `targetId` está dentro da árvore de `ancestorId` (soltar um
// container dentro de um dos seus próprios branches criaria um ciclo).
function rbIsDescendant(ancestorId, targetId) {
  const ancestor = rbFindStep(ancestorId);
  if (!ancestor) return false;
  for (const [, arr] of rbBranches(ancestor)) {
    for (const s of arr) {
      if (s.id === targetId || rbIsDescendant(s.id, targetId)) return true;
    }
  }
  return false;
}

function rbZoneDrop(ev, containerId, branchKey, index) {
  ev.preventDefault();
  ev.currentTarget.classList.remove('rb-over');
  const destArr = rbContainerArr(containerId, branchKey);
  if (!destArr) return;

  if (rbDraggedTipo) {
    destArr.splice(index, 0, rbCriarStep(rbDraggedTipo));
    rbDraggedTipo = null;
  } else if (rbDraggedId) {
    if (containerId !== 'root' && (containerId === rbDraggedId || rbIsDescendant(rbDraggedId, containerId))) {
      rbDraggedId = null;
      return; // soltaria o step dentro de si mesmo — ignora
    }
    const loc = rbFindLocation(rbDraggedId);
    if (!loc) return;
    const [item] = loc.arr.splice(loc.index, 1);
    let destIndex = index;
    if (loc.arr === destArr && loc.index < destIndex) destIndex -= 1;
    destArr.splice(destIndex, 0, item);
    rbDraggedId = null;
  } else {
    return;
  }
  rbMarcarSujo();
  rbRenderCanvas();
}

// ==================== Carregar / salvar ====================

function rbParamsUrl() {
  return new URLSearchParams(location.search);
}

async function rbCarregar() {
  rbCarregarDadosIA(); // em paralelo — só alimenta os seletores de credencial/provedor da sessão de IA
  const params = rbParamsUrl();
  rbAutomacaoId = params.get('automacaoId');
  rbRoboId = params.get('roboId');
  if (!rbAutomacaoId) { rbRenderPalette(); rbRenderCanvas(); return; }
  try {
    const automacao = await rbApi('GET', `/api/automacoes/${rbAutomacaoId}`);
    document.getElementById('rbNome').value = automacao.nome || '';
    document.getElementById('rbDesc').value = automacao.descricao || '';
    rbSteps = JSON.parse(JSON.stringify(automacao.steps || []));
    rbRoboId = automacao.roboId || rbRoboId;
  } catch (e) {
    rbToast('Erro ao carregar automação: ' + e.message, 'error');
  }
  rbRenderPalette();
  rbRenderCanvas();
}

async function rbSalvar() {
  const nome = document.getElementById('rbNome').value.trim();
  if (!nome) { rbToast('Dê um nome pro robô antes de salvar.', 'error'); return; }
  const descricao = document.getElementById('rbDesc').value.trim();
  const btn = document.getElementById('rbBtnSalvar');
  btn.disabled = true;
  try {
    let automacao;
    if (rbAutomacaoId) {
      automacao = await rbApi('PATCH', `/api/automacoes/${rbAutomacaoId}`, { nome, descricao, steps: rbSteps });
    } else {
      automacao = await rbApi('POST', '/api/automacoes', { nome, descricao, steps: rbSteps, gatilho: { tipo: 'manual' } });
      rbAutomacaoId = automacao._id;
    }

    if (!rbRoboId) {
      const robo = await rbApi('POST', '/api/robos', {
        nome, descricao, origem: 'builder', automacaoId: automacao._id, ambiente: 'local',
      });
      rbRoboId = robo._id;
      await rbApi('PATCH', `/api/automacoes/${rbAutomacaoId}`, { roboId: rbRoboId }).catch(() => {});
      history.replaceState(null, '', `/robo-builder?automacaoId=${rbAutomacaoId}&roboId=${rbRoboId}`);
    } else {
      // Edição de um robô já existente: mantém nome/descrição do card (Robô) iguais aos do
      // fluxo — senão renomear no Studio não apareceria na lista de Robôs.
      await rbApi('PUT', `/api/robos/${rbRoboId}`, { nome, descricao }).catch(() => {});
    }

    rbEmpresaSteps = false;
    document.getElementById('rbStatusTxt').textContent = 'Salvo ' + new Date().toLocaleTimeString('pt-BR');
    rbToast('Robô salvo!', 'success');
  } catch (e) {
    rbToast('Erro ao salvar: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function rbVoltar() {
  if (rbEmpresaSteps && !confirm('Existem alterações não salvas. Sair mesmo assim?')) return;
  location.href = '/operacoes';
}

// ==================== Rodar / acompanhar ====================

async function rbExecutarInline() {
  if (!rbAutomacaoId) { rbToast('Salve o robô antes de rodar.', 'error'); return; }
  if (rbEmpresaSteps) { rbToast('Salve as alterações antes de rodar.', 'error'); return; }
  const painel = document.getElementById('rbLogPanel');
  painel.classList.add('aberto');
  painel.innerHTML = '<div class="rb-log-linha">Disparando...</div>';
  try {
    const run = await rbApi('POST', `/api/automacoes/${rbAutomacaoId}/run`, {});
    rbPollRun(run._id, painel);
  } catch (e) {
    painel.innerHTML += `<div class="rb-log-linha failed">Erro: ${escapeHtmlRb(e.message)}</div>`;
  }
}

function rbPollRun(runId, painel) {
  if (rbPollTimer) clearTimeout(rbPollTimer);
  const mostrados = new Set();
  const tick = async () => {
    let run;
    try { run = await rbApi('GET', `/api/automacoes/${rbAutomacaoId}/runs/${runId}`); }
    catch (e) { painel.innerHTML += `<div class="rb-log-linha failed">${escapeHtmlRb(e.message)}</div>`; return; }

    for (const s of run.stepsResult || []) {
      const chave = s.stepId + ':' + s.status;
      if (mostrados.has(chave)) continue;
      mostrados.add(chave);
      const linha = document.createElement('div');
      linha.className = `rb-log-linha ${s.status}`;
      linha.textContent = `${s.stepName} (${s.stepType}) — ${s.status}${s.error ? ': ' + s.error : ''} [${s.durationMs}ms]`;
      painel.appendChild(linha);
      painel.scrollTop = painel.scrollHeight;
    }

    if (run.status === 'running') {
      rbPollTimer = setTimeout(tick, 500);
    } else {
      const linha = document.createElement('div');
      linha.className = `rb-log-linha ${run.status === 'success' ? 'success' : 'failed'}`;
      linha.textContent = `— ${run.status.toUpperCase()} — saída final: ${run.output || ''}`;
      painel.appendChild(linha);
    }
  };
  tick();
}

// ==================== Boot ====================

document.addEventListener('DOMContentLoaded', rbCarregar);
