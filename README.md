# Analizator giełdy

Aplikacja do testowania własnych reguł kupna i sprzedaży akcji oraz do pilnowania portfela. Działa jako zwykła strona na GitHub Pages i sama aktualizuje notowania raz dziennie.

## Uruchomienie (jednorazowo)

1. Załóż darmowe konto na [github.com](https://github.com).
2. Utwórz repozytorium: przycisk **New repository**, nazwa np. `analizator`, widoczność **Public**, bez dodawania README.
3. Włącz stronę: w repozytorium wejdź w **Settings → Pages** i w polu **Source** wybierz **GitHub Actions**.
4. Wgraj pliki: wróć na główną stronę repozytorium, kliknij **uploading an existing file** (albo **Add file → Upload files**), przeciągnij całą zawartość tej paczki razem z folderami `.github` i `scripts`, a na dole kliknij **Commit changes**.
5. Poczekaj 1–2 minuty. W zakładce **Actions** pojawi się przebieg „Aktualizacja notowań”. Zielony znaczek oznacza, że aplikacja jest opublikowana.
6. Adres aplikacji to `https://TWOJA-NAZWA.github.io/analizator/`. Znajdziesz go też w **Settings → Pages**.

Jeśli folder `.github` się nie wgrał (część przeglądarek pomija foldery zaczynające się od kropki), utwórz plik ręcznie: **Add file → Create new file**, w polu nazwy wpisz `.github/workflows/update.yml`, wklej treść tego pliku z paczki i zatwierdź.

Jeśli pierwszy przebieg zakończył się czerwonym znaczkiem, otwórz go w zakładce **Actions** i kliknij **Re-run all jobs**. Najczęstsza przyczyna to pominięty krok 3.

## Instalacja jak zwykłej aplikacji

- **Android (Chrome):** otwórz adres aplikacji, w menu przeglądarki wybierz **Zainstaluj aplikację** albo **Dodaj do ekranu głównego**.
- **Windows (Chrome lub Edge):** otwórz adres aplikacji i kliknij ikonę instalacji po prawej stronie paska adresu.

Po instalacji aplikacja otwiera się we własnym oknie, a bez internetu pokazuje ostatnio pobrane dane.

## Jak działa aktualizacja

- Automat GitHuba uruchamia się od wtorku do soboty o 05:17 UTC, po sesji w USA. Możesz go też uruchomić ręcznie: **Actions → Aktualizacja notowań → Run workflow**.
- Skrypt `scripts/update.js` pobiera notowania, składa plik `data.js` i publikuje stronę.
- Jeśli pobieranie się nie powiedzie, stare dane zostają, a GitHub wysyła e-mail o nieudanym przebiegu.

## Dodawanie spółek

Otwórz plik `tickers.json`, kliknij ikonę ołówka i dopisz wiersz, na przykład:

```json
{ "s": "KO", "n": "Coca-Cola" }
```

Po zatwierdzeniu zmiany automat sam pobierze notowania nowej spółki. Dla tych spółek aplikacja ma same kursy, więc działają one w Portfelu, ale nie biorą udziału w teście ani w Skanerze.

## Skąd są dane

- 16 spółek do testu i Skanera (kursy i zysk na akcję): zbiór Pubmarks na GitHubie.
- Spółki z `tickers.json` (same kursy): Yahoo Finance, a gdy ono nie odpowiada, Stooq. To źródła nieoficjalne i mogą czasem nie działać.

## Prywatność

Repozytorium jest publiczne i zawiera tylko aplikację oraz notowania. Portfele i ustawienia każdej osoby są zapisane wyłącznie w jej przeglądarce i nie trafiają na GitHub.

## Ograniczenia

- Aplikacja liczy w dolarach, więc spółki z GPW nie są jeszcze obsługiwane.
- Nie wysyła powiadomień. Polecenia widać po otwarciu zakładki Portfel.
- To narzędzie sprawdza reguły na danych historycznych. Nie jest rekomendacją inwestycyjną.
