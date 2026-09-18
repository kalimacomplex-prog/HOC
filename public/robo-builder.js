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

// ==================== Estado ====================

let rbSteps = [];
let rbAutomacaoId = null;
let rbRoboId = null;
let rbEmpresaSteps = false; // marca se algo mudou desde o último save
let rbSelectedId = null;
let rbDraggedId = null;
let rbBusca = '';
let rbPollTimer = null;

const RB_ACOES = [
  { tipo: 'comment', label: 'Comentário', icone: '💬', cor: '#a0aec0', cat: 'Anotação' },
  { tipo: 'set_variable', label: 'Definir variável', icone: '{x}', cor: '#3b5bdb', cat: 'Variáveis' },
  { tipo: 'condition', label: 'Condição (Se/Senão)', icone: '?', cor: '#dd6b20', cat: 'Controle de fluxo', container: true },
  { tipo: 'loop_count', label: 'Repetir N vezes', icone: '↻', cor: '#dd6b20', cat: 'Controle de fluxo', container: true },
  { tipo: 'foreach', label: 'Para cada item', icone: '∀', cor: '#dd6b20', cat: 'Controle de fluxo', container: true },
  { tipo: 'try_catch', label: 'Tentar / Capturar', icone: '!', cor: '#dd6b20', cat: 'Controle de fluxo', container: true },
  { tipo: 'wait', label: 'Aguardar', icone: '⏱', cor: '#718096', cat: 'Controle de fluxo' },
  { tipo: 'http_request', label: 'Requisição HTTP', icone: '⇄', cor: '#2b6cb0', cat: 'HTTP' },
  { tipo: 'http_request_retry', label: 'HTTP com retry', icone: '⇄+', cor: '#2b6cb0', cat: 'HTTP' },
  { tipo: 'send_email', label: 'Enviar e-mail', icone: '✉', cor: '#2b6cb0', cat: 'Comunicação' },
  { tipo: 'call_ai_agent', label: 'Chamar IA', icone: '✨', cor: '#6b46c1', cat: 'Inteligência Artificial' },
  { tipo: 'read_file', label: 'Ler arquivo', icone: '📄', cor: '#276749', cat: 'Arquivos (na máquina)' },
  { tipo: 'write_file', label: 'Escrever arquivo', icone: '📝', cor: '#276749', cat: 'Arquivos (na máquina)' },
  { tipo: 'run_command', label: 'Rodar comando', icone: '>_', cor: '#1a202c', cat: 'Sistema (na máquina)' },
  { tipo: 'browser_flow', label: 'Fluxo de navegador', icone: '🌐', cor: '#c53030', cat: 'Browser (na máquina)' },

  // ---- Sessão de browser persistente entre steps ----
  { tipo: 'browser_open', label: 'Abrir sessão de navegador', icone: '🌐+', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name', 'target', 'headless', 'browser_profile'], agente: true },
  { tipo: 'browser_click', label: 'Clicar (sessão)', icone: '👆', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name', 'target'], agente: true },
  { tipo: 'browser_type', label: 'Digitar (sessão)', icone: '⌨', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name', 'target', 'value'], agente: true },
  { tipo: 'browser_extract', label: 'Extrair texto (sessão)', icone: '📋', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name', 'target'], agente: true },
  { tipo: 'browser_wait', label: 'Aguardar elemento (sessão)', icone: '⏳', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name', 'target', 'seconds', 'timeout_seconds'], agente: true },
  { tipo: 'browser_screenshot', label: 'Screenshot (sessão)', icone: '📸', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name', 'target'], agente: true },
  { tipo: 'browser_close', label: 'Fechar sessão de navegador', icone: '🌐✕', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name'], agente: true },
  { tipo: 'browser_captcha_detect', label: 'Captcha foi resolvido?', icone: '🤖', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name'], agente: true },
  { tipo: 'browser_captcha_wait', label: 'Aguardar resolução de captcha', icone: '🤖⏳', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name', 'timeout_seconds'], agente: true },
  { tipo: 'browser_captcha_solve_image', label: 'Capturar imagem do captcha', icone: '🤖📸', cor: '#c53030', cat: 'Browser com sessão (na máquina)', fields: ['session_name', 'target'], agente: true },

  // ---- Expansão (formulário genérico por metadados de campo, ver RB_FIELD_META) ----
  { tipo: 'calculate', label: 'Calcular expressão', icone: 'ƒx', cor: '#3b5bdb', cat: 'Variáveis', fields: ['expression'] },

  { tipo: 'date_diff', label: 'Diferença entre datas', icone: '📅', cor: '#718096', cat: 'Data/hora', fields: ['date_from', 'date_to', 'unit'] },
  { tipo: 'date_add', label: 'Somar/subtrair data', icone: '📅', cor: '#718096', cat: 'Data/hora', fields: ['date', 'date_amount', 'unit'] },
  { tipo: 'timezone_convert', label: 'Converter fuso horário', icone: '🕐', cor: '#718096', cat: 'Data/hora', fields: ['date', 'to_timezone'] },
  { tipo: 'is_business_day', label: 'É dia útil?', icone: '📅', cor: '#718096', cat: 'Data/hora', fields: ['date'] },
  { tipo: 'format_date', label: 'Formatar data', icone: '📅', cor: '#718096', cat: 'Data/hora', fields: ['date', 'format'] },

  { tipo: 'list_files', label: 'Listar arquivos', icone: '📁', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['directory', 'pattern'], agente: true },
  { tipo: 'delete_file', label: 'Excluir arquivo', icone: '🗑', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['file_path'], agente: true },
  { tipo: 'copy_file', label: 'Copiar arquivo', icone: '📋', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['source_path', 'dest_path'], agente: true },
  { tipo: 'move_file', label: 'Mover arquivo', icone: '➡', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['source_path', 'dest_path'], agente: true },
  { tipo: 'file_hash', label: 'Hash de arquivo', icone: '#', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['file_path', 'hash_algo'], agente: true },
  { tipo: 'file_info', label: 'Info do arquivo', icone: 'ℹ', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['file_path'], agente: true },
  { tipo: 'search_in_files', label: 'Buscar em arquivos', icone: '🔍', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['directory', 'pattern', 'value'], agente: true },
  { tipo: 'convert_encoding', label: 'Converter encoding', icone: '🔤', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['file_path', 'encoding_from', 'encoding_to'], agente: true },
  { tipo: 'delete_folder', label: 'Excluir pasta', icone: '🗑', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['directory'], agente: true },
  { tipo: 'ensure_dir', label: 'Garantir pasta', icone: '📁', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['directory'], agente: true },
  { tipo: 'backup_folder', label: 'Backup de pasta', icone: '💾', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['directory'], agente: true },
  { tipo: 'zip_files', label: 'Compactar (zip)', icone: '🗜', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['data_input'] },
  { tipo: 'unzip_file', label: 'Descompactar (zip)', icone: '🗜', cor: '#276749', cat: 'Arquivos (na máquina)', fields: ['file_base64'] },

  { tipo: 'read_excel', label: 'Ler Excel', icone: '📊', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['file_base64', 'sheet_name'] },
  { tipo: 'write_excel', label: 'Escrever Excel', icone: '📊', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'sheet_name'] },
  { tipo: 'read_csv', label: 'Ler CSV', icone: '📊', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['file_base64', 'delimiter'] },
  { tipo: 'write_csv', label: 'Escrever CSV', icone: '📊', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'delimiter'] },
  { tipo: 'write_row', label: 'Adicionar linha', icone: '➕', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'value'] },
  { tipo: 'write_cell', label: 'Escrever célula', icone: '✏', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'row_index', 'cell_ref', 'value'] },
  { tipo: 'remove_row', label: 'Remover linha', icone: '➖', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'row_index'] },
  { tipo: 'remove_cell', label: 'Remover célula', icone: '➖', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'row_index', 'cell_ref'] },
  { tipo: 'filter_data', label: 'Filtrar dados', icone: '🔽', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'cell_ref', 'operator', 'value'] },
  { tipo: 'merge_data', label: 'Combinar dados', icone: '🔗', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'data_input2', 'merge_key'] },
  { tipo: 'dedupe_data', label: 'Remover duplicados', icone: '🧹', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'cell_ref'] },
  { tipo: 'sort_group_data', label: 'Ordenar dados', icone: '↕', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'sort_key'] },
  { tipo: 'sql_on_data', label: 'SQL sobre dados', icone: '🗄', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['data_input', 'sql_query'] },
  { tipo: 'generate_fake_data', label: 'Gerar dados fake', icone: '🎲', cor: '#2f7a3d', cat: 'Planilhas/dados', fields: ['fake_type', 'fake_count'] },

  { tipo: 'pdf_extract_text', label: 'Extrair texto de PDF', icone: '📕', cor: '#c53030', cat: 'PDF', fields: ['file_base64'] },
  { tipo: 'pdf_extract_tables', label: 'Extrair tabelas de PDF', icone: '📕', cor: '#c53030', cat: 'PDF', fields: ['file_base64'] },
  { tipo: 'pdf_merge', label: 'Juntar PDFs', icone: '📕', cor: '#c53030', cat: 'PDF', fields: ['data_input'] },
  { tipo: 'pdf_split', label: 'Separar PDF', icone: '📕', cor: '#c53030', cat: 'PDF', fields: ['file_base64'] },
  { tipo: 'pdf_generate', label: 'Gerar PDF', icone: '📕', cor: '#c53030', cat: 'PDF', fields: ['content'] },
  { tipo: 'pdf_fill_form', label: 'Preencher formulário PDF', icone: '📕', cor: '#c53030', cat: 'PDF', fields: ['file_base64', 'data_input'] },

  { tipo: 'validate_json_schema', label: 'Validar JSON Schema', icone: '✔', cor: '#805ad5', cat: 'ETL/formatos', fields: ['data_input', 'schema_input'] },
  { tipo: 'convert_data_format', label: 'Converter formato de dados', icone: '🔄', cor: '#805ad5', cat: 'ETL/formatos', fields: ['data_input', 'format_from', 'format_to'] },
  { tipo: 'html_extract', label: 'Extrair de HTML', icone: '🌐', cor: '#805ad5', cat: 'ETL/formatos', fields: ['data_input', 'css_selector'] },

  { tipo: 'validate_cpf_cnpj', label: 'Validar CPF/CNPJ', icone: '🇧🇷', cor: '#2f855a', cat: 'Validação BR', fields: ['value'] },
  { tipo: 'validate_email', label: 'Validar e-mail', icone: '🇧🇷', cor: '#2f855a', cat: 'Validação BR', fields: ['value'] },
  { tipo: 'validate_phone', label: 'Validar telefone', icone: '🇧🇷', cor: '#2f855a', cat: 'Validação BR', fields: ['value'] },
  { tipo: 'lookup_cep', label: 'Consultar CEP', icone: '🇧🇷', cor: '#2f855a', cat: 'Validação BR', fields: ['value'] },
  { tipo: 'format_currency', label: 'Formatar moeda', icone: '🇧🇷', cor: '#2f855a', cat: 'Validação BR', fields: ['value', 'currency'] },

  { tipo: 'encrypt_text', label: 'Criptografar texto', icone: '🔒', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['value', 'secret_key'] },
  { tipo: 'decrypt_text', label: 'Descriptografar texto', icone: '🔓', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['value', 'secret_key'] },
  { tipo: 'generate_jwt', label: 'Gerar JWT', icone: '🔑', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['data_input', 'secret_key', 'expires_in'] },
  { tipo: 'verify_jwt', label: 'Verificar JWT', icone: '🔑', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['value', 'secret_key'] },
  { tipo: 'hash_password', label: 'Hash de senha', icone: '🔑', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['value'] },
  { tipo: 'verify_password', label: 'Verificar senha', icone: '🔑', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['value', 'password_hash'] },
  { tipo: 'generate_otp', label: 'Gerar código OTP', icone: '🔢', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['secret_key'] },
  { tipo: 'verify_otp', label: 'Verificar código OTP', icone: '🔢', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['value', 'secret_key'] },
  { tipo: 'generate_secure_password', label: 'Gerar senha segura', icone: '🔑', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['password_length'] },
  { tipo: 'check_ssl_cert', label: 'Checar certificado SSL', icone: '🔒', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['url'] },
  { tipo: 'hmac_sign', label: 'Assinar HMAC', icone: '🔑', cor: '#1a202c', cat: 'Segurança/cripto', fields: ['value', 'secret_key'] },

  { tipo: 'send_telegram', label: 'Enviar Telegram', icone: '✈', cor: '#2b6cb0', cat: 'Comunicação', fields: ['api_key', 'to', 'email_body'] },
  { tipo: 'send_slack', label: 'Enviar Slack', icone: '💬', cor: '#2b6cb0', cat: 'Comunicação', fields: ['url', 'email_body'] },
  { tipo: 'send_discord', label: 'Enviar Discord', icone: '💬', cor: '#2b6cb0', cat: 'Comunicação', fields: ['url', 'email_body'] },
  { tipo: 'send_sms', label: 'Enviar SMS', icone: '📱', cor: '#2b6cb0', cat: 'Comunicação', fields: ['api_key', 'api_secret', 'from_number', 'to', 'email_body'] },
  { tipo: 'send_whatsapp', label: 'Enviar WhatsApp', icone: '📱', cor: '#2b6cb0', cat: 'Comunicação', fields: ['api_key', 'api_secret', 'from_number', 'to', 'email_body'] },
  { tipo: 'read_email_imap', label: 'Ler e-mails (IMAP)', icone: '📧', cor: '#2b6cb0', cat: 'Comunicação', fields: ['host', 'port', 'api_key', 'secret_key'] },
  { tipo: 'send_push_notification', label: 'Enviar push notification', icone: '🔔', cor: '#2b6cb0', cat: 'Comunicação', fields: ['api_key', 'api_secret', 'to', 'email_body'] },
  { tipo: 'create_incident', label: 'Criar incidente (PagerDuty)', icone: '🚨', cor: '#2b6cb0', cat: 'Comunicação', fields: ['api_key', 'email_body'] },

  { tipo: 'asaas_create_charge', label: 'Criar cobrança (Asaas)', icone: '💳', cor: '#dd6b20', cat: 'Pagamentos', fields: ['api_key', 'data_input'] },
  { tipo: 'asaas_check_payment', label: 'Checar pagamento (Asaas)', icone: '💳', cor: '#dd6b20', cat: 'Pagamentos', fields: ['api_key', 'value'] },
  { tipo: 'generate_pix_qr', label: 'Gerar QR Pix', icone: '💠', cor: '#dd6b20', cat: 'Pagamentos', fields: ['pix_key', 'merchant_name', 'merchant_city', 'amount'] },
  { tipo: 'get_currency_rate', label: 'Cotação de moeda', icone: '💱', cor: '#dd6b20', cat: 'Pagamentos', fields: ['value'] },
  { tipo: 'get_crypto_price', label: 'Preço de criptomoeda', icone: '₿', cor: '#dd6b20', cat: 'Pagamentos', fields: ['value'] },

  { tipo: 'get_weather', label: 'Consultar clima', icone: '🌤', cor: '#3182ce', cat: 'APIs externas', fields: ['api_key', 'value'] },
  { tipo: 'geocode_address', label: 'Geocodificar endereço', icone: '📍', cor: '#3182ce', cat: 'APIs externas', fields: ['value'] },
  { tipo: 'calculate_distance', label: 'Calcular distância', icone: '📏', cor: '#3182ce', cat: 'APIs externas', fields: ['coord_from', 'coord_to'] },
  { tipo: 'shorten_url', label: 'Encurtar URL', icone: '🔗', cor: '#3182ce', cat: 'APIs externas', fields: ['url'] },
  { tipo: 'lookup_cnpj', label: 'Consultar CNPJ', icone: '🏢', cor: '#3182ce', cat: 'APIs externas', fields: ['value'] },
  { tipo: 'get_holidays', label: 'Feriados (BR)', icone: '📅', cor: '#3182ce', cat: 'APIs externas', fields: ['value'] },
  { tipo: 'translate_text', label: 'Traduzir texto', icone: '🌍', cor: '#3182ce', cat: 'APIs externas', fields: ['api_key', 'value', 'target_lang'] },

  { tipo: 'download_file', label: 'Baixar arquivo', icone: '⬇', cor: '#3182ce', cat: 'Web/scraping', fields: ['url'] },
  { tipo: 'upload_file', label: 'Enviar arquivo', icone: '⬆', cor: '#3182ce', cat: 'Web/scraping', fields: ['url', 'file_base64'] },
  { tipo: 'scrape_html_table', label: 'Extrair tabela HTML', icone: '📋', cor: '#3182ce', cat: 'Web/scraping', fields: ['data_input', 'css_selector'] },
  { tipo: 'read_rss_feed', label: 'Ler feed RSS', icone: '📡', cor: '#3182ce', cat: 'Web/scraping', fields: ['url'] },

  { tipo: 'detect_language', label: 'Detectar idioma', icone: '🌍', cor: '#6b46c1', cat: 'Texto/NLP', fields: ['value'] },
  { tipo: 'count_tokens', label: 'Contar tokens', icone: '🔢', cor: '#6b46c1', cat: 'Texto/NLP', fields: ['value'] },
  { tipo: 'compare_texts', label: 'Comparar textos', icone: '⚖', cor: '#6b46c1', cat: 'Texto/NLP', fields: ['data_input', 'data_input2'] },

  { tipo: 'generate_embedding', label: 'Gerar embedding', icone: '✨', cor: '#6b46c1', cat: 'Inteligência Artificial', fields: ['api_key', 'value'] },
  { tipo: 'semantic_search', label: 'Busca semântica', icone: '✨', cor: '#6b46c1', cat: 'Inteligência Artificial', fields: ['value', 'data_input'] },
  { tipo: 'moderate_content', label: 'Moderar conteúdo', icone: '✨', cor: '#6b46c1', cat: 'Inteligência Artificial', fields: ['api_key', 'value'] },
  { tipo: 'generate_ai_image', label: 'Gerar imagem IA', icone: '🎨', cor: '#6b46c1', cat: 'Inteligência Artificial', fields: ['api_key', 'value'] },
  { tipo: 'transcribe_audio', label: 'Transcrever áudio', icone: '🎙', cor: '#6b46c1', cat: 'Inteligência Artificial', fields: ['api_key', 'file_base64'] },
  { tipo: 'text_to_speech', label: 'Texto pra fala', icone: '🔊', cor: '#6b46c1', cat: 'Inteligência Artificial', fields: ['api_key', 'value', 'provedor'] },

  { tipo: 'check_port_open', label: 'Checar porta aberta', icone: '🔌', cor: '#1a202c', cat: 'Sistema/rede', fields: ['target', 'value'] },
  { tipo: 'dns_lookup', label: 'Consultar DNS', icone: '🌐', cor: '#1a202c', cat: 'Sistema/rede', fields: ['target'] },
  { tipo: 'whois_lookup', label: 'Consultar WHOIS', icone: '🌐', cor: '#1a202c', cat: 'Sistema/rede', fields: ['value'] },
  { tipo: 'ssh_execute', label: 'Executar via SSH', icone: '🖥', cor: '#1a202c', cat: 'Sistema/rede', fields: ['target', 'port', 'api_key', 'secret_key', 'command'] },
  { tipo: 'read_env_var', label: 'Ler variável de ambiente', icone: '⚙', cor: '#1a202c', cat: 'Sistema/rede', fields: ['value'] },
  { tipo: 'check_url_uptime', label: 'Checar disponibilidade (URL)', icone: '📶', cor: '#1a202c', cat: 'Sistema/rede', fields: ['url'] },
  { tipo: 'system_stats', label: 'Estatísticas do sistema', icone: '📊', cor: '#1a202c', cat: 'Sistema (na máquina)', fields: [], agente: true },
  { tipo: 'list_processes', label: 'Listar processos', icone: '📋', cor: '#1a202c', cat: 'Sistema (na máquina)', fields: [], agente: true },

  { tipo: 'redis_get', label: 'Redis: ler chave', icone: '🗄', cor: '#805ad5', cat: 'Banco/fila', fields: ['url', 'value'] },
  { tipo: 'redis_set', label: 'Redis: gravar chave', icone: '🗄', cor: '#805ad5', cat: 'Banco/fila', fields: ['url', 'cell_ref', 'content'] },
  { tipo: 'queue_push', label: 'Fila: empilhar', icone: '📥', cor: '#805ad5', cat: 'Banco/fila', fields: ['url', 'value', 'content'] },
  { tipo: 'queue_pop', label: 'Fila: desempilhar', icone: '📤', cor: '#805ad5', cat: 'Banco/fila', fields: ['url', 'value'] },
  { tipo: 'sql_query_external', label: 'SQL externo (Postgres)', icone: '🗄', cor: '#805ad5', cat: 'Banco/fila', fields: ['api_key', 'sql_query'] },

  { tipo: 'render_template', label: 'Renderizar template', icone: '📄', cor: '#dd6b20', cat: 'Templates/documentos', fields: ['content'] },
  { tipo: 'generate_word_doc', label: 'Gerar documento Word', icone: '📄', cor: '#dd6b20', cat: 'Templates/documentos', fields: ['content'] },
  { tipo: 'generate_pptx', label: 'Gerar apresentação PPTX', icone: '📊', cor: '#dd6b20', cat: 'Templates/documentos', fields: ['content'] },

  { tipo: 'resize_image', label: 'Redimensionar imagem', icone: '🖼', cor: '#c53030', cat: 'Imagens', fields: ['file_base64', 'width', 'height'] },
  { tipo: 'convert_image_format', label: 'Converter formato de imagem', icone: '🖼', cor: '#c53030', cat: 'Imagens', fields: ['file_base64', 'format_to'] },
  { tipo: 'add_watermark', label: 'Adicionar marca d\'água', icone: '🖼', cor: '#c53030', cat: 'Imagens', fields: ['file_base64', 'value'] },
  { tipo: 'generate_thumbnail', label: 'Gerar miniatura', icone: '🖼', cor: '#c53030', cat: 'Imagens', fields: ['file_base64', 'width', 'height'] },
  { tipo: 'generate_qrcode', label: 'Gerar QR code', icone: '⬛', cor: '#c53030', cat: 'Imagens', fields: ['value'] },
  { tipo: 'read_qrcode', label: 'Ler QR code', icone: '⬛', cor: '#c53030', cat: 'Imagens', fields: ['file_base64'] },
  { tipo: 'compare_images', label: 'Comparar imagens', icone: '🖼', cor: '#c53030', cat: 'Imagens', fields: ['data_input', 'data_input2'] },
  { tipo: 'ocr_image', label: 'OCR de imagem', icone: '🔤', cor: '#c53030', cat: 'Imagens', fields: ['file_base64', 'ocr_lang'] },

  { tipo: 'transcode_media', label: 'Converter mídia', icone: '🎬', cor: '#805ad5', cat: 'Áudio/vídeo (na máquina)', fields: ['source_path', 'dest_path'], agente: true },
  { tipo: 'extract_audio', label: 'Extrair áudio de vídeo', icone: '🎵', cor: '#805ad5', cat: 'Áudio/vídeo (na máquina)', fields: ['source_path', 'dest_path'], agente: true },
  { tipo: 'trim_media', label: 'Cortar mídia', icone: '✂', cor: '#805ad5', cat: 'Áudio/vídeo (na máquina)', fields: ['source_path', 'dest_path', 'value', 'seconds'], agente: true },
  { tipo: 'extract_video_frame', label: 'Extrair frame de vídeo', icone: '🎬', cor: '#805ad5', cat: 'Áudio/vídeo (na máquina)', fields: ['source_path', 'dest_path', 'value'], agente: true },
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
          <span class="rb-acao-dot" style="background:${a.cor}"></span>
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
  const acao = RB_ACOES_MAP[step.type] || { label: step.type, icone: '•', cor: '#718096' };
  const num = numeros[step.id];
  const desativado = step.enabled === false;
  const branches = rbBranches(step);
  const isContainer = branches.length > 0;

  const cardHtml = `
    <div class="rb-step ${rbSelectedId === step.id ? 'selecionado' : ''}" style="${desativado ? 'opacity:.45' : ''}"
         draggable="true" ondragstart="rbStepDragStart(event,'${step.id}')"
         onclick="rbSelectStep('${step.id}', event)">
      <span class="rb-step-num">${num}</span>
      <span class="rb-step-icone" style="background:${acao.cor}22;color:${acao.cor}">${acao.icone}</span>
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

function rbRenderProps() {
  const el = document.getElementById('rbProps');
  if (!rbSelectedId) { el.innerHTML = '<div class="rb-props-placeholder">Selecione um step no canvas pra configurar, ou clique numa ação da paleta pra adicionar.</div>'; return; }
  const step = rbFindStep(rbSelectedId);
  if (!step) { el.innerHTML = ''; return; }
  const acao = RB_ACOES_MAP[step.type] || { label: step.type, icone: '•', cor: '#718096' };
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

  el.innerHTML = `<div class="rb-props-titulo"><span class="rb-step-icone" style="background:${acao.cor}22;color:${acao.cor}">${acao.icone}</span> ${escapeHtmlRb(acao.label)}</div>${form}`;
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
