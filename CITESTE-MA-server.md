# Rafturi depozit — cu bază de date partajată (server local)

Aplicația poate funcționa în două feluri:

1. **Simplu (fără server)** — deschizi direct `schema-raft.html` cu dublu-click. Datele se salvează automat în browser, dar rămân doar pe acel calculator. Bun pentru o singură persoană.

2. **Partajat (cu server local)** — un calculator din firmă rulează un mic server, iar colegii deschid aplicația din browser prin rețea. Toți lucrează pe **aceleași date**, în timp real. Fără internet, fără cloud, fără abonament. Asta descrie ghidul de mai jos.

---

## De ce ai nevoie

- Un calculator care rămâne pornit cât timp se lucrează (îl numim „serverul"). Poate fi un PC obișnuit.
- Toți colegii pe **aceeași rețea locală** (același router / Wi-Fi / rețea de firmă).
- **Node.js** instalat pe calculatorul-server (gratuit).

## Pas cu pas (pe calculatorul-server)

1. **Instalează Node.js** (o singură dată): intră pe https://nodejs.org, descarcă versiunea **LTS**, instaleaz-o (Next, Next, Finish).

2. Pune într-un folder, împreună, aceste două fișiere:
   - `server.js`
   - `schema-raft.html`

3. **Pornește serverul**: dublu-click pe `start-server.bat`.
   (Sau, manual: deschizi un terminal în folder și scrii `node server.js`.)

4. Se deschide o fereastră neagră care afișează adresele, de exemplu:
   ```
   Pe acest calculator:  http://localhost:3000
   In retea (colegi):    http://192.168.1.50:3000
   ```
   **Lasă fereastra deschisă** cât timp lucrați. Dacă o închizi, serverul se oprește.

5. Pe calculatorul-server, deschizi în browser `http://localhost:3000`.

## Pentru colegi

Deschid în browser adresa „In retea" afișată de server, de exemplu:
```
http://192.168.1.50:3000
```
(înlocuiește cu adresa afișată la tine). Gata — văd și editează aceleași date. În aplicație, sus, apare eticheta verde **„Conectat la server (partajat cu colegii)"**.

## Firewall (dacă colegii nu se pot conecta)

Prima dată când pornești, Windows poate întreba dacă permiți Node.js în rețea — apasă **Permite / Allow** (rețele private). Dacă tot nu merge, în Windows Firewall permite aplicația **Node.js** sau portul **3000** pe rețeaua privată.

## Unde stau datele / backup

Toate datele (rafturi, dimensiuni, inventar) se salvează automat în fișierul **`data.json`**, lângă `server.js`. Pentru backup, copiază din când în când acest fișier. Ca să repornești de la zero, oprește serverul și șterge `data.json`.

## Bine de știut

- Serverul trebuie să fie pornit ca alții să poată lucra. Dacă îl închizi, colegii nu mai au acces (dar datele rămân în `data.json` și reapar la repornire).
- Modificările apar la ceilalți în câteva secunde (se sincronizează automat).
- Dacă serverul e oprit, aplicația arată eticheta roșie „Server indisponibil" — pornește-l din nou.
- Pentru ca serverul să pornească singur la aprinderea calculatorului, poți pune o scurtătură către `start-server.bat` în folderul Startup din Windows (opțional).
