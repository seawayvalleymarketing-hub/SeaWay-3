# Seaway Valley: website, appointment times, dashboard, fax

Everything runs from one small Node program (`server.js`). No npm packages to install. Needs Node 18 or newer.

## What it does
* Serves the website (`public/index.html`).
* Every appointment form ends with a **date and time picker**. Times come live from the pharmacist's settings.
* **Dashboard** at `/admin` (password protected): weekly hours, days off, extra hours, block single times, see and cancel bookings, change the password.
* When a patient submits any form, the server builds a **black-and-white fax (PDF) in memory**, sends it to (613) 691-7667, and forgets it.
* **Double bookings are impossible**: a time is reserved on the server before the fax is sent; if the fax fails the time is released.

## What is stored (and what is not)
Stored in `data/`: your hours/settings, the booked **date, time, type (vaccine or minor ailment) and a random 6-letter reference**, and the dashboard password (scrambled). Bookings are deleted automatically after their day passes.
**Never stored:** names, answers, health card numbers, contact details, the fax itself. They are not logged either. Forms go to no email service, analytics, AI service or form service.
Patient details exist only in: the patient's browser until they submit, the fax provider's records (see below), and your fax machine.

## What you need to provide
1. **A place to run it** that supports Node and a small persistent disk (Render, Railway, Fly.io, a VPS...). A host in Canada is a good idea for health information. Point your domain at it; HTTPS must be on.
2. **A fax-sending account.** Set `FAX_PROVIDER` and the keys in `.env.example`.
   * Documo (mFax): `DOCUMO_API_KEY`  |  Phaxio / Sinch: `PHAXIO_API_KEY` + `PHAXIO_API_SECRET`.
   * The fax code for both was written from their public API descriptions and **has not been tested against a live account**. Before going live, do a test submission and confirm the fax arrives (see "Go-live checklist").
   * The provider will keep a record of each fax it sends. Ask them (or set in their account) for the shortest retention, a privacy/confidentiality agreement suitable for Ontario health information (PHIPA), and Canadian data storage if you want it. Set the provider to email you (not the patient data) when a fax fails.
3. **The dashboard password** (`ADMIN_PASSWORD`, 10+ characters, used on first start only).

## Run it
```
cp .env.example .env     # fill it in (or set the same values on your host)
node --env-file=.env server.js    # Node 20.6+; hosts that set variables for you can just run: node server.js
```
Open `/` for the site and `/admin` for the dashboard. `npm test` runs a self-check using a fake fax (nothing is sent).

## Go-live checklist
1. Set the env values, start the server, open `/admin`, sign in. The dashboard warns if faxing is not set up.
2. Put in your real weekly hours.
3. Submit one test of each type (vaccine, minor ailment, prescription) and confirm each fax arrives, is readable, and carries the right title and appointment time.
4. Confirm the booked time shows in the dashboard, and cancelling it frees the time.

## Notes
* Run **one copy** of the server (the double-booking protection lives in that one process).
* A cancelled booking does not notify the patient automatically. The patient's phone number is on the fax (match the reference).
* Fax acceptance means the provider took it. If the pharmacy line is busy they retry; failed faxes show in the provider's account.
* The page loads fonts from Google Fonts (no patient data involved). They can be self-hosted if you want zero third-party requests.
