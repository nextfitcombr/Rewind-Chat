"use strict";

// O Firefox expõe as APIs em `browser.*` retornando promise; o `chrome.*`
// dele é a camada de compatibilidade baseada em callback. Como este código
// usa promise (`await ...storage.local.get()`), preferimos `browser` quando
// ele existe. No Chrome/Brave `browser` é undefined e nada muda.
//
// Usa nome próprio em vez de redeclarar `chrome`: `const chrome` no escopo
// global lançaria SyntaxError se `chrome` for propriedade não-configurável.
const api = globalThis.browser || globalThis.chrome;

async function obterChaveSalva() {
  const { geminiKey } = await api.storage.local.get("geminiKey");
  return geminiKey || "";
}

async function semearChaveDoConfigLocal() {
  try {
    const resp = await fetch(api.runtime.getURL("config.local.js"));
    if (!resp.ok) return "";
    const texto = await resp.text();
    const match = texto.match(/iaKey\s*:\s*["']([^"']+)["']/);
    if (!match || !match[1]) return "";
    await api.storage.local.set({ geminiKey: match[1] });
    return match[1];
  } catch (_) {
    return "";
  }
}

function arrayBufferParaBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const TAMANHO_BLOCO = 0x8000;
  let binario = "";
  for (let i = 0; i < bytes.length; i += TAMANHO_BLOCO) {
    binario += String.fromCharCode.apply(null, bytes.subarray(i, i + TAMANHO_BLOCO));
  }
  return btoa(binario);
}

const MIME_TYPES_AUDIO_POR_EXTENSAO = {
  ogg: "audio/ogg",
  oga: "audio/ogg",
  mp3: "audio/mp3",
  wav: "audio/wav",
  aac: "audio/aac",
  aiff: "audio/aiff",
  flac: "audio/flac",
  m4a: "audio/aac",
};

// O S3 costuma devolver content-type genérico (ex: application/ogg), que o
// Gemini rejeita. A extensão do arquivo na URL é mais confiável.
function mimeTypeDoAudio(url, contentType) {
  const extensao = (url.split("?")[0].split(".").pop() || "").toLowerCase();
  if (MIME_TYPES_AUDIO_POR_EXTENSAO[extensao]) {
    return MIME_TYPES_AUDIO_POR_EXTENSAO[extensao];
  }
  if (contentType && contentType.startsWith("audio/")) return contentType;
  return "audio/ogg";
}

async function baixarAudioBase64(url) {
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const mimeType = mimeTypeDoAudio(url, resp.headers.get("content-type"));
  return { base64: arrayBufferParaBase64(buffer), mimeType };
}

async function resolverPartes(partes) {
  return Promise.all(
    (partes || []).map(async (parte) => {
      if (!parte.audioUrl) return parte;
      try {
        const { base64, mimeType } = await baixarAudioBase64(parte.audioUrl);
        return { inlineData: { mimeType, data: base64 } };
      } catch (erro) {
        return { text: "[Não foi possível baixar este áudio para transcrição]" };
      }
    })
  );
}

function aguardarMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 503 (modelo sobrecarregado) e 429 (limite de uso) costumam ser picos
// transitórios do lado do Gemini — tenta de novo com backoff em vez de
// obrigar o usuário a refazer a leitura da tela + download de áudio.
//
// Reduzimos pra 3 tentativas com teto de 8s (era 4 tentativas / 15s): no
// pior caso isso corta o tempo perdido em espera de ~29s pra ~10s. Ainda dá
// resiliência pra picos curtos sem deixar o agente esperando quase meio
// minuto só de backoff quando o modelo está sobrecarregado.
async function chamarGeminiComRetry(url, body, onTentativa, tentativas = 3) {
  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (resp.ok) return resp;

    const status = resp.status;
    const retentavel = status === 503 || status === 429 || status >= 500;
    if (!retentavel || tentativa === tentativas) {
      const corpo = await resp.text().catch(() => "");
      let dica = "";
      if (status === 400) dica = " (chave da API do Gemini inválida)";
      if (status === 429) dica = " (limite de uso da IA atingido, tente novamente em instantes)";
      if (status === 503) dica = " (modelo sobrecarregado no momento, tente novamente em instantes)";
      const falha = new Error(`A IA retornou ${status}${dica}. ${corpo}`);
      // Modelo sem suporte a raciocínio configurável: o chamador repete a
      // chamada sem o campo em vez de devolver erro ao agente.
      falha.raciocinioRecusado = status === 400 && /thinking/i.test(corpo);
      // Marca o erro como transitório: em vez de desistir e obrigar o agente
      // a refazer tudo, o chamador reagenda o trabalho (que já está guardado
      // com o tipo de resumo escolhido e a transcrição pronta).
      falha.retentavel = retentavel;
      throw falha;
    }

    // Jitter: a extensão roda em vários agentes ao mesmo tempo e um pico de
    // 503 atinge todos juntos. Sem isso, todos voltariam a bater na API no
    // mesmo instante e só prolongariam a sobrecarga.
    const espera = Math.min(2000 * 2 ** (tentativa - 1), 8000) + Math.floor(Math.random() * 1000);
    console.warn(`[rwc] Gemini retornou ${status}, tentando de novo em ${espera}ms (tentativa ${tentativa}/${tentativas})`);
    if (onTentativa) onTentativa(tentativa + 1, tentativas);
    await aguardarMs(espera);
  }
}

