# Quizlet to Anki Exporter

Автоматический экспорт карточек из Quizlet в Anki (CSV/APKG).

## Возможности

- ✅ Автоматический вход в аккаунт Quizlet
- ✅ Сбор всех наборов карточек из класса
- ✅ Извлечение пар слов (английский → русский)
- ✅ Скачивание изображений и аудио
- ✅ Экспорт в CSV и .apkg форматы
- ✅ **Генерация отдельных .apkg файлов для каждого набора**
- ✅ **Автоматическое скачивание и вставка аудио в карточки**
- ✅ Обход CAPTCHA через интерактивный режим
- ✅ **Автосохранение прогресса** — можно возобновить после ошибки
- ✅ **Desktop уведомления** — уведомления об ошибках и завершении
- ✅ **Логирование неудач** — файл `failed-sets.log` с ошибками

## Установка

```bash
npm install
npx playwright install chromium
```

## Настройка

Отредактируйте `.env`:

```env
# URL страницы класса
QUIZLET_CLASS_URL=https://quizlet.com/class/23779606/materials

# Логин/пароль от Quizlet
QUIZLET_EMAIL=your@email.com
QUIZLET_PASSWORD=yourpassword

# Формат вывода: csv, apkg, или both
OUTPUT_FORMAT=both

# Имя выходного файла
OUTPUT_FILENAME=quizlet-export

# Headless режим (true/false)
HEADLESS=true

# Задержка между запросами (мс) - увеличьте при 429 ошибках
REQUEST_DELAY=5000

# Интерактивный режим (true/false)
INTERACTIVE=true
```

## Использование

### Быстрый старт

```bash
npm start
```

### Команды

| Команда | Описание |
|---------|----------|
| `npm start` | Запуск скрапинга |
| `npm start -- --fresh` | Начать заново, игнорировать прогресс |
| `npm start -- --resume` | Возобновить с неудачных URL |
| `npm start -- --help` | Показать справку |

### Как это работает

1. **Первый запуск:**
   - Открывается браузер
   - Скрипт входит в аккаунт (если указаны логин/пароль)
   - Переходит на страницу класса
   - Извлекает все URL наборов карточек
   - Сохраняет прогресс в `url-progress.json`
   - Скрапит каждый набор и **сразу сохраняет** в `output/cards.json`

2. **Если произошла ошибка:**
   - Прогресс сохраняется в `url-progress.json`
   - Ошибка записывается в `failed-sets.log`
   - Запустите `npm start -- --resume` для продолжения

3. **После завершения:**
   - Все карточки в `output/cards.json`
   - Установите `INTERACTIVE=false` и запустите снова для экспорта в Anki

### Интерактивный режим

Браузер остаётся открытым для ручного обхода Cloudflare/CAPTCHA:

```env
INTERACTIVE=true
```

```bash
npm start
```

- Скрипт автоматически обрабатывает Cloudflare (ждёт пока вы пройдёте)
- Вы получаете **desktop уведомления** о статусе
- Нажмите **Ctrl+C** для сохранения сессии

### Экспорт в Anki

```env
INTERACTIVE=false
HEADLESS=true
```

```bash
npm start
```

Скрипт:
- Загрузит карточки из `output/cards.json`
- Скачает изображения и аудио
- Создаст CSV и .apkg файлы

### Генерация отдельных APKG для каждого набора

После скрапинга запустите генератор:

```bash
npm run anki
```

Это создаст:
- **Отдельный .apkg файл для каждого набора карточек**
- Имя файла соответствует названию набора
- Все аудиофайлы скачиваются и вставляются в карточки
- Файлы сохраняются в папку `anki-output/`

Пример:
```
anki-output/
├── A1_Outcomes_Unit_1.apkg
├── A1_Outcomes_Unit_2.apkg
├── A2_Vocabulary_Unit_5.apkg
└── media/
    ├── audio_A1_Outcomes_Unit_1_0.mp3
    ├── audio_A1_Outcomes_Unit_1_1.mp3
    └── ...
```

## Результат

- `output/cards.json` — собранные карточки
- `output/quizlet-export.csv` — CSV файл
- `output/quizlet-export.apkg` — общий Anki пакет
- `anki-output/` — отдельные APKG для каждого набора
- `media/` — изображения и аудио файлы
- `url-progress.json` — прогресс скрапинга
- `failed-sets.log` — логи ошибок

### Импорт в Anki

1. Откройте Anki
2. File → Import
3. Выберите `output/quizlet-export.apkg`
4. Готово!

## Структура проекта

```
quizlet-downloader/
├── src/
│   ├── index.js          # Главный скрипт
│   ├── scraper.js        # Логика парсинга
│   ├── exporter.js       # Экспорт CSV/APKG
│   ├── utils.js          # Утилиты
│   └── anki-generator.js # Генерация отдельных APKG
├── output/
│   ├── cards.json        # Собранные карточки
│   ├── *.csv             # CSV экспорт
│   └── *.apkg            # Общий Anki пакет
├── anki-output/          # Отдельные APKG для каждого набора
│   ├── *.apkg
│   └── media/            # Аудио файлы для APKG
├── media/                # Изображения и аудио
├── .env                  # Конфигурация
├── .storage-state.json   # Сессия браузера
├── url-progress.json     # Прогресс скрапинга
├── failed-sets.log       # Логи ошибок
└── package.json
```

## Решение проблем

### CAPTCHA / Cloudflare

- Используйте интерактивный режим
- Скрипт автоматически ждёт пока вы пройдёте проверку
- Вы получите уведомление когда Cloudflare будет пройден

### 429 Rate Limit

Увеличьте задержку в `.env`:

```env
REQUEST_DELAY=10000
```

### Не нашёл наборы

- Проверьте URL класса
- Убедитесь, что наборы публичные или вы вошли в аккаунт
- Посмотрите скриншоты в `output/debug-*.png`

### Возобновление после ошибки

```bash
# Продолжить с неудачных URL
npm start -- --resume

# Начать заново
npm start -- --fresh
```

### Проверка прогресса

Откройте `url-progress.json` — там статус каждого URL:
- `pending` — ещё не обработан
- `completed` — успешно обработан
- `failed` — ошибка при обработке