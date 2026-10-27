# Tasks

## 1. Синтаксис but commit

- [x] 1.1 Обновить `buildCommitCommands` в `lib/commit.js`: для `gitbutler` с веткой строить `['commit', '-b', <ветка>, '-m', <сообщение>]` вместо `['commit', <ветка>, '-m', <сообщение>]`; убедиться, что коммит без ветки остаётся `['commit', '-m', <сообщение>]`
- [x] 1.2 Обновить `test/commit.test.mjs`: ожидания argv для `but commit -b <ветка>` в тестах «GitButler commits into the branch» и «a new branch is created …», а также в `runCommit`-тестах, и проверить, что `npm test` проходит

## 2. Синтаксис but branch new

- [x] 2.1 Обновить `branchNewCommand` в `lib/commit.js`: строить `['branch', 'new', <имя>, '-A', <anchor>]` вместо `-a <anchor>`; при отсутствии anchor оставлять `['branch', 'new', <имя>]`
- [x] 2.2 Обновить `test/commit.test.mjs`: ожидания argv для `but branch new <имя> -A <anchor>` и без anchor, и проверить, что `npm test` проходит

## 3. Проверка минимальной версии GitButler

- [x] 3.1 Добавить в модуль проверки версии (по образцу `MIN_OPENSPEC_VERSION` в `lib/openspec.js`) константу `MIN_GITBUTLER_VERSION = '0.22.0'`, парсер первого `X.Y.Z` из `but --version` и численное сравнение версий по компонентам; проверить юнит-тестами `but 0.21.0 < 0.22.0`, `0.22.0` = минимум, `1.0.0 > минимум`, пре-релиз и мусор в выводе
- [x] 3.2 Встроить fail-closed проверку в карточку ввода GitButler (`resolveCommitInput` в `lib/control.js`, рядом с чтением `but status --json`): `but --version` читается один раз за прогон только когда `commit.tool` равен `gitbutler`; при версии ниже `0.22.0` или нераспознанном ответе прогон не начинается с сообщением об обновлении GitButler; проверить тестами версию актуальную, ниже минимума, нераспознанную и пропуск проверки при `git`

## 4. Документация

- [x] 4.1 Обновить README и подсказку «Commit tool»: синтаксис `but commit -b <ветка> -m` и `but branch new <имя> -A <anchor>`, минимальная версия GitButler `0.22.0`; сверить текст со спецификацией и списком команд `but --help`
- [x] 4.2 Прогнать `openspec validate "fix-gitbutler-022-commit"` и полный набор тестов плагина; убедиться, что change остаётся валидным (предупреждение об архивации MODIFIED-требований до архивации предыдущего change допустимо)