// Quanto raciocínio interno o modelo pode gastar ANTES de escrever a
// resposta. É o parâmetro que mais pesa no tempo: sem limite, um modelo
// Gemini 3 "pensa" por vários segundos e ainda consome parte do
// maxOutputTokens com isso (era por isso que 2048 tokens cortavam o resumo
// detalhado no meio). Resumir uma transcrição dentro de um template fixo não
// precisa disso — MINIMAL é "little to no thinking" na definição da API. O
// detalhado fica em LOW porque ele ainda precisa organizar ponto a ponto o
// que foi tratado na conversa.
const NIVEL_RACIOCINIO = {
  breve: "MINIMAL",
  normal: "MINIMAL",
  detalhado: "LOW",
  sugestao: "MINIMAL",
  cancelamento: "MINIMAL",
  downgrade: "MINIMAL",
  treinamento: "MINIMAL",
  anotacao: "MINIMAL",
  clear: "MINIMAL",
};

// thinkingConfig só existe em modelos que suportam raciocínio (Gemini 3+).
// Se o modelo for trocado um dia por um que não aceite o campo, a API
// devolve 400 — em vez de quebrar a extensão inteira, a primeira recusa
// desliga o campo e guarda isso aqui.
async function raciocinioDesligado() {
  try {
    const { rwcSemRaciocinio } = await api.storage.local.get("rwcSemRaciocinio");
    return !!rwcSemRaciocinio;
  } catch (_) {
    return false;
  }
}

