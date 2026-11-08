# Geo Game

A same-screen geography quiz for 2 to 8 players. Spin a category, spin a country, answer, and collect countries. Most countries wins.

**Play online:** https://tobymalkin.github.io/Geo-Game/

It is a static website: plain HTML, CSS and JavaScript, no build step, no tracking, no external libraries or fonts.

## How to play (hot-seat)

Everyone shares one screen and takes turns.

1. On the setup screen, enter 2 to 8 player names and choose an answer mode.
2. On your turn, spin the category wheel, then the country wheel. The country is drawn from the countries nobody has won yet.
3. Answer the question. A right answer wins you that country and nobody else can win it afterwards.
4. Right or wrong, that category is used up for you, so each player answers each category once.
5. The game ends when every player has voted to end (checked at the end of a round), when nobody has categories left, or when every country is won. The player with the most countries wins. A map of each player's empire is shown at the end.

### Answer modes

- **Type answers:** type your answer and it is checked for you. Spelling is forgiving (accents, case, "the", small typos), numbers accept suffixes such as k, m and bn, and numeric categories have a tolerance. If the check is wrong, the players can overrule it on the reveal screen.
- **Display answers (couch play):** say your answer out loud, reveal the correct one, and the players mark it right or wrong. Good for a living room with no keyboard.

## Run it locally

Browsers will not load the data when `index.html` is opened straight from disk, so use any static file server from this folder, for example:

```
python -m http.server 8000
```

then open http://localhost:8000/. (`npx serve`, `php -S localhost:8000` and similar work equally well.) If the page shows stale code after an update, hard-refresh or use a server that sends `Cache-Control: no-store`.

## Data

193 UN member states plus four extra states, 26 categories. Some values are estimates and may be imprecise: where a source had no figure, or none that could be checked, the value is an estimate. The source of each value is recorded in the `sources` field of `data/countries.json`.

Main sources: mledoze/countries (ODbL 1.0), World Bank WDI (CC BY 4.0), Our World in Data / NCD-RisC (CC BY 4.0), Natural Earth (public domain), flag-icons (MIT), Global Firepower 2026 rankings, UNODC, Wikipedia (CC BY-SA 4.0) and Wikimedia Commons photos (individual licences). See [DATA-LICENSES.md](DATA-LICENSES.md) for the full list with licences and attribution, and [data/images/CREDITS.md](data/images/CREDITS.md) for every photo credit.

## Licences

- Code (`index.html`, `credits.html`, `sources.html`, `style.css`, `js/`): MIT, see [LICENSE](LICENSE).
- Data: third-party, see [DATA-LICENSES.md](DATA-LICENSES.md). The combined country database `data/countries.json` is a derived database under the ODbL 1.0.
- Photos: Wikimedia Commons, each under its own licence.
