#!/usr/bin/env python3
"""Gera dist/firefox/ — a versão da extensão que o Firefox aceita.

O Firefox não suporta `background.service_worker` (MV3 dele usa event page,
via `background.scripts`) e o Chrome rejeita o manifest inteiro se
`background.scripts` estiver presente. Como um manifest só não atende os
dois, este script deriva o do Firefox a partir do manifest.json do Chrome —
assim uma permissão nova entra em manifest.json e chega nos dois lados
sozinha, sem risco de esquecer de atualizar uma cópia.

Uso:  python build-firefox.py
Depois: about:debugging > Carregar extensão temporária > dist/firefox/manifest.json
"""
import json
import shutil
from collections import OrderedDict
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
SAIDA = RAIZ / "dist" / "firefox"
ARQUIVOS = ["background.js", "content.js", "content.css"]
PASTAS = ["icons"]
EXTENSAO_ID = "rewind-chat@nextfit.com.br"
# -webkit-text-security (mascara a chave da API) só existe no Firefox 118+.
# Abaixo disso a chave apareceria em texto puro na tela.
VERSAO_MINIMA = "118.0"


def main() -> None:
    manifesto = json.loads(
        (RAIZ / "manifest.json").read_text(encoding="utf-8"),
        object_pairs_hook=OrderedDict,
    )
    manifesto["background"] = OrderedDict([("scripts", ["background.js"])])
    manifesto["browser_specific_settings"] = OrderedDict(
        [("gecko", OrderedDict([("id", EXTENSAO_ID), ("strict_min_version", VERSAO_MINIMA)]))]
    )

    if SAIDA.exists():
        shutil.rmtree(SAIDA)
    SAIDA.mkdir(parents=True)

    (SAIDA / "manifest.json").write_text(
        json.dumps(manifesto, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    for arquivo in ARQUIVOS:
        shutil.copy2(RAIZ / arquivo, SAIDA / arquivo)
    for pasta in PASTAS:
        shutil.copytree(RAIZ / pasta, SAIDA / pasta)

    print(f"Pronto: {SAIDA}")
    print("Carregue em about:debugging apontando para o manifest.json dessa pasta.")


if __name__ == "__main__":
    main()