// Devolve, junto do texto, quanto tempo cada etapa levou — é isso que
// realimenta a estimativa das próximas gerações. `aoTerminarAudios` avisa
// no instante em que os áudios saem do caminho e só sobra a espera pela IA,
// para a barra de progresso trocar de fase (e de estimativa) na hora certa.
async function gerarResumoIA(apiKey, tipo, partes, eventos) {
  const { aoTerminarAudios, aoTentativa } = eventos || {};
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${encodeURIComponent(
    apiKey
  )}`;

  const inicioAudios = Date.now();
  const partesResolvidas = await resolverPartes(partes);
  const audioMs = Date.now() - inicioAudios;
  if (aoTerminarAudios) aoTerminarAudios();

  const inicioIa = Date.now();
  const corpoDaChamada = (comRaciocinio) => ({
    contents: [{ parts: partesResolvidas }],
    generationConfig: {
      temperature: 0.3,
      // 2048 tokens já cortava o resumo detalhado no meio (às vezes só
      // "Dor do cliente" saía completo): parte do limite ia embora em
      // raciocínio interno antes de o modelo escrever a resposta visível.
      // 8192 dá folga de sobra pro texto sem custar mais tempo — o teto não
      // é gasto, só evita truncar.
      maxOutputTokens: 8192,
      ...(comRaciocinio
        ? { thinkingConfig: { thinkingLevel: NIVEL_RACIOCINIO[tipo] || "MINIMAL" } }
        : {}),
    },
  });

  let resp;
  try {
    resp = await chamarGeminiComRetry(url, corpoDaChamada(!(await raciocinioDesligado())), aoTentativa);
  } catch (erro) {
    if (!erro.raciocinioRecusado) throw erro;
    console.warn("[rwc] modelo não aceita thinkingConfig; repetindo sem o campo");
    await api.storage.local.set({ rwcSemRaciocinio: true });
    resp = await chamarGeminiComRetry(url, corpoDaChamada(false), aoTentativa);
  }

  const dados = await resp.json();

  // Diagnóstico de tempo: "raciocínio" alto aqui é o sinal de que o modelo
  // gastou o tempo pensando em vez de escrevendo, e é onde mexer se as
  // gerações voltarem a demorar.
  const uso = dados.usageMetadata || {};
  console.log(
    `[rwc] IA respondeu em ${((Date.now() - inicioIa) / 1000).toFixed(1)}s — tokens:`,
    `entrada ${uso.promptTokenCount || 0},`,
    `raciocínio ${uso.thoughtsTokenCount || 0},`,
    `resposta ${uso.candidatesTokenCount || 0}`
  );
  const cand = dados.candidates && dados.candidates[0];
  if (!cand) {
    throw new Error("A IA não retornou nenhum resultado. Tente novamente.");
  }

  const texto = ((cand.content && cand.content.parts) || [])
    .map((p) => p.text || "")
    .join("")
    .trim();

  // Se o modelo foi cortado por limite de tokens, o texto vem incompleto
  // (ex: só a primeira seção do resumo) mas não vazio — sem essa checagem
  // isso passaria como resumo "pronto" só que pela metade.
  if (texto && cand.finishReason === "MAX_TOKENS") {
    throw new Error(
      "O resumo foi cortado por ficar longo demais para a IA. Tente novamente ou escolha um nível de detalhe menor (normal/breve)."
    );
  }

  if (!texto) {
    const motivo = cand.finishReason ? ` (motivo: ${cand.finishReason})` : "";
    throw new Error(`A IA não gerou texto${motivo}.`);
  }
  return { texto: aplicarEstruturaFixa(tipo, texto), audioMs, iaMs: Date.now() - inicioIa };
}

const ROTULOS_TIPO = {
  breve: "Resumo breve",
  normal: "Resumo normal",
  detalhado: "Resumo detalhado",
  sugestao: "Modelo de sugestão",
  cancelamento: "Anotação de cancelamento",
  downgrade: "Solicitação de downgrade",
  treinamento: "Solicitação de treinamento",
  anotacao: "Anotação",
  clear: "CLEAR",
};

/* ==========================================================================
   Modelos com estrutura fixa.

   Nos resumos, variação de formato é tolerável. Nos modelos não: o texto é
   colado como está em outro lugar (ex: a planilha de sugestões do time), e
   os campos precisam vir sempre com os mesmos rótulos, na mesma ordem. O
   prompt pede isso, mas a IA às vezes devolve negrito, marcador de lista,
   um campo a menos ou uma frase de introdução. Em vez de confiar nisso, a
   resposta é remontada aqui a partir dos rótulos encontrados — o que chega
   ao agente é sempre exatamente a estrutura definida.

   Precisa casar com MODELOS no content script (que usa os mesmos rótulos
   para desenhar o resultado).
   ========================================================================== */
//
// `titulo` é uma linha fixa no topo. Um campo com `fixo` é escrito pela
// extensão com exatamente esse valor — "" deixa o campo em branco para o
// agente preencher — e qualquer coisa que a IA tenha escrito nele é
// ignorada. Só os campos sem `fixo` vêm da resposta da IA.
const ESTRUTURAS_FIXAS = {
  sugestao: {
    titulo: "@registrosugestão",
    campos: [
      { rotulo: "Sugestão" },
      { rotulo: "Motivo" },
      // Só o tipo de negócio ("Academia"): se a IA emendar uma explicação,
      // ela é cortada.
      { rotulo: "Modelo de operação", curto: true },
    ],
  },
  cancelamento: {
    titulo: "ANOTAÇÃO DE CANCELAMENTO",
    campos: [
      { rotulo: "ADM", fixo: "" },
      { rotulo: "Situação" },
      { rotulo: "Próximo passo", fixo: "Encaminhar ao CSM responsável." },
      { rotulo: "Anexos", fixo: "" },
    ],
  },
  downgrade: {
    titulo: "SOLICITAÇÃO DE DOWNGRADE ⬇️",
    campos: [
      { rotulo: "Situação" },
      {
        rotulo: "Próximo passo",
        fixo: "CSM Engajamento agir com a demanda, entrando em contato com o cliente.",
      },
      { rotulo: "Anexos", fixo: "" },
    ],
  },
  treinamento: {
    titulo: "SOLICITAÇÃO DE TREINAMENTO",
    campos: [
      // O agente troca o XXX e escolhe adicional/inicial.
      { rotulo: "Demanda", fixo: "Treinamento XXX (ADICIONAL OU INICIAL)" },
      { rotulo: "Quem entrou em contato" },
      { rotulo: "Qual sua função no negócio", curto: true },
      // Quase nunca vem na conversa e não é obrigatório: sem contato citado,
      // o campo fica em branco em vez de "Não informado".
      { rotulo: "Qual contato", vazioSeAusente: true },
      { rotulo: "Situação" },
      { rotulo: "O que já foi feito em relação a isso" },
      { rotulo: "Anexos", fixo: "" },
      {
        rotulo: "Próximo passo",
        fixo: "Encaminhar ao agente responsável para realizar o treinamento.",
      },
    ],
  },
  anotacao: {
    titulo: "ANOTAÇÃO",
    campos: [
      { rotulo: "Situação" },
      { rotulo: "Próximo passo", fixo: "" },
      { rotulo: "Anexos", fixo: "" },
    ],
  },
  clear: {
    titulo: "CLEAR - [Motivo]",
    campos: [
      { rotulo: "O que foi feito" },
      { rotulo: "Próximo passo" },
      { rotulo: "Cliente insatisfeito", opcoes: ["Sim", "Não"] },
    ],
  },
};

const SEM_INFORMACAO = "Não informado";

function semAcento(texto) {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function aplicarEstruturaFixa(tipo, texto) {
  const estrutura = ESTRUTURAS_FIXAS[tipo];
  if (!estrutura) return texto;
  const { titulo, campos } = estrutura;

  const valores = campos.map(() => []);
  let campoAtual = -1;

  texto.split("\n").forEach((bruta) => {
    // NFC garante que "ã" ocupa um caractere tanto aqui quanto na versão sem
    // acento — é isso que permite usar o tamanho do rótulo encontrado sem
    // acento para cortar a linha original.
    const linha = bruta
      .normalize("NFC")
      .replace(/\*\*|__/g, "")
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
      .trim();
    if (!linha) return;
    // A IA às vezes repete o título; ele é recolocado no lugar certo abaixo.
    if (titulo && semAcento(linha).replace(/:$/, "") === semAcento(titulo)) return;

    const rotulo = semAcento(linha).match(/^([a-z ]+?)\s*:\s*/);
    const indice = rotulo ? campos.findIndex((c) => semAcento(c.rotulo) === rotulo[1].trim()) : -1;
    if (indice >= 0) {
      campoAtual = indice;
      const valor = linha.slice(rotulo[0].length).trim();
      if (valor) valores[indice].push(valor);
    } else if (campoAtual >= 0) {
      // Continuação do campo anterior (a IA quebrou o parágrafo em linhas).
      valores[campoAtual].push(linha);
    }
    // Linhas antes do primeiro rótulo são introdução da IA: descartadas.
  });

  const linhas = [];
  campos.forEach((campo, i) => {
    if ("fixo" in campo) {
      linhas.push(campo.fixo ? `${campo.rotulo}: ${campo.fixo}` : `${campo.rotulo}:`);
      return;
    }
    let valor = valores[i].join(" ").replace(/\s+/g, " ").trim();
    const ausente = !valor || /^n[aã]o informado\.?$/i.test(valor);

    if (campo.opcoes) {
      // Só vale uma das opções, escrita exatamente como definida ("Sim",
      // "Não"). Resposta ambígua ou ausente fica em branco para o agente
      // decidir — a extensão não assume um "Não" por conta própria.
      const inicio = semAcento(valor).replace(/[^a-z].*$/, "");
      valor = ausente ? "" : campo.opcoes.find((o) => semAcento(o) === inicio) || "";
    } else {
      if (campo.curto) valor = valor.split(/\.\s|\s[-–—(]|;|\n/)[0].trim();
      if (ausente) valor = campo.vazioSeAusente ? "" : SEM_INFORMACAO;
    }
    linhas.push(valor ? `${campo.rotulo}: ${valor}` : `${campo.rotulo}:`);
  });

  const corpo = linhas.join("\n\n");
  return titulo ? `${titulo}\n\n${corpo}` : corpo;
}

// Identidade da conversa. Antes o resumo era casado por `location.href`
// exato: qualquer query string que o Freshworks acrescente/remova sozinho
// (filtro, view, tracking) fazia o resumo já pronto virar "de outra
// conversa" e sumir da tela pra sempre. O caminho da URL é o que identifica
// o atendimento, então a query fica de fora da chave.
function idDaConversa(href) {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}${u.hash}`.replace(/\/+$/, "");
  } catch (_) {
    return href || "";
  }
}

