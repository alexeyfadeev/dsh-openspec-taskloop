# Бейдж в шапке + диалог по клику

Переиспользуемый UI-паттерн для клиентских плагинов DSH: компактный индикатор
живёт в шапке сессии, а по нажатию открывает модальное окно с подробностями.
Документ описывает только элементы интерфейса, их разметку, поведение и сборку —
без бизнес-логики конкретного плагина. Всё, что относится к данным (что именно
показывать, откуда брать состояние, что писать в списке), намеренно вынесено за
скобки: паттерн повторяется с другим содержимым.

---

## 1. Схема

```
шапка сессии
┌──────────────────────────────────────────────────────┐
│  заголовок сессии                    [●  QUOTA 402]  │  ← бейдж (кнопка)
└──────────────────────────────────────────────────────┘
                                          │ click
                                          ▼
document.body (портал)
┌──────────────────────────────────────────────────────┐
│  слой: fixed, inset 0, z-index 1000, flex/center     │
│  ┌────────────────────────────────────────────────┐  │
│  │ маска: затемнение, клик = закрыть              │  │
│  │  ┌──────────────────────────────────────────┐  │  │
│  │  │ панель: role=dialog, aria-modal          │  │  │
│  │  │ заголовок                          [×]   │  │  │
│  │  │ ──────────────────────────────────────── │  │  │
│  │  │ тело: список / заметка (скроллится)      │  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

Ключевая идея: **бейдж — это кнопка, а не украшение**. Он открывает диалог,
поэтому обязан быть доступен с клавиатуры, объявлять себя как элемент,
открывающий диалог, и получать фокус обратно после закрытия. Диалог — не
«попап рядом с бейджем», а полноценная модалка, отрендеренная порталом в
`document.body`.

---

## 2. Точка монтирования: слот шапки

Бейдж регистрируется в слоте `conversation.session.header.utilities`.

| Свойство | Значение |
| --- | --- |
| Тип слота | список (одна запись = один элемент в ряду утилит шапки) |
| Область | сессия: слот сам передаёт `sessionId` пропсом |
| Когда виден | когда шапка сессии отрисована; у пустого разговора служебные слоты не рендерятся, поэтому отдельное правило «показывать только в начатом разговоре» не нужно |

Регистрация оборачивается в `ctx.slots.inject`: колбэк выполняется на каждый
жизненный цикл объявления слота. Если оболочка слот не объявила, бейдж просто
не появится — плагин не упадёт при активации.

```ts
export const inject = ['slots']

const SLOT = 'conversation.session.header.utilities'

export function apply(ctx: ClientContext): () => void {
  const removeStyles = installStyles()

  const dispose = ctx.slots.inject(SLOT, () =>
    ctx.slots.register(
      {
        name: SLOT,
        id: 'my-plugin-badge', // уникален внутри слота
        order: 30,             // позиция по возрастанию
      },
      MyBadge,
    ),
  )

  return () => {
    dispose()
    removeStyles()
  }
}
```

`apply` возвращает диспозер: он снимает и ячейку слота, и установленный
`<style>`. Это важно для HMR и выключения плагина — после выгрузки в шапке не
должно остаться ни узла, ни стилей.

Компонент получает `sessionId` стандартным пропсом слота:

```tsx
export function MyBadge({ sessionId }: { sessionId: string }) { /* ... */ }
```

---

## 3. Бейдж: анатомия

### 3.1. Разметка

```tsx
<button
  ref={seat}
  type="button"
  className={BADGE_CLASS}
  data-state={view.state}          // хук для стилей, не inline-цвет
  aria-label={view.ariaLabel}      // имя для всех состояний
  aria-haspopup="dialog"           // «я открываю диалог»
  title={view.ariaLabel}           // подсказка мышью
  onClick={() => setOpen(true)}
>
  <span className={DOT_CLASS} aria-hidden="true" />
  {view.label ? <span className={LABEL_CLASS}>{view.label}</span> : null}
