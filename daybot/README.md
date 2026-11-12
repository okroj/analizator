# Daybot – bot dzienny do „Pulpitu sygnałów”

Mały program, który sam handluje w ciągu jednej sesji giełdy w USA: kupuje chwilę po otwarciu,
sprzedaje 5 minut przed zamknięciem i nigdy nie zostawia pozycji na noc. Działa z brokerem Alpaca,
domyślnie na koncie testowym (paper), czyli na wirtualnych pieniądzach.

To narzędzie do nauki i automatyzacji, a nie porada inwestycyjna. Wynik z przeszłości nie gwarantuje
wyniku w przyszłości, a przewaga tej strategii jest mała (liczby niżej).

## Strategia: „odbicie po wyprzedaży”

1. Przed otwarciem bot liczy dla każdej spółki z listy dwa wskaźniki z wczorajszej sesji:
   RSI z 2 sesji oraz IBS (w którym miejscu dziennego zakresu wypadło zamknięcie).
2. Sygnał ma spółka, która zamknęła się mocno wyprzedana: RSI(2) < 10 i zamknięcie w dolnych 20% zakresu dnia.
3. Bot handluje tylko wtedy, gdy sygnał mają **co najmniej 2 spółki naraz** (szersza wyprzedaż, a nie zła
   wiadomość o jednej firmie). Kupuje do 4 najbardziej wyprzedanych, każdą za 1/4 kapitału bota.
4. Kupno 30 sekund po otwarciu, sprzedaż 5 minut przed zamknięciem tej samej sesji.

### Wynik na danych historycznych

16 spółek z Pulpitu, notowania dzienne 2008-01-01 – 2026-11-10, koszt 5 punktów bazowych na każdą stronę
transakcji (spread i poślizg). Reguły dobierane na latach 2008–2018 i sprawdzane na 2019–2026.
Okres sprawdzający nie był w pełni „ślepy”: widziałem go, wybierając między wariantami, więc traktuj go
jako potwierdzenie, a nie dowód.

| Okres | Transakcji | Średnio na transakcję | Trafność | Rocznie | Największy spadek | Dni z transakcją |
|---|---|---|---|---|---|---|
| 2008–2018 (dobór reguł) | 1172 | +0,19% | 51% | +4,9% | −16% | 14% |
| 2019–2026 (sprawdzenie) | 948 | +0,24% | 52% | +7,1% | −11% | 16% |
| ostatnie 3 lata | 379 | +0,22% | 51% | +6,6% | −11% | 17% |

Jak to czytać:

- Trafność to niewiele ponad połowę. Cała przewaga to średnio ok. 0,2% na transakcję.
- Przy koszcie 10 pb na stronę wynik spada do ok. 2–4% rocznie, przy 15 pb znika. Dlatego najważniejsze,
  co sprawdza konto testowe, to prawdziwe ceny realizacji (komenda `review`).
- Lata 2011, 2012 i 2016 były na minusie, a 2026 do 10 listopada jest w okolicach zera (−0,9%).
- Lista zawiera spółki, które okazały się zwycięzcami, więc historia jest dla niej łaskawa.
- Bot handluje średnio przez ok. 3 dni w miesiącu. W pozostałe dni nic nie robi i to jest poprawne.

Ten sam rachunek możesz powtórzyć: `node bot.js backtest --csv KATALOG_Z_CSV`
(pliki `SYMBOL.csv` w formacie Pulpitu: `date,open,high,low,close,volume,...`).

### Co sprawdziłem i odrzuciłem

Na tych samych danych: kupowanie wybić w górę, granie luk w dół i w górę oraz kupowanie spadków w trakcie sesji.
Wybicia i luki traciły po kosztach. Kupowanie spadków w trakcie sesji wyglądało świetnie tylko przy założeniu,
że zlecenie realizuje się przy każdym dotknięciu ceny; po urealnieniu tego założenia zysk znikał.
Takie strategie da się uczciwie ocenić dopiero na danych minutowych.

## Uruchomienie

Potrzebny jest Node.js w wersji 18 lub nowszej. Bot nie ma żadnych zewnętrznych bibliotek.

```
cp config.example.json config.json
cp .env.example .env          # wpisz klucze API konta PAPER z panelu Alpaca
npm test                      # testy z atrapą brokera, bez internetu
node bot.js status            # sprawdza połączenie i konto
node bot.js plan              # co bot kupiłby na najbliższej sesji
node bot.js run --dry-run     # cała sesja „na sucho”, bez żadnych zleceń
node bot.js run               # prawdziwa sesja na koncie testowym
```

