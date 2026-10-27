# Proposal

## Why

GitButler CLI 0.22.x изменил синтаксис `but commit` и `but branch new`: ветка задаётся флагом `-b`/`--branch`, а стекование новой ветки — флагом `-A`/`--above` вместо прежнего позиционного имени и `-a`/`--anchor`. Плагин до сих пор строит старую форму, поэтому коммит через GitButler на установленной версии 0.22.3 падает (`Could not find uncommitted change: '<branch>'`), останавливая прогон на границе группы и оставляя код задачи незакоммиченным.

## What Changes

- **BREAKING:** синтаксис `but commit` меняется с `but commit <ветка> -m <msg>` на `but commit -b <ветка> -m <msg>`.
- **BREAKING:** синтаксис `but branch new` меняется с `but branch new <имя> -a <anchor>` на `but branch new <имя> -A <anchor>`.
- Добавляется fail-closed проверка минимальной версии GitButler: плагин SHALL читать `but --version` один раз за прогон (только когда `commit.tool` равен `gitbutler`) и останавливать прогон, если установленная версия ниже `0.22.0` или ответ не распознан. Это исключает ветвление синтаксиса по версии: поддерживается только один набор команд 0.22.x.
- Актуализируются юнит-тесты `test/commit.test.mjs` под новые argv и добавляются тесты проверки версии.

## Capabilities

### New Capabilities

- (нет новых возможностей — поведение меняется внутри существующей возможности)

### Modified Capabilities

- `openspec-taskloop`: меняются требования о коммите через GitButler (новый синтаксис `but commit -b` и `but branch new -A`) и добавляется требование о fail-closed проверке минимальной версии GitButler.

## Impact

- `lib/commit.js`: `buildCommitCommands` — argv для `but commit` (флаг `-b`) и `but branch new` (флаг `-A`).
- `lib/environment.js` / `lib/control.js`: вызов `but --version` в карточке ввода GitButler, один раз за прогон, до вопроса о ветке; остановка при версии ниже `0.22.0`.
- `test/commit.test.mjs` и сопутствующие тесты: новые argv и покрытие проверки версии.
- `README` и подсказка «Commit tool»: описание нового синтаксиса и минимальной версии.
- Зависимость: установленный GitButler CLI `>= 0.22.0`. Версия ниже поддерживаться не будет.