</button>
```

Разбор по элементам:

| Элемент | Роль | Зачем |
| --- | --- | --- |
| `<button type="button">` | корень | фокусируется, активируется Enter/Space, объявляется как контрол; `span` с `onClick` этого не даёт |
| `data-state` | атрибут корня | состояние красится селектором `[data-state=…]`; цвет никогда не выбирается в JS |
| `aria-label` | имя кнопки | проговаривает состояние словами — цвет сам по себе скринридеру недоступен |
| `aria-haspopup="dialog"` | подсказка | предупреждает, что нажатие откроет диалог |
| `title` | подсказка мыши | повторяет имя; полезен, когда видимая подпись скрыта |
| точка (`span`, `aria-hidden`) | декор | несёт только цвет; в дереве доступности была бы шумом |
| подпись (`span`) | текст | показывается не во всех состояниях; обрезается по месту |

Подпись — необязательная часть. В референсе она появляется только в одном
(«проблемном») состоянии, а два нормальных состояния различаются цветом точки.
Правило простое: **цвет отвечает на «какое сейчас состояние», подпись — только
если состояние требует объяснения**. В шапке мало места, и подпись — первое,
что скрывается при нехватке ширины; имя в `aria-label` при этом остаётся.

### 3.2. Живой регион

`<button>` не может одновременно быть `role="status"`: роль кнопки побеждает,
и анонс теряется. Поэтому рядом с кнопкой ставится визуально скрытый регион,
который проговаривает то же предложение при смене состояния:

```tsx
<span className={SR_ONLY_CLASS} role="status">
  {view.ariaLabel}
</span>
```

Два канала говорят одно и то же в разные моменты: регион — когда состояние
изменилось, `aria-label` — когда пользователь дошёл до кнопки.

### 3.3. Размеры и стили (референс)

| Параметр | Значение |
| --- | --- |
| Высота | `22px` |
| Горизонтальные отступы | `0 8px` |
| Скругление | `999px` (pill) |
| Зазор точка↔подпись | `6px` |
| Точка | `8×8px`, `border-radius: 50%` |
| Шрифт подписи | `11px`, табличные цифры |
| Максимальная ширина подписи | `9ch`, обрезка через `text-overflow: ellipsis` |
| Фокус | `outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px` |
| Ховер | лёгкая подложка `color-mix(...)` только при `@media (hover: hover)` |
| Анимация | переход цвета `150ms`, отключается при `prefers-reduced-motion: reduce` |

Цвета — только семантические токены темы (`--dsw-*`), без литеральных значений:
тогда бейдж сам следует светлой и тёмной теме. Имена состояний, разумеется,
ваши; важно, что каждому соответствует свой токен:

```css
.badge[data-state="ok"]    .dot { background: var(--dsw-alias-brand-primary); }
.badge[data-state="warn"]  .dot { background: var(--dsw-alias-state-warn-primary); }
.badge[data-state="error"] .dot { background: var(--dsw-alias-state-error-primary); }
```

Нейтральный цвет точки задаётся как fallback — на один кадр до применения
атрибута состояния.

---

## 4. Открытие диалога

Состояние «открыт» хранит сам компонент слота — это локальный `useState`, а не
глобальный стор:

```tsx
const [open, setOpen] = useState(false)
const seat = useRef<HTMLButtonElement>(null)

const close = useCallback(() => {
  setOpen(false)
  seat.current?.focus()   // возврат фокуса на кнопку, которая открыла диалог
}, [])