// Guardamos um resumo POR CONVERSA. Com uma chave única global, começar um
// resumo na conversa B apagava o resultado já pronto da conversa A (a
// primeira coisa que processarGeracaoDeResumo faz é gravar o status
// "gerando"). O agente recebia a notificação de "pronto" da A, voltava pra
// ela e não encontrava nada.
const MAX_RESUMOS_GUARDADOS = 20;

// Duas gerações podem rodar em paralelo agora (uma por conversa), e ambas
// escrevem no mesmo objeto do storage. Sem serializar, o read-modify-write
// de uma sobrescreve o da outra.
let filaEscritaResumos = Promise.resolve();

function podarResumos(mapa) {
  const chaves = Object.keys(mapa);
  if (chaves.length <= MAX_RESUMOS_GUARDADOS) return mapa;
  const podado = {};
  chaves
    .sort((a, b) => (mapa[b]?.atualizadoEm || 0) - (mapa[a]?.atualizadoEm || 0))
    .slice(0, MAX_RESUMOS_GUARDADOS)
    .forEach((chave) => {
      podado[chave] = mapa[chave];
    });
  return podado;
}

// `mutador` recebe o mapa atual e devolve o novo — ou null pra desistir da
// escrita (ex: heartbeat que percebeu que a geração já terminou).
function atualizarResumos(mutador) {
  filaEscritaResumos = filaEscritaResumos
    .then(async () => {
      const { rwcResumos } = await api.storage.local.get("rwcResumos");
      const mapa = rwcResumos && typeof rwcResumos === "object" ? { ...rwcResumos } : {};
      const novo = mutador(mapa);
      if (!novo) return;
      await api.storage.local.set({ rwcResumos: podarResumos(novo) });
    })
    .catch((erro) => console.error("[rwc] falha ao gravar resumo", erro));
  return filaEscritaResumos;
}

function salvarResumo(dados) {
  return atualizarResumos((mapa) => {
    mapa[idDaConversa(dados.url)] = dados;
    return mapa;
  });
}

