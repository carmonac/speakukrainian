import type { FlatStrings } from './h5p.translations.js';

/**
 * The H5P player's own chrome in Ukrainian.
 *
 * **Why this is not a `LocalizedText` in `packages/shared`.** These are H5P's
 * own i18next keys with H5P's own values, and the shape is upstream's: one flat
 * `Record<string, string>` per locale, keyed by the names in
 * `@lumieducation/h5p-server`'s `build/assets/translations/client/`. Nothing
 * here is admin-authored and no admin screen edits it, so it is not domain
 * content and CLAUDE.md rule 1 does not reach it. It is the one place in the
 * product where a translation is not a `LocalizedText`; see ADR-007.
 *
 * **Why a `.ts` module and not a `uk.json`.** A source file compiles and ships
 * like every other one. A JSON file would raise a build question — whether
 * `nest build` copies it into `dist`, whether the Docker `pnpm deploy` carries
 * it — for a feature that has no other build risk.
 *
 * **The key set is upstream's, not ours.** It is exactly the flattened key set
 * of upstream's `client/en.json`, and `h5p.translations.spec.ts` asserts that.
 * When that test fails after a dependency bump, upstream added, removed or
 * renamed a key: add or remove the key here to match. **Do not delete the
 * test** — it is the only thing that turns an upstream rename from a label
 * silently reverting to English into a failure on the commit that caused it.
 *
 * Keys are written flat, including the three `discipline.*` ones, because flat
 * is the form the lookup in `h5p.translations.ts` uses.
 */