`node bot.js run` obsługuje jedną sesję i kończy pracę. Uruchamiaj go w dni robocze przed otwarciem
giełdy w USA, np. o 14:00 czasu polskiego: bot sam czeka na otwarcie, a w dni bez sesji od razu kończy.

Na serwerze domowym z systemd: skopiuj pliki z `deploy/` do `/etc/systemd/system/`, popraw w nich
użytkownika i katalog, a potem `systemctl enable --now daybot.timer`. Alternatywa w cronie:

```
CRON_TZ=Europe/Warsaw
0 14 * * 1-5  cd /opt/daybot && /usr/bin/node bot.js run >> logs/cron.log 2>&1
```

## Ustawienia (`config.json`)

| Pole | Znaczenie |
|---|---|
| `mode` | `paper` (konto testowe) albo `live` (prawdziwe pieniądze) |
| `capitalUsd` | kapitał oddany botowi; jedna pozycja to `capitalUsd / maxPos` |
| `maxOrderUsd` | twardy limit wartości jednego zlecenia |
| `entryDelaySec`, `entryWindowSec` | kiedy po otwarciu kupować i po jakim czasie już nie kupować |
| `exitMinutesBeforeClose` | ile minut przed zamknięciem sprzedawać |
| `dryRun` | `true` = bez zleceń, tylko zapis tego, co bot by zrobił |
| `strategy` | `rsiMax`, `ibsMax`, `minSignals`, `maxPos`, `stopAtr` (0 = bez stopu), `costBps` (tylko backtest) |

## Bezpieczniki

- Domyślnie konto testowe. Tryb `live` wymaga wpisania w `config.json` pola
  `"liveConfirmed": "TAK-PRAWDZIWE-PIENIADZE"` i kapitału nie większego niż `liveMaxCapitalUsd`.
- Bot sprzedaje tylko to, co sam tego dnia kupił, i nigdy więcej, niż jest na koncie.
- Każde zlecenie ma stały identyfikator (`daybot-DATA-SPÓŁKA-buy/sell`), więc ponowne uruchomienie
  tego samego dnia niczego nie dubluje. Zlecenia nie są ponawiane na ślepo.
- Wyłącznik awaryjny: utwórz w katalogu bota pusty plik `STOP`. Bot przestaje kupować i przy najbliższym
  sprawdzeniu (do minuty) sprzedaje swoje pozycje. `node bot.js flatten` robi to samo od ręki.
- Klucze API trzymaj tylko w pliku `.env` na serwerze. Plik jest w `.gitignore`.

## Co bot zapisuje

- `state/RRRR-MM-DD.json` – pełny stan dnia: plan, zlecenia, ceny, wynik.
- `logs/bot.log` – dziennik zdarzeń; `logs/trades.csv` – jedna linia na transakcję.
- `node bot.js review` – porównuje ceny kupna i sprzedaży z oficjalnym otwarciem i zamknięciem,
  czyli pokazuje, ile naprawdę kosztuje realizacja w porównaniu z założeniem backtestu.

## Czego jeszcze nie sprawdzono

- Bot nie był uruchomiony z prawdziwymi kluczami Alpaca. Logika sesji i warstwa połączenia przechodzą
  testy na atrapach, a adresy i nazwy pól są zgodne z oficjalną biblioteką Alpaca (wersja 5.0.0),
  ale pierwsze uruchomienie na koncie testowym zrób z `status`, potem `run --dry-run`.
- Cena kupna 30 sekund po otwarciu będzie się różnić od oficjalnej ceny otwarcia użytej w backteście.
  O ile, pokaże `review` po kilkunastu transakcjach.
- Przed trybem `live` z małą kwotą sprawdź u Alpaca, czy konto nie podlega jeszcze staremu limitowi
  transakcji dziennych (pattern day trader). Bot wtedy dostanie odmowę zlecenia i zapisze ją w dzienniku.

## Pliki

```
bot.js              komendy: plan, run, status, flatten, backtest, review
lib/strategy.js     reguły strategii (wspólne dla bota i backtestu)
lib/backtest.js     backtest na notowaniach dziennych
lib/session.js      przebieg jednej sesji
lib/alpaca.js       połączenie z Alpaca
lib/data.js         wczytywanie plików CSV
test/               testy: selftest.js (sesja), apitest.js (połączenie)
deploy/             pliki systemd do codziennego uruchamiania
```