// Marca "ainda estou vivo" sem mexer no resto do estado — e desiste se a
// geração já terminou ou se outra geração assumiu esta conversa.
function tocarHeartbeat(contexto, aindaGerando) {
  return atualizarResumos((mapa) => {
    const chave = idDaConversa(contexto.url);
    const atual = mapa[chave];
    if (
      (aindaGerando && !aindaGerando()) ||
      !atual ||
      atual.status !== "gerando" ||
      atual.solicitacaoId !== contexto.solicitacaoId
    ) {
      return null;
    }
    mapa[chave] = { ...atual, atualizadoEm: Date.now() };
    return mapa;
  });
}

function notificar(titulo, mensagem) {
  api.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: titulo,
    message: mensagem,
  });
}

/* ==========================================================================
   Estimativa de duração (barra de progresso).

   A API usada aqui é uma chamada única, sem streaming: não existe "%
   concluído" real vindo do Gemini para mostrar ao agente. O que dá para
   prever bem é o TEMPO. Toda geração passa pelas mesmas três etapas
   (leitura da tela, download dos áudios e a chamada à IA), então medimos
   quanto cada uma levou a cada resumo concluído e usamos a média das
   últimas execuções como estimativa da próxima. Nas primeiras vezes valem
   os padrões abaixo.
   ========================================================================== */
const TEMPOS_PADRAO = {
  leitura: 4000,
  audio: 3500, // por áudio baixado
  ia: { breve: 6000, normal: 8000, detalhado: 15000, sugestao: 6000, cancelamento: 5000, downgrade: 5000, treinamento: 7000, anotacao: 5000, clear: 6000 },
};

// As médias aprendidas descrevem o comportamento de uma versão específica da
// geração. Quando o que muda é justamente a velocidade (nível de raciocínio,
// prompt, modelo, forma de ler a tela), o histórico antigo passa a prever o
// tempo do jeito lento e a barra ficaria mentindo por umas 10 gerações até a
// média migrar. Subir esta versão descarta o histórico e recalibra do zero.
const VERSAO_TEMPOS = 2;

// Média móvel curta: o histórico antigo não pode engessar a estimativa
// quando a rede do agente (ou a fila do Gemini) muda de patamar.
const MAX_AMOSTRAS = 10;

let filaEscritaTempos = Promise.resolve();

async function lerTempos() {
  try {
    const { rwcTempos } = await api.storage.local.get("rwcTempos");
    return rwcTempos && rwcTempos.versao === VERSAO_TEMPOS ? rwcTempos : {};
  } catch (_) {
    return {};
  }
}

function mediaSalva(tempos, chave, padrao) {
  const amostra = tempos[chave];
  return amostra && amostra.amostras > 0 && amostra.media > 0 ? amostra.media : padrao;
}

function estimativaIa(tempos, tipo) {
  return mediaSalva(tempos, `ia:${tipo}`, TEMPOS_PADRAO.ia[tipo] || TEMPOS_PADRAO.ia.normal);
}

function estimativaAudios(tempos, totalAudios) {
  return mediaSalva(tempos, "audio", TEMPOS_PADRAO.audio) * (totalAudios || 0);
}

// `amostras` é um objeto { chave: duracaoEmMs }; entradas <= 0 são
// ignoradas, que é como o chamador descarta uma medição suja (ex: a
// chamada à IA que só demorou porque teve retry por sobrecarga).
function registrarTempos(amostras) {
  filaEscritaTempos = filaEscritaTempos
    .then(async () => {
      const tempos = await lerTempos();
      const novo = { ...tempos, versao: VERSAO_TEMPOS };
      let mudou = false;
      Object.entries(amostras).forEach(([chave, ms]) => {
        if (!(ms > 0)) return;
        const atual = novo[chave] || { media: 0, amostras: 0 };
        const peso = Math.min(atual.amostras, MAX_AMOSTRAS - 1);
        novo[chave] = {
          media: Math.round((atual.media * peso + ms) / (peso + 1)),
          amostras: Math.min(atual.amostras + 1, MAX_AMOSTRAS),
        };
        mudou = true;
      });
      if (mudou) await api.storage.local.set({ rwcTempos: novo });
    })
    .catch((erro) => console.error("[rwc] falha ao registrar tempos", erro));
  return filaEscritaTempos;
}

/* ==========================================================================
   Trabalhos duráveis.

   O keep-alive abaixo é um setInterval DENTRO do service worker — e é
   justamente isso que o Chrome estrangula quando o agente minimiza a janela
   e vai fazer outra coisa. Se o intervalo deixa de disparar por mais de
   ~30s, o worker é encerrado no meio do fetch pro Gemini: a promise morre
   sem passar pelo catch, nada é gravado, nenhuma notificação dispara, e o
   storage fica preso em "gerando" para sempre. O agente volta pro
   atendimento e não encontra resumo nenhum.

   Guardar o pedido (as `parts` já montadas) faz a geração deixar de ser
   volátil: um alarme reacorda o worker e o trabalho órfão é refeito do
   zero, sem depender de o agente estar com a aba aberta ou o Chrome em foco.
   ========================================================================== */
