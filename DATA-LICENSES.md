# Data licences and attribution

The game code is under the MIT licence (see LICENSE). The data in `data/` and the photos in `data/images/` come from the third-party sources below and keep their own licences. Some answers are estimates and may be imprecise.

## mledoze/countries

- Source: <https://github.com/mledoze/countries>
- Licence: [Open Database Licence (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/)
- Used for: country names, ISO 3166 codes, capital, currency, native name, area, internet domain (TLD), land borders (used for the neighbours category) and region
- Notes: ODbL requires attribution and share-alike. data/countries.json is a derived database built from this source plus the other sources below, and is made available under the ODbL 1.0 as a whole. Attribution: "Contains information from mledoze/countries (https://github.com/mledoze/countries), made available under the Open Database Licence (ODbL) 1.0."

## World Bank World Development Indicators (WDI)

- Source: <https://data.worldbank.org/>
- Licence: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Used for: population (SP.POP.TOTL), GDP per capita in current US dollars (NY.GDP.PCAP.CD), life expectancy at birth (SP.DYN.LE00.IN), intentional homicides per 100,000 people (VC.IHR.PSRC.P5)
- Notes: Attribution: The World Bank, World Development Indicators. Values were rounded or taken as the latest year available; a few countries use a national statistics office figure instead (named in the sources field of data/countries.json).

## Our World in Data / NCD-RisC

- Source: <https://ourworldindata.org/>
- Licence: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Used for: average male height (NCD Risk Factor Collaboration, 1996 birth cohort, via the Our World in Data chart "average-height-of-men") and a few homicide rates that the World Bank does not list (UNODC data via Our World in Data)
- Notes: Attribution: NCD Risk Factor Collaboration (NCD-RisC), via Our World in Data.

## UNODC (United Nations Office on Drugs and Crime)

- Source: <https://dataunodc.un.org/>
- Licence: Used via the World Bank (CC BY 4.0) and Our World in Data (CC BY 4.0)
- Used for: underlying source of the homicide rates
- Notes: Attribution: UNODC Homicide Statistics.

## Natural Earth

- Source: <https://www.naturalearthdata.com/>
- Licence: [Public domain](https://www.naturalearthdata.com/about/terms-of-use/)
- Used for: country outlines and the world map, simplified (obtained through the datasets/geo-countries repository)
- Notes: No attribution is required; it is given here anyway. The shapes are simplified and are not authoritative for borders.

## Global Firepower 2026

- Source: <https://www.globalfirepower.com/>
- Licence: Rankings credited to Global Firepower; no open licence
- Used for: the military ranking category (rank numbers only)
- Notes: The ranks are reproduced for a non-commercial quiz, with attribution to globalfirepower.com. Countries it does not rank have an estimated place (see the sources field). Remove the category if the owner objects.

## Wikipedia (text facts)

- Source: <https://en.wikipedia.org/>
- Licence: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
- Used for: short facts such as national sports, highest points, national animals, dishes, landmarks, alternative country names and the languages and religion tables where cited; article titles are stored in the data (wiki fields)
- Notes: Facts were collected from English Wikipedia articles and lists, which are under CC BY-SA 4.0; please attribute Wikipedia and its contributors when reusing them.

## Other public sources

- Licence: Each source keeps its own terms; used as references for individual facts
- Used for: Pew Research Center (religious composition), WHO Global status report on alcohol and health (beverage shares, via Wikipedia), Observatory of Economic Complexity (main exports), UNESCO (landmarks), UK Office for National Statistics Census 2021 and other national statistics offices
- Notes: The source of each value is recorded per country and category in the sources field of data/countries.json. Some values are estimates.

## Wikimedia Commons photos

- Source: <https://commons.wikimedia.org/>
- Licence: Individual licences (public domain, CC0, CC BY, CC BY-SA and similar)
- Used for: thumbnails of famous people, dishes, landmarks and drinks in data/images/
- Notes: Each photo keeps its own licence, author and file page, listed on the credits page (credits.html) and in data/images/CREDITS.md and CREDITS.json. Only files hosted on Commons with a stated licence are used.

## Files

- `data/countries.json`: the combined country database (derived database, ODbL 1.0, built from the sources above).
- `data/categories.json`: category definitions and prompts (part of the game code, MIT).
- `data/worldmap.json`, `data/outlines/`: simplified Natural Earth shapes.
- `data/images/`: Wikimedia Commons thumbnails with `CREDITS.md` and `CREDITS.json` (author, licence and file page for each one).
