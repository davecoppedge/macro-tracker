# Macro Tracker

A personal food and macro logger for Android (built as an installable web app).

## What's in this folder

| File | What it does |
|---|---|
| `index.html` | The page skeleton: header, bottom tabs, pop-up panel |
| `styles.css` | How everything looks (colors, sizes, dark mode) |
| `app.js` | The brain: food search, barcode, label reading, logging, charts, saving |
| `sw.js` | "Service worker": makes the app open instantly and work offline |
| `manifest.json` | Tells Android the app's name, icon and colors so it installs like a real app |
| `icons/` | App icons |

Your data (food log, saved foods, weights, goals) is stored **on your phone only**. Nothing is uploaded anywhere. Use **Settings → Export backup** now and then and save the file to Google Drive.

## Where the food data comes from

- **USDA FoodData Central**: whole and generic foods (chicken breast, rice, apples). Works out of the box with a shared demo key (~30 searches/hour). A free personal key from https://fdc.nal.usda.gov/api-key-signup raises it to 1,000/hour; paste it in Settings.
- **Open Food Facts**: branded and packaged foods, plus barcode lookups. Free, no key.
- **Label photo**: reads the label text on your phone (Tesseract). Always shows you the numbers to check before saving.

## Getting it onto your phone (one-time, ~10 minutes)

The app has to live at a web address (with `https://`) so your phone can install it. GitHub Pages hosts it free.

1. Create a free account at https://github.com (skip if you have one).
2. Click **+** (top right) → **New repository**. Name it `macro-tracker`, set it to **Public**, click **Create repository**.
3. On the next page click **uploading an existing file**. Drag in everything from this folder **except** the `.claude` folder: `index.html`, `styles.css`, `app.js`, `sw.js`, `manifest.json`, `README.md`, and the `icons` folder. Click **Commit changes**.
4. In the repository, go to **Settings → Pages**. Under "Branch" choose **main** and **/(root)**, click **Save**.
5. Wait 1 to 2 minutes. The page shows your address, like `https://YOUR-NAME.github.io/macro-tracker/`.
6. On your S23 Ultra, open that address in **Chrome**. Tap the **⋮** menu → **Add to home screen** → **Install**.
7. Open it from the home-screen icon. Allow camera access the first time you scan a barcode.

The code is public, but your food log is not: it never leaves your phone.

## Updating the app later

1. Change the files here (or ask Claude to).
2. In `sw.js`, bump `VERSION` (e.g. `'v1'` → `'v2'`) so phones fetch the new version.
3. Upload the changed files to the GitHub repository the same way (it replaces the old ones).
4. On your phone, close and reopen the app (twice if the change doesn't show the first time).

## Testing on the Mac

```bash
cd ~/Documents/Dev/macro-tracker && python3 -m http.server 8123
```

Then open http://localhost:8123 in Chrome.