const ALARME_RETOMADA = "rwc-retomar-trabalhos";

// Tempo sem heartbeat a partir do qual o trabalho é considerado órfão.
// Menor que o GERANDO_TIMEOUT_MS do content script (120s) de propósito: a
// retomada tem que acontecer antes de a tela desistir e mostrar erro.
const TRABALHO_ORFAO_MS = 60000;

// Espera antes de tentar de novo quando a IA respondeu que está
// sobrecarregada. O alarme roda de minuto em minuto, então na prática a
// próxima tentativa cai no tique seguinte.
const ESPERA_REAGENDAMENTO_MS = 45000;

// Cobre tanto worker morto pelo navegador quanto pico de 503 no Gemini.
const MAX_RETOMADAS = 3;

// Trabalhos que ESTE worker já está executando agora — sem isso o alarme
// reiniciaria uma geração que só está demorando.
const emExecucao = new Set();

async function lerTrabalhos() {
  const { rwcTrabalhos } = await api.storage.local.get("rwcTrabalhos");
  return rwcTrabalhos && typeof rwcTrabalhos === "object" ? rwcTrabalhos : {};
}

async function salvarTrabalho(trabalho) {
  const trabalhos = await lerTrabalhos();
  trabalhos[trabalho.solicitacaoId] = trabalho;
  await api.storage.local.set({ rwcTrabalhos: trabalhos });
}

async function removerTrabalho(solicitacaoId) {
  const trabalhos = await lerTrabalhos();
  if (!trabalhos[solicitacaoId]) return;
  delete trabalhos[solicitacaoId];
  await api.storage.local.set({ rwcTrabalhos: trabalhos });
}

function agendarRetomada() {
  // O alarme sobrevive à morte do worker e o reacorda — é isso que o
  // setInterval não consegue fazer.
  api.alarms.create(ALARME_RETOMADA, { periodInMinutes: 1 });
}

async function retomarTrabalhosOrfaos() {
  let trabalhos;
  try {
    trabalhos = await lerTrabalhos();
  } catch (_) {
    return;
  }
  const pendentes = Object.values(trabalhos);
  if (!pendentes.length) return;

  const { rwcResumos } = await api.storage.local.get("rwcResumos");
  const mapa = rwcResumos || {};

  for (const trabalho of pendentes) {
    if (emExecucao.has(trabalho.solicitacaoId)) continue;

    const resumo = mapa[idDaConversa(trabalho.url)];
    // Se outra geração assumiu a conversa, ou ela já terminou, o trabalho
    // não interessa mais.
    if (!resumo || resumo.solicitacaoId !== trabalho.solicitacaoId) {
      await removerTrabalho(trabalho.solicitacaoId);
      continue;
    }
    if (resumo.status !== "gerando") {
      await removerTrabalho(trabalho.solicitacaoId);
      continue;
    }
    // Duas formas de ficar elegível: um reagendamento explícito (a IA estava
    // sobrecarregada e pedimos pra tentar mais tarde) ou o trabalho ter
    // ficado sem sinal de vida, sinal de que o worker morreu no meio.
    const naHora = resumo.proximaTentativaEm
      ? Date.now() >= resumo.proximaTentativaEm
      : Date.now() - (resumo.atualizadoEm || 0) >= TRABALHO_ORFAO_MS;
    if (!naHora) continue;

    const retomadas = (trabalho.retomadas || 0) + 1;
    if (retomadas > MAX_RETOMADAS) {
      console.warn("[rwc] trabalho excedeu as retomadas, desistindo", trabalho.solicitacaoId);
      await removerTrabalho(trabalho.solicitacaoId);
      const motivo = trabalho.ultimoErro
        ? `A IA seguiu indisponível após várias tentativas. Último retorno: ${trabalho.ultimoErro}`
        : "A geração foi interrompida pelo navegador e não pôde ser concluída. Tente novamente.";
      await salvarResumo({
        ...resumo,
        status: "erro",
        erro: motivo,
        atualizadoEm: Date.now(),
      });
      notificar("Rewind Chat — erro ao gerar resumo", motivo);
      continue;
    }

    console.warn("[rwc] retomando trabalho órfão", trabalho.solicitacaoId, `(${retomadas}/${MAX_RETOMADAS})`);
    // Marca antes do await pra um segundo disparo do alarme não começar a
    // mesma geração duas vezes.
    emExecucao.add(trabalho.solicitacaoId);
    await salvarTrabalho({ ...trabalho, retomadas });
    processarGeracaoDeResumo(
      { ...trabalho, retomadas, type: "rwc-gerar-resumo" },
      () => {
        /* ninguém esperando resposta numa retomada */
      }
    );
  }
}

api.alarms.onAlarm.addListener((alarme) => {
  if (alarme.name === ALARME_RETOMADA) retomarTrabalhosOrfaos();
});

// O worker pode acordar por vários motivos; em qualquer um deles vale checar
// se ficou trabalho pela metade da última vez que ele foi morto.
api.runtime.onStartup.addListener(retomarTrabalhosOrfaos);
api.runtime.onInstalled.addListener(() => {
  agendarRetomada();
  retomarTrabalhosOrfaos();
});
agendarRetomada();
retomarTrabalhosOrfaos();