return (
  <>
    <Badge /* ... */ onOpen={() => setOpen(true)} seat={seat} />
    {open ? <MyDialog onClose={close} /> : null}
  </>
)
```

Последовательность при нажатии:

1. Пользователь нажимает бейдж мышью, `Enter` или `Space` → `onClick` →
   `setOpen(true)`.
2. Компонент слота перерисовывается, в его дереве появляется `<MyDialog />`;
   `createPortal` переносит DOM диалога в `document.body`, но React-состояние и
   обработчики остаются в дереве плагина.
3. Эффект диалога фокусирует панель и вешает обработчик `keydown` на `document`.
4. Любой способ закрытия (Escape, клик по маске, крестик) вызывает `onClose` →
   `setOpen(false)` и `seat.current?.focus()`.
5. Диалог размонтируется, cleanup эффекта снимает `keydown`; в шапке снова
   остаётся только бейдж с фокусом.

Из этого следуют три свойства:

1. **Диалог монтируется при открытии и размонтируется при закрытии.** Значит,
   запрос данных (если он нужен) уходит ровно один раз на открытие, а ответ,
   пришедший после закрытия, отбрасывается размонтированием — без ручной
   отмены и без «залипшего» состояния.
2. **Фокус возвращает тот, кто его отдал.** Диалог не ищет «предыдущий
   элемент»: у компонента есть `ref` на кнопку, и закрытие возвращает фокус
   туда. Это же поведение требуется по доступности: после модалки фокус не
   должен улетать в начало страницы.
3. **Смена сущности сбрасывает диалог.** Если бейдж переиспользуется для другой
   сессии/объекта, `open` сбрасывается вместе с состоянием — иначе останется
   панель с чужими данными.

Пока данных для первого рендера нет, компонент возвращает пустой фрагмент
`<></>`, а не `null`: слот ожидает элемент от каждой регистрации, и пустой
фрагмент — это «ноль узлов» допустимого типа. Так шапка не мигает бейджем,
которому ещё не место.

---

## 5. Диалог: портал и слои

### 5.1. Почему портал

Слот шапки живёт в контейнере со своим `overflow` и своим контекстом
наложения. Диалог, отрисованный на месте, будет обрезан шапкой и окажется под
другими слоями. Портал в `document.body` снимает оба ограничения и позволяет
маске закрыть всю страницу.

```tsx
return createPortal(
  <div className={LAYER_CLASS} role="presentation">
    <div className={MASK_CLASS} aria-hidden="true" onClick={onClose} />
    <div
      ref={panel}
      className={PANEL_CLASS}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      {/* заголовок, тело */}
    </div>
  </div>,
  document.body,
)
```

### 5.2. Три слоя

| Слой | Стили | Роль |
| --- | --- | --- |
| `layer` | `position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px` | центрирует панель и держит маску |
| `mask` | `position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur)` | затемняет страницу; клик по нему = закрыть |
| `panel` | `position: relative; z-index: 1; …` | сама карточка; лежит **поверх** маски |

**Маска — сосед панели, а не её родитель.** Клик по панели не всплывает до
маски, поэтому «клик внутри» и «клик снаружи» различаются без проверки
координат и без `stopPropagation`. Слой при этом блокирует страницу под собой.

### 5.3. Панель

| Параметр | Значение (референс) |
| --- | --- |
| Ширина | `min(30rem, 100%)` |
| Максимальная высота | `100%` |
| Скругление | `var(--dsw-radius-panel)` |
| Фон | `var(--dsw-alias-bg-layer-2)` |
| Тень | `var(--dsw-elevation-prominent)` |
| Внутренние отступы | `14px 16px 16px` |
| Раскладка | `display: flex; flex-direction: column; overflow: hidden` |

Заголовок и кнопка закрытия — фиксированная шапка панели; скроллится только
тело (`overflow: auto; overscroll-behavior: contain; min-height: 0`), иначе
длинный список растянул бы карточку за экран и унёс кнопку закрытия.

### 5.4. Тело: три состояния вместо «пусто»

Тело — не просто список. У него есть различимые состояния, и каждое
проговаривается отдельной заметкой:

| Состояние | Что рисуется |
| --- | --- |
| загрузка | заметка «Loading…» |
| данные не получены | заметка «недоступно» (а не пустой список) |
| данные получены, список пуст | заметка «пока ничего нет» |
| данные есть | список строк |

Разница между «ничего не произошло» и «ответ не пришёл» — это разные
утверждения; пустой список вместо второго читается как ложь. Поэтому тело
описывается размеченным объединением (`loading | unavailable | ready`), а не
nullable-массивом с флагом.

---

## 6. Клавиатура, фокус, доступность

Диалог ведёт себя как модалка продукта, а не как «карточка с крестиком».

| Требование | Реализация |
| --- | --- |
| Фокус при открытии | панель получает фокус (`panel.current?.focus()`), диалог объявляется заголовком, Tab начинается внутри |
| `Escape` | закрывает; `event.isComposing` игнорируется, чтобы не закрывать во время ввода IME |
| Клик по подложке | закрывает; реализован кликом по маске-соседу |
| `Tab` не выходит наружу | обработчик `keydown` зацикливает фокус между первым и последним фокусируемым элементом панели |
| `aria-modal="true"` | говорит скринридеру, что страница позади инертна |
| Возврат фокуса | выполняет компонент-владелец кнопки, а не диалог |
| Заголовок как имя | `aria-labelledby` указывает на `id` заголовка (`useId`) |
| Кнопка закрытия | `aria-label` («Close …»), видимый текст `×` — декор |

Ловушка Tab:

```ts
const FOCUSABLE = 'button:not(:disabled), a[href], [tabindex="0"]'

