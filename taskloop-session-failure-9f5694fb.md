## Выявлена проблема

Taskloop остановился из-за **ошибки уплотнения (compaction) вследствие превышения rate limit LLM-провайдера**.

---

## Ход событий

Taskloop работал над OpenSpec change.

- **Задача 1.1 — выполнена и подтверждена** (`progress: 1/9 complete, state: ready`, seq 153).
  - Модель корректно остановилась для паузы (seq 162–165), turn 2 помечен как `completed`.
- Затем taskloop запустил **уплотнение контекста перед задачей 1.2** и трижды подряд упёрся в rate limit провайдера `t-tech`.

Компакции (compaction):
```
seq=167  compaction/end → error: 429 "rate limit exceeded: quota tpm limit exceeded"
seq=169  compaction/end → error: 429 "rate limit exceeded: quota tpm limit exceeded"
seq=171  compaction/end → error: 429 "rate limit exceeded: quota tpm limit exceeded"
```

---

## Финальное сообщение об ошибке (seq 172)

> **`kind: error`**
> `taskloop: OpenSpec root: /home/ext.asfadeev/work/_ext/dsh-llm-fallback-switch. Change "handle-backup-http-429-quota" (1/9 tasks done). sent task 1.1; compaction before task 1.2 failed after 3 attempts (summary): manual compaction could not produce a smaller summary; the run stopped and no further task was sent.`

---

## Ключевые факты

- **Прямая причина:** превышена квота **TPM** (HTTP 429, `quota tpm limit exceeded`) у провайдера `t-tech`.
- **Триггер остановки:** taskloop выполняет уплотнение контекста между задачами; после 3 безуспешных попыток (все — 429, суммаризация не смогла получить ответ модели) run остановился и **задача 1.2 не была отправлена**.