// O MV3 pode encerrar o service worker por inatividade (~30s) mesmo com um
// fetch pendente, dependendo da versão do Chrome. Qualquer chamada a uma
// API da extensão reseta esse timer, então mantemos um "pulso" periódico
// enquanto a geração estiver rodando.
//
// Esse pulso também serve de heartbeat pro content script: sem ele,
// `atualizadoEm` ficaria travado no horário em que a geração começou, e uma
// conversa com vários áudios (download + retries no Gemini podem passar de
// 1-2 minutos) faria o content script achar que a geração morreu mesmo
// estando tudo normal. Atualizando `atualizadoEm` a cada pulso, o timeout
// do lado do content script passa a medir "tempo desde o último sinal de
// vida" em vez de "tempo desde o início".
// `aindaGerando` é checada antes de CADA operação assíncrona de storage
// (não só uma vez no início do tick) porque a leitura e a escrita do
// heartbeat não são atômicas: se a geração terminar (e gravar o resultado
// final) bem no meio dessas duas chamadas, sem essa checagem de novo logo
// antes do set() o heartbeat reescreveria "gerando" por cima do resultado
// já pronto/com erro.
function manterServiceWorkerAtivo(contexto, aindaGerando) {
  const intervalo = setInterval(() => {
    api.storage.local.get("rwcKeepAlive", () => void api.runtime.lastError);
    if (!aindaGerando()) return;
    tocarHeartbeat(contexto, aindaGerando);
  }, 15000);
  return () => clearInterval(intervalo);
}