function containTab(root: HTMLElement, event: KeyboardEvent): void {
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((i) => !i.hidden)
  const first = items[0] ?? root
  const last = items[items.length - 1] ?? root
  const active = root.ownerDocument.activeElement
  if (active === null || active === root || !root.contains(active)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
    return
  }
  if (event.shiftKey && active === first) {
    event.preventDefault()
    last.focus()
    return
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}
```

Обработчик клавиш ставится на `document` и снимается в cleanup эффекта.
`onClose` читается из `ref`, чтобы слушатель, установленный один раз, не
замыкался на устаревший колбэк.

---

## 7. Стили: один `<style>` на страницу

Клиентский бандл — единственный файл, который загружает страница. Импорт
`*.css` или CSS-модуль даст соседний файл, который никто не запросит. Поэтому
стили живут в TS как строки, а `apply` устанавливает их одним тегом:

```ts
const selector = `style[data-plugin-css="${CSS_MARKER}"]`

function installStyles(): () => void {
  if (document.querySelector(selector) !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = 'my-plugin'
  tag.dataset.pluginCss = CSS_MARKER
  tag.textContent = CSS
  document.head.append(tag)
  return () => {
    tag.remove()
  }
}
```

Два правила, которые делают это надёжным:

1. **Маркер + проверка** — повторная активация (HMR, второй корень страницы)
   переиспользует существующий тег, а не стопкой копий. Диспозер удаляет
   только тот тег, который создал сам; чужой тег не трогает.
2. **Имена классов — экспортируемые константы**, а не литералы в двух местах.
   Компонент импортирует `BADGE_CLASS`, `DOT_CLASS`, `PANEL_CLASS` и т.д.;
   переименование не может оставить разметку без стилей.

Состояние красится атрибутами (`data-state`, `data-tone`), а не inline-стилями:
JS называет состояние, таблица стилей решает, как оно выглядит. Это же
позволяет проверять стили тестами без браузера (наличие правила на каждое
состояние, только токены темы, guard для reduced motion).

---

## 8. Сборка клиентской половины

Клиентский загрузчик монтирует не ESM-модуль, а бандл, который при загрузке
вызывает `window.__ModuleLoader__.load({ id, factory })`:

```js
window.__ModuleLoader__.load({
  id: "my-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /* ...содержимое CJS-бандла... */

    return module.exports;
  },
});
```

Сборка (esbuild, `format: "cjs"`, `platform: "browser"`, `jsx: "automatic"`):

| Требование | Почему |
| --- | --- |
| `id` в обёртке = имя пакета | загрузчик сопоставляет бандл с плагином |
| `react`, `react/*`, `react-dom`, `react-dom/*`, `@deepseek-ai/*` — external | страница даёт единственный экземпляр React; встроенная копия сломает хуки, а `react-dom` нужен порталу |
| остальное встроено | бандл — единственное, что грузится; runtime-зависимость неоткуда взять |
| проверка в самом скрипте сборки | ошибка обёртки иначе проявляется только в браузере |

Проверки, которые стоит оставить в сборке: бандл начинается с вызова
загрузчика, `id` совпадает с `package.json`, среди входных файлов нет ничего
вне `src/`, нет предупреждений esbuild, все `require(...)` — литералы из
списка external.

`package.json`:

```json
{
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "scripts", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

`tsconfig.client.json` — отдельный: `lib: ["ES2022", "DOM", "DOM.Iterable"]`,
`jsx: "react-jsx"`, `noEmit: true`, `types: []`, include только
`src/client/**/*`.

---

## 9. Мини-скелет целиком

```tsx
// src/client/index.tsx
import type { ReactElement } from 'react'
import { MyBadge } from './badge.js'
import { CLIENT_CSS, CSS_MARKER } from './styles.js'

export const inject = ['slots']

const SLOT = 'conversation.session.header.utilities'

export function apply(ctx: ClientContext): () => void {
  const removeStyles = installStyles()
  const dispose = ctx.slots.inject(SLOT, () =>
    ctx.slots.register({ name: SLOT, id: 'my-plugin-badge', order: 30 }, MyBadge),
  )
  return () => {
    dispose()
    removeStyles()
  }
}
```

```tsx
// src/client/badge.tsx
export function MyBadge({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const seat = useRef<HTMLButtonElement>(null)
  const view = useView(sessionId) // ваш источник состояния; UI от него не зависит

  if (view === null) return <></> // ещё не знаем, место ли бейджу здесь

  const close = () => {
    setOpen(false)
    seat.current?.focus()
  }

  return (
    <>
      <button
        ref={seat}
        type="button"
        className={BADGE_CLASS}
        data-state={view.state}
        aria-label={view.ariaLabel}
        aria-haspopup="dialog"
        title={view.ariaLabel}
        onClick={() => setOpen(true)}
      >
        <span className={DOT_CLASS} aria-hidden="true" />
        {view.label ? <span className={LABEL_CLASS}>{view.label}</span> : null}
      </button>
      <span className={SR_ONLY_CLASS} role="status">{view.ariaLabel}</span>
      {open ? <MyDialog onClose={close} /> : null}
    </>
  )
}
```

```tsx
// src/client/dialog.tsx
export function MyDialog({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const titleId = useId()

  useEffect(() => {
    panel.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (event.key === 'Escape') {
        event.preventDefault()
        close.current()
        return
      }
      if (event.key === 'Tab' && panel.current !== null) containTab(panel.current, event)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return createPortal(
    <div className={LAYER_CLASS} role="presentation">
      <div className={MASK_CLASS} aria-hidden="true" onClick={onClose} />
      <div
        ref={panel}
        className={PANEL_CLASS}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className={HEAD_CLASS}>
          <h2 className={TITLE_CLASS} id={titleId}>Заголовок</h2>
          <button type="button" className={CLOSE_CLASS} aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </div>
        <div className={BODY_CLASS}>{/* список или заметка */}</div>
      </div>
    </div>,
    document.body,
  )
}
```

---

## 10. Чек-лист при переиспользовании

- [ ] Слот выбран `conversation.session.header.utilities` (или другой **list**-слот), id уникален, `order` не конфликтует с соседями.
- [ ] Регистрация обёрнута в `ctx.slots.inject`, `apply` возвращает диспозер.
- [ ] Бейдж — `<button type="button">`, а не `span`/`div` с `onClick`.
- [ ] Есть `aria-label` для **всех** состояний, `aria-haspopup="dialog"`, `title`.
- [ ] Точка помечена `aria-hidden="true"`; рядом есть `role="status"` регион.
- [ ] Цвета — только `--dsw-*`; состояние передаётся `data-*`, не inline-стилем.
- [ ] Видимая подпись обрезается (`max-width` + `ellipsis`) и не является единственным носителем смысла.
- [ ] Фокус при открытии — на панели; `Escape`, клик по маске и `Tab`-ловушка работают.
- [ ] Фокус после закрытия возвращается на бейдж.
- [ ] Диалог в портале `document.body`; маска — сосед панели.
- [ ] Тело различает «загрузка / недоступно / пусто / данные».
- [ ] Стили ставятся одним `<style>` с маркером; диспозер удаляет тег.
- [ ] Сборка оборачивает бандл в `__ModuleLoader__.load`, React и ReactDOM — external.
- [ ] `prefers-reduced-motion` отключает переходы.

---

## 11. Типичные ошибки

| Ошибка | Последствие |
| --- | --- |
| `span` с `onClick` вместо `button` | бейдж недостижим с клавиатуры, не объявляется контролом, фокус некуда возвращать |
| диалог отрисован внутри слота | обрезан `overflow` шапки, лежит под другими слоями |
| маска — родитель панели | клик по панели закрывает диалог (всплытие) |
| `null` вместо `<></>` до первого ответа | слот получает не элемент; шапка может падать или мигать |
| цвет задан inline в JS | не работает смена темы, стили нельзя проверить тестом |
| `role="status"` на кнопке | роль кнопки побеждает, анонс теряется |
| импорт `*.css` | esbuild эмитит соседний файл, который страница не загружает |
| `import React from 'react'` без external | в бандл попадает вторая копия React, хуки ломаются |
| закрытие только по крестику | нарушены ожидания модалки: Escape и клик вне |

---

## 12. Референс

Паттерн снят с клиентской половины этого плагина (в текущей ветке она лежит в
истории — ветка `sea/master`, каталог `src/client/`):

| Файл | Что показывает |
| --- | --- |
| `src/client/index.tsx` | регистрация слота, установка стилей, диспозер |
| `src/client/indicator.tsx` | кнопка-бейдж, живой регион, локальный `open`, возврат фокуса |
| `src/client/history-dialog.tsx` | портал, маска, панель, Escape, `containTab` |
| `src/client/styles.ts` | классы-константы, CSS-строки, токены, reduced motion |
| `scripts/build-client.mjs` | обёртка загрузчика, external, проверки контракта |

Логика плагина (что означает состояние, откуда берутся строки списка, как
часто обновляется бейдж) намеренно не описана: при переносе меняются только
источник состояния, словарь подписей и содержимое тела диалога.