export const UK_CLIENT_STRINGS: FlatStrings = {
  fullscreen: 'На весь екран',
  disableFullscreen: 'Вийти з повноекранного режиму',
  download: 'Завантажити',
  copyrights: 'Права на використання',
  embed: 'Вбудувати',
  size: 'Розмір',
  showAdvanced: 'Показати додаткові параметри',
  hideAdvanced: 'Сховати додаткові параметри',
  advancedHelp:
    'Додайте цей скрипт на свій сайт, якщо хочете, щоб розмір вбудованого вмісту змінювався динамічно:',
  copyrightInformation: 'Права на використання',
  close: 'Закрити',
  title: 'Назва',
  author: 'Автор',
  year: 'Рік',
  source: 'Джерело',
  license: 'Ліцензія',
  thumbnail: 'Мініатюра',
  noCopyrights: 'Для цього вмісту немає відомостей про авторські права.',
  reuse: 'Використати повторно',
  reuseContent: 'Використати вміст повторно',
  reuseDescription: 'Використайте цей вміст повторно.',
  downloadDescription: 'Завантажте цей вміст як файл H5P.',
  copyrightsDescription: 'Перегляньте відомості про авторські права на цей вміст.',
  embedDescription: 'Перегляньте код для вбудовування цього вмісту.',
  h5pDescription: 'Відвідайте H5P.org, щоб знайти більше цікавого вмісту.',
  contentChanged: 'Цей вміст змінився з часу вашого останнього використання.',
  startingOver: 'Ви почнете спочатку.',
  // Rendered between a title and an author name, as `<title> by <author>`.
  by: 'автор',
  showMore: 'Показати більше',
  showLess: 'Показати менше',
  subLevel: 'Підрівень',
  confirmDialogHeader: 'Підтвердьте дію',
  confirmDialogBody: 'Підтвердьте, будь ласка, що хочете продовжити. Цю дію не можна скасувати.',
  cancelLabel: 'Скасувати',
  confirmLabel: 'Підтвердити',
  licenseU: 'Не вказано',
  // The Creative Commons licence names in the forms Creative Commons itself
  // uses for Ukrainian, rather than transliterations of the English.
  licenseCCBY: 'Із зазначенням авторства',
  licenseCCBYSA: 'Із зазначенням авторства — Поширення на тих самих умовах',
  licenseCCBYND: 'Із зазначенням авторства — Без похідних творів',
  licenseCCBYNC: 'Із зазначенням авторства — Некомерційна',
  licenseCCBYNCSA: 'Із зазначенням авторства — Некомерційна — Поширення на тих самих умовах',
  licenseCCBYNCND: 'Із зазначенням авторства — Некомерційна — Без похідних творів',
  licenseCC40: '4.0 Міжнародна',
  licenseCC30: '3.0 Неадаптована',
  licenseCC25: '2.5 Загальна',
  licenseCC20: '2.0 Загальна',
  licenseCC10: '1.0 Загальна',
  licenseGPL: 'Загальна публічна ліцензія',
  licenseV3: 'Версія 3',
  licenseV2: 'Версія 2',
  licenseV1: 'Версія 1',
  licensePD: 'Суспільне надбання',
  licenseCC010: 'CC0 1.0 Universal (CC0 1.0) — передання у суспільне надбання',
  licensePDM: 'Позначка суспільного надбання',
  licenseC: 'Авторське право',
  contentType: 'Тип вмісту',
  licenseExtras: 'Додаткові умови ліцензії',
  changes: 'Журнал змін',
  contentCopied: 'Вміст скопійовано до буфера обміну',
  connectionLost:
    "З'єднання втрачено. Результати буде збережено й надіслано, щойно з'єднання відновиться.",
  connectionReestablished: "З'єднання відновлено.",
  resubmitScores: 'Спроба надіслати збережені результати.',
  offlineDialogHeader: "З'єднання із сервером втрачено",
  offlineDialogBody:
    "Не вдалося надіслати відомості про виконання цього завдання. Перевірте, будь ласка, з'єднання з інтернетом.",
  offlineDialogRetryMessage: 'Повторна спроба через :num....',
  offlineDialogRetryButtonLabel: 'Повторити зараз',
  offlineSuccessfulSubmit: 'Результати успішно надіслано.',
  mainTitle: 'Оприлюднення <strong>:title</strong>',
  editInfoTitle: 'Редагування відомостей про <strong>:title</strong>',
  cancel: 'Скасувати',
  back: 'Назад',
  next: 'Далі',
  reviewInfo: 'Перевірити відомості',
  share: 'Поділитися',
  saveChanges: 'Зберегти зміни',
  registerOnHub: 'Зареєструватися в H5P Hub',
  updateRegistrationOnHub: 'Зберегти налаштування облікового запису',
  requiredInfo: "Обов'язкові відомості",
  optionalInfo: 'Додаткові відомості',
  reviewAndShare: 'Перевірити й поділитися',
  reviewAndSave: 'Перевірити й зберегти',
  shared: 'Оприлюднено',
  currentStep: 'Крок :step з :total',
  sharingNote: 'Усі відомості про вміст можна змінити після оприлюднення',
  licenseDescription: 'Виберіть ліцензію для свого вмісту',
  licenseVersion: 'Версія ліцензії',
  licenseVersionDescription: 'Виберіть версію ліцензії',
  disciplineLabel: 'Дисципліни',
  disciplineDescription: 'Можна вибрати кілька дисциплін',
  disciplineLimitReachedMessage: 'Можна вибрати щонайбільше :numDisciplines дисциплін',
  'discipline.searchPlaceholder': 'Введіть текст, щоб знайти дисципліни',
  'discipline.in': 'у',
  'discipline.dropdownButton': 'Кнопка розкривного списку',
  removeChip: 'Вилучити :chip зі списку',
  keywordsPlaceholder: 'Додайте ключові слова',
  keywords: 'Ключові слова',
  keywordsDescription:
    'Можна додати кілька ключових слів, розділених комами. Натисніть «Enter» або «Додати», щоб підтвердити ключові слова',
  altText: 'Альтернативний текст',
  reviewMessage: 'Перегляньте, будь ласка, наведені нижче відомості, перш ніж ділитися',
  subContentWarning:
    'Вкладений вміст (зображення, запитання тощо) буде поширено за ліцензією :license, якщо в редакторі не вказано інше',
  disciplines: 'Дисципліни',
  shortDescription: 'Короткий опис',
  longDescription: 'Розгорнутий опис',
  icon: 'Піктограма',
  screenshots: 'Знімки екрана',
  helpChoosingLicense: 'Допоможіть вибрати ліцензію',
  shareFailed: 'Не вдалося поділитися.',
  editingFailed: 'Не вдалося відредагувати.',
  shareTryAgain: 'Щось пішло не так, спробуйте поділитися ще раз.',
  pleaseWait: 'Зачекайте, будь ласка...',
  language: 'Мова',
  level: 'Рівень',
  shortDescriptionPlaceholder: 'Короткий опис вашого вмісту',
  longDescriptionPlaceholder: 'Розгорнутий опис вашого вмісту',
  description: 'Опис',
  iconDescription: '640x480 пікселів. Якщо не вибрано, вміст використає піктограму категорії',
  screenshotsDescription: "Додайте до п'яти знімків екрана вашого вмісту",
  submitted: 'Надіслано!',
  isNowSubmitted: 'Тепер надіслано до H5P Hub',
  changeHasBeenSubmitted: 'Надіслано зміну для',
  contentAvailable: "Зазвичай ваш вміст з'являється в H5P Hub протягом одного робочого дня.",
  contentUpdateSoon: 'Ваш вміст незабаром оновиться',
  contentLicenseTitle: 'Відомості про ліцензію вмісту',
  licenseDialogDescription: 'Натисніть на певну ліцензію, щоб дізнатися про належне використання',
  publisherFieldTitle: 'Видавець',
  publisherFieldDescription: "Це відображатиметься як «Ім'я видавця» для оприлюдненого вмісту",
  emailAddress: 'Адреса електронної пошти',
  publisherDescription: 'Опис видавця',
  publisherDescriptionText:
    'Це відображатиметься в розділі «Відомості про видавця» для оприлюдненого вмісту',
  contactPerson: 'Контактна особа',
  phone: 'Телефон',
  address: 'Адреса',
  city: 'Місто',
  zip: 'Поштовий індекс',
  country: 'Країна',
  logoUploadText: 'Логотип або аватар організації',
  acceptTerms: "Я приймаю <a href=':url' target='_blank'>умови використання</a>",
  successfullyRegistred: 'Ви успішно зареєстрували обліковий запис у H5P Hub',
  successfullyRegistredDescription: 'Дані вашого облікового запису можна змінити',
  successfullyUpdated: 'Налаштування вашого облікового запису H5P Hub успішно змінено',
  accountDetailsLinkText: 'тут',
  registrationTitle: 'Реєстрація в H5P Hub',
  registrationFailed: 'Сталася помилка',
  registrationFailedDescription:
    'Наразі не вдалося створити обліковий запис. Щось пішло не так. Спробуйте пізніше.',
  maxLength: 'Максимальна кількість символів — :length',
  keywordExists: 'Таке ключове слово вже є!',
  licenseDetails: 'Подробиці ліцензії',
  remove: 'Вилучити',
  removeImage: 'Вилучити зображення',
  cancelPublishConfirmationDialogTitle: 'Скасувати оприлюднення',
  cancelPublishConfirmationDialogDescription:
    'Ви впевнені, що хочете скасувати процес оприлюднення?',
  cancelPublishConfirmationDialogCancelButtonText: 'Ні',
  cancelPublishConfirmationDialogConfirmButtonText: 'Так',
  add: 'Додати',
  age: 'Типовий вік',
  ageDescription:
    'Цільова аудиторія цього вмісту. Можливі формати вводу, розділені комами: «1,34-45,-50,59-».',
  invalidAge:
    'Хибний формат поля «Типовий вік». Можливі формати вводу, розділені комами: «1, 34-45, -50, -59-».',
  contactPersonDescription:
    "H5P звертатиметься до контактної особи, якщо з вмістом, оприлюдненим видавцем, виникнуть проблеми. Ім'я контактної особи та інші її дані не буде опубліковано чи передано третім сторонам",
  emailAddressDescription:
    'H5P використовуватиме адресу електронної пошти, щоб звернутися до видавця, якщо з вмістом виникнуть проблеми або якщо видавцеві потрібно буде відновити обліковий запис. Її не буде опубліковано чи передано третім сторонам',
  copyrightWarning:
    'Матеріали, захищені авторським правом, не можна поширювати в H5P Content Hub. Якщо вміст має ліцензію, дружню до відкритих освітніх ресурсів, як-от Creative Commons, виберіть відповідну ліцензію. Якщо ні, цим вмістом поділитися не можна.',
  keywordsExits: 'Такі ключові слова вже є!',
  someKeywordsExits: 'Деякі з цих ключових слів уже є',
  width: 'ширина',
  height: 'висота',
  rotateLeft: 'Повернути ліворуч',
  rotateRight: 'Повернути праворуч',
  cropImage: 'Обрізати зображення',
  confirmCrop: 'Підтвердити обрізання',
  cancelCrop: 'Скасувати обрізання',
};