// A partir do momento em que a mensagem chega aqui, a geração roda até o
// fim mesmo que a aba/conversa de origem seja fechada: o resultado (ou
// erro) é persistido em storage, e o content script — se ainda estiver
// aberto na mesma conversa — atualiza a tela via api.storage.onChanged.
// Se a aba já tiver fechado, o sendResponse simplesmente falha em silêncio;
// o trabalho em si não é interrompido por isso.
async function processarGeracaoDeResumo(mensagem, sendResponse) {
  const tipo = mensagem.tipo || "";
  const tempos = await lerTempos();
  const totalAudios = (mensagem.parts || []).filter((p) => p && p.audioUrl).length;

  // O relógio da barra de progresso começa no clique do agente (no content
  // script), não aqui: a leitura da tela já é espera para ele. Numa
  // retomada, `inicioEm` continua sendo o do pedido original — o tempo já
  // gasto entra na conta em vez de a barra recomeçar do zero.
  const inicioEm = Number(mensagem.inicioEm) || Date.now();
  const leituraMs = Number(mensagem.leituraMs) || 0;
  const decorrido = Math.max(0, Date.now() - inicioEm);

  const contexto = {
    status: "gerando",
    url: mensagem.url || "",
    tipo,
    solicitacaoId: mensagem.solicitacaoId || "",
    inicioEm,
    totalAudios,
    fase: totalAudios ? "audios" : "ia",
    estimativaMs: Math.round(
      decorrido + estimativaAudios(tempos, totalAudios) + estimativaIa(tempos, tipo)
    ),
    atualizadoEm: Date.now(),
  };
  console.log("[rwc] geração iniciada", contexto.tipo, contexto.url);
  await salvarResumo(contexto);

  // Persiste o pedido ANTES de começar: se o Chrome matar o worker no meio
  // do fetch, é daqui que a retomada reconstrói o trabalho.
  emExecucao.add(contexto.solicitacaoId);
  await salvarTrabalho({
    solicitacaoId: contexto.solicitacaoId,
    url: contexto.url,
    tipo: contexto.tipo,
    parts: mensagem.parts,
    retomadas: mensagem.retomadas || 0,
    inicioEm,
    leituraMs,
    criadoEm: Date.now(),
  });

  let finalizado = false;
  let reagendado = false;
  const pararKeepAlive = manterServiceWorkerAtivo(contexto, () => !finalizado);
  try {
    const apiKey = mensagem.apiKey || (await obterChaveSalva());
    if (!apiKey) {
      finalizado = true;
      const erroDados = {
        ...contexto,
        status: "erro",
        erro: "Nenhuma chave de API do Gemini configurada.",
        atualizadoEm: Date.now(),
      };
      await salvarResumo(erroDados);
      console.warn("[rwc] sem chave de API configurada");
      sendResponse({ ok: false, error: erroDados.erro });
      return;
    }

    let houveRetry = false;
    const { texto, audioMs, iaMs } = await gerarResumoIA(apiKey, tipo, mensagem.parts, {
      aoTerminarAudios: () => {
        if (!totalAudios) return; // não havia áudio: a fase já começou em "ia"
        // Etapa dos áudios encerrada: a estimativa deixa de embutir o chute
        // por áudio e passa a valer o tempo que eles realmente levaram, mais
        // a chamada à IA que ainda vem. A barra corrige o rumo aqui em vez
        // de arrastar o erro até o fim.
        contexto.fase = "ia";
        contexto.estimativaMs = Math.round(
          Date.now() - inicioEm + estimativaIa(tempos, contexto.tipo)
        );
        contexto.atualizadoEm = Date.now();
        salvarResumo({ ...contexto });
      },
      aoTentativa: () => {
        houveRetry = true;
        // Heartbeat: cada retry por sobrecarga do Gemini atualiza atualizadoEm,
        // então o content script sabe que ainda está vivo em vez de só ver
        // "gerando" parado por dezenas de segundos.
        tocarHeartbeat(contexto);
      },
    });
    finalizado = true;
    contexto.fase = "pronto";
    const prontoDados = { ...contexto, status: "pronto", texto, atualizadoEm: Date.now() };
    await salvarResumo(prontoDados);

    // Só realimenta a estimativa com medição limpa. Numa retomada o relógio
    // inclui o tempo em que o worker esteve morto, e um retry mede a
    // sobrecarga do Gemini — nos dois casos a duração não representa o
    // trabalho em si e estragaria a previsão das próximas gerações.
    // Aguarda a gravação: o worker pode ser encerrado logo depois do
    // sendResponse e a medição desta geração se perderia.
    if (!(mensagem.retomadas > 0)) {
      await registrarTempos({
        leitura: leituraMs,
        audio: totalAudios ? audioMs / totalAudios : 0,
        [`ia:${contexto.tipo}`]: houveRetry ? 0 : iaMs,
      });
    }
    console.log("[rwc] geração concluída", contexto.tipo, contexto.url);
    notificar("Rewind Chat", `${ROTULOS_TIPO[mensagem.tipo] || "Resumo"} pronto.`);
    sendResponse({ ok: true, text: texto });
  } catch (erro) {
    finalizado = true;
    const erroMsg = erro.message || "Ocorreu um erro inesperado.";
    const retomadasFeitas = mensagem.retomadas || 0;

    // Sobrecarga do Gemini (503/429) é temporária e não é culpa do agente —
    // não faz sentido devolver erro e obrigar a refazer a leitura da tela.
    // O trabalho guardado já tem o tipo de resumo escolhido e a transcrição,
    // então só reagendamos: o alarme tenta de novo sozinho e, pro agente, o
    // painel continua em "Gerando resumo...".
    if (erro.retentavel && retomadasFeitas < MAX_RETOMADAS) {
      reagendado = true;
      await salvarTrabalho({
        solicitacaoId: contexto.solicitacaoId,
        url: contexto.url,
        tipo: contexto.tipo,
        parts: mensagem.parts,
        retomadas: retomadasFeitas,
        ultimoErro: erroMsg,
        inicioEm,
        leituraMs,
        criadoEm: Date.now(),
      });
      await salvarResumo({
        ...contexto,
        status: "gerando",
        fase: "espera",
        // A barra não pode seguir correndo para o fim enquanto a próxima
        // tentativa nem começou: a estimativa passa a incluir a espera do
        // reagendamento mais uma chamada inteira à IA.
        estimativaMs: Math.round(
          Date.now() - inicioEm + ESPERA_REAGENDAMENTO_MS + estimativaIa(tempos, contexto.tipo)
        ),
        proximaTentativaEm: Date.now() + ESPERA_REAGENDAMENTO_MS,
        atualizadoEm: Date.now(),
      });
      console.warn("[rwc] IA indisponível, reagendando", contexto.solicitacaoId, erroMsg);
      sendResponse({ ok: false, error: erroMsg, reagendado: true });
      return;
    }

    const erroDados = { ...contexto, status: "erro", erro: erroMsg, atualizadoEm: Date.now() };
    await salvarResumo(erroDados);
    console.error("[rwc] geração falhou", erro);
    notificar("Rewind Chat — erro ao gerar resumo", erroMsg);
    sendResponse({ ok: false, error: erroMsg });
  } finally {
    pararKeepAlive();
    emExecucao.delete(contexto.solicitacaoId);
    // Só apaga o trabalho se ele realmente acabou. Num reagendamento ele
    // precisa sobreviver — é dele que a próxima tentativa é reconstruída.
    if (!reagendado) {
      await removerTrabalho(contexto.solicitacaoId).catch(() => {});
    }
  }
}

api.runtime.onMessage.addListener((mensagem, _sender, sendResponse) => {
  if (mensagem?.type === "rwc-obter-config-inicial") {
    (async () => {
      const existente = await obterChaveSalva();
      const geminiKey = existente || (await semearChaveDoConfigLocal());
      sendResponse({ geminiKey });
    })();
    return true;
  }

  if (mensagem?.type === "rwc-gerar-resumo") {
    processarGeracaoDeResumo(mensagem, (resposta) => {
      try {
        sendResponse(resposta);
      } catch (_) {
        // Aba de origem fechada — o resultado já está salvo em storage.
      }
    });
    return true;
  }

  return false;
});
