"use strict";

async function obterChaveSalva() {
  const { geminiKey } = await chrome.storage.local.get("geminiKey");
  return geminiKey || "";
}

async function semearChaveDoConfigLocal() {
  try {
    const resp = await fetch(chrome.runtime.getURL("config.local.js"));
    if (!resp.ok) return "";
    const texto = await resp.text();
    const match = texto.match(/iaKey\s*:\s*["']([^"']+)["']/);
    if (!match || !match[1]) return "";
    await chrome.storage.local.set({ geminiKey: match[1] });
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
      throw new Error(`A IA retornou ${status}${dica}. ${corpo}`);
    }

    const espera = Math.min(2000 * 2 ** (tentativa - 1), 8000);
    console.warn(`[rwc] Gemini retornou ${status}, tentando de novo em ${espera}ms (tentativa ${tentativa}/${tentativas})`);
    if (onTentativa) onTentativa(tentativa + 1, tentativas);
    await aguardarMs(espera);
  }
}

async function gerarResumoIA(apiKey, partes, onTentativa) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${encodeURIComponent(
    apiKey
  )}`;

  const partesResolvidas = await resolverPartes(partes);

  const resp = await chamarGeminiComRetry(
    url,
    {
      contents: [{ parts: partesResolvidas }],
      // 2048 tokens já cortava o resumo detalhado no meio (às vezes só
      // "Dor do cliente" saía completo): modelos mais novos gastam parte
      // desse limite com raciocínio interno antes de escrever a resposta
      // visível, sobrando pouco pro texto em si num resumo com bastante
      // conteúdo. 8192 dá folga de sobra pro texto sem custar muito mais.
      generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
    },
    onTentativa
  );

  const dados = await resp.json();
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
  return texto;
}

const ROTULOS_TIPO = {
  breve: "Resumo breve",
  normal: "Resumo normal",
  detalhado: "Resumo detalhado",
};

function salvarUltimoResumo(dados) {
  return chrome.storage.local.set({ rwcUltimoResumo: dados });
}

function notificar(titulo, mensagem) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: titulo,
    message: mensagem,
  });
}

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
    chrome.storage.local.get("rwcKeepAlive", () => void chrome.runtime.lastError);
    if (!aindaGerando()) return;
    chrome.storage.local.get("rwcUltimoResumo", ({ rwcUltimoResumo }) => {
      if (
        !aindaGerando() ||
        !rwcUltimoResumo ||
        rwcUltimoResumo.status !== "gerando" ||
        rwcUltimoResumo.solicitacaoId !== contexto.solicitacaoId
      ) {
        return;
      }
      chrome.storage.local.set({
        rwcUltimoResumo: { ...rwcUltimoResumo, atualizadoEm: Date.now() },
      });
    });
  }, 15000);
  return () => clearInterval(intervalo);
}

// A partir do momento em que a mensagem chega aqui, a geração roda até o
// fim mesmo que a aba/conversa de origem seja fechada: o resultado (ou
// erro) é persistido em storage, e o content script — se ainda estiver
// aberto na mesma conversa — atualiza a tela via chrome.storage.onChanged.
// Se a aba já tiver fechado, o sendResponse simplesmente falha em silêncio;
// o trabalho em si não é interrompido por isso.
async function processarGeracaoDeResumo(mensagem, sendResponse) {
  const contexto = {
    status: "gerando",
    url: mensagem.url || "",
    tipo: mensagem.tipo || "",
    solicitacaoId: mensagem.solicitacaoId || "",
    atualizadoEm: Date.now(),
  };
  console.log("[rwc] geração iniciada", contexto.tipo, contexto.url);
  await salvarUltimoResumo(contexto);

  let finalizado = false;
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
      await salvarUltimoResumo(erroDados);
      console.warn("[rwc] sem chave de API configurada");
      sendResponse({ ok: false, error: erroDados.erro });
      return;
    }

    const texto = await gerarResumoIA(apiKey, mensagem.parts, () => {
      // Heartbeat: cada retry por sobrecarga do Gemini atualiza atualizadoEm,
      // então o content script sabe que ainda está vivo em vez de só ver
      // "gerando" parado por dezenas de segundos.
      chrome.storage.local.set({
        rwcUltimoResumo: { ...contexto, atualizadoEm: Date.now() },
      });
    });
    finalizado = true;
    const prontoDados = { ...contexto, status: "pronto", texto, atualizadoEm: Date.now() };
    await salvarUltimoResumo(prontoDados);
    console.log("[rwc] geração concluída", contexto.tipo, contexto.url);
    notificar("Rewind Chat", `${ROTULOS_TIPO[mensagem.tipo] || "Resumo"} pronto.`);
    sendResponse({ ok: true, text: texto });
  } catch (erro) {
    finalizado = true;
    const erroMsg = erro.message || "Ocorreu um erro inesperado.";
    const erroDados = { ...contexto, status: "erro", erro: erroMsg, atualizadoEm: Date.now() };
    await salvarUltimoResumo(erroDados);
    console.error("[rwc] geração falhou", erro);
    notificar("Rewind Chat — erro ao gerar resumo", erroMsg);
    sendResponse({ ok: false, error: erroMsg });
  } finally {
    pararKeepAlive();
  }
}

chrome.runtime.onMessage.addListener((mensagem, _sender, sendResponse) => {
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
